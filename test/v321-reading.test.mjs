// v321-reading.test.mjs —— v3.2.1：两种排版都同步缩放 + 文本重排可高亮
//
// 这些逻辑全在 app.js 的闭包与真实 DOM 里，单元测试只钉住契约，
// 像素与交互由 .debug/e2e-batch.mjs 在浏览器里验证。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const app = read('public/app.js');
const css = read('public/style.css');

const slice = (from, to) => app.slice(app.indexOf(from), app.indexOf(to));

test('缩放：版面还原与文本重排都跟随原文同比例变化', () => {
  const state = slice('const cmp = {', 'function cmpEl(id)');
  assert.match(state, /flowZoom: 1,/, '文本重排要有自己的等效缩放状态');
  const zoom = slice('function syncCmpZoomRatio(ratio)', 'function bindPdfReader()');
  assert.match(zoom, /if \(cmp\.style === 'page'\)/, '版面还原继续走 CmpPages.setZoom');
  assert.match(zoom, /setZoom\?\.\(z \* ratio\)/, '版面还原的同比例联动不能被改坏');
  assert.match(zoom, /cmp\.flowZoom = next/, '文本重排必须吃下同一个比例');
  assert.match(zoom, /applyCmpFlowFontScale\(getCmpFontScale\(\)\)/, '改完要立刻重算 CSS 变量');
  const fit = slice('function fitWidth() {', '/**\n   * 改原文缩放。');
  assert.match(fit, /cmp\.flowZoom = 1/, '「适宽」要把两边一起带回基线');
  const buttons = slice("function bindPdfReader()", 'function setAnnotationColor');
  assert.match(buttons, /zoomPdfBy\(0\.2\)/, '放大按钮还在');
  assert.match(buttons, /zoomPdfBy\(-0\.2\)/, '缩小按钮还在');
});

test('文本重排字号 = 用户字号偏好 × 缩放倍数', () => {
  const fsFn = slice('function applyCmpFlowFontScale(k)', 'function stepCmpFontScale(delta)');
  assert.match(fsFn, /cmp\.flowZoom/, '不能丢掉缩放倍数');
  assert.match(fsFn, /fs \* zoom/, '两个倍数要相乘后一次落地');
  assert.match(fsFn, /setProperty\('--ctp-fs'/, '仍然写回原来的 CSS 变量');
  assert.match(css, /\.cmp-block-text \{ font-size: calc\(13\.5px \* var\(--ctp-fs, 1\)\);/, '流式正文仍按变量定字号');
});

test('文本重排选区能产出 blockId + tr，走同一条标注链路', () => {
  assert.match(app, /function cmpFlowSelection\(sel\)/, '缺少文本重排选区入口');
  const fn = slice('function cmpFlowSelection(sel)', 'function captureSelection()');
  assert.match(fn, /box\.contains\(sel\.anchorNode\)/, '只处理文本重排容器里的选区');
  assert.match(fn, /holder !== endEl\?\.closest\?\.\('\.cmp-block'\)/, '跨块选区不能硬凑成一条标注');
  assert.match(fn, /pre\.setEnd\(range\.startContainer, range\.startOffset\)/, '起点要用 Range 精确计算');
  assert.match(fn, /kind: 'trans'/, '与版面译文共用同一类型');
  assert.match(fn, /blockId: id/, '没有块 id 就无法与原文互推');
  assert.match(fn, /tr: \{ from, to \}/, '没有字符区间就无法画标记');
  assert.match(fn, /rects: cmpTransRects/, '原文侧矩形同样按块内比例反推');
  const capture = slice('function captureSelection()', 'function findPageWrap(node)');
  assert.match(capture, /const fs = cmpFlowSelection\(sel\);[\s\S]{0,80}if \(fs\) return fs;/, '捕获选区时先认文本重排');
});

test('文本重排上的标注画法与原文同步', () => {
  const fn = slice('function applyCmpFlowMarks(anns)', 'function cmpBlockAtRect(page, rect)');
  assert.match(fn, /mark\.ctp-hl, span\.ctp-ul, span\.ctp-cm-range/, '重画前先清干净旧标记');
  assert.match(fn, /window\.CmpPages\?\.markRange/, '两套排版共用同一个区间包裹器');
  assert.match(fn, /ctp-cm-inline/, '批注在流式段落里也有可点小标');
});
