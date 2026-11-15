/* knowledge-graph.js —— 知识图谱视图（独立模块，无第三方依赖、无构建）
 *
 * 约定：UI 完全自建，挂到 app.js 传入的容器（<section id="viewGraph">），
 *       切入时 window.GraphView.mount(container)，切走时 window.GraphView.close()。
 * 数据：GET  /api/knowledge/graph          图谱（nodes / edges / topics / stats）
 *       POST /api/knowledge/rebuild        重新聚类
 *       PATCH /api/literature/:id          写 tags
 *       POST /api/literature/:id/reveal    文件定位（Worlex.reveal 缺失时的直连兜底）
 * 桥：window.Worlex 的所有调用都做存在性判断，缺失时一律走本地兜底。
 * 安全：后端文本全部用 textContent / createElementNS 渲染，绝不用 innerHTML 拼接数据。
 */
(function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const FRAMES = 120;            // 稳定前迭代帧数（180 帧时大图要晃 6 秒，缩到 120 更跟手）
  const REPULSION = 5200;        // 库仑斥力系数
  const SPRING_K = 0.018;        // 弹簧系数
  const DAMPING = 0.84;          // 速度阻尼
  const MAX_V = 14;              // 单帧最大位移
  const CLUSTER_K = 0.022;       // 向簇中心引力（簇要收得紧，才不会糊成一团）
  const CENTER_K = 0.0012;       // 向画布中心引力
  const TOPIC_COLORS = 8;        // 主题色数量（与 CSS 的 .t0~.t7 对应）
  const LABEL_MAX = 14;          // 主题标签最多显示几个字（超出以省略号收尾）
  const LABEL_GAP = 6;           // 标签与簇边界的最小间距
  const LABEL_LINE = 15;         // 标签行高，用于避让时上下错开

  // ==================== 全局桥与兜底 ====================

  function W() {
    return (typeof window !== 'undefined' && window.Worlex) || null;
  }

  /** HTML 转义：优先用桥，缺失时本地实现。后端文本一律走 textContent，此处仅用于静态文案。 */
  function esc(s) {
    const w = W();
    if (w && typeof w.esc === 'function') {
      try { return w.esc(s); } catch (_) { /* 回落到本地 */ }
    }
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function svg(tag, attrs) {
    const n = document.createElementNS(SVG_NS, tag);
    if (attrs) Object.keys(attrs).forEach((k) => n.setAttribute(k, String(attrs[k])));
    return n;
  }

  function joinText(v, sep) {
    if (v == null) return '';
    if (Array.isArray(v)) return v.map((x) => String(x == null ? '' : x)).filter(Boolean).join(sep);
    return String(v);
  }

  function toast(msg, kind) {
    const w = W();
    if (w && typeof w.toast === 'function') {
      try { w.toast(msg, kind); return; } catch (_) { /* 回落到本地 */ }
    }
    try {
      const t = el('div', 'kg-toast');
      t.textContent = String(msg || '');
      document.body.appendChild(t);
      window.setTimeout(() => t.remove(), 2600);
    } catch (_) { /* ignore */ }
  }

  async function api(path, opts = {}) {
    const w = W();
    if (w && typeof w.api === 'function') return w.api(path, opts);
    const init = { method: opts.method || 'GET', headers: {} };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, init);
    const raw = await res.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = { error: raw }; }
    if (!res.ok) throw new Error((data && data.error) || `请求失败（${res.status}）`);
    return data;
  }

  /** Worlex.items() 若存在，用作详情面板的字段补全（同步返回数组才采纳）。 */
  function itemsById() {
    const map = new Map();
    const w = W();
    if (!w || typeof w.items !== 'function') return map;
    try {
      const list = w.items();
      if (Array.isArray(list)) {
        list.forEach((it) => { if (it && it.id != null) map.set(String(it.id), it); });
      }
    } catch (_) { /* ignore */ }
    return map;
  }

  function reveal(id, mode) {
    const w = W();
    if (w && typeof w.reveal === 'function') {
      try { return w.reveal(id, mode); } catch (_) { /* 回落到直连接口 */ }
    }
    return api(`/api/literature/${encodeURIComponent(id)}/reveal`, { method: 'POST', body: { mode } })
      .catch((err) => toast((err && err.message) || '定位失败', 'error'));
  }

  function openLiterature(id) {
    const w = W();
    if (w && typeof w.openLiterature === 'function') {
      try { return w.openLiterature(id); } catch (_) { /* 回落 */ }
    }
    toast('阅读器未就绪，请刷新页面后重试', 'error');
  }

  /** 若页面未显式引入本模块的样式表，则按脚本所在目录补一个 <link>。 */
  function ensureStyles() {
    if (typeof document === 'undefined') return;
    if (document.querySelector('link[href*="knowledge-graph.css"]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    let base = '';
    try {
      const cur = document.currentScript;
      if (cur && cur.src) base = cur.src.replace(/[^/]*$/, '');
    } catch (_) { /* ignore */ }
    link.href = base + 'knowledge-graph.css';
    link.setAttribute('data-kg-style', '1');
    document.head.appendChild(link);
  }

  // ==================== 状态 ====================

  const S = {
    mounted: false,
    container: null,
    root: null,
    refs: {},
    buckets: { global: [], nodes: [], detail: [], status: [] },
    data: null,
    items: new Map(),
    nodes: [],            // 布局节点：{ id, data, r, deg, x, y, vx, vy, cluster, color, visible, g, disc, fixed }
    edges: [],            // 布局边：  { s, t, kind, w, visible, line }
    clusters: [],         // 主题簇：  { id, label, count, color, nodes, x, y, r, hull, labelEl }
    topicList: [],        // 下拉筛选用
    elToNode: new WeakMap(),
    view: { scale: 1, tx: 0, ty: 0 },
    W: 0,
    H: 0,
    filter: { q: '', topic: '__all__', labels: true },
    selected: null,
    status: 'idle',
    // 当前可见簇的布局形态：只剩一个主题时铺满画布（节点摊开，才看得清彼此关系）
    layout: { single: false, clusters: 0 },
    sim: { frame: 0, frames: FRAMES, running: false },
    raf: 0,
    ro: null,
    drag: null,
    reduced: false,
  };

  function listen(target, type, fn, opts, bucket) {
    const b = bucket || 'global';
    target.addEventListener(type, fn, opts);
    S.buckets[b].push({ target, type, fn, opts });
  }

  function clearBucket(name) {
    const arr = S.buckets[name] || [];
    for (const l of arr) {
      try { l.target.removeEventListener(l.type, l.fn, l.opts); } catch (_) { /* ignore */ }
    }
    arr.length = 0;
  }

  // ==================== DOM 构建 ====================

  function buildDom(host) {
    const root = el('div', 'kg-root');

    // ---- 顶部工具条 ----
    const bar = el('div', 'kg-toolbar');
    const head = el('div', 'kg-head');
    head.appendChild(el('h1', 'kg-title', '知识图谱'));
    head.appendChild(el('p', 'kg-sub', '由大模型按研究主题聚类；连线表示两篇文献同关键词、同研究方法或同研究对象。'));
    bar.appendChild(head);

    const tools = el('div', 'kg-tools');

    const fSearch = el('label', 'kg-field kg-search');
    fSearch.appendChild(el('span', 'kg-sr', esc('按标题或作者搜索文献')));
    const search = el('input', 'kg-input');
    search.type = 'search';
    search.placeholder = '搜索标题 / 作者';
    search.setAttribute('aria-label', '按标题或作者搜索文献');
    fSearch.appendChild(search);
    tools.appendChild(fSearch);

    const fTopic = el('label', 'kg-field kg-topic');
    fTopic.appendChild(el('span', 'kg-field-label', '主题'));
    const sel = el('select', 'kg-select');
    sel.setAttribute('aria-label', '按主题筛选');
    fTopic.appendChild(sel);
    tools.appendChild(fTopic);

    const chkLabel = el('label', 'kg-check');
    const chk = el('input');
    chk.type = 'checkbox';
    chk.checked = true;
    chkLabel.appendChild(chk);
    chkLabel.appendChild(el('span', '', '显示主题标签'));
    tools.appendChild(chkLabel);

    const rebuild = el('button', 'kg-btn kg-btn-primary kg-rebuild', 'AI 重新聚类');
    rebuild.type = 'button';
    tools.appendChild(rebuild);
    bar.appendChild(tools);

    const stats = el('div', 'kg-stats');
    stats.setAttribute('aria-live', 'polite');
    stats.hidden = true;
    bar.appendChild(stats);

    // ---- 主区：画布 + 右侧详情 ----
    const main = el('div', 'kg-main');
    const stage = el('div', 'kg-stage');

    const svgRoot = svg('svg', { class: 'kg-svg' });
    const viewport = svg('g', { class: 'kg-viewport' });
    const clustersG = svg('g', { class: 'kg-clusters' });
    const edgesG = svg('g', { class: 'kg-edges' });
    const nodesG = svg('g', { class: 'kg-nodes' });
    viewport.appendChild(clustersG);
    viewport.appendChild(edgesG);
    viewport.appendChild(nodesG);
    svgRoot.appendChild(viewport);
    stage.appendChild(svgRoot);

    const tip = el('div', 'kg-tip');
    tip.setAttribute('role', 'tooltip');

    const status = el('div', 'kg-status');
    status.classList.add('is-off');
    status.setAttribute('aria-live', 'polite');

    const zoom = el('div', 'kg-zoom');
    const mkZoom = (text, label, factor, reset) => {
      const b = el('button', 'kg-zoom-btn', text);
      b.type = 'button';
      b.setAttribute('aria-label', esc(label));
      b.dataset.factor = reset ? 'reset' : String(factor);
      zoom.appendChild(b);
      return b;
    };
    mkZoom('＋', '放大', 1.2, false);
    mkZoom('－', '缩小', 1 / 1.2, false);
    mkZoom('复位', '重置视图', 1, true);

    stage.appendChild(tip);
    stage.appendChild(status);
    stage.appendChild(zoom);

    const detail = el('aside', 'kg-detail');
    detail.setAttribute('aria-label', '文献详情');

    main.appendChild(stage);
    main.appendChild(detail);
    root.appendChild(bar);
    root.appendChild(main);
    host.appendChild(root);

    S.root = root;
    S.refs = {
      root, bar, search, sel, chk, rebuild, stats,
      main, stage, svg: svgRoot, viewport, clustersG, edgesG, nodesG,
      tip, status, zoom, detail,
    };
  }

  function bind() {
    const r = S.refs;
    listen(r.search, 'input', (e) => { S.filter.q = e.target.value || ''; applyFilter(); });
    listen(r.sel, 'change', (e) => { S.filter.topic = e.target.value || '__all__'; applyFilter(); });
    listen(r.chk, 'change', (e) => { S.filter.labels = !!e.target.checked; applyFilter(); });
    listen(r.rebuild, 'click', () => rebuild());

    for (const b of r.zoom.children) {
      listen(b, 'click', () => {
        if (b.dataset.factor === 'reset') {
          S.view = { scale: 1, tx: 0, ty: 0 };
          render();
        } else {
          zoomAt(S.W / 2, S.H / 2, Number(b.dataset.factor) || 1.2);
        }
      });
    }

    listen(r.stage, 'pointerdown', onPointerDown);
    listen(r.stage, 'pointermove', onPointerMove);
    listen(r.stage, 'pointerup', onPointerUp);
    listen(r.stage, 'pointercancel', onPointerUp);
    listen(r.stage, 'wheel', onWheel, { passive: false });
    listen(document, 'keydown', onKeyDown);

    if (typeof ResizeObserver !== 'undefined') {
      S.ro = new ResizeObserver(() => onResize());
      S.ro.observe(r.stage);
    } else {
      listen(window, 'resize', onResize);
    }
  }

  // ==================== 数据 → 布局模型 ====================

  function edgeClass(kind) {
    const k = String(kind || '').toLowerCase();
    // 引用边最弱（正文里提了一句），同关键词最强，同方法 / 同研究对象居中
    if (/cite|ref|引用/.test(k)) return 'e-weak';
    if (/keyword|topic|cluster|主题/.test(k)) return 'e-strong';
    return 'e-normal';
  }

  function nodeAria(n) {
    const d = n.data || {};
    const parts = [d.title || '未命名文献'];
    if (d.titleZh) parts.push(String(d.titleZh));
    const meta = [];
    const a = joinText(d.authors, '、');
    if (a) meta.push(a);
    if (d.year) meta.push(String(d.year));
    if (meta.length) parts.push(meta.join(' · '));
    if (n.cluster && n.cluster.label) parts.push('主题：' + n.cluster.label);
    return parts.join('，');
  }

  function buildData() {
    const d = S.data || {};
    const rawNodes = Array.isArray(d.nodes) ? d.nodes : [];
    const rawEdges = Array.isArray(d.edges) ? d.edges : [];
    const rawTopics = Array.isArray(d.topics) ? d.topics : [];

    // 下拉筛选用的主题清单（以后端 topics 为准）
    S.topicList = rawTopics.map((t) => ({
      id: String(t && t.id != null ? t.id : ''),
      label: String((t && t.label) || '未命名主题'),
      count: Number(t && t.count) || 0,
    }));

    // 主题簇：以后端 topics 为主；若没有 topics，则从节点的 topicLabel 兜底生成
    const cmap = new Map();
    const clusters = [];
    const addCluster = (id, label, count) => {
      const c = {
        id: String(id), label: String(label || '未命名主题'), count: Number(count) || 0,
        color: clusters.length % TOPIC_COLORS, nodes: [], x: 0, y: 0, r: 60,
        hull: null, labelEl: null,
      };
      clusters.push(c);
      cmap.set(c.id, c);
      return c;
    };
    rawTopics.forEach((t) => addCluster(t && t.id != null ? t.id : '', t && t.label, t && t.count));
    if (!clusters.length) {
      const seen = new Map();
      rawNodes.forEach((rn) => {
        const id = rn && rn.topicId != null ? String(rn.topicId) : '__none__';
        const label = String((rn && rn.topicLabel) || '未分类');
        if (!seen.has(id)) { seen.set(id, true); addCluster(id, label, 0); }
      });
    }

    const other = {
      id: '__other__', label: '其他', count: 0,
      color: clusters.length % TOPIC_COLORS, nodes: [], x: 0, y: 0, r: 60,
      hull: null, labelEl: null,
    };

    const nodes = rawNodes.map((raw) => ({
      id: String(raw && raw.id != null ? raw.id : ''),
      data: raw || {}, r: 5, x: 0, y: 0, vx: 0, vy: 0, deg: 0,
      cluster: null, color: 0, visible: true, g: null, disc: null, fixed: false,
    }));
    const byId = new Map(nodes.map((n) => [n.id, n]));

    const edges = [];
    rawEdges.forEach((raw) => {
      const s = byId.get(String(raw && raw.source));
      const t = byId.get(String(raw && raw.target));
      if (!s || !t || s === t) return;
      const w = Math.max(0.1, Number(raw && raw.weight) || 1);
      s.deg += 1;
      t.deg += 1;
      edges.push({
        s, t,
        kind: String((raw && raw.kind) || ''),
        w,
        // 「为什么相连」的依据：后端算好的一句理由 + 引用方向（谁引了谁）
        reason: String((raw && raw.reason) || ''),
        citing: String((raw && raw.citing) || ''),
        visible: true,
        line: null,
      });
    });

    let maxDeg = 1;
    nodes.forEach((n) => { if (n.deg > maxDeg) maxDeg = n.deg; });
    nodes.forEach((n) => { n.r = 5 + 6 * (n.deg / maxDeg); });

    nodes.forEach((n) => {
      const tid = n.data.topicId == null ? '' : String(n.data.topicId);
      let c = cmap.get(tid);
      if (!c) {
        c = other;
        if (!clusters.includes(other)) clusters.push(other);
        if (n.data.topicLabel && other.label === '其他') other.label = String(n.data.topicLabel);
      }
      n.cluster = c;
      n.color = c.color;
      c.nodes.push(n);
    });

    // 只绘制有节点的簇，避免空圆圈
    S.clusters = clusters.filter((c) => c.nodes.length > 0);
    S.nodes = nodes;
    S.edges = edges;
  }

  function renderTopicOptions() {
    const sel = S.refs.sel;
    const prev = sel.value;
    sel.textContent = '';
    const all = el('option', '', '全部文献');
    all.value = '__all__';
    sel.appendChild(all);
    S.topicList.forEach((t) => {
      const o = el('option', '', t.count ? `${t.label}（${t.count}）` : t.label);
      o.value = t.id;
      sel.appendChild(o);
    });
    if (S.clusters.some((c) => c.id === '__other__')) {
      const o = el('option', '', '其他');
      o.value = '__other__';
      sel.appendChild(o);
    }
    let found = false;
    for (const o of sel.options) { if (o.value === prev) { found = true; break; } }
    if (found) sel.value = prev;
    else { sel.value = '__all__'; S.filter.topic = '__all__'; }
  }

  function renderStats() {
    const st = S.data && S.data.stats;
    const box = S.refs.stats;
    if (!box) return;
    if (!st || typeof st !== 'object') { box.hidden = true; return; }
    const n = (v) => {
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
      if (v == null || v === '') return '—';
      return String(v);
    };
    const c = (S.data && S.data.clustering) || {};
    const isLlm = c.method === 'llm';
    const how = isLlm ? '大模型聚类' : '本地聚类';
    const bits = [`${n(st.documents)} 篇文献`, `${n(st.topics)} 个主题`, `${n(st.relations)} 条关联`, how];
    box.hidden = false;
    box.textContent = bits.join(' · ');
    // 悬停看细节：用的是哪个模型、什么时候聚的、是否需要重新聚类
    const tips = [];
    if (isLlm) {
      if (c.model) tips.push('聚类模型：' + c.model);
      if (c.at) {
        const d = new Date(c.at);
        if (!Number.isNaN(d.getTime())) tips.push('聚类时间：' + d.toLocaleString());
      }
    } else {
      tips.push('按标题 / 关键词的词面相似度聚类，未调用大模型');
    }
    if (c.running) tips.push('正在用大模型重新聚类…');
    else if (c.stale) tips.push('文献有更新，稍后会自动重新聚类');
    if (c.error) tips.push('上次大模型聚类失败：' + c.error);
    if (tips.length) box.title = tips.join('\n');
    else box.removeAttribute('title');
  }

  // ==================== SVG 元素构建 ====================

  function buildGraph() {
    const r = S.refs;
    clearBucket('nodes');
    clearBucket('detail');
    [r.clustersG, r.edgesG, r.nodesG].forEach((g) => { g.textContent = ''; });
    S.elToNode = new WeakMap();

    // 主题簇：中性细线圈 + 灰色标签（颜色落在节点上）
    for (const c of S.clusters) {
      const hull = svg('circle', { class: 'kg-hull', r: 60 });
      const label = svg('text', { class: 'kg-topic-label', 'text-anchor': 'middle' });
      // 长标签截断显示，完整名称放进 title：图谱里一行放不下两串长中文
      c.labelText = labelTextOf(c.label);
      c.labelW = estTextWidth(c.labelText);
      label.textContent = c.labelText;
      const tip = svg('title');
      tip.textContent = `${c.label}（${c.count} 篇）`;
      label.appendChild(tip);
      r.clustersG.appendChild(hull);
      r.clustersG.appendChild(label);
      c.hull = hull;
      c.labelEl = label;
    }
    // 节点多的时候把连线压淡，否则一层网把主题分区糊掉
    S.root?.classList.toggle('kg-dense', S.nodes.length > 70);

    // 关系边
    for (const e of S.edges) {
      const line = svg('line', { class: `kg-edge ${edgeClass(e.kind)}` });
      r.edgesG.appendChild(line);
      e.line = line;
    }

    // 文献节点
    for (const n of S.nodes) {
      const g = svg('g', {
        class: `kg-node t${n.color}`, tabindex: '0', role: 'button',
        'aria-label': nodeAria(n),
      });
      const disc = svg('circle', { class: 'kg-disc', r: n.r.toFixed(1) });
      const hit = svg('circle', { class: 'kg-hit', r: (n.r + 7).toFixed(1) });
      g.appendChild(disc);
      g.appendChild(hit);
      r.nodesG.appendChild(g);
      n.g = g;
      n.disc = disc;
      S.elToNode.set(g, n);

      listen(g, 'pointerenter', (e) => showTip(n, e.clientX, e.clientY), undefined, 'nodes');
      listen(g, 'pointermove', (e) => moveTip(e.clientX, e.clientY), undefined, 'nodes');
      listen(g, 'pointerleave', hideTip, undefined, 'nodes');
      listen(g, 'focus', () => {
        const st = r.stage.getBoundingClientRect();
        showTip(n, st.left + n.x * S.view.scale + S.view.tx, st.top + n.y * S.view.scale + S.view.ty);
      }, undefined, 'nodes');
      listen(g, 'blur', hideTip, undefined, 'nodes');
      listen(g, 'keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault();
          openDetail(n.id);
        }
      }, undefined, 'nodes');
    }

    layoutInit();
    render();
  }

  // ==================== 力导向布局 ====================

  /** 文字宽度估算（12px UI 字体）：只为标签避让服务，不必精确到像素。 */
  function estTextWidth(text) {
    let w = 0;
    for (const ch of String(text || '')) {
      w += /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 12 : 6.6;
    }
    return w;
  }

  function labelTextOf(label) {
    const s = String(label || '').trim();
    if (!s) return '未命名主题';
    return s.length > LABEL_MAX ? `${s.slice(0, LABEL_MAX)}…` : s;
  }

  /**
   * 簇的位置与「自家地盘半径」：按成员数开方定半径，再按行列网格分配到画布。
   *
   * 旧版把所有簇中心摆在同一个半径 0.3·min(W,H) 的圆上，簇半径却有 200px，
   * 结果所有簇互相重叠、标签全挤在画面中间。改成网格分区后，每个簇各占一格，
   * 节点被限制在自家半径内，标签自然分开。
   */
  function layoutCenters() {
    const W = S.W || 800;
    const H = S.H || 600;
    // 只统计「当前可见」的成员：筛选到某一个主题时，别的簇不该继续占着画布格子，
    // 否则单主题只剩九分之一的地方，节点全挤在一小块里，看不出彼此关系。
    const shownIn = (c) => c.nodes.reduce((k, n) => k + (n.visible ? 1 : 0), 0);
    const active = S.clusters.filter((c) => shownIn(c) > 0);
    const m = active.length;
    S.layout = { single: m === 1, clusters: m };
    if (!m) return;
    // 详情面板打开时会盖住画布右侧：单主题视图把簇摆到「没被盖住」的那块中间，
    // 否则节点看着整体偏右，像布局出了问题。
    const detail = S.refs && S.refs.detail;
    const panelW = detail && detail.classList.contains('is-open') ? Math.min(W * 0.6, detail.offsetWidth || 0) : 0;
    const availW = Math.max(220, W - panelW);
    if (m === 1) {
      // 只看一个主题：簇铺满画布，节点有地方摊开
      const c = active[0];
      c.x = availW / 2;
      c.y = H / 2;
      c.rTarget = Math.max(90, Math.min(availW, H) / 2 - 46);
      return;
    }
    const padX = 24;
    const padY = 30; // 上方多留一点给主题标签
    const cols = Math.max(1, Math.ceil(Math.sqrt(m)));
    const rows = Math.max(1, Math.ceil(m / cols));
    const cellW = Math.max(120, (W - padX * 2) / cols);
    const cellH = Math.max(120, (H - padY * 2) / rows);
    active.forEach((c, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      c.x = padX + cellW * (col + 0.5);
      c.y = padY + cellH * (row + 0.5);
      // 30 是「看起来像个簇」的下限，sqrt 保证文献多的主题占更大一块
      const byCount = 30 + Math.sqrt(Math.max(1, shownIn(c))) * 24;
      const byCell = Math.min(cellW, cellH) / 2 - 26;
      c.rTarget = Math.max(34, Math.min(byCount, byCell));
    });
    // 没有成员的兜底簇（「其他」）不占格子，放在画布中心但不参与布局
    S.clusters.forEach((c) => {
      if (c.nodes && c.nodes.length) return;
      c.x = W / 2;
      c.y = H / 2;
      c.rTarget = 32;
    });
  }

  function layoutInit() {
    layoutCenters();
    const cx = (S.W || 800) / 2;
    const cy = (S.H || 600) / 2;
    // 按簇分配初始位置：黄金角螺旋铺在自家地盘里，避免所有节点从中心一个点炸开
    const seat = new Map();
    S.nodes.forEach((n) => {
      const c = n.cluster;
      const cx0 = c ? c.x : cx;
      const cy0 = c ? c.y : cy;
      const k = (seat.get(c) || 0) + 1;
      seat.set(c, k);
      const radius = (c && c.rTarget ? c.rTarget * 0.72 : 45) * Math.sqrt(k / Math.max(4, c ? c.nodes.length : 8));
      const angle = k * 2.399963; // 黄金角，分布均匀且确定
      n.x = cx0 + Math.cos(angle) * radius;
      n.y = cy0 + Math.sin(angle) * radius;
      n.vx = 0;
      n.vy = 0;
      n.fixed = false;
    });
  }

  function stepPhysics(alpha) {
    const nodes = S.nodes;
    const N = nodes.length;
    // 只剩一个主题时把图「摊开」：斥力更强、作用范围更远、簇引力更弱，
    // 节点会在整个画布半径内均匀散开，而不是缩在中心一小坨。
    const single = !!(S.layout && S.layout.single);
    const repulsion = single ? REPULSION * 3.2 : REPULSION;
    const cutoff2 = single ? 250000 : 90000;
    const clusterK = single ? CLUSTER_K * 0.35 : CLUSTER_K;
    // 单主题时把弹簧放软：节点靠斥力摊开，而不是被连线拉成一小团
    const springK = single ? SPRING_K * 0.55 : SPRING_K;

    // 斥力（库仑），距离过远忽略，保证大图也能跑
    for (let i = 0; i < N; i++) {
      const a = nodes[i];
      if (!a.visible) continue;
      for (let j = i + 1; j < N; j++) {
        const b = nodes[j];
        if (!b.visible) continue;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 > cutoff2) continue;
        if (d2 < 0.01) {
          dx = (i - j) * 0.01 || 0.01;
          dy = 0.01;
          d2 = dx * dx + dy * dy;
        }
        const d = Math.sqrt(d2);
        const f = repulsion / (d2 + 40) * alpha;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
    }

    // 弹簧（边）
    for (const e of S.edges) {
      if (!e.visible) continue;
      const a = e.s;
      const b = e.t;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      // 静止长度跟着簇的地盘走：小簇里还用 110px 会把节点全顶到边上
      const rt = (a.cluster && a.cluster.rTarget) || 110;
      const base = single
        ? Math.max(120, Math.min(320, rt * 0.85)) // 单主题：地盘大，连线也跟着拉长
        : Math.min(110, Math.max(46, rt * 0.8));
      const rest = base - Math.min(28, e.w * 10);
      const f = springK * (d - rest) * alpha * (0.7 + 0.3 * Math.min(3, e.w));
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }

    // 向簇中心 / 画布中心引力 + 积分
    const cx = (S.W || 800) / 2;
    const cy = (S.H || 600) / 2;
    const pad = 16;
    for (const n of nodes) {
      if (n.fixed) { n.vx = 0; n.vy = 0; continue; }
      if (!n.visible) { n.vx = 0; n.vy = 0; continue; }
      if (n.cluster) {
        n.vx += (n.cluster.x - n.x) * clusterK * alpha;
        n.vy += (n.cluster.y - n.y) * clusterK * alpha;
      }
      n.vx += (cx - n.x) * CENTER_K * alpha;
      n.vy += (cy - n.y) * CENTER_K * alpha;
      n.vx *= DAMPING;
      n.vy *= DAMPING;
      const sp = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
      if (sp > MAX_V) { n.vx = n.vx / sp * MAX_V; n.vy = n.vy / sp * MAX_V; }
      n.x += n.vx;
      n.y += n.vy;
      // 收在自家簇的半径内：簇与簇之间才拉得开，主题标签也不会互相压住
      if (n.cluster && n.cluster.rTarget) {
        const c = n.cluster;
        const dx = n.x - c.x;
        const dy = n.y - c.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const lim = Math.max(10, c.rTarget - n.r - 2);
        if (d > lim) {
          n.x = c.x + (dx / d) * lim;
          n.y = c.y + (dy / d) * lim;
          n.vx *= 0.35;
          n.vy *= 0.35;
        }
      }
      if (n.x < pad) { n.x = pad; n.vx *= -0.3; }
      if (n.x > S.W - pad) { n.x = S.W - pad; n.vx *= -0.3; }
      if (n.y < pad) { n.y = pad; n.vy *= -0.3; }
      if (n.y > S.H - pad) { n.y = S.H - pad; n.vy *= -0.3; }
    }
  }

  function tick() {
    if (!S.sim.running) return;
    const alpha = Math.max(0.03, 1 - S.sim.frame / Math.max(1, S.sim.frames));
    stepPhysics(alpha);
    // 节点多的时候隔帧画一次：物理每帧都算，但 DOM 写入减半，动画明显更顺
    const stride = S.nodes.length > 60 ? 2 : 1;
    if (S.sim.frame % stride === 0 || S.sim.frame === S.sim.frames - 1) render();
    S.sim.frame += 1;
    if (S.sim.frame < S.sim.frames) {
      S.raf = window.requestAnimationFrame(tick);
    } else {
      S.sim.running = false;
      S.raf = 0;
    }
  }

  function startSim(frames) {
    if (S.raf) { window.cancelAnimationFrame(S.raf); S.raf = 0; }
    if (!frames || !S.nodes.length) {
      S.sim.running = false;
      render();
      return;
    }
    S.sim.frame = 0;
    S.sim.frames = frames;
    if (S.reduced) {
      // 减弱动态效果：同步算完，不产生任何动画帧
      const steps = Math.min(frames, 90);
      for (let i = 0; i < steps; i++) {
        stepPhysics(Math.max(0.03, 1 - i / steps));
      }
      render();
      S.sim.running = false;
      return;
    }
    S.sim.running = true;
    S.raf = window.requestAnimationFrame(tick);
  }

  function render() {
    const r = S.refs;
    if (!r.viewport) return;
    const v = S.view;
    r.viewport.setAttribute('transform', `translate(${v.tx.toFixed(2)},${v.ty.toFixed(2)}) scale(${v.scale.toFixed(3)})`);

    for (const e of S.edges) {
      if (!e.line) continue;
      e.line.setAttribute('x1', e.s.x.toFixed(1));
      e.line.setAttribute('y1', e.s.y.toFixed(1));
      e.line.setAttribute('x2', e.t.x.toFixed(1));
      e.line.setAttribute('y2', e.t.y.toFixed(1));
    }
    for (const n of S.nodes) {
      if (!n.g) continue;
      n.g.setAttribute('transform', `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`);
    }
    // 主题标签：先算出每个簇的圈与标签位置，再做一次上下避让，
    // 避免两个相邻簇的标签落在同一行、糊成一串字。
    const W = S.W || 800;
    const occupied = [];
    const labels = [];
    for (const c of S.clusters) {
      if (!c.hull) continue;
      let max = 46;
      for (const n of c.nodes) {
        if (!n.visible) continue;
        const dx = n.x - c.x;
        const dy = n.y - c.y;
        const d = Math.sqrt(dx * dx + dy * dy) + n.r + 12;
        if (d > max) max = d;
      }
      // 圈不能大过自家地盘，否则又会压到邻居的节点上
      if (c.rTarget) max = Math.min(max, c.rTarget + 4);
      c.r = max;
      c.hull.setAttribute('cx', c.x.toFixed(1));
      c.hull.setAttribute('cy', c.y.toFixed(1));
      c.hull.setAttribute('r', max.toFixed(1));
      if (!c.labelEl || c.labelEl.classList.contains('is-hidden')) continue;
      const lw = Math.min(c.labelW || estTextWidth(c.labelText), W - 24);
      labels.push({
        c,
        lx: Math.min(Math.max(lw / 2 + 8, c.x), W - lw / 2 - 8),
        ly: Math.max(14, c.y - max - LABEL_GAP),
        lw,
      });
    }
    labels.sort((a, b) => b.ly - a.ly);
    for (const L of labels) {
      let finalY = null;
      for (let k = 0; k < 5; k++) {
        const y = L.ly - k * LABEL_LINE;
        if (y < 12) break;
        const box = { x1: L.lx - L.lw / 2 - 4, x2: L.lx + L.lw / 2 + 4, y1: y - 12, y2: y + 3 };
        const hit = occupied.some((o) => box.x1 < o.x2 && box.x2 > o.x1 && box.y1 < o.y2 && box.y2 > o.y1);
        if (!hit) { finalY = y; occupied.push(box); break; }
      }
      // 真的放不下就先把这一条藏起来（图谱本身就是按主题分区的，标签只是辅助）
      L.c.labelEl.classList.toggle('is-crowded', finalY === null);
      if (finalY === null) continue;
      L.c.labelEl.setAttribute('x', L.lx.toFixed(1));
      L.c.labelEl.setAttribute('y', finalY.toFixed(1));
    }
  }

  // ==================== 过滤 / 可见性 ====================

  function updateVisibility() {
    const q = S.filter.q.trim().toLowerCase();
    const topic = S.filter.topic;
    for (const n of S.nodes) {
      const d = n.data || {};
      const hay = [d.title, d.titleZh, joinText(d.authors, ' ')].filter(Boolean).join(' ').toLowerCase();
      const okQ = !q || hay.indexOf(q) !== -1;
      const okT = topic === '__all__'
        || (topic === '__other__'
          ? !!(n.cluster && n.cluster.id === '__other__')
          : String(d.topicId == null ? '' : d.topicId) === topic);
      n.visible = okQ && okT;
      if (n.g) n.g.classList.toggle('is-hidden', !n.visible);
    }
    for (const e of S.edges) {
      e.visible = e.s.visible && e.t.visible;
      if (e.line) e.line.classList.toggle('is-hidden', !e.visible);
    }
    S.refs.root.classList.toggle('kg-hide-labels', !S.filter.labels);
    for (const c of S.clusters) {
      const any = c.nodes.some((n) => n.visible);
      if (c.hull) c.hull.classList.toggle('is-hidden', !any);
      if (c.labelEl) c.labelEl.classList.toggle('is-hidden', !any);
    }
  }

  function applyFilter() {
    updateVisibility();
    const prev = S.layout;
    // 可见簇变了要重排中心：只看一个主题时铺满画布，回来时再还原成网格
    layoutCenters();
    const changed = !!prev && (prev.single !== S.layout.single || prev.clusters !== S.layout.clusters);
    // 进出单主题时复位视图：否则新布局会落在上一次「点节点居中」留下的平移量里，
    // 整簇被推到画布角落，看着像布局坏了。
    if (changed) S.view = { scale: 1, tx: 0, ty: 0 };
    startSim(changed ? 120 : 45);
    if (S.selected) {
      const sel = S.nodes.find((x) => x.id === S.selected);
      if (sel) markNeighborhood(sel);
    }
    render();
  }

  // ==================== 缩放 / 平移 / 拖拽 ====================

  function zoomAt(px, py, factor) {
    const v = S.view;
    const ns = Math.min(3.5, Math.max(0.3, v.scale * factor));
    const k = ns / v.scale;
    v.tx = px - (px - v.tx) * k;
    v.ty = py - (py - v.ty) * k;
    v.scale = ns;
    render();
  }

  function onWheel(e) {
    e.preventDefault();
    const st = S.refs.stage.getBoundingClientRect();
    zoomAt(e.clientX - st.left, e.clientY - st.top, e.deltaY < 0 ? 1.1 : 1 / 1.1);
  }

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const t = e.target;
    if (t && t.closest && t.closest('button, .kg-zoom, .kg-status, .kg-tip')) return;
    const g = t && t.closest ? t.closest('.kg-node') : null;
    if (g) {
      const n = S.elToNode.get(g);
      if (n) {
        S.drag = { mode: 'node', n, startX: e.clientX, startY: e.clientY, moved: false };
        n.fixed = true;
      }
    } else {
      S.drag = {
        mode: 'pan', startX: e.clientX, startY: e.clientY, moved: false,
        origTx: S.view.tx, origTy: S.view.ty,
      };
      S.refs.stage.classList.add('is-panning');
    }
    if (S.drag) {
      try { S.refs.stage.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      hideTip();
      e.preventDefault();
    }
  }

  function onPointerMove(e) {
    const drag = S.drag;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (drag.mode === 'pan') {
      S.view.tx = drag.origTx + dx;
      S.view.ty = drag.origTy + dy;
      render();
    } else {
      const st = S.refs.stage.getBoundingClientRect();
      drag.n.x = (e.clientX - st.left - S.view.tx) / S.view.scale;
      drag.n.y = (e.clientY - st.top - S.view.ty) / S.view.scale;
      drag.n.vx = 0;
      drag.n.vy = 0;
      render();
    }
  }

  function onPointerUp(e) {
    const drag = S.drag;
    if (!drag) return;
    S.drag = null;
    S.refs.stage.classList.remove('is-panning');
    try { S.refs.stage.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    if (drag.mode === 'node') {
      drag.n.fixed = false;
      if (!drag.moved) openDetail(drag.n.id);
      else startSim(30);
    }
  }

  function onKeyDown(e) {
    if (e.key !== 'Escape') return;
    if (S.selected && S.refs.detail && S.refs.detail.classList.contains('is-open')) {
      closeDetail();
    }
  }

  // ==================== Tooltip ====================

  function showTip(n, clientX, clientY) {
    const r = S.refs;
    if (!r.tip) return;
    const d = n.data || {};
    r.tip.textContent = '';
    r.tip.appendChild(el('div', 'kg-tip-title', d.title || '未命名文献'));
    if (d.titleZh) r.tip.appendChild(el('div', 'kg-tip-zh', d.titleZh));
    const meta = [];
    const a = joinText(d.authors, '、');
    if (a) meta.push(a);
    if (d.year) meta.push(String(d.year));
    if (meta.length) r.tip.appendChild(el('div', 'kg-tip-meta', meta.join(' · ')));
    // 主题与关联数：不用点开也能知道这个点在图上有多「关键」
    const extra = [];
    if (n.cluster && n.cluster.label) extra.push('主题：' + n.cluster.label);
    if (n.deg) extra.push(n.deg + ' 条关联');
    if (extra.length) r.tip.appendChild(el('div', 'kg-tip-meta', extra.join(' · ')));
    r.tip.classList.add('is-on');
    moveTip(clientX, clientY);
  }

  function moveTip(clientX, clientY) {
    const r = S.refs;
    if (!r.tip || !r.tip.classList.contains('is-on')) return;
    const st = r.stage.getBoundingClientRect();
    const px = clientX - st.left;
    const py = clientY - st.top;
    const w = r.tip.offsetWidth || 220;
    const h = r.tip.offsetHeight || 64;
    let x = px + 16;
    let y = py + 16;
    if (x + w > st.width - 8) x = px - w - 16;
    if (y + h > st.height - 8) y = py - h - 16;
    r.tip.style.left = Math.max(8, x) + 'px';
    r.tip.style.top = Math.max(8, y) + 'px';
  }

  function hideTip() {
    if (S.refs.tip) S.refs.tip.classList.remove('is-on');
  }

  // ==================== 详情面板 ====================

  /** 一条边用当前选中的文献视角讲清楚「为什么相连」。 */
  function whyText(e, self) {
    const k = String(e.kind || '').toLowerCase();
    if (/cite/.test(k)) {
      if (!e.citing) return e.reason || '存在引用关系';
      return e.citing === self.id ? '本篇引用了它' : '它引用了本篇';
    }
    // keyword / method / subject 的理由由后端算好（共同关键词 / 共同研究方法 / 共同研究对象）
    return e.reason || '内容相关';
  }

  /**
   * 与某篇文献直接相连的文献，按目标节点聚合。
   * 同一对文献可能同时有「主题」「作者」两条边，这里合成一条、理由合并展示，
   * 否则列表里会出现两遍同一篇，用户会以为数据重复。
   */
  function neighborsOf(n) {
    const map = new Map();
    for (const e of S.edges) {
      const other = e.s === n ? e.t : e.t === n ? e.s : null;
      if (!other) continue;
      let rec = map.get(other.id);
      if (!rec) {
        rec = { node: other, weight: 0, reasons: [] };
        map.set(other.id, rec);
      }
      if (e.w > rec.weight) rec.weight = e.w;
      const why = whyText(e, n);
      if (why && rec.reasons.indexOf(why) === -1) rec.reasons.push(why);
    }
    const titleOf = (x) => String((x.data && (x.data.titleZh || x.data.title)) || x.id);
    return [...map.values()].sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      const ta = titleOf(a.node), tb = titleOf(b.node);
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
  }

  function neighborRow(rec) {
    const other = rec.node;
    const d = other.data || {};
    const btn = el('button', 'kg-d-nb');
    btn.type = 'button';
    btn.title = '在图上定位并查看这篇文献';
    btn.appendChild(el('span', `kg-d-dot t${other.color}`));
    const main = el('span', 'kg-d-nb-main');
    const zh = String(d.titleZh || '').trim();
    const en = String(d.title || '').trim();
    main.appendChild(el('span', 'kg-d-nb-title', zh || en || '未命名文献'));
    if (zh && en && en !== zh) main.appendChild(el('span', 'kg-d-nb-sub', en));
    main.appendChild(el('span', 'kg-d-why', rec.reasons.join(' · ')));
    btn.appendChild(main);
    if (d.year) btn.appendChild(el('span', 'kg-d-nb-year', String(d.year)));
    listen(btn, 'click', () => focusNode(other.id), undefined, 'detail');
    return btn;
  }

  function neighborSection(n) {
    const all = neighborsOf(n);
    const sec = el('section', 'kg-d-section kg-d-nb-sec');
    const head = el('h3', 'kg-d-label');
    head.appendChild(el('span', '', '关联文献'));
    if (all.length) head.appendChild(el('span', 'kg-d-count', String(all.length)));
    sec.appendChild(head);
    if (!all.length) {
      sec.appendChild(el('p', 'kg-d-none', '这篇文献暂时没有可解释的关联（库里还没有与它共享关键词、研究方法或研究对象的文献）。'));
      return sec;
    }
    const wrap = el('div', 'kg-d-neighbors');
    sec.appendChild(wrap);
    const LIMIT = 8;
    let shown = 0;
    const addRows = (to) => {
      const end = Math.min(to, all.length);
      for (let i = shown; i < end; i++) wrap.appendChild(neighborRow(all[i]));
      shown = end;
    };
    addRows(LIMIT);
    if (all.length > LIMIT) {
      const more = el('button', 'kg-d-more', `展开全部 ${all.length} 篇`);
      more.type = 'button';
      listen(more, 'click', () => { addRows(all.length); more.remove(); }, undefined, 'detail');
      sec.appendChild(more);
    }
    return sec;
  }

  /** 画布上把选中节点的邻域提亮，其余压暗：一眼看出「它和谁有关系」。 */
  function markNeighborhood(n) {
    const root = S.root;
    if (!root) return;
    const near = new Set([n.id]);
    for (const e of S.edges) {
      if (e.s === n) near.add(e.t.id);
      else if (e.t === n) near.add(e.s.id);
    }
    root.classList.add('kg-focus');
    for (const x of S.nodes) {
      const on = near.has(x.id) && x.id !== n.id;
      if (x.g) x.g.classList.toggle('is-near', on);
    }
    for (const e of S.edges) {
      const hot = e.s === n || e.t === n;
      if (e.line) e.line.classList.toggle('is-hot', hot);
    }
  }

  function clearNeighborhood() {
    if (S.root) S.root.classList.remove('kg-focus');
    for (const x of S.nodes) {
      if (x.g) x.g.classList.remove('is-near');
    }
    for (const e of S.edges) {
      if (e.line) {
        e.line.classList.remove('is-hot');
      }
    }
  }

  /** 让节点闪一下：从关联列表跳过来时，视线才跟得上。 */
  function flashNode(n) {
    if (!n || !n.g) return;
    n.g.classList.remove('is-flash');
    void n.g.getBoundingClientRect(); // 强制回流，连续点同一篇也能重播动画
    n.g.classList.add('is-flash');
    window.setTimeout(() => { if (n.g) n.g.classList.remove('is-flash'); }, 1400);
  }

  /** 定位到某篇并打开详情；被筛选藏起来时先恢复「全部文献」。 */
  function focusNode(id) {
    const n = S.nodes.find((x) => x.id === id);
    if (!n) return;
    if (!n.visible) {
      S.filter.q = '';
      S.filter.topic = '__all__';
      if (S.refs.search) S.refs.search.value = '';
      if (S.refs.sel) S.refs.sel.value = '__all__';
      applyFilter();
    }
    S.view.tx = S.W / 2 - n.x * S.view.scale;
    S.view.ty = S.H / 2 - n.y * S.view.scale;
    render();
    openDetail(id);
    flashNode(n);
  }

  function detailField(n, key) {
    const d = n.data || {};
    const extra = S.items.get(n.id) || {};
    const a = d[key];
    if (a != null && a !== '' && (!Array.isArray(a) || a.length)) return a;
    return extra[key] != null ? extra[key] : '';
  }

  function chipSection(label, values) {
    const arr = (Array.isArray(values)
      ? values
      : String(values || '').split(/[,，;；]/)).map((x) => String(x == null ? '' : x).trim()).filter(Boolean);
    const sec = el('section', 'kg-d-section');
    sec.appendChild(el('h3', 'kg-d-label', label));
    const wrap = el('div', 'kg-d-chips');
    if (!arr.length) wrap.appendChild(el('span', 'kg-d-none', '暂无'));
    else arr.forEach((v) => wrap.appendChild(el('span', 'kg-chip', v)));
    sec.appendChild(wrap);
    return sec;
  }

  function detailButton(label, cls, fn, disabled, title) {
    const b = el('button', `kg-btn ${cls}`, label);
    b.type = 'button';
    if (disabled) {
      b.disabled = true;
      b.setAttribute('aria-disabled', 'true');
      if (title) b.title = title;
    } else {
      listen(b, 'click', fn, undefined, 'detail');
    }
    return b;
  }

  function buildDetail(n) {
    const root = S.refs.detail;
    clearBucket('detail');
    root.textContent = '';

    const top = el('div', 'kg-detail-top');
    top.appendChild(el('span', 'kg-detail-hint', '文献详情'));
    const close = el('button', 'kg-icon-btn', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭详情');
    listen(close, 'click', closeDetail, undefined, 'detail');
    top.appendChild(close);
    root.appendChild(top);

    const body = el('div', 'kg-detail-body');
    const en = el('h2', 'kg-d-en', detailField(n, 'title') || '未命名文献');
    en.setAttribute('lang', 'en');
    body.appendChild(en);
    const zh = detailField(n, 'titleZh');
    if (zh) body.appendChild(el('p', 'kg-d-zh', zh));

    const meta = el('dl', 'kg-d-meta');
    const rows = [
      ['作者', joinText(detailField(n, 'authors'), '、')],
      ['年份', String(detailField(n, 'year') || '')],
      ['期刊', joinText(detailField(n, 'journal'), '、')],
      ['类型', String(detailField(n, 'docType') || '')],
      ['主题', (n.cluster && n.cluster.label) ? n.cluster.label : String(detailField(n, 'topicLabel') || '')],
    ];
    rows.forEach(([k, v]) => {
      if (!v) return;
      const row = el('div', 'kg-d-row');
      row.appendChild(el('dt', '', k));
      row.appendChild(el('dd', '', v));
      meta.appendChild(row);
    });
    body.appendChild(meta);
    // 「它和谁有关系、为什么」是点开节点最想知道的事，排在关键词 / 标签之前，
    // 免得用户在 340px 宽的面板里先滚过一大段元数据。
    body.appendChild(neighborSection(n));
    body.appendChild(chipSection('关键词', detailField(n, 'keywords')));
    body.appendChild(chipSection('标签', detailField(n, 'tags')));

    const acts = el('div', 'kg-d-actions');
    const hasPdf = n.data && n.data.hasPdf !== false;
    acts.appendChild(detailButton('打开 PDF', '', () => reveal(n.id, 'open'), !hasPdf, '该文献暂无 PDF'));
    acts.appendChild(detailButton('阅读这篇', '', () => openLiterature(n.id), false));
    acts.appendChild(detailButton('在库中定位', '', () => reveal(n.id, 'folder'), false));
    acts.appendChild(detailButton('修改标签', '', () => editTags(n), false));
    acts.appendChild(detailButton('重新整理主题', 'kg-btn-primary kg-rebuild', () => rebuild(), false));
    body.appendChild(acts);
    root.appendChild(body);
  }

  function openDetail(id) {
    const n = S.nodes.find((x) => x.id === id);
    if (!n) return;
    S.selected = id;
    S.nodes.forEach((x) => { if (x.g) x.g.classList.toggle('is-selected', x.id === id); });
    markNeighborhood(n);
    buildDetail(n);
    S.refs.detail.classList.add('is-open');
    hideTip();
  }

  function closeDetail() {
    S.selected = null;
    S.nodes.forEach((x) => { if (x.g) x.g.classList.remove('is-selected'); });
    clearNeighborhood();
    const d = S.refs.detail;
    if (d) {
      d.classList.remove('is-open');
      d.textContent = '';
    }
    clearBucket('detail');
  }

  function editTags(n) {
    const cur = detailField(n, 'tags');
    const list = Array.isArray(cur) ? cur.join(', ') : String(cur || '');
    let input;
    try { input = window.prompt('用逗号分隔输入标签', list); } catch (_) { return; }
    if (input == null) return;
    const tags = input.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    api(`/api/literature/${encodeURIComponent(n.id)}`, { method: 'PATCH', body: { tags } })
      .then(() => { toast('标签已更新', 'success'); return load(); })
      .catch((err) => toast((err && err.message) || '标签保存失败', 'error'));
  }

  function rebuild() {
    const buttons = S.root ? S.root.querySelectorAll('.kg-rebuild') : [];
    buttons.forEach((b) => {
      b.disabled = true;
      if (!b.dataset.label) b.dataset.label = b.textContent || 'AI 重新聚类';
      b.textContent = '聚类中…';
    });
    // 走「大模型聚类」而不是本地重建：本地词面相似度常把中文文献熔成一两坨
    setStatus('loading', '正在用大模型按研究主题归类…文献多时会分几批跑，约 1~3 分钟');
    api('/api/knowledge/recluster', { method: 'POST' })
      .then((d) => {
        const t = Array.isArray(d && d.topics) ? d.topics.length : 0;
        const warn = d && d.warning ? `（部分失败：${d.warning}）` : '';
        toast(t ? `已用大模型分成 ${t} 个主题${warn}` : `已重新聚类${warn}`, warn ? 'info' : 'success');
        return load();
      })
      .catch((err) => {
        const msg = (err && err.message) || '重新聚类失败';
        toast(msg + '（已保留当前聚类结果）', 'error');
        return load();
      })
      .finally(() => {
        buttons.forEach((b) => {
          b.disabled = false;
          b.textContent = b.dataset.label || 'AI 重新聚类';
        });
      });
  }

  // ==================== 状态层（加载中 / 空 / 失败） ====================

  function setStatus(kind, msg) {
    const box = S.refs.status;
    if (!box) return;
    S.status = kind;
    clearBucket('status');
    box.textContent = '';
    if (kind === 'ok') { box.classList.add('is-off'); return; }
    box.classList.remove('is-off');
    const card = el('div', 'kg-status-card');
    if (kind === 'loading') {
      const line = el('div', 'kg-status-line');
      line.appendChild(el('span', 'kg-status-dot'));
      line.appendChild(el('span', '', msg || '正在构建知识图谱…'));
      card.appendChild(line);
    } else if (kind === 'empty') {
      card.appendChild(el('p', 'kg-status-text', '还没有可展示的文献关联。请先在文献库添加文献，或点击「重新聚类」生成主题。'));
    } else {
      card.appendChild(el('p', 'kg-status-text', '知识图谱加载失败：' + String(msg || '未知错误')));
      const retry = el('button', 'kg-btn', '重试');
      retry.type = 'button';
      listen(retry, 'click', () => load(), undefined, 'status');
      card.appendChild(retry);
    }
    box.appendChild(card);
  }

  // ==================== 尺寸 ====================

  function onResize() {
    const st = S.refs.stage;
    if (!st) return;
    const w = st.clientWidth;
    const h = st.clientHeight;
    if (!w || !h) return;                       // 视图隐藏时跳过
    if (w === S.W && h === S.H) return;
    S.W = w;
    S.H = h;
    if (S.nodes.length) {
      layoutCenters();
      startSim(S.layout && S.layout.single ? 90 : 60);
    }
    render();
  }

  // ==================== 生命周期 ====================

  function apply() {
    buildData();
    renderTopicOptions();
    renderStats();
    buildGraph();
    updateVisibility();
    // 重新加载时筛选条件还在（比如一直只看某个主题）：中心与半径要按当前可见成员重算，
    // 否则单主题视图会带着全量网格的坐标重新出现。
    layoutCenters();
    const has = S.nodes.length > 0;
    setStatus(has ? 'ok' : 'empty');
    startSim(has ? FRAMES : 0);
    if (S.selected) {
      const still = S.nodes.some((n) => n.id === S.selected);
      if (still) openDetail(S.selected);
      else closeDetail();
    }
  }

  async function load() {
    if (S.mounted) setStatus('loading');
    try {
      const data = await api('/api/knowledge/graph');
      if (!data || !Array.isArray(data.nodes)) throw new Error('返回数据格式不正确');
      S.data = data;
      S.items = itemsById();
      if (S.mounted) apply();
    } catch (err) {
      if (S.mounted) setStatus('error', (err && err.message) || '未知错误');
    }
  }

  function mount(container) {
    const host = container || (typeof document !== 'undefined' ? document.getElementById('viewGraph') : null);
    if (!host) return Promise.resolve();
    if (S.mounted && S.container === host) return load();
    if (S.mounted) close();
    S.container = host;
    S.mounted = true;
    S.reduced = typeof window !== 'undefined' && window.matchMedia
      ? !!window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false;
    buildDom(host);
    bind();
    onResize();
    return load();
  }

  function close() {
    if (S.raf) { window.cancelAnimationFrame(S.raf); S.raf = 0; }
    S.sim.running = false;
    if (S.ro) { try { S.ro.disconnect(); } catch (_) { /* ignore */ } S.ro = null; }
    ['global', 'nodes', 'detail', 'status'].forEach(clearBucket);
    hideTip();
    if (S.root && S.root.parentNode) S.root.parentNode.removeChild(S.root);
    S.mounted = false;
    S.container = null;
    S.root = null;
    S.refs = {};
    S.nodes = [];
    S.edges = [];
    S.clusters = [];
    S.topicList = [];
    S.items = new Map();
    S.elToNode = new WeakMap();
    S.selected = null;
    S.drag = null;
    S.status = 'idle';
    S.view = { scale: 1, tx: 0, ty: 0 };
    S.W = 0;
    S.H = 0;
    S.layout = { single: false, clusters: 0 };
    S.filter = { q: '', topic: '__all__', labels: true };
  }

  const GraphView = { mount, refresh: load, close };
  if (typeof window !== 'undefined') window.GraphView = GraphView;
  if (typeof module !== 'undefined' && module.exports) module.exports = GraphView;

  try { ensureStyles(); } catch (_) { /* 样式加载失败不影响功能 */ }
})();
