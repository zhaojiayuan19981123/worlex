/* special-issue.js —— SI 征稿视图 v3（公众号 / 官网页面 / 粘贴正文 → 列表 + 右侧详情）
 *
 * 挂载约定与 knowledge-graph.js 一致：
 *   切入  window.SpecialIssueView.mount(container)
 *   切走  window.SpecialIssueView.close()
 *
 * 数据流：
 *   GET  /api/special-issues              列表（不含全文翻译，控制响应体积）
 *   GET  /api/special-issues/:id          详情（含全文翻译 detailZh 与相关灵感）
 *   POST /api/special-issues/collect      收稿：公众号链接 / 官网链接 / 整段正文
 *   POST /api/special-issues/sync         启动后台同步，立即返回；本页轮询 /status 看进度
 *   POST /api/special-issues/:id/task     加入任务安排（替代原来的收藏）
 *   POST /api/special-issues/:id/ideas    让模型梳理与「灵感孵化」的关联
 *   POST /api/special-issues/:id/translate 生成 / 重译全文
 *   POST /api/special-issues/step         单步执行（补抽取 / 补等级 / 重试失败）
 *
 * 布局：列表行 → 点开右侧抽屉。之前是卡片网格 + 点击原地展开，问题是
 * 一屏只能放 4~6 张卡、摘要被截断成 3 行，而征稿真正要看的是全文和日期，
 * 所以改成「一览表 + 抽屉详情」：列表负责扫，抽屉负责读。
 *
 * 安全：后端文本一律 esc() 后拼 HTML；外链只放行 http(s)。
 */
(() => {
  'use strict';

  const S = {
    mounted: false,
    container: null,
    root: null,
    data: null,
    // 筛选
    query: '',
    deadlineWindow: 'all',
    rankSystem: '',
    rankLevels: new Set(),
    topics: new Set(),
    taskOnly: false,
    sort: '',
    // 界面
    busy: new Set(),
    panel: '',
    panelTab: 'sources',
    draft: { type: 'rss', name: '', target: '', backfillDays: 90 },
    pollTimer: null,
    pollStartedAt: 0,
    pasteHandler: null,
    guideHidden: false,
    drawerId: '',
    drawerTab: 'detail',
    detail: null,
    detailLoading: false,
    detailError: '',
    ideasBusy: false,
    taskBusy: false,
    translateBusy: false,
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ico = (name, cls = '') => `<svg class="ico${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const safeUrl = (u) => {
    try { const x = new URL(String(u || '')); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; }
  };
  const fmtTime = (s) => {
    if (!s) return '尚未同步';
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return '尚未同步';
    const diff = Date.now() - d.getTime();
    if (diff < 60e3) return '刚刚';
    if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`;
    if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`;
    return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const fmtDate = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : '');
  const fmtShort = (s) => (fmtDate(s) ? fmtDate(s).slice(5) : '');

  function toast(msg, type = '') {
    if (window.Worlex?.toast) window.Worlex.toast(msg, type);
    else console.log('[SI]', msg);
  }

  async function api(path, opts = {}) {
    const init = { ...opts };
    if (init.body !== undefined) {
      init.body = JSON.stringify(init.body);
      init.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    }
    if (window.Worlex?.api) return window.Worlex.api(path, init);
    const res = await fetch(path, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
    return data;
  }

  const absScore = (value) => {
    const s = String(value || '').trim();
    if (!s) return 0;
    if (/4\s*\*/.test(s)) return 5;
    const m = /([1-4])/.exec(s);
    return m ? Number(m[1]) : 0;
  };

  const GUIDE_KEY = 'worlex.si.guideHidden';

  // ---------------- DOM 骨架 ----------------
  function buildDom(host) {
    const root = document.createElement('div');
    root.className = 'si-root';
    root.innerHTML = `
      <div class="si-head">
        <div class="si-head-main">
          <h2>SI 征稿</h2>
          <div class="si-meta-line" id="siMeta"></div>
        </div>
        <div class="si-head-actions">
          <button class="tb-btn is-primary" id="siCollectBtn">${ico('clipboard')}<span>粘贴收稿</span></button>
          <button class="tb-btn" id="siSyncBtn">${ico('refresh')}<span>立即同步</span></button>
          <button class="tb-btn" id="siRankBtn">${ico('award')}<span>刷新等级</span></button>
          <button class="tb-btn" id="siSettingsBtn">${ico('settings')}<span>设置</span></button>
        </div>
      </div>

      <div id="siGuide"></div>
      <div class="si-stats" id="siStats"></div>
      <div id="siBanner"></div>

      <div class="si-toolbar">
        <div class="si-search-wrap">
          ${ico('search')}
          <input class="si-input" id="siQuery" type="search" placeholder="搜索期刊 / 主题 / 客座编辑…" autocomplete="off" />
        </div>
        <select class="si-select" id="siDeadline" aria-label="截止时间"></select>
        <select class="si-select" id="siRankSystem" aria-label="期刊等级体系"></select>
        <select class="si-select" id="siSort" aria-label="排序"></select>
        <label class="si-switch" id="siTaskSwitch"><input type="checkbox" id="siTaskOnly" /><span>只看已加任务</span></label>
        <button class="si-clear-btn hidden" id="siClear">清除筛选</button>
      </div>

      <div class="si-level-row hidden" id="siLevelRow"></div>
      <div class="si-topic-row hidden" id="siTopicRow"></div>

      <div id="siList"></div>
    `;
    host.appendChild(root);
    S.root = root;
    try { S.guideHidden = localStorage.getItem(GUIDE_KEY) === '1'; } catch { S.guideHidden = false; }

    root.querySelector('#siCollectBtn').addEventListener('click', () => openCollect());
    root.querySelector('#siSyncBtn').addEventListener('click', () => sync());
    root.querySelector('#siRankBtn').addEventListener('click', () => refreshRanks());
    root.querySelector('#siSettingsBtn').addEventListener('click', () => openPanel('sources'));

    const q = root.querySelector('#siQuery');
    let timer = null;
    q.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { S.query = q.value.trim(); renderList(); renderToolbarState(); }, 160);
    });
    root.querySelector('#siDeadline').addEventListener('change', (e) => { S.deadlineWindow = e.target.value; renderList(); renderToolbarState(); });
    root.querySelector('#siRankSystem').addEventListener('change', (e) => {
      S.rankSystem = e.target.value; S.rankLevels.clear(); renderLevelRow(); renderList(); renderToolbarState();
    });
    root.querySelector('#siSort').addEventListener('change', (e) => { S.sort = e.target.value; renderList(); });
    root.querySelector('#siTaskOnly').addEventListener('change', (e) => {
      S.taskOnly = e.target.checked;
      root.querySelector('#siTaskSwitch').classList.toggle('is-on', e.target.checked);
      renderList(); renderToolbarState();
    });
    root.querySelector('#siClear').addEventListener('click', () => {
      S.query = ''; S.deadlineWindow = 'all'; S.rankSystem = ''; S.rankLevels.clear();
      S.topics.clear(); S.taskOnly = false; S.sort = '';
      root.querySelector('#siQuery').value = '';
      syncControls();
      renderLevelRow(); renderTopicRow(); renderList(); renderToolbarState();
    });
  }

  function syncControls() {
    if (!S.root) return;
    const set = (sel, val) => { const el = S.root.querySelector(sel); if (el && el.value !== val) el.value = val; };
    set('#siDeadline', S.deadlineWindow);
    set('#siRankSystem', S.rankSystem);
    set('#siSort', S.sort || S.data?.preferences?.sort || 'deadline');
    const task = S.root.querySelector('#siTaskOnly');
    if (task) task.checked = S.taskOnly;
    S.root.querySelector('#siTaskSwitch')?.classList.toggle('is-on', S.taskOnly);
  }

  // ---------------- 头部 / 统计 ----------------
  function renderMeta() {
    const d = S.data;
    const el = S.root.querySelector('#siMeta');
    if (!d) { el.textContent = ''; return; }
    const sch = d.scheduler || {};
    const next = sch.enabled && sch.nextRunAt
      ? `下次自动同步 ${new Date(sch.nextRunAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
      : '自动同步已关闭';
    el.innerHTML = [
      `<span>${ico('clock')}上次同步 ${esc(fmtTime(d.summary.lastSyncAt))}</span>`,
      `<span>${ico('inbox')}${d.summary.enabledSources} 个文章源</span>`,
      `<span>${ico('calendar')}${esc(next)}</span>`,
    ].join('<i class="si-dot"></i>');
    const badge = document.querySelector('#navSiBadge');
    if (badge) {
      const n = d.summary.urgent || 0;
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.classList.toggle('hidden', !n);
    }
  }

  /**
   * 「去哪粘贴」提示块。
   * 用户最容易卡住的一步不是点击，而是「不知道去哪个号找征稿」，
   * 所以把公众号名和微信号直接写在这里，而不是藏在设置的面板里。
   */
  function renderGuide() {
    const el = S.root.querySelector('#siGuide');
    if (!el) return;
    if (S.guideHidden) {
      el.innerHTML = `<button class="si-guide-collapsed" id="siGuideShow">${ico('info')}<span>看在哪找征稿（公众号「SSCI征稿」）</span></button>`;
      el.querySelector('#siGuideShow')?.addEventListener('click', () => {
        S.guideHidden = false;
        try { localStorage.setItem(GUIDE_KEY, '0'); } catch { /* 隐私模式忽略 */ }
        renderGuide();
      });
      return;
    }
    const g = S.data?.guide || { accountName: 'SSCI征稿', accountId: 'sscizhenggao' };
    el.innerHTML = `<div class="si-guide">
      <div class="si-guide-head">
        <b>${ico('megaphone')}去哪找征稿</b>
        <button class="si-guide-hide" id="siGuideHide" title="收起">收起</button>
      </div>
      <ol class="si-guide-steps">
        <li>打开微信，搜索并关注公众号 <b class="si-guide-account">${esc(g.accountName)}</b>${g.accountId ? `<span class="si-guide-id">微信号 ${esc(g.accountId)}</span>` : ''}。</li>
        <li>打开当天的推送，点右上角 <b>···</b>（电脑版右键）→ <b>复制链接</b>。</li>
        <li>回到这里直接按 <kbd>Ctrl</kbd>+<kbd>V</kbd>，或点右上角「粘贴收稿」。</li>
      </ol>
      <p class="si-guide-note">也可以粘贴出版社的专刊页链接，或整段征稿正文——都会整理成新条目，不用管格式。</p>
    </div>`;
    el.querySelector('#siGuideHide')?.addEventListener('click', () => {
      S.guideHidden = true;
      try { localStorage.setItem(GUIDE_KEY, '1'); } catch { /* ignore */ }
      renderGuide();
    });
  }

  function renderStats() {
    const d = S.data;
    const el = S.root.querySelector('#siStats');
    if (!d) { el.innerHTML = ''; return; }
    const s = d.summary;
    const nearest = s.nearestTask || null;
    const cells = [
      { n: s.active, label: '在征专刊', accent: true },
      { n: s.urgent, label: '30 天内截止', tone: s.urgent ? 'urgent' : '' },
      { n: s.pendingArticles, label: '待处理文章', tone: s.pendingArticles ? 'soon' : '' },
      {
        // 这一格回答的是「我已经接下的活最近哪天要交」——只统计加进任务的征稿
        n: nearest ? fmtShort(nearest.date) : '—',
        label: nearest ? `任务最近截止 · ${nearest.label}` : (s.tasks ? '任务截止日待核实' : '还没加任务'),
        tone: nearest && nearest.days <= 30 ? 'urgent' : nearest ? 'soon' : '',
        action: 'tasks',
        title: nearest ? `${nearest.journal || ''} ${nearest.title || ''}` : '在详情里点「加入任务」，截止日就会出现在这里和首页',
      },
      { n: s.tasks || 0, label: '已加入任务的征稿' },
    ];
    el.innerHTML = cells.map((c) => `<div class="si-stat${c.accent ? ' is-accent' : ''}${c.tone ? ' is-' + c.tone : ''}${c.action ? ' is-clickable' : ''}"${c.action ? ` data-stat="${c.action}"` : ''}${c.title ? ` title="${esc(c.title)}"` : ''}><b>${esc(c.n)}</b><span>${esc(c.label)}</span></div>`).join('');
    el.querySelector('[data-stat="tasks"]')?.addEventListener('click', () => {
      S.taskOnly = true;
      syncControls();
      renderList(); renderToolbarState();
    });
  }

  function renderBanner() {
    const d = S.data;
    const el = S.root.querySelector('#siBanner');
    if (!d) { el.innerHTML = ''; return; }
    const rt = d.runtime || {};
    if (rt.running) {
      el.innerHTML = `<div class="si-banner is-running">${ico('loader', 'is-spin')}<span>${esc(rt.message || '正在同步…')}</span></div>`;
      return;
    }
    const res = rt.lastResult;
    if (res && (res.newIssues || res.processed || res.errors?.length)) {
      const bits = [];
      if (res.added) bits.push(`新内容 ${res.added} 篇`);
      if (res.extractedArticles) bits.push(`识别 ${res.extractedArticles} 篇`);
      if (res.newIssues) bits.push(`新增 ${res.newIssues} 条征稿`);
      if (res.skipped) bits.push(`跳过 ${res.skipped} 篇（非征稿）`);
      if (res.failed) bits.push(`失败 ${res.failed} 篇`);
      if (res.ranked) bits.push(`补等级 ${res.ranked} 本`);
      const errs = (res.errors || []).slice(0, 2);
      el.innerHTML = `<div class="si-banner ${errs.length ? 'is-warn' : 'is-ok'}">${ico(errs.length ? 'alert' : 'check-circle')}
        <span>上次处理：${esc(bits.join('，') || '没有新内容')}${errs.length ? `；${esc(errs.map((e) => e.error || '').join('；'))}` : ''}</span>
        <button class="si-link-btn" id="siDiagLink">查看诊断</button></div>`;
      el.querySelector('#siDiagLink')?.addEventListener('click', () => openPanel('diagnostics'));
      return;
    }
    if (!d.capability.hasModel) {
      el.innerHTML = `<div class="si-banner is-warn">${ico('alert')}<span>未配置大模型：当前用规则抽取，不会生成全文翻译。在「AI 设置」配好模型后，新收的征稿会自动带全文翻译。</span></div>`;
      return;
    }
    el.innerHTML = '';
  }

  // ---------------- 工具栏 ----------------
  function renderToolbarOptions() {
    const d = S.data;
    if (!d) return;
    S.root.querySelector('#siDeadline').innerHTML = (d.filters?.deadlineWindows || [{ id: 'all', label: '全部' }])
      .map((w) => `<option value="${esc(w.id)}">${esc(w.label)}</option>`).join('');
    S.root.querySelector('#siRankSystem').innerHTML = `<option value="">不限等级</option>` + (d.filters?.rankFilters || [])
      .map((r) => `<option value="${esc(r.label)}">${esc(r.label)}</option>`).join('');
    S.root.querySelector('#siSort').innerHTML = [
      ['deadline', '按截止时间'],
      ['latest', '按文章时间'],
      ['rank', '按等级高低'],
      ['confidence', '按可信度'],
    ].map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  }

  function renderLevelRow() {
    const d = S.data;
    const el = S.root.querySelector('#siLevelRow');
    const def = (d?.filters?.rankFilters || []).find((r) => r.label === S.rankSystem);
    if (!def) { el.innerHTML = ''; el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.innerHTML = `<span class="si-level-label">${esc(S.rankSystem)}</span>` + def.levels.map((lv) => {
      const on = S.rankLevels.has(lv);
      return `<button class="si-chip${on ? ' is-on' : ''}" data-level="${esc(lv)}">${esc(lv)}</button>`;
    }).join('');
    el.querySelectorAll('[data-level]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const lv = btn.dataset.level;
        if (S.rankLevels.has(lv)) S.rankLevels.delete(lv); else S.rankLevels.add(lv);
        renderLevelRow(); renderList(); renderToolbarState();
      });
    });
  }

  function renderTopicRow() {
    const d = S.data;
    const el = S.root.querySelector('#siTopicRow');
    const topics = d?.filters?.topics || [];
    if (!topics.length) { el.innerHTML = ''; el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.innerHTML = `<span class="si-level-label">主题</span>` + topics.slice(0, 14).map((t) => {
      const on = S.topics.has(t.topic);
      return `<button class="si-chip${on ? ' is-on' : ''}" data-topic="${esc(t.topic)}">${esc(t.topic)}<i>${t.count}</i></button>`;
    }).join('');
    el.querySelectorAll('[data-topic]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.topic;
        if (S.topics.has(t)) S.topics.delete(t); else S.topics.add(t);
        renderTopicRow(); renderList(); renderToolbarState();
      });
    });
  }

  function renderToolbarState() {
    const active = S.query || S.deadlineWindow !== 'all' || S.rankSystem || S.topics.size || S.taskOnly;
    S.root.querySelector('#siClear')?.classList.toggle('hidden', !active);
  }

  // ---------------- 列表 ----------------
  function filtered() {
    const d = S.data;
    if (!d) return [];
    const q = S.query.toLowerCase();
    const includeExpired = !!d.preferences.includeExpired;
    const list = d.issues.filter((i) => {
      const dm = i.deadline || { days: null };
      if (!includeExpired && dm.days !== null && dm.days < 0 && S.deadlineWindow !== 'expired') return false;
      if (S.deadlineWindow === '30' && !(dm.days !== null && dm.days >= 0 && dm.days <= 30)) return false;
      if (S.deadlineWindow === '90' && !(dm.days !== null && dm.days >= 0 && dm.days <= 90)) return false;
      if (S.deadlineWindow === 'undated' && dm.days !== null) return false;
      if (S.deadlineWindow === 'expired' && !(dm.days !== null && dm.days < 0)) return false;
      if (S.taskOnly && !i.taskId) return false;
      if (S.topics.size && !(i.topicsZh || []).some((t) => S.topics.has(t))) return false;
      if (S.rankSystem && S.rankLevels.size) {
        const badge = (i.badges || []).find((b) => b.label === S.rankSystem);
        if (!badge || !S.rankLevels.has(badge.level)) return false;
      }
      if (q) {
        const hay = [i.titleZh, i.titleEn, i.summaryZh, i.journal, i.journalShort, i.publisher,
          (i.topicsZh || []).join(' '), (i.guestEditors || []).map((e) => `${e.name} ${e.affiliation}`).join(' '),
          i.articleTitle, i.submissionNote].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const order = S.sort || d.preferences?.sort || 'deadline';
    return list.slice().sort((a, b) => {
      const da = a.deadline?.days ?? 99999;
      const db = b.deadline?.days ?? 99999;
      if (order === 'latest') return String(b.articlePublishedAt || b.createdAt).localeCompare(String(a.articlePublishedAt || a.createdAt));
      if (order === 'rank') {
        const ba = absScore((a.badges || []).find((x) => x.label === 'ABS')?.value);
        const bb = absScore((b.badges || []).find((x) => x.label === 'ABS')?.value);
        return bb - ba || da - db;
      }
      if (order === 'confidence') return (b.confidence || 0) - (a.confidence || 0);
      return da - db || String(a.deadline?.date || '9999').localeCompare(String(b.deadline?.date || '9999'));
    });
  }

  function rowHtml(i) {
    const dm = i.deadline || { label: '待核实', tone: 'muted' };
    const badges = (i.badges || []).slice(0, 3).map((b) => {
      const tone = window.RankUtils?.rankSystemTone?.(b.label, b.value) || 'gray';
      return `<span class="rank-chip rank-chip-${tone}"><b>${esc(b.label)}</b> ${esc(b.value)}</span>`;
    }).join('');
    const tags = (i.topicsZh || []).slice(0, 4).map((t) => `<span class="si-tag">${esc(t)}</span>`).join('');
    const editors = (i.guestEditors || []).length;
    const subBits = [];
    if (i.titleEn && i.titleEn !== i.titleZh) subBits.push(`<span class="si-row-en">${esc(i.titleEn)}</span>`);
    if (editors) subBits.push(`<span class="si-row-meta">${ico('users')}客座编辑 ${editors} 人</span>`);
    if (i.detailChars) subBits.push(`<span class="si-row-meta">${ico('languages')}全文翻译</span>`);
    if (i.extractedBy === 'rule') subBits.push('<span class="si-flag">规则抽取</span>');
    return `
      <article class="si-row${i.taskId ? ' is-task' : ''}" data-id="${esc(i.id)}" tabindex="0">
        <div class="si-row-journal">
          <b title="${esc(i.journal)}">${esc(i.journalShort || i.journal)}</b>
          ${i.journalShort && i.journal !== i.journalShort ? `<span>${esc(i.journal)}</span>` : ''}
        </div>
        <div class="si-row-main">
          <div class="si-row-title">${esc(i.titleZh || i.titleEn || '（未命名专刊）')}</div>
          <div class="si-row-sub">${subBits.join('<i class="si-dot"></i>') || '<span class="si-row-meta">暂无补充信息</span>'}</div>
          ${tags ? `<div class="si-row-tags">${tags}</div>` : ''}
        </div>
        <div class="si-row-side">
          <div class="si-row-badges">${badges || '<span class="rank-chip rank-chip-gray">未收录</span>'}</div>
          <span class="si-deadline is-${esc(dm.tone)}" title="${esc(fmtDate(i.deadline?.date) || '未公布截止日期')}">${ico('calendar')}${esc(dm.label)}</span>
          ${i.taskId ? `<span class="si-row-task" title="已加入任务安排">${ico('check-circle')}已加任务</span>` : ''}
        </div>
        <span class="si-row-arrow" aria-hidden="true">›</span>
      </article>`;
  }

  function renderList() {
    const el = S.root.querySelector('#siList');
    const d = S.data;
    if (!d) { el.innerHTML = ''; return; }
    const items = filtered();
    if (!items.length) {
      const hasIssues = (d.issues || []).length > 0;
      el.innerHTML = `<div class="si-empty">
        <div class="si-empty-ico">${ico(hasIssues ? 'search' : 'megaphone')}</div>
        <h3>${hasIssues ? (S.taskOnly ? '还没有加入任务的征稿' : '没有符合筛选条件的征稿') : '还没有收录到征稿信息'}</h3>
        <p>${hasIssues
          ? (S.taskOnly ? '在任意一条征稿的详情里点「加入任务」，它就会出现在这里、任务安排和首页倒计时里。' : '试试放宽截止时间或清空主题筛选。')
          : '打开微信，关注公众号「SSCI征稿」→ 打开文章 → 复制链接 → 回到这里按 Ctrl+V。也可以直接粘贴出版社的专刊页链接或整段正文。'}</p>
        <div class="si-empty-actions">
          ${hasIssues
            ? (S.taskOnly
              ? '<button class="tb-btn" id="siEmptyClear">看全部征稿</button>'
              : '<button class="tb-btn" id="siEmptyClear">清除筛选</button>')
            : `<button class="tb-btn is-primary" id="siEmptyCollect">${ico('clipboard')}<span>粘贴收稿</span></button>
               <button class="tb-btn" id="siEmptyAdd">配置自动同步</button>
               <button class="tb-btn" id="siEmptySync">立即同步</button>`}
        </div>
      </div>`;
      el.querySelector('#siEmptyClear')?.addEventListener('click', () => {
        if (S.taskOnly) { S.taskOnly = false; syncControls(); renderList(); renderToolbarState(); return; }
        S.root.querySelector('#siClear')?.click();
      });
      el.querySelector('#siEmptyCollect')?.addEventListener('click', () => openCollect());
      el.querySelector('#siEmptyAdd')?.addEventListener('click', () => openPanel('sources'));
      el.querySelector('#siEmptySync')?.addEventListener('click', () => sync());
      return;
    }
    const filteredOut = (d.issues || []).length - items.length;
    el.innerHTML = `<div class="si-list-head">
        <span>期刊 / 专刊</span><span>等级</span><span>截止</span>
      </div>
      <div class="si-list">${items.map(rowHtml).join('')}</div>
      <div class="si-list-foot">共 ${items.length} 条${filteredOut > 0 ? `（已筛掉 ${filteredOut} 条）` : ''}</div>`;

    el.querySelectorAll('.si-row').forEach((row) => {
      const open = () => openDrawer(row.dataset.id);
      row.addEventListener('click', open);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
  }

  function render() {
    renderMeta();
    renderGuide();
    renderStats();
    renderBanner();
    renderToolbarOptions();
    renderLevelRow();
    renderTopicRow();
    renderList();
    renderToolbarState();
    syncControls();
  }

  // ---------------- 动作 ----------------
  async function load() {
    try {
      const d = await api('/api/special-issues');
      S.data = d;
      if (!S.sort) S.sort = d.preferences?.sort || 'deadline';
      render();
      if (d.runtime?.running) startPolling();
    } catch (e) {
      toast(e.message || '加载失败', 'error');
    }
  }

  function startPolling() {
    if (S.pollTimer) return;
    S.pollStartedAt = Date.now();
    S.pollTimer = setInterval(async () => {
      try {
        const st = await api('/api/special-issues/status');
        if (S.data) { S.data.runtime = st.runtime || S.data.runtime; renderBanner(); }
        if (!st.runtime?.running) {
          stopPolling();
          await load();
          const res = S.data?.runtime?.lastResult;
          if (res) {
            const n = res.newIssues || 0;
            toast(n ? `处理完成，新增 ${n} 条征稿` : '处理完成，没有新的征稿信息');
          }
        }
      } catch {
        // 轮询失败不打扰用户
      }
      if (Date.now() - S.pollStartedAt > 30 * 60 * 1000) stopPolling();
    }, 2500);
  }

  function stopPolling() {
    if (S.pollTimer) clearInterval(S.pollTimer);
    S.pollTimer = null;
  }

  async function sync() {
    if (S.busy.has('sync')) return;
    if (!S.data?.summary?.enabledSources) { openPanel('sources'); return; }
    S.busy.add('sync');
    try {
      const d = await api('/api/special-issues/sync', { method: 'POST', body: {} });
      S.data = d;
      render();
      if (d.runtime?.running) startPolling();
    } catch (e) {
      toast(e.message || '同步失败', 'error');
    } finally {
      S.busy.delete('sync');
    }
  }

  async function refreshRanks() {
    if (S.busy.has('rank')) return;
    if (!S.data?.capability?.hasEasyScholarKey) { toast('先在「AI 设置」里填写 EasyScholar SecretKey', 'error'); return; }
    S.busy.add('rank');
    try {
      const d = await api('/api/special-issues/ranks/refresh', { method: 'POST', body: { limit: 25 } });
      S.data = d;
      render();
      const r = d.rankResult || {};
      toast(r.updated ? `已更新 ${r.updated} 本期刊的等级${r.remaining ? `，还有 ${r.remaining} 本待查` : ''}` : '等级已是最新');
    } catch (e) {
      toast(e.message || '刷新失败', 'error');
    } finally {
      S.busy.delete('rank');
    }
  }

  async function delIssue(id) {
    if (!window.confirm('删除这条征稿？如果已加入任务，对应任务也会一起删除。')) return;
    try {
      const d = await api(`/api/special-issues/${encodeURIComponent(id)}`, { method: 'DELETE' });
      S.data = d;
      closeDrawer();
      render();
      window.Worlex?.refreshTasks?.();
      toast('已删除');
    } catch (e) { toast(e.message || '删除失败', 'error'); }
  }

  // ---------------- 右侧详情抽屉 ----------------
  function issueOf(id) {
    return (S.data?.issues || []).find((i) => i.id === id) || null;
  }

  function openDrawer(id) {
    if (!S.root) return;
    S.drawerId = id;
    S.drawerTab = 'detail';
    S.detail = null;
    S.detailError = '';
    renderDrawer();
    loadDetail(id);
  }

  function closeDrawer() {
    S.root?.querySelector('#siDrawerMask')?.remove();
    S.drawerId = '';
    S.detail = null;
    S.detailError = '';
    S.ideasBusy = false;
    S.translateBusy = false;
  }

  async function loadDetail(id) {
    if (!id) return;
    S.detailLoading = true;
    renderDrawerBody();
    try {
      const d = await api(`/api/special-issues/${encodeURIComponent(id)}`);
      if (S.drawerId !== id) return;
      S.detail = d;
      S.detailError = '';
    } catch (e) {
      if (S.drawerId !== id) return;
      S.detailError = e.message || '加载详情失败';
    } finally {
      S.detailLoading = false;
      if (S.drawerId === id) renderDrawerBody();
    }
  }

  function renderDrawer() {
    if (!S.root) return;
    S.root.querySelector('#siDrawerMask')?.remove();
    if (!S.drawerId) return;
    const base = issueOf(S.drawerId);
    if (!base) return;
    const dm = base.deadline || { label: '待核实', tone: 'muted' };
    const badges = (base.badges || []).slice(0, 5).map((b) => {
      const tone = window.RankUtils?.rankSystemTone?.(b.label, b.value) || 'gray';
      return `<span class="rank-chip rank-chip-${tone}"><b>${esc(b.label)}</b> ${esc(b.value)}</span>`;
    }).join('');
    const siUrl = safeUrl(base.siUrl);
    const submitUrl = safeUrl(base.submitUrl);
    const articleUrl = safeUrl(base.articleUrl);

    const mask = document.createElement('div');
    mask.id = 'siDrawerMask';
    mask.className = 'si-drawer-mask';
    mask.innerHTML = `<aside class="si-drawer" role="dialog" aria-modal="true" aria-label="征稿详情">
      <header class="si-drawer-head">
        <div class="si-drawer-kicker">${esc(base.journalShort || base.journal || '')}</div>
        <h3>${esc(base.titleZh || base.titleEn || '（未命名专刊）')}</h3>
        ${base.titleEn && base.titleEn !== base.titleZh ? `<p class="si-drawer-en">${esc(base.titleEn)}</p>` : ''}
        <div class="si-drawer-badges">
          ${badges || '<span class="rank-chip rank-chip-gray">未收录分区</span>'}
          <span class="si-deadline is-${esc(dm.tone)}">${ico('calendar')}${esc(dm.label)}${dm.date ? ` · ${esc(dm.date)}` : ''}</span>
        </div>
        <button class="si-drawer-close" id="siDrawerClose" title="关闭">${ico('x')}</button>
      </header>
      <div class="si-drawer-tabs">
        <button data-dtab="detail" class="${S.drawerTab === 'detail' ? 'active' : ''}">详情与全文翻译</button>
        <button data-dtab="ideas" class="${S.drawerTab === 'ideas' ? 'active' : ''}">相关灵感${(S.detail?.ideaMatches || base.ideaMatches || []).length ? ` ${(S.detail?.ideaMatches || base.ideaMatches || []).length}` : ''}</button>
      </div>
      <div class="si-drawer-body" id="siDrawerBody"></div>
      <footer class="si-drawer-foot">
        <button class="tb-btn ${base.taskId ? '' : 'is-primary'}" id="siTaskBtn"${S.taskBusy ? ' disabled' : ''}>
          ${ico(base.taskId ? 'check-circle' : 'tasks')}<span>${base.taskId ? '已加入任务' : '加入任务'}</span>
        </button>
        ${base.taskId ? `<button class="si-link-btn" id="siTaskRemove">移出任务</button>` : ''}
        ${articleUrl ? `<a class="si-act" href="${esc(articleUrl)}" target="_blank" rel="noopener">${ico('external')}原文</a>` : ''}
        ${siUrl ? `<a class="si-act" href="${esc(siUrl)}" target="_blank" rel="noopener">${ico('link')}专刊页</a>` : ''}
        ${submitUrl ? `<a class="si-act is-primary" href="${esc(submitUrl)}" target="_blank" rel="noopener">${ico('send')}投稿</a>` : ''}
        <button class="si-icon-btn si-drawer-del" id="siIssueDel" title="删除这条征稿">${ico('trash')}</button>
      </footer>
    </aside>`;
    S.root.appendChild(mask);
    // 只有点遮罩才关；点抽屉内部不关
    mask.addEventListener('click', (e) => { if (e.target === mask) closeDrawer(); });
    mask.querySelector('#siDrawerClose').addEventListener('click', closeDrawer);
    mask.querySelectorAll('[data-dtab]').forEach((b) => b.addEventListener('click', () => {
      S.drawerTab = b.dataset.dtab;
      renderDrawer();
    }));
    mask.querySelector('#siTaskBtn').addEventListener('click', () => (base.taskId ? toast('已经加过这条任务，可在「任务安排」里查看') : addTask(base.id)));
    mask.querySelector('#siTaskRemove')?.addEventListener('click', () => removeTask(base.id));
    mask.querySelector('#siIssueDel').addEventListener('click', () => delIssue(base.id));
    renderDrawerBody();
    // 抽屉从右侧滑入时把焦点放到关闭按钮上，Esc 可关
    setTimeout(() => mask.querySelector('#siDrawerClose')?.focus(), 30);
  }

  function renderDrawerBody() {
    const body = S.root?.querySelector('#siDrawerBody');
    if (!body) return;
    const base = issueOf(S.drawerId);
    if (!base) { body.innerHTML = ''; return; }
    if (S.detailError) {
      body.innerHTML = `<div class="si-drawer-error">${ico('alert')}<span>${esc(S.detailError)}</span>
        <button class="tb-btn" id="siDetailRetry">重试</button></div>`;
      body.querySelector('#siDetailRetry')?.addEventListener('click', () => loadDetail(S.drawerId));
      return;
    }
    if (S.drawerTab === 'ideas') { body.innerHTML = ideasHtml(); bindIdeas(body); return; }
    if (S.detailLoading && !S.detail) {
      body.innerHTML = `<div class="si-drawer-loading">${ico('loader', 'is-spin')}<span>正在读取详情…</span></div>`;
      return;
    }
    const issue = S.detail?.issue || base;
    const article = S.detail?.article || null;
    const editors = issue.guestEditors || [];
    const facts = [
      ['截稿日期', issue.deadline?.date ? `${issue.deadline.date}（${issue.deadline.label}）` : '未公布'],
      ['开放投稿', fmtDate(issue.openDate) || '未公布'],
      ['出版商', issue.publisher || '—'],
      ['客座编辑', editors.length ? editors.map((e) => `${e.name}${e.affiliation ? '（' + e.affiliation + '）' : ''}`).join('、') : '未列出'],
    ];
    const tags = (issue.topicsZh || []).map((t) => `<span class="si-tag">${esc(t)}</span>`).join('');
    const detail = String(issue.detailZh || '').trim();

    body.innerHTML = `
      <section class="si-detail-facts">
        ${facts.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}
      </section>
      ${tags ? `<section class="si-detail-sec"><h4>主题</h4><div class="si-detail-tags">${tags}</div></section>` : ''}
      <section class="si-detail-sec">
        <h4>全文翻译${detail ? `<button class="si-link-btn" id="siRetranslate"${S.translateBusy ? ' disabled' : ''}>${S.translateBusy ? '翻译中…' : '重新翻译'}</button>` : ''}</h4>
        ${detail
          ? `<div class="si-detail-full">${paragraphs(detail)}</div>`
          : `<div class="si-detail-missing">
              <p>${issue.extractedBy === 'rule' ? '这条是规则抽取的，没有经过模型，所以没有全文翻译。' : '这条征稿还只有一句话摘要（旧版本生成的卡片）。'}</p>
              <button class="tb-btn" id="siTranslateBtn"${S.translateBusy ? ' disabled' : ''}>${ico('languages')}<span>${S.translateBusy ? '翻译中…' : '生成全文翻译'}</span></button>
            </div>`}
      </section>
      ${issue.submissionNote ? `<section class="si-detail-sec"><h4>投稿提示</h4><p class="si-detail-note">${esc(issue.submissionNote)}</p></section>` : ''}
      <section class="si-detail-sec">
        <h4>来源</h4>
        <p class="si-detail-note">
          ${article?.url ? `<a href="${esc(safeUrl(article.url))}" target="_blank" rel="noopener">${esc(article.title || article.url)}</a>` : esc(issue.articleTitle || '手动添加')}
          ${issue.articlePublishedAt ? ` · ${esc(issue.articlePublishedAt)}` : ''}
          ${article?.sourceName || issue.sourceName ? ` · ${esc(article?.sourceName || issue.sourceName)}` : ''}
        </p>
      </section>`;

    body.querySelector('#siTranslateBtn')?.addEventListener('click', () => translateDetail(issue.id));
    body.querySelector('#siRetranslate')?.addEventListener('click', () => translateDetail(issue.id));
  }

  /** 译文按段渲染：空行分段，行内不加格式，避免模型输出里的符号被当成 HTML。 */
  function paragraphs(text) {
    return String(text || '')
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `<p>${esc(line)}</p>`)
      .join('');
  }

  async function addTask(id) {
    if (S.taskBusy) return;
    S.taskBusy = true;
    renderDrawer();
    try {
      const d = await api(`/api/special-issues/${encodeURIComponent(id)}/task`, { method: 'POST', body: {} });
      S.data = d;
      // 先刷列表和统计再拉详情：加入任务后用户马上要看到「已加任务」和最近截止，
      // 不该等详情那一次请求回来才更新。
      renderList();
      renderStats();
      S.taskBusy = false;
      renderDrawer();
      await loadDetail(id);
      window.Worlex?.refreshTasks?.();
      const t = d.task;
      toast(t?.due ? `已加入任务安排，截止 ${t.due}` : '已加入任务安排');
    } catch (e) {
      S.taskBusy = false;
      renderDrawer();
      toast(e.message || '加入任务失败', 'error');
    }
  }

  async function removeTask(id) {
    if (S.taskBusy) return;
    S.taskBusy = true;
    try {
      const d = await api(`/api/special-issues/${encodeURIComponent(id)}/task`, { method: 'DELETE' });
      S.data = d;
      renderList();
      renderStats();
      S.taskBusy = false;
      renderDrawer();
      await loadDetail(id);
      window.Worlex?.refreshTasks?.();
      toast('已移出任务');
    } catch (e) {
      S.taskBusy = false;
      renderDrawer();
      toast(e.message || '移出任务失败', 'error');
    }
  }

  async function translateDetail(id) {
    if (S.translateBusy) return;
    S.translateBusy = true;
    renderDrawerBody();
    try {
      await api(`/api/special-issues/${encodeURIComponent(id)}/translate`, { method: 'POST', body: {} });
      await loadDetail(id);
      S.translateBusy = false;
      renderDrawer();
      renderList();
      toast('全文翻译已生成');
    } catch (e) {
      S.translateBusy = false;
      renderDrawerBody();
      toast(e.message || '翻译失败', 'error');
    }
  }

  // ---------------- 相关灵感（大模型梳理） ----------------
  function ideasHtml() {
    const matches = S.detail?.ideaMatches || issueOf(S.drawerId)?.ideaMatches || [];
    const list = matches.length ? matches.map((m) => `
      <article class="si-idea">
        <div class="si-idea-head">
          <b>${esc(m.title)}</b>
          <span class="si-idea-score" title="模型给出的契合度">${esc(m.score)}<i>分</i></span>
        </div>
        ${m.reason ? `<p class="si-idea-line"><b>为什么贴合</b>${esc(m.reason)}</p>` : ''}
        ${m.angle ? `<p class="si-idea-line"><b>可以怎么写</b>${esc(m.angle)}</p>` : ''}
        ${(m.tags || []).length ? `<div class="si-row-tags">${m.tags.map((t) => `<span class="si-tag">${esc(t)}</span>`).join('')}</div>` : ''}
        <div class="si-idea-foot">
          <button class="si-link-btn" data-openidea="${esc(m.ideaId)}">在灵感孵化里打开 →</button>
        </div>
      </article>`).join('') : '';
    return `
      <section class="si-detail-sec">
        <h4>把「灵感孵化」里的想法对到这个专刊</h4>
        <p class="si-hint">模型会读一遍你记录的想法，挑出和这个专刊征稿方向真正贴合的，并说明可以怎么写。
          只做匹配，不会改动灵感内容。</p>
        <button class="tb-btn is-primary" id="siMatchIdeas"${S.ideasBusy ? ' disabled' : ''}>
          ${ico('sparkles')}<span>${S.ideasBusy ? '正在梳理…' : matches.length ? '重新梳理' : '让模型梳理相关灵感'}</span>
        </button>
      </section>
      ${matches.length
        ? `<section class="si-detail-sec"><h4>匹配到 ${matches.length} 条灵感</h4><div class="si-idea-list">${list}</div></section>`
        : `<section class="si-detail-sec"><p class="si-hint">还没有梳理过。点上面的按钮，让模型从你的灵感里找找这个专刊能写什么。</p></section>`}`;
  }

  function bindIdeas(body) {
    body.querySelector('#siMatchIdeas')?.addEventListener('click', () => matchIdeas(S.drawerId));
    body.querySelectorAll('[data-openidea]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.openidea;
        // 抽屉会被切走的视图收掉，所以先关再跳
        closeDrawer();
        if (window.Worlex?.openIdea) window.Worlex.openIdea(id);
        else toast('已经关联到这条灵感，可在「灵感孵化」里查看');
      });
    });
  }

  async function matchIdeas(id) {
    if (S.ideasBusy || !id) return;
    S.ideasBusy = true;
    renderDrawerBody();
    try {
      const d = await api(`/api/special-issues/${encodeURIComponent(id)}/ideas`, { method: 'POST', body: {} });
      S.ideasBusy = false;
      if (S.detail) S.detail.ideaMatches = d.ideaMatches || [];
      // 列表数据也同步一份，切页签时不会闪回旧结果
      const issue = issueOf(id);
      if (issue) issue.ideaMatches = d.ideaMatches || [];
      renderDrawer();
      const n = (d.ideaMatches || []).length;
      toast(d.message || (n ? `梳理出 ${n} 条相关灵感` : '没有找到足够贴合的灵感'));
    } catch (e) {
      S.ideasBusy = false;
      renderDrawerBody();
      toast(e.message || '梳理失败', 'error');
    }
  }

  // ---------------- 粘贴收稿（公众号 / 官网 / 正文） ----------------
  // 公众号「文章列表」没有免登录的免费获取方式（原因见 src/siSources.js 顶部），
  // 所以把「复制 / 粘贴」做成最小的显式动作，其余全自动化。
  const WX_LINK_RE = /https?:\/\/mp\.weixin\.qq\.com\/s[/?][^\s"'<>（）()，。、；;]*/gi;
  const ANY_LINK_RE = /https?:\/\/[^\s<>"'（）()，。、；;]+/gi;

  function linkKey(url) {
    try {
      const u = new URL(url);
      const sn = u.searchParams.get('sn');
      if (sn) return 'sn:' + sn;
      const biz = u.searchParams.get('__biz');
      const mid = u.searchParams.get('mid') || u.searchParams.get('appmsgid');
      if (biz && mid) return `wx:${biz}:${mid}:${u.searchParams.get('idx') || '1'}`;
      const short = /^\/s\/([A-Za-z0-9_-]{4,})$/.exec(u.pathname);
      if (short) return 'p:' + short[1];
      return u.href.replace(/\/$/, '');
    } catch { return String(url || ''); }
  }

  /** 从任意文本里挑出链接并去重（微信分享文案、一行一个、混排都能处理）。 */
  function pickedLinks(text) {
    const found = String(text || '').match(ANY_LINK_RE) || [];
    const seen = new Set();
    const out = [];
    for (let url of found) {
      url = url.replace(/[)）\]】,，。.;；]+$/, '');
      if (!/^https?:/i.test(url)) continue;
      const key = linkKey(url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(url);
    }
    return out;
  }

  const isWx = (url) => /(^|\.)mp\.weixin\.qq\.com$/i.test((() => { try { return new URL(url).hostname; } catch { return ''; } })()) && /^\/s\/?/.test((() => { try { return new URL(url).pathname; } catch { return ''; } })());

  /** 与后端同一套判断：正文够长时只按正文收，避免和链接重复出卡。 */
  function analyzePaste(text) {
    const links = pickedLinks(text);
    const stripped = String(text || '')
      .replace(ANY_LINK_RE, '\n')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length >= 2)
      .filter((l) => !/^(复制链接|阅读原文|点击.{0,8}关注|长按.{0,8}二维码|扫码|分享|在看|点赞|写留言)/.test(l))
      .join('\n')
      .trim();
    const rich = stripped.length >= 400 && /(专刊|特刊|征稿|截稿|客座编辑|call\s+for\s+(?:papers|paper)|special\s+issue)/i.test(stripped);
    return {
      wechat: rich ? [] : links.filter(isWx),
      pages: rich ? [] : links.filter((u) => !isWx(u)),
      text: rich ? stripped : '',
      chars: stripped.length,
    };
  }

  function openCollect(prefill = '') {
    if (!S.root) return;
    closeCollect();
    const mask = document.createElement('div');
    mask.id = 'siCollectMask';
    mask.className = 'si-mask';
    mask.innerHTML = `<div class="si-panel si-collect" role="dialog" aria-modal="true">
      <div class="si-panel-head">
        <h3>粘贴收稿</h3>
        <button class="si-icon-btn" id="siCollectClose" title="关闭">${ico('x')}</button>
      </div>
      <div class="si-panel-body">
        <p class="si-hint">支持三种内容，混在一起贴也行：
          <b>公众号文章链接</b>、<b>出版社专刊页链接</b>、<b>整段征稿正文</b>（400 字以上会自动当正文处理）。</p>
        <textarea class="si-input si-textarea si-collect-input" id="siCollectText" rows="8"
          placeholder="https://mp.weixin.qq.com/s/...&#10;或 https://www.sciencedirect.com/special-issue/...&#10;或直接把征稿正文粘进来">${esc(prefill)}</textarea>
        <div class="si-collect-count" id="siCollectCount">还没有识别到内容</div>
        <div class="si-panel-actions">
          <button class="tb-btn" id="siCollectPaste">${ico('clipboard')}<span>从剪贴板读取</span></button>
          <button class="tb-btn is-primary" id="siCollectGo">${ico('play')}<span>开始整理</span></button>
        </div>
        <p class="si-hint si-collect-note">每条要过一次大模型（约 10–40 秒，全文翻译比摘要慢），进度显示在顶部横幅；可以先关掉窗口去干别的，不会丢。</p>
      </div>
    </div>`;
    S.root.appendChild(mask);

    const q = (sel) => mask.querySelector(sel);
    const input = q('#siCollectText');
    const countEl = q('#siCollectCount');

    const refreshCount = () => {
      const a = analyzePaste(input.value);
      const bits = [];
      if (a.wechat.length) bits.push(`${a.wechat.length} 篇公众号文章`);
      if (a.pages.length) bits.push(`${a.pages.length} 个网页链接`);
      if (a.text) bits.push(`1 段正文（${a.chars} 字）`);
      countEl.textContent = bits.length ? `识别到 ${bits.join('、')}` : '还没有识别到内容';
      countEl.classList.toggle('is-ready', bits.length > 0);
      q('#siCollectGo').disabled = bits.length === 0;
    };

    mask.addEventListener('click', (e) => { if (e.target === mask) closeCollect(); });
    q('#siCollectClose').addEventListener('click', closeCollect);
    input.addEventListener('input', refreshCount);
    input.addEventListener('paste', () => setTimeout(refreshCount, 0));

    q('#siCollectPaste').addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (!text) { toast('剪贴板是空的', 'error'); return; }
        input.value = [input.value, text].filter(Boolean).join('\n');
        refreshCount();
      } catch {
        toast('读不到剪贴板，直接在这里按 Ctrl+V 就行', 'error');
      }
    });

    q('#siCollectGo').addEventListener('click', () => submitCollect(input.value, q('#siCollectGo')));

    refreshCount();
    setTimeout(() => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }, 30);
  }

  function closeCollect() {
    S.root?.querySelector('#siCollectMask')?.remove();
  }

  async function submitCollect(text, btn) {
    if (!text || !String(text).trim()) return;
    if (btn) btn.disabled = true;
    try {
      const d = await api('/api/special-issues/collect', { method: 'POST', body: { text } });
      closeCollect();
      S.data = d;
      render();
      if (!d.started) {
        toast(d.existing ? `这些内容之前已经收过了（${d.existing} 条）` : '没有需要处理的新内容');
        return;
      }
      startPolling();
      const c = d.counted || {};
      const bits = [];
      if (c.wechat) bits.push(`${c.wechat} 篇公众号文章`);
      if (c.page) bits.push(`${c.page} 个网页`);
      if (c.text) bits.push('1 段正文');
      const extra = d.dropped ? `，超出上限的 ${d.dropped} 条没处理，可以下批再贴` : '';
      toast(`已收下 ${bits.join('、') || d.queued + ' 条'}，正在整理${extra}`);
    } catch (e) {
      toast(e.message || '收稿失败', 'error');
      if (btn) btn.disabled = false;
    }
  }

  /** 粘在页面任意空白处就自动识别：省掉「先点按钮再粘贴」这一步。 */
  function bindGlobalPaste() {
    if (S.pasteHandler) return;
    S.pasteHandler = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const text = e.clipboardData?.getData('text') || '';
      const a = analyzePaste(text);
      // 链接或整段正文都算有效粘贴；顺手粘的一大段普通文字不弹窗
      if (!a.wechat.length && !a.pages.length && !a.text) return;
      e.preventDefault();
      openCollect(text);
    };
    document.addEventListener('paste', S.pasteHandler);
  }

  function unbindGlobalPaste() {
    if (!S.pasteHandler) return;
    document.removeEventListener('paste', S.pasteHandler);
    S.pasteHandler = null;
  }

  // ---------------- 设置面板 ----------------
  function openPanel(kind) {
    S.panel = kind || 'sources';
    S.panelTab = kind === 'diagnostics' ? 'diagnostics' : kind === 'preferences' ? 'preferences' : 'sources';
    renderPanel();
  }

  function closePanel() {
    S.root?.querySelector('#siPanelMask')?.remove();
    S.panel = '';
  }

  function renderPanel() {
    if (!S.root) return;
    S.root.querySelector('#siPanelMask')?.remove();
    if (!S.panel) return;
    const mask = document.createElement('div');
    mask.id = 'siPanelMask';
    mask.className = 'si-mask';
    mask.innerHTML = `<div class="si-panel" role="dialog" aria-modal="true">
      <div class="si-panel-head">
        <div class="si-panel-tabs">
          <button data-tab="sources" class="${S.panelTab === 'sources' ? 'active' : ''}">文章源</button>
          <button data-tab="diagnostics" class="${S.panelTab === 'diagnostics' ? 'active' : ''}">诊断</button>
          <button data-tab="preferences" class="${S.panelTab === 'preferences' ? 'active' : ''}">偏好</button>
        </div>
        <button class="si-icon-btn" id="siPanelClose" title="关闭">${ico('x')}</button>
      </div>
      <div class="si-panel-body" id="siPanelBody"></div>
    </div>`;
    S.root.appendChild(mask);
    mask.addEventListener('click', (e) => { if (e.target === mask) closePanel(); });
    mask.querySelector('#siPanelClose').addEventListener('click', closePanel);
    mask.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
      S.panelTab = b.dataset.tab;
      renderPanel();
    }));
    const body = mask.querySelector('#siPanelBody');
    body.innerHTML = S.panelTab === 'sources' ? sourcesPanelHtml()
      : S.panelTab === 'diagnostics' ? diagnosticsPanelHtml()
        : preferencesPanelHtml();
    bindPanel(mask);
  }

  function sourcesPanelHtml() {
    const d = S.data;
    const types = d?.sourceTypes || [];
    const current = types.find((t) => t.type === S.draft.type) || types[0] || {};
    const list = (d?.sources || []).map((s) => `
      <div class="si-source" data-sid="${esc(s.id)}">
        <div class="si-source-main">
          <div class="si-source-title">
            <b>${esc(s.name)}</b>
            <span class="si-source-type">${esc((types.find((t) => t.type === s.type) || {}).label || s.type)}</span>
            ${s.enabled ? '' : '<span class="si-flag">已停用</span>'}
          </div>
          <div class="si-source-target" title="${esc(s.target)}">${esc(s.target)}</div>
          <div class="si-source-meta">
            ${s.lastFetchAt ? `上次拉取 ${esc(fmtTime(s.lastFetchAt))} · ${s.lastCount || 0} 篇` : '尚未拉取'}
            ${s.lastError ? ` · <span class="si-err">${esc(s.lastError)}</span>` : ''}
          </div>
        </div>
        <div class="si-source-actions">
          <label class="si-switch"><input type="checkbox" data-src-toggle ${s.enabled ? 'checked' : ''} /><span>启用</span></label>
          <button class="si-icon-btn" data-src-del title="删除">${ico('trash')}</button>
        </div>
      </div>`).join('');

    const targetLabel = S.draft.type === 'folder' ? '目录路径' : S.draft.type === 'links' ? '文章链接' : '地址';
    const placeholder = S.draft.type === 'folder'
      ? 'D:\\wechat\\SSCI征稿'
      : S.draft.type === 'links' ? '一行一个：https://mp.weixin.qq.com/s/...' : 'https://...';
    const targetField = S.draft.type === 'links'
      ? `<textarea class="si-input si-textarea" id="siDraftTarget" rows="4" placeholder="${esc(placeholder)}">${esc(S.draft.target)}</textarea>`
      : `<input class="si-input" id="siDraftTarget" placeholder="${esc(placeholder)}" value="${esc(S.draft.target)}" />`;

    return `
      <div class="si-panel-sec">
        <h4>已配置的来源</h4>
        ${list || '<p class="si-hint">还没有来源。日常用「粘贴收稿」就够了，这里只用于配置每日自动拉取。</p>'}
      </div>
      <div class="si-panel-sec">
        <h4>添加来源</h4>
        <div class="si-field">
          <label class="si-label">类型</label>
          <select class="si-select" id="siDraftType">
            ${types.map((t) => `<option value="${esc(t.type)}"${t.type === S.draft.type ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}
          </select>
        </div>
        <p class="si-hint">${esc(current.hint || '')}</p>
        <div class="si-field"><label class="si-label">名称</label>
          <input class="si-input" id="siDraftName" placeholder="例如 SSCI征稿" value="${esc(S.draft.name)}" /></div>
        <div class="si-field"><label class="si-label">${esc(targetLabel)}</label>${targetField}</div>
        <div class="si-field"><label class="si-label">首次回溯</label>
          <select class="si-select" id="siDraftBackfill">
            ${[30, 60, 90, 180, 365].map((n) => `<option value="${n}"${Number(S.draft.backfillDays) === n ? ' selected' : ''}>最近 ${n} 天</option>`).join('')}
          </select>
        </div>
        <div class="si-panel-actions">
          <button class="tb-btn" id="siDraftAdd">${ico('plus')}<span>添加并拉取</span></button>
        </div>
      </div>
      <div class="si-panel-sec si-panel-note">
        <h4>关于「文章源」</h4>
        <p class="si-hint">微信目前<b>没有免登录、免费列出某个号全部历史文章的办法</b>。所以默认走「粘贴收稿」，另外两种留给愿意一次性多花点时间的人。</p>
        <ul class="si-hint-list">
          <li><b>粘贴收稿（零配置，默认）</b>：在微信里逐篇复制链接 → 打开本页按 Ctrl+V；官网专刊页链接、整段正文同样能收。</li>
          <li><b>RSS 订阅地址</b>：配一次就全自动，适合要回溯大量历史文章。可接自建的 wechat-mp-tools（有 Windows 免安装包，<b>不需要 Docker</b>，但要用自己的公众号账号扫码登录）。</li>
          <li><b>本地导出目录</b>：用导出工具把文章存成 md / html，填目录路径；不依赖任何接口。</li>
        </ul>
      </div>`;
  }

  function diagnosticsPanelHtml() {
    const d = S.data;
    if (!d) return '<p class="si-hint">加载中…</p>';
    const st = d.articleStats || {};
    const STATUS = { pending: '待处理', extracted: '已抽取', skipped: '非征稿', failed: '失败' };
    const rows = (st.recent || []).map((a) => `
      <div class="si-article">
        <span class="si-status is-${esc(a.status)}">${esc(STATUS[a.status] || a.status)}</span>
        <div class="si-article-main">
          <div class="si-article-title">${a.url ? `<a href="${esc(safeUrl(a.url))}" target="_blank" rel="noopener">${esc(a.title || a.url)}</a>` : esc(a.title || '（粘贴的正文）')}</div>
          <div class="si-article-meta">${esc(a.publishedAt || '日期未知')}${a.sourceName ? ' · ' + esc(a.sourceName) : ''}${a.lastError ? ` · <span class="si-err">${esc(a.lastError)}</span>` : ''}</div>
        </div>
        ${a.status === 'failed' ? `<button class="si-link-btn" data-retry="${esc(a.id)}">重试</button>` : ''}
      </div>`).join('');
    return `
      <div class="si-panel-sec">
        <h4>处理进度</h4>
        <div class="si-diag-grid">
          <div><b>${st.total || 0}</b><span>内容总数</span></div>
          <div><b>${st.pending || 0}</b><span>待处理</span></div>
          <div><b>${st.extracted || 0}</b><span>已抽取</span></div>
          <div><b>${st.skipped || 0}</b><span>非征稿</span></div>
          <div><b>${st.failed || 0}</b><span>失败</span></div>
        </div>
        <div class="si-panel-actions">
          <button class="tb-btn" id="siRetryAll">${ico('refresh')}<span>重试全部失败</span></button>
          <button class="tb-btn" id="siExtractMore">${ico('play')}<span>继续抽取待处理</span></button>
        </div>
      </div>
      <div class="si-panel-sec">
        <h4>最近内容</h4>
        ${rows || '<p class="si-hint">还没有收录内容。先「粘贴收稿」，或添加一个文章源再同步。</p>'}
      </div>
      <div class="si-panel-sec">
        <h4>能力状态</h4>
        <ul class="si-hint-list">
          <li>大模型抽取与全文翻译：<b>${d.capability?.hasModel ? '已配置' : '未配置（当前用规则抽取，无全文翻译）'}</b></li>
          <li>EasyScholar 等级：<b>${d.capability?.hasEasyScholarKey ? '已配置' : '未配置'}</b>${d.rankPending ? `，还有 ${d.rankPending} 本期刊待查询` : ''}</li>
        </ul>
      </div>`;
  }

  function preferencesPanelHtml() {
    const p = S.data?.preferences || {};
    return `
      <div class="si-panel-sec">
        <h4>每日自动同步</h4>
        <div class="si-field is-row">
          <label class="si-switch ${p.autoSync !== false ? 'is-on' : ''}"><input type="checkbox" id="siPrefAuto" ${p.autoSync !== false ? 'checked' : ''} /><span>开启</span></label>
          <select class="si-select" id="siPrefHour">
            ${Array.from({ length: 24 }, (_, h) => `<option value="${h}"${Number(p.syncHour) === h ? ' selected' : ''}>每天 ${String(h).padStart(2, '0')}:00</option>`).join('')}
          </select>
        </div>
        <p class="si-hint">仅在配置了文章源时有效：到点自动拉取新内容并抽取，只处理新文章。</p>
      </div>
      <div class="si-panel-sec">
        <h4>展示与抓取</h4>
        <label class="si-switch ${p.includeExpired ? 'is-on' : ''}"><input type="checkbox" id="siPrefExpired" ${p.includeExpired ? 'checked' : ''} /><span>显示已截止的征稿</span></label>
        <label class="si-switch ${p.showRuleExtracted !== false ? 'is-on' : ''}"><input type="checkbox" id="siPrefRule" ${p.showRuleExtracted !== false ? 'checked' : ''} /><span>显示规则抽取的卡片</span></label>
        <label class="si-switch ${p.autoRank !== false ? 'is-on' : ''}"><input type="checkbox" id="siPrefRank" ${p.autoRank !== false ? 'checked' : ''} /><span>处理后自动查期刊等级</span></label>
        <div class="si-field">
          <label class="si-label">默认回溯天数</label>
          <select class="si-select" id="siPrefBackfill">
            ${[30, 60, 90, 180, 365].map((n) => `<option value="${n}"${Number(p.backfillDays) === n ? ' selected' : ''}>最近 ${n} 天</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="si-panel-actions">
        <button class="tb-btn" id="siPrefSave">${ico('save')}<span>保存</span></button>
      </div>`;
  }

  function bindPanel(mask) {
    const q = (sel) => mask.querySelector(sel);

    mask.querySelectorAll('[data-src-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const sid = btn.closest('[data-sid]').dataset.sid;
        if (!window.confirm('删除这个文章源？已收录的卡片会保留。')) return;
        try {
          S.data = await api(`/api/special-issues/sources/${encodeURIComponent(sid)}`, { method: 'DELETE' });
          render(); renderPanel();
          toast('已删除来源');
        } catch (e) { toast(e.message || '删除失败', 'error'); }
      });
    });
    mask.querySelectorAll('[data-src-toggle]').forEach((input) => {
      input.addEventListener('change', async () => {
        const sid = input.closest('[data-sid]').dataset.sid;
        try {
          S.data = await api(`/api/special-issues/sources/${encodeURIComponent(sid)}`, { method: 'PUT', body: { enabled: input.checked } });
          render();
        } catch (e) { toast(e.message || '更新失败', 'error'); }
      });
    });

    q('#siDraftType')?.addEventListener('change', (e) => { S.draft.type = e.target.value; renderPanel(); });
    q('#siDraftName')?.addEventListener('input', (e) => { S.draft.name = e.target.value; });
    q('#siDraftTarget')?.addEventListener('input', (e) => { S.draft.target = e.target.value; });
    q('#siDraftBackfill')?.addEventListener('change', (e) => { S.draft.backfillDays = Number(e.target.value); });

    q('#siDraftAdd')?.addEventListener('click', async () => {
      const target = S.draft.target.trim();
      if (!target) { toast('请填写地址或链接', 'error'); return; }
      const btn = q('#siDraftAdd');
      btn.disabled = true;
      try {
        S.data = await api('/api/special-issues/sources', {
          method: 'POST',
          body: {
            type: S.draft.type,
            name: S.draft.name || (S.draft.type === 'rss' ? '公众号 RSS' : S.draft.type === 'folder' ? '本地导出' : '手动添加'),
            target,
            backfillDays: S.draft.backfillDays,
          },
        });
        S.draft = { type: 'rss', name: '', target: '', backfillDays: 90 };
        render();
        closePanel();
        toast('已添加来源，开始同步…');
        await sync();
      } catch (e) {
        toast(e.message || '添加失败', 'error');
        btn.disabled = false;
      }
    });

    mask.querySelectorAll('[data-retry]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          S.data = await api('/api/special-issues/step', { method: 'POST', body: { step: 'extract', articleIds: [btn.dataset.retry], limit: 1 } });
          render(); renderPanel();
          toast('已重试');
        } catch (e) { toast(e.message || '重试失败', 'error'); }
      });
    });
    q('#siRetryAll')?.addEventListener('click', async () => {
      try {
        S.data = await api('/api/special-issues/step', { method: 'POST', body: { step: 'extract', retryFailed: true, limit: 20 } });
        render(); renderPanel();
        toast('已重新处理失败内容');
      } catch (e) { toast(e.message || '重试失败', 'error'); }
    });
    q('#siExtractMore')?.addEventListener('click', async () => {
      try {
        S.data = await api('/api/special-issues/step', { method: 'POST', body: { step: 'extract', limit: 20 } });
        render(); renderPanel();
        toast('已继续处理');
      } catch (e) { toast(e.message || '处理失败', 'error'); }
    });

    q('#siPrefSave')?.addEventListener('click', async () => {
      const body = {
        autoSync: q('#siPrefAuto').checked,
        syncHour: Number(q('#siPrefHour').value),
        includeExpired: q('#siPrefExpired').checked,
        showRuleExtracted: q('#siPrefRule').checked,
        autoRank: q('#siPrefRank').checked,
        backfillDays: Number(q('#siPrefBackfill').value),
      };
      try {
        S.data = await api('/api/special-issues/preferences', { method: 'PUT', body });
        render();
        toast('已保存');
      } catch (e) { toast(e.message || '保存失败', 'error'); }
    });

    mask.querySelectorAll('.si-switch input').forEach((input) => {
      input.addEventListener('change', () => input.closest('.si-switch')?.classList.toggle('is-on', input.checked));
    });
  }

  // ---------------- 生命周期 ----------------
  const onKeydown = (e) => {
    if (e.key !== 'Escape') return;
    if (S.root?.querySelector('#siCollectMask')) { closeCollect(); return; }
    if (S.root?.querySelector('#siPanelMask')) { closePanel(); return; }
    if (S.drawerId) closeDrawer();
  };

  const SpecialIssueView = {
    async mount(container) {
      if (!container) return;
      if (S.mounted && S.container === container) { await load(); return; }
      S.container = container;
      S.mounted = true;
      container.innerHTML = '';
      buildDom(container);
      bindGlobalPaste();
      document.addEventListener('keydown', onKeydown);
      await load();
    },
    close() {
      stopPolling();
      unbindGlobalPaste();
      closeCollect();
      if (S.panel) closePanel();
      closeDrawer();
      document.removeEventListener('keydown', onKeydown);
      S.mounted = false;
      S.container = null;
      S.root = null;
      S.data = null;
    },
    refresh: load,
    /** 供首页「征稿截止」卡片跳转：视图挂载后直接打开某条征稿的详情。 */
    open(id) {
      if (!S.mounted || !S.root) return;
      if (id && issueOf(id)) openDrawer(id);
    },
  };

  if (typeof window !== 'undefined') window.SpecialIssueView = SpecialIssueView;
})();
