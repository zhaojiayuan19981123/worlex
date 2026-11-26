// lazyLibs.js —— pdf-lib / fontkit 的「用到才加载」入口（v3.1.1 启动优化）
//
// 为什么需要它：
//   这两个包合计约 0.9 秒（本机冷启动实测：pdf-lib 607ms + fontkit 297ms），而它们
//   只在「真正生成译文 PDF」时才用得上。可它们又是 CJS 包，ESM 的 `import()` 是异步的，
//   改成 await 会把 render/reflow 里一串同步函数（measureFontInk → buildStrokeTable →
//   drawPlans）全部染成 async，调用点很多、容易出错。
//   用 createRequire 同步 require 就没这个问题：第一次访问时才真正读包，之后复用缓存，
//   调用方拿到的仍是同步结果，函数签名与返回值一个都不用改。
//
// 注意：Electron 打包是 asar:false 且 node_modules 全量随包，require 能正常解析。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let pdfLibCache = null;
let fontkitCache = null;

/** 同步取 pdf-lib 模块（首次调用才加载） */
export function pdfLibModule() {
  if (!pdfLibCache) pdfLibCache = require('pdf-lib');
  return pdfLibCache;
}

/** 同步取 fontkit 模块（@pdf-lib/fontkit 的 UMD 主入口，取 default 以兼容 ESM 包装） */
export function fontkitModule() {
  if (!fontkitCache) {
    const mod = require('@pdf-lib/fontkit');
    fontkitCache = mod?.default || mod;
  }
  return fontkitCache;
}
