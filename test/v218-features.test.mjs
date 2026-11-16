// v218-features.test.mjs —— 打印「版面还原的译文」
//
// 需求：点打印时，除了原文页与解析结果，还要能把**版面还原版的译文**打出来
// （文字块填回原坐标、图表表格原样保留），而不是文本重排那种连续流。
//
// 实现上最容易走偏的两条路，这里都锁住：
//   ① 另写一套排版 → 纸上和屏幕迟早是两种版式。必须复用 layoutLayer / fitPage。
//   ② 打印时把阅读器状态改坏 → 必须在 finally 里原样换回。
// 还有一条 CSS 陷阱：离屏排版台若用 display:none，量到的宽高是 0，字号全错。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const norm = (s) => s.replace(/\r\n/g, '\n');
const read = (p) => norm(readFileSync(new URL(`../public/${p}`, import.meta.url), 'utf8'));

function between(src, start, end) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `锚点没找到：${start} … ${end}`);
  return src.slice(i, j);
}

test('打印预览：页签是「原文 / 译文 / 解析结果」，译文排在解析结果之前', () => {
  const html = read('index.html');
  const seg = between(html, 'id="ppSeg"', '</div>');
  const modes = [...seg.matchAll(/data-ppmode="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(modes, ['pdf', 'trans', 'analysis'], `页签顺序变了：${modes.join(',')}`);
  assert.match(seg, /data-ppmode="trans"[^>]*title="[^"]*原版面[^"]*"/);
});

test('译文页：复用译文栏的排版函数，不另写一套', () => {
  const js = read('cmp-pages.js');
  // paintLayer 必须只是「取这一页的块，交给 layoutLayer」
  const paint = between(js, 'function paintLayer(n)', 'function layoutLayer(');
  assert.match(paint, /layoutLayer\(rec\.layer, rec\.wrap, state\.byPage\.get\(n\) \|\| \[\], pageSize\(n\), n\)/);
  // layoutLayer 必须真的去调 fitPage（本页统一字号的唯一来源）
  const layout = between(js, 'function layoutLayer(', '/**\n   * 一页一次排版');
  assert.match(layout, /fitPage\(pageNo, jobs\)/);
  // 导出
  assert.match(between(js, 'window.CmpPages = {', '};'), /printPages,/);
});

test('译文打印：每页一张纸，页宽按 A4 可打印宽度，底图单独高清重画', () => {
  const js = read('cmp-pages.js');
  // 纸宽 = A4 去掉 12mm 页边距后的可打印宽度（96dpi 下 703px），底图倍率单独一个常量
  assert.match(js, /const PRINT_W = 703/);
  assert.match(js, /const PRINT_IMG_X = 1\.8/);
  const seg = between(js, 'async function buildPrintSheet(', 'async function printPages(');
  assert.match(seg, /page\.getViewport\(\{ scale: scale \* PRINT_IMG_X \}\)/);
  assert.match(seg, /sheet\.className = 'ctp-sheet'/);
  // 底图转 JPEG 后必须释放位图，否则一篇几十页能把内存顶爆
  assert.match(seg, /canvas\.width = 0/);
  assert.match(seg, /canvas\.height = 0/);
  // 排版必须发生在「已进入文档布局」之后
  assert.ok(seg.indexOf('stage.appendChild(sheet)') < seg.indexOf('layoutLayer('),
    '先进文档再排版：否则量不到宽高，字号全错');
});

test('译文打印：不污染阅读器状态（打印用的块与页码全部从参数来）', () => {
  const js = read('cmp-pages.js');
  const seg = between(js, 'async function printPages(', '\n  function refit()');
  // 参数化，不依赖 mount
  assert.match(seg, /opts\.blocks/);
  assert.match(seg, /opts\.pageSize/);
  assert.match(seg, /opts\.getDoc/);
  // 临时接管 + finally 还原
  assert.match(seg, /const prev = \{/);
  assert.match(seg, /state\.opts = prev\.opts/);
  assert.match(seg, /state\.byPage = prev\.byPage/);
  assert.match(seg, /state\.pending = prev\.pending/);
  assert.match(seg, /state\.errors = prev\.errors/);
  assert.match(seg, /state\.base\.clear\(\)/);
  // 打印稿不该画「翻译中」白块
  assert.match(seg, /state\.pending = new Set\(\)/);
});

test('译文打印：预览按页签切换到 trans，页码默认铺全篇', () => {
  const app = read('app.js');
  const sw = between(app, 'async function ppSwitchMode(mode)', 'async function ppRender()');
  assert.match(sw, /if \(mode === 'trans' && !pp\.transSeeded\)/);
  assert.match(sw, /ppEl\('ppRange'\)\.value = '1-' \+ total/);
  // 页码只对解析结果隐藏
  assert.match(sw, /classList\.toggle\('hidden', mode === 'analysis'\)/);

  const render = between(app, 'async function ppRender()', 'function ppCurrentPages()');
  assert.match(render, /await ppBuildTrans\(\{ preview: true, gen \}\)/);

  const print = between(app, 'async function ppPrint()', 'function bindPrintPreview()');
  assert.match(print, /await ppBuildTrans\(\{ preview: false, gen: \+\+pp\.gen \}\)/);

  // 译文由 CmpPages 排，打印模块只负责页码与进度
  const build = between(app, 'async function ppBuildTrans(', '/** 解析结果文稿');
  assert.match(build, /window\.CmpPages\.printPages\(list, \{/);
  assert.match(build, /if \(gen !== pp\.gen\)/);
});

test('译文打印：页码缺省走全篇，按需翻译的缓存也要合并进来', () => {
  const app = read('app.js');
  const blocks = between(app, 'function ppTransBlocks()', 'async function ppBuildTrans(');
  assert.match(blocks, /cmp\.transCache\.get\(b\.id\)/);
  assert.match(blocks, /\{ \.\.\.b, translation: cached \}/);
});

test('译文打印的 CSS：离屏台用 visibility:hidden（不能让宽高变成 0），按纸分页', () => {
  const css = read('style.css');
  const stage = between(css, '.ctp-print-stage {', '}');
  assert.match(stage, /visibility: hidden/);
  assert.ok(!/display:\s*none/.test(stage), 'display:none 会让 clientWidth/clientHeight 变 0，字号全错');

  const print = between(css, '@media print {', '@page { margin: 14mm 12mm; }');
  assert.match(print, /\.print-area \.ctp-sheet \{[^}]*break-after: page/);
  // 屏幕上的「点这里翻译」角标与截断省略号不该印出来
  assert.match(print, /\.ctp-block\.ctp-missing::after/);
});
