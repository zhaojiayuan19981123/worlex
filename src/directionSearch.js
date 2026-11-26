// directionSearch.js —— 方向分析（一）：检索候选文献
//
// 数据源为什么不是百度学术 / X-MOL：
//   这两家都要「登录 + 人机验证」才给搜索结果，服务端直连拿不到东西——
//   实测百度学术 `xueshu.baidu.com/s?wd=...` 返回 403「百度安全验证」页，
//   X-MOL `paper/search/q` 能拿到 200 但页面里是「共有 0 个结果 / 暂无搜索结果」，
//   列表要靠登录后的前端接口渲染。所以检索改走 OpenAlex（开放学术数据库）：
//   免 key、有摘要、有引用数、有 DOI 与 OA 全文链接，服务端可稳定取数。
//   百度学术 / X-MOL 保留为「用同一组关键词去网页上看」的跳转按钮（见 linksFor），
//   用户在自己浏览器里登录、过验证码都不影响本功能。
//
// 本模块只做「查询构造 + 取数 + 归一化 + 多主题合并」，不碰存储、不碰大模型，
// 方便单测注入 fetchImpl。

const API = 'https://api.openalex.org/works';

/** 只取需要的字段：一页 50 条的响应从 600 KB 降到约 200 KB */
const SELECT = [
  'id', 'doi', 'display_name', 'publication_year', 'publication_date',
  'abstract_inverted_index', 'authorships', 'primary_location', 'cited_by_count',
  'type', 'language', 'open_access', 'best_oa_location', 'primary_topic',
].join(',');

/** 检索字段：值即 OpenAlex 的 filter 键 */
export const SEARCH_FIELDS = [
  { id: 'default', label: '全部字段', key: 'default.search' },
  { id: 'title_abstract', label: '标题 + 摘要', key: 'title_and_abstract.search' },
  { id: 'title', label: '仅标题', key: 'title.search' },
  { id: 'abstract', label: '仅摘要', key: 'abstract.search' },
  { id: 'keyword', label: '关键词 / 主题', key: 'keyword.search' },
  { id: 'author', label: '作者', key: 'raw_author_name.search' },
];

// 只保留期刊论文：article = 研究论文，review = 期刊综述。
// 预印本 / 会议论文 / 图书章节都不收，避免用户勾选后才发现不是正式发表文献。
export const WORK_TYPES = [
  { id: 'article|review', label: '期刊论文（含综述）' },
];

export const SORTS = [
  { id: 'relevance', label: '相关度', openalex: 'relevance_score:desc' },
  { id: 'cited', label: '引用数', openalex: 'cited_by_count:desc' },
  { id: 'recent', label: '最新发表', openalex: 'publication_date:desc' },
];

export const DEFAULT_FILTERS = {
  yearFrom: 0,          // 0 = 不限
  yearTo: 0,
  minCitations: 0,
  // 用户口径：只看英文的世界核心期刊论文，预印本不要。
  // OpenAlex 没有 Web of Science 的期刊名单，`is_core` 是 CWTS Core sources
  //（与 WoS 核心高度重叠的开放列表），这里用它做服务端硬过滤。
  type: 'article|review',
  language: 'en',
  coreOnly: true,
  onlyWithAbstract: true,
  includeRetracted: false,
  sort: 'relevance',
  perTopic: 30,         // 每个主题取多少条
};

/** 最多几个主题：再多就是「把整个领域搜一遍」，摘要拼给模型也没有意义 */
export const MAX_TOPICS = 6;
/** 合并后最多保留多少条候选（前端列表 + 多选上游的天花板） */
export const MAX_RESULTS = 120;
/** 单个短语最长：防止把整段话当关键词贴进来 */
const MAX_PHRASE = 80;

const str = (v) => String(v == null ? '' : v);
const clean = (v) => str(v).replace(/\s+/g, ' ').trim();
const clampInt = (v, min, max, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

/** 把「, ; ，； 换行」分隔的关键词拆成短语数组；空格留在短语内部（学术短语几乎都带空格） */
export function topicPhrases(keywords) {
  const seen = new Set();
  const out = [];
  for (const raw of str(keywords).split(/[,;，；\n\r]+/)) {
    let phrase = clean(raw).replace(/^["'“”]+|["'“”]+$/g, '').trim();
    if (!phrase) continue;
    phrase = phrase.slice(0, MAX_PHRASE);
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(phrase);
    if (out.length >= 6) break;
  }
  return out;
}

/** 词组 → OpenAlex 能识别的短语（带空格就加引号，避免被拆成松散的词袋） */
function quotePhrase(phrase) {
  const text = clean(phrase).replace(/"/g, '');
  if (!text) return '';
  return /[\s-]/.test(text) && text.length > 2 ? `"${text}"` : text;
}

/** 单个主题的规范化：前端传什么都要能兜住 */
export function normalizeTopic(raw, index = 0) {
  const keywords = clean(raw?.keywords ?? raw?.query ?? '');
  const field = SEARCH_FIELDS.some((f) => f.id === raw?.field) ? raw.field : 'default';
  return {
    id: clean(raw?.id) || `t${index + 1}`,
    name: clean(raw?.name) || keywords.split(/[,;，；\n]/)[0].slice(0, 40) || `主题 ${index + 1}`,
    keywords,
    exclude: clean(raw?.exclude),
    field,
    enabled: raw?.enabled !== false,
  };
}

export function normalizeFilters(raw = {}) {
  const sort = SORTS.some((s) => s.id === raw?.sort) ? raw.sort : DEFAULT_FILTERS.sort;
  // 这三个是硬约束，不接受前端改成「全部 / 中文 / 预印本」：
  // 需求明确只显示英文期刊论文、不纳入预印本与非核心期刊。
  const type = DEFAULT_FILTERS.type;
  const language = DEFAULT_FILTERS.language;
  const coreOnly = raw?.coreOnly !== false;
  let yearFrom = clampInt(raw?.yearFrom, 0, 2100, 0);
  let yearTo = clampInt(raw?.yearTo, 0, 2100, 0);
  if (yearFrom && yearTo && yearFrom > yearTo) [yearFrom, yearTo] = [yearTo, yearFrom];
  return {
    yearFrom, yearTo,
    minCitations: clampInt(raw?.minCitations, 0, 100000, 0),
    type, language, coreOnly,
    onlyWithAbstract: raw?.onlyWithAbstract !== false,
    includeRetracted: raw?.includeRetracted === true,
    sort,
    perTopic: clampInt(raw?.perTopic, 5, 50, DEFAULT_FILTERS.perTopic),
  };
}

/**
 * 主题 + 过滤条件 → OpenAlex 的查询参数。
 * 「必须同时包含」用 AND 串起来（多主题 = 多查一次再合并，比在一条查询里写括号可靠）；
 * 排除词不走服务端——实测 `NOT` / `-词` 的语义不稳定，改为拿到结果后本地过滤。
 */
export function buildQuery(topic, filters) {
  const f = normalizeFilters(filters);
  const phrases = topicPhrases(topic?.keywords).map(quotePhrase).filter(Boolean);
  const fieldKey = (SEARCH_FIELDS.find((x) => x.id === topic?.field) || SEARCH_FIELDS[0]).key;
  const search = phrases.join(' AND ');

  const filterParts = [];
  // 「全部字段」走 search 参数（服务端按相关度打分），指定字段只能走 filter 的 xxx.search 键
  if (search && fieldKey !== 'default.search') filterParts.push(`${fieldKey}:${search}`);
  if (f.yearFrom && f.yearTo) filterParts.push(`publication_year:${f.yearFrom}-${f.yearTo}`);
  else if (f.yearFrom) filterParts.push(`publication_year:>${f.yearFrom - 1}`);
  else if (f.yearTo) filterParts.push(`publication_year:<${f.yearTo + 1}`);
  if (f.minCitations > 0) filterParts.push(`cited_by_count:>${f.minCitations - 1}`);
  if (f.type) filterParts.push(`type:${f.type}`);
  if (f.language) filterParts.push(`language:${f.language}`);
  // 只收正式期刊：排除会议论文集、预印本平台与非核心来源
  filterParts.push('primary_location.source.type:journal');
  if (f.coreOnly) filterParts.push('primary_location.source.is_core:true');
  if (f.onlyWithAbstract) filterParts.push('has_abstract:true');
  if (!f.includeRetracted) filterParts.push('is_retracted:false');

  return {
    search: fieldKey === 'default.search' ? search : '',
    filter: filterParts.join(','),
    sort: (SORTS.find((s) => s.id === f.sort) || SORTS[0]).openalex,
  };
}

/** 单个 filter 值的编码：逗号是「多个 filter」的分隔符，不能编码进去 */
function encodeFilterValue(value) {
  return encodeURIComponent(value)
    .replace(/%3A/gi, ':')     // 「键:值」的冒号必须原样
    .replace(/%7C/gi, '|')     // type:article|review 的枚举分隔
    .replace(/%3E/gi, '>')
    .replace(/%3C/gi, '<');
}

/** 拼请求地址（导出成独立函数，单测直接断言 URL 形状） */
export function buildUrl(topic, filters, { page = 1, mailto = '' } = {}) {
  const f = normalizeFilters(filters);
  const q = buildQuery(topic, f);
  const params = [`per_page=${f.perTopic}&page=${page}`, `select=${SELECT}`, `sort=${q.sort}`];
  if (q.search) params.push(`search=${encodeURIComponent(q.search)}`);
  if (q.filter) {
    const encoded = q.filter.split(',').map(encodeFilterValue).join(',');
    params.push(`filter=${encoded}`);
  }
  if (mailto) params.push(`mailto=${encodeURIComponent(mailto)}`);
  return `${API}?${params.join('&')}`;
}

/** abstract_inverted_index（词 → 位置数组）还原成正常段落 */
export function reconstructAbstract(inverted) {
  if (!inverted || typeof inverted !== 'object') return '';
  const slots = [];
  for (const [word, positions] of Object.entries(inverted)) {
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) {
      const index = Number(pos);
      if (Number.isInteger(index) && index >= 0) slots[index] = word;
    }
  }
  return slots.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

const DOI_PREFIX = /^https?:\/\/(?:dx\.)?doi\.org\//i;

export function stripDoi(value) {
  return clean(value).replace(DOI_PREFIX, '').toLowerCase();
}

/** OpenAlex work → 前端/模型都用得上的扁平结构 */
export function parseWork(item) {
  if (!item || typeof item !== 'object') return null;
  const title = clean(item.display_name || item.title) || '（无标题）';
  const doi = stripDoi(item.doi);
  const abstract = reconstructAbstract(item.abstract_inverted_index);
  const authors = (Array.isArray(item.authorships) ? item.authorships : [])
    .map((a) => clean(a?.author?.display_name || a?.raw_author_name))
    .filter(Boolean);
  const primary = item.primary_location || {};
  const source = primary.source || {};
  const best = item.best_oa_location || {};
  const venue = clean(source.display_name || source.host_organization_name) || '';
  const oaUrl = clean(best.pdf_url || primary.pdf_url || '');
  const landUrl = clean(best.landing_page_url || primary.landing_page_url || '');
  const openalexId = clean(item.ids?.openalex || item.id).replace(/^https?:\/\/openalex\.org\//i, '');
  const url = oaUrl || landUrl || (doi ? `https://doi.org/${doi}` : '') || (openalexId ? `https://openalex.org/${openalexId}` : '');
  const authorLine = authors.length > 3 ? `${authors.slice(0, 3).join('，')} 等 ${authors.length} 人` : authors.join('，');
  return {
    id: openalexId ? `oa:${openalexId}` : `tt:${title.slice(0, 60).toLowerCase()}`,
    openalexId,
    doi,
    title,
    abstract,
    hasAbstract: abstract.length >= 60,
    year: Number(item.publication_year) || 0,
    date: clean(item.publication_date),
    authors,
    authorLine,
    venue,
    venueId: clean(source.id).replace(/^https?:\/\/openalex\.org\//i, ''),
    venueKind: clean(source.type),
    issn: clean(source.issn_l),
    isCore: source.is_core === true,
    citedBy: Number(item.cited_by_count) || 0,
    type: clean(item.type),
    language: clean(item.language),
    topic: clean(item.primary_topic?.display_name),
    oaUrl,
    landUrl,
    url,
    /** 命中的主题（合并阶段回填） */
    topics: [],
  };
}

/** 标题规范化：跨库去重时标题顺序/标点常变，只留字母数字 */
export function titleKey(title) {
  return clean(title).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '');
}

export function workKey(work) {
  if (work?.doi) return `doi:${work.doi}`;
  return `tt:${titleKey(work?.title)}`;
}

/** 排除词：标题 + 摘要里出现任意一个就丢掉（服务端 NOT 语义不稳，本地过滤更可控） */
function isExcluded(work, excludePhrases) {
  if (!excludePhrases.length) return false;
  const haystack = `${work.title} ${work.abstract}`.toLowerCase();
  return excludePhrases.some((p) => haystack.includes(p.toLowerCase()));
}

async function fetchJson(url, { fetchImpl, signal, timeoutMs = 30000 }) {
  const impl = fetchImpl || fetch;
  const own = new AbortController();
  const timer = setTimeout(() => own.abort(), timeoutMs);
  const onAbort = () => own.abort();
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await impl(url, {
      headers: { accept: 'application/json', 'user-agent': 'worlex/2.7 (direction-analysis)' },
      signal: own.signal,
    });
    const text = typeof res.text === 'function' ? await res.text() : '';
    let data = null;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!res.ok) {
      const detail = clean(data?.message || data?.error || text).slice(0, 200);
      const error = new Error(`检索接口返回 ${res.status}${detail ? `：${detail}` : ''}`);
      error.status = res.status;
      throw error;
    }
    if (!data) throw new Error('检索接口返回的不是 JSON');
    return data;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 一个主题的检索。取回后用本地规则再过一遍（摘要门槛、排除词），
 * 不够数就再翻一页——但最多两页，别把一次检索拖成一分钟。
 */
export async function searchTopic(topic, filters, deps = {}) {
  const f = normalizeFilters(filters);
  const excludePhrases = topicPhrases(topic?.exclude);
  const collected = [];
  const seen = new Set();
  let total = 0;
  let droppedByExclude = 0;
  let droppedByScope = 0;
  let pages = 0;

  for (let page = 1; page <= 2; page += 1) {
    const data = await fetchJson(buildUrl(topic, f, { page, mailto: deps.mailto || '' }), deps);
    pages = page;
    total = Number(data?.meta?.count) || 0;
    const results = Array.isArray(data?.results) ? data.results : [];
    if (!results.length) break;
    for (const raw of results) {
      const work = parseWork(raw);
      if (!work) continue;
      const key = workKey(work);
      if (seen.has(key)) continue;
      seen.add(key);
      // 服务端已经按 type / language / is_core 过滤；这里再兜一层，
      // 免得接口字段缺失时把预印本或非期刊来源混进候选列表。
      if (work.type === 'preprint'
        || (raw?.primary_location?.source?.type && clean(raw.primary_location.source.type) !== 'journal')
        || (f.coreOnly && raw?.primary_location?.source?.is_core === false)) {
        droppedByScope += 1;
        continue;
      }
      if (f.onlyWithAbstract && !work.hasAbstract) continue;
      if (isExcluded(work, excludePhrases)) { droppedByExclude += 1; continue; }
      collected.push(work);
      if (collected.length >= f.perTopic) break;
    }
    if (collected.length >= f.perTopic) break;
    // 第一页被过滤掉太多时才翻第二页：省一次请求
    if (results.length < f.perTopic) break;
  }

  return { topicId: topic.id, topicName: topic.name, total, works: collected, droppedByExclude, droppedByScope, pages, error: '' };
}

/** 并发受限的 map：同时最多 3 个请求，避免一次开 6 条把接口打限流 */
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * 多主题检索：并发取数 → 按主题轮转合并（每个主题都有机会进前列，不会被第一个主题包场）
 * → 去重（DOI 优先）→ 截断。
 */
export async function searchTopics(topics, filters, deps = {}) {
  const f = normalizeFilters(filters);
  const list = (Array.isArray(topics) ? topics : [])
    .map((t, i) => normalizeTopic(t, i))
    .filter((t) => t.enabled !== false && topicPhrases(t.keywords).length);
  if (!list.length) return { papers: [], perTopic: [], error: '请至少填写一个主题关键词' };
  if (list.length > MAX_TOPICS) return { papers: [], perTopic: [], error: `最多 ${MAX_TOPICS} 个主题` };

  const settled = await mapLimit(list, clampInt(deps.concurrency, 1, 4, 3), async (topic) => {
    try {
      return await searchTopic(topic, f, deps);
    } catch (error) {
      return { topicId: topic.id, topicName: topic.name, total: 0, works: [], droppedByExclude: 0, droppedByScope: 0, pages: 0, error: error.message || '检索失败' };
    }
  });

  const merged = [];
  const seen = new Set();
  let duplicated = 0;
  const longest = settled.reduce((max, r) => Math.max(max, r.works.length), 0);
  for (let i = 0; i < longest; i += 1) {
    for (const result of settled) {
      const work = result.works[i];
      if (!work) continue;
      const key = workKey(work);
      if (seen.has(key)) {
        duplicated += 1;
        const existing = merged.find((w) => workKey(w) === key);
        if (existing && !existing.topics.includes(result.topicName)) existing.topics.push(result.topicName);
        continue;
      }
      seen.add(key);
      merged.push({ ...work, topics: [result.topicName] });
      if (merged.length >= MAX_RESULTS) break;
    }
    if (merged.length >= MAX_RESULTS) break;
  }

  return {
    papers: merged,
    perTopic: settled.map(({ works, ...rest }) => ({ ...rest, fetched: works.length })),
    duplicated,
    truncated: merged.length >= MAX_RESULTS,
    error: '',
  };
}

/** 「用同一组关键词去网页上看」的跳转地址（百度学术 / X-MOL 服务端都拿不到，只能交给浏览器） */
export function linksFor(topics) {
  const query = (Array.isArray(topics) ? topics : [])
    .flatMap((t) => topicPhrases(t?.keywords))
    .slice(0, 3)
    .join(' ');
  if (!query) return { query: '', baidu: '', xmol: '' };
  const q = encodeURIComponent(query);
  return {
    query,
    baidu: `https://xueshu.baidu.com/s?wd=${q}`,
    xmol: `https://www.x-mol.com/paper/search/q?option=${q}`,
    openalex: `https://openalex.org/works?search=${q}`,
  };
}
