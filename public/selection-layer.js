// selection-layer.js —— 划词选区的「按行合并」绘制层
// 原生 ::selection 直接画在逐 text-item 的 span 上：行盒用整个 em 高度定位，
// 相邻行 y 方向互相压住，行尾又被各自 scaleX 拉得参差不齐。
// 这里接管可见选区：把 getClientRects() 按基线分带、同行合并、统一行高，
// 画成干净整齐的矩形；同时把合并结果交给批注存储（app.js 复用 mergeLineRects）。
(function () {
  'use strict';

  /**
   * 把一组矩形按「同一行」合并。
   * 输入/输出均为 {x1,y1,x2,y2}，与坐标系无关（屏幕像素或 PDF 归一化坐标都可用）。
   * @param {Array} rects
   * @param {number} tol 行高容差系数：同一带内的中心距 < tol×中位高度视为同一行
   */
  function mergeLineRects(rects, tol) {
    const list = (Array.isArray(rects) ? rects : [])
      .map((r) => {
        if (Array.isArray(r)) return { x1: +r[0], y1: +r[1], x2: +r[2], y2: +r[3] };
        return { x1: +(r?.x1), y1: +(r?.y1), x2: +(r?.x2), y2: +(r?.y2) };
      })
      .filter((r) => [r.x1, r.y1, r.x2, r.y2].every(Number.isFinite) && r.x2 > r.x1 && r.y2 > r.y1);
    if (!list.length) return [];
    const heights = list.map((r) => r.y2 - r.y1).sort((a, b) => a - b);
    const medianH = heights[Math.floor(heights.length / 2)] || 1;
    const factor = Number.isFinite(+tol) && +tol > 0 ? +tol : 0.62;

    // ① 按 y 中心分带（同一行的多个片段归到一组）
    list.sort((a, b) => (a.y1 + a.y2) / 2 - (b.y1 + b.y2) / 2 || a.x1 - b.x1);
    const bands = [];
    for (const r of list) {
      const cy = (r.y1 + r.y2) / 2;
      let band = bands.find((b) => Math.abs(b.cy - cy) <= medianH * factor);
      if (!band) { band = { cy, rects: [] }; bands.push(band); }
      band.rects.push(r);
      band.cy = band.rects.reduce((s, x) => s + (x.y1 + x.y2) / 2, 0) / band.rects.length;
    }

    // ② 每条带内按 x 连通段合并（多栏文本不要被一行大矩形横向糊住）
    const out = [];
    for (const band of bands) {
      const runs = [];
      band.rects.sort((a, b) => a.x1 - b.x1);
      for (const r of band.rects) {
        const last = runs[runs.length - 1];
        const gap = last ? r.x1 - last.x2 : Infinity;
        if (last && gap <= medianH * 1.6) {
          last.x1 = Math.min(last.x1, r.x1);
          last.x2 = Math.max(last.x2, r.x2);
          last.y1 = Math.min(last.y1, r.y1);
          last.y2 = Math.max(last.y2, r.y2);
        } else {
          runs.push({ x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 });
        }
      }
      // ③ 统一行高与基线：消除上下相邻矩形的重叠，边缘对齐到同一水平带
      for (const run of runs) {
        const cy = band.cy;
        const h = Math.max(medianH, Math.min(run.y2 - run.y1, medianH * 1.25));
        out.push({ x1: run.x1, y1: cy - h / 2, x2: run.x2, y2: cy + h / 2 });
      }
    }
    return out.sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1);
  }

  function layerOf(wrap, create) {
    let layer = wrap.querySelector(':scope > .pr-sel-layer');
    if (!layer && create) {
      layer = document.createElement('div');
      layer.className = 'pr-sel-layer';
      layer.style.width = wrap.style.width || (wrap.clientWidth + 'px');
      layer.style.height = wrap.style.height || (wrap.clientHeight + 'px');
      wrap.appendChild(layer);
    }
    return layer;
  }

  function clear() {
    document.querySelectorAll('.pr-sel-layer').forEach((n) => n.remove());
  }

  /** 用屏幕坐标的选区矩形画整齐的蓝色高亮 */
  function show(wrap, clientRects) {
    clear();
    if (!wrap || !Array.isArray(clientRects) || !clientRects.length) return;
    const box = wrap.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const raw = clientRects
      .filter((r) => r && r.width > 0 && r.height > 0)
      .map((r) => ({ x1: r.left, y1: r.top, x2: r.right, y2: r.bottom }));
    const merged = mergeLineRects(raw);
    if (!merged.length) return;
    const layer = layerOf(wrap, true);
    for (const r of merged) {
      const d = document.createElement('div');
      d.className = 'pr-sel-box';
      d.style.left = (r.x1 - box.left) + 'px';
      d.style.top = (r.y1 - box.top) + 'px';
      d.style.width = Math.max(1, r.x2 - r.x1) + 'px';
      d.style.height = Math.max(1, r.y2 - r.y1) + 'px';
      layer.appendChild(d);
    }
  }

  /** 监听选区变化，实时重绘；阅读模式（重排视图）不接管 */
  function bind() {
    let raf = 0;
    const update = () => {
      raf = 0;
      const sel = window.getSelection?.();
      if (!sel || sel.isCollapsed || !sel.rangeCount) { clear(); return; }
      const node = sel.anchorNode;
      let el = node?.nodeType === 1 ? node : node?.parentElement;
      let wrap = null;
      let inTextLayer = false;
      while (el) {
        if (el.classList?.contains('pr-text-layer')) inTextLayer = true;
        if (el.classList?.contains('pr-page-wrap')) { wrap = el; break; }
        el = el.parentElement;
      }
      if (!wrap || !inTextLayer) { clear(); return; }
      let rects = [];
      try { rects = [...sel.getRangeAt(0).getClientRects()]; } catch (_) { /* ignore */ }
      show(wrap, rects);
    };
    document.addEventListener('selectionchange', () => {
      if (raf) return;
      raf = requestAnimationFrame(update);
    });
    // 点击空白处、换页、缩放时清掉残留（下一次 selectionchange 会重画）
    document.addEventListener('pointerdown', (e) => {
      if (e.target?.closest?.('.pr-sel-layer')) return;
      setTimeout(() => { if (window.getSelection?.()?.isCollapsed) clear(); }, 0);
    }, true);
  }

  const api = { mergeLineRects, show, clear, bind };
  if (typeof window !== 'undefined') window.SelectionLayer = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
