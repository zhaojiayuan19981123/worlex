// direction-v31.test.mjs —— 详细报告 + 专业定制 + 全英文摘要可视化
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import express from 'express';

import {
  buildAnalysisMessages, normalizeAnalysis, englishOnly,
} from '../src/directionAnalyze.js';
import { analysisToMarkdown, registerDirectionRoutes } from '../src/directionRoutes.js';
import { DEFAULT_FILTERS } from '../src/directionSearch.js';
import * as store from '../src/store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(path.join(ROOT, p), 'utf8');
const paper = (i) => ({
  id: `W${i}`, title: `Paper ${i} on graph recommendation`,
  abstract: `Abstract ${i}. `.repeat(40), year: 2024,
  authors: ['Ada'], venue: 'Journal of Graphs', citedBy: i,
});

test('提示词：用户专业进入消息体，要求详细报告与纯英文摘要可视化', () => {
  const messages = buildAnalysisMessages({
    topics: [{ name: 'GNN 推荐' }], papers: [paper(1), paper(2)], mode: 'both',
    major: '管理科学与工程',
  });
  const sys = messages[0].content;
  const user = messages[1].content;
  assert.match(user, /用户专业背景：管理科学与工程/);
  assert.match(user, /结合这个专业的理论视角/);
  assert.match(sys, /visualization/);
  assert.match(sys, /不得出现任何中文/);
  assert.match(sys, /要详细/);
  assert.match(sys, /"hypothesis"/);
  assert.match(sys, /"agenda"/);
  assert.match(sys, /"steps"/);
});

test('可视化归一化：中文条目全部丢弃，英文关键词 / 节点 / 关系保留', () => {
  const out = normalizeAnalysis({
    overview: '概述',
    visualization: {
      keywords: [
        { text: 'graph neural network', weight: 9 },
        { text: '冷启动推荐', weight: 10 },
        { text: '图神经网络 recommendation', weight: 7 },
        { text: 'collaborative filtering', weight: 4 },
      ],
      nodes: [
        { id: 'n1', label: 'Cold-start recommendation', type: 'gap', papers: [1], summary: 'Sparse user history' },
        { id: 'n2', label: '冷启动问题', type: 'theme', papers: [2] },
        { id: 'n3', label: 'Cross-domain transfer', type: 'direction', papers: [1, 2] },
      ],
      edges: [
        { source: 'n1', target: 'n3', weight: 3, label: 'shared evidence' },
        { source: 'n1', target: 'n2', weight: 5 },
        { source: 'n1', target: 'n9', weight: 5 },
      ],
    },
  }, { paperCount: 2 });
  const viz = out.visualization;
  assert.equal(viz.keywords.length, 3);
  assert.deepEqual(viz.keywords.map((k) => k.text), ['graph neural network', 'recommendation', 'collaborative filtering']);
  assert.equal(viz.nodes.length, 2);
  assert.ok(viz.nodes.every((n) => !/[\u4e00-\u9fff]/.test(n.label)));
  assert.equal(viz.edges.length, 1);
  assert.equal(viz.edges[0].target, 'n3');
  assert.ok(!/[\u4e00-\u9fff]/.test(englishOnly('图神经网络 graph neural network')));
});

test('详细字段归一化：脉络 / 假设 / 步骤 / 路线图都在', () => {
  const out = normalizeAnalysis({
    overview: '概述',
    landscape: { evolution: '从矩阵分解到图模型', consensus: '都承认冷启动重要', debates: '离线指标不一致', methodTrends: '预训练成为主流' },
    gaps: [{ title: '缺少线上验证', statement: '都只做离线', rootCause: '数据难获取', impact: '影响落地', openQuestions: ['线上收益如何？'], check: '查是否有 A/B', type: '证据缺口' }],
    directions: [{ title: '跨域迁移', question: '能否迁移？', hypothesis: '可迁移', steps: ['先对齐域', '再训练'], evaluation: 'NDCG', resources: '跨域数据', timeline: '三个月' }],
    agenda: [{ phase: '第一阶段', goal: '补齐数据', tasks: ['爬取', '清洗'], deliverable: '数据集' }],
  }, { paperCount: 2 });
  assert.match(out.landscape.evolution, /矩阵分解/);
  assert.equal(out.gaps[0].openQuestions.length, 1);
  assert.match(out.gaps[0].check, /A\/B/);
  assert.deepEqual(out.directions[0].steps, ['先对齐域', '再训练']);
  assert.equal(out.directions[0].evaluation, 'NDCG');
  assert.equal(out.agenda[0].deliverable, '数据集');
});

test('Markdown 导出包含专业、研究格局、执行路线图与英文关键词', () => {
  const session = {
    id: 's1', title: '测试主题', topics: [{ name: 'GNN' }], selected: [], papers: [],
    major: '管理科学与工程', analyses: [],
  };
  const record = {
    id: 'r1', mode: 'both', model: 'fake', createdAt: '2026-11-26', paperCount: 1, paperIds: [],
    major: '管理科学与工程',
    analysis: normalizeAnalysis({
      overview: '概述',
      landscape: { evolution: '脉络' },
      agenda: [{ phase: '第一阶段', goal: '目标' }],
      visualization: { keywords: [{ text: 'graph neural network', weight: 8 }] },
    }, { paperCount: 1 }),
  };
  const md = analysisToMarkdown(session, record);
  assert.match(md, /结合用户专业「管理科学与工程」/);
  assert.match(md, /## 研究格局/);
  assert.match(md, /## 执行路线图/);
  assert.match(md, /## 摘要关键词（英文）/);
  assert.match(md, /graph neural network/);
});

// ---------- HTTP：专业随会话保存并真正送进模型 ----------
const REPORT = {
  overview: '概述', landscape: { evolution: '脉络' },
  gaps: [], directions: [],
  visualization: { keywords: [{ text: 'graph neural network', weight: 9 }], nodes: [], edges: [] },
};

async function setup() {
  const dir = await mkdtemp(path.join(ROOT, '.tmp-direction-v31-'));
  store.configure({ dataDir: dir });
  const app = express();
  app.use(express.json());
  let prompt = '';
  const model = async (_profile, payload) => {
    prompt = payload.messages[1].content;
    const stream = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(REPORT) } }] })}\n\n`));
        ctrl.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        ctrl.close();
      },
    });
    return { up: { ok: true, status: 200, body: stream }, cancel: () => {} };
  };
  const search = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({
    meta: { count: 1 },
    results: [{
      id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1000/x', display_name: 'Graph paper',
      publication_year: 2024, publication_date: '2024-01-01',
      abstract_inverted_index: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`w${i}`, [i]])),
      authorships: [{ author: { display_name: 'Ada' } }],
      primary_location: { source: { display_name: 'Journal of Graphs', type: 'journal' } },
      cited_by_count: 10, type: 'article', language: 'en',
    }],
  }) });
  registerDirectionRoutes(app, {
    store,
    resolveRequestModel: () => ({ profile: { provider: 'fake', baseURL: 'http://f/v1', model: 'fake' } }),
    fetchModelCompletion: model,
    readLLMResponse: async (up) => {
      const reader = up.body.getReader();
      let full = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of new TextDecoder().decode(value).split('\n')) {
          if (!line.startsWith('data:')) continue;
          const p = line.slice(5).trim();
          if (p === '[DONE]') continue;
          full += JSON.parse(p)?.choices?.[0]?.delta?.content || '';
        }
      }
      return { full };
    },
    fetchImpl: search,
    logger: () => {},
  });
  const server = app.listen(0, '127.0.0.1');
  const base = await new Promise((resolve) => server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  return { base, server, getPrompt: () => prompt, async cleanup() { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); await rm(dir, { recursive: true, force: true }); } };
}

test('HTTP：PATCH 保存专业，分析时送进提示词并落到报告记录', async () => {
  const ctx = await setup();
  try {
    const post = (url, body) => fetch(ctx.base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const search = await (await post('/api/direction/search', {
      topics: [{ name: 'T', keywords: 'graph' }], filters: DEFAULT_FILTERS,
    })).json();
    const id = search.session.id;
    await fetch(`${ctx.base}/api/direction/session/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ major: '金融科技' }),
    });
    const started = await (await post('/api/direction/analyze', { sessionId: id, paperIds: [search.session.papers[0].id], mode: 'gap' })).json();
    assert.equal(started.major, '金融科技');
    for (let i = 0; i < 30; i += 1) {
      const job = await (await fetch(`${ctx.base}/api/direction/job/${started.jobId}`)).json();
      if (job.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.match(ctx.getPrompt(), /用户专业背景：金融科技/);
    const state = await (await fetch(`${ctx.base}/api/direction/session/${id}`)).json();
    assert.equal(state.session.major, '金融科技');
    assert.equal(state.session.analyses[0].major, '金融科技');
    assert.equal(state.session.analyses[0].analysis.visualization.keywords[0].text, 'graph neural network');
  } finally { await ctx.cleanup(); }
});

test('前端接线：专业输入框与纯英文可视化调用已接上', async () => {
  const js = await read('public/direction.js');
  const viz = await read('public/direction-viz.js');
  const css = await read('public/direction.css');
  assert.match(js, /data-dir="major"/);
  assert.match(js, /major: \$\('\[data-dir="major"\]'\)/);
  assert.match(viz, /analysis\?\.visualization\?\.keywords/);
  assert.match(viz, /analysis\?\.visualization \|\| \{\}/);
  assert.doesNotMatch(viz, /ZH_STOP/);
  assert.doesNotMatch(viz, /p\.titleZh/);
  assert.match(css, /\.dir-major-input/);
});
