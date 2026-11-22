// special-issues.test.mjs —— v2.2.0 SI 征稿模块：纯逻辑 + HTTP + 源码挂载点
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import express from 'express';
import * as store from '../src/store.js';
import { registerSpecialIssueRoutes } from '../src/specialIssueRoutes.js';
import { createSpecialIssueScheduler } from '../src/specialIssueScheduler.js';
import {
  ABS_JOURNALS, SI_PRESETS, createSpecialIssueState, normalizeDeadline, deadlineMeta,
  parseSpecialIssueDocument, matchJournal, detectTopics, mergeIssues,
  profileFromGraph, scoreRelevance, recommendIssues, computeHotTopics, topicSnapshot,
  syncSpecialIssues, setSubscriptions, setPreferences, specialIssueSummary,
  toggleFavorite, addCustomIssue, purgeExpiredIssues, listIssues,
} from '../src/specialIssues.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8').replace(/\r\n/g, '\n');

const YEAR = new Date().getFullYear() + 1;
const CFP_HTML = `<html><body><ul>
  <li><h3><a href="/cfp/tourism-ai">Special Issue: Tourism and Artificial Intelligence</a></h3>
      <p>Call for papers on tourism, tourist experience and destination marketing. Submission deadline: 30 June ${YEAR}.</p></li>
  <li><h3><a href="/cfp/sustainable">Special Issue: Sustainable Tourism and ESG</a></h3>
      <p>Guest editors invite research on sustainable tourism and carbon. Deadline: December 15, ${YEAR}.</p></li>
</ul></body></html>`;

// ---------------- 纯逻辑 ----------------
test('目录：ABS 期刊足够多选、按学科分组、预设引用合法 id', () => {
  assert.ok(ABS_JOURNALS.length >= 120, `期刊目录应覆盖大量 ABS 期刊，实际 ${ABS_JOURNALS.length}`);
  assert.equal(new Set(ABS_JOURNALS.map((j) => j.id)).size, ABS_JOURNALS.length);
  assert.ok(ABS_JOURNALS.some((j) => j.category === '旅游与酒店'));
  assert.ok(ABS_JOURNALS.every((j) => typeof j.cfpUrl === 'string'));
  for (const [key, preset] of Object.entries(SI_PRESETS)) {
    assert.ok(preset.journalIds.length > 0, `${key} 预设不能为空`);
    for (const id of preset.journalIds) assert.ok(ABS_JOURNALS.some((j) => j.id === id), `预设 ${key} 引用了不存在的期刊 ${id}`);
  }
});

test('状态规范化：脏输入不抛错、订阅按目录白名单过滤、偏好有默认值', () => {
  const s = createSpecialIssueState({
    selectedJournalIds: ['tm', 'tm', '不存在', 42], issues: [null, { id: 'x' }, 'bad'],
    customSources: [{ url: 'ftp://nope' }, { url: 'https://example.com/cfp', label: 'A' }],
    preferences: { syncHour: 99, recommendEnabled: false },
  });
  assert.deepEqual(s.selectedJournalIds, ['tm']);
  assert.equal(s.issues.length, 1);
  assert.equal(s.customSources.length, 1);
  assert.equal(s.preferences.syncHour, 23);
  assert.equal(s.preferences.recommendEnabled, false);
  assert.equal(createSpecialIssueState(null).preferences.autoSync, true);
  assert.equal(createSpecialIssueState({ preferences: {} }).preferences.syncHour, 8);
});

test('截止日期：ISO / 英文月名 / 斜杠 / 中文都能归一，且带标签优先', () => {
  assert.equal(normalizeDeadline('Submission deadline: 30 June ' + YEAR).date, `${YEAR}-06-30`);
  assert.equal(normalizeDeadline('Deadline: December 15, ' + YEAR).date, `${YEAR}-12-15`);
  assert.equal(normalizeDeadline('投稿截止：' + YEAR + '年3月31日').date, `${YEAR}-03-31`);
  assert.equal(normalizeDeadline(`截止日期 ${YEAR}-09-01，卷号 Vol. 12`).date, `${YEAR}-09-01`);
  assert.equal(normalizeDeadline(`31/12/${YEAR}`).date, `${YEAR}-12-31`);
  assert.equal(normalizeDeadline('Call for papers, no date given').date, '');
  assert.equal(deadlineMeta({ deadline: `${YEAR}-06-30` }).days > 0, true);
  assert.equal(deadlineMeta({ deadline: '' }).label, '未公布');
  assert.equal(deadlineMeta({ deadline: '2020-01-01' }).label, '已截止');
});

test('解析：HTML 与 RSS 都能抽出标题 / 简介 / deadline / 原文链接 / 主题', () => {
  const items = parseSpecialIssueDocument(CFP_HTML, {
    baseUrl: 'https://example.com/journal/cfp', journal: ABS_JOURNALS.find((j) => j.id === 'tm'), now: new Date(),
  });
  assert.equal(items.length, 2);
  const first = items[0];
  assert.match(first.title, /Tourism and Artificial Intelligence/);
  assert.equal(first.deadline, `${YEAR}-06-30`);
  assert.equal(first.url, 'https://example.com/cfp/tourism-ai');
  assert.equal(first.journalId, 'tm');
  assert.equal(first.journal, 'Tourism Management');
  assert.ok(first.topics.includes('旅游与酒店'));
  assert.ok(first.description.length > 20);
  const feed = `<?xml version="1.0"?><rss><channel><item><title>Special Issue: Platform Economy</title><link>https://example.com/p/1</link><description>Call for papers on digital platforms. Deadline: 1 May ${YEAR}.</description></item></channel></rss>`;
  const rss = parseSpecialIssueDocument(feed, { baseUrl: 'https://example.com/feed', now: new Date() });
  assert.equal(rss.length, 1);
  assert.equal(rss[0].source, 'rss');
  assert.equal(rss[0].deadline, `${YEAR}-05-01`);
  assert.ok(rss[0].topics.includes('平台与生态'));
});

test('期刊名匹配与主题检测：旅游例子能命中', () => {
  assert.equal(matchJournal('Call for papers — Tourism Management special issue'), 'tm');
  assert.equal(matchJournal('Annals of Tourism Research'), 'atr');
  assert.equal(matchJournal('nothing relevant here'), '');
  assert.ok(detectTopics('sustainable tourism and tourist destination').includes('旅游与酒店'));
  assert.ok(detectTopics('生成式人工智能与大模型').includes('人工智能'));
});

test('合并：稳定 id 去重、保留首次发现时间与已有译文不丢', () => {
  const old = [{ id: 'a', title: 'old', discoveredAt: '2026-01-01', deadline: '', topics: [] }];
  const next = mergeIssues(old, [{ id: 'a', title: 'new', discoveredAt: '2026-02-02', deadline: `${YEAR}-01-01`, topics: ['旅游与酒店'] }, { id: 'b', title: 'b', deadline: `${YEAR}-02-01` }]);
  assert.equal(next.length, 2);
  const a = next.find((x) => x.id === 'a');
  assert.equal(a.title, 'new');
  assert.equal(a.discoveredAt, '2026-01-01');
  assert.equal(a.deadline, `${YEAR}-01-01`);
});

test('知识图谱推荐：研究旅游时旅游 SI 明显优先于无关 SI', () => {
  const graph = {
    topics: [{ label: '旅游与酒店', terms: ['tourism', 'tourist', 'destination'], count: 12 }],
    nodes: [{ topicLabel: '旅游与酒店', keywords: ['tourism', 'hospitality'] }, { keywords: ['tourism'] }],
    edges: [{ kind: 'subject', terms: ['游客', '目的地'], weight: 0.9 }],
  };
  const profile = profileFromGraph(graph);
  assert.equal(profile.empty, false);
  assert.ok(profile.topics.length > 0);
  const tourism = { id: 't', title: 'Special Issue: Sustainable Tourism and Destination Marketing', description: 'tourism, tourist, hospitality', topics: ['旅游与酒店'], deadline: `${YEAR}-08-01` };
  const accounting = { id: 'a', title: 'Special Issue: Auditing and Financial Reporting', description: 'audit disclosure', topics: ['会计与审计'], deadline: `${YEAR}-07-01` };
  const st = scoreRelevance(tourism, profile);
  const sa = scoreRelevance(accounting, profile);
  assert.ok(st.score >= 60, `旅游 SI 应高相关，实际 ${st.score}`);
  assert.ok(st.score > sa.score, `旅游 ${st.score} 应高于会计 ${sa.score}`);
  assert.ok(st.matched.some((m) => /旅游|tourism/i.test(m.term)));
  const rec = recommendIssues([accounting, tourism], profile, { now: new Date(), limit: 5 });
  assert.equal(rec[0].issue.id, 't');
});

test('领域热点：按覆盖数 / 期刊数 / 临近截止聚合，7 日趋势可读', () => {
  const mk = (id, topics, journalId, deadline) => ({ id, topics, journalId, deadline, discoveredAt: new Date().toISOString() });
  const issues = [
    mk('1', ['旅游与酒店', '人工智能'], 'tm', `${YEAR}-06-30`),
    mk('2', ['旅游与酒店'], 'atr', `${YEAR}-07-30`),
    mk('3', ['人工智能'], 'jtr', `${YEAR}-08-30`),
    mk('4', [], 'tm', ''),
  ];
  const hot = computeHotTopics(issues, { now: new Date(), limit: 10 });
  assert.equal(hot[0].topic, '旅游与酒店');
  assert.equal(hot[0].count, 2);
  assert.equal(hot[0].journalCount, 2);
  assert.equal(hot[0].upcomingCount, 2);
  assert.equal(hot[0].nearestDeadline, `${YEAR}-06-30`);
  const snap = topicSnapshot(issues);
  assert.equal(snap.counts['旅游与酒店'], 2);
  const pastKey = new Date(Date.now() - 7 * 86400000);
  const key = `${pastKey.getFullYear()}-${String(pastKey.getMonth() + 1).padStart(2, '0')}-${String(pastKey.getDate()).padStart(2, '0')}`;
  const withTrend = computeHotTopics(issues, { now: new Date(), history: { [key]: { counts: { '旅游与酒店': 1 } } }, limit: 10 });
  assert.equal(withTrend.find((t) => t.topic === '旅游与酒店').trend, 1);
  assert.deepEqual(computeHotTopics([], { now: new Date() }), []);
});

test('抓取：注入式 fetch、单源失败隔离、订阅与偏好写回', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('fail')) return { ok: false, status: 503, text: async () => '' };
    return { ok: true, status: 200, text: async () => CFP_HTML };
  };
  const state = setSubscriptions(createSpecialIssueState(), ['tm']);
  const result = await syncSpecialIssues(state, { fetchImpl, now: new Date(), concurrency: 2 });
  assert.ok(result.total > 0);
  assert.ok(result.added > 0);
  assert.ok(result.state.issues.length > 0);
  assert.ok(result.state.lastSyncAt);
  assert.ok(result.state.issues.every((i) => i.journalId === 'tm' || !i.journalId));
  assert.ok(result.state.issues.every((i) => /^https?:\/\//.test(i.url)));
  const p = setPreferences(result.state, { recommendEnabled: false, syncHour: 6, autoSync: false });
  assert.equal(p.preferences.recommendEnabled, false);
  assert.equal(p.preferences.syncHour, 6);
  assert.equal(specialIssueSummary(p).subscribed, 1);
});

test('定时任务：默认未启用、refresh / stop 后状态可预期、不自动出网', () => {
  let state = createSpecialIssueState();
  let runs = 0;
  const scheduler = createSpecialIssueScheduler({
    getState: () => state, saveState: (s) => { state = s; },
    runNow: async () => { runs += 1; return { ok: true }; },
    now: () => new Date('2026-11-22T09:00:00'),
  });
  assert.equal(scheduler.status().enabled, false);
  scheduler.start();
  assert.equal(scheduler.status().enabled, true);
  assert.equal(scheduler.status().hour, 8);
  assert.equal(runs, 0, 'start() 不应立即抓取');
  scheduler.refresh();
  scheduler.stop();
  assert.equal(scheduler.status().enabled, false);
  assert.equal(runs, 0);
});

// ---------------- 收藏 / 自行添加 / 到期清理 ----------------
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const shift = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d; };

test('收藏：切换 / 显式指定 / 不存在 id 无效，且可叠加筛选', () => {
  const base = createSpecialIssueState({ issues: [
    { id: 'a', title: 'A', deadline: ymd(shift(100)) },
    { id: 'b', title: 'B', deadline: ymd(shift(100)) },
  ] });
  const on = toggleFavorite(base, 'a');
  assert.deepEqual(on.favoriteIds, ['a']);
  assert.deepEqual(toggleFavorite(on, 'a').favoriteIds, []);
  assert.deepEqual(toggleFavorite(on, 'a', true).favoriteIds, ['a']);
  assert.deepEqual(toggleFavorite(on, '不存在').favoriteIds, ['a']);
  const fav = listIssues(on, { favoriteOnly: true });
  assert.deepEqual(fav.map((i) => i.id), ['a']);
});

test('自行添加：字段归一 / 主题识别 / 自动订阅 / 默认收藏 / 去重', () => {
  const now = new Date('2026-01-01T00:00:00');
  const deadline = ymd(shift(120));
  const r = addCustomIssue(createSpecialIssueState(), {
    title: 'Special Issue: Sustainable Tourism in Smart Destinations',
    description: 'Call for papers on tourism and tourist destination resilience.',
    deadline, journal: 'Tourism Management', url: 'https://example.com/cfp/custom',
  }, { now });
  assert.equal(r.error, '');
  assert.equal(r.issue.source, 'custom');
  assert.equal(r.issue.custom, true);
  assert.equal(r.issue.deadline, deadline);
  assert.equal(r.issue.journalId, 'tm');
  assert.ok(r.issue.topics.includes('旅游与酒店'));
  assert.ok(r.state.selectedJournalIds.includes('tm'), '手动添加应自动订阅该刊');
  assert.ok(r.state.favoriteIds.includes(r.issue.id), '手动添加默认收藏');
  const again = addCustomIssue(r.state, {
    title: 'Special Issue: Sustainable Tourism in Smart Destinations', url: 'https://example.com/cfp/custom',
  }, { now });
  assert.equal(again.state.issues.length, 1, '同一条不应重复添加');
  assert.ok(addCustomIssue(createSpecialIssueState(), { title: '短' }, { now }).error);
});

test('到期：只展示未截止，自动清除并带走译文 / 收藏 / 推荐黑名单', () => {
  const now = new Date();
  const old = { id: 'old', title: '过期征稿', deadline: ymd(shift(-5)), discoveredAt: now.toISOString() };
  const live = { id: 'live', title: '在征', deadline: ymd(shift(30)), discoveredAt: now.toISOString() };
  const state = createSpecialIssueState({
    issues: [old, live], favoriteIds: ['old', 'live'], dismissedIds: ['old'],
    translations: { old: { title: 'x' }, live: { title: 'y' } },
  });
  assert.deepEqual(listIssues(state, { now }).map((i) => i.id), ['live']);
  const purged = purgeExpiredIssues(state, { now });
  assert.deepEqual(purged.removed, ['old']);
  assert.deepEqual(purged.state.issues.map((i) => i.id), ['live']);
  assert.deepEqual(purged.state.favoriteIds, ['live']);
  assert.deepEqual(purged.state.dismissedIds, []);
  assert.equal(purged.state.translations.old, undefined);
  assert.equal(purged.state.translations.live.title, 'y');
  assert.equal(purgeExpiredIssues(purged.state, { now }).removed.length, 0);
});

test('搜索：标题 / 期刊 / 主题 / 关键词都能命中，且可与收藏筛选叠加', () => {
  const state = createSpecialIssueState({ issues: [
    { id: 'a', title: 'Special Issue: Tourism Platforms', journal: 'Tourism Management', topics: ['旅游与酒店'], keywords: ['destination'], deadline: ymd(shift(100)) },
    { id: 'b', title: 'Special Issue: Auditing', journal: 'Journal of Accounting Research', topics: ['会计与审计'], keywords: ['disclosure'], deadline: ymd(shift(100)) },
  ] });
  assert.deepEqual(listIssues(state, { query: 'tourism' }).map((i) => i.id), ['a']);
  assert.deepEqual(listIssues(state, { query: 'destination' }).map((i) => i.id), ['a']);
  assert.deepEqual(listIssues(state, { query: '会计' }).map((i) => i.id), ['b']);
  assert.equal(listIssues(toggleFavorite(state, 'b'), { favoriteOnly: true, query: 'tourism' }).length, 0);
});

// ---------------- HTTP ----------------
function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}
async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
}

test('HTTP：订阅 → 抓取 → 列表 / 热点 / 推荐 / 定时状态全链路', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'si-http-'));
  await mkdir(path.join(root, 'uploads'), { recursive: true });
  store.configure({ dataDir: path.join(root, 'data') });
  const app = express();
  app.use(express.json());
  const graph = {
    topics: [{ label: '旅游与酒店', terms: ['tourism', 'tourist'], count: 8 }],
    nodes: [{ keywords: ['tourism'] }], edges: [],
  };
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => CFP_HTML });
  registerSpecialIssueRoutes(app, {
    store, getGraph: () => graph, fetchImpl,
    resolveRequestModel: () => ({ error: 'no model' }),
  });
  const server = createServer(app);
  try {
    const base = await listen(server);
    const get = async (p) => (await fetch(base + p, { headers: { Connection: 'close' } })).json();
    const send = async (p, method, body) => (await fetch(base + p, {
      method, headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify(body || {}),
    })).json();

    const initial = await get('/api/special-issues');
    assert.ok(initial.catalog.length >= 120);
    assert.ok(Array.isArray(initial.issues));
    assert.equal(initial.profile.empty, false);
    assert.ok(initial.scheduler);

    const subscribed = await send('/api/special-issues/subscriptions', 'PUT', { selectedJournalIds: ['tm', 'atr'] });
    assert.deepEqual(subscribed.selectedJournalIds, ['tm', 'atr']);

    const synced = await send('/api/special-issues/sync', 'POST', {});
    assert.equal(synced.ok, true);
    assert.ok(synced.added > 0);
    assert.ok(synced.issues.length > 0);
    assert.ok(synced.issues.every((i) => i.deadline && i.deadline.label), '每条 SI 都要带截止日期展示信息');
    assert.ok(synced.hotTopics.length > 0, '抓取后应生成领域热点');
    assert.ok(synced.hotTopics.some((t) => t.topic === '旅游与酒店'));
    assert.ok(synced.recommendations.length > 0, '知识图谱画像应推出旅游相关 SI');
    assert.equal(synced.recommendations[0].relevance.score > 0, true);

    const status = await get('/api/special-issues/status');
    assert.equal(typeof status.hour, 'number');
    const hot = await get('/api/special-issues/hot-topics?limit=5');
    assert.ok(Array.isArray(hot.topics));
    const rec = await get('/api/special-issues/recommendations');
    assert.ok(Array.isArray(rec.items));

    const prefs = await send('/api/special-issues/preferences', 'PUT', { syncHour: 7, recommendEnabled: false });
    assert.equal(prefs.preferences.syncHour, 7);
    const sources = await send('/api/special-issues/sources', 'PUT', {
      customSources: [{ label: '自定义', url: 'https://example.com/cfp' }],
      cfpOverrides: { tm: 'https://example.com/tm/cfp' },
    });
    assert.equal(sources.customSources.length, 1);
    assert.equal(sources.cfpOverrides.tm, 'https://example.com/tm/cfp');

    // 新增：自行添加 → 收藏 → 只看收藏 → 手动清理
    const custom = await send('/api/special-issues/custom', 'POST', {
      title: 'Special Issue: My Own Call for Papers',
      deadline: ymd(shift(60)),
      description: 'tourism and destination research',
    });
    assert.equal(custom.issue?.custom, true);
    assert.ok(custom.favoriteIds.includes(custom.issue.id));
    const unfaved = await send(`/api/special-issues/${encodeURIComponent(custom.issue.id)}/favorite`, 'POST', {});
    assert.equal(unfaved.favoriteIds.includes(custom.issue.id), false);
    const favOff = await get('/api/special-issues?favoriteOnly=1');
    assert.equal(favOff.issues.some((i) => i.id === custom.issue.id), false);
    await send(`/api/special-issues/${encodeURIComponent(custom.issue.id)}/favorite`, 'POST', {});
    const favOn = await get('/api/special-issues?favoriteOnly=1');
    assert.ok(favOn.issues.some((i) => i.id === custom.issue.id));
    const purged = await send('/api/special-issues/purge', 'POST', {});
    assert.ok(Array.isArray(purged.removed));
  } finally {
    await close(server);
  }
});

// ---------------- 源码挂载点 ----------------
test('源码：后端路由、数据文件、前端导航与视图都已挂载', () => {
  const server = read('server.js');
  assert.match(server, /registerSpecialIssueRoutes\(app,/);
  assert.match(server, /getGraph: \(\) => kbGraphCache/);
  assert.match(server, /specialIssues\?\.scheduler\?\.start\(\)/);
  const storeSrc = read('src/store.js');
  assert.match(storeSrc, /getSpecialIssues\(\)/);
  assert.match(storeSrc, /'special-issues\.json'/);
  const html = read('public/index.html');
  assert.match(html, /data-view="specialissue"/);
  assert.match(html, /id="viewSpecialIssue"/);
  assert.match(html, /special-issue\.css/);
  assert.match(html, /special-issue\.js/);
  const app = read('public/app.js');
  assert.match(app, /specialissue: 'viewSpecialIssue'/);
  assert.match(app, /SpecialIssueView\?\.mount\?\./);
  const css = read('public/special-issue.css');
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /focus-visible/);
  assert.ok(!/transition:\s*all/.test(css), '不允许 transition: all');
});
