// direction-search.test.mjs —— 方向分析的检索层（src/directionSearch.js）
//
// 这一层不联网就能测全：查询构造是纯函数，取数靠注入的 fetchImpl。
// 重点盯三件事：
//   1) 关键词怎么变成 OpenAlex 的查询（引号短语 / AND 连接 / 字段限定）；
//   2) 多主题合并的次序与去重（DOI 优先，标题兜底）；
//   3) 过滤规则的边界（摘要门槛、排除词、每主题条数、单个主题失败不拖垮整体）。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_FILTERS, MAX_RESULTS, MAX_TOPICS,
  buildQuery, buildUrl, normalizeFilters, normalizeTopic, parseWork, reconstructAbstract,
  searchTopic, searchTopics, stripDoi, titleKey, topicPhrases, linksFor, workKey,
} from '../src/directionSearch.js';

/** 假的上游：按 URL 里的 search / filter 决定返回什么，并记录请求过的地址 */
function fakeOpenAlex(handler) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const body = handler(url, calls.length);
    return {
      ok: body.status ? body.status < 400 : true,
      status: body.status || 200,
      text: async () => (typeof body.body === 'string' ? body.body : JSON.stringify(body.body)),
    };
  };
  return { fetchImpl, calls };
}

/** 按 OpenAlex 的形状造一条 work */
function work({ title, doi = '', abstractWords = 30, year = 2024, cited = 10 }) {
  const inverted = {};
  for (let i = 0; i < abstractWords; i += 1) inverted[`w${i}`] = [i];
  return {
    id: `https://openalex.org/W${Math.abs(hash(title))}`,
    ids: { openalex: `https://openalex.org/W${Math.abs(hash(title))}` },
    doi: doi ? `https://doi.org/${doi}` : null,
    display_name: title,
    publication_year: year,
    publication_date: `${year}-05-01`,
    abstract_inverted_index: inverted,
    authorships: [{ author: { display_name: 'Ada Lovelace' } }, { author: { display_name: 'Alan Turing' } }],
    primary_location: { source: { display_name: 'Journal of Tests', type: 'journal' }, landing_page_url: `https://example.org/${encodeURIComponent(title)}` },
    cited_by_count: cited,
    type: 'article',
    language: 'en',
    best_oa_location: null,
    primary_topic: { display_name: 'Test Topic' },
  };
}

function hash(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
}

// ---------- 关键词 → 查询 ----------

test('关键词按逗号/分号/换行拆短语，空格留在短语内部', () => {
  assert.deepEqual(topicPhrases('large language model, recommendation；冷启动\nfederated learning'), [
    'large language model', 'recommendation', '冷启动', 'federated learning',
  ]);
  // 引号会被剥掉，避免拼出 ""a"" 这种非法查询
  assert.deepEqual(topicPhrases('"graph neural network", \'link prediction\''), ['graph neural network', 'link prediction']);
  // 去重不区分大小写
  assert.deepEqual(topicPhrases('LLM, llm, LLM'), ['LLM']);
  assert.deepEqual(topicPhrases(''), []);
});

test('多词短语加引号、单词不加，多个短语用 AND 连接', () => {
  const q = buildQuery({ keywords: 'large language model, reasoning' }, DEFAULT_FILTERS);
  assert.equal(q.search, '"large language model" AND reasoning');
  assert.equal(q.sort, 'relevance_score:desc');
  assert.match(q.filter, /has_abstract:true/);
  assert.match(q.filter, /is_retracted:false/);
});

test('指定字段时改走 filter 的 xxx.search，不再用 search 参数', () => {
  const q = buildQuery({ keywords: 'graph neural network', field: 'title' }, DEFAULT_FILTERS);
  assert.equal(q.search, '');
  assert.match(q.filter, /^title\.search:"graph neural network"/);
  const abstractQ = buildQuery({ keywords: 'gnn', field: 'abstract' }, DEFAULT_FILTERS);
  assert.match(abstractQ.filter, /abstract\.search:gnn/);
});

test('年份 / 引用 / 类型 / 语言都进 filter，且默认排除撤稿', () => {
  const q = buildQuery({ keywords: 'llm' }, { ...DEFAULT_FILTERS, yearFrom: 2020, yearTo: 2025, minCitations: 20, type: 'review', language: 'en' });
  assert.match(q.filter, /publication_year:2020-2025/);
  assert.match(q.filter, /cited_by_count:>19/);
  assert.match(q.filter, /type:review/);
  assert.match(q.filter, /language:en/);
  assert.match(q.filter, /is_retracted:false/);
  const open = buildQuery({ keywords: 'llm' }, { ...DEFAULT_FILTERS, includeRetracted: true });
  assert.doesNotMatch(open.filter, /is_retracted/);
});

test('只填起始年 / 只填截止年也能表达', () => {
  assert.match(buildQuery({ keywords: 'a' }, { ...DEFAULT_FILTERS, yearFrom: 2021 }).filter, /publication_year:>2020/);
  assert.match(buildQuery({ keywords: 'a' }, { ...DEFAULT_FILTERS, yearTo: 2019 }).filter, /publication_year:<2020/);
});

test('过滤条件归一：年份反过来自动交换，条数夹在 5~50，未知排序回落相关度', () => {
  const f = normalizeFilters({ yearFrom: 2025, yearTo: 2010, perTopic: 999, sort: 'nonsense', type: 'x', language: 'fr' });
  assert.equal(f.yearFrom, 2010);
  assert.equal(f.yearTo, 2025);
  assert.equal(f.perTopic, 50);
  assert.equal(f.sort, 'relevance');
  assert.equal(f.type, '');
  assert.equal(f.language, '');
});

test('请求地址：逗号保持分隔符、冒号与 | 不被编码', () => {
  const url = buildUrl({ keywords: 'llm, agent', field: 'title' }, { ...DEFAULT_FILTERS, type: 'article', language: 'en', perTopic: 20 }, { mailto: 'a@b.com' });
  const filter = decodeURIComponent(new URL(url).searchParams.get('filter'));
  assert.equal(filter.split(',')[0], 'title.search:llm AND agent');
  assert.match(filter, /type:article/);
  assert.match(filter, /language:en/);
  assert.equal(new URL(url).searchParams.get('per_page'), '20');
  assert.equal(new URL(url).searchParams.get('mailto'), 'a@b.com');
  assert.match(url, /select=id,doi/);
});

// ---------- 结果归一 ----------

test('摘要倒排索引能还原成正常句子（位置乱序也不怕）', () => {
  assert.equal(reconstructAbstract({ b: [1], a: [0], c: [2, 3] }), 'a b c c');
  assert.equal(reconstructAbstract(null), '');
  assert.equal(reconstructAbstract({ a: 'x' }), '');
});

test('DOI 去掉 resolver 前缀并小写；标题 key 只留文字', () => {
  assert.equal(stripDoi('https://doi.org/10.1000/ABC'), '10.1000/abc');
  assert.equal(stripDoi('http://dx.doi.org/10.1/x'), '10.1/x');
  assert.equal(titleKey('A Study: On GNNs (2020)!'), 'astudyonGnns2020'.toLowerCase());
});

test('work 归一：URL 依次取 OA PDF → 落地页 → DOI；作者超过 3 人写「等 N 人」', () => {
  const item = work({ title: 'Graph Nets', doi: '10.1/abc' });
  item.best_oa_location = { pdf_url: 'https://oa.example/paper.pdf' };
  const parsed = parseWork(item);
  assert.equal(parsed.doi, '10.1/abc');
  assert.equal(parsed.url, 'https://oa.example/paper.pdf');
  assert.equal(parsed.venue, 'Journal of Tests');
  assert.equal(parsed.citedBy, 10);
  assert.equal(parsed.hasAbstract, true);
  assert.equal(parsed.authorLine, 'Ada Lovelace，Alan Turing');
  assert.deepEqual(parsed.authors, ['Ada Lovelace', 'Alan Turing']);

  // 没有 OA 全文时用出版方落地页；连落地页都没有才退回 DOI
  const noOa = parseWork(work({ title: 'No OA', doi: '10.2/x' }));
  assert.equal(noOa.url, 'https://example.org/No%20OA');
  const bare = work({ title: 'Bare', doi: '10.3/y' });
  bare.primary_location = { source: { display_name: 'J' } };
  assert.equal(parseWork(bare).url, 'https://doi.org/10.3/y');

  const many = work({ title: 'Many Authors' });
  many.authorships = ['A', 'B', 'C', 'D'].map((name) => ({ author: { display_name: name } }));
  assert.equal(parseWork(many).authorLine, 'A，B，C 等 4 人');
});

test('没有摘要的 work 标记 hasAbstract=false，便于前端提示', () => {
  const item = work({ title: 'Tiny abstract', abstractWords: 3 });
  assert.equal(parseWork(item).hasAbstract, false);
});

test('去重键：有 DOI 用 DOI，没有就用标题', () => {
  assert.equal(workKey({ doi: '10.1/a', title: 'X' }), 'doi:10.1/a');
  assert.equal(workKey({ doi: '', title: 'Same Title!' }), 'tt:sametitle');
});

// ---------- 取数 ----------

test('单个主题：按 URL 取数、过滤短摘要、记录命中总数', async () => {
  const { fetchImpl, calls } = fakeOpenAlex(() => ({
    body: {
      meta: { count: 4321 },
      results: [
        work({ title: 'With abstract', doi: '10.1/a' }),
        work({ title: 'No abstract', doi: '10.1/b', abstractWords: 2 }),
      ],
    },
  }));
  const result = await searchTopic({ id: 't1', name: 'T', keywords: 'llm' }, { ...DEFAULT_FILTERS, perTopic: 10 }, { fetchImpl });
  assert.equal(result.total, 4321);
  assert.equal(result.works.length, 1);
  assert.equal(result.works[0].title, 'With abstract');
  // 上游只回了 2 条（少于 perTopic）说明没有下一页，不该再发一次请求
  assert.equal(calls.length, 1);
});

test('第一页被排除词清空时会翻第二页补齐', async () => {
  const { fetchImpl, calls } = fakeOpenAlex((url) => {
    const page = new URL(url).searchParams.get('page');
    const items = page === '1'
      ? Array.from({ length: 6 }, (_, i) => work({ title: `Survey ${i}`, doi: `10.1/s${i}` }))
      : Array.from({ length: 6 }, (_, i) => work({ title: `Real ${i}`, doi: `10.1/r${i}` }));
    return { body: { meta: { count: 12 }, results: items } };
  });
  const result = await searchTopic({ id: 't1', name: 'T', keywords: 'llm', exclude: 'survey' }, { ...DEFAULT_FILTERS, perTopic: 5 }, { fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(result.works.length, 5);
  assert.ok(result.works.every((w) => w.title.startsWith('Real')));
  assert.equal(result.droppedByExclude, 6);
});

test('排除词在本地过滤（服务端 NOT 语义不稳），并统计被过滤数量', async () => {
  const { fetchImpl } = fakeOpenAlex(() => ({
    body: {
      meta: { count: 3 },
      results: [
        work({ title: 'Survey of LLM agents', doi: '10.1/s' }),
        work({ title: 'LLM agent benchmark', doi: '10.1/b' }),
      ],
    },
  }));
  const result = await searchTopic({ id: 't1', name: 'T', keywords: 'llm', exclude: 'survey' }, DEFAULT_FILTERS, { fetchImpl });
  assert.deepEqual(result.works.map((w) => w.title), ['LLM agent benchmark']);
  assert.equal(result.droppedByExclude, 1);
});

test('多主题：轮转合并（每个主题都能进前列）、DOI 去重并记录命中的主题', async () => {
  const byQuery = {
    '"graph neural network"': [
      work({ title: 'GNN one', doi: '10.1/gnn1' }),
      work({ title: 'GNN two', doi: '10.1/gnn2' }),
      work({ title: 'Shared', doi: '10.1/shared' }),
    ],
    recommendation: [
      work({ title: 'Rec one', doi: '10.1/rec1' }),
      work({ title: 'Shared', doi: '10.1/shared' }),
    ],
  };
  const { fetchImpl } = fakeOpenAlex((url) => {
    const search = new URL(url).searchParams.get('search') || '';
    return { body: { meta: { count: 10 }, results: byQuery[search] || [] } };
  });
  const out = await searchTopics([
    { id: 't1', name: 'GNN', keywords: 'graph neural network' },
    { id: 't2', name: '推荐', keywords: 'recommendation' },
  ], { ...DEFAULT_FILTERS, perTopic: 5 }, { fetchImpl, concurrency: 2 });

  assert.deepEqual(out.papers.map((p) => p.title), ['GNN one', 'Rec one', 'GNN two', 'Shared']);
  const shared = out.papers.find((p) => p.title === 'Shared');
  assert.deepEqual([...shared.topics].sort(), ['GNN', '推荐'].sort());
  assert.equal(out.duplicated, 1);
  assert.equal(out.perTopic.length, 2);
  assert.equal(out.perTopic[0].fetched, 3);
});

test('一个主题失败不影响其它主题，失败原因落在 perTopic 上', async () => {
  const { fetchImpl } = fakeOpenAlex((url) => {
    if (url.includes('boom')) return { status: 500, body: { message: 'upstream down' } };
    return { body: { meta: { count: 1 }, results: [work({ title: 'Fine', doi: '10.1/fine' })] } };
  });
  const out = await searchTopics([
    { id: 't1', name: '坏的', keywords: 'boom' },
    { id: 't2', name: '好的', keywords: 'good' },
  ], DEFAULT_FILTERS, { fetchImpl, concurrency: 2 });
  assert.equal(out.papers.length, 1);
  assert.match(out.perTopic[0].error, /500/);
  assert.equal(out.perTopic[1].error, '');
});

test('空主题直接报错，不浪费一次请求', async () => {
  let called = 0;
  const out = await searchTopics([{ keywords: '  ' }], DEFAULT_FILTERS, { fetchImpl: async () => { called += 1; return { ok: true, status: 200, text: async () => '{}' }; } });
  assert.match(out.error, /至少填写一个主题/);
  assert.equal(called, 0);
});

test('主题数超过上限直接拒绝', async () => {
  const topics = Array.from({ length: MAX_TOPICS + 1 }, (_, i) => ({ keywords: `kw${i}` }));
  const out = await searchTopics(topics, DEFAULT_FILTERS, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }) });
  assert.match(out.error, /最多/);
});

test('合并结果不超过上限，并标记已截断', async () => {
  // 每个主题返回不同标题，否则会被去重压成同一批
  const { fetchImpl } = fakeOpenAlex((url, index) => {
    const items = Array.from({ length: 50 }, (_, i) => work({ title: `Paper ${index}-${i}`, doi: `10.9/${index}-${i}` }));
    return { body: { meta: { count: 60 }, results: items } };
  });
  const out = await searchTopics(Array.from({ length: MAX_TOPICS }, (_, i) => ({ id: `t${i}`, name: `主题${i}`, keywords: `kw${i}` })), { ...DEFAULT_FILTERS, perTopic: 50 }, { fetchImpl, concurrency: 3 });
  assert.equal(out.papers.length, MAX_RESULTS);
  assert.equal(out.truncated, true);
});

test('主题归一：缺名字时用第一个关键词顶上，未知字段回落「全部字段」', () => {
  const topic = normalizeTopic({ keywords: 'federated learning, privacy', field: 'nonsense' }, 2);
  assert.equal(topic.name, 'federated learning');
  assert.equal(topic.field, 'default');
  assert.equal(topic.enabled, true);
});

test('跳转链接：把各主题前几个词拼成一次查询（百度学术 / X-MOL / OpenAlex）', () => {
  const links = linksFor([{ keywords: 'large language model, reasoning' }, { keywords: 'agent' }]);
  assert.equal(links.query, 'large language model reasoning agent');
  assert.match(links.baidu, /^https:\/\/xueshu\.baidu\.com\/s\?wd=/);
  assert.match(links.xmol, /^https:\/\/www\.x-mol\.com\/paper\/search\/q\?option=/);
  assert.equal(linksFor([]).query, '');
});
