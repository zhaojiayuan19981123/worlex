/* direction-viz.js —— 分析报告可视化：词云 + 主题关系图（纯 SVG，无第三方依赖）
 *
 * 数据全部来自报告本身：overview / gaps / directions / clusters / cautions，
 * 以及参与分析的文献标题。中文没有分词库，这里用 2~4 gram + 停用词做轻量提取，
 * 足够呈现「这批文献在反复讨论什么」，不追求语言学意义上的精确分词。
 */
(() => {
  'use strict';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const EN_STOP = new Set('the a an and or of in on for to with by from as is are was were be been being this that these those it its into at our we their they can may using use used based new via about between within across have has had do does not no more most such than then also which what when where how why all any each other some only both through over under while however therefore thus study studies paper papers research results result method methods approach model models data analysis show shows shown find finds found propose proposed'.split(/\s+/));
  const ZH_STOP = ['研究', '方法', '本文', '我们', '提出', '一种', '基于', '通过', '可以', '进行', '分析', '结果', '表明', '发现', '本文提出', '这些', '这个', '以及', '并且', '对于', '由于', '因此', '但是', '如果', '其他', '不同', '问题', '文献', '论文', '实验', '模型', '数据', '领域'];

  function add(counts, word, weight) {
    const w = String(word || '').trim();
    if (!w) return;
    if (/^[a-zA-Z][\w-]{2,}$/.test(w)) {
      const k = w.toLowerCase();
      if (EN_STOP.has(k) || k.length < 3) return;
      counts.set(k, (counts.get(k) || 0) + weight);
      return;
    }
    if (!/[\u4e00-\u9fa5]/.test(w)) return;
    for (const n of [2, 3]) {
      for (let i = 0; i + n <= w.length; i += 1) {
        const g = w.slice(i, i + n);
        if (ZH_STOP.includes(g)) continue;
        counts.set(g, (counts.get(g) || 0) + weight / n);
      }
    }
  }

  /** 报告文本 → [{text, weight}]：簇名 / 空白标题 / 方向标题权重更高 */
  function extractTerms(analysis, papers) {
    const counts = new Map();
    const a = analysis || {};
    const push = (text, weight) => {
      String(text || '').split(/[\s,，。；;：:（）()\[\]【】"'’“”·、/\\|]+/).forEach((w) => add(counts, w, weight));
    };
    (a.clusters || []).forEach((c) => push(c.name, 5));
    (a.gaps || []).forEach((g) => push(`${g.title} ${g.statement || ''}`, 3));
    (a.directions || []).forEach((d) => push(`${d.title} ${d.question || ''}`, 3));
    push(a.overview, 2);
    (a.cautions || []).forEach((c) => push(c, 1));
    (papers || []).slice(0, 50).forEach((p) => push(p.titleZh || p.title || '', 1));
    // 去掉被更长词完全包含且频次接近的碎片（如「图神 / 神经网 / 网络」留下「神经网络」）
    const sorted = [...counts.entries()].filter(([w, n]) => n >= 1.5).sort((x, y) => y[1] - x[1]);
    const kept = [];
    for (const [word, weight] of sorted) {
      if (kept.length >= 45) break;
      const shadowed = kept.some((k) => k.weight >= weight * 0.9 && k.word.includes(word) && k.word.length > word.length);
      if (!shadowed) kept.push({ word, weight });
    }
    return kept.slice(0, 40);
  }

  function wordCloudSvg(analysis, papers) {
    const terms = extractTerms(analysis, papers);
    const W = 720, H = 320, cx = W / 2, cy = H / 2;
    if (!terms.length) return '<div class="dir-viz-empty">报告文本太短，提不出足够的关键词</div>';
    const max = terms[0].weight;
    const placed = [];
    const colors = ['var(--primary)', 'var(--accent-coral)', 'var(--accent-gold)', 'var(--text-2)', 'var(--primary)'];
    for (let i = 0; i < terms.length; i += 1) {
      const t = terms[i];
      const size = Math.round(13 + 25 * Math.sqrt(t.weight / max));
      const cjk = /[\u4e00-\u9fa5]/.test(t.word);
      const width = t.word.length * size * (cjk ? 1.02 : 0.58);
      const height = size * 1.25;
      let put = null;
      for (let step = 0; step < 260 && !put; step += 1) {
        const angle = i * 2.39996 + step * 0.16;
        const radius = (i === 0 ? 0 : 18 + Math.sqrt(i) * 17) + step * 1.3;
        const x = cx + Math.cos(angle) * radius * 1.5;
        const y = cy + Math.sin(angle) * radius * 0.78;
        if (x - width / 2 < 6 || x + width / 2 > W - 6 || y - height / 2 < 6 || y + height / 2 > H - 6) continue;
        const hit = placed.some((p) => Math.abs(x - p.x) < (width + p.w) / 2 + 4 && Math.abs(y - p.y) < (height + p.h) / 2 + 3);
        if (!hit) put = { x, y };
      }
      if (!put) continue;
      placed.push({ ...put, w: width, h: height });
      t._xy = put; t._size = size;
    }
    const nodes = terms.filter((t) => t._xy).map((t, i) => `
      <text x="${t._xy.x.toFixed(1)}" y="${t._xy.y.toFixed(1)}" text-anchor="middle" dominant-baseline="central"
        font-size="${t._size}" font-weight="${t._size > 26 ? 700 : 600}" fill="${colors[i % colors.length]}"
        style="fill:${colors[i % colors.length]}">${esc(t.word)}</text>`).join('');
    return `<svg class="dir-viz-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="报告关键词词云">${nodes}</svg>`;
  }

  function graphSvg(analysis, papers) {
    const a = analysis || {};
    const nodes = [];
    (a.clusters || []).slice(0, 8).forEach((c, i) => nodes.push({ id: `c${i}`, label: c.name || `主题 ${i + 1}`, type: 'cluster', papers: new Set(c.papers || []) }));
    (a.gaps || []).slice(0, 6).forEach((g, i) => nodes.push({ id: `g${i}`, label: g.title || `空白 ${i + 1}`, type: 'gap', papers: new Set(g.evidence || []) }));
    (a.directions || []).slice(0, 6).forEach((d, i) => nodes.push({ id: `d${i}`, label: d.title || `方向 ${i + 1}`, type: 'direction', papers: new Set(d.evidence || []) }));
    if (!nodes.length) return '<div class="dir-viz-empty">报告没有可绘制的主题 / 空白 / 方向节点</div>';

    const edges = [];
    const overlap = (x, y) => [...x].filter((n) => y.has(n)).length;
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const w = overlap(nodes[i].papers, nodes[j].papers);
        if (w > 0) edges.push({ a: nodes[i].id, b: nodes[j].id, w });
      }
    }

    // 简单力导向：斥力 + 边引力 + 回中力；节点数 ≤20，固定迭代足够稳定
    const W = 720, H = 360, cx = W / 2, cy = H / 2;
    nodes.forEach((n, i) => {
      const angle = (i / nodes.length) * Math.PI * 2;
      n.x = cx + Math.cos(angle) * 150 + (i % 3) * 6;
      n.y = cy + Math.sin(angle) * 120 + (i % 2) * 8;
      n.vx = 0; n.vy = 0;
    });
    const at = new Map(nodes.map((n) => [n.id, n]));
    for (let iter = 0; iter < 170; iter += 1) {
      for (const n of nodes) {
        let fx = (cx - n.x) * 0.006, fy = (cy - n.y) * 0.006;
        for (const m of nodes) {
          if (m === n) continue;
          const dx = n.x - m.x, dy = n.y - m.y;
          const d2 = Math.max(100, dx * dx + dy * dy);
          const f = 5200 / d2;
          fx += dx * f / Math.sqrt(d2); fy += dy * f / Math.sqrt(d2);
        }
        n.vx = (n.vx + fx) * 0.78; n.vy = (n.vy + fy) * 0.78;
      }
      for (const e of edges) {
        const a1 = at.get(e.a), b1 = at.get(e.b);
        const dx = b1.x - a1.x, dy = b1.y - a1.y;
        const d = Math.max(1, Math.hypot(dx, dy));
        const f = Math.min(0.9, (d - 110) * 0.008 * Math.min(2, e.w));
        a1.vx += dx / d * f; a1.vy += dy / d * f;
        b1.vx -= dx / d * f; b1.vy -= dy / d * f;
      }
      for (const n of nodes) {
        n.x = Math.max(62, Math.min(W - 62, n.x + n.vx));
        n.y = Math.max(30, Math.min(H - 30, n.y + n.vy));
      }
    }
    const tone = { cluster: 'var(--primary)', gap: 'var(--accent-coral)', direction: 'var(--accent-gold)' };
    const lines = edges.map((e) => {
      const a1 = at.get(e.a), b1 = at.get(e.b);
      return `<line x1="${a1.x.toFixed(1)}" y1="${a1.y.toFixed(1)}" x2="${b1.x.toFixed(1)}" y2="${b1.y.toFixed(1)}" stroke="var(--border)" stroke-width="${Math.min(3, 1 + e.w)}" opacity="0.85"/>`;
    }).join('');
    const dots = nodes.map((n) => {
      const base = n.type === 'cluster' ? 19 : n.type === 'gap' ? 15 : 13;
      const label = String(n.label).length > 14 ? String(n.label).slice(0, 13) + '…' : n.label;
      return `<g><circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${base}" fill="var(--surface)" stroke="${tone[n.type]}" stroke-width="2"/>
        <text x="${n.x.toFixed(1)}" y="${(n.y + base + 15).toFixed(1)}" text-anchor="middle" font-size="11" fill="var(--text-2)" style="fill:var(--text-2)">${esc(label)}</text></g>`;
    }).join('');
    const note = edges.length ? '' : '<text x="360" y="22" text-anchor="middle" font-size="11" fill="var(--text-3)" style="fill:var(--text-3)">节点间没有共同证据文献，按独立主题展示</text>';
    return `<svg class="dir-viz-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="报告主题关系图">${note}${lines}${dots}</svg>`;
  }

  window.DirectionViz = { wordCloudSvg, graphSvg, extractTerms };
})();
