// arxivRoutes.js —— arXiv 分类浏览 / 翻译 / 下载 PDF 导入文献中心的 HTTP 入口
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ARXIV_GROUPS, ARXIV_SORTS, DEFAULT_CATEGORY, MAX_PER_PAGE, fetchArxiv } from './arxivFeed.js';
import { normalizeDocType } from './aiExtractor.js';
import { translateSegments } from './academicTranslate.js';
import { startTranslateJob, getTranslateJob, cancelTranslateJob, translateJobSummary } from './translateJobs.js';

const str = (v) => String(v == null ? '' : v);
const clean = (v) => str(v).replace(/\s+/g, ' ').trim();
const ALL_CATEGORIES = new Set(ARXIV_GROUPS.flatMap((g) => g.items.map(([id]) => id)));
const MAX_IMPORT = 50;
const MAX_TRANSLATE = 50;
const MAX_PDF_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 90000;
const IMPORT_HISTORY = 20;

/** arXiv 只接受自己的 PDF，避免用接口当任意 URL 下载器 */
function pdfUrlOf(item) {
  const id = clean(item?.id || item?.arxivId).replace(/^arxiv:/i, '');
  // 新编号 2501.00001v2；旧编号 cs/1234567v1
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(id) || /^[a-z-]+\/\d{7}(v\d+)?$/i.test(id)) {
    return `https://arxiv.org/pdf/${id}`;
  }
  const raw = clean(item?.pdfUrl || item?.absUrl);
  if (!raw) return '';
  try {
    const u = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    if (!/(^|\.)arxiv\.org$/.test(u.hostname)) return '';
    u.protocol = 'https:';
    return u.toString();
  } catch { return ''; }
}

async function downloadArxivPdf(url, { fetchImpl, signal }) {
  const impl = fetchImpl || fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await impl(url, {
      headers: { 'user-agent': 'worlex/3.1 (arxiv-pdf-import)', accept: 'application/pdf,*/*' },
      signal: ctrl.signal,
    });
    if (!res?.ok) throw new Error(`arXiv PDF 返回 HTTP ${res?.status || 0}`);
    let buf;
    if (typeof res.arrayBuffer === 'function') buf = Buffer.from(await res.arrayBuffer());
    else if (typeof res.buffer === 'function') buf = Buffer.from(await res.buffer());
    else buf = Buffer.from(str(await res.text()), 'binary');
    if (!buf.length) throw new Error('arXiv 返回了空文件');
    if (buf.length > MAX_PDF_BYTES) throw new Error('PDF 超过 100MB，已跳过');
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new Error('下载到的不是 PDF（可能是验证页或失效链接）');
    }
    return buf;
  } catch (e) {
    if (e?.name === 'AbortError' && signal?.aborted) {
      const err = new Error('已取消'); err.name = 'AbortError'; throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener?.('abort', onAbort);
  }
}

// ---------- PDF 导入后台任务：POST 拿 jobId + GET 轮询，避免一次请求等几十个 PDF ----------
const importJobs = new Map();

function importJobSummary(job) {
  return {
    id: job.id,
    status: job.status,
    total: job.total,
    done: job.done,
    imported: job.imported.length,
    records: job.imported,
    skipped: job.skipped,
    errors: job.errors,
    docType: job.docType,
    collectionId: job.collectionId,
    error: job.error,
    elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
  };
}

function getImportJob(id) { return importJobs.get(str(id)) || null; }
function cancelImportJob(id) {
  const job = getImportJob(id);
  if (!job || job.status !== 'running') return false;
  job.controller.abort();
  job.status = 'error';
  job.error = '已取消';
  job.finishedAt = Date.now();
  return true;
}

function startImportJob({ items, docType, collectionId, store, makeRecord, getUploadDir, fetchImpl, delayMs = 600, log = () => {} }) {
  const id = `imp-${randomUUID().slice(0, 8)}`;
  const controller = new AbortController();
  const job = {
    id, docType, collectionId, status: 'running', total: items.length, done: 0,
    imported: [], skipped: [], errors: [], error: '', startedAt: Date.now(), finishedAt: 0, controller,
  };
  importJobs.set(id, job);
  if (importJobs.size > IMPORT_HISTORY) {
    for (const old of [...importJobs.values()].filter((j) => j.status !== 'running').sort((a, b) => a.startedAt - b.startedAt).slice(0, importJobs.size - IMPORT_HISTORY)) {
      importJobs.delete(old.id);
    }
  }

  Promise.resolve().then(async () => {
    const list = store.listLiterature().filter((r) => (r.docType || 'empirical') === docType);
    const byArxiv = new Map(list.map((r) => [clean(r.arxivId), r]).filter(([k]) => k));
    const byDoi = new Map(list.map((r) => [clean(r.doi).toLowerCase(), r]).filter(([k]) => k));
    const byTitle = new Map(list.map((r) => [clean(r.title).toLowerCase(), r]).filter(([k]) => k));
    const uploadDir = typeof getUploadDir === 'function' ? getUploadDir() : path.join(process.cwd(), 'uploads');

    for (const it of items) {
      if (controller.signal.aborted) break;
      const title = clean(it?.title).slice(0, 300);
      const arxivId = clean(it?.id || it?.arxivId).slice(0, 100);
      const doi = clean(it?.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').slice(0, 200);
      if (!title) { job.done += 1; continue; }
      // 去重只看目标文库；v3.0 只存了元数据、没有 PDF 的记录，这次直接补上附件
      const dup = (arxivId && byArxiv.get(arxivId))
        || (doi && byDoi.get(doi.toLowerCase()))
        || byTitle.get(title.toLowerCase()) || null;
      if (dup?.filePath && fs.existsSync(dup.filePath)) {
        job.skipped.push(title);
        job.done += 1;
        continue;
      }
      const url = pdfUrlOf(it);
      if (!url) {
        job.errors.push({ id: arxivId, title, error: '没有可用的 arXiv PDF 地址' });
        job.done += 1;
        continue;
      }
      try {
        const buf = await downloadArxivPdf(url, { fetchImpl, signal: controller.signal });
        const safe = (arxivId || 'paper').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60) || 'paper';
        const filename = `arxiv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safe}.pdf`;
        const filePath = path.join(uploadDir, filename);
        fs.writeFileSync(filePath, buf);

        const rec = dup || makeRecord();
        rec.title = title;
        rec.titleZh = clean(it?.titleZh).slice(0, 300) || rec.titleZh;
        rec.authors = Array.isArray(it?.authors) ? it.authors.join('，').slice(0, 500) : clean(it?.authorLine).slice(0, 500) || rec.authors;
        rec.abstract = clean(it?.abstract).slice(0, 8000) || rec.abstract;
        rec.abstractZh = clean(it?.abstractZh).slice(0, 8000) || rec.abstractZh;
        rec.journal = clean(it?.journalRef).slice(0, 200) || rec.journal;
        rec.year = Number(String(it?.published || '').slice(0, 4)) || rec.year || 0;
        rec.doi = doi || rec.doi;
        rec.keywords = Array.isArray(it?.categories) ? it.categories.slice(0, 10).join(', ') : rec.keywords;
        rec.source = 'arxiv';
        rec.arxivId = arxivId;
        rec.arxivUrl = clean(it?.absUrl).slice(0, 500) || rec.arxivUrl;
        rec.pdfUrl = clean(it?.pdfUrl).slice(0, 500) || url;
        rec.docType = docType;
        rec.collectionId = collectionId;
        Object.assign(rec, {
          originalName: `${safe}.pdf`,
          filename,
          filePath,
          fileSize: buf.length,
          fileKind: 'pdf',
          importedAt: new Date().toISOString(),
        });
        if (!rec.status) rec.status = 'pending';
        store.upsertLiterature(rec);
        if (arxivId) byArxiv.set(arxivId, rec);
        if (doi) byDoi.set(doi.toLowerCase(), rec);
        byTitle.set(title.toLowerCase(), rec);
        job.imported.push({ id: rec.id, title, arxivId, docType, collectionId, filename, fileSize: buf.length });
        log(`[arXiv 导入] ${title} → ${filename} (${buf.length} bytes)`);
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        job.errors.push({ id: arxivId, title, error: clean(e?.message).slice(0, 200) || '下载失败' });
      }
      job.done += 1;
      // arXiv 对连续请求有限速，逐篇之间留一点间隔；测试可注入 delayMs=0
      if (delayMs > 0 && job.done < job.total) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    if (!controller.signal.aborted) job.status = 'done';
  }).catch((e) => {
    job.status = 'error';
    job.error = e?.name === 'AbortError' ? '已取消' : (clean(e?.message) || '导入失败');
  }).finally(() => { job.finishedAt = Date.now(); job.done = job.total; });
  return job;
}

export function registerArxivRoutes(app, {
  fetchImpl, logger, store, makeRecord, getUploadDir, delayMs = 600,
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
      importMode: 'pdf',
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

  // ---------- PDF 下载并导入文献中心 ----------
  // v3.0 只写元数据；v3.1 起把 arXiv PDF 真正下载到 uploads 并挂到文献记录上，
  // 于是导入后可以直接在文献中心打开阅读、做版面识别与全文翻译。
  // docType / collectionId 沿用世图下载助手的校验；去重只看目标文库。
  app.post('/api/arxiv/import', (req, res) => {
    if (!store || !makeRecord) return res.status(503).json({ error: '文献中心暂不可用' });
    const raw = Array.isArray(req.body?.items) ? req.body.items.slice(0, MAX_IMPORT) : [];
    if (!raw.length) return res.status(400).json({ error: '没有可导入的论文' });
    let docType;
    try { docType = normalizeDocType(req.body?.docType || 'empirical'); } catch (e) { return res.status(400).json({ error: e.message }); }
    const wantedCollection = clean(req.body?.collectionId);
    const collectionId = wantedCollection && store.listCollections().some((c) => c.id === wantedCollection && c.docType === docType)
      ? wantedCollection : null;

    const job = startImportJob({
      items: raw, docType, collectionId, store, makeRecord, getUploadDir, fetchImpl, delayMs,
      log,
    });
    res.json({ jobId: job.id, total: raw.length, docType, collectionId, mode: 'pdf' });
  });

  app.get('/api/arxiv/import/job/:jobId', (req, res) => {
    const job = getImportJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: '导入任务已结束（或服务已重启）' });
    res.json(importJobSummary(job));
  });

  app.post('/api/arxiv/import/job/:jobId/cancel', (req, res) => {
    res.json({ ok: cancelImportJob(req.params.jobId) });
  });

  return { importJobList: () => [...importJobs.values()].map((j) => ({ id: j.id, status: j.status, done: j.done })) };
}
