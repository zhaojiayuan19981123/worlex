// directionAnalyze.js —— 方向分析（二）：把选中的文献摘要交给模型，产出「研究空白 + 研究方向」
//
// 只做两件事：拼 prompt、把模型输出收敛成受控结构。
// 不碰网络、不碰存储，方便单测（喂一段假模型输出就能验证解析与兜底）。
//
// 为什么强制 JSON 而不是 Markdown：
//   研究空白 / 研究方向都要挂「证据文献编号」，前端要能点编号跳原文、要能按难度和
//   置信度筛选。Markdown 里这些关系只能靠正则猜，JSON 才能稳定还原成卡片。

import { parseModelJson } from './siExtract.js';

/** 三种分析口径：只找空白 / 只给方向 / 两者都要（默认） */
export const ANALYSIS_MODES = [
  { id: 'both', label: '研究空白 + 研究方向', hint: '先找「大家都没做」的地方，再给可落地的选题' },
  { id: 'gap', label: '只找研究空白', hint: '聚焦这批文献覆盖不足、结论冲突或证据薄弱之处' },
  { id: 'direction', label: '只给研究方向', hint: '直接给可执行的选题、方法路径与预期贡献' },
];

export const DEFAULT_ANALYSIS = {
  overview: '',
  landscape: { evolution: '', consensus: '', debates: '', methodTrends: '' },
  gaps: [],
  directions: [],
  clusters: [],
  agenda: [],
  readingOrder: [],
  cautions: [],
  visualization: { keywords: [], nodes: [], edges: [] },
};

const str = (v) => String(v == null ? '' : v);
const clean = (v) => str(v).replace(/\s+/g, ' ').trim();
const clip = (v, max) => {
  const s = clean(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

const SYSTEM_PROMPT = [
  '你是资深科研选题顾问，服务对象是准备开题或撰写综述的研究者。',
  '用户会给你一批文献的标题、作者、年份、期刊与摘要（编号 1..N），要求你据此找出研究空白并提出研究方向。',
  '硬性约束：',
  '1) 只能用所给摘要里的信息，不得编造文献、数据、实验结论或作者观点；摘要里没写的东西，不要声称「该文报告了」。',
  '2) 每条论断必须用 evidence 数组标注依据的文献编号（整数，1..N）；找不到依据就不要写这一条。',
  '3) 「研究空白」要落在这批文献的共同边界上：说明哪些文献做了相近工作、差在哪一步、为什么这仍然是空白；不要把某一篇论文自己写的「未来工作」直接抄成空白。',
  '4) 「研究方向」要可执行：给研究问题、可检验假设、分步技术路线、评价方式、数据条件、阶段安排与主要风险；拒绝「A 与 B 相结合」这种空话。',
  '5) 报告要详细：把脉络、共识、分歧、方法趋势写成独立段落；每条空白写清类型、成因、影响与核查方式；每个方向写清假设、步骤、评价、资源与产出。字数不够详细就是不合格。',
  '6) 证据不足时明确写「证据不足」，宁少勿凑。',
  '7) 除 visualization 字段外，全部用简体中文，专业术语可保留英文原文。',
  '8) ★ visualization 里的所有文字（keywords.text、nodes.label、nodes.summary、edges.label）必须是纯英文，不得出现任何中文 / 日文 / 韩文字符；内容只能来自所给英文摘要，不得取自中文译文或报告文字。',
  '只输出一个 JSON 对象，不要 Markdown、不要代码块、不要任何解释文字。JSON 结构：',
  '{',
  '  "overview": "6-10 句：这批文献共同在解决什么问题、研究脉络走到哪、已有什么共识、分歧或证据薄弱的地方在哪",',
  '  "landscape": {"evolution":"研究脉络：从早期到近期怎么演进","consensus":"反复被验证的共识","debates":"结论冲突或悬而未决的争论","methodTrends":"方法与技术路线的主要变化和局限"},',
  '  "gaps": [{"title":"空白点的短标题","statement":"空白是什么（2-3 句）","why":"为什么仍是空白：相近工作做到哪、差在哪","type":"证据缺口|方法缺口|场景缺口|数据缺口|结论冲突","rootCause":"这个空白为什么一直没被补上","impact":"补上它能带来什么（2 句）","openQuestions":["仍未回答的具体问题"],"check":"怎样用现有文献或数据核查这确实是空白","evidence":[1,4],"confidence":"high|medium|low"}],',
  '  "directions": [{"title":"方向短标题","question":"要回答的核心研究问题","hypothesis":"可检验的假设","approach":"技术路线 / 研究设计（2-3 句）","steps":["第 1 步做什么","第 2 步做什么"],"data":"可用的数据或实验条件（数据不足就写需要什么）","evaluation":"评价指标、对照与判定标准","contribution":"预期贡献与创新点","novelty":"相对上述文献新在哪里","resources":"数据 / 算力 / 合作等必要条件","timeline":"分阶段时间安排","risks":"主要风险或失败可能","evidence":[2,5]}],',
  '  "clusters": [{"name":"主题簇名称","summary":"这一簇在做什么、方法共性","papers":[1,2,3]}],',
  '  "agenda": [{"phase":"阶段名称（含大致时间）","goal":"这一阶段要达到的目标","tasks":["具体任务"],"deliverable":"可交付成果"}],',
  '  "readingOrder": [{"index":1,"reason":"为什么先读它","focus":"读这篇时重点看什么"}],',
  '  "cautions": ["使用本报告时要注意的边界或未验证之处"],',
  '  "visualization": {',
  '    "keywords": [{"text":"english phrase from abstracts","weight":9}],',
  '    "nodes": [{"id":"n1","label":"English topic label","type":"theme|gap|direction","summary":"one English sentence from abstracts","papers":[1,2]}],',
  '    "edges": [{"source":"n1","target":"n2","weight":2,"label":"shared evidence"}]',
  '  }',
  '}',
  'visualization 要求：keywords 给 25-40 个英文词或短语（来自摘要反复出现的概念，weight 1-10，越重要越大）；nodes 给 4-10 个节点，id 唯一且 edges 只能引用这些 id，type 取 theme/gap/direction，papers 是证据编号；edges 给节点间的语义关系（共同证据、方法承接或对立），weight 1-5。',
].join('\n');

const MODE_INSTRUCTION = {
  both: '本次要求：既要给 research gaps，也要给 research directions；gaps 至少 3 条、directions 至少 3 条（证据不足时如实减少并在 cautions 说明）。无论哪种口径，landscape、agenda 与 visualization 都要给。',
  gap: '本次只要 research gaps：gaps 至少 4 条，directions 返回空数组；landscape、agenda 与 visualization 仍要给。',
  direction: '本次只要 research directions：directions 至少 4 条，gaps 返回空数组；landscape、agenda 与 visualization 仍要给。',
};

export function normalizeMode(mode) {
  return ANALYSIS_MODES.some((m) => m.id === mode) ? mode : 'both';
}

/** 单篇文献 → 紧凑文本块：摘要按份额裁剪，标题/作者/年份是判断「谁做的、什么时候」的关键 */
export function describePaper(paper, index, abstractChars = 1100) {
  const authors = Array.isArray(paper?.authors) ? paper.authors : [];
  const authorText = authors.length > 6 ? `${authors.slice(0, 6).join('；')} 等` : authors.join('；');
  const abstract = clip(paper?.abstract, abstractChars);
  return [
    `【${index}】${clip(paper?.title, 260) || '（无标题）'}`,
    `作者：${clip(authorText, 220) || '未提供'}｜年份：${paper?.year || '未提供'}｜期刊/会议：${clip(paper?.venue, 120) || '未提供'}｜被引：${paper?.citedBy || 0}`,
    abstract ? `摘要：${abstract}` : '摘要：公开元数据未提供（该篇只能按标题判断，引用它时要格外保守）',
  ].join('\n');
}

/**
 * 拼消息体。
 * 总预算控制：论文多、摘要长时逐篇压缩，保证 prompt 不超模型上下文。
 */
export function buildAnalysisMessages({ topics = [], papers = [], mode = 'both', focus = '', major = '', language = 'zh', budget = 60000 } = {}) {
  const list = Array.isArray(papers) ? papers.filter(Boolean) : [];
  const picked = normalizeMode(mode);
  const topicText = (Array.isArray(topics) ? topics : [])
    .map((t) => clean(t?.name || t?.keywords))
    .filter(Boolean)
    .join('；');
  // 每篇的摘要份额：至少 500 字，最多 1400 字
  const perPaper = Math.max(500, Math.min(1400, Math.floor(budget / Math.max(1, list.length))));
  const blocks = list.map((paper, i) => describePaper(paper, i + 1, perPaper));

  const head = [
    `研究主题：${topicText || '（未命名主题）'}`,
    `文献数量：${list.length} 篇（编号 1..${list.length}，evidence 只能用这些编号）`,
    major ? `用户专业背景：${clip(major, 160)}\n请结合这个专业的理论视角、常用方法、数据条件与发表语境来解释空白、细化方向：研究空白要说明「对这个专业意味着什么」，研究方向的步骤、评价与交付物要让该专业的研究者能直接开题。不要把专业背景当成一篇文献引用，也不要因此虚构该领域的事实。` : '',
    MODE_INSTRUCTION[picked],
    focus ? `额外关注：${clip(focus, 400)}` : '',
    language === 'zh' ? '' : 'Output language: English. Keep the JSON keys unchanged.',
  ].filter(Boolean).join('\n');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `${head}\n\n${blocks.join('\n\n')}` },
  ];
}

/**
 * 模型输出 → JSON。三级兜底：
 *   1) 直接按「首个 { 到最后一个 }」切；
 *   2) 截断（token 用尽）时按括号栈补齐收尾；
 *   3) 都不行返回 null，由上层报「模型输出无法解析」。
 */
export function parseAnalysisJson(text) {
  const direct = parseModelJson(text);
  if (direct && typeof direct === 'object') return direct;

  const s = str(text).trim().replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  const body = s.slice(start);

  // 从后往前试「在哪个位置截断后补括号能解析成功」
  const closers = { '{': '}', '[': ']' };
  for (let end = body.length; end > 0; end -= 1) {
    const ch = body[end - 1];
    if (ch !== '}' && ch !== ']' && ch !== '"' && ch !== '0' && ch !== '1' && ch !== '2' && ch !== '3' && ch !== '4' && ch !== '5' && ch !== '6' && ch !== '7' && ch !== '8' && ch !== '9') continue;
    const stack = [];
    let inStr = false;
    let esc = false;
    let broken = false;
    for (let i = 0; i < end; i += 1) {
      const c = body[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{' || c === '[') stack.push(c);
      else if (c === '}' || c === ']') {
        const open = stack.pop();
        if (!open || closers[open] !== c) { broken = true; break; }
      }
    }
    if (broken) continue;
    const tail = (inStr ? '"' : '') + stack.reverse().map((c) => closers[c]).join('');
    // 截断位置可能停在 `,"key":` 中间，去掉尾部多余的逗号/冒号再试
    const candidate = (body.slice(0, end) + tail).replace(/[,:]\s*([\]}])/g, '$1');
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* 继续往前退 */ }
  }
  return null;
}

const pickField = (obj, keys) => {
  for (const key of keys) {
    const v = obj?.[key];
    if (typeof v === 'string' && clean(v)) return clean(v);
  }
  return '';
};

function normalizeEvidence(raw, paperCount) {
  const list = Array.isArray(raw) ? raw : (raw == null ? [] : [raw]);
  const out = [];
  for (const item of list) {
    // 模型可能写 "3"、"文献3"、"3,4"，统一抠数字
    for (const m of str(item).match(/\d+/g) || []) {
      const n = Number(m);
      if (Number.isInteger(n) && n >= 1 && n <= paperCount && !out.includes(n)) out.push(n);
      if (out.length >= 8) break;
    }
    if (out.length >= 8) break;
  }
  return out.sort((a, b) => a - b);
}

const CONFIDENCE = { high: 'high', medium: 'medium', mid: 'medium', low: 'low', 高: 'high', 中: 'medium', 低: 'low' };
const DIFFICULTY = { 低: '低', 中: '中', 高: '高', low: '低', medium: '中', high: '高' };

/**
 * 可视化文字必须全英文：模型偶尔会偷懒输出「图神经网络 neural network」，
 * 这里直接剥掉中日韩字符，只留 ASCII 拉丁片段；剥完没内容就整条丢弃。
 */
export function englishOnly(value, max = 120) {
  const s = str(value)
    .replace(/[\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af\uf900-\ufaff]/g, ' ')
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length >= 2 && /[a-z]{2}/i.test(s) ? clip(s, max) : '';
}

const stringList = (raw, maxItems, maxLen, { english = false } = {}) => {
  const out = [];
  for (const item of (Array.isArray(raw) ? raw : [raw])) {
    const value = english ? englishOnly(item, maxLen) : clip(item, maxLen);
    if (value && !out.includes(value)) out.push(value);
    if (out.length >= maxItems) break;
  }
  return out;
};

const numberIn = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
};

/** 把模型输出收敛成前端可直接渲染的结构：限长、编号校验、去重、空对象剔除 */
export function normalizeAnalysis(payload, { paperCount = 0, mode = 'both' } = {}) {
  const raw = payload && typeof payload === 'object' ? payload : {};
  const picked = normalizeMode(mode);
  const limit = Math.max(1, paperCount || 1);
  const seenGap = new Set();
  const seenDir = new Set();

  const gaps = (Array.isArray(raw.gaps) ? raw.gaps : [])
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const title = clip(item.title || item.name, 80);
      const statement = clip(item.statement || item.gap || item.description, 320);
      const why = clip(item.why || item.reason || item.explain, 400);
      if (!title && !statement) return null;
      return {
        title: title || clip(statement, 40),
        statement,
        why,
        type: clip(item.type || item.gapType, 30),
        rootCause: clip(item.rootCause || item.cause, 500),
        impact: clip(item.impact || item.significance, 500),
        openQuestions: stringList(item.openQuestions || item.questions, 5, 220),
        check: clip(item.check || item.verify || item.howToVerify, 400),
        evidence: normalizeEvidence(item.evidence ?? item.papers ?? item.refs, limit),
        confidence: CONFIDENCE[clean(item.confidence).toLowerCase()] || CONFIDENCE[clean(item.confidence)] || 'medium',
      };
    })
    .filter((item) => {
      if (!item) return false;
      const key = `${item.title}|${item.statement}`.slice(0, 160);
      if (seenGap.has(key)) return false;
      seenGap.add(key);
      return true;
    })
    .slice(0, 10);

  const directions = (Array.isArray(raw.directions) ? raw.directions : [])
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const title = clip(item.title || item.name, 80);
      const question = clip(item.question || item.rq || item.problem, 300);
      if (!title && !question) return null;
      return {
        title: title || clip(question, 40),
        question,
        hypothesis: clip(item.hypothesis || item.hypo, 400),
        approach: clip(item.approach || item.method || item.design, 800),
        steps: stringList(item.steps || item.plan, 8, 320),
        data: clip(item.data || item.dataset || item.materials, 400),
        evaluation: clip(item.evaluation || item.metrics || item.validate, 500),
        contribution: clip(item.contribution || item.expected || item.value, 500),
        novelty: clip(item.novelty || item.difference, 400),
        resources: clip(item.resources || item.requirements, 400),
        timeline: clip(item.timeline || item.schedule, 300),
        difficulty: DIFFICULTY[clean(item.difficulty)] || '中',
        risks: clip(item.risks || item.risk || item.limitations, 400),
        evidence: normalizeEvidence(item.evidence ?? item.papers ?? item.refs, limit),
      };
    })
    .filter((item) => {
      if (!item) return false;
      const key = `${item.title}|${item.question}`.slice(0, 160);
      if (seenDir.has(key)) return false;
      seenDir.add(key);
      return true;
    })
    .slice(0, 10);

  const clusters = (Array.isArray(raw.clusters) ? raw.clusters : [])
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const name = clip(item.name || item.title, 60);
      if (!name) return null;
      return {
        name,
        summary: clip(item.summary || item.description, 520),
        keywords: stringList(item.keywords, 8, 60),
        papers: normalizeEvidence(item.papers ?? item.evidence ?? item.refs, limit),
      };
    })
    .filter(Boolean)
    .slice(0, 8);

  const readingOrder = (Array.isArray(raw.readingOrder) ? raw.readingOrder : [])
    .map((item) => {
      // 越界编号直接丢：模型偶尔会把「第 12 篇」写进只有 8 篇的分析里，
      // 前端点进去会指向不存在的文献，不如不留。
      const n = Number(item?.index ?? item?.paper ?? item);
      if (!Number.isInteger(n) || n < 1 || n > limit) return null;
      const focus = clip(item?.focus || item?.watch, 260);
      return { index: n, reason: clip(item?.reason || item?.why, 320), ...(focus ? { focus } : {}) };
    })
    .filter(Boolean)
    .slice(0, 30);

  const landscapeRaw = raw.landscape && typeof raw.landscape === 'object' ? raw.landscape : {};
  const landscape = {
    evolution: clip(landscapeRaw.evolution || landscapeRaw.history, 1400),
    consensus: clip(landscapeRaw.consensus || landscapeRaw.agreement, 1400),
    debates: clip(landscapeRaw.debates || landscapeRaw.disagreement, 1400),
    methodTrends: clip(landscapeRaw.methodTrends || landscapeRaw.trends, 1400),
  };

  const agenda = (Array.isArray(raw.agenda) ? raw.agenda : [])
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const phase = clip(item.phase || item.name, 80);
      if (!phase) return null;
      return {
        phase,
        goal: clip(item.goal || item.objective, 500),
        tasks: stringList(item.tasks, 6, 320),
        deliverable: clip(item.deliverable || item.output, 300),
      };
    })
    .filter(Boolean)
    .slice(0, 6);

  const vizRaw = raw.visualization && typeof raw.visualization === 'object' ? raw.visualization : {};
  // 词云 / 关系图只认模型基于摘要输出的英文数据；中文条目一律丢弃，不做本地分词兜底。
  const keywords = new Map();
  for (const item of (Array.isArray(vizRaw.keywords) ? vizRaw.keywords : [])) {
    const text = englishOnly(item?.text || item?.word || item, 80);
    if (!text) continue;
    const key = text.toLowerCase();
    const weight = numberIn(item?.weight ?? item?.value, 1, 10, 3);
    if (!keywords.has(key)) keywords.set(key, { text, weight });
    else keywords.get(key).weight = Math.max(keywords.get(key).weight, weight);
  }
  const vizKeywords = [...keywords.values()].sort((a, b) => b.weight - a.weight).slice(0, 40);

  const nodes = [];
  const nodeIds = new Set();
  for (const item of (Array.isArray(vizRaw.nodes) ? vizRaw.nodes : [])) {
    const label = englishOnly(item?.label || item?.name, 100);
    if (!label) continue;
    let id = clean(item?.id || item?.key).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20);
    if (!id) id = `n${nodes.length + 1}`;
    while (nodeIds.has(id)) id = `${id}_${nodes.length + 1}`;
    const type = ['theme', 'gap', 'direction'].includes(clean(item?.type)) ? clean(item.type) : 'theme';
    nodeIds.add(id);
    nodes.push({
      id,
      label,
      type,
      summary: englishOnly(item?.summary || item?.description, 240),
      papers: normalizeEvidence(item?.papers ?? item?.evidence, limit),
    });
    if (nodes.length >= 10) break;
  }
  // 模型偶尔会把中文标题塞进 edges 的 source/target；按 id 对不上就丢掉这条边。
  const edges = [];
  const seenEdge = new Set();
  for (const item of (Array.isArray(vizRaw.edges) ? vizRaw.edges : [])) {
    const source = clean(item?.source || item?.from).replace(/[^a-zA-Z0-9_-]/g, '');
    const target = clean(item?.target || item?.to).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!nodeIds.has(source) || !nodeIds.has(target) || source === target) continue;
    const key = `${source}|${target}`;
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    edges.push({
      source,
      target,
      weight: numberIn(item?.weight, 1, 5, 1),
      label: englishOnly(item?.label || item?.relation, 60),
    });
    if (edges.length >= 20) break;
  }
  const visualization = { keywords: vizKeywords, nodes, edges };

  const cautions = (Array.isArray(raw.cautions) ? raw.cautions : [str(raw.cautions)])
    .map((item) => clip(item, 400))
    .filter(Boolean)
    .slice(0, 8);

  return {
    overview: clip(pickField(raw, ['overview', 'summary', 'intro']), 2400),
    landscape,
    gaps: picked === 'direction' ? [] : gaps,
    directions: picked === 'gap' ? [] : directions,
    clusters,
    agenda,
    readingOrder,
    cautions,
    visualization,
    mode: picked,
    paperCount,
  };
}

/** 有内容就算「分析成功」：模型只回了一段 overview 也算，不能因为缺 gaps 就整份丢掉 */
export function hasAnalysisContent(analysis) {
  if (!analysis) return false;
  return Boolean(
    clean(analysis.overview)
    || (analysis.gaps || []).length
    || (analysis.directions || []).length
    || (analysis.clusters || []).length,
  );
}
