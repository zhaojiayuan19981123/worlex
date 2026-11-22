// specialIssueScheduler.js —— SI 征稿「每日定时抓取」
//
// 项目里原本没有 cron / node-schedule，也不引新依赖：用一个链式 setTimeout 排到
// 「下一个本地时间 syncHour:00」，跑完再排下一次。定时器一律 .unref()，不拖住进程退出。
// 启动补跑：上次同步超过 24 小时（或从未同步）时，等服务空闲 45 秒后补一次，
// 这样桌面版几天没开也不会一直显示旧数据，又不会在启动时抢首屏资源。

const DAY = 24 * 60 * 60 * 1000;

function nextLocalRun(now, hour) {
  const d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

/**
 * @param {object} deps
 *   getState() -> state            读取当前 SI 状态
 *   saveState(state) -> void       持久化（写 topicHistory 快照等）
 *   runNow(reason) -> Promise      真正执行一次抓取（由路由层实现）
 *   snapshot(state, now) -> state  生成主题快照（src/specialIssues.js 的 topicSnapshot）
 *   purgeIssues(state) -> {state, removed}  可选：清除已截止 SI
 *   logger(msg, err?)              可选日志
 *   now() -> Date                  可注入时间，便于单测
 */
export function createSpecialIssueScheduler(deps = {}) {
  const {
    getState = () => ({}),
    saveState = () => {},
    runNow = async () => {},
    snapshot = null,
    purgeIssues = null,
    logger = () => {},
    now = () => new Date(),
  } = deps;

  let dailyTimer = null;
  let catchupTimer = null;
  let cleanupTimer = null;
  let started = false;
  let running = false;
  let lastRunAt = '';
  let lastError = '';
  let nextRunAt = '';

  const status = () => {
    const s = getState() || {};
    const p = s.preferences || {};
    return {
      enabled: started && p.autoSync !== false,
      hour: Number.isFinite(Number(p.syncHour)) ? Number(p.syncHour) : 8,
      running,
      nextRunAt,
      lastRunAt,
      lastError,
      lastSyncAt: s.lastSyncAt || '',
    };
  };

  function writeSnapshot(reason) {
    if (typeof snapshot !== 'function') return;
    try {
      const s = getState();
      if (!s || !Array.isArray(s.issues) || !s.issues.length) return;
      const t = now();
      const key = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
      const snap = snapshot(s.issues, t);
      const next = { ...s, topicHistory: { ...(s.topicHistory || {}), [key]: snap.counts || {} } };
      saveState(next);
      logger(`[SI] 主题快照已记录（${reason}）`);
    } catch (e) {
      logger('[SI] 主题快照写入失败（忽略）：' + (e?.message || e));
    }
  }

  /** 到期清理：启动时立即跑一次，之后每小时一次；不依赖是否开启每日抓取。 */
  function cleanup() {
    if (typeof purgeIssues !== 'function') return;
    try {
      const result = purgeIssues(getState());
      if (result?.removed?.length) {
        saveState(result.state);
        logger(`[SI] 已自动清除 ${result.removed.length} 条已截止征稿`);
      }
    } catch (e) {
      logger('[SI] 到期清理失败（忽略）：' + (e?.message || e));
    }
  }

  async function trigger(reason) {
    if (running) return { skipped: true, reason: 'busy' };
    running = true;
    lastError = '';
    try {
      const result = await runNow(reason);
      lastRunAt = now().toISOString();
      writeSnapshot(reason);
      return result || { ok: true };
    } catch (e) {
      lastError = String(e?.message || e).slice(0, 300);
      logger('[SI] 定时抓取失败：' + lastError);
      return { ok: false, error: lastError };
    } finally {
      running = false;
    }
  }

  function schedule() {
    if (dailyTimer) clearTimeout(dailyTimer);
    const s = getState() || {};
    if (s.preferences?.autoSync === false) { nextRunAt = ''; return; }
    const hour = Number.isFinite(Number(s.preferences?.syncHour)) ? Number(s.preferences.syncHour) : 8;
    const target = nextLocalRun(now(), hour);
    nextRunAt = target.toISOString();
    const delay = Math.max(1000, target.getTime() - now().getTime());
    dailyTimer = setTimeout(async () => {
      await trigger('daily');
      schedule();
    }, delay);
    if (typeof dailyTimer.unref === 'function') dailyTimer.unref();
  }

  function start() {
    if (started) return status();
    started = true;
    cleanup();
    cleanupTimer = setInterval(cleanup, 60 * 60 * 1000);
    if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
    schedule();
    const s = getState() || {};
    if (s.preferences?.autoSync === false || !(s.selectedJournalIds || []).length) return status();
    const stale = !s.lastSyncAt || (now().getTime() - Date.parse(s.lastSyncAt) > DAY);
    if (stale) {
      catchupTimer = setTimeout(() => { trigger('catchup').catch(() => {}); }, 45000);
      if (typeof catchupTimer.unref === 'function') catchupTimer.unref();
    }
    return status();
  }

  function refresh() {
    if (!started) return status();
    schedule();
    return status();
  }

  function stop() {
    started = false;
    if (dailyTimer) clearTimeout(dailyTimer);
    if (catchupTimer) clearTimeout(catchupTimer);
    if (cleanupTimer) clearInterval(cleanupTimer);
    dailyTimer = null;
    catchupTimer = null;
    cleanupTimer = null;
    nextRunAt = '';
    return status();
  }

  return { start, stop, refresh, status, trigger };
}
