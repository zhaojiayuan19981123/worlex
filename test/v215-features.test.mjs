// v215-features.test.mjs —— 大模型重新聚类的实时进度
//
// 1) 服务端把一次聚类拆成四段（准备 / 分批归类 / 合并同义主题 / 装配图谱），
//    /api/knowledge/status 每次都能读到当前阶段、已处理篇数、已归纳主题数与已用时
// 2) 前端轮询这个接口，在画布左上角画进度条；按钮文字同步百分比，
//    聚类期间旧图谱仍然可见可点（不再整屏遮罩）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../server.js';
import * as store from '../src/store.js';

const norm = (s) => s.replace(/\r\n/g, '\n');
const read = (p) => norm(readFileSync(new URL(`../public/${p}`, import.meta.url), 'utf8'));
const readText = (rel) => norm(readFileSync(new URL(rel, import.meta.url), 'utf8'));

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
}

/** 假上游：读完请求体后按 handler 回应（可以延迟，用来观察「运行中」的中间态）。 */
function mockUpstream(handler) {
  return createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (_) { body = {}; }
    handler(body, res);
  });
}

function mockProfile(id, base) {
  return {
    id, label: 'mock-' + id, provider: 'custom',
    baseURL: `${base}/v1/chat/completions`, apiKey: '', model: 'mock-cluster',
    streamMode: 'never', systemPromptMode: 'auto', authMode: 'none', visionOverride: 'no',
    createdAt: new Date().toISOString(),
  };
}

function seedDocs(rows) {
  store.saveCollections([{ id: 'C1', name: '营销实证' }]);
  for (const r of rows) {
    store.upsertLiterature({
      ...r,
      titleZh: r.title,
      year: 2024,
      journal: '管理世界',
      docType: 'empirical',
      keywords: r.keywords || ['在线评论'],
      summary: r.summary || '在线评论影响酒店绩效。',
      tags: [],
      status: 'done',
      annotations: [],
      attachments: [],
    });
  }
}

const TOPICS_OK = {
  topics: [
    { name: '在线评论与酒店绩效', keywords: ['在线评论'], ids: ['a', 'b'] },
    { name: '供应链韧性测量', keywords: ['供应链'], ids: ['c'] },
  ],
};

test('服务端：聚类进度分阶段上报，带篇数 / 批数 / 主题数与已用时', () => {
  const server = readText('../server.js');
  // 阶段常量与就地更新（保留 startedAt，前端据此显示已用时）
  assert.match(server, /function patchClusterProgress\(patch\)/);
  assert.match(server, /stage: 'preparing'/);
  assert.match(server, /stage: 'batching', done: 0, total: list\.length,/);
  assert.match(server, /patchClusterProgress\(\{ stage: 'merging'/);
  assert.match(server, /patchClusterProgress\(\{ stage: 'applying'/);
  assert.match(server, /stage: 'done'/);
  // 进度以「篇」计：一批成功返回就把这一批的篇数累加，拆批重试不影响总数
  assert.match(server, /kbLlmProgress\.done \+= batch\.length;/);
  assert.match(server, /kbLlmProgress\.doneBatches \+= 1;/);
  assert.match(server, /kbLlmProgress\.topics = merged\.size;/);
  // status 接口直接带出去，并补一个服务端算好的已用时，前端不用和服务端对表
  assert.match(server, /elapsedMs: Math\.max\(0, Date\.now\(\) - \(kbLlmProgress\.startedAt \|\| Date\.now\(\)\)\)/);
  assert.match(server, /app\.get\('\/api\/knowledge\/status', \(_req, res\) => res\.json\(\{/);
});

test('前端：轮询 status 画进度条，按钮同步百分比，旧图谱不被遮罩', () => {
  const g = read('knowledge-graph.js');
  // 浮层结构
  assert.match(g, /const progress = el\('div', 'kg-progress'\);/);
  assert.match(g, /const pFill = el\('div', 'kg-progress-fill'\);/);
  assert.match(g, /stage\.appendChild\(progress\);/);
  // 阶段文案 + 百分比换算
  assert.match(g, /const STAGE_TEXT = \{/);
  assert.match(g, /batching: '大模型正在分批归类'/);
  assert.match(g, /function clusterPct\(c\)/);
  assert.match(g, /return 5 \+ ratio \* 85;/);
  // 轮询与收尾
  assert.match(g, /function startWatch\(seed, onFinish\)/);
  assert.match(g, /const st = await api\('\/api\/knowledge\/status'\);/);
  assert.match(g, /S\.watch\.timer = window\.setTimeout\(tick, 1000\);/);
  assert.match(g, /function finishProgress\(c\)/);
  assert.match(g, /function stopWatch\(\)/);
  // 按钮文字跟着进度走
  assert.match(g, /'聚类中 ' \+ Math\.round\(pct\) \+ '%'/);
  // 点按钮期间不再 setStatus\('loading'\) 整屏遮罩：聚类是后台换分类，画面要留着
  const rebuild = g.slice(g.indexOf('function rebuild()'), g.indexOf('function sendRecluster()'));
  assert.doesNotMatch(rebuild, /setStatus\('loading'/);
  assert.match(g, /toast\('后台正在聚类，已切换到进度显示'\)/);
  // 后台自动聚类（加完文献那种）也要能看到进度
  assert.match(g, /if \(c && c\.running && !S\.watch\.sending\) startWatch\(c, null\);/);
  // 切换视图时把定时器清干净
  const closeFn = g.slice(g.indexOf('function close()'), g.indexOf('function close()') + 900);
  assert.match(closeFn, /stopWatch\(\);/);
});

test('样式：进度条有轨道、填充与完成态', () => {
  const css = read('knowledge-graph.css');
  assert.match(css, /\.kg-progress \{/);
  assert.match(css, /\.kg-progress-fill \{/);
  assert.match(css, /transition: width \.65s var\(--ease\)/);
  assert.match(css, /\.kg-progress\.is-done \.kg-progress-fill \{ background: var\(--green\); \}/);
  assert.match(css, /\.kg-progress-dot \{/);
});

test('HTTP：聚类跑起来后 status 能读到阶段与已处理篇数，结束后留下完成快照', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'v215-progress-'));
  const dataDir = path.join(root, 'data');
  const uploadDir = path.join(root, 'uploads');
  let server = null;
  let upstream = null;
  try {
    // 上游故意慢 500ms：这样才能在 POST 还挂着的时候读到「运行中」的中间态
    upstream = mockUpstream((_body, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(TOPICS_OK) } }] }));
      }, 500);
    });
    const upstreamBase = await listen(upstream);

    store.configure({ dataDir });
    store.saveSettings({
      aiProvider: 'custom',
      _modelMigrated: true,
      activeProfileId: 'p1',
      modelProfiles: [mockProfile('p1', upstreamBase)],
    });
    seedDocs([
      { id: 'a', title: '在线评论对酒店绩效的影响', authors: ['张三'] },
      { id: 'b', title: '在线评论与消费者购买意愿', authors: ['李四'] },
      { id: 'c', title: '供应链韧性的测量', authors: ['王五'] },
    ]);

    const { app } = createApp({ uploadDir });
    server = createServer(app);
    const base = await listen(server);
    await fetch(base + '/api/knowledge/rebuild', { method: 'POST' });

    // 不 await：POST 要等模型，正好用来观察中间态
    const pending = fetch(base + '/api/knowledge/recluster', { method: 'POST' })
      .then(async (r) => ({ status: r.status, body: await r.json() }));

    await new Promise((r) => setTimeout(r, 220));
    const mid = await (await fetch(base + '/api/knowledge/status')).json();
    assert.equal(mid.clustering.running, true, '聚类期间 running 必须为真');
    assert.ok(mid.clustering.progress, '聚类期间必须带进度对象');
    assert.equal(mid.clustering.progress.total, 3, '总篇数 = 知识库篇数');
    assert.ok(
      ['preparing', 'batching'].includes(mid.clustering.progress.stage),
      `模型还没返回时应处于准备 / 归类阶段，实际：${mid.clustering.progress.stage}`,
    );
    assert.equal(typeof mid.clustering.progress.elapsedMs, 'number', '要带已用时');

    const done = await pending;
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.topics.length, 2);

    const after = await (await fetch(base + '/api/knowledge/status')).json();
    assert.equal(after.clustering.running, false);
    assert.equal(after.clustering.progress.stage, 'done', '结束后留一份完成快照，前端才能把进度条走满');
    assert.equal(after.clustering.progress.done, 3, '完成快照里的已处理篇数应等于总篇数');
    assert.equal(after.clustering.progress.topics, 2);
    assert.equal(after.clustering.method, 'llm');
  } finally {
    if (server) await close(server);
    if (upstream) await close(upstream);
    store.saveSettings({ aiProvider: 'none', _modelMigrated: true, activeProfileId: '', modelProfiles: [] });
    await rm(root, { recursive: true, force: true });
  }
});

test('HTTP：聚类失败时进度清空，不留下假的 100%', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'v215-fail-'));
  const dataDir = path.join(root, 'data');
  const uploadDir = path.join(root, 'uploads');
  let server = null;
  let upstream = null;
  try {
    upstream = mockUpstream((_body, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: '模型炸了' } }));
    });
    const upstreamBase = await listen(upstream);

    store.configure({ dataDir });
    store.saveSettings({
      aiProvider: 'custom',
      _modelMigrated: true,
      activeProfileId: 'p1',
      modelProfiles: [mockProfile('p1', upstreamBase)],
    });
    seedDocs([{ id: 'a', title: '在线评论对酒店绩效的影响', authors: ['张三'] }]);

    const { app } = createApp({ uploadDir });
    server = createServer(app);
    const base = await listen(server);
    await fetch(base + '/api/knowledge/rebuild', { method: 'POST' });

    const res = await fetch(base + '/api/knowledge/recluster', { method: 'POST' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /聚类失败/);

    const after = await (await fetch(base + '/api/knowledge/status')).json();
    assert.equal(after.clustering.running, false);
    assert.equal(after.clustering.progress, null, '失败后进度要清空，否则前端会停在某个假百分比');
    assert.ok(after.clustering.error);
  } finally {
    if (server) await close(server);
    if (upstream) await close(upstream);
    store.saveSettings({ aiProvider: 'none', _modelMigrated: true, activeProfileId: '', modelProfiles: [] });
    await rm(root, { recursive: true, force: true });
  }
});
