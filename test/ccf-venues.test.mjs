// ccf-venues.test.mjs —— CCF A / B 类期刊与会议接入顶刊追踪的目录级测试
//
// 覆盖点：
//   1) 目录完整性（id 唯一、等级只有 A/B、期刊有 ISSN 或 RSS、中文刊有取数地址、会议适配器合法）
//   2) 两套 CCF 分组恰好各自覆盖 A / B 的全部场馆，不漏不重
//   3) catalogFor 按场馆类型算出正确的数据源（Crossref / 知网 / 官网目录 / 官网 RSS / 会议官网）
//   4) 中文刊的数据源切换仍然可用，且「选了但没地址」时自动回落
//   5) syncJournals 按 provider 正确分流（会议走 conf、JMLR 走 rss、英文刊走 Crossref）

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALL_JOURNALS,
  JOURNAL_SETS,
  catalogFor,
  createTopJournalState,
  syncJournals,
} from '../src/topJournals.js';
import { CCF_CONFERENCES, CCF_JOURNALS, CCF_VENUES } from '../src/ccfVenues.js';
import { CONF_ADAPTERS } from '../src/confFeed.js';

test('CCF 目录：id 唯一、等级只有 A/B、分类与必填字段齐全', () => {
  const ids = new Set();
  for (const venue of CCF_VENUES) {
    assert.match(venue.id, /^ccf-/, `${venue.id} 缺少 ccf- 前缀`);
    assert.ok(!ids.has(venue.id), `${venue.id} 重复`);
    ids.add(venue.id);
    assert.ok(['A', 'B'].includes(venue.ccf), `${venue.id} 等级非法：${venue.ccf}`);
    assert.ok(venue.shortTitle && venue.title && venue.category, `${venue.id} 字段不全`);
    assert.equal(venue.set, 'ccf');
  }
  assert.ok(CCF_JOURNALS.length >= 30, 'CCF 期刊太少');
  assert.ok(CCF_CONFERENCES.length >= 10, 'CCF 会议太少');
});

test('CCF 英文刊：ISSN 格式合法；JMLR 没有 DOI 所以走官网 RSS', () => {
  for (const journal of CCF_JOURNALS.filter((item) => item.language === 'en')) {
    assert.match(journal.issn, /^\d{4}-\d{3}[\dX]$/, `${journal.id} 的 ISSN 不合法：${journal.issn}`);
    assert.ok(['crossref', 'rss'].includes(journal.provider), `${journal.id} 的 provider 非法`);
    if (journal.provider === 'rss') assert.match(journal.rssUrl, /^https:\/\//, `${journal.id} 缺 rssUrl`);
  }
});

test('CCF 中文刊：必须能取到数（知网代码或官网目录地址），并标注中文 T1/T2', () => {
  for (const journal of CCF_JOURNALS.filter((item) => item.language === 'zh')) {
    assert.ok(journal.cnkiCode || journal.feedUrl, `${journal.id} 既没有知网代码也没有目录地址`);
    assert.ok(['cnki', 'site'].includes(journal.provider), `${journal.id} 的 provider 非法`);
    assert.match(journal.ccfNote, /中文/, `${journal.id} 应注明中文分级口径`);
  }
});

test('CCF 会议：适配器必须在白名单内，办会月份合法', () => {
  for (const venue of CCF_CONFERENCES) {
    assert.equal(venue.kind, 'conference');
    assert.ok(CONF_ADAPTERS.includes(venue.conf?.adapter), `${venue.id} 适配器未知：${venue.conf?.adapter}`);
    assert.ok(venue.month >= 1 && venue.month <= 12, `${venue.id} 月份非法`);
    assert.match(venue.publisherUrl, /^https:\/\//, `${venue.id} 缺官网地址`);
  }
});

test('两套 CCF 分组恰好覆盖 A / B 全部场馆，不漏不重', () => {
  const setA = JOURNAL_SETS.find((set) => set.id === 'ccfA');
  const setB = JOURNAL_SETS.find((set) => set.id === 'ccfB');
  assert.ok(setA && setB);
  assert.equal(setA.collapsible, true);
  const idsA = new Set(setA.journalIds);
  const idsB = new Set(setB.journalIds);
  assert.equal(idsA.size + idsB.size, new Set([...setA.journalIds, ...setB.journalIds]).size, 'A/B 有交叉');
  for (const venue of CCF_VENUES) {
    const bucket = venue.ccf === 'A' ? idsA : idsB;
    assert.ok(bucket.has(venue.id), `${venue.id} 没有进 CCF-${venue.ccf} 分组`);
  }
  // 会议也要进分组，不能只收期刊
  assert.ok(setA.journalIds.some((id) => CCF_CONFERENCES.some((venue) => venue.id === id)));
  assert.ok([...setA.journalIds, ...setB.journalIds].every((id) => ALL_JOURNALS.some((venue) => venue.id === id)));
});

test('catalogFor：按场馆类型算出实际数据源', () => {
  const catalog = catalogFor(createTopJournalState({}));
  const byId = new Map(catalog.map((venue) => [venue.id, venue]));
  assert.equal(byId.get('ccf-tpami').sourceId, 'crossref');
  assert.equal(byId.get('ccf-jmlr').sourceId, 'rss');
  assert.equal(byId.get('ccf-rjxb').sourceId, 'cnki');
  assert.equal(byId.get('ccf-jsjyfz').sourceId, 'site');
  assert.equal(byId.get('ccf-neurips').sourceId, 'conf');
  assert.equal(byId.get('ccf-neurips').kind, 'conference');
  // 原有两套不受影响
  assert.equal(byId.get('jof').sourceId, 'crossref');
  assert.equal(byId.get('cn-jmsc').sourceId, 'cnki');
});

test('catalogFor：中文 CCF 刊可以切到官网目录，没地址时回落知网', () => {
  const state = createTopJournalState({ sourcePrefs: { 'ccf-jsjyfz': 'cnki', 'ccf-rjxb': 'site' } });
  const byId = new Map(catalogFor(state).map((venue) => [venue.id, venue]));
  // 计算机研究与发展：只有官网目录，选知网也会回落
  assert.equal(byId.get('ccf-jsjyfz').sourceId, 'site');
  // 软件学报：只有知网代码，选官网目录也会回落
  assert.equal(byId.get('ccf-rjxb').sourceId, 'cnki');
});

test('createTopJournalState：CCF 场馆的订阅会被保留，未知 id 被丢弃', () => {
  const state = createTopJournalState({ selectedJournalIds: ['ccf-cvpr', 'ccf-tpami', 'not-a-venue'] });
  assert.deepEqual(state.selectedJournalIds.sort(), ['ccf-cvpr', 'ccf-tpami']);
});

test('syncJournals：会议走会议官网、JMLR 走官网 RSS、英文刊走 Crossref', async () => {
  const nipsHtml = `<ul><li class="conference"><div class="paper-content"><a href="/paper_files/paper/2024/hash/x-Abstract-Conference.html">A Very Real NeurIPS Paper Title</a><span class="paper-authors">A One, B Two</span></div></li></ul>`;
  const jmlrXml = `<?xml version="1.0"?><rss><channel><item><title>A JMLR Paper About Something</title><link>http://jmlr.org/papers/v27/26-1.html</link><pubDate>2026</pubDate><author>X Y</author><description>Abstract text.</description></item></channel></rss>`;
  const crossrefPayload = {
    message: {
      items: [{
        DOI: '10.1109/tpami.2026.0001',
        title: ['A TPAMI Paper'],
        author: [{ given: 'A', family: 'B' }],
        'container-title': ['IEEE Transactions on Pattern Analysis and Machine Intelligence'],
        published: { 'date-parts': [[2026, 10, 1]] },
        type: 'journal-article',
      }],
    },
  };
  const fetchImpl = async (url) => {
    const target = String(url);
    // 只让 2024 届存在，验证「当年没有就退到上一年」的逻辑在分流路径上同样生效
    if (target.includes('papers.nips.cc/paper_files/paper/2024')) return { ok: true, text: async () => nipsHtml };
    if (target.includes('papers.nips.cc')) return { ok: false, status: 404 };
    if (target.includes('jmlr.xml')) return { ok: true, text: async () => jmlrXml };
    if (target.includes('api.crossref.org')) return { ok: true, json: async () => crossrefPayload };
    return { ok: false, status: 404 };
  };
  const result = await syncJournals(createTopJournalState({}), ['ccf-neurips', 'ccf-jmlr', 'ccf-tpami'], { fetchImpl, force: true });
  assert.deepEqual(result.failed, []);
  const byId = new Map(result.synced.map((row) => [row.journalId, row.provider]));
  assert.equal(byId.get('ccf-neurips'), 'conf');
  assert.equal(byId.get('ccf-jmlr'), 'rss');
  assert.equal(byId.get('ccf-tpami'), 'crossref');
  // 会议记录里带上「第几届」与目录页地址
  assert.equal(result.state.sync['ccf-neurips'].edition, '2024');
  assert.match(result.state.sync['ccf-neurips'].sourceUrl, /paper_files\/paper\/2024/);
  assert.equal(result.state.articles.filter((row) => row.journalId === 'ccf-neurips').length, 1);
});

test('syncJournals：三小时内抓过的会议不再重复下载大目录页', async () => {
  const state = createTopJournalState({
    articles: [{ id: 'conf:x', journalId: 'ccf-cvpr', title: 'Old Paper', publishedAt: '2026-06-01' }],
    sync: { 'ccf-cvpr': { lastSuccessAt: new Date().toISOString(), count: 1, sourceId: 'conf' } },
  });
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: false, status: 500 }; };
  const result = await syncJournals(state, ['ccf-cvpr'], { fetchImpl, force: false });
  assert.equal(calls, 0, '不该发起请求');
  assert.deepEqual(result.failed, []);
  assert.equal(result.synced[0].cached, true);
});
