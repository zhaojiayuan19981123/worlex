// arxiv-v30.test.mjs —— arXiv 翻译（翻译引擎）+ 一键导入文献中心
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import express from 'express';

import * as store from '../src/store.js';
import { registerArxivRoutes } from '../src/arxivRoutes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(path.join(ROOT, p), 'utf8');
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const post = (base, url, body) => fetch(base + url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const entry = (id, title) => ({
  id, title, abstract: `Abstract of ${title}.`, authors: ['Ada', 'Bob'], authorLine: 'Ada，Bob',
  published: '2025-03-01', categories: ['cs.AI', 'cs.LG'], journalRef: '',
  doi: '', absUrl: `https://arxiv.org/abs/${id}`, pdfUrl: `https://arxiv.org/pdf/${id}`,
});

async function newApp(translateImpl) {
  const dir = await mkdtemp(path.join(tmpdir(), 'arxiv-v30-'));
  store.configure({ dataDir: dir });
  const app = express();
  app.use(express.json());
  registerArxivRoutes(app, {
    store,
    makeRecord: () => ({ id: store.newId(), docType: 'empirical', collectionId: null, status: 'pending' }),
    translateImpl,
    logger: () => {},
  });
  const server = app.listen(0, '127.0.0.1');
  const base = await listen(server);
  return { base, dir, async cleanup() { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); await rm(dir, { recursive: true, force: true }); } };
}

test('翻译：走注入的翻译引擎，后台任务把标题/摘要中文写回 byId', async () => {
  const seen = [];
  const ctx = await newApp(async (segments, opts) => {
    seen.push(opts.engine);
    return segments.map((s) => ({ id: s.id, translation: `中文：${s.text}`, error: '' }));
  });
  try {
    const started = await (await post(ctx.base, '/api/arxiv/translate', {
      items: [entry('2501.00001', 'Graph Models')], engine: 'youdaoweb',
    })).json();
    assert.equal(started.total, 1);
    assert.equal(started.segments, 2);
    let job;
    for (let i = 0; i < 20; i += 1) {
      job = await (await fetch(`${ctx.base}/api/arxiv/translate/job/${started.jobId}`)).json();
      if (job.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(job.status, 'done');
    assert.match(job.byId['2501.00001'].titleZh, /^中文/);
    assert.match(job.byId['2501.00001'].abstractZh, /^中文/);
    assert.deepEqual(seen, ['youdaoweb']);
    assert.ok(!['siliconflow', 'builtin', ''].includes(seen[0]));
  } finally { await ctx.cleanup(); }
});

test('导入：按 arXiv id / 标题去重，元数据与目标文库正确', async () => {
  const ctx = await newApp();
  try {
    store.saveCollections([
      { id: 'col-a', name: '机器学习', docType: 'algorithm', createdAt: '' },
      { id: 'col-e', name: '实证', docType: 'empirical', createdAt: '' },
    ]);
    const items = [entry('2501.00001', 'Graph Models'), { ...entry('2501.00002', 'LLM Planning'), titleZh: '大模型规划' }];
    const first = await (await post(ctx.base, '/api/arxiv/import', {
      items, docType: 'algorithm', collectionId: 'col-a',
    })).json();
    assert.equal(first.imported, 2);
    assert.equal(first.docType, 'algorithm');
    assert.equal(first.collectionId, 'col-a');
    const saved = store.listLiterature().find((r) => r.title === 'Graph Models');
    assert.equal(saved.source, 'arxiv');
    assert.equal(saved.arxivId, '2501.00001');
    assert.equal(saved.authors, 'Ada，Bob');
    assert.equal(saved.year, 2025);
    assert.equal(saved.keywords, 'cs.AI, cs.LG');
    const second = await (await post(ctx.base, '/api/arxiv/import', {
      items, docType: 'algorithm', collectionId: 'col-a',
    })).json();
    assert.equal(second.imported, 0);
    assert.equal(second.skipped.length, 2);
    // 同一篇可以再进另一个文库
    const other = await (await post(ctx.base, '/api/arxiv/import', {
      items: [items[0]], docType: 'empirical', collectionId: 'col-e',
    })).json();
    assert.equal(other.imported, 1);
  } finally { await ctx.cleanup(); }
});

test('导入：非法分类或空列表不会建记录', async () => {
  const ctx = await newApp();
  try {
    const bad = await post(ctx.base, '/api/arxiv/import', { items: [entry('x', 'X')], docType: 'algorithm', collectionId: 'col-e' });
    assert.equal(bad.status, 200); // 分类不属于该文库时降级为未分类，而不是塞错地方
    assert.equal((await bad.json()).collectionId, null);
    const empty = await post(ctx.base, '/api/arxiv/import', { items: [], docType: 'empirical' });
    assert.equal(empty.status, 400);
    assert.equal(store.listLiterature().length, 1);
  } finally { await ctx.cleanup(); }
});

test('前端 / 后端接线：翻译与导入按钮、引擎下拉、路由都齐全', async () => {
  const js = await read('public/arxiv.js');
  const css = await read('public/arxiv.css');
  const routes = await read('src/arxivRoutes.js');
  const server = await read('server.js');
  assert.match(js, /data-ax="translate-selected"/);
  assert.match(js, /data-ax="translate-one"/);
  assert.match(js, /data-ax="import-page"/);
  assert.match(js, /data-ax="import-selected"/);
  assert.match(js, /data-ax="lib"/);
  assert.match(js, /data-ax="collection"/);
  assert.match(js, /arxiv\/translate\/job\//);
  assert.match(css, /\.ax-import-bar/);
  assert.match(routes, /app\.post\('\/api\/arxiv\/translate'/);
  assert.match(routes, /app\.post\('\/api\/arxiv\/import'/);
  assert.match(server, /\/api\/translate\/engines/);
});
