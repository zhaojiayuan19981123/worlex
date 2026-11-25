// cnJournalFeed.js —— 中文期刊「当期目录」抓取
//
// 为什么需要单独一层：
//   NSFC 管理科学部 A 类 22 种中文期刊**完全不在 Crossref**（按 ISSN、按 DOI 前缀查 works 均为 0 条），
//   OpenAlex 只零星收录两三种，也没有任何统一的中文期刊元数据接口。能拿到新文章的路径只有
//   「抓各刊官网/期刊系统的当期目录页」。
//
// 为什么不是 22 个解析器：
//   这些站点分散在玛格泰克（/CN/abstract/abstract1662.shtml、/CN/Y2025/V546/I12/20）、
//   勤云（view_abstract.aspx?file_no=20230504）、以及各自的自建 CMS（/info/1006/1002.htm、?id=123766）
//   上，模板各不相同而且经常改版，写 22 个选择器等于给自己埋 22 个定时炸弹。
//   所以这里只做**通用抽取**：把所有锚点按「链接形态」分组，取文章特征最强的那一组。
//   实测对中国软科学、中国工业经济、管理世界、管理科学、金融研究、数量经济技术经济研究、
//   科研管理 都能直接出目录；抓不到的刊会给出明确原因，不会静默失败。
//
// 已知取舍：
//   - 只取标题 + 链接 + 期号日期，不逐篇抓摘要（22 刊 × 数十篇 = 数百次请求，容易被风控，
//     而中文刊目录的价值主要在「这一期有哪些文章」）。
//   - 站点多为 GBK/GB18030 编码，必须按 charset 解码，否则标题全是乱码。

const MAX_ARTICLES = 12;
const MAX_HTML = 4 * 1024 * 1024;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 纯导航 / 功能性文案，不是文章标题 */
const NAV_TEXT = /^(首页|网站首页|返回首页|关于我们|联系我们|期刊介绍|期刊简介|编委会|投稿指南|在线投稿|作者登录|专家登录|编辑登录|读者登录|登录|注册|下载|下载中心|下载专区|更多|查看更多|更多>>|more|上一页|下一页|末页|首页上一页|English|EN|中文|目录|过刊浏览|当期目录|最新目录|本期目录|期刊订阅|订阅|广告|版权|声明|帮助|搜索|高级检索|友情链接|主办单位|主管单位|全文下载|返回顶部|点击排行|推荐文章|查看全文|在线阅读|摘要|PDF|pdf|下载全文)$/i;

/** 明显不是文章正文页的链接 */
const NON_ARTICLE_HREF = /(javascript:|mailto:|^#|\.(pdf|docx?|xlsx?|zip|rar|css|js|png|jpe?g|gif|ico)$|\/(login|register|contact|about|download|submission|author|editor|search|help|advert|news|notice|en)\b)/i;

/** 期刊自己会列出来的「某年第 N 期」目录索引，不是文章 */
const ISSUE_INDEX_TEXT = /^(\d{4}\s*年|第\s*\d+\s*期|.*观点摘要|.*总目录|.*年度总目)/;

const ENTITY = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ldquo: '“', rdquo: '”', mdash: '—', hellip: '…', middot: '·' };

function decodeEntities(s) {
  return String(s)
    .replace(/&([a-z]+);/gi, (m, name) => (ENTITY[name.toLowerCase()] ?? m))
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n) || 32))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16) || 32));
}

/** HTML → 单行纯文本 */
export function htmlText(value) {
  return decodeEntities(String(value || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * 按 charset 解码响应体。
 * 中文期刊站点大量使用 GB2312/GBK 且不一定在响应头里声明，所以头里没有就回落到 <meta> 里找。
 */
export function decodeHtml(buffer, contentType = '') {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || []);
  const head = Buffer.from(bytes.slice(0, 4096)).toString('latin1');
  const fromHeader = /charset=["']?([\w-]+)/i.exec(String(contentType || ''));
  const fromMeta = /charset=["']?([\w-]+)/i.exec(head);
  const raw = String(fromHeader?.[1] || fromMeta?.[1] || 'utf-8').toLowerCase();
  const label = raw === 'gb2312' || raw === 'gb18030' ? 'gbk' : raw === 'utf8' ? 'utf-8' : raw;
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    // 未知编码名（如 gb_2312-80）直接按 gbk 试，再退 utf-8
    try { return new TextDecoder('gbk').decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 期号 → 日期。月号 1~12 取当月 1 日；季刊/半年刊的期号超过 12 时只保留年份。 */
function issueToDate(year, issue) {
  const y = Number(year);
  const n = Number(issue);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) return '';
  if (Number.isInteger(n) && n >= 1 && n <= 12) return `${y}-${pad2(n)}-01`;
  return `${y}-01-01`;
}

/**
 * 从文章链接里反推年月。
 * 常见的三种编码方式都能命中：
 *   Magtech   /CN/Y2025/V546/I12/20     → 2025-12
 *   勤云      view_abstract.aspx?file_no=20230504 → 2023-05
 *   CNKI DOI  .../j.cnki.1000-2995.2026.11.001    → 2026-11
 */
export function dateFromArticleUrl(url) {
  const s = String(url || '');
  let m = /\/Y(20\d{2})\/V\d+\/(?:I|N)(\d{1,2})\b/i.exec(s);
  if (m) return issueToDate(m[1], m[2]);
  m = /[?&]file_no=(\d{4})(\d{2})/i.exec(s);
  if (m) return issueToDate(m[1], m[2]);
  // 中国软科学一类：/zgrkx/Article/abstract/20260503（年 + 期 + 篇序号）
  m = /\/abstract\/(20\d{2})(\d{2})\d{2}(?:[?#]|$)/i.exec(s);
  if (m) return issueToDate(m[1], m[2]);
  m = /\.(20\d{2})\.(\d{1,2})\.\d{2,4}(?:[?#]|$)/.exec(s);
  if (m) return issueToDate(m[1], m[2]);
  return '';
}

/**
 * 页面上的「2026 年第 11 期」→ 日期。链接里没有年月时兜底。
 *
 * 只在整页**只出现一个**年期时才采用：中文期刊首页往往带一长串「2015 年第 12 期」
 * 之类的过刊导航，取了第一个就会把当期文章全标成几年前的日期（实测中国工业经济
 * 的首页会把 2015 年的过刊索引排在最前）。宁可留空，也不要给出错得离谱的日期。
 */
export function issueDateFromHtml(html) {
  const text = String(html || '');
  const found = new Set();
  const re = /(20\d{2})\s*年\s*(?:第\s*)?(\d{1,2})\s*期|(20\d{2})\s*[,，]\s*(?:No\.?|第)\s*(\d{1,2})\s*期/gi;
  let m;
  while ((m = re.exec(text))) {
    const year = m[1] || m[3];
    const issue = m[2] || m[4];
    if (issue && Number(issue) >= 1 && Number(issue) <= 12) found.add(`${year}|${Number(issue)}`);
    if (found.size > 1) return '';
  }
  const [first] = found;
  if (!first) return '';
  const [year, issue] = first.split('|');
  return issueToDate(year, issue);
}

/** 链接形态：把数字抹掉，用来把同一批文章归到一组 */
function urlShape(href) {
  try {
    const u = new URL(href);
    return `${u.host}${u.pathname.replace(/\d+/g, '#')}${u.search.replace(/\d+/g, '#')}`;
  } catch {
    return String(href).replace(/\d+/g, '#');
  }
}

function stripTracking(url) {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|spm|from|scene|share|_t)/i.test(key)) u.searchParams.delete(key);
    }
    return u.href;
  } catch {
    return String(url || '');
  }
}

/** 标题质量：中文越多、越长越像论文标题；带【】或「下载」的是附属链接 */
function titleScore(title) {
  const cjk = (title.match(/[\u4e00-\u9fa5]/g) || []).length;
  let score = cjk * 2 + Math.min(title.length, 60) * 0.3;
  if (/[【\[]/.test(title.slice(0, 2))) score -= 40;
  if (/(下载|全文|摘要|PDF|引用本文|收藏)/.test(title)) score -= 25;
  return score;
}

/**
 * 从任意「当期目录/过刊目录」页面抽文章列表。
 * 导出它是为了单测：不用真的联网也能验证分组、去噪、去重。
 */
export function parseJournalIssuePage(html, baseUrl, journal = {}) {
  const source = String(html || '');
  if (!source.trim()) return [];
  const pageDate = issueDateFromHtml(source);

  const groups = new Map();
  const anchorRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(source))) {
    const href = m[1].trim();
    const title = htmlText(m[2]);
    if (!href || href.length < 4) continue;
    if (title.length < 8 || title.length > 140) continue;
    if (NAV_TEXT.test(title)) continue;
    if ((title.match(/[\u4e00-\u9fa5]/g) || []).length < 6) continue;
    // 期刊名 + 期号的目录索引（如「2015年第12期观点摘要」）不是文章
    if (ISSUE_INDEX_TEXT.test(title) && !/(——|：|:)/.test(title)) continue;
    if (NON_ARTICLE_HREF.test(href)) continue;
    let abs;
    try { abs = new URL(href.replace(/&amp;/g, '&'), baseUrl).href; } catch { continue; }
    if (!/^https?:$/i.test(abs.slice(0, abs.indexOf(':') + 1))) continue;
    const shape = urlShape(abs);
    if (!groups.has(shape)) groups.set(shape, []);
    groups.get(shape).push({ title, url: stripTracking(abs) });
  }

  // 文章列表的形态：条目多、标题长。导航区要么条数少，要么标题短。
  const ranked = [...groups.entries()]
    .filter(([, items]) => items.length >= 3)
    .map(([shape, items]) => ({
      shape,
      items,
      count: items.length,
      avgLen: items.reduce((sum, i) => sum + i.title.length, 0) / items.length,
      score: items.length * 1.0 + (items.reduce((sum, i) => sum + i.title.length, 0) / items.length) * 0.35,
    }))
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return [];

  // 主组之外，同页还常有一组「另一编码形态」的同一批文章（如 Article / article 大小写不同）。
  // 只并入同样长标题、条目够多的组，避免把侧栏「相关文章」混进来。
  const best = ranked[0];
  const merged = [...best.items];
  for (const group of ranked.slice(1)) {
    if (group.count < 3 || group.avgLen < 12) continue;
    if (group.count > best.count * 2) continue;
    merged.push(...group.items);
  }

  // 同一篇文章可能挂了多个锚点（标题 + 「【下载全文】」），按 URL 去重并保留更像标题的那个
  const byUrl = new Map();
  for (const item of merged) {
    const prev = byUrl.get(item.url);
    if (!prev || titleScore(item.title) > titleScore(prev.title)) byUrl.set(item.url, item);
  }

  const now = new Date().toISOString();
  const journalTitle = String(journal.title || '').trim();
  return [...byUrl.values()]
    .map((item) => {
      const publishedAt = dateFromArticleUrl(item.url) || pageDate;
      return {
        id: cnArticleId(item.url),
        journalId: journal.id || '',
        journal: journalTitle,
        title: item.title.slice(0, 300),
        authors: [],
        affiliations: [],
        abstract: '',
        doi: '',
        originalUrl: item.url,
        publishedAt,
        volume: '',
        issue: '',
        pages: '',
        articleType: 'journal-article',
        source: '期刊官网',
        discoveredAt: now,
        updatedAt: now,
      };
    })
    .slice(0, MAX_ARTICLES);
}

export function cnArticleId(url) {
  const key = String(url || '').trim();
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < key.length; i += 1) {
    h1 = ((h1 ^ key.charCodeAt(i)) * 16777619) >>> 0;
    h2 = ((h2 + key.charCodeAt(i)) * 2654435761) >>> 0;
  }
  return `cn:${h1.toString(36)}${h2.toString(36).slice(0, 5)}`;
}

/**
 * 有些期刊首页只是一个跳转壳：返回 300 多字节的 HTML，里面只有一句
 * window.location.href = '.../CN/<issn>/home.shtml' 或 meta refresh。
 * 不跟这一跳就永远解析不到目录（实测科研管理、中国管理科学、系统管理学报、系统工程理论与实践都是这样）。
 */
export function nextUrlFromShell(html, baseUrl) {
  const text = String(html || '');
  if (!text.trim()) return '';
  let m = /<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["'][^"']*url\s*=\s*([^"'>\s]+)/i.exec(text);
  if (!m) m = /(?:window\.|document\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i.exec(text);
  if (!m) m = /location\.(?:replace|assign)\(\s*["']([^"']+)["']\s*\)/i.exec(text);
  if (!m) return '';
  try {
    const next = new URL(m[1].replace(/&amp;/g, '&'), baseUrl).href;
    return /^https?:/i.test(next) ? next : '';
  } catch { return ''; }
}

/**
 * 抓一本中文期刊的最新目录。
 * 失败会抛出「用户能看懂并知道下一步做什么」的错误，由 syncJournals 记进该刊的 lastError。
 */
export async function fetchCnJournalArticles(journal, { fetchImpl = globalThis.fetch, timeoutMs = 25000 } = {}) {
  const target = String(journal?.feedUrl || journal?.publisherUrl || '').trim();
  if (!target) throw new Error('该刊还没有配置目录页地址，可在「期刊管理 → 中国期刊目录页」里补上');
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持网络请求');

  const fetchOnce = async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const res = await fetchImpl(url, {
        redirect: 'follow',
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'zh-CN,zh;q=0.9' },
        signal: controller.signal,
      });
      if (res?.ok === false) {
        const tip = [403, 401].includes(res.status) ? '：站点拒绝了程序访问' : res.status === 404 ? '：目录页地址不存在或已改版' : '';
        throw new Error(`期刊官网返回 HTTP ${res.status}${tip}`);
      }
      let buffer;
      if (typeof res.arrayBuffer === 'function') buffer = new Uint8Array(await res.arrayBuffer());
      else buffer = new TextEncoder().encode(String(res.body || ''));
      if (!buffer.length) throw new Error('期刊官网返回了空页面');
      if (buffer.length > MAX_HTML) throw new Error('目录页超过 4 MB，请确认地址不是整本 PDF 或压缩包');
      const html = decodeHtml(buffer, typeof res.headers?.get === 'function' ? res.headers.get('content-type') || '' : '');
      return { html, url: res.url || url };
    } catch (error) {
      const aborted = error?.name === 'AbortError' || /abort/i.test(String(error?.message || ''));
      if (aborted) throw new Error('访问期刊官网超时（可能限流或需要代理）');
      if (/^(期刊官网返回|目录页超过)/.test(String(error?.message || ''))) throw error;
      throw new Error(`访问期刊官网失败：${error?.message || '网络错误'}`);
    } finally {
      clearTimeout(timer);
    }
  };

  // 最多跟两跳跳转壳：官网 → /CN/<issn>/home.shtml → （个别站点再一跳）
  let currentUrl = target;
  let lastHtml = '';
  const visited = new Set();
  for (let hop = 0; hop <= 2; hop += 1) {
    if (visited.has(currentUrl)) break;
    visited.add(currentUrl);
    const page = await fetchOnce(currentUrl);
    lastHtml = page.html;
    const articles = parseJournalIssuePage(page.html, page.url, journal);
    if (articles.length) return articles;
    const next = nextUrlFromShell(page.html, page.url);
    if (!next || visited.has(next)) break;
    currentUrl = next;
  }
  if (!String(lastHtml).trim()) throw new Error('期刊官网返回了空页面');
  throw new Error('目录页里没有解析出文章标题（可能改成脚本渲染或站点改版），请在「中国期刊目录页」里换成当期目录地址');
}
