// verify-si-links.mjs —— 逐刊核验 SI 征稿链接：是否真实可达、是否确为 Special Issue、是否可解析出字段。
//
// 用法：
//   node scripts/verify-si-links.mjs [output.json] [--proxy=http://127.0.0.1:10809] [--only=id1,id2] [--delay=2500] [--tries=2]
//
// 输出：一份机器可读的核验报告 + 控制台摘要。不修改 catalog / audit，只产出证据，
// 由人工确认后再用 apply-si-links.mjs 写回配置，避免自动把误判链接写进默认源。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ABS_JOURNALS, CFP_SOURCES } from '../src/specialIssueCatalog.js';
import { proxiedFetch } from '../src/proxiedFetch.js';
import { parseDocument, DomUtils } from 'htmlparser2';
import { cfpPageEvidence, canonicalSourceUrl } from '../src/specialIssueSourcePolicy.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const output = args.find((a) => !a.startsWith('--')) || path.join(root, 'si-link-verification.json');
const proxyUrl = args.find((a) => a.startsWith('--proxy='))?.slice(8) || process.env.SI_PROXY || '';
const only = args.find((a) => a.startsWith('--only='))?.slice(7)?.split(',').filter(Boolean);
const delay = Math.max(0, Number(args.find((a) => a.startsWith('--delay='))?.slice(8)) || 2500);
const tries = Math.max(1, Number(args.find((a) => a.startsWith('--tries='))?.slice(8)) || 2);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').replace(/&/g, ' and ').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const titleOf = (html) => {
  try {
    const node = DomUtils.findOne((n) => n.name === 'title', parseDocument(String(html || '')).children);
    return node ? DomUtils.textContent(node).replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  } catch { return ''; }
};

const fetchWithRetry = async (url) => {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await proxiedFetch(url, {
        headers: { Accept: 'application/json,text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
        redirect: 'follow',
      }, { proxyUrl, timeoutMs: 20000 });
      const text = (await res.text()).slice(0, 2 * 1024 * 1024);
      if (res.status === 403 || res.status === 429) {
        last = { status: res.status, error: 'rate-limited', body: text };
        await sleep(delay * 2);
        continue;
      }
      return { status: res.status, url: res.url || url, body: text, checkedAt: new Date().toISOString() };
    } catch (e) {
      last = { status: 0, error: e.message };
      await sleep(delay);
    }
  }
  return { status: last?.status || 0, url, error: last?.error || 'unknown', body: last?.body || '', checkedAt: new Date().toISOString() };
};

// Each candidate is a *specific* official call-for-papers / special-issue URL, never a guessed slug.
const candidates = [];
for (const j of ABS_JOURNALS) {
  if (j.cfpUrl) candidates.push({ journalId: j.id, journalTitle: j.title, url: canonicalSourceUrl(j.cfpUrl), kind: 'configured-cfp' });
  for (const u of j.cfpUrls || []) {
    const url = canonicalSourceUrl(u);
    if (!candidates.some((c) => c.journalId === j.id && c.url === url)) candidates.push({ journalId: j.id, journalTitle: j.title, url, kind: 'configured-cfp' });
  }
}
for (const s of CFP_SOURCES) candidates.push({ journalId: '', journalTitle: s.label, url: canonicalSourceUrl(s.url), kind: 'aggregate', sourceId: s.id });
const queue = only ? candidates.filter((c) => only.includes(c.journalId) || only.includes(c.sourceId)) : candidates;

const originNext = new Map();
const results = [];
let done = 0;
for (const c of queue) {
  const origin = new URL(c.url).origin;
  const wait = Math.max(0, (originNext.get(origin) || 0) - Date.now());
  if (wait) await sleep(wait);
  originNext.set(origin, Date.now() + delay);
  const res = await fetchWithRetry(c.url);
  const title = titleOf(res.body);
  const isJson = /^\s*[\[{]/.test(res.body);
  let evidence = null;
  if (res.status === 200 && !isJson) {
    try { evidence = cfpPageEvidence(res.body, res.url, c.journalTitle); } catch { /* ignore */ }
  }
  // Detail pages from the official CFP API have the SI title as <title>, no "Call for Papers" label.
  const detailSi = /callforpapers\.taylorandfrancis\.com\/special_issues\//i.test(c.url)
    && /special\s+issue|submission\s+deadline|deadline/i.test(res.body.slice(0, 30000))
    && (!c.journalTitle || norm(c.journalTitle).split(' ').every((w) => w.length < 4 || norm(res.body.slice(0, 60000)).includes(w)));
  const isSiText = /special\s+issue|call\s+for\s+papers|征稿|专刊/i.test(`${title} ${res.body.slice(0, 20000)}`);
  results.push({
    ...c,
    status: res.status,
    finalUrl: res.url,
    title,
    error: res.error || '',
    evidence,
    verdict: res.status === 200 && (evidence?.confirmed || detailSi || (isJson && c.sourceId === 'tandf')) ? 'verified'
      : res.status === 403 || res.status === 429 ? 'blocked'
        : res.status === 0 ? 'network-error'
          : isSiText ? 'si-text-unconfirmed' : 'not-si',
  });
  console.log(`${++done}/${queue.length} ${c.journalId || c.sourceId} ${res.status} ${results.at(-1).verdict} ${c.url}`);
}

const summary = results.reduce((acc, r) => ({ ...acc, [r.verdict]: (acc[r.verdict] || 0) + 1 }), {});
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ checkedAt: new Date().toISOString(), proxyUsed: !!proxyUrl, summary, results }, null, 2) + '\n');
console.log(JSON.stringify({ output, summary }));
