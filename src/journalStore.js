// journalStore.js —— 期刊收藏的数据层（独立于文献中心与顶刊追踪）
//
// 为什么要单独一个模块：期刊收藏是「我关注哪些刊」的个人清单，字段与文献记录、
// 顶刊订阅都不同；独立成文件后可单独单测，也不会牵动文献中心的既有行为。
//
// 数据文件：data/journal-favorites.json（随数据备份 / 迁移 / 导出一起走）
//
// 一条记录里能放三类信息，来源各不相同，页面上要能分得清：
//   1) 等级   rank      —— easyScholar 查回来（有第三方出处，可刷新、会过期）
//   2) 评价   review    —— 我自己的评分与看法（主观，只有我写才有）
//   3) 周期   cycle/submissions —— 我自己的投稿经历（客观计时）+ 手填参考值
//
// 「审稿周期」不由我们凭空给数：没投过就是没有，只显示手填的参考值并标明来源。
// 这一点在 UI 上也如实展示，避免把论坛传闻当成事实。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as store from './store.js';

const FILE = 'journal-favorites.json';

/** 投稿结果的可选值（前端下拉与后端校验共用） */
export const RESULTS = ['pending', 'rejected', 'major', 'minor', 'accepted'];
export const RESULT_LABELS = {
  pending: '在审',
  rejected: '拒稿',
  major: '大修',
  minor: '小修',
  accepted: '接收',
};

/** 评价维度：三档够了，再多用户不会填 */
export const REVIEW_DIMENSIONS = [
  { key: 'rigor', label: '审稿严格', hint: '意见有多细、要求补的实验/分析多不多' },
  { key: 'speed', label: '处理速度', hint: '从投稿到出意见快不快' },
  { key: 'editor', label: '编辑友好', hint: '编辑是否讲得清、沟通是否顺畅' },
];

/** 前端可直接改的字段白名单（防止一条脏 PATCH 把记录结构写坏） */
export const PATCH_FIELDS = new Set([
  'name', 'nameCn', 'abbr', 'issn', 'publisher', 'field', 'website', 'submitUrl',
  'tags', 'note', 'review', 'cycle',
]);

function filePath() {
  return path.join(store.getDataDir(), FILE);
}

function load() {
  try {
    const p = filePath();
    if (!fs.existsSync(p)) return { version: 1, items: [] };
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const items = Array.isArray(raw) ? raw : raw?.items;
    return { version: 1, items: Array.isArray(items) ? items.filter(Boolean) : [] };
  } catch (e) {
    // 文件坏了不能让整个模块挂掉：退回空表，原文件留给人去看
    console.error('[journalStore] 读取失败：', e.message);
    return { version: 1, items: [] };
  }
}

function save(state) {
  const dir = path.dirname(filePath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, items: state.items }, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath());
}

export function newId() {
  return 'jrn_' + crypto.randomBytes(6).toString('hex');
}

function newSubmissionId() {
  return 'sub_' + crypto.randomBytes(5).toString('hex');
}

/** 去重键：大小写、全角半角、`&`/and、标点和多余空格都不该让同一本刊变成两条 */
export function normalizeKey(name) {
  return String(name || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** 只保留 YYYY-MM-DD；非法值返回空串（宁可留空，也不要写进一个猜的日期） */
export function normDate(value) {
  const s = String(value || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return '';
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return Number.isFinite(t) ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

function daysBetween(a, b) {
  const from = Date.parse(`${a}T00:00:00Z`);
  const to = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const d = Math.round((to - from) / 86400000);
  return d >= 0 ? d : null;
}

/**
 * 从投稿经历算审稿周期。
 *
 * 刻意分成「首轮意见」与「到接收」两个口径：用户关心的往往是「多久能看到第一个结果」，
 * 而不是整轮修完的总时长。中位数一起给，是因为投三五次的时候均值很容易被一次特慢的拉歪。
 */
export function computeStats(submissions) {
  const list = (Array.isArray(submissions) ? submissions : []).filter(Boolean);
  const firstDays = [];
  const acceptDays = [];
  let accepted = 0;
  let rejected = 0;
  let pending = 0;
  let rounds = 0;

  for (const s of list) {
    const submitted = normDate(s.submittedAt);
    const first = normDate(s.firstDecisionAt);
    const acceptedAt = normDate(s.acceptedAt);
    if (submitted && first) {
      const d = daysBetween(submitted, first);
      if (d != null) firstDays.push(d);
    }
    if (submitted && acceptedAt) {
      const d = daysBetween(submitted, acceptedAt);
      if (d != null) acceptDays.push(d);
    }
    if (s.result === 'accepted') accepted += 1;
    else if (s.result === 'rejected') rejected += 1;
    else pending += 1;
    rounds += Math.max(0, Number(s.rounds) || 0);
  }

  const mean = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);
  const median = (arr) => {
    if (!arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  };
  const decided = accepted + rejected;

  return {
    trials: list.length,
    accepted,
    rejected,
    pending,
    decided,
    rounds,
    // 有首轮意见的样本数：低于 1 时页面就只说「还没记录过」，不给任何数字
    firstSamples: firstDays.length,
    avgFirstDays: mean(firstDays),
    medianFirstDays: median(firstDays),
    fastestFirstDays: firstDays.length ? Math.min(...firstDays) : null,
    slowestFirstDays: firstDays.length ? Math.max(...firstDays) : null,
    avgAcceptDays: mean(acceptDays),
    acceptRate: decided ? Math.round((accepted / decided) * 100) : null,
  };
}

/** 展示用的周期：优先用自己投稿的实测中位数，其次手填参考值 */
export function cycleOf(journal, stats = computeStats(journal?.submissions)) {
  if (stats?.medianFirstDays != null) {
    return { days: stats.medianFirstDays, source: 'mine', label: '我的投稿实测（中位数）' };
  }
  const ref = Number(journal?.cycle?.refDays);
  if (Number.isFinite(ref) && ref > 0) {
    return {
      days: Math.round(ref),
      source: 'manual',
      label: journal?.cycle?.refSource ? `参考：${journal.cycle.refSource}` : '参考值（我填的）',
    };
  }
  return { days: null, source: '', label: '' };
}

/**
 * 等级档位打分：只用来「按等级排个序」，不是评价体系。
 * 拿不到任何等级时返回 null —— 排序时排到最后，而不是当成 0 分区。
 */
export function tierScore(items) {
  const list = Array.isArray(items) ? items : [];
  const get = (label) => String(list.find((i) => i.label === label)?.value || '').trim();
  let best = null;
  const bump = (v) => { if (v != null) best = best == null ? v : Math.max(best, v); };

  if (get('UTD24')) bump(100);
  const abs = get('ABS');
  if (abs) bump({ '4*': 96, '4': 88, '3': 74, '2': 58, '1': 42 }[abs] ?? null);
  if (get('FT50')) bump(92);
  const ccf = get('CCF');
  if (ccf) bump({ A: 90, B: 76, C: 60 }[ccf.toUpperCase()] ?? null);
  const sci = get('中科院分区');
  if (sci) {
    const m = /([1-4])\s*区/.exec(sci);
    const top = /top/i.test(sci);
    if (m) bump({ 1: 86, 2: 74, 3: 62, 4: 50 }[Number(m[1])] ?? null);
    else if (/^1/.test(sci)) bump(86);
    if (top && m && Number(m[1]) === 1) bump(94);
  }
  const xr = get('新锐分区');
  if (xr) {
    const m = /([1-4])\s*区/.exec(xr);
    if (m) bump({ 1: 80, 2: 70, 3: 60, 4: 50 }[Number(m[1])] ?? null);
  }
  if (get('SSCI') || get('FMS')) bump(70);
  if (get('CSSCI') || get('北大核心')) bump(56);
  return best;
}

export function decorate(journal) {
  const stats = computeStats(journal?.submissions);
  return {
    ...journal,
    key: normalizeKey(journal?.name),
    stats,
    // 注意：cycle 是**用户存的原始值**（refDays / refSource / refNote），必须原样带出去，
    // 抽屉里的输入框要靠它回显。派生出来的「到底用哪个天数」另起一个字段，
    // 早先把 cycle 直接覆盖成派生对象，导致保存参考周期后一刷新就变回空。
    cycleInfo: cycleOf(journal, stats),
    tierScore: tierScore(journal?.rank?.items),
  };
}

export function listJournals() {
  return load().items.map(decorate);
}

export function getJournal(id) {
  const found = load().items.find((j) => j.id === id);
  return found ? decorate(found) : null;
}

export function findByName(name) {
  const key = normalizeKey(name);
  if (!key) return null;
  const found = load().items.find((j) => normalizeKey(j.name) === key);
  return found ? decorate(found) : null;
}

function sanitizeReview(raw, prev = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const clamp = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 5 ? Math.round(n * 10) / 10 : 0;
  };
  const dims = {};
  const src = r.dimensions && typeof r.dimensions === 'object' ? r.dimensions : {};
  for (const d of REVIEW_DIMENSIONS) dims[d.key] = clamp(src[d.key]);
  return {
    ...prev,
    rating: clamp(r.rating),
    dimensions: dims,
    pros: String(r.pros ?? prev.pros ?? '').slice(0, 2000),
    cons: String(r.cons ?? prev.cons ?? '').slice(0, 2000),
    note: String(r.note ?? prev.note ?? '').slice(0, 4000),
    updatedAt: new Date().toISOString(),
  };
}

function sanitizeCycle(raw, prev = {}) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const n = Number(c.refDays);
  return {
    ...prev,
    refDays: Number.isFinite(n) && n > 0 ? Math.min(999, Math.round(n)) : 0,
    refSource: String(c.refSource ?? prev.refSource ?? '').slice(0, 120),
    refNote: String(c.refNote ?? prev.refNote ?? '').slice(0, 1000),
  };
}

/** 新建一条收藏；同名（规范化后）已存在时直接返回已有记录，不重复建 */
export function createJournal(input = {}) {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('期刊名不能为空');
  const state = load();
  const key = normalizeKey(name);
  const dup = state.items.find((j) => normalizeKey(j.name) === key);
  if (dup) return { journal: decorate(dup), created: false };

  const now = new Date().toISOString();
  const record = {
    id: newId(),
    name: name.slice(0, 200),
    nameCn: String(input.nameCn || '').slice(0, 120),
    abbr: String(input.abbr || '').slice(0, 60),
    issn: String(input.issn || '').slice(0, 40),
    publisher: String(input.publisher || '').slice(0, 120),
    field: String(input.field || '').slice(0, 60),
    website: String(input.website || '').slice(0, 500),
    submitUrl: String(input.submitUrl || '').slice(0, 500),
    tags: (Array.isArray(input.tags) ? input.tags : []).map((t) => String(t).trim()).filter(Boolean).slice(0, 12),
    note: String(input.note || '').slice(0, 4000),
    rank: { summary: '', items: [], at: '', error: '' },
    review: sanitizeReview(input.review || {}),
    cycle: sanitizeCycle(input.cycle || {}),
    submissions: [],
    ai: { text: '', at: '', model: '' },
    createdAt: now,
    updatedAt: now,
  };
  state.items.unshift(record);
  save(state);
  return { journal: decorate(record), created: true };
}

/** 按 id 改；也接受 { id } 或 { name } 指定目标。返回更新后的记录 */
export function patchJournal(id, patch = {}) {
  const state = load();
  const idx = state.items.findIndex((j) => j.id === id);
  if (idx < 0) return null;
  const cur = state.items[idx];
  const next = { ...cur };

  for (const [k, v] of Object.entries(patch)) {
    if (!PATCH_FIELDS.has(k)) continue;
    if (k === 'review') next.review = sanitizeReview(v, cur.review);
    else if (k === 'cycle') next.cycle = sanitizeCycle(v, cur.cycle);
    else if (k === 'tags') next.tags = (Array.isArray(v) ? v : []).map((t) => String(t).trim()).filter(Boolean).slice(0, 12);
    else if (typeof v === 'string') next[k] = v.slice(0, k === 'note' ? 4000 : 500);
    else next[k] = v;
  }

  // 改名后可能和另一条重名：直接拒绝，避免库里出现两条同一本刊
  if (patch.name != null) {
    const name = String(patch.name).trim();
    if (!name) throw new Error('期刊名不能为空');
    const key = normalizeKey(name);
    if (state.items.some((j, i) => i !== idx && normalizeKey(j.name) === key)) {
      throw new Error('这个期刊已经在收藏里了');
    }
    next.name = name.slice(0, 200);
  }

  next.updatedAt = new Date().toISOString();
  state.items[idx] = next;
  save(state);
  return decorate(next);
}

/** 写入等级查询结果（成功或失败都记，失败原因也留给人看） */
export function setRank(id, { summary = '', items = [], error = '' } = {}) {
  const state = load();
  const idx = state.items.findIndex((j) => j.id === id);
  if (idx < 0) return null;
  const cur = state.items[idx];
  const rank = error
    ? { ...(cur.rank || {}), error, at: new Date().toISOString() }
    : { summary: String(summary || ''), items: Array.isArray(items) ? items : [], at: new Date().toISOString(), error: '' };
  state.items[idx] = { ...cur, rank, updatedAt: new Date().toISOString() };
  save(state);
  return decorate(state.items[idx]);
}

export function setAiReview(id, { text = '', model = '' } = {}) {
  const state = load();
  const idx = state.items.findIndex((j) => j.id === id);
  if (idx < 0) return null;
  const cur = state.items[idx];
  state.items[idx] = {
    ...cur,
    ai: { text: String(text || '').slice(0, 20000), model: String(model || ''), at: new Date().toISOString() },
    updatedAt: new Date().toISOString(),
  };
  save(state);
  return decorate(state.items[idx]);
}

export function removeJournal(id) {
  const state = load();
  const next = state.items.filter((j) => j.id !== id);
  if (next.length === state.items.length) return false;
  state.items = next;
  save(state);
  return true;
}

/**
 * 加一条投稿经历。
 * 只校验「首轮意见 / 接收日期不能早于投稿日期」这一条硬规则——填错了周期就是错的，
 * 与其算出一个负数，不如当场说清楚。
 */
export function addSubmission(id, input = {}) {
  const state = load();
  const idx = state.items.findIndex((j) => j.id === id);
  if (idx < 0) return null;
  const submittedAt = normDate(input.submittedAt);
  if (!submittedAt) throw new Error('投稿日期必填（格式 YYYY-MM-DD）');
  const firstDecisionAt = normDate(input.firstDecisionAt);
  const acceptedAt = normDate(input.acceptedAt);
  if (firstDecisionAt && daysBetween(submittedAt, firstDecisionAt) == null) {
    throw new Error('首轮意见日期不能早于投稿日期');
  }
  if (acceptedAt && daysBetween(submittedAt, acceptedAt) == null) {
    throw new Error('接收日期不能早于投稿日期');
  }
  const result = RESULTS.includes(input.result) ? input.result : 'pending';
  const sub = {
    id: newSubmissionId(),
    submittedAt,
    firstDecisionAt,
    acceptedAt,
    result,
    rounds: Math.max(0, Math.min(20, Number(input.rounds) || 0)),
    note: String(input.note || '').slice(0, 1000),
    createdAt: new Date().toISOString(),
  };
  const cur = state.items[idx];
  const submissions = [sub, ...(Array.isArray(cur.submissions) ? cur.submissions : [])]
    .sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
  state.items[idx] = { ...cur, submissions, updatedAt: new Date().toISOString() };
  save(state);
  return decorate(state.items[idx]);
}

export function removeSubmission(id, submissionId) {
  const state = load();
  const idx = state.items.findIndex((j) => j.id === id);
  if (idx < 0) return null;
  const cur = state.items[idx];
  const next = (Array.isArray(cur.submissions) ? cur.submissions : []).filter((s) => s.id !== submissionId);
  if (next.length === (cur.submissions || []).length) return null;
  state.items[idx] = { ...cur, submissions: next, updatedAt: new Date().toISOString() };
  save(state);
  return decorate(state.items[idx]);
}

/**
 * 批量删除收藏：重复 id 只算一次，一次写盘；已不存在的记到 missing 而不是报错。
 * 只删期刊收藏本身，不动文献中心里的任何记录。
 */
export function removeJournals(ids) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
  if (!wanted.length) return { requested: 0, deleted: 0, missing: 0, ids: [] };
  const state = load();
  const existing = new Set(state.items.map((j) => j.id));
  const doomed = wanted.filter((id) => existing.has(id));
  if (!doomed.length) return { requested: wanted.length, deleted: 0, missing: wanted.length, ids: [] };
  const kill = new Set(doomed);
  state.items = state.items.filter((j) => !kill.has(j.id));
  save(state);
  return { requested: wanted.length, deleted: doomed.length, missing: wanted.length - doomed.length, ids: doomed };
}
