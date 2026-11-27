// v312-features.test.mjs —— v3.1.2：译文字号 / 缩放联动 / 原文↔译文高亮 / 解析结果批注
//
// 这一版全部落在「对照精读」与「文献详情」两处，行为都依赖真实 DOM 才能完全验证，
// 所以单元测试只钉住**契约**，具体像素与交互另有 Playwright 端到端脚本：
//   ① 译文页要能按倍数改字号，且标记是按字符区间贴上去的；
//   ② 顶部缩放要按同比例带动译文栏（两栏宽度不同，不能共用一个百分比）；
//   ③ 标注一条数据服务两侧：rects 给原文、blockId + tr 给译文；
//   ④ 解析结果的划词工具条要有「批注」，且服务端不能把 kind 改回 highlight。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const app = read('public/app.js');
const pages = read('public/cmp-pages.js');
const html = read('public/index.html');
const css = read('public/style.css');

test('译文字号：倍数进排版，且有上下限', () => {
  assert.match(pages, /const FONT_LO = 0\.8;/, '缺少字号倍数下限');
  assert.match(pages, /const FONT_HI = 1\.8;/, '缺少字号倍数上限');
  assert.match(pages, /function setFontScale\(k\)/, '缺少设置字号倍数的入口');
  assert.match(pages, /function getFontScale\(\)/, '缺少读取字号倍数');
  // 落笔时乘倍数：标题与正文一起放大，层级才不散
  const apply = pages.slice(pages.indexOf('function applySize(j, base)'), pages.indexOf('function growTo('));
  assert.match(apply, /state\.fontScale \|\| 1/, 'applySize 没有乘字号倍数');
  // 改倍数必须重排（基准字号是按「原框能放下的最大字号」算出来的）
  const setter = pages.slice(pages.indexOf('function setFontScale(k)'), pages.indexOf('function getFontScale()'));
  assert.match(setter, /state\.base\.clear\(\)/, '改字号后要清掉本页基准字号');
  assert.match(setter, /refit\(\)/, '改字号后要重排');
  assert.match(pages, /setFontScale,\s*\n\s*getFontScale,/, 'CmpPages 没有导出字号接口');
});

test('译文字号控件：界面有按钮，比例记在 localStorage', () => {
  assert.match(html, /id="cmpFontSeg"/, '译文栏缺少字号控件');
  assert.match(html, /id="cmpFontDec"/, '缺少 A－');
  assert.match(html, /id="cmpFontInc"/, '缺少 A＋');
  assert.match(html, /id="cmpFontLabel"/, '缺少字号百分比显示');
  assert.match(app, /const CMP_FONT_KEY = 'sciterminal\.cmpTransFontScale'/, '字号倍数没有持久化的 key');
  assert.match(app, /function stepCmpFontScale\(delta\)/, '缺少步进调节函数');
  assert.match(app, /localStorage\.setItem\(CMP_FONT_KEY/, '字号倍数没有写进 localStorage');
  // 文本重排（流式）共用同一个倍数，否则两种读法字号不一致
  assert.match(app, /function applyCmpFlowFontScale\(k\)/, '缺少文本重排的字号同步');
  assert.match(css, /--ctp-fs, 1/, '文本重排的字号没有接 CSS 变量');
});

test('缩放：顶部 ± 按同比例带动译文栏，适宽两边一起回位', () => {
  assert.match(app, /function zoomPdfBy\(delta\)/, '缺少统一的缩放函数');
  assert.match(app, /function syncCmpZoomRatio\(ratio\)/, '缺少译文栏同比例缩放');
  const sync = app.slice(app.indexOf('function syncCmpZoomRatio(ratio)'), app.indexOf('function bindPdfReader()'));
  // v3.2.1：文本重排也接进同一条链路，不能再有「非 page 就 return」的早退
  assert.doesNotMatch(sync, /cmp\.style !== 'page'/, '文本重排不能被排除在同步之外');
  assert.match(sync, /cmp\.style === 'page'/, '版面还原仍走独立的译文页缩放');
  assert.match(sync, /cmp\.flowZoom = next/, '文本重排要按同比例改等效缩放');
  assert.match(sync, /getZoom\?\.\(\) \|\| 1/, '同步时要基于译文栏当前倍数');
  assert.match(sync, /setZoom\?\.\(z \* ratio\)/, '译文栏缩放要按比例乘');
  // 按钮与 Ctrl+滚轮都走同一个函数，避免两条路径行为不一致
  assert.match(app, /\$\('prZoomIn'\)\.addEventListener\('click', \(\) => \{ zoomPdfBy\(0\.2\)/, '放大按钮没走 zoomPdfBy');
  assert.match(app, /\$\('prZoomOut'\)\.addEventListener\('click', \(\) => \{ zoomPdfBy\(-0\.2\)/, '缩小按钮没走 zoomPdfBy');
  const fit = app.slice(app.indexOf('function fitWidth() {'), app.indexOf('function bindPdfReader()'));
  assert.match(fit, /CmpPages\?\.fitWidth/, '「适宽」没有把译文页一起复位');
  assert.match(fit, /cmp\.flowZoom = 1/, '「适宽」也要把文本重排带回基线');
});

test('译文标注：按 blockId + 字符区间贴标记，先清后贴（幂等）', () => {
  assert.match(pages, /function setAnnotations\(list\)/, '缺少接收标注的入口');
  assert.match(pages, /function applyMarks\(n\)/, '缺少画标记的函数');
  assert.match(pages, /function clearMarks\(layer\)/, '缺少清标记的函数');
  const apply = pages.slice(pages.indexOf('function applyMarks(n)'), pages.indexOf('function offsetWithin('));
  assert.match(apply, /clearMarks\(rec\.layer\)/, '贴之前要先清，否则反复缩放会叠出多层');
  assert.match(apply, /a\.blockId/, '标记按块定位');
  assert.match(apply, /a\.tr\.from/, '标记按字符区间定位');
  assert.match(apply, /ctp-cm-range/, '批注在译文里也要有标记');
  assert.match(pages, /function selection\(\)/, '缺少读译文栏选区的入口');
  assert.match(pages, /function blockPageRect\(id\)/, '缺少「块 → PDF 坐标」的换算');
  // 标记要能跨多个文本节点（同一句被换行拆开时）
  assert.match(pages, /function wrapRange\(textEl, from, to, make\)/, '缺少按区间包元素的工具');
  assert.match(pages, /markRange: wrapRange/, '文本重排要复用同一套包元素逻辑');
  assert.match(css, /\.ctp-hl\.ctp-c-yellow/, '缺少译文高亮样式');
  assert.match(css, /\.ctp-cm \{/, '缺少译文批注小标样式');
});

test('原文 ↔ 译文同步：一条标注两侧都画', () => {
  assert.match(app, /function cmpTransRects\(ts\)/, '缺少「译文选区 → 原文坐标」的换算');
  assert.match(app, /function cmpLinkAnnotation\(a\)/, '缺少「原文选区 → 块 + 字符区间」的反查');
  assert.match(app, /function syncAnnotationsToCmp\(\)/, '缺少把标注推给译文栏的入口');
  // 保存路径必须同时刷新两侧
  const save = app.slice(app.indexOf('async function saveAnnotations(anns)'), app.indexOf('function selectionText(sel)'));
  assert.match(save, /syncAnnotationsToCmp\(\)/, '保存批注后没有同步译文栏');
  const add = app.slice(app.indexOf('async function addAnnotations(list)'), app.indexOf('function showNotePopover(a, x, y)'));
  assert.match(add, /cmpLinkAnnotation\(a\)/, '原文划词的标注没有补 blockId/tr');
  assert.match(add, /syncAnnotationsToCmp\(\)/, '新增标注后没有同步译文栏');
  // 译文栏划词要带上块 id 与字符区间
  const capture = app.slice(app.indexOf('function captureSelection()'), app.indexOf('function findPageWrap(node)'));
  assert.match(capture, /kind: 'trans'/, '译文栏选区没有单独的类型');
  assert.match(capture, /blockId: ts\.blockId/, '译文栏选区没有带上块 id');
  const fromSel = app.slice(app.indexOf('function annotationsFromSelection(type, sel, note'), app.indexOf('function doHighlight()'));
  assert.match(fromSel, /blockId: sel\.blockId/, '标注没有落 blockId');
  assert.match(fromSel, /tr: sel\.tr/, '标注没有落 tr 区间');
  // 译文栏划词不该再自动翻译一遍（本来就是译文）
  assert.match(app, /if \(sel\.kind === 'trans'\) \{ \/\* 只弹工具条 \*\/ \}/, '译文栏划词不应自动翻译');
});

test('解析结果（AI 字段正文）支持划词批注', () => {
  assert.match(html, /data-anno-note/, '划词工具条缺少「批注」按钮');
  assert.match(html, /id="annoCommentPop"/, '缺少批注浮层');
  assert.match(app, /function addCommentToSelection\(\)/, '缺少写批注的入口');
  assert.match(app, /function showFieldComment\(annId\)/, '缺少查看批注的入口');
  assert.match(app, /function editFieldComment\(a\)/, '批注要能改');
  assert.match(app, /async function removeFieldComment\(a\)/, '批注要能删');
  // 与高亮/字色共存：只替换同类型的重叠标注
  const apply = app.slice(app.indexOf('async function applyAnnoToSelection(kind, color, note'), app.indexOf('async function clearAnnoInSelection()'));
  assert.match(apply, /a\.kind === kind/, '替换时应只覆盖同类型标注，别把高亮冲掉');
  assert.match(apply, /'comment'/, 'applyAnnoToSelection 要认批注类型');
  // 正文只留标记：渲染时包 span + 末尾小圆点，内容不进正文
  const render = app.slice(app.indexOf('function applyFieldAnnotations(it)'), app.indexOf('function annotationSelectionTarget()'));
  assert.match(render, /anno-comment/, '批注没有渲染成虚线段');
  assert.match(render, /anno-cm-dot/, '批注没有渲染成可点小圆点');
  assert.match(app, /root\.querySelectorAll\('\.anno-cm-dot'\)\.forEach\(\(b\) => b\.remove\(\)\)/, '重画前要先摘掉旧小圆点');
  assert.match(css, /\.anno-cm-dot \{/, '缺少批注小圆点样式');
  assert.match(css, /span\.anno-comment \{/, '缺少批注虚线段样式');
});

test('服务端：字段批注的 kind 不会被改写回 highlight', () => {
  const srv = read('server.js');
  assert.match(srv, /a\.kind === 'comment' \? 'comment'/, '服务端把批注类型吃掉了');
  assert.match(srv, /note: String\(a\.note \|\| ''\)\.slice\(0, 4000\)/, '服务端没有保存批注内容');
});
