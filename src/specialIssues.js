// specialIssues.js —— SI（Special Issue）征稿：抓取解析、状态规范化、相关性与领域热点（纯逻辑）
//
// 与 src/topJournals.js 保持同一套约定：
//   * 网络通过 { fetchImpl } 注入，纯函数、不碰 fs，单测不需要真出网；
//   * 单个源失败只记 error，不影响其它源；
//   * 所有外部输入都做类型兜底，状态由 createSpecialIssueState() 统一规范化。
// 抓取的是出版社/期刊「征稿页」的公开列表信息，不抓全文、不绕登录。

import crypto from 'node:crypto';
import { canonicalSourceUrl, cfpPageEvidence } from './specialIssueSourcePolicy.js';
import { discoverJournalCfpPages, publisherCandidates, publisherPageError, mayFetchDetail } from './specialIssueParser.js';
import {
  ABS_JOURNALS, ABS_CATEGORIES, CFP_SOURCES, SI_PRESETS, TOPIC_LEXICON,
  journalById, defaultCfpUrl, isLegacyWileyCfpUrl,
} from './specialIssueCatalog.js';

export { ABS_JOURNALS, ABS_CATEGORIES, CFP_SOURCES, SI_PRESETS, TOPIC_LEXICON, journalById };

const DAY = 24 * 60 * 60 * 1000;
const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const STOP_WORDS = new Set(('the a an and or of for to in on at by with from as is are be this that these those we you your our their it its will can may special issue issues call papers submissions submission manuscripts manuscript paper research journal guest editors deadline please submit new about more than into over under using use based towards toward how what which who when where while not no all any if then than also including include includes open invited volume issue'.split(' ')));

const str = (v) => String(v == null ? '' : v);
const clean = (v) => str(v).replace(/\s+/g, ' ').trim();
const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function stableId(parts) {
  return 'si:' + crypto.createHash('sha1').update(parts.map((p) => clean(p).toLowerCase()).join('|')).digest('hex').slice(0, 20);
}

function safeUrl(href, baseUrl) {
  if (!str(href).trim()) return '';
  try {
    const u = new URL(str(href), str(baseUrl) || 'http://localhost/');
    if (!/^https?:$/.test(u.protocol)) return '';
    u.hash = '';
    return u.href;
  } catch { return ''; }
}

// ---------------- 状态 ----------------
/** 与 topJournals.createTopJournalState 同构：强制版本 + 白名单订阅 + 全字段兜底。 */
export function createSpecialIssueState(value = {}) {
  const v = value && typeof value === 'object' ? value : {};
  const ids = Array.isArray(v.selectedJournalIds) ? v.selectedJournalIds : [];
  const overrides = v.cfpOverrides && typeof v.cfpOverrides === 'object' ? v.cfpOverrides : {};
  const ranks = v.ranks && typeof v.ranks === 'object' ? v.ranks : {};
  const sync = v.sync && typeof v.sync === 'object' ? v.sync : {};
  const history = v.topicHistory && typeof v.topicHistory === 'object' ? v.topicHistory : {};
  const prefs = v.preferences && typeof v.preferences === 'object' ? v.preferences : {};
  return {
    version: 1,
    selectedJournalIds: [...new Set(ids.filter((id) => typeof id === 'string' && ABS_JOURNALS.some((j) => j.id === id)))],
    cfpOverrides: Object.fromEntries(Object.entries(overrides)
      .filter(([id, url]) => ABS_JOURNALS.some((j) => j.id === id) && typeof url === 'string'
        && /^https?:\/\//i.test(url) && !isLegacyWileyCfpUrl(url))
      .slice(0, 300)),
    customSources: (Array.isArray(v.customSources) ? v.customSources : [])
      .filter((s) => s && typeof s.url === 'string' && /^https?:\/\//i.test(s.url) && !isLegacyWileyCfpUrl(s.url))
      .slice(0, 50)
      .map((s) => ({ id: str(s.id) || stableId([s.url, s.label]), label: clean(s.label) || '自定义征稿页', url: s.url.trim(), journalId: str(s.journalId || '') })),
    issues: Array.isArray(v.issues) ? v.issues.filter((i) => i && typeof i === 'object' && i.id) : [],
    ranks: Object.fromEntries(Object.entries(ranks).filter(([, r]) => r && typeof r === 'object').slice(0, 300)),
    translations: v.translations && typeof v.translations === 'object' ? v.translations : {},
    sync: Object.fromEntries(Object.entries(sync).filter(([key, s]) => s && typeof s === 'object'
      && key !== 'publisher:Wiley Online Library' && !isLegacyWileyCfpUrl(s.url))),
    topicHistory: Object.fromEntries(Object.entries(history).filter(([, h]) => h && typeof h === 'object').slice(-120)),
    dismissedIds: [...new Set((Array.isArray(v.dismissedIds) ? v.dismissedIds : []).filter((x) => typeof x === 'string'))].slice(0, 2000),
    favoriteIds: [...new Set((Array.isArray(v.favoriteIds) ? v.favoriteIds : []).filter((x) => typeof x === 'string'))].slice(0, 2000),
    preferences: {
      recommendEnabled: prefs.recommendEnabled !== false,
      autoSync: prefs.autoSync !== false,
      syncHour: Number.isFinite(Number(prefs.syncHour)) ? Math.max(0, Math.min(23, Math.round(Number(prefs.syncHour)))) : 8,
      aiExtract: prefs.aiExtract === true,
      includeExpired: prefs.includeExpired === true,
      scope: prefs.scope === 'all' ? 'all' : 'subscribed',
    },
    lastSyncAt: str(v.lastSyncAt),
    lastAttemptAt: str(v.lastAttemptAt),
  };
}

// ---------------- 日期 ----------------
function pad(n) { return String(n).padStart(2, '0'); }
function validYmd(y, m, d, now) {
  y = Number(y); m = Number(m); d = Number(d);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return '';
  if (y < 2000 || y > now.getFullYear() + 8) return '';
  if (m < 1 || m > 12 || d < 1 || d > 31) return '';
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return '';
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * 从任意文本里抽投稿截止日期。支持 ISO、英文月名（前后顺序均可）、斜杠日期、中文年月日。
 * 带「deadline / 截止」标签的片段优先，避免把卷期号或出版年份误判成 deadline。
 * @returns {{date:string, text:string}} date 为 YYYY-MM-DD，抽不到为空串
 */
export function normalizeDeadline(text, now = new Date()) {
  const s = str(text).replace(/<[^>]*>/g, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, 100000);
  if (!s) return { date: '', text: '' };
  const label = /(?:(?:extended|revised|final|full)\s+)*(?:(?:abstracts?|papers?|manuscripts?)\s+)?(?:submission\s+)?deadline(?:\s+for\s+(?:abstracts?|submissions?|papers?|manuscripts?))?|(?:final\s+)?(?:full\s+)?(?:papers?|manuscripts?)(?:\s+would\s+be|\s+are|\s+is)?\s+due(?:\s+by)?|due\s+date|submit\s+by|submissions?\s+close[sd]?|closing\s+date|call\s+closes|摘要截止(?:日期|时间)?|投稿截止(?:日期|时间)?|截稿(?:日期|时间)?|截止日期/ig;
  const labels = [...s.matchAll(label)];
  const scopes = labels.map((m, index) => ({
    label: m[0], index,
    value: s.slice(m.index + m[0].length, Math.min(labels[index + 1]?.index ?? s.length, m.index + m[0].length + 120)),
  })).filter((m) => !/abstract|摘要/i.test(m.label))
    .sort((a, b) => Number(/extended|revised|final/i.test(b.label)) - Number(/extended|revised|final/i.test(a.label))
      || Number(/paper|manuscript|submission|投稿|截稿/i.test(b.label)) - Number(/paper|manuscript|submission|投稿|截稿/i.test(a.label)) || b.index - a.index);

  const patterns = [
    // 2026-12-31 / 2026.12.31 / 2026/12/31
    { re: /\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/, pick: (m) => [m[1], m[2], m[3]] },
    // 2026年12月31日
    { re: /\b(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/, pick: (m) => [m[1], m[2], m[3]] },
    // 31 December 2026 / 31st Dec, 2026
    { re: /\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s+(20\d{2})\b/i, pick: (m) => [m[3], MONTHS[m[2].toLowerCase()] || 0, m[1]] },
    // December 31, 2026 / Dec 31 2026
    { re: /\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/i, pick: (m) => [m[3], MONTHS[m[1].toLowerCase()] || 0, m[2]] },
    // Ambiguous numeric dates stay pending instead of risking premature removal.
    { re: /\b(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(20\d{2})\b/, pick: (m) => Number(m[1]) > 12 ? [m[3], m[2], m[1]] : Number(m[2]) > 12 || m[1] === m[2] ? [m[3], m[1], m[2]] : [] },
  ];
  for (const hay of scopes.length ? scopes.map((m) => m.value) : labels.length ? [] : [s]) {
  for (const { re, pick } of patterns) {
    const m = re.exec(hay);
    if (!m) continue;
    // Unlabelled publication/opening dates are not submission deadlines.
    if (!labels.length && clean(s).replace(/[.,。]$/, '') !== clean(m[0])) continue;
    const [y, mo, d] = pick(m);
    const date = validYmd(y, mo, d, now);
    if (date) return { date, text: clean(m[0]).slice(0, 48) };
  }
  }
  return { date: '', text: '' };
}

/** 截止日期的展示信息：剩余天数、短语、语义色调（前端用 token 上色）。 */
export function deadlineMeta(issue, now = new Date()) {
  const date = str(issue?.deadline);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { date: '', days: null, label: '未公布', tone: 'muted' };
  const valid = normalizeDeadline(date, now).date;
  if (!valid) return { date: '', days: null, label: '待核实', tone: 'muted' };
  const target = Date.parse(date + 'T00:00:00Z');
  if (!Number.isFinite(target)) return { date, days: null, label: date, tone: 'muted' };
  const days = Math.round((target - Date.parse(today(now) + 'T00:00:00Z')) / DAY);
  if (days < 0) return { date, days, label: '已截止', tone: 'muted' };
  if (days === 0) return { date, days, label: '今天截止', tone: 'urgent' };
  if (days <= 30) return { date, days, label: `${days} 天后截止`, tone: 'urgent' };
  if (days <= 90) return { date, days, label: `${days} 天后截止`, tone: 'soon' };
  return { date, days, label: date, tone: 'normal' };
}

// ---------------- HTML / RSS 解析 ----------------
function decodeEntities(s) {
  return str(s)
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;|&#34;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n) || 32))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16) || 32));
}
function htmlToText(html) {
  return decodeEntities(str(html)
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(?:p|li|div|h[1-6]|tr|article|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
function stripTags(html) {
  return decodeEntities(str(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
const SI_KEY = /(special[\s-]+issue|calls?[\s-]+for[\s-]+(?:papers|submissions|abstracts)|research\s+topic|guest\s+edit(?:or|ed)|cfp\b|专刊|征稿|特刊)/i;
const NEGATIVE_KEY = /(privacy policy|cookie|terms of use|sign in|log in|subscribe to newsletter|all journals|browse by)/i;

function hrefOf(fragment) {
  const m = /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(fragment);
  return m ? (m[1] || m[2] || m[3] || '') : '';
}
function headingOf(fragment) {
  const m = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(fragment);
  if (m) return stripTags(m[1]);
  const a = /<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(fragment);
  return a ? stripTags(a[1]) : '';
}

/** 把 HTML 切成「候选块」：优先按 li/article/带 CFP 语义的块，退化到锚点段落。 */
function htmlCandidates(html) {
  const source = str(html);
  const blocks = [];
  const blockRe = /<(li|article|section|div|tr|p)\b[^>]*>[\s\S]*?<\/\1>/gi;
  let m;
  while ((m = blockRe.exec(source)) && blocks.length < 400) {
    const frag = m[0];
    if (SI_KEY.test(stripTags(frag)) && !NEGATIVE_KEY.test(stripTags(frag).slice(0, 80))) blocks.push(frag);
  }
  if (blocks.length) return blocks;
  const anchorRe = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
  while ((m = anchorRe.exec(source)) && blocks.length < 400) {
    if (SI_KEY.test(stripTags(m[0]))) blocks.push(m[0]);
  }
  return blocks;
}

function rssItems(text) {
  const out = [];
  const re = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(text)) && out.length < 200) {
    const frag = m[2];
    const pick = (tag) => (new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(frag)?.[1] || '');
    let link = pick('link');
    if (!link) link = /<link[^>]*href\s*=\s*"([^"]*)"/i.exec(frag)?.[1] || '';
    const title = stripTags(pick('title'));
    const desc = stripTags(pick('description') || pick('summary') || pick('content'));
    const dateText = stripTags(pick('pubDate') || pick('updated') || pick('published'));
    if (title) out.push({ title, text: `${title} ${desc} ${dateText}`, href: link });
  }
  return out;
}

/** 从文本里识别属于哪本 ABS 期刊；返回 journalId，识别不了为空串。 */
export function matchJournal(text) {
  const s = clean(text).toLowerCase();
  if (!s) return '';
  let best = '';
  let bestLen = 0;
  for (const j of ABS_JOURNALS) {
    for (const name of [j.title, j.shortTitle].filter((x) => str(x).length >= 3)) {
      const n = name.toLowerCase();
      // 三个字母以内的英文简称（MAR / OR / JTR…）必须按词边界匹配，
      // 否则 "marketing" 会命中 MAR、"tour" 会命中 OR，把 SI 归错期刊。
      const shortAscii = n.length <= 4 && /^[a-z0-9&.\- ]+$/.test(n);
      const hit = shortAscii
        ? new RegExp(`(^|[^a-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(s)
        : s.includes(n);
      if (hit && n.length > bestLen) { best = j.id; bestLen = n.length; }
    }
  }
  return best;
}

/** 领域主题标签：确定性命中，不调模型。 */
export function detectTopics(text) {
  const s = clean(text).toLowerCase();
  if (!s) return [];
  const hits = [];
  for (const t of TOPIC_LEXICON) {
    if (t.terms.some((term) => termMatches(s, String(term).toLowerCase()))) hits.push(t.label);
  }
  return [...new Set(hits)];
}

/** 英文关键词：词频 top N，给翻译/相关性做补充信号。 */
export function extractKeywords(text, limit = 8) {
  const s = clean(text).toLowerCase();
  const freq = new Map();
  for (const word of s.match(/[a-z][a-z-]{2,}/g) || []) {
    const w = word.replace(/-+$/, '');
    if (w.length < 4 || STOP_WORDS.has(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([w]) => w);
}

/**
 * 解析一个征稿页（HTML 或 RSS/Atom），返回 SI 候选数组。
 * 只做公开列表信息的字段抽取：标题 / 简介 / deadline / 原文链接。
 */
export function parseSpecialIssueDocument(text, opts = {}) {
  const { baseUrl = '', journal = null, now = new Date(), rows = 60, requireUrl = true } = opts;
  const raw = str(text);
  if (!raw.trim()) return [];
  if (/^\s*\[/.test(raw) && isTandfApi(baseUrl)) {
    const records = JSON.parse(raw);
    if (records.some((record) => !record?.special_issues || typeof record.special_issues !== 'object')) throw new Error('官方征稿接口字段已改变');
    return records.slice(0, 100).map((record) => {
      const meta = record?.special_issues;
      if (!meta || typeof meta !== 'object') return null;
      const field = (key) => Array.isArray(meta[key]) ? meta[key][0] : meta[key];
      const name = stripTags(field('_special_issues_journal_title'));
      const matched = ABS_JOURNALS.find((j) => j.title.toLowerCase() === name.toLowerCase());
      const issue = normalizeAiIssue({
        title: stripTags(field('_special_issues_title') || record.title?.rendered),
        description: htmlToText(field('_special_issues_copy')),
        deadline: field('_special_issues_deadline'), url: record.link,
      }, { journal: matched || { id: '', title: name }, now, sourceUrl: baseUrl, inferJournal: false });
      return issue ? { ...issue, journalId: matched?.id || '', journal: name, source: 'publisher-api' } : null;
    }).filter(Boolean);
  }
  const isFeed = /<(?:rss|feed|rdf:RDF)\b/i.test(raw.slice(0, 2000));
  const candidates = isFeed
    ? rssItems(raw).map((x) => ({ title: x.title, text: x.text, href: x.href }))
    : publisherCandidates(raw, baseUrl, { detail: opts.detail === true });

  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const body = clean(c.text).slice(0, 60000);
    if (!body || body.length < 12 || !SI_KEY.test(body + ' ' + baseUrl)) continue;
    let title = clean(c.title || body).slice(0, 240);
    title = title.replace(/^(?:call\s+for\s+papers|special\s+issue|cfp)\s*[：:|\-–—]\s*/i, '').trim();
    if (!title || title.length < 8) continue;
    const url = (c.href ? safeUrl(c.href, baseUrl) : '') || safeUrl(baseUrl, baseUrl);
    if (requireUrl && !url) continue;
    const key = url + '|' + title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const dl = normalizeDeadline(c.text, now);
    let description = body.replace(title, '').replace(/^[\s:：|·\-–—]+/, '').trim();
    if (description.length < 20) description = body;
    const journalId = journal?.id || matchJournal(body + ' ' + title);
    const j = journalId ? journalById(journalId) : null;
    out.push({
      id: stableId([journalId || 'unknown', url, title]),
      journalId,
      journal: j?.title || (journal?.title || ''),
      journalShort: j?.shortTitle || clean(journal?.shortTitle || ''),
      publisher: j?.publisher || clean(journal?.publisher || ''),
      category: j?.category || '',
      title,
      description: description.slice(0, 12000),
      deadline: dl.date,
      deadlineText: dl.text,
      url,
      sourceUrl: safeUrl(baseUrl, baseUrl),
      topics: detectTopics(title + ' ' + body),
      keywords: extractKeywords(title + ' ' + body),
      discoveredAt: now.toISOString(),
      updatedAt: now.toISOString(),
      source: isFeed ? 'rss' : 'html',
    });
    if (out.length >= Math.max(1, Math.min(200, rows))) break;
  }
  return out;
}

/**
 * 解析用户从浏览器粘贴的征稿内容（网页源码 HTML 或渲染后的纯文本）。
 * 与自动抓取不同：内容来自用户可见页面，不依赖服务端出网；允许没有链接，
 * 用来源 URL / 标题兜底，让单条征稿通知也能导入。
 */
export function parsePastedContent(text, opts = {}) {
  const { baseUrl = '', journal = null, now = new Date(), rows = 60 } = opts;
  const raw = str(text);
  if (!raw.trim()) return [];
  const looksHtml = /<(?:a|div|p|li|h[1-6]|article|section|table|br|ul|ol|span)\b[^>]*>/i.test(raw);
  const items = looksHtml
    ? parseSpecialIssueDocument(raw, { baseUrl, journal, now, rows, requireUrl: false })
    : parsePlainTextContent(raw, { baseUrl, journal, now, rows });
  const source = safeUrl(baseUrl, baseUrl);
  return items.map((i) => ({
    ...i,
    source: 'pasted',
    url: i.url || source,
    sourceUrl: i.sourceUrl || source,
  }));
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"'）)，。、]+/gi;
const BODY_SIGNAL = /(deadline|截止|we invite|submissions?\s+(?:are|should|must)|please submit|guest editor|submission deadline)/i;

/**
 * 从一行文字里识别专刊标题：只认行首的明确标记，且排除「 Call for papers on …
 * Submission deadline: …」这类把正文写在标题行里的长句。返回空串表示不是标题行。
 */
function pastedHeading(line) {
  const s = clean(line);
  if (!s || s.length > 240) return '';
  if (s.length > 90 && BODY_SIGNAL.test(s)) return '';
  const m = /^(?:special\s+(?:issue|section)|research\s+topic|cfp|专刊|特刊|征稿)\s*[：:|\-–—]?\s*(.+)$/i.exec(s);
  if (m && clean(m[1]).length >= 6) return clean(m[1]);
  const c = /^call\s+for\s+(?:papers|submissions|abstracts)\s*[：:|\-–—]\s*(.+)$/i.exec(s);
  if (c && clean(c[1]).length >= 6) return clean(c[1]);
  return '';
}

/** 纯文本（浏览器「复制」后的渲染文字）按专刊标题行切成多条候选。 */
function parsePlainTextContent(raw, { baseUrl = '', journal = null, now = new Date(), rows = 60 } = {}) {
  const lines = str(raw).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    const heading = pastedHeading(line);
    if (heading) {
      if (cur) blocks.push(cur);
      cur = { title: heading, lines: [] };
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  if (cur) blocks.push(cur);
  // 没有任何标题行时，把整段当作一条（单条征稿通知的场景）
  if (!blocks.length && SI_KEY.test(str(raw))) {
    blocks.push({ title: '', lines: lines });
  }

  const out = [];
  const seen = new Set();
  for (const block of blocks) {
    const linesIn = block.lines.map(clean).filter(Boolean);
    const title = block.title || linesIn.find((l) => l.length >= 12 && !/^https?:\/\//i.test(l))?.slice(0, 240) || '';
    if (title.length < 8) continue;
    const body = [title, ...linesIn].join('\n').slice(0, 60000);
    if (!SI_KEY.test(body)) continue;
    const prose = linesIn.filter((l) => !/^https?:\/\//i.test(l)).join(' ').trim();
    const description = (prose.length >= 20 ? prose : body).slice(0, 12000);
    const dl = normalizeDeadline(body, now);
    const urls = (linesIn.join(' ').match(URL_IN_TEXT) || []).map((u) => safeUrl(u, baseUrl)).filter(Boolean);
    const url = urls[0] || safeUrl(baseUrl, baseUrl);
    const key = url + '|' + title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const journalId = journal?.id || matchJournal(body + ' ' + title);
    const j = journalId ? journalById(journalId) : null;
    out.push({
      id: stableId(['pasted', journalId || 'unknown', url, title]),
      journalId,
      journal: j?.title || clean(journal?.title || ''),
      journalShort: j?.shortTitle || clean(journal?.shortTitle || ''),
      publisher: j?.publisher || clean(journal?.publisher || ''),
      category: j?.category || '',
      title,
      description,
      deadline: dl.date,
      deadlineText: dl.text,
      url,
      sourceUrl: safeUrl(baseUrl, baseUrl),
      topics: detectTopics(title + ' ' + body),
      keywords: extractKeywords(title + ' ' + body),
      discoveredAt: now.toISOString(),
      updatedAt: now.toISOString(),
      source: 'pasted',
    });
    if (out.length >= Math.max(1, Math.min(200, rows))) break;
  }
  return out;
}

// ---------------- 合并 / 列表 ----------------
export function mergeIssues(existing = [], incoming = []) {
  const map = new Map();
  for (const old of existing) if (old?.id) map.set(old.id, { ...old });
  for (const item of incoming) {
    if (!item?.id) continue;
    const prev = map.get(item.id) || {};
    map.set(item.id, {
      ...prev, ...item,
      discoveredAt: prev.discoveredAt || item.discoveredAt,
      description: item.description || prev.description || '',
      deadline: item.deadline || prev.deadline || '',
      topics: item.topics?.length ? item.topics : (prev.topics || []),
    });
  }
  return [...map.values()].sort((a, b) => {
    const da = /^\d{4}-/.test(a.deadline || '') ? a.deadline : '9999';
    const db = /^\d{4}-/.test(b.deadline || '') ? b.deadline : '9999';
    return da.localeCompare(db) || str(b.discoveredAt).localeCompare(str(a.discoveredAt));
  }).slice(0, 3000);
}

// ---------------- 知识图谱画像 / 相关性 ----------------
/**
 * 从知识图谱里提炼「用户研究画像」：主题 / 关键词 / 实体各带权重。
 * 数据源为 GET /api/knowledge/graph 的 { topics, nodes, edges }：
 *   topics[].label / terms / count、nodes[].keywords、edges[kind=subject|method].terms
 */
export function profileFromGraph(graph) {
  const g = graph && typeof graph === 'object' ? graph : {};
  const bucket = new Map();
  const add = (term, weight, kind) => {
    const t = clean(term).toLowerCase();
    if (!t || t.length < 2 || t.length > 60) return;
    const cur = bucket.get(t) || { term: clean(term), weight: 0, kinds: new Set() };
    cur.weight += Math.max(0.2, Number(weight) || 1);
    cur.kinds.add(kind);
    bucket.set(t, cur);
  };
  for (const t of Array.isArray(g.topics) ? g.topics : []) {
    const count = Math.max(1, Number(t?.count) || 1);
    add(t?.label, 2 + Math.log2(count), 'topic');
    for (const term of Array.isArray(t?.terms) ? t.terms : []) add(term, 1.4 + Math.log2(count) / 2, 'topic');
  }
  const keyFreq = new Map();
  for (const n of Array.isArray(g.nodes) ? g.nodes : []) {
    add(n?.topicLabel, 2, 'topic');
    if (['entity', 'subject', 'method', 'keyword'].includes(n?.kind || n?.type)) add(n.label || n.name, 2, 'entity');
    for (const k of Array.isArray(n?.keywords) ? n.keywords : []) {
      const t = clean(k).toLowerCase();
      if (!t) continue;
      keyFreq.set(t, (keyFreq.get(t) || 0) + 1);
      add(k, 1, 'keyword');
    }
  }
  for (const e of Array.isArray(g.entities) ? g.entities : []) add(typeof e === 'string' ? e : e?.label || e?.name, 2, 'entity');
  for (const [t, n] of keyFreq) if (n > 1) add(t, Math.log2(n) * 1.5, 'keyword');
  for (const e of Array.isArray(g.edges) ? g.edges : []) {
    if (!['subject', 'method', 'keyword'].includes(e?.kind)) continue;
    const w = (Number(e?.weight) || 0.4) * (e.kind === 'subject' ? 2.2 : e.kind === 'method' ? 1.2 : 1.5);
    for (const term of Array.isArray(e?.terms) ? e.terms : []) add(term, w, e.kind === 'subject' ? 'entity' : e.kind);
  }
  const terms = [...bucket.values()].map((x) => ({ term: x.term, weight: Math.round(x.weight * 10) / 10, kind: [...x.kinds][0] || 'keyword' }));
  return {
    terms,
    topics: terms.filter((t) => t.kind === 'topic'),
    keywords: terms.filter((t) => t.kind === 'keyword'),
    entities: terms.filter((t) => t.kind === 'entity'),
    empty: terms.length === 0,
  };
}

const KIND_FACTOR = { topic: 3.2, entity: 2.6, keyword: 1.6, method: 1.1 };

function termMatches(hay, term) {
  if (/^[a-z0-9 .&-]+$/i.test(term)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(hay);
  }
  return hay.includes(term);
}

/** 单条 SI 与用户画像的相关性。命中主题/实体权重最高，分数封顶 100。 */
export function scoreRelevance(issue, profile, now = new Date()) {
  const p = profile && profile.terms ? profile : profileFromGraph(profile);
  if (!p.terms?.length) return { score: 0, matched: [], level: 'none' };
  const hay = clean([issue?.title, issue?.description, (issue?.topics || []).join(' '), (issue?.keywords || []).join(' '), issue?.journal].join(' ')).toLowerCase();
  if (!hay) return { score: 0, matched: [], level: 'none' };
  const matched = [];
  let raw = 0;
  const seen = new Set();
  for (const t of p.terms) {
    const key = t.term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // 中文用包含匹配；英文短语也用包含（主题词表都是 4 字符以上的实词短语）
    const bilingual = TOPIC_LEXICON.filter((entry) => entry.label.toLowerCase() === key || entry.terms.includes(key) || entry.label.includes(key));
    if (!termMatches(hay, key) && !bilingual.some((t) => t.terms.some((w) => termMatches(hay, w.toLowerCase())))) continue;
    const gain = (t.weight || 1) * (KIND_FACTOR[t.kind] || 1.2);
    raw += gain;
    matched.push({ term: t.term, kind: t.kind, gain: Math.round(gain * 10) / 10 });
  }
  if (!matched.length) return { score: 0, matched: [], level: 'none' };
  // 饱和曲线：命中越多收益递减，避免一篇堆满关键词的征稿刷到满分
  let score = Math.round(100 * (1 - Math.exp(-raw / 18)));
  // A small graph containing just one research term can still produce recommendations.
  const totalWeight = p.terms.reduce((sum, t) => sum + (t.weight || 1) * (KIND_FACTOR[t.kind] || 1.2), 0);
  score = Math.max(score, Math.round(35 * raw / Math.max(raw, totalWeight)));
  // 临近截止的更值得优先看到
  const dm = deadlineMeta(issue, now);
  if (dm.days != null && dm.days >= 0 && dm.days <= 60) score = Math.min(100, score + 4);
  if (dm.days != null && dm.days < 0) score = Math.max(0, score - 25);
  matched.sort((a, b) => b.gain - a.gain);
  return { score, matched: matched.slice(0, 6), level: score >= 60 ? 'high' : score >= 30 ? 'mid' : 'low' };
}

/** 主动推送：高相关 + 未过期 + 未关闭，按相关度降序、截止日期升序。 */
export function recommendIssues(issues, profile, opts = {}) {
  const { limit = 6, now = new Date(), dismissedIds = [], minScore = 30 } = opts;
  const dismissed = new Set(dismissedIds);
  return (Array.isArray(issues) ? issues : [])
    .filter((i) => !dismissed.has(i.id))
    .map((i) => ({ issue: i, relevance: scoreRelevance(i, profile, now), deadline: deadlineMeta(i, now) }))
    .filter((x) => x.relevance.score >= minScore && x.deadline.days !== null && x.deadline.days >= 0)
    .sort((a, b) => b.relevance.score - a.relevance.score
      || (a.deadline.days ?? 99999) - (b.deadline.days ?? 99999))
    .slice(0, Math.max(1, Math.min(30, limit)));
}

// ---------------- 领域热点 ----------------
/** 当日主题快照，写进 state.topicHistory[YYYY-MM-DD] 用于算趋势。 */
export function topicSnapshot(issues, now = new Date()) {
  const snap = {};
  for (const i of Array.isArray(issues) ? issues : []) {
    const dm = deadlineMeta(i, now);
    if (dm.days === null || dm.days < 0) continue;
    for (const t of new Set(i?.topics || [])) snap[t] = (snap[t] || 0) + 1;
  }
  return { at: today(now), counts: snap };
}

/**
 * 当前领域热点：按覆盖 SI 数、涉及期刊数、近 7 日新增、临近截止数加权。
 * 全部基于已抓取的真实 SI，抓不到数据就是空榜，不生成任何占位结论。
 */
export function computeHotTopics(issues, opts = {}) {
  const { history = {}, now = new Date(), limit = 12, journalIds = null } = opts;
  const list = (Array.isArray(issues) ? issues : []).filter((i) => (!journalIds || !i?.journalId || journalIds.includes(i.journalId))
    && deadlineMeta(i, now).days !== null && deadlineMeta(i, now).days >= 0);
  const buckets = new Map();
  const cutoff = now.getTime() - 7 * DAY;
  for (const i of list) {
    const dl = deadlineMeta(i, now);
    for (const topic of new Set(i?.topics || [])) {
      if (!buckets.has(topic)) buckets.set(topic, { topic, count: 0, journals: new Set(), upcomingCount: 0, expiringSoon: 0, recentCount: 0, nearestDeadline: '', issueIds: [] });
      const b = buckets.get(topic);
      b.count += 1;
      if (i.journalId) b.journals.add(i.journalId);
      if (dl.days != null && dl.days >= 0) {
        b.upcomingCount += 1;
        if (dl.days <= 60) b.expiringSoon += 1;
        if (!b.nearestDeadline || dl.date < b.nearestDeadline) b.nearestDeadline = dl.date;
      }
      if (Date.parse(i?.discoveredAt || 0) >= cutoff) b.recentCount += 1;
      if (b.issueIds.length < 40) b.issueIds.push(i.id);
    }
  }
  // 7 天前快照：趋势 = 当前覆盖数 − 历史覆盖数
  const pastKey = today(new Date(now.getTime() - 7 * DAY));
  const candidate = history?.[pastKey] || null;
  const past = opts.scopeKey !== undefined && candidate?.scope !== opts.scopeKey ? null : candidate;
  const topics = [...buckets.values()].map((b) => {
    const journalCount = b.journals.size;
    const score = b.count * 2 + journalCount * 1.5 + b.recentCount * 1.2 + b.expiringSoon * 0.6;
    const before = past ? (past.counts?.[b.topic] ?? past[b.topic] ?? 0) : null;
    const trend = before === null ? null : b.count - Number(before || 0);
    return {
      topic: b.topic, count: b.count, journalCount, upcomingCount: b.upcomingCount,
      expiringSoon: b.expiringSoon, recentCount: b.recentCount, nearestDeadline: b.nearestDeadline,
      score: Math.round(score * 10) / 10, trend, issueIds: b.issueIds,
    };
  }).sort((a, b) => b.score - a.score || b.count - a.count || a.topic.localeCompare(b.topic));
  const max = topics[0]?.score || 1;
  return topics.slice(0, Math.max(1, Math.min(40, limit))).map((t) => ({ ...t, share: Math.round(t.score / max * 100) }));
}

// ---------------- 列表筛选 ----------------
export function listIssues(state, opts = {}) {
  const s = createSpecialIssueState(state);
  const { query = '', journalIds = null, topic = '', sort = 'deadline', now = new Date(), profile = null, recommendOnly = false, favoriteOnly = false, limit = 400 } = opts;
  const q = clean(query).toLowerCase();
  const selected = journalIds === null ? null : new Set(journalIds);
  const favorites = new Set(s.favoriteIds);
  let items = s.issues.filter((i) => {
    // 只展示未截止的 SI；过期项由 purgeExpiredIssues 从磁盘清除，这里是双保险
    const dm = deadlineMeta(i, now);
    if (dm.days === null || dm.days < 0) return false;
    if (favoriteOnly && !favorites.has(i.id)) return false;
    if (selected && i.journalId && !selected.has(i.journalId)) return false;
    if (topic && !(i.topics || []).includes(topic)) return false;
    const tr = s.translations[i.id] || {};
    if (q && !clean([i.title, i.description, tr.title, tr.description, i.journal, i.publisher, i.deadline, i.deadlineText, (i.topics || []).join(' '), (i.keywords || []).join(' ')].join(' ')).toLowerCase().includes(q)) return false;
    return true;
  });
  items = items.map((i) => ({ ...i, deadline: deadlineMeta(i, now), relevance: profile ? scoreRelevance(i, profile, now) : { score: 0, matched: [] } }));
  if (recommendOnly) items = items.filter((i) => i.relevance.score >= 30);
  items.sort((a, b) => {
    if (sort === 'relevance') return b.relevance.score - a.relevance.score || (a.deadline.days ?? 99999) - (b.deadline.days ?? 99999);
    if (sort === 'latest') return str(b.discoveredAt).localeCompare(str(a.discoveredAt));
    return (a.deadline.days ?? 99999) - (b.deadline.days ?? 99999) || b.relevance.score - a.relevance.score;
  });
  return items.slice(0, Math.max(1, Math.min(1000, limit)));
}

// ---------------- 抓取 ----------------
function isTandfApi(url) {
  try {
    const u = new URL(url);
    return u.origin === 'https://callforpapers.taylorandfrancis.com'
      && /^\/wp-json\/wp\/v2\/special_issues\/?$/.test(u.pathname);
  } catch { return false; }
}

/** Build tasks from audited entries, homepage link discovery and user overrides. */
export function buildSyncTasks(state, journalIds = null) {
  const s = createSpecialIssueState(state);
  const wanted = Array.isArray(journalIds)
    ? [...new Set(journalIds.filter((id) => ABS_JOURNALS.some((j) => j.id === id)))]
    : s.selectedJournalIds;
  const tasks = [];
  const seen = new Map();
  const push = (url, journalId, label, discover = false, key = '') => {
    if (url === 'https://www.tandfonline.com/action/showSpecialIssues') url = CFP_SOURCES.find((s) => s.id === 'tandf').url;
    const safe = safeUrl(url, url);
    if (!safe) return;
    if (seen.has(safe)) {
      if (journalId && !seen.get(safe).journalIds.includes(journalId)) seen.get(safe).journalIds.push(journalId);
      return;
    }
    const aggregate = CFP_SOURCES.find((s) => s.url === safe);
    const task = { url: safe, journalId: aggregate ? '' : journalId, journalIds: journalId ? [journalId] : [], label: aggregate?.label || label, aggregate: !!aggregate, discover, key };
    tasks.push(task); seen.set(safe, task);
  };
  for (const id of wanted) {
    const j = journalById(id);
    if (!j) continue;
    const urls = s.cfpOverrides[id] ? [s.cfpOverrides[id]] : j.cfpUrls?.length ? j.cfpUrls : [j.cfpUrl || defaultCfpUrl(j)].filter(Boolean);
    if (urls.length) urls.forEach((url) => {
      push(url, id, j.shortTitle || j.title, false, urls.length > 1 ? `${id}:${url}` : '');
      const task = seen.get(safeUrl(url, url));
      if (task && !task.aggregate && !s.cfpOverrides[id]) task.verifyCfp = true;
    });
    else if (j.journalUrl && j.sourceAudit?.state !== 'robots-restricted') push(j.journalUrl, id, j.shortTitle || j.title, true);
    else tasks.push({ url: '', journalId: id, label: j.shortTitle || j.title, discover: false,
      error: j.sourceAudit?.state === 'robots-restricted' ? '官网 robots 限制或 robots 无法核实，未自动访问；请在浏览器核实后粘贴导入' : '' });
  }
  // 出版社聚合页只抓订阅刊涉及的出版社，避免无谓请求
  const publishers = new Set(wanted.map((id) => journalById(id)?.publisher).filter(Boolean));
  for (const src of CFP_SOURCES) if (src.verified && publishers.has(src.publisher)) push(src.url, '', src.label);
  for (const custom of s.customSources) push(custom.url, custom.journalId || '', custom.label);
  return tasks;
}

/**
 * 每日/手动抓取。网络注入、并发受限、单源失败隔离；返回新状态与统计。
 * @param {object} stateInput 现有 state
 * @param {object} opts { fetchImpl, journalIds, now, aiExtract, concurrency, timeoutMs, rowsPerSource }
 */
export async function syncSpecialIssues(stateInput, opts = {}) {
  const {
    fetchImpl = globalThis.fetch,
    journalIds = null,
    now = new Date(),
    aiExtract = null,
    concurrency = 3,
    timeoutMs = 15000,
    rowsPerSource = 60,
    maxDetailPages = 12,
    budgetMs = 90000,
    respectCrawlDelay = fetchImpl === globalThis.fetch,
  } = opts;
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持网络请求，无法抓取征稿信息');
  const state = createSpecialIssueState(stateInput);
  const tasks = buildSyncTasks(state, journalIds);
  if (!tasks.length) return { state, fetched: [], added: 0, total: 0, synced: [], failed: [] };

  const before = new Set(state.issues.map((i) => i.id));
  const fetched = [];
  const synced = [];
  const failed = [];
  const started = Date.now();
  const nextRequest = new Map();
  let detailCount = 0;
  async function fetchPage(url) {
    const origin = new URL(url).origin;
    const interval = respectCrawlDelay ? Math.max(2100, ...CFP_SOURCES.filter((source) => new URL(source.url).origin === origin).map((source) => source.crawlDelayMs)) : 0;
    const wait = Math.max(0, (nextRequest.get(origin) || 0) - Date.now());
    nextRequest.set(origin, Date.now() + wait + interval);
    if (wait >= budgetMs - (Date.now() - started)) throw new Error('本次抓取时间上限不足以满足官网访问间隔，请稍后分批重试');
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    const remaining = budgetMs - (Date.now() - started);
    if (remaining <= 0) throw new Error('本次抓取已达到时间上限，请缩小订阅范围后重试');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(Math.max(100, timeoutMs), remaining));
    try {
      const res = await fetchImpl(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; WorlexSI/2.2; academic CFP watcher)',
          Accept: 'application/json,text/html,application/xhtml+xml,application/rss+xml,application/atom+xml,application/xml;q=0.9',
          'Accept-Language': 'en-US,en;q=0.9',
        }, signal: controller.signal, redirect: 'follow',
      });
      if (res?.ok === false) {
        const hint = res.status === 404 ? '：征稿页已移除或地址有误，请更新该刊征稿页'
          : [403, 429].includes(res.status) ? '：出版社拒绝或限制访问，可从浏览器粘贴导入' : '';
        throw new Error(`HTTP ${res.status || '未知状态'}${hint}`);
      }
      const max = 4 * 1024 * 1024;
      let text = '';
      if (res?.body?.getReader) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let size = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > max) throw new Error('征稿页面超过 4 MB，请配置更具体的列表页');
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
        } finally { await reader.cancel().catch(() => {}); }
      } else text = typeof res?.text === 'function' ? await res.text() : str(res?.body || '');
      if (!text.trim()) throw new Error('页面为空');
      if (text.length > max) throw new Error('征稿页面过大');
      const error = publisherPageError(text);
      if (error) throw new Error(error);
      return { text, url: canonicalSourceUrl(res?.url || url), totalPages: Number(res?.headers?.get?.('X-WP-TotalPages')) || 0 };
    } catch (e) {
      if (e?.name === 'AbortError' || controller.signal.aborted) throw new Error('请求超时，请检查网络或配置单刊征稿页');
      throw e;
    } finally { clearTimeout(timer); }
  }
  const queue = [...tasks];
  const scheduled = new Set(tasks.map((task) => task.url).filter(Boolean));
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), queue.length) }, async () => {
    while (queue.length) {
      const task = queue.shift();
      let sourceUrl = task.url;
      try {
        if (!sourceUrl) throw new Error(task.error || '该刊没有已配置的征稿源，请在期刊管理中填写官网征稿页，或粘贴导入');
        let page = await fetchPage(sourceUrl);
        if (task.discover) {
          const links = discoverJournalCfpPages(page.text, page.url);
          if (!links.length) throw new Error('期刊主页未找到公开征稿入口，请指定官方征稿页或粘贴导入');
          for (const link of links) {
            if (scheduled.has(link)) continue;
            scheduled.add(link);
            queue.push({ ...task, url: link, discover: false, verifyCfp: true,
              key: links.length > 1 ? `${task.journalId}:${link}` : task.key });
          }
          delete state.sync[task.journalId];
          continue;
        }
        sourceUrl = page.url;
        const text = page.text;
        const journal = task.journalId ? journalById(task.journalId) : null;
        if (task.verifyCfp) {
          const evidence = cfpPageEvidence(text, page.url, journal?.title);
          if (evidence.closed) throw new Error('官网明确标注已关闭投稿，该专题不作为在征 SI 导入');
          if (!evidence.confirmed) throw new Error('页面未确认是该刊征稿入口，可能已重定向或属于已出版专刊；请核实原文');
        }
        let parsed = parseSpecialIssueDocument(text, { baseUrl: page.url, journal, now, rows: rowsPerSource });
        const warnings = [];
        const wanted = new Set(journalIds || state.selectedJournalIds);
        const structured = isTandfApi(page.url) && /^\s*\[/.test(text);
        if (structured) {
          const pageSize = Number(new URL(page.url).searchParams.get('per_page')) || 10;
          let count = JSON.parse(text).length;
          let pageNo = 1;
          while (count >= pageSize && (!page.totalPages || pageNo < page.totalPages) && pageNo < 12) {
            if (budgetMs - (Date.now() - started) < 1000) { warnings.push('达到抓取时间上限，结果为部分页面；请稍后重试'); break; }
            try {
              const url = new URL(page.url);
              url.searchParams.set('page', String(++pageNo));
              const more = await fetchPage(url.href);
              const records = JSON.parse(more.text);
              if (!Array.isArray(records)) throw new Error('官方接口返回格式已改变');
              parsed = mergeIssues(parsed, parseSpecialIssueDocument(more.text, { baseUrl: more.url, now }));
              count = records.length;
            } catch (e) { warnings.push('后续分页未完成：' + str(e?.message || e)); break; }
          }
          if (pageNo >= 12 && count >= pageSize && (!page.totalPages || pageNo < page.totalPages)) warnings.push('达到 12 页安全上限，结果可能不完整');
        }
        // Only follow same-origin detail links; each source and run have fixed limits.
        for (const item of (structured ? [] : parsed).filter((i) => !i.journalId || wanted.has(i.journalId)).slice(0, maxDetailPages)) {
          if (!mayFetchDetail(item.url, page.url) || detailCount >= 60) continue;
          detailCount += 1;
          try {
            const detail = await fetchPage(item.url);
            const details = parseSpecialIssueDocument(detail.text, { baseUrl: detail.url, journal: item.journalId ? journalById(item.journalId) : journal, now, detail: true });
            const found = details.find((x) => x.url === detail.url) || details[0];
            if (found) {
              const id = item.id, discoveredAt = item.discoveredAt, sourceUrl = item.sourceUrl;
              Object.assign(item, found, { id, discoveredAt, sourceUrl, detailFetchedAt: now.toISOString() });
            } else warnings.push('详情页未识别到完整征稿：' + item.url);
          } catch (e) { warnings.push(str(e?.message || e) + '：' + item.url); }
        }
        // 可选：让已配置的模型把页面文本再结构化一次，补上正则没抓全的字段
        if (aiExtract && !structured && text.length > 200) {
          try {
            const remaining = budgetMs - (Date.now() - started);
            if (remaining <= 0) throw new Error('本次抓取时间上限已到，跳过 AI 增强');
            const extra = await aiExtract(htmlToText(text).slice(0, 24000), { journal, sourceUrl: page.url, now, timeoutMs: Math.min(remaining, 30000) });
            if (Array.isArray(extra) && extra.length) {
              parsed = mergeIssues(parsed, extra.map((x) => normalizeAiIssue(x, { journal, now, sourceUrl: page.url })).filter(Boolean));
            }
          } catch (e) {
            // AI 抽取只是增强，失败不能让整次抓取失败
            state.sync['ai'] = { lastAttemptAt: now.toISOString(), error: str(e?.message || 'AI 抽取失败').slice(0, 200) };
          }
        }
        // Aggregates must never assign every result to the first selected journal.
        if (task.aggregate) parsed = parsed.filter((i) => i.journalId && wanted.has(i.journalId));
        if (!parsed.length && !structured) throw new Error('页面可访问，但未识别到所订阅期刊的 SI；可能无征稿、页面改版或依赖 JavaScript，请核实原文或粘贴导入');
        fetched.push(...parsed);
        state.sync[task.key || task.journalId || 'publisher:' + task.label] = {
          journalId: task.journalId,
          lastAttemptAt: now.toISOString(), lastSuccessAt: now.toISOString(), count: parsed.length,
          activeCount: parsed.filter((i) => deadlineMeta(i, now).days !== null && deadlineMeta(i, now).days >= 0).length,
          pendingCount: parsed.filter((i) => deadlineMeta(i, now).days === null).length,
          warnings, error: '', url: sourceUrl,
        };
        synced.push({ label: task.label, url: sourceUrl, count: parsed.length, warnings });
      } catch (e) {
        const message = str(e?.message || '未知抓取错误').slice(0, 200);
        state.sync[task.key || task.journalId || 'publisher:' + task.label] = {
          ...(state.sync[task.key || task.journalId || 'publisher:' + task.label] || {}),
          journalId: task.journalId,
          lastAttemptAt: now.toISOString(), error: message, url: sourceUrl,
        };
        failed.push({ label: task.label, url: sourceUrl, error: message });
      }
    }
  });
  await Promise.all(workers);
  state.issues = mergeIssues(state.issues, fetched);
  state.lastAttemptAt = now.toISOString();
  if (synced.length) state.lastSyncAt = now.toISOString();
  const added = state.issues.filter((i) => !before.has(i.id)).length;
  return { state, fetched, added, total: fetched.length, synced, failed };
}

/** 把模型返回的结构化条目收敛成内部字段（模型输出一律当不可信输入处理）。 */
export function normalizeAiIssue(raw, opts = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const { journal = null, now = new Date(), sourceUrl = '' } = opts;
  const title = clean(raw.title || raw.name).slice(0, 240);
  if (title.length < 8) return null;
  const url = safeUrl(raw.url || raw.link || '', sourceUrl) || safeUrl(sourceUrl, sourceUrl);
  if (!url) return null;
  const description = clean(raw.description || raw.summary || raw.theme || '').slice(0, 12000);
  const primary = normalizeDeadline(raw.deadline, now);
  const dl = primary.date ? primary : normalizeDeadline(raw.deadlineText, now);
  const journalId = journal?.id || (opts.inferJournal === false ? '' : matchJournal(`${journal?.title || ''} ${title} ${description}`));
  const j = journalId ? journalById(journalId) : null;
  const body = `${title} ${description}`;
  return {
    id: stableId([journalId || 'unknown', url, title]),
    journalId,
    journal: j?.title || clean(journal?.title || ''),
    journalShort: j?.shortTitle || clean(journal?.shortTitle || ''),
    publisher: j?.publisher || clean(journal?.publisher || ''),
    category: j?.category || '',
    title, description, deadline: dl.date, deadlineText: dl.text,
    url, sourceUrl: safeUrl(sourceUrl, sourceUrl),
    topics: detectTopics(body), keywords: extractKeywords(body),
    discoveredAt: now.toISOString(), updatedAt: now.toISOString(), source: 'ai',
  };
}

// ---------------- 订阅 / 偏好 / 推荐关闭 ----------------
export function setSubscriptions(stateInput, ids) {
  const state = createSpecialIssueState(stateInput);
  state.selectedJournalIds = [...new Set((Array.isArray(ids) ? ids : [])
    .filter((id) => typeof id === 'string' && ABS_JOURNALS.some((j) => j.id === id)))];
  return state;
}

export function setPreferences(stateInput, patch) {
  const state = createSpecialIssueState(stateInput);
  const p = patch && typeof patch === 'object' ? patch : {};
  for (const key of ['recommendEnabled', 'autoSync', 'aiExtract', 'includeExpired']) {
    if (typeof p[key] === 'boolean') state.preferences[key] = p[key];
  }
  if (p.syncHour !== undefined && Number.isFinite(Number(p.syncHour))) {
    state.preferences.syncHour = Math.max(0, Math.min(23, Math.round(Number(p.syncHour))));
  }
  if (p.scope === 'all' || p.scope === 'subscribed') state.preferences.scope = p.scope;
  return state;
}

export function dismissRecommendation(stateInput, id) {
  const state = createSpecialIssueState(stateInput);
  if (id && !state.dismissedIds.includes(id)) state.dismissedIds.push(str(id));
  state.dismissedIds = state.dismissedIds.slice(-2000);
  return state;
}

/** 收藏 / 取消收藏；force 为 true/false 时可显式指定目标状态。 */
export function toggleFavorite(stateInput, id, force = null) {
  const state = createSpecialIssueState(stateInput);
  const key = str(id);
  if (!key || !state.issues.some((i) => i.id === key)) return state;
  const has = state.favoriteIds.includes(key);
  const want = typeof force === 'boolean' ? force : !has;
  if (want === has) return state;
  state.favoriteIds = want ? [...state.favoriteIds, key] : state.favoriteIds.filter((x) => x !== key);
  return state;
}

/**
 * 用户自行添加一条 SI。所有字段按不可信输入处理；
 * deadline 支持 ISO / 英文 / 中文日期文本，链接可留空（用标题生成稳定 id）。
 */
export function addCustomIssue(stateInput, raw, opts = {}) {
  const state = createSpecialIssueState(stateInput);
  const { now = new Date(), allowPending = false } = opts;
  const r = raw && typeof raw === 'object' ? raw : {};
  const title = clean(r.title).slice(0, 240);
  if (title.length < 4) return { state, issue: null, error: '请填写专刊标题（至少 4 个字）' };
  const url = /^https?:\/\//i.test(clean(r.url)) ? safeUrl(r.url, '') : '';
  const rawJournalId = clean(r.journalId);
  const journalId = ABS_JOURNALS.some((j) => j.id === rawJournalId)
    ? rawJournalId
    : matchJournal(`${clean(r.journal)} ${title}`);
  const j = journalId ? journalById(journalId) : null;
  const primary = normalizeDeadline(r.deadline, now);
  const dl = primary.date ? primary : normalizeDeadline(r.deadlineText, now);
  if (!dl.date && !allowPending) return { state, issue: null, error: '请填写有效的投稿截止日期；日期不明的网页内容可先粘贴解析后核实' };
  if (deadlineMeta({ deadline: dl.date }, now).days < 0) return { state, issue: null, error: '该 SI 已截止，不能添加到在征列表' };
  const description = clean(r.description).slice(0, 12000);
  const body = `${title} ${description}`;
  const issue = {
    id: stableId(['custom', title, url || '']),
    journalId,
    journal: j?.title || clean(r.journal) || '未指定期刊',
    journalShort: j?.shortTitle || clean(r.journalShort) || '',
    publisher: j?.publisher || '',
    category: j?.category || '',
    title, description,
    deadline: dl.date,
    deadlineText: dl.text,
    url,
    sourceUrl: '',
    topics: detectTopics(body),
    keywords: extractKeywords(body),
    discoveredAt: now.toISOString(),
    updatedAt: now.toISOString(),
    source: 'custom',
    custom: true,
  };
  state.issues = mergeIssues(state.issues, [issue]);
  // 手动加的 SI 不能被「只看订阅」挡住：有期刊就顺手订阅
  if (journalId && !state.selectedJournalIds.includes(journalId)) {
    state.selectedJournalIds = [...state.selectedJournalIds, journalId];
  }
  state.favoriteIds = [...new Set([...state.favoriteIds, issue.id])].slice(0, 2000);
  return { state, issue: state.issues.find((i) => i.id === issue.id) || issue, error: '' };
}

/**
 * 批量导入浏览粘贴解析出的候选：逐条按 addCustomIssue 的规范化处理，
 * 已存在的（同标题+链接）自动跳过，返回真正新增的条目。
 */
export function importPastedIssues(stateInput, items, opts = {}) {
  let state = createSpecialIssueState(stateInput);
  const { now = new Date() } = opts;
  const added = [];
  const skipped = [];
  const list = Array.isArray(items) ? items.slice(0, 100) : [];
  for (const it of list) {
    if (!it || typeof it !== 'object') { skipped.push({ title: '', reason: '无效条目' }); continue; }
    const before = new Set(state.issues.map((i) => i.id));
    const res = addCustomIssue(state, {
      title: it.title, url: it.url, journalId: it.journalId, journal: it.journal,
      description: it.description, deadline: it.deadline || it.deadlineText,
    }, { now, allowPending: true });
    if (res.error) { skipped.push({ title: str(it.title), reason: res.error }); continue; }
    state = res.state;
    if (before.has(res.issue.id)) { skipped.push({ title: res.issue.title, reason: '已存在' }); continue; }
    added.push(res.issue);
  }
  return { state, added, skipped };
}

/** 到期自动清除：移除已过 deadline 的 SI，并清理译文 / 收藏 / 推荐黑名单里的残留 id。 */
export function purgeExpiredIssues(stateInput, opts = {}) {
  const state = createSpecialIssueState(stateInput);
  const now = opts.now || new Date();
  const expired = new Set(state.issues.filter((i) => {
    const dm = deadlineMeta(i, now);
    return dm.days !== null && dm.days < 0;
  }).map((i) => i.id));
  if (!expired.size) return { state, removed: [] };
  const removed = [...expired];
  state.issues = state.issues.filter((i) => !expired.has(i.id));
  state.favoriteIds = state.favoriteIds.filter((id) => !expired.has(id));
  state.dismissedIds = state.dismissedIds.filter((id) => !expired.has(id));
  state.translations = Object.fromEntries(Object.entries(state.translations).filter(([id]) => !expired.has(id)));
  return { state, removed };
}

/** 汇总数字，供页面顶部四个统计块使用。 */
export function specialIssueSummary(state, opts = {}) {
  const s = createSpecialIssueState(state);
  const now = opts.now || new Date();
  const issues = s.issues;
  let expiringSoon = 0;
  let active = 0;
  for (const i of issues) {
    const dm = deadlineMeta(i, now);
    if (dm.days !== null && dm.days >= 0) active += 1;
    if (dm.days !== null && dm.days >= 0 && dm.days <= 30) expiringSoon += 1;
  }
  return {
    total: issues.length, active, pending: issues.length - active, expiringSoon,
    subscribed: s.selectedJournalIds.length,
    catalogSize: ABS_JOURNALS.length,
    ranked: Object.keys(s.ranks).length,
    lastSyncAt: s.lastSyncAt,
    lastAttemptAt: s.lastAttemptAt,
    hotTopics: computeHotTopics(issues, { history: s.topicHistory, now, limit: 1 }).length,
  };
}
