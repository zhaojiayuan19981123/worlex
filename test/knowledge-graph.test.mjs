// knowledge-graph.test.mjs —— 主题聚类 + 文献关系图纯函数测试
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clusterTopics,
  buildEdges,
  buildGraph,
  mergeTags,
} from '../src/knowledgeGraph.js';

const entry = (over = {}) => ({
  id: 'x', title: 'T', titleZh: '', authors: [], journal: '', year: 2020,
  doi: '', docType: 'empirical', collectionId: '', keywords: [], tokens: [],
  summary: '', text: '', tags: [], ...over,
});

test('空 entries：四个导出都不抛错且返回空结构', () => {
  assert.deepEqual(clusterTopics(null), { topics: [], assignments: {} });
  assert.deepEqual(clusterTopics([]), { topics: [], assignments: {} });
  assert.deepEqual(buildEdges(null), []);
  assert.deepEqual(buildEdges([], {}), []);
  assert.deepEqual(mergeTags(null, null), []);
  const g = buildGraph(null);
  assert.deepEqual(g.nodes, []);
  assert.deepEqual(g.edges, []);
  assert.deepEqual(g.topics, []);
  assert.deepEqual(g.stats, { documents: 0, topics: 0, relations: 0 });
  assert.deepEqual(buildGraph({ entries: [] }).stats, { documents: 0, topics: 0, relations: 0 });
});

test('确定性：相同输入两次调用 deepEqual（clusterTopics / buildEdges / buildGraph）', () => {
  const entries = [
    entry({ id: 'a', title: 'Deep learning for vision', keywords: ['deep learning', 'vision'], tokens: ['deep', 'learning', 'vision', 'model'], authors: ['Zhang'], collectionId: 'C1', year: 2022 }),
    entry({ id: 'b', title: 'Deep learning in images', keywords: ['deep learning', 'vision'], tokens: ['deep', 'learning', 'vision', 'image'], authors: ['Zhang', 'Li'], collectionId: 'C1', year: 2021, text: 'see Zhang 2022' }),
    entry({ id: 'c', title: 'Graph neural networks', keywords: ['graph', 'network'], tokens: ['graph', 'neural', 'network'], authors: ['Wang'], collectionId: 'C2', year: 2023 }),
  ];
  const c1 = clusterTopics(entries);
  const c2 = clusterTopics(entries);
  assert.deepStrictEqual(c1, c2);
  assert.deepStrictEqual(buildEdges(entries, c1.assignments), buildEdges(entries, c1.assignments));
  assert.deepStrictEqual(buildGraph({ entries }), buildGraph({ entries }));
  assert.deepStrictEqual(clusterTopics(entries, { maxTopics: 2 }), clusterTopics(entries, { maxTopics: 2 }));
});

test('clusterTopics：两篇高度相似文献聚到同一主题，异主题文献分开', () => {
  const shared = {
    keywords: ['transformer', 'attention', 'vision'],
    tokens: ['transformer', 'attention', 'vision', 'encoder', 'image', 'model'],
    authors: ['Zhang'], collectionId: 'C1',
  };
  const entries = [
    entry({ id: 'p1', title: 'Transformer attention for vision', ...shared }),
    entry({ id: 'p2', title: 'Transformer attention in vision tasks', ...shared }),
    entry({ id: 'p3', title: 'RNA sequencing', keywords: ['rna', 'sequencing'], tokens: ['rna', 'sequencing', 'gene', 'cell'], authors: ['Li'], collectionId: 'C2' }),
  ];
  const { topics, assignments } = clusterTopics(entries);
  assert.equal(assignments.p1.topicId, assignments.p2.topicId, '两篇相似文献同主题');
  assert.notEqual(assignments.p1.topicId, assignments.p3.topicId, '异主题文献不同簇');
  assert.ok(topics.length >= 2);
  for (const t of topics) {
    assert.equal(typeof t.id, 'string');
    assert.ok(typeof t.label === 'string' && t.label.length > 0);
    assert.ok(Array.isArray(t.terms));
    assert.equal(typeof t.count, 'number');
  }
});

test('buildEdges：无自环、无重复边、每节点 ≤8 条、总数 ≤1200', () => {
  const entries = Array.from({ length: 40 }, (_, i) => entry({
    id: `n${String(i).padStart(3, '0')}`,
    title: `Study ${i} on transformer attention`,
    authors: ['Zhang', 'Li'],
    collectionId: 'C1',
    keywords: ['transformer', 'attention'],
    tokens: ['transformer', 'attention', 'model', 'vision', 'image'],
    text: `cites Zhang 2020 and Study ${Math.max(0, i - 1)} on transformer attention`,
    year: 2020,
  }));
  const { assignments } = clusterTopics(entries);
  const edges = buildEdges(entries, assignments);
  assert.ok(edges.length <= 1200);
  const keys = new Set();
  const degree = new Map();
  for (const e of edges) {
    assert.notEqual(e.source, e.target, '不得自环');
    assert.ok(e.source < e.target, 'source < target 规范');
    assert.ok(e.weight > 0);
    assert.ok(['topic', 'author', 'collection', 'citation'].includes(e.kind));
    const key = `${e.source}|${e.target}|${e.kind}`;
    assert.ok(!keys.has(key), '不得重复边');
    keys.add(key);
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }
  for (const d of degree.values()) assert.ok(d <= 8, '每篇最多 8 条');
});

test('mergeTags：过滤控制字符、去重、去空白、≤12 个', () => {
  const out = mergeTags(null, ['good tag', 'bad\u0001tag', '另一个', 'GOOD TAG', '  spaced  ', '']);
  assert.ok(out.includes('good tag'));
  assert.ok(out.includes('另一个'));
  assert.ok(!out.some((t) => t.includes('\u0001')));
  assert.equal(out.filter((t) => t.toLowerCase() === 'good tag').length, 1, '大小写不敏感去重');
  assert.ok(out.includes('spaced'), '去首尾空白');
  const many = Array.from({ length: 30 }, (_, i) => `tag${i}`);
  const capped = mergeTags({ tags: ['pre'] }, many);
  assert.ok(capped.length <= 12);
  assert.equal(capped[0], 'pre', '合并 node 现有标签且保序');
  assert.deepEqual(mergeTags(null, 'a, b；c、d'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(mergeTags(42, 42), ['42']);
  assert.deepEqual(mergeTags(undefined, undefined), []);
});

test('clusterTopics：空向量条目统一归「未分类」，maxTopics 上限生效', () => {
  const { topics, assignments } = clusterTopics([entry({ id: 'e1' }), entry({ id: 'e2' })]);
  assert.ok(topics.length >= 1);
  assert.ok(topics.some((t) => t.label === '未分类'));
  assert.equal(assignments.e1.topicId, assignments.e2.topicId);
  assert.equal(assignments.e1.label, '未分类');
  const many = Array.from({ length: 20 }, (_, i) => entry({ id: `m${i}`, tokens: [`only${i}`], keywords: [`k${i}`] }));
  assert.ok(clusterTopics(many, { maxTopics: 3 }).topics.length <= 3);
});

test('clusterTopics：中文 2-gram 虚词碎片不作为主题标签', () => {
  const noise = ['不会', '会不', '个非', '的非', '这个', '可以'];
  const shared = {
    keywords: ['供应链', '韧性'],
    tokens: [...noise, '供应', '应链', '韧性'],
  };
  const { topics } = clusterTopics([
    entry({ id: 'n1', title: '供应链韧性研究', ...shared }),
    entry({ id: 'n2', title: '供应链韧性实证', ...shared }),
  ]);
  assert.ok(topics.length >= 1);
  for (const t of topics) {
    for (const w of noise) assert.ok(!t.label.includes(w), `标签不该含 ${w}：${t.label}`);
    assert.ok(t.label.length > 0);
  }
});

test('buildGraph：节点字段齐全、顺序稳定、stats 正确', () => {
  const entries = [
    entry({ id: 'b', title: 'B', titleZh: '乙', authors: ['X'], year: 2021, journal: 'J2', docType: 'model', collectionId: 'C2', keywords: ['b'], tags: ['t2'], tokens: ['b', 'beta'], hasPdf: true }),
    entry({ id: 'a', title: 'A', authors: ['Y'], year: 2020, journal: 'J1', docType: 'algorithm', collectionId: 'C1', keywords: ['a'], tokens: ['a', 'alpha'] }),
  ];
  const g = buildGraph({ entries });
  assert.deepEqual(g.nodes.map((n) => n.id), ['b', 'a'], '节点顺序与输入一致');
  for (const k of ['id', 'title', 'titleZh', 'authors', 'year', 'journal', 'docType', 'collectionId', 'topicId', 'topicLabel', 'keywords', 'tags', 'hasPdf']) {
    assert.ok(k in g.nodes[0], `节点缺字段 ${k}`);
  }
  assert.equal(g.nodes[0].hasPdf, true);
  assert.equal(g.nodes[1].hasPdf, false);
  assert.equal(g.stats.documents, 2);
  assert.equal(typeof g.stats.topics, 'number');
  assert.equal(g.stats.relations, g.edges.length);
  assert.notEqual(g.nodes[0].topicId, '', '应有主题分配');
});
