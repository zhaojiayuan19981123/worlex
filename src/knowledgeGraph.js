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
const MAX_DEGREE = 8;
const THRESHOLDS = { topic: 0.2, author: 0.5, collection: 0.4, citation: 0.8 };
// 大模型分组的上限：超过这个数就是模型没合并好（服务端会先做一次上位主题归并），
// 这里只是兜底 —— 宁可少画几个主题，也不能让几十篇文献莫名掉进「未分类」。
const MAX_LLM_GROUPS = 20;
const MAX_GROUP_NAME = 40;

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

function tokenSet(e) {
  const s = new Set();
  for (const t of Array.isArray(e?.tokens) ? e.tokens : []) {
    const k = str(t).toLowerCase().trim();
    if (k) s.add(k);
  }
  return s;
}
function keywordSet(e) {
  const s = new Set();
  for (const k of toList(e?.keywords)) {
    const v = str(k).toLowerCase().trim();
    if (v) s.add(v);
  }
  return s;
}
function authorSet(e) {
  const s = new Set();
  for (const a of toList(e?.authors)) {
    const v = str(a).toLowerCase().trim();
    if (v) s.add(v);
  }
  return s;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const uni = a.size + b.size - inter;
  return uni ? inter / uni : 0;
}
function overlapRatio(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / Math.min(a.size, b.size);
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

export function buildEdges(entries, assignments) {
  const all = Array.isArray(entries) ? entries.filter((e) => e && typeof e === 'object') : [];
  const list = all.slice(0, MAX_DOCS); // 超过 400 篇先截断
  const amap = assignments && typeof assignments === 'object' ? assignments : {};
  const cand = [];
  const seen = new Set();
  const add = (idA, idB, kind, weight) => {
    if (!Number.isFinite(weight) || weight <= THRESHOLDS[kind]) return;
    let source = str(idA).trim(), target = str(idB).trim();
    if (!source || !target || source === target) return; // 无自环
    if (source > target) { const t = source; source = target; target = t; }
    const key = `${source}\u0000${target}\u0000${kind}`;
    if (seen.has(key)) return; // (source,target,kind) 去重
    seen.add(key);
    cand.push({ source, target, kind, weight: Math.round(weight * 1000) / 1000 });
  };

  const tokens = list.map(tokenSet);
  const kws = list.map(keywordSet);
  const authors = list.map(authorSet);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const idA = str(a.id).trim();
    if (!idA) continue;
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      const idB = str(b.id).trim();
      if (!idB || idA === idB) continue;
      // topic：共享 token / 关键词相似度，同主题再加权
      const sim = 0.6 * jaccard(tokens[i], tokens[j]) + 0.4 * jaccard(kws[i], kws[j]);
      const ta = amap[idA]?.topicId, tb = amap[idB]?.topicId;
      add(idA, idB, 'topic', Math.min(sim + (ta && tb && ta === tb ? 0.15 : 0), 1));
      // author：同一作者
      const ratio = overlapRatio(authors[i], authors[j]);
      if (ratio > 0) add(idA, idB, 'author', 0.5 + 0.45 * ratio);
      // collection：同一分类
      const ca = str(a.collectionId).trim(), cb = str(b.collectionId).trim();
      if (ca && ca === cb) add(idA, idB, 'collection', 0.45);
      // citation：双向检查
      const cw = Math.max(citationWeight(a, b), citationWeight(b, a));
      if (cw > 0) add(idA, idB, 'citation', cw);
    }
  }
  // 权重降序 + 稳定 tie-break，再按「每篇 ≤8 条、总量 ≤1200」裁剪
  cand.sort((x, y) =>
    (y.weight - x.weight) ||
    cmpStr(x.source, y.source) ||
    cmpStr(x.target, y.target) ||
    cmpStr(x.kind, y.kind));
  const degree = new Map();
  const edges = [];
  for (const e of cand) {
    if (edges.length >= MAX_EDGES) break;
    const da = degree.get(e.source) || 0;
    const db = degree.get(e.target) || 0;
    if (da >= MAX_DEGREE || db >= MAX_DEGREE) continue;
    edges.push(e);
    degree.set(e.source, da + 1);
    degree.set(e.target, db + 1);
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
  const edges = buildEdges(entries, assignments);
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
