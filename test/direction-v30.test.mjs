// direction-v30.test.mjs —— 50 篇上限 / 一键选前 50 / 报告可视化 / 翻译引擎
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import express from 'express';

import * as store from '../src/store.js';
import { registerDirectionRoutes } from '../src/directionRoutes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(path.join(ROOT, p), 'utf8');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}
const post = (base, url, body) => fetch(base + url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

async function newApp(translateImpl) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dir-v30-'));
  store.configure({ dataDir: dir });
  const app = express();
  app.use(express.json());
  registerDirectionRoutes(app, {
    store,
    fetchImpl: async () => ({ ok: true, text: async () => '{}' }),
    translateImpl,
    resolveRequestModel: () => ({ profile: { id: 'p1', provider: 'fake', baseURL: 'http://fake/v1', model: 'm' } }),
    fetchModelCompletion: async () => { throw new Error('not used'); },
    readLLMResponse: async () => '',
    logger: () => {},
  });
  const server = app.listen(0, '127.0.0.1');
  const base = await listen(server);
  return { base, dir, async cleanup() { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); await rm(dir, { recursive: true, force: true }); } };
}

function paper(i) {
  return {
    id: `p${i}`, title: `Paper ${i}`, abstract: `We study topic ${i} with enough detail for analysis.`,
    year: 2024, venue: 'Journal', authors: [], authorLine: 'A', topics: [],
  };
}

test('元信息公开 50 篇上限（分析与翻译一致）', async () => {
  const ctx = await newApp();
  try {
    const data = await (await fetch(`${ctx.base}/api/direction`)).json();
    assert.equal(data.meta.limits.maxAnalyzePapers, 50);
    assert.equal(data.meta.limits.maxTranslatePapers, 50);
  } finally { await ctx.cleanup(); }
});

test('后端拒绝超过 50 篇的分析请求', async () => {
  const ctx = await newApp();
  try {
    const papers = Array.from({ length: 51 }, (_, i) => paper(i));
    store.saveDirectionState({
      version: 1,
      sessions: [{
        id: 's-over', title: 'over', topics: [{ id: 't1', name: 'T', keywords: 'x' }],
        filters: {}, papers, selected: papers.map((p) => p.id), analyses: [],
      }],
      activeSessionId: 's-over', preferences: {},
    });
    const res = await post(ctx.base, '/api/direction/analyze', { sessionId: 's-over', mode: 'both' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /最多分析 50 篇/);
  } finally { await ctx.cleanup(); }
});

test('翻译后台任务拿到的引擎必须是非大模型服务', async () => {
  const engines = [];
  const ctx = await newApp(async (segments, opts) => {
    engines.push(opts.engine);
    return segments.map((s) => ({ id: s.id, translation: `译：${s.text}`, error: '' }));
  });
  try {
    const papers = [paper(1)];
    store.saveDirectionState({
      version: 1,
      sessions: [{ id: 's1', title: 's1', topics: [], filters: {}, papers, selected: [], analyses: [] }],
      activeSessionId: 's1', preferences: {},
    });
    const started = await (await post(ctx.base, '/api/direction/translate', {
      sessionId: 's1', paperIds: ['p1'], engine: 'deepl',
    })).json();
    assert.equal(started.engine, 'deepl');
    let job;
    for (let i = 0; i < 20; i += 1) {
      job = await (await fetch(`${ctx.base}/api/direction/translate/job/${started.jobId}`)).json();
      if (job.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(job.status, 'done');
    assert.deepEqual(engines, ['deepl']);
    assert.ok(!['siliconflow', 'builtin', ''].includes(engines[0]));
  } finally { await ctx.cleanup(); }
});

test('前端：一键选前 50 / 上限 / 翻译引擎下拉 / 可视化接线都在', async () => {
  const dirJs = await read('public/direction.js');
  const vizJs = await read('public/direction-viz.js');
  const html = await read('public/index.html');
  const css = await read('public/direction.css');
  assert.match(dirJs, /select-top50/);
  assert.match(dirJs, /一键选前 50 篇/);
  assert.match(dirJs, /const MAX_SELECT = 50/);
  assert.match(dirJs, /translate-engine/);
  assert.match(dirJs, /translate\/job\//);
  assert.match(dirJs, /DirectionViz\.wordCloudSvg/);
  assert.match(dirJs, /DirectionViz\.graphSvg/);
  assert.match(dirJs, /data-dir="viz-tab"/);
  assert.match(vizJs, /function wordCloudSvg/);
  assert.match(vizJs, /function graphSvg/);
  assert.match(html, /<script src="direction-viz\.js"><\/script>/);
  assert.match(css, /\.dir-viz-svg/);
});
