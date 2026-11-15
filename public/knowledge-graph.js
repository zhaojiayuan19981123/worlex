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
  const FRAMES = 180;            // 稳定前迭代帧数
  const REPULSION = 5200;        // 库仑斥力系数
  const SPRING_K = 0.018;        // 弹簧系数
  const DAMPING = 0.84;          // 速度阻尼
  const MAX_V = 14;              // 单帧最大位移
  const CLUSTER_K = 0.008;       // 向簇中心引力
  const CENTER_K = 0.0012;       // 向画布中心引力
  const TOPIC_COLORS = 8;        // 主题色数量（与 CSS 的 .t0~.t7 对应）

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
    head.appendChild(el('p', 'kg-sub', '按主题聚类呈现文献之间的关联，点击节点查看详细信息。'));
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

    const rebuild = el('button', 'kg-btn kg-btn-primary kg-rebuild', '重新聚类');
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
    if (/cite|ref|coauth|author|引用|共引/.test(k)) return 'e-weak';
    if (/topic|cluster|same|主题|同簇/.test(k)) return 'e-strong';
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
      edges.push({ s, t, kind: String((raw && raw.kind) || ''), w, visible: true, line: null });
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
    box.hidden = false;
    box.textContent = `${n(st.documents)} 篇文献 · ${n(st.topics)} 个主题 · ${n(st.relations)} 条关联`;
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
      label.textContent = c.label;
      r.clustersG.appendChild(hull);
      r.clustersG.appendChild(label);
      c.hull = hull;
      c.labelEl = label;
    }

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

  function layoutCenters() {
    const W = S.W || 800;
    const H = S.H || 600;
    const cx = W / 2;
    const cy = H / 2;
    const m = S.clusters.length;
    const ring = m <= 1 ? 0 : Math.max(60, Math.min(W, H) * 0.3);
    S.clusters.forEach((c, i) => {
      const a = (2 * Math.PI * i) / Math.max(1, m) - Math.PI / 2;
      c.x = cx + ring * Math.cos(a);
      c.y = cy + ring * Math.sin(a);
    });
  }

  function layoutInit() {
    layoutCenters();
    let seed = 987654321;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const cx = (S.W || 800) / 2;
    const cy = (S.H || 600) / 2;
    S.nodes.forEach((n) => {
      const c = n.cluster;
      n.x = (c ? c.x : cx) + (rnd() - 0.5) * 90;
      n.y = (c ? c.y : cy) + (rnd() - 0.5) * 90;
      n.vx = 0;
      n.vy = 0;
      n.fixed = false;
    });
  }

  function stepPhysics(alpha) {
    const nodes = S.nodes;
    const N = nodes.length;

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
        if (d2 > 90000) continue;
        if (d2 < 0.01) {
          dx = (i - j) * 0.01 || 0.01;
          dy = 0.01;
          d2 = dx * dx + dy * dy;
        }
        const d = Math.sqrt(d2);
        const f = REPULSION / (d2 + 40) * alpha;
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
      const rest = 110 - Math.min(50, e.w * 16);
      const f = SPRING_K * (d - rest) * alpha * (0.7 + 0.3 * Math.min(3, e.w));
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
        n.vx += (n.cluster.x - n.x) * CLUSTER_K * alpha;
        n.vy += (n.cluster.y - n.y) * CLUSTER_K * alpha;
      }
      n.vx += (cx - n.x) * CENTER_K * alpha;
      n.vy += (cy - n.y) * CENTER_K * alpha;
      n.vx *= DAMPING;
      n.vy *= DAMPING;
      const sp = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
      if (sp > MAX_V) { n.vx = n.vx / sp * MAX_V; n.vy = n.vy / sp * MAX_V; }
      n.x += n.vx;
      n.y += n.vy;
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
    render();
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
      c.r = max;
      c.hull.setAttribute('cx', c.x.toFixed(1));
      c.hull.setAttribute('cy', c.y.toFixed(1));
      c.hull.setAttribute('r', max.toFixed(1));
      if (c.labelEl) {
        c.labelEl.setAttribute('x', c.x.toFixed(1));
        c.labelEl.setAttribute('y', Math.max(16, c.y - max - 10).toFixed(1));
      }
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
    startSim(45);
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
    buildDetail(n);
    S.refs.detail.classList.add('is-open');
    hideTip();
  }

  function closeDetail() {
    S.selected = null;
    S.nodes.forEach((x) => { if (x.g) x.g.classList.remove('is-selected'); });
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
    buttons.forEach((b) => { b.disabled = true; });
    api('/api/knowledge/rebuild', { method: 'POST' })
      .then(() => { toast('已重新聚类', 'success'); return load(); })
      .catch((err) => toast((err && err.message) || '重新聚类失败', 'error'))
      .finally(() => { buttons.forEach((b) => { b.disabled = false; }); });
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
      line.appendChild(el('span', '', '正在构建知识图谱…'));
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
      startSim(60);
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
    S.filter = { q: '', topic: '__all__', labels: true };
  }

  const GraphView = { mount, refresh: load, close };
  if (typeof window !== 'undefined') window.GraphView = GraphView;
  if (typeof module !== 'undefined' && module.exports) module.exports = GraphView;

  try { ensureStyles(); } catch (_) { /* 样式加载失败不影响功能 */ }
})();
