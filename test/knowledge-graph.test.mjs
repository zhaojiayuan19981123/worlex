// knowledge-graph.test.mjs —— 主题聚类 + 文献关系图纯函数测试
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clusterTopics,
  buildEdges,
  buildGraph,
  applyTopicGroups,
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
  assert.equal(g.method, 'local', '没有大模型分组时标记为本地聚类');
});

// ==================== 大模型主题分组（applyTopicGroups） ====================

test('applyTopicGroups：空输入 / 脏数据都不抛错', () => {
  assert.deepEqual(applyTopicGroups(null, null), { topics: [], assignments: {}, coverage: 0 });
  assert.deepEqual(applyTopicGroups([], [{ name: 'x', ids: ['a'] }]), { topics: [], assignments: {}, coverage: 0 });
  const entries = [entry({ id: 'a' })];
  assert.equal(applyTopicGroups(entries, null).coverage, 0);
  assert.equal(applyTopicGroups(entries, [null, 1, 'x']).coverage, 0);
});

test('applyTopicGroups：不存在的 id 丢掉、重复归类只认第一次、空主题丢弃', () => {
  const entries = [entry({ id: 'a' }), entry({ id: 'b' }), entry({ id: 'c' })];
  const out = applyTopicGroups(entries, [
    { name: '  在线评论  ', keywords: ['评论', '情感'], ids: ['a', 'ghost', 'a'] },
    { name: '空主题', ids: ['ghost'] },
    { name: '平台治理', ids: ['b', 'a'] },  // a 已被前面的主题认领
  ]);
  assert.equal(out.coverage, 2);
  assert.deepEqual(out.topics.map((t) => t.label), ['在线评论', '平台治理', '未分类']);
  const byLabel = Object.fromEntries(out.topics.map((t) => [t.label, t]));
  assert.equal(byLabel['在线评论'].count, 1);
  assert.equal(byLabel['平台治理'].count, 1);
  assert.equal(byLabel['未分类'].count, 1, '没被归类的进「未分类」');
  assert.deepEqual(byLabel['在线评论'].terms, ['评论', '情感']);
  assert.equal(out.assignments.a.label, '在线评论');
  assert.equal(out.assignments.c.topicId, 'topic-uncategorized');
});

test('applyTopicGroups：主题按篇数降序排序，篇数相同按名字', () => {
  const entries = ['a', 'b', 'c', 'd'].map((id) => entry({ id }));
  const out = applyTopicGroups(entries, [
    { name: '乙主题', ids: ['a'] },
    { name: '甲主题', ids: ['b', 'c'] },
    { name: '丙主题', ids: ['d'] },
  ]);
  assert.deepEqual(out.topics.map((t) => t.label), ['甲主题', '丙主题', '乙主题']);
  assert.deepEqual(out.topics.map((t) => t.count), [2, 1, 1]);
});

test('applyTopicGroups：主题名超长截断、keywords 归一化', () => {
  const out = applyTopicGroups([entry({ id: 'a' })], [{
    name: '很'.repeat(80),
    keywords: 'k1；k2',
    ids: ['a'],
  }]);
  assert.equal(out.topics[0].label.length, 40);
  assert.deepEqual(out.topics[0].terms, ['k1', 'k2'], '字符串关键词按中文分号拆开');
});

test('buildGraph：传入大模型分组时走 llm 分支，节点带上主题名', () => {
  const entries = [
    entry({ id: 'a', title: '在线评论情感分析', keywords: ['评论'], tokens: ['评论', '情感'] }),
    entry({ id: 'b', title: '酒店评分与忠诚度', keywords: ['酒店'], tokens: ['酒店', '评分'] }),
    entry({ id: 'c', title: '平台治理机制', keywords: ['平台'], tokens: ['平台', '治理'] }),
  ];
  const g = buildGraph({ entries }, {
    topicGroups: [
      { name: '在线评论与酒店绩效', keywords: ['评论', '酒店'], ids: ['a', 'b'] },
      { name: '平台治理', ids: ['c'] },
    ],
  });
  assert.equal(g.method, 'llm');
  assert.deepEqual(g.topics.map((t) => t.label).sort(), ['在线评论与酒店绩效', '平台治理'].sort());
  const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
  assert.equal(byId.a.topicLabel, '在线评论与酒店绩效');
  assert.equal(byId.c.topicLabel, '平台治理');
  assert.equal(g.stats.documents, 3);
  assert.equal(g.stats.topics, 2);
});

test('buildGraph：大模型分组全是无效 id 时自动退回本地聚类', () => {
  const entries = [entry({ id: 'a', tokens: ['x', 'y'] }), entry({ id: 'b', tokens: ['x', 'y'] })];
  const g = buildGraph({ entries }, { topicGroups: [{ name: '假的', ids: ['nope'] }] });
  assert.equal(g.method, 'local');
  assert.equal(g.stats.documents, 2);
});
