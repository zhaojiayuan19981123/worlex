// conf-feed.test.mjs —— CCF 会议官网论文集抓取的纯函数测试
//
// 每个会议官网的模板都不一样（NeurIPS 的 li、PMLR 的 div.paper、CVF 的 dt/dd、
// ACL Anthology 的 strong/span、IJCAI 的 paper_wrapper、USENIX 的 article、ECVA 的分年区块），
// 这里用各站真实 HTML 的**最小切片**把七个解析器钉住，另加年份推断、抽样、前言过滤。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONF_ADAPTERS,
  candidateYears,
  confArticleId,
  fetchConferenceArticles,
  normalizePaperTitle,
  parseAcl,
  parseCvf,
  parseEcva,
  parseIjcai,
  parseNips,
  parsePmlr,
  parseUsenix,
  pickPmlrVolume,
  pickSpread,
  splitAuthors,
} from '../src/confFeed.js';

const NIPS_HTML = `<ul class="paper-list">
  <li class="conference" data-track="conference">
    <div class="paper-content">
      <a title="paper title" href="/paper_files/paper/2024/hash/000f947-Abstract-Conference.html">MicroAdam: Accurate Adaptive Optimization with Low Space Overhead</a>
      <span class="paper-authors">Ionut-Vlad Modoranu, Mher Safaryan, Grigory Malinovsky</span>
    </div>
    <span class="paper-track-badge">Main Conference Track</span>
  </li>
  <li class="conference" data-track="datasets_and_benchmarks_track">
    <div class="paper-content">
      <a title="paper title" href="/paper_files/paper/2024/hash/00295ce-Abstract-Datasets_and_Benchmarks_Track.html">GITA: Graph to Visual and Textual Integration for Graph Reasoning</a>
      <span class="paper-authors">Author One, Author Two</span>
    </div>
  </li>
</ul>`;

const PMLR_HTML = `<div class="paper">
  <p class="title">Revisiting Character-level Adversarial Attacks for Language Models</p>
  <p class="details">
    <span class="authors">Elias Abad Rocamora,&nbsp;Yongtao Wu,&nbsp;Fanghui Liu</span>;
    <span class="info"><i>Proceedings of the 41st International Conference on Machine Learning</i>, PMLR 235:1-30</span>
  </p>
  <p class="links">
    [<a href="https://proceedings.mlr.press/v235/abad-rocamora24a.html">abs</a>]
  </p>
</div>
<div class="paper">
  <p class="title">Adaptively Perturbed Mirror Descent for Learning in Games</p>
  <p class="details">
    <span class="authors">Kenshi Abe,&nbsp;Kaito Ariu</span>;
    <span class="info"><i>Proceedings of ICML</i>, PMLR 235:31-60</span>
  </p>
  <p class="links">[<a href="https://proceedings.mlr.press/v235/abe24a.html">abs</a>]</p>
</div>`;

const CVF_HTML = `<dt class="ptitle"><br><a href="/content/CVPR2024/html/Zeng_Unmixing_CVPR_2024_paper.html">Unmixing Diffusion for Self-Supervised Hyperspectral Image Denoising</a></dt>
<dd>
  <form id="form-HaijinZeng" action="/CVPR2024" method="post" class="authsearch">
    <input type="hidden" name="query_author" value="Haijin Zeng">
  </form>
  <form id="form-JiezhangCao" action="/CVPR2024" method="post" class="authsearch">
    <input type="hidden" name="query_author" value="Jiezhang Cao">
  </form>
</dd>`;

const ACL_HTML = `<div class="d-sm-flex align-items-stretch mb-3"><div class="d-block me-2 list-button-row"><span class="d-inline d-sm-block text-nowrap"></span></div>
<span class=d-block><strong><a class=align-middle href=/2024.acl-long.1/>Quantized Side Tuning: Fast and Memory-Efficient Tuning of Quantized <span class=acl-fixed-case>L</span>arge <span class=acl-fixed-case>L</span>anguage Models</a></strong><br><a href=/people/zhengxin-zhang/>Zhengxin Zhang</a>
|
<a href=/people/dan-zhao/>Dan Zhao</a></span></div><div class="card bg-light mb-2 mb-lg-3 collapse abstract-collapse" id=abstract-2024--acl-long--1><div class="card-body p-3 small">Finetuning large language models (LLMs) has been empirically effective.</div>
<span class=d-block><strong><a class=align-middle href=/2024.acl-long.0/>Proceedings of the 62nd Annual Meeting of the Association for Computational Linguistics</a></strong><br><a href=/people/maria-liakata/>Maria Liakata</a></span></div><div class="card bg-light mb-2 mb-lg-3 collapse abstract-collapse" id=abstract-2024--acl-long--0><div class="card-body p-3 small">Front matter.</div>`;

const IJCAI_HTML = `<div class="subsection"><div class="paper_wrapper paper-row" id="paper1">
  <div class="paper-row__text">
    <a class="title" href="/proceedings/2024/1">Certified Policy Verification and Synthesis for MDPs</a>
    <div class="authors"><a href="https://ijcai.org/authors/s-akshay/">S. Akshay</a>, <a href="https://ijcai.org/authors/krishnendu-chatterjee/">Krishnendu Chatterjee</a></div>
    <div class="details">Pages 3–12 · <a href="https://doi.org/10.24963/ijcai.2024/1">doi:10.24963/ijcai.2024/1</a></div>
  </div>
</div></div>`;

const USENIX_HTML = `<article id="node-1" class="node node-session view-mode-schedule"><h2>Keynote</h2>
<div class="field field-name-field-session-papers"><div class="field-item odd"><article id="node-2" class="node node-paper view-mode-schedule">
  <h2><a href="/conference/osdi26/presentation/keynote">Scaling AI Sustainably</a></h2>
  <div class="content"><div class="field field-name-field-presented-by"><p>Carole-Jean Wu, <em>Meta</em></p></div></div>
</article></div></div></article>
<article id="node-3" class="node node-paper view-mode-schedule">
  <h2><a href="/conference/osdi26/presentation/xie-zhiqiang">Strata: Hierarchical Context Caching for Long Context Serving</a></h2>
  <div class="content">
    <div class="field field-name-field-paper-people-text"><div class="field-items"><div class="field-item odd"><p>Zhiqiang Xie, <em>Stanford University;</em> Ziyi Xu, <em>Shanghai Jiao Tong University;</em> and Christos Kozyrakis, <em>Stanford</em></p></div></div></div>
    <div class="field field-name-field-paper-description-long"><div><p>Long-context large language models enable reasoning over millions of tokens.</p></div></div>
  </div>
</article>
<article id="node-4" class="node node-paper view-mode-schedule">
  <h2><a href="/conference/atc26/presentation/cross-listed">Cross listed paper from ATC</a></h2>
</article>`;

const ECVA_HTML = `<button class="accordion">ECCV 2024 Papers</button>
<div class="accordion-content"><div id="content"><dl>
<dt class="ptitle"><br>
<a href=papers/eccv_2024/papers_ECCV/html/4_ECCV_2024_paper.php>Is Retain Set All You Need in Machine Unlearning?</a>
</dt><dd>Jacopo Bonato*, Marco Cotogni, Luigi Sabetta*</dd>
<dd>[<a href="https://link.springer.com/chapter/10.1007/978-3-031-73232-4_1">DOI</a>]</dd>
</dl></div></div>
<button class="accordion">ECCV 2022 Papers</button>
<div class="accordion-content"><dl>
<dt class="ptitle"><br><a href=papers/eccv_2022/papers_ECCV/html/1_paper.php>Old paper that must not be picked</a></dt><dd>Some One</dd>
</dl></div>`;

const PMLR_INDEX = `<ul>
<li><a href="v235"><b>Volume 235</b></a> Proceedings of ICML 2024</li>
<li><a href="v202"><b>Volume 202</b></a> Proceedings of ICML 2023</li>
<li><a href="v247"><b>Volume 247</b></a> Proceedings of COLT 2024</li>
<li><a href="v230"><b>Volume 230</b></a> Proceedings of UAI 2023</li>
<li><a href="v286"><b>Volume 286</b></a> Proceedings of UAI 2025</li>
</ul>`;

test('七个官网适配器都在白名单里', () => {
  assert.deepEqual(CONF_ADAPTERS.sort(), ['acl', 'cvf', 'ecva', 'ijcai', 'nips', 'pmlr', 'usenix']);
});

test('NeurIPS：li.conference 里的标题、作者与绝对链接', () => {
  const rows = parseNips(NIPS_HTML, { id: 'ccf-neurips' }, 2024);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'MicroAdam: Accurate Adaptive Optimization with Low Space Overhead');
  assert.deepEqual(rows[0].authors, ['Ionut-Vlad Modoranu', 'Mher Safaryan', 'Grigory Malinovsky']);
  assert.equal(rows[0].url, 'https://papers.nips.cc/paper_files/paper/2024/hash/000f947-Abstract-Conference.html');
});

test('PMLR：标题 / 作者（&nbsp; 分隔）/ abs 链接 / PMLR 卷号与页码', () => {
  const rows = parsePmlr(PMLR_HTML, { id: 'ccf-icml' }, 2024, { baseUrl: 'https://proceedings.mlr.press/v235/', volume: '235' });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'Revisiting Character-level Adversarial Attacks for Language Models');
  assert.deepEqual(rows[0].authors, ['Elias Abad Rocamora', 'Yongtao Wu', 'Fanghui Liu']);
  assert.equal(rows[0].url, 'https://proceedings.mlr.press/v235/abad-rocamora24a.html');
  assert.equal(rows[0].pages, '1-30');
  assert.equal(rows[0].volume, 'PMLR 235');
});

test('CVF：dt.ptitle + dd 里的 query_author 隐藏域就是作者列表', () => {
  const rows = parseCvf(CVF_HTML, { id: 'ccf-cvpr' }, 2024);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Unmixing Diffusion for Self-Supervised Hyperspectral Image Denoising');
  assert.deepEqual(rows[0].authors, ['Haijin Zeng', 'Jiezhang Cao']);
  assert.match(rows[0].url, /^https:\/\/openaccess\.thecvf\.com\/content\/CVPR2024\/html\//);
});

test('ACL Anthology：标题里的 acl-fixed-case span 不能留下空格，摘要跟着条目走', () => {
  const rows = parseAcl(ACL_HTML, { id: 'ccf-acl' }, 2024);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'Quantized Side Tuning: Fast and Memory-Efficient Tuning of Quantized Large Language Models');
  assert.deepEqual(rows[0].authors, ['Zhengxin Zhang', 'Dan Zhao']);
  assert.match(rows[0].abstract, /Finetuning large language models/);
  assert.equal(rows[0].url, 'https://aclanthology.org/2024.acl-long.1/');
  // 卷首语条目也会被解析出来，但 toArticles 会按 FRONT_MATTER 过滤掉（见下面的 fetch 测试）
  assert.match(rows[1].title, /^Proceedings of the/);
});

test('IJCAI：标题 / 作者 / 页码 / DOI', () => {
  const rows = parseIjcai(IJCAI_HTML, { id: 'ccf-ijcai' }, 2024);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Certified Policy Verification and Synthesis for MDPs');
  assert.deepEqual(rows[0].authors, ['S. Akshay', 'Krishnendu Chatterjee']);
  assert.equal(rows[0].pages, '3-12');
  assert.equal(rows[0].doi, '10.24963/ijcai.2024/1');
});

test('USENIX：只收本会 presentation、剔除 keynote、作者去掉单位与 and', () => {
  const rows = parseUsenix(USENIX_HTML, { id: 'ccf-osdi' }, 2026, { slug: 'osdi' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Strata: Hierarchical Context Caching for Long Context Serving');
  assert.deepEqual(rows[0].authors, ['Zhiqiang Xie', 'Ziyi Xu', 'Christos Kozyrakis']);
  assert.match(rows[0].abstract, /Long-context large language models/);
});

test('ECVA：只取当届区块，不串到往届', () => {
  const rows = parseEcva(ECVA_HTML, { id: 'ccf-eccv' }, 2024);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Is Retain Set All You Need in Machine Unlearning?');
  assert.deepEqual(rows[0].authors, ['Jacopo Bonato', 'Marco Cotogni', 'Luigi Sabetta']);
  assert.equal(rows[0].doi, '10.1007/978-3-031-73232-4_1');
  assert.equal(parseEcva(ECVA_HTML, { id: 'ccf-eccv' }, 2021).length, 0);
});

test('PMLR 总目录里按会议名找最近一卷', () => {
  assert.deepEqual(pickPmlrVolume(PMLR_INDEX, 'International Conference on Machine Learning|\\bICML\\b'), { volume: 235, year: 2024 });
  assert.deepEqual(pickPmlrVolume(PMLR_INDEX, 'Uncertainty in Artificial Intelligence|\\bUAI\\b'), { volume: 286, year: 2025 });
  assert.deepEqual(pickPmlrVolume(PMLR_INDEX, 'Conference on Learning Theory|\\bCOLT\\b'), { volume: 247, year: 2024 });
  assert.equal(pickPmlrVolume(PMLR_INDEX, 'never-heard-of-it'), null);
});

test('年份推断：按办会月份决定从今年还是去年试起', () => {
  const now = new Date('2026-11-26T00:00:00+08:00');
  assert.deepEqual(candidateYears({ month: 6 }, now), [2026, 2025, 2024]);   // CVPR 6 月，今年已开
  assert.deepEqual(candidateYears({ month: 12 }, now), [2025, 2024, 2023]);  // NeurIPS 12 月，今年还没开
  assert.deepEqual(candidateYears({}, now), [2026, 2025, 2024]);
});

test('抽样：超过上限时等距取，顺序与首尾都保留', () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({ title: `t${i}` }));
  const picked = pickSpread(rows, 100);
  assert.equal(picked.length, 100);
  assert.equal(picked[0].title, 't0');
  assert.equal(picked[99].title, 't990');
  assert.equal(pickSpread(rows.slice(0, 10), 100).length, 10);
});

test('作者串切分：去掉单位星号、and、空项', () => {
  assert.deepEqual(splitAuthors('A One, B Two; C Three'), ['A One', 'B Two', 'C Three']);
  assert.deepEqual(splitAuthors('and Zhenyu Ning'), ['Zhenyu Ning']);
  assert.deepEqual(splitAuthors('Luigi Sabetta*'), ['Luigi Sabetta']);
  assert.deepEqual(splitAuthors(''), []);
});

test('会议论文主键只跟会议 + 标题有关（换年份/换链接不会产生重复）', () => {
  const a = confArticleId('ccf-cvpr', 'Unmixing Diffusion for Denoising');
  const b = confArticleId('ccf-cvpr', 'Unmixing   Diffusion for  Denoising');
  const c = confArticleId('ccf-cvpr', 'Another Paper Entirely');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^conf:/);
  assert.equal(normalizePaperTitle('A “Quoted” Title'), 'aquotedtitle');
});

test('fetchConferenceArticles：卷首语/目录被过滤，年份写进 meta', async () => {
  const fakeFetch = async (url) => {
    if (String(url).includes('/v235/')) return { ok: true, text: async () => PMLR_HTML };
    if (String(url).endsWith('proceedings.mlr.press/')) return { ok: true, text: async () => PMLR_INDEX };
    return { ok: false, status: 404 };
  };
  const articles = await fetchConferenceArticles(
    { id: 'ccf-icml', shortTitle: 'ICML', month: 7, conf: { adapter: 'pmlr', match: 'ICML' } },
    { fetchImpl: fakeFetch, now: new Date('2026-11-26T00:00:00+08:00') },
  );
  assert.equal(articles.length, 2);
  assert.deepEqual(articles.meta, { url: 'https://proceedings.mlr.press/v235/', year: 2024 });
  assert.equal(articles[0].journalId, 'ccf-icml');
  assert.equal(articles[0].journal, 'ICML 2024');
  assert.equal(articles[0].publishedAt, '2024-07-01');
  assert.equal(articles[0].articleType, 'conference-paper');
  assert.equal(articles[0].source, '会议官网');
});

test('fetchConferenceArticles：当年目录不存在时自动退到上一年', async () => {
  const seen = [];
  const fakeFetch = async (url) => {
    seen.push(url);
    if (String(url).includes('/2025')) return { ok: false, status: 404 };
    if (String(url).includes('/2024')) return { ok: true, text: async () => NIPS_HTML };
    return { ok: false, status: 404 };
  };
  const articles = await fetchConferenceArticles(
    { id: 'ccf-neurips', shortTitle: 'NeurIPS', month: 12, conf: { adapter: 'nips' } },
    { fetchImpl: fakeFetch, now: new Date('2026-11-26T00:00:00+08:00') },
  );
  assert.equal(articles.meta.year, 2024);
  assert.equal(articles.length, 2);
  assert.deepEqual(seen, [
    'https://papers.nips.cc/paper_files/paper/2025',
    'https://papers.nips.cc/paper_files/paper/2024',
  ]);
});

test('fetchConferenceArticles：目录页里全是通知 / 前言时报出可读原因', async () => {
  const onlyFront = ACL_HTML.split('</div>').slice(0, 1).join('</div>');
  const fakeFetch = async () => ({ ok: true, text: async () => `<div><strong><a class=align-middle href=/2024.acl-long.0/>Proceedings of the Meeting</a></strong><br><a href=/people/x/>X Y</a></span></div>` });
  void onlyFront;
  await assert.rejects(
    fetchConferenceArticles(
      { id: 'ccf-acl', shortTitle: 'ACL', month: 7, conf: { adapter: 'acl', slug: 'acl' } },
      { fetchImpl: fakeFetch, now: new Date('2026-11-26T00:00:00+08:00') },
    ),
    /没有解析出论文/,
  );
});
