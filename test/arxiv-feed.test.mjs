// arxiv-feed.test.mjs —— arXiv 分类浏览的纯逻辑（Atom 解析 / URL 拼装 / 取数）
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARXIV_GROUPS, decodeXml, parseArxivFeed, buildArxivUrl, fetchArxiv,
} from '../src/arxivFeed.js';

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns="http://www.w3.org/2005/Atom">
  <opensearch:totalResults>12345</opensearch:totalResults>
  <opensearch:startIndex>20</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/2601.12345v1</id>
    <title>Graph &amp; Attention for &lt;Recommendation&gt;</title>
    <summary>We study graph neural networks &#44; with attention.</summary>
    <published>2026-01-20T10:00:00Z</published>
    <updated>2026-01-21T10:00:00Z</updated>
    <author><name>Ada Lovelace</name></author>
    <author><name>Alan Turing</name></author>
    <category term="cs.LG" />
    <category term="cs.IR" />
    <arxiv:primary_category term="cs.LG" />
    <arxiv:journal_ref>J. Test 12 (2026)</arxiv:journal_ref>
    <link href="https://arxiv.org/pdf/2601.12345v1" title="pdf" />
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2601.99999v2</id>
    <title>Second Paper</title>
    <summary>Another abstract.</summary>
    <published>2026-01-19T10:00:00Z</published>
    <updated>2026-01-19T10:00:00Z</updated>
    <author><name>Grace Hopper</name></author>
    <category term="stat.ML" />
    <link href="https://arxiv.org/pdf/2601.99999v2" title="pdf" />
  </entry>
</feed>`;

test('类别目录按学科分组，含常用 cs.* / stat.* / q-bio.*', () => {
  const ids = ARXIV_GROUPS.flatMap((g) => g.items.map(([id]) => id));
  assert.ok(ids.includes('cs.AI'));
  assert.ok(ids.includes('cs.LG'));
  assert.ok(ids.includes('stat.ML'));
  assert.ok(ids.includes('q-bio.NC'));
});

test('XML 实体还原：命名实体与数字实体', () => {
  assert.equal(decodeXml('A &amp; B &lt;C&gt; &#44; &#x4E2D;'), 'A & B <C> , 中');
});

test('Atom 解析：总数、翻页、作者、分类、期刊引用、PDF 链接', () => {
  const out = parseArxivFeed(FEED);
  assert.equal(out.total, 12345);
  assert.equal(out.start, 20);
  assert.equal(out.entries.length, 2);
  const first = out.entries[0];
  assert.equal(first.id, '2601.12345v1');
  assert.equal(first.title, 'Graph & Attention for <Recommendation>');
  assert.equal(first.abstract, 'We study graph neural networks , with attention.');
  assert.deepEqual(first.authors, ['Ada Lovelace', 'Alan Turing']);
  assert.equal(first.authorLine, 'Ada Lovelace，Alan Turing');
  assert.deepEqual(first.categories, ['cs.LG', 'cs.IR']);
  assert.equal(first.primaryCategory, 'cs.LG');
  assert.equal(first.journalRef, 'J. Test 12 (2026)');
  assert.equal(first.absUrl, 'https://arxiv.org/abs/2601.12345v1');
  assert.equal(first.pdfUrl, 'https://arxiv.org/pdf/2601.12345v1');
  assert.equal(out.entries[1].authorLine, 'Grace Hopper');
  assert.equal(out.entries[1].pdfUrl, 'https://arxiv.org/pdf/2601.99999v2');
});

test('URL：类别走 cat:，关键词走 all:，条数与起始页受控', () => {
  const url = buildArxivUrl({ category: 'cs.AI', query: 'large language model', start: 20, perPage: 999, sort: 'relevance' });
  const u = new URL(url);
  assert.equal(u.searchParams.get('search_query'), 'all:large AND all:language AND all:model AND cat:cs.AI');
  assert.equal(u.searchParams.get('start'), '20');
  assert.equal(u.searchParams.get('max_results'), '50');
  assert.equal(u.searchParams.get('sortBy'), 'relevance');
  assert.equal(buildArxivUrl({ category: 'all', query: 'diffusion' }).includes('cat:'), false);
});

test('fetchArxiv：text() 与 arrayBuffer() 两种响应体都能读', async () => {
  const seen = [];
  const fake = async (url) => { seen.push(url); return { ok: true, status: 200, text: async () => FEED }; };
  const out = await fetchArxiv({ category: 'cs.LG', perPage: 2 }, { fetchImpl: fake });
  assert.equal(out.entries.length, 2);
  assert.equal(new URL(seen[0]).searchParams.get('search_query'), 'cat:cs.LG');

  const bufFake = async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from(FEED, 'utf8') });
  assert.equal((await fetchArxiv({ category: 'cs.AI' }, { fetchImpl: bufFake })).entries.length, 2);
});
