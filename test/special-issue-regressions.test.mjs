import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import {
  createSpecialIssueState, parseSpecialIssueDocument, syncSpecialIssues,
  extractSubmissionDeadline, mergeIssues, listIssues, addCustomIssue, buildSyncTasks,
  recommendIssues,
} from '../src/specialIssues.js';
import { sourceProblem, discoverSourceLinks, extractCallCandidates } from '../src/specialIssueSources.js';
import { registerSpecialIssueRoutes } from '../src/specialIssueRoutes.js';
import { createSpecialIssueScheduler } from '../src/specialIssueScheduler.js';

const now = new Date('2026-11-23T12:00:00');
const directory = `<main><h1>Calls for papers</h1><article>
<a href="/special-issue/tourism">Tourism and Artificial Intelligence</a>
<a href="/journal/tourism-management">Tourism Management</a>
<p>Submission deadline: 31 July 2027</p></article></main>`;
const live = (id, extra = {}) => ({
  id, journalId: 'tm', title: 'Tourism and AI', topics: ['tourism'],
  deadline: '2030-01-01', url: `https://example.com/special-issue/${id}`, ...extra,
});

function enableMockTimers(t) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 20 || (major === 20 && minor < 11)) t.mock.timers.enable(['setTimeout', 'setInterval']);
  else t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
}

test('scheduler records returned source failures and can stop during a pending daily run', async (t) => {
  enableMockTimers(t);
  let state = { preferences: { autoSync: true, syncHour: 8 }, selectedJournalIds: ['tm'] };
  let calls = 0;
  const scheduler = createSpecialIssueScheduler({
    now: () => new Date('2026-11-23T07:59:59'),
    getState: () => state,
    runNow: async () => { calls++; return { ok: false, failed: [{ error: 'HTTP 403' }] }; },
  });
  t.after(() => scheduler.stop());
  scheduler.start();
  state = { ...state, preferences: { ...state.preferences, autoSync: false } };
  scheduler.refresh();
  t.mock.timers.tick(60000);
  assert.equal(calls, 0);
  await scheduler.trigger('manual');
  assert.match(scheduler.status().lastError, /403/);
  assert.equal(calls, 1);
});

test('stopping during a scheduled crawl does not schedule another daily run', async (t) => {
  enableMockTimers(t);
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const scheduler = createSpecialIssueScheduler({
    now: () => new Date('2026-11-23T07:59:59'),
    getState: () => ({ preferences: { autoSync: true, syncHour: 8 }, selectedJournalIds: [] }),
    isReady: () => true,
    runNow: () => pending,
  });
  scheduler.start();
  t.mock.timers.tick(1000);
  assert.equal(scheduler.status().running, true);
  scheduler.stop();
  release({ ok: true });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(scheduler.status().nextRunAt, '');
  assert.equal(scheduler.status().enabled, false);
});

test('deadlines distinguish abstract, full-paper, extended and publication dates', () => {
  assert.equal(extractSubmissionDeadline('Abstract deadline: 1 May 2027. Full paper deadline: 31 July 2027', now).date, '2027-07-31');
  assert.equal(extractSubmissionDeadline('Submission deadline: 1 May 2027. Extended deadline: 31 July 2027', now).date, '2027-07-31');
  assert.equal(extractSubmissionDeadline('Publication date: 31 July 2027', now).date, '');
  assert.equal(extractSubmissionDeadline('Deadline for abstracts: 31 July 2027', now).date, '');
  assert.equal(extractSubmissionDeadline('Submission deadline: 31 February 2027', now).date, '');
  assert.equal(extractSubmissionDeadline('Deadline: December 31, 2024', now).date, '2024-12-31');
  assert.equal(extractSubmissionDeadline('Submission window: January 1, 2027–April 5, 2027', now).date, '2027-04-05');
});

test('society call details keep headers and ignore references to previously published work', () => {
  const html = '<main><article><header><h1>Call for Papers: Consumer Wisdom</h1></header><p>Submission window: January 1, 2027–April 5, 2027</p><p>Build on previously published research.</p></article></main>';
  const items = parseSpecialIssueDocument(html, { baseUrl: 'https://www.ama.org/2026/07/01/call-for-papers-consumer-wisdom/', journal: { id: 'jppm' }, now });
  assert.equal(items.length, 1);
  assert.equal(items[0].deadline, '2027-04-05');
  assert.equal(items[0].detailPage, true);
});

test('AOM adapter excludes general open calls and conferences', () => {
  const html = '<main><a href="/event/amp-open-call-for-papers/">AMP Open Call for Papers</a><a href="/event/amp-call-for-special-issue-papers-topic/">AMP Call for Special Issue Papers: Topic</a><a href="/event/annual-conference/">Conference Call for Papers</a></main>';
  const base = 'https://www.aom.org/event-calendar/';
  assert.deepEqual(extractCallCandidates(html, base).map((c) => c.title), ['AMP Call for Special Issue Papers: Topic']);
  assert.deepEqual(discoverSourceLinks(html, base), []);
});

test('directory journal identities are exact and explicit empty scope stays empty', () => {
  const options = { baseUrl: 'https://example.com/browse/calls-for-papers', now };
  assert.equal(parseSpecialIssueDocument(directory, { ...options, journalIds: ['tm'] }).length, 1);
  assert.equal(parseSpecialIssueDocument(directory, { ...options, journalIds: [] }).length, 0);
  assert.equal(parseSpecialIssueDocument(directory.replaceAll('Tourism Management', 'Tourism Management Perspectives'), { ...options, journalIds: ['tm'] }).length, 0);
});

test('archives and access challenges cannot masquerade as an empty successful crawl', async () => {
  assert.match(sourceProblem('<title>Just a moment...</title>'), /验证/);
  assert.ok(sourceProblem('<p>Transferred back to society as of 2022</p>'));
  const result = await syncSpecialIssues(createSpecialIssueState({ selectedJournalIds: ['tm'] }), {
    now, fetchImpl: async () => ({ ok: true, text: async () => '<title>Just a moment...</title>' }),
  });
  assert.equal(result.synced.length, 0);
  assert.equal(result.failed.length, 1);
});

test('dedicated journal sources do not trigger duplicate publisher directory requests', () => {
  const tasks = buildSyncTasks(createSpecialIssueState({ selectedJournalIds: ['tm', 'atr'], cfpOverrides: {
    tm: 'https://example.com/journal/tourism-management/about/call-for-papers',
    atr: 'https://example.com/journal/annals/about/call-for-papers',
  } }));
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every((task) => task.journalId && task.url.endsWith('/about/call-for-papers')));
});

test('publisher directory results do not overwrite dedicated journal diagnostics', async () => {
  const result = await syncSpecialIssues(createSpecialIssueState({ selectedJournalIds: ['tm', 'imm'], cfpOverrides: {
    tm: 'https://example.com/journal/tourism-management/calls',
    imm: 'https://example.com/directory/calls',
  } }), {
    now,
    fetchImpl: async (url) => ({
      ok: !url.includes('/tourism-management/'), status: 403, url,
      text: async () => '<main>No current calls for papers</main>',
    }),
  });
  assert.match(result.state.sync.tm.error, /403/);
  assert.match(result.state.sync.imm.error, /未识别/);
});

test('actual same-origin next links are followed; guessed or external paths are not', () => {
  const links = discoverSourceLinks('<a rel="next" href="?page=2">Next</a><a rel="next" href="https://other.example/page">Next</a>', 'https://example.com/calls');
  assert.deepEqual(links.map((x) => x.url), ['https://example.com/calls?page=2']);
});

test('title changes preserve legacy identity and the first discovery timestamp', () => {
  const old = live('legacy', { discoveredAt: '2026-01-01' });
  const next = mergeIssues([old], [{ ...old, id: 'new-hash', title: 'Updated title', discoveredAt: '2026-11-23' }]);
  assert.equal(next.length, 1);
  assert.equal(next[0].id, 'legacy');
  assert.equal(next[0].title, 'Updated title');
  assert.equal(next[0].discoveredAt, '2026-01-01');
});

test('unknown and closed deadlines do not appear, even with includeExpired enabled', () => {
  const state = createSpecialIssueState({
    preferences: { includeExpired: true },
    issues: [live('open'), live('closed', { status: 'closed' }), live('unknown', { deadline: '' }), live('expired', { deadline: '2024-01-01' })],
  });
  assert.deepEqual(listIssues(state, { now }).map((i) => i.id), ['open']);
  assert.deepEqual(listIssues(state, { now, journalIds: [] }), []);
  assert.ok(addCustomIssue(state, { title: 'Missing deadline' }, { now }).error);
  const profile = { empty: false, topics: [{ term: 'tourism', weight: 5 }], keywords: [], entities: [] };
  const recommendations = recommendIssues(state.issues, profile, { now, minScore: 0 });
  assert.deepEqual(recommendations.map((r) => r.issue.id), ['open']);
});

test('crawl obtains a missing deadline from the actual linked detail page', async () => {
  const result = await syncSpecialIssues(createSpecialIssueState({ selectedJournalIds: ['tm'], cfpOverrides: { tm: 'https://example.com/calls-for-papers' } }), {
    now,
    fetchImpl: async (url) => ({
      ok: true, url, text: async () => url.endsWith('/calls-for-papers')
        ? directory.replace('<p>Submission deadline: 31 July 2027</p>', '')
        : '<main><h1>Special Issue: Tourism and Artificial Intelligence</h1><a href="/journal/tourism-management">Tourism Management</a><p>Submission deadline: 31 July 2027</p></main>',
    }),
  });
  assert.equal(result.failed.length, 0);
  assert.equal(result.state.issues[0].deadline, '2027-07-31');
});

async function apiFixture(t, initial = {}, deps = {}) {
  let state = createSpecialIssueState(initial);
  const store = {
    getSpecialIssues: () => structuredClone(state),
    saveSpecialIssues: (s) => { state = structuredClone(s); },
    getSettings: () => ({ easyScholarKey: 'test-only' }),
  };
  const app = express();
  app.use(express.json());
  const service = registerSpecialIssueRoutes(app, { store, ...deps });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    service.scheduler.stop();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  const request = async (path, method = 'GET', body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/special-issues${path}`, {
      method, headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, data: await res.json() };
  };
  return { request, service, store, state: () => structuredClone(state) };
}

test('sync preserves mutations made while network requests are pending', async (t) => {
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const fixture = await apiFixture(t, {
    selectedJournalIds: ['tm'], issues: [live('keep'), live('delete')],
    wechat: { config: { historyUrl: 'https://mp.weixin.qq.com/mp/profile_ext?action=home&__biz=TEST' } },
  }, {
    resolveRequestModel: () => ({ profile: { model: 'test' } }),
    fetchModelCompletion: async () => ({ up: { ok: true } }),
    readLLMResponse: async () => ({ full: '[]' }),
    wechatProviderFactory: () => ({ page: async () => {
      entered();
      await gate;
      return { articles: [], dates: [], hasMore: false, nextOffset: 10 };
    } }),
  });
  const pending = fixture.service.runSync('manual');
  await started;
  fixture.store.saveSpecialIssues(createSpecialIssueState({
    ...fixture.state(), selectedJournalIds: [], favoriteIds: ['keep'],
    issues: [live('keep'), live('manual', { source: 'custom', custom: true })],
  }));
  release();
  await pending;
  assert.deepEqual(fixture.state().selectedJournalIds, []);
  assert.deepEqual(fixture.state().favoriteIds, ['keep']);
  assert.deepEqual(fixture.state().issues.map((i) => i.id).sort(), ['keep', 'manual']);
});

test('rank batches extract ABS explicitly and do not overwrite user changes', async (t) => {
  let fixture;
  fixture = await apiFixture(t, { issues: [live('one', { journal: 'Tourism Management' }), live('two', { journalId: 'atr', journal: 'Annals of Tourism Research' })] }, {
    queryRank: async () => {
      fixture.store.saveSpecialIssues({ ...fixture.state(), selectedJournalIds: ['tm'] });
      return { code: 200, data: { officialRank: { all: { ajg: '4', ssci: 'Q1' } } } };
    },
  });
  const { data, status } = await fixture.request('/ranks/refresh', 'POST', { limit: 1 });
  assert.equal(status, 200);
  assert.equal(data.refreshed, 1);
  assert.equal(Object.values(data.ranks)[0].abs, '4');
  assert.equal(data.pendingJournalIds.length, 1);
  assert.deepEqual(data.selectedJournalIds, ['tm']);
});

test('translation cannot resurrect a deleted issue or its cached translation', async (t) => {
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const fixture = await apiFixture(t, { issues: [live('translate')] }, {
    translateText: async () => { entered(); await gate; return 'translated'; },
  });
  const pending = fixture.request('/translate/translate', 'POST', {});
  await started;
  fixture.store.saveSpecialIssues({ ...fixture.state(), issues: [] });
  release();
  assert.equal((await pending).status, 400);
  assert.deepEqual(fixture.state().issues, []);
  assert.deepEqual(fixture.state().translations, {});
});

test('recommendation and hotspot routes respect empty subscriptions and disabled preferences', async (t) => {
  const fixture = await apiFixture(t, { issues: [live('tourism')] }, {
    getGraph: () => ({ topics: [{ label: 'tourism', terms: ['tourism'], count: 5 }] }),
  });
  assert.deepEqual((await fixture.request('/recommendations')).data.items, []);
  assert.deepEqual((await fixture.request('/hot-topics')).data.topics, []);
  await fixture.request('/preferences', 'PUT', { scope: 'all', recommendEnabled: false });
  assert.deepEqual((await fixture.request('/recommendations')).data.items, []);
});

test('changed source content invalidates translation in payload and translation endpoint', async (t) => {
  let calls = 0;
  const fixture = await apiFixture(t, {
    selectedJournalIds: ['tm'], issues: [live('updated', { title: 'New title', description: 'New description' })],
    translations: { updated: { title: 'Old translation', sourceTitle: 'Old title', sourceDescription: 'Old description' } },
  }, { translateText: async () => { calls++; return 'Fresh translation'; } });
  assert.deepEqual((await fixture.request('')).data.translations, {});
  const fresh = await fixture.request('/updated/translate', 'POST', {});
  assert.equal(fresh.data.cached, false);
  assert.equal(fresh.data.translation.sourceTitle, 'New title');
  assert.equal(calls, 2);
  assert.equal((await fixture.request('/updated/translate', 'POST', {})).data.cached, true);
});

test('subscribed topic counts are not compared against global historical counts', async (t) => {
  const day = new Date();
  day.setDate(day.getDate() - 7);
  const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  const fixture = await apiFixture(t, {
    selectedJournalIds: ['tm'], issues: [live('topic')],
    topicHistory: { [key]: { counts: { tourism: 30 }, scope: 'all' } },
  });
  assert.equal((await fixture.request('/hot-topics')).data.topics[0].trend, null);
  await fixture.request('/preferences', 'PUT', { scope: 'all' });
  assert.equal((await fixture.request('/hot-topics')).data.topics[0].trend, -29);
});
