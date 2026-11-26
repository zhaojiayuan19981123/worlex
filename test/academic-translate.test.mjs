// academic-translate.test.mjs —— 文献批量翻译：只用翻译引擎，不用大模型
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACADEMIC_ENGINES, academicEngineList, resolveAcademicEngine, splitForEngine, translateSegments,
} from '../src/academicTranslate.js';

test('引擎白名单排除大模型与内置小模型', () => {
  const ids = ACADEMIC_ENGINES.map((e) => e.id);
  assert.ok(!ids.includes('siliconflow'), '不能走当前激活的大模型');
  assert.ok(!ids.includes('builtin'), '内置翻译模型本质仍是 LLM，也要排除');
  assert.ok(ids.includes('deepl') && ids.includes('youdaoweb') && ids.includes('free'));
});

test('自动选引擎：已配密钥的引擎优先，没配则用免密钥网页引擎', () => {
  assert.equal(resolveAcademicEngine({ translateProvider: 'siliconflow' }), 'youdaoweb');
  assert.equal(resolveAcademicEngine({ translateProvider: 'builtin' }), 'youdaoweb');
  assert.equal(resolveAcademicEngine({ deeplKey: 'abc' }), 'deepl');
  assert.equal(resolveAcademicEngine({ volcKey: 'ak#sk' }, 'volcapi'), 'volcapi');
  // 用户显式点的大模型引擎不能被放行
  assert.equal(resolveAcademicEngine({ deeplKey: 'abc' }, 'siliconflow'), 'deepl');
  const list = academicEngineList({ deeplKey: 'abc' });
  assert.equal(list.find((e) => e.id === 'deepl').configured, true);
  assert.equal(list.find((e) => e.id === 'youdaoweb').configured, true);
});

test('长文本按句读切段，短文本原样返回', () => {
  assert.deepEqual(splitForEngine('Short abstract.'), ['Short abstract.']);
  const text = Array.from({ length: 30 }, (_, i) => `Sentence ${i} discusses neural networks.`).join(' ');
  const parts = splitForEngine(text, 200);
  assert.ok(parts.length > 3);
  assert.ok(parts.every((p) => p.length <= 200));
  assert.equal(parts.join(' ').replace(/\s+/g, ' ').trim(), text.replace(/\s+/g, ' ').trim());
});

test('批量翻译把每段交给非大模型引擎，并回报进度', async () => {
  const seen = [];
  const progress = [];
  const out = await translateSegments([
    { id: 'a|title', text: 'Graph neural networks' },
    { id: 'a|abstract', text: 'We study cold start problems.' },
  ], {
    settings: { deeplKey: 'fake' },
    translateImpl: async (engine, text) => { seen.push([engine, text]); return `译：${text}`; },
    onProgress: (done, total) => progress.push([done, total]),
  });
  assert.deepEqual(seen.map((s) => s[0]), ['deepl', 'deepl']);
  assert.equal(out[0].translation, '译：Graph neural networks');
  assert.deepEqual(progress, [[1, 2], [2, 2]]);
});

test('主引擎限流时自动降级到另一个翻译引擎', async () => {
  const seen = [];
  const out = await translateSegments([{ id: 'p|title', text: 'Attention is all you need' }], {
    settings: { deeplKey: 'fake' },
    engine: 'deepl',
    translateImpl: async (engine, text) => {
      seen.push(engine);
      if (engine === 'deepl') throw new Error('DeepL 返回 429: rate limit');
      return `降级译文：${text}`;
    },
  });
  assert.equal(seen[0], 'deepl');
  assert.ok(seen.some((id) => ['volcweb', 'youdaoweb', 'free'].includes(id)), `应降级到别的引擎，实际 ${seen}`);
  assert.match(out[0].translation, /^降级译文/);
  assert.equal(out[0].error, '');
});

test('全部引擎都失败时保留原文不炸掉整批', async () => {
  const out = await translateSegments([{ id: 'x', text: 'Hello' }], {
    settings: { deeplKey: 'fake' },
    engine: 'deepl',
    translateImpl: async () => { throw new Error('boom'); },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].translation, '');
  assert.match(out[0].error, /boom/);
});
