// v311-features.test.mjs —— v3.1.1：文献实时刷新 / 启动与运行优化 / 批注 / 实验环境字段
//
// 这一版没有新页面，全是「用起来才感觉得到」的改动，所以测试分三类：
//   ① 数据契约：版本戳真的会随写入变化（前端靠它判断要不要重新拉列表）；
//   ② 结构契约：重型依赖不再在启动时静态导入、表格整批渲染、缩略图延后；
//   ③ 功能契约：批注是新类型（正文只留标记）、算法类新增「实验环境」并进入提示词。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createApp } from '../server.js';
import * as store from '../src/store.js';
import { shutdownPdfTextPool } from '../src/pdfTextPool.js';
import { TYPE_FIELDS, FIELD_LABELS, buildPrompt } from '../src/aiExtractor.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// PDF 文本线程池不主动收尾的话，测试进程会吊着不退（CI 上表现为「跑到最后没有结果」）
test.after(async () => { await shutdownPdfTextPool(); });

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}
async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
}

test('文献版本戳：写入后一定变化，没写入时保持稳定', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'v311-'));
  const prev = store.getDataDir();
  try {
    store.configure({ dataDir: dir });
    const v0 = store.literatureVersion();
    assert.equal(typeof v0.stamp, 'string');
    assert.equal(v0.count, 0);

    const rec = { id: 'lit-v311-1', title: '版本戳测试', docType: 'algorithm' };
    store.upsertLiterature(rec);
    const v1 = store.literatureVersion();
    assert.equal(v1.count, 1);
    assert.notEqual(v1.stamp, v0.stamp, '写入后版本戳必须变，否则前端不会重新拉列表');
    // 再查一次（没有写入）必须稳定，避免前端每次切视图都白拉一遍整份列表
    assert.equal(store.literatureVersion().stamp, v1.stamp);
  } finally {
    store.configure({ dataDir: prev });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/literature/version 可直接给前端比对，且不会被 /:id 吃掉', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'v311-http-'));
  const uploadDir = path.join(root, 'uploads');
  await mkdir(uploadDir, { recursive: true });
  const prev = store.getDataDir();
  store.configure({ dataDir: path.join(root, 'data') });
  const { app } = createApp({ uploadDir });
  const server = createServer(app);
  const base = await listen(server);
  try {
    const r1 = await fetch(`${base}/api/literature/version`, { headers: { Connection: 'close' } });
    assert.equal(r1.status, 200);
    const b1 = await r1.json();
    assert.ok('stamp' in b1 && 'count' in b1);

    await fetch(`${base}/api/literature`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ docType: 'algorithm' }),
    });
    const b2 = await (await fetch(`${base}/api/literature/version`, { headers: { Connection: 'close' } })).json();
    assert.equal(b2.count, 1);
    assert.notEqual(b2.stamp, b1.stamp);
  } finally {
    await close(server);
    store.configure({ dataDir: prev });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('前端：切回文献中心/首页时会比对版本戳，导入后不必重启', () => {
  const src = read('public/app.js');
  assert.match(src, /\/api\/literature\/version/, '前端必须查版本戳');
  assert.match(src, /syncItemsIfChanged/, '缺少「按版本戳追平」的实现');
  assert.match(src, /worlex:literature-changed/, '缺少跨模块通知事件');
  assert.match(src, /literatureChanged: notifyLiteratureChanged/, 'Worlex 桥接要暴露通知方法');
  // arXiv 导入结束后必须通知一次
  const arxiv = read('public/arxiv.js');
  assert.match(arxiv, /notifyLibraryChanged\(\)/, 'arXiv 导入结束要通知文献中心');
});

test('启动优化：重型依赖不再在启动路径上静态导入', () => {
  // pdf-lib / fontkit 走 lazyLibs（同步 require，调用点不变）
  assert.ok(fs.existsSync(path.join(ROOT, 'src/pdfTranslate/lazyLibs.js')), '缺少 lazyLibs.js');
  for (const f of ['src/pdfTranslate/render.js', 'src/pdfTranslate/reflow.js', 'src/pdfTranslate/paint.js', 'src/pdfTranslate/fontMetrics.js']) {
    const s = read(f);
    assert.ok(!/^import .*from 'pdf-lib'/m.test(s), `${f} 仍在静态导入 pdf-lib`);
    assert.ok(!/^import .*from '@pdf-lib\/fontkit'/m.test(s), `${f} 仍在静态导入 fontkit`);
    assert.match(s, /pdfLibModule|fontkitModule/, `${f} 没用惰性入口`);
  }
  // 邮箱 / mammoth 同理
  assert.ok(!/^import .*from 'imapflow'/m.test(read('src/mail.js')), 'mail.js 仍在静态导入 imapflow');
  assert.ok(!/^import mammoth/m.test(read('src/achievementRoutes.js')), 'achievementRoutes 仍在静态导入 mammoth');
  assert.ok(!/^import mammoth/m.test(read('server.js')), 'server.js 仍在静态导入 mammoth');
});

test('运行流畅度：表格整批渲染 + 缩略图空闲回填', () => {
  const src = read('public/app.js');
  // 整批 innerHTML（不再逐行 createElement + appendChild）
  assert.match(src, /el\.tbody\.innerHTML = rows\.join\(''\)/);
  assert.ok(!/el\.tbody\.appendChild\(tr\)/.test(src), '表格仍在逐行 appendChild');
  // 拖拽改成事件委托
  assert.match(src, /addEventListener\('dragstart'/, '缺少 tbody 上的 dragstart 委托');
  // 缩略图延后
  assert.match(src, /scheduleThumbBackfill/);
  assert.match(src, /requestIdleCallback/);
  assert.ok(!/slice\(0, 10\)\.forEach\(\(i\) => ensureThumb\(i\)\)/.test(src), '启动时仍在同步渲染 10 张缩略图');
});

test('批注：新增 comment 类型，正文只显示标记不展开内容', () => {
  const html = read('public/index.html');
  assert.match(html, /data-sel="comment"/, '划词工具条缺少「批注」按钮');
  assert.match(html, /<option value="comment">批注<\/option>/, '笔记筛选缺少批注类型');
  const app = read('public/app.js');
  assert.match(app, /function doComment\(\)/, '缺少加批注入口');
  assert.match(app, /function showCommentPopover/, '缺少查看批注的浮层');
  assert.match(app, /function editComment/, '批注要能编辑');
  assert.match(app, /function deleteComment/, '批注要能删除');
  // 只画标记，不铺底色（笔记才铺底色）
  const block = app.slice(app.indexOf("} else if (a.type === 'comment') {"), app.indexOf('// ---------- 笔记与高亮'));
  assert.match(block, /pr-comment-marker/);
  assert.ok(!/background = HIGHLIGHT_COLORS/.test(block), '批注不能铺高亮底色');
  // 重排视图 / EPUB 也要有对应样式
  assert.match(read('public/reader-mode.js'), /rm-comment/, '重排视图缺少批注标记');
  assert.match(read('public/style.css'), /\.pr-comment-marker/, '缺少批注标记样式');
  assert.match(read('public/epub-reader.js'), /ep-comment/, 'EPUB 缺少批注标记');
});

test('算法类新增「实验环境」：进字段集、进提示词、进前端列', () => {
  assert.ok(TYPE_FIELDS.algorithm.includes('experimentalEnv'), '算法类字段集缺 experimentalEnv');
  assert.equal(FIELD_LABELS.experimentalEnv, '实验环境');
  const p = buildPrompt('algorithm', '简体中文');
  assert.match(p, /experimentalEnv（实验环境）/, '提示词缺少实验环境字段说明');
  assert.match(p, /GPU/, '实验环境要明确要求写 GPU');
  assert.match(p, /CUDA|cuDNN/, '实验环境要覆盖软件栈版本');
  assert.match(p, /原文未报告/, '没写的项要标「原文未报告」，不能编默认值');
  const app = read('public/app.js');
  assert.match(app, /experimentalEnv: \{ key: 'experimentalEnv', label: '实验环境'/, '前端缺列定义');
  assert.match(app, /'experimentalDesign', 'experimentalEnv'/, '算法类列顺序缺实验环境');
});

test('Electron：先出窗口再等后端（加载页）', () => {
  const s = read('electron/main.cjs');
  assert.match(s, /SPLASH_HTML/, '缺少启动加载页');
  assert.match(s, /createWindow\(\);\s*\n\s*try \{\s*\n\s*backendPort = await startBackend\(\)/, '窗口应先于后端创建');
  assert.match(s, /did-finish-load/, '缺少首屏耗时日志');
});

test('批注浮层：贴窗口下沿时向上翻转，不被切掉', () => {
  const app = read('public/app.js');
  const fn = app.slice(app.indexOf('function showPopover('), app.indexOf('function hidePopover()'));
  assert.match(fn, /offsetHeight/, '要用浮层真实高度判断放不放得下');
  assert.match(fn, /top \+ h > vh - 8/, '缺少底部越界判断');
  assert.match(fn, /const above = top - h - 24/, '放不下时要翻到触发点上方');
  assert.match(fn, /visibility = 'hidden'/, '要先量尺寸再露面，避免闪一下');
});
