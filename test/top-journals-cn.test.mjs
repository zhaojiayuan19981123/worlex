// 中国期刊（NSFC 管理科学部 A 类 22 种）接入顶刊追踪的测试：
// 目录完整性、目录页解析、编码、日期推断、按 provider 分流同步、用户自填目录页。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALL_JOURNALS,
  CN_A_JOURNALS,
  JOURNAL_SETS,
  UTD_JOURNALS,
  catalogFor,
  createTopJournalState,
  journalById,
  syncJournals,
} from '../src/topJournals.js';
import { CCF_VENUES } from '../src/ccfVenues.js';
import {
  dateFromArticleUrl,
  decodeHtml,
  fetchCnJournalArticles,
  issueDateFromHtml,
  parseJournalIssuePage,
} from '../src/cnJournalFeed.js';

const MAGTECH_HTML = `<html><head><meta charset="gbk"><title>金融研究 2026年第11期</title></head><body>
<div class="nav">
  <a href="/CN/volumn/home.shtml">当期目录</a>
  <a href="/CN/column/column12.shtml">投稿指南</a>
  <a href="/CN/column/column13.shtml">编委会</a>
</div>
<ul class="article-list">
  <li><a href="/CN/Y2026/V560/I11/1">数字化转型与企业创新——基于中国上市公司的经验证据</a></li>
  <li><a href="/CN/Y2026/V560/I11/2">绿色金融能否促进经济“脱虚向实”——来自改革试验区的证据</a></li>
  <li><a href="/CN/Y2026/V560/I11/3">银行竞争、利率市场化与货币政策传导效果研究</a></li>
</ul>
<a href="/CN/Y2026/V560/I11/1">【下载全文和数据】</a>
<a href="/CN/column/item88.shtml">《金融研究》2026年度优秀论文公示</a>
</body></html>`;

const JOURNAL = { id: 'cn-jryj', title: '金融研究' };

// 知网 RSS 的真实形态：channel + item，item 带 title/link/description/pubDate/author
const CNKI_RSS = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel>
  <title>金融研究-CNKI</title>
  <link>https://navi.cnki.net/knavi/journals/JRYJ/detail?uniplatform=NZKPT</link>
  <item>
    <title>地方政府债务置换对企业债务违约风险的影响研究</title>
    <link>https://kns.cnki.net/kcms2/article/abstract?v=AAA111&amp;uniplatform=NZKPT</link>
    <description>本文利用 2015—2022 年城投债数据，考察债务置换对企业违约风险的影响...</description>
    <pubDate>Wed, 25 Nov 2026 16:00:00 GMT</pubDate>
    <author>张三;李四;</author>
  </item>
  <item>
    <title>银行资本监管改革与地方政府债券融资成本</title>
    <link>https://kns.cnki.net/kcms2/article/abstract?v=BBB222&amp;uniplatform=NZKPT</link>
    <description>基于 2018 年资管新规的准自然实验...</description>
    <pubDate>Wed, 25 Nov 2026 16:00:00 GMT</pubDate>
    <author>王五;</author>
  </item>
  <item>
    <title>《金融研究》2027 年征稿启事</title>
    <link>https://kns.cnki.net/kcms2/article/abstract?v=CCC333</link>
    <description>本刊 2027 年重点选题如下...</description>
    <pubDate>Tue, 24 Nov 2026 16:00:00 GMT</pubDate>
    <author></author>
  </item>
</channel></rss>`;

function fakeResponse(body, { status = 200, url = 'http://www.jryj.org.cn/CN/1002-7246/home.shtml', contentType = 'text/html; charset=utf-8' } = {}) {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: (key) => (String(key).toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
  };
}

test('中国 A 类 22 本全部在目录内，id 与 ISSN 不重复，分组覆盖全集', () => {
  assert.equal(CN_A_JOURNALS.length, 22);
  assert.equal(UTD_JOURNALS.length, 24);
  // v2.7.0 起目录里还有 CCF A/B 的期刊与会议，总数按实际目录长度算
  assert.equal(ALL_JOURNALS.length, 46 + CCF_VENUES.length);
  assert.equal(new Set(ALL_JOURNALS.map((journal) => journal.id)).size, ALL_JOURNALS.length);
  const issns = ALL_JOURNALS.map((journal) => journal.issn).filter(Boolean);
  assert.equal(new Set(issns).size, issns.length, 'ISSN 不应重复');
  // 中国刊必须都有中文标题与四段式 ISSN；数据源按「有没有知网代码」决定（有代码走知网 RSS）
  for (const journal of CN_A_JOURNALS) {
    assert.match(journal.title, /[\u4e00-\u9fa5]/, `${journal.id} 应有中文刊名`);
    assert.match(journal.issn, /^\d{4}-\d{3}[\dX]$/, `${journal.id} ISSN 格式不对`);
    assert.equal(journal.provider, journal.cnkiCode ? 'cnki' : 'site', `${journal.id} 数据源应与知网代码一致`);
    assert.equal(journal.set, 'cnA');
  }
  // 22 本里除《管理科学》外都有实测可用的知网代码
  const withCnki = CN_A_JOURNALS.filter((journal) => journal.cnkiCode);
  assert.equal(withCnki.length, 21, '应有 21 本配好知网代码');
  assert.equal(withCnki.filter((journal) => journal.provider === 'cnki').length, 21);
  assert.equal(new Set(withCnki.map((journal) => journal.cnkiCode)).size, 21, '知网代码不应重复');
  const covered = new Set(JOURNAL_SETS.flatMap((set) => set.journalIds));
  assert.equal(covered.size, ALL_JOURNALS.length, '分组应覆盖全部期刊');
  assert.equal(journalById('cn-mw').title, '管理世界');
  assert.equal(journalById('nope'), null);
});

test('目录页解析抽到文章，过滤导航与期号索引，同 URL 只留最像标题的那个', () => {
  const articles = parseJournalIssuePage(MAGTECH_HTML, 'http://www.jryj.org.cn/CN/1002-7246/home.shtml', JOURNAL);
  assert.equal(articles.length, 3);
  assert.equal(articles[0].title, '数字化转型与企业创新——基于中国上市公司的经验证据');
  assert.equal(articles[0].journalId, 'cn-jryj');
  assert.equal(articles[0].journal, '金融研究');
  assert.equal(articles[0].originalUrl, 'http://www.jryj.org.cn/CN/Y2026/V560/I11/1');
  assert.equal(articles[0].publishedAt, '2026-11-01');
  assert.match(articles[0].id, /^cn:/);
  // 「【下载全文和数据】」与首篇同 URL，去重后不应多出一条
  assert.ok(!articles.some((article) => article.title.includes('下载全文')));
  // 侧栏单条公告不成组，不应混进来
  assert.ok(!articles.some((article) => article.title.includes('优秀论文公示')));
  // 同一份 HTML 解析两次 id 必须一致，否则去重与投递记录会失效
  assert.deepEqual(
    parseJournalIssuePage(MAGTECH_HTML, 'http://www.jryj.org.cn/CN/1002-7246/home.shtml', JOURNAL).map((a) => a.id),
    articles.map((a) => a.id),
  );
});

test('日期可以从三种常见链接形态反推，链接里没有时退回页面上的年期', () => {
  assert.equal(dateFromArticleUrl('http://www.jryj.org.cn/CN/Y2025/V546/I12/20'), '2025-12-01');
  assert.equal(dateFromArticleUrl('https://www.jqte.net/sljjjsjjyj/ch/reader/view_abstract.aspx?file_no=20230504&flag=1'), '2023-05-01');
  assert.equal(dateFromArticleUrl('https://www.kygl.net.cn/CN/10.19571/j.cnki.1000-2995.2026.11.001'), '2026-11-01');
  assert.equal(dateFromArticleUrl('http://glkx.hit.edu.cn/info/1006/1002.htm'), '');
  assert.equal(issueDateFromHtml('<p>《管理世界》2026 年第 3 期</p>'), '2026-03-01');
  assert.equal(issueDateFromHtml('<p>没有年期的页面</p>'), '');
});

test('期刊官网常用 GBK，按 meta 声明解码后标题不乱码', () => {
  // “管理” 的 GBK 编码是 B9 DC C0 ED；页面里通常由 meta 声明编码
  const prefix = new TextEncoder().encode('<html><head><meta charset="gbk"></head><body>');
  const suffix = new TextEncoder().encode('</body></html>');
  const page = new Uint8Array([...prefix, 0xb9, 0xdc, 0xc0, 0xed, ...suffix]);
  assert.match(decodeHtml(page, 'text/html'), /管理/);
  const gbk = new Uint8Array([0xb9, 0xdc, 0xc0, 0xed]);
  assert.equal(decodeHtml(gbk, 'text/html; charset=gb2312'), '管理');
  const utf8 = new TextEncoder().encode('管理科学');
  assert.equal(decodeHtml(utf8, 'text/html; charset=utf-8'), '管理科学');
});

test('同步按数据源分流：知网优先、失败退官网，单刊失败只影响自己', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    // 知网 RSS 一律不通，用来验证「自动退到官网目录」
    if (String(url).startsWith('https://rss.cnki.net/')) throw new Error('connect ETIMEDOUT');
    if (String(url).includes('jryj')) return fakeResponse(MAGTECH_HTML);
    if (String(url).includes('nbr.nankai')) throw new Error('connect ETIMEDOUT');
    throw new Error('unexpected ' + url);
  };
  const state = createTopJournalState({ selectedJournalIds: ['cn-jryj', 'cn-nkglpl'] });
  const result = await syncJournals(state, ['cn-jryj', 'cn-nkglpl'], { fetchImpl });
  // 金融研究：知网失败 → 官网成功（2 次请求）；南开没有内置目录页，只试知网（1 次）
  assert.equal(calls.filter((url) => url.includes('jryj')).length, 1);
  assert.equal(calls.length, 3);
  assert.equal(result.synced.length, 1);
  assert.equal(result.synced[0].journalId, 'cn-jryj');
  assert.equal(result.synced[0].provider, 'site', '知网不通时应记为官网目录');
  assert.equal(result.synced[0].count, 3);
  assert.equal(result.state.articles.length, 3);
  assert.equal(result.state.articles[0].journalId, 'cn-jryj');
  assert.equal(result.state.sync['cn-jryj'].source, '期刊官网');
  // 抓取失败只影响自己，且错误里两个源都写明，便于判断是网络还是代码变更
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].journalId, 'cn-nkglpl');
  assert.match(result.state.sync['cn-nkglpl'].error, /知网 RSS/);
  assert.match(result.state.sync['cn-nkglpl'].error, /请求失败|超时|HTTP/);
  // 只配了知网代码、没有目录页的刊：报错要指向知网这一路
  const empty = await syncJournals(createTopJournalState(), ['cn-yc'], { fetchImpl });
  assert.match(empty.state.sync['cn-yc'].error, /知网 RSS/);
});

test('知网 RSS 能出文章时就不再去抓官网', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('https://rss.cnki.net/')) {
      return fakeResponse(CNKI_RSS, { url: String(url), contentType: 'application/xml;charset=UTF-8' });
    }
    throw new Error('不该走到这里：' + url);
  };
  const result = await syncJournals(createTopJournalState(), ['cn-jryj'], { fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(result.synced[0].provider, 'cnki');
  assert.equal(result.state.sync['cn-jryj'].source, '知网 RSS');
  assert.equal(result.state.articles.length, 2, '征稿启事应被过滤，只剩 2 篇论文');
  assert.ok(result.state.articles.every((article) => article.journalId === 'cn-jryj'));
  assert.equal(result.state.articles[0].abstractExcerpt, true);
  assert.ok(result.state.articles[0].authors.length > 0, '知网 RSS 带作者');
});

test('用户自填的目录页地址会覆盖内置值，并按所选数据源参与同步', async () => {
  // 默认数据源是知网，所以这里显式把该刊切到官网目录，验证覆盖值真的被用上
  const state = createTopJournalState({
    feedOverrides: { 'cn-nkglpl': 'http://nbr.nankai.edu.cn/nkglpl/article/issue/1' },
    sourcePrefs: { 'cn-nkglpl': 'site' },
  });
  assert.equal(catalogFor(state).find((journal) => journal.id === 'cn-nkglpl').feedUrl, 'http://nbr.nankai.edu.cn/nkglpl/article/issue/1');
  // 非 http 地址不会被采纳
  const dirty = createTopJournalState({ feedOverrides: { 'cn-nkglpl': 'javascript:alert(1)', 'cn-yc': 'https://example.com/list' } });
  assert.equal(dirty.feedOverrides['cn-nkglpl'], undefined);
  assert.equal(dirty.feedOverrides['cn-yc'], 'https://example.com/list');

  const calls = [];
  const fetchImpl = async (url) => { calls.push(String(url)); return fakeResponse(MAGTECH_HTML, { url: String(url) }); };
  const result = await syncJournals(state, ['cn-nkglpl'], { fetchImpl });
  assert.equal(calls[0], 'http://nbr.nankai.edu.cn/nkglpl/article/issue/1');
  assert.equal(result.synced.length, 1);
});

test('抓取失败给出的是能照着做的提示：无地址 / 拒绝访问 / 空页面 / 解析不出文章', async () => {
  await assert.rejects(() => fetchCnJournalArticles({ id: 'cn-yc', title: '预测', feedUrl: '' }), /目录页地址/);
  await assert.rejects(() => fetchCnJournalArticles({ id: 'x', title: 'X', feedUrl: 'http://a.com' }, { fetchImpl: async () => fakeResponse('', { status: 403 }) }), /HTTP 403/);
  await assert.rejects(() => fetchCnJournalArticles({ id: 'x', title: 'X', feedUrl: 'http://a.com' }, { fetchImpl: async () => fakeResponse('') }), /空页面/);
  await assert.rejects(
    () => fetchCnJournalArticles({ id: 'x', title: 'X', feedUrl: 'http://a.com' }, { fetchImpl: async () => fakeResponse('<html><body><p>请开启 JavaScript</p></body></html>') }),
    /没有解析出文章/,
  );
});

test('签到能给中文刊分配文章，并保持跨天不重复', async () => {
  const { checkInAndCreateDelivery } = await import('../src/topJournals.js');
  const articles = parseJournalIssuePage(MAGTECH_HTML, 'http://www.jryj.org.cn/CN/1002-7246/home.shtml', JOURNAL);
  let state = createTopJournalState({ selectedJournalIds: ['cn-jryj'], articles });
  const first = checkInAndCreateDelivery(state, { date: '2026-11-26', perJournal: 2 });
  assert.equal(first.delivery.items.length, 2);
  const second = checkInAndCreateDelivery(first.state, { date: '2026-11-27', perJournal: 2 });
  assert.equal(second.delivery.items.length, 1, '剩余 1 篇未投递');
  assert.equal(second.delivery.shortages.length, 1);
  assert.ok(second.delivery.items.every((entry) => !first.delivery.items.some((old) => old.articleId === entry.articleId)));
});
