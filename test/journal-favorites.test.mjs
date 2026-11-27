// journal-favorites.test.mjs —— 期刊收藏（v3.2.0）
//
// 这一版的三类信息各有各的可信度，测试重点就是「别把它们混在一起」：
//   等级：第三方查回来的，查不到要如实落 error，不能拿空数组冒充「没收录」
//   评价：我的主观打分，必须能存能改，且只替换同一条记录
//   周期：只能来自我的投稿记录（实测）或我手填的参考值（标明来源），不能凭空造
//
// 另外「收藏」这种清单最容易出的问题是重复：大小写、`&` 与 `and`、标点不同都算同一本。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createApp } from '../server.js';
import * as store from '../src/store.js';
import * as js from '../src/journalStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
}

/** 每个用例一个独立数据目录：期刊收藏是文件型存储，共用目录会互相干扰 */
async function withDataDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'jrn-'));
  store.configure({ dataDir: dir });
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------- 数据层 ----------

test('去重键：大小写 / & 与 and / 标点 / 全角都不该让同一本刊变成两条', () => {
  const a = js.normalizeKey('Journal of Consumer Research');
  assert.equal(a, js.normalizeKey('journal of consumer research'));
  assert.equal(a, js.normalizeKey('  Journal  of Consumer   Research '));
  assert.equal(js.normalizeKey('MIS Quarterly'), js.normalizeKey('MIS Quarterly.'));
  assert.equal(js.normalizeKey('Journal of Marketing & Research'), js.normalizeKey('Journal of Marketing and Research'));
  // 全角字符走 NFKC 归一
  assert.equal(js.normalizeKey('管理世界'), js.normalizeKey('管理世界'));
  assert.equal(a === js.normalizeKey('管理世界'), false);
});

test('新建收藏：同名重复不建第二条，返回已有记录', async () => {
  await withDataDir(async () => {
    const first = js.createJournal({ name: 'Journal of Consumer Research', field: '市场营销' });
    assert.equal(first.created, true);
    const again = js.createJournal({ name: 'journal of consumer research' });
    assert.equal(again.created, false);
    assert.equal(again.journal.id, first.journal.id);
    assert.equal(js.listJournals().length, 1);
    assert.equal(js.listJournals()[0].field, '市场营销', '重复创建不能把已有字段清空');
  });
});

test('投稿统计：首轮中位数 / 均值 / 最快最慢 / 接收率，在审的不算进接收率分母', () => {
  const stats = js.computeStats([
    { submittedAt: '2026-01-01', firstDecisionAt: '2026-03-02', result: 'accepted', acceptedAt: '2026-06-01' },
    { submittedAt: '2025-01-01', firstDecisionAt: '2025-02-10', result: 'rejected' },
    { submittedAt: '2024-05-01', result: 'pending' },
    // 唯一一条特慢的：用来验证中位数不像均值那样被拉歪
    { submittedAt: '2023-01-01', firstDecisionAt: '2023-06-30', result: 'rejected' },
  ]);
  assert.equal(stats.trials, 4);
  assert.equal(stats.firstSamples, 3);
  assert.equal(stats.accepted, 1);
  assert.equal(stats.rejected, 2);
  assert.equal(stats.pending, 1);
  assert.equal(stats.acceptRate, 33, '接收率只在「已出结果」的样本里算');
  // 天数：60 / 40 / 180 → 中位数 60，均值 93
  assert.equal(stats.medianFirstDays, 60);
  assert.equal(stats.avgFirstDays, 93);
  assert.equal(stats.fastestFirstDays, 40);
  assert.equal(stats.slowestFirstDays, 180);
  assert.equal(stats.avgAcceptDays, 151);
});

test('周期口径：有实测用实测，没有用手填参考值，都没有就是空（不猜）', () => {
  const measured = js.decorate({
    id: 'x', name: 'A',
    submissions: [{ submittedAt: '2026-01-01', firstDecisionAt: '2026-03-01' }],
    cycle: { refDays: 200, refSource: '官网' },
  });
  assert.equal(measured.cycleInfo.days, 59);
  assert.equal(measured.cycleInfo.source, 'mine');

  const manual = js.decorate({ id: 'y', name: 'B', submissions: [], cycle: { refDays: 120, refSource: '编辑部邮件' } });
  assert.equal(manual.cycleInfo.days, 120);
  assert.equal(manual.cycleInfo.source, 'manual');
  assert.match(manual.cycleInfo.label, /编辑部邮件/, '参考值必须把来源显示出来');

  const none = js.decorate({ id: 'z', name: 'C', submissions: [], cycle: {} });
  assert.equal(none.cycleInfo.days, null, '没有数据时不能返回 0 天');
  assert.equal(none.cycleInfo.source, '');
});

test('投稿记录：缺日期或日期倒挂当场报错，不要算出一个负数周期', async () => {
  await withDataDir(async () => {
    const { journal } = js.createJournal({ name: 'Test Journal' });
    assert.throws(() => js.addSubmission(journal.id, {}), /投稿日期必填/);
    assert.throws(
      () => js.addSubmission(journal.id, { submittedAt: '2026-05-01', firstDecisionAt: '2026-04-01' }),
      /不能早于投稿日期/,
    );
    const ok = js.addSubmission(journal.id, {
      submittedAt: '2026-01-10', firstDecisionAt: '2026-03-01', result: 'major', rounds: '2',
    });
    assert.equal(ok.submissions.length, 1);
    assert.equal(ok.submissions[0].rounds, 2);
    assert.equal(ok.stats.medianFirstDays, 50);

    const removed = js.removeSubmission(journal.id, ok.submissions[0].id);
    assert.equal(removed.submissions.length, 0);
    assert.equal(js.removeSubmission(journal.id, 'nope'), null);
  });
});

test('PATCH 白名单：改不了 id / submissions / rank；改名撞车直接拒绝', async () => {
  await withDataDir(async () => {
    const { journal: a } = js.createJournal({ name: 'Journal A' });
    const { journal: b } = js.createJournal({ name: 'Journal B' });

    const patched = js.patchJournal(a.id, {
      name: 'Journal A2',
      id: 'hacked',
      submissions: [{ submittedAt: '2020-01-01' }],
      rank: { summary: '假的', items: [{ label: 'UTD24', value: '是' }] },
      review: { rating: '4', pros: '编辑很快' },
    });
    assert.equal(patched.id, a.id, 'id 不能被改');
    assert.equal(patched.submissions.length, 0, '投稿记录只能走专用接口');
    assert.equal(patched.rank.summary, '', '等级只能由查询接口写入');
    assert.equal(patched.review.rating, 4);
    assert.equal(patched.review.pros, '编辑很快');

    assert.throws(() => js.patchJournal(a.id, { name: 'Journal B' }), /已经在收藏里/);
    assert.equal(js.getJournal(b.id).name, 'Journal B');
  });
});

test('等级档位打分：UTD24 > 中科院 1 区 Top > 2 区 > 未收录', () => {
  const utd = js.tierScore([{ label: 'UTD24', value: '是' }]);
  const sciTop = js.tierScore([{ label: '中科院分区', value: '1区 Top' }]);
  const sci2 = js.tierScore([{ label: '中科院分区', value: '2区' }]);
  const ccfA = js.tierScore([{ label: 'CCF', value: 'A' }]);
  assert.ok(utd > sciTop && sciTop > sci2);
  assert.ok(ccfA > sci2);
  assert.equal(js.tierScore([]), null, '查不到等级时不能当成 0 分区');
  assert.equal(js.tierScore([{ label: '中科院分区', value: '未收录' }]), null);
});

test('批量导入：按去重键跳过已收藏的，重复名字在那一批里也只收一次', async () => {
  await withDataDir(async () => {
    js.createJournal({ name: 'Journal of Marketing' });
    const res = js.importNames(['Journal of Marketing', 'MIS Quarterly', 'mis quarterly.', 'Journal of Finance']);
    assert.equal(res.added, 2);
    assert.equal(res.skipped, 2);
    assert.equal(js.listJournals().length, 3);
  });
});

// ---------- HTTP ----------

test('HTTP：收藏 → 列表 → 改评价 → 记投稿 → 周期变成实测 → 删除', async () => {
  await withDataDir(async () => {
    const { app } = createApp();
    const server = createServer(app);
    const base = await listen(server);
    try {
      const post = (p, body) => fetch(base + p, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
      });

      const created = await post('/api/journals', { name: 'Journal of Consumer Research', field: '市场营销' });
      assert.equal(created.status, 201);
      const { journal } = await created.json();
      assert.equal(journal.name, 'Journal of Consumer Research');

      const dup = await post('/api/journals', { name: 'journal of consumer research' });
      assert.equal(dup.status, 200);
      assert.equal((await dup.json()).created, false, '重复收藏不该报错，也不该建第二条');

      let list = await (await fetch(base + '/api/journals')).json();
      assert.equal(list.total, 1);
      assert.equal(list.counts.total, 1);
      assert.equal(list.counts.withCycle, 0);

      // 评价
      const patched = await fetch(`${base}/api/journals/${journal.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ review: { rating: 4, dimensions: { rigor: 5, speed: 3 }, pros: '意见具体' } }),
      });
      assert.equal(patched.status, 200);
      const rated = await patched.json();
      assert.equal(rated.review.rating, 4);
      assert.equal(rated.review.dimensions.rigor, 5);
      assert.equal(rated.review.dimensions.editor, 0, '没填的维度归零，不要 NaN');

      // 投稿记录 → 周期从「未知」变「实测」
      const sub = await post(`/api/journals/${journal.id}/submissions`, {
        submittedAt: '2026-01-01', firstDecisionAt: '2026-03-12', result: 'minor', rounds: 1,
      });
      assert.equal(sub.status, 200);
      const withSub = await sub.json();
      assert.equal(withSub.cycleInfo.source, 'mine');
      assert.equal(withSub.cycleInfo.days, 70);

      // 手填的参考周期要能「存得下、读得回」：
      // 早先 decorate() 把 cycle 覆盖成派生对象，保存后一刷新输入框就空了。
      const refPatched = await (await fetch(`${base}/api/journals/${journal.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cycle: { refDays: 150, refSource: '编辑部邮件' } }),
      })).json();
      assert.equal(refPatched.cycle.refDays, 150, '原始参考值要原样返回给前端回显');
      assert.equal(refPatched.cycle.refSource, '编辑部邮件');
      assert.equal(refPatched.cycleInfo.source, 'mine', '有实测时仍以实测为准');
      assert.equal(refPatched.cycleInfo.days, 70);

      const reread = (await (await fetch(`${base}/api/journals/${journal.id}`)).json()).journal;
      assert.equal(reread.cycle.refDays, 150);

      list = await (await fetch(base + '/api/journals')).json();
      assert.equal(list.counts.withCycle, 1);
      assert.equal(list.counts.rated, 1);

      const del = await fetch(`${base}/api/journals/${journal.id}`, { method: 'DELETE' });
      assert.equal(del.status, 200);
      assert.equal((await (await fetch(base + '/api/journals')).json()).total, 0);
    } finally {
      await close(server);
    }
  });
});

test('HTTP：没配 easyScholar / 没配模型时，各自给明确提示而不是 500', async () => {
  await withDataDir(async () => {
    store.saveSettings({ ...store.getSettings(), easyScholarKey: '', modelProfiles: [] });
    const { app } = createApp();
    const server = createServer(app);
    const base = await listen(server);
    try {
      const post = (p, body) => fetch(base + p, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
      });

      const lookup = await post('/api/journals/lookup', { name: 'MIS Quarterly' });
      assert.equal(lookup.status, 400);
      assert.match((await lookup.json()).error, /easyScholar/);

      const { journal } = await (await post('/api/journals', { name: 'MIS Quarterly' })).json();
      const rank = await post(`/api/journals/${journal.id}/rank`);
      assert.equal(rank.status, 400);
      assert.match((await rank.json()).error, /easyScholar/);

      const batch = await post('/api/journals/batch-rank', {});
      assert.equal(batch.status, 400);
      assert.match((await batch.json()).error, /easyScholar/);

      const ai = await post(`/api/journals/${journal.id}/ai`);
      assert.equal(ai.status, 400);
      assert.match((await ai.json()).error, /大模型|AI 设置/);

      const meta = await (await fetch(base + '/api/journals/meta')).json();
      assert.equal(meta.hasScholarKey, false);
      assert.ok(meta.dimensions.length >= 3, '评价维度要由服务端统一下发，前后端不能各写一份');
    } finally {
      await close(server);
    }
  });
});

test('HTTP：从文献库导入期刊名，同一本刊只收一次', async () => {
  await withDataDir(async () => {
    store.upsertLiterature({ id: 'lit1', docType: 'empirical', title: 'A', journal: 'Journal of Finance' });
    store.upsertLiterature({ id: 'lit2', docType: 'empirical', title: 'B', journal: 'journal of finance' });
    store.upsertLiterature({ id: 'lit3', docType: 'empirical', title: 'C', journal: '' });
    store.upsertLiterature({ id: 'lit4', docType: 'algorithm', title: 'D', journal: 'NeurIPS' });

    const { app } = createApp();
    const server = createServer(app);
    const base = await listen(server);
    try {
      const res = await fetch(base + '/api/journals/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'literature', docType: 'empirical' }),
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.added, 1, '两篇同刊只收一本，空期刊名跳过');
      assert.equal(data.skipped, 1);

      // 再导一次：全都已收藏
      const again = await (await fetch(base + '/api/journals/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'literature' }),
      })).json();
      assert.equal(again.added, 1, '这次不限制文库，NeurIPS 应该补进来');
      // 文献库里 JoF 与 jof 两条撞同一本，都已收藏 → 各记一次跳过
      assert.equal(again.skipped, 2);
    } finally {
      await close(server);
    }
  });
});

test('HTTP：配了 key 时查等级，结果写回记录；被对方拒绝也要把原因留住', async () => {
  await withDataDir(async () => {
    store.saveSettings({ ...store.getSettings(), easyScholarKey: 'fake-key' });
    const realFetch = globalThis.fetch;
    let mode = 'ok';
    // 只拦 easyScholar，其余（本机 app 的请求）照旧走真 fetch
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input?.url || '';
      if (url.includes('easyscholar.cc')) {
        if (mode === 'fail') {
          return new Response(JSON.stringify({ code: 400, msg: '未查询到该期刊' }), { headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          code: 200,
          data: { officialRank: { all: { sciUp: '1区', utd24: '是', ajg: '4' } } },
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      return realFetch(input, init);
    };

    const { app } = createApp();
    const server = createServer(app);
    const base = await listen(server);
    try {
      const post = (p, body) => fetch(base + p, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
      });
      const { journal } = await (await post('/api/journals', { name: 'Journal of Consumer Research' })).json();

      const ranked = await post(`/api/journals/${journal.id}/rank`);
      assert.equal(ranked.status, 200);
      const body = await ranked.json();
      assert.ok(body.rank.items.length >= 2, '要解析出多个等级项');
      assert.match(body.rank.summary, /中科院分区/);
      assert.ok(body.rank.at, '要记查询时间，页面才能提示「超过 7 天建议重查」');
      assert.ok(body.tierScore != null, '有等级后要能按等级排序');

      // 换一本查不到收录的：不能假装查到，error 要落库
      mode = 'fail';
      const { journal: j2 } = await (await post('/api/journals', { name: 'Some Unknown Journal' })).json();
      const failed = await post(`/api/journals/${j2.id}/rank`);
      assert.equal(failed.status, 400);
      const after = (await (await fetch(`${base}/api/journals/${j2.id}`)).json()).journal;
      assert.match(after.rank.error, /未查询到/);
      assert.equal(after.rank.items.length, 0, '查不到就不要留上一轮的旧等级');
    } finally {
      globalThis.fetch = realFetch;
      await close(server);
    }
  });
});

// ---------- 前端接线 ----------
test('前端接线：导航项、视图容器、脚本、路由映射与样式都在', async () => {
  const [html, appJs, css, jrJs] = await Promise.all([
    readFile(path.join(root, 'public/index.html'), 'utf-8'),
    readFile(path.join(root, 'public/app.js'), 'utf-8'),
    readFile(path.join(root, 'public/style.css'), 'utf-8'),
    readFile(path.join(root, 'public/journals.js'), 'utf-8'),
  ]);
  assert.match(html, /data-view="journals"/, '侧栏要有入口');
  assert.match(html, /id="viewJournals"/, '要有一个空容器给模块挂载');
  assert.match(html, /<script src="journals\.js"><\/script>/, '脚本要引入');
  assert.match(appJs, /journals:\s*'viewJournals'/, 'switchView 的映射不能漏');
  assert.match(appJs, /JournalView\?\.mount\?\.\(\$\('viewJournals'\)\)/, '进视图时要挂载');
  assert.match(appJs, /JournalView\?\.close\?\.\(\)/, '切走时要收抽屉');
  assert.match(appJs, /journals:\s*\{\s*name:/, 'VIEW_META 要补标题');
  assert.match(css, /\.jr-row \{/, '列表行样式');
  assert.match(css, /\.jr-drawer \{/, '抽屉样式');
  assert.match(jrJs, /window\.JournalView = \{ mount, close/, '模块导出约定');
  // 等级徽标必须按体系配色，不能全都一个颜色
  assert.match(css, /\.jr-badge-teal/);
  assert.match(css, /\.jr-badge-violet/);
  // 窄屏要能收起来
  assert.match(css, /@media \(max-width: 900px\)[\s\S]{0,400}\.jr-drawer \{ width: 100vw; \}/);
});
