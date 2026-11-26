/* direction-viz.js —— 分析报告可视化：词云 + 主题关系图（纯 SVG，无第三方依赖）
 *
 * v3.1 起数据**只来自大模型**：分析提示词要求模型基于所选英文摘要输出
 * analysis.visualization = { keywords, nodes, edges }，且所有文字必须是英文。
 * 这里不再做任何本地中文分词 / 从标题提词，避免词云里混进中文或脱离摘要。
 * 模型没给数据时显示「请重新分析」的提示，而不是拿旧报告的文字硬凑。
 */
(() => {
  'use strict';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const CJK = /[\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af\uf900-\ufaff]/;
  const cleanEn = (v) => String(v == null ? '' : v)
    .replace(CJK, ' ')
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  /** 供前端/测试读取：模型给出的英文关键词（已再做一次纯英文过滤） */
  function extractTerms(analysis) {
    const seen = new Set();
    const out = [];
    for (const item of (analysis?.visualization?.keywords || [])) {
      const text = cleanEn(item?.text || item);
      if (!text || !/[a-z]{2}/i.test(text)) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ word: text, weight: Number(item?.weight) > 0 ? Number(item.weight) : 2 });
      if (out.length >= 40) break;
    }
    return out.sort((a, b) => b.weight - a.weight);
  }

  function wordCloudSvg(analysis) {
    const terms = extractTerms(analysis);
    const W = 720, H = 330, cx = W / 2, cy = H / 2;
    if (!terms.length) return '<div class="dir-viz-empty">这份报告没有模型生成的英文关键词，请重新点「开始分析」。</div>';
    const max = terms[0].weight;
    const placed = [];
    const colors = ['var(--primary)', 'var(--accent-coral)', 'var(--accent-gold)', 'var(--text-2)', 'var(--primary)'];
    for (let i = 0; i < terms.length; i += 1) {
      const t = terms[i];
      const baseSize = Math.round(12 + 22 * Math.sqrt(t.weight / max));
      // 放不下就逐级缩小字号，缩到 10px 仍挤不进就丢弃，避免文字被裁掉半截
      for (const scale of [1, 0.82, 0.68, 0.56]) {
        if (t._xy) break;
        const size = Math.max(10, Math.round(baseSize * scale));
        const width = t.word.length * size * 0.58;
        const height = size * 1.2;
        for (let step = 0; step < 360 && !t._xy; step += 1) {
          const angle = i * 2.39996 + step * 0.16;
          const radius = (i === 0 ? 0 : 16 + Math.sqrt(i) * 16) + step * 1.2;
          const x = cx + Math.cos(angle) * radius * 1.5;
          const y = cy + Math.sin(angle) * radius * 0.74;
          if (x - width / 2 < 10 || x + width / 2 > W - 10 || y - height / 2 < 10 || y + height / 2 > H - 10) continue;
          const hit = placed.some((p) => Math.abs(x - p.x) < (width + p.w) / 2 + 6 && Math.abs(y - p.y) < (height + p.h) / 2 + 4);
          if (!hit) t._xy = { x, y }, t._size = size;
        }
      }
      if (!t._xy) continue;
      placed.push({ ...t._xy, w: t.word.length * t._size * 0.58, h: t._size * 1.2 });
    }
    const nodes = terms.filter((t) => t._xy).map((t, i) => `
      <text x="${t._xy.x.toFixed(1)}" y="${t._xy.y.toFixed(1)}" text-anchor="middle" dominant-baseline="central"
        font-size="${t._size}" font-weight="${t._size > 24 ? 700 : 600}" fill="${colors[i % colors.length]}"
        style="fill:${colors[i % colors.length]}">${esc(t.word)}</text>`).join('');
    return `<svg class="dir-viz-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Abstract keyword cloud">${nodes}</svg>`;
  }

  function graphSvg(analysis) {
    const viz = analysis?.visualization || {};
    const ids = new Set();
    const nodes = [];
    for (const item of (viz.nodes || []).slice(0, 10)) {
      const label = cleanEn(item?.label);
      if (!label || !/[a-z]{2}/i.test(label)) continue;
      let id = cleanEn(item?.id).replace(/[^a-zA-Z0-9_-]/g, '');
      if (!id) id = `n${nodes.length + 1}`;
      while (ids.has(id)) id = `${id}_${nodes.length + 1}`;
      ids.add(id);
      const type = ['theme', 'gap', 'direction'].includes(item?.type) ? item.type : 'theme';
      nodes.push({
        id, label, type,
        summary: cleanEn(item?.summary),
        papers: new Set(Array.isArray(item?.papers) ? item.papers : []),
        x: 0, y: 0, vx: 0, vy: 0,
      });
    }
    if (!nodes.length) return '<div class="dir-viz-empty">这份报告没有模型生成的主题关系数据，请重新点「开始分析」。</div>';

    // 模型给的语义边优先；同向关系/共同证据都可以画线，线宽表示强度。
    const edges = [];
    const seen = new Set();
    for (const item of (viz.edges || []).slice(0, 20)) {
      const a = cleanEn(item?.source).replace(/[^a-zA-Z0-9_-]/g, '');
      const b = cleanEn(item?.target).replace(/[^a-zA-Z0-9_-]/g, '');
      if (!ids.has(a) || !ids.has(b) || a === b) continue;
      const key = [a, b].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ a, b, w: Math.max(1, Math.min(5, Number(item?.weight) || 1)), label: cleanEn(item?.label) });
    }

    // 简单力导向：斥力 + 边引力 + 回中力；节点数 ≤10，固定迭代足够稳定
    const W = 720, H = 400, cx = W / 2, cy = H / 2;
    const radiusOf = (n) => (n.type === 'theme' ? 19 : n.type === 'gap' ? 15 : 13);
    nodes.forEach((n, i) => {
      const angle = (i / nodes.length) * Math.PI * 2;
      n.x = cx + Math.cos(angle) * 165 + (i % 3) * 6;
      n.y = cy + Math.sin(angle) * 125 + (i % 2) * 8;
    });
    const at = new Map(nodes.map((n) => [n.id, n]));
    for (let iter = 0; iter < 220; iter += 1) {
      for (const n of nodes) {
        let fx = (cx - n.x) * 0.008, fy = (cy - n.y) * 0.008;
        for (const m of nodes) {
          if (m === n) continue;
          const dx = n.x - m.x, dy = n.y - m.y;
          const d2 = Math.max(100, dx * dx + dy * dy);
          // 斥力按各自半径放大，避免圆和下方标签压到一起
          const f = 12000 / d2;
          fx += dx * f / Math.sqrt(d2); fy += dy * f / Math.sqrt(d2);
        }
        n.vx = (n.vx + fx) * 0.76; n.vy = (n.vy + fy) * 0.76;
      }
      for (const e of edges) {
        const a1 = at.get(e.a), b1 = at.get(e.b);
        const dx = b1.x - a1.x, dy = b1.y - a1.y;
        const d = Math.max(1, Math.hypot(dx, dy));
        const f = Math.min(0.9, (d - 165) * 0.008 * Math.min(2, e.w));
        a1.vx += dx / d * f; a1.vy += dy / d * f;
        b1.vx -= dx / d * f; b1.vy -= dy / d * f;
      }
      for (const n of nodes) {
        n.x = Math.max(80, Math.min(W - 80, n.x + n.vx));
        n.y = Math.max(36, Math.min(H - 56, n.y + n.vy));
      }
    }

    // 标签落位：默认贴节点下方，若与别的节点 / 已放标签冲突就翻到上方或左右错开
    const labelW = (n) => (Math.min(n.label.length, 22)) * 6.1 + 8;
    const boxes = [];
    const boxOf = (c, lw) => {
      const left = c.anchor === 'middle' ? c.x - lw / 2 : c.anchor === 'start' ? c.x : c.x - lw;
      return { l: left, r: left + lw, t: c.y - 7.5, b: c.y + 7.5 };
    };
    for (const n of nodes) {
      const lw = labelW(n), r = radiusOf(n);
      const candidates = [
        { x: n.x, y: n.y + r + 13, anchor: 'middle' },
        { x: n.x, y: n.y - r - 8, anchor: 'middle' },
        { x: n.x + r + 6, y: n.y + 4, anchor: 'start' },
        { x: n.x - r - 6, y: n.y + 4, anchor: 'end' },
      ];
      let chosen = candidates[0];
      let chosenBox = boxOf(chosen, lw);
      for (const c of candidates) {
        const box = boxOf(c, lw);
        const inside = box.l > 4 && box.r < W - 4 && box.t > 12 && box.b < H - 4;
        const hitNode = nodes.some((m) => m !== n && Math.hypot(m.x - c.x, m.y - c.y) < radiusOf(m) + 7);
        const hitLabel = boxes.some((b2) => !(box.r < b2.l - 2 || box.l > b2.r + 2 || box.b < b2.t - 2 || box.t > b2.b + 2));
        if (inside && !hitNode && !hitLabel) { chosen = c; chosenBox = box; break; }
      }
      boxes.push(chosenBox);
      n._label = chosen;
    }
    const tone = { theme: 'var(--primary)', gap: 'var(--accent-coral)', direction: 'var(--accent-gold)' };
    const lines = edges.map((e) => {
      const a1 = at.get(e.a), b1 = at.get(e.b);
      return `<line x1="${a1.x.toFixed(1)}" y1="${a1.y.toFixed(1)}" x2="${b1.x.toFixed(1)}" y2="${b1.y.toFixed(1)}" stroke="var(--border)" stroke-width="${Math.min(3.5, 0.9 + e.w * 0.5)}" opacity="0.9"/>`;
    }).join('');
    const dots = nodes.map((n) => {
      const base = radiusOf(n);
      const label = n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label;
      return `<g><circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${base}" fill="var(--surface)" stroke="${tone[n.type]}" stroke-width="2"/>
        <text x="${n._label.x.toFixed(1)}" y="${n._label.y.toFixed(1)}" text-anchor="${n._label.anchor}" font-size="11"
          fill="var(--text-2)" style="fill:var(--text-2)" stroke="var(--surface)" stroke-width="3" paint-order="stroke">${esc(label)}</text></g>`;
    }).join('');
    const note = edges.length ? '' : '<text x="360" y="22" text-anchor="middle" font-size="11" fill="var(--text-3)" style="fill:var(--text-3)">No relations returned by the model</text>';
    return `<svg class="dir-viz-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Topic relation graph">${note}${lines}${dots}</svg>`;
  }

  window.DirectionViz = { wordCloudSvg, graphSvg, extractTerms };
})();
