// v213-features.test.mjs —— v2.1.3 两项改动的接线与行为测试
//
// 1) 点击节点：详情面板列出「关联文献」，并说明每一篇为什么相连
//    （共享主题词 / 共同作者 / 同分类 / 引用方向），画布上只提亮它的邻域
// 2) 只显示某一个主题时：簇铺满画布，节点摊开，便于看清单个主题内部的关系
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../server.js';
import * as store from '../src/store.js';

const norm = (s) => s.replace(/\r\n/g, '\n');
const read = (p) => norm(readFileSync(new URL(`../public/${p}`, import.meta.url), 'utf8'));
const readText = (rel) => norm(readFileSync(new URL(rel, import.meta.url), 'utf8'));

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
}

test('图谱视图：点击节点会列出关联文献，并给出「为什么相连」', () => {
  const g = read('knowledge-graph.js');
  // 详情面板里新增「关联文献」区块
  assert.match(g, /function neighborSection\(n\)/);
  assert.match(g, /head\.appendChild\(el\('span', '', '关联文献'\)\)/);
  assert.match(g, /body\.appendChild\(neighborSection\(n\)\);/);
  // 同一对文献的多条边合成一条记录，理由合并，避免列表里出现两遍同一篇
  assert.match(g, /function neighborsOf\(n\)/);
  assert.match(g, /const other = e\.s === n \? e\.t : e\.t === n \? e\.s : null;/);
  assert.match(g, /if \(why && rec\.reasons\.indexOf\(why\) === -1\) rec\.reasons\.push\(why\);/);
  // 理由文案：引用方向按 citing 还原（source/target 被字典序重排过）
  assert.match(g, /function whyText\(e, self\)/);
  assert.match(g, /return e\.citing === self\.id \? '本篇引用了它' : '它引用了本篇';/);
  assert.match(g, /return e\.reason \|\| '研究主题相近';/);
  // 点击关联条目 → 定位并打开那一篇
  assert.match(g, /function focusNode\(id\)/);
  assert.match(g, /listen\(btn, 'click', \(\) => focusNode\(other\.id\), undefined, 'detail'\);/);
  // 画布上只提亮邻域，其余压暗
  assert.match(g, /function markNeighborhood\(n\)/);
  assert.match(g, /root\.classList\.add\('kg-focus'\);/);
  assert.match(g, /function clearNeighborhood\(\)/);
  assert.match(g, /clearNeighborhood\(\);/);
  // tooltip 也补上主题与关联数
  assert.match(g, /extra\.push\('主题：' \+ n\.cluster\.label\)/);
  assert.match(g, /extra\.push\(n\.deg \+ ' 条关联'\)/);
});

test('图谱样式：邻域提亮 / 关联条目 / 跳转闪烁都有对应规则', () => {
  const css = read('knowledge-graph.css');
  assert.match(css, /\.kg-root\.kg-focus \.kg-node \{ opacity: \.14; \}/);
  assert.match(css, /\.kg-root\.kg-focus \.kg-edge\.is-hot \{ opacity: \.9; stroke-width: 1\.7; \}/);
  assert.match(css, /\.kg-node\.is-flash \.kg-disc \{ animation: kgNodeFlash/);
  assert.match(css, /\.kg-d-neighbors \{/);
  assert.match(css, /\.kg-d-nb \{/);
  assert.match(css, /\.kg-d-why \{/);
  assert.match(css, /\.kg-d-dot\.t7 \{ background: var\(--kg-c7\); \}/);
});

test('图谱布局：只剩一个主题时铺满画布，并放宽斥力与弹簧长度', () => {
  const g = read('knowledge-graph.js');
  // 可见成员才算数：过滤后别的簇不再占画布格子
  assert.match(g, /const shownIn = \(c\) => c\.nodes\.reduce\(\(k, n\) => k \+ \(n\.visible \? 1 : 0\), 0\);/);
  assert.match(g, /const active = S\.clusters\.filter\(\(c\) => shownIn\(c\) > 0\);/);
  // 单簇分支：中心落在画布中心、半径吃到短边
  assert.match(g, /S\.layout = \{ single: m === 1, clusters: m \};/);
  assert.match(g, /c\.rTarget = Math\.max\(90, Math\.min\(availW, H\) \/ 2 - 46\);/);
  // 物理参数随「单主题」放大：斥力、作用半径、弹簧静止长度，并把弹簧放软
  assert.match(g, /const single = !!\(S\.layout && S\.layout\.single\);/);
  assert.match(g, /const repulsion = single \? REPULSION \* 3\.2 : REPULSION;/);
  assert.match(g, /const cutoff2 = single \? 250000 : 90000;/);
  assert.match(g, /const clusterK = single \? CLUSTER_K \* 0\.35 : CLUSTER_K;/);
  assert.match(g, /const springK = single \? SPRING_K \* 0\.55 : SPRING_K;/);
  assert.match(g, /const base = single\n\s+\? Math\.max\(120, Math\.min\(320, rt \* 0\.85\)\)/);
  // 详情面板打开时，单主题簇摆到未被遮挡的那块中间
  assert.match(g, /const availW = Math\.max\(220, W - panelW\);/);
  // 筛选变化后重排中心并多给几帧，节点才有时间摊开
  assert.match(g, /const changed = !!prev && \(prev\.single !== S\.layout\.single \|\| prev\.clusters !== S\.layout\.clusters\);/);
  assert.match(g, /startSim\(changed \? 120 : 45\);/);
});

test('后端：边带 reason，图谱结构版本写入缓存以便旧缓存自动重建', () => {
  const kg = readText('../src/knowledgeGraph.js');
  assert.match(kg, /export const GRAPH_VERSION = 3;/);
  assert.match(kg, /export function buildEdges\(entries, assignments, options\)/);
  assert.match(kg, /`共同关键词：\$\{terms\.join\('、'\)\}`/);
  assert.match(kg, /reason: shared\.length \? `共同作者：\$\{shared\.join\('、'\)\}` : '作者有重合'/);
  assert.match(kg, /reason: cname \? `同属分类「\$\{cname\}」` : '归在同一分类'/);
  assert.match(kg, /citing: ab >= ba \? idA : idB/);
  assert.match(kg, /version: GRAPH_VERSION,/);

  const server = readText('../server.js');
  assert.match(server, /const usable = cached && Array\.isArray\(cached\.nodes\) && cached\.version === GRAPH_VERSION;/);
  assert.match(server, /function graphOptions\(\)/);
  assert.match(server, /collectionNames\[String\(c\.id\)\] = String\(c\.name \|\| ''\)\.trim\(\);/);
  assert.match(server, /kbGraphCache = buildGraph\(kbIndex, graphOptions\(\)\);/);
});

test('HTTP：图谱接口返回的每条边都能解释「为什么相连」', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'v213-edges-'));
  const dataDir = path.join(root, 'data');
  const uploadDir = path.join(root, 'uploads');
  let server = null;
  try {
    store.configure({ dataDir });
    store.saveSettings({ aiProvider: 'none', _modelMigrated: true, activeProfileId: '', modelProfiles: [] });
    store.saveCollections([{ id: 'C1', name: '营销实证' }]);
    const rows = [
      { id: 'a', title: '在线评论对酒店绩效的影响', authors: ['张三'], collectionId: 'C1' },
      { id: 'b', title: '在线评论与消费者购买意愿', authors: ['张三'], collectionId: 'C1' },
      { id: 'c', title: '供应链韧性的测量', authors: ['李四'], collectionId: 'C2' },
    ];
    for (const r of rows) {
      store.upsertLiterature({
        ...r,
        titleZh: r.title,
        year: 2024,
        journal: '管理世界',
        docType: 'empirical',
        keywords: r.id === 'c' ? ['供应链', '韧性'] : ['在线评论', '购买意愿'],
        summary: r.id === 'c' ? '供应链韧性与风险传染。' : '在线评论影响酒店绩效与购买意愿。',
        tags: [],
        status: 'done',
        annotations: [],
        attachments: [],
      });
    }

    const { app } = createApp({ uploadDir });
    server = createServer(app);
    const base = await listen(server);
    await fetch(base + '/api/knowledge/rebuild', { method: 'POST' });

    const graph = await (await fetch(base + '/api/knowledge/graph')).json();
    assert.ok(Array.isArray(graph.edges) && graph.edges.length > 0, '三篇文献之间应有边');
    assert.equal(graph.version, 3, '新装配的图谱带结构版本号');
    for (const e of graph.edges) {
      assert.equal(typeof e.reason, 'string');
      assert.ok(e.reason.length > 0, `边 ${e.source}→${e.target}（${e.kind}）缺少理由`);
    }
    const author = graph.edges.find((e) => e.kind === 'author');
    assert.ok(author, 'a / b 有共同作者，应有作者边');
    assert.match(author.reason, /共同作者：张三/);
    const col = graph.edges.find((e) => e.kind === 'collection');
    assert.ok(col, 'a / b 同分类，应有分类边');
    assert.equal(col.reason, '同属分类「营销实证」');
    const topic = graph.edges.find((e) => e.kind === 'topic' && /共同关键词/.test(e.reason));
    assert.ok(topic, '共享关键词的文献应给出「共同关键词」理由');
    assert.match(topic.reason, /在线评论/);
  } finally {
    if (server) await close(server);
    store.saveSettings({ aiProvider: 'none', _modelMigrated: true, activeProfileId: '', modelProfiles: [] });
    await rm(root, { recursive: true, force: true });
  }
});
