/* Fixed SSCI征稿 ingestion and local SI cards. */
(() => {
  'use strict';
  const S = { root: null, host: null, data: null, generation: 0, tab: 'issues', query: '', status: 'active', journal: '', rankSystem: '', rankValue: '', topic: '', sort: 'deadline', favoriteOnly: false, journals: new Map(), expanded: new Set(), busy: false, saving: false, prefSaving: false, prefDirty: false, loading: false, pending: false, timer: null, debounce: null, error: '', observed: false };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ico = name => `<svg class="ico" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const safeUrl = value => { try { const u = new URL(value); return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : ''; } catch { return ''; } };
  const time = value => { const d = new Date(value || ''); return Number.isNaN(d.getTime()) ? '暂无记录' : d.toLocaleString('zh-CN', { hour12: false }); };
  const toast = (text, type = '') => { if (window.Worlex?.toast) window.Worlex.toast(text, type); };
  const options = (items, selected) => items.map(([v, t]) => `<option value="${esc(v)}"${String(v) === selected ? ' selected' : ''}>${esc(t)}</option>`).join('');
  async function api(path, opts = {}) {
    const init = { ...opts };
    if (init.body !== undefined) { init.body = JSON.stringify(init.body); init.headers = { 'Content-Type': 'application/json', ...init.headers }; }
    if (window.Worlex?.api) return window.Worlex.api(path, init);
    const res = await fetch(path, init), data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
    return data;
  }
  function params() {
    const p = new URLSearchParams();
    for (const key of ['query', 'status', 'journal', 'rankSystem', 'rankValue', 'topic', 'sort']) if (S[key]) p.set(key, S[key]);
    if (S.favoriteOnly) p.set('favoriteOnly', '1');
    return p.toString();
  }
  function schedule() {
    clearTimeout(S.timer);
    if (S.root) S.timer = setTimeout(() => { if (!document.hidden) load(); else schedule(); }, S.data?.wechat?.running ? 2000 : 15000);
  }
  async function load() {
    if (!S.root) return;
    if (S.loading) { S.pending = true; return; }
    const generation = S.generation, query = params();
    S.loading = true; S.pending = false; clearTimeout(S.timer);
    try {
      const d = await api('/api/special-issues?' + query);
      if (!S.root || generation !== S.generation) return;
      if (query !== params()) { S.pending = true; return; }
      S.data = d; S.error = '';
      if (Array.isArray(d.issueJournals)) S.journals = new Map(d.issueJournals.filter(j => j?.id).map(j => [j.id, j.title || j.id]));
      else for (const i of d.issues || []) if (i.journalId) S.journals.set(i.journalId, i.journal || i.journalShort || i.journalId);
      if (d.wechat?.running) S.observed = true;
      else if (S.observed) { S.observed = false; toast(d.wechat?.lastError ? '同步结束，部分任务需处理' : '公众号同步已完成', d.wechat?.lastError ? 'error' : 'success'); }
      render();
    } catch (e) { if (S.root && generation === S.generation) { S.error = e.message || '加载失败'; renderStatus(); } }
    finally { if (generation === S.generation) { S.loading = false; if (S.pending && S.root) load(); else schedule(); } }
  }
  function build(host) {
    const root = document.createElement('div'); root.className = 'si-root';
    root.innerHTML = `<header class="si-head"><div><h2>SI 征稿</h2><div id="siMeta" class="si-meta-line">SSCI征稿 · sscizhenggao</div></div><div class="si-head-actions"><button class="tb-btn" data-si-act="add">${ico('plus')}添加 SI</button><button class="tb-btn" data-si-act="ranks">${ico('trophy')}刷新期刊等级</button><button class="tb-btn accent" data-si-act="sync">${ico('refresh')}立即同步</button></div></header>
      <div id="siStats" class="si-stats"></div><div id="siProgress" class="si-progress" role="status" aria-live="polite"></div><div id="siError" class="si-error" role="alert" hidden></div>
      <nav class="si-tabs" aria-label="征稿视图"><button data-si-tab="issues">征稿卡片</button><button data-si-tab="hot">领域热点</button><button data-si-tab="manage">公众号与同步</button></nav>
      <div id="siToolbar" class="si-toolbar"><input id="siQuery" class="si-input" type="search" aria-label="搜索征稿" placeholder="搜索征稿 / 期刊 / 主题" value="${esc(S.query)}"><select id="siStatus" class="si-select" aria-label="征稿状态"></select><select id="siJournal" class="si-select" aria-label="按期刊筛选"></select><select id="siRankSystem" class="si-select" aria-label="期刊等级体系"></select><select id="siRankValue" class="si-select" aria-label="期刊等级"></select><select id="siSort" class="si-select" aria-label="排序方式"></select><label class="si-switch"><input id="siFavChk" type="checkbox">只看收藏</label><button class="tb-btn" data-si-act="clear">清除筛选</button><span id="siTopic" class="si-topic-filter"></span></div>
      <div id="siBody" class="si-content"><div class="si-empty">正在加载公众号状态与征稿卡片…</div></div><div id="siModal"></div>`;
    host.appendChild(root); S.root = root; S.host = host;
    root.addEventListener('click', click); root.addEventListener('change', change);
    root.addEventListener('input', e => { if (e.target.id === 'siQuery') { S.query = e.target.value; clearTimeout(S.debounce); S.debounce = setTimeout(load, 280); } if (e.target.closest('#siPreferencesForm')) S.prefDirty = true; });
    root.addEventListener('submit', e => { e.preventDefault(); if (e.target.id === 'siWechatForm') saveWechat(e.target); if (e.target.id === 'siPreferencesForm') savePreferences(e.target); if (e.target.id === 'siAddForm') saveCustom(e.target); });
    root.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  }
  function empty(title, text, action = '') { return `<div class="si-empty"><b>${esc(title)}</b><p>${esc(text)}</p>${action}</div>`; }
  function report(w) {
    const b = w.backfill || {};
    return `<dl class="si-report"><div><dt>会话配置</dt><dd>${w.configured ? '已保存，有效性以实际同步为准' : '尚未配置'}</dd></div><div><dt>保存的凭据</dt><dd>Cookie ${w.hasCookie ? '已保存' : '未保存'} · Token ${w.hasToken ? '已保存' : '未单独保存'}</dd></div><div><dt>首次回溯范围</dt><dd>${b.from ? `${esc(time(b.from))} 至 ${esc(time(b.through))}` : '从首次同步日期向前回溯三个月'}</dd></div><div><dt>历史列表 / 回溯处理</dt><dd>${b.listedAt ? '已列出' : '待列出'} / ${b.completedAt ? '已完成' : '尚未完成'}</dd></div><div><dt>增量水位</dt><dd>${esc(time(w.watermark))}</dd></div><div><dt>AI / EasyScholar</dt><dd>${w.aiReady ? 'AI 已就绪' : 'AI 未就绪，请在设置中配置'} · ${w.ranksReady ? '等级服务已配置' : '等级服务未配置'}</dd></div></dl>
      ${(w.failedArticles || []).length ? `<details class="si-failures" open><summary>文章处理失败 · ${w.failedArticles.length} 篇</summary>${w.failedArticles.map(a => `<div><b>${safeUrl(a.url) ? `<a href="${esc(safeUrl(a.url))}" target="_blank" rel="noopener noreferrer">${esc(a.title || '未命名文章')}</a>` : esc(a.title || a.id)}</b><p>${esc(a.error || '待重试')} · 已尝试 ${Number(a.attempts || 0)} 次</p></div>`).join('')}</details>` : ''}
      ${(w.rankErrors || []).length ? `<details class="si-failures" open><summary>期刊等级查询未完成</summary>${w.rankErrors.map(e => `<p>${esc(typeof e === 'string' ? e : [e.journal, e.error].filter(Boolean).join('：'))}</p>`).join('')}</details>` : ''}`;
  }
  function scheduleReport() {
    const p = S.data?.preferences || {}, s = S.data?.scheduler || {}, enabled = p.autoSync !== false, zone = s.timezone || '';
    let next = '等待调度';
    if (!enabled) next = '自动同步已关闭';
    else if (s.nextRunAt) {
      const date = new Date(s.nextRunAt);
      if (!Number.isNaN(date.getTime())) {
        try { next = date.toLocaleString('zh-CN', { hour12: false, ...(zone ? { timeZone: zone } : {}) }); }
        catch { next = date.toISOString(); }
      }
    }
    return `<dl class="si-report"><div><dt>已保存的每日计划</dt><dd>${enabled ? `每天 ${String(p.syncHour ?? s.hour ?? 8).padStart(2, '0')}:00` : '已关闭'}</dd></div><div><dt>下次执行</dt><dd>${esc(next)}</dd></div><div><dt>执行时区</dt><dd>${esc(zone || '后端未提供')}</dd></div></dl>${enabled && s.ready === false ? '<p class="si-hint">会话或 AI 尚未就绪，请完成配置后同步。</p>' : ''}`;
  }
  function settings(w) {
    const p = S.data?.preferences || {}, s = S.data?.scheduler || {};
    S.prefDirty = false;
    return `<div class="si-settings"><section><h3>SSCI征稿 <small>sscizhenggao</small></h3><p>从首次同步日期向前回溯三个月，之后每日增量更新。文章经 AI 提取、翻译成中文后生成卡片，再查询 EasyScholar 期刊等级。</p><form id="siWechatForm" autocomplete="off"><fieldset id="siWechatFields">
      <label for="siHistoryUrl">微信历史消息链接</label><input id="siHistoryUrl" class="si-input" name="historyUrl" type="password" autocomplete="new-password" maxlength="12000" placeholder="${w.configured ? '已保存，留空保留；会话失效时更新' : 'https://mp.weixin.qq.com/mp/profile_ext?...'}" aria-describedby="siHistoryHint"><p id="siHistoryHint" class="si-hint">需从微信中获取 SSCI征稿 的历史消息链接，包含 action、__biz 和有效会话参数。仅公众号 ID 或单篇文章链接不足以读取历史列表。</p>
      <label for="siCookie">Cookie（留空保留）</label><input id="siCookie" class="si-input" name="cookie" type="password" autocomplete="new-password" maxlength="16000"><label class="si-switch"><input id="siClearCookie" type="checkbox">清除已保存 Cookie</label>
      <label for="siToken">appmsg_token（留空保留）</label><input id="siToken" class="si-input" name="appmsgToken" type="password" autocomplete="new-password" maxlength="4096"><label class="si-switch"><input id="siClearToken" type="checkbox">清除已保存 Token</label>
      <label for="siInterval">请求间隔（秒）</label><input id="siInterval" class="si-input si-interval" name="intervalSeconds" type="number" min="3" max="60" step="1" required value="${Number(w.intervalSeconds) || 5}"><div><button class="tb-btn accent" type="submit">保存会话设置</button></div></fieldset></form><p class="si-hint">凭据不会回填到页面。微信会话可能失效或被限制，失败后请更新会话重试。AI 处理会使用已配置模型并产生相应费用。</p><form id="siPreferencesForm" class="si-schedule-form"><h3>每日自动同步</h3><fieldset id="siPreferencesFields"><label class="si-switch"><input id="siAutoSync" name="autoSync" type="checkbox"${p.autoSync !== false ? ' checked' : ''}>启用每日自动同步</label><div class="si-schedule-row"><label for="siSyncHour">每日执行小时</label><input id="siSyncHour" class="si-input si-hour" name="syncHour" type="number" min="0" max="23" step="1" required value="${esc(p.syncHour ?? s.hour ?? 8)}" aria-describedby="siScheduleHint"><span>时</span><button class="tb-btn" type="submit">保存同步计划</button></div><p id="siScheduleHint" class="si-hint">按下方执行时区的整点运行；应用服务需保持运行。</p></fieldset></form><div id="siScheduleReport" role="status" aria-live="polite">${scheduleReport()}</div></section><section><h3>采集与处理记录</h3><div id="siReport">${report(w)}</div><button class="tb-btn" data-si-act="reload">${ico('refresh')}刷新状态</button></section></div>`;
  }
  function renderStatus() {
    if (!S.root) return;
    const w = S.data?.wechat || {}, stages = { starting: '正在启动', backfill: '从首次同步日期向前回溯三个月', incremental: '增量采集文章', processing: '提取征稿并翻译为中文', ranks: '查询卡片期刊等级', idle: '同步已结束' };
    const progress = w.stage === 'processing' ? ` · 第 ${Number(w.current || 0)} / ${Number(w.count || 0)} 篇` : ['backfill', 'incremental'].includes(w.stage) ? ` · 第 ${Number(w.pages || 0)} 页` : '';
    S.root.querySelector('#siProgress').innerHTML = `<span>${esc(w.running ? (stages[w.stage] || '正在同步') + progress : !w.configured ? '尚未配置微信会话' : w.pending ? `${Number(w.pending)} 篇文章待处理，可重新同步重试` : '每日增量同步 · 已截止的公众号征稿保留在历史记录中')}</span><button class="as-link" data-si-tab="manage">查看同步设置</button>`;
    S.root.querySelector('#siMeta').textContent = `SSCI征稿 · sscizhenggao · 上次尝试 ${time(w.lastAttemptAt)}`;
    const errors = [...new Set([S.error, w.lastError].filter(Boolean))], error = S.root.querySelector('#siError');
    error.hidden = !errors.length; error.innerHTML = errors.map(x => `<p>${esc(x)}</p>`).join('') + (S.error ? '<button class="tb-btn" data-si-act="reload">重试</button>' : '');
    const sync = S.root.querySelector('[data-si-act="sync"]'); sync.disabled = !!w.running || S.busy; sync.innerHTML = `${ico('refresh')}${w.running ? '同步中' : '立即同步'}`;
    const ranks = S.root.querySelector('[data-si-act="ranks"]'); ranks.disabled = !!w.running || S.busy; if (!S.busy) ranks.innerHTML = `${ico('trophy')}刷新期刊等级`;
    const fields = S.root.querySelector('#siWechatFields'); if (fields) fields.disabled = !!w.running || S.saving;
    const prefFields = S.root.querySelector('#siPreferencesFields');
    if (prefFields) {
      prefFields.disabled = S.prefSaving;
      if (!S.prefDirty && !S.prefSaving && !prefFields.contains(document.activeElement)) {
        S.root.querySelector('#siAutoSync').checked = S.data?.preferences?.autoSync !== false;
        S.root.querySelector('#siSyncHour').value = S.data?.preferences?.syncHour ?? S.data?.scheduler?.hour ?? 8;
      }
    }
    const sr = S.root.querySelector('#siScheduleReport'); if (sr) sr.innerHTML = scheduleReport();
    const r = S.root.querySelector('#siReport'); if (r) r.innerHTML = report(w);
  }
  function renderFilters() {
    const set = (id, values, selected) => { S.root.querySelector('#' + id).innerHTML = options(values, selected); };
    set('siStatus', [['all', '全部状态'], ['active', '在征'], ['expired', '已截止'], ['review', '待核验']], S.status);
    set('siJournal', [['', '全部期刊'], ...[...S.journals].sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'))], S.journal);
    const systems = new Map();
    for (const r of Object.values(S.data?.ranks || {})) for (const item of r.items || []) { const label = String(item.label || ''); if (!label) continue; if (!systems.has(label)) systems.set(label, new Set()); systems.get(label).add(String(item.value ?? '')); }
    if (S.rankSystem && S.rankSystem !== 'pending' && !systems.has(S.rankSystem)) systems.set(S.rankSystem, new Set());
    set('siRankSystem', [['', '全部等级体系'], ...[...systems.keys()].map(x => [x, x]), ['pending', '等级待查询']], S.rankSystem);
    const values = [...(systems.get(S.rankSystem) || [])]; if (S.rankValue && !values.includes(S.rankValue)) values.push(S.rankValue);
    set('siRankValue', [['', '全部等级'], ...values.map(x => [x, x])], S.rankValue); S.root.querySelector('#siRankValue').disabled = !S.rankSystem || S.rankSystem === 'pending';
    set('siSort', [['deadline', '按截止日期'], ['latest', '按最新发现'], ['relevance', '按研究相关度']], S.sort);
    S.root.querySelector('#siFavChk').checked = S.favoriteOnly;
    S.root.querySelector('#siTopic').innerHTML = S.topic ? `${esc(S.topic)} <button class="as-link" data-si-act="clear-topic">清除主题</button>` : '';
  }
  function card(i, d) {
    const tr = d.translations?.[i.id], title = i.source === 'wechat' ? i.title : tr?.title || i.title, original = i.titleOriginal || (tr?.title ? i.title : '');
    const dl = typeof i.deadline === 'object' && i.deadline ? i.deadline : { date: i.deadline || '' };
    const expired = (dl.days != null && dl.days < 0) || i.status === 'closed', opened = S.expanded.has(i.id), favorite = (d.favoriteIds || []).includes(i.id), review = i.needsReview || !dl.date;
    const articles = new Map();
    for (const a of i.sourceArticles || []) if (safeUrl(a.url)) articles.set(safeUrl(a.url), a);
    if (!articles.size && i.source === 'wechat' && safeUrl(i.sourceUrl)) articles.set(safeUrl(i.sourceUrl), { url: i.sourceUrl, title: 'SSCI征稿原文' });
    const rank = d.ranks?.[i.journalId], url = safeUrl(i.url);
    return `<article class="si-card${favorite ? ' is-favorite' : ''}${expired ? ' is-expired' : ''}" data-si-card="${esc(i.id)}"><div class="si-card-top"><span class="si-pill">${i.source === 'wechat' ? 'SSCI征稿' : i.custom ? '手动添加' : '历史征稿'}</span>${review ? '<span class="si-review">待核验</span>' : ''}<span class="si-deadline is-${esc(dl.tone || 'muted')}">${expired ? '已截止' : esc(dl.label || dl.date || '日期待核验')}</span><button class="si-fav${favorite ? ' is-on' : ''}" data-si-fav="${esc(i.id)}" aria-label="${favorite ? '取消收藏' : '收藏'}" aria-pressed="${favorite}" title="${favorite ? '取消收藏' : '收藏'}">${ico(favorite ? 'star' : 'star-outline')}</button></div>
      <h3 lang="zh-CN">${esc(title || '未命名专刊')}</h3>${original && original !== title ? `<div class="si-title-original">${esc(original)}</div>` : ''}<div class="si-journal-line">${esc(i.journal || '期刊待核验')}</div><div class="si-rank-wrap">${rank?.items?.length ? rank.items.map(x => `<span class="rank-chip rank-chip-gray">${esc(x.label)} <b>${esc(x.value)}</b></span>`).join('') : `<span class="si-journal-line">${rank?.queriedAt ? '已查询，未返回可识别等级' : '等级待查询'}</span>`}</div>
      <p class="si-desc${opened ? ' is-open' : ''}">${esc(tr?.description || i.description || '暂无主题简介，请查看来源文章。')}</p>${review ? '<p class="si-hint">信息尚不完整，请通过来源文章核验投稿截止日。</p>' : ''}
      ${(i.topics || []).length ? `<div class="si-topic-row">${i.topics.slice(0, opened ? undefined : 5).map(t => `<button class="si-topic" data-si-topic="${esc(t)}">${esc(t)}</button>`).join('')}</div>` : ''}
      ${articles.size ? `<div class="si-provenance"><span>来源文章 · ${articles.size} 篇</span>${[...articles].slice(0, opened ? undefined : 2).map(([u, a]) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(a.title || 'SSCI征稿原文')}</a>`).join('')}</div>` : ''}
      <div class="si-actions"><button class="tb-btn" data-si-expand="${esc(i.id)}" aria-expanded="${opened}">${opened ? '收起' : '展开'}</button>${url && !articles.has(url) ? `<a class="tb-btn" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${ico('external')}征稿链接</a>` : ''}${i.source !== 'wechat' && !tr?.title ? `<button class="tb-btn" data-si-translate="${esc(i.id)}">翻译</button>` : ''}<button class="tb-btn" data-si-del="${esc(i.id)}">${ico('trash')}删除</button>${dl.date ? `<span class="si-journal-line">截稿 ${esc(dl.date)}</span>` : ''}</div></article>`;
  }
  function render(force = false) {
    if (!S.root || !S.data) return;
    const d = S.data, w = d.wechat || {}, s = d.summary || {};
    S.root.querySelector('#siStats').innerHTML = [['在征 SI', s.active || 0], ['30 天内截止', s.expiringSoon || 0], ['公众号文章', w.totalArticles || 0], ['已处理 / 待处理', `${Number(w.processed || 0)} / ${Number(w.pending || 0)}`]].map(([t, v]) => `<div class="si-stat"><b>${esc(v)}</b><span>${esc(t)}</span></div>`).join('');
    S.root.querySelectorAll('.si-tabs [data-si-tab]').forEach(b => b.classList.toggle('active', b.dataset.siTab === S.tab));
    S.root.querySelector('#siToolbar').hidden = S.tab !== 'issues'; renderFilters();
    const body = S.root.querySelector('#siBody');
    if (S.tab === 'manage') { if (force || !body.querySelector('#siWechatForm')) body.innerHTML = settings(w); }
    else if (S.tab === 'hot') body.innerHTML = (d.hotTopics || []).length ? `<p class="si-hint">仅反映本地征稿样本，不代表整个领域趋势。</p><div class="si-hot-list">${d.hotTopics.map(t => `<button class="si-hot-row" data-si-topic="${esc(t.topic)}"><span>${esc(t.topic)}<small>${Number(t.journalCount || 0)} 本期刊 · ${Number(t.upcomingCount || 0)} 条在征</small></span><b>${Number(t.count || 0)} 条</b></button>`).join('')}</div>` : empty('暂无领域热点', '采集并处理公众号文章后，按征稿主题汇总。');
    else if ((d.issues || []).length) body.innerHTML = `<p class="si-hint">当前筛选 ${d.issues.length} 条征稿</p><div class="si-list">${d.issues.map(i => card(i, d)).join('')}</div>`;
    else body.innerHTML = !w.configured ? empty('配置 SSCI征稿 采集', '从首次同步日期向前回溯三个月，之后每日增量更新。', '<button class="tb-btn accent" data-si-tab="manage">配置公众号会话</button>') : empty(w.running ? '正在处理公众号文章' : '没有匹配的征稿', w.running ? '处理完成后会自动刷新卡片。' : '调整筛选条件，或在全部状态中查看已截止和待核验的征稿。', '<button class="tb-btn" data-si-act="clear">清除筛选</button>');
    renderStatus();
    const badge = document.getElementById('navSiBadge'); if (badge) { const n = Number(s.expiringSoon || 0); badge.textContent = String(n); badge.classList.toggle('hidden', n <= 0); badge.title = `${n} 条征稿将在 30 天内截止`; }
  }
  async function mutate(path, opts = {}) {
    if (S.busy || !S.root) return null;
    const generation = S.generation; S.busy = true; S.error = ''; renderStatus();
    try { const r = await api(path, { method: 'POST', body: {}, ...opts }); if (!S.root || generation !== S.generation) return null; await load(); return r; }
    catch (e) { if (generation === S.generation) { S.error = e.message; toast(S.error, 'error'); } return null; }
    finally { if (generation === S.generation) { S.busy = false; renderStatus(); } }
  }
  async function sync() {
    if (S.busy || S.data?.wechat?.running) return;
    if (!S.data?.wechat?.configured) { S.tab = 'manage'; render(true); toast('请先配置微信历史消息链接与有效会话', 'error'); return; }
    const r = await mutate('/api/special-issues/sync');
    if (r) { toast('同步请求已提交，正在刷新进度', 'success'); schedule(); }
  }
  async function saveWechat(form) {
    if (S.saving || S.data?.wechat?.running || !form.reportValidity()) return;
    const generation = S.generation, value = id => form.querySelector('#' + id).value.trim(), w = S.data?.wechat || {};
    const body = { historyUrl: value('siHistoryUrl'), cookie: value('siCookie'), appmsgToken: value('siToken'), clearCookie: form.querySelector('#siClearCookie').checked, clearToken: form.querySelector('#siClearToken').checked, intervalSeconds: Number(value('siInterval')) };
    try {
      if (!body.historyUrl && !w.configured) throw new Error('请填写带 __biz 和有效会话的历史消息链接，公众号 ID 不足以采集。');
      if (body.historyUrl) {
        let u; try { u = new URL(body.historyUrl.replace(/&amp;/g, '&')); } catch { throw new Error('历史消息链接格式无效'); }
        if (u.origin !== 'https://mp.weixin.qq.com' || u.username || u.password || u.pathname !== '/mp/profile_ext' || !['home', 'getmsg'].includes(u.searchParams.get('action')) || !u.searchParams.get('__biz')) throw new Error('请提供含 action 和 __biz 的微信 /mp/profile_ext 历史消息链接。');
        const token = !body.clearToken && (body.appmsgToken || w.hasToken), cookie = !body.clearCookie && (body.cookie || w.hasCookie);
        if (u.searchParams.get('action') === 'getmsg' && !u.searchParams.get('appmsg_token') && !token) throw new Error('getmsg 历史链接缺少 appmsg_token，请更新会话。');
        if (!['appmsg_token', 'pass_ticket', 'key', 'uin', 'wxtoken'].some(k => u.searchParams.get(k)) && !token && !cookie) throw new Error('只有 __biz 无法确认有效会话，请提供会话参数或 Cookie / Token。');
        body.historyUrl = u.href;
      }
      if (/[\r\n]/.test(body.cookie)) throw new Error('Cookie 不能包含换行');
      S.saving = true; S.error = ''; renderStatus();
      await api('/api/special-issues/wechat', { method: 'PUT', body });
      if (generation !== S.generation || !form.isConnected) return;
      for (const id of ['siHistoryUrl', 'siCookie', 'siToken']) { const input = form.querySelector('#' + id); input.value = ''; input.disabled = false; }
      form.querySelector('#siClearCookie').checked = false; form.querySelector('#siClearToken').checked = false;
      toast('公众号会话设置已保存', 'success'); await load();
    } catch (e) { if (generation === S.generation) { S.error = e.message || '保存失败'; toast(S.error, 'error'); } }
    finally { if (generation === S.generation) { S.saving = false; renderStatus(); } }
  }
  async function savePreferences(form) {
    if (S.prefSaving || !form.reportValidity()) return;
    const generation = S.generation, body = { autoSync: form.querySelector('#siAutoSync').checked, syncHour: Number(form.querySelector('#siSyncHour').value) };
    S.prefSaving = true; S.error = ''; renderStatus();
    try {
      const result = await api('/api/special-issues/preferences', { method: 'PUT', body });
      if (generation !== S.generation || !form.isConnected) return;
      if (S.data) { S.data.preferences = result.preferences || { ...S.data.preferences, ...body }; if (result.scheduler) S.data.scheduler = result.scheduler; }
      S.prefDirty = false; toast('每日同步计划已保存', 'success'); await load();
    } catch (e) { if (generation === S.generation) { S.error = e.message || '保存同步计划失败'; toast(S.error, 'error'); } }
    finally { if (generation === S.generation) { S.prefSaving = false; renderStatus(); } }
  }
  async function ranks() {
    if (S.busy || S.data?.wechat?.running) return;
    const generation = S.generation; S.busy = true; S.error = ''; renderStatus();
    let count = 0; const errors = [];
    try {
      const all = await api('/api/special-issues?status=all');
      const ids = [...new Set((all.issues || []).map(i => i.journalId).filter(Boolean))];
      if (!ids.length) { toast('暂无征稿卡片对应的期刊', 'error'); return; }
      for (let offset = 0; offset < ids.length; offset += 20) {
        if (!S.root || generation !== S.generation) return;
        S.root.querySelector('[data-si-act="ranks"]').textContent = `等级查询 ${Math.min(offset + 20, ids.length)} / ${ids.length}`;
        const r = await api('/api/special-issues/ranks/refresh', { method: 'POST', body: { journalIds: ids.slice(offset, offset + 20), limit: 20 } }); count += Number(r.refreshed || 0); errors.push(...(r.errors || []));
      }
      if (generation !== S.generation) return;
      await load();
      if (errors.length) S.error = errors.map(e => typeof e === 'string' ? e : [e.journal, e.error].filter(Boolean).join('：')).join('；');
      toast(`等级已更新 ${count} 本${errors.length ? `，${errors.length} 项失败` : '，有效缓存会保留'}`, errors.length ? 'error' : 'success');
    } catch (e) { if (generation === S.generation) { S.error = e.message; toast(S.error, 'error'); } }
    finally { if (generation === S.generation) { S.busy = false; renderStatus(); } }
  }
  function addModal() {
    const catalog = S.data?.catalog || [];
    S.root.querySelector('#siModal').innerHTML = `<div class="si-modal-mask"><div class="si-modal" role="dialog" aria-modal="true" aria-labelledby="siAddHeading"><div class="si-modal-head"><b id="siAddHeading">添加 SI 征稿</b><button class="tb-btn" data-si-act="close-modal" aria-label="关闭">${ico('x')}</button></div><form id="siAddForm"><label>专刊标题<input class="si-input" name="title" required minlength="4" maxlength="240"></label><label>期刊<select class="si-select" name="journalId"><option value="">手动填写期刊名</option>${catalog.map(j => `<option value="${esc(j.id)}">${esc(j.title)}</option>`).join('')}</select></label><label>期刊名称<input class="si-input" name="journal" maxlength="300"></label><label>主题简介<textarea class="si-input" name="description" rows="3" maxlength="900"></textarea></label><label>截止日期<input class="si-input" name="deadline" type="date" required></label><label>原文链接<input class="si-input" name="url" type="url" placeholder="https://..."></label><div class="si-actions"><button type="button" class="tb-btn" data-si-act="close-modal">取消</button><button class="tb-btn accent" type="submit">添加</button></div></form></div></div>`;
    S.root.querySelector('#siAddForm [name="title"]').focus();
  }
  function closeModal() { if (!S.root) return; S.root.querySelector('#siModal').innerHTML = ''; S.root.querySelector('[data-si-act="add"]').focus(); }
  async function saveCustom(form) { if (!form.reportValidity()) return; const r = await mutate('/api/special-issues/custom', { body: Object.fromEntries(new FormData(form)) }); if (r) { closeModal(); toast('已添加并收藏', 'success'); } }
  function click(e) {
    const t = e.target;
    if (t.classList?.contains('si-modal-mask')) { closeModal(); return; }
    const tab = t.closest('[data-si-tab]'); if (tab) { S.tab = tab.dataset.siTab; render(true); return; }
    const act = t.closest('[data-si-act]')?.dataset.siAct;
    if (act === 'sync') { sync(); return; } if (act === 'ranks') { ranks(); return; } if (act === 'reload') { load(); return; } if (act === 'add') { addModal(); return; } if (act === 'close-modal') { closeModal(); return; }
    if (act === 'clear' || act === 'clear-topic') { S.topic = ''; if (act === 'clear') { S.query = ''; S.status = 'active'; S.journal = ''; S.rankSystem = ''; S.rankValue = ''; S.favoriteOnly = false; S.root.querySelector('#siQuery').value = ''; } load(); return; }
    const topic = t.closest('[data-si-topic]'); if (topic) { S.topic = topic.dataset.siTopic; S.tab = 'issues'; load(); return; }
    const expand = t.closest('[data-si-expand]'); if (expand) { const id = expand.dataset.siExpand; if (S.expanded.has(id)) S.expanded.delete(id); else S.expanded.add(id); render(); return; }
    const fav = t.closest('[data-si-fav]'); if (fav) { mutate(`/api/special-issues/${encodeURIComponent(fav.dataset.siFav)}/favorite`); return; }
    const del = t.closest('[data-si-del]'); if (del) { if (window.confirm('删除这条征稿？公众号征稿删除后将不再自动导入。')) mutate(`/api/special-issues/${encodeURIComponent(del.dataset.siDel)}`, { method: 'DELETE' }); return; }
    const tr = t.closest('[data-si-translate]'); if (tr) mutate(`/api/special-issues/${encodeURIComponent(tr.dataset.siTranslate)}/translate`);
  }
  function change(e) {
    const t = e.target, keys = { siStatus: 'status', siJournal: 'journal', siRankSystem: 'rankSystem', siRankValue: 'rankValue', siSort: 'sort' };
    if (t.closest('#siPreferencesForm')) S.prefDirty = true;
    if (keys[t.id]) { S[keys[t.id]] = t.value; if (t.id === 'siRankSystem') S.rankValue = ''; load(); return; }
    if (t.id === 'siFavChk') { S.favoriteOnly = t.checked; load(); return; }
    if (t.id === 'siClearCookie' || t.id === 'siClearToken') { const input = S.root.querySelector(t.id === 'siClearCookie' ? '#siCookie' : '#siToken'); input.disabled = t.checked; if (t.checked) input.value = ''; }
  }
  function visible() { if (!document.hidden && S.root) load(); }
  function mount(container) {
    const host = container || document.getElementById('viewSpecialIssue'); if (!host) return Promise.resolve(); if (S.root && S.host === host) return load(); if (S.root) close();
    S.generation++; S.data = null; S.loading = false; S.busy = false; S.saving = false; S.prefSaving = false; S.prefDirty = false; S.error = ''; S.observed = false;
    build(host); document.addEventListener('visibilitychange', visible); return load();
  }
  function close() { clearTimeout(S.timer); clearTimeout(S.debounce); document.removeEventListener('visibilitychange', visible); S.generation++; S.root?.remove(); S.root = null; S.host = null; S.data = null; S.expanded.clear(); S.observed = false; }
  window.SpecialIssueView = { mount, refresh: load, close };
})();
