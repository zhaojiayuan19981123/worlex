// academicTranslate.js —— 文献批量翻译：只走「翻译引擎」，绝不调用大模型
//
// 划词翻译（src/translate.js）默认跟随全局设置，可能是 siliconflow（当前激活的大模型）
// 或 builtin（固定小模型）。方向分析 / arXiv 这类批量场景明确要求不走大模型，
// 所以这里单独收口：引擎白名单 = translateProviders.js 里的 NON_LLM_PROVIDERS，
// 并在引擎层做分段、限速、重试与降级，避免免费网页接口的长文本/频率限制把整批翻译打断。

import {
  NON_LLM_PROVIDERS, TRANSLATE_PROVIDERS, translateWithProvider, translateProviderLabel,
} from './translateProviders.js';

/** 一次请求最多塞多少字符：有道网页版 1000 字可用、1500 字报 103，留足余量 */
const MAX_CHUNK = 850;
/** 免费网页接口的礼貌间隔（实测有道连发 6 次左右就开始 411） */
const WEB_MIN_GAP_MS = 800;
const WEB_ENGINES = new Set(['volcweb', 'youdaoweb', 'free']);

export const ACADEMIC_ENGINES = TRANSLATE_PROVIDERS
  .filter((p) => NON_LLM_PROVIDERS.has(p.id))
  .map((p) => ({ id: p.id, label: p.label, needsKey: !!p.needsKey }));

export function engineConfigured(id, settings) {
  if (id === 'deepl') return !!(settings?.deeplKey || settings?.deeplEndpoint);
  if (id === 'volcapi') return !!settings?.volcKey;
  if (id === 'youdaoapi') return !!settings?.youdaoKey;
  if (id === 'baidu') return !!settings?.baiduKey;
  if (id === 'tencent') return !!settings?.tencentKey;
  return !TRANSLATE_PROVIDERS.find((p) => p.id === id)?.needsKey;
}

/** 引擎清单（给前端下拉）：标注哪些已配密钥、哪些开箱即用 */
export function academicEngineList(settings = {}) {
  return ACADEMIC_ENGINES.map((p) => ({ ...p, configured: engineConfigured(p.id, settings) }));
}

/** 用户指定 > 已配密钥的引擎 > 全局非大模型偏好 > 有道网页版（免密钥） */
export function resolveAcademicEngine(settings = {}, requested = '') {
  const id = String(requested || '').trim();
  if (NON_LLM_PROVIDERS.has(id) && engineConfigured(id, settings)) return id;
  const configured = ACADEMIC_ENGINES.find((p) => p.needsKey && engineConfigured(p.id, settings));
  if (configured) return configured.id;
  const pref = String(settings.translateProvider || '').trim();
  if (NON_LLM_PROVIDERS.has(pref)) return pref;
  return 'youdaoweb';
}

/** 按句读切段，尽量不在句中截断；超长句再按字数硬切 */
export function splitForEngine(text, maxChars = MAX_CHUNK) {
  const source = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!source) return [];
  if (source.length <= maxChars) return [source];
  const pieces = [];
  let buf = '';
  for (const part of source.split(/(?<=[.!?。！？；;\n])\s*/)) {
    if (!part) continue;
    if (buf && buf.length + part.length > maxChars) { pieces.push(buf.trim()); buf = ''; }
    if (part.length > maxChars) {
      for (let i = 0; i < part.length; i += maxChars) pieces.push(part.slice(i, i + maxChars).trim());
    } else {
      buf += (buf ? ' ' : '') + part;
    }
  }
  if (buf.trim()) pieces.push(buf.trim());
  return pieces.filter(Boolean);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('已取消'), { name: 'AbortError' }));
    const timer = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(timer); reject(Object.assign(new Error('已取消'), { name: 'AbortError' })); }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

const retryable = (e) => /411|429|频率|too many|rate.?limit|errorcode.?103|103/i.test(String(e?.message || ''));

/**
 * 批量翻译。segments = [{id, text}]，返回 [{id, translation, error}]（顺序一致）。
 * translateImpl 可注入，便于离线单测；onProgress(done, total) 供后台任务显示进度。
 */
export async function translateSegments(segments, options = {}) {
  const list = Array.isArray(segments) ? segments : [];
  const settings = options.settings || {};
  const impl = options.translateImpl || translateWithProvider;
  const signal = options.signal;
  const log = typeof options.logger === 'function' ? options.logger : () => {};
  const primary = resolveAcademicEngine(settings, options.engine);
  // 主引擎失败后的降级候选：只挑已经配好密钥或免密钥的引擎，别把「无 Key」错误层层放大
  const chain = [primary, ...ACADEMIC_ENGINES
    .map((p) => p.id)
    .filter((id) => id !== primary && engineConfigured(id, settings))];
  let lastAt = 0;

  async function requestOnce(text, engine) {
    if (WEB_ENGINES.has(engine)) {
      const wait = WEB_MIN_GAP_MS - (Date.now() - lastAt);
      if (wait > 0) await sleep(wait, signal);
    }
    lastAt = Date.now();
    const out = await impl(engine, text, settings, 'zh');
    const value = String(out || '').trim();
    if (!value) throw new Error(`${translateProviderLabel(engine)} 返回空译文`);
    return value;
  }

  async function requestWithFallback(text) {
    let last;
    for (const engine of chain) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try { return await requestOnce(text, engine); } catch (e) {
          if (e?.name === 'AbortError' || signal?.aborted) throw e;
          last = e;
          log(`[翻译] ${engine} 失败（第 ${attempt + 1} 次）：${e?.message || e}`);
          if (retryable(e) && attempt === 0) await sleep(1600 * (attempt + 1), signal);
          else break;
        }
      }
    }
    throw last || new Error('没有可用的翻译引擎');
  }

  const results = [];
  let done = 0;
  for (const seg of list) {
    const id = String(seg?.id ?? '');
    const chunks = splitForEngine(seg?.text);
    if (!chunks.length) { results.push({ id, translation: '', error: '' }); done += 1; options.onProgress?.(done, list.length); continue; }
    try {
      const parts = [];
      for (const chunk of chunks) parts.push(await requestWithFallback(chunk));
      results.push({ id, translation: parts.join('\n'), error: '' });
    } catch (e) {
      results.push({ id, translation: '', error: String(e?.message || e).slice(0, 200) });
    }
    done += 1;
    options.onProgress?.(done, list.length);
  }
  return results;
}
