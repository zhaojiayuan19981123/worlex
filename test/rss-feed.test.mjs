// rss-feed.test.mjs —— 期刊官网 RSS（JMLR）解析测试
//
// JMLR 的 RSS 有两个坑：
//   1) <pubDate> 只给年份（"2026"），不是完整时间 → 解析成该年 1 月 1 日，不能变成 Invalid Date；
//   2) <description> 里的摘要带 HTML（&lt;p&gt;…），且被转义了两次 → 必须反复解实体 + 去标签。

import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchRssArticles, parseGenericRss, rssArticleId, rssDateToDay } from '../src/rssFeed.js';

const JMLR_XML = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel>
<title>JMLR</title>
<item>
<title>
A Detailed Survey of Machine Learning Interpretability
</title>
<link>
http://jmlr.org/papers/v27/26-1976.html
</link>
<pubDate>2026</pubDate>
<author>James Enouen, Yan Liu</author>
<description>
Interpretability has gained popularity. &amp;lt;p&amp;gt;We survey &amp;lt;b&amp;gt;feature interactions&amp;lt;/b&amp;gt;.&amp;lt;/p&amp;gt;
</description>
</item>
<item>
<title>Second Paper On Something Else Entirely</title>
<link>http://jmlr.org/papers/v27/26-0002.html</link>
<pubDate>Mon, 03 Feb 2025 00:00:00 GMT</pubDate>
<author>Single Author</author>
<description>Plain abstract.</description>
</item>
<item>
<title>Second Paper On Something Else Entirely</title>
<link>http://jmlr.org/papers/v27/26-0002.html</link>
<pubDate>2025</pubDate>
<author>Dup</author>
<description>Duplicate.</description>
</item>
</channel></rss>`;

test('年份型 pubDate → 该年 1 月 1 日；标准 RFC 日期按 UTC 取日', () => {
  assert.equal(rssDateToDay('2026'), '2026-01-01');
  assert.equal(rssDateToDay('Mon, 03 Feb 2025 00:00:00 GMT'), '2025-02-03');
  assert.equal(rssDateToDay(''), '');
  assert.equal(rssDateToDay('not a date'), '');
});

test('条目解析：标题去空白、作者切分、双重转义的摘要被洗干净', () => {
  const rows = parseGenericRss(JMLR_XML, { id: 'ccf-jmlr', title: 'Journal of Machine Learning Research' });
  assert.equal(rows.length, 2, '重复标题应被去掉');
  assert.equal(rows[0].title, 'A Detailed Survey of Machine Learning Interpretability');
  assert.deepEqual(rows[0].authors, ['James Enouen', 'Yan Liu']);
  assert.equal(rows[0].publishedAt, '2026-01-01');
  assert.equal(rows[0].originalUrl, 'http://jmlr.org/papers/v27/26-1976.html');
  assert.ok(!/[<>]/.test(rows[0].abstract), `摘要里还有标签：${rows[0].abstract}`);
  assert.match(rows[0].abstract, /feature interactions/);
  assert.equal(rows[0].source, '期刊官网 RSS');
  assert.equal(rows[0].journalId, 'ccf-jmlr');
});

test('主键只跟期刊 + 规范化标题有关，重复同步不会重复投递', () => {
  assert.equal(rssArticleId('ccf-jmlr', 'A  Paper'), rssArticleId('ccf-jmlr', 'a paper'));
  assert.notEqual(rssArticleId('ccf-jmlr', 'A Paper'), rssArticleId('ccf-jmlr', 'B Paper'));
  assert.match(rssArticleId('ccf-jmlr', 'A Paper'), /^rss:/);
});

test('fetchRssArticles：没有条目时报出可读原因', async () => {
  await assert.rejects(
    fetchRssArticles({ id: 'x', rssUrl: 'https://example.com/feed.xml' }, { fetchImpl: async () => ({ ok: true, text: async () => '<rss><channel></channel></rss>' }) }),
    /没有条目/,
  );
  await assert.rejects(fetchRssArticles({ id: 'x' }, { fetchImpl: async () => ({ ok: true }) }), /还没有配置官网 RSS/);
});

test('fetchRssArticles：正常响应能解析出文章', async () => {
  const rows = await fetchRssArticles(
    { id: 'ccf-jmlr', title: 'JMLR', rssUrl: 'https://jmlr.org/jmlr.xml' },
    { fetchImpl: async () => ({ ok: true, text: async () => JMLR_XML }) },
  );
  assert.equal(rows.length, 2);
});
