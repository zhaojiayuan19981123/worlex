// v2.1.9 回归用例 —— 设置页简化 / 引擎全局化 / 笔记模式误报 / 原图弹窗
//
// 这一版的原则：
//   1) 设置页只留一处「翻译引擎」，不再有第二、第三个开关；
//   2) 视觉模型不再是必填项（所有模型都按能看图处理，纯文本模型由后端自动兜底）；
//   3) 翻译过就该看得见译文 —— 判断依据不能用「有没有点开过译文查看器」；
//   4) 图表 / 表格 / 公式要能一键看原图，原图要能旋转。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8').replace(/\r\n/g, '\n');
const between = (s, a, b) => {
  const i = s.indexOf(a);
  const j = b ? s.indexOf(b, i + a.length) : s.length;
  assert.ok(i >= 0, `找不到片段起点：${a}`);
  return s.slice(i, j < 0 ? s.length : j);
};

test('设置页：视觉模型整块移除，不再有必填项', () => {
  const html = read('public/index.html');
  const js = read('public/app.js');
  assert.ok(!html.includes('id="visionSection"'), '视觉模型区块应已删除');
  assert.ok(!html.includes('id="setVisionProfile"'), '视觉模型下拉应已删除');
  assert.ok(!html.includes('setVisionHint'), '视觉模型提示应已删除');
  assert.ok(!js.includes('renderVisionOptions'), '渲染视觉模型下拉的函数已无对应 DOM');
  // 保存设置时也不该再回写这个字段（否则老值会一直留在设置里）
  assert.ok(!/visionProfileId:\s*\$\('setVisionProfile'\)/.test(js), '保存设置不该再读视觉模型下拉');
});

test('设置页：只剩「翻译引擎」一处，阅读器里不另存一份引擎状态', () => {
  const html = read('public/index.html');
  const js = read('public/app.js');
  // 「翻译源」这个第二开关彻底删掉
  assert.ok(!html.includes('prTranslateSource'), '设置页不该再有「翻译源」');
  assert.ok(!js.includes('prTranslateSource'), 'app.js 不该再读「翻译源」');
  // 划词面板 / 笔记模式 / 对照精读工具条上都能看到引擎
  // （v2.1.10 起划词 / 整篇 / 工具条这三处是可选下拉，见 v2110-features.test.mjs）
  assert.match(html, /id="prSelSource"/, '划词面板应显示当前引擎');
  assert.match(html, /id="pnEngineChip"/, '笔记模式应显示当前引擎');
  assert.match(html, /id="cmpEngineChip"/, '对照精读工具条应显示当前引擎');
  assert.match(html, /id="cmpEngine"/, '整篇翻译面板应显示当前引擎');
  // 所有单段翻译请求都不再自带 provider（交给服务端按全局设置决定）
  const sendSeg = between(js, 'async function cmpTranslateBlock(', 'const joined =');
  assert.ok(!/body:\s*JSON\.stringify\(\{\s*text,\s*target,\s*provider/.test(sendSeg), '单段翻译不该再带 provider');
  assert.match(js, /function renderTranslateEngine\(\)/, '应有统一的引擎展示函数');
});

test('自动整篇翻译跟随全局引擎，不再固定成免密钥引擎', () => {
  const js = read('public/app.js');
  assert.match(js, /const CMP_AUTO_ENGINE = 'auto';/);
  // 自动管线 / 手动启动都走同一个 auto 分支
  const start = between(js, 'async function startCmpTranslate(', 'setCmpStartBusy(true)');
  assert.match(start, /:\s*'auto';/, '手动启动也应固定 auto（服务端按全局设置分流）');
  assert.ok(!/cmpEl\('cmpEngine'\)\?\.value/.test(js), '不该再读启动面板的引擎下拉');
});

test('笔记模式：译过就能看见，判断依据不再是「有没有打开过译文查看器」', () => {
  const js = read('public/app.js');
  const seg = between(js, 'function renderPnLeftMd()', 'function pnAlignToMarkdown(');
  assert.match(seg, /loadPnLeftMd\(\)/, '内存里没有译文时应主动去取');
  const load = between(js, 'async function loadPnLeftMd()', 'function doPnTranslate(');
  // 先找 Markdown 成品，再退回对照译文
  assert.match(load, /kind === 'md'/, '应优先取 Markdown 成品');
  assert.match(load, /kind === 'align'/, '没有 Markdown 时应退回对照译文');
  assert.match(js, /function pnAlignToMarkdown\(/, '应能把对照块拼成可读 Markdown');
  // 空态文案要说明「怎么才会有译文」，而不是含糊地说未翻译
  assert.match(load, /还没有整篇译文/, '空态应给出可操作提示');
});

test('原图：图表 / 表格 / 公式有「看原图」图标，弹窗支持左右旋转', () => {
  const pages = read('public/cmp-pages.js');
  const app = read('public/app.js');
  const html = read('public/index.html');
  // 译文页的块上加图标，并走 onAsset 回调
  assert.match(pages, /className = 'ctp-zoom'/, '保持原图的块应带「看原图」图标');
  assert.match(pages, /state\.opts\.onAsset\?\.\(zid\)/, '点图标应走 onAsset，而不是选中块');
  assert.match(app, /onAsset: \(id\) => openCmpBlockImage\(id\)/, '挂载时应把 onAsset 接上');
  // 没有 assets 裁图时从已渲染画布截一块，别让按钮点了没反应
  assert.match(app, /window\.CmpPages\?\.capture\?\.\(id\)/, '缺裁图时应退回画布截取');
  // 旋转
  for (const id of ['pbpRotateLeft', 'pbpRotateRight', 'pbpRotateLabel']) {
    assert.match(html, new RegExp(`id="${id}"`), `原图弹窗缺少 ${id}`);
  }
  assert.match(app, /function rotateBlockView\(delta\)/, '应有旋转函数');
  assert.match(app, /img\.style\.transform = deg \? `rotate\(\$\{deg\}deg\)` : '';/, '旋转应落到 transform');
  assert.match(app, /BLOCK_VIEW\.rotation = 0;/, '打开新图要归零，不能沿用上一张的角度');
  // 打印稿里不能出现这个图标
  assert.match(read('public/style.css'), /\.ctp-print \.ctp-zoom[^{]*\{ display: none !important; \}/, '打印稿要隐藏看原图图标');
});
