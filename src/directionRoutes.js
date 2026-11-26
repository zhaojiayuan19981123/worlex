// directionRoutes.js —— 方向分析（三）：HTTP 路由 + 会话存储 + 后台分析任务
//
// 链路：检索（OpenAlex，见 directionSearch.js）→ 用户勾选 → 后台调模型
//      （prompt 与解析见 directionAnalyze.js）→ 报告落到 session.analyses。
//
// 分析为什么要做成「后台任务 + 轮询」而不是一次 POST 等结果：
//   一次分析要读 10~30 篇摘要、生成三四千字 JSON，本地 7B 模型能跑两三分钟。
//   HTTP 一步到底很容易被浏览器/代理掐断，也看不到进度。这里改成
//   POST 立刻拿 jobId，再轮询 /api/direction/job/:id 取状态与已生成字数。

import { randomUUID } from 'node:crypto';
import {
  DEFAULT_FILTERS, MAX_TOPICS, MAX_RESULTS, SEARCH_FIELDS, SORTS, WORK_TYPES,
  normalizeFilters, normalizeTopic, searchTopics, linksFor, topicPhrases,
} from './directionSearch.js';
import {
  ANALYSIS_MODES, buildAnalysisMessages, parseAnalysisJson, normalizeAnalysis, hasAnalysisContent, normalizeMode,
} from './directionAnalyze.js';

const str = (v) => String(v == null ? '' : v);
const clean = (v) => str(v).replace(/\s+/g, ' ').trim();
/** 会话里最多留几份历史报告 / 几个会话：文件要跟着数据备份走，不能无限长 */
const MAX_ANALYSES = 10;
const MAX_SESSIONS = 20;
const MAX_JOB_HISTORY = 30;
/** 单次分析最多塞几篇：再多摘要就超上下文，模型也会明显开始编 */
const MAX_ANALYZE_PAPERS = 40;
/** 单篇摘要写进会话文件时的上限（候选列表本身不需要全文摘要） */
const SAVED_ABSTRACT = 2000;

function normalizeTopics(raw) {
  const list = (Array.isArray(raw) ? raw : []).slice(0, MAX_TOPICS);
  return list
    .map((t, i) => normalizeTopic(t, i))
    .filter((t) => topicPhrases(t.keywords).length)
    .map((t, i) => ({ ...t, id: t.id || `t${i + 1}` }));
}

function sessionTitle(topics) {
  const names = topics.map((t) => clean(t.name) || topicPhrases(t.keywords)[0] || '').filter(Boolean);
  const text = names.slice(0, 3).join(' × ');
  return clean(text).slice(0, 60) || `方向分析 ${new Date().toLocaleString('zh-CN')}`;
}

function slimPaper(paper) {
  return {
    id: paper.id,
    doi: paper.doi || '',
    title: paper.title || '',
    abstract: str(paper.abstract).slice(0, SAVED_ABSTRACT),
    year: paper.year || 0,
    date: paper.date || '',
    authors: Array.isArray(paper.authors) ? paper.authors.slice(0, 12) : [],
    authorLine: paper.authorLine || '',
    venue: paper.venue || '',
    citedBy: paper.citedBy || 0,
    type: paper.type || '',
    language: paper.language || '',
    topic: paper.topic || '',
    oaUrl: paper.oaUrl || '',
    landUrl: paper.landUrl || '',
    url: paper.url || '',
    topics: Array.isArray(paper.topics) ? paper.topics : [],
  };
}

function normalizeSession(raw) {
  const now = new Date().toISOString();
  const topics = Array.isArray(raw?.topics) ? raw.topics : [];
  const papers = (Array.isArray(raw?.papers) ? raw.papers : []).slice(0, MAX_RESULTS).map(slimPaper);
  const ids = new Set(papers.map((p) => p.id));
  return {
    id: clean(raw?.id) || `dir-${randomUUID().slice(0, 8)}`,
    title: clean(raw?.title).slice(0, 60) || sessionTitle(topics),
    createdAt: clean(raw?.createdAt) || now,
    updatedAt: clean(raw?.updatedAt) || now,
    topics,
    filters: normalizeFilters(raw?.filters),
    papers,
    // 选中集合永远和候选列表对齐，避免删掉文献后留下幽灵 id
    selected: (Array.isArray(raw?.selected) ? raw.selected : []).filter((id) => ids.has(id)),
    perTopic: Array.isArray(raw?.perTopic) ? raw.perTopic : [],
    analyses: (Array.isArray(raw?.analyses) ? raw.analyses : []).slice(0, MAX_ANALYSES),
    stats: raw?.stats && typeof raw.stats === 'object' ? raw.stats : {},
    model: clean(raw?.model),
  };
}

function sessionSummary(session) {
  const latest = session.analyses[0] || null;
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    paperCount: session.papers.length,
    selectedCount: session.selected.length,
    hasAnalysis: Boolean(latest),
    topics: session.topics.map((t) => ({ id: t.id, name: t.name, keywords: t.keywords })),
    latestMode: latest?.mode || '',
    latestAt: latest?.createdAt || '',
    gapCount: latest?.analysis?.gaps?.length || 0,
    directionCount: latest?.analysis?.directions?.length || 0,
  };
}

/** 报告 → Markdown：导出到「Markdown 笔记」时用，也用于复制到剪贴板 */
export function analysisToMarkdown(session, record) {
  const a = record?.analysis || {};
  // evidence 里的编号对应「送进模型的那批文献」的次序，不是候选列表次序
  const order = (record?.paperIds || []).length ? record.paperIds : (session.selected || []);
  const paperAt = (n) => session.papers.find((p) => p.id === order[n - 1]) || null;
  const cite = (evidence) => (evidence || []).map((n) => {
    const paper = paperAt(n);
    return `[${n}] ${paper ? clean(paper.title).slice(0, 80) : '（文献已移除）'}`;
  }).join('；');
  const lines = [`# 方向分析：${session.title}`, '', `主题：${session.topics.map((t) => clean(t.name) || t.keywords).join('；')}`, `文献样本：${record?.paperCount || session.selected.length} 篇｜模型：${record?.model || '未记录'}｜生成时间：${record?.createdAt || ''}`, ''];
  if (a.overview) lines.push('## 综述', '', a.overview, '');
  if ((a.gaps || []).length) {
    lines.push('## 研究空白', '');
    a.gaps.forEach((gap, i) => {
      lines.push(`### ${i + 1}. ${gap.title}`, '', gap.statement || '');
      if (gap.why) lines.push('', `**为什么仍是空白**：${gap.why}`, '');
      lines.push(`置信度：${gap.confidence}｜证据：${cite(gap.evidence)}`, '');
    });
  }
  if ((a.directions || []).length) {
    lines.push('## 研究方向', '');
    a.directions.forEach((d, i) => {
      lines.push(`### ${i + 1}. ${d.title}`, '', `**研究问题**：${d.question || '—'}`, '');
      if (d.approach) lines.push(`**技术路线**：${d.approach}`, '');
      if (d.data) lines.push(`**数据 / 条件**：${d.data}`, '');
      if (d.contribution) lines.push(`**预期贡献**：${d.contribution}`, '');
      if (d.novelty) lines.push(`**新在哪里**：${d.novelty}`, '');
      lines.push(`难度：${d.difficulty}${d.risks ? `｜风险：${d.risks}` : ''}`, '', `证据：${cite(d.evidence)}`, '');
    });
  }
  if ((a.clusters || []).length) {
    lines.push('## 主题簇', '');
    a.clusters.forEach((c) => lines.push(`- **${c.name}**：${c.summary || ''}${c.papers.length ? `（文献 ${c.papers.join('、')}）` : ''}`));
    lines.push('');
  }
  if ((a.readingOrder || []).length) {
    lines.push('## 建议阅读顺序', '');
    a.readingOrder.forEach((r) => {
      const paper = paperAt(r.index);
      lines.push(`${r.index}. ${paper ? clean(paper.title) : `文献 ${r.index}`}${r.reason ? ` —— ${r.reason}` : ''}`);
    });
    lines.push('');
  }
  if ((a.cautions || []).length) {
    lines.push('## 使用边界', '');
    a.cautions.forEach((c) => lines.push(`- ${c}`));
    lines.push('');
  }
  lines.push('---', '', '> 本报告由所选文献摘要生成，未阅读全文；引用前请核对原文。');
  return lines.join('\n');
}

export function registerDirectionRoutes(app, {
  store, resolveRequestModel, fetchModelCompletion, readLLMResponse, fetchImpl, logger,
} = {}) {
  const log = typeof logger === 'function' ? logger : () => {};
  /** jobId → 运行状态。只在内存里，进程重启后前端重新点一次即可（报告本身已落盘） */
  const jobs = new Map();

  const readState = () => {
    const state = store.getDirectionState();
    const sessions = Array.isArray(state?.sessions) ? state.sessions.map(normalizeSession) : [];
    return {
      version: 1,
      sessions,
      activeSessionId: clean(state?.activeSessionId),
      preferences: { model: '', abstractChars: 1100, maxPapers: 30, language: 'zh', ...(state?.preferences || {}) },
    };
  };
  const writeState = (state) => store.saveDirectionState({
    version: 1,
    sessions: state.sessions.slice(0, MAX_SESSIONS),
    activeSessionId: state.activeSessionId,
    preferences: state.preferences,
  });
  const findSession = (state, id) => state.sessions.find((s) => s.id === id) || null;
  const touch = (session) => { session.updatedAt = new Date().toISOString(); return session; };

  const meta = {
    fields: SEARCH_FIELDS,
    types: WORK_TYPES,
    sorts: SORTS,
    modes: ANALYSIS_MODES,
    limits: { maxTopics: MAX_TOPICS, maxResults: MAX_RESULTS, maxAnalyzePapers: MAX_ANALYZE_PAPERS },
    defaults: DEFAULT_FILTERS,
    source: {
      id: 'openalex',
      label: 'OpenAlex',
      note: '开放学术数据库（免密钥、含摘要与引用数）。百度学术 / X-MOL 需要登录与人机验证，服务端取不到，已改为用同一组关键词一键跳转。',
    },
  };

  // ---------- 会话列表 ----------
  app.get('/api/direction', (_req, res) => {
    const state = readState();
    res.json({
      sessions: state.sessions.map(sessionSummary),
      activeSessionId: state.activeSessionId,
      preferences: state.preferences,
      meta,
    });
  });

  app.get('/api/direction/session/:id', (req, res) => {
    const state = readState();
    const session = findSession(state, req.params.id);
    if (!session) return res.status(404).json({ error: '这次检索记录已不存在' });
    res.json({ session, meta, links: linksFor(session.topics) });
  });

  app.patch('/api/direction/session/:id', (req, res) => {
    const state = readState();
    const session = findSession(state, req.params.id);
    if (!session) return res.status(404).json({ error: '这次检索记录已不存在' });
    if (typeof req.body?.title === 'string' && clean(req.body.title)) session.title = clean(req.body.title).slice(0, 60);
    if (Array.isArray(req.body?.selected)) {
      const ids = new Set(session.papers.map((p) => p.id));
      session.selected = [...new Set(req.body.selected.filter((id) => ids.has(id)))];
    }
    touch(session);
    state.activeSessionId = session.id;
    writeState(state);
    res.json({ session: sessionSummary(session) });
  });

  app.delete('/api/direction/session/:id', (req, res) => {
    const state = readState();
    const before = state.sessions.length;
    state.sessions = state.sessions.filter((s) => s.id !== req.params.id);
    if (state.sessions.length === before) return res.status(404).json({ error: '这次检索记录已不存在' });
    if (state.activeSessionId === req.params.id) state.activeSessionId = state.sessions[0]?.id || '';
    writeState(state);
    res.json({ ok: true, sessions: state.sessions.map(sessionSummary) });
  });

  // ---------- 检索 ----------
  app.post('/api/direction/search', async (req, res) => {
    const topics = normalizeTopics(req.body?.topics);
    if (!topics.length) return res.status(400).json({ error: '请至少填一个主题关键词（多个词用逗号分隔表示「必须同时包含」）' });
    const filters = normalizeFilters(req.body?.filters);
    const mailto = clean(req.body?.mailto);
    try {
      const result = await searchTopics(topics, filters, { fetchImpl, mailto, concurrency: 3 });
      if (result.error) return res.status(400).json({ error: result.error });

      const state = readState();
      const existing = clean(req.body?.sessionId) ? findSession(state, req.body.sessionId) : null;
      const session = normalizeSession({
        ...(existing || {}),
        id: existing?.id,
        topics,
        filters,
        papers: result.papers,
        perTopic: result.perTopic,
        stats: {
          duplicated: result.duplicated || 0,
          truncated: Boolean(result.truncated),
          droppedByExclude: (result.perTopic || []).reduce((sum, t) => sum + (t.droppedByExclude || 0), 0),
          totalHits: (result.perTopic || []).reduce((sum, t) => sum + (t.total || 0), 0),
          searchedAt: new Date().toISOString(),
        },
        // 换了一批候选，旧报告仍然留着（标题里标了当时的文献数），但选中集合只保留还在列表里的
        selected: existing?.selected || [],
      });
      if (!existing) session.title = clean(req.body?.title).slice(0, 60) || sessionTitle(topics);
      touch(session);

      if (existing) {
        const index = state.sessions.findIndex((s) => s.id === session.id);
        state.sessions[index] = session;
      } else {
        state.sessions.unshift(session);
      }
      state.activeSessionId = session.id;
      writeState(state);
      res.json({
        session,
        meta,
        links: linksFor(session.topics),
        empty: session.papers.length === 0,
        hint: session.papers.length ? '' : '没有命中：试试放宽年份 / 引用数限制，或改用英文关键词（该数据源以英文文献为主）。',
      });
    } catch (error) {
      const message = /abort|timeout|超时/i.test(String(error?.message)) ? '检索超时，请减少主题数量后重试' : `检索失败：${error.message}`;
      log(`[方向分析] ${message}`);
      res.status(502).json({ error: message });
    }
  });

  // ---------- 分析（后台任务） ----------
  app.post('/api/direction/analyze', (req, res) => {
    const state = readState();
    const session = findSession(state, clean(req.body?.sessionId));
    if (!session) return res.status(404).json({ error: '这次检索记录已不存在' });

    const wanted = Array.isArray(req.body?.paperIds) ? req.body.paperIds : session.selected;
    const byId = new Map(session.papers.map((p) => [p.id, p]));
    const papers = [...new Set(wanted)].map((id) => byId.get(id)).filter(Boolean);
    if (!papers.length) return res.status(400).json({ error: '请先勾选至少 1 篇文献' });
    if (papers.length > MAX_ANALYZE_PAPERS) return res.status(400).json({ error: `单次最多分析 ${MAX_ANALYZE_PAPERS} 篇，请减少勾选` });
    if (!papers.some((p) => str(p.abstract).length >= 60)) {
      return res.status(400).json({ error: '所选文献都没有摘要，无法做空白分析。请换几篇带摘要的文献，或放宽「只看有摘要」的限制重新检索' });
    }

    const picked = resolveRequestModel(req.body?.profileId);
    if (picked?.error) return res.status(400).json({ error: picked.error });
    const profile = picked.profile;

    const running = [...jobs.values()].find((j) => j.sessionId === session.id && j.status === 'running');
    if (running) return res.status(409).json({ error: '这一次检索正在分析中，等它跑完再开新的', jobId: running.id });

    const mode = normalizeMode(req.body?.mode);
    const job = {
      id: `job-${randomUUID().slice(0, 8)}`,
      sessionId: session.id,
      mode,
      status: 'running',
      text: '',
      error: '',
      analysis: null,
      model: profile.model || '',
      paperIds: papers.map((p) => p.id),
      paperCount: papers.length,
      startedAt: Date.now(),
      finishedAt: 0,
      cancel: () => {},
    };
    jobs.set(job.id, job);
    // 只留最近的若干条任务记录，避免长跑进程里无限攒
    if (jobs.size > MAX_JOB_HISTORY) {
      const stale = [...jobs.values()].filter((j) => j.status !== 'running').sort((a, b) => a.startedAt - b.startedAt);
      for (const item of stale.slice(0, jobs.size - MAX_JOB_HISTORY)) jobs.delete(item.id);
    }

    session.selected = papers.map((p) => p.id);
    session.model = job.model;
    touch(session);
    state.activeSessionId = session.id;
    writeState(state);

    runAnalysis({
      job, session, papers, mode,
      focus: clean(req.body?.focus),
      profile,
      fetchModelCompletion, readLLMResponse,
      onDone: (analysis) => {
        const record = {
          id: `rep-${randomUUID().slice(0, 8)}`,
          mode,
          model: job.model,
          createdAt: new Date().toISOString(),
          elapsedMs: job.finishedAt - job.startedAt,
          paperCount: papers.length,
          paperIds: papers.map((p) => p.id),
          analysis,
        };
        // 这里必须重新读一次状态：分析跑了两三分钟，期间用户可能已经改过标题或勾选
        const latest = readState();
        const target = findSession(latest, session.id);
        if (!target) return;
        target.analyses = [record, ...(target.analyses || [])].slice(0, MAX_ANALYSES);
        target.model = job.model;
        touch(target);
        latest.activeSessionId = target.id;
        writeState(latest);
        job.recordId = record.id;
      },
    }).catch((error) => {
      job.status = 'error';
      job.finishedAt = Date.now();
      job.error = String(error?.message || error);
      log(`[方向分析] 分析失败：${job.error}`);
    });

    res.json({ jobId: job.id, paperCount: papers.length, mode, model: job.model });
  });

  app.get('/api/direction/job/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: '这次分析任务已结束（或服务已重启），请重新点「开始分析」' });
    res.json({
      id: job.id,
      status: job.status,
      chars: job.text.length,
      elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
      paperCount: job.paperCount,
      mode: job.mode,
      model: job.model,
      analysis: job.analysis,
      recordId: job.recordId || '',
      error: job.error,
    });
  });

  app.post('/api/direction/job/:jobId/cancel', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: '任务已结束' });
    try { job.cancel(); } catch { /* 已经结束就无所谓 */ }
    job.status = 'error';
    job.error = '已取消';
    job.finishedAt = Date.now();
    res.json({ ok: true });
  });

  // ---------- 报告导出 / 打开原文 ----------
  app.post('/api/direction/export-markdown', (req, res) => {
    const state = readState();
    const session = findSession(state, clean(req.body?.sessionId));
    if (!session) return res.status(404).json({ error: '这次检索记录已不存在' });
    const record = (session.analyses || []).find((r) => r.id === clean(req.body?.recordId)) || session.analyses[0];
    if (!record) return res.status(400).json({ error: '还没有可导出的分析报告' });
    const content = analysisToMarkdown(session, record);
    const note = store.upsertMarkdownNote({
      id: store.newId(),
      title: `方向分析 · ${session.title}`.slice(0, 160),
      content,
      sourceName: '方向分析',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    res.json({ ok: true, noteId: note.id, title: note.title, chars: content.length });
  });

  app.get('/api/direction/markdown/:sessionId', (req, res) => {
    const state = readState();
    const session = findSession(state, req.params.sessionId);
    if (!session) return res.status(404).json({ error: '这次检索记录已不存在' });
    const record = (session.analyses || []).find((r) => r.id === clean(req.query.recordId)) || session.analyses[0];
    if (!record) return res.status(400).json({ error: '还没有可导出的分析报告' });
    res.json({ markdown: analysisToMarkdown(session, record) });
  });

  return {
    meta,
    /** 供测试断言用：当前后台任务快照 */
    jobList: () => [...jobs.values()].map((j) => ({ id: j.id, status: j.status, chars: j.text.length })),
  };
}

/** 真正跑模型的那一段：与路由分开，方便单测直接喂假模型 */
async function runAnalysis({
  job, session, papers, mode, focus, profile,
  fetchModelCompletion, readLLMResponse, onDone,
}) {
  const messages = buildAnalysisMessages({ topics: session.topics, papers, mode, focus });
  const request = await fetchModelCompletion(profile, {
    model: profile.model,
    messages,
    temperature: 0.35,
    max_tokens: 4200,
  }, { stream: true });
  job.cancel = () => { try { request.cancel(); } catch { /* 忽略 */ } };
  try {
    if (!request.up?.ok) {
      const detail = request.up?._litErrorText ?? await request.up?.text?.().catch?.(() => '') ?? '';
      const status = request.up?.status || 0;
      throw new Error(`AI 接口返回 ${status}${detail ? `：${clean(detail).slice(0, 200)}` : ''}`);
    }
    const out = await readLLMResponse(request.up, { onDelta: (delta) => { job.text += delta; } });
    const full = str(out.full || job.text).trim();
    if (out.aborted && !full) throw new Error('模型连接中断（可能是上下文过长或网络抖动）');
    job.finishedAt = Date.now();

    const parsed = parseAnalysisJson(full);
    if (!parsed) {
      job.status = 'error';
      job.error = `模型输出不是可解析的 JSON（已生成 ${full.length} 字）。常见原因：模型被 max_tokens 截断、或没按格式输出。可换用能力更强的模型重试，或减少文献数量。`;
      job.raw = full.slice(0, 4000);
      return;
    }
    const analysis = normalizeAnalysis(parsed, { paperCount: papers.length, mode });
    if (!hasAnalysisContent(analysis)) {
      job.status = 'error';
      job.error = '模型返回了空的空白 / 方向列表，请重试或换模型';
      job.raw = full.slice(0, 4000);
      return;
    }
    job.analysis = analysis;
    job.status = 'done';
    onDone?.(analysis);
  } finally {
    try { request.cancel?.(); } catch { /* 忽略 */ }
  }
}
