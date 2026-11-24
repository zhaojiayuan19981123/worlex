import { parseDocument, DomUtils } from 'htmlparser2';

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const OMIT = new Set(['script', 'style', 'noscript', 'nav', 'footer', 'header', 'aside', 'svg']);
const CALL = /special\s+issue|call\s+for\s+(?:papers|submissions)|curated\s+collection|专刊|征稿|特刊/i;
const DETAIL = /\/special-issue\/[^/?#]+|\/calls?-for-papers(?:\/|-)[^/?#]+|\/event\/[^/?#]+-call-for-special-issue-papers-/i;
const DEADLINE = /submission\s+(?:deadline|window)|deadline(?:\s+for\s+(?:submissions|papers|manuscripts))?|manuscripts?\s+due|submit\s+by|closing\s+date|投稿截止|截稿|截止日期/i;

function walk(node, predicate, result = []) {
  if (OMIT.has(node.name)) return result;
  if (predicate(node)) result.push(node);
  for (const child of node.children || []) walk(child, predicate, result);
  return result;
}

function text(node) {
  if (!node || OMIT.has(node.name)) return '';
  if (node.type === 'text') return node.data || '';
  const value = (node.children || []).map(text).join(' ');
  return /^(p|div|li|article|section|h[1-6]|tr|br)$/.test(node.name || '') ? value + '\n' : value;
}

function absolute(href, base) {
  try {
    const url = new URL(href, base);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return '';
    url.hash = '';
    return url.href;
  } catch { return ''; }
}

const anchors = (node) => walk(node, (n) => n.name === 'a' && !!n.attribs?.href);
function detailLink(node, base) {
  const url = absolute(node.attribs?.href, base);
  if (!url) return false;
  const { hostname, pathname } = new URL(url);
  if (base.startsWith('https://www.aom.org/event-calendar')) {
    return hostname === 'www.aom.org' && /^\/event\/amp-call-for-special-issue-papers-/i.test(pathname);
  }
  if (base === 'https://www.ama.org/journal-of-public-policy-marketing/') {
    return hostname === 'www.ama.org' && /\/call-for-papers-journal-of-public-policy-marketing-/i.test(pathname);
  }
  return DETAIL.test(pathname) || CALL.test(clean(text(node)));
}

/** Read visible HTML structure, not regex-delimited nested containers. */
export function extractCallCandidates(html, baseUrl) {
  const doc = parseDocument(String(html || ''), { decodeEntities: true });
  const content = walk(doc, (n) => n.name === 'main' || n.attribs?.id === 'site-content')[0] || doc;
  let pathname = '';
  try { pathname = new URL(baseUrl).pathname; } catch { /* Empty base URLs are valid for local fixtures. */ }
  const detailUrl = DETAIL.test(pathname);
  const main = detailUrl ? walk(content, (n) => n.name === 'article' || n.attribs?.id === 'tribe-events-content')[0] || content : content;
  const heading = DomUtils.findOne((n) => n.name === 'h1', main.children || []);
  const pageText = text(main);
  const archive = /lists? (?:the )?(?:published|completed) (?:collections|special issues)|transferred back to society|已发表特刊归档/i.test(pageText);
  if (archive) return [];
  if (heading && DEADLINE.test(pageText) && (detailUrl || CALL.test(clean(text(heading))))) {
    return [{
      title: clean(text(heading)), text: pageText.slice(0, 120000), href: baseUrl,
      journalNames: anchors(main).filter((a) => /\/journal\//i.test(a.attribs.href || '')).map((a) => clean(text(a))),
      callEvidence: true, detail: true,
    }];
  }
  const out = [];
  const seen = new Set();
  const linksByBlock = new WeakMap();
  const textByBlock = new WeakMap();
  const blockLinks = (node) => {
    if (!linksByBlock.has(node)) linksByBlock.set(node, anchors(node));
    return linksByBlock.get(node);
  };
  const blockText = (node) => {
    if (!textByBlock.has(node)) textByBlock.set(node, text(node));
    return textByBlock.get(node);
  };
  for (const a of anchors(main)) {
    if (!detailLink(a, baseUrl)) continue;
    const href = absolute(a.attribs.href, baseUrl);
    const title = clean(text(a));
    if (!href || title.length <= 7 || /^(?:special issues?|calls? for papers|view all|learn more|read more)$/i.test(title)) continue;
    let block = a;
    for (let p = a.parent; p && p !== main && p.type !== 'root'; p = p.parent) {
      const links = new Set(blockLinks(p).filter((link) => detailLink(link, baseUrl)).map((link) => absolute(link.attribs.href, baseUrl)).filter(Boolean));
      if (links.size > 1 || blockText(p).length > 24000) break;
      block = p;
      if (p.name === 'li' || p.name === 'article') break;
    }
    if (seen.has(href)) continue;
    seen.add(href);
    const journalNames = blockLinks(block)
      .filter((link) => /\/journal\//i.test(link.attribs.href || ''))
      .map((link) => clean(text(link)));
    out.push({ title, text: blockText(block), href, journalNames, callEvidence: true });
  }
  return out.slice(0, 2000);
}

/** Explicit diagnostics for HTTP-200 challenges and archives. */
export function sourceProblem(html) {
  const doc = parseDocument(String(html || ''));
  const title = clean(DomUtils.textContent(walk(doc, (n) => n.name === 'title')[0] || {}));
  const body = clean(text(doc));
  if (/just a moment|attention required|请稍候|access denied|robot check/i.test(title)
      || /verify you are human|正在进行安全验证|checking your browser/i.test(body.slice(0, 3000))) {
    return '网站返回安全验证/访问限制页面，未绕过验证；请在官网查看或手动添加 SI';
  }
  if (/transferred back to society/i.test(body)) return '期刊已转移出版社；当前页面为旧站归档，请更新官方征稿入口';
  if (/lists? (?:the )?(?:published|completed) (?:collections|special issues)/i.test(body)) return '这是已发表特刊归档，不是开放征稿页';
  return '';
}

/** Follow only actual links on the same origin. Do not guess paths or crawl the whole site. */
export function discoverSourceLinks(html, baseUrl) {
  const doc = parseDocument(String(html || ''));
  const base = new URL(baseUrl);
  const result = [];
  for (const a of anchors(doc)) {
    const href = absolute(a.attribs.href, baseUrl);
    if (!href || href === base.href || new URL(href).origin !== base.origin) continue;
    const label = clean(text(a));
    const next = (a.attribs.rel || '').split(/\s+/).includes('next');
    const societySource = base.hostname === 'www.aom.org' || base.hostname === 'www.ama.org';
    if (next || (!societySource && /call.for.papers/i.test(label) && !DETAIL.test(href))) result.push({ url: href, kind: next ? 'next' : 'directory' });
  }
  return [...new Map(result.map((x) => [x.url, x])).values()].slice(0, 4);
}
