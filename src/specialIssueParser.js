// Parse nested publisher markup without treating a whole list as one SI card.
import { parseDocument, DomUtils } from 'htmlparser2';
import { cfpPageEvidence } from './specialIssueSourcePolicy.js';

const SIGNAL = /special[\s-]+issue|call[\s-]+for[\s-]+papers|research[\s-]+topic|guest[\s-]+edit|专刊|特刊|征稿|\bcfp\b/i;
const GENERIC = /^(?:special issues?|calls? for papers|open calls?|research topics?|view all|read more|learn more|details|征稿|专刊)$/i;
const SKIP = new Set(['script', 'style', 'noscript', 'svg', 'nav', 'footer', 'aside']);
const BLOCK = new Set(['p', 'li', 'div', 'article', 'section', 'h1', 'h2', 'h3', 'h4', 'tr', 'br']);
const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();

function contains(parent, child) {
  for (let node = child; node; node = node.parent) if (node === parent) return true;
  return false;
}

function walk(node, predicate, result = []) {
  if (SKIP.has(node.name)) return result;
  if (node.name === 'header' && !insideArticle(node)) return result;
  if (predicate(node)) result.push(node);
  for (const child of node.children || []) walk(child, predicate, result);
  return result;
}

function text(node) {
  if (!node || SKIP.has(node.name)) return '';
  if (node.name === 'header' && !insideArticle(node)) return '';
  if (node.type === 'text') return node.data;
  const s = (node.children || []).map(text).join('');
  return BLOCK.has(node.name) ? '\n' + s + '\n' : s;
}

function insideArticle(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === 'main' || parent.name === 'article') return true;
  }
  return false;
}

function urlOf(href, base) {
  if (!String(href || '').trim()) return '';
  try {
    const u = new URL(href, base);
    if (!/^https?:$/.test(u.protocol)) return '';
    u.hash = '';
    return u.href;
  } catch { return ''; }
}

export function publisherCandidates(html, baseUrl, { detail = false } = {}) {
  const doc = parseDocument(String(html || ''), { decodeEntities: true });
  const headings = walk(doc, (n) => /^h[1-4]$/.test(n.name));
  const anchors = walk(doc, (n) => n.name === 'a' && n.attribs?.href);
  const pageSignal = SIGNAL.test(clean(headings.slice(0, 4).map(text).join(' '))) || SIGNAL.test(baseUrl);
  const candidates = [];
  const seen = new Set();
  const add = (title, body, href, block = null) => {
    const url = urlOf(href, baseUrl);
    title = clean(title);
    if (!title || GENERIC.test(title) || title.length < 8 || !url) return;
    if (/\/(?:toc|loi)\//i.test(new URL(url).pathname)) return;
    if (/\b(?:published special issue|submissions? closed|call (?:is )?closed)\b/i.test(body)) return;
    const key = url + '|' + title.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const journalNames = block ? walk(block, (n) => n.name === 'a' && /\/journal\//i.test(n.attribs?.href || '')).map((n) => clean(text(n))) : [];
    candidates.push({ title, text: body, href: url, journalNames, detail: url === urlOf(baseUrl, baseUrl) });
  };
  // Springer collections are one call with related articles, not a CFP list.
  let pageUrl;
  try { pageUrl = new URL(baseUrl); } catch { /* Pasted content may have no source URL. */ }
  if (pageUrl?.hostname === 'link.springer.com' && /^\/collections\/[^/]+\/?$/i.test(pageUrl.pathname)) {
    const h1 = headings.find((node) => node.name === 'h1');
    const main = walk(doc, (node) => node.name === 'main')[0] || doc;
    const deadline = DomUtils.findOne((node) => node.attribs?.['data-test'] === 'submission-deadline', doc.children);
    if (h1 && cfpPageEvidence(html, baseUrl).confirmed) add(text(h1), text(main) + '\n' + text(deadline), baseUrl);
    return candidates;
  }
  const linked = anchors.filter((a) => {
    const label = clean(text(a));
    const href = a.attribs.href;
    return label.length >= 8 && !GENERIC.test(label)
      && (SIGNAL.test(label + ' ' + href) || (pageSignal && headings.some((h) => contains(h, a) || contains(a, h))));
  });
  for (const a of linked.slice(0, 200)) {
    let block = a;
    for (let p = a.parent; p && p.name !== 'body'; p = p.parent) {
      const count = walk(p, (n) => linked.includes(n)).length;
      if (count > 1) break;
      block = p;
      if (['li', 'article', 'tr'].includes(p.name)) break;
    }
    add(text(a), text(block), a.attribs.href, block);
  }
  // Some publishers link only a generic "details" button below the topic heading.
  for (const h of headings.filter((n) => n.name !== 'h1')) {
    const title = clean(text(h));
    if (GENERIC.test(title) || (!pageSignal && !SIGNAL.test(title))) continue;
    let block = h;
    for (let p = h.parent; p && p.name !== 'body'; p = p.parent) {
      if (walk(p, (n) => /^h[1-4]$/.test(n.name)).length > 1) break;
      block = p;
      if (['li', 'article', 'tr'].includes(p.name)) break;
    }
    const links = walk(block, (n) => n.name === 'a' && n.attribs?.href);
    const link = links.find((a) => /details|read more|learn more/i.test(clean(text(a)))) || links[0];
    if (link && !candidates.some((c) => c.href === urlOf(link.attribs.href, baseUrl))) {
      add(title, text(block), link.attribs.href);
    }
  }
  // A detail page often has a plain topic title and the SI marker in its body.
  const h1 = headings.find((n) => n.name === 'h1');
  if (h1 && !GENERIC.test(clean(text(h1))) && (detail || linked.length === 0)) {
    const main = walk(doc, (n) => n.name === 'main')[0]
      || walk(doc, (n) => n.name === 'article')[0]
      || walk(doc, (n) => n.name === 'body')[0] || doc;
    const body = text(main);
    const isTandf = /^https:\/\/callforpapers\.taylorandfrancis\.com\/special_issues\//i.test(baseUrl);
    const topic = isTandf ? headings.find((n) => n.name === 'h2' && !GENERIC.test(clean(text(n)))) || h1 : h1;
    if (SIGNAL.test(body)) add(text(topic), body, baseUrl, main);
  }
  return candidates.slice(0, 200);
}

/**
 * T&F 官方 SI 详情页：每页就是一条专刊，标题在 <title>/<h1>，期刊名有专门字段。
 * 用整页正文抽取字段，避免通用启发式把导航链接（"View all Calls for Papers"）误当 SI。
 */
export function officialSiDetailCandidates(html, baseUrl, journal = null) {
  const doc = parseDocument(String(html || ''), { decodeEntities: true });
  const headings = walk(doc, (n) => /^h[1-2]$/.test(n.name));
  // <title> is the real SI title; h1 on these pages is usually the journal name.
  const titleTag = walk(doc, (n) => n.name === 'title')[0];
  const h1 = headings.find((n) => /^h1$/.test(n.name));
  const headingTexts = headings.map((n) => clean(text(n))).filter(Boolean);
  const titleTagText = clean(titleTag ? text(titleTag) : '');
  const h1Text = clean(h1 ? text(h1) : '');
  const journalFromPage = headingTexts.find((h) => h !== titleTagText && h.length < 90 && !/special issue|editor|deadline|submit/i.test(h)) || '';
  // 真实 T&F 详情页用 <title> 作 SI 短标题、h1 作期刊名；旧 fixture / 部分页面没有 <title>，
  // 此时取 h2（SI 标题），避免误把 h1 的期刊名当标题。
  const h2Text = clean(headings.filter((n) => /^h2$/.test(n.name)).map((n) => text(n)).join(' '));
  const rawTitle = titleTagText && titleTagText !== journalFromPage
    ? titleTagText
    : (h2Text || (h1Text && h1Text !== journalFromPage ? h1Text : titleTagText));
  if (!rawTitle || /^(just a moment|access denied|attention required)/i.test(rawTitle)) return [];
  const journalName = journal?.title || journalFromPage;
  const body = clean(text(walk(doc, (n) => n.name === 'main')[0] || doc));
  const deadlineMatch = body.match(/(?:submission\s+deadline|deadline)\s*[:\-–]?\s*([0-9]{1,2}\s+[A-Za-z]+\s+[0-9]{4}|[A-Za-z]+\s+[0-9]{1,2},?\s+[0-9]{4}|\d{4}-\d{2}-\d{2})/i);
  const deadline = deadlineMatch?.[1] || '';
  const description = body.replace(rawTitle, '').replace(/special issue\s*/i, '').replace(/submit your manuscript.*$/i, '').trim().slice(0, 12000);
  if (!/special issue|deadline/i.test(body + ' ' + rawTitle)) return [];
  return [{ title: rawTitle, text: [rawTitle, journalName, deadline, description].filter(Boolean).join('\n'), href: baseUrl, journalName }];
}

export function publisherPageError(html) {
  const s = String(html || '');
  if (/^\s*[\[{]/.test(s)) return '';
  if (/<(?:title|h1|h2)\b[^>]*>\s*(?:(?:error\s+)?404(?:\s*[-:]?\s*page not found)?|page not found)\s*(?:<\/|[|])/i.test(s)) {
    return 'HTTP 404：征稿页已移除或地址有误，请更新该刊征稿页';
  }
  if (/<title[^>]*>[^<]*(?:just a moment|access denied|attention required|robot check|security check)/i.test(s)
    || /cf-chl-widget|id=["']challenge-form|enable javascript and cookies to continue|captcha-container/i.test(s)
    || /verify (?:that )?you are human/i.test(text(parseDocument(s)))) {
    return '出版社人机验证或访问限制；请在浏览器打开原文后使用「从网页粘贴」导入，或更换官方征稿源';
  }
  return '';
}

/** Journal homepages may link their CFP pages in the main navigation. */
export function discoverJournalCfpPages(html, baseUrl) {
  const journal = new URL(baseUrl);
  const journalPath = /\/(?:page\/)?journal\/([^/]+)/i.exec(journal.pathname)?.[1]?.toLowerCase();
  const pages = new Set();
  const doc = parseDocument(String(html || ''));
  const visit = (node) => {
    if (['script', 'style', 'footer'].includes(node.name)) return;
    if (node.name === 'a' && node.attribs?.href && /calls?\s+for\s+papers|open\s+(?:calls|special issues)/i.test(clean(text(node)))) {
      const href = urlOf(node.attribs.href, baseUrl);
      if (href && mayFetchDetail(href, baseUrl)) {
        const target = new URL(href);
        const targetJournal = /\/(?:page\/)?journal\/([^/]+)/i.exec(target.pathname)?.[1]?.toLowerCase();
        const sameJournal = !journalPath || targetJournal === journalPath;
        const isWiley = journal.hostname === 'onlinelibrary.wiley.com';
        const isArchive = /\/(?:toc|loi)\/|archive|published[-_]special[-_]issues/i.test(target.pathname);
        const isCall = /calls?[-_]?(?:for[-_]?)?papers|open[-_](?:calls|special[-_]issues)|\/collections\//i.test(target.pathname);
        // Wiley's shared CFP URL is obsolete. Other publishers may link a
        // journal-specific call on an official /calls-for-papers/ topic page.
        if (!isArchive && (sameJournal || (!isWiley && !targetJournal)) && isCall) {
          pages.add(href);
        }
      }
    }
    for (const child of node.children || []) visit(child);
  };
  visit(doc);
  return [...pages];
}

export function mayFetchDetail(url, sourceUrl) {
  try {
    const target = new URL(url), source = new URL(sourceUrl);
    return /^https?:$/.test(target.protocol) && target.origin === source.origin && target.href !== source.href;
  } catch { return false; }
}
