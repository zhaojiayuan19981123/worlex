// specialIssueRoutes.js —— SI 征稿（v2）HTTP 路由
//
// 职责边界：只做「读状态 → 调管线 → 写状态 → 返回 payload」，不放业务规则。
// 复用的既有能力：
//   easyScholar   → src/easyscholar.js   期刊等级
//   translate     → src/translate.js     可选译文（抽取阶段已中文化，这里只做补充）
//   AI 结构化抽取 → 注入 fetchModelCompletion / readLLMResponse / resolveRequestModel
//   出网          → 注入 fetchImpl（server.js 的 modelFetch，自动直连/代理切换）

import { createHash } from 'node:crypto';
import { queryPublicationRank, formatRank } from './easyscholar.js';
import { defaultTranslationProvider, translate } from './translate.js';
import { resolveActive } from './modelCatalog.js';
import { createSpecialIssueScheduler } from './specialIssueScheduler.js';
import {
  createSpecialIssueState, listIssues, specialIssueSummary, setPreferences,
  toggleFavorite, removeIssue, purgeExpiredIssues, deadlineMeta, topicCounts,
  RANK_FILTERS, SOURCE_TYPES, normalizeSource, articleIdOf, today,
} from './specialIssues.js';
import { collectArticles, processArticles, requeueArticles, enrichRanks, pendingRankCount, runSyncPipeline } from './siPipeline.js';
import { buildExtractMessages, parseModelJson, normalizeExtractedIssues, ruleExtractIssues } from './siExtract.js';
import { extractArticleUrls, isWechatArticleUrl } from './siSources.js';

const str = (v) => String(v == null ? '' : v);
const clean = (v) => str(v).replace(/\s+/g, ' ').trim();
const DAY = 24 * 60 * 60 * 1000;

const DEADLINE_WINDOWS = [
  { id: 'all', label: '全部' },
  { id: '30', label: '30 天内截止' },
  { id: '90', label: '90 天内截止' },
  { id: 'undated', label: '日期待核实' },
  { id: 'expired', label: '已截止' },
];

function compact(text, max = 260) {
  const s = clean(text);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function translationEngine(settings) {
  const provider = defaultTranslationProvider(settings);
  const model = provider === 'siliconflow' ? resolveActive(settings) : null;
  const identity = [provider, model?.id, model?.provider, model?.baseURL, model?.model, model?.apiFormat];
  return { provider, key: createHash('sha256').update(JSON.stringify(identity)).digest('hex') };
}

export function registerSpecialIssueRoutes(app, deps = {}) {
  const {
    store,
    fetchImpl = globalThis.fetch,
    resolveRequestModel = () => ({ error: '未配置 AI 模型' }),
    fetchModelCompletion = null,
    readLLMResponse = null,
    translateImpl = translate,
    queryRankImpl = queryPublicationRank,
    logger = () => {},
  } = deps;

  const readState = () => {
    const s = createSpecialIssueState(store.getSpecialIssues());
    if (s.preferences.includeExpired) return s;
    const purged = purgeExpiredIssues(s);
    if (purged.removed.length) {
      try { store.saveSpecialIssues(purged.state); } catch { /* 下次访问再清 */ }
      return purged.state;
    }
    return s;
  };
  const writeState = (s) => store.saveSpecialIssues(createSpecialIssueState(s));

  // ---------- 运行态（内存，不落盘） ----------
  const runtime = {
    running: false,
    phase: 'idle',
    message: '',
    startedAt: '',
    lastResult: null,
  };
  const setPhase = (phase, message) => {
    runtime.phase = phase;
    runtime.message = message || '';
  };

  // 供外部（如备份恢复）判断是否有写在跑：抓取、阶段任务期间都不应替换数据文件。
  let activeOps = 0;
  let collectPromise = null;
  const isBusy = () => runtime.running || !!syncPromise || !!collectPromise || activeOps > 0;

  // ---------- 抽取器：模型优先，失败退规则 ----------
  function buildExtractor() {
    const am = resolveRequestModel('');
    const hasModel = !am?.error && am?.profile && typeof fetchModelCompletion === 'function' && typeof readLLMResponse === 'function';
    return {
      hasModel,
      async extract(text, ctx) {
        if (!hasModel) {
          const res = ruleExtractIssues(text, ctx);
          return { issues: res.issues, notCfp: res.notCfp === true || res.issues.length === 0, rejected: res.rejected, by: 'rule' };
        }
        const messages = buildExtractMessages(text, {
          sourceName: ctx.sourceName || '公众号',
          articleTitle: ctx.articleTitle || '',
          articleDate: ctx.articlePublishedAt || '',
        });
        let request;
        try {
          request = await fetchModelCompletion(am.profile, {
            model: am.profile.model,
            messages,
            temperature: 0.1,
            max_tokens: 2600,
          }, { stream: false, timeoutMs: 60000 });
          if (!request?.up?.ok) throw new Error('模型没有返回有效响应');
          const full = (await readLLMResponse(request.up)).full || '';
          const json = parseModelJson(full);
          if (!json) {
            // 模型输出不是 JSON（常见于小模型/长文截断），退回规则抽取，至少能出卡
            logger('[SI] 模型输出无法解析为 JSON，本条改用规则抽取');
            const res = ruleExtractIssues(text, ctx);
            return { issues: res.issues, notCfp: res.issues.length === 0, rejected: res.rejected, by: 'rule' };
          }
          const normalized = normalizeExtractedIssues(json, ctx);
          return { ...normalized, by: 'ai' };
        } catch (e) {
          logger('[SI] 模型抽取失败，改用规则抽取：' + (e?.message || e));
          const res = ruleExtractIssues(text, ctx);
          return { issues: res.issues, notCfp: res.issues.length === 0, rejected: res.rejected, by: 'rule' };
        } finally {
          try { request?.cancel?.(); } catch { /* ignore */ }
        }
      },
    };
  }

  // ---------- 同步（手动 / 定时共用，单飞） ----------
  let syncPromise = null;

  /**
   * 把用户粘贴的链接放进「待处理」队列。
   * 只入库不抽取：这样即使界面被关掉、或者要分批处理很久，文章也已经记下来了。
   */
  function enqueueArticleUrls(state, urls, { sourceName = '微信粘贴' } = {}) {
    const now = new Date();
    const seen = new Set(state.articles.map((a) => a.id));
    let queued = 0;
    let existing = 0;
    for (const url of urls) {
      const id = articleIdOf(url);
      if (seen.has(id)) { existing += 1; continue; }
      seen.add(id);
      state.articles.push({
        id, url, localPath: '', title: '', publishedAt: '', digest: '',
        contentKind: 'url', sourceId: '', sourceName,
        status: 'pending', attempts: 0, lastError: '', fetchedAt: now.toISOString(),
        extractedAt: '', contentChars: 0,
      });
      queued += 1;
    }
    return { queued, existing };
  }

  function runSync(reason = 'manual', opts = {}) {
    if (syncPromise) return syncPromise;
    syncPromise = (async () => {
      runtime.running = true;
      runtime.startedAt = new Date().toISOString();
      runtime.lastResult = null;
      const state = readState();
      if (!state.sources.filter((s) => s.enabled).length) {
        runtime.running = false;
        setPhase('idle', '');
        return { ok: false, error: '还没有配置文章源。先在「文章源」里添加订阅地址或粘贴文章链接。' };
      }
      const settings = store.getSettings();
      const extractor = buildExtractor();
      setPhase('collect', '正在拉取文章列表');
      try {
        const { summary } = await runPipeline(state, {
          settings,
          extractor,
          reason,
          sourceIds: opts.sourceIds || null,
          backfillDays: opts.backfillDays || null,
        });
        runtime.lastResult = summary;
        const failedArticles = summary.failed || 0;
        return {
          ok: summary.errors.length === 0 && (summary.added > 0 || summary.processed > 0 || summary.newIssues > 0),
          summary,
          extractedBy: extractor.hasModel ? 'ai' : 'rule',
          error: summary.errors.length ? summary.errors[0].error : (failedArticles ? `${failedArticles} 篇文章处理失败，可在诊断里重试` : ''),
        };
      } finally {
        runtime.running = false;
        setPhase('idle', '');
      }
    })().finally(() => { syncPromise = null; });
    return syncPromise;
  }

  /**
   * 把管线产物写回磁盘。偏好 / 收藏 / 文章源以「最新」为准：
   * 抽取可能跑十几分钟，期间用户点收藏、改偏好都不该被整份状态覆盖掉。
   */
  function commitPipeline(nextState) {
    const latest = readState();
    const merged = {
      ...latest,
      articles: nextState.articles,
      issues: nextState.issues,
      ranks: { ...latest.ranks, ...nextState.ranks },
      sync: nextState.sync || latest.sync,
      lastAttemptAt: nextState.lastAttemptAt || latest.lastAttemptAt,
      lastSyncAt: nextState.lastSyncAt || latest.lastSyncAt,
      sources: latest.sources,
    };
    writeState(merged);
    return merged;
  }

  async function runPipeline(state, { settings, extractor, sourceIds, backfillDays }) {
    const secretKey = clean(settings.easyScholarKey);
    return runSyncPipeline(state, {
      fetchImpl,
      extract: (text, ctx) => extractor.extract(text, ctx),
      queryRank: queryRankImpl,
      formatRank,
      secretKey,
      sourceIds,
      backfillDays,
      autoRank: state.preferences.autoRank !== false,
      logger,
      onPhase: setPhase,
      extractLimit: 12,
      rounds: 6,
      rankLimit: 25,
      concurrency: 2,
    }).then(({ state: nextState, summary }) => ({ state: commitPipeline(nextState), summary }));
  }

  // ---------- 粘贴收稿（零配置主路径） ----------
  // 一条公众号文章链接就能开工：不依赖 RSS、不依赖任何外部服务。
  // 因为每篇都要过一次大模型，几十篇会跑很久，所以接口只负责入队并立即返回，
  // 前端轮询 /status 看进度（与「立即同步」共用同一套运行态）。
  const COLLECT_MAX = 60;
  const COLLECT_BATCH = 6;

  function runCollect(total) {
    if (collectPromise) return collectPromise;
    collectPromise = (async () => {
      runtime.running = true;
      runtime.startedAt = new Date().toISOString();
      runtime.lastResult = null;
      const extractor = buildExtractor();
      const summary = {
        added: total, processed: 0, extractedArticles: 0, newIssues: 0,
        skipped: 0, failed: 0, ranked: 0, errors: [],
      };
      try {
        setPhase('extract', `正在识别 ${total} 篇文章`);
        let done = 0;
        const batches = Math.ceil(total / COLLECT_BATCH);
        for (let round = 0; round < batches; round += 1) {
          const cur = readState();
          const { stats } = await processArticles(cur, {
            fetchImpl,
            extract: (text, ctx) => extractor.extract(text, ctx),
            now: new Date(),
            limit: COLLECT_BATCH,
            concurrency: 2,
            onProgress: (n) => setPhase('extract', `正在识别 ${Math.min(total, done + n)}/${total} 篇`),
          });
          // 每批都把结果并入最新状态：长任务中断也不会丢掉前面已识别的内容
          commitPipeline(cur);
          if (!stats.processed) break;
          done += stats.processed;
          summary.processed += stats.processed;
          summary.extractedArticles += stats.extracted;
          summary.newIssues += stats.issues;
          summary.skipped += stats.skipped;
          summary.failed += stats.failed;
          if (stats.errors?.length) summary.errors.push(...stats.errors);
        }

        const settings = store.getSettings();
        const secretKey = clean(settings.easyScholarKey);
        if (secretKey && readState().preferences.autoRank !== false) {
          setPhase('rank', '正在查期刊等级');
          const cur = readState();
          try {
            const r = await enrichRanks(cur, {
              queryRank: queryRankImpl, formatRank, secretKey, now: new Date(), limit: 25,
            });
            commitPipeline(cur);
            summary.ranked = r.updated || 0;
          } catch (e) {
            // 等级查不到不该影响已经识别出来的卡片
            logger('[SI] 收稿后查等级失败：' + (e?.message || e));
          }
        }

        runtime.lastResult = summary;
        return { ok: true, summary, extractedBy: extractor.hasModel ? 'ai' : 'rule' };
      } catch (e) {
        summary.errors.push({ error: clean(e?.message || e) || '处理失败' });
        runtime.lastResult = summary;
        return { ok: false, summary, error: clean(e?.message || e) || '处理失败' };
      } finally {
        runtime.running = false;
        setPhase('idle', '');
      }
    })().finally(() => { collectPromise = null; });
    return collectPromise;
  }


  const scheduler = createSpecialIssueScheduler({
    getState: readState,
    saveState: writeState,
    runNow: (reason) => runSync(reason),
    logger,
  });

  // ---------- payload ----------
  function payload(options = {}) {
    const state = readState();
    const now = new Date();
    const settings = store.getSettings();
    const issues = listIssues(state, {
      now,
      query: options.query || '',
      topics: options.topics || [],
      deadlineWindow: options.deadlineWindow || 'all',
      rankSystem: options.rankSystem || '',
      rankLevels: options.rankLevels || [],
      favoriteOnly: options.favoriteOnly === true,
      sourceId: options.sourceId || '',
      sort: options.sort || '',
      limit: 400,
    }).map((i) => ({ ...i, summaryZh: compact(i.summaryZh, 600) }));

    const summary = specialIssueSummary(state, { now });
    const recentArticles = [...state.articles]
      .sort((a, b) => str(b.publishedAt).localeCompare(str(a.publishedAt)))
      .slice(0, 40)
      .map((a) => ({
        id: a.id,
        title: a.title,
        url: a.url,
        publishedAt: a.publishedAt,
        status: a.status,
        lastError: a.lastError,
        attempts: a.attempts,
        sourceName: a.sourceName,
      }));

    return {
      issues,
      favoriteIds: state.favoriteIds,
      summary,
      sources: state.sources,
      sourceTypes: SOURCE_TYPES,
      preferences: state.preferences,
      filters: {
        deadlineWindows: DEADLINE_WINDOWS,
        rankFilters: RANK_FILTERS,
        topics: topicCounts(state.issues),
      },
      articleStats: {
        total: state.articles.length,
        pending: state.articles.filter((a) => a.status === 'pending').length,
        extracted: state.articles.filter((a) => a.status === 'extracted').length,
        skipped: state.articles.filter((a) => a.status === 'skipped').length,
        failed: state.articles.filter((a) => a.status === 'failed').length,
        recent: recentArticles,
      },
      capability: {
        hasModel: buildExtractor().hasModel,
        hasEasyScholarKey: !!clean(settings.easyScholarKey),
      },
      rankPending: pendingRankCount(state, { now }),
      runtime: { ...runtime, running: runtime.running || !!syncPromise || !!collectPromise },
      scheduler: { ...scheduler.status(), running: runtime.running || !!syncPromise || !!collectPromise },
    };
  }

  const queryOpts = (req) => ({
    query: str(req.query?.query),
    topics: str(req.query?.topics).split(',').map((t) => t.trim()).filter(Boolean),
    deadlineWindow: str(req.query?.deadlineWindow) || 'all',
    rankSystem: str(req.query?.rankSystem),
    rankLevels: str(req.query?.rankLevels).split(',').map((t) => t.trim()).filter(Boolean),
    favoriteOnly: req.query?.favoriteOnly === '1',
    sourceId: str(req.query?.sourceId),
    sort: str(req.query?.sort),
  });

  // ---------- 主查询 ----------
  app.get('/api/special-issues', (req, res) => res.json(payload(queryOpts(req))));
  app.get('/api/special-issues/status', (_req, res) => res.json({
    ...scheduler.status(),
    runtime: { ...runtime, running: runtime.running || !!syncPromise || !!collectPromise },
  }));

  // ---------- 文章源 CRUD ----------
  app.post('/api/special-issues/sources', (req, res) => {
    const source = normalizeSource(req.body || {});
    if (!source) return res.status(400).json({ error: '文章源配置不完整：请检查类型与地址/路径' });
    const state = readState();
    if (state.sources.some((s) => s.id === source.id)) {
      return res.status(409).json({ error: '这个文章源已经存在了' });
    }
    if (state.sources.length >= 20) return res.status(400).json({ error: '文章源最多 20 个' });
    state.sources = [...state.sources, source];
    writeState(state);
    scheduler.refresh();
    res.json({ ...payload(), added: source });
  });

  app.put('/api/special-issues/sources/:id', (req, res) => {
    const state = readState();
    const idx = state.sources.findIndex((s) => s.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: '文章源不存在' });
    const patch = req.body || {};
    if (typeof patch.enabled === 'boolean') state.sources[idx].enabled = patch.enabled;
    if (patch.name !== undefined) state.sources[idx].name = clean(patch.name).slice(0, 60) || state.sources[idx].name;
    if (patch.backfillDays !== undefined) {
      const n = Math.round(Number(patch.backfillDays));
      if (Number.isFinite(n)) state.sources[idx].backfillDays = Math.max(1, Math.min(365, n));
    }
    writeState(state);
    scheduler.refresh();
    res.json(payload());
  });

  app.delete('/api/special-issues/sources/:id', (req, res) => {
    const state = readState();
    const source = state.sources.find((s) => s.id === req.params.id);
    if (!source) return res.status(404).json({ error: '文章源不存在' });
    const dropArticles = req.query?.purgeArticles === '1';
    state.sources = state.sources.filter((s) => s.id !== req.params.id);
    if (dropArticles) {
      const ids = new Set(state.articles.filter((a) => a.sourceId === source.id).map((a) => a.id));
      state.articles = state.articles.filter((a) => !ids.has(a.id));
      state.issues = state.issues.filter((i) => !ids.has(i.articleId));
    }
    writeState(state);
    scheduler.refresh();
    res.json(payload());
  });

  /** 试拉一个源（不落盘），用于配置时确认地址是否有效。 */
  app.post('/api/special-issues/sources/test', async (req, res) => {
    const source = normalizeSource(req.body || {});
    if (!source) return res.status(400).json({ error: '文章源配置不完整' });
    try {
      const { results } = await collectArticles(
        { ...createSpecialIssueState({ sources: [{ ...source, id: 'probe' }], articles: [] }) },
        { fetchImpl, sourceIds: ['probe'], now: new Date() },
      );
      const r = results[0] || {};
      if (!r.ok) return res.status(400).json({ error: r.error || '测试失败' });
      res.json({ ok: true, count: r.count, added: r.added, warning: r.warning || '', sample: [] });
    } catch (e) {
      res.status(400).json({ error: clean(e?.message || e) || '测试失败' });
    }
  });

  // ---------- 同步 ----------
  // 首次回溯 3 个月会有几十篇文章、每篇一次模型调用，可能跑几分钟。
  // 因此接口只负责「启动任务」并立即返回，前端轮询 /status 看进度，避免请求超时。
  app.post('/api/special-issues/sync', (req, res) => {
    if (syncPromise || runtime.running) {
      return res.json({ started: false, running: true, ...payload(queryOpts(req)) });
    }
    const opts = {
      sourceIds: Array.isArray(req.body?.sourceIds) ? req.body.sourceIds : null,
      backfillDays: Number(req.body?.backfillDays) > 0 ? Number(req.body.backfillDays) : null,
    };
    runtime.running = true;
    runSync('manual', opts).catch((e) => {
      logger('[SI] 手动同步异常：' + (e?.message || e));
      runtime.running = false;
      runtime.phase = 'idle';
      runtime.message = '';
    });
    res.json({ started: true, running: true, ...payload(queryOpts(req)) });
  });

  /**
   * 粘贴收稿：一次给多条（微信「复制链接」的短链、分享文案、一行一个都行）。
   * 这是「不想折腾 RSS / 订阅服务」时的主路径，零配置可用。
   */
  app.post('/api/special-issues/collect', (req, res) => {
    if (syncPromise || collectPromise || runtime.running) {
      return res.status(409).json({ error: '上一批还在处理，等它跑完再贴下一批。' });
    }
    const raw = Array.isArray(req.body?.urls)
      ? req.body.urls.join('\n')
      : str(req.body?.text || req.body?.url);
    const all = extractArticleUrls(raw).filter((u) => isWechatArticleUrl(u));
    if (!all.length) {
      return res.status(400).json({ error: '没有识别到公众号文章链接。请在微信里打开文章，点右上角「…」→ 复制链接，再粘贴到这里。' });
    }
    const urls = all.slice(0, COLLECT_MAX);
    const dropped = Math.max(0, all.length - urls.length);

    // 先在请求里入队并落盘：这样「收下了没有」有确定答案，
    // 全是重复链接时也不必白跑一趟后台任务。
    const state = readState();
    const { queued, existing } = enqueueArticleUrls(state, urls);
    if (queued) writeState(state);
    if (!queued) {
      return res.json({
        started: false, running: false, queued: 0, existing, dropped,
        ...payload(queryOpts(req)),
      });
    }

    runtime.running = true;
    runCollect(queued).catch((e) => {
      logger('[SI] 收稿异常：' + (e?.message || e));
      runtime.running = false;
      setPhase('idle', '');
    });
    res.json({
      started: true, running: true, queued, existing, dropped,
      ...payload(queryOpts(req)),
    });
  });

  /** 只跑某一阶段，便于界面分开操作（例如只补等级、只重试失败）。 */
  app.post('/api/special-issues/step', async (req, res) => {
    const step = clean(req.body?.step);
    const state = readState();
    activeOps++;
    try {
      if (step === 'extract') {
        const extractor = buildExtractor();
        const ids = Array.isArray(req.body?.articleIds) ? req.body.articleIds : null;
        if (ids) requeueArticles(state, ids);
        const { stats } = await processArticles(state, {
          fetchImpl, extract: (t, c) => extractor.extract(t, c), now: new Date(),
          limit: Math.max(1, Math.min(50, Number(req.body?.limit) || 20)),
          retryFailed: req.body?.retryFailed === true,
        });
        writeState(state);
        return res.json({ ...payload(), step: 'extract', stats });
      }
      if (step === 'rank') {
        const settings = store.getSettings();
        if (!clean(settings.easyScholarKey)) return res.status(400).json({ error: '未配置 EasyScholar SecretKey，请在「AI 设置」里填写' });
        const { updated, attempted, remaining, errors } = await enrichRanks(state, {
          queryRank: queryRankImpl,
          formatRank,
          secretKey: settings.easyScholarKey,
          now: new Date(),
          limit: Math.max(1, Math.min(40, Number(req.body?.limit) || 25)),
          force: req.body?.force === true,
        });
        writeState(state);
        return res.json({ ...payload(), step: 'rank', rankResult: { updated, attempted, remaining, errors } });
      }
      if (step === 'collect') {
        const { results } = await collectArticles(state, { fetchImpl, now: new Date() });
        writeState(state);
        return res.json({ ...payload(), step: 'collect', results });
      }
      return res.status(400).json({ error: '未知的步骤：' + step });
    } catch (e) {
      res.status(502).json({ error: clean(e?.message || e) || '执行失败' });
    } finally {
      activeOps = Math.max(0, activeOps - 1);
    }
  });

  // ---------- 偏好 / 收藏 / 修正 ----------
  app.put('/api/special-issues/preferences', (req, res) => {
    writeState(setPreferences(readState(), req.body || {}));
    scheduler.refresh();
    res.json(payload());
  });

  app.post('/api/special-issues/:id/favorite', (req, res) => {
    const state = readState();
    if (!state.issues.some((i) => i.id === req.params.id)) return res.status(404).json({ error: '该征稿不存在或已被清理' });
    writeState(toggleFavorite(state, req.params.id, typeof req.body?.favorite === 'boolean' ? req.body.favorite : null));
    res.json(payload());
  });

  app.patch('/api/special-issues/:id', (req, res) => {
    const state = readState();
    const issue = state.issues.find((i) => i.id === req.params.id);
    if (!issue) return res.status(404).json({ error: '该征稿不存在或已被清理' });
    const body = req.body || {};
    if (body.journal !== undefined) issue.journal = clean(body.journal).slice(0, 160) || issue.journal;
    if (body.journalShort !== undefined) issue.journalShort = clean(body.journalShort).slice(0, 40);
    if (body.titleZh !== undefined) issue.titleZh = clean(body.titleZh).slice(0, 300) || issue.titleZh;
    if (body.deadline !== undefined) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean(body.deadline));
      if (!m) return res.status(400).json({ error: '截止日期格式应为 YYYY-MM-DD' });
      issue.deadline = m[0];
    }
    if (body.submitUrl !== undefined) issue.submitUrl = /^https?:\/\//i.test(clean(body.submitUrl)) ? clean(body.submitUrl) : '';
    if (body.siUrl !== undefined) issue.siUrl = /^https?:\/\//i.test(clean(body.siUrl)) ? clean(body.siUrl) : '';
    issue.updatedAt = new Date().toISOString();
    issue.editedByUser = true;
    writeState(state);
    res.json(payload());
  });

  app.delete('/api/special-issues/:id', (req, res) => {
    const state = readState();
    if (!state.issues.some((i) => i.id === req.params.id)) return res.status(404).json({ error: '该征稿不存在或已被清理' });
    writeState(removeIssue(state, req.params.id));
    res.json(payload());
  });

  /** 手动补一条：给一个链接直接走「抓正文 → 抽取」，不依赖已配置的源。 */
  app.post('/api/special-issues/manual', async (req, res) => {
    const raw = str(req.body?.url || req.body?.text);
    const urls = extractArticleUrls(raw);
    const single = /^https?:\/\//i.test(clean(req.body?.url)) ? clean(req.body.url) : '';
    const targets = urls.length ? urls : (single ? [single] : []);
    if (!targets.length) return res.status(400).json({ error: '请粘贴公众号文章链接（https://mp.weixin.qq.com/s/...）' });
    const state = readState();
    const now = new Date();
    const extractor = buildExtractor();
    for (const url of targets.slice(0, 5)) {
      const id = articleIdOf(url);
      if (!state.articles.some((a) => a.id === id)) {
        state.articles.push({
          id, url, localPath: '', title: '', publishedAt: '', digest: '',
          contentKind: 'url', sourceId: '', sourceName: '手动添加',
          status: 'pending', attempts: 0, lastError: '', fetchedAt: now.toISOString(),
          extractedAt: '', contentChars: 0,
        });
      }
    }
    writeState(state);
    const { stats } = await processArticles(state, {
      fetchImpl, extract: (t, c) => extractor.extract(t, c), now, limit: targets.length, concurrency: 1,
    });
    writeState(state);
    res.json({ ...payload(), stats, extractedBy: extractor.hasModel ? 'ai' : 'rule' });
  });

  // ---------- 等级 ----------
  app.post('/api/special-issues/ranks/refresh', async (req, res) => {
    const settings = store.getSettings();
    if (!clean(settings.easyScholarKey)) return res.status(400).json({ error: '未配置 easyScholar SecretKey，请在「AI 设置」中填写' });
    const state = readState();
    try {
      const result = await enrichRanks(state, {
        queryRank: queryRankImpl,
        formatRank,
        secretKey: settings.easyScholarKey,
        now: new Date(),
        limit: Math.max(1, Math.min(40, Number(req.body?.limit) || 25)),
        force: req.body?.force === true,
      });
      writeState(state);
      res.json({ ...payload(), rankResult: result });
    } catch (e) {
      res.status(400).json({ error: '查询期刊等级失败：' + (e?.message || e) });
    }
  });

  // ---------- 补充翻译（抽取已中文化，这里只处理残留英文） ----------
  app.post('/api/special-issues/:id/translate', async (req, res) => {
    const state = readState();
    const issue = state.issues.find((i) => i.id === req.params.id);
    if (!issue) return res.status(404).json({ error: '该征稿不存在或已被清理' });
    const settings = store.getSettings();
    const engine = translationEngine(settings);
    try {
      const opts = { target: 'zh', provider: engine.provider, fetchImpl };
      const title = issue.titleZh || issue.titleEn;
      const needTitle = /[A-Za-z]{12,}/.test(title) && !/[\u4e00-\u9fa5]/.test(title);
      const translatedTitle = needTitle ? await translateImpl(issue.titleEn || title, settings, opts) : '';
      const summary = issue.summaryZh;
      const needSummary = !summary || (/[A-Za-z]{40,}/.test(summary) && !/[\u4e00-\u9fa5]{6,}/.test(summary));
      const translatedSummary = needSummary
        ? await translateImpl((issue.summaryZh || issue.titleEn || '').slice(0, 4000), settings, opts)
        : '';
      const latest = readState();
      const current = latest.issues.find((i) => i.id === issue.id);
      if (!current) return res.status(404).json({ error: '该征稿已删除或到期，未保存译文' });
      if (translatedTitle) current.titleZh = translatedTitle.slice(0, 300);
      if (translatedSummary) current.summaryZh = translatedSummary.slice(0, 1200);
      current.translatedAt = new Date().toISOString();
      writeState(latest);
      res.json({ ...payload(), translated: true });
    } catch (e) {
      res.status(400).json({ error: '翻译失败：' + (e?.message || '未知错误') });
    }
  });

  app.post('/api/special-issues/purge', (_req, res) => {
    const { state, removed } = purgeExpiredIssues(readState());
    if (removed.length) writeState(state);
    res.json({ ...payload(), removed });
  });

  return { scheduler, runSync, payload, isBusy };
}
