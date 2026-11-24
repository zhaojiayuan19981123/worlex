import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { publisherPageError, discoverJournalCfpPages } from '../src/specialIssueParser.js';
import { canonicalSourceUrl, robotsPolicy, cfpPageEvidence } from '../src/specialIssueSourcePolicy.js';
import { ABS_JOURNALS, CFP_SOURCES, defaultCfpUrl } from '../src/specialIssueCatalog.js';
import { registerSpecialIssueRoutes } from '../src/specialIssueRoutes.js';
import { createSpecialIssueScheduler } from '../src/specialIssueScheduler.js';
import {
  createSpecialIssueState, normalizeDeadline, deadlineMeta, normalizeAiIssue,
  parseSpecialIssueDocument, addCustomIssue, importPastedIssues, profileFromGraph,
  recommendIssues, listIssues, computeHotTopics, purgeExpiredIssues, syncSpecialIssues,
  buildSyncTasks, detectTopics,
} from '../src/specialIssues.js';

const now = new Date('2026-11-22T12:00:00');
const future = `${new Date().getFullYear() + 1}-12-31`;
const call = (id = 'a', extra = {}) => ({ id, title: 'Tourism and sustainable destinations',
  description: 'Research on tourism and hospitality. '.repeat(100), journalId: 'tm',
  journal: 'Tourism Management', deadline: future, topics: ['旅游与酒店'], ...extra });
const apiUrl = 'https://callforpapers.taylorandfrancis.com/wp-json/wp/v2/special_issues?per_page=50';
const record = (journal, id = 1) => ({ id, link: `https://callforpapers.taylorandfrancis.com/special_issues/tourism-${id}/`,
  title: { rendered: 'Tourism and responsible artificial intelligence' }, special_issues: {
    _special_issues_journal_title: [journal], _special_issues_deadline: ['30 April 2027'],
    _special_issues_deadline2: ['1 June 2026'], _special_issues_copy: ['<p>Call for papers on sustainable tourism.</p>'],
  } });
const response = (body, url, pages = 0) => ({ ok: true, url, text: async () => body,
  headers: new Headers(pages ? { 'X-WP-TotalPages': String(pages) } : {}) });

async function harness(t, { initial = {}, settings = {}, ...deps } = {}) {
  let state = createSpecialIssueState(initial);
  const store = { getSpecialIssues: () => structuredClone(state),
    saveSpecialIssues: (s) => { state = structuredClone(s); }, getSettings: () => settings };
  const app = express();
  app.use(express.json());
  const routes = registerSpecialIssueRoutes(app, { store, ...deps });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => { routes.scheduler.stop(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const request = async (path = '', method = 'GET', body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/special-issues${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, ...(await res.json()) };
  };
  return { request, routes, get: () => state, set: (s) => { state = createSpecialIssueState(s); } };
}

test('deadline: full manuscript overrides abstract; labelled multiline dates and extensions', () => {
  for (const value of [
    'Abstract deadline\n1 June 2026\nManuscript deadline\n1 February 2027',
    'Manuscript deadline: 1 February 2027; Abstract submission deadline: 1 June 2026',
    'Abstract deadline: 1 June 2026. The final manuscript would be due by 1 February 2027.',
    'Submission deadline: 1 January 2027; Extended deadline: 1 February 2027',
  ]) assert.equal(normalizeDeadline(value, now).date, '2027-02-01', value);
  for (const value of ['Abstract deadline: 1 June 2027', 'Published on 1 June 2027', 'Submission opens: 2027-01-01',
    'Deadline: 2027-02-30', 'Deadline: 05/06/2027']) assert.equal(normalizeDeadline(value, now).date, '', value);
  assert.equal(deadlineMeta({ deadline: '2026-11-22' }, new Date('2026-11-22T23:59:59')).days, 0);
  assert.equal(deadlineMeta({ deadline: '2026-11-22' }, new Date('2026-11-23T00:00:00')).days, -1);
});

test('manual and paste import accept normalized deadline plus original text', () => {
  const raw = { title: 'Tourism research special issue', description: 'Call for papers', deadline: '2027-12-31', deadlineText: '31 December 2027' };
  assert.equal(addCustomIssue({}, raw, { now }).issue.deadline, '2027-12-31');
  assert.equal(importPastedIssues({}, [raw], { now }).added.length, 1);
  assert.equal(normalizeAiIssue({ ...raw, url: 'https://example.org/call' }, { now }).deadline, '2027-12-31');
  assert.ok(addCustomIssue({}, { ...raw, deadline: '2020-01-01' }, { now }).error);
});

test('publisher: ordinary Cloudflare footer is accepted, actual verification is rejected', () => {
  assert.equal(publisherPageError('<h1>Tourism</h1><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>'), '');
  assert.ok(publisherPageError('<title>Just a moment...</title><form id="challenge-form"></form>'));
  assert.ok(publisherPageError('<main>Verify you are human</main>'));
});

test('publisher: nested card headings and detail-only deadline remain intact', () => {
  const html = '<main><h1>Special issues</h1>' + [1, 2].map((n) => `<article><div><h2><span><a href="/special-issue/${n}">Tourism research ${n}</a></span></h2><p>Call for papers. Submission deadline: ${n} December 2027</p></div></article>`).join('') + '</main>';
  const parsed = parseSpecialIssueDocument(html, { baseUrl: 'https://example.org/cfp', now });
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map((i) => i.deadline), ['2027-12-01', '2027-12-02']);
  const detail = `<main><h1>Journal of Sustainable Tourism</h1><h2>Tourism in a changing world</h2><p>Special issue. ${'Research topics. '.repeat(300)}</p><h3>Abstract deadline</h3><p>1 June 2026</p><h3>Manuscript deadline</h3><p>1 February 2027</p></main>`;
  const item = parseSpecialIssueDocument(detail, { baseUrl: 'https://callforpapers.taylorandfrancis.com/special_issues/tourism/', detail: true, now }).at(-1);
  assert.equal(item.title, 'Tourism in a changing world');
  assert.equal(item.deadline, '2027-02-01');
  assert.ok(item.description.length > 3000);
});

test('official JSON: exact journal metadata, manuscript deadline and public fields only', () => {
  assert.equal(publisherPageError(JSON.stringify([{ description: '<div class="captcha-container">Research about verification</div>' }])), '');
  const records = [record('Journal of Sustainable Tourism'), record('Not in the catalogue', 2)];
  records[1].title.rendered = 'Tourism Management and other journals are discussed here';
  records[0].special_issues.contact_email = ['private@example.org'];
  const items = parseSpecialIssueDocument(JSON.stringify(records), { baseUrl: apiUrl, now });
  assert.equal(items[0].journalId, 'jost');
  assert.equal(items[0].deadline, '2027-04-30');
  assert.equal(items[0].source, 'publisher-api');
  assert.equal(items[1].journalId, '');
  assert.equal(items[1].journalShort, '');
  assert.equal(items[1].publisher, '');
  assert.equal(items[1].category, '');
  assert.ok(!JSON.stringify(items).includes('private@example.org'));
  assert.throws(() => parseSpecialIssueDocument('[{}]', { baseUrl: apiUrl, now }), /字段/);
});

test('topic detection uses English word boundaries instead of matching AI within words', () => {
  assert.ok(!detectTopics('Sustainable tourism, fairness and hospitality').includes('人工智能'));
  assert.ok(detectTopics('AI and tourism research').includes('人工智能'));
  assert.ok(detectTopics('人工智能与旅游研究').includes('人工智能'));
});

test('official API pagination filters selected journals and never fetches HTML details', async () => {
  const seen = [];
  const result = await syncSpecialIssues({ selectedJournalIds: ['jost'] }, { now,
    fetchImpl: async (url) => {
      seen.push(url);
      assert.match(url, /wp-json/);
      return response(JSON.stringify(new URL(url).searchParams.has('page') ? [record('Journal of Sustainable Tourism', 99)]
        : Array.from({ length: Number(new URL(url).searchParams.get('per_page')) }, (_, i) => record('Other Journal', i))), url, 2);
    },
  });
  assert.equal(seen.length, 2);
  assert.equal(result.total, 1);
  assert.equal(result.fetched[0].journalId, 'jost');
  assert.equal(result.failed.length, 0);
});

test('sync: failure does not update success time; valid empty official data is not a network failure', async () => {
  const initial = { selectedJournalIds: ['jost'], lastSyncAt: '2026-11-01T00:00:00Z' };
  const failed = await syncSpecialIssues(initial, { now, fetchImpl: async () => ({ ok: false, status: 403 }) });
  assert.equal(failed.state.lastSyncAt, initial.lastSyncAt);
  assert.equal(failed.state.lastAttemptAt, now.toISOString());
  assert.equal(failed.synced.length, 0);
  const empty = await syncSpecialIssues(initial, { now, fetchImpl: async (url) => response('[]', url) });
  assert.equal(empty.failed.length, 0);
  assert.equal(empty.synced.length, 1);
  assert.equal(empty.total, 0);
});

test('sync follows a same-origin detail to recover a missing deadline', async () => {
  const result = await syncSpecialIssues({ customSources: [{ url: 'https://example.org/list' }] }, { now,
    fetchImpl: async (url) => response(url.endsWith('/list')
      ? '<article><h2><a href="/special-issue/tourism">Special Issue: Tourism Futures</a></h2><p>Call for papers</p></article>'
      : '<main><h1>Tourism Futures</h1><p>Special issue on tourism research. Submission deadline: 31 December 2027</p></main>', url),
  });
  assert.equal(result.fetched[0].deadline, '2027-12-31');
  assert.ok(result.fetched[0].detailFetchedAt);
});

const legacyWiley = 'https://onlinelibrary.wiley.com/call-for-papers';
const wileyHome = 'https://onlinelibrary.wiley.com/journal/15221970';
const wileyCalls = 'https://onlinelibrary.wiley.com/page/journal/15221970/homepage/call-for-papers';

test('Wiley: legacy shared URL migrates and a valid per-journal override takes priority', () => {
  const state = { selectedJournalIds: ['ijtr'], cfpOverrides: { ijtr: `${legacyWiley}/?old=1` },
    customSources: [{ url: legacyWiley }],
    sync: { 'publisher:Wiley Online Library': { url: legacyWiley } } };
  assert.deepEqual(createSpecialIssueState(state).sync, {});
  assert.deepEqual(buildSyncTasks(state).map(({ url, discover }) => ({ url, discover })), [{ url: wileyHome, discover: true }]);
  state.cfpOverrides.ijtr = wileyCalls;
  assert.deepEqual(buildSyncTasks(state).map(({ url, discover }) => ({ url, discover })), [{ url: wileyCalls, discover: false }]);
});

test('Wiley: only follows an official same-journal CFP link and retains the manuscript deadline', async () => {
  const seen = [];
  const result = await syncSpecialIssues({ selectedJournalIds: ['ijtr'] }, { now, maxDetailPages: 0,
    fetchImpl: async (url) => {
      seen.push(url);
      if (url === wileyHome) return response(`
        <nav><a href="${legacyWiley}">Call for Papers</a>
        <a href="/page/journal/10990836/homepage/call-for-papers">Calls for Papers</a>
        <a href="${new URL(wileyCalls).pathname}">Calls for Papers</a></nav>`, url);
      assert.equal(url, wileyCalls);
      return response('<main><h1>Calls for Papers</h1><p>International Journal of Tourism Research</p><article><h2><a href="/doi/example">Tourism Futures</a></h2><p>Manuscript deadline: 30 April 2027</p></article></main>', url);
    },
  });
  assert.deepEqual(seen, [wileyHome, wileyCalls]);
  assert.equal(result.failed.length, 0);
  assert.equal(result.fetched[0].journalId, 'ijtr');
  assert.equal(result.fetched[0].deadline, '2027-04-30');
  assert.equal(result.state.sync.ijtr.url, wileyCalls);
});

test('sources: 404 pages, HTTP restrictions and robots restrictions are distinguishable', async () => {
  assert.match(publisherPageError('<h1>Error 404</h1><h2>Page not found</h2>'), /404/);
  const result = await syncSpecialIssues({ selectedJournalIds: ['ijtr', 'ds', 'tm'] }, {
    now, fetchImpl: async (url) => { assert.ok([wileyHome, 'https://onlinelibrary.wiley.com/journal/15405915'].includes(url)); return { ok: false, status: 403 }; },
  });
  assert.equal(result.state.lastSyncAt, '');
  assert.match(result.state.sync.ijtr.error, /403/);
  assert.match(result.state.sync.ds.error, /403/);
  assert.match(result.state.sync.tm.error, /robots/);
});

test('single Chinese graph keyword or entity recommends English tourism; word boundaries prevent AI false positives', () => {
  for (const graph of [{ nodes: [{ keywords: ['旅游'] }] }, { entities: [{ label: '旅游' }] }]) {
    const rec = recommendIssues([call()], profileFromGraph(graph), { now });
    assert.equal(rec.length, 1);
  }
  assert.equal(recommendIssues([call('a', { title: 'Chair design', description: 'Research on chairs', topics: [], journal: '' })], profileFromGraph({ nodes: [{ keywords: ['AI'] }] }), { now }).length, 0);
});

test('unknown and expired deadlines never reach active search, recommendations or hotspots', () => {
  const issues = [call(), call('unknown', { deadline: '' }), call('expired', { deadline: '2020-01-01' })];
  assert.equal(listIssues({ issues }, { now, query: 'tourism' }).length, 1);
  assert.equal(computeHotTopics(issues, { now })[0].count, 1);
  assert.equal(listIssues({ issues, selectedJournalIds: [] }, { now, journalIds: [] }).length, 0);
  const purged = purgeExpiredIssues({ issues, favoriteIds: ['expired'], dismissedIds: ['expired'], translations: { expired: { title: 'old' } } }, { now });
  assert.ok(!purged.state.issues.some((i) => i.id === 'expired'));
  assert.deepEqual(purged.state.favoriteIds, []);
  assert.deepEqual(purged.state.translations, {});
});

test('HTTP sync coalesces overlapping runs and preserves concurrent favorites, subscriptions and custom additions', async (t) => {
  let release, entered;
  const gate = new Promise((r) => { release = r; });
  const ready = new Promise((r) => { entered = r; });
  let calls = 0;
  const h = await harness(t, { initial: { selectedJournalIds: ['jost'], issues: [call()],
    wechat: { config: { historyUrl: 'https://mp.weixin.qq.com/mp/profile_ext?action=home&__biz=TEST' } } },
    resolveRequestModel: () => ({ profile: { model: 'fixture' } }),
    fetchModelCompletion: async () => ({ up: { ok: true } }),
    readLLMResponse: async () => ({ full: JSON.stringify([{ titleOriginal: 'Tourism and AI', title: '旅游与人工智能',
      journal: 'Tourism Management', description: '旅游研究征稿', deadline: future, deadlineEvidence: '投稿截止：' + future }]) }),
    wechatProviderFactory: () => ({
      page: async () => { calls++; entered(); await gate; return { articles: [{ id: 'wx:1', title: 'Tourism and AI',
        url: 'https://mp.weixin.qq.com/s?__biz=TEST&mid=1&idx=1&sn=test', publishedAt: new Date().toISOString() }], dates: [Date.now()], hasMore: false }; },
      article: async () => ({ content: 'Tourism and AI\nTourism Management\n投稿截止：' + future, links: [] }),
    }),
  });
  const first = h.routes.runSync('manual');
  await ready;
  const second = h.routes.runSync('daily');
  assert.equal(first, second);
  await h.request('/a/favorite', 'POST', { favorite: true });
  await h.request('/subscriptions', 'PUT', { selectedJournalIds: ['tm', 'jost'] });
  const custom = await h.request('/custom', 'POST', { title: 'Manual concurrent tourism call', deadline: future });
  release();
  const result = await first;
  assert.equal(calls, 1);
  assert.equal(result.added, 1);
  assert.ok(h.get().favoriteIds.includes('a'));
  assert.ok(h.get().issues.some((i) => i.id === custom.issue.id));
  assert.deepEqual(h.get().selectedJournalIds, ['tm', 'jost']);
});

test('HTTP translation deduplicates requests, caches by content and preserves concurrent state', async (t) => {
  let release, entered;
  const gate = new Promise((r) => { release = r; });
  const ready = new Promise((r) => { entered = r; });
  let calls = 0;
  const h = await harness(t, { initial: { selectedJournalIds: ['tm'], issues: [call()] }, translateImpl: async (text) => {
    calls += 1; entered(); await gate; return '译文 ' + text;
  } });
  const first = h.request('/a/translate', 'POST', {});
  await ready;
  const second = h.request('/a/translate', 'POST', {});
  await h.request('/a/favorite', 'POST', { favorite: true });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(calls, 2, 'one title and one description');
  assert.ok(h.get().favoriteIds.includes('a'));
  assert.equal((await h.request('/a/translate', 'POST', {})).cached, true);
  h.set({ ...h.get(), issues: [call('a', { title: 'Updated tourism call' })] });
  assert.deepEqual((await h.request()).translations, {});
  await h.request('/a/translate', 'POST', {});
  assert.equal(calls, 4);
});

test('HTTP SI translation uses the current default engine and invalidates old translations and search matches', async (t) => {
  const settings = { translateProvider: 'builtin' };
  const providers = [];
  const h = await harness(t, { initial: { selectedJournalIds: ['tm'], issues: [call()] }, settings,
    translateImpl: async (_text, _settings, { provider }) => {
      providers.push(provider);
      return provider === 'builtin' ? '内置引擎译文' : '当前引擎译文';
    },
  });
  assert.equal((await h.request('/a/translate', 'POST', { provider: 'deepl' })).translation.title, '内置引擎译文');
  assert.equal((await h.request(`?query=${encodeURIComponent('内置引擎译文')}`)).issues.length, 1);
  settings.translateProvider = 'deepl';
  assert.deepEqual((await h.request()).translations, {});
  assert.equal((await h.request(`?query=${encodeURIComponent('内置引擎译文')}`)).issues.length, 0);
  assert.equal((await h.request('/a/translate', 'POST', {})).translation.title, '当前引擎译文');
  assert.equal((await h.request('/a/translate', 'POST', {})).cached, true);
  assert.deepEqual(providers, ['builtin', 'builtin', 'deepl', 'deepl']);
});

test('HTTP translation cannot restore a deleted SI; error is actionable without a model', async (t) => {
  let release, entered;
  const gate = new Promise((r) => { release = r; });
  const ready = new Promise((r) => { entered = r; });
  const h = await harness(t, { initial: { issues: [call()] }, translateImpl: async () => { entered(); await gate; return '译文'; } });
  const pending = h.request('/a/translate', 'POST', {});
  await ready; await h.request('/a', 'DELETE'); release();
  assert.equal((await pending).status, 400);
  assert.equal(h.get().issues.length, 0);
  assert.deepEqual(h.get().translations, {});
  const missing = await harness(t, { initial: { issues: [call()] } });
  const result = await missing.request('/a/translate', 'POST', {});
  assert.equal(result.status, 400);
  assert.match(result.error, /模型|设置|配置/);
});

test('HTTP pending deadline confirmation and disabled recommendations', async (t) => {
  const h = await harness(t, { initial: { selectedJournalIds: ['tm'], issues: [call('a', { deadline: '' })] }, getGraph: () => ({ entities: ['旅游'] }) });
  const before = await h.request();
  assert.equal(before.issues.length, 0); assert.equal(before.pendingIssues.length, 1);
  const confirmed = await h.request('/a/deadline', 'PUT', { deadline: future });
  assert.equal(confirmed.issues.length, 1); assert.equal(confirmed.pendingIssues.length, 0);
  assert.equal((await h.request('/a/deadline', 'PUT', { deadline: '2020-01-01' })).status, 400);
  await h.request('/preferences', 'PUT', { recommendEnabled: false });
  assert.equal((await h.request('/recommendations')).items.length, 0);
});

test('scheduler: disabling prevents catchup; cleanup runs hourly even with autoSync off', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: now.getTime() });
  let state = createSpecialIssueState({ selectedJournalIds: ['tm'] }), runs = 0, cleanups = 0;
  const scheduler = createSpecialIssueScheduler({ getState: () => state, runNow: async () => { runs++; },
    purgeIssues: (s) => { cleanups++; return { state: s, removed: [] }; } });
  t.after(() => scheduler.stop());
  scheduler.start();
  state.preferences.autoSync = false;
  scheduler.refresh();
  t.mock.timers.tick(45001);
  assert.equal(runs, 0);
  t.mock.timers.tick(3600000);
  assert.ok(cleanups >= 2);
  scheduler.stop();
  const count = cleanups;
  t.mock.timers.tick(3600000);
  assert.equal(cleanups, count);
});

test('source policy: journal identity and primary headings distinguish CFPs from brand footers and archives', () => {
  const brand = '<title>Springer, serving the global research community</title><main><h1>Serving the global research community</h1><h2>Resources</h2></main><footer><h2>Calls for Papers</h2></footer>';
  assert.equal(cfpPageEvidence(brand, 'https://link.springer.com/brands/springer').confirmed, false);
  const collection = '<title>Call for Papers - Sustainable organizations</title><main><h1>Sustainable organizations</h1><p>Participating journal: Journal of Business Ethics</p></main>';
  assert.equal(cfpPageEvidence(collection, 'https://link.springer.com/collections/example', 'Journal of Business Ethics').confirmed, true);
  assert.equal(cfpPageEvidence(collection, 'https://link.springer.com/collections/example', 'Journal of International Business Studies').confirmed, false);
  assert.equal(cfpPageEvidence(collection, 'https://journals.sagepub.com/toc/jnma/58/2-3').confirmed, false);
  assert.equal(cfpPageEvidence('<h1>Published Special Issues | Calls for Papers</h1>', 'https://example.org/calls').confirmed, false);
});

test('source policy: robots agent specificity, merged groups, longest rule and end anchors', () => {
  const rules = 'User-agent: *\nDisallow: /\nCrawl-delay: 10\nUser-agent: WorlexSI\nDisallow: /private/*\nAllow: /private/open$\nCrawl-delay: 3\nUser-agent: WorlexSI\nDisallow: /drafts\n';
  assert.deepEqual(robotsPolicy(rules, 'https://example.org/journal'), { allowed: true, crawlDelayMs: 3000 });
  assert.equal(robotsPolicy(rules, 'https://example.org/private/open').allowed, true);
  assert.equal(robotsPolicy(rules, 'https://example.org/private/open/more').allowed, false);
  assert.equal(robotsPolicy(rules, 'https://example.org/drafts').allowed, false);
  assert.equal(robotsPolicy(rules, 'https://example.org/journal', 'otherbot').allowed, false);
  assert.equal(robotsPolicy('User-agent: *\nDisallow: /same\nAllow: /same', 'https://example.org/same').allowed, true);
  assert.equal(robotsPolicy('User-agent: *\nDisallow: /*?secret=', 'https://example.org/list?secret=value').allowed, false);
});

test('Springer collections: parse the primary call, ignore article links and reject explicitly closed calls', async () => {
  const baseUrl = 'https://link.springer.com/collections/example';
  const html = '<title>Call for Papers: Microfoundations</title><main><h1>Call for Papers: Special Issue on Microfoundations of International Business</h1>'
    + '<p>Participating journal: Journal of International Business Studies</p>'
    + '<aside><span data-test="submission-deadline">Submission deadline<date>31 December 2027</date></span></aside>'
    + '<h2>Articles</h2><article><h3><a href="/article/10.example/1">Published research on global firms</a></h3></article>'
    + '<article><h3><a href="/article/10.example/2">Another article about business</a></h3></article></main>';
  for (const detail of [false, true]) {
    const parsed = parseSpecialIssueDocument(html, { baseUrl, now, detail });
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].url, baseUrl);
    assert.match(parsed[0].title, /Microfoundations/);
    assert.equal(parsed[0].deadline, '2027-12-31');
  }
  const closed = html.replace('<h2>Articles</h2>', '<p><strong>Closed for submissions</strong></p><h2>Articles</h2>');
  assert.equal(cfpPageEvidence(closed, baseUrl).confirmed, false);
  assert.equal(cfpPageEvidence(closed, baseUrl).closed, true);
  assert.deepEqual(parseSpecialIssueDocument(closed, { baseUrl, now }), []);
  const result = await syncSpecialIssues({ selectedJournalIds: ['jibs'], cfpOverrides: { jibs: baseUrl } }, {
    now, maxDetailPages: 0, fetchImpl: async (url) => response(closed, url),
  });
  assert.equal(result.fetched.length, 0);
  assert.ok(result.failed.length > 0);
  // jibs 的旧 Springer collection 链接无法复核，已从默认源移除；
  // 未配置征稿源时应明确提示，而不是用不可靠的旧链接抓取。
  const automatic = await syncSpecialIssues({ selectedJournalIds: ['jibs'] }, {
    now, maxDetailPages: 0, fetchImpl: async (url) => response(closed, url),
  });
  assert.equal(automatic.fetched.length, 0);
  assert.ok(automatic.failed.length > 0);
  assert.match(automatic.failed[0].error, /没有已配置的征稿源|未找到公开征稿入口|已关闭投稿/);
});

test('source policy: canonical URLs drop transient cookie errors and preserve meaningful queries', () => {
  assert.equal(canonicalSourceUrl('https://link.springer.com/journal/41267?error=cookies_not_supported&code=token&page=2#x'), 'https://link.springer.com/journal/41267?page=2');
  assert.equal(canonicalSourceUrl('https://example.org/cfp?code=journal&error=other#x'), 'https://example.org/cfp?code=journal&error=other');
});

test('discovery: keeps complete journal slugs and all same-journal links, skips archives and other journals', () => {
  const base = 'https://www.sciencedirect.com/journal/journal-of-interactive-marketing';
  const valid = Array.from({ length: 5 }, (_, i) => `${base}/call-for-papers/${i}`);
  const html = valid.map((url) => `<a href="${url}">Call for papers</a>`).join('')
    + '<a href="/journal/journal-of-other/call-for-papers">Call for papers</a>'
    + '<a href="/toc/jnma/58/2-3">Open special issues</a>'
    + '<a href="/journal/journal-of-interactive-marketing/published-special-issues">Call for papers</a>'
    + '<footer><a href="/calls-for-papers">Call for papers</a></footer>';
  assert.deepEqual(discoverJournalCfpPages(html, base), valid);
  assert.equal(parseSpecialIssueDocument('<main><h1>Special Issues</h1><h2><a href="/toc/jnma/58/2-3">Published Special Issue: Interactive Marketing</a></h2></main>', { baseUrl: 'https://journals.sagepub.com/home/jnma', now }).length, 0);
});

test('catalogue: every journal is covered by a task or explicit diagnostic and no unverified aggregate is a default', () => {
  const ids = ABS_JOURNALS.map((journal) => journal.id);
  const tasks = buildSyncTasks({ selectedJournalIds: ids });
  const covered = new Set(tasks.flatMap((task) => [task.journalId, ...(task.journalIds || [])]).filter(Boolean));
  assert.equal(ids.length, 166);
  assert.deepEqual(ids.filter((id) => !covered.has(id)), []);
  for (const journal of ABS_JOURNALS) {
    const url = defaultCfpUrl(journal);
    assert.equal(url.includes('cookies_not_supported'), false);
    if (journal.sourceAudit.state !== 'cfp-confirmed' && url) {
      assert.ok(CFP_SOURCES.some((source) => source.verified && source.url === url));
    }
  }
  assert.equal(CFP_SOURCES.find((source) => source.id === 'springer').verified, false);
  const jim = ABS_JOURNALS.find((journal) => journal.id === 'jim');
  assert.equal(jim.publisher, 'Sage');
  assert.equal(jim.cfpUrls.length, 0);
  assert.equal(ABS_JOURNALS.find((journal) => journal.id === 'pom').publisher, 'Sage');
  assert.equal(ABS_JOURNALS.find((journal) => journal.id === 'jom').publisher, 'Wiley');
  assert.equal(ABS_JOURNALS.find((journal) => journal.id === 'jitm').publisher, 'Association of Management');
  assert.equal(new URL(CFP_SOURCES.find((source) => source.id === 'tandf').url).searchParams.get('per_page'), '100');
});

test('sync: all discovered calls are fetched and independently diagnosed; generic redirects fail closed', async () => {
  const links = Array.from({ length: 4 }, (_, i) => `${wileyCalls}-${i}`);
  const seen = [];
  const result = await syncSpecialIssues({ selectedJournalIds: ['ijtr'] }, { now, maxDetailPages: 0,
    fetchImpl: async (url) => {
      seen.push(url);
      if (url === wileyHome) return response(links.map((link) => `<a href="${link}">Call for papers</a>`).join(''), url);
      if (url === links[0]) return response('<h1>Wiley homepage</h1><footer><h2>Calls for papers</h2></footer>', 'https://onlinelibrary.wiley.com/');
      return response(`<main><h1>Call for papers: International Journal of Tourism Research</h1><article><h2><a href="/cfp/${links.indexOf(url)}">Tourism research special issue ${links.indexOf(url)}</a></h2><p>Manuscript deadline: 30 April 2027</p></article></main>`, url);
    },
  });
  assert.deepEqual(new Set(seen), new Set([wileyHome, ...links]));
  assert.equal(result.synced.length, 3);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /未确认/);
  assert.equal(Object.keys(result.state.sync).length, 4);
  assert.ok(Object.values(result.state.sync).every((entry) => entry.journalId === 'ijtr'));
});

const rankResponse = { code: 200, data: { officialRank: { all: { sciUp: '1区', xr: 'A', ssci: 'Q1', ajg: '3' } } } };

test('HTTP ranks: explicit empty list queries nothing; duplicate and unknown IDs are filtered', async (t) => {
  const calls = [];
  const h = await harness(t, { settings: { easyScholarKey: 'fixture-only' }, queryRankImpl: async (title) => { calls.push(title); return rankResponse; } });
  assert.equal((await h.request('/ranks/refresh', 'POST', { journalIds: [] })).attempted, 0);
  const result = await h.request('/ranks/refresh', 'POST', { journalIds: ['tm', 'tm', 'unknown'] });
  assert.equal(result.refreshed, 1);
  assert.equal(calls.length, 1);
  assert.equal(result.ranks.tm.items.find((item) => item.label === 'ABS').value, '3');
  assert.equal(result.ranks.tm.source, 'easyScholar');
});

test('HTTP ranks: full catalogue batches default to 20 and enforce maximum 40 without losing journals', async (t) => {
  const seen = [];
  const h = await harness(t, { settings: { easyScholarKey: 'fixture-only' }, queryRankImpl: async (title) => { seen.push(title); return rankResponse; } });
  let result = await h.request('/ranks/refresh', 'POST', { scope: 'catalog' });
  assert.equal(result.attempted, 20);
  assert.equal(result.remainingJournalIds.length, 146);
  result = await h.request('/ranks/refresh', 'POST', { journalIds: result.remainingJournalIds, limit: 999 });
  assert.equal(result.attempted, 40);
  while (result.remainingJournalIds.length) result = await h.request('/ranks/refresh', 'POST', { journalIds: result.remainingJournalIds });
  assert.equal(seen.length, 166);
  assert.equal(new Set(seen).size, 166);
  assert.equal(Object.keys(result.ranks).length, 166);
  assert.equal((await h.request('/ranks/refresh', 'POST', { scope: 'catalog' })).cached, 166);
});

test('HTTP ranks: invalid, future and expired cache dates refresh; fresh entries are reused', async (t) => {
  const ranks = { tm: { queriedAt: 'invalid' }, atr: { queriedAt: '2099-01-01T00:00:00Z' },
    jost: { queriedAt: new Date().toISOString() }, cit: { queriedAt: '2020-01-01T00:00:00Z' } };
  const h = await harness(t, { initial: { ranks }, settings: { easyScholarKey: 'fixture-only' }, queryRankImpl: async () => rankResponse });
  const result = await h.request('/ranks/refresh', 'POST', { journalIds: Object.keys(ranks) });
  assert.equal(result.attempted, 3);
  assert.equal(result.cached, 1);
  assert.deepEqual(result.remainingJournalIds, []);
});

test('HTTP ranks: failures terminate the current queue; successful responses without ABS do not invent a grade', async (t) => {
  const h = await harness(t, { settings: { easyScholarKey: 'fixture-only' }, queryRankImpl: async (title) => {
    if (title === 'Tourism Management') throw new Error('fixture quota exhausted');
    return { code: 200, data: { officialRank: { all: { sciUp: '1区' } } } };
  } });
  const result = await h.request('/ranks/refresh', 'POST', { journalIds: ['tm', 'atr'], limit: 1 });
  assert.equal(result.errors.length, 1);
  assert.deepEqual(result.remainingJournalIds, ['atr']);
  const last = await h.request('/ranks/refresh', 'POST', { journalIds: result.remainingJournalIds });
  assert.deepEqual(last.remainingJournalIds, []);
  assert.ok(last.ranks.atr.queriedAt);
  assert.ok(!last.ranks.atr.items.some((item) => item.label === 'ABS'));
  assert.equal(last.ranks.tm, undefined);
});
