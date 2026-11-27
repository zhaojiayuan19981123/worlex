/* journals.js —— 期刊收藏（DOM 自建，挂载约定同 direction.js / arxiv.js）
 *
 * 这个模块存在的理由：平时读文献、看顶刊、翻征稿时反复遇到同一批刊，
 * 但没有一个地方能「把它记下来，并且记下我对它的判断」。
 *
 * 三类信息在界面上是分开的，来源必须一眼能分清：
 *   等级 —— easyScholar 查回来的，带查询时间，可刷新（第三方数据）
 *   评价 —— 我自己打的分和写的感受（主观，只有我写了才有）
 *   周期 —— 我自己投稿记录算出来的（客观计时）+ 可手填的参考值（必须标来源）
 */
(() => {
  'use strict';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (msg, type = '') => window.Worlex?.toast?.(msg, type) || console.log('[期刊收藏]', msg);
  const safeUrl = (u) => {
    try { const x = new URL(String(u || '')); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; }
  };
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

  const S = {
    mounted: false, root: null,
    items: [], tags: [], counts: {}, total: 0,
    q: '', sort: 'recent', tag: '',
    meta: null,
    current: null,     // 抽屉里正在看的期刊
    busy: false,
    addOpen: false,
    addDraft: { name: '', nameCn: '', abbr: '', issn: '', field: '', website: '', tags: '' },
    addLookup: null,   // 添加弹窗里「先查等级」的结果
    subDraft: { submittedAt: '', firstDecisionAt: '', acceptedAt: '', result: 'pending', rounds: '', note: '' },
    aiBusy: false,
  };
  const $ = (sel) => S.root?.querySelector(sel);

  // ---------- 小工具 ----------
  function daysText(n) {
    if (n == null) return '—';
    if (n < 30) return `${n} 天`;
    if (n < 60) return `${n} 天（约 ${Math.round(n / 7)} 周）`;
    return `${n} 天（约 ${(n / 30).toFixed(1)} 个月）`;
  }

  function starRow(value, size = 'sm') {
    const v = Number(value) || 0;
    let out = '<span class="jr-stars ' + (size === 'lg' ? 'lg' : '') + '">';
    for (let i = 1; i <= 5; i += 1) {
      out += `<span class="jr-star ${i <= Math.round(v) ? 'on' : ''}">★</span>`;
    }
    out += '</span>';
    return out;
  }

  function starInput(field, value, { disabled = false } = {}) {
    const v = Number(value) || 0;
    let out = `<span class="jr-star-input" data-star-field="${esc(field)}">`;
    for (let i = 1; i <= 5; i += 1) {
      out += `<button type="button" class="jr-star-btn ${i <= v ? 'on' : ''}" data-star="${i}" `
        + `aria-label="${i} 分"${disabled ? ' disabled' : ''}>★</button>`;
    }
    out += `<span class="jr-star-val">${v ? v.toFixed(1).replace(/\.0$/, '') : '未评'}</span></span>`;
    return out;
  }

  /** 等级徽标：大类给不同配色，一眼能分开「中科院几区」和「ABS 几星」 */
  function rankBadges(items) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return '<span class="jr-muted">未查询</span>';
    return list.map((i) => {
      const label = String(i.label || '');
      const value = String(i.value || '');
      const tone = /UTD24|FT50/i.test(label) ? 'gold'
        : /ABS/i.test(label) ? 'violet'
          : /CCF/i.test(label) ? 'blue'
            : /中科院|新锐/i.test(label) ? 'teal'
              : /SSCI|FMS/i.test(label) ? 'orange'
                : 'gray';
      return `<span class="jr-badge jr-badge-${tone}" title="${esc(label)}">${esc(label)} <b>${esc(value)}</b></span>`;
    }).join('');
  }

  // ---------- 列表 ----------
  async function load() {
    try {
      const qs = new URLSearchParams();
      if (S.q) qs.set('q', S.q);
      if (S.sort) qs.set('sort', S.sort);
      if (S.tag) qs.set('tag', S.tag);
      const data = await api('/api/journals' + (qs.toString() ? `?${qs}` : ''));
      S.items = data.items || [];
      S.tags = data.tags || [];
      S.counts = data.counts || {};
      S.total = data.total || 0;
      // 侧栏徽标：只报「一共有多少本」，不跟着搜索/筛选变，否则边搜边跳很吵
      const badge = document.getElementById('navJournalBadge');
      if (badge) {
        const n = Number(S.counts.total) || 0;
        badge.textContent = String(n);
        badge.classList.toggle('hidden', !n);
      }
    } catch (e) {
      toast(e.message, 'error');
      S.items = [];
    }
  }

  async function loadMeta() {
    try {
      S.meta = await api('/api/journals/meta');
    } catch {
      S.meta = { dimensions: [], results: [], hasScholarKey: false, hasModel: false, rankTtlDays: 7, batchLimit: 20 };
    }
  }

  function rowHtml(j) {
    const cycle = j.cycleInfo?.days != null
      ? `<span class="jr-row-cycle" title="${esc(j.cycleInfo.label)}">${esc(daysText(j.cycleInfo.days))}</span>`
      : '<span class="jr-row-cycle muted" title="还没有投稿记录，也没有手填参考值">周期未知</span>';
    const url = safeUrl(j.website);
    return `<article class="jr-row" data-id="${esc(j.id)}" tabindex="0" role="button"
      aria-label="${esc(j.name)} 详情">
      <div class="jr-row-main">
        <div class="jr-row-title">
          <b>${esc(j.name)}</b>
          ${j.nameCn ? `<span class="jr-row-cn">${esc(j.nameCn)}</span>` : ''}
          ${j.abbr ? `<span class="jr-row-abbr">${esc(j.abbr)}</span>` : ''}
        </div>
        <div class="jr-row-sub">
          ${j.field ? `<span class="jr-chip">${esc(j.field)}</span>` : ''}
          ${j.issn ? `<span class="jr-muted">ISSN ${esc(j.issn)}</span>` : ''}
          ${(j.tags || []).map((t) => `<span class="jr-tag">${esc(t)}</span>`).join('')}
          ${url ? `<a class="jr-link" href="${esc(url)}" target="_blank" rel="noopener">官网</a>` : ''}
        </div>
        <div class="jr-row-rank">${rankBadges(j.rank?.items)}</div>
      </div>
      <div class="jr-row-side">
        <div class="jr-row-rating">${j.review?.rating ? starRow(j.review.rating) : '<span class="jr-muted">未评价</span>'}</div>
        ${cycle}
      </div>
    </article>`;
  }

  function statsBar() {
    const c = S.counts || {};
    return `<div class="jr-statbar">
      <span><b>${c.total || 0}</b> 本收藏</span>
      <span><b>${c.withRank || 0}</b> 本有等级</span>
      <span><b>${c.rated || 0}</b> 本已评价</span>
      <span><b>${c.withCycle || 0}</b> 本有周期数据</span>
    </div>`;
  }

  function listHtml() {
    return S.items.length
      ? S.items.map(rowHtml).join('')
      : `<div class="jr-empty">${S.q || S.tag ? '没有匹配的期刊' : '还没有收藏期刊'}<br>
          <span class="jr-muted">点右上「＋ 收藏期刊」手动加一本，或「从文献库导入」把读过的刊一次性收进来</span></div>`;
  }

  /**
   * 只重绘「统计条 + 列表」。
   *
   * 搜索 / 排序 / 标签筛选必须走这条路径：整块重建会把 #jrSearch 一起替换掉，
   * 输入焦点和输入法的候选状态都会丢（中文打到一半字就飞了）。
   */
  function renderList() {
    const list = $('.jr-list');
    if (list) list.innerHTML = listHtml();
    const bar = $('.jr-head-title .jr-statbar');
    if (bar) bar.outerHTML = statsBar();
  }

  function render() {
    if (!S.root) return;
    const list = listHtml();

    S.root.innerHTML = `
      <div class="jr-head">
        <div class="jr-head-title">
          <h2>期刊收藏</h2>
          ${statsBar()}
        </div>
        <div class="jr-head-tools">
          <input id="jrSearch" class="jr-search" type="search" placeholder="搜索期刊名 / 标签 / 备注" value="${esc(S.q)}" aria-label="搜索期刊">
          <select id="jrSort" class="jr-select" aria-label="排序">
            ${[
    ['recent', '最近收藏'], ['tier', '按等级'], ['rating', '按我的评分'], ['cycle', '按审稿周期'], ['name', '按名称'],
  ].map(([v, label]) => `<option value="${v}"${S.sort === v ? ' selected' : ''}>${label}</option>`).join('')}
          </select>
          <select id="jrTag" class="jr-select" aria-label="按标签筛选">
            <option value="">全部标签</option>
            ${S.tags.map((t) => `<option value="${esc(t)}"${S.tag === t ? ' selected' : ''}>${esc(t)}</option>`).join('')}
          </select>
          <button type="button" id="jrBatchRank" class="jr-btn" title="把这些刊的等级一次性查回来">刷新等级</button>
          <button type="button" id="jrImport" class="jr-btn" title="把文献库里出现过的期刊收进来">从文献库导入</button>
          <button type="button" id="jrAdd" class="jr-btn primary">＋ 收藏期刊</button>
        </div>
      </div>
      ${S.meta && !S.meta.hasScholarKey ? `<div class="jr-note">还没有配置 easyScholar SecretKey，等级查询用不了；其余（评价、投稿周期、备注）照常可用。到「AI 设置」里填上就能查。</div>` : ''}
      <div class="jr-list">${list}</div>
      <div id="jrDrawerMask" class="jr-drawer-mask hidden"></div>
      <aside id="jrDrawer" class="jr-drawer hidden" role="dialog" aria-modal="true" aria-label="期刊详情"></aside>
      <div id="jrModal" class="jr-modal hidden" role="dialog" aria-modal="true" aria-label="收藏期刊"></div>
    `;
    bind();
    if (S.current) renderDrawer();
    if (S.addOpen) renderAddModal();
  }

  // ---------- 事件 ----------
  let searchTimer = null;
  function bind() {
    const search = $('#jrSearch');
    search?.addEventListener('input', () => {
      S.q = search.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(async () => { await load(); renderList(); }, 220);
    });
    $('#jrSort')?.addEventListener('change', async (e) => { S.sort = e.target.value; await load(); renderList(); });
    $('#jrTag')?.addEventListener('change', async (e) => { S.tag = e.target.value; await load(); renderList(); });
    $('#jrAdd')?.addEventListener('click', () => openAddModal());
    $('#jrImport')?.addEventListener('click', importFromLibrary);
    $('#jrBatchRank')?.addEventListener('click', batchRank);

    $('.jr-list')?.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;      // 官网链接自己跳
      const row = e.target.closest('.jr-row');
      if (row?.dataset.id) openJournal(row.dataset.id);
    });
    $('.jr-list')?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const row = e.target.closest('.jr-row');
      if (row?.dataset.id) { e.preventDefault(); openJournal(row.dataset.id); }
    });

    $('#jrDrawerMask')?.addEventListener('click', closeDrawer);
    S.root.querySelector('#jrDrawer')?.addEventListener('click', onDrawerClick);
    S.root.querySelector('#jrDrawer')?.addEventListener('input', onDrawerInput);
    S.root.querySelector('#jrDrawer')?.addEventListener('change', onDrawerInput);
    S.root.querySelector('#jrModal')?.addEventListener('click', onModalClick);
    S.root.querySelector('#jrModal')?.addEventListener('input', onModalInput);
  }

  // 抽屉里的星级：点第 N 颗 = N 分，再点同一颗清零
  function onDrawerClick(e) {
    const star = e.target.closest('.jr-star-btn');
    if (star) {
      const wrap = star.closest('.jr-star-input');
      const field = wrap?.dataset.starField;
      const n = Number(star.dataset.star);
      const cur = Number(wrap.dataset.value) || 0;
      const next = cur === n ? 0 : n;
      wrap.dataset.value = String(next);
      wrap.querySelectorAll('.jr-star-btn').forEach((b) => b.classList.toggle('on', Number(b.dataset.star) <= next));
      const val = wrap.querySelector('.jr-star-val');
      if (val) val.textContent = next ? String(next) : '未评';
      if (field === 'rating') {
        S.reviewDraft = { ...(S.reviewDraft || {}), rating: next };
      } else if (field?.startsWith('dim:')) {
        // 维度写在 dimensions 里；早先直接写成 { 'dim:rigor': 5 } 导致三个维度全存成 0
        S.reviewDraft = {
          ...(S.reviewDraft || {}),
          dimensions: { ...(S.reviewDraft?.dimensions || {}), [field.slice(4)]: next },
        };
      }
      return;
    }

    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    const j = S.current;
    if (act === 'close') return closeDrawer();
    if (act === 'rank') return queryRank(j.id);
    if (act === 'saveReview') return saveReview();
    if (act === 'saveCycle') return saveCycle();
    if (act === 'saveInfo') return saveInfo();
    if (act === 'delete') return deleteJournal(j.id);
    if (act === 'addSub') return addSubmission();
    if (act === 'delSub') return delSubmission(e.target.closest('[data-sid]')?.dataset.sid);
    if (act === 'ai') return genAi(j.id);
    return undefined;
  }

  function onDrawerInput(e) {
    const t = e.target;
    const field = t.dataset?.draft;
    if (!field) return;
    if (field.startsWith('review.')) {
      const key = field.slice(7);
      S.reviewDraft = { ...(S.reviewDraft || {}) };
      if (key.startsWith('dim:')) {
        S.reviewDraft.dimensions = { ...(S.reviewDraft.dimensions || {}), [key.slice(4)]: t.value };
      } else S.reviewDraft[key] = t.value;
    } else if (field.startsWith('cycle.')) {
      S.cycleDraft = { ...(S.cycleDraft || {}), [field.slice(6)]: t.value };
    } else if (field.startsWith('sub.')) {
      S.subDraft = { ...S.subDraft, [field.slice(4)]: t.value };
    } else if (field.startsWith('info.')) {
      S.infoDraft = { ...(S.infoDraft || {}), [field.slice(5)]: t.value };
    }
  }

  // ---------- 添加弹窗 ----------
  function openAddModal() {
    S.addOpen = true;
    S.addDraft = { name: '', nameCn: '', abbr: '', issn: '', field: '', website: '', tags: '' };
    S.addLookup = null;
    renderAddModal();
  }

  function closeAddModal() {
    S.addOpen = false;
    S.addLookup = null;
    $('#jrModal')?.classList.add('hidden');
  }

  function renderAddModal() {
    const m = $('#jrModal');
    if (!m) return;
    m.classList.remove('hidden');
    const d = S.addDraft;
    const look = S.addLookup;
    m.innerHTML = `<div class="jr-modal-box">
      <header class="jr-modal-head">
        <h3>收藏一本期刊</h3>
        <button type="button" class="jr-icon-btn" data-mact="close" aria-label="关闭">✕</button>
      </header>
      <div class="jr-modal-body">
        <label class="jr-field"><span>期刊名 <i>必填</i></span>
          <input data-mdraft="name" value="${esc(d.name)}" placeholder="例如 Journal of Consumer Research" autofocus>
        </label>
        <div class="jr-field-row">
          <label class="jr-field"><span>中文名 / 简称</span>
            <input data-mdraft="nameCn" value="${esc(d.nameCn)}" placeholder="可选">
          </label>
          <label class="jr-field"><span>缩写</span>
            <input data-mdraft="abbr" value="${esc(d.abbr)}" placeholder="如 JCR">
          </label>
        </div>
        <div class="jr-field-row">
          <label class="jr-field"><span>ISSN</span>
            <input data-mdraft="issn" value="${esc(d.issn)}" placeholder="可选">
          </label>
          <label class="jr-field"><span>学科</span>
            <input data-mdraft="field" value="${esc(d.field)}" placeholder="如 市场营销">
          </label>
        </div>
        <label class="jr-field"><span>官网</span>
          <input data-mdraft="website" value="${esc(d.website)}" placeholder="https://">
        </label>
        <label class="jr-field"><span>标签（逗号分隔）</span>
          <input data-mdraft="tags" value="${esc(d.tags)}" placeholder="如 营销, 行为, 目标刊">
        </label>

        <div class="jr-lookup">
          <button type="button" class="jr-btn" data-mact="lookup">先查一下等级</button>
          ${look ? (look.error
    ? `<span class="jr-lookup-err">${esc(look.error)}</span>`
    : `<div class="jr-lookup-ok">${rankBadges(look.items)}</div>`) : '<span class="jr-muted">不用先存，查完再决定要不要收</span>'}
        </div>
      </div>
      <footer class="jr-modal-foot">
        <button type="button" class="jr-btn" data-mact="close">取消</button>
        <button type="button" class="jr-btn primary" data-mact="save">收藏</button>
      </footer>
    </div>`;
  }

  function onModalInput(e) {
    const key = e.target.dataset?.mdraft;
    if (!key) return;
    S.addDraft = { ...S.addDraft, [key]: e.target.value };
  }

  async function onModalClick(e) {
    const act = e.target.closest('[data-mact]')?.dataset.mact;
    if (!act) return;
    if (act === 'close') return closeAddModal();
    if (act === 'lookup') {
      const name = S.addDraft.name.trim();
      if (!name) return toast('先填期刊名', 'error');
      S.addLookup = { loading: true };
      renderAddModal();
      try {
        S.addLookup = await api('/api/journals/lookup', { method: 'POST', body: { name } });
      } catch (err) {
        S.addLookup = { error: err.message };
      }
      return renderAddModal();
    }
    if (act === 'save') {
      const name = S.addDraft.name.trim();
      if (!name) return toast('期刊名不能为空', 'error');
      try {
        const payload = {
          ...S.addDraft,
          tags: String(S.addDraft.tags || '').split(/[,，;；]/).map((s) => s.trim()).filter(Boolean),
        };
        const res = await api('/api/journals', { method: 'POST', body: payload });
        closeAddModal();
        await refreshAll();
        if (res.created) toast(`已收藏《${res.journal.name}》`);
        else toast('这本刊已经在收藏里了');
        if (res.created && S.meta?.hasScholarKey) queryRank(res.journal.id, { silent: true });
        else if (res.journal?.id) openJournal(res.journal.id);
      } catch (err) {
        toast(err.message, 'error');
      }
    }
    return undefined;
  }

  // ---------- 从文献库导入 ----------
  async function importFromLibrary() {
    try {
      const res = await api('/api/journals/import', { method: 'POST', body: { source: 'literature' } });
      await refreshAll();
      toast(res.added ? `导入了 ${res.added} 本期刊${res.skipped ? `，${res.skipped} 本已收藏跳过` : ''}` : '文献库里的期刊都已经收藏过了');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  // ---------- 批量查等级 ----------
  async function batchRank() {
    if (!S.meta?.hasScholarKey) return toast('先在「AI 设置」里填 easyScholar SecretKey 才能查等级', 'error');
    if (!S.items.length) return toast('收藏夹是空的', 'error');
    if (S.busy) return undefined;
    S.busy = true;
    const btn = $('#jrBatchRank');
    const old = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = '查询中…'; }
    try {
      const res = await api('/api/journals/batch-rank', { method: 'POST', body: { ids: S.items.map((j) => j.id) } });
      await load();
      render();
      const extra = res.truncated ? `（按接口限速，一次最多 ${res.done} 本，其余请再点一次）` : '';
      toast(`等级已更新 ${res.updated} 本${res.failed ? `，${res.failed} 本未查到` : ''}${extra}`);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      S.busy = false;
      if (btn) { btn.disabled = false; btn.textContent = old || '刷新等级'; }
    }
    return undefined;
  }

  // ---------- 抽屉 ----------
  async function openJournal(id) {
    try {
      const data = await api('/api/journals/' + encodeURIComponent(id));
      S.current = data.journal;
      S.staleRank = Boolean(data.staleRank);
      S.hasScholarKey = Boolean(data.hasScholarKey);
      S.reviewDraft = { ...(S.current.review || {}) };
      S.cycleDraft = { ...(S.current.cycle || {}) };
      S.infoDraft = {
        name: S.current.name, nameCn: S.current.nameCn || '', abbr: S.current.abbr || '',
        issn: S.current.issn || '', field: S.current.field || '',
        website: S.current.website || '', submitUrl: S.current.submitUrl || '',
      };
      S.subDraft = { submittedAt: '', firstDecisionAt: '', acceptedAt: '', result: 'pending', rounds: '', note: '' };
      renderDrawer();
      $('#jrDrawer')?.classList.remove('hidden');
      $('#jrDrawerMask')?.classList.remove('hidden');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function closeDrawer() {
    S.current = null;
    $('#jrDrawer')?.classList.add('hidden');
    $('#jrDrawerMask')?.classList.add('hidden');
  }

  function cycleBlock(j) {
    const s = j.stats || {};
    const cells = [
      ['首轮意见（中位数）', s.medianFirstDays != null ? daysText(s.medianFirstDays) : '—'],
      ['首轮意见（均值）', s.avgFirstDays != null ? daysText(s.avgFirstDays) : '—'],
      ['最快 / 最慢', s.firstSamples ? `${s.fastestFirstDays} / ${s.slowestFirstDays} 天` : '—'],
      ['到接收', s.avgAcceptDays != null ? daysText(s.avgAcceptDays) : '—'],
      ['接收率', s.acceptRate != null ? `${s.acceptRate}%（${s.accepted}/${s.decided}）` : '—'],
      ['投稿次数', s.trials ? `${s.trials} 次（在审 ${s.pending}）` : '0 次'],
    ];
    return `<div class="jr-cycle-grid">
      ${cells.map(([k, v]) => `<div class="jr-cycle-cell"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}
    </div>
    <p class="jr-hint">${s.firstSamples
    ? `以下天数来自你自己记录的投稿经历（${s.firstSamples} 条有首轮意见日期），不是论坛传闻。`
    : '还没有记录过投稿。填一条「投稿日期 + 首轮意见日期」，这里就会开始统计。'}</p>`;
  }

  function subList(j) {
    const list = Array.isArray(j.submissions) ? j.submissions : [];
    if (!list.length) return '<p class="jr-muted jr-hint">还没有投稿记录。</p>';
    return `<ul class="jr-subs">${list.map((s) => {
      const label = (S.meta?.results || []).find((r) => r.value === s.result)?.label || s.result;
      const first = s.firstDecisionAt ? `首轮 ${s.firstDecisionAt}` : '尚无首轮意见';
      const acc = s.acceptedAt ? ` · 接收 ${s.acceptedAt}` : '';
      return `<li><div class="jr-sub-main">
          <b>${esc(s.submittedAt)}</b>
          <span class="jr-sub-res jr-res-${esc(s.result)}">${esc(label)}</span>
          <span class="jr-muted">${esc(first)}${esc(acc)}${s.rounds ? ` · ${s.rounds} 轮` : ''}</span>
        </div>
        ${s.note ? `<div class="jr-sub-note">${esc(s.note)}</div>` : ''}
        <button type="button" class="jr-icon-btn" data-act="delSub" data-sid="${esc(s.id)}" title="删除这条记录" aria-label="删除这条投稿记录">✕</button>
      </li>`;
    }).join('')}</ul>`;
  }

  function renderDrawer() {
    const el = $('#jrDrawer');
    const j = S.current;
    if (!el || !j) return;
    const rank = j.rank || {};
    const stale = S.staleRank;
    const results = S.meta?.results || [];
    const dims = S.meta?.dimensions || [];
    const ws = safeUrl(j.website);
    const su = safeUrl(j.submitUrl);

    el.innerHTML = `
      <header class="jr-drawer-head">
        <div>
          <h3>${esc(j.name)}</h3>
          <div class="jr-drawer-sub">
            ${j.nameCn ? `<span>${esc(j.nameCn)}</span>` : ''}
            ${j.abbr ? `<span>${esc(j.abbr)}</span>` : ''}
            ${j.issn ? `<span>ISSN ${esc(j.issn)}</span>` : ''}
            ${j.field ? `<span class="jr-chip">${esc(j.field)}</span>` : ''}
          </div>
        </div>
        <button type="button" class="jr-icon-btn" data-act="close" aria-label="关闭">✕</button>
      </header>
      <div class="jr-drawer-body">

        <section class="jr-sec">
          <div class="jr-sec-head">
            <h4>期刊等级</h4>
            <div class="jr-sec-tools">
              ${ws ? `<a class="jr-btn small" href="${esc(ws)}" target="_blank" rel="noopener">官网</a>` : ''}
              ${su ? `<a class="jr-btn small" href="${esc(su)}" target="_blank" rel="noopener">投稿入口</a>` : ''}
              <button type="button" class="jr-btn small" data-act="rank"${S.hasScholarKey ? '' : ' title="需要先配置 easyScholar SecretKey"'}>${rank.at ? '重新查询' : '查询等级'}</button>
            </div>
          </div>
          <div class="jr-rank-box">${rankBadges(rank.items)}</div>
          ${rank.error ? `<p class="jr-warn">${esc(rank.error)}</p>` : ''}
          ${rank.at ? `<p class="jr-hint">查询于 ${esc(new Date(rank.at).toLocaleString('zh-CN'))}${stale ? '（超过 7 天，建议重新查询）' : ''} · 数据来自 easyScholar</p>` : ''}
          ${S.hasScholarKey ? '' : '<p class="jr-hint">未配置 easyScholar SecretKey，暂时查不了等级；评价与周期不受影响。</p>'}
        </section>

        <section class="jr-sec">
          <div class="jr-sec-head"><h4>我的评价</h4>
            <button type="button" class="jr-btn small primary" data-act="saveReview">保存评价</button>
          </div>
          <div class="jr-review-row"><span class="jr-label">总评</span>
            ${starInput('rating', S.reviewDraft?.rating, { })}</div>
          <div class="jr-dims">
            ${dims.map((d) => `<div class="jr-dim">
              <span class="jr-label" title="${esc(d.hint)}">${esc(d.label)}</span>
              ${starInput(`dim:${d.key}`, S.reviewDraft?.dimensions?.[d.key])}
            </div>`).join('')}
          </div>
          <div class="jr-field-row">
            <label class="jr-field"><span>好在哪</span>
              <textarea rows="2" data-draft="review.pros" placeholder="编辑给的建议具体、返修要求清楚…">${esc(S.reviewDraft?.pros || '')}</textarea>
            </label>
            <label class="jr-field"><span>不足</span>
              <textarea rows="2" data-draft="review.cons" placeholder="周期长、要求补的实验做不完…">${esc(S.reviewDraft?.cons || '')}</textarea>
            </label>
          </div>
          <label class="jr-field"><span>备注</span>
            <textarea rows="2" data-draft="review.note" placeholder="适合什么类型的研究、写作偏好、版面费…">${esc(S.reviewDraft?.note || '')}</textarea>
          </label>
          ${S.reviewDraft?.updatedAt ? `<p class="jr-hint">上次修改：${esc(new Date(S.reviewDraft.updatedAt).toLocaleString('zh-CN'))}</p>` : ''}
        </section>

        <section class="jr-sec">
          <div class="jr-sec-head"><h4>审稿周期</h4>
            <span class="jr-hint">${j.cycleInfo?.days != null ? `当前展示：${esc(daysText(j.cycleInfo.days))} · ${esc(j.cycleInfo.label)}` : '暂无可用周期'}</span>
          </div>
          ${cycleBlock(j)}
          <div class="jr-field-row jr-cycle-ref">
            <label class="jr-field"><span>参考周期（天）</span>
              <input type="number" min="0" max="999" data-draft="cycle.refDays" value="${esc(S.cycleDraft?.refDays || '')}" placeholder="没有投稿记录时用它兜底">
            </label>
            <label class="jr-field"><span>来源</span>
              <input data-draft="cycle.refSource" value="${esc(S.cycleDraft?.refSource || '')}" placeholder="如 官网 / 编辑部邮件 / 同门经验">
            </label>
            <button type="button" class="jr-btn small" data-act="saveCycle">保存参考值</button>
          </div>
          <p class="jr-hint">参考值只在你还没有实测数据时兜底展示，并会标明来源——不当成实测结果。</p>

          <h5 class="jr-sub-h">我的投稿经历</h5>
          ${subList(j)}
          <details class="jr-add-sub">
            <summary>＋ 记一条投稿</summary>
            <div class="jr-field-row">
              <label class="jr-field"><span>投稿日期</span>
                <input type="date" data-draft="sub.submittedAt" value="${esc(S.subDraft.submittedAt)}">
              </label>
              <label class="jr-field"><span>首轮意见</span>
                <input type="date" data-draft="sub.firstDecisionAt" value="${esc(S.subDraft.firstDecisionAt)}">
              </label>
            </div>
            <div class="jr-field-row">
              <label class="jr-field"><span>接收日期</span>
                <input type="date" data-draft="sub.acceptedAt" value="${esc(S.subDraft.acceptedAt)}">
              </label>
              <label class="jr-field"><span>结果</span>
                <select data-draft="sub.result">
                  ${results.map((r) => `<option value="${esc(r.value)}"${S.subDraft.result === r.value ? ' selected' : ''}>${esc(r.label)}</option>`).join('')}
                </select>
              </label>
              <label class="jr-field"><span>轮次</span>
                <input type="number" min="0" max="20" data-draft="sub.rounds" value="${esc(S.subDraft.rounds)}" placeholder="如 2">
              </label>
            </div>
            <label class="jr-field"><span>备注</span>
              <input data-draft="sub.note" value="${esc(S.subDraft.note)}" placeholder="审稿人主要问了什么">
            </label>
            <button type="button" class="jr-btn primary" data-act="addSub">保存这条投稿</button>
          </details>
        </section>

        <section class="jr-sec">
          <div class="jr-sec-head"><h4>AI 投稿建议</h4>
            <button type="button" class="jr-btn small" data-act="ai"${S.aiBusy ? ' disabled' : ''}>${j.ai?.text ? '重新生成' : '生成建议'}</button>
          </div>
          <p class="jr-hint">只让模型给「投什么、怎么准备」的建议；影响因子、录用率、审稿天数这类数字它不许编，一律以你查到的等级和你自己的投稿记录为准。</p>
          ${j.ai?.text
    ? `<div class="jr-ai-body">${esc(j.ai.text).replace(/\n/g, '<br>')}</div>
             <p class="jr-hint">${esc(j.ai.model || 'AI')} · ${esc(new Date(j.ai.at).toLocaleString('zh-CN'))} · AI 生成，仅供参考</p>`
    : '<p class="jr-muted">还没有生成。</p>'}
        </section>

        <section class="jr-sec">
          <div class="jr-sec-head"><h4>基本信息</h4>
            <button type="button" class="jr-btn small" data-act="saveInfo">保存</button>
          </div>
          <div class="jr-field-row">
            <label class="jr-field"><span>期刊名</span><input data-draft="info.name" value="${esc(S.infoDraft?.name || '')}"></label>
            <label class="jr-field"><span>中文名</span><input data-draft="info.nameCn" value="${esc(S.infoDraft?.nameCn || '')}"></label>
          </div>
          <div class="jr-field-row">
            <label class="jr-field"><span>缩写</span><input data-draft="info.abbr" value="${esc(S.infoDraft?.abbr || '')}"></label>
            <label class="jr-field"><span>ISSN</span><input data-draft="info.issn" value="${esc(S.infoDraft?.issn || '')}"></label>
            <label class="jr-field"><span>学科</span><input data-draft="info.field" value="${esc(S.infoDraft?.field || '')}"></label>
          </div>
          <div class="jr-field-row">
            <label class="jr-field"><span>官网</span><input data-draft="info.website" value="${esc(S.infoDraft?.website || '')}"></label>
            <label class="jr-field"><span>投稿入口</span><input data-draft="info.submitUrl" value="${esc(S.infoDraft?.submitUrl || '')}"></label>
          </div>
          <div class="jr-danger">
            <button type="button" class="jr-btn small danger" data-act="delete">从收藏中移除</button>
            <span class="jr-hint">只删这条收藏，不影响文献中心里的文献。</span>
          </div>
        </section>
      </div>`;
    // 星级输入需要把当前值放进 dataset，后面的点击逻辑才能「再点同一颗清零」
    el.querySelectorAll('.jr-star-input').forEach((wrap) => {
      const field = wrap.dataset.starField;
      const raw = field === 'rating' ? S.reviewDraft?.rating : S.reviewDraft?.dimensions?.[field.slice(4)];
      wrap.dataset.value = String(Number(raw) || 0);
    });
  }

  // ---------- 动作 ----------
  async function saveReview() {
    const d = S.reviewDraft || {};
    try {
      const j = await api(`/api/journals/${encodeURIComponent(S.current.id)}`, {
        method: 'PATCH',
        body: { review: { rating: d.rating, dimensions: d.dimensions, pros: d.pros, cons: d.cons, note: d.note } },
      });
      applyJournal(j);
      toast('评价已保存');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function saveCycle() {
    const d = S.cycleDraft || {};
    try {
      const j = await api(`/api/journals/${encodeURIComponent(S.current.id)}`, {
        method: 'PATCH',
        body: { cycle: { refDays: d.refDays, refSource: d.refSource, refNote: d.refNote } },
      });
      applyJournal(j);
      toast('参考周期已保存');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function saveInfo() {
    const d = S.infoDraft || {};
    if (!String(d.name || '').trim()) return toast('期刊名不能为空', 'error');
    try {
      const j = await api(`/api/journals/${encodeURIComponent(S.current.id)}`, {
        method: 'PATCH', body: { ...d },
      });
      applyJournal(j);
      toast('已保存');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function queryRank(id, opts = {}) {
    if (!opts.silent && S.busy) return;
    S.busy = true;
    try {
      const j = await api(`/api/journals/${encodeURIComponent(id)}/rank`, { method: 'POST', body: {} });
      if (S.current?.id === j.id) applyJournal(j);
      else { await load(); render(); }
      if (!opts.silent) toast(j.rank?.items?.length ? '等级已更新' : '没查到收录信息');
    } catch (e) {
      toast(e.message, 'error');
      if (S.current?.id === id) {
        try { applyJournal(await api(`/api/journals/${encodeURIComponent(id)}`).then((d) => d.journal)); } catch { /* 忽略 */ }
      }
    } finally {
      S.busy = false;
    }
  }

  async function addSubmission() {
    const d = S.subDraft || {};
    try {
      const j = await api(`/api/journals/${encodeURIComponent(S.current.id)}/submissions`, { method: 'POST', body: d });
      applyJournal(j);
      S.subDraft = { submittedAt: '', firstDecisionAt: '', acceptedAt: '', result: 'pending', rounds: '', note: '' };
      renderDrawer();
      toast('投稿记录已保存');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function delSubmission(sid) {
    if (!sid) return;
    try {
      const j = await api(`/api/journals/${encodeURIComponent(S.current.id)}/submissions/${encodeURIComponent(sid)}`, { method: 'DELETE' });
      applyJournal(j);
      toast('已删除这条投稿记录');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function deleteJournal(id) {
    if (!window.confirm('从收藏里移除这本期刊？只删收藏，不影响文献中心。')) return;
    try {
      await api(`/api/journals/${encodeURIComponent(id)}`, { method: 'DELETE' });
      closeDrawer();
      await refreshAll();
      toast('已移除');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function genAi(id) {
    if (S.aiBusy) return;
    if (!S.meta?.hasModel) return toast('还没有配置大模型，请到「AI 设置」里添加', 'error');
    S.aiBusy = true;
    const btn = S.root?.querySelector('[data-act="ai"]');
    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
    try {
      const j = await api(`/api/journals/${encodeURIComponent(id)}/ai`, { method: 'POST', body: {} });
      applyJournal(j);
      toast('建议已生成');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      S.aiBusy = false;
      const b2 = S.root?.querySelector('[data-act="ai"]');
      if (b2) { b2.disabled = false; b2.textContent = '重新生成'; }
    }
  }

  /** 服务端返回的是完整记录：把它同时写回抽屉与列表那一行，避免「改了这边那边还是旧的」 */
  function applyJournal(j) {
    if (!j) return;
    S.current = j;
    S.reviewDraft = { ...(j.review || {}) };
    S.cycleDraft = { ...(j.cycle || {}) };
    const idx = S.items.findIndex((x) => x.id === j.id);
    if (idx >= 0) S.items[idx] = j;
    renderDrawer();
    const row = S.root?.querySelector(`.jr-row[data-id="${j.id}"]`);
    if (row) row.outerHTML = rowHtml(j);
  }

  async function refreshAll() {
    await load();
    render();
  }

  // ---------- 挂载 ----------
  async function mount(container) {
    if (container) S.root = container;
    if (!S.mounted) {
      S.mounted = true;
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!$('#jrDrawer') || $('#jrDrawer').classList.contains('hidden')) {
          if (S.addOpen) closeAddModal();
          return;
        }
        closeDrawer();
      });
    }
    if (!S.meta) await loadMeta();
    await load();
    render();
  }

  function close() {
    closeDrawer();
    S.addOpen = false;
    $('#jrModal')?.classList.add('hidden');
  }

  window.JournalView = { mount, close, refresh: refreshAll };
})();
