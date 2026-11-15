/**
 * PDF 链接层：把 pdf.js 注释链接与文中 URL / DOI 铺成可点热区。
 * 内部跳页、外链新窗口、DOI 弹信息卡（可复制到剪贴板 / 添加到文献库）。
 * 仅依赖 window.Worlex 全局桥，所有成员做存在性判断，缺失时优雅降级。
 * 对外导出 render(page, viewport, wrap, pageNum) / clear(wrap)。
 */
(() => {
  'use strict';

  // 当前打开的 DOI 信息卡（全局只保留一张）。
  let ACTIVE = null;

  /* ------------------------------------------------------------------
   * 全局桥与通用小工具
   * ------------------------------------------------------------------ */

  function bridge(name) {
    const w = typeof window !== 'undefined' ? window.Worlex : null;
    if (!w || typeof w[name] !== 'function') return null;
    return (...args) => {
      try { return w[name](...args); } catch (_) { return undefined; }
    };
  }

  function toast(msg, kind) {
    const fn = bridge('toast');
    if (fn) fn(msg, kind);
  }

  function currentDocName() {
    const el = document.getElementById('prFilename');
    const t = el && el.textContent ? el.textContent.trim() : '';
    if (t) return t;
    const dt = typeof document !== 'undefined' && document.title ? document.title.trim() : '';
    return dt || '阅读器文献';
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = String(text);
    return node;
  }

  async function copyText(text) {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { /* 退回 execCommand */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch (_) {
      return false;
    }
  }

  /** 优先复用项目里的 DoiUtils；没有时用同样的规则本地归一化。 */
  function normalizeDoi(raw) {
    const utils = typeof window !== 'undefined' ? window.DoiUtils : null;
    if (utils && typeof utils.normalizeDoi === 'function') {
      try {
        const v = utils.normalizeDoi(raw);
        if (v) return String(v);
      } catch (_) { /* 继续本地兜底 */ }
    }
    let s = String(raw == null ? '' : raw).trim();
    s = s.replace(/^doi:\s*/i, '');
    s = s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
    s = s.replace(/[.,;)\]]+$/, '');
    return s.trim();
  }

  function isDoi(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (/^https?:\/\/(dx\.)?doi\.org\//i.test(s)) return true;
    if (/^doi:\s*10\./i.test(s)) return true;
    return /^10\.\d{1,9}\/\S+/.test(normalizeDoi(s));
  }

  /* ------------------------------------------------------------------
   * 热区
   * ------------------------------------------------------------------ */

  /** 视口矩形 [x1,y1,x2,y2] → 页内 CSS 像素盒，不再做二次换算。 */
  function viewportBox(viewport, rect) {
    if (!viewport || typeof viewport.convertToViewportRectangle !== 'function') return null;
    let box;
    try { box = viewport.convertToViewportRectangle(rect); } catch (_) { return null; }
    if (!box || !Array.isArray(box) || box.length < 4) return null;
    const a = Number(box[0]) || 0;
    const b = Number(box[1]) || 0;
    const c = Number(box[2]) || 0;
    const d = Number(box[3]) || 0;
    const x1 = Math.min(a, c);
    const x2 = Math.max(a, c);
    const y1 = Math.min(b, d);
    const y2 = Math.max(b, d);
    if (!(x2 - x1 > 0) || !(y2 - y1 > 0)) return null;
    return { left: x1, top: y1, w: x2 - x1, h: y2 - y1 };
  }

  function overlaps(a, b) {
    const iw = Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l));
    const ih = Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
    const small = Math.min((a.r - a.l) * (a.b - a.t), (b.r - b.l) * (b.b - b.t));
    return small > 0 && (iw * ih) / small > 0.6;
  }

  function addHot(layer, info, boxes) {
    const a = document.createElement('a');
    a.className = 'pl-hot';
    a.setAttribute('role', 'link');
    a.setAttribute('tabindex', '0');
    // 不使用 href：避免 unsafeUrl 里的 javascript: 之类的伪协议造成注入。
    a.setAttribute('aria-label', info.label || ('链接：' + (info.text || '未知目标')));
    a.style.left = Math.max(0, Math.round(info.left)) + 'px';
    a.style.top = Math.max(0, Math.round(info.top)) + 'px';
    a.style.width = Math.max(1, Math.round(info.w)) + 'px';
    a.style.height = Math.max(1, Math.round(info.h)) + 'px';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onActivate(info, a);
    });
    a.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onActivate(info, a);
      }
    });
    layer.appendChild(a);
    boxes.push({ l: info.left, t: info.top, r: info.left + info.w, b: info.top + info.h });
  }

  /** 扫文字层 span，给文中裸 URL / DOI 也铺一个热区。 */
  function addInlineHots(layer, wrap, pageNum, boxes) {
    const textLayer = wrap.querySelector('.pr-text-layer');
    if (!textLayer) return;
    const wr = wrap.getBoundingClientRect();
    const re = /(https?:\/\/\S+|10\.\d{4,9}\/\S+)/i;
    const spans = textLayer.querySelectorAll('span');
    for (let i = 0; i < spans.length; i++) {
      const text = spans[i].textContent || '';
      const m = re.exec(text);
      if (!m) continue;
      const raw = m[0].replace(/[.,;)\]]+$/, '').trim();
      if (!raw) continue;
      const sr = spans[i].getBoundingClientRect();
      if (!sr.width || !sr.height) continue;
      const box = {
        l: sr.left - wr.left, t: sr.top - wr.top,
        r: sr.right - wr.left, b: sr.bottom - wr.top,
      };
      let duplicate = false;
      for (let j = 0; j < boxes.length; j++) {
        if (overlaps(box, boxes[j])) { duplicate = true; break; }
      }
      if (duplicate) continue;
      addHot(layer, {
        url: raw,
        text: text.trim(),
        label: '文中链接：' + text.trim(),
        left: box.l,
        top: box.t,
        w: box.r - box.l,
        h: box.b - box.t,
        pageNum,
        inline: true,
      }, boxes);
    }
  }

  /* ------------------------------------------------------------------
   * 文档内跳转（参考文献 / 引文标记 / 图表编号）
   *
   * PDF 里「[1]」这种引文标记不是 URL，而是一条 Link 注释：
   *   dest = 'bib51'（命名目标）或 [页引用, {name:'FitR'}, x1,y1,x2,y2]（显式目标）。
   * 旧实现只认字符串 dest，于是点上去一律弹「暂不支持该链接类型」。
   * 现在按 pdf.js 自己的规则解析：命名目标先 getDestination(name)，
   * 再 getPageIndex(第一项) 得到页码；FitR / XYZ 的坐标用来精确落位。
   * ------------------------------------------------------------------ */

  function readerDoc() {
    const w = typeof window !== 'undefined' ? window.Worlex : null;
    if (!w || typeof w.pdfDoc !== 'function') return null;
    try { return w.pdfDoc() || null; } catch (_) { return null; }
  }

  /** 目标数组 → PDF 用户坐标矩形；只给单点（XYZ）时返回零高矩形，仅用于纵向定位。 */
  function destRect(arr) {
    if (!Array.isArray(arr) || arr.length < 3) return null;
    const kind = arr[1] && typeof arr[1] === 'object' ? String(arr[1].name || '') : '';
    if (kind === 'FitR' && arr.length >= 6) {
      const n = arr.slice(2, 6).map(Number);
      if (n.every(Number.isFinite)) return [n[0], n[1], n[2], n[3]];
    }
    if (kind === 'XYZ') {
      const top = Number(arr[3]);
      if (Number.isFinite(top)) {
        const left = Number.isFinite(Number(arr[2])) ? Number(arr[2]) : 0;
        return [left, top, left + 1, top + 1];
      }
    }
    return null;
  }

  /** dest（命名目标字符串 / 显式数组）→ { page（1 起）, rect（PDF 坐标，可能为 null） }。 */
  async function resolveDest(dest) {
    const doc = readerDoc();
    if (!doc) return null;
    let arr = dest;
    if (typeof arr === 'string') {
      try { arr = await doc.getDestination(arr); } catch (_) { arr = null; }
    }
    if (!Array.isArray(arr) || !arr.length) return null;
    let pageIndex = -1;
    try {
      pageIndex = typeof arr[0] === 'number'
        ? arr[0]
        : await doc.getPageIndex(arr[0]);
    } catch (_) { return null; }
    if (!Number.isFinite(pageIndex) || pageIndex < 0) return null;
    return { page: pageIndex + 1, rect: destRect(arr) };
  }

  /** 等页面容器就位（切换文献 / 懒渲染时可能还没建出来）。 */
  function waitPageWrap(pageNum, timeoutMs) {
    const wrapOf = bridge('pageWrap');
    if (!wrapOf) return Promise.resolve(null);
    const deadline = Date.now() + Math.max(200, timeoutMs || 1200);
    return new Promise((resolve) => {
      const tick = () => {
        const w = wrapOf(pageNum);
        if (w) { resolve(w); return; }
        if (Date.now() >= deadline) { resolve(null); return; }
        setTimeout(tick, 80);
      };
      tick();
    });
  }

  /** 把目标位置滚到阅读区上方约 1/4 处，而不是页面顶端（引文条目通常靠页脚）。 */
  function scrollToBox(wrap, box) {
    const host = document.getElementById('prPages');
    if (!host) return;
    const wr = wrap.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    const base = host.scrollTop + (wr.top - hr.top);
    const y = base + (box ? box.top : 0) - Math.round(host.clientHeight * 0.26);
    try { host.scrollTo({ top: Math.max(0, y), behavior: 'smooth' }); }
    catch (_) { host.scrollTop = Math.max(0, y); }
  }

  /**
   * 目标处闪一下半透明框：让用户一眼看到「跳到哪一条」。
   *
   * 这里不能「挂上去就不管」：跳转用的页目标往往在视口外，是滚动到位之后才被
   * 懒渲染的，而 renderPageInto 开头会 wrap.innerHTML = ''（连同占位符一起重画），
   * 刚挂好的框在同一帧内就被清掉了。等渲染结束再挂也不行 —— 平滑滚动耗时不定，
   * 渲染可能比预估更晚才开始。
   * 所以改成盯住容器：只要框被清走就补挂回去，直到它按动画时长自然退场。
   * 坐标跟着页面走（占位符与真页同尺寸），补挂后位置依然准确。
   */
  function flash(wrap, box) {
    const mark = el('div', 'pl-dest-mark');
    mark.style.left = Math.max(0, Math.round(box.left - 3)) + 'px';
    mark.style.top = Math.max(0, Math.round(box.top - 2)) + 'px';
    mark.style.width = Math.max(6, Math.round(box.w + 6)) + 'px';
    mark.style.height = Math.max(6, Math.round(box.h + 4)) + 'px';
    wrap.appendChild(mark);
    const keep = () => { if (!mark.isConnected) wrap.appendChild(mark); };
    let mo = null;
    if (typeof MutationObserver === 'function') {
      mo = new MutationObserver(keep);
      mo.observe(wrap, { childList: true });
    }
    setTimeout(() => {
      // 先停观察再摘框：否则 remove() 本身会触发回调，又把框挂回去
      if (mo) mo.disconnect();
      if (mark.parentNode) mark.remove();
    }, 2400);
  }

  async function gotoDest(dest) {
    const doc = readerDoc();
    if (!doc) { toast('请先打开一篇文献，再点文档内的链接', 'info'); return; }
    let target = null;
    try { target = await resolveDest(dest); } catch (_) { target = null; }
    if (!target) { toast('这条链接没有指向文档内的位置', 'info'); return; }
    const go = bridge('gotoPage');
    if (go) go(target.page);
    const wrap = await waitPageWrap(target.page, 1500);
    if (!wrap) return;
    let box = null;
    if (target.rect) {
      try {
        const page = await doc.getPage(target.page);
        const vp = bridge('viewport') ? bridge('viewport')(page, target.page) : null;
        if (vp && typeof vp.convertToViewportRectangle === 'function') {
          const r = vp.convertToViewportRectangle(target.rect);
          box = {
            left: Math.min(r[0], r[2]), top: Math.min(r[1], r[3]),
            w: Math.abs(r[2] - r[0]), h: Math.abs(r[3] - r[1]),
          };
          // 很多 PDF 的 FitR 目标只是一条基线（y1 === y2），换算出来高度是 0，
          // 退化成一根几像素的细条，看着像误画的下划线而不是「跳到这里」。
          // 不足一行文字时按一行补（10 个 PDF 单位 ≈ 一行正文的高度）。
          if (box.h < 8) box.h = Math.max(10, Math.round(10 * (vp.scale || 1)));
        }
      } catch (_) { box = null; }
    }
    scrollToBox(wrap, box);
    if (box) flash(wrap, box);
  }

  function onActivate(info, anchor) {
    const raw = String(info.url || info.text || '').trim();
    // DOI 优先于普通 http(s)：doi.org 链接要弹信息卡而不是直接跳走。
    if (raw && isDoi(raw)) {
      if (ACTIVE && ACTIVE.anchor === anchor) { closeCard(); return; }
      openDoiCard(raw, info, anchor);
      return;
    }
    const m = /^#p(\d+)$/i.exec(raw) || /^#page=(\d+)$/i.exec(raw);
    if (m) {
      const go = bridge('gotoPage');
      if (go) go(parseInt(m[1], 10));
      else toast('无法跳转到第 ' + m[1] + ' 页', 'error');
      return;
    }
    if (/^https?:\/\//i.test(raw)) {
      try { window.open(raw, '_blank', 'noopener,noreferrer'); }
      catch (_) { toast('无法打开链接', 'error'); }
      return;
    }
    // 文档内跳转：注释带的命名目标 / 显式目标
    if (info.dest != null) { gotoDest(info.dest); return; }
    if (info.fromLink && raw) { gotoDest(raw); return; }
    toast('暂不支持该链接类型', 'info');
  }

  /* ------------------------------------------------------------------
   * DOI 信息卡
   * ------------------------------------------------------------------ */

  function closeCard() {
    if (!ACTIVE) return;
    document.removeEventListener('pointerdown', ACTIVE.onDown, true);
    document.removeEventListener('keydown', ACTIVE.onKey, true);
    if (ACTIVE.root && ACTIVE.root.parentNode) ACTIVE.root.remove();
    ACTIVE = null;
  }

  function setMsg(text, isError) {
    if (!ACTIVE) return;
    const m = ACTIVE.msg;
    m.textContent = String(text || '');
    m.classList.toggle('error', !!isError);
    m.classList.toggle('ok', !isError && !!text);
  }

  function cardRow(label, value, cls) {
    const row = el('div', 'pl-card-row');
    row.appendChild(el('span', 'pl-card-k', label));
    row.appendChild(el('div', 'pl-card-v ' + cls, value == null ? '' : String(value)));
    return row;
  }

  function cardBtn(text, cls, fn) {
    const b = el('button', 'pl-btn' + (cls ? ' ' + cls : ''), text);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }

  function positionCard(card, anchor) {
    const r = anchor.getBoundingClientRect();
    const cw = card.offsetWidth || 300;
    const ch = card.offsetHeight || 200;
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    let left = r.left;
    let top = r.bottom + 8;
    if (left + cw > vw - 12) left = Math.max(12, vw - cw - 12);
    if (top + ch > vh - 12) top = Math.max(12, r.top - ch - 8);
    card.style.left = Math.max(12, Math.round(left)) + 'px';
    card.style.top = Math.max(12, Math.round(top)) + 'px';
  }

  function openDoiCard(raw, info, anchor) {
    closeCard();
    const stray = document.querySelector('.pl-card');
    if (stray) stray.remove();

    const doi = normalizeDoi(raw);
    const openUrl = /^https?:\/\//i.test(raw) ? raw : 'https://doi.org/' + encodeURI(doi);
    const origText = String(info.text || raw).trim();

    const card = el('div', 'pl-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'DOI 信息');

    const head = el('div', 'pl-card-head');
    head.appendChild(el('span', '', '文献 DOI'));
    const close = cardBtn('关闭', 'pl-card-close', (e) => {
      e.preventDefault();
      closeCard();
    });
    close.setAttribute('aria-label', '关闭 DOI 信息卡');
    head.appendChild(close);
    card.appendChild(head);

    card.appendChild(cardRow('原文链接文字', origText, 'pl-card-orig'));
    card.appendChild(cardRow('规范化 DOI', doi || '（未识别）', 'pl-card-doi'));

    const actions = el('div', 'pl-card-actions');
    const bOpen = cardBtn('在浏览器打开', '', () => {
      try { window.open(openUrl, '_blank', 'noopener,noreferrer'); }
      catch (_) { setMsg('无法打开链接，请检查系统浏览器设置', true); }
    });
    const bCopy = cardBtn('复制', '', async () => {
      const ok = await copyText(doi || raw);
      setMsg(ok ? '已复制 DOI' : '复制失败，请手动选中复制', !ok);
      toast(ok ? '已复制 DOI' : '复制失败', ok ? 'success' : 'error');
    });
    const bAdd = cardBtn('添加到文献库', 'primary', () => addToLibrary(doi, origText));
    actions.append(bOpen, bCopy, bAdd);
    card.appendChild(actions);

    const msg = el('div', 'pl-card-msg');
    msg.setAttribute('aria-live', 'polite');
    card.appendChild(msg);

    document.body.appendChild(card);
    positionCard(card, anchor);

    const onDown = (e) => {
      if (card.contains(e.target)) return;
      if (ACTIVE && ACTIVE.anchor && ACTIVE.anchor.contains(e.target)) return;
      closeCard();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeCard(); }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    ACTIVE = { root: card, anchor, onDown, onKey, msg, addBtn: bAdd };
    close.focus();
  }

  async function addToLibrary(doi, title) {
    const api = bridge('api');
    if (!api) {
      setMsg('当前环境不支持添加到文献库', true);
      toast('添加到文献库失败：接口不可用', 'error');
      return;
    }
    if (ACTIVE && ACTIVE.addBtn) {
      ACTIVE.addBtn.disabled = true;
      ACTIVE.addBtn.textContent = '添加中…';
    }
    const payload = {
      title: title || doi,
      doi,
      originalName: currentDocName(),
    };
    try {
      let res = await api('/api/literature', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      let data = res;
      if (res && typeof res.json === 'function') data = await res.json();
      const failed = !res
        || res.ok === false
        || (data && (data.ok === false || data.success === false || data.error))
        || (typeof res.status === 'number' && res.status >= 400);
      if (failed) {
        const why = (data && (data.message || data.error)) || (res && res.statusText) || '接口未返回成功';
        throw new Error(String(why));
      }
      setMsg('已添加到文献库', false);
      toast('已添加到文献库', 'success');
      closeCard();
    } catch (err) {
      const why = err && err.message ? err.message : '网络异常';
      // 接口失败必须给出可见的友好错误，不能静默。
      setMsg('添加失败：' + why + '，请检查网络或稍后再试', true);
      toast('添加到文献库失败：' + why, 'error');
      if (ACTIVE && ACTIVE.addBtn) {
        ACTIVE.addBtn.disabled = false;
        ACTIVE.addBtn.textContent = '添加到文献库';
      }
    }
  }

  /* ------------------------------------------------------------------
   * 对外 API
   * ------------------------------------------------------------------ */

  /** 由 app.js 在每页渲染完成后调用；同一 wrap 重复渲染会先清掉旧层。 */
  async function render(page, viewport, wrap, pageNum) {
    if (!wrap) return;
    clear(wrap);

    const layer = el('div', 'pl-layer');
    const w = viewport && Number(viewport.width) ? Number(viewport.width) : wrap.clientWidth;
    const h = viewport && Number(viewport.height) ? Number(viewport.height) : wrap.clientHeight;
    layer.style.width = Math.max(0, w || 0) + 'px';
    layer.style.height = Math.max(0, h || 0) + 'px';

    let annotations = [];
    if (page && typeof page.getAnnotations === 'function') {
      try {
        annotations = await page.getAnnotations({ intent: 'display' });
      } catch (_) {
        try { annotations = await page.getAnnotations(); } catch (_) { annotations = []; }
      }
    }
    if (!Array.isArray(annotations)) annotations = [];

    const boxes = [];
    for (let i = 0; i < annotations.length; i++) {
      const a = annotations[i];
      if (!a || a.subtype !== 'Link') continue;
      const rect = a.rect;
      if (!Array.isArray(rect) || rect.length !== 4) continue;
      const vb = viewportBox(viewport, rect);
      if (!vb) continue;
      const url = String(a.url || a.unsafeUrl || '').trim();
      // 注释里除了外链，还有大量文档内目标（参考文献「[1]」→ 命名目标 bib51）。
      // dest 原样带上，点击时再异步解析，渲染阶段不阻塞。
      const dest = a.dest != null ? a.dest : null;
      addHot(layer, {
        url,
        dest,
        fromLink: true,
        text: url,
        label: url ? ('链接：' + url) : '文档内跳转',
        left: vb.left,
        top: vb.top,
        w: vb.w,
        h: vb.h,
        pageNum,
      }, boxes);
    }

    addInlineHots(layer, wrap, pageNum, boxes);
    if (layer.childNodes.length) wrap.appendChild(layer);
  }

  function clear(wrap) {
    if (!wrap) return;
    // 先判断卡片是否挂在本页 / 锚点是否已随页面重建被移除，再移除层
    //（移除层之后 anchor 就脱离 wrap 了，contains 会失效）。
    const anchorGone = !!(ACTIVE && ACTIVE.anchor && !document.body.contains(ACTIVE.anchor));
    const inThisWrap = !!(ACTIVE && ACTIVE.anchor && wrap.contains(ACTIVE.anchor));
    const shouldClose = anchorGone || inThisWrap;
    const layers = wrap.querySelectorAll('.pl-layer');
    for (let i = 0; i < layers.length; i++) layers[i].remove();
    if (shouldClose) closeCard();
  }

  const api = { render, clear };
  if (typeof window !== 'undefined') window.PdfLinks = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
