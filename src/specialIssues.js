// specialIssues.js —— SI 征稿：数据层与管线（v2，公众号文章驱动）
//
// v1 走的是「订阅 ABS 期刊 → 逐刊抓出版社征稿页」，实测大量期刊官网禁止访问/人机验证，
// 且页面改版即失效。v2 改为「公众号文章驱动」：
//
//   文章源（siSources.js） → 正文（wechatArticle.js） → 抽取（siExtract.js）
//        → 期刊等级（easyscholar.js） → 卡片（issues）
//
// 本文件只用纯逻辑 + 注入的网络/模型函数，方便单测；落盘由 src/store.js 负责。

import crypto from 'node:crypto';
import { normalizeSource, canonicalArticleUrl, articleIdOf, SOURCE_TYPES } from './siSources.js';
import { normalizeExtractedIssues } from './siExtract.js';

const DAY = 24 * 60 * 60 * 1000;
const str = (v) => String(v == null ? '' : v);
const clean = (v) => str(v).replace(/\s+/g, ' ').trim();

function pad(n) { return String(n).padStart(2, '0'); }
export function today(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function shortHash(parts) {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

// ---------------- 状态 ----------------

export const SI_STATE_VERSION = 2;

export const DEFAULT_PREFERENCES = {
  autoSync: true,
  syncHour: 9,
  backfillDays: 90,
  includeExpired: false,
  showRuleExtracted: true,
  autoRank: true,
  autoTranslate: false,
  sort: 'deadline',
};

export function createSpecialIssueState(value = {}) {
  const v = value && typeof value === 'object' ? value : {};
  const prefs = v.preferences && typeof v.preferences === 'object' ? v.preferences : {};
  const sync = v.sync && typeof v.sync === 'object' ? v.sync : {};
  const ranks = v.ranks && typeof v.ranks === 'object' ? v.ranks : {};

  const sources = (Array.isArray(v.sources) ? v.sources : [])
    .map((s) => normalizeSource(s)).filter(Boolean).slice(0, 30);

  const sourceIds = new Set(sources.map((s) => s.id));
  const articles = (Array.isArray(v.articles) ? v.articles : [])
    .filter((a) => a && typeof a === 'object' && a.id)
    .map((a) => ({
      id: str(a.id),
      url: str(a.url),
      localPath: str(a.localPath),
      title: clean(a.title).slice(0, 200),
      publishedAt: str(a.publishedAt),
      digest: clean(a.digest).slice(0, 600),
      contentKind: a.contentKind === 'file' ? 'file' : 'url',
      sourceId: str(a.sourceId),
      sourceName: clean(a.sourceName).slice(0, 60),
      status: ['pending', 'extracted', 'skipped', 'failed'].includes(a.status) ? a.status : 'pending',
      attempts: Number.isFinite(Number(a.attempts)) ? Number(a.attempts) : 0,
      lastError: clean(a.lastError).slice(0, 300),
      fetchedAt: str(a.fetchedAt),
      extractedAt: str(a.extractedAt),
      contentChars: Number(a.contentChars) || 0,
    }))
    .slice(0, 5000);

  const articleIds = new Set(articles.map((a) => a.id));
  const issues = (Array.isArray(v.issues) ? v.issues : [])
    .filter((i) => i && typeof i === 'object' && i.id && (i.journal || i.titleZh))
    .map((i) => ({
      id: str(i.id),
      articleId: str(i.articleId),
      articleUrl: str(i.articleUrl),
      articleTitle: clean(i.articleTitle).slice(0, 200),
      articlePublishedAt: str(i.articlePublishedAt),
      sourceId: str(i.sourceId),
      sourceName: clean(i.sourceName).slice(0, 60),
      journal: clean(i.journal).slice(0, 160),
      journalShort: clean(i.journalShort).slice(0, 40),
      publisher: clean(i.publisher).slice(0, 60),
      titleEn: clean(i.titleEn).slice(0, 300),
      titleZh: clean(i.titleZh).slice(0, 300),
      summaryZh: clean(i.summaryZh).slice(0, 1200),
      topicsZh: (Array.isArray(i.topicsZh) ? i.topicsZh : []).map((t) => clean(t).slice(0, 24)).filter(Boolean).slice(0, 8),
      guestEditors: (Array.isArray(i.guestEditors) ? i.guestEditors : [])
        .map((e) => ({ name: clean(e?.name).slice(0, 60), affiliation: clean(e?.affiliation).slice(0, 80) }))
        .filter((e) => e.name).slice(0, 10),
      openDate: str(i.openDate),
      deadline: str(i.deadline),
      submitUrl: str(i.submitUrl),
      siUrl: str(i.siUrl),
      journalUrl: str(i.journalUrl),
      submissionNote: clean(i.submissionNote).slice(0, 300),
      confidence: Math.max(0, Math.min(1, Number(i.confidence) || 0)),
      extractedBy: i.extractedBy === 'rule' ? 'rule' : 'ai',
      rank: i.rank && typeof i.rank === 'object' ? { summary: str(i.rank.summary), items: Array.isArray(i.rank.items) ? i.rank.items.slice(0, 10) : [], queriedAt: str(i.rank.queriedAt), journal: str(i.rank.journal) } : null,
      createdAt: str(i.createdAt),
      updatedAt: str(i.updatedAt),
    }))
    .slice(0, 4000);

  const issueIds = new Set(issues.map((i) => i.id));
  return {
    version: SI_STATE_VERSION,
    sources,
    articles,
    issues,
    ranks: Object.fromEntries(Object.entries(ranks).filter(([, r]) => r && typeof r === 'object').slice(0, 800)),
    translations: v.translations && typeof v.translations === 'object' ? v.translations : {},
    sync: {
      phase: clean(sync.phase).slice(0, 40),
      message: clean(sync.message).slice(0, 200),
      lastAttemptAt: str(sync.lastAttemptAt),
      lastSuccessAt: str(sync.lastSuccessAt),
      lastError: clean(sync.lastError).slice(0, 300),
      lastResult: sync.lastResult && typeof sync.lastResult === 'object' ? sync.lastResult : null,
    },
    preferences: {
      autoSync: prefs.autoSync !== false,
      syncHour: Number.isFinite(Number(prefs.syncHour)) ? Math.max(0, Math.min(23, Math.round(Number(prefs.syncHour)))) : DEFAULT_PREFERENCES.syncHour,
      backfillDays: Number(prefs.backfillDays) > 0 ? Math.max(1, Math.min(365, Math.round(Number(prefs.backfillDays)))) : DEFAULT_PREFERENCES.backfillDays,
      includeExpired: prefs.includeExpired === true,
      showRuleExtracted: prefs.showRuleExtracted !== false,
      autoRank: prefs.autoRank !== false,
      autoTranslate: prefs.autoTranslate === true,
      sort: ['deadline', 'latest', 'rank', 'confidence'].includes(prefs.sort) ? prefs.sort : DEFAULT_PREFERENCES.sort,
    },
    dismissedIds: [...new Set((Array.isArray(v.dismissedIds) ? v.dismissedIds : []).filter((x) => typeof x === 'string'))].slice(-2000),
    favoriteIds: [...new Set((Array.isArray(v.favoriteIds) ? v.favoriteIds : []).filter((x) => typeof x === 'string' && issueIds.has(x)))].slice(-2000),
    lastSyncAt: str(v.lastSyncAt),
    lastAttemptAt: str(v.lastAttemptAt),
    migratedFrom: Number(v.version) === 1 ? 1 : (Number(v.migratedFrom) || 0),
  };
}

// ---------------- 日期与倒计时 ----------------

export function deadlineMeta(issue, now = new Date()) {
  const date = str(issue?.deadline);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { date: '', days: null, label: '待核实', tone: 'muted' };
  const target = Date.parse(date + 'T00:00:00Z');
  if (!Number.isFinite(target)) return { date, days: null, label: date, tone: 'muted' };
  const base = Date.parse(today(now) + 'T00:00:00Z');
  const days = Math.round((target - base) / DAY);
  if (days < 0) return { date, days, label: '已截止', tone: 'expired' };
  if (days === 0) return { date, days, label: '今天截止', tone: 'urgent' };
  if (days <= 30) return { date, days, label: `${days} 天后截止`, tone: 'urgent' };
  if (days <= 90) return { date, days, label: `${days} 天后截止`, tone: 'soon' };
  return { date, days, label: date, tone: 'normal' };
}

// ---------------- 期刊等级 ----------------

const RANK_LABEL_ORDER = ['中科院分区', '新锐分区', 'ABS', 'UTD24', 'SSCI', 'FMS', 'CSSCI'];

/** ABS 值数值化：4* > 4 > 3 > 2 > 1。用于「按等级排序」。 */
export function absScore(value) {
  const s = clean(value);
  if (!s) return 0;
  if (/4\s*\*/.test(s)) return 5;
  const m = /([1-4])/.exec(s);
  return m ? Number(m[1]) : 0;
}

/** 把等级值归一成可用于筛选的短码：ABS→'4*','3'；SSCI→'Q1'；中科院→'1','2Top'。 */
export function rankLevelKey(label, value) {
  const v = clean(value);
  if (!v) return '';
  if (label === 'ABS') {
    if (/4\s*\*/.test(v)) return '4*';
    const m = /([1-4])/.exec(v);
    return m ? m[1] : v;
  }
  if (label === 'SSCI' || label === 'FMS' || label === 'CSSCI') {
    const q = /Q([1-4])/i.exec(v);
    return q ? 'Q' + q[1] : v.slice(0, 8);
  }
  if (label === '中科院分区' || label === '新锐分区') {
    const m = /([1-4])\s*区/.exec(v);
    if (!m) return v.slice(0, 8);
    return v.includes('Top') || v.includes('TOP') ? `${m[1]}区Top` : `${m[1]}区`;
  }
  if (label === 'UTD24') return /是|true|yes|√|Y/i.test(v) ? 'Y' : 'N';
  return v.slice(0, 8);
}

export function rankValueOf(issue, label) {
  const items = Array.isArray(issue?.rank?.items) ? issue.rank.items : [];
  return clean(items.find((i) => i?.label === label)?.value);
}

/** 一条 SI 的等级徽章序列（供卡片直接渲染）。 */
export function rankBadges(issue) {
  const items = Array.isArray(issue?.rank?.items) ? issue.rank.items : [];
  const byLabel = new Map(items.map((i) => [i.label, clean(i.value)]));
  return RANK_LABEL_ORDER.filter((l) => byLabel.get(l)).map((label) => ({
    label, value: byLabel.get(label), level: rankLevelKey(label, byLabel.get(label)),
  }));
}

// ---------------- ID ----------------

function normName(s) {
  return clean(s).toLowerCase().replace(/[\s\-–—_.,:;'"“”‘’()（）&]/g, '');
}

/**
 * 卡片稳定 id：同一本刊 + 同一个截稿日 + 同一主题 = 同一条。
 * 公众号常对同一专刊二次推送（延期、补充），用这个键合并而不是重复出卡。
 */
export function stableIssueId(issue) {
  const key = [
    normName(issue?.journal || ''),
    str(issue?.deadline || ''),
    normName(issue?.titleEn || issue?.titleZh || ''),
  ].join('|');
  return 'si:' + shortHash([key]);
}

// ---------------- 合并 ----------------

export function mergeIssues(existing = [], incoming = []) {
  const map = new Map();
  for (const old of existing) if (old?.id) map.set(old.id, { ...old });
  for (const item of incoming) {
    if (!item?.id) continue;
    const prev = map.get(item.id);
    if (!prev) { map.set(item.id, item); continue; }
    // 新数据优先，但不要把已有的等级/翻译/用户修正冲掉
    const merged = { ...prev, ...item };
    merged.createdAt = prev.createdAt || item.createdAt;
    merged.rank = item.rank || prev.rank || null;
    merged.summaryZh = item.summaryZh || prev.summaryZh;
    merged.deadline = item.deadline || prev.deadline;
    merged.guestEditors = item.guestEditors?.length ? item.guestEditors : (prev.guestEditors || []);
    merged.topicsZh = item.topicsZh?.length ? item.topicsZh : (prev.topicsZh || []);
    map.set(item.id, merged);
  }
  return [...map.values()];
}

export function mergeArticles(existing = [], incoming = []) {
  const map = new Map();
  for (const old of existing) if (old?.id) map.set(old.id, { ...old });
  for (const item of incoming) {
    if (!item?.id) continue;
    const prev = map.get(item.id);
    map.set(item.id, prev ? { ...prev, ...item, fetchedAt: prev.fetchedAt || item.fetchedAt } : item);
  }
  return [...map.values()];
}

/** 把抽取结果转成受控 issue（补 id / 时间戳 / 去重键）。 */
export function buildIssue(extracted, now = new Date()) {
  const base = {
    ...extracted,
    journal: clean(extracted.journal).slice(0, 160),
    titleZh: clean(extracted.titleZh || extracted.titleEn).slice(0, 300),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  return { ...base, id: stableIssueId(base) };
}

// ---------------- 列表 / 筛选 ----------------

export function topicCounts(issues = []) {
  const map = new Map();
  for (const i of issues) {
    for (const t of new Set(i.topicsZh || [])) map.set(t, (map.get(t) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 24)
    .map(([topic, count]) => ({ topic, count }));
}

/**
 * 卡片列表筛选。
 * @param {object} state
 * @param {object} opts
 *   query           关键词（中英标题/摘要/期刊/主题/客座编辑）
 *   topics          主题数组（任一命中）
 *   deadlineWindow  'all' | '30' | '90' | 'expired' | 'undated'
 *   rankSystem      等级体系 label（ABS / SSCI / 中科院分区 / UTD24 / FMS / CSSCI / 新锐分区）
 *   rankLevels      该体系下的等级短码数组，空表示不限
 *   favoriteOnly    只看收藏
 *   sourceId        限定来源
 *   includeExpired  是否包含已截止
 *   sort            deadline | latest | rank | confidence
 */
export function listIssues(stateInput, opts = {}) {
  const s = createSpecialIssueState(stateInput);
  const {
    query = '', topics = [], deadlineWindow = 'all', rankSystem = '', rankLevels = [],
    favoriteOnly = false, sourceId = '', sort = '', limit = 800, now = new Date(),
  } = opts;
  const q = clean(query).toLowerCase();
  const favorites = new Set(s.favoriteIds);
  const topicSet = new Set((Array.isArray(topics) ? topics : []).filter(Boolean));
  const levelSet = new Set((Array.isArray(rankLevels) ? rankLevels : []).filter(Boolean));
  // 「只看已截止」本身就是要看过期项，不能被通用过期过滤挡住
  const wantExpired = deadlineWindow === 'expired';
  const includeExpired = s.preferences.includeExpired || opts.includeExpired === true || wantExpired;

  let items = s.issues.filter((i) => {
    if (!s.preferences.showRuleExtracted && i.extractedBy === 'rule') return false;
    if (sourceId && i.sourceId !== sourceId) return false;
    if (favoriteOnly && !favorites.has(i.id)) return false;
    const dm = deadlineMeta(i, now);
    if (!includeExpired && dm.days !== null && dm.days < 0) return false;
    if (deadlineWindow === '30' && !(dm.days !== null && dm.days >= 0 && dm.days <= 30)) return false;
    if (deadlineWindow === '90' && !(dm.days !== null && dm.days >= 0 && dm.days <= 90)) return false;
    if (deadlineWindow === 'expired' && !(dm.days !== null && dm.days < 0)) return false;
    if (deadlineWindow === 'undated' && dm.days !== null) return false;
    if (topicSet.size && !(i.topicsZh || []).some((t) => topicSet.has(t))) return false;
    if (rankSystem && levelSet.size) {
      const value = rankValueOf(i, rankSystem);
      if (!value) return false;
      if (!levelSet.has(rankLevelKey(rankSystem, value))) return false;
    }
    if (q) {
      const tr = s.translations[i.id] || {};
      const hay = clean([
        i.titleZh, i.titleEn, i.summaryZh, i.journal, i.journalShort, i.publisher,
        (i.topicsZh || []).join(' '),
        (i.guestEditors || []).map((e) => `${e.name} ${e.affiliation}`).join(' '),
        i.articleTitle, i.submissionNote, tr.title, tr.summary,
      ].join(' ')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  items = items.map((i) => ({ ...i, deadline: deadlineMeta(i, now), badges: rankBadges(i) }));
  const order = sort || s.preferences.sort || 'deadline';
  items.sort((a, b) => {
    if (order === 'latest') return str(b.articlePublishedAt || b.createdAt).localeCompare(str(a.articlePublishedAt || a.createdAt));
    if (order === 'rank') {
      return absScore(rankValueOf(b, 'ABS')) - absScore(rankValueOf(a, 'ABS'))
        || (a.deadline.days ?? 99999) - (b.deadline.days ?? 99999);
    }
    if (order === 'confidence') return (b.confidence || 0) - (a.confidence || 0);
    return (a.deadline.days ?? 99999) - (b.deadline.days ?? 99999)
      || str(a.deadline.date || '9999').localeCompare(str(b.deadline.date || '9999'))
      || (b.confidence || 0) - (a.confidence || 0);
  });
  return items.slice(0, Math.max(1, Math.min(2000, limit)));
}

// ---------------- 清理 ----------------

export function purgeExpiredIssues(stateInput, opts = {}) {
  const state = createSpecialIssueState(stateInput);
  const now = opts.now || new Date();
  if (state.preferences.includeExpired) return { state, removed: [] };
  const expired = new Set(state.issues
    .filter((i) => { const dm = deadlineMeta(i, now); return dm.days !== null && dm.days < -7; })
    .map((i) => i.id));
  if (!expired.size) return { state, removed: [] };
  state.issues = state.issues.filter((i) => !expired.has(i.id));
  state.favoriteIds = state.favoriteIds.filter((id) => !expired.has(id));
  state.dismissedIds = state.dismissedIds.filter((id) => !expired.has(id));
  state.translations = Object.fromEntries(Object.entries(state.translations).filter(([id]) => !expired.has(id)));
  return { state, removed: [...expired] };
}

// ---------------- 偏好 / 收藏 ----------------

export function setPreferences(stateInput, patch) {
  const state = createSpecialIssueState(stateInput);
  const p = patch && typeof patch === 'object' ? patch : {};
  for (const key of ['autoSync', 'includeExpired', 'showRuleExtracted', 'autoRank', 'autoTranslate']) {
    if (typeof p[key] === 'boolean') state.preferences[key] = p[key];
  }
  if (p.syncHour !== undefined && Number.isFinite(Number(p.syncHour))) {
    state.preferences.syncHour = Math.max(0, Math.min(23, Math.round(Number(p.syncHour))));
  }
  if (p.backfillDays !== undefined && Number(p.backfillDays) > 0) {
    state.preferences.backfillDays = Math.max(1, Math.min(365, Math.round(Number(p.backfillDays))));
  }
  if (['deadline', 'latest', 'rank', 'confidence'].includes(p.sort)) state.preferences.sort = p.sort;
  return state;
}

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

export function removeIssue(stateInput, id) {
  const state = createSpecialIssueState(stateInput);
  const key = str(id);
  state.issues = state.issues.filter((i) => i.id !== key);
  state.favoriteIds = state.favoriteIds.filter((x) => x !== key);
  state.translations = Object.fromEntries(Object.entries(state.translations).filter(([k]) => k !== key));
  if (!state.dismissedIds.includes(key)) state.dismissedIds.push(key);
  state.dismissedIds = state.dismissedIds.slice(-2000);
  return state;
}

// ---------------- 统计 ----------------

export function specialIssueSummary(stateInput, opts = {}) {
  const s = createSpecialIssueState(stateInput);
  const now = opts.now || new Date();
  let active = 0;
  let urgent = 0;
  let undated = 0;
  for (const i of s.issues) {
    const dm = deadlineMeta(i, now);
    if (dm.days === null) { undated += 1; continue; }
    if (dm.days >= 0) {
      active += 1;
      if (dm.days <= 30) urgent += 1;
    }
  }
  const pendingArticles = s.articles.filter((a) => a.status === 'pending').length;
  const failedArticles = s.articles.filter((a) => a.status === 'failed').length;
  return {
    total: s.issues.length,
    active,
    urgent,
    undated,
    expired: s.issues.length - active - undated,
    articles: s.articles.length,
    pendingArticles,
    failedArticles,
    sources: s.sources.length,
    enabledSources: s.sources.filter((x) => x.enabled).length,
    ranked: s.issues.filter((i) => i.rank?.items?.length).length,
    favorites: s.favoriteIds.length,
    lastSyncAt: s.lastSyncAt,
    lastAttemptAt: s.lastAttemptAt,
  };
}

// ---------------- 供前端使用的元数据 ----------------

export const RANK_FILTERS = [
  { label: 'ABS', levels: ['4*', '4', '3', '2', '1'] },
  { label: 'SSCI', levels: ['Q1', 'Q2', 'Q3', 'Q4'] },
  { label: '中科院分区', levels: ['1区Top', '1区', '2区', '3区', '4区'] },
  { label: '新锐分区', levels: ['1区Top', '1区', '2区', '3区', '4区'] },
  { label: 'UTD24', levels: ['Y'] },
  { label: 'FMS', levels: ['A', 'B', 'C', 'D'] },
  { label: 'CSSCI', levels: ['Q1', 'Q2', 'Q3', 'Q4'] },
];

export { SOURCE_TYPES, normalizeSource, canonicalArticleUrl, articleIdOf, normalizeExtractedIssues };
