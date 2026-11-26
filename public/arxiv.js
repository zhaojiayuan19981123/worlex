/* arxiv.js —— arXiv 分类浏览 / 翻译 / 一键导入文献中心（DOM 自建，挂载约定同 direction.js） */
(() => {
  'use strict';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (msg, type = '') => window.Worlex?.toast?.(msg, type) || console.log('[arXiv]', msg);
  const safeUrl = (u) => {
    try { const x = new URL(String(u || '')); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; }
  };
  const readJson = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
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

  const TRANS_KEY = 'arxiv:translations';
  const ENGINE_KEY = 'arxiv:translateEngine';
  const DOC_TYPE_KEY = 'arxiv:targetDocType';
  const COLLECTION_KEY = 'arxiv:targetCollection';
  const LIB_TYPES = ['empirical', 'model', 'algorithm'];
  const LIB_NAMES = { empirical: '实证类文库', model: '模型类文库', algorithm: '算法类文库' };

  const S = {
    mounted: false, root: null, meta: null,
    category: 'cs.AI', query: '', sort: 'submittedDate', start: 0, perPage: 20,
    total: 0, entries: [], busy: false, expanded: new Set(), error: '',
    selected: new Set(), imported: new Set(),
    translations: readJson(TRANS_KEY, {}),
    engines: [], engine: localStorage.getItem(ENGINE_KEY) || '',
    translating: false, translateJobId: '', translateTimer: null,
    collections: [], docType: localStorage.getItem(DOC_TYPE_KEY) || 'empirical',
    collectionId: localStorage.getItem(COLLECTION_KEY) || '',
    importing: false, importJobId: '', importTimer: null, importDone: 0, importTotal: 0,
  };
  if (!LIB_TYPES.includes(S.docType)) S.docType = 'empirical';
  const $ = (sel) => S.root?.querySelector(sel);

  function mount(container) {
    S.root = container;
    if (!S.mounted) {
      container.innerHTML = skeleton();
      S.mounted = true;
      bind();
      loadEngines();
      loadCollections();
    }
    refreshMeta();
    if (S.translateJobId && S.translating) pollTranslate(S.translateJobId);
    if (S.importJobId && S.importing) pollImport(S.importJobId);
  }
  function close() { /* 保留列表与任务状态；切走页面后轮询自然结束 */ }

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
          <div class="ax-import-bar">
            <select class="tb-select ax-engine" data-ax="engine" title="翻译引擎（不使用大模型）"><option value="">翻译引擎：自动</option></select>
            <button class="btn btn-sm" data-ax="translate-selected" title="用翻译引擎翻译勾选论文的标题与摘要">批量译中文</button>
            <button class="btn btn-sm hidden" data-ax="cancel-translate">取消翻译</button>
            <span class="tb-spacer"></span>
            <select class="tb-select ax-lib" data-ax="lib" title="导入到哪个文库">
              ${LIB_TYPES.map((t) => `<option value="${t}">${LIB_NAMES[t]}</option>`).join('')}
            </select>
            <select class="tb-select ax-collection" data-ax="collection" title="分类（可选）"><option value="">未分类</option></select>
            <button class="btn btn-sm" data-ax="import-selected" title="下载 PDF 并导入上方选中的文库">下载导入勾选</button>
            <button class="btn btn-sm btn-primary" data-ax="import-page" title="逐篇下载 PDF 并导入文献中心">一键下载本页</button>
            <button class="btn btn-sm hidden" data-ax="cancel-import">取消导入</button>
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
      if (!act) return;
      const name = act.dataset.ax;
      const id = act.closest('[data-ax-id]')?.dataset.axId;
      if (name === 'search') { S.query = $('[data-ax="q"]').value.trim(); S.start = 0; load(); return; }
      if (name === 'prev') { S.start = Math.max(0, S.start - S.perPage); load(); return; }
      if (name === 'next') { S.start += S.perPage; load(); return; }
      if (name === 'expand') {
        if (S.expanded.has(id)) S.expanded.delete(id); else S.expanded.add(id);
        renderList(); return;
      }
      if (name === 'translate-one') { translateItems([id]); return; }
      if (name === 'translate-selected') { translateItems([...S.selected]); return; }
      if (name === 'cancel-translate') { cancelTranslate(); return; }
      if (name === 'import-one') { importItems([id]); return; }
      if (name === 'import-selected') { importItems([...S.selected]); return; }
      if (name === 'import-page') { importItems(S.entries.map((it) => it.id)); return; }
      if (name === 'cancel-import') { cancelImport(); return; }
      if (name === 'select-page') {
        const all = S.entries.every((it) => S.selected.has(it.id));
        S.selected = all ? new Set() : new Set(S.entries.map((it) => it.id));
        renderList(); renderHead(); return;
      }
    });
    S.root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target?.matches?.('[data-ax="q"]')) {
        e.preventDefault(); S.query = e.target.value.trim(); S.start = 0; load();
      }
    });
    S.root.addEventListener('change', (e) => {
      const t = e.target;
      if (t.matches('[data-ax="sort"]')) { S.sort = t.value; S.start = 0; load(); return; }
      if (t.matches('[data-ax="engine"]')) { S.engine = t.value; localStorage.setItem(ENGINE_KEY, S.engine); return; }
      if (t.matches('[data-ax="lib"]')) {
        S.docType = LIB_TYPES.includes(t.value) ? t.value : 'empirical';
        S.collectionId = '';
        localStorage.setItem(DOC_TYPE_KEY, S.docType);
        localStorage.setItem(COLLECTION_KEY, '');
        renderCollections(); return;
      }
      if (t.matches('[data-ax="collection"]')) {
        S.collectionId = t.value;
        localStorage.setItem(COLLECTION_KEY, S.collectionId); return;
      }
      if (t.matches('[data-ax-item]')) {
        const id = t.closest('[data-ax-id]')?.dataset.axId;
        if (!id) return;
        if (t.checked) S.selected.add(id); else S.selected.delete(id);
        renderHead(); return;
      }
    });
  }

  async function loadEngines() {
    try {
      const data = await api('/api/translate/engines');
      S.engines = data.engines || [];
    } catch { S.engines = []; }
    const box = $('[data-ax="engine"]');
    if (!box) return;
    const sorted = [...S.engines].sort((x, y) => Number(y.configured) - Number(x.configured));
    const preferred = S.engine && sorted.some((e) => e.id === S.engine) ? S.engine : '';
    box.innerHTML = `<option value="">翻译引擎：自动</option>${sorted.map((e) =>
      `<option value="${esc(e.id)}"${preferred === e.id ? ' selected' : ''}>${esc(e.label.replace(/（[^）]*）/g, ''))}${e.configured ? ' · 已配置' : ''}</option>`).join('')}`;
    box.value = preferred;
  }

  async function loadCollections() {
    try {
      S.collections = (await api('/api/collections')) || [];
    } catch { S.collections = []; }
    renderCollections();
  }

  function renderCollections() {
    const libSel = $('[data-ax="lib"]');
    const colSel = $('[data-ax="collection"]');
    if (!libSel || !colSel) return;
    libSel.value = S.docType;
    const list = S.collections.filter((c) => c.docType === S.docType);
    if (S.collectionId && !list.some((c) => c.id === S.collectionId)) S.collectionId = '';
    colSel.innerHTML = '<option value="">未分类</option>' + list.map((c) =>
      `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    colSel.value = S.collectionId;
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
      const ids = new Set(S.entries.map((it) => it.id));
      S.selected = new Set([...S.selected].filter((id) => ids.has(id)));
      if (!S.selected.size) S.selected = ids;
      S.error = '';
      banner('');
      renderAll();
    } catch (e) {
      S.error = e.message;
      S.entries = []; S.total = 0; S.selected.clear();
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

  function renderAll() { renderHead(); renderList(); renderPager(); }

  function renderHead() {
    const box = $('[data-ax-head]');
    if (!box) return;
    const label = S.meta?.groups?.flatMap((g) => g.items).find(([id]) => id === S.category)?.[1] || S.category;
    box.innerHTML = `<b>${esc(label)}</b><span>${S.total.toLocaleString('zh-CN')} 篇论文${S.query ? ` · 关键词「${esc(S.query)}」` : ''} · 已勾选 ${S.selected.size}</span>
      <span class="tb-spacer"></span><button class="dir-link" data-ax="select-page">${S.entries.every((it) => S.selected.has(it.id)) ? '取消全选本页' : '全选本页'}</button>`;
    const btn = $('[data-ax="translate-selected"]');
    if (btn) { btn.disabled = S.translating || !S.selected.size; btn.textContent = S.translating ? '翻译中…' : '批量译中文'; }
    const cancel = $('[data-ax="cancel-translate"]');
    if (cancel) cancel.classList.toggle('hidden', !S.translating);
    const importBtn = $('[data-ax="import-selected"]');
    if (importBtn) {
      importBtn.disabled = S.importing || !S.selected.size;
      importBtn.textContent = S.importing ? '下载导入中…' : '下载导入勾选';
    }
    const pageBtn = $('[data-ax="import-page"]');
    if (pageBtn) {
      pageBtn.disabled = S.importing || !S.entries.length;
      pageBtn.textContent = S.importing ? '下载导入中…' : '一键下载本页';
    }
    const cancelImportBtn = $('[data-ax="cancel-import"]');
    if (cancelImportBtn) cancelImportBtn.classList.toggle('hidden', !S.importing);
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
      const tr = S.translations[it.id] || {};
      const cats = (it.categories || []).slice(0, 5).map((c) => `<span class="ax-cat-chip" title="${esc(c)}">${esc(catLabel(c))}</span>`).join('');
      return `
        <article class="ax-item${S.selected.has(it.id) ? ' is-selected' : ''}" data-ax-id="${esc(it.id)}">
          <div class="ax-item-top">
            <label class="ax-check"><input type="checkbox" data-ax-item ${S.selected.has(it.id) ? 'checked' : ''} aria-label="选择这篇论文"></label>
            <a class="ax-title" href="${esc(abs)}" target="_blank" rel="noopener">${esc(tr.titleZh || it.title)}</a>
            ${tr.titleZh ? '<span class="ax-zh-badge">中</span>' : ''}
            ${S.imported.has(it.id) ? '<span class="ax-imported-badge" title="PDF 已下载到文献中心">PDF 已入库</span>' : ''}
            <span class="ax-date">${esc((it.published || '').slice(0, 10))}</span>
          </div>
          ${tr.titleZh ? `<div class="ax-origin">${esc(it.title)}</div>` : ''}
          <div class="ax-authors">${esc(it.authorLine || '作者未列出')}</div>
          <div class="ax-chips">${cats}${it.journalRef ? `<span class="ax-jref">期刊：${esc(it.journalRef)}</span>` : ''}</div>
          <div class="ax-abs${open ? ' is-open' : ''}">${esc(tr.abstractZh || it.abstract)}</div>
          <div class="ax-actions">
            <button class="dir-link" data-ax="expand">${open ? '收起摘要' : '展开摘要'}</button>
            <button class="dir-link" data-ax="translate-one" title="用翻译引擎译成中文">${tr.titleZh ? '重译' : '译中文'}</button>
            <button class="dir-link" data-ax="import-one" title="导入到上方选中的文库">导入</button>
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

  function saveTranslations() {
    try { localStorage.setItem(TRANS_KEY, JSON.stringify(S.translations)); } catch { /* 存储满时只影响本次会话 */ }
  }

  function applyTranslations(byId) {
    let ok = 0, errors = 0;
    for (const [id, out] of Object.entries(byId || {})) {
      const prev = S.translations[id] || {};
      if (out.titleZh) prev.titleZh = out.titleZh;
      if (out.abstractZh) prev.abstractZh = out.abstractZh;
      if (out.error) errors += 1; else if (out.titleZh || out.abstractZh) ok += 1;
      S.translations[id] = prev;
    }
    if (ok) saveTranslations();
    renderList();
    return { ok, errors };
  }

  async function translateItems(ids) {
    if (S.translating) return;
    const picked = [...new Set(ids.filter(Boolean))]
      .map((id) => S.entries.find((it) => it.id === id))
      .filter(Boolean)
      .slice(0, S.meta?.limits?.maxTranslate || 50);
    if (!picked.length) { toast('请先勾选要翻译的论文', 'error'); return; }
    S.translating = true;
    renderHead();
    banner(`正在用翻译引擎翻译 ${picked.length} 篇论文…（不走大模型）`, 'info', true);
    try {
      const data = await api('/api/arxiv/translate', {
        method: 'POST',
        body: {
          items: picked.map((it) => ({ id: it.id, title: it.title, abstract: it.abstract })),
          engine: S.engine || undefined,
        },
      });
      S.translateJobId = data.jobId;
      pollTranslate(data.jobId);
    } catch (e) {
      S.translating = false; S.translateJobId = '';
      renderHead(); banner(e.message, 'error');
    }
  }

  function pollTranslate(jobId) {
    clearTimeout(S.translateTimer);
    const tick = async () => {
      try {
        const job = await api(`/api/arxiv/translate/job/${encodeURIComponent(jobId)}`);
        if (job.byId && Object.keys(job.byId).length) applyTranslations(job.byId);
        if (job.status === 'running') {
          const pct = job.total ? Math.round(job.done / job.total * 100) : 0;
          banner(`翻译引擎处理中：${job.done} / ${job.total} 段（${pct}%）。免费接口有频率限制，批量会慢一些…`, 'info', true);
          S.translateTimer = setTimeout(tick, 1000);
          return;
        }
        clearTimeout(S.translateTimer);
        S.translating = false; S.translateJobId = '';
        renderHead();
        if (job.status === 'done') {
          const { ok, errors } = applyTranslations(job.byId);
          toast(ok ? `已翻译 ${ok} 篇${errors ? `，${errors} 篇失败（可改用已配密钥的引擎重试）` : ''}` : '没有译出内容，请换一个翻译引擎重试', ok ? 'ok' : 'error');
          banner('');
        } else banner(job.error || '翻译失败', 'error');
      } catch (e) {
        clearTimeout(S.translateTimer);
        S.translating = false; S.translateJobId = '';
        renderHead(); banner(e.message, 'error');
      }
    };
    tick();
  }

  async function cancelTranslate() {
    if (!S.translateJobId) return;
    try { await api(`/api/arxiv/translate/job/${encodeURIComponent(S.translateJobId)}/cancel`, { method: 'POST', body: {} }); } catch { /* ignore */ }
    clearTimeout(S.translateTimer);
    S.translating = false; S.translateJobId = '';
    renderHead(); banner('已取消翻译', 'warn');
  }

  async function importItems(ids) {
    if (S.importing) return;
    const picked = [...new Set(ids.filter(Boolean))]
      .map((id) => S.entries.find((it) => it.id === id))
      .filter(Boolean)
      .slice(0, S.meta?.limits?.maxImport || 50);
    if (!picked.length) { toast('请先勾选要导入的论文', 'error'); return; }
    S.importing = true;
    S.importDone = 0; S.importTotal = picked.length;
    renderHead();
    banner(`正在下载 PDF 并导入 ${picked.length} 篇到${LIB_NAMES[S.docType]}…`, 'info', true);
    try {
      const data = await api('/api/arxiv/import', {
        method: 'POST',
        body: {
          items: picked.map((it) => ({ ...it, ...(S.translations[it.id] || {}) })),
          docType: S.docType,
          collectionId: S.collectionId || null,
        },
      });
      S.importJobId = data.jobId;
      pollImport(data.jobId);
    } catch (e) {
      S.importing = false; S.importJobId = '';
      banner(e.message, 'error');
      renderHead();
    }
  }

  function pollImport(jobId) {
    clearTimeout(S.importTimer);
    const tick = async () => {
      if (S.importJobId !== jobId || !S.importing) return;
      try {
        const job = await api(`/api/arxiv/import/job/${encodeURIComponent(jobId)}`);
        S.importDone = job.done; S.importTotal = job.total;
        if (job.status === 'running') {
          banner(`正在下载 PDF 并导入：${job.done}/${job.total} 篇（成功 ${job.imported}，跳过 ${job.skipped.length}，失败 ${job.errors.length}）`, 'info', true);
          S.importTimer = setTimeout(tick, 1200);
          return;
        }
        clearTimeout(S.importTimer);
        S.importing = false; S.importJobId = '';
        for (const rec of job.records || []) {
          S.imported.add(rec.arxivId || rec.id);
          const item = S.entries.find((it) => it.id === rec.arxivId);
          if (item) S.imported.add(item.id);
        }
        renderList(); renderHead();
        if (job.status === 'done') {
          const parts = [`成功 ${job.imported} 篇`];
          if (job.skipped.length) parts.push(`跳过重复 ${job.skipped.length} 篇`);
          if (job.errors.length) parts.push(`失败 ${job.errors.length} 篇`);
          toast(parts.join('，'), job.errors.length ? 'warn' : 'ok');
          banner(job.errors.length ? `${job.errors[0].title}：${job.errors[0].error}` : `已下载 PDF 并入库 ${job.imported} 篇`, job.errors.length ? 'warn' : 'ok');
        } else {
          banner(job.error || '导入失败', 'error');
        }
        setTimeout(() => banner(''), 5000);
      } catch (e) {
        clearTimeout(S.importTimer);
        S.importing = false; S.importJobId = '';
        renderHead(); banner(e.message, 'error');
      }
    };
    tick();
  }

  async function cancelImport() {
    if (!S.importJobId) return;
    try { await api(`/api/arxiv/import/job/${encodeURIComponent(S.importJobId)}/cancel`, { method: 'POST', body: {} }); } catch { /* ignore */ }
    clearTimeout(S.importTimer);
    S.importing = false; S.importJobId = '';
    renderHead(); banner('已取消导入', 'warn');
  }

  window.ArxivView = { mount, close };
})();
