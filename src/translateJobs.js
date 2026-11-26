// translateJobs.js —— 批量翻译后台任务（方向分析 / arXiv 共用）
//
// 免费翻译引擎要限速分段，50 篇摘要不可能在一次 HTTP 请求里等完。
// 这里沿用方向分析「POST 拿 jobId + GET 轮询」的成熟模式；任务只存内存，
// 译文本身由各调用方落盘（方向分析写会话，arXiv 由前端存 localStorage）。

import { randomUUID } from 'node:crypto';

const jobs = new Map();
const MAX_HISTORY = 30;

export function translateJobSummary(job) {
  return {
    id: job.id,
    kind: job.kind || '',
    status: job.status,
    total: job.total,
    done: job.done,
    engine: job.engine,
    error: job.error,
    byId: job.viewById || {},
    elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
  };
}

/**
 * 启动一批翻译任务。
 * items: [{id, text}]；translateImpl: (items, {settings, engine, signal, onProgress, logger}) => [{id, translation, error}]
 * onResult(rawById, job) 由路由提供，负责把原始译文整理成前端需要的 byId，并可落盘。
 */
export function startTranslateJob({
  kind = 'translate', items = [], settings = {}, engine = '',
  translateImpl, onResult, logger,
} = {}) {
  const id = `tr-${randomUUID().slice(0, 8)}`;
  const controller = new AbortController();
  const job = {
    id, kind, status: 'running', total: items.length, done: 0,
    engine, error: '', viewById: {}, startedAt: Date.now(), finishedAt: 0,
    controller,
  };
  jobs.set(id, job);
  if (jobs.size > MAX_HISTORY) {
    for (const old of [...jobs.values()].filter((j) => j.status !== 'running').sort((a, b) => a.startedAt - b.startedAt).slice(0, jobs.size - MAX_HISTORY)) {
      jobs.delete(old.id);
    }
  }
  Promise.resolve().then(async () => {
    const raw = await translateImpl(items, {
      settings, engine, signal: controller.signal,
      onProgress: (done) => { job.done = done; },
      logger,
    });
    const byId = {};
    for (const row of raw || []) if (row?.id) byId[row.id] = row;
    if (!controller.signal.aborted) {
      job.viewById = typeof onResult === 'function' ? (onResult(byId, job) || {}) : byId;
      job.status = 'done';
    }
  }).catch((e) => {
    job.status = 'error';
    job.error = String(e?.message || e).slice(0, 300);
    if (e?.name === 'AbortError' || controller.signal.aborted) { job.status = 'error'; job.error = '已取消'; }
  }).finally(() => { job.finishedAt = Date.now(); job.done = job.total; });
  return job;
}

export function getTranslateJob(id) { return jobs.get(String(id || '')) || null; }

export function cancelTranslateJob(id) {
  const job = jobs.get(String(id || ''));
  if (!job || job.status !== 'running') return false;
  job.controller.abort();
  job.status = 'error';
  job.error = '已取消';
  job.finishedAt = Date.now();
  return true;
}
