/* arxiv.js —— arXiv 分类浏览（DOM 自建，挂载约定同 direction.js） */
(() => {
  'use strict';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (msg, type = '') => window.Worlex?.toast?.(msg, type) || console.log('[arXiv]', msg);
  const safeUrl = (u) => {
    try { const x = new URL(String(u || '')); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; }
  };
  async function api(path) {
    if (window.Worlex?.api) return window.Worlex.api(path);
    const res = await fetch(path);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
    return data;
  }

  const S = {
    mounted: false, root: null, meta: null,
    category: 'cs.AI', query: '', sort: 'submittedDate', start: 0, perPage: 20,
    total: 0, entries: [], busy: false, expanded: new Set(), error: '',
  };
  const $ = (sel) => S.root?.querySelector(sel);

  function mount(container) {
    S.root = container;
    if (!S.mounted) {
      container.innerHTML = skeleton();
      S.mounted = true;
      bind();
    }
    refreshMeta();
  }
  function close() { /* 没有后台任务，保留列表状态 */ }

  function skeleton() {
    return `
      <div class="ax-shell">
        <aside class="ax-side">
          <div class="ax-side-head"><b>arXiv 分类</b><span>按学科查看最新论文</span></div>
          <div class="ax-cats" data-ax-cats></div>
        </aside>
        <main class="ax-main">
          <div class="ax-toolbar">
            <input class="tb-input ax-q" data-ax="q" placeholder="在所选分类里检索（多个词用空格分隔）" maxlength="160">
            <select class="tb-select ax-sort" data-ax="sort">
              <option value="submittedDate">最新提交</option>
              <option value="relevance">相关度</option>
            </select>
            <button class="btn btn-primary" data-ax="search">检索</button>
          </div>
          <div class="ax-banner hidden" data-ax-banner></div>
          <div class="ax-head" data-ax-head></div>
          <div class="ax-list" data-ax-list></div>
          <div class="ax-pager" data-ax-pager></div>
        </main>
      </div>`;
  }

  function bind() {
    S.root.addEventListener('click', (e) => {
      const cat = e.target.closest('[data-ax-cat]');
      if (cat) { S.category = cat.dataset.axCat; S.start = 0; renderCats(); load(); return; }
      const act = e.target.closest('[data-ax]');
      if (act) {
        const name = act.dataset.ax;
        if (name === 'search') { S.query = $('[data-ax="q"]').value.trim(); S.start = 0; load(); return; }
        if (name === 'prev') { S.start = Math.max(0, S.start - S.perPage); load(); return; }
        if (name === 'next') { S.start += S.perPage; load(); return; }
        if (name === 'expand') {
          const id = act.closest('[data-ax-id]')?.dataset.axId;
          if (S.expanded.has(id)) S.expanded.delete(id); else S.expanded.add(id);
          renderList();
        }
      }
    });
    S.root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target?.matches?.('[data-ax="q"]')) {
        e.preventDefault(); S.query = e.target.value.trim(); S.start = 0; load();
      }
    });
    S.root.addEventListener('change', (e) => {
      if (e.target.matches('[data-ax="sort"]')) { S.sort = e.target.value; S.start = 0; load(); }
    });
  }

  async function refreshMeta() {
    try {
      S.meta = await api('/api/arxiv/meta');
      if (!S.meta.groups.some((g) => g.items.some(([id]) => id === S.category))) {
        S.category = S.meta.defaultCategory || 'cs.AI';
      }
      renderCats();
      await load();
    } catch (e) {
      S.error = e.message;
      banner(e.message, 'error');
    }
  }

  async function load() {
    if (S.busy) return;
    S.busy = true;
    banner('正在抓取 arXiv…', 'info', true);
    try {
      const params = new URLSearchParams({
        category: S.category, q: S.query, sort: S.sort,
        start: String(S.start), perPage: String(S.perPage),
      });
      const data = await api(`/api/arxiv/feed?${params}`);
      S.total = data.total || 0;
      S.entries = data.entries || [];
      S.error = '';
      banner('');
      renderAll();
    } catch (e) {
      S.error = e.message;
      S.entries = []; S.total = 0;
      banner(e.message, 'error');
      renderAll();
    } finally {
      S.busy = false;
    }
  }

  function banner(text, tone = '', spin = false) {
    const box = $('[data-ax-banner]');
    if (!box) return;
    if (!text) { box.className = 'ax-banner hidden'; box.innerHTML = ''; return; }
    box.className = `ax-banner is-${tone}`;
    box.innerHTML = `${spin ? '<span class="dir-spinner" aria-hidden="true"></span>' : ''}<span>${esc(text)}</span>`;
  }

  function renderCats() {
    const box = $('[data-ax-cats]');
    if (!box || !S.meta?.groups) return;
    const all = `<button class="ax-cat${S.category === 'all' ? ' active' : ''}" data-ax-cat="all">全部学科</button>`;
    box.innerHTML = all + S.meta.groups.map((g) => `
      <div class="ax-cat-group">
        <div class="ax-cat-group-name">${esc(g.name)}</div>
        <div class="ax-cat-items">${g.items.map(([id, label]) =>
          `<button class="ax-cat${S.category === id ? ' active' : ''}" data-ax-cat="${esc(id)}" title="${esc(id)}">${esc(label)}</button>`).join('')}</div>
      </div>`).join('');
  }

  function renderAll() {
    renderHead();
    renderList();
    renderPager();
  }

  function renderHead() {
    const box = $('[data-ax-head]');
    if (!box) return;
    const label = S.meta?.groups?.flatMap((g) => g.items).find(([id]) => id === S.category)?.[1] || S.category;
    box.innerHTML = `<b>${esc(label)}</b><span>${S.total.toLocaleString('zh-CN')} 篇论文${S.query ? ` · 关键词「${esc(S.query)}」` : ''}</span>`;
  }

  function catLabel(id) {
    return S.meta?.groups?.flatMap((g) => g.items).find(([i]) => i === id)?.[1] || id;
  }

  function renderList() {
    const box = $('[data-ax-list]');
    if (!box) return;
    if (!S.entries.length) {
      box.innerHTML = `<div class="ax-empty">${S.error ? '抓取失败，请稍后重试' : '这个条件下没有论文，换个分类或关键词试试'}</div>`;
      return;
    }
    box.innerHTML = S.entries.map((it) => {
      const open = S.expanded.has(it.id);
      const abs = safeUrl(it.absUrl);
      const pdf = safeUrl(it.pdfUrl);
      const cats = (it.categories || []).slice(0, 5).map((c) => `<span class="ax-cat-chip" title="${esc(c)}">${esc(catLabel(c))}</span>`).join('');
      return `
        <article class="ax-item" data-ax-id="${esc(it.id)}">
          <div class="ax-item-top">
            <a class="ax-title" href="${esc(abs)}" target="_blank" rel="noopener">${esc(it.title)}</a>
            <span class="ax-date">${esc((it.published || '').slice(0, 10))}</span>
          </div>
          <div class="ax-authors">${esc(it.authorLine || '作者未列出')}</div>
          <div class="ax-chips">${cats}${it.journalRef ? `<span class="ax-jref">期刊：${esc(it.journalRef)}</span>` : ''}</div>
          <div class="ax-abs${open ? ' is-open' : ''}">${esc(it.abstract)}</div>
          <div class="ax-actions">
            <button class="dir-link" data-ax="expand">${open ? '收起摘要' : '展开摘要'}</button>
            ${abs ? `<a class="dir-link" href="${esc(abs)}" target="_blank" rel="noopener">arXiv 页 ↗</a>` : ''}
            ${pdf ? `<a class="dir-link" href="${esc(pdf)}" target="_blank" rel="noopener">PDF ↗</a>` : ''}
          </div>
        </article>`;
    }).join('');
  }

  function renderPager() {
    const box = $('[data-ax-pager]');
    if (!box) return;
    const from = S.total ? S.start + 1 : 0;
    const to = Math.min(S.start + S.perPage, S.total);
    box.innerHTML = `
      <span>${from}–${to} / ${S.total.toLocaleString('zh-CN')}</span>
      <span class="tb-spacer"></span>
      <button class="btn btn-sm" data-ax="prev"${S.start <= 0 ? ' disabled' : ''}>上一页</button>
      <button class="btn btn-sm btn-primary" data-ax="next"${S.start + S.perPage >= S.total ? ' disabled' : ''}>下一页</button>`;
  }

  window.ArxivView = { mount, close };
})();
