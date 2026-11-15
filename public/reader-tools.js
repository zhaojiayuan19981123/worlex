/**
 * 阅读器工具条：框选表格（几何聚类还原）/ 框选问 AI / 全文查找。
 * 仅依赖 window.Worlex 全局桥，所有成员都做存在性判断，缺失时优雅降级。
 * 对外导出 init() / repaintHits(wrap, pageNum) / destroy()，不改写任何既有模块。
 */
(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const FIND_DEBOUNCE = 200;
  const MIN_BOX = 6;
  const MAX_HITS = 2000;

  const HINT_TEXT = {
    table: '拖出一个框，框住整张表格（含表头）。Esc 取消',
    ai: '拖出一个框，框住任意内容，直接送进 AI',
  };
  const ICON = {
    table: 'M2 3.5h12v9H2z M2 6.5h12 M2 9.5h12 M6 3.5v9 M10 3.5v9',
    ai: 'M8 2l1.25 3.45L12.7 6.7 9.25 7.95 8 11.4 6.75 7.95 3.3 6.7l3.45-1.25z M12.6 10.4l.5 1.35 1.35.5-1.35.5-.5 1.35-.5-1.35-1.35-.5 1.35-.5z',
    prev: 'M10 3.5L5.5 8l4.5 4.5',
    next: 'M6 3.5L10.5 8 6 12.5',
  };

  // 全部运行期状态集中管理，destroy() 一次性复位。
  const S = {
    initialized: false,
    ownStrip: false,
    strip: null,
    root: null,
    hint: null,
    hintTimer: 0,
    mode: null,             // null | 'table' | 'ai'
    marquee: null,
    activeWrap: null,
    start: null,
    end: null,
    pointerId: null,
    dragHandlers: [],       // 拖框模式的临时监听
    cleanup: [],            // init() 挂的常驻监听
    modal: null,
    modalCleanup: [],
    lastFocus: null,
    grid: [],
    headRows: 1,
    pageNum: 0,
    preview: '',
    query: '',
    hits: [],
    cur: -1,
    cacheDoc: null,
    cachePages: [],
    seq: 0,
    debounce: 0,
    findEls: {},
  };

  /* ------------------------------------------------------------------
   * 通用小工具
   * ------------------------------------------------------------------ */

  function bridge(name) {
    const w = typeof window !== 'undefined' ? window.Worlex : null;
    if (!w || typeof w[name] !== 'function') return null;
    return (...args) => {
      try { return w[name](...args); } catch (_) { return undefined; }
    };
  }

  function call(name, ...args) {
    const fn = bridge(name);
    return fn ? fn(...args) : undefined;
  }

  /** 优先走 Worlex.toast；桥缺失时退化成短暂的提示条，保证不静默。 */
  function notify(msg, kind) {
    const fn = bridge('toast');
    if (fn) { fn(msg, kind); return; }
    if (!S.hint) return;
    S.hint.textContent = String(msg || '');
    S.hint.classList.add('is-visible');
    clearTimeout(S.hintTimer);
    S.hintTimer = setTimeout(() => {
      S.hintTimer = 0;
      if (!S.mode && S.hint) {
        S.hint.classList.remove('is-visible');
        S.hint.textContent = '';
      }
    }, 2600);
  }

  function docTitle() {
    const el = document.getElementById('prFilename');
    const t = el && el.textContent ? el.textContent.trim() : '';
    if (t) return t;
    const dt = typeof document !== 'undefined' && document.title ? document.title.trim() : '';
    return dt || '当前文献';
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function svgIcon(d) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.4');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
    return svg;
  }

  function clampNum(v, lo, hi) {
    const n = Number(v);
    return Math.max(lo, Math.min(hi, isFinite(n) ? n : 0));
  }

  function bind(target, type, fn) {
    if (!target) return;
    target.addEventListener(type, fn);
    S.cleanup.push(() => target.removeEventListener(type, fn));
  }

  /* ------------------------------------------------------------------
   * init / destroy
   * ------------------------------------------------------------------ */

  function init() {
    if (S.initialized) return;
    if (typeof document === 'undefined' || !document.body) return;

    let strip = document.getElementById('prToolStrip');
    if (!strip) {
      // 容器没预先放好时，退化为挂到阅读器工具条上，仍然可用。
      const bar = document.querySelector('.pr-toolbar');
      if (!bar) return;
      strip = el('div');
      strip.id = 'prToolStrip';
      bar.appendChild(strip);
      S.ownStrip = true;
    }
    S.strip = strip;
    S.initialized = true;

    const root = el('div', 'rt-root');
    S.root = root;
    strip.appendChild(root);

    const btnTable = el('button', 'rt-btn');
    btnTable.type = 'button';
    btnTable.dataset.rt = 'table';
    btnTable.setAttribute('aria-pressed', 'false');
    btnTable.setAttribute('title', '拖框圈住整张表格，提取成可编辑表格');
    btnTable.appendChild(svgIcon(ICON.table));
    btnTable.appendChild(el('span', '', '框选表格'));
    root.appendChild(btnTable);

    const btnAi = el('button', 'rt-btn');
    btnAi.type = 'button';
    btnAi.dataset.rt = 'ai';
    btnAi.setAttribute('aria-pressed', 'false');
    btnAi.setAttribute('title', '拖框圈住任意内容，直接送进 AI 助读');
    btnAi.appendChild(svgIcon(ICON.ai));
    btnAi.appendChild(el('span', '', '框选问 AI'));
    root.appendChild(btnAi);

    const find = el('div', 'rt-find');
    const input = el('input', 'rt-find-input');
    input.type = 'search';
    input.placeholder = '在文中查找';
    input.setAttribute('aria-label', '在文中查找');
    const prev = el('button', 'rt-find-nav');
    prev.type = 'button';
    prev.title = '上一个命中';
    prev.setAttribute('aria-label', '上一个命中');
    prev.appendChild(svgIcon(ICON.prev));
    const next = el('button', 'rt-find-nav');
    next.type = 'button';
    next.title = '下一个命中';
    next.setAttribute('aria-label', '下一个命中');
    next.appendChild(svgIcon(ICON.next));
    const count = el('span', 'rt-find-count', '0 / 0');
    count.setAttribute('aria-live', 'polite');
    find.append(input, prev, next, count);
    root.appendChild(find);

    const hint = el('div', 'rt-hint');
    hint.setAttribute('role', 'status');
    hint.setAttribute('aria-live', 'polite');
    document.body.appendChild(hint);
    S.hint = hint;

    S.findEls = { btnTable, btnAi, input, prev, next, count };
    bind(btnTable, 'click', () => activate('table'));
    bind(btnAi, 'click', () => activate('ai'));
    bind(input, 'input', onFindInput);
    bind(input, 'keydown', onFindKey);
    bind(prev, 'click', () => stepHit(-1));
    bind(next, 'click', () => stepHit(1));
  }

  function destroy() {
    deactivate();
    closeTableModal();
    clearTimeout(S.debounce);
    clearTimeout(S.hintTimer);
    for (let i = 0; i < S.cleanup.length; i++) {
      try { S.cleanup[i](); } catch (_) { /* 忽略清理异常 */ }
    }
    S.cleanup = [];
    clearAllFindLayers();
    if (S.root && S.root.parentNode) S.root.remove();
    if (S.hint && S.hint.parentNode) S.hint.remove();
    if (S.ownStrip && S.strip && S.strip.parentNode) S.strip.remove();
    S.root = null;
    S.hint = null;
    S.strip = null;
    S.ownStrip = false;
    S.initialized = false;
    S.hintTimer = 0;
    S.query = '';
    S.hits = [];
    S.cur = -1;
    S.cacheDoc = null;
    S.cachePages = [];
    S.seq += 1;
    S.findEls = {};
    S.grid = [];
  }

  /* ------------------------------------------------------------------
   * 拖框模式
   * ------------------------------------------------------------------ */

  function dragOn(target, type, fn) {
    if (!target) return;
    target.addEventListener(type, fn, true);
    S.dragHandlers.push(() => target.removeEventListener(type, fn, true));
  }

  function activate(mode) {
    if (!S.initialized) return;
    if (S.mode === mode) { deactivate(); return; }
    deactivate();
    S.mode = mode;
    document.body.classList.add('rt-selecting');
    if (S.hint) {
      S.hint.textContent = HINT_TEXT[mode] || '';
      S.hint.classList.add('is-visible');
    }
    const t = S.findEls.btnTable;
    const a = S.findEls.btnAi;
    if (t) {
      t.classList.toggle('active', mode === 'table');
      t.setAttribute('aria-pressed', mode === 'table' ? 'true' : 'false');
    }
    if (a) {
      a.classList.toggle('active', mode === 'ai');
      a.setAttribute('aria-pressed', mode === 'ai' ? 'true' : 'false');
    }
    dragOn(document, 'pointerdown', onPointerDown);
    dragOn(document, 'pointermove', onPointerMove);
    dragOn(document, 'pointerup', onPointerUp);
    dragOn(document, 'pointercancel', onPointerUp);
    dragOn(document, 'keydown', onDragKey);
  }

  function deactivate() {
    for (let i = 0; i < S.dragHandlers.length; i++) {
      try { S.dragHandlers[i](); } catch (_) { /* 忽略清理异常 */ }
    }
    S.dragHandlers = [];
    if (S.marquee && S.marquee.parentNode) S.marquee.remove();
    S.marquee = null;
    S.activeWrap = null;
    S.start = null;
    S.end = null;
    S.pointerId = null;
    S.mode = null;
    document.body.classList.remove('rt-selecting');
    const t = S.findEls.btnTable;
    const a = S.findEls.btnAi;
    if (t) { t.classList.remove('active'); t.setAttribute('aria-pressed', 'false'); }
    if (a) { a.classList.remove('active'); a.setAttribute('aria-pressed', 'false'); }
    if (S.hint && !S.hintTimer) {
      S.hint.classList.remove('is-visible');
      S.hint.textContent = '';
    }
  }

  /** 坐标一律相对目标 wrap 的 getBoundingClientRect()，并夹到页内。 */
  function pointIn(wrap, clientX, clientY) {
    const r = wrap.getBoundingClientRect();
    const w = wrap.clientWidth || r.width || 1;
    const h = wrap.clientHeight || r.height || 1;
    return { x: clampNum(clientX - r.left, 0, w), y: clampNum(clientY - r.top, 0, h) };
  }

  function paintMarquee() {
    if (!S.marquee || !S.start || !S.end) return;
    const x = Math.min(S.start.x, S.end.x);
    const y = Math.min(S.start.y, S.end.y);
    S.marquee.style.left = x + 'px';
    S.marquee.style.top = y + 'px';
    S.marquee.style.width = Math.abs(S.end.x - S.start.x) + 'px';
    S.marquee.style.height = Math.abs(S.end.y - S.start.y) + 'px';
  }

  function onPointerDown(e) {
    if (!S.mode) return;
    if (e.button != null && e.button !== 0) return;
    const target = e.target && e.target.nodeType === 1 ? e.target : null;
    const wrap = target && target.closest ? target.closest('.pr-page-wrap') : null;
    if (!wrap) return;
    e.preventDefault();
    S.activeWrap = wrap;
    S.pointerId = e.pointerId;
    S.start = pointIn(wrap, e.clientX, e.clientY);
    S.end = { x: S.start.x, y: S.start.y };
    S.marquee = el('div', 'rt-marquee');
    wrap.appendChild(S.marquee);
    paintMarquee();
  }

  function onPointerMove(e) {
    if (!S.mode || !S.activeWrap || !S.marquee) return;
    e.preventDefault();
    S.end = pointIn(S.activeWrap, e.clientX, e.clientY);
    paintMarquee();
  }

  function onPointerUp(e) {
    if (!S.mode || !S.activeWrap || !S.start) return;
    e.preventDefault();
    const wrap = S.activeWrap;
    const mode = S.mode;
    S.end = pointIn(wrap, e.clientX, e.clientY);
    const r = {
      x: Math.min(S.start.x, S.end.x),
      y: Math.min(S.start.y, S.end.y),
      w: Math.abs(S.end.x - S.start.x),
      h: Math.abs(S.end.y - S.start.y),
    };
    const pageNum = parseInt(wrap.dataset.page, 10) || 0;
    deactivate(); // 先移除全部临时监听与浮层，再进行后续处理
    if (e.type === 'pointercancel' || r.w < MIN_BOX || r.h < MIN_BOX) {
      notify('选框太小，已取消', 'info');
      return;
    }
    handleRegion(mode, wrap, pageNum, r);
  }

  function onDragKey(e) {
    if (e.key === 'Escape' && S.mode) {
      e.preventDefault();
      deactivate();
    }
  }

  function handleRegion(mode, wrap, pageNum, r) {
    const image = cropRegion(wrap, r);
    const items = collectItems(wrap, r);
    if (mode === 'ai') {
      const send = bridge('sendRegionToChat');
      if (!send) { notify('AI 助读通道不可用', 'error'); return; }
      send({ image, text: items.map((it) => it.text).join('\n'), page: pageNum, autoSend: true });
      return;
    }
    if (mode === 'table') openTableModal(buildGrid(items), pageNum, image);
  }

  /** 按 DPR 裁图：缩放因子 = canvas.width / wrap.clientWidth。 */
  function cropRegion(wrap, r) {
    try {
      const canvas = wrap.querySelector('canvas');
      if (!canvas || !canvas.width || !canvas.height) return '';
      const sx = canvas.width / (wrap.clientWidth || 1);
      const sy = canvas.height / (wrap.clientHeight || 1);
      const w = Math.max(1, Math.round(r.w * sx));
      const h = Math.max(1, Math.round(r.h * sy));
      const out = document.createElement('canvas');
      out.width = w;
      out.height = h;
      const ctx = out.getContext('2d');
      if (!ctx) return '';
      let bg = '#ffffff';
      try {
        const cs = window.getComputedStyle(wrap).backgroundColor;
        if (cs && cs !== 'transparent' && cs !== 'rgba(0, 0, 0, 0)') bg = cs;
      } catch (_) { /* 取不到就用白底 */ }
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(canvas, r.x * sx, r.y * sy, r.w * sx, r.h * sy, 0, 0, w, h);
      return out.toDataURL('image/jpeg', 0.9);
    } catch (_) {
      return '';
    }
  }

  /** 取与选框相交的文字项，位置用 getBoundingClientRect 相对 wrap，兼容旋转与对照精读。 */
  function collectItems(wrap, r) {
    const layer = wrap.querySelector('.pr-text-layer');
    if (!layer) return [];
    const wr = wrap.getBoundingClientRect();
    const out = [];
    const spans = layer.querySelectorAll('span');
    for (let i = 0; i < spans.length; i++) {
      const sr = spans[i].getBoundingClientRect();
      const l = sr.left - wr.left;
      const t = sr.top - wr.top;
      const rr = sr.right - wr.left;
      const bb = sr.bottom - wr.top;
      if (rr < r.x || l > r.x + r.w || bb < r.y || t > r.y + r.h) continue;
      const text = (spans[i].textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      out.push({
        text, x: l, right: rr, y: t, bottom: bb,
        w: rr - l, h: bb - t, cx: (l + rr) / 2, cy: (t + bb) / 2,
      });
    }
    return out;
  }

  /* ------------------------------------------------------------------
   * 表格几何聚类：先按 y 中心分行，再按 x 间隙切列
   * ------------------------------------------------------------------ */

  function buildGrid(items) {
    if (!items.length) return [['']];
    const heights = items.map((it) => it.h).filter((h) => h > 0).sort((a, b) => a - b);
    const medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 12;

    // 1) 行：y 中心容差 ≈ 0.6 × 中位字高
    const tol = Math.max(4, medianH * 0.6);
    const sorted = items.slice().sort((a, b) => a.cy - b.cy || a.x - b.x);
    const rows = [];
    for (let i = 0; i < sorted.length; i++) {
      const it = sorted[i];
      let row = rows.length ? rows[rows.length - 1] : null;
      if (!row || it.cy - row.cy > tol) {
        row = { cy: it.cy, items: [] };
        rows.push(row);
      }
      row.items.push(it);
      row.cy = row.items.reduce((sum, x) => sum + x.cy, 0) / row.items.length;
    }
    if (!rows.length) return fallbackGrid(items);

    // 2) 列：取行内显著 x 间隙的中点，全局聚类成列边界（最多 12 列）
    const gapThresh = Math.max(10, medianH * 1.5);
    const cuts = [];
    for (let i = 0; i < rows.length; i++) {
      const list = rows[i].items.slice().sort((a, b) => a.x - b.x);
      for (let j = 1; j < list.length; j++) {
        const gap = list[j].x - list[j - 1].right;
        if (gap > gapThresh) cuts.push({ at: (list[j - 1].right + list[j].x) / 2, gap });
      }
    }
    cuts.sort((a, b) => b.gap - a.gap);
    const top = cuts.slice(0, 11).sort((a, b) => a.at - b.at);
    const bt = Math.max(12, medianH * 2);
    const bounds = [];
    for (let i = 0; i < top.length; i++) {
      const c = top[i];
      const last = bounds.length ? bounds[bounds.length - 1] : null;
      if (last && c.at - last.at < bt) {
        bounds[bounds.length - 1] = { at: (last.at + c.at) / 2, gap: Math.max(last.gap, c.gap) };
      } else {
        bounds.push({ at: c.at, gap: c.gap });
      }
    }
    bounds.sort((a, b) => a.at - b.at);
    const cols = bounds.map((b) => b.at);

    // 3) 投影成二维网格
    const grid = rows.map((row) => {
      const cells = new Array(cols.length + 1).fill('');
      const list = row.items.slice().sort((a, b) => a.x - b.x);
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        let ci = 0;
        while (ci < cols.length && it.cx > cols[ci]) ci += 1;
        cells[ci] = cells[ci] ? cells[ci] + ' ' + it.text : it.text;
      }
      return cells;
    });
    if (!grid.length || grid.every((row) => row.every((c) => !c))) return fallbackGrid(items);
    return grid;
  }

  /** 几何聚类失败时的兜底：按文字项顺序拆成单列，不抛错。 */
  function fallbackGrid(items) {
    const lines = items.map((it) => [it.text]).filter((row) => row[0]);
    return lines.length ? lines : [['']];
  }

  /* ------------------------------------------------------------------
   * 「提取的表格」模态框
   * ------------------------------------------------------------------ */

  function actionBtn(text, cls, fn) {
    const b = el('button', cls, text);
    b.type = 'button';
    modalBind(b, 'click', fn);
    return b;
  }

  function modalBind(target, type, fn) {
    if (!target) return;
    target.addEventListener(type, fn);
    S.modalCleanup.push(() => target.removeEventListener(type, fn));
  }

  function openTableModal(grid, pageNum, image) {
    closeTableModal();
    S.grid = grid;
    S.pageNum = pageNum;
    S.preview = image || '';
    S.headRows = 1;
    S.lastFocus = document.activeElement;

    const backdrop = el('div', 'rt-modal-backdrop');
    backdrop.id = 'rtTableModal';
    const dialog = el('div', 'rt-modal');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'rtTableTitle');
    backdrop.appendChild(dialog);

    const head = el('div', 'rt-modal-head');
    const title = el('h3', '', '');
    title.id = 'rtTableTitle';
    const closeBtn = el('button', 'rt-modal-close', '关闭');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', '关闭提取的表格');
    head.append(title, closeBtn);
    dialog.appendChild(head);

    const body = el('div', 'rt-modal-body');
    const bar = el('div', 'rt-table-bar');
    const headLabel = el('label', 'rt-label', '表头行数');
    const headSel = el('select', 'rt-select');
    for (let i = 1; i <= 3; i += 1) {
      const op = el('option', '', String(i));
      op.value = String(i);
      headSel.appendChild(op);
    }
    headSel.value = '1';
    headLabel.appendChild(headSel);
    bar.appendChild(headLabel);
    bar.append(
      actionBtn('转置', 'rt-action', onTranspose),
      actionBtn('去掉空行空列', 'rt-action', onTrim),
      actionBtn('复制（粘贴到 Excel）', 'rt-action', onCopy),
      actionBtn('保存为 CSV', 'rt-action', onCsv),
      actionBtn('保存为 Excel', 'rt-action primary', onXls),
    );
    body.appendChild(bar);

    const fields = el('div', 'rt-caption-fields');
    const capLabel = el('label', 'rt-label', '表题');
    const capInput = el('input', 'rt-input');
    capInput.type = 'text';
    capInput.placeholder = '例如：表 1 描述性统计';
    capLabel.appendChild(capInput);
    const noteLabel = el('label', 'rt-label', '表注');
    const noteInput = el('input', 'rt-input');
    noteInput.type = 'text';
    noteInput.placeholder = '例如：*** p<0.01；数据来源：作者整理';
    noteLabel.appendChild(noteInput);
    fields.append(capLabel, noteLabel);
    body.appendChild(fields);

    if (S.preview) {
      body.appendChild(el('div', 'rt-preview-label', '框选区域预览'));
      const img = document.createElement('img');
      img.className = 'rt-preview';
      img.alt = '框选区域预览';
      img.src = S.preview; // dataURL，属性赋值不经过 HTML 解析
      body.appendChild(img);
    }

    const scroll = el('div', 'rt-grid-scroll');
    const table = el('table', 'rt-grid');
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    scroll.appendChild(table);
    body.appendChild(scroll);
    dialog.appendChild(body);
    document.body.appendChild(backdrop);

    S.modal = { backdrop, title, tbody, capInput, noteInput, headSel };
    renderGrid();
    syncTitle();

    modalBind(closeBtn, 'click', closeTableModal);
    modalBind(backdrop, 'pointerdown', (e) => { if (e.target === backdrop) closeTableModal(); });
    modalBind(document, 'keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeTableModal(); }
    });
    modalBind(headSel, 'change', () => {
      S.headRows = parseInt(headSel.value, 10) || 1;
      updateHeaderStyles();
    });
    closeBtn.focus();
  }

  function closeTableModal() {
    const stale = document.getElementById('rtTableModal');
    if (stale && (!S.modal || stale !== S.modal.backdrop)) stale.remove();
    for (let i = 0; i < S.modalCleanup.length; i++) {
      try { S.modalCleanup[i](); } catch (_) { /* 忽略清理异常 */ }
    }
    S.modalCleanup = [];
    if (S.modal && S.modal.backdrop && S.modal.backdrop.parentNode) S.modal.backdrop.remove();
    S.modal = null;
    if (S.lastFocus && S.lastFocus.focus) {
      try { S.lastFocus.focus(); } catch (_) { /* 元素可能已移除 */ }
    }
    S.lastFocus = null;
  }

  function renderGrid() {
    if (!S.modal) return;
    const tbody = S.modal.tbody;
    tbody.textContent = '';
    if (!S.grid.length) {
      const tr = document.createElement('tr');
      const td = el('td', '', '（未取到表格内容，可直接在此编辑）');
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    for (let r = 0; r < S.grid.length; r++) {
      const tr = document.createElement('tr');
      const row = Array.isArray(S.grid[r]) ? S.grid[r] : [S.grid[r]];
      for (let c = 0; c < row.length; c++) {
        const td = el('td', '', row[c] == null ? '' : String(row[c]));
        td.setAttribute('contenteditable', 'true');
        td.setAttribute('spellcheck', 'false');
        td.dataset.r = String(r);
        td.dataset.c = String(c);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    updateHeaderStyles();
  }

  /** 每次导出前从可编辑单元格读回，保证用户的修改不丢。 */
  function readGrid() {
    if (!S.modal) return S.grid;
    const out = [];
    const trs = S.modal.tbody.querySelectorAll('tr');
    for (let i = 0; i < trs.length; i++) {
      const cells = [];
      const tds = trs[i].querySelectorAll('td');
      for (let j = 0; j < tds.length; j++) {
        cells.push((tds[j].textContent || '').replace(/\u00a0/g, ' ').trim());
      }
      out.push(cells);
    }
    if (!out.length) return [['']];
    const n = Math.max.apply(null, out.map((row) => row.length));
    for (let i = 0; i < out.length; i++) while (out[i].length < n) out[i].push('');
    return out;
  }

  function updateHeaderStyles() {
    if (!S.modal) return;
    const trs = S.modal.tbody.querySelectorAll('tr');
    for (let i = 0; i < trs.length; i++) {
      const tds = trs[i].querySelectorAll('td');
      for (let j = 0; j < tds.length; j++) tds[j].classList.toggle('rt-head', i < S.headRows);
    }
  }

  function syncTitle() {
    if (!S.modal) return;
    let cols = 0;
    for (let i = 0; i < S.grid.length; i++) {
      cols = Math.max(cols, Array.isArray(S.grid[i]) ? S.grid[i].length : 1);
    }
    S.modal.title.textContent = docTitle() + ' · 第 ' + (S.pageNum || '?') + ' 页 · ' + S.grid.length + ' 行 × ' + cols + ' 列';
  }

  function onTranspose() {
    const g = readGrid();
    const out = [];
    for (let c = 0; c < g[0].length; c++) {
      const row = [];
      for (let r = 0; r < g.length; r++) row.push(g[r][c] == null ? '' : g[r][c]);
      out.push(row);
    }
    S.grid = out;
    renderGrid();
    syncTitle();
    notify('已转置表格', 'success');
  }

  function onTrim() {
    let g = readGrid().filter((row) => row.some((c) => String(c).trim() !== ''));
    if (!g.length) g = [['']];
    const keep = [];
    for (let c = 0; c < g[0].length; c++) {
      if (g.some((row) => String(row[c] || '').trim() !== '')) keep.push(c);
    }
    g = g.map((row) => keep.map((c) => (row[c] == null ? '' : row[c])));
    if (!g[0].length) g = [['']];
    S.grid = g;
    renderGrid();
    syncTitle();
    notify('已去掉空行空列', 'success');
  }

  async function onCopy() {
    const tsv = readGrid().map((row) => row.map(tsvCell).join('\t')).join('\n');
    const ok = await copyText(tsv);
    notify(ok ? '已复制为 TSV，可直接粘贴到 Excel' : '复制失败，请手动选中表格复制', ok ? 'success' : 'error');
  }

  function onCsv() {
    const csv = '\ufeff' + readGrid().map((row) => row.map(csvCell).join(',')).join('\r\n');
    download(csv, '表格_第' + (S.pageNum || 0) + '页.csv', 'text/csv;charset=utf-8');
    notify('已保存 CSV（含 BOM）', 'success');
  }

  function onXls() {
    const g = readGrid();
    const caption = S.modal ? (S.modal.capInput.value || '').trim() : '';
    const note = S.modal ? (S.modal.noteInput.value || '').trim() : '';
    const rows = [];
    if (caption) rows.push(xlsRow([caption]));
    for (let i = 0; i < g.length; i++) rows.push(xlsRow(g[i]));
    if (note) rows.push(xlsRow([note]));
    const name = xlsSheetName(caption || ('第' + (S.pageNum || 0) + '页表格'));
    const xml = '\ufeff<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<?mso-application progid="Excel.Sheet"?>\n'
      + '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" '
      + 'xmlns:o="urn:schemas-microsoft-com:office:office" '
      + 'xmlns:x="urn:schemas-microsoft-com:office:excel" '
      + 'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n'
      + '<Worksheet ss:Name="' + xmlEsc(name) + '">\n<Table>\n'
      + rows.join('\n') + '\n</Table>\n</Worksheet>\n</Workbook>\n';
    download(xml, '表格_第' + (S.pageNum || 0) + '页.xls', 'application/vnd.ms-excel;charset=utf-8');
    notify('已保存 Excel（.xls，可直接打开）', 'success');
  }

  function xlsRow(cells) {
    return '<Row>' + cells.map((c) => '<Cell><Data ss:Type="String">' + xmlEsc(c) + '</Data></Cell>').join('') + '</Row>';
  }

  function xlsSheetName(s) {
    return String(s).replace(/[\\/?*[\]:]/g, '_').slice(0, 31) || 'Sheet1';
  }

  function xmlEsc(v) {
    return String(v == null ? '' : v)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  function tsvCell(v) {
    return String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ');
  }

  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function download(content, filename, mime) {
    try {
      const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) { /* 忽略 */ } }, 2000);
    } catch (_) {
      notify('下载失败，请改用「复制」', 'error');
    }
  }

  async function copyText(text) {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { /* 退回 execCommand */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch (_) {
      return false;
    }
  }

  /* ------------------------------------------------------------------
   * 全文查找：结果按 pdfDoc 缓存，doc 变了自动失效
   * ------------------------------------------------------------------ */

  function onFindInput() {
    S.query = S.findEls.input ? S.findEls.input.value : '';
    clearTimeout(S.debounce);
    if (!S.query.trim()) {
      clearAllFindLayers();
      S.hits = [];
      S.cur = -1;
      updateCount();
      return;
    }
    S.debounce = setTimeout(runSearch, FIND_DEBOUNCE);
  }

  function onFindKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      stepHit(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (S.query && S.findEls.input) {
        S.findEls.input.value = '';
        onFindInput();
      }
    }
  }

  async function ensurePages() {
    const doc = call('pdfDoc');
    if (!doc || typeof doc.getPage !== 'function') return null;
    if (S.cacheDoc === doc && S.cachePages.length) return S.cachePages;
    const total = Number(doc.numPages) || 0;
    if (!total) return null;

    const seq = ++S.seq;
    const scale = Number(call('scale')) || 1;
    const pages = new Array(total);
    let next = 1;
    async function worker() {
      while (next <= total) {
        const p = next++;
        if (seq !== S.seq) return;
        const items = [];
        let height = 0;
        try {
          const page = await doc.getPage(p);
          const view = page && page.view;
          if (Array.isArray(view) && view.length >= 4) height = view[3] - view[1];
          const content = await page.getTextContent();
          const raw = content && Array.isArray(content.items) ? content.items : [];
          for (let i = 0; i < raw.length; i++) {
            const it = raw[i];
            if (!it || typeof it.str !== 'string' || !it.str) continue;
            items.push({
              str: it.str,
              transform: Array.isArray(it.transform) ? it.transform : null,
              width: Number(it.width) || 0,
            });
          }
        } catch (_) { /* 单页取不到文本就留空 */ }
        if (seq !== S.seq) return;
        pages[p - 1] = { text: items.map((it) => it.str).join(' '), items, height, scale };
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, total) }, worker));
    if (seq !== S.seq) return null;
    S.cacheDoc = doc;
    S.cachePages = pages;
    return pages;
  }

  /** 用 item.transform + scale 近似命中框（文字层未就绪时的兜底数据）。 */
  function approximateRect(entry, idx) {
    const items = entry && entry.items ? entry.items : [];
    let cursor = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const start = cursor;
      const end = cursor + it.str.length;
      cursor = end + 1; // 拼接时补的一个空格
      if (idx < start || idx >= end) continue;
      const t = it.transform;
      if (!t || t.length < 6) return null;
      const sc = entry.scale || 1;
      const fh = Math.hypot(Number(t[2]) || 0, Number(t[3]) || 0) || Math.abs(Number(t[0]) || 0) || 10;
      const w = (Number(it.width) || it.str.length * fh * 0.5) * sc;
      const h = fh * sc;
      const x = (Number(t[4]) || 0) * sc;
      const y = ((Number(entry.height) || 0) - (Number(t[5]) || 0) - fh) * sc;
      if (y < -h || y > (Number(entry.height) || 0) * sc + h) return null;
      return { x, y, w, h };
    }
    return null;
  }

  async function runSearch() {
    const q = S.query.trim().toLowerCase();
    if (!q) { clearAllFindLayers(); S.hits = []; S.cur = -1; updateCount(); return; }
    const pages = await ensurePages();
    if (q !== S.query.trim().toLowerCase()) return; // 输入已变，丢弃旧结果
    if (!pages) { S.hits = []; S.cur = -1; updateCount(); return; }

    const hits = [];
    for (let i = 0; i < pages.length; i++) {
      const entry = pages[i];
      if (!entry || !entry.text) continue;
      const lower = entry.text.toLowerCase();
      let from = 0;
      let idx = lower.indexOf(q, from);
      while (idx !== -1) {
        hits.push({
          page: i + 1,
          text: entry.text.slice(Math.max(0, idx - 24), idx + q.length + 24),
          rect: approximateRect(entry, idx),
          at: idx,
        });
        from = idx + Math.max(1, q.length);
        if (hits.length >= MAX_HITS) break;
        idx = lower.indexOf(q, from);
      }
      if (hits.length >= MAX_HITS) break;
    }
    S.hits = hits;
    S.cur = -1;
    updateCount();
    refreshAllHits();
  }

  function stepHit(delta) {
    const n = S.hits.length;
    if (!n) { notify('没有查找结果', 'info'); return; }
    S.cur = (S.cur + delta + n) % n;
    const go = bridge('gotoPage');
    if (go) go(S.hits[S.cur].page);
    updateCount();
    refreshAllHits();
  }

  function updateCount() {
    const c = S.findEls.count;
    if (!c) return;
    const n = S.hits.length;
    if (!n) c.textContent = S.query.trim() ? '无结果' : '0 / 0';
    else c.textContent = S.cur >= 0 ? (S.cur + 1) + ' / ' + n : '共 ' + n + ' 处';
  }

  function clearAllFindLayers() {
    if (typeof document === 'undefined') return;
    const layers = document.querySelectorAll('.rt-find-layer');
    for (let i = 0; i < layers.length; i++) layers[i].remove();
  }

  function refreshAllHits() {
    if (typeof document === 'undefined') return;
    const wraps = document.querySelectorAll('.pr-page-wrap');
    for (let i = 0; i < wraps.length; i++) {
      repaintHits(wraps[i], parseInt(wraps[i].dataset.page, 10));
    }
  }

  /** 由 app.js 在每页渲染完成后调用；也用于导航后刷新 .current。 */
  function repaintHits(wrap, pageNum) {
    if (!wrap) return;
    for (let i = wrap.children.length - 1; i >= 0; i--) {
      const ch = wrap.children[i];
      if (ch && ch.classList && ch.classList.contains('rt-find-layer')) ch.remove();
    }
    const q = S.query.trim().toLowerCase();
    if (!q || !S.hits.length) return;
    const page = Number.isFinite(pageNum) ? pageNum : parseInt(wrap.dataset.page, 10);
    const pageHits = [];
    for (let i = 0; i < S.hits.length; i++) if (S.hits[i].page === page) pageHits.push(i);
    if (!pageHits.length) return;

    const layer = el('div', 'rt-find-layer');
    const wr = wrap.getBoundingClientRect();
    const W = wrap.clientWidth || wr.width || 1;
    const H = wrap.clientHeight || wr.height || 1;
    let assigned = 0;
    let drawn = 0;

    // 首选：直接拿已定位好的文字层 span 画框，旋转/缩放都天然正确。
    const spans = wrap.querySelectorAll('.pr-text-layer span');
    for (let i = 0; i < spans.length && drawn < 300; i++) {
      const t = spans[i].textContent || '';
      if (!t.toLowerCase().includes(q)) continue;
      const sr = spans[i].getBoundingClientRect();
      if (!sr.width || !sr.height) continue;
      const hi = pageHits[Math.min(assigned, pageHits.length - 1)];
      const box = el('div', 'rt-find-hit');
      box.style.left = clampNum(sr.left - wr.left, 0, W) + 'px';
      box.style.top = clampNum(sr.top - wr.top, 0, H) + 'px';
      box.style.width = Math.min(sr.width, W) + 'px';
      box.style.height = Math.min(sr.height, H) + 'px';
      box.dataset.hit = String(hi);
      if (hi === S.cur) box.classList.add('current');
      layer.appendChild(box);
      assigned += 1;
      drawn += 1;
    }

    // 文字层尚未就绪：退回 pdf.js 文本项推算的近似框。
    if (!drawn) {
      for (let i = 0; i < pageHits.length && drawn < 300; i++) {
        const hi = pageHits[i];
        const r = S.hits[hi].rect;
        if (!r || !(r.w > 0) || !(r.h > 0)) continue;
        const box = el('div', 'rt-find-hit');
        box.style.left = clampNum(r.x, 0, W) + 'px';
        box.style.top = clampNum(r.y, 0, H) + 'px';
        box.style.width = Math.min(r.w, W) + 'px';
        box.style.height = Math.min(r.h, H) + 'px';
        box.dataset.hit = String(hi);
        if (hi === S.cur) box.classList.add('current');
        layer.appendChild(box);
        drawn += 1;
      }
    }
    // 再不行就只保留计数 + 跳页兜底，不画误导性的假框。
    if (!drawn) return;
    wrap.appendChild(layer);
  }

  const api = { init, repaintHits, destroy };
  if (typeof window !== 'undefined') window.ReaderTools = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
