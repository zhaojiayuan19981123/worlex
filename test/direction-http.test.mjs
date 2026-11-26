// direction-http.test.mjs —— 方向分析的 HTTP 级端到端测试
//
// 真服务（真实 express 路由 + 真实 store 落盘）、假上游（OpenAlex 检索与模型流），
// 覆盖用户路径：填主题检索 → 会话落盘 → 勾选 → 后台分析 → 轮询拿报告 → 导出 / 删除。
// 上游一律注入，不联网，跑得快也能断言请求形状。
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import * as store from '../src/store.js';
import { registerDirectionRoutes } from '../src/directionRoutes.js';
import { DEFAULT_FILTERS } from '../src/directionSearch.js';

const REPORT = {
  overview: '这批文献都在做图神经网络推荐，冷启动基本被忽略。',
  gaps: [
    { title: '冷启动缺证据', statement: '没有一篇在真实冷启动场景验证', why: '文献 1、2 都假设有交互历史', evidence: [1, 2], confidence: 'high' },
    { title: '跨域迁移只在同域验证', statement: '缺少跨域实验', why: '文献 2 的数据集同源', evidence: [2], confidence: 'medium' },
    { title: '缺少线上 A/B', statement: '全部是离线指标', why: '文献 1 只报 NDCG', evidence: [1], confidence: 'low' },
  ],
  directions: [
    { title: '元学习 + 图预训练', question: '能否用他域行为缓解冷启动？', approach: '元学习 + 图预训练', data: '公开跨域数据集', contribution: '首个跨域 GNN 冷启动框架', novelty: '把元学习引入图结构', difficulty: '高', risks: '数据难获取', evidence: [1, 2] },
    { title: '线上小流量验证', question: '离线收益能否迁移到线上？', approach: '在线 A/B', data: '需要业务方配合', contribution: '首个线上验证', novelty: '从离线到线上', difficulty: '中', risks: '流量不足', evidence: [1] },
    { title: '冷启动合成数据', question: '能否用生成模型造冷启动样本？', approach: '生成式数据增强', data: '公开数据 + 生成器', contribution: '低成本冷启动评测集', novelty: '构造评测基准', difficulty: '低', risks: '生成质量不可控', evidence: [2] },
  ],
  clusters: [{ name: '图协同过滤', summary: 'GNN 做推荐的 mainstream 路线', papers: [1, 2] }],
  readingOrder: [{ index: 1, reason: '先看问题定义最清楚的那篇' }, { index: 2, reason: '再看方法细节' }],
  cautions: ['样本只有 2 篇，结论仅作方向参考'],
};

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}
async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const postJson = (base, url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** 造一条 OpenAlex work（摘要够长，能过 hasAbstract 门槛） */
function work(i, title) {
  const inverted = {};
  for (let n = 0; n < 40; n += 1) inverted[`word${n}`] = [n];
  return {
    id: `https://openalex.org/W${i}`,
    ids: { openalex: `https://openalex.org/W${i}` },
    doi: `https://doi.org/10.1000/test${i}`,
    display_name: title,
    publication_year: 2023,
    publication_date: '2023-03-01',
    abstract_inverted_index: inverted,
    authorships: [{ author: { display_name: 'Ada' } }, { author: { display_name: 'Alan' } }],
    primary_location: { source: { display_name: 'Journal of Graphs', type: 'journal' }, landing_page_url: `https://example.org/${i}` },
    cited_by_count: 40 - i,
    type: 'article',
    language: 'en',
    best_oa_location: null,
    primary_topic: { display_name: 'Graph Learning' },
  };
}

/** 假模型：按 SSE 逐块吐 JSON，onDelta 能拿到增量（模拟真实流式） */
function fakeModel({ fail = false, text = JSON.stringify(REPORT) } = {}) {
  const calls = [];
  const fetchModelCompletion = async (profile, payload) => {
    calls.push({ profile, payload });
    const chunks = [];
    for (let i = 0; i < text.length; i += 120) {
      const piece = text.slice(i, i + 120);
      chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    }
    chunks.push('data: [DONE]\n\n');
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
        controller.close();
      },
    });
    return {
      up: fail
        ? { ok: false, status: 500, headers: { get: () => 'application/json' }, text: async () => '{"error":"boom"}' }
        : { ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body: stream },
      cancel: () => {},
    };
  };
  return { fetchModelCompletion, calls };
}

/** 测试侧的 SSE 读取（与 server.js 的 readLLMResponse 同为「逐帧取 delta」） */
async function readStream(up, { onDelta } = {}) {
  const reader = up.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content || '';
      if (delta) { full += delta; onDelta?.(delta); }
    }
  }
  return { full, reasoning: '', aborted: false };
}

async function setup(options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'worlex-direction-'));
  store.configure({ dataDir: dir });
  const app = express();
  app.use(express.json());
  const model = fakeModel(options.model);
  const searchCalls = [];
  const fetchImpl = async (url) => {
    searchCalls.push(url);
    const payload = {
      meta: { count: 128 },
      results: [work(1, 'Graph cold start'), work(2, 'Cross-domain GNN')],
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  const service = registerDirectionRoutes(app, {
    store,
    resolveRequestModel: (id) => (options.noModel
      ? { error: '未配置可用模型，请到「AI 设置」里先配一个' }
      : { profile: { id: id || 'p1', provider: 'fake', baseURL: 'http://fake.local/v1', model: 'fake-model' } }),
    fetchModelCompletion: model.fetchModelCompletion,
    readLLMResponse: readStream,
    fetchImpl,
    logger: () => {},
  });
  const server = app.listen(0, '127.0.0.1');
  const base = await listen(server);
  return {
    base, dir, server, model, searchCalls, service,
    async cleanup() { await close(server); await rm(dir, { recursive: true, force: true }); },
  };
}

test('检索 → 落盘 → 勾选 → 分析 → 轮询 → 导出 → 删除 全链路', async () => {
  const ctx = await setup();
  try {
    // 1) 检索
    const searchRes = await postJson(ctx.base, '/api/direction/search', {
      topics: [{ name: 'GNN 冷启动', keywords: 'graph neural network, cold start' }],
      filters: { ...DEFAULT_FILTERS, perTopic: 10 },
    });
    assert.equal(searchRes.status, 200);
    const search = await searchRes.json();
    assert.equal(search.session.papers.length, 2);
    assert.equal(search.session.papers[0].title, 'Graph cold start');
    assert.equal(search.session.papers[0].doi, '10.1000/test1');
    assert.match(search.session.title, /GNN 冷启动/);
    assert.equal(search.session.stats.totalHits, 128);
    assert.ok(ctx.searchCalls[0].includes('graph%20neural%20network'), '关键词应进 search 参数');
    const sessionId = search.session.id;

    // 数据确实落到 data/direction-analysis.json
    const saved = JSON.parse(await readFile(path.join(ctx.dir, 'direction-analysis.json'), 'utf8'));
    assert.equal(saved.sessions.length, 1);
    assert.equal(saved.activeSessionId, sessionId);

    // 2) 勾选两篇
    const patchRes = await fetch(`${ctx.base}/api/direction/session/${sessionId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selected: search.session.papers.map((p) => p.id), title: '冷启动选题' }),
    });
    assert.equal(patchRes.status, 200);
    assert.equal((await patchRes.json()).session.selectedCount, 2);

    // 3) 分析
    const analyzeRes = await postJson(ctx.base, '/api/direction/analyze', { sessionId, mode: 'both' });
    assert.equal(analyzeRes.status, 200);
    const { jobId } = await analyzeRes.json();
    assert.ok(jobId);

    // 4) 轮询到完成
    let job = null;
    for (let i = 0; i < 60; i += 1) {
      job = await (await fetch(`${ctx.base}/api/direction/job/${jobId}`)).json();
      if (job.status !== 'running') break;
      await sleep(25);
    }
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.paperCount, 2);
    assert.equal(job.analysis.gaps.length, 3);
    assert.equal(job.analysis.directions.length, 3);
    // 模型收到的 prompt 里两篇都编了号
    const prompt = ctx.model.calls[0].payload.messages[1].content;
    assert.match(prompt, /【1】Graph cold start/);
    assert.match(prompt, /【2】Cross-domain GNN/);

    // 5) 报告落进会话
    const sessionRes = await (await fetch(`${ctx.base}/api/direction/session/${sessionId}`)).json();
    assert.equal(sessionRes.session.analyses.length, 1);
    assert.equal(sessionRes.session.analyses[0].analysis.gaps.length, 3);
    assert.equal(sessionRes.session.analyses[0].paperIds.length, 2);

    // 6) Markdown 导出（预览 + 存进笔记）
    const md = await (await fetch(`${ctx.base}/api/direction/markdown/${sessionId}`)).json();
    assert.match(md.markdown, /# 方向分析：冷启动选题/);
    assert.match(md.markdown, /## 研究空白/);
    assert.match(md.markdown, /## 研究方向/);
    assert.match(md.markdown, /Graph cold start/);

    const exported = await (await postJson(ctx.base, '/api/direction/export-markdown', { sessionId })).json();
    assert.ok(exported.noteId);
    const notes = store.listMarkdownNotes();
    assert.equal(notes.length, 1);
    assert.match(notes[0].title, /方向分析/);
    assert.match(notes[0].content, /元学习 \+ 图预训练/);

    // 7) 会话列表 → 删除
    const list = await (await fetch(`${ctx.base}/api/direction`)).json();
    assert.equal(list.sessions.length, 1);
    assert.equal(list.sessions[0].hasAnalysis, true);
    assert.equal(list.sessions[0].gapCount, 3);
    assert.ok(list.meta.fields.some((f) => f.id === 'title_abstract'));
    assert.ok(list.meta.modes.length === 3);

    const delRes = await fetch(`${ctx.base}/api/direction/session/${sessionId}`, { method: 'DELETE' });
    assert.equal(delRes.status, 200);
    const after = await (await fetch(`${ctx.base}/api/direction`)).json();
    assert.equal(after.sessions.length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('同一会话再次检索是覆盖候选列表，不会新建第二条会话', async () => {
  const ctx = await setup();
  try {
    const first = await (await postJson(ctx.base, '/api/direction/search', {
      topics: [{ name: 'A', keywords: 'graph' }], filters: { ...DEFAULT_FILTERS, perTopic: 5 },
    })).json();
    const second = await (await postJson(ctx.base, '/api/direction/search', {
      sessionId: first.session.id,
      topics: [{ name: 'B', keywords: 'cold start' }],
      filters: { ...DEFAULT_FILTERS, perTopic: 5 },
    })).json();
    assert.equal(second.session.id, first.session.id);
    assert.match(second.session.title, /A/, '已有会话改检索条件时保留原来的标题');
    const list = await (await fetch(`${ctx.base}/api/direction`)).json();
    assert.equal(list.sessions.length, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('没勾文献 / 没配模型 / 会话不存在都给出可读错误', async () => {
  const ctx = await setup({ noModel: true });
  try {
    const search = await (await postJson(ctx.base, '/api/direction/search', {
      topics: [{ name: 'A', keywords: 'graph' }], filters: DEFAULT_FILTERS,
    })).json();

    const noPapers = await postJson(ctx.base, '/api/direction/analyze', { sessionId: search.session.id, paperIds: [] });
    assert.equal(noPapers.status, 400);
    assert.match((await noPapers.json()).error, /勾选/);

    const ids = search.session.papers.map((p) => p.id);
    const noModel = await postJson(ctx.base, '/api/direction/analyze', { sessionId: search.session.id, paperIds: ids });
    assert.equal(noModel.status, 400);
    assert.match((await noModel.json()).error, /未配置可用模型/);

    const missing = await postJson(ctx.base, '/api/direction/analyze', { sessionId: 'nope' });
    assert.equal(missing.status, 404);

    const badSearch = await postJson(ctx.base, '/api/direction/search', { topics: [{ keywords: '  ' }] });
    assert.equal(badSearch.status, 400);
    assert.match((await badSearch.json()).error, /至少填/);
  } finally {
    await ctx.cleanup();
  }
});

test('模型报错时任务状态是 error 且带原因，不会假装成功', async () => {
  const ctx = await setup({ model: { fail: true } });
  try {
    const search = await (await postJson(ctx.base, '/api/direction/search', {
      topics: [{ name: 'A', keywords: 'graph' }], filters: DEFAULT_FILTERS,
    })).json();
    const ids = search.session.papers.map((p) => p.id);
    const { jobId } = await (await postJson(ctx.base, '/api/direction/analyze', { sessionId: search.session.id, paperIds: ids })).json();
    let job = null;
    for (let i = 0; i < 60; i += 1) {
      job = await (await fetch(`${ctx.base}/api/direction/job/${jobId}`)).json();
      if (job.status !== 'running') break;
      await sleep(25);
    }
    assert.equal(job.status, 'error');
    assert.match(job.error, /500|AI 接口/);
    const session = await (await fetch(`${ctx.base}/api/direction/session/${search.session.id}`)).json();
    assert.equal(session.session.analyses.length, 0, '失败不应留下空报告');
  } finally {
    await ctx.cleanup();
  }
});

test('模型输出被截断时能救回一部分，解析不出则报错而不是空白报告', async () => {
  const cut = JSON.stringify(REPORT).slice(0, 220);
  const ctx = await setup({ model: { text: cut } });
  try {
    const search = await (await postJson(ctx.base, '/api/direction/search', {
      topics: [{ name: 'A', keywords: 'graph' }], filters: DEFAULT_FILTERS,
    })).json();
    const ids = search.session.papers.map((p) => p.id);
    const { jobId } = await (await postJson(ctx.base, '/api/direction/analyze', { sessionId: search.session.id, paperIds: ids })).json();
    let job = null;
    for (let i = 0; i < 60; i += 1) {
      job = await (await fetch(`${ctx.base}/api/direction/job/${jobId}`)).json();
      if (job.status !== 'running') break;
      await sleep(25);
    }
    assert.equal(job.status, 'done');
    assert.ok(job.analysis.overview.length > 0, '被截断也应保住 overview');
  } finally {
    await ctx.cleanup();
  }
});

test('取消任务后状态立刻结束，轮询不会一直转', async () => {
  const ctx = await setup();
  try {
    const search = await (await postJson(ctx.base, '/api/direction/search', {
      topics: [{ name: 'A', keywords: 'graph' }], filters: DEFAULT_FILTERS,
    })).json();
    const ids = search.session.papers.map((p) => p.id);
    const { jobId } = await (await postJson(ctx.base, '/api/direction/analyze', { sessionId: search.session.id, paperIds: ids })).json();
    const cancelRes = await postJson(ctx.base, `/api/direction/job/${jobId}/cancel`, {});
    assert.equal(cancelRes.status, 200);
    const job = await (await fetch(`${ctx.base}/api/direction/job/${jobId}`)).json();
    assert.ok(['error', 'done'].includes(job.status));
    assert.match(job.error || '已取消', /取消|完成/);
  } finally {
    await ctx.cleanup();
  }
});

test('单篇摘要太短（<60 字）判定为没有摘要，拒绝分析并说明原因', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'worlex-direction-short-'));
  store.configure({ dataDir: dir });
  const app = express();
  app.use(express.json());
  const fetchImpl = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({
      meta: { count: 1 },
      results: [{ ...work(9, 'Tiny abstract'), abstract_inverted_index: { a: [0], b: [1] } }],
    }),
  });
  const model = fakeModel();
  registerDirectionRoutes(app, {
    store,
    resolveRequestModel: () => ({ profile: { provider: 'fake', baseURL: 'http://f/v1', model: 'm' } }),
    fetchModelCompletion: model.fetchModelCompletion,
    readLLMResponse: readStream,
    fetchImpl,
  });
  const server = app.listen(0, '127.0.0.1');
  const base = await listen(server);
  try {
    // 关掉「只保留有摘要」，让短摘要的条目也能进候选，再由分析接口拒绝
    const search = await (await postJson(base, '/api/direction/search', {
      topics: [{ name: 'A', keywords: 'graph' }],
      filters: { ...DEFAULT_FILTERS, onlyWithAbstract: false },
    })).json();
    assert.equal(search.session.papers.length, 1);
    const res = await postJson(base, '/api/direction/analyze', { sessionId: search.session.id, paperIds: search.session.papers.map((p) => p.id) });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /没有摘要/);
  } finally {
    await close(server);
    await rm(dir, { recursive: true, force: true });
  }
});
