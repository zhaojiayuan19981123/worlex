// si-link-verification.test.mjs —— SI 征稿链接核验与官方详情页解析
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfpPageEvidence, officialSiDetailEvidence, canonicalSourceUrl } from '../src/specialIssueSourcePolicy.js';
import { officialSiDetailCandidates } from '../src/specialIssueParser.js';
import { parseSpecialIssueDocument, buildSyncTasks, createSpecialIssueState } from '../src/specialIssues.js';
import { ABS_JOURNALS, CFP_SOURCES, journalById } from '../src/specialIssueCatalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');
const detailUrl = 'https://callforpapers.taylorandfrancis.com/special_issues/guardians-of-accountability/';
const DETAIL_HTML = `<!doctype html><html><head><title>Guardians of Accountability</title></head><body>
<main>
<h1>Accounting Forum</h1>
<h2>Guardians of accountability: Accounting professionals' roles in fraud prevention</h2>
<p>Special Issue. Guest editors invite research on accountability and fraud prevention.</p>
<p>Submission deadline: 31 March 2027. Submit your manuscript via the journal portal.</p>
</main></body></html>`;

test('官方 SI 详情页判据：详情页通过、普通主页不误判', () => {
  const detail = officialSiDetailEvidence(DETAIL_HTML, detailUrl, 'Accounting Forum');
  assert.equal(detail.confirmed, true);
  assert.equal(detail.detail, true);
  assert.equal(detail.closed, false);
  // 列表页判据不应把详情页当通用 CFP 列表（避免错误路径）
  assert.equal(cfpPageEvidence(DETAIL_HTML, detailUrl, 'Accounting Forum').confirmed, false);
  // 非官方域名绝不通过
  assert.equal(officialSiDetailEvidence(DETAIL_HTML, 'https://evil.example.com/special_issues/x/', 'Accounting Forum').confirmed, false);
  // 期刊身份不符不通过
  assert.equal(officialSiDetailEvidence(DETAIL_HTML, detailUrl, 'Tourism Management').confirmed, false);
});

test('官方 SI 详情页判据：已关闭投稿的页面被拒绝', () => {
  const closed = DETAIL_HTML.replace('Submission deadline: 31 March 2027.', 'Submissions are now closed.');
  const ev = officialSiDetailEvidence(closed, detailUrl, 'Accounting Forum');
  assert.equal(ev.closed, true);
  assert.equal(ev.confirmed, false);
});

test('官方详情页解析：只产出一条真实 SI，标题/deadline/链接正确，导航链接不混入', () => {
  const html = DETAIL_HTML + `<nav><a href="/call-for-papers/">View all available Calls for Papers</a>
    <a href="/special_issues/other/">Another special issue</a></nav>`;
  const items = parseSpecialIssueDocument(html, { baseUrl: detailUrl, journal: journalById('af'), now: new Date() });
  assert.equal(items.length, 1);
  assert.match(items[0].title, /Guardians of Accountability/i);
  assert.equal(items[0].deadline, '2027-03-31');
  assert.equal(items[0].url, detailUrl);
  assert.equal(items[0].journalId, 'af');
  assert.ok(!/View all available/i.test(items[0].title));
});

test('官方详情页解析：不传期刊也能从页面识别期刊身份', () => {
  const items = parseSpecialIssueDocument(DETAIL_HTML, { baseUrl: detailUrl, now: new Date() });
  assert.equal(items.length, 1);
  assert.equal(items[0].journalId, 'af');
});

test('审计配置：已核验的 SI 详情页必须来自官方 API，且逐条可核对', () => {
  const audit = JSON.parse(read('src/specialIssueSourceAudit.json'));
  const verified = Object.values(audit.journals).filter((j) => j.verifiedSiUrls?.length);
  assert.ok(verified.length >= 8, `官方 API 应核验至少 8 本期刊，实际 ${verified.length}`);
  for (const j of verified) {
    assert.equal(j.source, 'tandf-official-api');
    for (const url of j.verifiedSiUrls) {
      const u = new URL(url);
      assert.equal(u.hostname, 'callforpapers.taylorandfrancis.com', `${j.id} 链接域名不正确：${url}`);
      assert.match(u.pathname, /^\/special_issues\/[^/]+\/?$/, `${j.id} 链接不是 SI 详情页：${url}`);
    }
    assert.ok(j.issues.every((i) => i.deadline && i.title));
  }
});

test('catalog：只有官方 API 聚合源被验证，SF/SAGE/INFORMS 等不可靠源不作为默认', () => {
  const verified = CFP_SOURCES.filter((s) => s.verified);
  assert.deepEqual(verified.map((s) => s.id), ['tandf']);
  for (const j of ABS_JOURNALS) {
    if (!j.cfpUrl) continue;
    const u = new URL(j.cfpUrl);
    assert.ok(u.hostname === 'callforpapers.taylorandfrancis.com', `${j.id} 默认征稿源不是官方地址：${j.cfpUrl}`);
  }
});

test('catalog：核验过的详情页作为证据暴露，抓取源仍为官方聚合接口', () => {
  const withEvidence = ABS_JOURNALS.filter((j) => j.verifiedSiUrls?.length);
  assert.ok(withEvidence.length >= 8);
  for (const j of withEvidence) {
    assert.match(j.cfpUrl, /wp-json\/wp\/v2\/special_issues/, `${j.id} 抓取源应为官方聚合接口`);
    assert.ok(j.verifiedSiUrls.every((u) => /\/special_issues\//.test(u)));
  }
  const state = createSpecialIssueState({ selectedJournalIds: ['af', 'ejis'] });
  const tasks = buildSyncTasks(state, ['af', 'ejis']);
  assert.equal(new Set(tasks.map((t) => t.url)).size, tasks.length, '任务 URL 不应重复');
});

test('canonicalSourceUrl：去掉 Springer 的 cookies_not_supported 追踪参数', () => {
  const url = 'https://link.springer.com/journal/41267?error=cookies_not_supported&code=abc#section';
  assert.equal(canonicalSourceUrl(url), 'https://link.springer.com/journal/41267');
});
