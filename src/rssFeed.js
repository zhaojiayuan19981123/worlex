// rssFeed.js —— 期刊官网自带的 RSS 2.0（目前用于 JMLR）
//
// 为什么单独一层：
//   JMLR（CCF-A 人工智能期刊）不给 DOI 注册，Crossref 里 total-results = 0，按 ISSN 查是一条都拿不到；
//   但官网 https://jmlr.org/jmlr.xml 有标准 RSS：标题、作者、摘要、文章页链接都在里面。
//   与其为它写一个专门的页面解析器，不如做一层通用的 RSS 2.0 适配，以后别的刊也能直接复用。
//
// 与知网 RSS 的差别：
//   · 这里的 <pubDate> 只给年份（如 2026），不是完整时间 → publishedAt 记成「该年 1 月 1 日」；
//   · 链接是稳定地址（没有一次性签名），但仍按「期刊 + 规范化标题」做主键，和别处保持同一口径。

import { htmlText, decodeHtml } from './cnJournalFeed.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_XML = 8 * 1024 * 1024;

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n) || 32))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16) || 32));
}

/** 和知网 RSS 一样可能双重转义：解实体 → 去标签，反复几轮 */
function rssText(raw) {
  let text = htmlText(decodeEntities(raw));
  for (let i = 0; i < 3 && /<[^>]+>/.test(text); i += 1) text = htmlText(text);
  return text.replace(/\s+/g, ' ').trim();
}

function tag(xml, name) {
  const re = new RegExp(`<${name}>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${name}>`, 'i');
  const m = re.exec(xml);
  return m ? m[1].trim() : '';
}

function shortHash(text) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    h1 = ((h1 ^ text.charCodeAt(i)) * 16777619) >>> 0;
    h2 = ((h2 + text.charCodeAt(i)) * 2654435761) >>> 0;
  }
  return `${h1.toString(36)}${h2.toString(36).slice(0, 6)}`;
}

export function rssArticleId(journalId, title) {
  const key = String(title || '').replace(/[\s\u3000]+/g, '').toLowerCase();
  return `rss:${shortHash(`${journalId}|${key}`)}`;
}

/** <pubDate>2026</pubDate> / <pubDate>Mon, 03 Feb 2025 00:00:00 GMT</pubDate> 都要能认 */
export function rssDateToDay(value) {
  const raw = String(value || '').trim();
  const yearOnly = /^(20\d{2})$/.exec(raw);
  if (yearOnly) return `${yearOnly[1]}-01-01`;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function parseGenericRss(xml, journal = {}) {
  const text = String(xml || '');
  const stamp = new Date().toISOString();
  const seen = new Set();
  const out = [];
  for (const raw of text.split(/<item\b[^>]*>/i).slice(1)) {
    const title = rssText(tag(raw, 'title')).slice(0, 300);
    if (!title) continue;
    const key = title.replace(/[\s\u3000]+/g, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: rssArticleId(journal.id, title),
      journalId: journal.id || '',
      journal: String(journal.title || '').trim(),
      title,
      authors: rssText(tag(raw, 'author') || tag(raw, 'dc:creator'))
        .split(/[;,，；]|\band\b/)
        .map((name) => name.trim())
        .filter(Boolean),
      affiliations: [],
      abstract: rssText(tag(raw, 'description')).slice(0, 4000),
      doi: '',
      originalUrl: decodeEntities(tag(raw, 'link')).trim(),
      publishedAt: rssDateToDay(tag(raw, 'pubDate')),
      volume: '',
      issue: '',
      pages: '',
      articleType: 'journal-article',
      source: '期刊官网 RSS',
      discoveredAt: stamp,
      updatedAt: stamp,
    });
  }
  return out;
}

export async function fetchRssArticles(journal, { fetchImpl = globalThis.fetch, timeoutMs = 25000 } = {}) {
  const url = String(journal?.rssUrl || '').trim();
  if (!url) throw new Error('该刊还没有配置官网 RSS 地址');
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持网络请求');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  let res;
  try {
    res = await fetchImpl(url, {
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8' },
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error?.name === 'AbortError' || /abort/i.test(String(error?.message || ''));
    throw new Error(aborted ? '期刊官网 RSS 请求超时（可能限流，稍后重试）' : `期刊官网 RSS 请求失败：${error?.message || '网络错误'}`);
  } finally {
    clearTimeout(timer);
  }
  if (res?.ok === false) throw new Error(`期刊官网 RSS 返回 HTTP ${res.status}`);
  let buffer;
  if (typeof res.arrayBuffer === 'function') buffer = new Uint8Array(await res.arrayBuffer());
  else if (typeof res.text === 'function') buffer = new TextEncoder().encode(await res.text());
  else buffer = new TextEncoder().encode(String(res.body || ''));
  if (!buffer.length) throw new Error('期刊官网 RSS 返回了空内容');
  if (buffer.length > MAX_XML) throw new Error('期刊官网 RSS 返回内容异常大，已中止');
  const xml = decodeHtml(buffer, 'application/xml;charset=utf-8');
  if (!/<item\b/i.test(xml)) throw new Error('期刊官网 RSS 里没有条目');
  const articles = parseGenericRss(xml, journal);
  if (!articles.length) throw new Error('期刊官网 RSS 里的条目都不像论文');
  return articles;
}
