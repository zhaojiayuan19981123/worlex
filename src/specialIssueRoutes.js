// specialIssueRoutes.js —— SI 征稿模块的 HTTP 路由（独立模块，依赖注入）
//
// 复用项目里现成的四套能力，不另起炉灶：
//   easyScholar   → src/easyscholar.js  期刊等级（ABS / UTD24 / 中科院…）
//   translate     → src/translate.js   划词/全文翻译的同一套引擎
//   知识图谱      → createApp 注入的 getGraph()（kbGraphCache）
//   AI 结构化抽取 → 注入 fetchModelCompletion / readLLMResponse（与 /api/top-journals/analyze 同款）
// 抓取出口由 createApp 注入 fetchImpl（server.js 的 modelFetch，自动直连/代理切换）。

import { createHash } from 'node:crypto';
import { queryPublicationRank, formatRank } from './easyscholar.js';
import { translate } from './translate.js';
import { createSpecialIssueScheduler } from './specialIssueScheduler.js';
import {
  ABS_JOURNALS, ABS_CATEGORIES, CFP_SOURCES, SI_PRESETS, journalById,
  createSpecialIssueState, syncSpecialIssues, listIssues, mergeIssues,
  profileFromGraph, recommendIssues, computeHotTopics, topicSnapshot,
  specialIssueSummary, setSubscriptions, setPreferences, dismissRecommendation,
  normalizeAiIssue, toggleFavorite, addCustomIssue, purgeExpiredIssues,
  parsePastedContent, importPastedIssues, normalizeDeadline, deadlineMeta,
} from './specialIssues.js';

const DAY = 24 * 60 * 60 * 1000;
const str = (v) => String(v == null ? '' : v);

function compact(text, max = 260) {
  const s = str(text).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export function registerSpecialIssueRoutes(app, deps = {}) {
  const {
    store,
    getGraph = () => null,
    fetchImpl = globalThis.fetch,
    resolveRequestModel = () => ({ error: '未配置 AI 模型' }),
    fetchModelCompletion = null,
    readLLMResponse = null,
    translateImpl = translate,
    queryRankImpl = queryPublicationRank,
    logger = () => {},
  } = deps;

  // 读取即清理：任何一次访问都会把已截止的 SI 从磁盘移除，不必等下一次抓取。
  const readState = () => {
    const s = createSpecialIssueState(store.getSpecialIssues());
    const purged = purgeExpiredIssues(s);
    if (purged.removed.length) {
      try { store.saveSpecialIssues(purged.state); } catch { /* 下次访问再清 */ }
      return purged.state;
    }
    return s;
  };
  const writeState = (s) => store.saveSpecialIssues(createSpecialIssueState(s));
  let syncPromise = null;
  const translating = new Map();
  const fingerprint = (issue) => createHash('sha256').update(JSON.stringify([issue.title, issue.description || ''])).digest('hex');
  const scopedIssues = (state) => state.preferences.scope === 'all' ? state.issues
    : state.issues.filter((i) => !i.journalId || state.selectedJournalIds.includes(i.journalId));
  const scopeKey = (state) => state.preferences.scope === 'all' ? 'all' : [...state.selectedJournalIds].sort().join(',');

  // ---------- AI 辅助结构化抽取（可选，默认关闭） ----------
  // 正则抓不全的出版社页面，交给已配置的模型再抽一次 JSON；失败只记录、不影响整次抓取。
  async function aiExtract(text, ctx) {
    if (typeof fetchModelCompletion !== 'function' || typeof readLLMResponse !== 'function') return null;
    const am = resolveRequestModel('');
    if (am?.error || !am?.profile) return null;
    const request = await fetchModelCompletion(am.profile, {
      model: am.profile.model,
      messages: [
        { role: 'system', content: '你是学术征稿信息抽取器。从用户给出的期刊征稿页文本中找出所有 Special Issue / Call for Papers 条目。只输出 JSON 数组，不要 Markdown 围栏、不要解释。每项字段：title（专刊标题）, description（主题简介，一两句）, deadline（YYYY-MM-DD 或空字符串）, url（该专征稿详情页绝对链接，没有就留空）。没有条目就输出 []。' },
        { role: 'user', content: `期刊：${ctx?.journal?.title || '未知'}\n来源：${ctx?.sourceUrl || ''}\n页面文本：\n${str(text).slice(0, 14000)}` },
      ],
      temperature: 0.1,
      max_tokens: 2000,
    }, { stream: false, timeoutMs: ctx?.timeoutMs || 30000 });
    try {
      if (!request.up || !request.up.ok) throw new Error('模型未返回有效结果');
      const full = (await readLLMResponse(request.up)).full || '';
      const s = full.trim().replace(/^```[a-z]*\s*/i, '').replace(/```$/i, '');
      const a = s.indexOf('['), b = s.lastIndexOf(']');
      if (a < 0 || b <= a) return [];
      const data = JSON.parse(s.slice(a, b + 1));
      return (Array.isArray(data) ? data : []).slice(0, 60);
    } finally {
      try { request.cancel?.(); } catch { /* ignore */ }
    }
  }

  // ---------- 抓取（手动 / 定时共用） ----------
  function runSync(reason, opts = {}) {
    if (syncPromise) return syncPromise;
    syncPromise = performSync(reason, opts).finally(() => { syncPromise = null; });
    return syncPromise;
  }

  async function performSync(reason, opts = {}) {
    const state = readState();
    const useAi = opts.aiExtract === true || (opts.aiExtract == null && state.preferences.aiExtract);
    const result = await syncSpecialIssues(state, {
      fetchImpl,
      journalIds: opts.journalIds || null,
      aiExtract: useAi ? async (text, ctx) => {
        try { return await aiExtract(text, ctx); } catch (e) { logger('[SI] AI 抽取跳过：' + (e?.message || e)); return null; }
      } : null,
      now: new Date(),
    });
    // Network awaits must never restore an old copy of subscriptions or favorites.
    const latest = readState();
    const originalIds = new Set(state.issues.map((i) => i.id));
    const currentIds = new Set(latest.issues.map((i) => i.id));
    const incoming = (result.fetched || []).filter((i) => !originalIds.has(i.id) || currentIds.has(i.id))
      .map((i) => {
        const current = latest.issues.find((x) => x.id === i.id);
        return current?.deadlineVerifiedAt ? { ...i, deadline: current.deadline, deadlineVerifiedAt: current.deadlineVerifiedAt } : i;
      });
    const next = purgeExpiredIssues({ ...latest,
      issues: mergeIssues(latest.issues, incoming),
      sync: { ...latest.sync, ...result.state.sync },
      lastAttemptAt: result.state.lastAttemptAt,
      lastSyncAt: result.synced.length ? result.state.lastSyncAt : latest.lastSyncAt,
    }).state;
    const snap = topicSnapshot(scopedIssues(next));
    next.topicHistory = { ...(next.topicHistory || {}), [snap.at]: { counts: snap.counts, scope: scopeKey(next) } };
    writeState(next);
    const ok = result.synced.length > 0;
    const incomingIds = new Set(incoming.map((i) => i.id));
    return { ok, reason, added: next.issues.filter((i) => incomingIds.has(i.id) && !originalIds.has(i.id)).length,
      total: incoming.length, synced: result.synced, failed: result.failed,
      error: ok ? '' : result.failed.length ? '所有征稿源均未获取到有效 SI，请查看抓取诊断' : '请先订阅期刊或添加官方征稿页',
    };
  }

  const scheduler = createSpecialIssueScheduler({
    getState: readState,
    saveState: writeState,
    runNow: (reason) => runSync(reason),
    snapshot: (issues, t) => topicSnapshot(issues, t),
    purgeIssues: (s) => purgeExpiredIssues(s),
    logger,
  });

  // ---------- 组装前端所需的完整 payload ----------
  function payload(options = {}) {
    const state = readState();
    const now = new Date();
    const graph = getGraph();
    const profile = profileFromGraph(graph);
    const useProfile = state.preferences.recommendEnabled ? profile : { terms: [], empty: true };
    const scopeIds = state.preferences.scope === 'all' ? null : state.selectedJournalIds;
    const issues = listIssues(state, {
      now, profile: useProfile, sort: options.sort || 'deadline',
      query: options.query || '', topic: options.topic || '',
      journalIds: scopeIds, recommendOnly: options.recommendOnly === true,
      favoriteOnly: options.favoriteOnly === true,
      limit: 400,
    });
    const hotIssues = scopedIssues(state);
    const hotTopics = computeHotTopics(hotIssues, { history: state.topicHistory, scopeKey: scopeKey(state), now, limit: 12 });
    const recommendations = state.preferences.recommendEnabled && !profile.empty
      ? recommendIssues(hotIssues, profile, { now, limit: 6, dismissedIds: state.dismissedIds })
        .map((x) => ({ ...x.issue, relevance: x.relevance, deadline: x.deadline }))
      : [];
    return {
      catalog: ABS_JOURNALS,
      categories: ABS_CATEGORIES,
      presets: SI_PRESETS,
      sources: CFP_SOURCES,
      selectedJournalIds: state.selectedJournalIds,
      favoriteIds: state.favoriteIds,
      cfpOverrides: state.cfpOverrides,
      customSources: state.customSources,
      ranks: state.ranks,
      translations: Object.fromEntries(state.issues.filter((i) => state.translations[i.id]?.contentHash === fingerprint(i))
        .map((i) => [i.id, state.translations[i.id]])),
      sync: state.sync,
      preferences: state.preferences,
      issues,
      pendingIssues: hotIssues.filter((i) => deadlineMeta(i, now).days === null).slice(0, 400),
      hotTopics,
      recommendations,
      summary: specialIssueSummary(state, { now }),
      profile: {
        empty: profile.empty,
        topics: profile.topics.slice(0, 12).map((t) => t.term),
        keywords: profile.keywords.slice(0, 12).map((t) => t.term),
        entities: profile.entities.slice(0, 12).map((t) => t.term),
      },
      scheduler: { ...scheduler.status(), running: !!syncPromise || scheduler.status().running },
    };
  }

  // ---------- 路由 ----------
  app.get('/api/special-issues', (req, res) => {
    res.json(payload({
      sort: str(req.query?.sort), query: str(req.query?.query),
      topic: str(req.query?.topic), recommendOnly: req.query?.recommendOnly === '1',
      favoriteOnly: req.query?.favoriteOnly === '1',
    }));
  });

  // ---------- 收藏 / 自行添加 / 删除 / 到期清理 ----------
  app.post('/api/special-issues/custom', (req, res) => {
    const { state, issue, error } = addCustomIssue(readState(), req.body || {});
    if (error) return res.status(400).json({ error });
    writeState(state);
    res.json({ ...payload(), issue });
  });

  // ---------- 浏览器辅助导入：解析粘贴的网页内容（不出网），再批量确认导入 ----------
  app.post('/api/special-issues/parse-paste', async (req, res) => {
    const body = req.body || {};
    const text = str(body.text).slice(0, 400000);
    if (!text.trim()) return res.status(400).json({ error: '请先从浏览器复制征稿页面内容并粘贴进来' });
    const journalId = ABS_JOURNALS.some((j) => j.id === str(body.journalId)) ? str(body.journalId) : '';
    const journal = journalId ? journalById(journalId) : null;
    const baseUrl = /^https?:\/\//i.test(str(body.url).trim()) ? str(body.url).trim() : '';
    const now = new Date();
    let items = parsePastedContent(text, { baseUrl, journal, now });
    // 纯文本 / 非常规页面正则抓不全时，用已配置的模型补一次结构化（可选，失败不影响结果）
    if (body.aiExtract === true && typeof fetchModelCompletion === 'function') {
      try {
        const extra = await aiExtract(text, { journal, sourceUrl: baseUrl, now });
        if (Array.isArray(extra) && extra.length) {
          items = mergeIssues(items, extra.map((x) => {
            const n = normalizeAiIssue(x, { journal, now, sourceUrl: baseUrl });
            return n ? { ...n, source: 'pasted' } : null;
          }).filter(Boolean));
        }
      } catch (e) { logger('[SI] 粘贴解析 AI 增强跳过：' + (e?.message || e)); }
    }
    res.json({ items, count: items.length });
  });

  app.post('/api/special-issues/import', (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 100) : [];
    if (!items.length) return res.status(400).json({ error: '请先勾选要导入的征稿条目' });
    const { state, added, skipped } = importPastedIssues(readState(), items, { now: new Date() });
    writeState(state);
    res.json({ ...payload(), added, skipped });
  });

  app.put('/api/special-issues/:id/deadline', (req, res) => {
    const state = readState();
    const issue = state.issues.find((i) => i.id === req.params.id);
    if (!issue) return res.status(404).json({ error: '该征稿不存在或已到期' });
    const dl = normalizeDeadline(str(req.body?.deadline));
    if (!dl.date || deadlineMeta({ deadline: dl.date }).days < 0) return res.status(400).json({ error: '请填写有效且未过期的截止日期' });
    Object.assign(issue, { deadline: dl.date, deadlineText: dl.text, deadlineVerifiedAt: new Date().toISOString() });
    writeState(state);
    res.json(payload());
  });

  app.post('/api/special-issues/purge', (_req, res) => {
    const { state, removed } = purgeExpiredIssues(readState());
    if (removed.length) writeState(state);
    res.json({ ...payload(), removed });
  });

  app.post('/api/special-issues/:id/favorite', (req, res) => {
    const id = req.params.id;
    const state = readState();
    if (!state.issues.some((i) => i.id === id)) return res.status(404).json({ error: '该征稿信息不存在或已到期清除' });
    const favorite = typeof req.body?.favorite === 'boolean' ? req.body.favorite : null;
    writeState(toggleFavorite(state, id, favorite));
    res.json(payload());
  });

  app.delete('/api/special-issues/:id', (req, res) => {
    const state = readState();
    const id = req.params.id;
    if (!state.issues.some((i) => i.id === id)) return res.status(404).json({ error: '该征稿信息不存在或已到期清除' });
    state.issues = state.issues.filter((i) => i.id !== id);
    state.favoriteIds = state.favoriteIds.filter((x) => x !== id);
    state.dismissedIds = state.dismissedIds.filter((x) => x !== id);
    state.translations = Object.fromEntries(Object.entries(state.translations).filter(([k]) => k !== id));
    writeState(state);
    res.json(payload());
  });

  app.get('/api/special-issues/status', (_req, res) => res.json({ ...scheduler.status(), running: !!syncPromise || scheduler.status().running }));

  app.get('/api/special-issues/hot-topics', (req, res) => {
    const state = readState();
    const issues = scopedIssues(state);
    res.json({ topics: computeHotTopics(issues, { history: state.topicHistory, scopeKey: scopeKey(state), now: new Date(), limit: Number(req.query?.limit) || 12 }) });
  });

  app.get('/api/special-issues/recommendations', (_req, res) => {
    const state = readState();
    const profile = profileFromGraph(getGraph());
    const items = state.preferences.recommendEnabled
      ? recommendIssues(scopedIssues(state), profile, { now: new Date(), limit: 12, dismissedIds: state.dismissedIds }) : [];
    res.json({ items: items.map((x) => ({ ...x.issue, relevance: x.relevance, deadline: x.deadline })), empty: profile.empty });
  });

  app.put('/api/special-issues/subscriptions', (req, res) => {
    const ids = Array.isArray(req.body?.selectedJournalIds) ? req.body.selectedJournalIds : [];
    writeState(setSubscriptions(readState(), ids));
    scheduler.refresh();
    res.json(payload());
  });

  app.put('/api/special-issues/preferences', (req, res) => {
    writeState(setPreferences(readState(), req.body || {}));
    scheduler.refresh();
    res.json(payload());
  });

  app.put('/api/special-issues/sources', (req, res) => {
    const state = readState();
    const overrides = req.body?.cfpOverrides && typeof req.body.cfpOverrides === 'object' ? req.body.cfpOverrides : state.cfpOverrides;
    const custom = Array.isArray(req.body?.customSources) ? req.body.customSources : state.customSources;
    writeState({ ...state, cfpOverrides: overrides, customSources: custom });
    res.json(payload());
  });

  app.post('/api/special-issues/sync', async (req, res) => {
    try {
      const result = await runSync('manual', {
        journalIds: Array.isArray(req.body?.journalIds) ? req.body.journalIds : null,
        aiExtract: typeof req.body?.aiExtract === 'boolean' ? req.body.aiExtract : undefined,
      });
      res.json({ ...payload(), ...result });
    } catch (e) {
      res.status(502).json({ error: '征稿信息抓取失败：' + (e?.message || '未知错误') });
    }
  });

  app.post('/api/special-issues/ranks/refresh', async (req, res) => {
    const settings = store.getSettings();
    if (!settings.easyScholarKey) return res.status(400).json({ error: '未配置 easyScholar SecretKey，请在「AI 设置」中填写' });
    const state = readState();
    const wanted = Array.isArray(req.body?.journalIds) && req.body.journalIds.length
      ? req.body.journalIds
      : [...new Set([...state.selectedJournalIds, ...state.issues.map((i) => i.journalId).filter(Boolean)])];
    const targets = wanted.map((id) => journalById(id)).filter(Boolean)
      .filter((j) => !state.ranks[j.id] || Date.now() - Date.parse(state.ranks[j.id].queriedAt || 0) > 7 * DAY)
      .slice(0, Number(req.body?.limit) > 0 ? Math.min(40, Number(req.body.limit)) : 20);
    const updated = {};
    const errors = [];
    for (const j of targets) {
      try {
        const data = await queryRankImpl(j.title, settings.easyScholarKey);
        if (data?.code !== 200) { errors.push({ journal: j.title, error: data?.msg || '未查询到' }); continue; }
        const f = formatRank(data.data);
        updated[j.id] = { summary: f.summary, items: f.items, queriedAt: new Date().toISOString(), journal: j.title };
      } catch (e) {
        errors.push({ journal: j.title, error: compact(e?.message || '查询失败', 120) });
      }
    }
    if (Object.keys(updated).length) {
      const latest = readState();
      writeState({ ...latest, ranks: { ...latest.ranks, ...updated } });
    }
    res.json({ ...payload(), refreshed: Object.keys(updated).length, errors });
  });

  app.post('/api/special-issues/:id/translate', async (req, res) => {
    const state = readState();
    const issue = state.issues.find((i) => i.id === req.params.id);
    if (!issue) return res.status(404).json({ error: '该征稿信息不存在或已从本地缓存清理' });
    const hash = fingerprint(issue);
    const cached = state.translations[issue.id];
    if (cached?.contentHash === hash) return res.json({ translation: cached, cached: true });
    try {
      const key = issue.id + ':' + hash;
      if (!translating.has(key)) {
        const task = (async () => {
          const settings = store.getSettings();
          const opts = { target: 'zh', fetchImpl };
          const title = await translateImpl(issue.title, settings, opts);
          const chunks = (issue.description || '').match(/[\s\S]{1,4000}/g) || [];
          const descriptions = [];
          for (const chunk of chunks) {
            const translated = await translateImpl(chunk, settings, opts);
            if (!translated?.trim()) throw new Error('翻译引擎返回了空简介，请检查翻译服务配置');
            descriptions.push(translated);
          }
          if (!title?.trim()) throw new Error('翻译引擎没有返回标题');
          const translation = { title, description: descriptions.join('\n'), contentHash: hash, translatedAt: new Date().toISOString() };
          const latest = readState();
          const current = latest.issues.find((i) => i.id === issue.id);
          if (!current) throw new Error('该征稿已删除或到期，未保存译文');
          if (fingerprint(current) !== hash) throw new Error('征稿内容已更新，请重新翻译');
          writeState({ ...latest, translations: { ...latest.translations, [issue.id]: translation } });
          return translation;
        })();
        translating.set(key, task);
      }
      let translation;
      try { translation = await translating.get(key); }
      finally { translating.delete(key); }
      res.json({ translation, cached: false });
    } catch (e) {
      res.status(400).json({ error: '翻译失败：' + (e?.message || '未知错误') });
    }
  });

  app.post('/api/special-issues/:id/dismiss', (req, res) => {
    writeState(dismissRecommendation(readState(), req.params.id));
    res.json(payload());
  });

  return { scheduler, runSync, payload };
}
