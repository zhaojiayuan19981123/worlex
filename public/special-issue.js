/* special-issue.js —— SI 征稿视图（独立模块，无构建、无第三方依赖）
 *
 * 约定与 knowledge-graph.js 一致：DOM 自建并挂到 app.js 传入的容器
 * (<section id="viewSpecialIssue">)，切入时 window.SpecialIssueView.mount(container)，
 * 切走时 window.SpecialIssueView.close()。
 * 数据：GET /api/special-issues（一次给全：目录 / 订阅 / SI / 等级 / 译文 / 热点 / 推荐 / 定时状态）
 *       PUT /subscriptions | /preferences | /sources
 *       POST /sync | /ranks/refresh | /:id/translate | /:id/dismiss
 * 安全：后端文本一律 esc() 后拼 HTML；外链只放行 http(s)。
 */
(() => {
  'use strict';

  const S = {
    mounted: false, container: null, root: null, data: null,
    tab: 'issues', query: '', sort: 'deadline', topic: '', favoriteOnly: false,
    journalQuery: '', category: '', busy: false, loading: false,
    expanded: new Set(), dismissed: new Set(), sourceDraft: [], overrideDraft: [],
    timer: null,
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ico = (name, cls = '') => `<svg class="ico${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const safeUrl = (u) => {
    try { const x = new URL(String(u || '')); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; }
  };
  const fmtTime = (s) => {
    if (!s) return '尚未抓取';
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return '尚未抓取';
    return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

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

  // ---------------- DOM ----------------
  function buildDom(host) {
    const root = document.createElement('div');
    root.className = 'si-root';
    root.innerHTML = `
      <div class="si-head">
        <div>
          <h2>SI 征稿</h2>
          <div class="si-meta-line" id="siMeta">${ico('clock', 'ico-sm')}<span>每日定时抓取</span></div>
        </div>
        <div class="si-head-actions">
          <button class="tb-btn" data-si-act="add">${ico('plus')}添加 SI</button>
          <button class="tb-btn" data-si-act="ranks">${ico('trophy')}期刊等级</button>
          <button class="tb-btn accent" data-si-act="sync">${ico('refresh')}立即抓取</button>
        </div>
      </div>
      <div class="si-stats" id="siStats"></div>
      <div class="si-toolbar">
        <label class="si-search-wrap">${ico('search', 'ico-sm')}<input class="si-input" id="siQuery" type="search" placeholder="搜索征稿标题 / 期刊 / 主题" autocomplete="off" aria-label="搜索征稿信息"></label>
        <select class="si-select" id="siSort" aria-label="排序方式">
          <option value="deadline">按截止日期</option>
          <option value="relevance">按相关度</option>
          <option value="latest">按最新发现</option>
        </select>
        <label class="si-switch" id="siRecommendWrap"><input type="checkbox" id="siRecommendChk">${ico('target', 'ico-sm')}<span>我的研究推荐</span></label>
        <label class="si-switch" id="siFavWrap"><input type="checkbox" id="siFavChk">${ico('star', 'ico-sm')}<span>只看收藏</span></label>
        <span class="si-matched" id="siTopicClear" hidden></span>
      </div>
      <nav class="si-tabs" id="siTabs">
        <button class="active" data-si-tab="issues">征稿</button>
        <button data-si-tab="hot">领域热点</button>
        <button data-si-tab="manage">期刊管理</button>
      </nav>
      <div id="siRecommendBox"></div>
      <div id="siBody" class="si-content"></div>
      <div id="siModal"></div>`;
    host.appendChild(root);
    S.root = root;
    S.container = host;
    return root;
  }

  function bind() {
    const root = S.root;
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('input', onInput);
    root.addEventListener('submit', (e) => {
      e.preventDefault();
      if (e.target?.id === 'siAddForm') handleAction('save-custom');
    });
  }

  // ---------------- 数据 ----------------
  async function load() {
    if (S.loading) return;
    S.loading = true;
    try {
      const params = new URLSearchParams();
      if (S.query) params.set('query', S.query);
      if (S.topic) params.set('topic', S.topic);
      if (S.sort) params.set('sort', S.sort);
      if (S.favoriteOnly) params.set('favoriteOnly', '1');
      S.data = await api('/api/special-issues' + (params.toString() ? '?' + params : ''));
      S.sourceDraft = (S.data.customSources || []).map((x) => ({ ...x }));
      S.overrideDraft = Object.entries(S.data.cfpOverrides || {}).map(([id, url]) => ({ id, url }));
      render();
    } catch (e) {
      toast(e.message || '征稿数据加载失败', 'error');
      const body = S.root?.querySelector('#siBody');
      if (body) body.innerHTML = emptyState('alert', '加载失败', e.message || '请稍后重试');
    } finally {
      S.loading = false;
    }
  }

  async function post(path, body, act) {
    if (S.busy) return null;
    S.busy = true;
    const btn = act ? S.root.querySelector(`[data-si-act="${act}"]`) : null;
    const original = btn?.innerHTML;
    if (btn) { btn.disabled = true; btn.innerHTML = `${ico('loader', 'ico-sm')}处理中`; }
    try {
      const result = await api(path, { method: 'POST', body: body || {} });
      return result;
    } catch (e) {
      toast(e.message || '操作失败', 'error');
      return null;
    } finally {
      S.busy = false;
      if (btn && original != null) { btn.disabled = false; btn.innerHTML = original; }
    }
  }

  async function put(path, body) {
    try { S.data = await api(path, { method: 'PUT', body }); render(); }
    catch (e) { toast(e.message || '保存失败', 'error'); }
  }

  // ---------------- 渲染 ----------------
  function render() {
    if (!S.root || !S.data) return;
    const d = S.data;
    renderHead(d);
    renderStats(d);
    const sort = S.root.querySelector('#siSort');
    if (sort) sort.value = S.sort;
    const rec = S.root.querySelector('#siRecommendChk');
    if (rec) rec.checked = !!d.preferences?.recommendEnabled;
    const recWrap = S.root.querySelector('#siRecommendWrap');
    if (recWrap) recWrap.classList.toggle('is-on', !!d.preferences?.recommendEnabled);
    const fav = S.root.querySelector('#siFavChk');
    if (fav) fav.checked = S.favoriteOnly;
    S.root.querySelector('#siFavWrap')?.classList.toggle('is-on', S.favoriteOnly);
    const clear = S.root.querySelector('#siTopicClear');
    if (clear) {
      clear.hidden = !S.topic;
      clear.innerHTML = S.topic ? `${ico('tag', 'ico-sm')}${esc(S.topic)} <button class="as-link" data-si-act="clear-topic">清除</button>` : '';
    }
    S.root.querySelectorAll('[data-si-tab]').forEach((b) => b.classList.toggle('active', b.dataset.siTab === S.tab));
    const recBox = S.root.querySelector('#siRecommendBox');
    if (recBox) recBox.innerHTML = renderRecommend(d);
    const body = S.root.querySelector('#siBody');
    if (!body) return;
    if (S.tab === 'issues') body.innerHTML = renderIssues(d);
    else if (S.tab === 'hot') body.innerHTML = renderHot(d);
    else body.innerHTML = renderManage(d);
    updateBadge(d);
  }

  function renderHead(d) {
    const meta = S.root.querySelector('#siMeta');
    if (!meta) return;
    const sc = d.scheduler || {};
    const auto = sc.enabled ? `每日 ${String(sc.hour ?? 8).padStart(2, '0')}:00 自动抓取` : '自动抓取未启用';
    meta.innerHTML = `${ico('clock', 'ico-sm')}<span>${esc(auto)}</span><span>·</span><span>${esc(fmtTime(d.summary?.lastSyncAt))}</span><span>·</span><span>已订阅 ${Number(d.selectedJournalIds?.length || 0)} 本</span>`;
  }

  function renderStats(d) {
    const box = S.root.querySelector('#siStats');
    if (!box) return;
    const s = d.summary || {};
    box.innerHTML = [
      ['在征 SI', s.active ?? 0, ''],
      ['30 天内截止', s.expiringSoon ?? 0, 'is-accent'],
      ['关注期刊', s.subscribed ?? 0, ''],
      ['领域热点', (d.hotTopics || []).length, ''],
    ].map(([label, value, cls]) => `<div class="si-stat ${cls}"><b>${Number(value)}</b><span>${esc(label)}</span></div>`).join('');
  }

  function emptyState(icon, title, hint, action = '') {
    return `<div class="si-empty">${ico(icon, 'ico-lg')}<p><b>${esc(title)}</b>${hint ? `<br>${esc(hint)}` : ''}</p>${action}</div>`;
  }

  function rankChips(rank, limit = 3) {
    if (!rank?.items?.length) return '';
    const tone = (label) => {
      if (window.RankUtils?.rankSystemTone) return window.RankUtils.rankSystemTone(label, '');
      if (/ABS|UTD|FT50|FMS/i.test(label)) return 'red';
      if (/中科院|新锐/i.test(label)) return 'blue';
      if (/SSCI|SCI/i.test(label)) return 'green';
      return 'gray';
    };
    return rank.items.slice(0, limit).map((x) => `<span class="rank-chip rank-chip-${tone(x.label)}">${esc(x.label)} <b>${esc(x.value)}</b></span>`).join('');
  }

  function issueCard(i, d) {
    const j = (d.catalog || []).find((x) => x.id === i.journalId);
    const rank = d.ranks?.[i.journalId];
    const tr = d.translations?.[i.id];
    const dl = i.deadline || {};
    const url = safeUrl(i.url);
    const opened = S.expanded.has(i.id);
    const rel = i.relevance || { score: 0, matched: [] };
    const chips = rankChips(rank);
    const faved = (d.favoriteIds || []).includes(i.id);
    return `<article class="si-card${faved ? ' is-favorite' : ''}" data-si-card="${esc(i.id)}">
      <div class="si-card-top">
        <span class="si-pill" title="${esc(i.journal || j?.title || '未识别期刊')}">${esc(i.journalShort || j?.shortTitle || i.journal || 'SI')}</span>
        ${chips ? `<span class="si-rank-wrap">${chips}</span>` : ''}
        <span class="si-deadline is-${esc(dl.tone || 'muted')}" title="${esc(dl.date || '')}">${ico('clock', 'ico-sm')}${esc(dl.label || (dl.date || '未公布'))}</span>
        <button class="si-fav${faved ? ' is-on' : ''}" data-si-fav="${esc(i.id)}" aria-label="${faved ? '取消收藏' : '收藏'}" title="${faved ? '取消收藏' : '收藏'}">${ico(faved ? 'star' : 'star-outline', 'ico-sm')}</button>
      </div>
      <h3>${esc(i.title || '未命名专刊')}</h3>
      ${tr?.title ? `<div class="si-title-zh">${esc(tr.title)}</div>` : ''}
      <div class="si-journal-line">${esc(i.journal || j?.title || '未识别期刊')}${i.category ? ` · ${esc(i.category)}` : ''}</div>
      <p class="si-desc${opened ? ' is-open' : ''}">${esc(i.description || '征稿页未提供主题简介，可打开原文查看。')}</p>
      ${tr?.description ? `<div class="si-desc-zh">${esc(tr.description)}</div>` : ''}
      ${(i.topics || []).length ? `<div class="si-topic-row">${i.topics.slice(0, 5).map((t) => `<button class="si-topic" data-si-topic="${esc(t)}">${esc(t)}</button>`).join('')}</div>` : ''}
      ${rel.score > 0 ? `<div class="si-matched">${ico('target', 'ico-sm')}与你的研究相关 ${Number(rel.score)} · ${esc((rel.matched || []).slice(0, 3).map((m) => m.term).join('、'))}</div>` : ''}
      <div class="si-actions">
        <button class="tb-btn" data-si-translate="${esc(i.id)}">${ico('languages')}${tr?.title || tr?.description ? '查看译文' : '一键翻译'}</button>
        <button class="tb-btn" data-si-expand="${esc(i.id)}">${opened ? '收起' : '展开'}</button>
        ${url ? `<a class="tb-btn" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${ico('external')}原文</a>` : ''}
        ${i.custom ? `<button class="tb-btn" data-si-del="${esc(i.id)}">${ico('trash')}删除</button>` : ''}
        ${dl.date ? `<span class="si-journal-line">截稿 ${esc(dl.date)}</span>` : ''}
      </div>
    </article>`;
  }

  function renderIssues(d) {
    const items = d.issues || [];
    if (!items.length) {
      if (!(d.selectedJournalIds || []).length) {
        return emptyState('megaphone', '先选择关注的 ABS 期刊', '在期刊管理里勾选方向与期刊，抓取后这里会列出征稿与截稿日期。',
          '<button class="tb-btn accent" data-si-tab="manage">选择期刊</button>');
      }
      if (!d.summary?.lastSyncAt) {
        return emptyState('refresh', '还没有征稿信息', '点「立即抓取」拉取已订阅期刊的征稿页。',
          '<button class="tb-btn accent" data-si-act="sync">立即抓取</button>');
      }
      return emptyState('search', '没有匹配的征稿', '换个关键词、清除主题筛选，或重新抓取。',
        '<button class="tb-btn" data-si-act="clear-filters">清除筛选</button>');
    }
    return `<div class="si-list">${items.map((i) => issueCard(i, d)).join('')}</div>`;
  }

  function renderRecommend(d) {
    if (!d.preferences?.recommendEnabled) return '';
    const list = (d.recommendations || []).filter((r) => !S.dismissed.has(r.id)).slice(0, 4);
    if (!list.length) return '';
    return `<div class="si-recommend">
      <div class="si-rec-head">${ico('sparkles')}<span>为你推荐</span><span class="si-rec-hint">${esc((d.profile?.topics || []).slice(0, 4).join(' · ') || '来自知识图谱')}</span></div>
      <div class="si-rec-list">${list.map((r) => `<div class="si-rec-item">
        <span class="si-rec-score">${Number(r.relevance?.score || 0)}</span>
        <a href="#siBody" data-si-jump="${esc(r.id)}" title="${esc(r.title)}">${esc(r.title)}</a>
        <button class="si-rec-close" data-si-dismiss="${esc(r.id)}" aria-label="不再推荐">${ico('x', 'ico-sm')}</button>
      </div>`).join('')}</div>
    </div>`;
  }

  function renderHot(d) {
    const topics = d.hotTopics || [];
    if (!topics.length) return emptyState('trending', '暂无领域热点', '抓取到 SI 征稿后，按主题覆盖数、涉及期刊与临近截止自动汇总。');
    const head = `<div class="si-hot-head"><b>当前领域热点</b><span>基于 ${Number(d.summary?.total || 0)} 条已抓取征稿 · 点击主题查看相关 SI</span></div>`;
    const rows = topics.map((t) => {
      const trend = t.trend === null ? '近 7 日' : t.trend > 0 ? `↑ ${t.trend}` : t.trend < 0 ? `↓ ${Math.abs(t.trend)}` : '持平';
      return `<div class="si-hot-row" data-si-hot="${esc(t.topic)}" tabindex="0" role="button">
        <div class="si-hot-name">${esc(t.topic)}<small>${Number(t.journalCount)} 本期刊 · ${Number(t.upcomingCount)} 条在征</small></div>
        <div class="si-hot-bar" aria-hidden="true"><i style="width:${Math.max(4, Number(t.share) || 0)}%"></i></div>
        <div class="si-hot-num">${Number(t.count)} 条<span class="si-trend${t.trend === 0 ? ' is-flat' : ''}">${esc(trend)}</span></div>
      </div>`;
    }).join('');
    return `${head}<div class="si-hot-list">${rows}</div>`;
  }

  function renderManage(d) {
    const selected = new Set(d.selectedJournalIds || []);
    const catalog = d.catalog || [];
    const presets = Object.entries(d.presets || {});
    const q = S.journalQuery.trim().toLowerCase();
    const filtered = catalog.filter((j) => (!S.category || j.category === S.category)
      && (!q || `${j.title} ${j.shortTitle} ${j.category} ${j.publisher}`.toLowerCase().includes(q)));
    const groups = [...new Set(filtered.map((j) => j.category))];
    const p = d.preferences || {};
    const sc = d.scheduler || {};
    return `<div class="si-manage">
      <div class="si-manage-card">
        <h3>关注期刊</h3>
        <p>已选 ${selected.size} / ${catalog.length} 本 · 勾选即时保存，每日只抓取已选期刊的征稿页</p>
        <div class="si-preset-row"><span>方向预设</span>${presets.map(([id, x]) => `<button class="si-preset" data-si-preset="${esc(id)}">${esc(x.label)}</button>`).join('')}
          <button class="si-preset secondary" data-si-act="select-all">全选</button>
          <button class="si-preset secondary" data-si-act="clear-all">清空</button></div>
        <div class="si-filter-row">
          <label class="si-search-wrap">${ico('search', 'ico-sm')}<input class="si-input" id="siJournalQuery" type="search" placeholder="搜索期刊名 / 简称 / 出版社" value="${esc(S.journalQuery)}" autocomplete="off" aria-label="搜索 ABS 期刊"></label>
          <select class="si-select" id="siCategory" aria-label="按学科筛选"><option value="">全部学科</option>${(d.categories || []).map((c) => `<option value="${esc(c)}"${S.category === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>
        </div>
        ${groups.length ? groups.map((g) => {
          const list = filtered.filter((j) => j.category === g);
          return `<section class="si-journal-group"><div class="si-group-head"><b>${esc(g)}</b><button class="as-link" data-si-category="${esc(g)}">全选此类</button></div>
            <div class="si-journal-options">${list.map((j) => `<label title="${esc(j.title)}">
              <input type="checkbox" data-si-journal="${esc(j.id)}" ${selected.has(j.id) ? 'checked' : ''}>
              <span><b>${esc(j.shortTitle)}</b><small>${esc(j.title)}</small></span>
              ${rankChips(d.ranks?.[j.id], 1) ? `<span class="si-rank-wrap">${rankChips(d.ranks[j.id], 1)}</span>` : `<span class="si-journal-line">${esc(j.publisher)}</span>`}
            </label>`).join('')}</div></section>`;
        }).join('') : emptyState('search', '没有匹配的期刊', '换个关键词或学科再试')}
      </div>
      <details class="si-manage-card">
        <summary style="cursor:pointer;font-size:14px;font-weight:700;color:var(--text)">征稿页与定时任务</summary>
        <p style="margin-top:10px">出版社改版后，可把下面任意一行换成实际的征稿页地址；抓取器对页面结构是通用的。</p>
        <div class="si-options-actions">
          <label class="si-switch${p.autoSync ? ' is-on' : ''}"><input type="checkbox" id="siAutoSync" ${p.autoSync ? 'checked' : ''}>每日自动抓取</label>
          <select class="si-select" id="siHour" aria-label="每日抓取时间">${Array.from({ length: 24 }, (_, h) => `<option value="${h}"${Number(sc.hour ?? 8) === h ? ' selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select>
          <label class="si-switch${p.aiExtract ? ' is-on' : ''}"><input type="checkbox" id="siAiExtract" ${p.aiExtract ? 'checked' : ''}>AI 辅助抽取</label>
          <select class="si-select" id="siScope" aria-label="统计范围"><option value="subscribed"${p.scope !== 'all' ? ' selected' : ''}>只看已订阅</option><option value="all"${p.scope === 'all' ? ' selected' : ''}>全部抓取结果</option></select>
          <button class="tb-btn" data-si-act="save-prefs">保存</button>
        </div>
        <h3 style="margin-top:16px">自定义征稿页</h3>
        <div id="siSources">${S.sourceDraft.map((x, idx) => `<div class="si-source-row">
          <input class="si-input" data-si-src-label="${idx}" value="${esc(x.label)}" placeholder="名称" aria-label="征稿页名称">
          <input class="si-input" data-si-src-url="${idx}" value="${esc(x.url)}" placeholder="https://…" aria-label="征稿页地址">
          <button data-si-act="del-source" data-idx="${idx}" aria-label="删除该征稿页">${ico('trash', 'ico-sm')}</button>
        </div>`).join('')}</div>
        <div class="si-options-actions"><button class="tb-btn" data-si-act="add-source">${ico('plus', 'ico-sm')}添加</button><button class="tb-btn accent" data-si-act="save-sources">保存征稿页</button></div>
        <h3 style="margin-top:16px">单刊征稿页覆盖</h3>
        <div id="siOverrides">${S.overrideDraft.map((x, idx) => `<div class="si-source-row">
          <span class="si-journal-line">${esc((catalog.find((j) => j.id === x.id) || {}).shortTitle || x.id)}</span>
          <input class="si-input" data-si-override-url="${idx}" value="${esc(x.url)}" aria-label="该期刊的征稿页地址">
          <button data-si-act="del-override" data-idx="${idx}" aria-label="删除覆盖">${ico('trash', 'ico-sm')}</button>
        </div>`).join('')}</div>
        <div class="si-source-row">
          <select class="si-select" id="siOverrideJournal" aria-label="选择期刊"><option value="">选择期刊</option>${catalog.map((j) => `<option value="${esc(j.id)}">${esc(j.shortTitle)} — ${esc(j.title)}</option>`).join('')}</select>
          <input class="si-input" id="siOverrideUrl" placeholder="https://…/call-for-papers" aria-label="征稿页地址">
          <button class="tb-btn" data-si-act="add-override">添加</button>
        </div>
      </details>
    </div>`;
  }

  function openAddModal() {
    const box = S.root?.querySelector('#siModal');
    if (!box) return;
    const catalog = S.data?.catalog || [];
    box.innerHTML = `<div class="si-modal-mask">
      <div class="si-modal" role="dialog" aria-modal="true" aria-label="添加 SI 征稿">
        <div class="si-modal-head"><b>添加 SI 征稿</b><button class="si-rec-close" data-si-act="close-modal" aria-label="关闭">${ico('x')}</button></div>
        <form id="siAddForm">
          <label>专刊标题 <i>*</i><input class="si-input" id="siAddTitle" required maxlength="240" placeholder="Special Issue: ..."></label>
          <label>期刊<select class="si-select" id="siAddJournal"><option value="">未指定 / 自动识别</option>${catalog.map((j) => `<option value="${esc(j.id)}">${esc(j.shortTitle)} — ${esc(j.title)}</option>`).join('')}</select></label>
          <label>主题简介<textarea class="si-input" id="siAddDesc" rows="3" maxlength="900" placeholder="征稿主题、投稿要求…"></textarea></label>
          <label>截止日期<input class="si-input" id="siAddDeadline" placeholder="2027-06-30 或 30 June 2027"></label>
          <label>原文链接<input class="si-input" id="siAddUrl" type="url" placeholder="https://…"></label>
          <div class="si-modal-foot"><button type="button" class="tb-btn" data-si-act="close-modal">取消</button><button type="submit" class="tb-btn accent">添加</button></div>
        </form>
      </div>
    </div>`;
    box.querySelector('#siAddTitle')?.focus();
  }

  function closeModal() {
    const box = S.root?.querySelector('#siModal');
    if (box) box.innerHTML = '';
  }

  function updateBadge(d) {
    const badge = document.getElementById('navSiBadge');
    if (!badge) return;
    const n = Number(d.summary?.expiringSoon || 0);
    badge.textContent = String(n);
    badge.classList.toggle('hidden', n <= 0);
    badge.title = `${n} 条征稿将在 30 天内截止`;
  }

  // ---------------- 交互 ----------------
  function onClick(e) {
    const t = e.target;
    if (t.classList?.contains('si-modal-mask')) { closeModal(); return; }
    const favBtn = t.closest('[data-si-fav]');
    if (favBtn) {
      const id = favBtn.dataset.siFav;
      post(`/api/special-issues/${encodeURIComponent(id)}/favorite`, {}).then((r) => {
        if (!r) return;
        S.data = r;
        toast(r.favoriteIds?.includes(id) ? '已收藏' : '已取消收藏', 'success');
        render();
      });
      return;
    }
    const delBtn = t.closest('[data-si-del]');
    if (delBtn) {
      const id = delBtn.dataset.siDel;
      if (!window.confirm('删除这条自己添加的 SI？')) return;
      api(`/api/special-issues/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((r) => {
        S.data = r; toast('已删除', 'success'); render();
      }).catch((err) => toast(err.message || '删除失败', 'error'));
      return;
    }
    const tab = t.closest('[data-si-tab]');
    if (tab) { S.tab = tab.dataset.siTab; render(); return; }
    const act = t.closest('[data-si-act]');
    if (act) { handleAction(act.dataset.siAct, act); return; }
    const preset = t.closest('[data-si-preset]');
    if (preset) {
      const ids = S.data?.presets?.[preset.dataset.siPreset]?.journalIds || [];
      put('/api/special-issues/subscriptions', { selectedJournalIds: ids });
      return;
    }
    const cat = t.closest('[data-si-category]');
    if (cat) {
      const ids = new Set(S.data?.selectedJournalIds || []);
      (S.data?.catalog || []).filter((j) => j.category === cat.dataset.siCategory).forEach((j) => ids.add(j.id));
      put('/api/special-issues/subscriptions', { selectedJournalIds: [...ids] });
      return;
    }
    const topicBtn = t.closest('[data-si-topic]');
    if (topicBtn) { S.topic = topicBtn.dataset.siTopic; S.tab = 'issues'; load(); return; }
    const hot = t.closest('[data-si-hot]');
    if (hot) { S.topic = hot.dataset.siHot; S.tab = 'issues'; load(); return; }
    const jump = t.closest('[data-si-jump]');
    if (jump) {
      const card = S.root.querySelector(`[data-si-card="${CSS.escape(jump.dataset.siJump)}"]`);
      if (card) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    const dismiss = t.closest('[data-si-dismiss]');
    if (dismiss) {
      S.dismissed.add(dismiss.dataset.siDismiss);
      post(`/api/special-issues/${encodeURIComponent(dismiss.dataset.siDismiss)}/dismiss`, {}).then(() => render());
      return;
    }
    const translate = t.closest('[data-si-translate]');
    if (translate) { translateIssue(translate.dataset.siTranslate, translate); return; }
    const expand = t.closest('[data-si-expand]');
    if (expand) {
      const id = expand.dataset.siExpand;
      if (S.expanded.has(id)) S.expanded.delete(id); else S.expanded.add(id);
      render();
    }
  }

  function onChange(e) {
    const t = e.target;
    if (t.id === 'siRecommendChk') { put('/api/special-issues/preferences', { recommendEnabled: t.checked }); return; }
    if (t.id === 'siFavChk') { S.favoriteOnly = t.checked; load(); return; }
    if (t.id === 'siSort') { S.sort = t.value; load(); return; }
    if (t.id === 'siCategory') { S.category = t.value; render(); return; }
    if (t.id === 'siAutoSync' || t.id === 'siAiExtract') { t.closest('.si-switch')?.classList.toggle('is-on', t.checked); return; }
    if (t.matches('[data-si-journal]')) {
      const ids = new Set(S.data?.selectedJournalIds || []);
      if (t.checked) ids.add(t.dataset.siJournal); else ids.delete(t.dataset.siJournal);
      put('/api/special-issues/subscriptions', { selectedJournalIds: [...ids] });
    }
  }

  function onInput(e) {
    const t = e.target;
    if (t.id === 'siQuery') {
      S.query = t.value;
      clearTimeout(S.timer);
      S.timer = setTimeout(() => load(), 260);
      return;
    }
    if (t.id === 'siJournalQuery') {
      S.journalQuery = t.value;
      clearTimeout(S.timer);
      S.timer = setTimeout(() => {
        const pos = t.selectionStart;
        render();
        const next = S.root.querySelector('#siJournalQuery');
        if (next) { next.focus(); try { next.setSelectionRange(pos, pos); } catch { /* ignore */ } }
      }, 200);
      return;
    }
    if (t.matches('[data-si-src-label]')) S.sourceDraft[Number(t.dataset.siSrcLabel)].label = t.value;
    if (t.matches('[data-si-src-url]')) S.sourceDraft[Number(t.dataset.siSrcUrl)].url = t.value;
    if (t.matches('[data-si-override-url]')) S.overrideDraft[Number(t.dataset.siOverrideUrl)].url = t.value;
  }

  function handleAction(act, node) {
    const d = S.data || {};
    if (act === 'sync') {
      post('/api/special-issues/sync', {}, 'sync').then((r) => {
        if (!r) return;
        S.data = r;
        toast(`抓取完成：新增 ${Number(r.added || 0)} 条，成功 ${Number(r.synced?.length || 0)} 个源${r.failed?.length ? `，失败 ${r.failed.length} 个` : ''}`, 'success');
        render();
      });
      return;
    }
    if (act === 'ranks') {
      post('/api/special-issues/ranks/refresh', {}, 'ranks').then((r) => {
        if (!r) return;
        S.data = r;
        toast(r.refreshed ? `已更新 ${r.refreshed} 本期刊等级` : '等级已是最新', 'success');
        render();
      });
      return;
    }
    if (act === 'select-all') { put('/api/special-issues/subscriptions', { selectedJournalIds: (d.catalog || []).map((j) => j.id) }); return; }
    if (act === 'clear-all') { put('/api/special-issues/subscriptions', { selectedJournalIds: [] }); return; }
    if (act === 'clear-topic' || act === 'clear-filters') {
      S.topic = ''; S.query = ''; S.favoriteOnly = false;
      const q = S.root.querySelector('#siQuery'); if (q) q.value = '';
      load(); return;
    }
    if (act === 'add') { openAddModal(); return; }
    if (act === 'close-modal') { closeModal(); return; }
    if (act === 'save-custom') {
      const title = (S.root.querySelector('#siAddTitle')?.value || '').trim();
      if (!title) { toast('请填写专刊标题', 'error'); return; }
      post('/api/special-issues/custom', {
        title,
        journalId: S.root.querySelector('#siAddJournal')?.value || '',
        description: S.root.querySelector('#siAddDesc')?.value || '',
        deadline: S.root.querySelector('#siAddDeadline')?.value || '',
        url: S.root.querySelector('#siAddUrl')?.value || '',
      }).then((r) => {
        if (!r) return;
        S.data = r;
        closeModal();
        toast('已添加并收藏', 'success');
        render();
      });
      return;
    }
    if (act === 'save-prefs') {
      const auto = S.root.querySelector('#siAutoSync');
      const hour = S.root.querySelector('#siHour');
      const ai = S.root.querySelector('#siAiExtract');
      const scope = S.root.querySelector('#siScope');
      put('/api/special-issues/preferences', {
        autoSync: !!auto?.checked, syncHour: Number(hour?.value ?? 8),
        aiExtract: !!ai?.checked, scope: scope?.value || 'subscribed',
      });
      toast('定时任务设置已保存', 'success');
      return;
    }
    if (act === 'add-source') { S.sourceDraft.push({ id: '', label: '', url: '' }); render(); return; }
    if (act === 'del-source') { S.sourceDraft.splice(Number(node.dataset.idx), 1); render(); return; }
    if (act === 'save-sources') {
      const valid = S.sourceDraft.filter((x) => /^https?:\/\//i.test(x.url));
      put('/api/special-issues/sources', {
        customSources: valid.map((x) => ({ id: x.id || undefined, label: x.label || '自定义征稿页', url: x.url })),
        cfpOverrides: Object.fromEntries(S.overrideDraft.filter((x) => x.id && /^https?:\/\//i.test(x.url)).map((x) => [x.id, x.url])),
      });
      toast('征稿页已保存', 'success');
      return;
    }
    if (act === 'add-override') {
      const id = S.root.querySelector('#siOverrideJournal')?.value;
      const url = (S.root.querySelector('#siOverrideUrl')?.value || '').trim();
      if (!id || !/^https?:\/\//i.test(url)) { toast('请选择期刊并填写 http(s) 征稿页地址', 'error'); return; }
      S.overrideDraft = S.overrideDraft.filter((x) => x.id !== id).concat([{ id, url }]);
      put('/api/special-issues/sources', {
        customSources: (d.customSources || []).map((x) => ({ id: x.id, label: x.label, url: x.url })),
        cfpOverrides: Object.fromEntries(S.overrideDraft.filter((x) => /^https?:\/\//i.test(x.url)).map((x) => [x.id, x.url])),
      });
      toast('已覆盖该刊征稿页', 'success');
      return;
    }
    if (act === 'del-override') {
      S.overrideDraft.splice(Number(node.dataset.idx), 1);
      put('/api/special-issues/sources', {
        customSources: (d.customSources || []).map((x) => ({ id: x.id, label: x.label, url: x.url })),
        cfpOverrides: Object.fromEntries(S.overrideDraft.filter((x) => /^https?:\/\//i.test(x.url)).map((x) => [x.id, x.url])),
      });
    }
  }

  async function translateIssue(id, button) {
    if (S.busy) return;
    const tr = S.data?.translations?.[id];
    if (tr?.title || tr?.description) { toast('已显示缓存译文', 'success'); return; }
    S.busy = true;
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `${ico('loader', 'ico-sm')}翻译中`;
    try {
      const r = await api(`/api/special-issues/${encodeURIComponent(id)}/translate`, { method: 'POST', body: {} });
      S.data.translations = { ...(S.data.translations || {}), [id]: r.translation };
      toast(r.cached ? '已显示缓存译文' : '已翻译', 'success');
      render();
    } catch (e) { toast(e.message || '翻译失败', 'error'); }
    finally {
      S.busy = false;
      const next = S.root.querySelector(`[data-si-translate="${CSS.escape(id)}"]`);
      if (next) { next.disabled = false; next.innerHTML = original; }
    }
  }

  // ---------------- 生命周期 ----------------
  function mount(container) {
    const host = container || document.getElementById('viewSpecialIssue');
    if (!host) return Promise.resolve();
    if (S.mounted && S.container === host) return load();
    if (S.mounted) close();
    buildDom(host);
    bind();
    S.mounted = true;
    return load();
  }

  function close() {
    if (S.timer) clearTimeout(S.timer);
    S.timer = null;
    S.root?.remove();
    S.root = null;
    S.container = null;
    S.mounted = false;
    S.expanded.clear();
  }

  const SpecialIssueView = { mount, refresh: load, close };
  if (typeof window !== 'undefined') window.SpecialIssueView = SpecialIssueView;
})();
