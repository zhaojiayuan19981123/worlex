// direction-analyze.test.mjs —— 方向分析的提示词与结果解析（src/directionAnalyze.js）
//
// 这一层最怕两件事：模型输出被 token 上限截断（JSON 少了收尾括号）、
// 以及模型把文献编号写错（evidence 越界）。所以重点测「截断修复」与「编号收敛」。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANALYSIS_MODES, buildAnalysisMessages, describePaper, hasAnalysisContent,
  normalizeAnalysis, normalizeMode, parseAnalysisJson,
} from '../src/directionAnalyze.js';

const paper = (i, extra = {}) => ({
  id: `oa:W${i}`,
  title: `Paper ${i} on topic`,
  abstract: `Abstract ${i}. `.repeat(30),
  year: 2020 + i,
  authors: ['Alice', 'Bob'],
  venue: 'Journal of Things',
  citedBy: i * 10,
  ...extra,
});

test('消息体：文献按 1..N 编号，主题与模式说明都在', () => {
  const messages = buildAnalysisMessages({
    topics: [{ name: 'GNN 推荐' }],
    papers: [paper(1), paper(2)],
    mode: 'both',
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /研究空白/);
  assert.match(messages[1].content, /研究主题：GNN 推荐/);
  assert.match(messages[1].content, /【1】Paper 1 on topic/);
  assert.match(messages[1].content, /【2】Paper 2 on topic/);
  assert.match(messages[1].content, /gaps 至少 3 条/);
});

test('模式口径：只要空白时不给方向，只要方向时不列空白', () => {
  const gapOnly = buildAnalysisMessages({ topics: [], papers: [paper(1)], mode: 'gap' });
  assert.match(gapOnly[1].content, /只要 research gaps/);
  const dirOnly = buildAnalysisMessages({ topics: [], papers: [paper(1)], mode: 'direction' });
  assert.match(dirOnly[1].content, /只要 research directions/);
  assert.equal(normalizeMode('nonsense'), 'both');
  assert.equal(ANALYSIS_MODES.length, 3);
});

test('摘要预算：篇数越多每篇份额越小，但不会低于 500 字', () => {
  const long = (i) => paper(i, { abstract: `A${i} `.repeat(1200) });
  const few = buildAnalysisMessages({ papers: [long(1), long(2)], budget: 20000 });
  const many = buildAnalysisMessages({ papers: Array.from({ length: 40 }, (_, i) => long(i + 1)), budget: 20000 });
  const first = (messages) => messages[1].content.split('摘要：')[1].split('\n')[0].length;
  assert.ok(first(few) > first(many), '篇数多时单篇摘要应更短');
  // 40 篇 × 500 字是下限，不能再压缩
  assert.ok(first(many) >= 500);
  const tiny = buildAnalysisMessages({ papers: [paper(1)], budget: 100 });
  assert.ok(tiny[1].content.includes('Abstract 1.'));
  assert.ok(describePaper(paper(1), 1, 20).includes('…'));
});

test('没有摘要的文献也编号，但明确标注「只能按标题判断」', () => {
  const block = describePaper(paper(1, { abstract: '' }), 3, 500);
  assert.match(block, /【3】/);
  assert.match(block, /未提供/);
});

// ---------- 解析 ----------

const sample = {
  overview: '这批文献都在做图神经网络的推荐应用。',
  gaps: [{ title: '冷启动缺失', statement: '没人处理新用户', why: '文献 1、2 都假设有交互历史', evidence: [1, 2], confidence: 'high' }],
  directions: [{ title: '跨域迁移', question: '能否用他域行为缓解冷启动？', approach: '元学习 + 图预训练', data: '公开跨域数据集', contribution: '首个跨域 GNN 冷启动框架', novelty: '把元学习引入图结构', difficulty: '高', risks: '数据难获取', evidence: [2] }],
  clusters: [{ name: '图协同过滤', summary: '主流的 GNN 推荐范式', papers: [1, 2] }],
  readingOrder: [{ index: 1, reason: '先看综述式的那篇' }],
  cautions: ['样本仅 2 篇，结论不具代表性'],
};

test('标准 JSON、代码块、前置说明都能解析', () => {
  assert.equal(parseAnalysisJson(JSON.stringify(sample)).overview, sample.overview);
  assert.equal(parseAnalysisJson('```json\n' + JSON.stringify(sample) + '\n```').overview, sample.overview);
  assert.equal(parseAnalysisJson(`好的，分析如下：\n${JSON.stringify(sample)}\n以上。`).overview, sample.overview);
  assert.equal(parseAnalysisJson('完全不是 JSON'), null);
});

test('被 token 截断的 JSON 能补齐收尾括号救回来', () => {
  const full = JSON.stringify(sample, null, 2);
  // 砍在小标题中间：既没有收尾引号，也没有闭合的 ] 与 }
  const cut = full.slice(0, full.indexOf('跨域迁移') + 2);
  const parsed = parseAnalysisJson(cut);
  assert.ok(parsed, '截断后应能救回前几个字段');
  assert.equal(parsed.overview, sample.overview);
  assert.equal(parsed.gaps.length, 1);
});

test('截断在数组元素中间（逗号残留）也不崩', () => {
  const cut = '{"overview":"x","gaps":[{"title":"a","statement":"b"},';
  const parsed = parseAnalysisJson(cut);
  assert.ok(parsed);
  assert.equal(parsed.gaps.length, 1);
});

// ---------- 收敛 ----------

test('evidence 越界 / 非数字 / 重复都被收敛到 1..N', () => {
  const out = normalizeAnalysis({
    gaps: [{ title: 'A', statement: 'S', evidence: [1, 99, 1, '文献3', 0] }],
  }, { paperCount: 3 });
  assert.deepEqual(out.gaps[0].evidence, [1, 3]);
});

test('重复的空白点被去重，空条目被丢掉', () => {
  const out = normalizeAnalysis({
    gaps: [
      { title: 'Same', statement: 'Same text' },
      { title: 'Same', statement: 'Same text' },
      { title: '', statement: '' },
    ],
  }, { paperCount: 5 });
  assert.equal(out.gaps.length, 1);
});

test('只找空白时不保留方向，只给方向时不保留空白', () => {
  const gapOnly = normalizeAnalysis(sample, { paperCount: 2, mode: 'gap' });
  assert.equal(gapOnly.directions.length, 0);
  assert.equal(gapOnly.gaps.length, 1);
  const dirOnly = normalizeAnalysis(sample, { paperCount: 2, mode: 'direction' });
  assert.equal(dirOnly.gaps.length, 0);
  assert.equal(dirOnly.directions.length, 1);
});

test('难度与置信度的中英文写法都能归一', () => {
  const out = normalizeAnalysis({
    gaps: [{ title: 'G', statement: 's', confidence: '低' }],
    directions: [{ title: 'D', question: 'q', difficulty: 'low' }],
  }, { paperCount: 2 });
  assert.equal(out.gaps[0].confidence, 'low');
  assert.equal(out.directions[0].difficulty, '低');
  const unknown = normalizeAnalysis({ gaps: [{ title: 'G', statement: 's', confidence: '???' }] }, { paperCount: 2 });
  assert.equal(unknown.gaps[0].confidence, 'medium');
});

test('阅读顺序的编号越界直接丢弃，合法编号保留', () => {
  const out = normalizeAnalysis({
    readingOrder: [{ index: 99, reason: 'x' }, { index: '2', reason: '先读它' }],
  }, { paperCount: 3 });
  assert.deepEqual(out.readingOrder, [{ index: 2, reason: '先读它' }]);
});

test('超长字段被截断，不把整段话塞进卡片', () => {
  const out = normalizeAnalysis({ overview: 'x'.repeat(5000), directions: [{ title: 'D', question: 'q', approach: 'y'.repeat(3000) }] }, { paperCount: 1 });
  assert.ok(out.overview.length <= 2401);
  assert.ok(out.directions[0].approach.length <= 801);
});

test('模型换了字段名（summary / method / papers）也能落到标准结构', () => {
  const out = normalizeAnalysis({
    summary: '概述',
    gaps: [{ name: '别名标题', gap: '空白描述', reason: '原因', papers: [1] }],
    directions: [{ name: '方向', rq: '问题', method: '方法', expected: '贡献', papers: [2] }],
    clusters: [{ title: '簇', description: '说明', evidence: [1, 2] }],
    cautions: '单条字符串',
  }, { paperCount: 2 });
  assert.equal(out.overview, '概述');
  assert.equal(out.gaps[0].title, '别名标题');
  assert.equal(out.directions[0].approach, '方法');
  assert.equal(out.directions[0].contribution, '贡献');
  assert.equal(out.clusters[0].name, '簇');
  assert.deepEqual(out.cautions, ['单条字符串']);
});

test('内容判定：只有 overview 也算成功，全空才算失败', () => {
  assert.equal(hasAnalysisContent({ overview: '有话说' }), true);
  assert.equal(hasAnalysisContent({ gaps: [{ title: 'a' }] }), true);
  assert.equal(hasAnalysisContent({ overview: '', gaps: [], directions: [], clusters: [] }), false);
  assert.equal(hasAnalysisContent(null), false);
});
