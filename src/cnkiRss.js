// cnkiRss.js —— 中国知网期刊 RSS（rss.cnki.net）
//
// 为什么用它：
//   NSFC 管理科学部 A 类 22 种中文刊在 Crossref / OpenAlex 基本查不到，抓官网目录又要为每家站点
//   处理 GBK、脚本跳转和各式模板。知网自己有按刊的 RSS，一次拿到「最新 20 条」，
//   并且带标题、作者、摘要节选和发布时间——比官网目录多两样（作者、摘要），稳定得多。
//
// 地址形态：https://rss.cnki.net/knavi/rss/<刊代码>?pcode=CJFD,CCJD
//   <刊代码> 是知网内部的 4 位刊名缩写（如 管理科学学报 = JCYJ、管理世界 = GLSJ、中国工业经济 = GGYY），
//   跟拼音/刊名不对应，只能逐刊核对（本文件导出的 CNKI_CODES 已全部实测过 channel title）。
//
// 已知限制（都做了对应处理）：
//   1. 条目里的 <link> 带一次性签名参数 v=...，同一篇每次请求都不同 → **不能拿链接当主键**，
//      否则每次同步都当成新文章，签到会重复投递。主键改用「期刊 + 规范化标题」。
//   2. <description> 是摘要**节选**（结尾带「...」），不是全文；卡片上说明「摘要节选」。
//   3. 一次只回 20 条，且没有期号/卷号。
//   4. 列表里混着「征文启事 / 欢迎订阅 / 培训课程 / 喜报」等非论文条目，必须过滤，
//      否则签到会把一篇通知当成论文投递给用户。

import { htmlText, decodeHtml } from './cnJournalFeed.js';

const FEED_BASE = 'https://rss.cnki.net/knavi/rss/';
const MAX_HTML = 2 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 22 本刊的知网代码（2026-11 实测：逐个拉 RSS 并核对 channel title 是否为本刊）。
 * 管理科学（哈工大）没找到可用代码（GLKX 被《高师理科学刊》占用），继续走官网目录。
 */
export const CNKI_CODES = {
  'cn-jmsc': 'JCYJ', // 管理科学学报
  'cn-setp': 'XTLL', // 系统工程理论与实践
  'cn-mw': 'GLSJ', // 管理世界
  'cn-qte': 'SLJY', // 数量经济技术经济研究
  'cn-ssc': 'ZGRK', // 中国软科学
  'cn-jryj': 'JRYJ', // 金融研究
  'cn-zgglkx': 'ZGGK', // 中国管理科学
  'cn-jse': 'XTGC', // 系统工程学报
  'cn-kjyj': 'KJYJ', // 会计研究
  'cn-xtglxb': 'XTGL', // 系统管理学报
  'cn-glpl': 'ZWGD', // 管理评论
  'cn-glgcxb': 'GLGU', // 管理工程学报
  'cn-nkglpl': 'LKGP', // 南开管理评论
  'cn-kygl': 'KYGL', // 科研管理
  'cn-qbxb': 'QBXB', // 情报学报
  'cn-ggglxb': 'GGGL', // 公共管理学报
  'cn-yc': 'YUCE', // 预测（2022 年起更名《工程管理科技前沿》，知网代码沿用）
  'cn-ycygl': 'YCGL', // 运筹与管理
  'cn-kxxyj': 'KXYJ', // 科学学研究
  'cn-ciej': 'GGYY', // 中国工业经济
  'cn-ncyjwt': 'NJWT', // 农业经济问题
};

/** 非论文条目：征稿/征文启事、订阅广告、培训与会议通知、喜报、勘误声明等 */
const NOTICE_TEXT = /(征稿启事|征文启事|征稿通知|征稿|稿约|投稿须知|欢迎订阅|订阅|喜报|讣告|招聘|启事|声明|更正|勘误|致谢|培训课程|工作坊|会议通知|研讨会通知|征订)/;

export function cnkiFeedUrl(code) {
  return `${FEED_BASE}${encodeURIComponent(String(code || '').trim())}?pcode=CJFD,CCJD`;
}

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

/** 取第一个匹配的标签内容（CDATA 也吃） */
function tag(xml, name) {
  const re = new RegExp(`<${name}>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${name}>`, 'i');
  const m = re.exec(xml);
  return m ? m[1].trim() : '';
}

/**
 * 知网 RSS 的文本是**双重转义**的：摘要里标注来源的 `<正>` 写成 `&amp;lt;正&amp;gt;`，
 * 化学式/上标写成 `&amp;lt;sup&amp;gt;®&amp;lt;/sup&amp;gt;`。只解一次会把这些标签原样留在卡片上，
 * 所以「解实体 → 去标签」反复做，直到不再有残余标签（实测最多两层）。
 */
function rssText(raw) {
  let text = htmlText(decodeEntities(raw));
  for (let i = 0; i < 3 && /<[^>]+>/.test(text); i += 1) text = htmlText(text);
  // 去标签时标签会被替换成空格，中文标点旁会留下多余空格（如「AICPA ® 」），这里收干净
  return text
    .replace(/\s+([®™©，。；：、！？）】》」』])/g, '$1')
    .replace(/([（【《「『])\s+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 知网 RSS 的 pubDate 是 GMT（如 Sat, 14 Nov 2026 16:00:00 GMT），
 * 而知网实际是北京时间当天 0 点发布，直接取 UTC 日期会整体早一天。
 * 这里按北京时间换算成 YYYY-MM-DD（应用内 publishedAt 统一是日期字符串）。
 */
export function cnkiDateToDay(pubDate, offsetMinutes = 480) {
  const ms = Date.parse(String(pubDate || ''));
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + offsetMinutes * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 标题规范化：全角/半角标点、空白差异不应产生两条记录 */
export function normalizeCnkiTitle(title) {
  return String(title || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[“”"‘’'']/g, '')
    .replace(/[（(]/g, '(').replace(/[）)]/g, ')')
    .replace(/[：:]/g, ':')
    .toLowerCase();
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

/**
 * 文章主键：期刊 + 规范化标题。
 * 不用链接，因为知网链接带一次性签名（见文件头说明）；也不用标题+日期，
 * 因为同一篇会在相邻两期重复出现在 RSS 里时日期会变，会造成重复投递。
 */
export function cnkiArticleId(journalId, title) {
  return `cnk:${shortHash(`${String(journalId || '')}|${normalizeCnkiTitle(title)}`)}`;
}

function authorsOf(raw) {
  return String(raw || '')
    .split(/[;；]/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * 解析一份知网期刊 RSS。
 * 返回与 Crossref / 官网目录**同构**的文章对象，交给 mergeArticles 统一去重排序。
 */
export function parseCnkiRss(xml, journal = {}, { now = new Date() } = {}) {
  const text = String(xml || '');
  const journalId = String(journal.id || '');
  const journalTitle = String(journal.title || '').trim();
  const items = text.split(/<item\b[^>]*>/i).slice(1);
  const stamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const seen = new Set();
  const out = [];
  for (const raw of items) {
    const title = rssText(tag(raw, 'title')).slice(0, 300);
    if (!title) continue;
    const key = normalizeCnkiTitle(title);
    if (key.length < 4) continue;
    // 征稿启事 / 订阅广告 / 会议通知等不是论文，投递时会造成干扰
    if (NOTICE_TEXT.test(title)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    // 摘要节选：知网截断处是「...」，去掉尾部省略号，卡片上另注明「节选」
    const abstract = rssText(tag(raw, 'description')).replace(/(\.{3}|…)$/, '').trim();
    out.push({
      id: cnkiArticleId(journalId, title),
      journalId,
      journal: journalTitle,
      title,
      authors: authorsOf(rssText(tag(raw, 'author'))),
      affiliations: [],
      abstract,
      // 知网 RSS 不提供 DOI
      doi: '',
      originalUrl: decodeEntities(tag(raw, 'link')),
      publishedAt: cnkiDateToDay(tag(raw, 'pubDate')),
      volume: '',
      issue: '',
      pages: '',
      articleType: 'journal-article',
      source: '知网 RSS',
      abstractExcerpt: true,
      discoveredAt: stamp,
      updatedAt: stamp,
    });
  }
  // RSS 本身按时间倒序，但个别刊会插入「最新录用」在中间，这里统一排序
  return out.sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')));
}

/**
 * 抓一本刊的知网 RSS。失败抛出可直接展示给用户的中文原因。
 */
export async function fetchCnkiJournalArticles(journal, { fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  const code = String(journal?.cnkiCode || '').trim();
  if (!code) throw new Error('该刊还没有配置知网代码');
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持网络请求');
  const url = cnkiFeedUrl(code);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  let res;
  try {
    res = await fetchImpl(url, {
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error?.name === 'AbortError' || /abort/i.test(String(error?.message || ''));
    throw new Error(aborted ? '知网 RSS 请求超时（可能限流，稍后重试）' : `知网 RSS 请求失败：${error?.message || '网络错误'}`);
  } finally {
    clearTimeout(timer);
  }
  if (res?.ok === false) {
    const tip = [403, 401].includes(res.status) ? '：知网拒绝了本次请求，稍后重试' : res.status === 404 ? '：该刊的知网代码可能已变更' : '';
    throw new Error(`知网 RSS 返回 HTTP ${res.status}${tip}`);
  }
  let buffer;
  if (typeof res.arrayBuffer === 'function') buffer = new Uint8Array(await res.arrayBuffer());
  else buffer = new TextEncoder().encode(String(res.body || ''));
  if (!buffer.length) throw new Error('知网 RSS 返回了空内容（该刊可能已停用 RSS）');
  if (buffer.length > MAX_HTML) throw new Error('知网 RSS 返回内容异常大，已中止');
  const contentType = typeof res.headers?.get === 'function' ? res.headers.get('content-type') || '' : '';
  const xml = decodeHtml(buffer, contentType || 'application/xml;charset=utf-8');
  if (!/<item\b/i.test(xml)) {
    throw new Error('知网 RSS 里没有条目（可能该刊未开通 RSS，或代码已变更）');
  }
  const articles = parseCnkiRss(xml, journal);
  if (!articles.length) {
    // 有 <item> 但全被判成通知：不算失败，但要让调用方知道这期没论文
    return [];
  }
  return articles;
}
