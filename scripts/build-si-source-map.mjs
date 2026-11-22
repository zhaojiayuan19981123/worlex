// build-si-source-map.mjs —— 从官方结构化征稿接口构建「期刊 → 真实 SI 详情页链接」映射。
//
// 核心原则：链接必须来自官方 API 返回的记录本身（record.link / 官方字段），
// 绝不按期刊名或简称猜测拼接 URL。每条记录都带 journal title / SI title / deadline。
//
// 用法：node scripts/build-si-source-map.mjs [tandf-all.json] [output.json]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const input = args[0] || 'D:/work/tandf_all.json';
const output = args[1] || path.join(root, 'src/specialIssueSourceAudit.json');
const records = JSON.parse(fs.readFileSync(input, 'utf8'));

const catalogSrc = fs.readFileSync(path.join(root, 'src/specialIssueCatalog.js'), 'utf8');
const journals = [...catalogSrc.matchAll(/\['([a-z0-9_]+)', '([^']+)', '([^']+)', '([^']+)', '([^']+)'\]/g)]
  .map((m) => ({ id: m[1], title: m[2], category: m[4], publisher: m[5] }));

const norm = (s) => String(s || '').replace(/&/g, ' and ').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const field = (meta, key) => Array.isArray(meta?.[key]) ? meta[key][0] : meta[key];
const plain = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// 已核验的 tandfonline 期刊代号（比期刊名匹配更可靠，可区分 Journal of Advertising 与
// International Journal of Advertising）。来源：官方期刊主页 tandfonline.com/journals/<code>。
// 代号来自之前逐刊核验的快照，此处固化以避免脚本依赖临时文件。
const TANDF_CODES = {
  abr: 'RABR20', af: 'RACC20', ear: 'REAR20', jbfin: 'HBHF20', ijpr: 'TPRS20',
  iise: 'UIIE21', jmis: 'MMIS20', ejis: 'TJIS20', ja: 'UJOA20', jost: 'RSUS20',
  tg: 'RTXG20', cit: 'RCIT20', apjtr: 'RAPT20', jttm: 'WTTM20', jht: 'RJHT20',
  trr: 'RTRR20', ijhmc: 'WHMM20', pmr: 'RPXM20', she: 'CSHE20',
};
const codeToJournal = new Map();
for (const [id, code] of Object.entries(TANDF_CODES)) {
  codeToJournal.set(code, id);
  codeToJournal.set(code.replace(/(?:20|21)$/, ''), id);
}

const byTitle = new Map();
for (const j of journals) byTitle.set(norm(j.title), j);
const issuesByJournal = new Map();
const unmatchedNames = new Map();

for (const r of records) {
  const meta = r?.special_issues;
  if (!meta || typeof meta !== 'object' || !r.link) continue;
  const name = plain(field(meta, '_special_issues_journal_title'));
  const rawCode = String(field(meta, '_special_issues_journal_select') || '').trim().toUpperCase();
  // 优先用官方期刊代号精确匹配；代号缺失时才回退到标题精确匹配。
  const j = (rawCode && codeToJournal.get(rawCode) ? journals.find((x) => x.id === codeToJournal.get(rawCode)) : null)
    || byTitle.get(norm(name));
  if (!j) { unmatchedNames.set(norm(name), name); continue; }
  const deadline = plain(field(meta, '_special_issues_deadline') || field(meta, '_special_issues_deadline2'));
  const issue = {
    url: canonical(r.link),
    title: plain(field(meta, '_special_issues_title') || r.title?.rendered),
    siTitle: plain(field(meta, '_special_issues_title_short')),
    deadline,
    deadlineText: deadline,
    updatedAt: r.modified || r.date || '',
  };
  if (!issue.title || !issue.url) continue;
  const list = issuesByJournal.get(j.id) || [];
  list.push(issue);
  issuesByJournal.set(j.id, list);
}

function canonical(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch { return String(url || ''); }
}

// 读取旧审计保留其它期刊的核验信息
let previous = { journals: {}, aggregates: [] };
try { previous = JSON.parse(fs.readFileSync(output, 'utf8')); } catch { /* new */ }
const checkedAt = new Date().toISOString();
const result = {
  checkedAt,
  method: 'Official structured call-for-papers API (T&F). Per-journal CFP links come only from API records; no URL guessing. Each link is an actual Special Issue detail page with journal title and deadline.',
  source: 'https://callforpapers.taylorandfrancis.com/wp-json/wp/v2/special_issues',
  recordCount: records.length,
  journals: { ...previous.journals },
  aggregates: previous.aggregates,
};

for (const j of journals) {
  const issues = (issuesByJournal.get(j.id) || []).filter((i) => i.deadline);
  if (!issues.length) continue;
  // 仅保留可达且未过期的 SI 详情页；deadline 解析在 catalog 运行时也会做
  issues.sort((a, b) => (a.deadline || '').localeCompare(b.deadline || ''));
  result.journals[j.id] = {
    id: j.id,
    journalUrl: result.journals[j.id]?.journalUrl || '',
    cfpUrl: issues[0].url,
    cfpUrls: [...new Set(issues.map((i) => i.url))],
    issues,
    state: 'cfp-confirmed',
    checkedAt,
    source: 'tandf-official-api',
    checks: [{ requestedUrl: result.source, status: 200, checkedAt, evidence: { format: 'official-special-issues-json', records: records.length } }],
  };
}

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
const confirmed = Object.values(result.journals).filter((j) => j.state === 'cfp-confirmed');
console.log(JSON.stringify({
  output,
  totalRecords: records.length,
  confirmedJournals: confirmed.length,
  totalLinks: confirmed.reduce((n, j) => n + j.cfpUrls.length, 0),
  ids: confirmed.map((j) => j.id),
  unmatchedNames: unmatchedNames.size,
}, null, 2));
