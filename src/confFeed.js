// confFeed.js —— CCF 会议「官网论文集目录」抓取
//
// 为什么不用 Crossref / DBLP：
//   · Crossref 对会议论文只按 proceedings 的容器名检索，排序是「相关度」而不是出版时间，
//     拿到的常常是往届甚至别的大会的文章；IEEE / ACM 的 proceedings 元数据也缺摘要。
//   · DBLP 与 ACM DL、IEEE Xplore 都有反爬（实测 403 / 202 挑战页），不能作为每日自动同步的源。
//   · 而这些大会的**官网论文集目录**本身就是公开可抓的静态页，一次拿到当届全部论文的
//     标题、作者、原文链接（部分还给摘要与 DOI），这才是「官网爬取」的可行形态。
//
// 收录范围（每个会议一个适配器，见 CCF_CONFERENCES）：
//   nips   NeurIPS        papers.nips.cc 的当届论文表
//   pmlr   ICML / UAI / COLT  proceedings.mlr.press 的当届卷号页
//   cvf    CVPR / ICCV    openaccess.thecvf.com 的当届全量列表
//   acl    ACL / EMNLP / NAACL / COLING  aclanthology.org 的当届会议页（含摘要）
//   ijcai  IJCAI          ijcai.org/proceedings/<年>
//   usenix OSDI / FAST / ATC / NSDI / USENIX Security  technical-sessions 页
//   ecva   ECCV           ecva.net/papers.php 里的当届区块
//
// 取舍：
//   · 只取标题 / 作者 / 原文链接 /（有的话）摘要与 DOI，不下载 PDF。
//   · 一页动辄数千篇（CVPR 全量 7 MB），入库前按等距抽样压到 150 篇：
//     签到每天每会取 5 篇，150 篇够看一个月；全量入库只会把本地 JSON 撑爆。
//   · 会议论文没有「发表日期」，用「办会月份 1 号」代替，并在界面注明是会议年份月份。

import { htmlText } from './cnJournalFeed.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_HTML = 16 * 1024 * 1024;
const MAX_PAPERS = 150;
// 只要解析出论文就算这届可用；目录页是否「像论文集」由 FRONT_MATTER / 标题长度这些规则把关
const MIN_PAPERS = 1;

export const CONF_ADAPTERS = ['nips', 'pmlr', 'cvf', 'acl', 'ijcai', 'usenix', 'ecva'];

function pad2(n) {
  return String(n).padStart(2, '0');
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

export function normalizePaperTitle(title) {
  return String(title || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[“”"‘’'']/g, '')
    .toLowerCase();
}

/** 会议论文主键：会议 + 规范化标题。标题跨年重复的概率远低于「链接带签名/带期号」带来的坑。 */
export function confArticleId(venueId, title) {
  return `conf:${shortHash(`${venueId}|${normalizePaperTitle(title)}`)}`;
}

/** 作者串切分：PRML 用 ",&nbsp;"、CVF/IJCAI 用 ", "、USENIX 用 ", " 再跟单位 */
export function splitAuthors(raw) {
  return String(raw || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .split(/[;,，；]/)
    .map((name) => name.replace(/\s+/g, ' ').replace(/^[\s·*†‡]+/, '').replace(/^(?:and|&)\s+/i, '').replace(/[\s·*†‡]+$/g, '').trim())
    .filter((name) => name && name.length <= 120);
}

export function absoluteUrl(href, baseUrl) {
  try {
    const abs = new URL(String(href || '').replace(/&amp;/g, '&'), baseUrl).href;
    return /^https?:/i.test(abs) ? abs : '';
  } catch {
    return '';
  }
}

/** 等距抽样：保持顺序与覆盖面，让每天的 5 篇能轮到大目录里不同方向的论文 */
export function pickSpread(list, max = MAX_PAPERS) {
  const rows = Array.isArray(list) ? list : [];
  if (rows.length <= max) return rows;
  const stride = rows.length / max;
  const out = [];
  for (let i = 0; i < max; i += 1) out.push(rows[Math.floor(i * stride)]);
  return out;
}

// ---------- 各官网模板的解析器（纯函数，便于单测） ----------

/** NeurIPS：<li class="conference"><div class="paper-content"><a href=…>标题</a><span class="paper-authors">作者</span> */
export function parseNips(html, venue, year) {
  const out = [];
  const re = /<li class="conference"[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const block = m[1];
    const link = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!link) continue;
    const authors = /<span class="paper-authors">([\s\S]*?)<\/span>/i.exec(block);
    out.push({ title: htmlText(link[2]), url: absoluteUrl(link[1], 'https://papers.nips.cc'), authors: splitAuthors(htmlText(authors?.[1])) });
  }
  return out;
}

/** PMLR：<div class="paper"><p class="title">标题</p><p class="details"><span class="authors">作者</span>; <span class="info">PMLR 235:1-30</span></p> */
export function parsePmlr(html, venue, year, { baseUrl = 'https://proceedings.mlr.press/', volume = '' } = {}) {
  const out = [];
  for (const block of String(html || '').split('<div class="paper">').slice(1)) {
    const title = /<p class="title">([\s\S]*?)<\/p>/i.exec(block)?.[1];
    if (!title) continue;
    const authors = /<span class="authors">([\s\S]*?)<\/span>/i.exec(block)?.[1];
    const info = /<span class="info">([\s\S]*?)<\/span>/i.exec(block)?.[1];
    const abs = /<a href="([^"]+)">abs<\/a>/i.exec(block)?.[1];
    const pages = /PMLR\s+\d+\s*:\s*([\d\-–]+)/i.exec(htmlText(info || ''))?.[1] || '';
    out.push({
      title: htmlText(title),
      url: absoluteUrl(abs, baseUrl),
      authors: splitAuthors(htmlText(authors)),
      pages: pages.replace(/–/g, '-'),
      volume: volume ? `PMLR ${volume}` : '',
    });
  }
  return out;
}

/** CVF：<dt class="ptitle"><br><a href="/content/CVPR2024/html/…">标题</a></dt><dd>…query_author…</dd> */
export function parseCvf(html, venue, year) {
  const out = [];
  const re = /<dt class="ptitle">[\s\S]*?<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/dt>\s*<dd>([\s\S]*?)<\/dd>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const names = [...m[3].matchAll(/name="query_author"\s+value="([^"]*)"/gi)]
      .map((row) => htmlText(row[1]))
      .filter(Boolean);
    out.push({ title: htmlText(m[2]), url: absoluteUrl(m[1], 'https://openaccess.thecvf.com'), authors: names });
  }
  return out;
}

/** ACL Anthology：<strong><a class=align-middle href=/2024.acl-long.1/>标题</a></strong><br>作者 | 作者 … 后面跟摘要折叠块 */
export function parseAcl(html, venue, year) {
  const source = String(html || '');
  // <span class=acl-fixed-case>A</span>ssociation —— 直接去掉 span，否则 htmlText 会补出空格
  const cleanAcl = (value) => htmlText(String(value || '').replace(/<\/?span[^>]*>/gi, ''));
  const out = [];
  const re = /<strong><a class=align-middle href=(\/20\d\d\.[^>\s]+)>([\s\S]*?)<\/a><\/strong><br>([\s\S]*?)<\/div>/gi;
  let m;
  while ((m = re.exec(source))) {
    const names = [...m[3].matchAll(/<a href=\/people\/[^>]*>([\s\S]*?)<\/a>/gi)].map((row) => htmlText(row[1]));
    // 摘要紧跟着条目：<div class="card … abstract-collapse" id=abstract-…><div class="card-body p-3 small">摘要</div>
    const tail = source.slice(m.index + m[0].length, m.index + m[0].length + 400);
    const abstract = /card-body p-3 small">([\s\S]*?)<\/div>/i.exec(tail)?.[1];
    out.push({
      title: cleanAcl(m[2]),
      url: absoluteUrl(m[1], 'https://aclanthology.org'),
      authors: names.map((name) => cleanAcl(name)).filter(Boolean),
      abstract: abstract ? htmlText(abstract) : '',
    });
  }
  return out;
}

/** IJCAI：<a class="title" href="/proceedings/2024/1">标题</a><div class="authors">…</div><div class="details">Pages 3–12 · doi:…</div> */
export function parseIjcai(html, venue, year) {
  const out = [];
  for (const block of String(html || '').split('<div class="paper_wrapper').slice(1)) {
    const link = /<a class="title" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!link) continue;
    const authorBlock = /<div class="authors">([\s\S]*?)<\/div>/i.exec(block)?.[1] || '';
    const names = [...authorBlock.matchAll(/<a [^>]*>([\s\S]*?)<\/a>/gi)].map((row) => htmlText(row[1]));
    const details = htmlText(/<div class="details">([\s\S]*?)<\/div>/i.exec(block)?.[1] || '');
    const doi = /doi:\s*(10\.[^\s<]+)/i.exec(details)?.[1] || /(10\.24963\/[^\s<"']+)/i.exec(block)?.[1] || '';
    const pages = /Pages?\s*([\d\-–]+)/i.exec(details)?.[1]?.replace(/–/g, '-') || '';
    out.push({
      title: htmlText(link[2]),
      url: absoluteUrl(link[1], 'https://www.ijcai.org'),
      authors: names.filter(Boolean),
      doi,
      pages,
    });
  }
  return out;
}

/** USENIX：<article class="node node-paper">…<h2><a href="/conference/osdi24/presentation/…">标题</a></h2>…<p>作者, <em>单位</em></p> */
export function parseUsenix(html, venue, year, { slug = 'osdi' } = {}) {
  const yy = String(year).slice(2);
  const prefix = `/conference/${slug}${yy}/presentation/`;
  const out = [];
  for (const block of String(html || '').split('<article id=').slice(1)) {
    const link = /<h2>\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!link || !link[1].includes(prefix)) continue;
    // keynote / panel / awards / BOF 之类的环节不是论文，投递出去只会干扰阅读
    if (/\/presentation\/(keynote|panel|award|bof|lunch|break|opening|closing)/i.test(link[1])) continue;
    // 2026 起 USENIX 改用了 field-paper-people-text，旧页面是 field-presented-by，两个都认
    const present = /field-name-field-(?:paper-people-text|presented-by)[\s\S]*?<p>([\s\S]*?)<\/p>/i.exec(block)?.[1] || '';
    const abstract = /field-name-field-paper-description-long[\s\S]*?<p>([\s\S]*?)<\/p>/i.exec(block)?.[1] || '';
    out.push({
      title: htmlText(link[2]),
      url: absoluteUrl(link[1], 'https://www.usenix.org'),
      // 作者行是「A, B, <em>单位</em>」：单位先剔掉，否则会被当成一个作者
      authors: splitAuthors(String(present).replace(/<em>[\s\S]*?<\/em>/gi, '')),
      abstract: abstract ? htmlText(abstract) : '',
    });
  }
  return out;
}

/** ECVA（ECCV）：整页按年份分块，<dt class="ptitle"><a href=papers/eccv_2024/…>标题</a></dt><dd>作者</dd> */
export function parseEcva(html, venue, year) {
  const source = String(html || '');
  const start = source.indexOf(`ECCV ${year} Papers`);
  if (start < 0) return [];
  const rest = source.slice(start);
  const next = rest.indexOf('<button class="accordion"', 10);
  const section = next > 0 ? rest.slice(0, next) : rest;
  const out = [];
  const re = /<dt class="ptitle">[\s\S]*?<a href="?([^">\s]+)"?[^>]*>\s*([\s\S]*?)<\/a>\s*<\/dt>\s*<dd>([\s\S]*?)<\/dd>/gi;
  let m;
  while ((m = re.exec(section))) {
    const after = section.slice(m.index, m.index + 1200);
    const doi = /10\.1007\/[0-9Xx\-_.]+/.exec(after)?.[0] || '';
    out.push({
      title: htmlText(m[2]),
      url: absoluteUrl(m[1], 'https://www.ecva.net'),
      authors: splitAuthors(htmlText(m[3])),
      doi,
    });
  }
  return out;
}

// ---------- 网络 ----------

/** 论文集的前言、目录、编者按不是论文，投递时会被当成「今天的第一篇」 */
const FRONT_MATTER = /^(proceedings\s+of\b|front\s*matter|preface\b|editors?'?\s*(note|introduction)|message\s+from\b|table\s+of\s+contents|author\s+index|subject\s+index|copyright\b)/i;

function toArticles(venue, rows, { year, url }) {
  const stamp = new Date().toISOString();
  const month = Number(venue.month) || 1;
  const publishedAt = `${year}-${pad2(month)}-01`;
  const seen = new Set();
  const articles = [];
  for (const row of rows) {
    const title = String(row?.title || '').replace(/\s+/g, ' ').trim();
    if (!title || title.length < 8) continue;
    if (FRONT_MATTER.test(title)) continue;
    const key = normalizePaperTitle(title);
    if (seen.has(key)) continue;
    seen.add(key);
    articles.push({
      id: confArticleId(venue.id, title),
      journalId: venue.id,
      journal: `${venue.shortTitle} ${year}`,
      title: title.slice(0, 300),
      authors: Array.isArray(row.authors) ? row.authors.slice(0, 40) : [],
      affiliations: [],
      abstract: String(row.abstract || '').slice(0, 4000),
      doi: String(row.doi || ''),
      originalUrl: String(row.url || ''),
      publishedAt,
      volume: String(row.volume || ''),
      issue: '',
      pages: String(row.pages || ''),
      articleType: 'conference-paper',
      source: '会议官网',
      discoveredAt: stamp,
      updatedAt: stamp,
    });
  }
  return articles;
}

/**
 * 候选年份：按办会月份判断「今年这届论文集出了没有」。
 * 例如 NeurIPS（12 月）在 11 月还没论文集，直接从去年试起，省掉一次必然 404 的请求。
 */
export function candidateYears(venue, now = new Date()) {
  const month = Number(venue?.month) || 1;
  const year = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const start = currentMonth >= month + 1 ? year : year - 1;
  return [start, start - 1, start - 2];
}

async function fetchHtml(url, { fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en;q=0.9' },
      signal: controller.signal,
    });
    if (res?.ok === false) {
      const tip = [403, 401].includes(res.status) ? '：站点拒绝了程序访问' : res.status === 404 ? '：这一届的目录页不存在' : '';
      throw new Error(`会议官网返回 HTTP ${res.status}${tip}`);
    }
    let buffer;
    if (typeof res.arrayBuffer === 'function') buffer = new Uint8Array(await res.arrayBuffer());
    else if (typeof res.text === 'function') buffer = new TextEncoder().encode(await res.text());
    else buffer = new TextEncoder().encode(String(res.body || ''));
    if (!buffer.length) throw new Error('会议官网返回了空页面');
    if (buffer.length > MAX_HTML) throw new Error('会议目录页超过 16 MB，已中止');
    return new TextDecoder('utf-8').decode(buffer);
  } catch (error) {
    const aborted = error?.name === 'AbortError' || /abort/i.test(String(error?.message || ''));
    if (aborted) throw new Error('访问会议官网超时（可能限流，稍后重试）');
    if (/^(会议官网返回|会议目录页超过)/.test(String(error?.message || ''))) throw error;
    throw new Error(`访问会议官网失败：${error?.message || '网络错误'}`);
  } finally {
    clearTimeout(timer);
  }
}

// PMLR 的卷号只出现在目录页，且每年递增，缓存 6 小时避免每次同步都拉一遍
const pmlrIndexCache = { at: 0, text: '' };

async function pmlrVolumes({ fetchImpl, timeoutMs }) {
  if (pmlrIndexCache.text && Date.now() - pmlrIndexCache.at < 6 * 3600 * 1000) return pmlrIndexCache.text;
  const html = await fetchHtml('https://proceedings.mlr.press/', { fetchImpl, timeoutMs });
  pmlrIndexCache.at = Date.now();
  pmlrIndexCache.text = html;
  return html;
}

/** 在 PMLR 总目录里找某会议最近一卷：返回 { volume, year } */
export function pickPmlrVolume(indexHtml, match) {
  const re = /<a href="v(\d+)">[\s\S]*?<\/a>([\s\S]*?)<\/li>/gi;
  const wanted = match instanceof RegExp ? match : new RegExp(String(match || ''), 'i');
  let best = null;
  let m;
  while ((m = re.exec(String(indexHtml || '')))) {
    const text = htmlText(m[2]);
    if (!wanted.test(text)) continue;
    const year = Number((/(20\d{2})/.exec(text) || [])[1]) || 0;
    const volume = Number(m[1]) || 0;
    if (!best || year > best.year || (year === best.year && volume > best.volume)) best = { volume, year };
  }
  return best;
}

/**
 * 抓一个会议当届的论文目录。失败抛出可直接展示的中文原因。
 * 返回的数组上挂 `meta = { url, year }`，由 syncJournals 写进同步记录。
 */
export async function fetchConferenceArticles(venue, { fetchImpl = globalThis.fetch, timeoutMs = 120000, now = new Date(), maxPapers = MAX_PAPERS } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持网络请求');
  const conf = venue?.conf || {};
  const adapter = String(conf.adapter || '');
  if (!CONF_ADAPTERS.includes(adapter)) throw new Error('该会议还没有配置官网适配器');
  const errors = [];
  const years = candidateYears(venue, now);

  const finish = (rows, year, url) => {
    if (!rows.length) return null;
    const articles = toArticles(venue, pickSpread(rows, maxPapers), { year, url });
    if (articles.length < MIN_PAPERS) return null;
    articles.meta = { url, year };
    return articles;
  };

  if (adapter === 'pmlr') {
    const index = await pmlrVolumes({ fetchImpl, timeoutMs });
    const picked = pickPmlrVolume(index, conf.match);
    if (!picked) throw new Error('PMLR 目录里没找到该会议的卷号（可能改了命名）');
    const url = `https://proceedings.mlr.press/v${picked.volume}/`;
    const html = await fetchHtml(url, { fetchImpl, timeoutMs });
    const rows = parsePmlr(html, venue, picked.year, { baseUrl: url, volume: String(picked.volume) });
    const done = finish(rows, picked.year, url);
    if (!done) throw new Error('PMLR 当届卷页里没有解析出论文标题');
    return done;
  }

  for (const year of years) {
    let url = '';
    let rows = [];
    try {
      if (adapter === 'nips') {
        url = `https://papers.nips.cc/paper_files/paper/${year}`;
        rows = parseNips(await fetchHtml(url, { fetchImpl, timeoutMs }), venue, year);
      } else if (adapter === 'cvf') {
        url = `https://openaccess.thecvf.com/${conf.series}${year}?day=all`;
        rows = parseCvf(await fetchHtml(url, { fetchImpl, timeoutMs }), venue, year);
      } else if (adapter === 'acl') {
        url = `https://aclanthology.org/events/${conf.slug}-${year}/`;
        rows = parseAcl(await fetchHtml(url, { fetchImpl, timeoutMs }), venue, year);
      } else if (adapter === 'ijcai') {
        url = `https://www.ijcai.org/proceedings/${year}`;
        rows = parseIjcai(await fetchHtml(url, { fetchImpl, timeoutMs }), venue, year);
      } else if (adapter === 'ecva') {
        url = 'https://www.ecva.net/papers.php';
        rows = parseEcva(await fetchHtml(url, { fetchImpl, timeoutMs }), venue, year);
      } else if (adapter === 'usenix') {
        const yy = String(year).slice(2);
        url = `https://www.usenix.org/conference/${conf.slug}${yy}/technical-sessions`;
        rows = parseUsenix(await fetchHtml(url, { fetchImpl, timeoutMs }), venue, year, { slug: conf.slug });
      }
    } catch (error) {
      const message = error?.message || '请求失败';
      // 超时是网络/限流问题，换一年再试只会再罚站一次（ACL 一页 10 MB），直接报错更有用
      if (/超时/.test(message)) throw error;
      errors.push(`${year}：${message}`);
      continue;
    }
    const done = finish(rows, year, url);
    if (done) return done;
    errors.push(`${year}：目录页里没有解析出论文`);
  }
  throw new Error(errors.slice(0, 2).join('；') || '没有找到该会议的论文集');
}
