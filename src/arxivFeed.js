// arxivFeed.js —— arXiv 分类浏览：类别目录 + Atom 解析 + 取数
//
// arXiv 的 API 是 Atom XML（不是 JSON），而且 http 会 301 到 https，
// 所以这里只用 Node 内置能力解析：按 <entry> 切块、抽字段、还原 XML 实体。
// 不做 HTML 清洗：arXiv 的 title/summary 是纯文本，转义后即可直接放进页面。

const API = 'https://export.arxiv.org/api/query';

/** 左侧栏的分组目录：id 就是 arXiv API 的 cat: 值 */
export const ARXIV_GROUPS = [
  {
    name: '计算机科学',
    items: [
      ['cs.AI', '人工智能'], ['cs.LG', '机器学习'], ['cs.CV', '计算机视觉'],
      ['cs.CL', '计算语言学'], ['cs.IR', '信息检索'], ['cs.DB', '数据库'],
      ['cs.DS', '数据结构与算法'], ['cs.CR', '密码学与安全'], ['cs.NI', '网络与互联网'],
      ['cs.RO', '机器人'], ['cs.HC', '人机交互'], ['cs.SE', '软件工程'],
      ['cs.AR', '硬件架构'], ['cs.GT', '计算机科学博弈论'], ['cs.MA', '多智能体'],
      ['cs.DC', '分布式计算'], ['cs.CY', '计算机与社会'], ['cs.MM', '多媒体'],
      ['cs.SD', '声音'], ['cs.LO', '逻辑'], ['cs.PL', '程序语言'], ['cs.SC', '符号计算'],
      ['cs.SI', '社会与信息网络'], ['cs.DL', '数字图书馆'], ['cs.NA', '数值分析'],
    ],
  },
  {
    name: '统计与数学',
    items: [
      ['stat.ML', '机器学习统计'], ['stat.ME', '方法论'], ['stat.TH', '统计理论'],
      ['stat.AP', '应用统计'], ['stat.CO', '计算统计'],
      ['math.OC', '最优化'], ['math.ST', '统计理论'], ['math.CO', '组合数学'],
      ['math.AG', '代数几何'], ['math.NA', '数值分析'], ['math.DG', '微分几何'], ['math.PR', '概率'],
    ],
  },
  {
    name: '工程与物理',
    items: [
      ['eess.SY', '系统与控制'], ['eess.SP', '信号处理'], ['eess.IV', '图像与视频'],
      ['quant-ph', '量子物理'], ['hep-th', '高能物理理论'], ['cond-mat', '凝聚态'],
      ['astro-ph', '天体物理'], ['gr-qc', '广义相对论'], ['nucl-th', '核理论'],
    ],
  },
  {
    name: '生物与经济',
    items: [
      ['q-bio.BM', '生物大分子'], ['q-bio.GN', '基因组学'], ['q-bio.NC', '神经元与认知'],
      ['q-bio.PE', '种群与进化'], ['econ.EM', '计量经济学'], ['econ.GN', '一般经济学'],
      ['econ.TH', '经济理论'],
    ],
  },
];

export const ARXIV_SORTS = [
  { id: 'submittedDate', label: '最新提交' },
  { id: 'relevance', label: '相关度' },
];

export const DEFAULT_CATEGORY = 'cs.AI';
/** 一页最多多少：arXiv 建议单次不超过 2000，界面按 20 条翻页 */
export const MAX_PER_PAGE = 50;

const str = (v) => String(v == null ? '' : v);
const clean = (v) => str(v).replace(/\s+/g, ' ').trim();

/** Atom 里的实体（title/summary 常带 &amp; &lt; 和 &#xx;） */
export function decodeXml(value) {
  return str(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16) || 0))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec) || 0))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

const pick = (block, re) => decodeXml(re.exec(block)?.[1] || '');

/** Atom feed → {total, start, entries}。单条解析失败就跳过，不让整页挂掉。 */
export function parseArxivFeed(xml) {
  const text = str(xml);
  const total = Number(pick(text, /<opensearch:totalResults>([\s\S]*?)<\/opensearch:totalResults>/)) || 0;
  const start = Number(pick(text, /<opensearch:startIndex>([\s\S]*?)<\/opensearch:startIndex>/)) || 0;
  const entries = [];
  for (const match of text.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const block = match[1];
    const rawId = pick(block, /<id>([\s\S]*?)<\/id>/);
    const title = clean(pick(block, /<title>([\s\S]*?)<\/title>/));
    if (!title) continue;
    const authors = [...block.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)]
      .map((m) => clean(decodeXml(m[1]))).filter(Boolean);
    const categories = [...block.matchAll(/<category[^>]*\bterm="([^"]+)"/g)]
      .map((m) => m[1]).filter(Boolean);
    // arXiv 的 PDF 链接形如 /pdf/2601.12345v1（不一定以 .pdf 结尾）
    const pdf = pick(block, /<link[^>]*href="([^"]+\/pdf\/[^"]+)"[^>]*>/);
    const absUrl = rawId.replace(/^http:/, 'https:');
    entries.push({
      id: rawId.split('/abs/')[1] || rawId,
      title,
      authors,
      authorLine: authors.length > 4 ? `${authors.slice(0, 4).join('，')} 等 ${authors.length} 人` : authors.join('，'),
      abstract: clean(pick(block, /<summary>([\s\S]*?)<\/summary>/)),
      published: pick(block, /<published>([\s\S]*?)<\/published>/),
      updated: pick(block, /<updated>([\s\S]*?)<\/updated>/),
      categories,
      primaryCategory: pick(block, /<arxiv:primary_category[^>]*\bterm="([^"]+)"/),
      journalRef: clean(pick(block, /<arxiv:journal_ref>([\s\S]*?)<\/arxiv:journal_ref>/)),
      doi: clean(pick(block, /<arxiv:doi>([\s\S]*?)<\/arxiv:doi>/)),
      absUrl,
      pdfUrl: pdf || `${absUrl}.pdf`,
    });
  }
  return { total, start, entries };
}

/** 查询串拼装：类别走 cat:，关键词走 all:，多个词用 AND（arXiv 的 OR 括号不可靠） */
export function buildArxivUrl({ category = DEFAULT_CATEGORY, query = '', start = 0, perPage = 20, sort = 'submittedDate' } = {}) {
  const cat = clean(category) || DEFAULT_CATEGORY;
  const words = clean(query).split(/[\s,，]+/).filter(Boolean).slice(0, 6);
  const parts = [];
  if (words.length) parts.push(words.map((w) => `all:${/[\s]/.test(w) ? `"${w}"` : w}`).join(' AND '));
  if (cat !== 'all') parts.push(`cat:${cat}`);
  const searchQuery = parts.length ? parts.join(' AND ') : `cat:${DEFAULT_CATEGORY}`;
  const sortBy = ARXIV_SORTS.some((s) => s.id === sort) ? sort : 'submittedDate';
  const params = new URLSearchParams({
    search_query: searchQuery,
    start: String(Math.max(0, Math.round(Number(start) || 0))),
    max_results: String(Math.min(MAX_PER_PAGE, Math.max(1, Math.round(Number(perPage) || 20)))),
    sortBy,
    sortOrder: 'descending',
  });
  return `${API}?${params.toString()}`;
}

/** 取一页 arXiv 结果；fetchImpl 可注入，便于完全离线的单测 */
export async function fetchArxiv(options = {}, deps = {}) {
  const impl = deps.fetchImpl || fetch;
  const url = buildArxivUrl(options);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(deps.timeoutMs) > 0 ? Number(deps.timeoutMs) : 30000);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const res = await impl(url, {
      headers: { 'user-agent': 'worlex/2.9 (arxiv-browser)', accept: 'application/atom+xml' },
      signal: ctrl.signal,
    });
    const xml = typeof res.text === 'function' ? await res.text()
      : typeof res.arrayBuffer === 'function' ? Buffer.from(await res.arrayBuffer()).toString('utf8') : '';
    if (!res.ok) throw new Error(`arXiv 返回 HTTP ${res.status}`);
    return { ...parseArxivFeed(xml), url };
  } finally {
    clearTimeout(timer);
  }
}
