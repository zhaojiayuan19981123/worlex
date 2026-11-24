// SI 征稿（v2）测试：文章源解析、正文提取、抽取规范化、去重与筛选、管线状态机
// 全部纯逻辑 + 注入的 fetch/extract，不出网。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseFeed, canonicalArticleUrl, extractArticleUrls, articleIdOf, normalizeSource,
  parseAnyDate, fetchSourceArticles, SOURCE_TYPES,
} from '../src/siSources.js';
import {
  htmlToArticleText, extractContentHtml, wechatPageError, extractPublishDate, fetchWechatArticle,
} from '../src/wechatArticle.js';
import {
  normalizeDate, parseModelJson, normalizeExtractedIssues, ruleExtractIssues,
} from '../src/siExtract.js';
import {
  createSpecialIssueState, listIssues, deadlineMeta, rankLevelKey, stableIssueId,
  purgeExpiredIssues, toggleFavorite, setPreferences, specialIssueSummary, topicCounts, buildIssue,
  mergeArticles,
} from '../src/specialIssues.js';
import { collectArticles, processArticles, enrichRanks } from '../src/siPipeline.js';

const NOW = new Date('2026-11-25T10:00:00+08:00');

// ---------------- 文章源 ----------------

test('RSS 解析：RSS 2.0 与 Atom 都能取到标题/链接/时间', () => {
  const rss = `<?xml version="1.0"?><rss><channel>
    <item><title><![CDATA[SSCI征稿｜Omega专刊：AI赋能运营]]></title>
      <link>https://mp.weixin.qq.com/s?__biz=MzU5&amp;mid=1&amp;idx=2&amp;sn=abc123&amp;chksm=zzz</link>
      <pubDate>Tue, 29 Jul 2026 08:00:00 +0800</pubDate>
      <description><![CDATA[<p>本期专刊聚焦 AI 与运营决策</p>]]></description></item>
    <item><title>第二篇</title><link>https://mp.weixin.qq.com/s/second01</link>
      <pubDate>2026-08-01</pubDate></item>
  </channel></rss>`;
  const items = parseFeed(rss);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'SSCI征稿｜Omega专刊：AI赋能运营');
  assert.equal(items[0].publishedAt, '2026-07-29');
  assert.match(items[0].digest, /AI 与运营/);
  assert.equal(items[1].publishedAt, '2026-08-01');

  const atom = `<feed><entry><title>Atom 标题</title>
    <link href="https://mp.weixin.qq.com/s/atom001"/>
    <published>2026-09-02T10:00:00Z</published></entry></feed>`;
  const a = parseFeed(atom);
  assert.equal(a.length, 1);
  assert.equal(a[0].title, 'Atom 标题');
  assert.equal(a[0].url, 'https://mp.weixin.qq.com/s/atom001');
  assert.equal(a[0].publishedAt, '2026-09-02');
});

test('文章链接规范化：长短链同一篇要去重成同一个 id', () => {
  const long = 'https://mp.weixin.qq.com/s?__biz=MzU5OTg4MTMyNg==&mid=2247484126&idx=2&sn=1b6f&chksm=ff65&scene=21#wechat_redirect';
  const long2 = 'https://mp.weixin.qq.com/s?__biz=MzU5OTg4MTMyNg==&mid=2247484126&idx=2&sn=1b6f&chksm=DIFFERENT&from=timeline';
  assert.equal(canonicalArticleUrl(long), canonicalArticleUrl(long2));
  assert.equal(articleIdOf(long), articleIdOf(long2));
  // 短链按 sn 归并
  assert.equal(canonicalArticleUrl('https://mp.weixin.qq.com/s/1b6f'), 'wx:1b6f');
  // 不同文章不同 id
  assert.notEqual(articleIdOf('https://mp.weixin.qq.com/s/aaa111'), articleIdOf('https://mp.weixin.qq.com/s/bbb222'));
});

test('从分享文案里提取文章链接并去重', () => {
  const text = `SSCI征稿｜Omega专刊 https://mp.weixin.qq.com/s?__biz=A&mid=1&idx=1&sn=x1&chksm=k
  再来一个 https://mp.weixin.qq.com/s?__biz=A&mid=1&idx=1&sn=x1&chksm=k2
  以及 https://mp.weixin.qq.com/s/other99`;
  const urls = extractArticleUrls(text);
  assert.equal(urls.length, 2);
});

test('源配置规范化：非法地址被拒绝，回溯天数被夹紧', () => {
  assert.equal(normalizeSource({ type: 'rss', target: 'ftp://x' }), null);
  assert.equal(normalizeSource({ type: 'links', target: '不是链接' }), null);
  const s = normalizeSource({ type: 'rss', name: '  SSCI征稿 ', target: 'https://x.test/feed', backfillDays: 9999 });
  assert.equal(s.name, 'SSCI征稿');
  assert.equal(s.backfillDays, 365);
  assert.equal(s.enabled, true);
});

test('日期解析覆盖常见写法', () => {
  assert.equal(parseAnyDate('2026-12-31'), '2026-12-31');
  assert.equal(parseAnyDate('2026年12月31日'), '2026-12-31');
  assert.equal(parseAnyDate('31 December 2026'), '2026-12-31');
  assert.equal(parseAnyDate('Dec 31, 2026'), '2026-12-31');
  // 用当天中午的时间戳，避免时区跨日导致断言漂移
  const noon = String(Math.floor(Date.parse('2026-12-31T12:00:00Z') / 1000));
  assert.equal(parseAnyDate(noon), '2026-12-31');
  assert.equal(parseAnyDate('乱码'), '');
});

test('RSS 源拉取：回溯窗口按时过滤', async () => {
  const rss = `<rss><channel>
    <item><title>新文章</title><link>https://mp.weixin.qq.com/s/new1</link><pubDate>2026-11-20</pubDate></item>
    <item><title>旧文章</title><link>https://mp.weixin.qq.com/s/old1</link><pubDate>2026-01-01</pubDate></item>
  </channel></rss>`;
  const fetchImpl = async () => ({ ok: true, text: async () => rss, status: 200 });
  const { articles } = await fetchSourceArticles(
    { type: 'rss', name: 't', target: 'https://feed.test/rss', backfillDays: 90 },
    { fetchImpl, now: NOW, backfillDays: 90 },
  );
  assert.equal(articles.length, 1);
  assert.equal(articles[0].title, '新文章');
  assert.equal(articles[0].sourceName, 't');
});

// wechat-mp-tools 这类自建服务的 RSS：<link> 指向它自己的离线预览文件，
// 原文地址在 <guid>，正文落在 content:encoded。三个都得接对，否则卡片跳转和抽取都会出错。
const FEED_WITH_FULLTEXT = `<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
  <item>
    <title>Omega 专刊征稿</title>
    <link>http://127.0.0.1:5200/api/articles/serve-file/a/b/c.html</link>
    <guid isPermaLink="false">https://mp.weixin.qq.com/s?__biz=MzU5&amp;mid=1&amp;idx=1&amp;sn=full01&amp;chksm=abc</guid>
    <pubDate>2026-11-20</pubDate>
    <description>本期聚焦供应链数字化</description>
    <content:encoded><![CDATA[<div id="js_content"><p>期刊：Omega</p><p>专刊主题：供应链数字化</p><p>投稿系统：<a href="https://submit.elsevier.com/OMEGA">Editorial Manager</a></p><p>截稿日期：2027年3月31日</p></div>]]></content:encoded>
  </item>
</channel></rss>`;

test('RSS 全文源：正文取 content:encoded，原文链接取 guid 而不是离线预览地址', async () => {
  const items = parseFeed(FEED_WITH_FULLTEXT);
  assert.equal(items.length, 1);
  assert.match(items[0].url, /mp\.weixin\.qq\.com\/s\?/, '原文链接必须指向公众号，不能是服务自己的预览地址');
  assert.match(items[0].url, /sn=full01/);
  assert.match(items[0].content, /期刊：Omega/, 'content:encoded 全文要留下来');
  assert.match(items[0].content, /submit\.elsevier\.com/, '正文里的投稿链接必须保留');
  assert.equal(items[0].digest, '本期聚焦供应链数字化', '摘要仍取 description');

  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => FEED_WITH_FULLTEXT });
  const { articles } = await fetchSourceArticles(
    { type: 'rss', name: 'wechat-mp-tools', target: 'https://feed.test/rss', backfillDays: 90 },
    { fetchImpl, now: NOW, backfillDays: 90 },
  );
  assert.equal(articles.length, 1);
  assert.equal(articles[0].contentKind, 'feed');
  assert.match(articles[0].content, /供应链数字化/);
});

test('RSS 无全文时回落为需要抓正文', () => {
  const plain = `<rss><channel><item><title>只有标题</title>
    <link>https://mp.weixin.qq.com/s/plain01</link><pubDate>2026-11-20</pubDate></item></channel></rss>`;
  const items = parseFeed(plain);
  assert.equal(items[0].content, '');
});

test('管线：订阅源自带全文时不再请求正文页', async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(String(url));
    return { ok: true, status: 200, text: async () => FEED_WITH_FULLTEXT };
  };
  let state = createSpecialIssueState({
    sources: [{ type: 'rss', name: 'wechat-mp-tools', target: 'https://feed.test/rss', backfillDays: 90 }],
  });
  state = (await collectArticles(state, { fetchImpl, now: NOW })).state;
  const extract = async (text, ctx) => {
    assert.match(text, /投稿系统/, '交给模型的是订阅源里的正文');
    assert.equal(ctx.articleUrl.includes('mp.weixin.qq.com'), true, '上下文里要带公众号原文地址');
    return {
      issues: [{ journal: 'Omega', titleZh: '供应链数字化', deadline: '2027-03-31', extractedBy: 'ai' }],
      notCfp: false,
    };
  };
  const p = await processArticles(state, { fetchImpl, extract, now: NOW, limit: 10 });
  assert.equal(p.stats.processed, 1);
  assert.equal(p.state.issues.length, 1);
  // 关键：只请求过订阅地址一次，没有再去抓 mp.weixin.qq.com
  assert.equal(requested.filter((u) => u.includes('mp.weixin.qq.com')).length, 0);
  assert.equal(p.state.articles[0].content, '', '抽取完成后要清掉全文，避免状态文件膨胀');
});

test('合并：已抽取的文章不再回填订阅源全文', () => {
  const merged = mergeArticles(
    [{ id: 'a1', status: 'extracted', content: '' }],
    [{ id: 'a1', status: 'pending', content: '<p>又抓了一遍全文</p>' }],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].content, '');
  // 还没处理的文章要拿到全文
  const fresh = mergeArticles([{ id: 'a2', status: 'pending', content: '' }], [{ id: 'a2', content: '<p>新全文</p>' }]);
  assert.equal(fresh[0].content, '<p>新全文</p>');
});

test('源类型：只保留 rss / folder / links / json', () => {
  assert.deepEqual(SOURCE_TYPES.map((t) => t.type), ['rss', 'folder', 'links', 'json']);
  // 微信读书源拿不到历史列表（官方列表接口已废弃，只能取最新一篇），不提供给用户选
  assert.equal(normalizeSource({ type: 'weread', target: 'MP_WXS_123', cookie: 'wr_vid=1' }), null);
});

// ---------------- 正文 ----------------

test('正文提取：保留链接文字与 URL，丢弃脚本与图片', () => {
  const html = `<div class="rich_media_content" id="js_content"><p>投稿系统：
    <a href="https://submit.elsevier.com/OMEGA">Editorial Manager</a></p>
    <script>alert(1)</script><img src="x.png"><p>截止 2026年12月31日</p></div>
    <div class="rich_media_tool">尾部工具条</div>`;
  const inner = extractContentHtml(html);
  assert.ok(inner.startsWith('<div'));
  assert.ok(!inner.includes('rich_media_tool'));
  const text = htmlToArticleText(inner);
  assert.match(text, /Editorial Manager \(https:\/\/submit\.elsevier\.com\/OMEGA\)/);
  assert.match(text, /截止 2026年12月31日/);
  assert.ok(!text.includes('alert'), '脚本必须被剔除');
  assert.ok(!text.includes('x.png'), '图片必须被丢弃');
});

test('非文章页要给出可读错误而不是当正文', () => {
  assert.match(wechatPageError('<html><title>未知错误</title></html>'), /未知错误/);
  assert.match(wechatPageError('<html><title>环境异常</title><body>完成验证后即可继续访问</body></html>'), /验证/);
  assert.equal(wechatPageError('<html><div id="js_content">正文</div></html>'), '');
});

test('发布时间从 ct 时间戳解析', () => {
  const noon = String(Math.floor(Date.parse('2026-12-31T12:00:00Z') / 1000));
  assert.equal(extractPublishDate(`var ct = "${noon}";`), '2026-12-31');
  assert.equal(extractPublishDate('<span id="publish_time">2026-07-29</span>'), '2026-07-29');
  assert.equal(extractPublishDate('无'), '');
});

test('抓正文：302 未知错误要报错，正常页要返回文本', async () => {
  const bad = async () => ({ ok: true, status: 200, url: 'https://mp.weixin.qq.com/s/x', text: async () => '<html><title>未知错误</title></html>' });
  await assert.rejects(() => fetchWechatArticle('https://mp.weixin.qq.com/s/x', { fetchImpl: bad }), /链接参数不完整|未知错误/);

  const good = async () => ({
    ok: true, status: 200, url: 'https://mp.weixin.qq.com/s/x',
    text: async () => `<html><head><meta property="og:title" content="SSCI征稿｜Omega专刊"></head>
      <body><div id="js_content"><p>期刊：Omega – The International Journal of Management Science</p>
      <p>专刊主题：AI-Augmented MS/OR</p><p>截稿日期：2026年12月31日</p>
      <p>${'正文内容'.repeat(40)}</p></div></body></html>`,
  });
  const art = await fetchWechatArticle('https://mp.weixin.qq.com/s/x', { fetchImpl: good });
  assert.equal(art.title, 'SSCI征稿｜Omega专刊');
  assert.match(art.text, /Omega/);
  assert.ok(art.chars > 60);
});

// ---------------- 抽取 ----------------

test('日期归一：点号/斜杠/中文/只给月日', () => {
  assert.equal(normalizeDate('2026.12.31', NOW), '2026-12-31');
  assert.equal(normalizeDate('2026/12/31', NOW), '2026-12-31');
  assert.equal(normalizeDate('2027年3月31日', NOW), '2027-03-31');
  // 只给月日且已过的，按明年算
  assert.equal(normalizeDate('12月31日', NOW), '2026-12-31');
  assert.equal(normalizeDate('3月31日', NOW), '2027-03-31');
  assert.equal(normalizeDate('', NOW), '');
});

test('模型 JSON 解析容忍代码围栏与前后废话', () => {
  assert.deepEqual(parseModelJson('好的，结果如下：\n```json\n{"isCallForPapers":true,"issues":[]}\n```\n以上'), { isCallForPapers: true, issues: [] });
  assert.equal(parseModelJson('完全不是 JSON'), null);
});

test('模型输出规范化：过滤过期、缺字段、非法链接', () => {
  const payload = {
    isCallForPapers: true,
    issues: [
      {
        journal: '《Journal of Cleaner Production》', journalShort: 'JCLP', publisher: 'Elsevier',
        titleEn: 'AI for Sustainable Operations', titleZh: 'AI 赋能可持续运营',
        summaryZh: '讨论 AI 如何支撑可持续运营决策。', topicsZh: ['人工智能', '可持续运营'],
        guestEditors: [{ name: 'Alice', affiliation: 'MIT' }, 'Bob'],
        openDate: '2026-07-01', deadline: '2026.12.31',
        submitUrl: 'https://submit.elsevier.com/JCLP', siUrl: 'javascript:alert(1)',
        journalUrl: 'https://www.sciencedirect.com/journal/x', confidence: 0.9,
      },
      { journal: '', titleZh: '', deadline: '2026-12-31' },
      { journal: 'Old Journal', titleZh: '已过期', deadline: '2025-01-01' },
    ],
  };
  const { issues, rejected } = normalizeExtractedIssues(payload, {
    articleUrl: 'https://mp.weixin.qq.com/s/a', articleId: 'art_1', sourceName: 'SSCI征稿', now: NOW,
  });
  assert.equal(issues.length, 1);
  assert.equal(rejected, 2);
  const i = issues[0];
  assert.equal(i.journal, 'Journal of Cleaner Production', '书名号要去掉');
  assert.equal(i.deadline, '2026-12-31');
  assert.equal(i.siUrl, '', 'javascript: 链接必须丢弃');
  assert.equal(i.submitUrl, 'https://submit.elsevier.com/JCLP');
  assert.equal(i.guestEditors.length, 2);
  assert.equal(i.guestEditors[1].name, 'Bob');
  assert.equal(i.articleId, 'art_1');
});

test('非征稿文章识别', () => {
  const { issues, notCfp } = normalizeExtractedIssues({ isCallForPapers: false, issues: [] }, { now: NOW });
  assert.equal(issues.length, 0);
  assert.equal(notCfp, true);
});

test('规则抽取：从「SSCI征稿」版式抽全关键字段', () => {
  const text = [
    '期刊 ：Omega – The International Journal of Management Science',
    'SSCI/SCIE双收录 ：Q1 | IF 6.9 | ABS 3★ | 中科院2区',
    '专刊主题 ：AI-Augmented MS/OR for Digital Operations and Emerging Technologies',
    '截稿日期 ：2026年12月31日',
    '客座编辑 ：Jim Shi (NJIT)、Kejia Hu (Oxford)、Haibing Lu (Santa Clara)',
    '期刊介绍',
    'Omega是国际管理科学领域的旗舰期刊之一，由Elsevier出版，创刊于1973年，SSCI与SCIE双收录。',
    '专刊主题',
    'AI赋能管理科学与运营研究：数字运营与新兴技术',
    '投稿方式',
    '通过 Editorial Manager 提交，文章类型选择 VSI: AI-Augmented MS/OR',
    '专刊链接 https://www.sciencedirect.com/special-issue/330123/ai-augmented-msor',
    '投稿入口 https://submit.elsevier.com/OMEGA',
  ].join('\n');
  const { issues } = ruleExtractIssues(text, { articleUrl: 'https://mp.weixin.qq.com/s/a', now: NOW });
  assert.equal(issues.length, 1);
  const i = issues[0];
  assert.equal(i.journal, 'Omega – The International Journal of Management Science');
  assert.equal(i.publisher, 'Elsevier');
  assert.equal(i.titleEn, 'AI-Augmented MS/OR for Digital Operations and Emerging Technologies');
  assert.equal(i.titleZh, 'AI赋能管理科学与运营研究：数字运营与新兴技术');
  assert.equal(i.deadline, '2026-12-31');
  assert.equal(i.journalShort, 'Omega');
  assert.equal(i.siUrl, 'https://www.sciencedirect.com/special-issue/330123/ai-augmented-msor');
  assert.equal(i.submitUrl, 'https://submit.elsevier.com/OMEGA');
  assert.ok(i.guestEditors.length >= 3);
  assert.equal(i.extractedBy, 'rule');
});

test('规则抽取：广告类文章不出卡', () => {
  const { issues, notCfp } = ruleExtractIssues('这是一篇卖课广告，扫码添加老师微信。', { now: NOW });
  assert.equal(issues.length, 0);
  assert.equal(notCfp, true);
});

// ---------------- 状态 / 去重 / 筛选 ----------------

function issue(over = {}) {
  return buildIssue({
    journal: 'Omega', journalShort: 'Omega', titleEn: 'AI-Augmented MS/OR', titleZh: 'AI赋能运营',
    summaryZh: '摘要', topicsZh: ['人工智能'], deadline: '2026-12-31',
    articleId: 'art_1', extractedBy: 'ai', confidence: 0.9, ...over,
  }, NOW);
}

test('同一专刊被两篇文章报道只出一张卡', () => {
  const a = issue({ articleId: 'art_1' });
  const b = issue({ articleId: 'art_2', summaryZh: '补充说明' });
  assert.equal(a.id, b.id, '期刊+截止日+主题相同 → 同一 id');
  const c = issue({ deadline: '2027-03-31' });
  assert.notEqual(a.id, c.id, '截止日不同 → 不同专刊');
});

test('状态规范化：非法字段被兜底，旧版本数据被标记', () => {
  const s = createSpecialIssueState({
    version: 1, selectedJournalIds: ['tm'], issues: [issue()],
    sources: [{ type: 'rss', target: 'https://x.test/rss' }, { type: 'rss', target: 'bad' }],
    preferences: { syncHour: 99, backfillDays: -5 },
  });
  assert.equal(s.version, 2);
  assert.equal(s.migratedFrom, 1);
  assert.equal(s.sources.length, 1, '非法源被丢弃');
  assert.equal(s.preferences.syncHour, 23);
  assert.equal(s.preferences.backfillDays, 90);
  assert.equal(s.issues.length, 1);
});

test('筛选：截止窗口 / 等级 / 主题 / 关键词 / 收藏', () => {
  const soon = issue({ journal: 'A', titleEn: 'T1', titleZh: '近期专刊', deadline: '2026-12-05', topicsZh: ['人工智能'] });
  soon.rank = { items: [{ label: 'ABS', value: '4*' }, { label: 'SSCI', value: 'Q1' }] };
  const later = issue({ journal: 'B', titleEn: 'T2', titleZh: '明年专刊', deadline: '2027-06-30', topicsZh: ['可持续'] });
  later.rank = { items: [{ label: 'ABS', value: '2' }, { label: 'SSCI', value: 'Q3' }] };
  const expired = issue({ journal: 'C', titleEn: 'T3', titleZh: '已截止', deadline: '2026-01-01' });

  const state = createSpecialIssueState({ issues: [soon, later, expired], favoriteIds: [later.id] });

  assert.equal(listIssues(state, { now: NOW }).length, 2, '默认隐藏已截止');
  assert.equal(listIssues(state, { now: NOW, includeExpired: true }).length, 3);
  assert.equal(listIssues(state, { now: NOW, deadlineWindow: '30' }).length, 1);
  assert.equal(listIssues(state, { now: NOW, deadlineWindow: 'expired' }).length, 1);
  assert.equal(listIssues(state, { now: NOW, deadlineWindow: '90' }).length, 1);
  assert.equal(listIssues(state, { now: NOW, favoriteOnly: true }).length, 1);
  assert.equal(listIssues(state, { now: NOW, topics: ['可持续'] }).length, 1);
  assert.equal(listIssues(state, { now: NOW, query: '可持续' }).length, 1);
  assert.equal(listIssues(state, { now: NOW, rankSystem: 'ABS', rankLevels: ['4*'] }).length, 1);
  assert.equal(listIssues(state, { now: NOW, rankSystem: 'SSCI', rankLevels: ['Q1', 'Q2'] }).length, 1);

  const sorted = listIssues(state, { now: NOW, sort: 'rank' });
  assert.equal(sorted[0].journal, 'A', 'ABS 4* 排最前');
  assert.equal(sorted[0].badges.length, 2);
});

test('等级值归一：ABS / SSCI / 中科院 / UTD24', () => {
  assert.equal(rankLevelKey('ABS', '4*'), '4*');
  assert.equal(rankLevelKey('ABS', '3'), '3');
  assert.equal(rankLevelKey('SSCI', 'Q1'), 'Q1');
  assert.equal(rankLevelKey('中科院分区', '1区Top'), '1区Top');
  assert.equal(rankLevelKey('中科院分区', '2区'), '2区');
  assert.equal(rankLevelKey('UTD24', '是'), 'Y');
  assert.equal(rankLevelKey('FMS', 'B'), 'B');
});

test('截止倒计时分档', () => {
  assert.equal(deadlineMeta({ deadline: '2026-11-25' }, NOW).tone, 'urgent');
  assert.equal(deadlineMeta({ deadline: '2026-12-10' }, NOW).tone, 'urgent');
  assert.equal(deadlineMeta({ deadline: '2027-01-20' }, NOW).tone, 'soon');
  assert.equal(deadlineMeta({ deadline: '2027-06-30' }, NOW).tone, 'normal');
  assert.equal(deadlineMeta({ deadline: '2026-01-01' }, NOW).tone, 'expired');
  assert.equal(deadlineMeta({ deadline: '' }, NOW).label, '待核实');
});

test('过期清理：超过 7 天才移除，收藏与译文一并清掉', () => {
  const old = issue({ journal: 'Old', deadline: '2026-11-01' });
  const recent = issue({ journal: 'Recent', deadline: '2026-11-22' });
  const state = createSpecialIssueState({ issues: [old, recent], favoriteIds: [old.id, recent.id] });
  state.translations[old.id] = { title: 'x' };
  const { state: next, removed } = purgeExpiredIssues(state, { now: NOW });
  assert.deepEqual(removed, [old.id]);
  assert.equal(next.issues.length, 1);
  assert.ok(!next.favoriteIds.includes(old.id));
  assert.equal(next.translations[old.id], undefined);

  const keep = createSpecialIssueState({ issues: [old], preferences: { includeExpired: true } });
  assert.equal(purgeExpiredIssues(keep, { now: NOW }).removed.length, 0);
});

test('偏好与收藏：非法值不写入', () => {
  const s = createSpecialIssueState({ issues: [issue()] });
  const id = s.issues[0].id;
  const next = setPreferences(s, { syncHour: 'abc', backfillDays: 0, sort: 'nope', autoSync: false });
  assert.equal(next.preferences.syncHour, 9);
  assert.equal(next.preferences.backfillDays, 90, '非法回溯天数应保持默认，而不是夹成 1');
  assert.equal(next.preferences.sort, 'deadline');
  assert.equal(next.preferences.autoSync, false);

  assert.equal(toggleFavorite(next, id).favoriteIds.includes(id), true);
  assert.equal(toggleFavorite(toggleFavorite(next, id), id).favoriteIds.includes(id), false);
});

test('统计与主题计数', () => {
  const a = issue({ journal: 'A', deadline: '2026-12-05', topicsZh: ['人工智能', '运营'] });
  const b = issue({ journal: 'B', deadline: '2026-12-06', topicsZh: ['人工智能'] });
  const u = issue({ journal: 'C', deadline: '', topicsZh: [] });
  const state = createSpecialIssueState({ issues: [a, b, u] });
  const sum = specialIssueSummary(state, { now: NOW });
  assert.equal(sum.total, 3);
  assert.equal(sum.active, 2);
  assert.equal(sum.urgent, 2);
  assert.equal(sum.undated, 1);
  const topics = topicCounts(state.issues);
  assert.equal(topics[0].topic, '人工智能');
  assert.equal(topics[0].count, 2);
});

// ---------------- 管线 ----------------

test('管线：采集 → 抽取 → 去重 → 等级', async () => {
  const rss = `<rss><channel>
    <item><title>A篇</title><link>https://mp.weixin.qq.com/s/aaa111</link><pubDate>2026-11-20</pubDate></item>
    <item><title>B篇</title><link>https://mp.weixin.qq.com/s/bbb222</link><pubDate>2026-11-21</pubDate></item>
  </channel></rss>`;
  const fetchImpl = async (url) => {
    if (String(url).includes('feed.test')) return { ok: true, status: 200, text: async () => rss };
    return {
      ok: true, status: 200, url,
      text: async () => `<html><head><meta property="og:title" content="文章"></head>
        <body><div id="js_content"><p>${'正文内容'.repeat(60)}</p></div></body></html>`,
    };
  };
  let state = createSpecialIssueState({
    sources: [{ type: 'rss', name: 'SSCI征稿', target: 'https://feed.test/rss', backfillDays: 90 }],
  });

  const c = await collectArticles(state, { fetchImpl, now: NOW });
  state = c.state;
  assert.equal(state.articles.length, 2);
  assert.ok(state.articles.every((a) => a.status === 'pending'));
  assert.equal(state.sources[0].lastCount, 2);

  // 抽取：两篇指向同一专刊 → 只出一张卡
  const extract = async () => ({
    issues: [{
      journal: 'Omega', titleEn: 'AI-Augmented MS/OR', titleZh: 'AI赋能运营',
      deadline: '2026-12-31', extractedBy: 'ai', confidence: 0.9,
    }],
    notCfp: false,
  });
  const p = await processArticles(state, { fetchImpl, extract, now: NOW, limit: 10 });
  state = p.state;
  assert.equal(p.stats.processed, 2);
  assert.equal(state.articles.filter((a) => a.status === 'extracted').length, 2);
  assert.equal(state.issues.length, 1, '同一专刊只保留一张卡');

  // 等级
  const queryRank = async (name) => ({ code: 200, data: { officialRank: { all: { ajg: '3', ssci: 'Q1' } } } });
  const r = await enrichRanks(state, { queryRank, secretKey: 'k', now: NOW });
  state = r.state;
  assert.equal(r.updated, 1);
  assert.equal(state.issues[0].rank.items.length, 2);
  assert.equal(state.ranks.Omega.items[0].label, 'ABS');
});

test('管线：单篇失败不影响其他，且可重试', async () => {
  const rss = `<rss><channel>
    <item><title>好文</title><link>https://mp.weixin.qq.com/s/good01</link><pubDate>2026-11-20</pubDate></item>
    <item><title>坏文</title><link>https://mp.weixin.qq.com/s/bad001</link><pubDate>2026-11-21</pubDate></item>
  </channel></rss>`;
  const fetchImpl = async (url) => {
    if (String(url).includes('feed.test')) return { ok: true, status: 200, text: async () => rss };
    if (String(url).includes('bad001')) return { ok: true, status: 200, text: async () => '<html><title>未知错误</title></html>' };
    return {
      ok: true, status: 200, url,
      text: async () => `<html><head><meta property="og:title" content="好文"></head><body><div id="js_content"><p>${'正文'.repeat(80)}</p></div></body></html>`,
    };
  };
  let state = createSpecialIssueState({ sources: [{ type: 'rss', name: 't', target: 'https://feed.test/rss' }] });
  state = (await collectArticles(state, { fetchImpl, now: NOW })).state;
  const extract = async () => ({ issues: [{ journal: 'J', titleZh: '题', deadline: '2026-12-31' }], notCfp: false });
  const p = await processArticles(state, { fetchImpl, extract, now: NOW });
  state = p.state;
  assert.equal(p.stats.extracted, 1);
  assert.equal(p.stats.failed, 1);
  const failed = state.articles.find((a) => a.status === 'failed');
  assert.equal(failed.attempts, 1);
  assert.match(failed.lastError, /未知错误/);
  assert.equal(state.issues.length, 1);
});

test('管线：非征稿文章标记 skipped 而不是 failed', async () => {
  const rss = `<rss><channel><item><title>广告</title><link>https://mp.weixin.qq.com/s/ad0001</link><pubDate>2026-11-20</pubDate></item></channel></rss>`;
  const fetchImpl = async (url) => (String(url).includes('feed.test')
    ? { ok: true, status: 200, text: async () => rss }
    : { ok: true, status: 200, url, text: async () => `<html><body><div id="js_content"><p>${'卖课广告'.repeat(40)}</p></div></body></html>` });
  let state = createSpecialIssueState({ sources: [{ type: 'rss', name: 't', target: 'https://feed.test/rss' }] });
  state = (await collectArticles(state, { fetchImpl, now: NOW })).state;
  const extract = async () => ({ issues: [], notCfp: true });
  const p = await processArticles(state, { fetchImpl, extract, now: NOW });
  assert.equal(p.stats.skipped, 1);
  assert.equal(p.stats.failed, 0);
  assert.equal(p.state.articles[0].status, 'skipped');
});

test('管线：等级查询失败只记错误不中断', async () => {
  const a = issue({ journal: 'Good', deadline: '2026-12-31' });
  const b = issue({ journal: 'Bad', deadline: '2027-01-31' });
  const state = createSpecialIssueState({ issues: [a, b] });
  const queryRank = async (name) => {
    if (name === 'Bad') throw new Error('超时');
    return { code: 200, data: { officialRank: { all: { ajg: '3' } } } };
  };
  const r = await enrichRanks(state, { queryRank, secretKey: 'k', now: NOW });
  assert.equal(r.updated, 1);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].journal, 'Bad');
});
