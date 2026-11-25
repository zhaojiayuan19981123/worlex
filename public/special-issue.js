/* special-issue.js —— SI 征稿视图 v2（公众号文章驱动，无构建、无第三方依赖）
 *
 * 挂载约定与 knowledge-graph.js 一致：
 *   切入  window.SpecialIssueView.mount(container)
 *   切走  window.SpecialIssueView.close()
 *
 * 数据流：
 *   GET  /api/special-issues           一次给全（卡片 / 源 / 统计 / 筛选项 / 运行态 / 定时器）
 *   POST /api/special-issues/sync      启动后台同步，立即返回；本页轮询 /status 看进度
 *   POST /api/special-issues/step      单步执行（补抽取 / 补等级 / 重试失败）
 *   POST|PUT|DELETE /api/special-issues/sources[...]   文章源管理
 *
 * 筛选在前端本地完成（一次最多 400 张卡，够快且无请求延迟），
 * 计数用的主题统计由后端给（基于全量，不受当前筛选影响）。
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
    favoriteOnly: false,
    sort: '',
    // 界面
    busy: new Set(),
    panel: '',
    panelTab: 'sources',
    draft: { type: 'rss', name: '', target: '', backfillDays: 90 },
    pollTimer: null,
    pollStartedAt: 0,
    expanded: new Set(),
    pasteHandler: null,
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

  // ---------------- DOM 骨架 ----------------
  function buildDom(host) {
    const root = document.createElement('div');
    root.className = 'si-root';
    root.innerHTML = `
      <div class="si-head">
        <div>
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
        <label class="si-switch" id="siFavSwitch"><input type="checkbox" id="siFavOnly" /><span>只看收藏</span></label>
        <button class="si-clear-btn hidden" id="siClear">清除筛选</button>
      </div>

      <div class="si-level-row hidden" id="siLevelRow"></div>
      <div class="si-topic-row hidden" id="siTopicRow"></div>

      <div id="siList"></div>
    `;
    host.appendChild(root);
    S.root = root;

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
    root.querySelector('#siFavOnly').addEventListener('change', (e) => {
      S.favoriteOnly = e.target.checked;
      root.querySelector('#siFavSwitch').classList.toggle('is-on', e.target.checked);
      renderList(); renderToolbarState();
    });
    root.querySelector('#siClear').addEventListener('click', () => {
      S.query = ''; S.deadlineWindow = 'all'; S.rankSystem = ''; S.rankLevels.clear();
      S.topics.clear(); S.favoriteOnly = false; S.sort = '';
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
    const fav = S.root.querySelector('#siFavOnly');
    if (fav) fav.checked = S.favoriteOnly;
    S.root.querySelector('#siFavSwitch')?.classList.toggle('is-on', S.favoriteOnly);
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

  function renderStats() {
    const d = S.data;
    const el = S.root.querySelector('#siStats');
    if (!d) { el.innerHTML = ''; return; }
    const s = d.summary;
    const cells = [
      { n: s.active, label: '在征专刊', accent: true },
      { n: s.urgent, label: '30 天内截止', tone: s.urgent ? 'urgent' : '' },
      { n: s.pendingArticles, label: '待处理文章', tone: s.pendingArticles ? 'soon' : '' },
      { n: s.total ? `${s.ranked}/${s.total}` : 0, label: '已查等级的卡片' },
    ];
    el.innerHTML = cells.map((c) => `<div class="si-stat${c.accent ? ' is-accent' : ''}${c.tone ? ' is-' + c.tone : ''}"><b>${esc(c.n)}</b><span>${esc(c.label)}</span></div>`).join('');
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
      if (res.added) bits.push(`新文章 ${res.added} 篇`);
      if (res.extractedArticles) bits.push(`识别 ${res.extractedArticles} 篇`);
      if (res.newIssues) bits.push(`新增 ${res.newIssues} 条征稿`);
      if (res.skipped) bits.push(`跳过 ${res.skipped} 篇（非征稿）`);
      if (res.failed) bits.push(`失败 ${res.failed} 篇`);
      if (res.ranked) bits.push(`补等级 ${res.ranked} 本`);
      const errs = (res.errors || []).slice(0, 2);
      el.innerHTML = `<div class="si-banner ${errs.length ? 'is-warn' : 'is-ok'}">${ico(errs.length ? 'alert' : 'check-circle')}
        <span>上次同步：${esc(bits.join('，') || '没有新内容')}${errs.length ? `；${esc(errs.map((e) => e.error || '').join('；'))}` : ''}</span>
        <button class="si-link-btn" id="siDiagLink">查看诊断</button></div>`;
      el.querySelector('#siDiagLink')?.addEventListener('click', () => openPanel('diagnostics'));
      return;
    }
    if (!d.summary.enabledSources) {
      el.innerHTML = `<div class="si-banner is-warn">${ico('info')}<span>不需要订阅服务也能用：在微信里复制「SSCI征稿」的文章链接，回到这里按 Ctrl+V 就收下了。</span>
        <button class="si-link-btn" id="siPasteLink">粘贴收稿</button>
        <button class="si-link-btn" id="siAddLink">配置自动同步</button></div>`;
      el.querySelector('#siPasteLink')?.addEventListener('click', () => openCollect());
      el.querySelector('#siAddLink')?.addEventListener('click', () => openPanel('sources'));
      return;
    }
    if (!d.capability.hasModel) {
      el.innerHTML = `<div class="si-banner is-warn">${ico('alert')}<span>未配置大模型，当前用规则抽取（字段较少、准确率低）。在「AI 设置」配好模型后会自动用模型抽取。</span></div>`;
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
    const active = S.query || S.deadlineWindow !== 'all' || S.rankSystem || S.topics.size || S.favoriteOnly;
    S.root.querySelector('#siClear')?.classList.toggle('hidden', !active);
  }

  // ---------------- 卡片 ----------------
  function filtered() {
    const d = S.data;
    if (!d) return [];
    const q = S.query.toLowerCase();
    const includeExpired = !!d.preferences.includeExpired;
    const favorites = new Set(d.favoriteIds || []);
    const list = d.issues.filter((i) => {
      const dm = i.deadline || { days: null };
      if (!includeExpired && dm.days !== null && dm.days < 0 && S.deadlineWindow !== 'expired') return false;
      if (S.deadlineWindow === '30' && !(dm.days !== null && dm.days >= 0 && dm.days <= 30)) return false;
      if (S.deadlineWindow === '90' && !(dm.days !== null && dm.days >= 0 && dm.days <= 90)) return false;
      if (S.deadlineWindow === 'undated' && dm.days !== null) return false;
      if (S.deadlineWindow === 'expired' && !(dm.days !== null && dm.days < 0)) return false;
      if (S.favoriteOnly && !favorites.has(i.id)) return false;
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

  function cardHtml(i) {
    const favorites = new Set(S.data?.favoriteIds || []);
    const fav = favorites.has(i.id);
    const dm = i.deadline || { label: '待核实', tone: 'muted' };
    const badges = (i.badges || []).slice(0, 4).map((b) => {
      const tone = window.RankUtils?.rankSystemTone?.(b.label, b.value) || 'gray';
      return `<span class="rank-chip rank-chip-${tone}"><b>${esc(b.label)}</b> ${esc(b.value)}</span>`;
    }).join('');
    const editors = i.guestEditors || [];
    const editorText = editors.map((e) => `${e.name}${e.affiliation ? '（' + e.affiliation + '）' : ''}`).join('、');
    const tags = (i.topicsZh || []).slice(0, 5).map((t) => `<span class="si-tag">${esc(t)}</span>`).join('');
    const siUrl = safeUrl(i.siUrl);
    const submitUrl = safeUrl(i.submitUrl);
    const articleUrl = safeUrl(i.articleUrl);
    const expanded = S.expanded.has(i.id);
    return `
      <article class="si-card${expanded ? ' is-expanded' : ''}" data-id="${esc(i.id)}">
        <div class="si-card-top">
          <div class="si-card-journal">
            <b title="${esc(i.journal)}">${esc(i.journalShort || i.journal)}</b>
            ${i.journalShort && i.journal !== i.journalShort ? `<span>${esc(i.journal)}</span>` : ''}
          </div>
          <div class="si-card-badges">${badges || '<span class="rank-chip rank-chip-gray">未收录分区</span>'}</div>
        </div>
        <h3 class="si-card-title">${esc(i.titleZh || i.titleEn || '（未命名专刊）')}</h3>
        ${i.titleEn && i.titleEn !== i.titleZh ? `<p class="si-card-title-en">${esc(i.titleEn)}</p>` : ''}
        ${i.summaryZh ? `<p class="si-card-summary">${esc(i.summaryZh)}</p>` : ''}
        ${tags ? `<div class="si-card-tags">${tags}</div>` : ''}
        ${editorText && expanded ? `<div class="si-card-extra"><b>客座编辑</b>${esc(editorText)}</div>` : ''}
        ${i.submissionNote && expanded ? `<div class="si-card-extra"><b>投稿提示</b>${esc(i.submissionNote)}</div>` : ''}
        <div class="si-card-foot">
          <span class="si-deadline is-${esc(dm.tone)}" title="${esc(fmtDate(i.deadline?.date) || '未公布截止日期')}">
            ${ico('calendar')}${esc(dm.label)}
          </span>
          ${editors.length ? `<button class="si-meta-btn" data-act="expand">${ico('users')}客座编辑 ${editors.length} 人</button>` : ''}
          ${i.extractedBy === 'rule' ? `<span class="si-flag" title="未使用大模型，字段可能不全">规则抽取</span>` : ''}
          <div class="si-card-actions">
            ${articleUrl ? `<a class="si-act" href="${esc(articleUrl)}" target="_blank" rel="noopener">${ico('external')}原文</a>` : ''}
            ${siUrl ? `<a class="si-act" href="${esc(siUrl)}" target="_blank" rel="noopener">${ico('link')}专刊页</a>` : ''}
            ${submitUrl ? `<a class="si-act is-primary" href="${esc(submitUrl)}" target="_blank" rel="noopener">${ico('send')}投稿</a>` : ''}
            <button class="si-icon-btn${fav ? ' is-on' : ''}" data-act="fav" title="${fav ? '取消收藏' : '收藏'}">${ico('star')}</button>
            <button class="si-icon-btn" data-act="del" title="删除">${ico('trash')}</button>
          </div>
        </div>
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
        <h3>${hasIssues ? '没有符合筛选条件的征稿' : '还没有收录到征稿信息'}</h3>
        <p>${hasIssues
          ? '试试放宽截止时间或清空主题筛选。'
          : d.summary.enabledSources
            ? '文章源已就绪。点「立即同步」拉取新文章；也可以在微信里复制文章链接，回到这里按 Ctrl+V 直接收稿。'
            : '最快的方式：在微信里打开「SSCI征稿」的文章 → 复制链接 → 回到这里按 Ctrl+V。不用装任何服务，也不用配 RSS。'}</p>
        <div class="si-empty-actions">
          ${hasIssues
            ? '<button class="tb-btn" id="siEmptyClear">清除筛选</button>'
            : `<button class="tb-btn is-primary" id="siEmptyCollect">${ico('clipboard')}<span>粘贴文章链接</span></button>
               <button class="tb-btn" id="siEmptyAdd">添加文章源</button>
               <button class="tb-btn" id="siEmptySync">立即同步</button>`}
        </div>
      </div>`;
      el.querySelector('#siEmptyClear')?.addEventListener('click', () => S.root.querySelector('#siClear')?.click());
      el.querySelector('#siEmptyCollect')?.addEventListener('click', () => openCollect());
      el.querySelector('#siEmptyAdd')?.addEventListener('click', () => openPanel('sources'));
      el.querySelector('#siEmptySync')?.addEventListener('click', () => sync());
      return;
    }
    const filteredOut = (d.issues || []).length - items.length;
    el.innerHTML = `<div class="si-cards">${items.map(cardHtml).join('')}</div>
      <div class="si-list-foot">共 ${items.length} 条${filteredOut > 0 ? `（已筛掉 ${filteredOut} 条）` : ''}</div>`;

    el.querySelectorAll('.si-card').forEach((card) => {
      const id = card.dataset.id;
      card.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'fav') { e.stopPropagation(); toggleFav(id); return; }
        if (act === 'del') { e.stopPropagation(); delIssue(id); return; }
        const inLink = e.target.closest('a');
        if (inLink) return;
        if (S.expanded.has(id)) S.expanded.delete(id); else S.expanded.add(id);
        renderList();
      });
    });
  }

  function render() {
    renderMeta();
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
        if (S.data) { S.data.runtime = st.runtime || S.data.runtime; renderBanner(); renderStats(); }
        if (!st.runtime?.running) {
          stopPolling();
          await load();
          const res = S.data?.runtime?.lastResult;
          if (res) {
            const n = res.newIssues || 0;
            toast(n ? `同步完成，新增 ${n} 条征稿` : '同步完成，没有新的征稿信息');
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

  async function toggleFav(id) {
    try {
      const fav = new Set(S.data?.favoriteIds || []).has(id);
      const d = await api(`/api/special-issues/${encodeURIComponent(id)}/favorite`, { method: 'POST', body: { favorite: !fav } });
      S.data = d;
      render();
    } catch (e) { toast(e.message || '操作失败', 'error'); }
  }

  async function delIssue(id) {
    if (!window.confirm('删除这条征稿？')) return;
    try {
      const d = await api(`/api/special-issues/${encodeURIComponent(id)}`, { method: 'DELETE' });
      S.data = d;
      render();
      toast('已删除');
    } catch (e) { toast(e.message || '删除失败', 'error'); }
  }

  // ---------------- 粘贴收稿（零配置主路径） ----------------
  // 公众号「文章列表」目前没有免登录的免费获取方式（原因见 src/siSources.js 顶部），
  // 所以这里把「在微信里复制链接」做成最小的显式动作，其余全自动化：
  //   复制 → 本页 Ctrl+V → 抓正文 + 大模型抽取 + 查等级 → 出卡片。
  const WX_LINK_RE = /https?:\/\/mp\.weixin\.qq\.com\/s[/?][^\s"'<>（）()，。、；;]*/gi;

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

  /** 从任意文本里挑出公众号链接并去重（微信分享文案、一行一个、混排都能处理）。 */
  function pickedLinks(text) {
    const found = String(text || '').match(WX_LINK_RE) || [];
    const seen = new Set();
    const out = [];
    for (let url of found) {
      url = url.replace(/[)）\]】,，。.;；]+$/, '');
      const key = linkKey(url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(url);
    }
    return out;
  }

  function openCollect(prefill = '') {
    if (!S.root) return;
    closeCollect();
    const mask = document.createElement('div');
    mask.id = 'siCollectMask';
    mask.className = 'si-mask';
    mask.innerHTML = `<div class="si-panel si-collect" role="dialog" aria-modal="true">
      <div class="si-panel-head">
        <h3>粘贴微信文章链接</h3>
        <button class="si-icon-btn" id="siCollectClose" title="关闭">${ico('x')}</button>
      </div>
      <div class="si-panel-body">
        <p class="si-hint">在微信里打开文章 → 右上角「…」（电脑版右键）→ <b>复制链接</b> → 回到这里按 <b>Ctrl+V</b>。
          一次一篇或多篇都行，重复链接会自动跳过。</p>
        <textarea class="si-input si-textarea si-collect-input" id="siCollectText" rows="7"
          placeholder="https://mp.weixin.qq.com/s/...">${esc(prefill)}</textarea>
        <div class="si-collect-count" id="siCollectCount">还没有识别到链接</div>
        <div class="si-panel-actions">
          <button class="tb-btn" id="siCollectPaste">${ico('clipboard')}<span>从剪贴板读取</span></button>
          <button class="tb-btn is-primary" id="siCollectGo">${ico('play')}<span>开始识别</span></button>
        </div>
        <p class="si-hint si-collect-note">每篇要过一次大模型（约 10–30 秒），进度显示在顶部横幅；可以先关掉窗口去干别的，不会丢。</p>
      </div>
    </div>`;
    S.root.appendChild(mask);

    const q = (sel) => mask.querySelector(sel);
    const input = q('#siCollectText');
    const countEl = q('#siCollectCount');

    const refreshCount = () => {
      const n = pickedLinks(input.value).length;
      countEl.textContent = n ? `识别到 ${n} 篇文章` : '还没有识别到链接';
      countEl.classList.toggle('is-ready', n > 0);
      q('#siCollectGo').disabled = n === 0;
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

    q('#siCollectGo').addEventListener('click', () => submitCollect(pickedLinks(input.value), q('#siCollectGo')));

    refreshCount();
    setTimeout(() => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }, 30);
  }

  function closeCollect() {
    S.root?.querySelector('#siCollectMask')?.remove();
  }

  async function submitCollect(urls, btn) {
    if (!urls.length) return;
    if (btn) btn.disabled = true;
    try {
      const d = await api('/api/special-issues/collect', { method: 'POST', body: { urls } });
      closeCollect();
      S.data = d;
      render();
      if (!d.started) {
        toast(d.existing ? `这 ${d.existing} 篇之前已经收过了` : '没有需要处理的新链接');
        return;
      }
      startPolling();
      const extra = d.dropped ? `，超出上限的 ${d.dropped} 条没处理，可以下批再贴` : '';
      toast(`已收下 ${d.queued} 篇文章，正在识别${extra}`);
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
      if (!pickedLinks(text).length) return;
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

  // ---------------- 面板 ----------------
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
        ${list || '<p class="si-hint">还没有来源，下面添加第一个。</p>'}
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
        <h4>怎么拿到文章列表</h4>
        <p class="si-hint">微信在 2026 年 7 月关闭了公众号后台的跨号文章搜索接口，目前<b>没有免登录、免费列出某个号全部历史文章的办法</b>。所以默认走「复制链接」，另外两种留给愿意一次性多花点时间的人。</p>
        <ul class="si-hint-list">
          <li><b>复制链接（零配置，默认）</b>：在微信里逐篇复制 → 打开 SI 页按 Ctrl+V。每天只有几篇新文章的话，十几秒就完事。</li>
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
          <div class="si-article-title">${a.url ? `<a href="${esc(safeUrl(a.url))}" target="_blank" rel="noopener">${esc(a.title || a.url)}</a>` : esc(a.title || '（未命名）')}</div>
          <div class="si-article-meta">${esc(a.publishedAt || '日期未知')}${a.sourceName ? ' · ' + esc(a.sourceName) : ''}${a.lastError ? ` · <span class="si-err">${esc(a.lastError)}</span>` : ''}</div>
        </div>
        ${a.status === 'failed' ? `<button class="si-link-btn" data-retry="${esc(a.id)}">重试</button>` : ''}
      </div>`).join('');
    return `
      <div class="si-panel-sec">
        <h4>处理进度</h4>
        <div class="si-diag-grid">
          <div><b>${st.total || 0}</b><span>文章总数</span></div>
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
        <h4>最近文章</h4>
        ${rows || '<p class="si-hint">还没有抓到文章。先添加来源并同步。</p>'}
      </div>
      <div class="si-panel-sec">
        <h4>能力状态</h4>
        <ul class="si-hint-list">
          <li>大模型抽取：<b>${d.capability?.hasModel ? '已配置' : '未配置（当前用规则抽取）'}</b></li>
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
        <p class="si-hint">到点自动拉取新文章并抽取，只处理新内容，不会重复抓已有文章。</p>
      </div>
      <div class="si-panel-sec">
        <h4>展示与抓取</h4>
        <label class="si-switch ${p.includeExpired ? 'is-on' : ''}"><input type="checkbox" id="siPrefExpired" ${p.includeExpired ? 'checked' : ''} /><span>显示已截止的征稿</span></label>
        <label class="si-switch ${p.showRuleExtracted !== false ? 'is-on' : ''}"><input type="checkbox" id="siPrefRule" ${p.showRuleExtracted !== false ? 'checked' : ''} /><span>显示规则抽取的卡片</span></label>
        <label class="si-switch ${p.autoRank !== false ? 'is-on' : ''}"><input type="checkbox" id="siPrefRank" ${p.autoRank !== false ? 'checked' : ''} /><span>同步后自动查期刊等级</span></label>
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
        toast('已重新处理失败文章');
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
  const SpecialIssueView = {
    async mount(container) {
      if (!container) return;
      if (S.mounted && S.container === container) { await load(); return; }
      S.container = container;
      S.mounted = true;
      container.innerHTML = '';
      buildDom(container);
      bindGlobalPaste();
      await load();
    },
    close() {
      stopPolling();
      unbindGlobalPaste();
      closeCollect();
      if (S.panel) closePanel();
      S.mounted = false;
      S.container = null;
      S.root = null;
      S.data = null;
      S.expanded.clear();
    },
    refresh: load,
  };

  if (typeof window !== 'undefined') window.SpecialIssueView = SpecialIssueView;
})();
