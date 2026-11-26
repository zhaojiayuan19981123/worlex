// worldlib-target-ui.test.mjs —— 世图下载助手「选择目标文库」的接线一致性
//
// 后端收 docType/collectionId 的测试在 worldlib-download.test.mjs；
// 这里只盯前端别漏接线：下拉框没渲染、请求没带参数、切库后「已导入」状态没重算。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const html = read('../public/index.html');
const app = read('../public/app.js');
const css = read('../public/style.css');

test('页面：目标文库与分类下拉都在世图视图里，三个文库齐全', () => {
  const view = html.slice(html.indexOf('<section id="viewWorldlib"'), html.indexOf('<!-- ===== 视图：邮箱'));
  assert.match(view, /id="wlTargetLib"/);
  assert.match(view, /id="wlTargetCollection"/);
  assert.match(view, /<option value="empirical">实证类文库<\/option>/);
  assert.match(view, /<option value="model">模型类文库<\/option>/);
  assert.match(view, /<option value="algorithm">算法类文库<\/option>/);
  assert.match(css, /\.wl-targets\s*\{/);
});

test('前端：选择会记住，且分类跟着文库切换', () => {
  assert.match(app, /WL_DOC_TYPE_KEY = 'worldlib:targetDocType'/);
  assert.match(app, /WL_COLLECTION_KEY = 'worldlib:targetCollection'/);
  assert.match(app, /localStorage\.getItem\(WL_DOC_TYPE_KEY\)/);
  assert.match(app, /LIB_TYPES\.includes\(savedDocType\)/);
  assert.match(app, /collections\.filter\(\(c\) => c\.docType === wlDocType\)/);
  assert.match(app, /\$\('wlTargetLib'\)\.addEventListener\('change'/);
  assert.match(app, /\$\('wlTargetCollection'\)\.addEventListener\('change'/);
});

test('前端：下载请求带上目标文库与分类，状态判断按目标文库隔离', () => {
  assert.match(app, /body: JSON\.stringify\(\{ title: it\.title, url: it\.url, overwrite: true, \.\.\.wlTargetPayload\(\) \}\)/);
  assert.match(app, /if \(\(r\.docType \|\| 'empirical'\) !== wlDocType\) return false;/);
  assert.match(app, /stale = items\.filter\(\(r\) => \(r\.docType \|\| 'empirical'\) === wlDocType/);
  assert.match(app, /docTypeLabel\(wlDocType\)/);
});
