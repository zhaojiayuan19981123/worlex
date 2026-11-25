// siSources.js —— SI 征稿：公众号「文章源」适配器层
//
// 背景（2026-11 现状，决定了本文件为什么长这样）：
//   微信在 2026-07-30 关闭了公众号后台「跨号文章搜索」接口族（searchbiz / appmsgpublish），
//   依赖它的 wechat-article-exporter、we-mp-rss、wewe-rss 已全部停止维护；
//   搜狗微信、客户端历史消息页抓包也早已失效。**没有任何一种免登录方式能稳定列出某号的全部历史文章。**
//   但单篇文章正文仍可免登录抓取（见 wechatArticle.js）。
//
// 所以这里把「文章列表从哪来」抽象成可替换的源，而不是写死某一条会被封的路：
//   rss    —— 第三方把公众号转成 RSS（取阅 / wechat2rss / 自建服务）。最省心，推荐。
//   folder —— 本地导出目录（qiye45/wechatDownload 等工具导出的 md/html/json）。
//             无需任何接口，永不失效；配合本机微信可做到半自动每日增量。
//   links  —— 用户直接粘贴文章链接（可批量），永远可用的兜底。
//   json   —— 自建桥接：任意返回文章数组的 HTTP 接口，方便接 MCP / 脚本。
//
// 单个源失败只影响它自己；调用方按源记录 lastError，界面显示诊断。

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const str = (v) => String(v == null ? '' : v);
const clean = (v) => str(v).replace(/\s+/g, ' ').trim();
const DAY = 24 * 60 * 60 * 1000;

export const SOURCE_TYPES = [
  {
    type: 'rss',
    label: 'RSS 订阅地址',
    hint: '一次配置后每天自动拉取，适合要回溯大量历史文章。可接自建的 wechat-mp-tools（有 Windows 免安装包，不需要 Docker，但要用自己的公众号账号扫码登录），也可用收费的 wechat2rss。订阅源自带全文时不会再重复抓正文。',
  },
  {
    type: 'folder',
    label: '本地导出目录',
    hint: '用 wechatDownload 等工具把公众号文章导出到本地文件夹，这里填目录路径。不需要任何接口，导出后自动入库。',
  },
  {
    type: 'links',
    label: '粘贴文章链接',
    hint: '零配置：一行一个粘贴公众号文章链接，保存后自动抓正文并抽取。适合一次性批量补录——这批处理完，这条来源会自动移除，不会每天重复抓。日常零散文章直接用页面上的「粘贴收稿」。',
    recommended: true,
  },
  {
    type: 'json',
    label: '自定义接口',
    hint: '自建桥接接口，返回 [{url,title,publishedAt}] 或 {items:[...]}。可用于接本机脚本或 MCP。',
  },
];

export function sourceTypeMeta(type) {
  return SOURCE_TYPES.find((t) => t.type === type) || SOURCE_TYPES[0];
}

// ---------------- 规范化 ----------------

export function stableSourceId(parts) {
  const s = parts.map((p) => clean(p)).join('|').toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return 'src_' + h.toString(36);
}

/** 把用户输入/磁盘里的源收敛成受控结构。非法输入返回 null。 */
export function normalizeSource(input = {}) {
  const v = input && typeof input === 'object' ? input : {};
  const type = SOURCE_TYPES.some((t) => t.type === v.type) ? v.type : '';
  if (!type) return null;
  const name = clean(v.name).slice(0, 60) || sourceTypeMeta(type).label;
  let target = clean(v.target || v.url || v.path);
  if (type === 'rss' || type === 'json') {
    if (!/^https?:\/\//i.test(target)) return null;
  } else if (type === 'folder') {
    if (!target) return null;
  } else if (type === 'links') {
    const urls = extractArticleUrls(Array.isArray(target) ? target.join('\n') : target);
    if (!urls.length) return null;
    target = urls.join('\n');
  }
  const id = clean(v.id) || stableSourceId([type, target]);
  return {
    id,
    type,
    name,
    target,
    enabled: v.enabled !== false,
    backfillDays: clampDays(v.backfillDays),
    createdAt: str(v.createdAt) || new Date().toISOString(),
    lastFetchAt: str(v.lastFetchAt),
    lastError: clean(v.lastError).slice(0, 300),
    lastCount: Number.isFinite(Number(v.lastCount)) ? Number(v.lastCount) : 0,
  };
}

export function clampDays(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 90;
  return Math.max(1, Math.min(365, n));
}

// ---------------- 链接提取 ----------------

const URL_RE = /https?:\/\/[^\s<>"'（）()，。、；;]+/gi;

/** 从任意文本（微信复制出来的分享文案、一行一个链接）里抽出公众号文章链接。 */
export function extractArticleUrls(text) {
  const raw = Array.isArray(text) ? text.join('\n') : str(text);
  const found = raw.match(URL_RE) || [];
  const out = [];
  const seen = new Set();
  for (let url of found) {
    url = url.replace(/[)）\]】,，。.;；]+$/, '');
    if (!isWechatArticleUrl(url) && !/^https?:\/\//i.test(url)) continue;
    const key = canonicalArticleUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

export function isWechatArticleUrl(url) {
  try {
    const u = new URL(url);
    return /(^|\.)mp\.weixin\.qq\.com$/i.test(u.hostname) && (/^\/s\//.test(u.pathname) || /^\/s$/.test(u.pathname) || u.pathname === '/mp/appmsg/show');
  } catch { return false; }
}

/**
 * 文章链接规范化：用于去重。
 * 微信同一篇文章有短链 /s/{sn} 和长链 /s?__biz=..&mid=..&idx=..&sn=.. 两种形态，
 * 长链里 chksm、scene、from 等参数与内容无关，一律剔除；有 mid+idx+sn 时用它们做键。
 */
export function canonicalArticleUrl(url) {
  try {
    const u = new URL(str(url));
    u.hash = '';
    for (const key of ['chksm', 'scene', 'from', 'isappinstalled', 'clicktime', 'enterid', 'ascene', 'devicetype', 'version', 'nettype', 'abtest_cookie', 'key', 'pass_ticket', 'wx_header', 'exportkey', 'poc_token', 'subscene']) {
      u.searchParams.delete(key);
    }
    if (u.pathname === '/s' || u.pathname === '/s/') {
      const biz = u.searchParams.get('__biz');
      const mid = u.searchParams.get('mid') || u.searchParams.get('appmsgid');
      const idx = u.searchParams.get('idx');
      const sn = u.searchParams.get('sn');
      if (sn) return `wx:${sn}`;
      if (biz && mid) return `wx:${biz}:${mid}:${idx || '1'}`;
    }
    const short = /^\/s\/([A-Za-z0-9_-]{4,})$/.exec(u.pathname);
    if (short) return `wx:${short[1]}`;
    return u.href.replace(/\/$/, '');
  } catch { return clean(url); }
}

/** 文章稳定 id：对规范化链接取短哈希，避免 URL 变体造成重复入库。 */
export function articleIdOf(url) {
  const key = canonicalArticleUrl(url);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < key.length; i += 1) {
    h1 = ((h1 ^ key.charCodeAt(i)) * 16777619) >>> 0;
    h2 = ((h2 + key.charCodeAt(i)) * 2654435761) >>> 0;
  }
  return 'art_' + h1.toString(36) + h2.toString(36).slice(0, 6);
}

// ---------------- 日期 ----------------

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function pad(n) { return String(n).padStart(2, '0'); }

/** 宽松解析各种时间表示，返回 YYYY-MM-DD（失败返回空串）。 */
export function parseAnyDate(value) {
  const s = clean(value);
  if (!s) return '';
  // 纯数字时间戳（秒/毫秒）
  if (/^\d{10}$/.test(s)) return ymd(new Date(Number(s) * 1000));
  if (/^\d{13}$/.test(s)) return ymd(new Date(Number(s)));
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (iso) return validYmd(iso[1], iso[2], iso[3]);
  const cn = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(s);
  if (cn) return validYmd(cn[1], cn[2], cn[3]);
  const dmy = /(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/.exec(s);
  if (dmy) return validYmd(dmy[3], MONTHS[dmy[2].slice(0, 3).toLowerCase()], dmy[1]);
  const mdy = /([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(s);
  if (mdy) return validYmd(mdy[3], MONTHS[mdy[1].slice(0, 3).toLowerCase()], mdy[2]);
  const parsed = Date.parse(s);
  if (Number.isFinite(parsed)) return ymd(new Date(parsed));
  return '';
}

function validYmd(y, m, d) {
  y = Number(y); m = Number(m); d = Number(d);
  if (![y, m, d].every(Number.isInteger)) return '';
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return '';
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return '';
  return `${y}-${pad(m)}-${pad(d)}`;
}

function ymd(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  return validYmd(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

// ---------------- RSS / Atom ----------------

/** RSS 自带全文的长度上限，和抓正文的上限保持同一量级，避免状态文件被撑爆。 */
const MAX_FEED_CONTENT = 120000;

function decodeEntities(s) {
  return str(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;|&#34;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n) || 32))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16) || 32));
}

function tagValue(fragment, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  return decodeEntities(re.exec(fragment)?.[1] || '').trim();
}

function stripHtml(html) {
  return decodeEntities(str(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}

/** 解析 RSS 2.0 / Atom，返回统一的文章条目。 */
export function parseFeed(xmlText) {
  const raw = str(xmlText);
  if (!raw.trim()) return [];
  const out = [];
  const re = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(raw)) && out.length < 500) {
    const frag = m[2];
    const title = stripHtml(tagValue(frag, 'title'));
    let link = tagValue(frag, 'link');
    if (!link) {
      const href = /<link\b[^>]*href\s*=\s*"([^"]+)"/i.exec(frag);
      link = decodeEntities(href?.[1] || '');
    }
    // Atom 的 link 可能是自闭合标签，上面 tagValue 会拿到空串
    if (!link) {
      const href = /<link\b[^>]*href\s*=\s*'([^']+)'/i.exec(frag);
      link = decodeEntities(href?.[1] || '');
    }
    // 有些自建服务（如 wechat-mp-tools）的 <link> 指向它自己的离线预览文件，
    // 真正的公众号原文地址在 <guid> 里。卡片「原文」必须跳微信，所以这里让微信链接优先。
    const guid = tagValue(frag, 'guid');
    if (isWechatArticleUrl(guid)) link = guid;
    else if (!link && /^https?:\/\//i.test(guid)) link = guid;
    const publishedAt = parseAnyDate(
      tagValue(frag, 'pubDate') || tagValue(frag, 'published') || tagValue(frag, 'updated') || tagValue(frag, 'dc:date'),
    );
    const digest = stripHtml(
      tagValue(frag, 'description') || tagValue(frag, 'summary'),
    ).slice(0, 600);
    // 订阅源若已带全文（wechat-mp-tools 的 content:encoded 默认输出全文），
    // 就存下来直接用于抽取，不必再去请求一次正文页——少一次网络请求就少一次被风控的机会。
    const content = (tagValue(frag, 'content:encoded') || tagValue(frag, 'content')).slice(0, MAX_FEED_CONTENT);
    if (!title && !link) continue;
    out.push({
      url: link.trim(),
      title,
      publishedAt,
      digest: digest || stripHtml(content).slice(0, 600),
      content,
    });
  }
  return out;
}

// ---------------- 各类型取数 ----------------

async function withTimeout(fetchImpl, url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    return await fetchImpl(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readText(res, maxBytes = 6 * 1024 * 1024) {
  if (!res) throw new Error('网络请求没有返回');
  if (res.ok === false) throw new Error(`HTTP ${res.status || '未知'}`);
  let text = '';
  if (res.body?.getReader) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxBytes) throw new Error('响应超过 6 MB，请检查源地址是否指向列表页');
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); }
  } else if (typeof res.text === 'function') {
    text = await res.text();
  } else {
    text = str(res.body);
  }
  return text;
}

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/rss+xml,application/atom+xml,application/xml,application/json,text/html;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

async function fetchRss(source, { fetchImpl, timeoutMs }) {
  const res = await withTimeout(fetchImpl, source.target, { headers: FETCH_HEADERS, redirect: 'follow' }, timeoutMs);
  if (res?.ok === false) {
    const tip = [401, 403].includes(res.status) ? '：订阅地址需要鉴权或已失效，请在订阅服务里重置地址' : res.status === 404 ? '：订阅地址不存在' : '';
    throw new Error(`RSS 请求失败 HTTP ${res.status}${tip}`);
  }
  const text = await readText(res);
  const items = parseFeed(text);
  if (!items.length) {
    if (/<html/i.test(text.slice(0, 500))) throw new Error('返回的是网页而不是 RSS，请确认填的是订阅地址');
    throw new Error('RSS 里没有解析到文章条目，可能格式不受支持或该号近期没有更新');
  }
  return items.map((i) => ({ ...i, contentKind: i.content ? 'feed' : 'url' }));
}

async function fetchJson(source, { fetchImpl, timeoutMs }) {
  const res = await withTimeout(fetchImpl, source.target, { headers: FETCH_HEADERS, redirect: 'follow' }, timeoutMs);
  const text = await readText(res);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('接口返回的不是合法 JSON'); }
  const list = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : Array.isArray(data?.articles) ? data.articles : [];
  if (!list.length) throw new Error('接口没有返回文章数组（应为 [{url,title,publishedAt}]）');
  return list.slice(0, 500).map((x) => ({
    url: clean(x?.url || x?.link),
    title: clean(x?.title),
    publishedAt: parseAnyDate(x?.publishedAt || x?.date || x?.createTime),
    digest: clean(x?.digest || x?.summary).slice(0, 600),
    contentKind: 'url',
  })).filter((x) => x.url || x.title);
}

const ARTICLE_FILE_RE = /\.(md|markdown|html?|txt|json)$/i;

async function walkFolder(dir, depth = 0, acc = []) {
  if (depth > 3 || acc.length > 3000) return acc;
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { await walkFolder(full, depth + 1, acc); continue; }
    if (entry.isFile() && ARTICLE_FILE_RE.test(entry.name)) acc.push(full);
  }
  return acc;
}

/** 从导出文件名/正文里取标题与日期。wechatDownload 等工具常以「日期 + 标题」命名。 */
function metaFromFile(filePath, head) {
  const base = path.basename(filePath).replace(ARTICLE_FILE_RE, '');
  const ymdInName = /(20\d{2})[-_.年]?(\d{1,2})[-_.月]?(\d{1,2})/.exec(base);
  const dateFromName = ymdInName ? validYmd(ymdInName[1], ymdInName[2], ymdInName[3]) : '';
  let title = base.replace(/^(20\d{2}[-_.]?\d{1,2}[-_.]?\d{1,2})[\s_\-·.]*/, '').trim() || base;
  if (/\.json$/i.test(filePath)) {
    try {
      const data = JSON.parse(head);
      const t = clean(data?.title || data?.name);
      if (t) title = t;
      return { title, publishedAt: parseAnyDate(data?.publishedAt || data?.date || data?.create_time) || dateFromName };
    } catch { /* 落到文件名 */ }
  }
  const fmTitle = /^#\s+(.+)$/m.exec(head.slice(0, 4000));
  const htmlTitle = /<h1[^>]*class="rich_media_title"[^>]*>([^<]+)/i.exec(head.slice(0, 20000))
    || /property="og:title"\s+content="([^"]+)"/i.exec(head.slice(0, 20000));
  const fromFile = stripHtml(fmTitle?.[1] || htmlTitle?.[1] || '');
  if (fromFile && fromFile.length > 4) title = fromFile;
  const dateInBody = /(?:发布时间|发表时间|日期)[:：]\s*(20\d{2}[-年]\d{1,2}[-月]\d{1,2})/.exec(head.slice(0, 20000));
  return { title, publishedAt: dateFromName || parseAnyDate(dateInBody?.[1]) };
}

async function fetchFolder(source, { since }) {
  const dir = source.target;
  let info;
  try { info = await stat(dir); } catch { throw new Error('目录不存在或没有读取权限：' + dir); }
  if (!info.isDirectory()) throw new Error('填的不是目录：' + dir);
  const files = await walkFolder(dir);
  if (!files.length) throw new Error('目录里没有找到 md / html / txt / json 文章文件');
  const sinceMs = since ? since.getTime() : 0;
  const out = [];
  for (const file of files) {
    let head = '';
    try {
      const buf = await readFile(file, 'utf8');
      head = buf.slice(0, 60000);
      const meta = metaFromFile(file, buf);
      const ms = meta.publishedAt ? Date.parse(meta.publishedAt + 'T00:00:00') : 0;
      // 没有日期的文件不因回溯窗口被丢弃（可能是用户手动放的），交给后续去重
      if (sinceMs && ms && ms < sinceMs) continue;
      out.push({
        url: '',
        localPath: file,
        title: meta.title,
        publishedAt: meta.publishedAt,
        digest: '',
        contentKind: 'file',
      });
    } catch {
      // 单个文件读失败不影响整体
    }
  }
  if (!out.length) throw new Error(`目录里有 ${files.length} 个文件，但都早于回溯窗口（${source.backfillDays} 天）`);
  return out;
}

function fetchLinks(source) {
  return extractArticleUrls(source.target).map((url) => ({
    url, localPath: '', title: '', publishedAt: '', digest: '', contentKind: 'url',
  }));
}

/**
 * 拉取一个源的文章列表。
 * @returns {{articles: Array, warning: string}}
 */
export async function fetchSourceArticles(sourceInput, opts = {}) {
  const source = normalizeSource(sourceInput);
  if (!source) throw new Error('文章源配置不完整');
  const {
    fetchImpl = globalThis.fetch,
    now = new Date(),
    backfillDays = source.backfillDays,
    timeoutMs = 25000,
  } = opts;
  const since = backfillDays > 0 ? new Date(now.getTime() - backfillDays * DAY) : null;

  let items = [];
  if (source.type === 'rss') items = await fetchRss(source, { fetchImpl, timeoutMs });
  else if (source.type === 'json') items = await fetchJson(source, { fetchImpl, timeoutMs });
  else if (source.type === 'folder') items = await fetchFolder(source, { since });
  else if (source.type === 'links') items = fetchLinks(source);
  else throw new Error('不支持的文章源类型');

  const seen = new Set();
  const articles = [];
  let undated = 0;
  for (const item of items) {
    const key = item.url ? canonicalArticleUrl(item.url) : `file:${item.localPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!item.publishedAt) undated += 1;
    else if (since && Date.parse(item.publishedAt + 'T00:00:00') < since.getTime()) continue;
    articles.push({
      id: articleIdOf(item.url || key),
      url: item.url || '',
      localPath: item.localPath || '',
      title: clean(item.title).slice(0, 200),
      publishedAt: item.publishedAt || '',
      digest: clean(item.digest).slice(0, 600),
      contentKind: item.contentKind || 'url',
      // 订阅源自带的全文（有就用，抽取时不再请求正文页），抽取完成后会被清空以控制状态体积
      content: str(item.content).slice(0, MAX_FEED_CONTENT),
      sourceId: source.id,
      sourceName: source.name,
    });
  }
  const warning = undated && source.type !== 'links' && source.type !== 'folder'
    ? `${undated} 条没有发布日期，已按增量处理`
    : '';
  return { articles, warning };
}

/** 一次性源（links）在消费后应当移除，避免每天重复处理同一批链接。 */
export function isOneShotSource(source) {
  return source?.type === 'links';
}
