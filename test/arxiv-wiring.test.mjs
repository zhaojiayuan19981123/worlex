// arxiv-wiring.test.mjs —— arXiv 模块接线：文件引用、导航、视图、后端路由
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const html = read('../public/index.html');
const app = read('../public/app.js');
const server = read('../server.js');

test('前端：样式、脚本、导航、视图容器都在，且脚本先于 app.js', () => {
  assert.match(html, /<link rel="stylesheet" href="arxiv\.css" \/>/);
  assert.match(html, /<script src="arxiv\.js"><\/script>/);
  assert.ok(html.indexOf('arxiv.js') < html.indexOf('<script src="app.js">'));
  assert.match(html, /data-view="arxiv"/);
  assert.match(html, /<span class="nav-label">arXiv 分类<\/span>/);
  assert.match(html, /<section id="viewArxiv" class="view hidden"><\/section>/);
});

test('前端：视图元信息 / switchView map / mount 与 close 都接上', () => {
  assert.match(app, /arxiv: \{ name: 'arXiv 分类'/);
  assert.match(app, /arxiv: 'viewArxiv'/);
  assert.match(app, /if \(v === 'arxiv'\) await window\.ArxivView\?\.mount\?\.\(\$\('viewArxiv'\)\)/);
  assert.match(app, /if \(v !== 'arxiv'\) window\.ArxivView\?\.close\?\.\(\)/);
});

test('后端：arXiv 路由已注册', () => {
  assert.match(server, /import \{ registerArxivRoutes \} from '\.\/src\/arxivRoutes\.js'/);
  assert.match(server, /registerArxivRoutes\(app, \{ fetchImpl: modelFetch/);
});
