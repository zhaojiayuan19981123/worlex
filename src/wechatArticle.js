// wechatArticle.js —— 公众号单篇文章正文抓取与归一化
//
// 为什么只做「单篇」不做「列表」：
//   2026-07-30 微信关闭了公众号后台跨号搜索接口，任何免登录的批量列表通道都已失效；
//   但 mp.weixin.qq.com/s?... 单篇正文仍可免登录访问（实测 2026-11 仍有效）。
//   因此本模块只负责「给一个文章链接，还我干净的正文」，列表交给 siSources.js 的多源适配。
//
// 抓取要点：
//   * 必须带桌面版 UA + Referer，短链（无 chksm）可能返回 302 未知错误，此时提示用户提供完整链接；
//   * 正文在 #js_content 内，且默认 visibility:hidden（由页面脚本显示），文本本身就在 HTML 里，无需执行 JS；
//   * 正文中的 <a> 要保留成「文字 (URL)」，因为投稿系统与专刊详情页链接常是纯文字链接；
//   * 页面可能返回「环境异常/验证」页，必须明确报错而不是把验证页当正文喂给模型。

import { readFile } from 'node:fs/promises';

const str = (v) => String(v == null ? '' : v);
const clean = (v) => str(v).replace(/\s+/g, ' ').trim();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BLOCK_TAGS = 'p|div|li|h[1-6]|tr|article|section|blockquote|pre';

function decodeEntities(s) {
  return str(s)
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;|&#34;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&mdash;/gi, '—').replace(/&ndash;/gi, '–').replace(/&hellip;/gi, '…')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n) || 32))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16) || 32));
}

/**
 * 把公众号正文 HTML 转成适合大模型阅读的纯文本。
 * 段落/列表保留换行，链接转成「文字 (URL)」，图片丢弃。
 */
export function htmlToArticleText(html) {
  let s = str(html);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, ' ');
  // 图片先占位去掉，避免 alt 文本混进正文
  s = s.replace(/<img\b[^>]*>/gi, ' ');
  // 链接 -> 文字 (URL)，URL 用于后续抽取投稿系统/专刊链接
  s = s.replace(/<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi, (_m, a, b, c, inner) => {
    const href = decodeEntities(a || b || c || '').trim();
    const label = clean(decodeEntities(str(inner).replace(/<[^>]+>/g, ' ')));
    if (!href || !label) return ` ${label} `;
    if (/^javascript:/i.test(href)) return ` ${label} `;
    // 微信内部跳转/阅读原文等噪音链接不保留
    if (/mp\.weixin\.qq\.com\/mp\/profile|^#|weixin\.qq\.com\/s\?src=/i.test(href)) return ` ${label} `;
    return ` ${label} (${href}) `;
  });
  s = s.replace(new RegExp(`<br\\s*/?>`, 'gi'), '\n');
  s = s.replace(new RegExp(`</(?:${BLOCK_TAGS})>`, 'gi'), '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s
    .replace(/[ \t\u00a0\u3000]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function metaContent(html, key) {
  const re = new RegExp(`<meta\\b[^>]*(?:property|name)\\s*=\\s*["']${key}["'][^>]*content\\s*=\\s*["']([^"']*)`, 'i');
  const m = re.exec(html);
  return m ? decodeEntities(m[1]).trim() : '';
}

/** 从页面里取发布时间（微信有几种写法，逐个试）。 */
export function extractPublishDate(html) {
  const s = str(html);
  const patterns = [
    /var\s+ct\s*=\s*["'](\d{10})["']/i,
    /["']create_time["']\s*:\s*["']?(\d{10})/i,
    /var\s+createTime\s*=\s*["']([^"']+)["']/i,
    /["']publish_time["']\s*:\s*["']?(\d{10})/i,
    /id="publish_time"[^>]*>\s*([^<]+)</i,
  ];
  for (const re of patterns) {
    const m = re.exec(s);
    if (!m) continue;
    const raw = m[1].trim();
    if (/^\d{10}$/.test(raw)) {
      const d = new Date(Number(raw) * 1000);
      if (!Number.isNaN(d.getTime())) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }
    }
    const m2 = /(20\d{2})[-年/](\d{1,2})[-月/](\d{1,2})/.exec(raw);
    if (m2) return `${m2[1]}-${String(m2[2]).padStart(2, '0')}-${String(m2[3]).padStart(2, '0')}`;
  }
  return '';
}

/** 识别「不是正常文章页」的页面，返回可读的错误原因。 */
export function wechatPageError(html) {
  const s = str(html);
  if (!s.trim()) return '页面为空';
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1] || '').trim();
  if (/^(未知错误|参数错误|系统繁忙|该内容已被发布者删除|此内容因违规无法查看)$/.test(title)) {
    return `微信返回「${title}」：链接参数不完整或文章已被删除。请在微信里重新复制完整链接（需包含 chksm 参数）`;
  }
  if (/环境异常|完成验证后即可继续访问|去验证/.test(s) && !/id="js_content"/.test(s)) {
    return '微信要求人机验证（环境异常）：该链接在当前网络下被限制，请稍后重试或换网络';
  }
  if (/该公众号已迁移|该内容已被发布者删除/.test(s) && !/id="js_content"/.test(s)) {
    return '文章已被发布者删除或公众号已迁移';
  }
  if (/此内容被多人投诉|无法查看/.test(s) && !/id="js_content"/.test(s)) {
    return '文章因投诉无法查看';
  }
  return '';
}

/** 从整页 HTML 里截出 #js_content 片段。 */
export function extractContentHtml(html) {
  const s = str(html);
  const marker = s.search(/id=["']js_content["']/i);
  if (marker < 0) return '';
  // 回退到该属性的开标签起点，否则切片会从 "id=..." 开始，
  // 这段属性文本会被当成正文第一行，字段名就不在行首了。
  const lt = s.lastIndexOf('<', marker);
  const start = lt >= 0 ? lt : marker;
  const rest = s.slice(start);
  const endMarkers = [
    /<div[^>]*class=["'][^"']*rich_media_tool/i,
    /<div[^>]*id=["']js_toobar/i,
    /<div[^>]*id=["']js_tags/i,
    /<div[^>]*class=["'][^"']*qr_code_pc/i,
    /<div[^>]*id=["']js_pc_qr_code/i,
  ];
  let end = rest.length;
  for (const re of endMarkers) {
    const m = re.exec(rest);
    if (m && m.index > 0 && m.index < end) end = m.index;
  }
  if (end === rest.length) end = Math.min(rest.length, 400000);
  return rest.slice(0, end);
}

/**
 * 抓取一篇公众号文章。
 * @param {string} url
 * @param {{fetchImpl?:Function, timeoutMs?:number, maxChars?:number}} opts
 * @returns {Promise<{url:string, title:string, publishedAt:string, text:string, chars:number}>}
 */
export async function fetchWechatArticle(url, opts = {}) {
  const {
    fetchImpl = globalThis.fetch,
    timeoutMs = 25000,
    maxChars = 16000,
  } = opts;
  const target = clean(url);
  if (!/^https?:\/\//i.test(target)) throw new Error('文章链接格式不正确');
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持网络请求');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  let res;
  try {
    res = await fetchImpl(target, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Referer: 'https://mp.weixin.qq.com/',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`抓取文章超时（${Math.round(timeoutMs / 1000)} 秒）`);
    throw new Error('抓取文章失败，请检查网络：' + (e?.message || e));
  } finally {
    clearTimeout(timer);
  }

  const status = Number(res?.status) || 0;
  if (res?.ok === false && status >= 400) {
    if (status === 404) throw new Error('文章不存在（HTTP 404），可能已被删除');
    if ([403, 429].includes(status)) throw new Error(`微信拒绝访问（HTTP ${status}），请稍后重试`);
    throw new Error(`抓取文章失败 HTTP ${status}`);
  }

  const html = typeof res?.text === 'function' ? await res.text() : str(res?.body);
  const pageError = wechatPageError(html);
  if (pageError) throw new Error(pageError);

  const contentHtml = extractContentHtml(html);
  if (!contentHtml) throw new Error('页面里没有找到正文（可能不是公众号文章，或页面结构已变化）');

  const title = clean(
    metaContent(html, 'og:title')
    || decodeEntities(/<h1[^>]*class=["'][^"']*rich_media_title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] || '')
      .replace(/<[^>]+>/g, ' ')
    || (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || ''),
  ).slice(0, 200);

  const text = htmlToArticleText(contentHtml);
  if (text.length < 60) throw new Error('正文过短，可能抓到了错误页面');

  return {
    url: clean(res?.url) || target,
    title,
    publishedAt: extractPublishDate(html),
    text: text.slice(0, maxChars),
    chars: text.length,
  };
}

/** 读取本地导出的文章文件（md / html / txt），返回与在线抓取一致的结构。 */
export async function readLocalArticle(filePath, opts = {}) {
  const { maxChars = 16000 } = opts;
  let raw = '';
  try { raw = await readFile(filePath, 'utf8'); } catch (e) {
    throw new Error('读取本地文章失败：' + (e?.message || e));
  }
  if (!raw.trim()) throw new Error('本地文章文件为空');
  const isHtml = /\.html?$/i.test(filePath) || /<html|<body|<div\b/i.test(raw.slice(0, 2000));
  let title = '';
  let text = '';
  if (isHtml) {
    title = clean(metaContent(raw, 'og:title') || (/<title[^>]*>([^<]*)<\/title>/i.exec(raw)?.[1] || ''));
    const body = extractContentHtml(raw) || raw;
    text = htmlToArticleText(body);
  } else {
    const fm = /^#\s+(.+)$/m.exec(raw.slice(0, 2000));
    title = clean(fm?.[1] || '');
    text = raw
      .replace(/^---[\s\S]*?---\s*\n/, '')
      .replace(/^#\s+.*$/m, '')
      .trim();
  }
  if (text.length < 40) throw new Error('本地文章内容过短，无法抽取');
  return { url: '', title: title.slice(0, 200), publishedAt: '', text: text.slice(0, maxChars), chars: text.length };
}
