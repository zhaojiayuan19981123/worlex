// v212-features.test.mjs —— v2.1.2 三项改动的接线与行为测试
//
// 1) 文中参考文献链接 → 解析命名目标并跳到对应位置（不再弹「暂不支持该链接类型」）
// 2) 高亮色块从第二行工具条收进顶部弹出式取色
// 3) 知识图谱改用大模型做主题聚类（本地仅作兜底）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../server.js';
import * as store from '../src/store.js';

// 统一换行符再断言：本机是 LF、GitHub Actions 的 Windows 检出是 CRLF，
// 带 `;` 紧邻换行的正则（如 `;\n    hide…`）在 CRLF 下会失配。
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

test('参考文献链接：命名目标 / 显式目标都能解析成页码并落位', () => {
  const links = read('pdf-links.js');
  // 注释里的 dest 原样带出，不再只认 http(s) 字符串
  assert.match(links, /const dest = a\.dest != null \? a\.dest : null;/);
  assert.match(links, /fromLink: true/);
  // 命名目标解析：getDestination → getPageIndex（与 pdf.js 自己的 LinkService 一致）
  assert.match(links, /await doc\.getDestination\(arr\)/);
  assert.match(links, /await doc\.getPageIndex\(arr\[0\]\)/);
  assert.match(links, /function destRect\(/);
  // 落位：滚动到目标 + 闪一下框；跳转失败才提示，不再一句「暂不支持」
  assert.match(links, /function scrollToBox\(/);
  assert.match(links, /function flash\(wrap, box\)/);
  assert.match(links, /if \(info\.dest != null\) \{ gotoDest\(info\.dest\); return; \}/);
  assert.match(links, /if \(info\.fromLink && raw\) \{ gotoDest\(raw\); return; \}/);
  // 视口换算走主程序的 getPageViewport（含当前缩放与该页额外旋转）
  assert.match(read('app.js'), /\n    viewport: \(page, n\) => getPageViewport\(page, n\),/);
  assert.match(read('pdf-links.css'), /\.pl-dest-mark/);
});

test('落点定位框：目标页懒渲染把它清掉之后会自动补挂回去', () => {
  const links = read('pdf-links.js');
  // 跳转目标往往在视口外，滚动到位才开始渲染，而 renderPageInto 会 wrap.innerHTML = ''，
  // 刚挂上的框同一帧就被清掉 —— 必须盯住容器补挂，不能挂上去就不管。
  assert.match(links, /const keep = \(\) => \{ if \(!mark\.isConnected\) wrap\.appendChild\(mark\); \};/);
  assert.match(links, /new MutationObserver\(keep\)/);
  assert.match(links, /mo\.observe\(wrap, \{ childList: true \}\)/);
  // 先停观察再摘框：否则 remove() 本身会触发回调，又把框挂回去
  assert.match(links, /if \(mo\) mo\.disconnect\(\);\n\s+if \(mark\.parentNode\) mark\.remove\(\);/);
  // 「等渲染结束再挂」不可靠（平滑滚动耗时不定，渲染可能比预估更晚才开始），已删掉
  assert.doesNotMatch(links, /waitPagePainted/);
});

test('高亮色块：收进顶部工具条的弹出取色，第二行只剩大纲 / 原文译文', () => {
  const html = read('index.html');
  // 仍然存在（旧测试与 show() 逻辑都依赖这个 id），但位置挪到了顶部工具条里
  assert.match(html, /id="prColorTools"/);
  assert.ok(html.indexOf('id="prColorTools"') < html.indexOf('id="prToolStrip"'), '色块应在顶部工具条 #prPdfTools 内');
  assert.match(html, /id="prColorBtn"/);
  assert.match(html, /id="prColorPop"/);
  assert.match(html, /id="prColorDot"/);
  const css = read('style.css');
  assert.match(css, /\.pr-color-pop \{/);
  assert.match(css, /\.pr-color-dot\[data-color="yellow"\]/);
  const app = read('app.js');
  assert.match(app, /const colorBtn = \$\('prColorBtn'\);/);
  assert.match(app, /colorBtn\?\.addEventListener\('click'/);
  assert.match(app, /if \(colorDot\) colorDot\.dataset\.color = c\.dataset\.color;/);
  assert.match(app, /function hideColorPopover\(\)/);
  assert.match(app, /pr\.open = false;\n    hideColorPopover\(\);/);
});

test('知识图谱：前端走大模型聚类接口，并显示聚类方式', () => {
  const g = read('knowledge-graph.js');
  assert.match(g, /api\('\/api\/knowledge\/recluster', \{ method: 'POST' \}\)/);
  assert.match(g, /大模型聚类/);
  assert.match(g, /'AI 重新聚类'/);
  const server = readText('../server.js');
  assert.match(server, /app\.post\('\/api\/knowledge\/recluster'/);
  assert.match(server, /async function requestLlmClusters\(/);
  assert.match(server, /按「研究主题 \/ 研究对象 \/ 理论视角」/);
  assert.match(server, /topicGroups: llmGroupsForIndex\(\) \|\| undefined/);
  assert.match(server, /scheduleLlmClustering\(\);/);
});

/** 上游 mock：只认 /v1/chat/completions，返回固化的聚类 JSON（故意带围栏 + 假 id）。 */
function mockClusterUpstream(onCall, topicIds) {
  return createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    onCall(raw);
    const content = '```json\n' + JSON.stringify({
      topics: [
        { name: '在线评论与酒店绩效', keywords: ['在线评论', '酒店'], ids: [...topicIds, 'ghost-id'] },
        { name: '空主题（应被丢弃）', ids: [] },
      ],
    }) + '\n```';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
}

function seedLiterature(ids) {
  for (const id of ids) {
    store.upsertLiterature({
      id, title: `文献 ${id}`, titleZh: `中文标题 ${id}`, authors: ['张三'], year: 2024,
      journal: '管理世界', docType: 'empirical', collectionId: '', keywords: ['评论', '酒店'],
      summary: '这是一段摘要，用于让聚类提示词有内容可读。', tokens: ['评论', '酒店'], tags: [],
      status: 'done', annotations: [], attachments: [],
    });
  }
}

/**
 * 上游 mock：一次喂太多篇就报「上下文超限」，模拟推理模型在长目录上超时/截断。
 * 用来验证分批 + 拆半重试真的把大请求拆开了，而不是悄悄丢掉那一批。
 */
function mockOverflowUpstream(onCall) {
  return createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const ids = [...new Set(String(raw).match(/lit-\d{4}/g) || [])];
    onCall(ids.length);
    if (ids.length > 12) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'context length exceeded' } }));
      return;
    }
    const content = JSON.stringify({ topics: [{ name: '统一主题', keywords: ['评论'], ids }] });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
}

test('批次超限时对半拆批重试：45 篇拆成 40/5 → 再拆到 ≤10，最终一篇不漏', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'v212-split-'));
  const dataDir = path.join(root, 'data');
  const uploadDir = path.join(root, 'uploads');
  let server = null;
  let upstream = null;
  try {
    store.configure({ dataDir });
    const ids = Array.from({ length: 45 }, (_, i) => `lit-${String(i + 1).padStart(4, '0')}`);
    seedLiterature(ids);
    const sizes = [];
    upstream = mockOverflowUpstream((n) => sizes.push(n));
    const upstreamBase = await listen(upstream);
    store.saveSettings({
      aiProvider: 'custom',
      _modelMigrated: true,
      activeProfileId: 'p1',
      modelProfiles: [{
        id: 'p1', label: '模拟供应商', provider: 'custom',
        baseURL: `${upstreamBase}/v1/chat/completions`, apiKey: '', model: 'mock-model',
        streamMode: 'nonstream', systemPromptMode: 'auto', authMode: 'none', visionOverride: 'no',
        createdAt: new Date().toISOString(),
      }],
      modelRouter: { enabled: true, failover: false, queue: [], breaker: { failThreshold: 3, openSeconds: 60 } },
    });

    const { app } = createApp({ uploadDir });
    server = createServer(app);
    const base = await listen(server);

    await fetch(base + '/api/knowledge/rebuild', { method: 'POST' });
    const re = await fetch(base + '/api/knowledge/recluster', { method: 'POST' });
    const out = await re.json();
    assert.equal(re.status, 200, JSON.stringify(out));
    assert.equal(out.method, 'llm');
    assert.equal(out.warning || '', '', '拆半重试后不该再有失败批次');

    // 40 篇那一批被拆成 20/20，再拆成 10/10；5 篇那批一次过。
    // 两个批次并发跑，顺序不定，所以比对排序后的尺寸序列。
    assert.deepEqual(sizes.slice().sort((a, b) => a - b), [5, 10, 10, 10, 10, 20, 20, 40],
      `实际调用尺寸：${sizes.join(',')}`);
    assert.ok(sizes.filter((n) => n > 12).length === 3, '只应有 3 次超限尝试（40 一次、20 两次）');

    const graph = await (await fetch(base + '/api/knowledge/graph')).json();
    assert.equal(graph.clustering.method, 'llm');
    assert.equal(graph.nodes.length, 45, '拆批不能漏文献');
    assert.equal(graph.topics.length, 1, '同名主题应合并成一个');
    assert.ok(graph.nodes.every((n) => n.topicLabel === '统一主题'), '每篇都应带上模型给的主题');
    assert.deepEqual(graph.nodes.map((n) => n.id).sort(), ids.slice().sort());
  } finally {
    if (server) await close(server);
    if (upstream) await close(upstream);
    store.saveSettings({ aiProvider: 'none', _modelMigrated: true, activeProfileId: '', modelProfiles: [] });
    await rm(root, { recursive: true, force: true });
  }
});

test('没有可用模型时：AI 聚类返回 400 并说明原因，图谱仍按本地聚类可用', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'v212-nomodel-'));
  const dataDir = path.join(root, 'data');
  const uploadDir = path.join(root, 'uploads');
  let server = null;
  try {
    store.configure({ dataDir });
    store.saveSettings({ aiProvider: 'none', _modelMigrated: true, activeProfileId: '', modelProfiles: [] });
    seedLiterature(['a', 'b']);
    const { app } = createApp({ uploadDir });
    server = createServer(app);
    const base = await listen(server);

    const re = await fetch(base + '/api/knowledge/recluster', { method: 'POST' });
    assert.equal(re.status, 400);
    const data = await re.json();
    assert.match(data.error, /AI/);

    const graph = await (await fetch(base + '/api/knowledge/graph')).json();
    assert.equal(graph.clustering.method, 'local');
    assert.equal(graph.stats.documents, 2);
  } finally {
    if (server) await close(server);
    store.saveSettings({ aiProvider: 'none', _modelMigrated: true, activeProfileId: '', modelProfiles: [] });
    await rm(root, { recursive: true, force: true });
  }
});

test('配了模型时：AI 聚类把主题写进图谱，假 id 被丢掉、未归类的进「未分类」', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'v212-llm-'));
  const dataDir = path.join(root, 'data');
  const uploadDir = path.join(root, 'uploads');
  let server = null;
  let upstream = null;
  try {
    store.configure({ dataDir });
    seedLiterature(['lit-aaa', 'lit-bbb', 'lit-ccc']);
    let sawPrompt = '';
    upstream = mockClusterUpstream((raw) => { sawPrompt = raw; }, ['lit-aaa', 'lit-bbb']);
    const upstreamBase = await listen(upstream);
    store.saveSettings({
      aiProvider: 'custom',
      _modelMigrated: true,
      activeProfileId: 'p1',
      modelProfiles: [{
        id: 'p1', label: '模拟供应商', provider: 'custom',
        baseURL: `${upstreamBase}/v1/chat/completions`, apiKey: '', model: 'mock-model',
        streamMode: 'nonstream', systemPromptMode: 'auto', authMode: 'none', visionOverride: 'no',
        createdAt: new Date().toISOString(),
      }],
      modelRouter: { enabled: true, failover: false, queue: [], breaker: { failThreshold: 3, openSeconds: 60 } },
    });

    const { app } = createApp({ uploadDir });
    server = createServer(app);
    const base = await listen(server);

    await fetch(base + '/api/knowledge/rebuild', { method: 'POST' });
    const re = await fetch(base + '/api/knowledge/recluster', { method: 'POST' });
    const out = await re.json();
    assert.equal(re.status, 200, JSON.stringify(out));
    assert.equal(out.method, 'llm');
    assert.match(sawPrompt, /研究主题/, '提示词应要求按研究主题归类');
    assert.match(sawPrompt, /只输出 JSON/, '提示词应要求只输出 JSON');

    const graph = await (await fetch(base + '/api/knowledge/graph')).json();
    assert.equal(graph.clustering.method, 'llm');
    assert.equal(graph.clustering.model, '模拟供应商');
    assert.ok(graph.clustering.at, '应记录聚类时间');
    const labels = graph.topics.map((t) => t.label);
    assert.ok(labels.includes('在线评论与酒店绩效'), labels.join(','));
    const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
    assert.equal(byId['lit-aaa'].topicLabel, '在线评论与酒店绩效');
    assert.equal(byId['lit-ccc'].topicLabel, '未分类', '没被模型归类的文献要有兜底主题');
    assert.ok(!graph.nodes.some((n) => n.id === 'ghost-id'), '模型编造的 id 不能进图谱');

    // 持久化：重开一个实例（同一数据目录）应直接读到 llm 分组，不必再调模型
    const again = createApp({ uploadDir });
    const server2 = createServer(again.app);
    const base2 = await listen(server2);
    try {
      const g2 = await (await fetch(base2 + '/api/knowledge/graph')).json();
      assert.equal(g2.clustering.method, 'llm');
      assert.ok(g2.topics.some((t) => t.label === '在线评论与酒店绩效'));
    } finally {
      await close(server2);
    }
  } finally {
    if (server) await close(server);
    if (upstream) await close(upstream);
    await rm(root, { recursive: true, force: true });
  }
});
