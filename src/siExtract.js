// siExtract.js —— 从公众号文章正文里抽「专刊征稿（Special Issue / Call for Papers）」信息
//
// 两条路：
//   1) aiExtractIssues()  —— 用已配置的大模型做结构化 + 中文化。主路径，字段最全。
//   2) ruleExtractIssues()—— 不依赖模型的正则兜底。「SSCI征稿」这类号的文风非常固定
//      （期刊：/专刊主题：/截稿日期：/客座编辑：），没配 key 也能出卡片。
//
// 设计原则：
//   * 模型输出一律当不可信输入处理，逐字段校验、裁剪、丢弃非法值；
//   * 链接只允许来自原文或来源页，绝不自己拼接出版社地址（这正是旧版官网爬取的坑）；
//   * 日期统一 YYYY-MM-DD；解析不出就留空进「待核实」，不猜；
//   * 非征稿文章必须能识别出来（isCallForPapers=false），避免广告/带货文变成卡片。

import { parseAnyDate } from './siSources.js';

const str = (v) => String(v == null ? '' : v);
const clean = (v) => str(v).replace(/\s+/g, ' ').trim();

function pad(n) { return String(n).padStart(2, '0'); }

/** 比 parseAnyDate 更宽：额外支持 2026.12.31、2026/12/31、12/31/2026。 */
export function normalizeDate(value, now = new Date()) {
  const s = clean(value);
  if (!s) return '';
  const dotted = /\b(20\d{2})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})\b/.exec(s);
  if (dotted && isValidYmd(dotted[1], dotted[2], dotted[3], now)) {
    return `${dotted[1]}-${pad(dotted[2])}-${pad(dotted[3])}`;
  }
  const direct = parseAnyDate(s);
  if (direct && isValidYmd(...direct.split('-'), now)) return direct;
  // 只有「月日」时补当前年（征稿文里常见「12月31日截止」）
  const md = /(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(s);
  if (md) {
    const y = now.getFullYear();
    const guess = `${y}-${pad(md[1])}-${pad(md[2])}`;
    if (isValidYmd(y, md[1], md[2], now)) {
      // 已过去的月日按明年算（征稿都是未来日期）
      return Date.parse(guess + 'T00:00:00') < Date.parse(new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString())
        ? `${y + 1}-${pad(md[1])}-${pad(md[2])}` : guess;
    }
  }
  return '';
}

function isValidYmd(y, m, d, now = new Date()) {
  y = Number(y); m = Number(m); d = Number(d);
  if (![y, m, d].every(Number.isInteger)) return false;
  if (y < 2000 || y > now.getFullYear() + 8 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

function safeHttpUrl(value, baseUrl = '') {
  const s = clean(value);
  if (!s) return '';
  try {
    const u = new URL(s, baseUrl || undefined);
    if (!/^https?:$/.test(u.protocol)) return '';
    if (/(^|\.)mp\.weixin\.qq\.com$/i.test(u.hostname)) return '';
    if (/weixin\.qq\.com$/i.test(u.hostname)) return '';
    u.hash = '';
    return u.href;
  } catch { return ''; }
}

function simplifyJournalName(name) {
  return clean(name)
    .replace(/^期刊(?:名称|全称)?\s*[:：]\s*/i, '')
    .replace(/[《》]/g, '')
    .trim();
}

/** 去掉期刊名后面的解释性尾巴：「Omega – The International Journal of Management Science SSCI/SCIE双收录」 */
function trimJournalTail(name) {
  let s = simplifyJournalName(name);
  s = s.split(/\s{2,}/)[0];
  s = s.replace(/\s+(?:SSCI|SCIE|SCI|ESCI|ABS|JCR|IF|影响因子|中科院|分区|收录)\b.*$/i, '').trim();
  // 公众号正文常把收录情况塞进全角括号：「Omega（SSCI/SCIE双收录）」「JBE（ABS 3星）」
  s = s.replace(/[（(][^）)]{0,40}?(?:收录|SSCI|SCIE|SCI|ESCI|ABS|JCR|分区|Top|影响因子|中科院)[^）)]{0,40}?[）)]/gi, '').trim();
  return s.slice(0, 160);
}

/**
 * 期刊名尾部括号里的简称要拆出来单独当 journalShort：
 * 「Journal of Business Ethics（JBE）」→ 全名 + JBE。
 * 只认「全名 + 纯拉丁缩写」的形状，避免把「(United Kingdom)」这种地名当成简称。
 */
export function splitJournalShort(name) {
  const s = trimJournalTail(name);
  const m = /^(.{4,}?)\s*[（(]\s*([A-Za-z][A-Za-z0-9&.\- ]{1,39}?)\s*[）)]\s*$/.exec(s);
  if (m) return { journal: m[1].trim(), short: clean(m[2]) };
  return { journal: s, short: '' };
}

export const SI_PROMPT_VERSION = 3;

/**
 * 抽取用提示词。
 * 刻意把「这个号的常见版式」写进 system，模型对中文征稿文的字段定位会稳很多。
 *
 * v3 的关键变化：detailZh 要求**全文翻译**而不是概括。
 * 用户看这个模块是为了判断「这个专刊值不值得投」，摘要式概括会把征稿范围、客座编辑背景、
 * 投稿类型要求这些真正决定投不投的信息丢掉，所以卡片详情必须是逐段翻译。
 */
export function buildExtractMessages(article, opts = {}) {
  const { sourceName = 'SSCI征稿', articleTitle = '', articleDate = '' } = opts;
  const system = [
    '你是学术专刊（Special Issue / Call for Papers）征稿信息抽取与翻译器。',
    '输入可能来自微信公众号文章，也可能来自出版社的专刊征稿页或用户直接粘贴的正文。',
    '一篇材料通常介绍一本期刊的一个专刊。',
    '',
    '【输出】只输出一个 JSON 对象，不要 Markdown 代码围栏，不要任何解释。格式：',
    '{"isCallForPapers":true,"issues":[{"journal":"","journalShort":"","publisher":"",',
    '"titleEn":"","titleZh":"","summaryZh":"","detailZh":"","topicsZh":[],',
    '"guestEditors":[{"name":"","affiliation":""}],',
    '"openDate":"","deadline":"","submitUrl":"","siUrl":"","journalUrl":"",',
    '"submissionNote":"","confidence":0.0}]}',
    '',
    '【字段要求】',
    '- journal：期刊英文全名（必须原样取自原文，用于后续查询期刊等级；不要翻译、不要加书名号）。',
    '  原文常见写法是「期刊：Omega – The International Journal of Management Science」，取冒号后完整名称。',
    '- journalShort：原文给出的常用缩写，如 Omega、TFSC、JIMF；没有就留空字符串。',
    '- titleEn：专刊主题的英文原名。titleZh：专刊主题的中文译名。',
    '  若原文只有中文主题，titleZh 用原文、titleEn 留空；若只有英文，把 titleEn 照抄、titleZh 翻译成中文。',
    '- summaryZh：**一句话**（30~60 字）说明这个专刊收什么方向的文章，只用于列表页一眼扫过。',
    '- detailZh：**全文翻译**，这是最重要的字段。把原文里所有对投稿者有意义的文字逐段译成中文：',
    '  专刊背景与缘起、征稿主题与范围（原文若分条列出，必须逐条译出、保留分条）、重要日期',
    '  （开放投稿、截稿、评审、出版）、客座编辑及其单位、投稿方式与文章类型要求、篇幅与格式要求、',
    '  费用与开放获取说明、原文中的联系方式与注意事项。',
    '  要求：① 不要概括、不要合并、不要省略段落，宁可长也不要丢信息；② 不要添加原文没有的内容，',
    '  不要写「本文介绍了…」这类导读；③ 数字、日期、期刊名、系统名（Editorial Manager 等）、',
    '  邮箱、链接一律原样保留，不要意译；④ 用小标题或换行分段，段落之间用 \\n 分隔；',
    '  ⑤ 已经是中文的段落原样保留，只需把英文段落翻译过来；⑥ 全文控制在 4000 字以内，',
    '  超长时优先保留征稿范围、日期、编辑、投稿要求这些决策相关信息。',
    '- topicsZh：3~6 个中文主题词（如「生成式AI」「数字运营」「可持续金融」），便于筛选。',
    '- guestEditors：客座编辑，name 姓名原文、affiliation 单位（原文有就填，没有留空）。',
    '- openDate / deadline：投稿开放日与截稿日，统一 YYYY-MM-DD。',
    '  原文常写「截稿日期：2026年12月31日」「投稿截止 2026.12.31」；只给月日时用文章年份推断。不要猜不存在的日期。',
    '- submitUrl：投稿系统地址（如 Editorial Manager / ScholarOne）。siUrl：该专刊在出版社的详情页（如 sciencedirect.com/special-issue/...）。',
    '  journalUrl：期刊主页。三者都只能从原文出现的链接里取，取不到就留空字符串，**绝对不要自己拼地址**。',
    '- submissionNote：投稿时的注意事项，如「文章类型选择 VSI: xxx」。',
    '- confidence：0~1，表示这条抽取的可信度。',
    '',
    '【判断】',
    '- 一篇材料通常只有 1 个专刊。若确实介绍了多个专刊，就输出多条 issues。',
    '- 若内容不是征稿信息（广告、招聘、论文推介、纯资讯），输出 {"isCallForPapers":false,"issues":[]}。',
    '- 宁可留空也不要编造。抽不到期刊名时把 confidence 压到 0.3 以下。',
  ].join('\n');

  const user = [
    `材料来源：${sourceName}`,
    articleTitle ? `材料标题：${articleTitle}` : '',
    articleDate ? `发布日期：${articleDate}` : '',
    '',
    '正文：',
    str(article).slice(0, 14000),
  ].filter(Boolean).join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * 单独做「全文翻译」的提示词。
 * 用于给旧卡片补 detailZh（抽取时还没有这个字段），或用户点了「重新翻译」。
 */
export function buildTranslateMessages(issue = {}, articleText = '') {
  const system = [
    '你是学术专刊征稿信息的翻译器。把下面的英文（或中英混排）征稿材料完整译成简体中文。',
    '',
    '要求：',
    '1. 逐段翻译，不概括、不合并、不省略；原文分条列出的，译文也分条列出。',
    '2. 不添加原文没有的内容，不写导读、不写总结、不写「以上」。',
    '3. 数字、日期、期刊名、投稿系统名、邮箱、链接、专刊编号（如 VSI: xxx）原样保留。',
    '4. 已是中文的段落原样保留。',
    '5. 用换行分段；小标题单独成行。',
    '6. 只输出译文本身，不要 JSON、不要代码围栏、不要任何解释。',
  ].join('\n');
  const meta = [
    `期刊：${clean(issue.journal) || '未知'}`,
    clean(issue.titleZh || issue.titleEn) ? `专刊主题：${clean(issue.titleZh || issue.titleEn)}` : '',
    clean(issue.deadline) ? `截稿日期：${clean(issue.deadline)}` : '',
  ].filter(Boolean).join('\n');
  const user = [meta, '', '材料正文：', str(articleText).slice(0, 14000)].filter(Boolean).join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * 模型输出被截断（全文翻译太长、max_tokens 用完）时的抢救：
 * JSON.parse 必然失败，但前面那些短字段是完整的，可以用正则一个个捞出来，
 * 至少能出卡；detailZh 取到断点为止的部分译文，也好过整条丢弃。
 * 只有连期刊名/主题都捞不到时才真的失败。
 */
export function salvageModelJson(full) {
  const s = str(full);
  const pick = (key) => {
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'i').exec(s);
    return m ? m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\') : '';
  };
  // detailZh 可能被截断在中间，没有收尾引号：取到文本末尾
  const detailOpen = /"detailZh"\s*:\s*"([\s\S]*)$/i.exec(s);
  let detail = pick('detailZh');
  if (!detail && detailOpen) {
    detail = detailOpen[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\+$/, '');
  }
  const journal = pick('journal') || pick('journalName');
  const titleZh = pick('titleZh');
  if (!journal && !titleZh) return null;
  const arr = (key) => {
    const m = new RegExp(`"${key}"\\s*:\\s*\\[([\\s\\S]*?)\\]`, 'i').exec(s);
    if (!m) return [];
    try { return JSON.parse('[' + m[1] + ']'); } catch { return []; }
  };
  return {
    isCallForPapers: true,
    issues: [{
      journal,
      journalShort: pick('journalShort'),
      publisher: pick('publisher'),
      titleEn: pick('titleEn'),
      titleZh,
      summaryZh: pick('summaryZh'),
      detailZh: detail,
      topicsZh: arr('topicsZh'),
      guestEditors: arr('guestEditors'),
      openDate: pick('openDate'),
      deadline: pick('deadline'),
      submitUrl: pick('submitUrl'),
      siUrl: pick('siUrl'),
      journalUrl: pick('journalUrl'),
      submissionNote: pick('submissionNote'),
      confidence: 0.5,
    }],
    salvaged: true,
  };
}

/** 从模型返回的文本里抠出 JSON（容忍代码围栏与前后废话）。 */
export function parseModelJson(full) {
  const s = str(full).trim().replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '');
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try { return JSON.parse(s.slice(first, last + 1)); } catch { return null; }
}

/**
 * 把模型输出收敛成受控的 issue 数组。
 * @returns {{issues: Array, rejected: number}}
 */
export function normalizeExtractedIssues(payload, ctx = {}) {
  const {
    articleUrl = '', articleTitle = '', articlePublishedAt = '', articleId = '',
    sourceId = '', sourceName = '', now = new Date(),
  } = ctx;
  const raw = payload && typeof payload === 'object' ? payload : {};
  if (raw.isCallForPapers === false) return { issues: [], rejected: 0, notCfp: true };
  const list = Array.isArray(raw.issues) ? raw.issues : Array.isArray(payload) ? payload : raw.journal ? [raw] : [];
  const issues = [];
  let rejected = 0;

  for (const item of list.slice(0, 12)) {
    if (!item || typeof item !== 'object') { rejected += 1; continue; }
    // 模型偶尔把简称写在期刊名括号里，拆出来当 journalShort
    const nameParts = splitJournalShort(item.journal || item.journalName || item.journalFull || '');
    const journal = nameParts.journal;
    const titleEn = clean(item.titleEn || item.title || item.topicEn || '').slice(0, 300);
    let titleZh = clean(item.titleZh || item.topicZh || item.titleCN || '').slice(0, 300);
    if (!titleZh && titleEn) titleZh = titleEn;
    const deadline = normalizeDate(item.deadline || item.submissionDeadline || '', now);
    const openDate = normalizeDate(item.openDate || item.openingDate || '', now);
    const summaryZh = clean(item.summaryZh || item.summary || item.abstract || '').slice(0, 400);
    // 全文翻译：保留换行（卡片详情要分段显示），只收敛多余空行
    const detailZh = str(item.detailZh || item.detail || item.translationZh || item.fullTextZh || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 12000);
    // 没有期刊名也没有主题，无法构成一张卡片
    if (!journal && !titleZh) { rejected += 1; continue; }
    if (deadline && Date.parse(deadline + 'T00:00:00') < Date.parse(new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString())) {
      rejected += 1;
      continue;
    }
    const topicsZh = (Array.isArray(item.topicsZh) ? item.topicsZh : Array.isArray(item.topics) ? item.topics : [])
      .map((t) => clean(t).slice(0, 24)).filter(Boolean).slice(0, 8);
    const guestEditors = (Array.isArray(item.guestEditors) ? item.guestEditors : [])
      .map((e) => (typeof e === 'string'
        ? { name: clean(e).slice(0, 60), affiliation: '' }
        : { name: clean(e?.name).slice(0, 60), affiliation: clean(e?.affiliation || e?.org).slice(0, 80) }))
      .filter((e) => e.name).slice(0, 10);

    issues.push({
      journal,
      journalShort: clean(item.journalShort || item.abbr || nameParts.short || '').slice(0, 40),
      publisher: clean(item.publisher || '').slice(0, 60),
      titleEn, titleZh, summaryZh, detailZh, topicsZh, guestEditors,
      openDate, deadline,
      submitUrl: safeHttpUrl(item.submitUrl || item.submissionUrl || '', articleUrl),
      siUrl: safeHttpUrl(item.siUrl || item.callUrl || item.detailUrl || '', articleUrl),
      journalUrl: safeHttpUrl(item.journalUrl || item.homepage || '', articleUrl),
      submissionNote: clean(item.submissionNote || '').slice(0, 300),
      confidence: Math.max(0, Math.min(1, Number(item.confidence) || (journal ? 0.7 : 0.4))),
      articleUrl, articleTitle, articlePublishedAt, articleId, sourceId, sourceName,
      extractedBy: 'ai',
    });
  }
  return { issues, rejected, notCfp: false };
}

// ---------------- 规则兜底 ----------------

/**
 * 字段值的终止边界。
 * 微信正文里「期刊：… 专刊主题：… 截稿日期：…」常挤在同一行（span 排版，转纯文本后没换行），
 * 所以不能只靠 [^\n]+，必须在下一个字段标签处截断。
 */
const STOP_RE = /(?:期刊(?:名称|全称|介绍|简介|定位)?|专刊(?:名称|名|主题|题目|编号)|特刊(?:名称|主题|题目)|专题名称|中文(?:主题|题目|标题)|英文(?:主题|题目|标题)|截稿日期|投稿截止|截止日期|截稿时间|客座编辑|特邀编辑|投稿方式|投稿说明|投稿类型|投稿链接|投稿地址|投稿开(?:放|始)(?:日期)?|开放日期|重要日期|专刊链接|征稿链接|期刊主页|年发文量|影响因子)\s*[:：]/i;

/** 不要求行首的字段查找：公众号正文里标签常被拆成「期刊\\n：值」，行首锚点会漏。 */
function fieldValue(text, names) {
  const re = new RegExp(`(?:${names})\\s*[:：]\\s*`, 'i');
  const m = re.exec(text);
  if (!m) return '';
  const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 400);
  const stop = STOP_RE.exec(rest);
  const value = stop && stop.index > 0 ? rest.slice(0, stop.index) : rest.split('\n')[0];
  return clean(value);
}

/** 取所有「专刊主题」出现的值，用于区分英文原名与中文译名。 */
function allFieldValues(text, names) {
  const re = new RegExp(`(?:${names})\\s*([:：])?\\s*`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(text)) && out.length < 8) {
    const hasColon = !!m[1];
    const rest = text.slice(re.lastIndex, re.lastIndex + 400);
    if (hasColon) {
      const stop = STOP_RE.exec(rest);
      const v = clean(stop && stop.index > 0 ? rest.slice(0, stop.index) : rest.split('\n')[0]);
      if (v.length >= 2 && v.length <= 300) out.push(v);
      continue;
    }
    // 没有冒号：字段名独占一行，值在下一行
    const sameLine = clean(rest.split('\n')[0]);
    if (sameLine.length >= 6 && !STOP_RE.test(sameLine)) { out.push(sameLine); continue; }
    const nl = rest.indexOf('\n');
    if (nl >= 0) {
      const next = clean(rest.slice(nl + 1).split('\n')[0]);
      if (next.length >= 4 && next.length <= 300) out.push(next);
    }
  }
  return out;
}

const CJK = /[\u4e00-\u9fa5]{2,}/;
const LATIN = /[A-Za-z]{4,}/;

/**
 * 识别出版商。
 * 注意不能简单取全文第一个出版社名：「Kejia Hu (Oxford)」里的 Oxford 是单位不是出版商。
 * 因此先看「由 X 出版 / published by X」，再退化为已知出版社清单（不含 Oxford/Cambridge 单词）。
 */
const PUBLISHERS = [
  'Elsevier', 'Springer', 'Wiley', 'Taylor\\s*&\\s*Francis', 'SAGE', 'Sage', 'Emerald',
  'INFORMS', 'Palgrave', 'Oxford University Press', 'Cambridge University Press', 'World Scientific',
];
function detectPublisher(text) {
  const explicit = new RegExp(`(?:由|published\\s+by|by)\\s*(${PUBLISHERS.join('|')})\\s*(?:出版|发行)?`, 'i').exec(text);
  if (explicit) return clean(explicit[1]).replace(/\s+/g, ' ');
  const any = new RegExp(`(${PUBLISHERS.join('|')})`, 'i').exec(text);
  return any ? clean(any[1]).replace(/\s+/g, ' ') : '';
}

/**
 * 没有「期刊简介」段落时的摘要兜底：跳过字段行（`期刊：…`）、链接、编号列表，
 * 取真正的叙述句拼接，避免把「发布时间：2026-11-05」当成摘要。
 */
function ruleSummary(body) {
  const FIELD_LINE = /^[^\n：:]{2,14}\s*[:：]/;
  const prose = body.split('\n').map(clean).filter((l) => (
    l.length >= 18
    && !FIELD_LINE.test(l)
    && !/^https?:\/\//i.test(l)
    && !/^[#>*]/.test(l)
    && !/^\d+\s*[.、)）]/.test(l)
  ));
  return prose.slice(0, 3).join(' ').slice(0, 500);
}

/**
 * 不依赖模型的正则抽取，针对「期刊：…/专刊主题：…/截稿日期：…」这类固定版式。
 * 只在没有可用模型时使用，结果标注 extractedBy:'rule'，置信度偏低。
 */
export function ruleExtractIssues(text, ctx = {}) {
  const {
    articleUrl = '', articleTitle = '', articlePublishedAt = '', articleId = '',
    sourceId = '', sourceName = '', now = new Date(),
  } = ctx;
  const body = str(text);
  if (!body.trim()) return { issues: [], rejected: 0 };
  // 明确的征稿信号，否则不进入规则抽取
  if (!/(专刊|特刊|征稿|call\s+for\s+papers|special\s+issue|截稿|客座编辑)/i.test(body)) {
    return { issues: [], rejected: 0, notCfp: true };
  }

  const journalRaw = fieldValue(body, '期刊(?:名称|全称)?');
  const journalParts = splitJournalShort(journalRaw);
  const journal = journalParts.journal;
  const shortMatch = /(?:简称|常用缩写|缩写)\s*[:：]\s*([A-Za-z&.\- ]{2,40})/.exec(body);
  // 正文常不写「简称」，优先用期刊名括号里的缩写，其次从破折号前半段或首词派生
  const derivedShort = (() => {
    if (shortMatch) return clean(shortMatch[1]).slice(0, 40);
    if (journalParts.short) return journalParts.short.slice(0, 40);
    const dash = /^([A-Za-z][A-Za-z0-9&.\- ]{1,30}?)\s*[–—]\s+/.exec(journal);
    if (dash) return clean(dash[1]).slice(0, 40);
    const first = journal.split(/\s+/)[0] || '';
    return /^(The|A|An|Journal|International)$/i.test(first) ? '' : clean(first).slice(0, 40);
  })();
  const themeValues = allFieldValues(body, '专刊主题|特刊主题|专题名称|专刊题目|专题征稿主题');
  // 有的推文把中英文主题拆成两行字段，这时直接按字段名取更准
  const enTheme = fieldValue(body, '英文主题|英文题目|英文标题');
  const cnTheme = fieldValue(body, '中文主题|中文题目|中文标题');
  let titleEn = '';
  let titleZh = '';
  for (const v of themeValues) {
    const hasCjk = CJK.test(v);
    const hasLatin = LATIN.test(v);
    if (!titleEn && hasLatin && !hasCjk) { titleEn = v.slice(0, 300); continue; }
    if (!titleZh && hasCjk) titleZh = v.slice(0, 300);
  }
  if (!titleEn && enTheme && LATIN.test(enTheme) && !CJK.test(enTheme)) titleEn = enTheme.slice(0, 300);
  if (!titleZh && cnTheme && CJK.test(cnTheme)) titleZh = cnTheme.slice(0, 300);
  if (!titleEn) {
    const inParen = /[（(]([A-Za-z][^）)]{10,200})[）)]/.exec(titleZh || themeValues[0] || '');
    if (inParen) titleEn = clean(inParen[1]).slice(0, 300);
  }
  if (!titleZh) titleZh = titleEn;
  if (titleZh) titleZh = titleZh.replace(/[（(][^）)]*[）)]\s*$/, '').trim();

  const deadlineRaw = fieldValue(body, '截稿日期|投稿截止(?:日期)?|截止日期|截稿时间|deadline');
  const deadline = normalizeDate(deadlineRaw, now);
  const editorsRaw = fieldValue(body, '客座编辑|特邀编辑|guest\\s+editors?');
  const guestEditors = editorsRaw
    ? editorsRaw.split(/[、,，;；]/).map((part) => {
      const m = /^(.+?)\s*[（(]([^）)]*)[）)]\s*$/.exec(clean(part));
      return m ? { name: clean(m[1]).slice(0, 60), affiliation: clean(m[2]).slice(0, 80) } : { name: clean(part).slice(0, 60), affiliation: '' };
    }).filter((e) => e.name).slice(0, 10)
    : [];

  // 正文里若没有成对的「专刊主题：」，退一步用明显的英文标题行
  if (!titleEn) {
    const enLine = body.split('\n').map(clean)
      .find((l) => l.length > 25 && l.length < 200 && /^[A-Z][A-Za-z0-9 ,:&'\-–—]+$/.test(l)
        && /(AI|Digital|Sustainable|Governance|Innovation|Data|Management|Finance|Policy)/i.test(l));
    if (enLine) titleEn = enLine.slice(0, 300);
  }

  const urls = body.match(/https?:\/\/[^\s<>"'）)，。、]+/gi) || [];
  // 正文写了「专刊链接：」「投稿链接：」时优先信字段，比按路径猜更准
  const siUrl = safeHttpUrl(fieldValue(body, '专刊链接|征稿链接|专刊页|专刊详情'))
    || urls.map((u) => safeHttpUrl(u, articleUrl)).find((u) => /special-issue|special_issues|calls?-for-papers|call-for-papers|research-topics|collections|\/updates\//i.test(u)) || '';
  const submitUrl = safeHttpUrl(fieldValue(body, '投稿链接|投稿地址|投稿系统|提交地址'))
    || urls.map((u) => safeHttpUrl(u, articleUrl)).find((u) => /editorialmanager|scholarone|submit\.|mc\.manuscriptcentral|submission/i.test(u)) || '';
  const journalUrl = urls.map((u) => safeHttpUrl(u, articleUrl)).find((u) => u && u !== siUrl && u !== submitUrl && /sciencedirect\.com\/journal|springer\.com\/journal|tandfonline\.com\/journal|wiley\.com\/journal|sagepub\.com/i.test(u)) || '';

  if (!journal && !titleZh) return { issues: [], rejected: 1 };
  if (deadline && Date.parse(deadline + 'T00:00:00') < Date.parse(new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString())) {
    return { issues: [], rejected: 1 };
  }

  // 摘要：优先取「期刊介绍/征稿范围」段落；否则从正文里挑真正的叙述句
  // （不能直接截正文开头——开场白往往是「各位老师好」和「发布时间：…」这类字段行）
  const introMatch = /(?:期刊介绍|期刊简介|关于期刊|专刊介绍|征稿范围|征稿主题)\s*[:：]?\s*\n?([\s\S]{30,900}?)(?:\n\s*(?:专刊|特刊|征稿|核心征稿|投稿|客座|截稿))/i.exec(body);
  // 公众号常把「期刊介绍：……」（含冒号）写在同一行，上面那条要求换行分段，会漏掉这种写法
  const introInline = /(?:期刊介绍|期刊简介|关于期刊|专刊介绍|征稿范围|征稿主题)\s*[:：]\s*([^\n]{20,800})/.exec(body);
  const summaryZh = clean(introInline?.[1] || introMatch?.[1] || ruleSummary(body)).slice(0, 800);

  const topicsZh = [...new Set(
    (body.match(/(?:人工智能|机器学习|深度学习|大模型|生成式AI|生成式人工智能|AIGC|算法|可解释性|数字化|数字运营|数字经济|可持续|ESG|绿色|供应链|产业链|平台|平台经济|金融科技|数字金融|金融|会计|审计|公司治理|治理|创新创业|创新|创业|消费者|营销|品牌|旅游|医疗健康|教育|公共政策|区块链|物联网|数字孪生|风险管理|组织行为|人力资源|知识管理|运营管理|运筹|战略|国际化|伦理)/g) || []),
  )].slice(0, 6);

  return {
    issues: [{
      journal,
      journalShort: derivedShort,
      publisher: detectPublisher(body),
      titleEn, titleZh, summaryZh,
      // 规则抽取不做翻译：detailZh 留空，界面会提示「配好模型后可生成全文翻译」，
      // 而不是把中文原文冒充成译文。
      detailZh: '',
      topicsZh, guestEditors,
      openDate: normalizeDate(fieldValue(body, '投稿开放|开放日期|投稿开始'), now),
      deadline,
      submitUrl, siUrl, journalUrl,
      submissionNote: fieldValue(body, '投稿方式|投稿说明|投稿类型|文章类型').slice(0, 300),
      confidence: journal && deadline ? 0.55 : 0.35,
      articleUrl, articleTitle, articlePublishedAt, articleId, sourceId, sourceName,
      extractedBy: 'rule',
    }],
    rejected: 0,
  };
}
