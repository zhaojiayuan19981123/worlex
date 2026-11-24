/* Shared navigation and dialog accessibility, independent of each view's data logic. */
(() => {
  'use strict';
  const sidebar = document.getElementById('sidebar');
  const toggle = document.getElementById('btnSidebarToggle');
  const scrim = document.getElementById('sidebarScrim');
  const main = document.querySelector('.main-area');
  const topbar = document.querySelector('.topbar');
  const narrow = window.matchMedia('(max-width: 900px)');
  const nav = [...document.querySelectorAll('.nav-item[data-view]')];
  const focusable = 'button, a[href], input, select, textarea, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
  const visible = element => element.isConnected && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const stops = root => [...root.querySelectorAll(focusable)].filter(el => !el.disabled && !el.closest('[inert]') && el.tabIndex >= 0 && visible(el));

  function setDrawer(open, restoreFocus = true) {
    open = open && narrow.matches;
    document.body.classList.toggle('sidebar-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? '\u5173\u95ed\u5bfc\u822a' : '\u6253\u5f00\u5bfc\u822a');
    toggle.title = toggle.getAttribute('aria-label');
    scrim.hidden = !open;
    refreshDialogs();
    if (activeDialogs.length) return;
    if (open) (sidebar.querySelector('.nav-item.active') || nav[0])?.focus({ preventScroll: true });
    else if (restoreFocus && narrow.matches) toggle.focus({ preventScroll: true });
  }
  toggle.addEventListener('click', () => setDrawer(!document.body.classList.contains('sidebar-open')));
  scrim.addEventListener('click', () => setDrawer(false));
  narrow.addEventListener('change', () => setDrawer(false, false));
  new ResizeObserver(() => {
    const zoom = Number.parseFloat(getComputedStyle(document.body).zoom) || 1;
    document.documentElement.style.setProperty('--shell-top', `${topbar.getBoundingClientRect().height / zoom}px`);
  }).observe(topbar);

  function syncNavigation() {
    nav.forEach(item => {
      if (item.classList.contains('active')) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });
  }
  nav.forEach((item, index) => {
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    item.addEventListener('keydown', event => {
      let target;
      if (event.key === 'ArrowDown') target = nav[(index + 1) % nav.length];
      if (event.key === 'ArrowUp') target = nav[(index + nav.length - 1) % nav.length];
      if (event.key === 'Home') target = nav[0];
      if (event.key === 'End') target = nav[nav.length - 1];
      if (target) { event.preventDefault(); target.focus(); }
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); item.click(); }
    });
    item.addEventListener('click', () => {
      if (narrow.matches) {
        setDrawer(false, false);
        const active = main.querySelector('.view:not(.hidden)');
        if (active) { active.tabIndex = -1; active.focus({ preventScroll: true }); }
      }
    });
  });
  const profile = document.getElementById('profileCard');
  profile.setAttribute('role', 'button');
  profile.tabIndex = 0;
  profile.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); profile.click(); }
  });
  profile.addEventListener('click', () => {
    if (narrow.matches) setDrawer(false, false);
  }, true);
  document.querySelector('.side-nav').setAttribute('aria-label', '\u4e3b\u5bfc\u822a');
  syncNavigation();
  const navObserver = new MutationObserver(syncNavigation);
  nav.forEach(item => navObserver.observe(item, { attributes: true, attributeFilter: ['class'] }));

  const dialogState = new Map();
  const inertState = new Map();
  const focusBeforeOpen = new WeakMap();
  const dialogTypes = [
    { root: '.modal', panel: '.modal-dialog', heading: '.modal-head h3, .modal-head h2', close: '.modal-close' },
    { root: '.si-modal-mask', panel: '.si-modal', heading: '.si-modal-head b', close: '[data-si-act="close-modal"]' },
    { root: '.ac-mask', panel: '.ac-modal', heading: '.ac-modal-head', close: '[data-close]' },
    { root: '.th-modal', panel: '.th-modal-box', heading: '.th-modal-head h3', close: '#thAskCancel, #thConfirmCancel, #thCmpClose, #thBigClose' },
    { root: '.rt-modal-backdrop', panel: '.rt-modal', heading: '.rt-modal-head h3', close: '.rt-modal-close' },
    { root: '.prp', panel: '.prp-panel', close: '#ppClose' },
    { root: '.pbp', panel: '.pbp-panel', close: '#pbpClose' },
    // Readers and portalled pickers can sit above a dialog in another view.
    { root: '.pdf-reader', close: '#prClose', escape: false },
    { root: '.thr', close: '#thrBack', escape: false },
    { root: '.ac-preview', close: '#acPvClose' },
    { root: '.ld-panel', close: '.ld-close' },
    { root: '.pl-card', close: '.pl-card-close' },
    { root: '.th-quotes', close: '#thqClose' },
  ];
  const dialogSelector = dialogTypes.map(type => type.root).join(', ');
  let activeDialogs = [];
  let dialogSequence = 0;
  let previousFocus = document.activeElement;
  document.addEventListener('focusin', event => {
    const root = event.target.closest(dialogSelector);
    if (root && !dialogState.has(root) && !focusBeforeOpen.has(root)) focusBeforeOpen.set(root, previousFocus);
    dialogState.forEach((state, element) => {
      if (element.contains(event.target)) state.lastFocus = event.target;
    });
    previousFocus = event.target;
  }, true);

  function syncInert(top) {
    const required = new Set();
    const drawerOpen = document.body.classList.contains('sidebar-open');
    const allowed = top ? [top] : drawerOpen ? [sidebar, toggle, scrim] : [];
    if (top?.matches('.ld-panel')) {
      const mask = document.querySelector('.ld-mask');
      if (mask && visible(mask)) allowed.push(mask);
    }
    // Isolate siblings along the active branches, never the dialog's ancestors.
    const branches = new Set();
    allowed.forEach(element => {
      for (let node = element; node && node !== document.body; node = node.parentElement) branches.add(node);
    });
    branches.forEach(element => {
      if (!element.parentElement || allowed.some(root => root.contains(element.parentElement))) return;
      [...element.parentElement.children].forEach(sibling => {
        if (sibling instanceof HTMLElement && !branches.has(sibling) && !sibling.matches('script, style, link')) required.add(sibling);
      });
    });
    if (narrow.matches && !drawerOpen && !sidebar.contains(top)) required.add(sidebar);
    inertState.forEach((original, element) => {
      if (!required.has(element)) {
        element.inert = original;
        inertState.delete(element);
      }
    });
    required.forEach(element => {
      if (!inertState.has(element)) inertState.set(element, element.inert);
      if (!element.inert) element.inert = true;
    });
  }

  function layerPath(element) {
    const path = [];
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      const z = Number.parseFloat(style.zIndex);
      if ((style.position !== 'static' && Number.isFinite(z)) || style.transform !== 'none'
        || Number.parseFloat(style.opacity) < 1 || style.isolation === 'isolate') path.unshift(Number.isFinite(z) ? z : 0);
    }
    return path;
  }

  function refreshDialogs() {
    const previousTop = activeDialogs.at(-1);
    const roots = [...document.querySelectorAll(dialogSelector)].filter(visible);
    roots.forEach(root => {
      const type = dialogTypes.find(type => root.matches(type.root));
      const panel = type.panel ? root.querySelector(type.panel) : root;
      if (!panel || dialogState.get(root)?.panel === panel) return;
      const heading = type.heading && panel.querySelector(type.heading);
      if (type.panel) {
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
      }
      if (!panel.hasAttribute('tabindex')) panel.tabIndex = -1;
      if (heading && !panel.hasAttribute('aria-labelledby') && !panel.hasAttribute('aria-label')) {
        if (heading.matches('.ac-modal-head')) {
          panel.setAttribute('aria-label', [...heading.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim());
        } else {
          if (!heading.id) heading.id = `interface-dialog-title-${++dialogSequence}`;
          panel.setAttribute('aria-labelledby', heading.id);
        }
      }
      panel.querySelectorAll(type.close).forEach(button => {
        if (!button.hasAttribute('aria-label') && !button.textContent.trim().replace(/[\u00d7\u2715\u2716]/g, '')) button.setAttribute('aria-label', '\u5173\u95ed');
      });
      const old = dialogState.get(root);
      const opener = root.contains(document.activeElement) ? focusBeforeOpen.get(root) : document.activeElement;
      dialogState.set(root, { panel, type, opener: old?.opener || opener, lastFocus: document.activeElement, order: ++dialogSequence });
      focusBeforeOpen.delete(root);
    });
    const closed = [...dialogState.entries()].filter(([root]) => !roots.includes(root));
    activeDialogs = roots.filter(root => dialogState.has(root)).sort((a, b) => {
      const left = layerPath(a);
      const right = layerPath(b);
      for (let index = 0; index < Math.max(left.length, right.length); index++) {
        const depth = (left[index] || 0) - (right[index] || 0);
        if (depth) return depth;
      }
      const position = a.compareDocumentPosition(b);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return dialogState.get(a).order - dialogState.get(b).order;
    });
    const top = activeDialogs.at(-1);
    syncInert(top);
    if (closed.some(([root]) => root === previousTop)) {
      let opener = dialogState.get(previousTop).opener;
      const visited = new Set();
      let parent;
      while (opener && (parent = closed.find(([root]) => root.contains(opener) && !visited.has(root)))) {
        visited.add(parent[0]);
        opener = parent[1].opener;
      }
      if (opener && visible(opener) && !opener.closest('[inert]') && !opener.disabled && (!top || top.contains(opener))) opener.focus({ preventScroll: true });
      else if (!top && narrow.matches && visible(toggle)) toggle.focus({ preventScroll: true });
    }
    closed.forEach(([root]) => { dialogState.delete(root); focusBeforeOpen.delete(root); });
    if (top && (!top.contains(document.activeElement) || document.activeElement.closest('[inert]'))) {
      const { panel, lastFocus } = dialogState.get(top);
      const target = lastFocus && panel.contains(lastFocus) && visible(lastFocus) && !lastFocus.closest('[inert]') && !lastFocus.disabled ? lastFocus : stops(panel)[0] || panel;
      target.focus({ preventScroll: true });
    }
  }
  let dialogFrame = 0;
  const scheduleDialogs = () => {
    if (dialogFrame) return;
    dialogFrame = requestAnimationFrame(() => { dialogFrame = 0; refreshDialogs(); });
  };
  new MutationObserver(records => {
    if (records.some(record => record.type === 'attributes'
      ? record.target.matches(dialogSelector) || record.target.querySelector(dialogSelector) || record.target.closest(dialogSelector)
      : record.target.closest(dialogSelector) || [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && (node.matches(dialogSelector) || node.querySelector(dialogSelector))))) scheduleDialogs();
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' && event.key !== 'Tab') return;
    refreshDialogs();
    const root = activeDialogs.at(-1);
    const drawerOpen = document.body.classList.contains('sidebar-open');
    if (!root && !drawerOpen) return;
    if (event.key === 'Escape') {
      // Full readers already use Escape for their own transient tools.
      if (root && dialogState.get(root).type.escape === false) return;
      if (event.target.tagName === 'SELECT' || event.isComposing) return;
      const close = root && [...root.querySelectorAll(dialogState.get(root).type.close)].find(button => !button.disabled && visible(button));
      if (root && !close) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (close) close.click();
      else setDrawer(false);
    }
    if (event.key === 'Tab') {
      const elements = root ? stops(dialogState.get(root).panel) : [toggle, ...stops(sidebar)];
      const first = elements[0];
      const last = elements.at(-1);
      if (!first) { event.preventDefault(); if (root) dialogState.get(root).panel.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !elements.includes(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !elements.includes(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
  }, true);
  setDrawer(false, false);
})();
