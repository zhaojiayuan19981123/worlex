// v216-features.test.mjs —— 图谱重设计：平涂圆点、半径读关联数、点击后深浅读相关性
//
// 这一版把「颜色深浅」从常驻编码里拿掉了：
//   - 圆点必须平涂（不许有高光 / 渐变 / 外发光）
//   - 半径由 deg 直接决定（连得越多，圆越大）
//   - 只有点开某个节点，它的邻居才按相关度上深浅，其余节点压暗
// 这三条是这一版设计的立身之本，任何一条被改回去都要在这里断下来。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const norm = (s) => s.replace(/\r\n/g, '\n');
const read = (p) => norm(readFileSync(new URL(`../public/${p}`, import.meta.url), 'utf8'));

test('图谱节点：半径 = 关联文献数，颜色不参与「连得多不多」', () => {
  const g = read('knowledge-graph.js');
  assert.match(g, /nodes\.forEach\(\(n\) => \{ n\.r = 4\.6 \+ 8\.4 \* \(n\.deg \/ maxDeg\); \}\);/);
  // 旧的「按度数排名算浓淡」必须已经拆掉，否则颜色会和半径抢同一个含义
  assert.doesNotMatch(g, /n\.shade/);
  assert.doesNotMatch(g, /rankOf\(/);
});

test('图谱节点：平涂，没有任何高光 / 渐变', () => {
  const g = read('knowledge-graph.js');
  const css = read('knowledge-graph.css');
  assert.doesNotMatch(g, /kgGloss/);
  assert.doesNotMatch(g, /radialGradient/);
  assert.doesNotMatch(css, /kg-gloss/);
  assert.doesNotMatch(css, /url\(#kgGloss\)/);
  // 圆点就是「主题色之一 + 白圈」两件事
  assert.match(css, /\.kg-disc \{\n  fill: color-mix\(in srgb, var\(--kg-hue, var\(--ink-3\)\) var\(--kg-fill, 76%\), var\(--surface\)\);\n  stroke: var\(--surface\);\n  stroke-width: 1\.5;\n\}/);
});

test('图谱节点：只有选中时按相关度上深浅，越深越相关', () => {
  const g = read('knowledge-graph.js');
  const css = read('knowledge-graph.css');
  // 相关度 = 两篇之间所有边权重之和（同关键词 + 同方法 + 同对象 可以叠加）
  assert.match(g, /strength\.set\(other\.id, \(strength\.get\(other\.id\) \|\| 0\) \+ e\.w\);/);
  // 按档位铺开到 52%~100%，同分并列同色
  assert.match(g, /const t = lastLevel > 0 \? levels\.indexOf\(s\) \/ lastLevel : 0\.75;/);
  assert.match(g, /Math\.round\(52 \+ 48 \* t\) \+ '%'/);
  assert.match(g, /if \(on\) x\.g\.style\.setProperty\('--kg-fill', fill\);/);
  // 取消选中要把深浅清掉，否则下次点开还带着上一轮的颜色
  assert.match(g, /x\.g\.style\.removeProperty\('--kg-fill'\);/);
  // 没选中时邻居不该有深色描边盖住填充
  assert.match(css, /\.kg-node\.is-near \.kg-disc \{ stroke: var\(--surface\); stroke-width: 2; \}/);
});

test('图谱配色：三套主题各有一份马卡龙色板', () => {
  const css = read('knowledge-graph.css');
  const blocks = css.split('[data-theme="dark"]');
  assert.equal(blocks.length, 2, '应有一块深色主题');
  const sepia = css.split('[data-theme="sepia"]');
  assert.equal(sepia.length, 2, '应有一块护眼主题');
  for (let i = 0; i < 8; i += 1) {
    const re = new RegExp(`--kg-c${i}: #[0-9a-f]{6};`);
    const hits = css.match(new RegExp(re.source, 'g')) || [];
    assert.equal(hits.length, 3, `--kg-c${i} 应在浅色 / 深色 / 护眼各声明一次`);
  }
  // 主题簇的底色也跟着各自的色相走，不再是统一灰
  assert.match(css, /\.kg-hull \{\n  fill: color-mix\(in srgb, var\(--kg-hue, var\(--ink-3\)\) 9%, transparent\);/);
  assert.match(css, /\.kg-root \.t7 \{ --kg-hue: var\(--kg-c7\); \}/);
});

test('图谱界面：图例说明「圆越大」，副标题说明「点击后越深越相关」', () => {
  const g = read('knowledge-graph.js');
  assert.match(g, /el\('span', 'kg-legend-text', '圆越大，相连的文献越多'\)/);
  assert.match(g, /点击任一节点：颜色越深，说明它和这一篇越相关/);
  // 主题色卡：把「哪个主题是哪种糖色」摆到统计行
  assert.match(g, /const dot = el\('span', `kg-swatch t\$\{c\.color\}`\);/);
});
