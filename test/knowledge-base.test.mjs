// knowledge-base.test.mjs —— 本地知识库索引纯函数测试
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  tokenize,
  buildEntry,
  buildIndex,
  searchEntries,
  buildEvidenceBlock,
  readKnowledgeFullText,
} from '../src/knowledgeBase.js';

const base = (over = {}) => ({
  id: 'x', title: 'A study', authors: ['Zhang'], journal: 'J', year: 2020,
  doi: '', keywords: [], abstract: '', summary: '', conclusion: '', ...over,
});

test('空输入：所有导出都不抛错并返回合理空结构', () => {
  assert.deepEqual(tokenize(null), []);
  assert.deepEqual(tokenize(undefined), []);
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(123), []);
  const e = buildEntry(null);
  assert.equal(typeof e.id, 'string');
  assert.ok(Array.isArray(e.tokens));
  assert.ok(Array.isArray(e.keywords));
  assert.equal(typeof e.text, 'string');
  const idx = buildIndex(null);
  assert.equal(idx.version, 1);
  assert.deepEqual(idx.entries, []);
  assert.deepEqual(idx.stats, { documents: 0, withFullText: 0, libraries: 0 });
  assert.deepEqual(searchEntries(null, 'x'), []);
  assert.deepEqual(searchEntries(idx, ''), []);
  assert.equal(typeof buildEvidenceBlock(null), 'string');
  assert.equal(readKnowledgeFullText(null, null), '');
});

test('脏数据：null 元素与字段非字符串均被安全兜底', () => {
  const items = [
    null,
    { id: 'a', title: { weird: 1 }, authors: ['Zhang', 42, null], year: '2024', keywords: { k: 1 }, tags: undefined },
    { id: 'b', title: ['A', 'B'], year: 'not-a-year', docType: () => {}, collectionId: 7 },
    { id: '', title: '无 id 应被过滤' },
    42,
    'string-item',
  ];
  const idx = buildIndex(items, { now: '2026-01-01T00:00:00.000Z' });
  assert.equal(idx.stats.documents, 2, '仅保留两条有 id 的记录');
  assert.equal(idx.builtAt, '2026-01-01T00:00:00.000Z');
  for (const e of idx.entries) {
    assert.equal(typeof e.title, 'string');
    assert.equal(typeof e.year, 'number');
    assert.equal(typeof e.journal, 'string');
    assert.ok(Array.isArray(e.authors));
    assert.ok(Array.isArray(e.keywords));
    assert.ok(Array.isArray(e.tokens));
    assert.ok(e.tokens.length <= 400);
    assert.ok(e.text.length <= 20000);
  }
  assert.equal(idx.entries[1].year, 0, '非法年份兜底为 0');
  assert.equal(idx.entries[1].collectionId, '7', '数字兜底成字符串');
});

test('tokenize：中英混合分词、去停用词、全小写', () => {
  const t = tokenize('The Deep Learning 深度学习的目的 and 神经网络 of 2024');
  assert.ok(Array.isArray(t));
  assert.ok(t.every((x) => x === x.toLowerCase()), '全部小写');
  assert.ok(t.includes('deep'), '含英文词 deep');
  assert.ok(t.includes('learning'), '含英文词 learning');
  assert.ok(!t.includes('the'), '英文停用词 the 被去掉');
  assert.ok(!t.includes('and'), '英文停用词 and 被去掉');
  assert.ok(!t.includes('of'), '英文停用词 of 被去掉');
  assert.ok(t.includes('深度'), '中文 2-gram 深度');
  assert.ok(t.includes('学习'), '中文 2-gram 学习');
  assert.ok(t.includes('深'), '中文单字 深');
  assert.ok(!t.includes('的'), '中文停用词 的 被去掉');
  assert.ok(!t.includes('2024'), '纯数字不作为 token');
});

test('searchEntries：命中排序、标题加权、空 query 按年份倒序、不修改入参', () => {
  const idx = buildIndex([
    base({ id: 'a', title: 'Transformer for vision', year: 2024, keywords: ['transformer'] }),
    base({ id: 'b', title: 'A survey of graphs', year: 2020, abstract: 'we discuss transformer in passing' }),
    base({ id: 'c', title: 'Another transformer paper', year: 2022 }),
  ], { now: 'T0' });
  const before = JSON.stringify(idx);
  const hits = searchEntries(idx, 'transformer', 8);
  assert.equal(hits.length, 3);
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].score >= hits[i].score, '按得分降序');
  assert.equal(hits[0].id, 'a', '标题命中权重更高且年份最新，应排第一');
  assert.equal(hits[hits.length - 1].id, 'b', '仅摘要命中应排最后');
  assert.ok(hits.every((h) => typeof h.score === 'number'));
  assert.ok(hits.every((h) => h.snippet.length <= 180));
  assert.equal(JSON.stringify(idx), before, '不得修改入参');
  const empty = searchEntries(idx, '', 3);
  assert.deepEqual(empty.map((h) => h.id), ['a', 'c', 'b'], '空 query 按年份倒序');
  assert.ok(empty.every((h) => h.score === 0));
  assert.ok(empty.every((h) => typeof h.snippet === 'string'));
  assert.deepEqual(searchEntries(idx, '完全不存在的词zzz'), []);
});

test('buildEvidenceBlock：编号、英文+中文译名换行、末尾引用要求', () => {
  const hits = [
    { title: 'Visual Atypicality', titleZh: '视觉非典型性', authors: ['Zhang San', 'Li Si'], year: 2024, journal: 'JMR', summary: '本文研究生成图像的视觉非典型性。', text: '...' },
    { title: 'Deep Learning', titleZh: '', authors: 'Wang', year: 2021, journal: 'NIPS', summary: '', text: '绪论 摘要 深度学习方法 结论' },
  ];
  const block = buildEvidenceBlock(hits);
  assert.match(block, /\[1\]/);
  assert.match(block, /\[2\]/);
  assert.ok(block.includes('Visual Atypicality'));
  assert.match(block, /Visual Atypicality\n[^\n]*视觉非典型性/, '英文标题后换行接中文译名');
  assert.ok(block.includes('Zhang San'));
  assert.ok(block.includes('2024'));
  assert.ok(block.includes('JMR'));
  assert.ok(block.includes('本文研究生成图像的视觉非典型性。'), '含摘要摘录');
  assert.ok(block.includes('[编号]'), '末尾要求含 [编号]');
  assert.ok(block.includes('参考文献列表'), '末尾要求含参考文献列表');
  assert.equal(typeof buildEvidenceBlock([]), 'string');
});

test('buildEntry：字段齐全、tokens 去重且 ≤400、text ≤20000', () => {
  const words = Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ');
  const e = buildEntry({
    id: 'z1', title: '中文标题', titleZh: '译名', authors: ['A', 'B'], journal: 'J',
    year: 2023, doi: '10.1/x', docType: 'empirical', collectionId: 'C',
    keywords: ['kw1', 'kw2'], abstract: words, summary: '摘要', conclusion: '结论',
  }, '全文'.repeat(10000), 'NOW');
  assert.equal(e.titleZh, '译名');
  assert.equal(e.year, 2023);
  assert.deepEqual(e.authors, ['A', 'B']);
  assert.deepEqual(e.keywords, ['kw1', 'kw2']);
  assert.deepEqual(e.topics, []);
  assert.equal(e.updatedAt, 'NOW');
  assert.ok(e.tokens.length <= 400);
  assert.equal(new Set(e.tokens).size, e.tokens.length, 'tokens 去重');
  assert.ok(e.text.length <= 20000);
  assert.equal(buildEntry({ id: 'z2', title: '纯中文标题' }).titleZh, '', '无译名且标题含中文时留空');
});

test('buildIndex：注入 readFullText 与 now，统计 withFullText / libraries', () => {
  const readFullText = (it) => (it.id === 'a' ? 'A 的全文 ' + '机器学习 '.repeat(10) : '');
  const idx = buildIndex([
    { id: 'a', collectionId: 'C1' },
    { id: 'b', collectionId: 'C1' },
    { id: 'c', collectionId: 'C2' },
  ], { now: 'FIXED', readFullText });
  assert.equal(idx.builtAt, 'FIXED');
  assert.equal(idx.stats.documents, 3);
  assert.equal(idx.stats.withFullText, 1);
  assert.equal(idx.stats.libraries, 2);
  assert.equal(idx.entries[0].updatedAt, 'FIXED');
  assert.ok(idx.entries[0].text.includes('A 的全文'));
  assert.equal(idx.entries[1].text.includes('A 的全文'), false);
  assert.doesNotThrow(() => buildIndex([{ id: 'a' }], { readFullText: () => { throw new Error('boom'); } }));
});

test('readKnowledgeFullText：目录不存在返回空串（临时目录，测完清理）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-empty-'));
  try {
    assert.equal(readKnowledgeFullText(dir, { id: 'missing' }), '');
    assert.equal(readKnowledgeFullText(path.join(dir, 'nope'), { id: 'x' }), '');
    assert.equal(readKnowledgeFullText(dir, null), '');
    assert.equal(readKnowledgeFullText(null, { id: 'x' }), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readKnowledgeFullText：按文献 id 目录与 manifest literatureId 反查，且截断 60000', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-full-'));
  try {
    const d1 = path.join(dir, 'layout', 'L1');
    fs.mkdirSync(d1, { recursive: true });
    fs.writeFileSync(path.join(d1, 'paper.md'), '# 直连全文\n正文内容', 'utf8');
    assert.ok(readKnowledgeFullText(dir, { id: 'L1' }).includes('直连全文'));
    const d2 = path.join(dir, 'layout', 'job-xyz');
    fs.mkdirSync(d2, { recursive: true });
    fs.writeFileSync(path.join(d2, 'manifest.json'), JSON.stringify({ literatureId: 'L2', pages: 3 }), 'utf8');
    fs.writeFileSync(path.join(d2, 'paper.md'), '全'.repeat(70000), 'utf8');
    assert.equal(readKnowledgeFullText(dir, { id: 'L2' }).length, 60000);
    assert.equal(readKnowledgeFullText(dir, { id: 'L3' }), '', '无匹配返回空串');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
