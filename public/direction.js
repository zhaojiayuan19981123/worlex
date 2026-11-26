/* direction.js —— 方向分析视图
 *
 * 挂载约定与 special-issue.js / knowledge-graph.js 一致：
 *   切入  window.DirectionView.mount(container)
 *   切走  window.DirectionView.close()
 *
 * 数据流：
 *   GET    /api/direction                      会话列表 + 元信息（字段/排序/模式）
 *   GET    /api/direction/session/:id          单个会话（候选文献 + 历史报告）
 *   POST   /api/direction/search               检索（落库成会话）
 *   POST   /api/direction/analyze              启动后台分析 → 拿 jobId
 *   GET    /api/direction/job/:id              轮询：状态 / 已生成字数 / 报告
 *   POST   /api/direction/job/:id/cancel       取消
 *   PATCH  /api/direction/session/:id          改标题 / 存勾选
 *   DELETE /api/direction/session/:id          删会话
 *   GET    /api/direction/markdown/:id         报告转 Markdown（复制用）
 *   POST   /api/direction/export-markdown      报告存进「Markdown 笔记」
 *
 * 布局：左「检索条件」+ 右「候选文献 / 分析报告」两个页签。
 * 为什么不是卡片网格：候选动辄几十篇、要逐篇勾选对比，行式列表一屏能看到 8~10 条，
 * 勾选和读标题是一件事；分析报告则要读长文，所以两者分页签而不是硬塞在一屏。
 */
(() => {
  'use strict';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = (u) => {
    try { const x = new URL(String(u || '')); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; }
  };
  const toast = (msg, type = '') => window.Worlex?.toast?.(msg, type) || console.log('[方向分析]', msg);

  async function api(path, opts = {}) {
    const init = { ...opts };
    if (init.body !== undefined) {
      init.body = JSON.stringify(init.body);
      init.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    }
    if (window.Worlex?.api) return window.Worlex.api(path, init);
    const res = await fetch(path, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
    return data;
  }

  const DEFAULT_FILTERS = {
    yearFrom: 0, yearTo: 0, minCitations: 0, type: '', language: '',
    onlyWithAbstract: true, includeRetracted: false, sort: 'relevance', perTopic: 30,
  };

  const S = {
    mounted: false,
    container: null,
    root: null,
    meta: null,
    sessions: [],
    session: null,
    // 侧栏编辑区（与已保存会话解耦：改条件不该立刻改掉历史）
    topics: [],
    filters: { ...DEFAULT_FILTERS },
    tab: 'papers',
    busy: '',
    job: null,
    pollTimer: null,
    selection: new Set(),
    expanded: new Set(),
    reportId: '',
    error: '',
    hint: '',
    pollStartedAt: 0,
  };

  const $ = (sel) => S.root?.querySelector(sel);
  const $$ = (sel) => [...(S.root?.querySelectorAll(sel) || [])];
  const nowYear = new Date().getFullYear();

  // ==================== 挂载 ====================

  function mount(container) {
    S.container = container;
    if (!S.mounted) {
      container.innerHTML = skeleton();
      S.mounted = true;
      bind();
    }
    S.root = container;
    if (!S.topics.length) S.topics = [blankTopic()];
    refresh();
  }

  function close() {
    stopPoll();
  }

  function skeleton() {
    return `
      <div class="dir-shell">
        <aside class="dir-side">
          <div class="dir-side-head">
            <div class="dir-side-title">检索条件</div>
            <select class="dir-history" data-dir="history" title="历史检索"><option value="">历史检索…</option></select>
          </div>
          <div class="dir-topics" data-dir-topics></div>
          <button class="btn btn-sm dir-add-topic" data-dir="add-topic">＋ 添加主题</button>
          <div class="dir-adv">
            <details data-dir-adv>
              <summary>高级检索</summary>
              <div class="dir-adv-body">
                <div class="dir-adv-row">
                  <label>年份</label>
                  <input class="dir-num" type="number" min="1900" max="${nowYear + 1}" placeholder="起" data-filter="yearFrom">
                  <span>–</span>
                  <input class="dir-num" type="number" min="1900" max="${nowYear + 1}" placeholder="止" data-filter="yearTo">
                </div>
                <div class="dir-adv-row">
                  <label>最低被引</label>
                  <input class="dir-num" type="number" min="0" step="10" placeholder="0" data-filter="minCitations">
                  <label class="dir-inline-check"><input type="checkbox" data-filter="onlyWithAbstract" checked> 只保留有摘要</label>
                </div>
                <div class="dir-adv-row">
                  <label>类型</label>
                  <select class="dir-select" data-filter="type">
                    <option value="">全部</option>
                    <option value="article">期刊论文</option>
                    <option value="review">综述</option>
                    <option value="preprint">预印本</option>
                    <option value="book-chapter">图书章节</option>
                  </select>
                  <label>语言</label>
                  <select class="dir-select" data-filter="language">
                    <option value="">全部</option>
                    <option value="en">英文</option>
                    <option value="zh">中文</option>
                  </select>
                </div>
                <div class="dir-adv-row">
                  <label>排序</label>
                  <select class="dir-select" data-filter="sort">
                    <option value="relevance">相关度</option>
                    <option value="cited">引用数</option>
                    <option value="recent">最新发表</option>
                  </select>
                  <label>每主题</label>
                  <input class="dir-num" type="number" min="5" max="50" step="5" value="30" data-filter="perTopic">
                </div>
                <label class="dir-inline-check"><input type="checkbox" data-filter="includeRetracted"> 包含已撤稿文献</label>
              </div>
            </details>
          </div>
          <div class="dir-side-foot">
            <button class="btn btn-primary dir-search-btn" data-dir="search">检索文献</button>
            <div class="dir-jump">
              <span>去网页看：</span>
              <button class="dir-link" data-dir="jump-baidu">百度学术</button>
              <button class="dir-link" data-dir="jump-xmol">X-MOL</button>
            </div>
            <div class="dir-source-note">检索走 OpenAlex（免密钥、带摘要与引用数）。百度学术 / X-MOL 需要登录与人机验证，服务端取不到，只能一键跳转由浏览器打开。</div>
          </div>
        </aside>

        <main class="dir-main">
          <div class="dir-main-head">
            <div class="seg-tabs dir-tabs">
              <button class="seg-tab active" data-dirtab="papers">候选文献 <span class="dir-count" data-dir-count>0</span></button>
              <button class="seg-tab" data-dirtab="report">分析报告</button>
            </div>
            <div class="tb-spacer"></div>
            <label class="dir-inline-check dir-all"><input type="checkbox" data-dir="select-all"> 全选</label>
            <span class="dir-selcount" data-dir-selcount>已选 0 篇</span>
            <select class="dir-select" data-dir="mode" title="分析口径">
              <option value="both">空白 + 方向</option>
              <option value="gap">只找空白</option>
              <option value="direction">只给方向</option>
            </select>
            <div id="dirModelRow" class="ai-model-row dir-model-row"></div>
            <button class="btn btn-primary dir-run" data-dir="analyze">开始分析</button>
          </div>
          <div class="dir-banner hidden" data-dir-banner></div>
          <div class="dir-pane" data-dirpane="papers"></div>
          <div class="dir-pane hidden" data-dirpane="report"></div>
        </main>
      </div>`;
  }

  // ==================== 事件 ====================

  function bind() {
    S.container.addEventListener('click', onClick);
    S.container.addEventListener('change', onChange);
    S.container.addEventListener('input', onInput);
    S.container.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target?.matches?.('.dir-topic-kw') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSearch(); }
    });
  }

  function onClick(event) {
    const tab = event.target.closest('[data-dirtab]');
    // 切页签必须重绘：report 面板平时是空的（只有 class，没有内容），
    // 只切 class 会得到一块高度为 0 的「不可见」区域。
    if (tab) { S.tab = tab.dataset.dirtab; renderPane(); return; }

    const action = event.target.closest('[data-dir]');
    if (action) {
      const name = action.dataset.dir;
      if (name === 'add-topic') { addTopic(); return; }
      if (name === 'del-topic') { removeTopic(action.closest('[data-topic-id]')?.dataset.topicId); return; }
      if (name === 'search') { doSearch(); return; }
      if (name === 'analyze') { doAnalyze(); return; }
      if (name === 'select-all') { return; } // checkbox 由 change 处理
      if (name === 'jump-baidu' || name === 'jump-xmol') { jump(name === 'jump-baidu' ? 'baidu' : 'xmol'); return; }
      if (name === 'clear-selection') { S.selection.clear(); renderPapers(); return; }
      if (name === 'sample') { applySample(action.dataset.sample); return; }
      if (name === 'export-md') { exportMarkdown(); return; }
      if (name === 'copy-md') { copyMarkdown(); return; }
      if (name === 'open-paper') { focusPaper(Number(action.dataset.index)); return; }
      if (name === 'switch-report') { S.reportId = action.dataset.recordId || ''; S.tab = 'report'; render(); return; }
      if (name === 'new-search') { S.session = null; S.selection.clear(); S.tab = 'papers'; render(); return; }
      return;
    }

    const paper = event.target.closest('[data-paper-id]');
    if (paper) {
      const box = paper.querySelector('input[type="checkbox"]');
      // 点摘要「展开」与点外链不该顺手切换勾选
      if (event.target.closest('a, .dir-abs-toggle')) return;
      if (box && event.target !== box) {
        box.checked = !box.checked;
        togglePaper(paper.dataset.paperId, box.checked);
        return;
      }
    }
  }

  function onChange(event) {
    const target = event.target;
    if (target.matches('[data-dir="history"]')) {
      const id = target.value;
      if (id) loadSession(id);
      return;
    }
    if (target.matches('[data-dir="select-all"]')) {
      const ids = visiblePapers().map((p) => p.id);
      ids.forEach((id) => (target.checked ? S.selection.add(id) : S.selection.delete(id)));
      renderPapers();
      saveSelection();
      return;
    }
    if (target.matches('[data-paper-id] input[type="checkbox"]')) {
      togglePaper(target.closest('[data-paper-id]').dataset.paperId, target.checked);
      return;
    }
    if (target.matches('[data-dir="mode"]')) {
      S.mode = target.value;
      return;
    }
    const filter = target.dataset.filter;
    if (filter) {
      const numeric = ['yearFrom', 'yearTo', 'minCitations', 'perTopic'].includes(filter);
      S.filters[filter] = target.type === 'checkbox' ? target.checked : (numeric ? Number(target.value || 0) : target.value);
    }
    const topicField = target.dataset.topicField;
    if (topicField) {
      const topic = S.topics.find((t) => t.id === target.closest('[data-topic-id]')?.dataset.topicId);
      if (topic) topic.field = target.value;
    }
  }

  function onInput(event) {
    const target = event.target;
    const topicId = target.closest('[data-topic-id]')?.dataset.topicId;
    if (topicId && (target.matches('[data-topic-name]') || target.matches('[data-topic-kw]') || target.matches('[data-topic-exclude]'))) {
      const topic = S.topics.find((t) => t.id === topicId);
      if (!topic) return;
      if (target.matches('[data-topic-name]')) topic.name = target.value;
      if (target.matches('[data-topic-kw]')) topic.keywords = target.value;
      if (target.matches('[data-topic-exclude]')) topic.exclude = target.value;
    }
  }

  // ==================== 数据 ====================

  async function refresh() {
    try {
      const data = await api('/api/direction');
      S.meta = data.meta;
      S.sessions = data.sessions || [];
      const active = data.activeSessionId;
      if (!S.session && active) {
        await loadSession(active, { silent: true });
        return;
      }
      render();
    } catch (error) {
      S.error = error.message;
      render();
    }
  }

  async function loadSession(id, { silent = false } = {}) {
    try {
      const data = await api(`/api/direction/session/${encodeURIComponent(id)}`);
      S.session = data.session;
      S.meta = data.meta || S.meta;
      S.topics = (data.session.topics || []).map((t, i) => ({ id: t.id || `t${i + 1}`, name: t.name || `主题 ${i + 1}`, keywords: t.keywords || '', exclude: t.exclude || '', field: t.field || 'default' }));
      if (!S.topics.length) S.topics = [blankTopic()];
      S.filters = { ...DEFAULT_FILTERS, ...(data.session.filters || {}) };
      S.selection = new Set(data.session.selected || []);
      S.reportId = data.session.analyses?.[0]?.id || '';
      S.expanded.clear();
      S.error = '';
      render();
    } catch (error) {
      if (!silent) toast(error.message, 'error');
      S.session = null;
      S.topics = S.topics.length ? S.topics : [blankTopic()];
      render();
    }
  }

  function blankTopic() {
    const n = S.topics.length + 1;
    return { id: `t${Date.now().toString(36)}${n}`, name: `主题 ${n}`, keywords: '', exclude: '', field: 'default' };
  }

  function addTopic() {
    if (S.topics.length >= (S.meta?.limits?.maxTopics || 6)) { toast(`最多 ${S.meta?.limits?.maxTopics || 6} 个主题`, 'error'); return; }
    S.topics = [...S.topics, blankTopic()];
    renderTopics();
  }

  function removeTopic(id) {
    if (!id) return;
    if (S.topics.length <= 1) { toast('至少保留一个主题', 'error'); return; }
    S.topics = S.topics.filter((t) => t.id !== id);
    renderTopics();
  }

  function currentTopics() {
    return S.topics
      .map((t) => ({ ...t, keywords: String(t.keywords || '').trim() }))
      .filter((t) => t.keywords);
  }

  const visiblePapers = () => (S.session?.papers || []);

  // ==================== 渲染 ====================

  function render() {
    if (!S.root) return;
    renderTopics();
    renderFilters();
    renderHistory();
    renderLinks();
    renderHead();
    renderPane();
  }

  function renderTopics() {
    const box = $('[data-dir-topics]');
    if (!box) return;
    box.innerHTML = S.topics.map((topic, index) => `
      <div class="dir-topic" data-topic-id="${esc(topic.id)}">
        <div class="dir-topic-head">
          <input class="dir-topic-name" data-topic-name value="${esc(topic.name || `主题 ${index + 1}`)}" maxlength="40" title="主题名称（只影响显示）">
          ${S.topics.length > 1 ? '<button class="dir-topic-del" data-dir="del-topic" title="删除这个主题">×</button>' : ''}
        </div>
        <textarea class="dir-topic-kw" data-topic-kw rows="2" placeholder="关键词：多个词用逗号分隔 = 必须同时包含，如 large language model, recommendation">${esc(topic.keywords)}</textarea>
        <div class="dir-topic-row">
          <select class="dir-select" data-topic-field title="在哪些字段里检索">
            ${(S.meta?.fields || [{ id: 'default', label: '全部字段' }]).map((f) => `<option value="${esc(f.id)}"${topic.field === f.id ? ' selected' : ''}>${esc(f.label)}</option>`).join('')}
          </select>
          <input class="dir-topic-ex" data-topic-exclude value="${esc(topic.exclude || '')}" placeholder="排除词（可留空）" title="标题或摘要里出现这些词就丢弃；多个用逗号分隔">
        </div>
      </div>`).join('');
  }

  function renderFilters() {
    const f = S.filters;
    const set = (sel, value) => { const box = $(sel); if (box) box.value = value; };
    set('[data-filter="yearFrom"]', f.yearFrom || '');
    set('[data-filter="yearTo"]', f.yearTo || '');
    set('[data-filter="minCitations"]', f.minCitations || '');
    set('[data-filter="type"]', f.type || '');
    set('[data-filter="language"]', f.language || '');
    set('[data-filter="sort"]', f.sort || 'relevance');
    set('[data-filter="perTopic"]', f.perTopic || 30);
    const only = $('[data-filter="onlyWithAbstract"]'); if (only) only.checked = f.onlyWithAbstract !== false;
    const retracted = $('[data-filter="includeRetracted"]'); if (retracted) retracted.checked = Boolean(f.includeRetracted);
    const mode = $('[data-dir="mode"]'); if (mode) mode.value = S.mode || 'both';
  }

  function renderHistory() {
    const box = $('[data-dir="history"]');
    if (!box) return;
    const options = S.sessions.map((s) => `<option value="${esc(s.id)}"${S.session?.id === s.id ? ' selected' : ''}>${esc(s.title)}（${s.paperCount} 篇${s.hasAnalysis ? ' · 有报告' : ''}）</option>`);
    box.innerHTML = `<option value="">历史检索（${S.sessions.length}）</option>${options.join('')}`;
  }

  function renderLinks() {
    const topics = currentTopics();
    const keywords = topics.flatMap((t) => String(t.keywords).split(/[,;，；\n]+/)).map((s) => s.trim()).filter(Boolean).slice(0, 3).join(' ');
    S.linkQuery = keywords;
  }

  function jump(which) {
    const q = S.linkQuery;
    if (!q) { toast('先在上面填一个主题关键词', 'error'); return; }
    const url = which === 'baidu'
      ? `https://xueshu.baidu.com/s?wd=${encodeURIComponent(q)}`
      : `https://www.x-mol.com/paper/search/q?option=${encodeURIComponent(q)}`;
    window.open(url, '_blank', 'noopener');
  }

  function renderHead() {
    const count = visiblePapers().length;
    const countBox = $('[data-dir-count]');
    if (countBox) countBox.textContent = String(count);
    const sel = $('[data-dir-selcount]');
    if (sel) sel.textContent = `已选 ${S.selection.size} 篇`;
    const all = $('[data-dir="select-all"]');
    if (all) {
      const ids = visiblePapers().map((p) => p.id);
      const checked = ids.length > 0 && ids.every((id) => S.selection.has(id));
      all.checked = checked;
      all.indeterminate = !checked && ids.some((id) => S.selection.has(id));
    }
    const run = $('[data-dir="analyze"]');
    if (run) {
      const running = S.job?.status === 'running';
      run.disabled = running || S.busy === 'search';
      run.textContent = running ? '分析中…' : '开始分析';
    }
    const searchBtn = $('[data-dir="search"]');
    if (searchBtn) {
      searchBtn.disabled = S.busy === 'search';
      searchBtn.textContent = S.busy === 'search' ? '检索中…' : '检索文献';
    }
    const modelRow = $('.dir-model-row');
    if (modelRow) modelRow.classList.toggle('hidden', false);
  }

  function setTab(tab) {
    S.tab = tab;
    $$('[data-dirtab]').forEach((btn) => btn.classList.toggle('active', btn.dataset.dirtab === tab));
    $$('[data-dirpane]').forEach((pane) => pane.classList.toggle('hidden', pane.dataset.dirpane !== tab));
  }

  function renderPane() {
    setTab(S.tab);
    if (S.tab === 'papers') renderPapers();
    else renderReport();
  }

  function banner(text, { tone = '', spin = false } = {}) {
    const box = $('[data-dir-banner]');
    if (!box) return;
    if (!text) { box.className = 'dir-banner hidden'; box.innerHTML = ''; return; }
    box.className = `dir-banner ${tone ? `is-${tone}` : ''}`;
    box.innerHTML = `${spin ? '<span class="dir-spinner" aria-hidden="true"></span>' : ''}<span>${esc(text)}</span>`;
  }

  function renderPapers() {
    const pane = $('[data-dirpane="papers"]');
    if (!pane) return;
    if (S.error) {
      pane.innerHTML = `<div class="dir-empty"><b>出错了</b><p>${esc(S.error)}</p></div>`;
      return;
    }
    const papers = visiblePapers();
    if (!papers.length) {
      pane.innerHTML = emptyState();
      return;
    }
    const stats = S.session?.stats || {};
    const perTopic = S.session?.perTopic || [];
    const failed = perTopic.filter((t) => t.error);
    pane.innerHTML = `
      <div class="dir-paper-head">
        <div>共 <b>${papers.length}</b> 篇候选${stats.totalHits ? `（各主题命中合计 ${Number(stats.totalHits).toLocaleString('zh-CN')} 篇）` : ''}${stats.duplicated ? `，合并去重 ${stats.duplicated} 篇` : ''}${stats.droppedByExclude ? `，按排除词过滤 ${stats.droppedByExclude} 篇` : ''}</div>
        ${S.selection.size ? `<button class="dir-link" data-dir="clear-selection">清空勾选</button>` : ''}
      </div>
      ${failed.length ? `<div class="dir-warn">${failed.map((t) => `${esc(t.topicName)}：${esc(t.error)}`).join('；')}</div>` : ''}
      <div class="dir-papers">${papers.map((p, i) => paperRow(p, i)).join('')}</div>`;
  }

  function paperRow(paper, index) {
    const checked = S.selection.has(paper.id);
    const open = S.expanded.has(paper.id);
    const url = safeUrl(paper.oaUrl || paper.url);
    const abstract = String(paper.abstract || '').trim();
    const tags = (paper.topics || []).slice(0, 2).map((t) => `<span class="dir-tag">${esc(t)}</span>`).join('');
    const meta = [
      paper.authorLine || '',
      paper.year || '',
      paper.venue || '',
      paper.citedBy ? `被引 ${paper.citedBy}` : '',
      paper.type === 'preprint' ? '预印本' : '',
      paper.language === 'zh' ? '中文' : '',
    ].filter(Boolean).map(esc).join(' · ');
    return `
      <div class="dir-paper${checked ? ' is-checked' : ''}${open ? ' is-open' : ''}" data-paper-id="${esc(paper.id)}">
        <label class="dir-check"><input type="checkbox"${checked ? ' checked' : ''} aria-label="选择这篇文献"></label>
        <div class="dir-paper-body">
          <div class="dir-paper-title">${esc(paper.title)}${url ? ` <a href="${esc(url)}" target="_blank" rel="noopener">原文 ↗</a>` : ''}</div>
          <div class="dir-paper-meta">${esc(String(index + 1)).padStart(2, '0')} · ${meta || '元数据不全'}${tags ? ` ${tags}` : ''}</div>
          ${abstract
            ? `<div class="dir-paper-abs" data-abs>
                 <span class="dir-abs-text">${esc(abstract.slice(0, open ? 1400 : 180))}${!open && abstract.length > 180 ? '…' : ''}</span>
                 ${abstract.length > 180 ? `<button class="dir-abs-toggle" data-dir="toggle-abs">${open ? '收起' : '展开摘要'}</button>` : ''}
               </div>`
            : '<div class="dir-paper-abs is-missing">公开元数据没有摘要，这一篇交给模型时只能按标题判断</div>'}
        </div>
      </div>`;
  }

  function emptyState() {
    const samples = ['large language model, reasoning', 'graph neural network, recommendation', 'federated learning, privacy', '生成式对抗网络'];
    return `
      <div class="dir-empty">
        <b>先填检索条件，再点左上角「检索文献」</b>
        <ol class="dir-steps">
          <li>写 1~6 个主题；同一个主题里的词用逗号分隔 = 必须同时出现（AND），多个主题 = 分别检索后合并去重。</li>
          <li>结果按主题轮转排列，勾选你要拿去做分析的那几篇（建议 8~30 篇，太少看不出空白）。</li>
          <li>点「开始分析」，模型会按摘要找出研究空白并给出可执行的研究方向。</li>
        </ol>
        <div class="dir-samples">
          <span>试试：</span>
          ${samples.map((s) => `<button class="dir-sample" data-dir="sample" data-sample="${esc(s)}">${esc(s)}</button>`).join('')}
        </div>
      </div>`;
  }

  function applySample(text) {
    if (!S.topics.length) S.topics = [blankTopic()];
    S.topics[0].keywords = text;
    S.topics[0].name = text.split(',')[0];
    renderTopics();
  }

  function renderReport() {
    const pane = $('[data-dirpane="report"]');
    if (!pane) return;
    const analyses = S.session?.analyses || [];
    const record = analyses.find((r) => r.id === S.reportId) || analyses[0] || null;
    const live = S.job?.status === 'running' ? null : S.job?.analysis;
    const active = record || (live ? { analysis: live, mode: S.job.mode, createdAt: new Date().toISOString(), model: S.job.model, paperCount: S.job.paperCount, paperIds: S.job.paperIds } : null);

    if (!active) {
      pane.innerHTML = `
        <div class="dir-empty">
          <b>还没有分析报告</b>
          <p>在「候选文献」里勾选若干篇，点右上角「开始分析」。模型会读这些文献的摘要，产出：研究空白（哪一步没人做、差在哪）+ 研究方向（研究问题、技术路线、数据、预期贡献、风险）。</p>
          ${analyses.length ? '<p class="dir-muted">历史报告：' + analyses.map((r) => `<button class="dir-link" data-dir="switch-report" data-record-id="${esc(r.id)}">${esc(new Date(r.createdAt).toLocaleString('zh-CN'))}</button>`).join('　') + '</p>' : ''}
        </div>`;
      return;
    }

    const a = active.analysis || {};
    const order = active.paperIds || [];
    const paperAt = (n) => S.session?.papers.find((p) => p.id === order[n - 1]) || null;
    const evidence = (list) => (list || []).map((n) => {
      const p = paperAt(n);
      return `<button class="dir-ev" data-dir="open-paper" data-index="${n}" title="${esc(p ? p.title : '文献已不在候选列表')}">${n}</button>`;
    }).join('');

    const gaps = (a.gaps || []).map((gap, i) => `
      <article class="dir-card dir-gap">
        <header><span class="dir-no">G${i + 1}</span><h4>${esc(gap.title)}</h4><span class="dir-conf is-${esc(gap.confidence)}">${gap.confidence === 'high' ? '较可靠' : gap.confidence === 'low' ? '待验证' : '中等'}</span></header>
        ${gap.statement ? `<p>${esc(gap.statement)}</p>` : ''}
        ${gap.why ? `<p class="dir-why"><b>为什么仍是空白</b>${esc(gap.why)}</p>` : ''}
        ${gap.evidence.length ? `<div class="dir-evrow">依据 ${evidence(gap.evidence)}</div>` : ''}
      </article>`).join('');

    const directions = (a.directions || []).map((d, i) => `
      <article class="dir-card dir-dir">
        <header><span class="dir-no">D${i + 1}</span><h4>${esc(d.title)}</h4><span class="dir-diff">难度 ${esc(d.difficulty)}</span></header>
        ${d.question ? `<p class="dir-q">${esc(d.question)}</p>` : ''}
        <dl class="dir-kv">
          ${d.approach ? `<dt>技术路线</dt><dd>${esc(d.approach)}</dd>` : ''}
          ${d.data ? `<dt>数据 / 条件</dt><dd>${esc(d.data)}</dd>` : ''}
          ${d.contribution ? `<dt>预期贡献</dt><dd>${esc(d.contribution)}</dd>` : ''}
          ${d.novelty ? `<dt>新在哪里</dt><dd>${esc(d.novelty)}</dd>` : ''}
          ${d.risks ? `<dt>风险</dt><dd>${esc(d.risks)}</dd>` : ''}
        </dl>
        ${d.evidence.length ? `<div class="dir-evrow">依据 ${evidence(d.evidence)}</div>` : ''}
      </article>`).join('');

    const clusters = (a.clusters || []).length ? `
      <section class="dir-block">
        <h3>主题簇</h3>
        <div class="dir-clusters">${a.clusters.map((c) => `
          <div class="dir-cluster"><b>${esc(c.name)}</b><span>${esc(c.summary || '')}</span>${c.papers.length ? `<em>文献 ${c.papers.join('、')}</em>` : ''}</div>`).join('')}
        </div>
      </section>` : '';

    const reading = (a.readingOrder || []).length ? `
      <section class="dir-block">
        <h3>建议阅读顺序</h3>
        <ol class="dir-reading">${a.readingOrder.map((r) => {
          const p = paperAt(r.index);
          return `<li><button class="dir-link" data-dir="open-paper" data-index="${r.index}">${esc(p ? p.title : `文献 ${r.index}`)}</button>${r.reason ? ` —— ${esc(r.reason)}` : ''}</li>`;
        }).join('')}</ol>
      </section>` : '';

    const cautions = (a.cautions || []).length ? `
      <section class="dir-block">
        <h3>使用边界</h3>
        <ul class="dir-cautions">${a.cautions.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
      </section>` : '';

    const history = analyses.length > 1 ? `
      <div class="dir-report-history">
        <span>历史报告：</span>
        ${analyses.map((r) => `<button class="dir-link${r.id === active.id ? ' is-active' : ''}" data-dir="switch-report" data-record-id="${esc(r.id)}">${esc(new Date(r.createdAt).toLocaleString('zh-CN'))} · ${r.paperCount} 篇</button>`).join('')}
      </div>` : '';

    pane.innerHTML = `
      <div class="dir-report tools">
        <div class="dir-report-meta">
          ${esc((active.mode === 'gap' ? '只找空白' : active.mode === 'direction' ? '只给方向' : '空白 + 方向'))}
          · ${active.paperCount || order.length} 篇 · ${esc(active.model || '模型未记录')}
          · ${esc(new Date(active.createdAt).toLocaleString('zh-CN'))}
        </div>
        <div class="dir-report-actions">
          <button class="btn btn-sm" data-dir="copy-md">复制 Markdown</button>
          <button class="btn btn-sm" data-dir="export-md">存进 Markdown 笔记</button>
        </div>
      </div>
      ${history}
      ${a.overview ? `<section class="dir-block dir-overview"><h3>这批文献在做什么</h3><p>${esc(a.overview)}</p></section>` : ''}
      ${gaps ? `<section class="dir-block"><h3>研究空白 <span class="dir-n">${(a.gaps || []).length}</span></h3><div class="dir-cards">${gaps}</div></section>` : ''}
      ${directions ? `<section class="dir-block"><h3>研究方向 <span class="dir-n">${(a.directions || []).length}</span></h3><div class="dir-cards">${directions}</div></section>` : ''}
      ${clusters}${reading}${cautions}
      <p class="dir-foot">本报告只依据所选文献的摘要生成，未阅读全文；引用前请核对原文，尤其是涉及具体数字与结论的部分。</p>`;
  }

  // ==================== 交互动作 ====================

  function togglePaper(id, checked) {
    if (!id) return;
    if (checked) S.selection.add(id); else S.selection.delete(id);
    const row = S.root.querySelector(`[data-paper-id="${CSS.escape(id)}"]`);
    if (row) row.classList.toggle('is-checked', checked);
    renderHead();
    saveSelection();
  }

  function saveSelection() {
    const id = S.session?.id;
    if (!id) return;
    const payload = { selected: [...S.selection] };
    api(`/api/direction/session/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload }).catch(() => {});
  }

  function toggleAbstract(id) {
    if (S.expanded.has(id)) S.expanded.delete(id); else S.expanded.add(id);
    const paper = visiblePapers().find((p) => p.id === id);
    const row = S.root.querySelector(`[data-paper-id="${CSS.escape(id)}"]`);
    if (!row || !paper) return;
    const open = S.expanded.has(id);
    row.classList.toggle('is-open', open);
    const text = row.querySelector('.dir-abs-text');
    if (text) text.textContent = `${String(paper.abstract || '').slice(0, open ? 1400 : 180)}${!open && String(paper.abstract || '').length > 180 ? '…' : ''}`;
    const btn = row.querySelector('.dir-abs-toggle');
    if (btn) btn.textContent = open ? '收起' : '展开摘要';
  }

  // 展开摘要走委托（paperRow 里的按钮没有独立 handler）
  document.addEventListener('click', (event) => {
    if (!S.mounted) return;
    if (!event.target.closest('.dir-abs-toggle')) return;
    const row = event.target.closest('[data-paper-id]');
    if (row) { event.stopPropagation(); toggleAbstract(row.dataset.paperId); }
  }, true);

  async function doSearch() {
    const topics = currentTopics();
    if (!topics.length) { toast('请先填一个主题关键词', 'error'); $('[data-topic-kw]')?.focus(); return; }
    S.busy = 'search';
    banner('正在检索…（每个主题一次请求，命中多时最多翻两页）', { spin: true });
    renderHead();
    try {
      // 已经在看某次检索时，重新检索覆盖这一次；否则新建
      const data = await api('/api/direction/search', {
        method: 'POST',
        body: { sessionId: S.session?.id || '', topics, filters: S.filters },
      });
      S.session = data.session;
      S.meta = data.meta || S.meta;
      S.topics = (data.session.topics || []).map((t, i) => ({ id: t.id || `t${i + 1}`, name: t.name || `主题 ${i + 1}`, keywords: t.keywords || '', exclude: t.exclude || '', field: t.field || 'default' }));
      S.filters = { ...DEFAULT_FILTERS, ...(data.session.filters || {}) };
      // 重新检索后默认全选前 12 篇：用户通常就是想「先看看这批」的空白
      const keep = new Set((data.session.selected || []).filter((id) => (data.session.papers || []).some((p) => p.id === id)));
      S.selection = keep.size ? keep : new Set((data.session.papers || []).slice(0, 12).map((p) => p.id));
      S.reportId = data.session.analyses?.[0]?.id || '';
      S.tab = 'papers';
      S.error = '';
      await loadSessions();
      render();
      if (data.empty) banner(data.hint || '没有命中', { tone: 'warn' });
      else banner(`检索完成：${data.session.papers.length} 篇候选`, { tone: 'ok' });
      if (!keep.size && S.selection.size) saveSelection();
      setTimeout(() => { if (S.job?.status !== 'running') banner(''); }, 4000);
    } catch (error) {
      S.error = '';
      banner(error.message, { tone: 'error' });
    } finally {
      S.busy = '';
      renderHead();
    }
  }

  async function loadSessions() {
    try {
      const data = await api('/api/direction');
      S.sessions = data.sessions || [];
      renderHistory();
    } catch { /* 历史加载失败不影响主流程 */ }
  }

  async function doAnalyze() {
    if (!S.session) { toast('先检索一次，再选文献分析', 'error'); return; }
    if (!S.selection.size) { toast('请先勾选至少 1 篇文献', 'error'); S.tab = 'papers'; renderPane(); return; }
    const profileId = window.Worlex?.readModelPick?.('direction') || localStorage.getItem('aiModel:direction') || '';    S.busy = 'analyze';
    renderHead();
    banner('正在提交分析任务…', { spin: true });
    try {
      const data = await api('/api/direction/analyze', {
        method: 'POST',
        body: {
          sessionId: S.session.id,
          paperIds: [...S.selection],
          mode: $('[data-dir="mode"]')?.value || 'both',
          profileId,
        },
      });
      S.job = { id: data.jobId, status: 'running', chars: 0, analysis: null, paperIds: [...S.selection], mode: data.mode, model: data.model, paperCount: data.paperCount };
      startPoll(data.jobId);
    } catch (error) {
      S.busy = '';
      banner(error.message, { tone: 'error' });
      renderHead();
    }
  }

  function startPoll(jobId) {
    stopPoll();
    S.pollStartedAt = Date.now();
    const tick = async () => {
      try {
        const job = await api(`/api/direction/job/${encodeURIComponent(jobId)}`);
        S.job = { ...S.job, ...job };
        if (job.status === 'running') {
          const secs = Math.round((Date.now() - S.pollStartedAt) / 1000);
          banner(`模型正在读摘要并组织结论…已生成 ${job.chars} 字 / ${secs}s${job.paperCount ? `（${job.paperCount} 篇）` : ''}`, { spin: true });
          renderHead();
          S.pollTimer = setTimeout(tick, 1500);
          return;
        }
        stopPoll();
        S.busy = '';
        if (job.status === 'done' && job.analysis) {
          banner('分析完成', { tone: 'ok' });
          // 报告已由后端落库，重新拉一次会话拿到 recordId 与历史列表
          await loadSession(S.session.id, { silent: true });
          S.tab = 'report';
          render();
          setTimeout(() => banner(''), 3000);
        } else {
          banner(job.error || '分析失败，请重试', { tone: 'error' });
          renderHead();
        }
      } catch (error) {
        stopPoll();
        S.busy = '';
        banner(error.message, { tone: 'error' });
        renderHead();
      }
    };
    tick();
  }

  function stopPoll() {
    if (S.pollTimer) { clearTimeout(S.pollTimer); S.pollTimer = null; }
  }

  function currentRecordId() {
    return S.session?.analyses?.find((r) => r.id === S.reportId)?.id || S.session?.analyses?.[0]?.id || '';
  }

  async function exportMarkdown() {
    if (!S.session) return;
    try {
      const data = await api('/api/direction/export-markdown', {
        method: 'POST',
        body: { sessionId: S.session.id, recordId: currentRecordId() },
      });
      toast(`已存进 Markdown 笔记：${data.title}`, 'ok');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function copyMarkdown() {
    if (!S.session) return;
    try {
      const data = await api(`/api/direction/markdown/${encodeURIComponent(S.session.id)}?recordId=${encodeURIComponent(currentRecordId())}`);
      await navigator.clipboard.writeText(data.markdown || '');
      toast('报告已复制为 Markdown', 'ok');
    } catch (error) {
      toast(`复制失败：${error.message}`, 'error');
    }
  }

  function focusPaper(index) {
    S.tab = 'papers';
    render();
    const id = (S.session?.analyses?.find((r) => r.id === S.reportId)?.paperIds || S.job?.paperIds || [])[index - 1];
    if (!id) { toast(`文献 ${index} 已不在候选列表里`, 'error'); return; }
    const row = S.root.querySelector(`[data-paper-id="${CSS.escape(id)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.classList.add('is-flash');
    S.selection.add(id);
    row.classList.add('is-checked');
    const box = row.querySelector('input[type="checkbox"]');
    if (box) box.checked = true;
    renderHead();
    setTimeout(() => row.classList.remove('is-flash'), 1400);
  }

  window.DirectionView = { mount, close };
})();
