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
  let tasks = [];
  let ideas = [];
  let seq = 0;
  return {
    getSpecialIssues: () => state,
    saveSpecialIssues: (s) => { state = JSON.parse(JSON.stringify(s)); },
    getSettings: () => settings,
    listTasks: () => JSON.parse(JSON.stringify(tasks)),
    saveTasks: (list) => { tasks = JSON.parse(JSON.stringify(list)); },
    listIdeas: () => ideas,
    newId: () => `task_${++seq}`,
    _tasks: () => tasks,
    _ideas: (list) => { ideas = list; },
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

test('既没有链接也没有正文时直接拒绝，而不是静默成功', async () => {
  const { app } = setup();
  const r = await invoke(app, 'POST /api/special-issues/collect', {
    body: { text: '今天天气不错，随便记两笔。' },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /没有识别到可处理的内容/);
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

// ---------------- v2.4.0：官网链接 / 粘贴正文 / 加入任务 ----------------

/** 假出版社专刊页：结构与公众号页完全不同，验证走的是通用网页抓取。 */
const PAGE_HTML = () => `<!doctype html><html><head>
  <title>Call for Papers: Journal of Testing</title>
</head><body>
  <nav>Home · Journals · Submit · Login</nav>
  <article>
    <h1>Special Issue: AI for Operations</h1>
    <p>期刊：Journal of Testing</p>
    <p>专刊主题：Generative AI for Sustainable Operations</p>
    <p>截稿日期：2026-12-31</p>
    <p>${'This special issue welcomes empirical and modeling work on AI in operations. '.repeat(6)}</p>
  </article>
  <footer>© 2026 Publisher</footer>
</body></html>`;

/** 粘贴的整段正文：不带任何链接。 */
const PASTED_TEXT = [
  '期刊：Journal of Testing',
  '专刊主题：Generative AI for Sustainable Operations',
  '截稿日期：2026-12-31',
  '客座编辑：Wei Zhang（Tsinghua University）',
  '征稿范围：本专刊关注生成式人工智能在运营与供应链中的实证与建模研究。',
  '要求：投稿时文章类型请选择 VSI: GenAI-Ops，篇幅不超过 9000 字。',
  '其他说明：'.padEnd(6, '　') + '欢迎跨学科研究。'.repeat(40),
].join('\n');

test('出版社专刊页链接会走通用网页抓取，并整理成新条目', async () => {
  const { app } = setup({
    fetchImpl: async (url) => {
      if (/example\.org/.test(String(url))) {
        return new Response(PAGE_HTML(), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      return new Response(ARTICLE_HTML('测试征稿'), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  });
  const r = await invoke(app, 'POST /api/special-issues/collect', {
    body: { text: '官网这里 https://www.example.org/special-issue/ai-ops' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.counted.page, 1);
  assert.equal(r.body.queued, 1);

  await waitIdle(app);
  const list = await invoke(app, 'GET /api/special-issues');
  assert.equal(list.body.issues.length, 1);
  assert.match(list.body.issues[0].journal, /Journal of Testing/);
  assert.equal(list.body.issues[0].deadline.date, '2026-12-31');
});

test('直接粘贴整段正文时不发任何网络请求，也能出条目', async () => {
  let calls = 0;
  const { app } = setup({ fetchImpl: async () => { calls += 1; throw new Error('不该发请求'); } });
  const r = await invoke(app, 'POST /api/special-issues/collect', { body: { text: PASTED_TEXT } });
  assert.equal(r.status, 200);
  assert.equal(r.body.counted.text, 1);
  assert.equal(r.body.queued, 1);

  await waitIdle(app);
  const list = await invoke(app, 'GET /api/special-issues');
  assert.equal(calls, 0);
  assert.equal(list.body.issues.length, 1);
  assert.match(list.body.issues[0].titleEn, /Generative AI/);
});

test('加入任务：生成带 SI 标记与截止日的任务，重复点击不会建两条', async () => {
  const { app, store } = setup();
  await invoke(app, 'POST /api/special-issues/collect', { body: { text: PASTED_TEXT } });
  await waitIdle(app);

  const list = await invoke(app, 'GET /api/special-issues');
  const id = list.body.issues[0].id;

  const created = await invoke(app, 'POST /api/special-issues/:id/task', { params: { id }, body: {} });
  assert.equal(created.status, 200);
  assert.equal(created.body.task.source, 'si');
  assert.equal(created.body.task.due, '2026-12-31');
  assert.match(created.body.task.title, /^投稿 SI｜/);
  assert.equal(store._tasks().length, 1);

  const again = await invoke(app, 'POST /api/special-issues/:id/task', { params: { id }, body: {} });
  assert.equal(again.body.already, true);
  assert.equal(store._tasks().length, 1);

  const withTask = await invoke(app, 'GET /api/special-issues');
  assert.ok(withTask.body.issues[0].taskId);
  assert.equal(withTask.body.summary.tasks, 1);
});

test('移出任务会把任务一起删掉，卡片回到未加任务状态', async () => {
  const { app, store } = setup();
  await invoke(app, 'POST /api/special-issues/collect', { body: { text: PASTED_TEXT } });
  await waitIdle(app);
  const list = await invoke(app, 'GET /api/special-issues');
  const id = list.body.issues[0].id;
  await invoke(app, 'POST /api/special-issues/:id/task', { params: { id }, body: {} });

  const removed = await invoke(app, 'DELETE /api/special-issues/:id/task', { params: { id } });
  assert.equal(removed.status, 200);
  assert.equal(store._tasks().length, 0);
  assert.equal(removed.body.issues[0].taskId, '');
});

test('没配模型时梳理灵感会明确报错，而不是返回空结果', async () => {
  const { app, store } = setup();
  await invoke(app, 'POST /api/special-issues/collect', { body: { text: PASTED_TEXT } });
  await waitIdle(app);
  const list = await invoke(app, 'GET /api/special-issues');
  const id = list.body.issues[0].id;
  store._ideas([{ id: 'idea_1', title: 'AI 与供应链韧性', content: '研究生成式 AI 如何提升供应链韧性', tags: ['AI'] }]);

  const r = await invoke(app, 'POST /api/special-issues/:id/ideas', { params: { id }, body: {} });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /未配置大模型/);
});
