// topJournals.js —— 顶刊跟踪：期刊目录、元数据同步与个人不重复投递队列
//
// 目录分四套：
//   utd  —— UTD 24，元数据走 Crossref（稳定、带作者与摘要）。
//   cnA  —— 国家自然科学基金委管理科学部 A 类期刊 22 种（中文）。
//           这 22 种**完全不在 Crossref**（按 ISSN 与 DOI 前缀查 works 均为 0 条），OpenAlex 也只零星收录。
//           数据源两个，按刊择优：
//             · 知网期刊 RSS（见 cnkiRss.js）—— 21 种有代码，带标题/作者/摘要节选，首选；
//             · 官网当期目录（见 cnJournalFeed.js）—— 《管理科学》等知网没 RSS 的刊，或用户主动切换。
//           每个刊的 `sourceId` 表示「这次用哪个源」，用户可在界面按刊切换；
//           首选源抓失败会自动退到另一个源，不会因为一次 503 就整天没文章。
//   ccfA / ccfB —— 计算机领域的 CCF A / B 类（期刊 + 会议，见 ccfVenues.js）。取数按场馆类型分流：
//             · 英文期刊 → Crossref（出版社上报的 DOI 元数据；IEEE/ACM/Elsevier 官网都挡程序访问）；
//             · 中文期刊 → 知网 RSS，没有 RSS 的走官网当期目录；
//             · 期刊官网自带 RSS（JMLR）→ 直接读 RSS；
//             · 会议 → 抓官网论文集目录（见 confFeed.js），NeurIPS/ICML/CVPR/ACL/IJCAI/USENIX/ECCV。
//
// 本模块只同步公开的书目信息/摘要/DOI/出版社文章页；不抓取或分发受版权保护的 PDF 全文。

import { fetchCnJournalArticles } from './cnJournalFeed.js';
import { fetchCnkiJournalArticles, CNKI_CODES } from './cnkiRss.js';
import { fetchConferenceArticles } from './confFeed.js';
import { fetchRssArticles } from './rssFeed.js';
import { CCF_JOURNALS, CCF_CONFERENCES, ccfIdsOf, ccfIdsByCategory } from './ccfVenues.js';

const DAY = 24 * 60 * 60 * 1000;
const CROSSREF_API = 'https://api.crossref.org/journals';

const UTD_BASE = [
  { id: 'tar', title: 'The Accounting Review', shortTitle: 'TAR', category: '会计', issn: '0001-4826', publisherUrl: 'https://publications.aaahq.org/accounting-review' },
  { id: 'jae', title: 'Journal of Accounting and Economics', shortTitle: 'JAE', category: '会计', issn: '0165-4101', publisherUrl: 'https://www.sciencedirect.com/journal/journal-of-accounting-and-economics' },
  { id: 'jar', title: 'Journal of Accounting Research', shortTitle: 'JAR', category: '会计', issn: '0021-8456', publisherUrl: 'https://onlinelibrary.wiley.com/journal/1475679x' },
  { id: 'jof', title: 'The Journal of Finance', shortTitle: 'JoF', category: '金融', issn: '0022-1082', publisherUrl: 'https://onlinelibrary.wiley.com/journal/15406261' },
  { id: 'jfe', title: 'Journal of Financial Economics', shortTitle: 'JFE', category: '金融', issn: '0304-405X', publisherUrl: 'https://www.sciencedirect.com/journal/journal-of-financial-economics' },
  { id: 'rfs', title: 'The Review of Financial Studies', shortTitle: 'RFS', category: '金融', issn: '0893-9454', publisherUrl: 'https://academic.oup.com/rfs' },
  { id: 'isr', title: 'Information Systems Research', shortTitle: 'ISR', category: '信息系统', issn: '1047-7047', publisherUrl: 'https://pubsonline.informs.org/journal/isre' },
  { id: 'ijoc', title: 'INFORMS Journal on Computing', shortTitle: 'INFORMS JOC', category: '信息系统', issn: '1091-9856', publisherUrl: 'https://pubsonline.informs.org/journal/ijoc' },
  { id: 'misq', title: 'MIS Quarterly', shortTitle: 'MISQ', category: '信息系统', issn: '0276-7783', publisherUrl: 'https://misq.umn.edu/' },
  { id: 'jcr', title: 'Journal of Consumer Research', shortTitle: 'JCR', category: '营销', issn: '0093-5301', publisherUrl: 'https://academic.oup.com/jcr' },
  { id: 'jm', title: 'Journal of Marketing', shortTitle: 'JM', category: '营销', issn: '0022-2429', publisherUrl: 'https://journals.sagepub.com/home/jmx' },
  { id: 'jmr', title: 'Journal of Marketing Research', shortTitle: 'JMR', category: '营销', issn: '0022-2437', publisherUrl: 'https://journals.sagepub.com/home/mrj' },
  { id: 'mksc', title: 'Marketing Science', shortTitle: 'Marketing Science', category: '营销', issn: '0732-2399', publisherUrl: 'https://pubsonline.informs.org/journal/mksc' },
  { id: 'ms', title: 'Management Science', shortTitle: 'Management Science', category: '运营与供应链', issn: '0025-1909', publisherUrl: 'https://pubsonline.informs.org/journal/mnsc' },
  { id: 'or', title: 'Operations Research', shortTitle: 'Operations Research', category: '运营与供应链', issn: '0030-364X', publisherUrl: 'https://pubsonline.informs.org/journal/opre' },
  { id: 'jom', title: 'Journal of Operations Management', shortTitle: 'JOM', category: '运营与供应链', issn: '0272-6963', publisherUrl: 'https://onlinelibrary.wiley.com/journal/18731317' },
  { id: 'msom', title: 'Manufacturing & Service Operations Management', shortTitle: 'M&SOM', category: '运营与供应链', issn: '1523-4614', publisherUrl: 'https://pubsonline.informs.org/journal/msom' },
  { id: 'pom', title: 'Production and Operations Management', shortTitle: 'POM', category: '运营与供应链', issn: '1059-1478', publisherUrl: 'https://onlinelibrary.wiley.com/journal/19375956' },
  { id: 'amj', title: 'Academy of Management Journal', shortTitle: 'AMJ', category: '综合管理与战略', issn: '0001-4273', publisherUrl: 'https://journals.aom.org/journal/amj' },
  { id: 'amr', title: 'Academy of Management Review', shortTitle: 'AMR', category: '综合管理与战略', issn: '0363-7425', publisherUrl: 'https://journals.aom.org/journal/amr' },
  { id: 'asq', title: 'Administrative Science Quarterly', shortTitle: 'ASQ', category: '综合管理与战略', issn: '0001-8392', publisherUrl: 'https://journals.sagepub.com/home/asq' },
  { id: 'os', title: 'Organization Science', shortTitle: 'Organization Science', category: '综合管理与战略', issn: '1047-7039', publisherUrl: 'https://pubsonline.informs.org/journal/orsc' },
  { id: 'jibs', title: 'Journal of International Business Studies', shortTitle: 'JIBS', category: '综合管理与战略', issn: '0047-2506', publisherUrl: 'https://link.springer.com/journal/41267' },
  { id: 'smj', title: 'Strategic Management Journal', shortTitle: 'SMJ', category: '综合管理与战略', issn: '0143-2095', publisherUrl: 'https://onlinelibrary.wiley.com/journal/10970266' },
];

export const UTD_JOURNALS = UTD_BASE.map((journal) => ({ ...journal, set: 'utd', provider: 'crossref', language: 'en' }));

/**
 * 国家自然科学基金委管理科学部 A 类期刊（22 种）。
 *
 * 数据源：这 22 种刊不在 Crossref，有两条可选路径——
 *   1. 知网期刊 RSS（rss.cnki.net）：一次给最新 20 条，带标题/作者/摘要节选/发布时间，稳定且可统一解析；
 *   2. 官网当期目录：知网没有 RSS 的刊（目前只有《管理科学》）或用户主动切换时使用。
 * cnkiCode 为知网内部刊代码（逐个实测核对过 channel title），见 cnkiRss.js 的 CNKI_CODES。
 * feedUrl 只填**实测能解析出文章列表**的地址（2026-11 验证）；留空的站点抓不到
 * （脚本渲染、拒绝程序访问或域名变更），界面标「待验证」，用户可自行补上当期目录地址。
 */
export const CN_A_JOURNALS = [
  { id: 'cn-jmsc', title: '管理科学学报', shortTitle: '管理科学学报', titleEn: 'Journal of Management Sciences in China', category: '管理科学与工程', issn: '1007-9807', publisherUrl: 'http://jmsc.tju.edu.cn', feedUrl: 'http://jmsc.tju.edu.cn' },
  { id: 'cn-setp', title: '系统工程理论与实践', shortTitle: '系统工程理论与实践', titleEn: 'Systems Engineering — Theory & Practice', category: '管理科学与工程', issn: '1000-6788', publisherUrl: 'http://www.sysengi.com', feedUrl: '' },
  { id: 'cn-mw', title: '管理世界', shortTitle: '管理世界', titleEn: 'Journal of Management World', category: '工商管理', issn: '1002-5502', publisherUrl: 'http://www.mwm.net.cn', feedUrl: 'http://www.mwm.net.cn' },
  { id: 'cn-qte', title: '数量经济技术经济研究', shortTitle: '数量经济技术经济研究', titleEn: 'Journal of Quantitative & Technological Economics', category: '经济与金融', issn: '1000-3894', publisherUrl: 'https://www.jqte.net', feedUrl: 'https://www.jqte.net' },
  { id: 'cn-ssc', title: '中国软科学', shortTitle: '中国软科学', titleEn: 'China Soft Science', category: '经济与金融', issn: '1002-9753', publisherUrl: 'https://www.cssm.com.cn', feedUrl: 'https://www.cssm.com.cn' },
  { id: 'cn-jryj', title: '金融研究', shortTitle: '金融研究', titleEn: 'Journal of Financial Research', category: '经济与金融', issn: '1002-7246', publisherUrl: 'http://www.jryj.org.cn', feedUrl: 'http://www.jryj.org.cn/CN/1002-7246/home.shtml' },
  { id: 'cn-zgglkx', title: '中国管理科学', shortTitle: '中国管理科学', titleEn: 'Chinese Journal of Management Science', category: '管理科学与工程', issn: '1003-207X', publisherUrl: 'http://www.zgglkx.com', feedUrl: 'https://www.zgglkx.com/CN/1003-207x/home.shtml' },
  { id: 'cn-jse', title: '系统工程学报', shortTitle: '系统工程学报', titleEn: 'Journal of Systems Engineering', category: '管理科学与工程', issn: '1000-5781', publisherUrl: '', feedUrl: '' },
  { id: 'cn-kjyj', title: '会计研究', shortTitle: '会计研究', titleEn: 'Accounting Research', category: '工商管理', issn: '1003-2886', publisherUrl: '', feedUrl: '' },
  { id: 'cn-xtglxb', title: '系统管理学报', shortTitle: '系统管理学报', titleEn: 'Journal of Systems & Management', category: '管理科学与工程', issn: '1005-2542', publisherUrl: 'http://xtglxb.sjtu.edu.cn', feedUrl: 'https://xtglxb.sjtu.edu.cn/CN/2097-4558/home.shtml' },
  { id: 'cn-glpl', title: '管理评论', shortTitle: '管理评论', titleEn: 'Management Review', category: '管理科学与工程', issn: '1003-1952', publisherUrl: '', feedUrl: '' },
  { id: 'cn-glgcxb', title: '管理工程学报', shortTitle: '管理工程学报', titleEn: 'Journal of Industrial Engineering and Engineering Management', category: '管理科学与工程', issn: '1004-6062', publisherUrl: 'http://glgcxb.zju.edu.cn', feedUrl: '' },
  { id: 'cn-nkglpl', title: '南开管理评论', shortTitle: '南开管理评论', titleEn: 'Nankai Business Review', category: '工商管理', issn: '1008-3448', publisherUrl: 'http://nbr.nankai.edu.cn', feedUrl: '' },
  { id: 'cn-kygl', title: '科研管理', shortTitle: '科研管理', titleEn: 'Science Research Management', category: '工商管理', issn: '1000-2995', publisherUrl: 'https://www.kygl.net.cn', feedUrl: 'https://www.kygl.net.cn/CN/1000-2995/home.shtml' },
  { id: 'cn-qbxb', title: '情报学报', shortTitle: '情报学报', titleEn: 'Journal of the China Society for Scientific and Technical Information', category: '公共管理与情报', issn: '1000-0135', publisherUrl: 'http://qbxb.istic.ac.cn', feedUrl: '' },
  { id: 'cn-ggglxb', title: '公共管理学报', shortTitle: '公共管理学报', titleEn: 'Journal of Public Management', category: '公共管理与情报', issn: '1672-6162', publisherUrl: '', feedUrl: '' },
  { id: 'cn-glkx', title: '管理科学', shortTitle: '管理科学', titleEn: 'Journal of Management Science', category: '管理科学与工程', issn: '1672-0334', publisherUrl: 'http://glkx.hit.edu.cn', feedUrl: 'http://glkx.hit.edu.cn' },
  { id: 'cn-yc', title: '预测', shortTitle: '预测', titleEn: 'Forecasting', category: '管理科学与工程', issn: '1003-5192', publisherUrl: '', feedUrl: '' },
  { id: 'cn-ycygl', title: '运筹与管理', shortTitle: '运筹与管理', titleEn: 'Operations Research and Management Science', category: '管理科学与工程', issn: '1007-3221', publisherUrl: '', feedUrl: '' },
  { id: 'cn-kxxyj', title: '科学学研究', shortTitle: '科学学研究', titleEn: 'Studies in Science of Science', category: '公共管理与情报', issn: '1003-2053', publisherUrl: '', feedUrl: '' },
  { id: 'cn-ciej', title: '中国工业经济', shortTitle: '中国工业经济', titleEn: 'China Industrial Economics', category: '工商管理', issn: '1006-480X', publisherUrl: 'http://ciejournal.ajcass.com', feedUrl: 'http://ciejournal.ajcass.com' },
  { id: 'cn-ncyjwt', title: '农业经济问题', shortTitle: '农业经济问题', titleEn: 'Issues in Agricultural Economy', category: '工商管理', issn: '1000-6389', publisherUrl: '', feedUrl: '' },
].map((journal) => {
  const cnkiCode = CNKI_CODES[journal.id] || '';
  return {
    ...journal,
    set: 'cnA',
    cnkiCode,
    // 默认数据源：有知网代码就走知网 RSS，没有就退回官网目录
    provider: cnkiCode ? 'cnki' : 'site',
    language: 'zh',
  };
});

export const ALL_JOURNALS = [...UTD_JOURNALS, ...CN_A_JOURNALS, ...CCF_JOURNALS, ...CCF_CONFERENCES];

export const JOURNAL_SETS = [
  {
    id: 'utd',
    label: 'UTD 24 · 英文顶刊',
    note: '元数据来自 Crossref，自动带作者与摘要',
    journalIds: UTD_JOURNALS.map((journal) => journal.id),
  },
  {
    id: 'cnA',
    label: '中国 · 国家自然科学基金委管理科学部 A 类（22 种）',
    note: '21 种走知网期刊 RSS（带作者与摘要节选），其余抓官网当期目录；可按刊切换',
    journalIds: CN_A_JOURNALS.map((journal) => journal.id),
  },
  {
    id: 'ccfA',
    label: '计算机 · CCF-A（期刊 + 会议）',
    note: '英文刊走出版社 DOI 元数据，中文刊走知网 RSS（没有 RSS 的抓官网目录），会议抓官网论文集目录',
    collapsible: true,
    journalIds: ccfIdsOf('A'),
  },
  {
    id: 'ccfB',
    label: '计算机 · CCF-B（期刊 + 会议）',
    note: '同上；中文刊等级对应《计算领域高质量科技期刊分级目录》T2',
    collapsible: true,
    journalIds: ccfIdsOf('B'),
  },
];

export function journalById(id) {
  return ALL_JOURNALS.find((journal) => journal.id === id) || null;
}

export const JOURNAL_PRESETS = {
  marketing: { label: '营销', journalIds: ['jcr', 'jm', 'jmr', 'mksc'] },
  management: { label: '企业管理', journalIds: ['amj', 'amr', 'asq', 'os', 'jibs', 'smj'] },
  technologyEconomics: { label: '技术经济 / 管理科学', journalIds: ['isr', 'ijoc', 'misq', 'ms', 'or', 'jom', 'msom', 'pom'] },
  tourism: { label: '旅游（交叉）', journalIds: ['jcr', 'jm', 'jmr', 'mksc', 'jibs', 'smj'] },
  accounting: { label: '会计', journalIds: ['tar', 'jae', 'jar'] },
  finance: { label: '金融', journalIds: ['jof', 'jfe', 'rfs'] },
  informationSystems: { label: '信息系统', journalIds: ['isr', 'ijoc', 'misq'] },
  operations: { label: '运营与供应链', journalIds: ['ms', 'or', 'jom', 'msom', 'pom'] },
  cnAll: { label: '中国 A 类 22 本', journalIds: CN_A_JOURNALS.map((journal) => journal.id) },
  cnManagement: {
    label: '中国 · 管理科学与工程',
    journalIds: CN_A_JOURNALS.filter((journal) => journal.category === '管理科学与工程').map((journal) => journal.id),
  },
  cnBusiness: {
    label: '中国 · 工商管理',
    journalIds: CN_A_JOURNALS.filter((journal) => journal.category === '工商管理').map((journal) => journal.id),
  },
  cnEconomics: {
    label: '中国 · 经济金融',
    journalIds: CN_A_JOURNALS.filter((journal) => ['经济与金融', '公共管理与情报'].includes(journal.category)).map((journal) => journal.id),
  },
  ccfAAll: { label: '计算机 · CCF-A 全部', journalIds: ccfIdsOf('A') },
  ccfBAll: { label: '计算机 · CCF-B 全部', journalIds: ccfIdsOf('B') },
  ccfAI: { label: '计算机 · 人工智能', journalIds: [...ccfIdsByCategory('A', ['人工智能', '自然语言处理', '计算机视觉']), ...ccfIdsByCategory('B', ['人工智能', '自然语言处理', '计算机视觉'])] },
  ccfSystems: { label: '计算机 · 系统 / 网络 / 安全', journalIds: [...ccfIdsByCategory('A', ['系统与存储', '网络与安全']), ...ccfIdsByCategory('B', ['系统与存储', '网络与安全'])] },
  ccfSe: { label: '计算机 · 软件工程 / 数据库', journalIds: [...ccfIdsByCategory('A', ['软件工程', '数据库与信息检索']), ...ccfIdsByCategory('B', ['软件工程', '数据库与信息检索'])] },
  ccfTop: { label: '计算机 · 只看 A 类会议', journalIds: ccfIdsOf('A', 'conference') },
};

export function dayKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function createTopJournalState(value = {}) {
  // v2 新增收藏与历史软删除。保留投递记录，以便“删历史”后仍能保证文章永不重复投递。
  const favoriteSource = value?.favorites && typeof value.favorites === 'object' ? value.favorites : {};
  const deletedSource = value?.deletedHistoryArticleIds && typeof value.deletedHistoryArticleIds === 'object'
    ? value.deletedHistoryArticleIds : {};
  const feedSource = value?.feedOverrides && typeof value.feedOverrides === 'object' ? value.feedOverrides : {};
  const prefSource = value?.sourcePrefs && typeof value.sourcePrefs === 'object' ? value.sourcePrefs : {};
  return {
    version: 2,
    selectedJournalIds: Array.isArray(value?.selectedJournalIds) ? [...new Set(value.selectedJournalIds.filter((id) => ALL_JOURNALS.some((j) => j.id === id)))] : [],
    articles: Array.isArray(value?.articles) ? value.articles : [],
    checkins: value?.checkins && typeof value.checkins === 'object' ? value.checkins : {},
    deliveries: value?.deliveries && typeof value.deliveries === 'object' ? value.deliveries : {},
    sync: value?.sync && typeof value.sync === 'object' ? value.sync : {},
    favorites: Object.fromEntries(Object.entries(favoriteSource).filter(([id]) => typeof id === 'string' && id)),
    deletedHistoryArticleIds: Object.fromEntries(Object.entries(deletedSource).filter(([id]) => typeof id === 'string' && id)),
    // 用户自填的期刊目录页（只对中文刊有意义）：{ journalId: url }
    feedOverrides: Object.fromEntries(Object.entries(feedSource).filter(([id, url]) => typeof id === 'string' && /^https?:\/\//i.test(String(url || '')))),
    // 用户按刊选的数据源：{ journalId: 'cnki' | 'site' }；缺省按刊自身 provider（有知网代码优先知网）
    sourcePrefs: Object.fromEntries(Object.entries(prefSource).filter(([id, v]) => typeof id === 'string' && (v === 'cnki' || v === 'site'))),
    preferences: { fillWithRecentUnseen: true, ...(value?.preferences || {}) },
  };
}

/**
 * 应用用户偏好后的期刊目录（界面与同步都读这一份）。
 * sourceId = 实际会用的源；用户选了但该源不可用（如选了知网但该刊没代码）时自动换另一个，
 * 避免界面显示「知网 RSS」而实际总是同步失败。
 */
export function catalogFor(stateInput) {
  const overrides = stateInput?.feedOverrides || {};
  const prefs = stateInput?.sourcePrefs || {};
  return ALL_JOURNALS.map((journal) => {
    const merged = overrides[journal.id] ? { ...journal, feedUrl: overrides[journal.id] } : journal;
    // 会议只有一条路：抓官网论文集目录
    if (merged.kind === 'conference') return { ...merged, sourceId: 'conf', sourcePref: '' };
    // 中文刊（NSFC A 类 + CCF 中文刊）可以在知网 RSS / 官网目录之间切换
    const switchable = merged.set === 'cnA' || (merged.set === 'ccf' && merged.language === 'zh');
    if (!switchable) return { ...merged, sourceId: merged.provider === 'rss' ? 'rss' : 'crossref', sourcePref: '' };
    const wanted = prefs[journal.id] === 'cnki' || prefs[journal.id] === 'site'
      ? prefs[journal.id]
      : (merged.provider === 'site' ? 'site' : 'cnki');
    let sourceId = wanted;
    if (sourceId === 'cnki' && !merged.cnkiCode) sourceId = 'site';
    if (sourceId === 'site' && !merged.feedUrl && merged.cnkiCode) sourceId = 'cnki';
    return { ...merged, sourceId, sourcePref: prefs[journal.id] || '' };
  });
}

function htmlToText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

function firstDate(message) {
  for (const key of ['published-online', 'published-print', 'published', 'issued', 'created']) {
    const part = message?.[key];
    const values = part?.['date-parts']?.[0];
    if (Array.isArray(values) && values.length) {
      const [year, month = 1, day = 1] = values;
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  return '';
}

function articleIdFor(item) {
  const doi = String(item?.DOI || '').trim().toLowerCase();
  if (doi) return `doi:${doi}`;
  return `fallback:${String(item?.title?.[0] || '').trim().toLowerCase()}|${firstDate(item)}`;
}

export function mapCrossrefWork(work, journal) {
  const doi = String(work?.DOI || '').trim();
  const authors = Array.isArray(work?.author) ? work.author.map((author) => [author.given, author.family].filter(Boolean).join(' ').trim()).filter(Boolean) : [];
  const affiliations = Array.from(new Set((work?.author || []).flatMap((author) => (author.affiliation || []).map((row) => String(row?.name || '').trim()).filter(Boolean))));
  return {
    id: articleIdFor(work),
    journalId: journal.id,
    journal: String(work?.['container-title']?.[0] || journal.title).trim(),
    title: String(work?.title?.[0] || '').trim(),
    authors,
    affiliations,
    abstract: htmlToText(work?.abstract),
    doi,
    originalUrl: String(work?.URL || (doi ? `https://doi.org/${doi}` : '')).trim(),
    publishedAt: firstDate(work),
    volume: String(work?.volume || ''),
    issue: String(work?.issue || ''),
    pages: String(work?.page || work?.article_number || ''),
    articleType: String(work?.type || ''),
    source: 'Crossref',
    discoveredAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    translations: work?.translations && typeof work.translations === 'object' ? work.translations : {},
  };
}

function mergeArticles(existing, incoming) {
  const byId = new Map(existing.map((article) => [article.id, article]));
  for (const next of incoming) {
    if (!next.title) continue;
    const old = byId.get(next.id);
    byId.set(next.id, {
      ...old,
      ...next,
      abstract: next.abstract || old?.abstract || '',
      authors: next.authors?.length ? next.authors : (old?.authors || []),
      affiliations: next.affiliations?.length ? next.affiliations : (old?.affiliations || []),
      translations: old?.translations || next.translations || {},
      discoveredAt: old?.discoveredAt || next.discoveredAt,
    });
  }
  return [...byId.values()]
    .sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')) || String(b.discoveredAt || '').localeCompare(String(a.discoveredAt || '')))
    .slice(0, 6000);
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

const SOURCE_LABEL = { crossref: 'Crossref', cnki: '知网 RSS', site: '期刊官网', rss: '官网 RSS', conf: '会议官网' };

/** 一个场馆这次要依次尝试的数据源：首选在前，失败自动退到备选 */
function sourceAttempts(journal) {
  if (journal.kind === 'conference') return ['conf'];
  if (journal.provider === 'rss') return ['rss'];
  const switchable = journal.set === 'cnA' || (journal.set === 'ccf' && journal.language === 'zh');
  if (!switchable) return ['crossref'];
  const primary = journal.sourceId || journal.provider;
  const order = primary === 'site' ? ['site', 'cnki'] : ['cnki', 'site'];
  const usable = order.filter((source) => (source === 'cnki' ? Boolean(journal.cnkiCode) : Boolean(journal.feedUrl)));
  // 两个源都没配好时也给一个明确的报错，而不是静默 0 条
  return usable.length ? usable : [primary];
}

async function fetchFromSource(sourceId, journal, { fetchImpl, rows }) {
  if (sourceId === 'cnki') return fetchCnkiJournalArticles(journal, { fetchImpl });
  if (sourceId === 'site') return fetchCnJournalArticles(journal, { fetchImpl });
  if (sourceId === 'rss') return fetchRssArticles(journal, { fetchImpl });
  if (sourceId === 'conf') return fetchConferenceArticles(journal, { fetchImpl });
  const params = new URLSearchParams({ filter: 'type:journal-article', sort: 'published', order: 'desc', rows: String(Math.max(1, Math.min(100, rows))) });
  const response = await fetchImpl(`${CROSSREF_API}/${encodeURIComponent(journal.issn)}/works?${params}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'worlex/1.9 (mailto:research@example.invalid)' },
  });
  if (!response.ok) throw new Error(`Crossref ${response.status}`);
  const payload = await response.json();
  return (payload?.message?.items || []).map((item) => mapCrossrefWork(item, journal));
}

export async function syncJournals(stateInput, journalIds, { fetchImpl = globalThis.fetch, rows = 50, force = false } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持网络请求，无法同步期刊元数据');
  const state = createTopJournalState(stateInput);
  const catalog = catalogFor(state);
  const wanted = [...new Set((journalIds || []).filter((id) => catalog.some((journal) => journal.id === id)))];
  if (!wanted.length) return { state, synced: [], failed: [] };
  const synced = [];
  const failed = [];
  const fetched = [];
  // 会议目录页动辄 3~7 MB（CVPR 全量），签到每天都会跑一次；
  // 三小时内抓过且库里还有文章就跳过，避免「一天点三次签到就下 20 MB」。
  const FRESH_MS = 3 * 3600 * 1000;
  const hasArticlesFor = (id) => state.articles.some((article) => article.journalId === id);
  // 限制并发为 3，既比逐刊串行快，也避免对 Crossref / 知网 / 期刊官网造成突发请求。
  const queue = [...wanted];
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) {
      const id = queue.shift();
      const journal = catalog.find((candidate) => candidate.id === id);
      const attempts = sourceAttempts(journal);
      const errors = [];
      let done = false;
      if (!force && journal.kind === 'conference') {
        const prev = state.sync[id] || {};
        const fresh = prev.lastSuccessAt && Date.now() - Date.parse(prev.lastSuccessAt) < FRESH_MS;
        if (fresh && hasArticlesFor(id)) {
          synced.push({ journalId: id, count: 0, provider: 'conf', cached: true });
          continue;
        }
      }
      for (const sourceId of attempts) {
        try {
          const articles = await fetchFromSource(sourceId, journal, { fetchImpl, rows });
          fetched.push(...articles);
          const sourceUrl = sourceId === 'cnki'
            ? `https://rss.cnki.net/knavi/rss/${journal.cnkiCode}`
            : sourceId === 'site'
              ? (journal.feedUrl || '')
              : sourceId === 'rss'
                ? (journal.rssUrl || '')
                : sourceId === 'conf'
                  ? (articles.meta?.url || '')
                  : '';
          state.sync[id] = {
            lastSuccessAt: new Date().toISOString(),
            sourceId,
            source: SOURCE_LABEL[sourceId],
            sourceUrl,
            edition: sourceId === 'conf' ? String(articles.meta?.year || '') : '',
            count: articles.length,
            error: '',
          };
          synced.push({ journalId: id, count: articles.length, provider: sourceId });
          done = true;
          break;
        } catch (error) {
          errors.push(attempts.length > 1 ? `${SOURCE_LABEL[sourceId]}：${error?.message || '未知错误'}` : (error?.message || '未知同步错误'));
        }
      }
      if (!done) {
        state.sync[id] = { ...(state.sync[id] || {}), lastAttemptAt: new Date().toISOString(), error: errors.join('；') };
        failed.push({ journalId: id, error: errors.join('；'), provider: journal.sourceId || journal.provider, tried: attempts });
      }
    }
  });
  await Promise.all(workers);
  state.articles = mergeArticles(state.articles, fetched);
  return { state, synced, failed };
}

function articleDateMillis(article) {
  const parsed = Date.parse(`${article.publishedAt || ''}T12:00:00`);
  return Number.isFinite(parsed) ? parsed : 0;
}

function deliveredIdsFor(state, journalId) {
  const ids = new Set();
  for (const batch of Object.values(state.deliveries)) {
    for (const entry of batch?.items || []) if (entry.journalId === journalId) ids.add(entry.articleId);
  }
  return ids;
}

/**
 * 同一篇论文在不同数据源里的主键不同（官网目录用链接哈希 `cn:`、知网 RSS 用「期刊+标题」`cnk:`），
 * 用户切换数据源后旧记录仍留在投递历史里，只按 id 判重会把同一篇再投一次。
 * 所以投递时再按「期刊 + 规范化标题」判一次重。
 */
function titleKeyOf(article) {
  return String(article?.title || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[“”"‘’'']/g, '')
    .toLowerCase();
}

function deliveredTitleKeys(state) {
  const keys = new Set();
  const byId = new Map(state.articles.map((article) => [article.id, article]));
  for (const batch of Object.values(state.deliveries)) {
    for (const entry of batch?.items || []) {
      const article = byId.get(entry.articleId);
      if (article?.title) keys.add(`${entry.journalId}|${titleKeyOf(article)}`);
    }
  }
  return keys;
}

export function checkInAndCreateDelivery(stateInput, { date = dayKey(), perJournal = 5 } = {}) {
  if (!isValidDate(date)) throw new Error('签到日期格式无效');
  const state = createTopJournalState(stateInput);
  const existing = state.deliveries[date];
  if (!state.selectedJournalIds.length && !existing) throw new Error('请先在「期刊管理」勾选至少一本期刊');

  // 同一天再次签到不会重置旧投递；如果用户随后新增期刊（或旧期刊此前不足 5 篇），仅追加未投递文章。
  const now = new Date().toISOString();
  const limit = Math.max(1, Math.min(10, Number(perJournal) || 5));
  const delivery = existing
    ? { ...existing, items: Array.isArray(existing.items) ? [...existing.items] : [] }
    : { date, createdAt: now, items: [], shortages: [] };
  const addedEntries = [];
  const shortages = [];
  const deliveredTitles = deliveredTitleKeys(state);
  for (const journalId of state.selectedJournalIds) {
    const currentCount = delivery.items.filter((item) => item.journalId === journalId).length;
    const missing = Math.max(0, limit - currentCount);
    const previouslyDelivered = deliveredIdsFor(state, journalId);
    const candidates = state.articles
      .filter((article) => article.journalId === journalId && !previouslyDelivered.has(article.id))
      // 换数据源后同一篇会换 id，按标题再挡一层（见 deliveredTitleKeys 的说明）
      .filter((article) => !deliveredTitles.has(`${journalId}|${titleKeyOf(article)}`))
      .sort((a, b) => articleDateMillis(b) - articleDateMillis(a) || String(b.discoveredAt || '').localeCompare(String(a.discoveredAt || '')));
    const chosen = candidates.slice(0, missing);
    for (const article of chosen) {
      const entry = { journalId, articleId: article.id, slot: currentCount + addedEntries.filter((item) => item.journalId === journalId).length + 1, openedAt: '', savedAt: '' };
      delivery.items.push(entry);
      addedEntries.push(entry);
    }
    const totalForJournal = currentCount + chosen.length;
    if (totalForJournal < limit) shortages.push({ journalId, available: totalForJournal, requested: limit });
  }
  delivery.shortages = shortages;
  delivery.updatedAt = now;
  state.checkins[date] = { ...(state.checkins[date] || {}), checkedInAt: state.checkins[date]?.checkedInAt || now, deliveredCount: delivery.items.length };
  state.deliveries[date] = delivery;
  return { state, delivery, alreadyCheckedIn: Boolean(existing), addedCount: addedEntries.length };
}

export function deliveryArticles(stateInput, date = dayKey()) {
  const state = createTopJournalState(stateInput);
  const delivery = state.deliveries[date] || null;
  if (!delivery) return { delivery: null, articles: [] };
  const order = new Map(delivery.items.map((entry, index) => [entry.articleId, index]));
  return {
    delivery,
    articles: delivery.items.map((entry) => state.articles.find((article) => article.id === entry.articleId)).filter(Boolean)
      .sort((a, b) => order.get(a.id) - order.get(b.id)),
  };
}

export function recentArticles(stateInput, { journalIds = [], limit = 120 } = {}) {
  const state = createTopJournalState(stateInput);
  const ids = journalIds.length ? new Set(journalIds) : new Set(state.selectedJournalIds);
  return state.articles.filter((article) => !ids.size || ids.has(article.journalId))
    .sort((a, b) => articleDateMillis(b) - articleDateMillis(a) || String(b.discoveredAt || '').localeCompare(String(a.discoveredAt || '')))
    .slice(0, Math.max(1, Math.min(500, Number(limit) || 120)));
}

export function deliveredArticleIds(stateInput) {
  const state = createTopJournalState(stateInput);
  return new Set(Object.values(state.deliveries).flatMap((batch) => (batch?.items || []).map((entry) => entry.articleId)));
}

export function historyArticles(stateInput, { includeDeleted = false } = {}) {
  const state = createTopJournalState(stateInput);
  const ids = deliveredArticleIds(state);
  return state.articles
    .filter((article) => ids.has(article.id) && (includeDeleted || !state.deletedHistoryArticleIds[article.id]))
    .sort((a, b) => articleDateMillis(b) - articleDateMillis(a) || String(b.discoveredAt || '').localeCompare(String(a.discoveredAt || '')));
}

export function setArticleFavorite(stateInput, articleId, favorite = true) {
  const state = createTopJournalState(stateInput);
  if (!state.articles.some((article) => article.id === articleId)) throw new Error('文章不存在或已从本地缓存清理');
  if (favorite) state.favorites[articleId] = { ...(state.favorites[articleId] || {}), savedAt: state.favorites[articleId]?.savedAt || new Date().toISOString() };
  else delete state.favorites[articleId];
  return state;
}

export function removeFavorites(stateInput, articleIds) {
  const state = createTopJournalState(stateInput);
  const ids = [...new Set((Array.isArray(articleIds) ? articleIds : []).filter((id) => typeof id === 'string' && id))];
  let removedCount = 0;
  for (const id of ids) if (state.favorites[id]) { delete state.favorites[id]; removedCount += 1; }
  return { state, removedCount };
}

export function removeHistoryArticles(stateInput, articleIds) {
  const state = createTopJournalState(stateInput);
  const delivered = deliveredArticleIds(state);
  const ids = [...new Set((Array.isArray(articleIds) ? articleIds : []).filter((id) => typeof id === 'string' && id))];
  const deletedIds = [];
  for (const id of ids) {
    if (!delivered.has(id) || state.deletedHistoryArticleIds[id]) continue;
    state.deletedHistoryArticleIds[id] = { deletedAt: new Date().toISOString() };
    deletedIds.push(id);
  }
  return { state, deletedIds };
}

export function calendarSummary(stateInput, now = new Date()) {
  const state = createTopJournalState(stateInput);
  const today = dayKey(now);
  const cursor = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthPrefix = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-`;
  const checkinDays = Object.keys(state.checkins).filter((date) => date.startsWith(monthPrefix)).sort();
  let streak = 0;
  const walk = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  while (state.checkins[dayKey(walk)]) { streak += 1; walk.setDate(walk.getDate() - 1); }
  const libraryIds = deliveredArticleIds(state);
  const historyCount = [...libraryIds].filter((id) => !state.deletedHistoryArticleIds[id]).length;
  return { today, todayCheckedIn: Boolean(state.checkins[today]), streak, checkinDays, libraryCount: historyCount, historyCount, favoriteCount: Object.keys(state.favorites).length, selectedCount: state.selectedJournalIds.length };
}

export function markArticleOpened(stateInput, articleId, date = dayKey()) {
  const state = createTopJournalState(stateInput);
  const delivery = state.deliveries[date];
  if (!delivery) return state;
  const entry = delivery.items.find((item) => item.articleId === articleId);
  if (entry && !entry.openedAt) entry.openedAt = new Date().toISOString();
  return state;
}

export function pruneTopJournalState(stateInput, now = Date.now()) {
  const state = createTopJournalState(stateInput);
  // 文章元数据保留两年，已投递论文永不因清理而删除。
  const protectedIds = new Set([...deliveredArticleIds(state), ...Object.keys(state.favorites)]);
  state.articles = state.articles.filter((article) => protectedIds.has(article.id) || !article.publishedAt || Date.parse(article.publishedAt) >= now - 730 * DAY);
  return state;
}
