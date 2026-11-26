// 中国知网期刊 RSS 接入的测试：
// 解析、日期换算、非论文条目过滤、主键稳定性（链接带一次性签名）、
// 数据源切换与兜底、以及「换源后同一篇不重复投递」。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CNKI_CODES,
  cnkiArticleId,
  cnkiDateToDay,
  cnkiFeedUrl,
  fetchCnkiJournalArticles,
  parseCnkiRss,
} from '../src/cnkiRss.js';
import {
  catalogFor,
  checkInAndCreateDelivery,
  createTopJournalState,
} from '../src/topJournals.js';

const JOURNAL = { id: 'cn-jryj', title: '金融研究', cnkiCode: 'JRYJ' };

function rssItem({ title, link = 'https://kns.cnki.net/kcms2/article/abstract?v=TOKEN1', desc = '摘要正文…', date = 'Wed, 25 Nov 2026 16:00:00 GMT', author = '张三;李四;' }) {
  return `  <item>
    <title>${title}</title>
    <link>${link}</link>
    <description>${desc}</description>
    <pubDate>${date}</pubDate>
    <author>${author}</author>
  </item>`;
}

function rss(...items) {
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>金融研究-CNKI</title><link>https://navi.cnki.net/knavi/journals/JRYJ/detail</link>
${items.join('\n')}
</channel></rss>`;
}

function fakeResponse(body, { status = 200, contentType = 'application/xml;charset=UTF-8' } = {}) {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key) => (String(key).toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

test('知网 RSS 能解析出标题、作者、摘要节选与原文链接', () => {
  const articles = parseCnkiRss(rss(
    rssItem({ title: '地方政府债务置换对企业债务违约风险的影响研究', author: '李勇建;陈婷;' }),
  ), JOURNAL);
  assert.equal(articles.length, 1);
  const [article] = articles;
  assert.equal(article.title, '地方政府债务置换对企业债务违约风险的影响研究');
  assert.deepEqual(article.authors, ['李勇建', '陈婷']);
  assert.equal(article.journalId, 'cn-jryj');
  assert.equal(article.journal, '金融研究');
  assert.equal(article.source, '知网 RSS');
  assert.equal(article.abstractExcerpt, true);
  assert.equal(article.abstract, '摘要正文', '尾部省略号应去掉');
  assert.equal(article.originalUrl, 'https://kns.cnki.net/kcms2/article/abstract?v=TOKEN1');
  assert.equal(article.doi, '', '知网 RSS 不提供 DOI');
});

test('pubDate 是 GMT，按北京时间换算，否则整期都会早一天', () => {
  // 北京时间 11-26 00:00 发布，RSS 里写的是 11-25 16:00 GMT
  assert.equal(cnkiDateToDay('Wed, 25 Nov 2026 16:00:00 GMT'), '2026-11-26');
  assert.equal(cnkiDateToDay('2026-11-25T04:00:00Z'), '2026-11-25');
  assert.equal(cnkiDateToDay('不是日期'), '');
});

test('摘要里的双重转义标签（&lt;正&gt;、&lt;sup&gt;）不会漏到卡片上', () => {
  const xml = rss(rssItem({
    title: '美国注册会计师协会会计理论建构的历史考察',
    // 知网真实返回是 &amp;lt;，解一层实体后才是 &lt;
    desc: '&amp;lt;正&amp;gt;美国注册会计师协会（AICPA&amp;lt;sup&amp;gt;®&amp;lt;/sup&amp;gt;）是各州注册会计师自愿加入的组织。',
  }));
  const [article] = parseCnkiRss(xml, JOURNAL);
  assert.equal(article.abstract, '美国注册会计师协会（AICPA®）是各州注册会计师自愿加入的组织。');
  assert.doesNotMatch(article.abstract, /<|&lt;|&amp;/);
});

test('征稿启事/订阅广告/会议通知不算论文，会被过滤掉', () => {
  const xml = rss(
    rssItem({ title: '数字化转型与企业创新' }),
    rssItem({ title: '《金融研究》2027 年征稿启事' }),
    rssItem({ title: '欢迎订阅 2027 年《金融研究》' }),
    rssItem({ title: '第十届金融学年会会议通知' }),
  );
  const articles = parseCnkiRss(xml, JOURNAL);
  assert.equal(articles.length, 1);
  assert.equal(articles[0].title, '数字化转型与企业创新');
});

test('主键只用「期刊 + 规范化标题」：链接里的签名换掉也不会变成新文章', () => {
  const a = parseCnkiRss(rss(rssItem({ title: '绿色金融与企业创新', link: 'https://kns.cnki.net/x?v=AAA' })), JOURNAL);
  const b = parseCnkiRss(rss(rssItem({ title: '绿色金融与企业创新', link: 'https://kns.cnki.net/x?v=ZZZ' })), JOURNAL);
  assert.equal(a[0].id, b[0].id, '同一篇两次同步必须是同一个 id');
  // 空白与引号写法不同也视为同一篇
  assert.equal(
    cnkiArticleId('cn-jryj', '绿色金融 与“企业创新”'),
    cnkiArticleId('cn-jryj', '绿色金融与"企业创新"'),
  );
  // 不同刊的相同标题不能撞
  assert.notEqual(cnkiArticleId('cn-jryj', '编者按'), cnkiArticleId('cn-kygl', '编者按'));
});

test('同一份 RSS 内重复标题只留一条，并按日期倒序', () => {
  const xml = rss(
    rssItem({ title: '较早发表的一篇实证研究文章', date: 'Mon, 02 Nov 2026 16:00:00 GMT' }),
    rssItem({ title: '最新发表的一篇实证研究文章', date: 'Wed, 25 Nov 2026 16:00:00 GMT' }),
    rssItem({ title: '最新发表的一篇实证研究文章', date: 'Wed, 25 Nov 2026 16:00:00 GMT', link: 'https://kns.cnki.net/x?v=DUP' }),
  );
  const articles = parseCnkiRss(xml, JOURNAL);
  assert.equal(articles.length, 2);
  assert.equal(articles[0].title, '最新发表的一篇实证研究文章');
  assert.ok(articles[0].publishedAt > articles[1].publishedAt);
});

test('抓取失败给出可操作的中文原因，而不是空数组', async () => {
  const notFound = async () => fakeResponse('', { status: 404 });
  await assert.rejects(() => fetchCnkiJournalArticles(JOURNAL, { fetchImpl: notFound }), /HTTP 404/);

  const empty = async () => fakeResponse('', { status: 200 });
  await assert.rejects(() => fetchCnkiJournalArticles(JOURNAL, { fetchImpl: empty }), /空内容/);

  const noItem = async () => fakeResponse('<rss><channel><title>x</title></channel></rss>');
  await assert.rejects(() => fetchCnkiJournalArticles(JOURNAL, { fetchImpl: noItem }), /没有条目/);

  // 有条目但全是通知：不算失败，返回空数组，由上层按 0 条处理
  const onlyNotice = async () => fakeResponse(rss(rssItem({ title: '《金融研究》征稿启事' })));
  assert.deepEqual(await fetchCnkiJournalArticles(JOURNAL, { fetchImpl: onlyNotice }), []);

  // 没配代码时不该发请求
  await assert.rejects(() => fetchCnkiJournalArticles({ id: 'x', title: 'y' }, { fetchImpl: notFound }), /知网代码/);
});

test('feed 地址按刊代码拼，22 本里 21 本有代码', () => {
  assert.equal(cnkiFeedUrl('JCYJ'), 'https://rss.cnki.net/knavi/rss/JCYJ?pcode=CJFD,CCJD');
  assert.equal(Object.keys(CNKI_CODES).length, 21);
  // 管理科学（哈工大）没有可用代码，走官网目录
  assert.equal(CNKI_CODES['cn-glkx'], undefined);
  assert.equal(CNKI_CODES['cn-jmsc'], 'JCYJ');
});

test('catalogFor 按用户选择切换数据源，选到不可用的源时自动换另一个', () => {
  const base = createTopJournalState({});
  const jryj = catalogFor(base).find((journal) => journal.id === 'cn-jryj');
  assert.equal(jryj.sourceId, 'cnki', '有知网代码默认走知网');

  const toSite = catalogFor(createTopJournalState({ sourcePrefs: { 'cn-jryj': 'site' } })).find((journal) => journal.id === 'cn-jryj');
  assert.equal(toSite.sourceId, 'site');
  assert.equal(toSite.sourcePref, 'site');

  // 选了官网但该刊没有目录页 → 回落知网
  const noFeed = catalogFor(createTopJournalState({ sourcePrefs: { 'cn-nkglpl': 'site' } })).find((journal) => journal.id === 'cn-nkglpl');
  assert.equal(noFeed.sourceId, 'cnki');

  // 选知网但该刊没有知网代码（管理科学）→ 回落官网
  const noCode = catalogFor(createTopJournalState({ sourcePrefs: { 'cn-glkx': 'cnki' } })).find((journal) => journal.id === 'cn-glkx');
  assert.equal(noCode.sourceId, 'site');
  assert.equal(noCode.feedUrl, 'http://glkx.hit.edu.cn');

  // 非法值不入库
  const dirty = createTopJournalState({ sourcePrefs: { 'cn-jryj': 'ftp', 'cn-mw': 'site' } });
  assert.equal(dirty.sourcePrefs['cn-jryj'], undefined);
  assert.equal(dirty.sourcePrefs['cn-mw'], 'site');
});

test('换数据源后同一篇不会重复投递（id 变了但标题没变）', () => {
  const title = '绿色金融能否促进经济“脱虚向实”';
  // 第一天：官网目录抓到的（id 是链接哈希）
  const day1 = createTopJournalState({
    selectedJournalIds: ['cn-jryj'],
    articles: [{ id: 'cn:aaa', journalId: 'cn-jryj', title, publishedAt: '2026-11-20', source: '期刊官网', discoveredAt: '2026-11-20T00:00:00Z' }],
  });
  const first = checkInAndCreateDelivery(day1, { date: '2026-11-20' });
  assert.equal(first.delivery.items.length, 1);

  // 第二天：切成知网 RSS，同一篇换了 id 重新入库
  const day2 = createTopJournalState({
    ...first.state,
    articles: [
      ...first.state.articles,
      { id: 'cnk:bbb', journalId: 'cn-jryj', title, publishedAt: '2026-11-26', source: '知网 RSS', discoveredAt: '2026-11-26T00:00:00Z' },
    ],
  });
  const second = checkInAndCreateDelivery(day2, { date: '2026-11-26' });
  assert.equal(second.addedCount, 0, '同一篇不该因为换源被再投一次');
  assert.equal(second.delivery.items.length, 0);
});
