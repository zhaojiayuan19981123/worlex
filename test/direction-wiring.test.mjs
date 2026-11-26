// direction-wiring.test.mjs —— 方向分析的接线一致性
//
// 这类「新模块」最容易出的问题不是逻辑，而是漏接线：文件写了但没引、视图没进 map、
// 数据文件没进备份清单。这里只断言接线，不重复各模块自己的单测。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const html = read('../public/index.html');
const app = read('../public/app.js');
const server = read('../server.js');
const css = read('../public/direction.css');

test('前端：脚本、样式、导航、视图容器都在', () => {
  assert.match(html, /<script src="direction\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="direction\.css" \/>/);
  assert.match(html, /data-view="direction"/);
  assert.match(html, /<span class="nav-label">方向分析<\/span>/);
  assert.match(html, /<section id="viewDirection" class="view hidden"><\/section>/);
  // 脚本必须在 app.js 之前，否则 switchView 里 mount 时 window.DirectionView 还不存在
  assert.ok(html.indexOf('direction.js') < html.indexOf('<script src="app.js">'));
});

test('前端：视图注册进 map / 元信息 / 挂载与关闭 / 模型下拉', () => {
  assert.match(app, /direction: 'viewDirection'/);
  assert.match(app, /direction: \{ name: '方向分析'/);
  assert.match(app, /if \(v === 'direction'\) await window\.DirectionView\?\.mount\?\.\(\$\('viewDirection'\)\)/);
  assert.match(app, /if \(v !== 'direction'\) window\.DirectionView\?\.close\?\.\(\)/);
  assert.match(app, /\['dirModelRow', 'direction'\]/);
  assert.match(app, /'papers', 'direction'\]\.includes\(v\)\) renderAiModelRows\(\)/);
  assert.match(app, /readModelPick,/);
});

test('前端模块：挂载约定与后端接口一一对上', () => {
  const js = read('../public/direction.js');
  assert.match(js, /window\.DirectionView = \{ mount, close \}/);
  assert.match(js, /api\('\/api\/direction'\)/);
  assert.match(js, /'\/api\/direction\/search'/);
  assert.match(js, /'\/api\/direction\/analyze'/);
  assert.match(js, /`\/api\/direction\/job\/\$\{encodeURIComponent\(jobId\)\}`/);
  assert.match(js, /`\/api\/direction\/session\/\$\{encodeURIComponent\(id\)\}`/);
  assert.match(js, /'\/api\/direction\/export-markdown'/);
  // 所有插入页面的文本都过 esc
  assert.match(js, /const esc = /);
  // 侧栏条件与「已保存会话」解耦：改条件不该立刻改历史
  assert.match(js, /selected: \[\.\.\.S\.selection\]/);
});

test('后端：路由已注册，数据文件进了备份清单', () => {
  assert.match(server, /import \{ registerDirectionRoutes \} from '\.\/src\/directionRoutes\.js'/);
  assert.match(server, /const directionService = registerDirectionRoutes\(app, \{/);
  assert.match(server, /fetchImpl: modelFetch/);
  const storeSrc = read('../src/store.js');
  assert.match(storeSrc, /'direction-analysis\.json'/);
  assert.match(storeSrc, /export function getDirectionState\(\)/);
  assert.match(storeSrc, /export function saveDirectionState\(value\)/);
});

test('样式：全部走主题 token，没有写死颜色', () => {
  // 允许 color-mix / transparent / 关键字，但不允许 #rrggbb 或 rgb( 字面量
  const literals = css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) || [];
  assert.deepEqual(literals, [], `direction.css 里有写死颜色：${literals.join(', ')}`);
  assert.match(css, /\.dir-shell\s*\{/);
  assert.match(css, /@media \(max-width: 1080px\)/);
});
