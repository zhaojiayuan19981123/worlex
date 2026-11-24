// specialIssueScheduler.js —— SI 征稿「每日增量抓取」定时器（v2）
//
// 不引新依赖：链式 setTimeout 排到下一个本地时间 syncHour:00，跑完再排下一次，定时器一律 unref()。
// 启动补跑：有启用的文章源、且上次同步超过 24 小时（或从未同步）时，等服务空闲 45 秒后补一次。
// v2 的判定条件从「是否订阅了期刊」改成「是否配置了启用的文章源」。

const DAY = 24 * 60 * 60 * 1000;

function nextLocalRun(now, hour) {
  const d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

/**
 * @param {object} deps
 *   getState() -> state
 *   saveState(state) -> void
 *   runNow(reason) -> Promise<{ok:boolean, error?:string}>
 *   logger(msg)
 *   now() -> Date
 */
export function createSpecialIssueScheduler(deps = {}) {
  const {
    getState = () => ({}),
    saveState = () => {},
    runNow = async () => ({ ok: true }),
    logger = () => {},
    now = () => new Date(),
  } = deps;

  let dailyTimer = null;
  let catchupTimer = null;
  let started = false;
  let running = false;
  let lastRunAt = '';
  let lastError = '';
  let nextRunAt = '';

  const enabledSources = () => {
    const s = getState() || {};
    return Array.isArray(s.sources) ? s.sources.filter((x) => x && x.enabled) : [];
  };

  const status = () => {
    const s = getState() || {};
    const p = s.preferences || {};
    return {
      enabled: started && p.autoSync !== false,
      hour: Number.isFinite(Number(p.syncHour)) ? Number(p.syncHour) : 9,
      running,
      nextRunAt,
      lastRunAt,
      lastError,
      lastSyncAt: s.lastSyncAt || '',
      sources: enabledSources().length,
    };
  };

  async function trigger(reason) {
    if (running) return { skipped: true, reason: 'busy' };
    running = true;
    lastError = '';
    try {
      const result = await runNow(reason);
      lastRunAt = now().toISOString();
      if (result?.ok === false) lastError = result.error || '本次同步未产生新数据';
      return result || { ok: true };
    } catch (e) {
      lastError = String(e?.message || e).slice(0, 300);
      logger('[SI] 定时同步失败：' + lastError);
      return { ok: false, error: lastError };
    } finally {
      running = false;
    }
  }

  function schedule() {
    if (dailyTimer) clearTimeout(dailyTimer);
    const s = getState() || {};
    if (s.preferences?.autoSync === false || !enabledSources().length) { nextRunAt = ''; return; }
    const hour = Number.isFinite(Number(s.preferences?.syncHour)) ? Number(s.preferences.syncHour) : 9;
    const target = nextLocalRun(now(), hour);
    nextRunAt = target.toISOString();
    const delay = Math.max(1000, target.getTime() - now().getTime());
    dailyTimer = setTimeout(async () => {
      if (started && getState()?.preferences?.autoSync !== false) await trigger('daily');
      if (started) schedule();
    }, delay);
    if (typeof dailyTimer.unref === 'function') dailyTimer.unref();
  }

  function start() {
    if (started) return status();
    started = true;
    schedule();
    const s = getState() || {};
    if (s.preferences?.autoSync === false || !enabledSources().length) return status();
    const stale = !s.lastSyncAt || (now().getTime() - Date.parse(s.lastSyncAt) > DAY);
    if (stale) {
      catchupTimer = setTimeout(() => {
        catchupTimer = null;
        const latest = getState() || {};
        if (started && latest.preferences?.autoSync !== false && enabledSources().length
          && (!latest.lastSyncAt || now().getTime() - Date.parse(latest.lastSyncAt) > DAY)) {
          trigger('catchup').catch(() => {});
        }
      }, 45000);
      if (typeof catchupTimer.unref === 'function') catchupTimer.unref();
    }
    return status();
  }

  function refresh() {
    if (!started) return status();
    if (getState()?.preferences?.autoSync === false && catchupTimer) {
      clearTimeout(catchupTimer);
      catchupTimer = null;
    }
    schedule();
    return status();
  }

  function stop() {
    started = false;
    if (dailyTimer) clearTimeout(dailyTimer);
    if (catchupTimer) clearTimeout(catchupTimer);
    dailyTimer = null;
    catchupTimer = null;
    nextRunAt = '';
    return status();
  }

  return { start, stop, refresh, status, trigger, saveState };
}
