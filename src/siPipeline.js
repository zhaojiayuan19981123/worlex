// siPipeline.js —— SI 征稿管线编排：采集 → 抽取 → 期刊等级
//
// 分层原则：
//   * 每一步都从「磁盘上的最新状态」开始、以「写回状态」结束，中断后重跑不会重复出卡；
//   * 单篇文章失败只影响它自己，并把错误记在文章上，界面可单独重试；
//   * 每一步都有数量上限（limit），避免一次同步卡住十几分钟——公众号首次回溯 3 个月会有几十篇，
//     分几轮跑完比一口气跑完更稳，用户也能看到进度。
//
// 网络、模型、等级查询全部由调用方注入，本文件不发请求、不写磁盘。

import { fetchSourceArticles, isOneShotSource, isWechatArticleUrl, canonicalArticleUrl } from './siSources.js';
import { fetchWechatArticle, readLocalArticle, htmlToArticleText } from './wechatArticle.js';
import { fetchWebPageArticle } from './siWebPage.js';
import { buildIssue, mergeIssues, mergeArticles, deadlineMeta } from './specialIssues.js';
import { formatRank as defaultFormatRank } from './easyscholar.js';

const str = (v) => String(v == null ? '' : v);
const clean = (v) => str(v).replace(/\s+/g, ' ').trim();
const DAY = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;

function nowIso(now) { return now.toISOString(); }

// ---------------- 1. 采集文章列表 ----------------

/**
 * 从所有启用的源拉文章列表，写入 state.articles（status='pending'）。
 * 已存在（按文章 id）的条目不会被重置状态，只更新标题等元信息。
 */
export async function collectArticles(stateInput, opts = {}) {
  const {
    fetchImpl = globalThis.fetch,
    now = new Date(),
    sourceIds = null,
    backfillDays = null,
    timeoutMs = 25000,
  } = opts;
  const state = stateInput;
  const wanted = Array.isArray(sourceIds) && sourceIds.length
    ? state.sources.filter((s) => sourceIds.includes(s.id))
    : state.sources.filter((s) => s.enabled);

  const existing = new Map(state.articles.map((a) => [a.id, a]));
  const incoming = [];
  const results = [];

  for (const source of wanted) {
    const days = Number(backfillDays) > 0 ? Number(backfillDays) : source.backfillDays;
    try {
      const { articles, warning } = await fetchSourceArticles(source, { fetchImpl, now, backfillDays: days, timeoutMs });
      let added = 0;
      for (const a of articles) {
        const prev = existing.get(a.id);
        if (prev) {
          // 已有文章：只补元信息，保持状态机不动
          incoming.push({
            ...prev,
            url: prev.url || a.url,
            localPath: prev.localPath || a.localPath,
            title: prev.title || a.title,
            publishedAt: prev.publishedAt || a.publishedAt,
            sourceName: prev.sourceName || a.sourceName,
          });
          continue;
        }
        incoming.push({ ...a, status: 'pending', attempts: 0, lastError: '', fetchedAt: nowIso(now), extractedAt: '', contentChars: 0 });
        added += 1;
      }
      results.push({ sourceId: source.id, name: source.name, ok: true, count: articles.length, added, warning: warning || '' });
    } catch (e) {
      results.push({ sourceId: source.id, name: source.name, ok: false, count: 0, added: 0, error: clean(e?.message || e).slice(0, 300) });
    }
  }

  // 源状态写回（保留其他源的历史）
  const byId = new Map(results.map((r) => [r.sourceId, r]));
  state.sources = state.sources.map((s) => {
    const r = byId.get(s.id);
    if (!r) return s;
    return {
      ...s,
      lastFetchAt: nowIso(now),
      lastError: r.ok ? '' : (r.error || '采集失败'),
      lastCount: r.ok ? r.count : s.lastCount,
    };
  });

  // 一次性源（粘贴链接）消费后停用，避免每天重复抓同一批
  state.sources = state.sources.flatMap((s) => {
    const r = byId.get(s.id);
    if (!r?.ok) return [s];
    if (isOneShotSource(s)) return [];
    return [s];
  });

  state.articles = mergeArticles(state.articles, incoming);
  return { state, results };
}

// ---------------- 2. 抽取 ----------------

async function extractOne(state, article, opts) {
  const {
    fetchImpl, extract, now, timeoutMs,
  } = opts;
  let content;
  // 订阅源已带全文时直接用，不再请求正文页：省一次往返，也少一次被微信风控拦下的机会
  if (article.content && str(article.content).length >= 60) {
    content = {
      url: article.url || '',
      title: article.title || '',
      publishedAt: article.publishedAt || '',
      text: htmlToArticleText(article.content, { maxChars: 16000 }),
    };
  } else {
    try {
      // 三种来源三种取正文的方式：
      //   localPath   → 本地导出文件
      //   mp.weixin…  → 公众号正文页（有 #js_content 专用解析）
      //   其它 http   → 出版社/期刊的专刊页，走通用正文识别
      // 之前把所有链接都当微信文章抓，官网链接必定失败，这是「贴了官网地址没反应」的根因。
      content = article.localPath
        ? await readLocalArticle(article.localPath, { maxChars: 16000 })
        : isWechatArticleUrl(article.url)
          ? await fetchWechatArticle(article.url, { fetchImpl, timeoutMs })
          : await fetchWebPageArticle(article.url, { fetchImpl, timeoutMs });
    } catch (e) {
      return { ok: false, error: clean(e?.message || e) };
    }
  }
  const text = str(content?.text);
  if (text.length < 60) return { ok: false, error: '正文过短，无法抽取' };

  const ctx = {
    articleUrl: content.url || article.url,
    articleTitle: content.title || article.title,
    articlePublishedAt: content.publishedAt || article.publishedAt,
    articleId: article.id,
    sourceId: article.sourceId,
    sourceName: article.sourceName,
    now,
  };

  let result;
  try {
    result = await extract(text, ctx);
  } catch (e) {
    return { ok: false, error: '抽取失败：' + clean(e?.message || e), contentChars: text.length };
  }
  if (!result || !Array.isArray(result.issues)) {
    return { ok: false, error: '抽取器没有返回有效结果', contentChars: text.length };
  }
  // 补上正文里没写、但文章本身有的元信息
  const issues = result.issues.map((i) => buildIssue({
    ...i,
    articleId: article.id,
    articleUrl: ctx.articleUrl,
    articleTitle: ctx.articleTitle || i.articleTitle,
    articlePublishedAt: ctx.articlePublishedAt || i.articlePublishedAt,
    sourceId: article.sourceId,
    sourceName: article.sourceName,
  }, now));

  return {
    ok: true,
    notCfp: result.notCfp === true || issues.length === 0,
    issues,
    contentChars: text.length,
    articleTitle: content.title || article.title,
    articlePublishedAt: content.publishedAt || article.publishedAt,
  };
}

/**
 * 处理待抽取文章。
 * @param {object} state
 * @param {object} opts { fetchImpl, extract, now, limit=20, concurrency=2, retryFailed=false }
 */
export async function processArticles(stateInput, opts = {}) {
  const {
    fetchImpl = globalThis.fetch,
    extract,
    now = new Date(),
    limit = 20,
    concurrency = 2,
    timeoutMs = 25000,
    retryFailed = false,
    onProgress = null,
  } = opts;
  if (typeof extract !== 'function') throw new Error('缺少抽取函数');
  const state = stateInput;

  // 新的优先：刚发的文章对用户价值最高；首次回溯时也不会全都堆在最老的文章上
  const queue = state.articles
    .filter((a) => a.status === 'pending' || (retryFailed && a.status === 'failed' && a.attempts < MAX_ATTEMPTS))
    .sort((a, b) => str(b.publishedAt).localeCompare(str(a.publishedAt)))
    .slice(0, Math.max(1, limit));

  const stats = { processed: 0, extracted: 0, skipped: 0, failed: 0, issues: 0, errors: [] };
  if (!queue.length) return { state, stats };

  const byId = new Map(state.articles.map((a) => [a.id, a]));
  const newIssues = [];
  let cursor = 0;

  async function worker() {
    for (;;) {
      const idx = cursor;
      cursor += 1;
      const article = queue[idx];
      if (!article) return;
      const live = byId.get(article.id);
      if (!live) continue;
      const res = await extractOne(state, live, { fetchImpl, extract, now, timeoutMs });
      stats.processed += 1;
      if (typeof onProgress === 'function') {
        try { onProgress(stats.processed, queue.length, live.title || live.url); } catch { /* 进度回调不应影响主流程 */ }
      }
      if (!res.ok) {
        stats.failed += 1;
        stats.errors.push({ title: live.title || live.url, error: res.error });
        byId.set(live.id, {
          ...live,
          status: 'failed',
          attempts: (live.attempts || 0) + 1,
          lastError: res.error.slice(0, 300),
          contentChars: res.contentChars || live.contentChars,
        });
        continue;
      }
      if (res.notCfp) {
        stats.skipped += 1;
        byId.set(live.id, {
          ...live,
          status: 'skipped',
          attempts: (live.attempts || 0) + 1,
          lastError: '',
          extractedAt: nowIso(now),
          contentChars: res.contentChars,
          content: '',
          producedIds: [],
        });
        continue;
      }
      stats.extracted += 1;
      stats.issues += res.issues.length;
      newIssues.push(...res.issues);
      byId.set(live.id, {
        ...live,
        title: live.title || res.articleTitle,
        publishedAt: live.publishedAt || res.articlePublishedAt,
        status: 'extracted',
        attempts: (live.attempts || 0) + 1,
        lastError: '',
        extractedAt: nowIso(now),
        contentChars: res.contentChars,
        // 记下这篇抽出了哪几条：条目被用户删掉后，同一篇再贴一次要能重新收回来
        producedIds: res.issues.map((i) => i.id),
        // 抽完就丢掉原文，状态文件不必背着几十篇全文；失败时保留，方便下次直接重试
        content: '',
      });
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));

  state.articles = [...byId.values()];
  const before = new Set(state.issues.map((i) => i.id));
  state.issues = mergeIssues(state.issues, newIssues);
  stats.added = state.issues.filter((i) => !before.has(i.id)).length;
  return { state, stats };
}

/** 把失败/跳过的文章重新排队（用户点「重试」）。 */
export function requeueArticles(stateInput, articleIds = null) {
  const state = stateInput;
  const ids = Array.isArray(articleIds) && articleIds.length ? new Set(articleIds) : null;
  state.articles = state.articles.map((a) => {
    // 显式点名要重跑的文章一律重排队：用户点了「重新抽取」就该真的重跑，
    // 哪怕它上次是成功状态（换了模型 / 改了提示词后需要重来）。
    if (ids) {
      if (!ids.has(a.id)) return a;
      return { ...a, status: 'pending', attempts: 0, lastError: '' };
    }
    if (a.status === 'failed' || a.status === 'skipped') {
      return { ...a, status: 'pending', attempts: 0, lastError: '' };
    }
    return a;
  });
  return state;
}

// ---------------- 3. 期刊等级 ----------------

export function journalKey(name) {
  return clean(name).toLowerCase().replace(/\s+/g, ' ');
}

/**
 * 用 easyScholar 给 issue 补期刊等级。
 * 同名期刊只查一次；缓存 7 天；整体串行以满足每秒 2 次的限制。
 * @param {object} opts { queryRank, secretKey, now, limit=25, maxAgeDays=7, force=false }
 */
export async function enrichRanks(stateInput, opts = {}) {
  const {
    queryRank,
    secretKey,
    now = new Date(),
    limit = 25,
    maxAgeDays = 7,
    force = false,
    formatRank = defaultFormatRank,
  } = opts;
  const state = stateInput;
  if (typeof queryRank !== 'function') throw new Error('缺少等级查询函数');
  if (!clean(secretKey)) throw new Error('未配置 EasyScholar SecretKey');

  const maxAge = maxAgeDays * DAY;
  const pending = new Map();
  for (const issue of state.issues) {
    const key = journalKey(issue.journal);
    if (!key) continue;
    const cached = state.ranks[issue.journal];
    const queriedAt = Date.parse(cached?.queriedAt || '');
    const fresh = Number.isFinite(queriedAt) && now.getTime() - queriedAt < maxAge;
    if (cached && fresh && !force) {
      if (!issue.rank) issue.rank = { summary: cached.summary, items: cached.items, queriedAt: cached.queriedAt, journal: issue.journal };
      continue;
    }
    if (!pending.has(key)) pending.set(key, { journal: issue.journal, issues: [] });
    pending.get(key).issues.push(issue);
  }

  const targets = [...pending.values()].slice(0, Math.max(1, limit));
  const errors = [];
  let updated = 0;
  for (const target of targets) {
    let summary = '';
    let items = [];
    try {
      const data = await queryRank(target.journal, secretKey);
      if (data?.code !== 200) {
        errors.push({ journal: target.journal, error: clean(data?.msg) || '未查询到' });
        continue;
      }
      const formatted = formatRank ? formatRank(data.data) : null;
      if (formatted) {
        summary = formatted.summary || '';
        items = Array.isArray(formatted.items) ? formatted.items : [];
      } else {
        summary = '未收录于中科院/新锐/ABS/UTD24/SSCI/FMS/CSSCI 分区';
      }
    } catch (e) {
      errors.push({ journal: target.journal, error: clean(e?.message || e).slice(0, 160) });
      continue;
    }
    const record = { summary, items, queriedAt: nowIso(now), journal: target.journal, source: 'easyScholar' };
    state.ranks[target.journal] = record;
    for (const issue of target.issues) {
      issue.rank = { ...record };
    }
    updated += 1;
  }
  return {
    state,
    updated,
    attempted: targets.length,
    remaining: pending.size - targets.length,
    errors,
  };
}

/** 还有多少本期刊需要查等级（用于界面提示「继续刷新」）。 */
export function pendingRankCount(stateInput, opts = {}) {
  const state = stateInput;
  const now = opts.now || new Date();
  const maxAge = (opts.maxAgeDays || 7) * DAY;
  const keys = new Set();
  for (const issue of state.issues) {
    const key = journalKey(issue.journal);
    if (!key) continue;
    const queriedAt = Date.parse(state.ranks[issue.journal]?.queriedAt || '');
    if (Number.isFinite(queriedAt) && now.getTime() - queriedAt < maxAge) continue;
    keys.add(key);
  }
  return keys.size;
}

// ---------------- 4. 汇总 ----------------

/** 一次完整同步：采集 → 抽取（多轮直到限额）→ 等级。供手动同步与定时任务共用。 */
export async function runSyncPipeline(stateInput, opts = {}) {
  const {
    fetchImpl = globalThis.fetch,
    extract,
    queryRank,
    formatRank,
    secretKey = '',
    now = new Date(),
    sourceIds = null,
    backfillDays = null,
    extractLimit = 12,
    rounds = 3,
    rankLimit = 25,
    concurrency = 2,
    autoRank = true,
    logger = () => {},
    onPhase = () => {},
  } = opts;

  const state = stateInput;
  const startedAt = nowIso(now);
  const summary = {
    collected: 0, added: 0, processed: 0, extractedArticles: 0, skipped: 0, failed: 0,
    issues: 0, newIssues: 0, ranked: 0, rankRemaining: 0, warnings: [], errors: [],
  };

  onPhase('collect', '正在拉取文章列表');
  const collected = await collectArticles(state, { fetchImpl, now, sourceIds, backfillDays });
  summary.collected = collected.results.reduce((n, r) => n + r.count, 0);
  summary.added = collected.results.reduce((n, r) => n + r.added, 0);
  for (const r of collected.results) {
    if (!r.ok) summary.errors.push({ stage: 'collect', source: r.name, error: r.error });
    else if (r.warning) summary.warnings.push(`${r.name}：${r.warning}`);
  }

  onPhase('extract', '正在抽取征稿信息');
  for (let round = 0; round < Math.max(1, rounds); round += 1) {
    const pending = state.articles.filter((a) => a.status === 'pending').length;
    if (!pending) break;
    const res = await processArticles(state, {
      fetchImpl, extract, now, limit: extractLimit, concurrency,
      onProgress: (done, total, title) => {
        const short = clean(title).slice(0, 28);
        onPhase('extract', `正在抽取 ${done}/${total}${short ? '：' + short : ''}`);
      },
    });
    summary.processed += res.stats.processed;
    summary.extractedArticles += res.stats.extracted;
    summary.skipped += res.stats.skipped;
    summary.failed += res.stats.failed;
    summary.issues += res.stats.issues;
    summary.newIssues += res.stats.added || 0;
    for (const e of res.stats.errors) summary.errors.push({ stage: 'extract', ...e });
    if (res.stats.processed === 0) break;
    const left = state.articles.filter((a) => a.status === 'pending').length;
    logger(`[SI] 抽取第 ${round + 1} 轮完成，剩余待处理 ${left} 篇`);
  }

  if (autoRank && secretKey && typeof queryRank === 'function') {
    onPhase('rank', '正在查询期刊等级');
    try {
      const res = await enrichRanks(state, { queryRank, formatRank, secretKey, now, limit: rankLimit });
      summary.ranked = res.updated;
      summary.rankRemaining = res.remaining;
      for (const e of res.errors) summary.errors.push({ stage: 'rank', ...e });
    } catch (e) {
      summary.errors.push({ stage: 'rank', error: clean(e?.message || e).slice(0, 200) });
    }
  }

  state.lastAttemptAt = startedAt;
  state.sync = {
    phase: 'idle',
    message: '',
    lastAttemptAt: startedAt,
    lastSuccessAt: summary.errors.length === 0 ? startedAt : (state.sync?.lastSuccessAt || ''),
    lastError: summary.errors.length ? summary.errors[0].error : '',
    lastResult: summary,
  };
  if (summary.processed > 0 || summary.added > 0) state.lastSyncAt = startedAt;
  onPhase('idle', '');
  return { state, summary };
}
