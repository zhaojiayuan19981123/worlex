// v217-features.test.mjs —— AI 助读的提示词收紧：只说「依据论文内容回答」
//
// 病根：旧提示词一口气规定了「具体、可核查 / 必要时指明依据来自论文哪一部分 /
// 适合比较的用 Markdown 表格 / 代码用围栏代码块 / 公式用 $$」，模型于是把
// 「这段话什么意思」也答成分节长文；「总结本页」还额外要求「一句话主旨 + 3-5 条要点
// + 全篇作用」的三段式，一小段原文被套进模板后比原文还长。
//
// 这一版的原则：**提示词只交代依据（论文内容）、底线（没有就说没有）与输出格式（Markdown），
// 详略交给用户的问题。** 谁把结构模板加回去，这里就要断下来。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const norm = (s) => s.replace(/\r\n/g, '\n');
const read = (p) => norm(readFileSync(new URL(`../public/${p}`, import.meta.url), 'utf8'));

/** 取 app.js 里某两个锚点之间的片段，避免「别的功能也有同样措辞」造成误判 */
function between(src, start, end) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `锚点没找到：${start} … ${end}`);
  return src.slice(i, j);
}

test('AI 助读：系统提示只要求「根据论文内容回答」，不规定结构与篇幅', () => {
  const app = read('app.js');
  const seg = between(app, 'const ctx = buildPaperContext(text);', 'const userContent = imgs.length')
    // 去掉注释行：本版的注释正文里会引用旧话术做对照，那是说明，不是提示词
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

  // 必须在：依据 + 防幻觉 + 语言 + 输出格式为 Markdown
  assert.match(seg, /请根据下面这篇论文的内容，回答我的问题。/);
  assert.match(seg, /论文里没有提到的，就说论文中没有提到，不要编造。/);
  assert.match(seg, /用简体中文、Markdown 格式回答。/);
  // 论文上下文仍然要注入（简化提示词不等于让模型裸答）
  assert.match(seg, /【论文内容】/);

  // 必须没有：这些是「答案变复杂」的直接来源
  for (const bad of ['可核查', '指明依据来自论文的哪一部分', 'Markdown 表格', '围栏代码块', '公式使用']) {
    assert.ok(!seg.includes(bad), `助读提示词里不应再有「${bad}」`);
  }
  // 提示词本身就这么多：超过这个长度说明又往里塞了规矩
  assert.ok(seg.length < 900, `助读提示词片段过长（${seg.length} 字符），可能又加了格式要求`);
});

test('AI 助读「总结」：只说总结这一段，不再套「主旨 + 3-5 条要点 + 全篇作用」', () => {
  const app = read('app.js');
  assert.match(app, /const prompt = `请总结「\$\{label\}」的内容。\\n\\n【\$\{label\}正文】\\n\$\{text\}`;/);
  assert.ok(!app.includes('分 3-5 条要点'), '不该再要求固定条数的要点列表');
  assert.ok(!app.includes('最后说明这一部分在全篇中的作用'), '不该再要求补一段「全篇作用」');
});

test('AI 助读：引用池的默认问法平实，不追加复合任务', () => {
  const app = read('app.js');
  assert.match(app, /const ask = String\(text \|\| ''\)\.trim\(\) \|\| '这几段引文讲了什么？';/);
  assert.ok(!app.includes('梳理它们的要点、相互关系与可能的用法'), '默认问法不该顺手让模型写综述');
});
