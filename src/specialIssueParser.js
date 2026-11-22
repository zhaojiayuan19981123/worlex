// Parse nested publisher markup without treating a whole list as one SI card.
import { parseDocument } from 'htmlparser2';

const SIGNAL = /special[\s-]+issue|call[\s-]+for[\s-]+papers|research[\s-]+topic|guest[\s-]+edit|专刊|特刊|征稿|\bcfp\b/i;
const GENERIC = /^(?:special issues?|calls? for papers|open calls?|research topics?|view all|read more|learn more|details|征稿|专刊)$/i;
const SKIP = new Set(['script', 'style', 'noscript', 'svg', 'nav', 'header', 'footer', 'aside']);
const BLOCK = new Set(['p', 'li', 'div', 'article', 'section', 'h1', 'h2', 'h3', 'h4', 'tr', 'br']);
const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();

function contains(parent, child) {
  for (let node = child; node; node = node.parent) if (node === parent) return true;
  return false;
}

function walk(node, predicate, result = []) {
  if (SKIP.has(node.name)) return result;
  if (predicate(node)) result.push(node);
  for (const child of node.children || []) walk(child, predicate, result);
  return result;
}

function text(node) {
  if (!node || SKIP.has(node.name)) return '';
  if (node.type === 'text') return node.data;
  const s = (node.children || []).map(text).join('');
  return BLOCK.has(node.name) ? '\n' + s + '\n' : s;
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
  const add = (title, body, href) => {
    const url = urlOf(href, baseUrl);
    title = clean(title);
    if (!title || GENERIC.test(title) || title.length < 8 || !url) return;
    const key = url + '|' + title.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ title, text: body, href: url });
  };
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
    add(text(a), text(block), a.attribs.href);
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
    if (SIGNAL.test(body)) add(text(topic), body, baseUrl);
  }
  return candidates.slice(0, 200);
}

export function publisherPageError(html) {
  const s = String(html || '');
  if (/<title[^>]*>[^<]*(?:just a moment|access denied|attention required|robot check|security check)/i.test(s)
    || /cf-chl-widget|id=["']challenge-form|enable javascript and cookies to continue|captcha-container/i.test(s)
    || /verify (?:that )?you are human/i.test(text(parseDocument(s)))) {
    return '出版社人机验证或访问限制；请在浏览器打开原文后使用「从网页粘贴」导入，或更换官方征稿源';
  }
  return '';
}

export function mayFetchDetail(url, sourceUrl) {
  try {
    const target = new URL(url), source = new URL(sourceUrl);
    return /^https?:$/.test(target.protocol) && target.origin === source.origin && target.href !== source.href;
  } catch { return false; }
}
