// lit-drawer.js —— 阅读器「目录」侧边抽屉
// 旧版抽屉挂在 .pr-body 里，而对照精读会把 .pr-body 整块 display:none，
// 导致点目录毫无反应。这里改成挂在 body 上的独立浮层，两种读法都能弹出；
// 同时把「同一文库内其他文献」做成可搜索、可一键切换的列表。
(function () {
  'use strict';

  const LIB_ORDER = ['empirical', 'model', 'algorithm'];
  const LIB_LABELS = { empirical: '实证类文库', model: '模型类文库', algorithm: '算法类文库' };

  let root = null;
  let mask = null;
  let listBox = null;
  let searchBox = null;
  let headBox = null;
  let state = { items: [], currentId: '', docType: '', open: false, onPick: null, onClose: null, query: '' };

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  /** 英文标题 + 换行中文译名；已是中文标题时不重复显示 */
  function titleBlock(it) {
    const en = String(it?.title || it?.originalName || '未命名').trim();
    const zh = String(it?.titleZh || '').trim();
    const hasCJK = /[\u4e00-\u9fff]/.test(en);
    const showZh = zh && zh !== en && !hasCJK;
    return { en, zh: showZh ? zh : '' };
  }

  function ensureDom() {
    if (root) return;
    mask = document.createElement('div');
    mask.className = 'ld-mask hidden';
    mask.setAttribute('aria-hidden', 'true');

    root = document.createElement('aside');
    root.className = 'ld-panel hidden';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'false');
    root.setAttribute('aria-label', '文献目录');
    root.innerHTML = [
      '<div class="ld-head">',
      '  <div class="ld-head-top"><span class="ld-title">目录</span>',
      '    <button class="ld-close" type="button" aria-label="关闭目录">',
      '      <svg class="ico" aria-hidden="true"><use href="#i-x"/></svg></button></div>',
      '  <div class="ld-current" id="ldCurrent"></div>',
      '  <label class="ld-search-wrap"><span class="ld-search-label">搜索文献</span>',
      '    <input class="ld-search" type="search" placeholder="标题 / 中文译名 / 作者 / 期刊" /></label>',
      '</div>',
      '<div class="ld-list" id="ldList"></div>',
      '<div class="ld-foot" id="ldFoot"></div>',
    ].join('');
    document.body.appendChild(mask);
    document.body.appendChild(root);

    headBox = root.querySelector('#ldCurrent');
    listBox = root.querySelector('#ldList');
    searchBox = root.querySelector('.ld-search');
    root.querySelector('.ld-close').addEventListener('click', close);
    mask.addEventListener('click', close);
    searchBox.addEventListener('input', () => { state.query = searchBox.value.trim().toLowerCase(); render(); });
    listBox.addEventListener('click', (e) => {
      const row = e.target.closest('[data-ld-id]');
      if (!row) return;
      const id = row.dataset.ldId;
      if (!id || id === state.currentId) { close(); return; }
      const fn = state.onPick || window.Worlex?.openLiterature;
      close();
      if (typeof fn === 'function') Promise.resolve(fn(id)).catch(() => {});
    });
    document.addEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key !== 'Escape' || !state.open) return;
    close();
    e.stopPropagation();
  }

  function render() {
    if (!root) return;
    const items = Array.isArray(state.items) ? state.items : [];
    const current = items.find((it) => it?.id === state.currentId) || null;
    const cur = titleBlock(current);
    headBox.innerHTML = current
      ? `<div class="ld-cur-label">正在阅读</div><div class="ld-cur-title">${esc(cur.en)}</div>${cur.zh ? `<div class="ld-cur-zh">${esc(cur.zh)}</div>` : ''}`
      : '<div class="ld-cur-label">正在阅读</div><div class="ld-cur-title">未打开文献</div>';

    const q = state.query;
    const match = (it) => [it?.title, it?.titleZh, it?.authors, it?.journal, it?.year, it?.originalName]
      .map((v) => String(v || '')).join(' ').toLowerCase().includes(q);
    // 当前文库排在最前，其它文库折叠在后面 —— 主要目标是「同一文库内快速切换」
    const types = [...LIB_ORDER];
    if (state.docType && types.includes(state.docType)) {
      types.splice(types.indexOf(state.docType), 1);
      types.unshift(state.docType);
    }
    let total = 0;
    const blocks = [];
    for (const type of types) {
      const list = items
        .filter((it) => it?.id && it?.filename && (it.docType || 'empirical') === type)
        .filter((it) => !q || match(it))
        .sort((a, b) => String(a.title || a.originalName || '').localeCompare(String(b.title || b.originalName || ''), 'zh'));
      if (!list.length) continue;
      total += list.length;
      const sameLib = type === (state.docType || 'empirical');
      blocks.push(`<div class="ld-group${sameLib ? ' ld-group-current' : ''}">` +
        `<div class="ld-group-head"><span>${esc(LIB_LABELS[type] || '文献')}</span>` +
        `<span class="ld-group-count">${list.length}${sameLib ? ' · 当前文库' : ''}</span></div>` +
        list.map((it) => {
          const t = titleBlock(it);
          const sub = [it.authors, it.journal, it.year].map((v) => String(v || '').trim()).filter(Boolean).join(' · ');
          return `<button type="button" class="ld-item${it.id === state.currentId ? ' active' : ''}" data-ld-id="${esc(it.id)}">` +
            `<span class="ld-item-title">${esc(t.en)}</span>` +
            (t.zh ? `<span class="ld-item-zh">${esc(t.zh)}</span>` : '') +
            (sub ? `<span class="ld-item-sub">${esc(sub)}</span>` : '') +
            (it.id === state.currentId ? '<span class="ld-item-now">正在阅读</span>' : '') +
            '</button>';
        }).join('') + '</div>');
    }
    listBox.innerHTML = blocks.length ? blocks.join('') :
      `<div class="ld-empty">${q ? '没有匹配的文献' : '文献库里还没有可阅读的 PDF'}</div>`;
    root.querySelector('#ldFoot').textContent = total ? `共 ${total} 篇 · 点击即切换` : '';
  }

  function open(opts) {
    ensureDom();
    const o = opts || {};
    state.items = Array.isArray(o.items) ? o.items : [];
    state.currentId = String(o.currentId || '');
    state.docType = String(o.docType || '');
    state.onPick = typeof o.onPick === 'function' ? o.onPick : null;
    // 关闭可能来自遮罩 / Esc / 选文献，而不只是目录按钮；用回调把阅读器里的 pr.dirOpen 同步回来，
    // 否则下一次点「目录」会按旧状态执行关闭，看起来像按钮失灵（对照精读下尤其明显）。
    state.onClose = typeof o.onClose === 'function' ? o.onClose : null;
    state.query = '';
    if (searchBox) searchBox.value = '';
    render();
    mask.classList.remove('hidden');
    root.classList.remove('hidden');
    document.body.classList.add('ld-open');
    state.open = true;
    const btn = document.getElementById('prDirToggle');
    if (btn) btn.classList.add('active');
    setTimeout(() => searchBox?.focus(), 40);
  }

  function close() {
    if (!root) return;
    const wasOpen = state.open;
    root.classList.add('hidden');
    mask.classList.add('hidden');
    document.body.classList.remove('ld-open');
    state.open = false;
    const btn = document.getElementById('prDirToggle');
    if (btn) btn.classList.remove('active');
    // 只在「真的从展开变收起」时回调一次；setPrDir(false) 会再次调用 close()，此时不能重入。
    if (wasOpen && typeof state.onClose === 'function') {
      const fn = state.onClose;
      state.onClose = null;
      try { fn(); } catch (_) { /* 状态同步失败不影响收起动画 */ }
    }
  }

  function toggle(opts) {
    if (state.open) close();
    else open(opts);
  }

  const api = { open, close, toggle, render, titleBlock, isOpen: () => state.open };
  if (typeof window !== 'undefined') window.LitDrawer = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
