import { parseDocument, DomUtils } from 'htmlparser2';

const normalize = (value) => String(value || '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
const content = (node) => {
  if (node.type === 'text') return node.data;
  if (['script', 'style', 'nav', 'footer'].includes(node.name)) return '';
  const text = (node.children || []).map(content).join('');
  return /^(?:p|div|h[1-6]|br|section|main|article|li)$/.test(node.name) ? ' ' + text + ' ' : text;
};

export function canonicalSourceUrl(value) {
  const url = new URL(value);
  if (url.searchParams.get('error') === 'cookies_not_supported') {
    url.searchParams.delete('error');
    url.searchParams.delete('code');
  }
  url.hash = '';
  return url.href;
}

export function robotsPolicy(body, value, agent = 'worlexsi') {
  const groups = [];
  let group = { agents: [], rules: [], delay: 0 }, directives = false;
  for (const line of String(body || '').split(/\r?\n/)) {
    const match = /^\s*(user-agent|allow|disallow|crawl-delay)\s*:\s*([^#]*)/i.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase(), rule = match[2].trim();
    if (key === 'user-agent') {
      if (directives) { groups.push(group); group = { agents: [], rules: [], delay: 0 }; directives = false; }
      group.agents.push(rule.toLowerCase());
    } else {
      directives = true;
      if (key === 'crawl-delay') group.delay = Math.max(0, Number(rule) || 0) * 1000;
      else if (rule) group.rules.push({ allow: key === 'allow', value: rule });
    }
  }
  groups.push(group);
  const score = (g) => Math.max(-1, ...g.agents.map((a) => a === '*' ? 0 : agent.toLowerCase().includes(a) ? a.length : -1));
  const best = Math.max(-1, ...groups.map(score));
  const selected = groups.filter((g) => best >= 0 && score(g) === best);
  const target = new URL(value), pathname = target.pathname + target.search;
  const matches = selected.flatMap((g) => g.rules).filter(({ value: pattern }) => {
    const end = pattern.endsWith('$');
    const escaped = (end ? pattern.slice(0, -1) : pattern).split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp('^' + escaped + (end ? '$' : '')).test(pathname);
  }).sort((a, b) => b.value.replace(/[*$]/g, '').length - a.value.replace(/[*$]/g, '').length || Number(b.allow) - Number(a.allow));
  return { allowed: !matches.length || matches[0].allow, crawlDelayMs: Math.max(0, ...selected.map((g) => g.delay)) };
}

export function cfpPageEvidence(html, url, journalTitle = '') {
  const document = parseDocument(String(html || ''));
  const nodes = DomUtils.findAll((node) => ['title', 'h1'].includes(node.name), document.children);
  const headings = nodes.map((node) => DomUtils.textContent(node).replace(/\s+/g, ' ').trim()).join(' | ');
  const main = DomUtils.findOne((node) => node.name === 'main', document.children) || document;
  const text = content(main).replace(/\s+/g, ' ');
  const identity = !journalTitle || normalize(text).includes(normalize(journalTitle));
  const path = new URL(url).pathname;
  const collection = /^\/collections?\/[^/]+\/?$/i.test(path);
  const call = /calls?[\s-]+for[\s-]+papers|open[\s-]+calls|submission[\s-]+deadline|submit[\s-]+(?:your[\s-]+)?manuscript/i;
  const closedPattern = /\bclosed for submissions\b|\bsubmissions? (?:are |is )?(?:now )?closed\b|\bcall (?:is )?(?:now )?closed\b/i;
  const closed = closedPattern.test(headings) || (collection && closedPattern.test(text));
  const archive = /\/(?:toc|loi)\//i.test(path) || /\b(?:published|closed) special issues?\b/i.test(headings);
  // Navigation/footer links cannot turn a generic brand page into a CFP feed.
  const focused = /call[s\s-]+for[\s-]+papers|open[\s-]+calls/i.test(headings)
    || (/\/collections?\//i.test(path) && call.test(text));
  return { confirmed: identity && focused && call.test(headings + ' ' + text) && !archive && !closed,
    headings: headings.slice(0, 600), identity, closed };
}

/**
 * 官方征稿 API 返回的 SI 详情页：标题就是专刊标题，没有 "Call for Papers" 栏目标签，
 * 因此 cfpPageEvidence 的列表页判据不适用。这类页面由以下特征确认：
 *   1) 来自官方 CFP 域名 /special_issues/ 路径；
 *   2) 正文明确含 special issue 与 submission deadline；
 *   3) 给出期刊名（identity）。
 * 只用于「可信来源提供的详情页」，不会被用来把任意出版社主页误判成征稿页。
 */
export function officialSiDetailEvidence(html, url, journalTitle = '') {
  const document = parseDocument(String(html || ''));
  const headings = DomUtils.findAll((node) => ['title', 'h1', 'h2'].includes(node.name), document.children)
    .map((node) => DomUtils.textContent(node).replace(/\s+/g, ' ').trim()).join(' | ');
  const text = content(document).replace(/\s+/g, ' ');
  let pathOk = false;
  try {
    const parsed = new URL(url);
    pathOk = /^callforpapers\.taylorandfrancis\.com$/i.test(parsed.hostname)
      && /^\/special_issues\/[^/]+\/?$/i.test(parsed.pathname);
  } catch { /* invalid url */ }
  const identity = !journalTitle || normalize(text).includes(normalize(journalTitle));
  const si = /special\s+issue|专刊|特刊/i.test(headings + ' ' + text);
  const deadline = /submission\s+deadline|deadline|截止/i.test(headings + ' ' + text);
  const closed = /\bclosed for submissions\b|\bsubmissions? (?:are |is )?(?:now )?closed\b/i.test(headings + ' ' + text);
  return { confirmed: pathOk && identity && si && deadline && !closed,
    headings: headings.slice(0, 600), identity, closed, detail: true };
}
