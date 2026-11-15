// knowledgeBase.js —— 本地知识库索引的纯逻辑（不依赖 express / 数据库）
// 除 readKnowledgeFullText 允许使用 node:fs 外，其余导出均为纯函数；
// 所有导出对 null / undefined / 异常输入一律兜底，绝不抛错。
import fs from 'node:fs';
import path from 'node:path';

// ---------- 内部工具：绝不抛错的类型兜底 ----------
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

// ---------- 停用词（中英，均为虚词；实词保留以便主题聚类） ----------
const STOP = new Set([
  // 英文功能词
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'but', 'by', 'can',
  'do', 'does', 'for', 'from', 'has', 'have', 'if', 'in', 'into', 'is', 'it', 'its',
  'of', 'on', 'or', 'our', 'that', 'the', 'their', 'these', 'this', 'those', 'to',
  'was', 'were', 'will', 'with', 'would', 'we', 'you', 'your', 'not', 'no', 'nor',
  'so', 'than', 'then', 'too', 'very', 'while', 'where', 'when', 'who', 'how',
  'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'such', 'up',
  'out', 'over', 'after', 'before', 'about', 'also', 'may', 's', 't', 'don',
  'now', 'via', 'per', 'within', 'among', 'between', 'during', 'through',
  'above', 'below', 'i', 'me', 'my', 'he', 'she', 'they', 'them', 'his', 'her',
  // 中文虚词
  '的', '了', '和', '与', '及', '或', '在', '是', '有', '为', '对', '中', '也',
  '就', '都', '而', '其', '这', '那', '之', '以', '于', '上', '下', '不', '无',
  '可', '被', '把', '从', '到', '由', '等', '我们', '本文', '通过', '进行',
  '以及', '一个', '一种', '可以', '并', '且', '则', '所', '使', '让', '更',
  '最', '很', '该', '此', '各', '每', '还', '又', '再', '即',
]);

export function tokenize(text) {
  try {
    const s = str(text).toLowerCase();
    if (!s) return [];
    const out = [];
    // 英文按单词（至少含一个字母），中文按 2-gram + 单字
    for (const w of s.match(/[a-z][a-z0-9]*/g) || []) {
      if (w.length >= 2 && !STOP.has(w)) out.push(w);
    }
    for (const chunk of s.match(/[\u4e00-\u9fff]+/g) || []) {
      const chars = [...chunk];
      for (let i = 0; i < chars.length - 1; i++) {
        const g = chars[i] + chars[i + 1];
        if (!STOP.has(g)) out.push(g);
      }
      for (const c of chars) if (!STOP.has(c)) out.push(c);
    }
    return out;
  } catch {
    return [];
  }
}

export function buildEntry(item, fullText, now = '') {
  const it = item && typeof item === 'object' ? item : {};
  const id = str(it.id).trim();
  const title = str(it.title);
  // 有译名取译名；没有（即便标题本身是中文）也留空，避免把中文标题当译名重复展示
  const titleZh = str(it.titleZh);
  const authors = toList(it.authors);
  const keywords = toList(it.keywords);
  const text = [
    title,
    titleZh,
    authors.join(' '),
    keywords.join(' '),
    str(it.abstract),
    str(it.summary),
    str(it.innovation),
    str(it.coreFindings),
    str(it.method),
    str(it.conclusion),
    str(it.researchQuestion),
    str(fullText),
  ].filter(Boolean).join('\n').slice(0, 20000);
  const tokens = [];
  const seen = new Set();
  for (const t of tokenize(text)) {
    if (seen.has(t)) continue;
    seen.add(t);
    tokens.push(t);
    if (tokens.length >= 400) break;
  }
  return {
    id,
    title,
    titleZh,
    authors,
    journal: str(it.journal),
    year: num(it.year),
    doi: str(it.doi),
    docType: str(it.docType),
    collectionId: str(it.collectionId),
    topics: [],
    keywords,
    tags: toList(it.tags),
    hasPdf: !!(str(it.filename) || str(it.filePath)),
    pdfPath: str(it.filePath || it.filename),
    summary: str(it.summary) || str(it.abstract),
    tokens,
    text,
    updatedAt: str(it.updatedAt || it.createdAt || now || ''),
  };
}

export function buildIndex(items, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  let builtAt;
  if (opts.now == null) builtAt = new Date().toISOString();
  else if (opts.now instanceof Date) builtAt = opts.now.toISOString();
  else builtAt = str(opts.now);
  const readFullText = typeof opts.readFullText === 'function' ? opts.readFullText : null;
  const list = Array.isArray(items) ? items : [];
  const entries = [];
  const libraries = new Set();
  let withFullText = 0;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (!str(item.id).trim()) continue; // 过滤无 id 的记录
    let fullText = '';
    if (readFullText) {
      try { fullText = str(readFullText(item)); } catch { fullText = ''; }
    }
    const entry = buildEntry(item, fullText, builtAt);
    entries.push(entry);
    if (fullText.trim()) withFullText += 1;
    if (entry.collectionId) libraries.add(entry.collectionId);
  }
  return {
    version: 1,
    builtAt,
    entries,
    stats: { documents: entries.length, withFullText, libraries: libraries.size },
  };
}

// 从 text 里截出含命中词的一段（≤180 字）
function snippetOf(text, qTokens) {
  const raw = str(text);
  const lower = raw.toLowerCase();
  let idx = -1;
  const ordered = [...qTokens].sort((a, b) => b.length - a.length || cmpStr(a, b));
  for (const t of ordered) {
    const p = lower.indexOf(t);
    if (p >= 0) { idx = p; break; }
  }
  const start = idx >= 0 ? Math.max(0, idx - 60) : 0;
  return raw.slice(start, start + 180).replace(/\s+/g, ' ').trim().slice(0, 180);
}

export function searchEntries(index, query, limit = 8) {
  const entries = Array.isArray(index?.entries) ? index.entries : [];
  const lim0 = Number(limit);
  const lim = Number.isFinite(lim0) && lim0 > 0 ? Math.min(Math.floor(lim0), 100) : 8;
  const qTokens = [...new Set(tokenize(query))];
  const makeHit = (e, score, snippet) => ({ ...e, score, snippet });

  // 空 query：按年份倒序（并列按 id 升序）返回前 limit 条
  if (qTokens.length === 0) {
    const sorted = [...entries].sort((a, b) => {
      const dy = num(b.year) - num(a.year);
      if (dy !== 0) return dy;
      return cmpStr(str(a.id), str(b.id));
    });
    return sorted.slice(0, lim).map((e) => makeHit(e, 0, snippetOf(e.text, [])));
  }

  // IDF 加权：标题命中 ×3、关键词命中 ×2、正文命中 ×1
  const N = entries.length || 1;
  const df = new Map();
  const bodySets = new Map();
  for (const e of entries) {
    const set = new Set(
      (Array.isArray(e?.tokens) ? e.tokens : [])
        .map((t) => str(t).toLowerCase().trim()).filter(Boolean),
    );
    bodySets.set(e, set);
    for (const t of qTokens) if (set.has(t)) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = new Map();
  for (const t of qTokens) idf.set(t, Math.log(1 + N / (1 + (df.get(t) || 0))));

  const scored = [];
  for (const e of entries) {
    const body = bodySets.get(e) || new Set();
    const titleSet = new Set(tokenize(str(e.title) + ' ' + str(e.titleZh)));
    const kwSet = new Set(tokenize((Array.isArray(e.keywords) ? e.keywords : []).map(str).join(' ')));
    let score = 0;
    for (const t of qTokens) {
      let w = 0;
      if (titleSet.has(t)) w = 3;
      else if (kwSet.has(t)) w = 2;
      else if (body.has(t)) w = 1;
      if (w > 0) score += (idf.get(t) || 0) * w;
    }
    if (score <= 0) continue;
    scored.push({ e, score: Math.round(score * 1000) / 1000 });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const dy = num(b.e.year) - num(a.e.year);
    if (dy !== 0) return dy;
    return cmpStr(str(a.e.id), str(b.e.id));
  });
  return scored.slice(0, lim).map(({ e, score }) => makeHit(e, score, snippetOf(e.text, qTokens)));
}

export function buildEvidenceBlock(hits) {
  const list = Array.isArray(hits) ? hits : [];
  const lines = [];
  let n = 0;
  for (const h of list) {
    if (!h || typeof h !== 'object') continue;
    n += 1;
    const title = str(h.title);
    const titleZh = str(h.titleZh);
    const authors = Array.isArray(h.authors) ? h.authors.map(str).join(', ') : str(h.authors);
    const year = str(h.year);
    const journal = str(h.journal);
    const excerpt = (str(h.summary) || str(h.text)).replace(/\s+/g, ' ').trim().slice(0, 220);
    let block = `[${n}] ${title}`;
    if (titleZh) block += `\n中文译名：${titleZh}`; // 英文标题 + 中文译名换行
    block += `\n作者：${authors}`;
    block += `\n年份：${year} | 期刊：${journal}`;
    block += `\n摘要/结论摘录：${excerpt}`;
    lines.push(block);
  }
  const instruction = '请基于以上文献作答：回答中引用文献时写 [编号]（如 [1]），并在最后给出参考文献列表。';
  const body = lines.join('\n\n');
  return body ? `${body}\n\n${instruction}` : instruction;
}

// 唯一允许碰 fs 的导出：尝试按文献 id / 版面作业 id 找全文 Markdown
export function readKnowledgeFullText(dataDir, item) {
  try {
    const root = str(dataDir);
    const id = str(item && typeof item === 'object' ? item.id : item).trim();
    if (!root || !id) return '';
    const layoutRoot = path.join(root, 'layout');
    // 尝试一：目录名就是文献 id
    try {
      const direct = path.join(layoutRoot, id, 'paper.md');
      if (fs.existsSync(direct)) return str(fs.readFileSync(direct, 'utf8')).slice(0, 60000);
    } catch { /* 读不到继续走扫描 */ }
    // 尝试二：版面作业 id 作目录名，靠 manifest.json 的 literatureId 反查
    let names;
    try { names = fs.readdirSync(layoutRoot, { withFileTypes: true }); }
    catch { return ''; }
    names.sort((a, b) => cmpStr(a.name, b.name));
    for (const d of names) {
      if (!d.isDirectory()) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(layoutRoot, d.name, 'manifest.json'), 'utf8'));
        const lid = str(manifest && typeof manifest === 'object'
          ? (manifest.literatureId ?? manifest.litId ?? manifest.literatureID ?? manifest.id)
          : '').trim();
        if (!lid || lid !== id) continue;
        const md = path.join(layoutRoot, d.name, 'paper.md');
        if (!fs.existsSync(md)) continue;
        return str(fs.readFileSync(md, 'utf8')).slice(0, 60000);
      } catch { /* 单个目录读不到就跳过 */ }
    }
    return '';
  } catch {
    return '';
  }
}
