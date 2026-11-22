import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument, DomUtils } from 'htmlparser2';
import { ABS_JOURNALS, CFP_SOURCES } from '../src/specialIssueCatalog.js';
import { discoverJournalCfpPages, publisherPageError } from '../src/specialIssueParser.js';
import { canonicalSourceUrl, robotsPolicy, cfpPageEvidence } from '../src/specialIssueSourcePolicy.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const output = args.find((arg) => !arg.startsWith('--')) || path.join(root, 'src/specialIssueSourceAudit.json');
const only = args.find((arg) => arg.startsWith('--only='))?.slice(7).split(',');
const aggregateIds = args.find((arg) => arg.startsWith('--aggregates='))?.slice(13).split(',');
const previous = (only || aggregateIds) && fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : { journals: {}, aggregates: [] };
const home = (prefix, entries) => Object.fromEntries(Object.entries(entries).map(([id, value]) => [id, prefix + value]));
// These are candidates for inspection, never proof that a CFP exists.
const homes = {
  ...home('https://www.sciencedirect.com/journal/', {
    jae: 'journal-of-accounting-and-economics', aos: 'accounting-organizations-and-society', japp: 'journal-of-accounting-and-public-policy',
    mar: 'management-accounting-research', bar: 'the-british-accounting-review', jcaae: 'journal-of-contemporary-accounting-and-economics',
    jfe: 'journal-of-financial-economics', jbf: 'journal-of-banking-and-finance', jcf: 'journal-of-corporate-finance',
    jfm: 'journal-of-financial-markets', jfi: 'journal-of-financial-intermediation', jimf: 'journal-of-international-money-and-finance',
    irfa: 'international-review-of-financial-analysis', jef: 'journal-of-empirical-finance', frl: 'finance-research-letters', pbfj: 'pacific-basin-finance-journal',
    ejor: 'european-journal-of-operational-research', omega: 'omega', ijpe: 'international-journal-of-production-economics',
    im: 'information-and-management', dss: 'decision-support-systems', chb: 'computers-in-human-behavior', ijim: 'international-journal-of-information-management',
    jr: 'journal-of-retailing', ijrm: 'international-journal-of-research-in-marketing', jbr: 'journal-of-business-research', imm: 'industrial-marketing-management',
    obhdp: 'organizational-behavior-and-human-decision-processes', lrp: 'long-range-planning', jwb: 'journal-of-world-business',
    jbv: 'journal-of-business-venturing', rp: 'research-policy', tech: 'technovation', jetm: 'journal-of-engineering-and-technology-management',
    tfs: 'technological-forecasting-and-social-change', tm: 'tourism-management', atr: 'annals-of-tourism-research', ijhm: 'international-journal-of-hospitality-management',
    jdmm: 'journal-of-destination-marketing-and-management', tmp: 'tourism-management-perspectives', jhtm: 'journal-of-hospitality-and-tourism-management',
    joe: 'journal-of-econometrics', jebeo: 'journal-of-economic-behavior-and-organization', jcleanprod: 'journal-of-cleaner-production', ee: 'ecological-economics',
  }),
  ...home('https://link.springer.com/journal/', {
    ras: '11142', aor: '10479', orsp: '291', isf: '10796', bise: '12599', em: '12525', jams: '11747', ml: '11002',
    jbm: '41262', jibs: '41267', sbe: '11187', jbe: '10551', he: '10734',
  }),
  ...home('https://www.emeraldgrouppublishing.com/journal/', {
    ijopm: 'ijopm', scm: 'scm', iacr: 'intr', jsm: 'jsm', ejm: 'ejm', jcm: 'jcm', jkm: 'jkm', jtf: 'jtf', ijcthr: 'ijchm',
  }),
  ...home('https://www.tandfonline.com/journals/', {
    abr: 'rabr20', af: 'racc20', ear: 'rear20', jbfin: 'hbhf20', ijpr: 'tprs20', iise: 'uiie21', jmis: 'mmis20', ejis: 'tjis20',
    ja: 'ujoa20', jost: 'rsus20', tg: 'rtxg20', cit: 'rcit20', apjtr: 'rapt20', jttm: 'wttm20', jht: 'rjht20', trr: 'rtrr20',
    ijhmc: 'whmm20', pmr: 'rpxm20', she: 'cshe20',
  }),
  ...home('https://journals.sagepub.com/home/', {
    jit: 'jina', jar_res: 'jar', jsr: 'jsra', asq: 'asqa', jomg: 'joma', cmr: 'cmra', org: 'orga', osr: 'ossa',
    humrel: 'huma', etp: 'etpb', jtr: 'jtrb', jhtr: 'jht', chq: 'cqx', te: 'teu', bas: 'basa', oae: 'oaex',
  }),
  ...home('https://pubsonline.informs.org/journal/', { ms: 'mnsc', or: 'opre', msom: 'msom', ijoc: 'ijoc', isr: 'isre', mksc: 'mksc', os: 'orsc' }),
  ...home('https://academic.oup.com/', { rfs: 'rfs', rof: 'rof', jcr: 'jcr', qje: 'qje', restud: 'restud', ej: 'ej', jpart: 'jpart' }),
  ...home('https://publications.aaahq.org/', { tar: 'accounting-review', ah: 'accounting-horizons', ajpt: 'ajpt' }),
  ...home('https://journals.aom.org/journal/', { amj: 'amj', amr: 'amr', amp: 'amp' }),
  jfqa: 'https://www.cambridge.org/core/journals/journal-of-financial-and-quantitative-analysis',
  misq: 'https://misq.umn.edu/', jais: 'https://aisel.aisnet.org/jais/', jitm: 'https://home.thejitm.org/index.shtml',
  pom: 'https://www.poms.org/journal',
  jm: 'https://www.ama.org/journal-of-marketing/', jmr: 'https://www.ama.org/journal-of-marketing-research/',
  jim: 'https://www.ama.org/journal-of-interactive-marketing/', jppm: 'https://www.ama.org/journal-of-public-policy-marketing/',
  jap: 'https://www.apa.org/pubs/journals/apl', hbr: 'https://hbr.org/', sloan: 'https://sloanreview.mit.edu/',
  ieee_tem: 'https://www.ieee-tems.org/ieee-transactions-on-engineering-management/',
  ijtm: 'https://www.inderscience.com/jhome.php?jcode=ijtm', aer: 'https://www.aeaweb.org/journals/aer',
  jpe: 'https://www.journals.uchicago.edu/toc/jpe/current',
  jom: 'https://onlinelibrary.wiley.com/journal/18731317', ds: 'https://onlinelibrary.wiley.com/journal/15405915',
  jpi: 'https://onlinelibrary.wiley.com/journal/15405885', pp: 'https://onlinelibrary.wiley.com/journal/17446570',
  rdm: 'https://onlinelibrary.wiley.com/journal/14679310',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hostNext = new Map();
const hostDelay = new Map();
const robots = new Map();
const get = async (url) => {
  const origin = new URL(url).origin;
  const delay = Math.max(0, (hostNext.get(origin) || 0) - Date.now());
  hostNext.set(origin, Date.now() + delay + Math.max(2100, hostDelay.get(origin) || 0));
  if (delay) await sleep(delay);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'WorlexSI/2.2 (academic CFP source audit)', Accept: 'text/html,application/json' } });
    const body = (await response.text()).slice(0, 4 * 1024 * 1024);
    return { requestedUrl: url, url: response.url, status: response.status, checkedAt: new Date().toISOString(), body };
  } catch (error) { return { requestedUrl: url, url, status: 0, checkedAt: new Date().toISOString(), error: error.message, body: '' }; }
};

async function allowed(url) {
  const target = new URL(url);
  if (!robots.has(target.origin)) robots.set(target.origin, get(target.origin + '/robots.txt'));
  const result = await robots.get(target.origin);
  if ([401, 403, 429].includes(result.status)) return false;
  if (result.status !== 200) return !(!result.status || result.status >= 500);
  const policy = robotsPolicy(result.body, url);
  hostDelay.set(target.origin, policy.crawlDelayMs);
  hostNext.set(target.origin, Math.max(hostNext.get(target.origin) || 0, Date.parse(result.checkedAt) + policy.crawlDelayMs));
  return policy.allowed;
}

async function inspect(journal) {
  const journalUrl = homes[journal.id] || journal.journalUrl || '';
  if (!journalUrl) return { id: journal.id, journalUrl: '', cfpUrl: '', state: 'not-confirmed', checks: [], note: 'No identified official homepage; no URL generated from the journal title.' };
  if (!(await allowed(journalUrl))) {
    const robotsPage = await robots.get(new URL(journalUrl).origin);
    const { body: ignored, ...evidence } = robotsPage;
    return { id: journal.id, journalUrl, cfpUrl: '', state: 'robots-restricted', checks: [], robots: evidence, checkedAt: new Date().toISOString(), note: 'robots.txt disallows access or could not be checked safely.' };
  }
  const page = await get(journalUrl);
  const doc = parseDocument(page.body);
  const title = DomUtils.textContent(DomUtils.findOne((n) => n.name === 'title', doc.children) || { children: [] }).replace(/\s+/g, ' ').slice(0, 240);
  const { body, ...check } = page;
  const checks = [{ ...check, title }];
  const blocked = [401, 403, 429].includes(page.status) || !!publisherPageError(body);
  const result = { id: journal.id, journalUrl: page.status === 200 && !blocked ? canonicalSourceUrl(page.url) : journalUrl, cfpUrl: '', cfpUrls: [], state: blocked ? 'access-limited' : 'not-confirmed', checkedAt: page.checkedAt, checks };
  if (page.status !== 200 || blocked) return result;
  const visible = DomUtils.textContent(doc).replace(/[^a-z0-9]+/gi, ' ').toLowerCase();
  const identity = journal.title.replace(/[^a-z0-9]+/gi, ' ').toLowerCase().trim();
  if (!visible.includes(identity)) { result.note = 'HTTP 200 but journal identity was not confirmed.'; return result; }
  result.state = 'homepage-confirmed';
  const links = discoverJournalCfpPages(body, page.url);
  for (const url of links) {
    if (!(await allowed(url))) continue;
    const cfp = await get(url);
    const { body: cfpBody, ...cfpCheck } = cfp;
    checks.push(cfpCheck);
    const evidence = cfpPageEvidence(cfpBody, cfp.url, journal.title);
    checks.at(-1).evidence = evidence;
    if (cfp.status === 200 && evidence.identity && evidence.closed) {
      (result.closedCfpUrls ||= []).push(canonicalSourceUrl(cfp.url));
    }
    if (cfp.status === 200 && !publisherPageError(cfpBody) && evidence.confirmed) {
      result.cfpUrls.push(canonicalSourceUrl(cfp.url)); result.state = 'cfp-confirmed';
    }
  }
  result.cfpUrl = result.cfpUrls[0] || '';
  return result;
}

const journals = { ...(previous.journals || {}) };
const queue = ABS_JOURNALS.filter((journal) => only ? only.includes(journal.id) : !aggregateIds);
const total = queue.length;
let completed = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (queue.length) {
    const journal = queue.shift();
    try { journals[journal.id] = await inspect(journal); }
    catch (error) { journals[journal.id] = { id: journal.id, journalUrl: homes[journal.id] || journal.journalUrl || '', cfpUrl: '', state: 'not-confirmed', checks: [], note: error.message }; }
    console.log(`${++completed}/${total} ${journal.id} ${journals[journal.id].state}`);
  }
}));
const aggregates = [...(previous.aggregates || [])];
for (const source of CFP_SOURCES.filter((source) => aggregateIds ? aggregateIds.includes(source.id) : !only)) {
  const old = aggregates.findIndex((entry) => entry.id === source.id);
  if (old >= 0) aggregates.splice(old, 1);
  if (!(await allowed(source.url))) { aggregates.push({ ...source, state: 'robots-restricted' }); continue; }
  const page = await get(source.url);
  const { body, ...check } = page;
  let valid = false;
  let evidence = { confirmed: false };
  if (page.status === 200 && !publisherPageError(body)) {
    if (source.id === 'tandf' && /^\s*\[/.test(body)) {
      const records = JSON.parse(body);
      valid = records.length > 0 && records.every((entry) => entry.special_issues?._special_issues_journal_title && entry.link);
      evidence = { confirmed: valid, format: 'official-special-issues-json', records: records.length };
    } else { evidence = cfpPageEvidence(body, page.url); valid = evidence.confirmed; }
  }
  aggregates.push({ ...source, ...check, url: canonicalSourceUrl(page.url), verified: valid, evidence,
    crawlDelayMs: hostDelay.get(new URL(source.url).origin) || 0, state: valid ? 'aggregate-confirmed' : 'not-confirmed' });
}
const report = { checkedAt: new Date().toISOString(), method: 'Official homepage identity check, linked CFP discovery, robots.txt and HTTP evidence. Restricted and unconfirmed pages are not verified CFPs.', journals, aggregates };
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, total: Object.keys(journals).length, states: Object.values(journals).reduce((all, entry) => ({ ...all, [entry.state]: (all[entry.state] || 0) + 1 }), {}) }));
