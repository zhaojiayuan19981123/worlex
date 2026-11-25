// siWebPage.js —— 通用网页正文抓取（用于「官网 SI 页面」这条收稿路径）
//
// 为什么单独一个文件：wechatArticle.js 依赖公众号页面的固定标记（#js_content / rich_media_title），
// 出版社的专刊页（ScienceDirect、Springer、Taylor & Francis、Wiley…）结构完全不同，
// 复用那套选择器只会拿到空正文。这里做的是「通用但保守」的正文区识别：
//
//   1. 先按语义容器挑正文：<article> → <main> → id/class 像正文的 div → <body>；
//      取文本量最大的那个（导航、页脚、Cookie 提示因此自然被排除在外）；
//   2. 把块级标签换成换行，行内标签直接去掉，保证段落结构还在（模型要靠它分段翻译）；
//   3. 有些出版社返回 Cloudflare/Akamai 的人机验证页，正文只有几百字且含 verify 关键字，
//      这种情况直接报错让用户粘贴正文，不要把验证页当成征稿信息喂给模型。
//
// 不做 JS 渲染：本项目不打包浏览器内核，静态 HTML 拿不到的内容就明确失败。

const str = (v) => String(v == null ? '' : v);
const clean = (v) => str(v).replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', ndash: '–', mdash: '—', hellip: '…',
  middot: '·', times: '×', copy: '©', reg: '®', trade: '™', deg: '°',
};

function decodeEntities(input) {
  return str(input)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safePoint(Number(dec)))
    .replace(/&([a-z][a-z0-9]{1,9});/gi, (all, name) => (ENTITIES[name.toLowerCase()] ?? all));
}

function safePoint(code) {
  try { return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : ' '; } catch { return ' '; }
}

/** HTML → 纯文本：保留段落换行，去掉脚本/样式/表单等非正文节点。 */
export function htmlToPlainText(html) {
  let s = str(html);
  s = s
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|template|form|nav|footer|header|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|main|li|tr|h[1-6]|blockquote|dd|dt|figcaption|td)>/gi, '\n')
    .replace(/<(p|div|section|article|main|li|tr|h[1-6]|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return clean(s.split('\n').map((line) => line.trim()).join('\n'));
}

/** 从 HTML 里取一个「像标题」的字符串。 */
export function htmlTitle(html) {
  const s = str(html);
  const og = /<meta[^>]+property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']+)["']/i.exec(s)
    || /<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:title["']/i.exec(s);
  if (og) return clean(decodeEntities(og[1])).slice(0, 200);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s);
  if (title) return clean(decodeEntities(title[1])).slice(0, 200);
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(s);
  if (h1) return clean(decodeEntities(h1[1].replace(/<[^>]+>/g, ' '))).slice(0, 200);
  return '';
}

/** 依次取出所有候选正文块，返回文本量最大的一个（太短的丢弃）。 */
function pickMainBlock(html) {
  const s = str(html);
  const patterns = [
    /<article\b[^>]*>([\s\S]*?)<\/article>/gi,
    /<main\b[^>]*>([\s\S]*?)<\/main>/gi,
    /<div\b[^>]*(?:id|class)\s*=\s*["'][^"']*(?:article|content|main|body|text|detail|call)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
  ];
  const candidates = [];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(s))) {
      const text = htmlToPlainText(m[1]);
      if (text.length >= 200) candidates.push(text);
    }
  }
  if (!candidates.length) return htmlToPlainText(/<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(s)?.[1] || s);
  return candidates.reduce((best, cur) => (cur.length > best.length ? cur : best), '');
}

/** 页面日期：meta / time[datetime] / 正文里的日期，取不到返回空串。 */
export function htmlPublishedAt(html) {
  const s = str(html);
  const meta = /<meta[^>]+(?:property|name)\s*=\s*["'](?:article:published_time|pubdate|publishdate|date|dc\.date)["'][^>]*content\s*=\s*["']([^"']+)["']/i.exec(s)
    || /<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]*(?:property|name)\s*=\s*["'](?:article:published_time|pubdate|publishdate)["']/i.exec(s);
  const raw = meta?.[1] || /<time[^>]+datetime\s*=\s*["']([^"']+)["']/i.exec(s)?.[1] || '';
  const m = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(str(raw));
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return '';
}

const BLOCKED_HINT = /(verify you are human|checking your browser|cf-challenge|access denied|attention required|captcha|人机验证|环境异常|访问过于频繁)/i;

async function readLimited(res, maxBytes = 4 * 1024 * 1024) {
  if (!res) throw new Error('网络请求没有返回');
  if (res.ok === false) {
    const tip = res.status === 403 || res.status === 401
      ? '：该页面不允许程序访问（可能需要登录或有反爬限制），请直接把页面正文复制粘贴进来'
      : res.status === 404 ? '：页面不存在' : '';
    throw new Error(`HTTP ${res.status}${tip}`);
  }
  const type = str(res.headers?.get?.('content-type')).toLowerCase();
  let text = '';
  if (res.body?.getReader) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxBytes) throw new Error('页面超过 4 MB，请确认填的是专刊详情页而不是期刊首页');
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); }
  } else if (typeof res.text === 'function') {
    text = await res.text();
  } else {
    text = str(res.body);
  }
  return { text, type };
}

/**
 * 抓取任意网页并抽出正文。
 * @returns {Promise<{url:string,title:string,publishedAt:string,text:string}>}
 */
export async function fetchWebPageArticle(url, opts = {}) {
  const { fetchImpl = globalThis.fetch, timeoutMs = 25000 } = opts;
  const target = str(url).trim();
  if (!/^https?:\/\//i.test(target)) throw new Error('不是有效的网页地址');
  if (typeof fetchImpl !== 'function') throw new Error('当前环境没有可用的网络请求能力');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  let res;
  try {
    res = await fetchImpl(target, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // 用桌面浏览器 UA：不少出版社对默认 UA 直接 403
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
  } catch (e) {
    throw new Error(controller.signal.aborted ? '页面请求超时' : `打不开这个页面：${e?.message || e}`);
  } finally {
    clearTimeout(timer);
  }

  const { text: raw, type } = await readLimited(res);
  // 非 HTML（纯文本、JSON）直接当正文用
  if (type && !/html|xml/.test(type)) {
    return { url: target, title: '', publishedAt: '', text: clean(raw).slice(0, 60000) };
  }
  if (BLOCKED_HINT.test(raw.slice(0, 6000))) {
    throw new Error('这个页面返回的是人机验证/拒绝访问页，抓不到正文。请在浏览器里打开后把正文复制粘贴进来。');
  }
  const body = pickMainBlock(raw).slice(0, 60000);
  if (body.length < 80) {
    throw new Error('页面里没有解析出正文（可能是纯 JS 渲染）。请在浏览器里打开后把正文复制粘贴进来。');
  }
  return { url: target, title: htmlTitle(raw), publishedAt: htmlPublishedAt(raw), text: body };
}
