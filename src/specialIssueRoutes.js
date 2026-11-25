// specialIssueRoutes.js —— SI 征稿（v2）HTTP 路由
//
// 职责边界：只做「读状态 → 调管线 → 写状态 → 返回 payload」，不放业务规则。
// 复用的既有能力：
//   easyScholar   → src/easyscholar.js   期刊等级
//   translate     → src/translate.js     可选译文（抽取阶段已中文化，这里只做补充）
//   AI 结构化抽取 → 注入 fetchModelCompletion / readLLMResponse / resolveRequestModel
//   出网          → 注入 fetchImpl（server.js 的 modelFetch，自动直连/代理切换）

import { createHash, randomUUID } from 'node:crypto';
import { queryPublicationRank, formatRank } from './easyscholar.js';
import { defaultTranslationProvider, translate } from './translate.js';
import { resolveActive } from './modelCatalog.js';
import { createSpecialIssueScheduler } from './specialIssueScheduler.js';
import {
  createSpecialIssueState, listIssues, specialIssueSummary, setPreferences,
  removeIssue, purgeExpiredIssues, deadlineMeta, rankBadges, topicCounts,
  RANK_FILTERS, SOURCE_TYPES, normalizeSource, articleIdOf, today,
} from './specialIssues.js';
import { collectArticles, processArticles, requeueArticles, enrichRanks, pendingRankCount, runSyncPipeline } from './siPipeline.js';
import { buildExtractMessages, buildTranslateMessages, parseModelJson, salvageModelJson, normalizeExtractedIssues, ruleExtractIssues } from './siExtract.js';
import { extractArticleUrls, isWechatArticleUrl, canonicalArticleUrl } from './siSources.js';
import { fetchWechatArticle, readLocalArticle, htmlToArticleText } from './wechatArticle.js';
import { fetchWebPageArticle } from './siWebPage.js';

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

/** 整理模型返回的译文：留换行（详情按段渲染），去掉代码围栏与行尾空白。 */
function cleanParagraphs(text) {
  return str(text)
    .trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```\s*$/i, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
            // 全文翻译比原来的「两三句摘要」长得多，2600 token 会被截断在 JSON 中间；
            // 4 秒级的模型也够用，所以直接把预算提到 4000。
            max_tokens: 4000,
          }, { stream: false, timeoutMs: 90000 });
          if (!request?.up?.ok) throw new Error('模型没有返回有效响应');
          const full = (await readLLMResponse(request.up)).full || '';
          let json = parseModelJson(full);
          if (!json) {
            // 全文翻译太长导致 JSON 被截断时，短字段其实是完整的，先按字段抢救一遍，
            // 抢救不到才退回规则抽取（否则等于白花一次模型调用）。
            json = salvageModelJson(full);
            if (json) logger('[SI] 模型输出不是完整 JSON（多半是全文翻译被截断），已按字段抢救');
          }
          if (!json) {
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
   * 把用户粘贴的内容拆成「待处理条目」。
   *
   * 三种输入混在同一个文本框里，按下面的顺序判断，避免同一份材料被处理两次：
   *   1. 去掉链接后仍有 400 字以上的正文 → 只按正文处理（用户粘的往往是整页内容，
   *      链接只是来源标注；再抓一次页面既慢又会和正文出重复卡）
   *   2. 否则收下所有链接：mp.weixin.qq.com 走公众号正文，其它域名走通用网页抓取
   *   3. 链接都没有但正文够长 → 同样按正文处理
   */
  const PASTE_URL_RE = /https?:\/\/[^\s<>"'（）()，。、；;]+/gi;
  const CFP_SIGNAL_RE = /(专刊|特刊|征稿|截稿|客座编辑|call\s+for\s+(?:papers|paper)|special\s+issue)/i;
  const SHARE_NOISE_RE = /^(?:复制链接|阅读原文|点击.{0,8}关注|长按.{0,8}二维码|扫码|分享|在看|点赞|写留言|预览时标签不可点)/;

  /** 纯文本条目的稳定 id：同一段正文贴两次不会重复入库。 */
  function textArticleId(text) {
    return 'art_t' + createHash('sha1').update(clean(text)).digest('hex').slice(0, 16);
  }

  function parseCollectInput(raw) {
    const text = str(raw);
    const urls = [];
    const seen = new Set();
    PASTE_URL_RE.lastIndex = 0;
    let m;
    while ((m = PASTE_URL_RE.exec(text))) {
      const url = m[0].replace(/[)）\]】,，。.;；]+$/, '');
      const key = canonicalArticleUrl(url);
      if (seen.has(key)) continue;
      seen.add(key);
      urls.push(url);
    }
    const leftover = text
      .replace(PASTE_URL_RE, '\n')
      .split('\n')
      .map((line) => clean(line))
      .filter((line) => line.length >= 2 && !SHARE_NOISE_RE.test(line))
      .join('\n')
      .trim();
    const richContent = leftover.length >= 400 && CFP_SIGNAL_RE.test(leftover);
    return {
      urls: richContent ? [] : urls,
      wechatUrls: urls.filter((u) => isWechatArticleUrl(u)),
      pageUrls: urls.filter((u) => !isWechatArticleUrl(u)),
      contentText: richContent ? leftover.slice(0, 60000) : '',
      leftover,
    };
  }

  /** 这篇文章上次抽出的条目里还有没有活着的（旧记录没有 producedIds，退回按 articleId 反查） */
  function articleStillHasIssue(state, article) {
    const produced = Array.isArray(article.producedIds) ? article.producedIds : [];
    if (produced.length) {
      const alive = new Set(state.issues.map((i) => i.id));
      return produced.some((id) => alive.has(id));
    }
    return state.issues.some((i) => i.articleId === article.id);
  }

  /** 重置成待处理：条目被删掉、被过期清理或上次抓取失败时，允许同一篇重新收一次 */
  function resetArticleForRetry(article, now) {
    article.status = 'pending';
    article.attempts = 0;
    article.lastError = '';
    article.extractedAt = '';
    article.fetchedAt = now;
    article.producedIds = [];
  }

  /**
   * 把待处理条目放进队列。
   * 只入库不抽取：这样即使界面被关掉、或者要分批处理很久，内容也已经记下来了。
   *
   * 「已收过」不能只看文章记录还在不在：用户在列表里删掉条目后文章记录仍留着，
   * 如果只按文章 id 判重，同一篇再贴一次会被「之前已经收过了」永久挡住，删了就再也收不回来。
   * 所以按「它上次抽出的条目是否还在」判断：
   *   - 条目还在（或上次根本没抽出条目、判定为非征稿）→ 真的已收过，跳过；
   *   - 条目被删掉 / 被过期清理 → 重置这篇文章，重新走一遍抓正文 → 抽取；
   *   - 上次抓取失败 → 同样重置，省得先去「诊断」页点重试。
   */
  function enqueueTargets(state, targets) {
    const now = new Date().toISOString();
    const byId = new Map(state.articles.map((a) => [a.id, a]));
    let queued = 0;
    let existing = 0;
    for (const t of targets) {
      const id = t.kind === 'text' ? textArticleId(t.text) : articleIdOf(t.url);
      const prev = byId.get(id);
      if (prev) {
        const redo = prev.status === 'failed'
          || ((prev.status === 'extracted') && !articleStillHasIssue(state, prev));
        if (!redo) { existing += 1; continue; }
        resetArticleForRetry(prev, now);
        if (t.kind === 'text') {
          prev.contentKind = 'text';
          prev.content = t.text;
          prev.sourceName = '粘贴正文';
        }
        queued += 1;
        continue;
      }
      const record = {
        id,
        url: t.kind === 'text' ? '' : t.url,
        localPath: '',
        title: '',
        publishedAt: '',
        digest: '',
        contentKind: t.kind === 'text' ? 'text' : 'url',
        // 粘贴的正文直接存进 content，抽取时不再请求任何页面
        content: t.kind === 'text' ? t.text : '',
        sourceId: '',
        sourceName: t.kind === 'text' ? '粘贴正文' : (isWechatArticleUrl(t.url) ? '微信粘贴' : '官网页面'),
        status: 'pending',
        attempts: 0,
        lastError: '',
        fetchedAt: now,
        extractedAt: '',
        contentChars: 0,
        producedIds: [],
      };
      state.articles.push(record);
      byId.set(id, record);
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
    // 列表不返回全文翻译：400 条 × 上万字会把响应撑到几 MB，
    // 详情面板打开时再按 id 取（见 GET /api/special-issues/:id）。
    const issues = listIssues(state, {
      now,
      query: options.query || '',
      topics: options.topics || [],
      deadlineWindow: options.deadlineWindow || 'all',
      rankSystem: options.rankSystem || '',
      rankLevels: options.rankLevels || [],
      favoriteOnly: options.favoriteOnly === true,
      taskOnly: options.taskOnly === true,
      sourceId: options.sourceId || '',
      sort: options.sort || '',
      limit: 400,
    }).map((i) => {
      const { detailZh, ...rest } = i;
      return { ...rest, summaryZh: compact(i.summaryZh, 400), detailChars: str(detailZh).length, hasTask: !!i.taskId };
    });

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
      summary,
      sources: state.sources,
      sourceTypes: SOURCE_TYPES,
      preferences: state.preferences,
      // 界面顶部要告诉用户「去哪粘贴」：公众号名放在这里，换号时只改一处
      guide: {
        accountName: 'SSCI征稿',
        accountId: 'sscizhenggao',
        tip: '在微信里搜索并关注这个号，每天推送最新的 SSCI/SCIE 专刊征稿。',
      },
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
    taskOnly: req.query?.taskOnly === '1',
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
   * 粘贴收稿：公众号链接、出版社 SI 页面链接、整段正文都能收。
   * 这是「不想折腾 RSS / 订阅服务」时的主路径，零配置可用。
   * 每篇都要过一次大模型，几十篇会跑很久，所以接口只负责入队并立即返回，
   * 前端轮询 /status 看进度（与「立即同步」共用同一套运行态）。
   */
  app.post('/api/special-issues/collect', (req, res) => {
    if (syncPromise || collectPromise || runtime.running) {
      return res.status(409).json({ error: '上一批还在处理，等它跑完再贴下一批。' });
    }
    const raw = Array.isArray(req.body?.urls)
      ? req.body.urls.join('\n')
      : str(req.body?.text || req.body?.url);
    const parsed = parseCollectInput(raw);
    const targets = [];
    if (parsed.contentText) targets.push({ kind: 'text', text: parsed.contentText });
    for (const url of parsed.urls) targets.push({ kind: 'url', url });
    if (!targets.length) {
      return res.status(400).json({
        error: '没有识别到可处理的内容。可以粘贴公众号文章链接、出版社专刊页链接，或直接粘贴正文（400 字以上会自动识别）。',
      });
    }
    const picked = targets.slice(0, COLLECT_MAX);
    const dropped = Math.max(0, targets.length - picked.length);

    // 先在请求里入队并落盘：这样「收下了没有」有确定答案，
    // 全是重复内容时也不必白跑一趟后台任务。
    const state = readState();
    const { queued, existing } = enqueueTargets(state, picked);
    if (queued) writeState(state);
    const counted = {
      wechat: parsed.contentText ? 0 : parsed.wechatUrls.length,
      page: parsed.contentText ? 0 : parsed.pageUrls.length,
      text: parsed.contentText ? 1 : 0,
    };
    if (!queued) {
      return res.json({
        started: false, running: false, queued: 0, existing, dropped, counted,
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
      started: true, running: true, queued, existing, dropped, counted,
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

  // ---------- 偏好 / 修正 ----------
  app.put('/api/special-issues/preferences', (req, res) => {
    writeState(setPreferences(readState(), req.body || {}));
    scheduler.refresh();
    res.json(payload());
  });

  // ---------- 加入任务（替代原来的收藏） ----------
  // 收藏只是标记，用户真正要做的是「在截止前把稿子投出去」，所以直接进任务安排，
  // 首页的今日计划 / 倒计时 / 征稿卡片都会自动带上它。

  const newTaskId = () => (typeof store?.newId === 'function' ? store.newId() : 'task_' + randomUUID());

  function buildTaskFromIssue(issue, now = new Date()) {
    const dm = deadlineMeta(issue, now);
    const journal = clean(issue.journalShort || issue.journal) || '期刊';
    const topic = clean(issue.titleZh || issue.titleEn).slice(0, 80);
    // 没有公布截止日期时给一个两周后的软提醒：任务永远沉在「无期限」里等于没加
    const fallbackDue = today(new Date(now.getTime() + 14 * DAY));
    const priority = dm.days === null ? '中' : dm.days <= 14 ? '高' : dm.days <= 45 ? '中' : '低';
    return {
      title: `投稿 SI｜${journal}${topic ? '｜' + topic : ''}`.slice(0, 200),
      due: dm.date || fallbackDue,
      priority,
      projectId: null,
      status: 'todo',
      createdAt: now.toISOString(),
      completedAt: null,
      // 任务安排/首页据此把这条任务标成「征稿」，并能跳回 SI 详情
      source: 'si',
      issueId: issue.id,
      issueUrl: clean(issue.siUrl || issue.submitUrl || issue.articleUrl),
      journal: clean(issue.journal),
      deadline: clean(issue.deadline),
    };
  }

  app.post('/api/special-issues/:id/task', (req, res) => {
    const state = readState();
    const issue = state.issues.find((i) => i.id === req.params.id);
    if (!issue) return res.status(404).json({ error: '该征稿不存在或已被清理' });
    const list = typeof store.listTasks === 'function' ? store.listTasks() : [];
    // 已经加过：直接回显，不重复建任务（用户往往连点两下）
    const existingTask = issue.taskId ? list.find((t) => t.id === issue.taskId) : null;
    if (existingTask) return res.json({ ...payload(), task: existingTask, already: true });

    const task = { id: newTaskId(), ...buildTaskFromIssue(issue) };
    // 允许界面覆盖截止日/优先级（例如用户想在截稿前一周提醒自己）
    const due = clean(req.body?.due);
    if (/^\d{4}-\d{2}-\d{2}$/.test(due)) task.due = due;
    if (['高', '中', '低'].includes(req.body?.priority)) task.priority = req.body.priority;

    list.unshift(task);
    if (typeof store.saveTasks === 'function') store.saveTasks(list);
    issue.taskId = task.id;
    issue.taskAddedAt = task.createdAt;
    issue.updatedAt = new Date().toISOString();
    writeState(state);
    res.json({ ...payload(), task });
  });

  app.delete('/api/special-issues/:id/task', (req, res) => {
    const state = readState();
    const issue = state.issues.find((i) => i.id === req.params.id);
    if (!issue) return res.status(404).json({ error: '该征稿不存在或已被清理' });
    if (issue.taskId && typeof store.listTasks === 'function' && typeof store.saveTasks === 'function') {
      const list = store.listTasks().filter((t) => t.id !== issue.taskId);
      store.saveTasks(list);
    }
    issue.taskId = '';
    issue.taskAddedAt = '';
    issue.updatedAt = new Date().toISOString();
    writeState(state);
    res.json(payload());
  });

  // ---------- 详情（含全文翻译与相关灵感） ----------
  app.get('/api/special-issues/:id', (req, res) => {
    const state = readState();
    const issue = state.issues.find((i) => i.id === req.params.id);
    if (!issue) return res.status(404).json({ error: '该征稿不存在或已被清理' });
    const article = state.articles.find((a) => a.id === issue.articleId) || null;
    res.json({
      issue: {
        ...issue,
        deadline: deadlineMeta(issue),
        badges: rankBadges(issue),
      },
      article: article
        ? {
          id: article.id,
          url: article.url,
          title: article.title,
          publishedAt: article.publishedAt,
          sourceName: article.sourceName,
          status: article.status,
          contentChars: article.contentChars || str(article.content).length,
        }
        : null,
      ideaMatches: hydrateIdeaMatches(issue),
    });
  });

  // ---------- 相关灵感（大模型梳理） ----------
  function hydrateIdeaMatches(issue) {
    const ideas = typeof store.listIdeas === 'function' ? store.listIdeas() : [];
    const byId = new Map(ideas.map((x) => [x.id, x]));
    return (issue?.ideaMatches || [])
      .map((m) => {
        const idea = byId.get(m.ideaId);
        // 灵感被删了就别再显示死链接
        if (!idea) return null;
        return {
          ...m,
          title: idea.title || '未命名灵感',
          content: clean(idea.content).slice(0, 240),
          tags: Array.isArray(idea.tags) ? idea.tags.slice(0, 4) : [],
          status: idea.status || 'seed',
        };
      })
      .filter(Boolean);
  }

  app.post('/api/special-issues/:id/ideas', async (req, res) => {
    const state = readState();
    const issue = state.issues.find((i) => i.id === req.params.id);
    if (!issue) return res.status(404).json({ error: '该征稿不存在或已被清理' });
    const ideas = typeof store.listIdeas === 'function' ? store.listIdeas() : [];
    if (!ideas.length) {
      return res.json({ ...payload(), ideaMatches: [], message: '灵感孵化里还没有记录，先去记两条想法再来匹配。' });
    }
    const am = resolveRequestModel(req.body?.profileId || '');
    if (am?.error || typeof fetchModelCompletion !== 'function' || typeof readLLMResponse !== 'function') {
      return res.status(400).json({ error: '未配置大模型，无法梳理灵感关联。请先在「AI 设置」里启用一个模型。' });
    }

    // 只把最近更新的 40 条送进模型：灵感库可能攒了几百条，全塞进去既超上下文也更不准
    const pool = [...ideas]
      .sort((a, b) => str(b.updatedAt || b.createdAt).localeCompare(str(a.updatedAt || a.createdAt)))
      .slice(0, 40);
    const ideaLines = pool.map((idea, idx) => [
      `[${idx + 1}] id=${idea.id}`,
      `标题：${clean(idea.title || '未命名').slice(0, 120)}`,
      `内容：${clean(idea.content).slice(0, 700) || '（未填写）'}`,
      idea.field ? `领域：${clean(idea.field).slice(0, 60)}` : '',
      (idea.tags || []).length ? `标签：${(idea.tags || []).join('、').slice(0, 120)}` : '',
    ].filter(Boolean).join('\n')).join('\n\n');

    const siInfo = [
      `期刊：${clean(issue.journal)}`,
      clean(issue.titleEn) ? `专刊英文主题：${clean(issue.titleEn)}` : '',
      `专刊中文主题：${clean(issue.titleZh)}`,
      issue.deadline ? `截稿日期：${issue.deadline}` : '截稿日期未公布',
      (issue.topicsZh || []).length ? `主题词：${issue.topicsZh.join('、')}` : '',
      clean(issue.summaryZh) ? `征稿说明：${clean(issue.summaryZh)}` : '',
      clean(issue.detailZh || '').slice(0, 2500) ? `征稿详情（节选）：\n${clean(issue.detailZh).slice(0, 2500)}` : '',
    ].filter(Boolean).join('\n');

    const messages = [
      {
        role: 'system',
        content: [
          '你是研究选题与征稿信息的匹配助手。',
          '任务：判断「用户的科研灵感」与「某个期刊专刊的征稿方向」是否真的贴合，只输出 JSON。',
          '',
          '【输出】{"matches":[{"id":"灵感id","score":0,"reason":"","angle":""}]}',
          '- score：0~100 的整数，表示这条灵感写成该专刊论文的契合度。',
          '  80 以上＝主题、方法或情境直接对口；60~79＝有明显交集，需要调整切口；',
          '  45~59＝勉强相关；低于 45 的一律不要返回。',
          '- reason：一句话说明为什么契合（≤60 字，要具体到主题/机制/情境，不要空话）。',
          '- angle：一句话说明怎么把它写成这个专刊的文章（切入角度或需要补的部分，≤60 字）。',
          '- 最多返回 5 条，按 score 从高到低。一条都不贴合就返回 {"matches":[]}。',
          '- 不要为了凑数硬匹配：灵感与征稿方向没有实质交集时必须返回空数组。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: `【征稿信息】\n${siInfo}\n\n【用户的灵感】\n${ideaLines}`,
      },
    ];

    try {
      const request = await fetchModelCompletion(am.profile, {
        model: am.profile.model,
        messages,
        temperature: 0.2,
        max_tokens: 1200,
      }, { stream: false, timeoutMs: 60000 });
      if (!request?.up?.ok) throw new Error('模型没有返回有效响应');
      const full = (await readLLMResponse(request.up)).full || '';
      const json = parseModelJson(full);
      const rawMatches = Array.isArray(json?.matches) ? json.matches : Array.isArray(json) ? json : [];
      const valid = new Set(pool.map((x) => x.id));
      const matches = rawMatches
        .map((m) => ({
          ideaId: str(m?.id || m?.ideaId),
          score: Math.max(0, Math.min(100, Math.round(Number(m?.score) || 0))),
          reason: clean(m?.reason).slice(0, 300),
          angle: clean(m?.angle).slice(0, 300),
          at: new Date().toISOString(),
        }))
        .filter((m) => valid.has(m.ideaId) && m.score >= 45)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      // 重新读一遍：模型跑了几十秒，期间用户可能改了别的卡片
      const latest = readState();
      const target = latest.issues.find((i) => i.id === issue.id);
      if (!target) return res.status(404).json({ error: '该征稿已删除，未保存匹配结果' });
      target.ideaMatches = matches;
      target.updatedAt = new Date().toISOString();
      writeState(latest);
      res.json({ ...payload(), ideaMatches: hydrateIdeaMatches(target), matched: matches.length });
    } catch (e) {
      res.status(400).json({ error: '梳理灵感失败：' + clean(e?.message || e) });
    }
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
    const issue = state.issues.find((i) => i.id === req.params.id);
    if (!issue) return res.status(404).json({ error: '该征稿不存在或已被清理' });
    // 删掉征稿等于「不投了」，它派生出的任务也一并撤掉，免得任务列表里留一条无主待办
    if (issue.taskId && typeof store.listTasks === 'function' && typeof store.saveTasks === 'function') {
      store.saveTasks(store.listTasks().filter((t) => t.id !== issue.taskId));
    }
    writeState(removeIssue(state, req.params.id));
    res.json(payload());
  });

  /** 手动补一条：给一个链接直接走「抓正文 → 抽取」，不依赖已配置的源。 */
  app.post('/api/special-issues/manual', async (req, res) => {
    const raw = str(req.body?.url || req.body?.text);
    const urls = extractArticleUrls(raw);
    const single = /^https?:\/\//i.test(clean(req.body?.url)) ? clean(req.body.url) : '';
    const targets = urls.length ? urls : (single ? [single] : []);
    if (!targets.length) return res.status(400).json({ error: '请粘贴征稿页链接（公众号文章或出版社专刊页都可以）' });
    const state = readState();
    const now = new Date();
    const extractor = buildExtractor();
    for (const url of targets.slice(0, 5)) {
      const id = articleIdOf(url);
      const prev = state.articles.find((a) => a.id === id);
      if (!prev) {
        state.articles.push({
          id, url, localPath: '', title: '', publishedAt: '', digest: '',
          contentKind: 'url', sourceId: '', sourceName: '手动添加',
          status: 'pending', attempts: 0, lastError: '', fetchedAt: now.toISOString(),
          extractedAt: '', contentChars: 0, producedIds: [],
        });
      } else if (prev.status === 'failed' || (prev.status === 'extracted' && !articleStillHasIssue(state, prev))) {
        // 条目被删掉或上次失败时，手动补这一条就是「重新收一次」的意思，别静默跳过
        resetArticleForRetry(prev, now.toISOString());
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

  // ---------- 全文翻译（旧卡片补 detailZh / 用户手动重译） ----------
  // 抽取时已经带 detailZh；这个接口是给两类情况兜底：
  //   ① 升级前生成的卡片只有一句话摘要；
  //   ② 用户觉得上次翻译质量不好，想重来。
  // 所以需要重新拿到原文：优先用文章缓存里的正文，其次按链接重抓。
  async function readArticleText(issue, state) {
    const article = state.articles.find((a) => a.id === issue.articleId);
    if (!article) return { text: '', title: '', url: '' };
    if (article.content && str(article.content).length >= 60) {
      return { text: htmlToArticleText(article.content), title: article.title, url: article.url };
    }
    try {
      if (article.localPath) {
        const r = await readLocalArticle(article.localPath, { maxChars: 16000 });
        return { text: str(r?.text), title: r?.title || article.title, url: article.url };
      }
      if (article.url) {
        const r = isWechatArticleUrl(article.url)
          ? await fetchWechatArticle(article.url, { fetchImpl })
          : await fetchWebPageArticle(article.url, { fetchImpl });
        return { text: str(r?.text), title: r?.title || article.title, url: article.url };
      }
    } catch (e) {
      logger('[SI] 重取原文失败：' + (e?.message || e));
    }
    return { text: '', title: article.title, url: article.url };
  }

  app.post('/api/special-issues/:id/translate', async (req, res) => {
    const state = readState();
    const issue = state.issues.find((i) => i.id === req.params.id);
    if (!issue) return res.status(404).json({ error: '该征稿不存在或已被清理' });
    const settings = store.getSettings();
    const engine = translationEngine(settings);
    try {
      const { text, title } = await readArticleText(issue, state);
      if (!text || text.length < 60) {
        return res.status(400).json({ error: '找不到这条征稿的原文（可能已被微信删除）。可以重新粘贴一次文章链接再试。' });
      }

      let detailZh = '';
      const am = resolveRequestModel('');
      if (!am?.error && typeof fetchModelCompletion === 'function' && typeof readLLMResponse === 'function') {
        const request = await fetchModelCompletion(am.profile, {
          model: am.profile.model,
          messages: buildTranslateMessages(issue, text),
          temperature: 0.1,
          max_tokens: 4000,
        }, { stream: false, timeoutMs: 90000 });
        if (!request?.up?.ok) throw new Error('模型没有返回有效响应');
        detailZh = cleanParagraphs((await readLLMResponse(request.up)).full || '');
        try { request?.cancel?.(); } catch { /* ignore */ }
      } else {
        // 没配模型时退到「文本翻译」通道，至少把英文段落译出来（会按长度截断）
        detailZh = cleanParagraphs(await translateImpl(text.slice(0, 6000), settings, {
          target: 'zh', provider: engine.provider, fetchImpl,
        }));
      }
      if (!detailZh) throw new Error('翻译结果为空，请检查模型配置');

      const latest = readState();
      const current = latest.issues.find((i) => i.id === issue.id);
      if (!current) return res.status(404).json({ error: '该征稿已删除或到期，未保存译文' });
      current.detailZh = detailZh.slice(0, 12000);
      // 顺带补上标题译文：有些卡片来自纯英文官网，标题还是英文
      const zhTitle = current.titleZh || current.titleEn;
      if (zhTitle && !/[\u4e00-\u9fa5]/.test(zhTitle)) {
        current.titleZh = (title || zhTitle).slice(0, 300);
      }
      current.translatedAt = new Date().toISOString();
      current.updatedAt = new Date().toISOString();
      writeState(latest);
      res.json({ ...payload(), translated: true, detailChars: current.detailZh.length });
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
