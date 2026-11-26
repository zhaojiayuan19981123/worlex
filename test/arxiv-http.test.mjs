// arxiv-http.test.mjs —— arXiv 路由：分类校验、参数透传、上游失败兜底
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import express from 'express';

import { registerArxivRoutes } from '../src/arxivRoutes.js';

const FEED = `<?xml version="1.0"?><feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns="http://www.w3.org/2005/Atom">
  <opensearch:totalResults>7</opensearch:totalResults><opensearch:startIndex>0</opensearch:startIndex>
  <entry><id>http://arxiv.org/abs/2601.00001v1</id><title>One</title><summary>Abstract one.</summary>
  <published>2026-01-01T00:00:00Z</published><author><name>A</name></author><category term="cs.AI"/></entry>
</feed>`;

function listen(app) {
  const server = createServer(app);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server,
    base: `http://127.0.0.1:${server.address().port}`,
  })));
}
async function close(server) {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
}

async function newApp(fetchImpl) {
  const app = express();
  registerArxivRoutes(app, { fetchImpl, logger: () => {} });
  return listen(app);
}

test('meta 返回分组目录与排序', async () => {
  const { server, base } = await newApp(async () => {});
  try {
    const data = await (await fetch(`${base}/api/arxiv/meta`)).json();
    assert.ok(data.groups.length >= 4);
    assert.equal(data.defaultCategory, 'cs.AI');
    assert.ok(data.sorts.some((s) => s.id === 'submittedDate'));
  } finally { await close(server); }
});

test('feed：分类 / 关键词 / 翻页参数透传到 arXiv，解析结果原样返回', async () => {
  let seen = '';
  const { server, base } = await newApp(async (url) => {
    seen = url;
    return { ok: true, status: 200, text: async () => FEED };
  });
  try {
    const r = await fetch(`${base}/api/arxiv/feed?category=cs.LG&q=graph%20neural&start=20&perPage=5&sort=relevance`);
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.total, 7);
    assert.equal(data.entries.length, 1);
    assert.equal(data.entries[0].title, 'One');
    const u = new URL(seen);
    assert.match(u.searchParams.get('search_query'), /cat:cs\.LG/);
    assert.match(u.searchParams.get('search_query'), /all:graph/);
    assert.equal(u.searchParams.get('start'), '20');
    assert.equal(new URL(seen).searchParams.get('max_results'), '5');
  } finally { await close(server); }
});

test('未知分类与超长检索词直接 400，不打上游', async () => {
  let calls = 0;
  const { server, base } = await newApp(async () => { calls += 1; return {}; });
  try {
    assert.equal((await fetch(`${base}/api/arxiv/feed?category=nope`)).status, 400);
    assert.equal((await fetch(`${base}/api/arxiv/feed?q=${'a'.repeat(200)}`)).status, 400);
    assert.equal(calls, 0);
  } finally { await close(server); }
});

test('上游 500 时返回 502 而不是空列表', async () => {
  const { server, base } = await newApp(async () => ({ ok: false, status: 500, text: async () => 'bad' }));
  try {
    const r = await fetch(`${base}/api/arxiv/feed?category=cs.AI`);
    assert.equal(r.status, 502);
    assert.match((await r.json()).error, /HTTP 500/);
  } finally { await close(server); }
});
