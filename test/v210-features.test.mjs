// v210-features.test.mjs —— v2.1.0 九项改造的静态接线一致性测试
// 这些功能分散在 HTML / app.js / server.js / 独立模块里，最容易出问题的是
// 「文件写了但没接上」。这里只断言接线，不重复各模块自己的纯函数单测。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const html = read('../public/index.html');
const app = read('../public/app.js');
const server = read('../server.js');
const extractor = read('../src/aiExtractor.js');
const store = read('../src/store.js');
const css = read('../public/style.css') + read('../public/workbench-extras.css');

test('目录侧边抽屉：模块已引入，且对照精读隐藏 .pr-body 时不再依赖它', () => {
  assert.match(html, /<script src="lit-drawer\.js"><\/script>/);
  assert.match(app, /window\.LitDrawer\?\.open\(/);
  assert.match(app, /onPick: \(id\) => openPdfReader\(id\)/);
  assert.match(app, /\$\('prDir'\)\?\.classList\.add\('hidden'\)/);
  assert.match(css, /\.ld-panel\s*\{/);
});

test('标题中文译名：提示词、存储字段、列表与目录都显示第二行', () => {
  assert.match(extractor, /'title', 'titleZh', 'authors'/);
  assert.match(extractor, /逐字照抄原文标题/);
  assert.match(extractor, /titleZh：论文标题的简体中文译名/);
  assert.match(extractor, /cleanTitleZh\(/);
  assert.match(app, /function litTitleParts\(/);
  assert.match(app, /class="lit-title-zh"/);
  assert.match(app, /class="pr-dir-zh"/);
  assert.match(css, /\.lit-title-zh/);
});

test('功能区精简：阅读模式/版面/导出/两下拉隐藏，整篇翻译改为重新翻译', () => {
  assert.match(html, /id="prReadingBtn" class="btn btn-ghost pr-icobtn hidden"/);
  assert.match(html, /id="prLayoutBtn" class="btn btn-ghost pr-icobtn hidden"/);
  assert.match(html, /id="cmpBarEngine" class="cmp-bar-engine hidden"/);
  assert.match(html, /id="cmpPairMode" class="cmp-bar-engine hidden"/);
  assert.match(html, /id="cmpExportNote" class="cmp-bar-btn hidden"/);
  assert.match(html, />重新翻译<\/button>/);
  assert.match(app, /show\(\$\('prLayoutBtn'\), false\)/);
  assert.match(app, /show\(\$\('prReadingBtn'\), false\)/);
  assert.match(app, /setPairMode\?\.\('para'\)/);
  assert.match(app, /自动整理/);
});

test('划词高亮：按行合并模块已接入选区与批注绘制', () => {
  assert.match(html, /<script src="selection-layer\.js"><\/script>/);
  assert.match(app, /window\.SelectionLayer\?\.mergeLineRects/);
  assert.match(app, /window\.SelectionLayer\?\.bind\?\.\(\)/);
  assert.match(read('../public/selection-layer.js'), /function mergeLineRects\(/);
  assert.match(css, /\.pr-text-layer ::selection \{ background: transparent; \}/);
  assert.match(css, /\.pr-sel-box/);
});

test('三个新工具：框选表格 / 框选问 AI / 全文查找已挂在阅读器工具条', () => {
  assert.match(html, /id="prToolStrip"/);
  assert.match(html, /<script src="reader-tools\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="reader-tools\.css" \/>/);
  assert.match(app, /window\.ReaderTools\?\.init\?\.\(\)/);
  assert.match(app, /window\.ReaderTools\?\.repaintHits\?\./);
  assert.match(app, /sendRegionToChat: \(opts\)/);
  const tools = read('../public/reader-tools.js');
  assert.match(tools, /dataset\.rt = 'table'/);
  assert.match(tools, /dataset\.rt = 'ai'/);
  assert.match(tools, /在文中查找/);
});

test('AI 助手：两个前置按钮收进 ＋ 菜单，界面直接以输入框开始', () => {
  assert.match(html, /id="btnChatMore"/);
  assert.match(html, /id="chatMoreMenu"/);
  assert.match(html, /id="btnPrChatMore"/);
  assert.match(html, /id="prChatMoreMenu"/);
  assert.match(html, /id="btnChatAttach" class="btn btn-ghost hidden"/);
  assert.match(html, /id="btnChatKnowledge" class="btn btn-ghost hidden"/);
  assert.match(app, /\$\('btnChatMore'\)\?\.addEventListener/);
  assert.match(app, /\$\('btnPrChatMore'\)\?\.addEventListener/);
  assert.match(css, /\.ai-composer/);
});

test('本地知识库：跨文库索引、自动重建、问答参考文献与知识图谱接口齐全', () => {
  // 全文读取改成「一次扫描 layout 目录」，别再退回到逐篇 readdir + 读 manifest 的慢路径
  assert.match(server, /import \{ buildIndex, searchEntries, buildEvidenceBlock, createFullTextReader \}/);
  assert.match(server, /const readFullText = createFullTextReader\(dir\)/);
  assert.match(server, /app\.get\('\/api\/knowledge\/graph'/);
  assert.match(server, /app\.post\('\/api\/knowledge\/rebuild'/);
  assert.match(server, /scheduleKbRebuild\(\)/);
  assert.match(server, /sseSend\(res, \{ references: kbRefs \}\)/);
  assert.match(server, /buildSystemPrompt\(effectiveContent\) \+ kbBlock/);
  assert.match(store, /'knowledge-base\.json'/);
  assert.match(app, /function chatRefsHtml\(/);
  assert.match(app, /event\.references/);
  assert.match(css, /\.ai-ref-chip/);
});

test('知识图谱视图：导航 / 容器 / 映射 / 挂载 / 关闭全部接上', () => {
  assert.match(html, /data-view="graph"/);
  assert.match(html, /id="viewGraph"/);
  assert.match(html, /<script src="knowledge-graph\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="knowledge-graph\.css" \/>/);
  assert.match(app, /graph: 'viewGraph'/);
  assert.match(app, /graph: \{ name: '知识图谱'/);
  assert.match(app, /window\.GraphView\?\.mount\?\./);
  assert.match(app, /if \(v !== 'graph'\) window\.GraphView\?\.close\?\./);
  const g = read('../public/knowledge-graph.js');
  assert.match(g, /const GraphView = \{ mount, refresh: load, close \}/);
});

test('文中超链接：注解热区模块在每页渲染后调用', () => {
  assert.match(html, /<script src="pdf-links\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="pdf-links\.css" \/>/);
  assert.match(app, /window\.PdfLinks\?\.render\(page, viewport, wrap, pageNum\)/);
  const links = read('../public/pdf-links.js');
  assert.match(links, /getAnnotations/);
  assert.match(links, /convertToViewportRectangle/);
});

test('全局桥：新模块依赖的接口一个不少', () => {
  for (const key of ['items', 'openLiterature', 'setPrTab', 'reveal',
    'pdfDoc', 'scale', 'pageWrap', 'gotoPage', 'sendRegionToChat']) {
    assert.match(app, new RegExp(`\\n    ${key}:`), `window.Worlex 缺少 ${key}`);
  }
  // toast / esc / api 用对象简写挂上去
  assert.match(app, /\n    toast, esc, api,/);
});
