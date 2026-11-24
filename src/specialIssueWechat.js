import crypto from 'node:crypto';
import { parseDocument, DomUtils } from 'htmlparser2';

export const WECHAT_ACCOUNT = 'sscizhenggao';
export const WECHAT_NAME = 'SSCI征稿';
const DAY = 86400000;
const text = value => String(value ?? '').trim();
const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
const iso = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : '';
const decode = value => text(value).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");

export function normalizeWechat(value = {}) {
  const v = value && typeof value === 'object' ? value : {};
  const c = v.config && typeof v.config === 'object' ? v.config : {};
  const articles = v.articles && typeof v.articles === 'object' && !Array.isArray(v.articles) ? v.articles : {};
  return {
    accountId: WECHAT_ACCOUNT, accountName: WECHAT_NAME,
    config: {
      historyUrl: text(c.historyUrl).slice(0, 12000), cookie: text(c.cookie).slice(0, 16000),
      appmsgToken: text(c.appmsgToken).slice(0, 4096),
      intervalSeconds: Math.max(3, Math.min(60, Number(c.intervalSeconds) || 5)),
    },
    backfill: {
      from: iso(v.backfill?.from), through: iso(v.backfill?.through),
      listedAt: iso(v.backfill?.listedAt), completedAt: iso(v.backfill?.completedAt),
    },
    watermark: iso(v.watermark), lastAttemptAt: iso(v.lastAttemptAt), lastError: text(v.lastError).slice(0, 400),
    articles: Object.fromEntries(Object.entries(articles).filter(([, a]) => a && typeof a === 'object' && a.url)),
    deletedIssueIds: [...new Set((Array.isArray(v.deletedIssueIds) ? v.deletedIssueIds : []).filter(id => typeof id === 'string'))],
  };
}

// Use calendar months in China, clamping month-end instead of subtracting 90 days.
export function threeMonthsAgo(now = new Date()) {
  const local = new Date(now.getTime() + 8 * 3600000);
  const day = local.getUTCDate();
  local.setUTCDate(1);
  local.setUTCMonth(local.getUTCMonth() - 3);
  const last = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 0)).getUTCDate();
  local.setUTCDate(Math.min(day, last));
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - 8 * 3600000).toISOString();
}

export function validateWechatConfig(config) {
  let url;
  try { url = new URL(config.historyUrl); } catch { throw new Error('请填写 SSCI征稿 的微信历史消息链接，公众号 ID 本身不能读取历史文章'); }
  if (url.origin !== 'https://mp.weixin.qq.com' || url.username || url.password || url.pathname !== '/mp/profile_ext'
      || !['home', 'getmsg'].includes(url.searchParams.get('action')) || !url.searchParams.get('__biz')) {
    throw new Error('历史链接必须是 https://mp.weixin.qq.com/mp/profile_ext，且包含 action 和 __biz');
  }
  if (/[\r\n]/.test(config.cookie || '')) throw new Error('Cookie 不能包含换行');
  if (url.searchParams.get('action') === 'getmsg' && !(config.appmsgToken || url.searchParams.get('appmsg_token'))) {
    throw new Error('getmsg 历史链接缺少 appmsg_token，请更新微信会话');
  }
  return url;
}

export function wechatArticleUrl(value, biz) {
  try {
    const url = new URL(decode(value), 'https://mp.weixin.qq.com');
    if (url.hostname !== 'mp.weixin.qq.com' || url.port || url.username || url.password || !['http:', 'https:'].includes(url.protocol)
        || !/^\/s(?:\/|$)/.test(url.pathname)) return '';
    if (biz && url.searchParams.get('__biz') !== biz) return '';
    url.protocol = 'https:';
    url.hash = '';
    // Tracking parameters must not give one article multiple identities.
    for (const key of [...url.searchParams.keys()]) {
      if (!['__biz', 'mid', 'idx', 'sn'].includes(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.href;
  } catch { return ''; }
}

export function parseWechatPage(data, biz) {
  if (!data || typeof data !== 'object') throw new Error('微信未返回有效的历史消息');
  if (Number(data.ret ?? data.base_resp?.ret ?? 0) !== 0) throw new Error('微信会话失效或请求被限制，请更新历史消息链接和 Cookie');
  let raw;
  try { raw = typeof data.general_msg_list === 'string' ? JSON.parse(data.general_msg_list) : data.general_msg_list; }
  catch { throw new Error('微信历史消息格式无效，未推进同步进度'); }
  if (!raw || !Array.isArray(raw.list) || ![0, 1, '0', '1'].includes(data.can_msg_continue)) {
    throw new Error('微信未返回可验证的文章分页，未推进同步进度');
  }
  const articles = [];
  const dates = [];
  for (const item of raw.list) {
    const timestamp = Number(item.comm_msg_info?.datetime) * 1000;
    if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error('历史消息缺少发布时间，无法确认回溯范围');
    dates.push(timestamp);
    const ext = item.app_msg_ext_info;
    if (!ext) continue;
    for (const entry of [ext, ...(Array.isArray(ext.multi_app_msg_item_list) ? ext.multi_app_msg_item_list : [])]) {
      const url = wechatArticleUrl(entry.content_url, biz);
      if (!url) throw new Error('文章链接缺失或不属于当前公众号，已停止抓取');
      articles.push({ id: 'wx:' + hash(url), url, title: text(entry.title).slice(0, 500), publishedAt: new Date(timestamp).toISOString() });
    }
  }
  const hasMore = Number(data.can_msg_continue) === 1;
  const nextOffset = Number(data.next_offset);
  if (hasMore && (!Number.isInteger(nextOffset) || nextOffset <= 0 || !dates.length)) throw new Error('微信分页游标无效，未标记历史回溯完成');
  return { articles, dates, hasMore, nextOffset };
}

function plainContent(node) {
  if (node.type === 'text') return node.data;
  if (['script', 'style', 'noscript'].includes(node.name)) return '';
  const body = (node.children || []).map(plainContent).join('');
  return /^(p|div|section|br|li|h[1-6]|tr)$/.test(node.name) ? body + '\n' : body;
}

export function parseWechatArticle(html) {
  const dom = parseDocument(html);
  const content = DomUtils.getElementById('js_content', dom.children)
    || DomUtils.findOne(n => /(?:^|\s)rich_media_content(?:\s|$)/.test(n.attribs?.class || ''), dom.children);
  if (!content) throw new Error('文章正文不可读取，可能需要更新会话或文章已删除');
  const body = plainContent(content).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (body.length < 40) throw new Error('正文文字过少或为图片征稿，需人工核验；未生成空卡片');
  const links = DomUtils.findAll(n => n.name === 'a' && n.attribs?.href, [content]).map(n => {
    try { const u = new URL(n.attribs.href); return /^https?:$/.test(u.protocol) ? { label: DomUtils.textContent(n).slice(0, 120), url: u.href } : null; } catch { return null; }
  }).filter(Boolean).slice(0, 80);
  return { content: body, links, contentHash: hash(body + JSON.stringify(links)) };
}

export function createWechatProvider(config, { fetchImpl = globalThis.fetch, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const history = validateWechatConfig(config);
  const biz = history.searchParams.get('__biz');
  let token = config.appmsgToken || history.searchParams.get('appmsg_token') || '';
  let lastRequest = 0;
  async function request(url) {
    if (lastRequest) await sleep(Math.max(0, Math.max(3, Number(config.intervalSeconds) || 5) * 1000 - (Date.now() - lastRequest)));
    lastRequest = Date.now();
    let response;
    try {
      response = await fetchImpl(url.href, {
        headers: { Accept: 'text/html,application/json', ...(config.cookie ? { Cookie: config.cookie } : {}) },
        redirect: 'error', signal: AbortSignal.timeout(30000),
      });
    } catch { throw new Error('微信请求失败或超时，请更新会话或稍后重试'); }
    if (!response.ok) throw new Error(`微信返回 HTTP ${response.status}，请检查会话或稍后重试`);
    if (Number(response.headers?.get('content-length')) > 2 * 1024 * 1024) throw new Error('微信响应超过安全大小限制');
    let body;
    try { body = await response.text(); }
    catch { throw new Error('微信正文读取失败，请稍后重试'); }
    if (body.length > 2 * 1024 * 1024) throw new Error('微信响应超过安全大小限制');
    return body;
  }
  return {
    async page(offset) {
      if (offset === 0) {
        const home = new URL(history);
        home.searchParams.set('action', 'home');
        const html = await request(home);
        const dom = parseDocument(html);
        const nickname = DomUtils.getElementById('nickname', dom.children) || DomUtils.getElementById('js_name', dom.children);
        if (!nickname || DomUtils.textContent(nickname).replace(/\s/g, '').toLowerCase() !== WECHAT_NAME.toLowerCase()) {
          throw new Error('未能确认历史页面属于 SSCI征稿，请检查公众号或更新会话');
        }
        token = /appmsg_token\s*=\s*["']([^"']+)/.exec(html)?.[1] || token;
        const encoded = /(?:var\s+)?msgList\s*=\s*'((?:\\.|[^'\\])*)'/.exec(html)?.[1];
        const more = /can_msg_continue\s*=\s*['"]?([01])/.exec(html)?.[1];
        if (encoded === undefined || more === undefined) throw new Error('微信历史页面格式发生变化或会话失效');
        // Decode one JavaScript string layer without evaluating page scripts.
        const json = decode(encoded.replace(/\\(x[a-f\d]{2}|u[a-f\d]{4}|[\\'"/bfnrt])/gi, (_, escape) => {
          if (/^[xu]/i.test(escape)) return String.fromCharCode(parseInt(escape.slice(1), 16));
          return ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' })[escape] ?? escape;
        }));
        return parseWechatPage({ general_msg_list: json, can_msg_continue: more, next_offset: 10 }, biz);
      }
      const url = new URL(history);
      for (const [key, value] of Object.entries({ action: 'getmsg', f: 'json', offset, count: 10, is_ok: 1, scene: 124, appmsg_token: token })) url.searchParams.set(key, value);
      const raw = await request(url);
      let data;
      try { data = JSON.parse(raw); } catch { throw new Error('微信返回登录或验证页面，请更新会话'); }
      return parseWechatPage(data, biz);
    },
    async article(article) {
      const url = wechatArticleUrl(article.url, biz);
      if (!url) throw new Error('拒绝读取非目标公众号的文章');
      return parseWechatArticle(await request(new URL(url)));
    },
  };
}

export function wechatPublicStatus(value, runtime = {}) {
  const w = normalizeWechat(value);
  const entries = Object.values(w.articles);
  let hasToken = !!w.config.appmsgToken;
  try { hasToken ||= !!new URL(w.config.historyUrl).searchParams.get('appmsg_token'); } catch { /* No usable history URL. */ }
  let configured = true;
  try { validateWechatConfig(w.config); } catch { configured = false; }
  return {
    accountId: WECHAT_ACCOUNT, accountName: WECHAT_NAME, configured,
    hasCookie: !!w.config.cookie, hasToken,
    intervalSeconds: w.config.intervalSeconds, backfill: w.backfill, watermark: w.watermark,
    lastAttemptAt: w.lastAttemptAt, lastError: w.lastError,
    totalArticles: entries.length, processed: entries.filter(a => a.status === 'processed').length,
    pending: entries.filter(a => a.status !== 'processed').length,
    failedArticles: entries.filter(a => a.error).map(a => ({ id: a.id, title: a.title, url: a.url, error: a.error, attempts: a.attempts || 0 })).slice(0, 100),
    ...runtime,
  };
}

// Persist after each page and article. Mutations always merge against the latest
// saved state so a slow network request cannot restore a user's deleted cards.
export async function syncWechatIssues({ getState, saveState, provider, extract, buildCards, enrich, progress = () => {}, now = new Date(), maxPages = 500 }) {
  let w = normalizeWechat(getState().wechat);
  const start = now.toISOString();
  if (!w.backfill.from) w.backfill = { from: threeMonthsAgo(now), through: start, listedAt: '', completedAt: '' };
  const initial = !w.backfill.listedAt;
  const since = initial ? w.backfill.from : new Date(Math.max(Date.parse(w.backfill.from), Date.parse(w.watermark || w.backfill.through) - 2 * DAY)).toISOString();
  function persist(patch, issues = []) {
    const latest = getState();
    w = normalizeWechat({ ...latest.wechat, ...patch });
    const deleted = new Set(w.deletedIssueIds);
    const map = new Map(latest.issues.map(i => [i.id, i]));
    for (const issue of issues) if (!deleted.has(issue.id)) map.set(issue.id, { ...map.get(issue.id), ...issue });
    saveState({ ...latest, wechat: w, issues: [...map.values()] });
  }
  persist({ ...w, lastAttemptAt: start, lastError: '' });
  let listingComplete = false, listingError = '', added = 0;
  try {
    let offset = 0;
    const seenOffsets = new Set();
    for (let page = 0; page < maxPages; page++) {
      progress({ stage: initial ? 'backfill' : 'incremental', pages: page + 1 });
      if (seenOffsets.has(offset)) throw new Error('微信返回重复分页，已保留进度，请稍后重试');
      seenOffsets.add(offset);
      const result = await provider.page(offset);
      const articles = { ...w.articles };
      for (const article of result.articles) {
        if (Date.parse(article.publishedAt) < Date.parse(since)) continue;
        if (!articles[article.id]) articles[article.id] = { ...article, status: 'pending', attempts: 0, issueIds: [] };
      }
      persist({ articles });
      // Do not stop on the first old article: WeChat can include pinned entries.
      if (!result.hasMore || (result.dates.length && result.dates.every(d => d < Date.parse(since)))) { listingComplete = true; break; }
      if (result.nextOffset <= offset) throw new Error('微信分页没有前进，未推进同步水位');
      offset = result.nextOffset;
    }
    if (!listingComplete) throw new Error('本次达到分页保护上限，历史回溯尚未完成');
    persist({ ...(initial ? { backfill: { ...w.backfill, listedAt: start } } : {}), watermark: start });
  } catch (error) {
    listingError = text(error.message).slice(0, 300);
    persist({ lastError: listingError });
  }
  const pending = Object.values(w.articles).filter(a => a.status !== 'processed')
    .sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
  for (let index = 0; index < pending.length; index++) {
    let article = { ...w.articles[pending[index].id] };
    progress({ stage: 'processing', current: index + 1, count: pending.length });
    try {
      if (!article.content) article = { ...article, ...await provider.article(article) };
      persist({ articles: { ...w.articles, [article.id]: { ...article, attempts: (article.attempts || 0) + 1, error: '' } } });
      const raw = await extract(article);
      if (!Array.isArray(raw)) throw new Error('AI 未返回有效的征稿数组');
      const cards = buildCards(raw, article, now);
      const existing = new Set(getState().issues.map(i => i.id));
      added += cards.filter(c => !existing.has(c.id) && !w.deletedIssueIds.includes(c.id)).length;
      article = { ...article, status: 'processed', processedAt: new Date().toISOString(), error: '', attempts: (article.attempts || 0) + 1, issueIds: cards.map(c => c.id) };
      persist({ articles: { ...w.articles, [article.id]: article } }, cards);
    } catch (error) {
      article = { ...article, status: 'failed', attempts: (article.attempts || 0) + 1, error: text(error.message).slice(0, 300) };
      persist({ articles: { ...w.articles, [article.id]: article } });
      // Missing/invalid AI configuration affects every article; avoid a cascade
      // of billable requests after the first persistent configuration error.
      if (error.code === 'SI_AI_CONFIG') break;
    }
  }
  const failed = Object.values(w.articles).filter(a => a.status !== 'processed');
  if (listingComplete && !failed.length) {
    persist({ backfill: { ...w.backfill, completedAt: w.backfill.completedAt || new Date().toISOString() }, lastError: '' });
    saveState({ ...getState(), lastSyncAt: start });
  } else if (!listingError) persist({ lastError: `${failed.length} 篇文章尚未处理成功，已保存并等待重试` });
  if (typeof enrich === 'function') { progress({ stage: 'ranks' }); await enrich(); }
  return { ok: listingComplete && !failed.length, partial: added > 0 && (!listingComplete || !!failed.length), added, total: getState().issues.length,
    synced: listingComplete ? [WECHAT_ACCOUNT] : [], failed: [...(listingError ? [{ error: listingError }] : []), ...failed.map(a => ({ articleId: a.id, error: a.error || '待处理' }))] };
}
