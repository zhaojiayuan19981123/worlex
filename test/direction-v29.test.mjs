// direction-v29.test.mjs —— v2.9 的四个硬约束：等级 / WoS 核心 / 分页 / 中文翻译
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import * as store from '../src/store.js';
import { registerDirectionRoutes, parseTranslation } from '../src/directionRoutes.js';
import { DEFAULT_FILTERS } from '../src/directionSearch.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}
async function close(server) {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
}
const post = (base, url, body) => fetch(base + url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

function work(id, venue, isCore = true) {
  const inv = {};
  for (let i = 0; i < 40; i += 1) inv[`w${i}`] = [i];
  return {
    id: `https://openalex.org/W${id}`,
    ids: { openalex: `https://openalex.org/W${id}` },
    doi: `https://doi.org/10.1000/v29.${id}`,
    display_name: `Paper ${id}`,
    publication_year: 2024,
    publication_date: '2024-01-01',
    abstract_inverted_index: inv,
    authorships: [{ author: { display_name: 'Ada' } }],
    primary_location: { source: { display_name: venue, type: 'journal', is_core: isCore }, landing_page_url: `https://example.org/${id}` },
    cited_by_count: 10,
    type: 'article',
    language: 'en',
  };
}

async function newApp({ fetchImpl, queryRankImpl, translateImpl, secretKey = '' } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dir-v29-'));
  store.configure({ dataDir: dir });
  store.saveSettings({ ...store.getSettings(), easyScholarKey: secretKey });
  const app = express();
  app.use(express.json());
  registerDirectionRoutes(app, {
    store,
    fetchImpl: fetchImpl || (async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ meta: { count: 2 }, results: [] }) })),
    queryRankImpl: queryRankImpl || (async () => ({ code: 404, msg: 'not found' })),
    translateImpl: translateImpl || (async (text) => `标题：中文标题\n摘要：中文摘要（${text.length} 字）`),
    resolveRequestModel: () => ({ profile: { id: 'p1', provider: 'fake', baseURL: 'http://fake/v1', model: 'm' } }),
    fetchModelCompletion: async () => { throw new Error('not used'); },
    readLLMResponse: async () => '',
    logger: () => {},
  });
  const server = app.listen(0, '127.0.0.1');
  const base = await listen(server);
  return { base, server, dir, async cleanup() { await close(server); await rm(dir, { recursive: true, force: true }); } };
}

test('翻译结果解析：按「标题 / 摘要」拆段，格式跑偏整段当摘要', () => {
  assert.deepEqual(parseTranslation('标题：图神经网络\n摘要：我们研究冷启动。'), { title: '图神经网络', abstract: '我们研究冷启动。' });
  assert.deepEqual(parseTranslation('Title: Graph AI\nAbstract: We study graphs.'), { title: 'Graph AI', abstract: 'We study graphs.' });
  assert.deepEqual(parseTranslation('整段都是中文'), { title: '', abstract: '整段都是中文' });
});

test('等级接口：没配 easyScholar Key 时仍给 CWTS Core 标记', async () => {
  const ctx = await newApp();
  try {
    const data = await (await post(ctx.base, '/api/direction/ranks', {
      papers: [{ id: 'oa:1', venue: 'Nature', isCore: true }, { id: 'oa:2', venue: 'Unknown', isCore: false }],
    })).json();
    assert.equal(data.configured, false);
    assert.match(data.note, /CWTS Core/);
    assert.deepEqual(data.byId['oa:1'].items, [{ label: '核心来源', value: 'CWTS Core' }]);
    assert.equal(data.byId['oa:1'].wosCore, false, 'CWTS Core 不能冒充 WoS 核心');
    assert.deepEqual(data.byId['oa:2'].items, []);
  } finally { await ctx.cleanup(); }
});

test('等级接口：配了 Key 就用 easyScholar 的 WoS 数据集判定', async () => {
  const seen = [];
  const ctx = await newApp({
    secretKey: 'fake-key',
    queryRankImpl: async (name, key) => {
      seen.push([name, key]);
      return { code: 200, data: { officialRank: { all: { sciUp: '1区', ssci: 'Q1' } } } };
    },
  });
  try {
    const data = await (await post(ctx.base, '/api/direction/ranks', {
      papers: [{ id: 'oa:1', venue: 'Nature', isCore: true }],
    })).json();
    assert.equal(data.configured, true);
    assert.equal(data.byId['oa:1'].wosCore, true);
    assert.ok(data.byId['oa:1'].items.some((i) => i.label === '中科院分区'));
    assert.deepEqual(seen[0], ['Nature', 'fake-key']);
  } finally { await ctx.cleanup(); }
});

test('翻译接口：结果写回会话，切会话回来还在', async () => {
  const ctx = await newApp({
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({
      meta: { count: 1 }, results: [work(1, 'Nature')],
    }) }),
  });
  try {
    const search = await (await post(ctx.base, '/api/direction/search', {
      topics: [{ name: 'T', keywords: 'graph' }], filters: DEFAULT_FILTERS,
    })).json();
    const id = search.session.papers[0].id;
    const data = await (await post(ctx.base, '/api/direction/translate', {
      sessionId: search.session.id, paperIds: [id],
    })).json();
    assert.equal(data.byId[id].titleZh, '中文标题');
    const again = await (await fetch(`${ctx.base}/api/direction/session/${search.session.id}`)).json();
    assert.equal(again.session.papers[0].titleZh, '中文标题');
    assert.match(again.session.papers[0].abstractZh, /^中文摘要/);
  } finally { await ctx.cleanup(); }
});

test('严格模式：配了 Key 后按 WoS 收录剔除不满足的期刊', async () => {
  const ctx = await newApp({
    secretKey: 'fake-key',
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({
      meta: { count: 2 }, results: [work(1, 'WoS Journal'), work(2, 'Non WoS Journal')],
    }) }),
    queryRankImpl: async (name) => ({
      code: 200,
      data: { officialRank: { all: name === 'WoS Journal' ? { sciUp: '2区' } : { ccf: 'A' } } },
    }),
  });
  try {
    const data = await (await post(ctx.base, '/api/direction/search', {
      topics: [{ name: 'T', keywords: 'graph' }], filters: DEFAULT_FILTERS,
    })).json();
    assert.equal(data.session.papers.length, 1);
    assert.equal(data.session.papers[0].venue, 'WoS Journal');
    assert.equal(data.session.stats.wosFiltered, 1);
    assert.equal(data.wosStrict, true);
  } finally { await ctx.cleanup(); }
});
