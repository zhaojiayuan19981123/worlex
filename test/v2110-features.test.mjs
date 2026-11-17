// v2.1.10 回归用例 —— 阅读器内可就地改翻译引擎 / 文献中心按阅读热力排序
//
// 这一版的原则：
//   1) 引擎仍然只有一份值（settings.translateProvider），切掉的是「只能看不能改」；
//   2) 在划词面板 / 整篇翻译 / 对照精读工具条里改，写回的就是那份全局设置，
//      三处 + 设置页 + 笔记标签同时刷新，不存在第二份状态；
//   3) 排序里的「按期刊」本质上就是按字符串排，信息量低；换成按阅读热力排，
//      和顶部「热 / 冷」筛选同一口径。
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

test('阅读器内三处引擎是可选下拉，不是只能看的标签', () => {
  const html = read('public/index.html');
  const js = read('public/app.js');
  for (const id of ['prSelSource', 'cmpEngine', 'cmpEngineChip']) {
    assert.match(html, new RegExp(`<select[^>]*id="${id}"`), `${id} 应是下拉（就地可改引擎）`);
  }
  // 三处共用一份选项，顺序与设置页一致
  assert.match(js, /const TR_ENGINE_SELECTS = \['prSelSource', 'cmpEngine', 'cmpEngineChip'\];/);
  assert.match(js, /const TR_ENGINE_ORDER = \[[^\]]*'builtin'[\s\S]*?'free'\];/);
  const fill = between(js, 'function fillTrEngineSelects()', 'function renderTranslateEngine()');
  assert.match(fill, /dataset\.filled === '1'/, '只填一次，别把正在展开的下拉重置');
});

test('改引擎 = 改全局设置：写回 translateProvider 并同步所有显示', () => {
  const js = read('public/app.js');
  const fn = between(js, 'async function setGlobalTranslateEngine(', 'async function loadTranslateSources()');
  assert.match(fn, /api\('\/api\/settings'/, '应走设置接口保存');
  // 只提交这一个字段：通用入口对 dataDir / 路由 / 代理有特殊处理，带上反而危险
  assert.match(fn, /body: JSON\.stringify\(\{ translateProvider: id \}\)/);
  const bodyLine = fn.split('\n').find((l) => l.includes('body: JSON.stringify')) || '';
  assert.ok(!bodyLine.includes('dataDir'), '不该顺手提交 dataDir（会触发数据目录迁移）');
  assert.match(fn, /if \(settings\) settings\.translateProvider = id;/, '先就地更新本地值');
  assert.match(fn, /settings\.translateProvider = prev;/, '保存失败要回滚，别显示成已切换');
  assert.match(fn, /renderTranslateEngine\(\);/, '每次状态变化都要刷新所有显示位');
  // 缺 Key 的引擎要当场提醒，而不是等翻译报错
  assert.match(fn, /TR_ENGINE_KEY_FIELD\[id\]/, '选了需要 Key 的引擎应检查 Key');
  assert.match(js, /const TR_ENGINE_KEY_FIELD = \{[\s\S]*?deepl: \['deeplKey'/);
  // 划词面板里已有原文时，换引擎立刻重译，屏幕上的译文不能还是旧引擎的
  assert.match(fn, /sourceId === 'prSelSource'[\s\S]*?doPanelTranslate\(\)/);
});

test('三处下拉都绑了 change，且带上自己的来源 id', () => {
  const js = read('public/app.js');
  assert.match(js, /for \(const id of TR_ENGINE_SELECTS\) \{\s*\$\(id\)\?\.addEventListener\('change', \(e\) => setGlobalTranslateEngine\(e\.target\.value, id\)\);/);
});

test('文献中心排序：按期刊换成按阅读热力，口径与热 / 冷筛选一致', () => {
  const html = read('public/index.html');
  const js = read('public/app.js');
  assert.match(html, /<option value="readingHeat">按阅读热力<\/option>/);
  assert.ok(!html.includes('按期刊'), '「按期刊」这个排序项应已移除');
  assert.ok(!/<option value="journal">/.test(html), '不该再留 journal 排序项');
  // 排序值不在记录字段里，必须走计时模块取数（读 a.readingHeat 会全是 undefined）
  const cmp = between(js, 'const cmp = (a, b) => {', 'return Search.rank(list, q, cmp);');
  assert.match(cmp, /if \(f === 'readingHeat'\)/);
  assert.match(cmp, /window\.ReadingHeat/);
  assert.match(cmp, /H\.total\(it\.id\)/, '应与「热 / 冷」筛选同一取数口径');
  assert.match(cmp, /Number\(it\.readingHeat\?\.total\) \|\| 0/, '计时模块不可用时退回记录里的累计值');
});
