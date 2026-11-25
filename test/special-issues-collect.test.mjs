// special-issues-collect.test.mjs —— 「粘贴收稿」的 HTTP 链路
//
// 这条路径是给「不想装 Docker / 配 RSS」的人用的，坏掉的代价是整块功能不可用，
// 所以这里把三个容易出错的地方钉住：
//   1. 粘贴文本里混着标题、分享文案时能不能只挑出文章链接；
//   2. 同一篇文章贴两次会不会重复入库；
//   3. 一批还在跑时又贴一批，会不会把状态写乱（应当直接拒绝）。
import assert from 'node:assert/strict';
import test from 'node:test';

import { registerSpecialIssueRoutes } from '../src/specialIssueRoutes.js';

/** 最小 express 替身：只记录路由，测试直接调 handler，不占端口。 */
function makeApp() {
  const routes = new Map();
  const add = (method) => (pattern, handler) => routes.set(`${method} ${pattern}`, handler);
  return { get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE'), routes };
}

function invoke(app, key, req = {}) {
  const handler = app.routes.get(key);
  assert.ok(handler, `未注册路由：${key}`);
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); },
    };
    handler({ query: {}, params: {}, body: {}, ...req }, res);
  });
}

function memStore() {
  let state = {};
  let settings = {};
  return {
    getSpecialIssues: () => state,
    saveSpecialIssues: (s) => { state = JSON.parse(JSON.stringify(s)); },
    getSettings: () => settings,
  };
}

const ARTICLE_HTML = (title) => `<!doctype html><html><head>
  <meta property="og:title" content="${title}" />
</head><body>
  <h1 class="rich_media_title">${title}</h1>
  <div id="js_content">${'<p>Journal of Testing 专刊征稿，截稿日期 2026-12-31。</p>'.repeat(20)}</div>
</body></html>`;

/** 假微信正文页：不联网，只按 URL 返回一篇正常文章。 */
function fakeFetch({ delay = 0 } = {}) {
  return async (url) => {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    return new Response(ARTICLE_HTML('测试征稿'), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  };
}

function setup(opts = {}) {
  const app = makeApp();
  const store = memStore();
  registerSpecialIssueRoutes(app, {
    store,
    fetchImpl: opts.fetchImpl || fakeFetch(),
    logger: () => {},
    // 不给模型 → 走规则抽取，测试完全不碰外部网络
    resolveRequestModel: () => ({ error: '测试环境未配置模型' }),
  });
  return { app, store };
}

async function waitIdle(app, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const r = await invoke(app, 'GET /api/special-issues/status');
    if (!r.body.runtime?.running) return;
    if (Date.now() > deadline) throw new Error('收稿没有在预期时间内结束');
    await new Promise((res) => setTimeout(res, 40));
  }
}

test('粘贴里没有公众号链接时直接拒绝，而不是静默成功', async () => {
  const { app } = setup();
  const r = await invoke(app, 'POST /api/special-issues/collect', {
    body: { text: '今天天气不错 https://example.com/foo' },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /没有识别到公众号文章链接/);
});

test('整段分享文案里只挑文章链接，去掉重复，逐条入库', async () => {
  const { app } = setup();
  const text = [
    '【征稿】SSCI 专刊征稿：Journal of Testing',
    'https://mp.weixin.qq.com/s/aaa111bbb',
    '顺手再贴一次：https://mp.weixin.qq.com/s/aaa111bbb',
    '另一个号的文章 https://mp.weixin.qq.com/s/ccc222ddd',
  ].join('\n');

  const r = await invoke(app, 'POST /api/special-issues/collect', { body: { text } });
  assert.equal(r.status, 200);
  assert.equal(r.body.started, true);
  assert.equal(r.body.queued, 2);

  await waitIdle(app);
  const list = await invoke(app, 'GET /api/special-issues');
  assert.equal(list.body.articleStats.total, 2);
});

test('同一批链接再贴一次不会重复入库', async () => {
  const { app } = setup();
  const text = 'https://mp.weixin.qq.com/s/aaa111bbb';
  await invoke(app, 'POST /api/special-issues/collect', { body: { text } });
  await waitIdle(app);

  const again = await invoke(app, 'POST /api/special-issues/collect', { body: { text } });
  assert.equal(again.status, 200);
  assert.equal(again.body.queued, 0);

  await waitIdle(app);
  const list = await invoke(app, 'GET /api/special-issues');
  assert.equal(list.body.articleStats.total, 1);
});

test('上一批还在跑时再贴一批会被拒绝，避免两批同时写状态', async () => {
  const { app } = setup({ fetchImpl: fakeFetch({ delay: 120 }) });
  const first = await invoke(app, 'POST /api/special-issues/collect', {
    body: { text: 'https://mp.weixin.qq.com/s/aaa111bbb' },
  });
  assert.equal(first.body.started, true);

  const second = await invoke(app, 'POST /api/special-issues/collect', {
    body: { text: 'https://mp.weixin.qq.com/s/ccc222ddd' },
  });
  assert.equal(second.status, 409);
  assert.match(second.body.error, /上一批还在处理/);

  await waitIdle(app);
});

test('一次贴超过上限时只收前 60 条，并告知丢了多少', async () => {
  const { app } = setup({ fetchImpl: fakeFetch({ delay: 1 }) });
  const links = Array.from({ length: 63 }, (_, i) => `https://mp.weixin.qq.com/s/link${String(i).padStart(4, '0')}`);
  const r = await invoke(app, 'POST /api/special-issues/collect', { body: { urls: links } });
  assert.equal(r.status, 200);
  assert.equal(r.body.queued, 60);
  assert.equal(r.body.dropped, 3);
  await waitIdle(app, 20000);
});
