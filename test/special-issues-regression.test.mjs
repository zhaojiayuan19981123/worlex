import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { publisherPageError } from '../src/specialIssueParser.js';
import { registerSpecialIssueRoutes } from '../src/specialIssueRoutes.js';
import { createSpecialIssueScheduler } from '../src/specialIssueScheduler.js';
import {
  createSpecialIssueState, normalizeDeadline, deadlineMeta, normalizeAiIssue,
  parseSpecialIssueDocument, addCustomIssue, importPastedIssues, profileFromGraph,
  recommendIssues, listIssues, computeHotTopics, purgeExpiredIssues, syncSpecialIssues,
  detectTopics,
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
        : Array.from({ length: 50 }, (_, i) => record('Other Journal', i))), url, 2);
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
  const h = await harness(t, { initial: { selectedJournalIds: ['jost'], issues: [call()] }, fetchImpl: async (url) => {
    calls += 1; entered(); await gate; return response(JSON.stringify([record('Journal of Sustainable Tourism')]), url);
  } });
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
