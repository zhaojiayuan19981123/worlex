// journalRoutes.js —— 期刊收藏的 HTTP 接口
//
// 三类信息各走各的路：
//   等级 → easyScholar（要 SecretKey，查回来的结果带时间戳，可刷新）
//   评价 → 用户自己打分写感受（主观数据，不做聚合、不假装是「大家说」）
//   周期 → 用户自己的投稿记录自动统计 + 可手填参考值（来源必须标出来）
//
// 这个模块不出网除「查等级」和「让模型写一份投稿建议」两处，且都要求先配置好。

import {
  listJournals, getJournal, createJournal, patchJournal, removeJournal,
  setRank, setAiReview, addSubmission, removeSubmission, importNames,
  REVIEW_DIMENSIONS, RESULTS, RESULT_LABELS, computeStats,
} from './journalStore.js';
import { queryPublicationRank, formatRank } from './easyscholar.js';

/** 等级查询的「新鲜期」：一周内重复进详情页不再打接口（额度有限，也被限速） */
const RANK_TTL_MS = 7 * 24 * 3600 * 1000;
/** 批量刷新一次最多查这么多本：easyScholar 每 550ms 一次，20 本约 11 秒，再多接口会等太久 */
const BATCH_LIMIT = 20;

function freshRank(rank) {
  if (!rank?.at || !Array.isArray(rank.items) || !rank.items.length) return false;
  const t = Date.parse(rank.at);
  return Number.isFinite(t) && Date.now() - t < RANK_TTL_MS;
}

export function registerJournalRoutes(app, ctx = {}) {
  const { store, resolveRequestModel, fetchModelCompletion, readLLMResponse } = ctx;

  const modelError = (e) => String(e?.message || '调用模型失败');

  // ---------- 元信息 ----------
  app.get('/api/journals/meta', (_req, res) => {
    const settings = store.getSettings();
    res.json({
      dimensions: REVIEW_DIMENSIONS,
      results: RESULTS.map((value) => ({ value, label: RESULT_LABELS[value] })),
      hasScholarKey: Boolean(settings?.easyScholarKey),
      hasModel: Boolean(settings?.modelProfiles?.length),
      rankTtlDays: Math.round(RANK_TTL_MS / 86400000),
      batchLimit: BATCH_LIMIT,
    });
  });

  // ---------- 列表 ----------
  app.get('/api/journals', (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const tag = String(req.query.tag || '').trim();
    const sort = String(req.query.sort || 'recent');
    let items = listJournals();

    if (q) {
      items = items.filter((j) => [j.name, j.nameCn, j.abbr, j.issn, j.publisher, j.field, j.note, ...(j.tags || [])]
        .filter(Boolean).join(' ').toLowerCase().includes(q));
    }
    if (tag) items = items.filter((j) => (j.tags || []).includes(tag));

    const byNum = (a, b, dir = 1) => (a == null ? 1 : b == null ? -1 : (a - b) * dir);
    if (sort === 'tier') items.sort((a, b) => byNum(b.tierScore, a.tierScore));
    else if (sort === 'rating') items.sort((a, b) => byNum(b.review?.rating, a.review?.rating));
    else if (sort === 'cycle') items.sort((a, b) => byNum(a.cycleInfo?.days, b.cycleInfo?.days));
    else if (sort === 'name') items.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    // recent：默认按收藏时间倒序（importNames 用 push，createJournal 用 unshift，统一按字段排）
    else items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

    const tags = [...new Set(items.flatMap((j) => j.tags || []))].sort((a, b) => a.localeCompare(b));
    const fields = [...new Set(items.map((j) => j.field).filter(Boolean))].sort((a, b) => a.localeCompare(b));

    res.json({
      items,
      tags,
      fields,
      total: items.length,
      counts: {
        total: items.length,
        rated: items.filter((j) => Number(j.review?.rating) > 0).length,
        withRank: items.filter((j) => Array.isArray(j.rank?.items) && j.rank.items.length).length,
        withCycle: items.filter((j) => j.cycleInfo?.days != null).length,
      },
    });
  });

  // ---------- 按名字临时查等级（还没收藏，先看看这本刊什么档次） ----------
  app.post('/api/journals/lookup', async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: '请填写期刊名' });
    const settings = store.getSettings();
    if (!settings?.easyScholarKey) {
      return res.status(400).json({ error: '未配置 easyScholar SecretKey，请在「AI 设置」中填写后再查等级' });
    }
    try {
      const data = await queryPublicationRank(name, settings.easyScholarKey);
      if (data?.code !== 200) return res.status(400).json({ error: 'easyScholar：' + (data?.msg || '未查询到该期刊') });
      const f = formatRank(data.data);
      res.json({ name, summary: f.summary, items: f.items });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- 新建 ----------
  app.post('/api/journals', async (req, res) => {
    try {
      const { journal, created } = createJournal(req.body || {});
      res.status(created ? 201 : 200).json({ journal, created });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ---------- 批量收藏：从文献库把出现过的期刊收进来 ----------
  app.post('/api/journals/import', (req, res) => {
    const body = req.body || {};
    let names = [];
    if (Array.isArray(body.names)) {
      names = body.names;
    } else if (body.source === 'literature') {
      const docType = String(body.docType || '').trim();
      const rows = store.listLiterature() || [];
      names = rows
        .filter((r) => (docType ? r.docType === docType : true))
        .map((r) => String(r.journal || '').trim())
        .filter(Boolean);
    } else {
      return res.status(400).json({ error: '请指定要导入的期刊名或数据来源' });
    }
    if (!names.length) return res.status(400).json({ error: '没有可导入的期刊名' });
    const result = importNames(names, { field: body.field || '' });
    res.json(result);
  });

  // ---------- 批量刷新等级（限 BATCH_LIMIT 本，跳过一周内刚查过的） ----------
  app.post('/api/journals/batch-rank', async (req, res) => {
    const settings = store.getSettings();
    if (!settings?.easyScholarKey) {
      return res.status(400).json({ error: '未配置 easyScholar SecretKey，请在「AI 设置」中填写' });
    }
    const force = Boolean(req.body?.force);
    const ids = Array.isArray(req.body?.ids) && req.body.ids.length
      ? req.body.ids.map(String)
      : listJournals().filter((j) => force || !freshRank(j.rank)).map((j) => j.id);
    const targets = ids.slice(0, BATCH_LIMIT);
    let updated = 0;
    let failed = 0;
    const failures = [];
    for (const id of targets) {
      const j = getJournal(id);
      if (!j) continue;
      try {
        const data = await queryPublicationRank(j.name, settings.easyScholarKey);
        if (data?.code !== 200) {
          setRank(id, { error: data?.msg || '未查询到该期刊' });
          failed += 1;
          failures.push({ id, name: j.name, error: data?.msg || '未查询到该期刊' });
          continue;
        }
        const f = formatRank(data.data);
        setRank(id, { summary: f.summary, items: f.items });
        updated += 1;
      } catch (e) {
        setRank(id, { error: e.message });
        failed += 1;
        failures.push({ id, name: j.name, error: e.message });
      }
    }
    res.json({
      requested: ids.length,
      done: targets.length,
      updated,
      failed,
      failures,
      skipped: Math.max(0, ids.length - targets.length),
      truncated: ids.length > BATCH_LIMIT,
    });
  });

  // ---------- 单条 ----------
  app.get('/api/journals/:id', (req, res) => {
    const j = getJournal(req.params.id);
    if (!j) return res.status(404).json({ error: '期刊不存在' });
    const settings = store.getSettings();
    res.json({ journal: j, staleRank: Boolean(j.rank?.at) && !freshRank(j.rank), hasScholarKey: Boolean(settings?.easyScholarKey) });
  });

  app.patch('/api/journals/:id', (req, res) => {
    try {
      const j = patchJournal(req.params.id, req.body || {});
      if (!j) return res.status(404).json({ error: '期刊不存在' });
      res.json(j);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete('/api/journals/:id', (req, res) => {
    if (!removeJournal(req.params.id)) return res.status(404).json({ error: '期刊不存在' });
    res.json({ ok: true });
  });

  // ---------- 查等级 ----------
  app.post('/api/journals/:id/rank', async (req, res) => {
    const j = getJournal(req.params.id);
    if (!j) return res.status(404).json({ error: '期刊不存在' });
    const settings = store.getSettings();
    if (!settings?.easyScholarKey) {
      return res.status(400).json({ error: '未配置 easyScholar SecretKey，请在「AI 设置」中填写' });
    }
    try {
      const data = await queryPublicationRank(j.name, settings.easyScholarKey);
      if (data?.code !== 200) {
        const msg = data?.msg || '未查询到该期刊';
        setRank(j.id, { error: msg });
        return res.status(400).json({ error: 'easyScholar：' + msg });
      }
      const f = formatRank(data.data);
      res.json(setRank(j.id, { summary: f.summary, items: f.items }));
    } catch (e) {
      setRank(j.id, { error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- 投稿经历 ----------
  app.post('/api/journals/:id/submissions', (req, res) => {
    try {
      const j = addSubmission(req.params.id, req.body || {});
      if (!j) return res.status(404).json({ error: '期刊不存在' });
      res.json(j);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete('/api/journals/:id/submissions/:sid', (req, res) => {
    const j = removeSubmission(req.params.id, req.params.sid);
    if (!j) return res.status(404).json({ error: '这条投稿记录不存在' });
    res.json(j);
  });

  // ---------- AI 投稿建议 ----------
  //
  // 严格限定「只给方法建议，不给事实数字」：影响因子、录用率、审稿周期这类数字
  // 模型记的往往是几年前的、甚至是错的。这里宁可让它说不知道，也不要让它编一个
  // 看起来很专业的小数点。
  app.post('/api/journals/:id/ai', async (req, res) => {
    const j = getJournal(req.params.id);
    if (!j) return res.status(404).json({ error: '期刊不存在' });

    let profile;
    if (resolveRequestModel) {
      const picked = resolveRequestModel(req.body?.profileId);
      if (picked?.error) return res.status(400).json({ error: picked.error });
      profile = picked?.profile;
    }
    if (!profile) return res.status(400).json({ error: '还没有配置大模型，请到「AI 设置」里添加' });

    const rankLine = (j.rank?.items || []).length
      ? j.rank.items.map((i) => `${i.label}：${i.value}`).join('；')
      : '（未查询到等级，或尚未查询）';
    const stats = computeStats(j.submissions);
    const mine = [
      j.review?.rating ? `我的总评：${j.review.rating}/5` : '',
      stats.medianFirstDays != null ? `我的投稿实测首轮意见中位数：${stats.medianFirstDays} 天` : '',
      stats.trials ? `已记录投稿 ${stats.trials} 次（接收 ${stats.accepted}、拒稿 ${stats.rejected}）` : '',
      j.review?.pros ? `我觉得好在：${j.review.pros}` : '',
      j.review?.cons ? `我觉得不足：${j.review.cons}` : '',
      j.note ? `我的备注：${j.note}` : '',
    ].filter(Boolean).join('\n');

    const system = [
      '你是一位有经验的论文投稿顾问，帮研究者判断「这本刊值不值得投、要怎么投」。',
      '硬规则：',
      '1. 不要编造任何具体事实数字（影响因子、录用率、审稿天数、版面费、年发文量）。',
      '   用户没提供、你也不能确定的一律写「未提供，需自行核实」，绝不猜。',
      '2. 必须区分「普遍规律」与「这本刊的特殊要求」；后者你不确定时明确说明不确定。',
      '3. 用中文，小标题 + 短句。全文 400~700 字，不写客套话。',
    ].join('\n');

    const user = [
      `期刊：${j.name}${j.nameCn ? `（${j.nameCn}）` : ''}${j.abbr ? `，简称 ${j.abbr}` : ''}`,
      j.issn ? `ISSN：${j.issn}` : '',
      j.publisher ? `出版方：${j.publisher}` : '',
      j.field ? `学科领域：${j.field}` : '',
      `已知等级（来自 easyScholar，可信）：${rankLine}`,
      mine ? `\n我的情况：\n${mine}` : '',
      '',
      '请输出四节：',
      '一、这本刊通常要什么样的稿子（选题、理论贡献、方法严格度、写作风格）',
      '二、投前自检清单（5 条以内，可勾选）',
      '三、常见退稿原因（结合等级与学科，说明判断依据）',
      '四、给我的建议（按我上面的评价与投稿记录，说明该不该投、先补什么）',
    ].filter(Boolean).join('\n');

    try {
      const request = await fetchModelCompletion(profile, {
        model: profile.model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: 0.4,
        stream: false,
      }, { stream: false, settings: store.getSettings() });
      try {
        const up = request.up;
        if (!up.ok) {
          const detail = up._litErrorText ?? await up.text().catch(() => '');
          throw new Error(`模型返回 ${up.status}：${String(detail).slice(0, 300)}`);
        }
        const text = (await readLLMResponse(up)).full;
        if (!String(text || '').trim()) throw new Error('模型返回了空内容');
        const saved = setAiReview(j.id, { text, model: profile.label || profile.model || '' });
        res.json(saved);
      } finally {
        request.cancel?.();
        request.abort?.();
      }
    } catch (e) {
      res.status(500).json({ error: modelError(e) });
    }
  });
}
