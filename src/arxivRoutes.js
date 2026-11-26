// arxivRoutes.js —— arXiv 分类浏览 / 翻译 / 导入文献中心的 HTTP 入口
import { ARXIV_GROUPS, ARXIV_SORTS, DEFAULT_CATEGORY, MAX_PER_PAGE, fetchArxiv } from './arxivFeed.js';
import { normalizeDocType } from './aiExtractor.js';
import { translateSegments } from './academicTranslate.js';
import { startTranslateJob, getTranslateJob, cancelTranslateJob, translateJobSummary } from './translateJobs.js';

const str = (v) => String(v == null ? '' : v);
const clean = (v) => str(v).replace(/\s+/g, ' ').trim();
const ALL_CATEGORIES = new Set(ARXIV_GROUPS.flatMap((g) => g.items.map(([id]) => id)));
const MAX_IMPORT = 50;
const MAX_TRANSLATE = 50;

export function registerArxivRoutes(app, {
  fetchImpl, logger, store, makeRecord,
  translateImpl = translateSegments,
} = {}) {
  const log = typeof logger === 'function' ? logger : () => {};

  app.get('/api/arxiv/meta', (_req, res) => {
    res.json({
      groups: ARXIV_GROUPS,
      sorts: ARXIV_SORTS,
      defaultCategory: DEFAULT_CATEGORY,
      maxPerPage: MAX_PER_PAGE,
      limits: { maxImport: MAX_IMPORT, maxTranslate: MAX_TRANSLATE },
    });
  });

  app.get('/api/arxiv/feed', async (req, res) => {
    const category = clean(req.query?.category) || DEFAULT_CATEGORY;
    if (category !== 'all' && !ALL_CATEGORIES.has(category)) {
      return res.status(400).json({ error: '未知的 arXiv 分类' });
    }
    const perPage = Math.min(MAX_PER_PAGE, Math.max(1, Number(req.query?.perPage) || 20));
    const start = Math.max(0, Number(req.query?.start) || 0);
    const query = clean(req.query?.q);
    if (query.length > 160) return res.status(400).json({ error: '检索词过长（最多 160 字）' });
    try {
      const data = await fetchArxiv({ category, query, start, perPage, sort: req.query?.sort }, { fetchImpl });
      res.json({ ...data, category, query, perPage, start });
    } catch (e) {
      const message = e?.name === 'AbortError' ? 'arXiv 响应超时，请稍后重试' : (e?.message || 'arXiv 抓取失败');
      log(`[arXiv] ${message}`);
      res.status(502).json({ error: message });
    }
  });

  // ---------- 翻译：只走翻译引擎，分段后台跑，进度可轮询 ----------
  app.post('/api/arxiv/translate', (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, MAX_TRANSLATE) : [];
    if (!items.length) return res.status(400).json({ error: '没有需要翻译的论文' });
    const segments = [];
    for (const it of items) {
      const id = clean(it?.id);
      if (!id) continue;
      if (clean(it.title)) segments.push({ id: `${id}|title`, text: clean(it.title) });
      if (clean(it.abstract)) segments.push({ id: `${id}|abstract`, text: clean(it.abstract).slice(0, 1200) });
    }
    if (!segments.length) return res.status(400).json({ error: '所选论文没有标题或摘要' });
    const job = startTranslateJob({
      kind: 'arxiv',
      items: segments,
      settings: store ? store.getSettings() : {},
      engine: clean(req.body?.engine),
      translateImpl,
      logger: (msg) => log(`[arXiv 翻译] ${msg}`),
      onResult: (raw) => {
        const view = {};
        const ids = new Set(items.map((it) => clean(it?.id)).filter(Boolean));
        for (const id of ids) {
          const t = raw[`${id}|title`];
          const a = raw[`${id}|abstract`];
          if (!t?.translation && !a?.translation) continue;
          view[id] = {
            ...(t?.translation ? { titleZh: clean(t.translation).slice(0, 500) } : {}),
            ...(a?.translation ? { abstractZh: clean(a.translation).slice(0, 4000) } : {}),
            ...((t?.error || a?.error) ? { error: t?.error || a?.error } : {}),
          };
        }
        return view;
      },
    });
    res.json({ jobId: job.id, total: items.length, segments: segments.length, engine: job.engine });
  });

  app.get('/api/arxiv/translate/job/:jobId', (req, res) => {
    const job = getTranslateJob(req.params.jobId);
    if (!job || job.kind !== 'arxiv') return res.status(404).json({ error: '翻译任务已结束（或服务已重启）' });
    res.json(translateJobSummary(job));
  });

  app.post('/api/arxiv/translate/job/:jobId/cancel', (req, res) => {
    res.json({ ok: cancelTranslateJob(req.params.jobId) });
  });

  // ---------- 一键导入文献中心 ----------
  // 与世图下载助手同一套 docType / collectionId 校验；去重按 arXiv id > DOI > 标题，
  // 只看目标文库，同一篇可分别收进实证类与算法类。
  app.post('/api/arxiv/import', (req, res) => {
    if (!store || !makeRecord) return res.status(503).json({ error: '文献中心暂不可用' });
    const raw = Array.isArray(req.body?.items) ? req.body.items.slice(0, MAX_IMPORT) : [];
    if (!raw.length) return res.status(400).json({ error: '没有可导入的论文' });
    let docType;
    try { docType = normalizeDocType(req.body?.docType || 'empirical'); } catch (e) { return res.status(400).json({ error: e.message }); }
    const wantedCollection = clean(req.body?.collectionId);
    const collectionId = wantedCollection && store.listCollections().some((c) => c.id === wantedCollection && c.docType === docType)
      ? wantedCollection : null;

    const list = store.listLiterature().filter((r) => (r.docType || 'empirical') === docType);
    const existIds = new Set(list.map((r) => clean(r.arxivId)).filter(Boolean));
    const existDoi = new Set(list.map((r) => clean(r.doi).toLowerCase()).filter(Boolean));
    const existTitle = new Set(list.map((r) => clean(r.title).toLowerCase()).filter(Boolean));
    const imported = [];
    const skipped = [];

    for (const it of raw) {
      const id = clean(it?.id);
      const title = clean(it?.title).slice(0, 300);
      if (!title) continue;
      const doi = clean(it?.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').slice(0, 200);
      const key = title.toLowerCase();
      const arxivId = id || clean(it?.arxivId);
      const duplicate = (arxivId && existIds.has(arxivId))
        || (doi && existDoi.has(doi.toLowerCase()))
        || existTitle.has(key);
      if (duplicate) { skipped.push(title); continue; }

      const rec = makeRecord();
      rec.title = title;
      rec.titleZh = clean(it?.titleZh).slice(0, 300);
      rec.authors = Array.isArray(it?.authors) ? it.authors.join('，').slice(0, 500) : clean(it?.authorLine).slice(0, 500);
      rec.abstract = clean(it?.abstract).slice(0, 8000);
      rec.abstractZh = clean(it?.abstractZh).slice(0, 8000);
      rec.journal = clean(it?.journalRef).slice(0, 200);
      rec.year = Number(String(it?.published || '').slice(0, 4)) || 0;
      rec.doi = doi;
      rec.keywords = Array.isArray(it?.categories) ? it.categories.slice(0, 10).join(', ') : '';
      rec.source = 'arxiv';
      rec.arxivId = arxivId.slice(0, 100);
      rec.arxivUrl = clean(it?.absUrl).slice(0, 500);
      rec.pdfUrl = clean(it?.pdfUrl).slice(0, 500);
      rec.docType = docType;
      rec.collectionId = collectionId;
      store.upsertLiterature(rec);
      list.push(rec);
      if (arxivId) existIds.add(arxivId);
      if (doi) existDoi.add(doi.toLowerCase());
      existTitle.add(key);
      imported.push({ id: rec.id, title: rec.title, docType, collectionId });
    }
    res.json({ imported: imported.length, skipped, records: imported, docType, collectionId });
  });
}
