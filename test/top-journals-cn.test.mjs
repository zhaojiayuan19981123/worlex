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
  assert.equal(ALL_JOURNALS.length, 46);
  assert.equal(new Set(ALL_JOURNALS.map((journal) => journal.id)).size, 46);
  const issns = ALL_JOURNALS.map((journal) => journal.issn).filter(Boolean);
  assert.equal(new Set(issns).size, issns.length, 'ISSN 不应重复');
  // 中国刊必须都有中文标题与四段式 ISSN，且走 site 数据源
  for (const journal of CN_A_JOURNALS) {
    assert.match(journal.title, /[\u4e00-\u9fa5]/, `${journal.id} 应有中文刊名`);
    assert.match(journal.issn, /^\d{4}-\d{3}[\dX]$/, `${journal.id} ISSN 格式不对`);
    assert.equal(journal.provider, 'site');
    assert.equal(journal.set, 'cnA');
  }
  const covered = new Set(JOURNAL_SETS.flatMap((set) => set.journalIds));
  assert.equal(covered.size, 46, '分组应覆盖全部期刊');
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

test('同步按 provider 分流：中文刊抓官网，失败的刊只影响自己', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('jryj')) return fakeResponse(MAGTECH_HTML);
    if (String(url).includes('nbr.nankai')) throw new Error('connect ETIMEDOUT');
    throw new Error('unexpected ' + url);
  };
  const state = createTopJournalState({ selectedJournalIds: ['cn-jryj', 'cn-nkglpl'] });
  const result = await syncJournals(state, ['cn-jryj', 'cn-nkglpl'], { fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(result.synced.length, 1);
  assert.equal(result.synced[0].journalId, 'cn-jryj');
  assert.equal(result.synced[0].provider, 'site');
  assert.equal(result.synced[0].count, 3);
  assert.equal(result.state.articles.length, 3);
  assert.equal(result.state.articles[0].journalId, 'cn-jryj');
  assert.equal(result.state.sync['cn-jryj'].source, '期刊官网');
  // 抓取失败只影响自己，且错误信息能指路（这里南开的官网直连超时）
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].journalId, 'cn-nkglpl');
  assert.match(result.state.sync['cn-nkglpl'].error, /访问期刊官网失败|超时|目录页/);
  // 连官网地址都没有的刊，提示用户去填目录页
  const empty = await syncJournals(createTopJournalState(), ['cn-yc'], { fetchImpl });
  assert.match(empty.state.sync['cn-yc'].error, /目录页地址/);
});

test('用户自填的目录页地址会覆盖内置值，并参与同步', async () => {
  const state = createTopJournalState({ feedOverrides: { 'cn-nkglpl': 'http://nbr.nankai.edu.cn/nkglpl/article/issue/1' } });
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
