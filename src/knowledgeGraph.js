// knowledgeGraph.js —— 主题聚类 + 文献关系图的纯逻辑（无外部依赖、无 fs）
// 所有导出对 null / undefined / 异常输入兜底，且结果确定（相同输入相同输出）。
function str(v) {
  if (v == null) return '';
  const t = typeof v;
  if (t === 'string') return v;
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v);
  if (t === 'function' || t === 'symbol') return '';
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(' ');
  try { return JSON.stringify(v) ?? ''; } catch { return ''; }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toList(v) {
  if (Array.isArray(v)) return v.map((x) => str(x).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(/[;；]+/).map((x) => x.trim()).filter(Boolean);
  if (v == null || typeof v === 'object' || typeof v === 'function' || typeof v === 'symbol') return [];
  return [str(v).trim()].filter(Boolean);
}

function cmpStr(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

// 标签用词黑名单（只排除功能词，保留实词）
const LABEL_STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'these', 'those', 'are',
  'was', 'were', 'been', 'being', 'into', 'about', 'between', 'through',
  'during', 'also', 'than', 'then', 'have', 'has', 'not', 'but', 'our',
  'their', 'its', 'his', 'her', 'you', 'your', 'she', 'him', 'who', 'how',
  'all', 'any', 'each', 'both', 'few',
  '我们', '本文', '通过', '进行', '以及', '一个', '一种', '可以', '其中',
  '这些', '那些', '并且', '所以',
]);

// 中文虚词 / 量词字符。tokenize() 用 2-gram 切中文，会造出「不会 / 个非 / 会不」
// 这类碎片；直接拿权重最高的碎片当主题名，图谱上就是一串看不懂的字。
const CJK_NOISE = new Set([...'的了和与及或在是有为对中也很就会个非之其所这那我你他它们以但并更能无未已可将把被让从向于而且若只又再还上下一二三不没说做用等如因由使给每该本此些被比最']);

function labelTerm(t) {
  const s = str(t).toLowerCase().trim();
  if (s.length < 2 || /^\d+$/.test(s) || LABEL_STOP.has(s)) return false;
  if (/^[a-z][a-z0-9]*$/.test(s)) return s.length >= 3 && !LABEL_STOP.has(s);
  if (/^[\u4e00-\u9fff]+$/.test(s)) return [...s].every((c) => !CJK_NOISE.has(c));
  return true;
}

const CLUSTER_THRESHOLD = 0.2;

// 条目向量：正文 token 权重 1，关键词单元权重 2（突出主题词）
function entryVector(entry) {
  const m = new Map();
  const add = (t, w) => {
    const k = str(t).toLowerCase().trim();
    if (!k) return;
    m.set(k, (m.get(k) || 0) + w);
  };
  for (const t of Array.isArray(entry?.tokens) ? entry.tokens : []) add(t, 1);
  for (const k of toList(entry?.keywords)) {
    const units = str(k).toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]{1,2}/g) || [];
    for (const u of units) add(u, 2);
  }
  return m;
}

// 余弦相似度（簇向量取成员平均）
function simToCluster(vec, cluster) {
  if (!vec.size || !cluster.count) return 0;
  const cnt = cluster.count;
  let dot = 0, na = 0, nb = 0;
  for (const [t, w] of vec) {
    na += w * w;
    const cw = cluster.sum.get(t);
    if (cw) dot += w * (cw / cnt);
  }
  for (const cw of cluster.sum.values()) {
    const v = cw / cnt;
    nb += v * v;
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

function labelOf(cluster, list) {
  // AI 解析出的关键词是完整词，比 2-gram 碎片可靠得多：簇内有两个以上就用它们当主题名
  const kwCount = new Map();
  for (const idx of cluster.members) {
    for (const k of toList(list[idx]?.keywords)) {
      const s = str(k).trim();
      if (s.length >= 2) kwCount.set(s, (kwCount.get(s) || 0) + 1);
    }
  }
  const kws = [...kwCount.entries()]
    .sort((a, b) => (b[1] - a[1]) || cmpStr(a[0], b[0])).slice(0, 3).map(([k]) => k);
  if (kws.length >= 2) return { label: kws.join(' · '), terms: kws };

  const ranked = [...cluster.sum.entries()]
    .filter(([t]) => labelTerm(t))
    .sort((a, b) => (b[1] - a[1]) || cmpStr(a[0], b[0]));
  const seen = new Set();
  const terms = [];
  for (const [t] of ranked) {
    // 2-gram 的正反序（「不会」「会不」）算同一个词，只留权重高的那个
    const key = /^[\u4e00-\u9fff]+$/.test(t) ? [...t].sort().join('') : t;
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(t);
    if (terms.length >= 4) break;
  }
  if (terms.length >= 2) return { label: terms.join(' · '), terms };
  // 退化：只有单个关键词就用它；一个都没有则用首篇短标题，别把碎片拼成主题名
  if (kws.length) return { label: kws[0], terms: kws };
  const first = list[cluster.members[0]];
  const title = str(first?.title || first?.titleZh).trim();
  const short = title.length > 16 ? `${title.slice(0, 16)}…` : title;
  return short ? { label: short, terms: [] } : { label: '未分类', terms: [] };
}

export function clusterTopics(entries, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const mt = Number(opts.maxTopics);
  const maxTopics = Number.isFinite(mt) && mt > 0 ? Math.min(Math.floor(mt), 50) : 12;
  const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e === 'object') : [];
  if (!list.length) return { topics: [], assignments: {} };

  const vectors = list.map(entryVector);
  const clusters = [];
  let uncategorized = null; // 退化（空向量）条目统一归「未分类」
  const assign = new Map(); // index -> { topicId, label, score }

  for (let i = 0; i < list.length; i++) {
    const vec = vectors[i];
    if (!vec.size) {
      if (!uncategorized) {
        uncategorized = { id: 'topic-uncategorized', members: [], count: 0, sum: new Map() };
      }
      uncategorized.members.push(i);
      assign.set(i, { topicId: uncategorized.id, label: '未分类', score: 0 });
      continue;
    }
    // 贪心：归入最相似的已有簇（严格大于保证并列时取先建立的簇 → 确定性）
    let best = -1, bestScore = 0;
    for (let c = 0; c < clusters.length; c++) {
      const s = simToCluster(vec, clusters[c]);
      if (s > bestScore + 1e-9) { bestScore = s; best = c; }
    }
    let target;
    if (best >= 0 && bestScore >= CLUSTER_THRESHOLD) {
      target = clusters[best];
    } else if (clusters.length < maxTopics) {
      target = { id: `topic-${clusters.length + 1}`, members: [], count: 0, sum: new Map() };
      clusters.push(target);
    } else {
      target = clusters[best >= 0 ? best : 0]; // 已达上限：并入最相似簇
    }
    target.members.push(i);
    target.count += 1;
    for (const [t, w] of vec) target.sum.set(t, (target.sum.get(t) || 0) + w);
    assign.set(i, { topicId: target.id, label: null, score: Math.round(bestScore * 1000) / 1000 });
  }

  const topics = [];
  for (const c of clusters) {
    const { label, terms } = labelOf(c, list);
    c.label = label;
    topics.push({ id: c.id, label, terms, count: c.members.length });
  }
  if (uncategorized) {
    topics.push({ id: uncategorized.id, label: '未分类', terms: [], count: uncategorized.members.length });
  }
  const assignments = {};
  for (let i = 0; i < list.length; i++) {
    const a = assign.get(i);
    const label = a.label || clusters.find((c) => c.id === a.topicId)?.label || '未分类';
    const key = str(list[i].id).trim() || `entry-${i}`;
    assignments[key] = { topicId: a.topicId, label, score: a.score };
  }
  return { topics, assignments };
}

const MAX_DOCS = 400;
const MAX_EDGES = 1200;
// 这里的度数按「不同对端文献」计，一篇最多和 6 篇相连；
// 同两篇之间可以同时有「同关键词 / 同方法 / 同对象」多条边，不算重复占用额度。
const MAX_DEGREE = 6;
// 边只建立在内容交集上：同关键词、同研究方法、同研究对象。
// 「同属分类」「共同作者」是元数据，不代表两篇文献讲的是同一件事，已不参与建边。
const THRESHOLDS = { keyword: 0.4, method: 0.5, subject: 0.45, citation: 0.8 };

/**
 * 研究方法词表：[规范名, ...别名]。
 * 关键词里常常没有方法，方法只写在摘要里（"we conducted a survey"），
 * 所以匹配范围是标题 + 关键词 + 摘要，而不是只看 keywords。
 * 中文别名按子串匹配，英文按词边界（允许复数），避免 sem 命中 semantic、did 命中助动词。
 */
const METHOD_LEXICON = [
  ['问卷', '问卷', 'survey', 'questionnaire'],
  ['实验', '实验', 'experiment', 'experimental'],
  ['准实验', '准实验', 'quasi-experiment', 'natural experiment'],
  ['结构方程模型', '结构方程', 'structural equation', 'sem', 'pls-sem'],
  ['回归分析', '回归分析', '回归', 'regression', 'ols'],
  ['离散选择模型', '离散选择', 'logit', 'probit', 'discrete choice'],
  ['面板数据', '面板数据', 'panel data', '固定效应', 'fixed effect'],
  ['双重差分', '双重差分', 'difference-in-differences'],
  ['工具变量', '工具变量', 'instrumental variable'],
  ['倾向得分匹配', '倾向得分', 'propensity score'],
  ['元分析', '元分析', '荟萃分析', 'meta-analysis', 'meta analysis'],
  ['内容分析', '内容分析', 'content analysis'],
  ['文本挖掘', '文本挖掘', '文本分析', 'text mining', 'text analysis'],
  ['主题模型', '主题模型', 'topic model', 'lda'],
  ['机器学习', '机器学习', 'machine learning', '随机森林', 'random forest', 'xgboost', '支持向量机', 'svm'],
  ['深度学习', '深度学习', 'deep learning', '神经网络', 'neural network', 'transformer', 'bert'],
  ['大语言模型', '大语言模型', '大模型', 'large language model', 'llm', 'chatgpt', 'generative ai'],
  ['自然语言处理', '自然语言处理', 'nlp', 'natural language processing'],
  ['计算机视觉', '计算机视觉', 'computer vision', '图像识别', 'image recognition', '多模态', 'multimodal'],
  ['访谈', '访谈', 'interview'],
  ['焦点小组', '焦点小组', 'focus group'],
  ['案例研究', '案例研究', '案例分析', 'case study'],
  ['扎根理论', '扎根理论', 'grounded theory'],
  ['眼动追踪', '眼动', 'eye tracking', 'eye-tracking'],
  ['神经科学方法', '脑电', 'eeg', 'fmri', '脑成像'],
  ['联合分析', '联合分析', 'conjoint'],
  ['社会网络分析', '社会网络', 'social network'],
  ['文献综述', '文献综述', '系统综述', 'systematic review', 'literature review'],
  ['混合方法', '混合方法', 'mixed method'],
  ['A/B 测试', 'a/b 测试', 'a/b test', 'ab test', 'ab测试'],
  ['仿真', '仿真', 'simulation', 'agent-based', '多主体'],
  ['大数据分析', '大数据', 'big data'],
];

/**
 * 研究对象词表：[规范名, ...别名]。
 * 这一维回答「两篇文献研究的是不是同一批人或同一个市场」——
 * 同为消费者研究，一个看直播带货、一个看绿色包装，才值得连起来。
 */
const SUBJECT_LEXICON = [
  ['消费者', '消费者', 'consumer', 'consumption'],
  ['用户', '用户', 'user'],
  ['顾客', '顾客', '客户', 'customer', 'client'],
  ['企业', '企业', '公司', 'firm', 'enterprise', 'company'],
  ['平台', '平台', 'platform'],
  ['电子商务', '电子商务', '电商', 'e-commerce', 'ecommerce', 'online shopping', '网购'],
  ['直播', '直播', 'live streaming', 'live stream', 'livestream'],
  ['短视频', '短视频', 'short video', 'tiktok', '抖音'],
  ['社交媒体', '社交媒体', 'social media', '微信', 'wechat', '微博', 'twitter', 'facebook'],
  ['品牌', '品牌', 'brand'],
  ['广告', '广告', 'advertising', 'advertisement'],
  ['推荐系统', '推荐系统', '推荐算法', 'recommender', 'recommendation system'],
  ['供应链', '供应链', 'supply chain'],
  ['定价', '定价', '价格', 'pricing', 'price'],
  ['可持续消费', '绿色消费', '可持续消费', 'sustainable consumption', 'green consumption', 'esg'],
  ['人工智能', '人工智能', 'artificial intelligence'],
  ['生成式内容', '生成式', 'generative', 'aigc'],
  ['营销', '营销', 'marketing'],
  ['产品', '产品', 'product'],
  ['服务', '服务', 'service'],
  ['信任', '信任', 'trust'],
  ['满意度', '满意度', 'satisfaction'],
  ['购买意愿', '购买意愿', '购买决策', 'purchase intention'],
  ['口碑', '口碑', 'word of mouth', 'word-of-mouth', 'ewom'],
  ['隐私', '隐私', 'privacy'],
  ['学生', '学生', 'student'],
  ['员工', '员工', 'employee', 'worker'],
  ['投资者', '投资者', 'investor'],
  ['医疗健康', '医疗', '健康', 'healthcare', 'health'],
  ['旅游', '旅游', 'tourism', 'travel'],
  ['教育', '教育', 'education'],
  ['金融', '金融', 'finance', 'financial'],
  ['算法', '算法', 'algorithm'],
  ['移动应用', '移动应用', 'mobile application', 'app'],
];
// 大模型分组的上限：超过这个数就是模型没合并好（服务端会先做一次上位主题归并），
// 这里只是兜底 —— 宁可少画几个主题，也不能让几十篇文献莫名掉进「未分类」。
const MAX_LLM_GROUPS = 20;
const MAX_GROUP_NAME = 40;
// 图谱结构版本：v4 起边只按内容建（同关键词 / 同方法 / 同研究对象），
// 不再有「同属分类」「共同作者」这两类元数据边。旧版本持久化的 graph 一边是
// 拿分类连出来的，服务端读到版本不符就重建，不必等用户手动重聚类。
export const GRAPH_VERSION = 4;
// 「为什么相连」里最多列出几个共享词
const MAX_REASON_TERMS = 3;

/**
 * 用大模型给出的主题分组装配图谱（模型负责语义归类，本地负责结构校验）。
 *
 * 本地相似度聚类只看词面重合：中文文献里「实证 / 量表 / 问卷」这类词到处都是，
 * 很容易把所有文献熔成一两坨。大模型读标题 + 摘要能按真正的「研究问题」分。
 *
 * 容错规则（模型输出不可全信）：不存在的 id 丢掉、重复归类只认第一次、
 * 主题名截断、空主题丢弃、没被归类的统一进「未分类」。
 *
 * @param {Array} entries 知识库条目
 * @param {Array<{name?:string, keywords?:Array, ids?:Array, members?:Array}>} groups 模型输出
 * @returns {{topics: Array, assignments: Object, coverage: number}} 与 clusterTopics 同构
 */
export function applyTopicGroups(entries, groups) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e === 'object') : [];
  const raw = Array.isArray(groups) ? groups : [];
  const known = new Set();
  for (const e of list) {
    const id = str(e.id).trim();
    if (id) known.add(id);
  }
  const topics = [];
  const assignments = {};
  const used = new Set();
  for (const g of raw) {
    if (!g || typeof g !== 'object') continue;
    if (topics.length >= MAX_LLM_GROUPS) break;
    const label = str(g.name || g.label).replace(/\s+/g, ' ').trim().slice(0, MAX_GROUP_NAME);
    const ids = (Array.isArray(g.ids) ? g.ids : Array.isArray(g.members) ? g.members : [])
      .map((x) => str(x).trim()).filter(Boolean);
    const members = [];
    for (const id of ids) {
      if (!known.has(id) || used.has(id)) continue; // 不存在的 id / 已被前面的主题认领
      used.add(id);
      members.push(id);
    }
    if (!members.length) continue;
    const terms = toList(g.keywords).slice(0, 4);
    const topicId = `topic-llm-${topics.length + 1}`;
    const name = label || terms[0] || `主题 ${topics.length + 1}`;
    topics.push({ id: topicId, label: name, terms, count: members.length });
    for (const mid of members) assignments[mid] = { topicId, label: name, score: 1 };
  }
  const rest = [];
  for (const id of known) {
    if (!used.has(id)) rest.push(id);
  }
  if (rest.length) {
    topics.push({ id: 'topic-uncategorized', label: '未分类', terms: [], count: rest.length });
    for (const mid of rest) assignments[mid] = { topicId: 'topic-uncategorized', label: '未分类', score: 0 };
  }
  // 主题按篇数降序（并列按名字）排序：图谱配色与左侧筛选下拉的顺序才稳定
  topics.sort((a, b) => (b.count - a.count) || cmpStr(a.label, b.label));
  return { topics, assignments, coverage: used.size };
}

/**
 * 把关键词拆成原子词。
 * 库里的 keywords 常常不是干净的词：AI 解析会写成
 * 「作者原列关键词：A、B。ai 补充检索词：C、D」或「machine learning（机器学习）」，
 * 整串比对永远不会和另一篇相等，等于没有关键词可用。这里先切掉来源前缀，
 * 再按顿号/逗号/分号拆开，括号里的译名也单独算一个词。
 */
function keywordAtoms(e) {
  const out = new Map(); // lowercase → 展示用原文
  const push = (raw) => {
    const s = str(raw).replace(/\s+/g, ' ').replace(/^[\s.。;；:：,-]+|[\s.。;；:：,-]+$/g, '').trim();
    if (!s || s.length > 30) return;   // 整段检索词不是关键词
    if (/^\d+$/.test(s)) return;
    const low = s.toLowerCase();
    if (!out.has(low)) out.set(low, s);
  };
  for (const raw of toList(e?.keywords)) {
    const cleaned = str(raw)
      .replace(/作者原列关键词\s*[:：]?/gi, '|')
      .replace(/ai\s*补充检索词\s*[:：]?/gi, '|')
      .replace(/补充检索词\s*[:：]?/gi, '|');
    for (const seg of cleaned.split('|')) {
      for (const part of seg.split(/[、,，;；/\n]+/)) {
        const p = part.trim();
        if (!p) continue;
        const m = p.match(/^(.+?)[（(]([^()（）]+)[)）]\s*$/);
        if (m) { push(m[1]); push(m[2]); } else push(p);
      }
    }
  }
  return out;
}
/** 每个词出现在多少篇里（文档频次）：越稀有的共享词，越能说明这两篇为什么被连起来。 */
function docFreq(sets) {
  const df = new Map();
  for (const set of sets) {
    if (!set) continue;
    for (const t of set) df.set(t, (df.get(t) || 0) + 1);
  }
  return df;
}

/**
 * 全库过半文献都有的词，连起来说明不了什么。
 * 「问卷」「消费者」这类词在本库里几乎人人都有，靠它建边会把整张图连成一坨，
 * 等于没有解释；所以共享词要么稀有，要么就别当依据。小库（<3 篇）不设限。
 */
function tooCommon(df, n, ratio) {
  const d = Number(df) || 0;
  if (d < 3) return false;
  return d / Math.max(1, n) > ratio;
}

/** 别名 → 编译好的正则（英文按词边界，允许复数；中文走 includes，不用正则）。 */
const ALIAS_RE = new Map();

function hitAlias(hay, alias) {
  if (!/[a-z]/.test(alias)) return hay.includes(alias);
  let re = ALIAS_RE.get(alias);
  if (!re) {
    const esc = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(`(^|[^a-z])${esc}(s|es)?([^a-z]|$)`);
    ALIAS_RE.set(alias, re);
  }
  return re.test(hay);
}

/**
 * 从「标题 + 译名 + 关键词 + 摘要」里认出方法与研究对象。
 * 摘要缺失时才退回正文开头 —— 全文里参考文献和致谢会带来噪声，
 * 只在没别的可用内容时才用，且只取前 4000 字。
 */
function contentText(e) {
  const head = [
    str(e?.title),
    str(e?.titleZh),
    toList(e?.keywords).join(' '),
    str(e?.summary),
  ].filter(Boolean).join('\n').slice(0, 6000).toLowerCase();
  if (head.length >= 400) return head;
  return `${head}\n${str(e?.text).slice(0, 4000)}`.toLowerCase();
}

function matchLexicon(hay, lexicon) {
  const out = new Set();
  if (!hay) return out;
  for (const rule of lexicon) {
    const label = rule[0];
    for (let i = 1; i < rule.length; i++) {
      if (hitAlias(hay, rule[i])) { out.add(label); break; }
    }
  }
  return out;
}

// 对方标题 / 「作者 年份」出现在 A 的 DOI 或全文里 → 视为引用
function citationWeight(a, b) {
  const hay = (str(a?.text) + ' ' + str(a?.doi)).toLowerCase();
  const titleB = str(b?.title).toLowerCase().trim();
  const yearB = str(b?.year).trim();
  const authorsB = toList(b?.authors);
  const lastB = authorsB.length
    ? (str(authorsB[0]).toLowerCase().split(/[\s,，]+/).filter(Boolean)[0] || '')
    : '';
  if (titleB.length >= 8 && hay.includes(titleB)) return 0.95;
  if (lastB && yearB && (
    hay.includes(`${lastB} ${yearB}`) ||
    hay.includes(`${lastB}, ${yearB}`) ||
    hay.includes(`${lastB} (${yearB}`) ||
    hay.includes(`${lastB}(${yearB}`)
  )) return 0.9;
  return 0;
}

/**
 * 生成文献之间的关联边。
 *
 * 只按内容建边 —— 两篇文献要么共享关键词，要么用了同一种研究方法，要么研究同一类对象。
 * 「同属分类」「共同作者」这类元数据不再参与：同一个分类里可能什么主题都有，
 * 同一个作者也完全可能写两篇毫无关系的东西，拿它当连接依据等于没有解释。
 *
 * 每条边除了 source/target/kind/weight，还带一句可读的 reason，
 * 前端点开节点时据此解释「为什么相连」，不必再猜。
 *
 * @param {Array} entries 索引条目
 * @param {Object} [_assignments] 旧版聚类结果；保留这个位置只为兼容既有调用
 * @param {Object} [_options] 旧版分类名表；已不使用
 */
export function buildEdges(entries, _assignments, _options) {
  const all = Array.isArray(entries) ? entries.filter((e) => e && typeof e === 'object') : [];
  const list = all.slice(0, MAX_DOCS); // 超过 400 篇先截断
  const N = list.length;
  const cand = [];
  const seen = new Set();
  const add = (idA, idB, kind, weight, extra) => {
    if (!Number.isFinite(weight) || weight <= THRESHOLDS[kind]) return;
    let source = str(idA).trim(), target = str(idB).trim();
    if (!source || !target || source === target) return; // 无自环
    if (source > target) { const t = source; source = target; target = t; }
    const key = `${source}\u0000${target}\u0000${kind}`;
    if (seen.has(key)) return; // (source,target,kind) 去重
    seen.add(key);
    const item = { source, target, kind, weight: Math.round(weight * 1000) / 1000 };
    if (extra && typeof extra === 'object') {
      const reason = str(extra.reason).replace(/\s+/g, ' ').trim().slice(0, 90);
      if (reason) item.reason = reason;
      if (Array.isArray(extra.terms) && extra.terms.length) {
        item.terms = extra.terms.slice(0, MAX_REASON_TERMS).map((t) => str(t).trim()).filter(Boolean);
      }
      // citation 专用：谁引用了谁（source/target 被字典序重排过，方向不能靠这两个字段推）
      const citing = str(extra.citing).trim();
      if (citing) item.citing = citing;
    }
    cand.push(item);
  };

  const kwMaps = list.map(keywordAtoms);
  const kws = kwMaps.map((m) => new Set(m.keys()));

  // 关键词保留原词大小写/写法用于展示（集合里都是 lowercase）
  const kwDisplay = new Map();
  for (const m of kwMaps) {
    for (const [low, disp] of m) if (!kwDisplay.has(low)) kwDisplay.set(low, disp);
  }
  const kwDf = docFreq(kws);

  // 内容维度：从标题 / 关键词 / 摘要里认出研究方法与研究对象
  const facets = list.map((e) => {
    const hay = contentText(e);
    return {
      methods: matchLexicon(hay, METHOD_LEXICON),
      subjects: matchLexicon(hay, SUBJECT_LEXICON),
    };
  });
  const methodDf = docFreq(facets.map((f) => f.methods));
  const subjectDf = docFreq(facets.map((f) => f.subjects));

  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const idA = str(a.id).trim();
    if (!idA) continue;
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      const idB = str(b.id).trim();
      if (!idB || idA === idB) continue;
      // ---- 同一关键词：只认 AI 解析出的完整词 ----
      const sharedKw = [];
      for (const k of kws[i]) {
        if (!kws[j].has(k) || !kwDisplay.has(k)) continue;
        if (tooCommon(kwDf.get(k), N, 0.2)) continue; // 「研究」「消费者」这类人人都有
        sharedKw.push(kwDisplay.get(k));
        if (sharedKw.length >= MAX_REASON_TERMS) break;
      }
      if (sharedKw.length) {
        add(idA, idB, 'keyword', Math.min(0.92, 0.5 + 0.14 * (sharedKw.length - 1)), {
          terms: sharedKw,
          reason: `共同关键词：${sharedKw.join('、')}`,
        });
      }

      // ---- 同一研究方法：都用问卷 / 实验 / 文本挖掘，结论才可比 ----
      const sharedMethod = [];
      for (const m of facets[i].methods) {
        // 方法词门槛比对象词宽一点，但全库三成都用的方法（如「实验」）同样不构成区分
        if (!facets[j].methods.has(m) || tooCommon(methodDf.get(m), N, 0.3)) continue;
        sharedMethod.push(m);
        if (sharedMethod.length >= MAX_REASON_TERMS) break;
      }
      if (sharedMethod.length) {
        add(idA, idB, 'method', Math.min(0.9, 0.58 + 0.16 * (sharedMethod.length - 1)), {
          terms: sharedMethod,
          reason: `共同研究方法：${sharedMethod.join('、')}`,
        });
      }

      // ---- 同一研究对象：都在看消费者 / 平台 / 供应链，才有可对照之处 ----
      const sharedSubject = [];
      for (const s of facets[i].subjects) {
        if (!facets[j].subjects.has(s) || tooCommon(subjectDf.get(s), N, 0.2)) continue;
        sharedSubject.push(s);
        if (sharedSubject.length >= MAX_REASON_TERMS) break;
      }
      if (sharedSubject.length) {
        add(idA, idB, 'subject', Math.min(0.86, 0.52 + 0.12 * (sharedSubject.length - 1)), {
          terms: sharedSubject,
          reason: `共同研究对象：${sharedSubject.join('、')}`,
        });
      }

      // ---- 引用：正文里明确提到了对方，是最硬的内容证据，保留 ----
      const ab = citationWeight(list[i], list[j]);
      const ba = citationWeight(list[j], list[i]);
      if (ab > 0 || ba > 0) {
        add(idA, idB, 'citation', Math.max(ab, ba), {
          citing: ab >= ba ? idA : idB,
          reason: '正文中提及了对方文献',
        });
      }
    }
  }

  // 权重降序 + 稳定 tie-break，再按「每篇 ≤10 个邻居、总量 ≤1200」裁剪
  cand.sort((x, y) =>
    (y.weight - x.weight) ||
    cmpStr(x.source, y.source) ||
    cmpStr(x.target, y.target) ||
    cmpStr(x.kind, y.kind));
  const peers = new Map(); // 文献 id → 已连上的对端集合
  const edges = [];
  for (const e of cand) {
    if (edges.length >= MAX_EDGES) break;
    let pa = peers.get(e.source);
    if (!pa) { pa = new Set(); peers.set(e.source, pa); }
    let pb = peers.get(e.target);
    if (!pb) { pb = new Set(); peers.set(e.target, pb); }
    // 同一对文献可能同时有「同关键词 / 同方法」多条边，不能算两次额度
    const overA = pa.size >= MAX_DEGREE && !pa.has(e.target);
    const overB = pb.size >= MAX_DEGREE && !pb.has(e.source);
    if (overA || overB) continue;
    edges.push(e);
    pa.add(e.target);
    pb.add(e.source);
  }
  return edges;
}

export function buildGraph(index, opts) {
  const entries = Array.isArray(index?.entries)
    ? index.entries.filter((e) => e && typeof e === 'object')
    : [];
  const options = opts && typeof opts === 'object' ? opts : {};
  // 有大模型分组就优先用它（opts.topicGroups）；否则退回本地相似度聚类。
  let llm = null;
  if (Array.isArray(options.topicGroups) && options.topicGroups.length) {
    const applied = applyTopicGroups(entries, options.topicGroups);
    if (applied.coverage > 0) llm = applied;
  }
  const { topics, assignments } = llm || clusterTopics(entries, options);
  // 聚类结果只决定节点属于哪个主题，不参与建边：连不连看内容本身
  const edges = buildEdges(entries);
  const nodes = entries.map((e) => {
    const id = str(e.id).trim();
    const a = assignments[id] || {};
    return {
      id,
      title: str(e.title),
      titleZh: str(e.titleZh),
      authors: toList(e.authors),
      year: num(e.year),
      journal: str(e.journal),
      docType: str(e.docType),
      collectionId: str(e.collectionId),
      topicId: str(a.topicId || ''),
      topicLabel: str(a.label || '未分类'),
      keywords: toList(e.keywords),
      tags: toList(e.tags),
      hasPdf: !!(e.hasPdf || e.hasFullText || e.pdfPath || e.filePath),
    };
  });
  return {
    // 结构版本：服务端读持久化缓存时据此判断要不要重建（旧版边没有 reason）
    version: GRAPH_VERSION,
    nodes,
    edges,
    topics,
    // 聚类来源：'llm' = 大模型语义聚类，'local' = 本地词面相似度聚类
    method: llm ? 'llm' : 'local',
    stats: { documents: nodes.length, topics: topics.length, relations: edges.length },
  };
}

// 控制字符（排除 \t \n \r 这类可归一化空白）
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

export function mergeTags(node, raw) {
  const items = [];
  if (node && typeof node === 'object') {
    for (const t of toList(node.tags)) items.push(t);
  }
  if (Array.isArray(raw)) {
    for (const t of raw) items.push(str(t));
  } else if (typeof raw === 'string') {
    for (const t of raw.split(/[,，;；、\n]+/)) items.push(t);
  } else if (raw != null) {
    items.push(str(raw));
  }
  const out = [];
  const seen = new Set();
  for (const t of items) {
    const rawStr = str(t);
    if (!rawStr.trim() || CTRL.test(rawStr)) continue; // 过滤含控制字符的项
    const s = rawStr.replace(/\s+/g, ' ').trim();       // 去空白
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;                        // 去重
    seen.add(key);
    out.push(s);
    if (out.length >= 12) break;                        // ≤12 个
  }
  return out;
}
