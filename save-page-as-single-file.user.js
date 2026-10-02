// ==UserScript==
// @name         保存网页为单 HTML 文件（图片内联）
// @name:en      Save Page As Single HTML (inline images)
// @namespace    https://gist.github.com/
// @version      1.10.4
// @description  把当前页面保存成一个 .html 文件：图片 / CSS / 字体全部内联为 data URI，离线打开不丢图；仅保存正文时也会挑出正文用到的 @font-face 和图标符号样式一起内联；跨域走 GM 请求 → 普通 fetch → canvas 三级兜底，失败会明确报告原因
// @author       CodeBuddy
// @match        *://*/*
// @grant        GM.xmlhttpRequest
// @grant        GM_xmlhttpRequest
// @grant        GM.registerMenuCommand
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '1.10.4';

  /* ---------------- 配置 ---------------- */
  const CFG = {
    concurrency: 8,          // 全局并发下载数
    perHost: 2,              // 同一域名最大并发（防 429）
    hostGap: 250,            // 同一域名两次请求最小间隔(ms)
    timeout: 20000,          // 单个资源超时(ms)
    maxSize: 20 * 1024 * 1024, // 超过此大小的资源不内联(保持原链接)
    retry: 1,                // 失败重试次数
    hotkey: true,            // Alt+S 直接保存
    inlineFailWarn: 0.2,     // 内联失败率超过此比例时高亮提醒
    preferFetch: false,      // true: 跨域也先试普通 fetch（省流量，但知乎这类会刷 CORS 报错）
    canvasReferrer: 'no-referrer',  // canvas 兜底发不带 Referer；图片 403 可试 'origin'
    keepFonts: true,         // 仅正文模式下也保留页面正文字体 / 图标符号的样式
    fontFetch: true,         // 字体、CSS 这类非图片资源先用普通 fetch 试（服务器必须带 CORS 头）
    mathFallback: true       // 正文里有 LaTeX 公式且已移除脚本时，留一条联网渲染公式的后备脚本
  };

  const LAZY_SRC = ['data-src', 'data-original', 'data-lazy-src', 'data-echo', 'data-actualsrc',
    'data-url', 'data-image', 'data-lazy', 'data-href', 'data-ezsrc'];
  const LAZY_SRCSET = ['data-srcset', 'data-original-set', 'data-lazy-srcset', 'data-ezsrcset'];
  const FONT_EXT = /\.(woff2?|ttf|otf|eot)(\?|#|$)/i;
  const URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/g;

  /* ---------------- GM API 适配 ---------------- */
  /* 各脚本管理器暴露的写法不一样，四种都探一遍：
     Tampermonkey: GM.xmlHttpRequest / GM_xmlhttpRequest（部分版本还有 GM.xmlhttpRequest）
     Violentmonkey: GM.xmlHttpRequest + 下划线版，没有小写 r 的点号版 */
  function pickGm() {
    const cands = [];
    try {
      if (typeof GM === 'object' && GM) cands.push(GM.xmlHttpRequest, GM.xmlhttpRequest, GM.XMLHttpRequest);
    } catch (e) { /* 忽略 */ }
    try {
      if (typeof GM_xmlhttpRequest !== 'undefined') cands.push(GM_xmlhttpRequest);
      if (typeof GM_xmlHttpRequest !== 'undefined') cands.push(GM_xmlHttpRequest);
    } catch (e) { /* 忽略 */ }
    for (const f of cands) if (typeof f === 'function') return f;
    return null;
  }
  const gmXhr = pickGm();
  console.log('[SPF] GM.xmlHttpRequest: ' + (gmXhr ? '可用' : '不可用（脚本管理器没给跨域权限）'));

  function menu(name, fn) {
    try {
      if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand(name, fn);
      else if (typeof GM !== 'undefined' && GM.registerMenuCommand) GM.registerMenuCommand(name, fn);
    } catch (e) { /* 忽略 */ }
  }

  /* ---------------- 工具函数 ---------------- */
  const baseEl = document.querySelector('base[href]');
  const BASE = baseEl ? baseEl.href : location.href;

  function toAbs(raw, base) {
    if (!raw) return '';
    raw = raw.trim();
    if (!raw || /^(data|blob|about|javascript|chrome|moz-extension):/i.test(raw) || raw.charAt(0) === '#') return '';
    try { return new URL(raw, base || BASE).href; } catch (e) { return ''; }
  }

  function cssUrls(css) {
    const out = [];
    let m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(css)) !== null) {
      const u = (m[1] || m[2] || m[3] || '').trim();
      if (u) out.push(u);
    }
    return out;
  }

  function splitSrcset(v) {
    // 只取带宽/像素最大的候选，避免把同一张图的 3~4 个尺寸全部下载
    let best = '', bestVal = -1;
    v.split(',').forEach(part => {
      const bits = part.trim().split(/\s+/);
      if (!bits[0]) return;
      const d = bits[1], w = d && /\d+w$/i.test(d) ? parseInt(d, 10)
        : d && /[\d.]+x$/i.test(d) ? Math.round(parseFloat(d) * 100) : 0;
      if (w > bestVal) { bestVal = w; best = bits[0]; }
    });
    return best ? [best] : [];
  }

  function extMime(url) {
    const m = url.split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i);
    const e = m ? m[1].toLowerCase() : '';
    const map = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
      webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon',
      bmp: 'image/bmp', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
      otf: 'font/otf', eot: 'application/vnd.ms-fontobject', css: 'text/css'
    };
    return map[e] || 'application/octet-stream';
  }

  function toDataURL(buf, type) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(new Blob([buf], { type: type || 'application/octet-stream' }));
    });
  }

  /* 兜底通道：走浏览器自己的图片加载管线（<img> + crossOrigin + canvas）。
     它不受 CSP connect-src 和 XHR 权限限制，能命中 HTTP 缓存；只要图床发了
     Access-Control-Allow-Origin（知乎这种配了 referrerpolicy=no-referrer 的
     站点通常发了），toDataURL 就能拿到字节。
     代价：重新解码一次、动图只剩首帧、SVG 需先转位图 */
  function b64ToBuf(b64) {
    try { return Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer; } catch (e) { return null; }
  }
  /* 画布在内存里永远是 RGBA，所以 toDataURL('image/png') 一定带 alpha 通道：
     知乎那篇 17 张图全编码成 PNG，11 MB，其中一半以上是透明通道和无损编码的浪费。
     采样看看是不是真有半透明像素（读不动就保守按有处理），没有就转 JPEG */
  function canvasHasAlpha(cx, w, h) {
    try {
      const step = Math.max(1, Math.floor(Math.sqrt(w * h / 20000)));
      for (let y = 0; y < h; y += step) {
        const d = cx.getImageData(0, y, w, 1).data;
        for (let x = 0; x < w; x += step) if (d[x * 4 + 3] !== 255) return true;
      }
      return false;
    } catch (e) { return true; }
  }
  function getByCanvas(url, type) {
    return new Promise(resolve => {
      const im = new Image();
      let settled = false;
      const done = r => { if (!settled) { settled = true; resolve(r); } };
      const timer = setTimeout(() => { try { im.src = ''; } catch (e) {} done(null); }, CFG.timeout);
      im.crossOrigin = 'anonymous';
      im.referrerPolicy = CFG.canvasReferrer;
      im.onload = () => {
        clearTimeout(timer);
        try {
          const w = im.naturalWidth || im.width, h = im.naturalHeight || im.height;
          if (!w || !h) return done(null);
          const cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          const cx = cv.getContext('2d');
          const src = type || extMime(url) || '';
          const isSvg = /svg/i.test(src) || /\.svgz?(\?|#|$)/i.test(url);
          const isGif = /gif/i.test(src) || /\.gif(\?|#|$)/i.test(url);
          if (isSvg) {
            cx.fillStyle = '#ffffff';
            cx.fillRect(0, 0, w, h);   // SVG 转位图时补白底，免得透明变黑
          }
          cx.drawImage(im, 0, 0);
          let want = 'image/png';
          // GIF 只剩首帧，转 JPEG 会把透明涂成黑色；小图标转 JPEG 全是压缩斑。这两种留 PNG
          if (!isSvg && !isGif && w * h > 100000 && !canvasHasAlpha(cx, w, h)) want = 'image/jpeg';
          const out = cv.toDataURL(want, 0.9);
          const i = out.indexOf(',');
          const buf = i > 0 ? b64ToBuf(out.slice(i + 1)) : null;
          done(buf ? { buf: buf, type: out.slice(5, out.indexOf(';')) } : null);
        } catch (e) { done(null); } // 画布被污染（服务器没给 CORS 头）
      };
      im.onerror = () => { clearTimeout(timer); done(null); };
      im.src = url;
    });
  }
  const IMG_TYPE_RE = /\.(jpe?g|png|gif|webp|avif|bmp|ico|svgz?)(\?|#|$)/i;

  /* 图床常把 .jpg/.png 发成 Content-Type: application/octet-stream，
     直接塞进 data URI 浏览器不认，图片照样不显示：按扩展名 + 文件头修正 */
  const IMG_EXT_RE = /\.(jpe?g|png|gif|webp|avif|svgz?|bmp|ico)(\?|#|$)/i;
  const FONT_EXT_RE = /\.(woff2?|ttf|otf|eot)(\?|#|$)/i;
  function fixType(url, buf, type) {
    const guessed = extMime(url);
    const sn = new Uint8Array(buf, 0, Math.min(16, buf.byteLength));
    let magic = '';
    const hex = n => n.toString(16).padStart(2, '0');
    for (let k = 0; k < sn.length; k++) magic += hex(sn[k]);
    let real = '';
    if (/^ffd8ff/.test(magic)) real = 'image/jpeg';
    else if (/^89504e470d0a1a0a/.test(magic)) real = 'image/png';
    else if (/^47494638/.test(magic)) real = 'image/gif';
    else if (/^52494646....46424c54/i.test(magic)) real = 'image/webp';
    else if (/^(667479706176696|6674797068656963|667479706d73363|667479706d70313)/i.test(magic)) real = 'image/avif';
    else if (/^1f8b/.test(magic) && /\.svgz/i.test(url)) real = 'image/svg+xml';
    else if (/^(3c737667|3c3f786d6c)/.test(magic)) real = 'image/svg+xml';
    else if (/^774f4646/.test(magic)) real = 'font/woff';
    else if (/^774f4632/.test(magic)) real = 'font/woff2';
    else if (/^00010000/.test(magic)) real = guessed;
    if (real) return real;
    if (!type || /^application\/(octet-stream|unknown|x-gzip|x-www-form-urlencoded)$/i.test(type)) {
      return IMG_EXT_RE.test(url) || FONT_EXT_RE.test(url) ? guessed : type;
    }
    return type;
  }

  /* 下载资源，四级通道：
     1) 本次已下过的直接用内存缓存；
     2) 同源资源先试普通 fetch —— 走浏览器 HTTP 缓存和正常 cookie，页面显示过的
        资源大多零网络请求，服务器几乎看不到额外流量，不易触发 429；
     3) GM.xhr —— 跨域通用通道，但要脚本管理器授权；
     4) canvas 兜底 —— 用 <img crossOrigin> + toDataURL，不吃任何跨域权限，
        代价是要求服务器返回 Access-Control-Allow-Origin，否则画布被污染。
     返回 {buf,type} / {rateLimit,fail} / null */
  const memCache = new Map();
  const failHosts = new Map();   // host -> 失败次数
  let gmMissingWarned = false;
  let canvasTried = 0, canvasSaved = 0;   // canvas 兜底的成效
  function sameOrigin(url) {
    try { return new URL(url).origin === location.origin; } catch (e) { return false; }
  }
  function markFail(url) {
    try {
      const h = new URL(url).host;
      failHosts.set(h, (failHosts.get(h) || 0) + 1);
    } catch (e) { /* 忽略 */ }
  }
  function toBuf(x) {
    if (!x) return null;
    if (x instanceof ArrayBuffer) return x;
    if (ArrayBuffer.isView(x)) return x.buffer;
    if (typeof x === 'string') {
      try {
        const u = new Uint8Array(x.length);
        for (let k = 0; k < x.length; k++) u[k] = x.charCodeAt(k) & 0xff;
        return u.buffer;
      } catch (e) { return null; }
    }
    return null;
  }
  function fetchGm(url, ref) {
    return new Promise(resolve => {
      const done = res => resolve(res);
      try {
        gmXhr({
          method: 'GET',
          url: url,
          responseType: 'arraybuffer',
          timeout: CFG.timeout,
          headers: { 'Accept': '*/*', 'Referer': ref || location.href },
          onload(r) {
            const ct = (r.responseHeaders || '').match(/content-type:\s*([^\r\n;]+)/i);
            const buf = toBuf(r.response);
            if (r.status >= 200 && r.status < 400 && buf) {
              done({ buf: buf, type: (ct ? ct[1] : '') || extMime(url) });
            } else {
              markFail(url);
              done({ rateLimit: r.status === 429, fail: true, status: r.status });
            }
          },
          onerror(r) { markFail(url); done({ fail: true, status: r && r.status }); },
          ontimeout() { markFail(url); done(null); },
          onabort() { markFail(url); done(null); }
        });
      } catch (e) { markFail(url); done(null); }
    });
  }
  async function fetchBuf(url, ref) {
    if (memCache.has(url)) return memCache.get(url);
    const isImg = IMG_TYPE_RE.test(url);
    let out = null;
    // 1) 普通 fetch：同源最省（走浏览器缓存 + cookie）。跨域的字体/CSS 也先试一把 ——
    //    字体本来就是 CORS 强制资源（@font-face 不带 ACAO 头浏览器根本不给加载），
    //    所以 fetch 大概率能命中缓存拿到，不需要 GM 权限；图片不带 CORS 头则留给后面。
    const tryFetch = sameOrigin(url) || CFG.preferFetch || (CFG.fontFetch && !isImg);
    if (tryFetch) {
      try {
        const r = await fetch(url, { credentials: sameOrigin(url) ? 'include' : 'omit' });
        if (r.ok) out = { buf: await r.arrayBuffer(), type: extMime(url) };
        else out = { rateLimit: r.status === 429, fail: true, status: r.status };
      } catch (e) { out = null; /* CORS/CSP 挡了，走后面的通道 */ }
    }
    // 2) GM.xmlHttpRequest：跨域通用通道（需要脚本管理器授权）
    if (!out && gmXhr) out = await fetchGm(url, ref);
    // 3) canvas 兜底 —— 不依赖任何跨域权限（GM 拿到 403 也照样试一次）
    if ((!out || !out.buf) && isImg) {
      canvasTried++;
      const c = await getByCanvas(url, out && out.type);
      if (c && c.buf) { canvasSaved++; out = c; }
    }
    if (!out || !out.buf) {
      if (!gmMissingWarned && !gmXhr) {
        gmMissingWarned = true;
        note('⚠ 拿不到 GM.xmlHttpRequest：跨域资源只能靠 canvas 兜底，且要求图床带 CORS 头；' +
          '想全量内联请给脚本管理器开跨域权限（Tampermonkey：脚本设置 → 允许跨域；' +
          'Firefox：扩展 → 管理扩展 → 访问网站 → 所有网站）', true);
      }
      markFail(url);
      out = (out && out.rateLimit) ? out : null;
    }
    memCache.set(url, out);
    return out;
  }
  /* 重试用的备选地址：知乎这类图床同一份图有多个可互换域名（picx/pic1/pic4…），
     某个 CDN 节点拒答时换一个再试。不加随机 query，免得破坏带签名的图片地址 */
  const CDN_ALT = { picx: ['pic1', 'pic2', 'pic4', 'pic7', 'pica', 'pico'], pic1: ['picx', 'pic2', 'pic4', 'pic7'] };
  function altUrls(url) {
    const out = [];
    try {
      const u = new URL(url);
      const m = u.hostname.match(/^([a-z]+)(\d*)\./i);
      if (m) {
        const alts = CDN_ALT[m[1].toLowerCase()];
        if (alts) {
          for (const a of alts) {
            const v = new URL(url);
            v.hostname = u.hostname.replace(m[1], a);
            out.push(v.href);
          }
        }
      }
    } catch (e) { /* 忽略 */ }
    return out;
  }

  /* 按域名限速：同域并发不超过 perHost，两次请求间隔不小于 hostGap */
  const hostState = new Map();
  function hostSlot(url) {
    let host;
    try { host = new URL(url).host; } catch (e) { return Promise.resolve(() => {}); }
    let st = hostState.get(host);
    if (!st) { st = { active: 0, last: 0, waiters: [] }; hostState.set(host, st); }
    return new Promise(resolve => {
      const tryRun = () => {
        if (st.active >= CFG.perHost) { st.waiters.push(tryRun); return; }
        const gap = st.last + CFG.hostGap - Date.now();
        if (gap > 0) { setTimeout(tryRun, gap); return; }
        st.active++;
        st.last = Date.now();
        resolve(() => {
          st.active--;
          const next = st.waiters.shift();
          if (next) next();
        });
      };
      tryRun();
    });
  }

  async function pool(items, limit, worker) {
    let i = 0;
    const n = Math.min(limit, items.length);
    const runners = [];
    for (let k = 0; k < n; k++) {
      runners.push((async () => {
        while (i < items.length) await worker(items[i++]);
      })());
    }
    await Promise.all(runners);
  }

  /* ---------------- 懒加载还原 ---------------- */
  function unlazy(doc) {
    doc.querySelectorAll('img, source, video, iframe, [data-bg]').forEach(el => {
      for (const a of LAZY_SRC) {
        const v = el.getAttribute(a);
        if (v && !el.getAttribute('src')) { el.setAttribute('src', v); break; }
      }
      for (const a of LAZY_SRCSET) {
        const v = el.getAttribute(a);
        if (v && !el.getAttribute('srcset')) { el.setAttribute('srcset', v); break; }
      }
      if (el.tagName === 'IMG') { el.removeAttribute('loading'); el.loading = 'eager'; }
      const bg = el.getAttribute && el.getAttribute('data-bg');
      if (bg) el.style.backgroundImage = 'url("' + bg + '")';
    });
    // 常见的占位 class 不影响，交给 CSS 内联处理
  }

  /* ---------------- 正文提取 ---------------- */
  const NEGATIVE_RE = /comment|meta|footer|footnote|sidebar|share|related|advert|banner|nav[-_]?bar/i;
  const POSITIVE_RE = /post|entry|article|body|content|main|text/i;
  const PUNCT_RE = /[，。！？；：、,.!?;]/g;

  /* Readability 式正文识别：先给每个段落打分，再向上聚合到父容器(计满)和
     祖父容器(计半)，取最高分容器。避免整页 wrapper 或页脚因绝对文本量胜出 */
  function candScore(p) {
    const len = (p.textContent || '').trim().length;
    const commas = (p.innerHTML.match(/<br\s*\/?>/gi) || []).length +
      ((p.textContent || '').split(PUNCT_RE).length - 1);
    return Math.max(1, commas + 1) + Math.floor(len / 100);
  }

  /* ---------------- 正文模式下的字体 / 图标符号 ----------------
     “仅保存正文”会把原页面所有 <style>/<link> 删掉，知乎正文字体和
     ::before 图标字符就全没了。这里按正文实际用到的 @font-face 名称和
     class 令牌，从原样式表里挑出相关规则单独保留 */
  let savedTokens = new Set();
  let fontCssText = '';
  const fontCssUrls = new Set();
  let fontCssDown = [];      // 下载回来的外链 CSS：[{url, text}]

  function tok(s) {
    const out = [];
    (s || '').split(/[\s,]+/).forEach(t => {
      if (t.length > 1 && !/^\d+$/.test(t)) out.push(t.toLowerCase());
    });
    return out;
  }

  // 选择器 -> 标识符：.zhihu-icon-arrow::before 必须还原成 zhihu-icon-arrow，
  // 否则永远对不上 savedTokens 里的纯类名（之前字体规则一条都抓不到就是这个原因）
  function selTokens(sel) {
    const out = [];
    (sel || '').replace(/::?\s*(before|after)\b/gi, '')
      .split(/[^A-Za-z0-9_-]+/).forEach(t => {
        if (t.length > 1 && !/^\d+$/.test(t)) out.push(t.toLowerCase());
      });
    return out;
  }

  function collectFontCss() {
    const rules = [], seenRule = new Set();
    const keep = t => { t = (t || '').trim(); if (t && !seenRule.has(t)) { seenRule.add(t); rules.push(t); } };
    // @font-face 一律保留：知乎把图标字体按 unicode-range 切成多个子集，
    // 猜“正文用到哪个 family”很容易漏，漏一个就是方块字。数量由下面的上限兜住。
    const FACE_CAP = 40;
    let faceKept = 0;
    // a) 能直接读到的样式表（同源，或扩展已开 web-access）
    for (const sheet of Array.from(document.styleSheets)) {
      let rs = null;
      try { rs = sheet.cssRules; } catch (e) { continue }   // 跨域读不了，交给 b) 下载
      for (const r of Array.from(rs || [])) {
        const t = (r.cssText || '').trim();
        if (!t) continue;
        if (r.type === CSSRule.FONT_FACE_RULE) {
          if (faceKept++ < FACE_CAP) keep(t);
        } else if (r.selectorText && /\S::?(before|after)/i.test(r.selectorText)) {
          if (selTokens(r.selectorText).some(x => savedTokens.has(x))) keep(t);
        }
      }
    }
    // b) 下载回来的跨域样式表：正则切块（@import 嵌套进来的字体表覆盖不到）
    for (const item of fontCssDown) {
      const txt = (item.text || '').replace(/\r\n?/g, '\n');
      if (!txt.trim()) continue;
      const blockRe = /@font-face\s*\{[^}]*\}/gi;
      let m;
      while ((m = blockRe.exec(txt)) !== null) {
        if (faceKept++ < FACE_CAP) keep(m[0]);
      }
      // 伪元素规则：逐块扫描（知乎的 CSS 常带换行，不能只按单行匹配）
      let i = 0;
      while (i < txt.length) {
        const b = txt.indexOf('{', i);
        if (b < 0) break;
        let d = 1, e = b + 1;
        while (e < txt.length && d) {
          if (txt[e] === '{') d++;
          else if (txt[e] === '}') d--;
          e++;
        }
        let sel = txt.slice(i, b).trim();
        // 上一层块的收尾符会粘连在选择器前面，切掉
        sel = sel.slice(Math.max(sel.lastIndexOf('}'), sel.lastIndexOf(';')) + 1).trim();
        if (/\S::?(before|after)/i.test(sel) && selTokens(sel).some(x => savedTokens.has(x))) {
          keep(sel + txt.slice(b, e).replace(/\s*\n\s*/g, ''));
        }
        // 前进到 b+1 而不是 e：这样 @media / @supports 里的规则也能被扫到
        i = b + 1;
      }
    }
    return rules.join('\n');
  }

  /* 知乎把未读消息数塞进 document.title：
     "(63 封私信 / 2 条消息) 正文标题 - 知乎"。
     这个前缀会写进 <title>、<h1> 和文件名，还会干扰“正文标题 vs 页面标题”的匹配，先剥掉 */
  function pageTitle() {
    const raw = (document.title || '').trim();
    let t = raw.replace(
      /^[\[(（【]?\s*(?:\d+\s*[封条个篇]\s*[\u4e00-\u9fa5]{2,4}\s*[/、,，]\s*)*\d+\s*[封条个篇]\s*[\u4e00-\u9fa5]{2,4}\s*[\])）】]\s*/, '');
    t = t.replace(/\s*[-|｜–—]\s*[\u4e00-\u9fa5A-Za-z0-9 ]{1,8}$/, '');
    return t.trim() || raw;
  }

  function candidatesToMain(doc) {
    const norm = s => (s || '').replace(/\s+/g, '');
    const dbg = m => console.log('[SPF] ' + m);
    // 1) 去掉样板噪音
    doc.querySelectorAll('script,style,noscript,link,iframe,form,nav,header,footer,aside,[hidden],[aria-hidden="true"]')
      .forEach(el => el.remove());
    // 2) 文本块 -> 候选容器（正文可能是 <p>，也可能是裸文本 <div>+<br>）
    const cRe = /article|section|div|main|td/;
    const bRe = /^(P|PRE|BLOCKQUOTE|DIV|SECTION|ARTICLE|MAIN|TD|LI|DT|DD|H[1-6])$/;
    const cands = new Map();
    const textLeaves = [];
    const isTextOnly = el => Array.from(el.childNodes).every(n =>
      n.nodeType === 3 || (n.nodeType === 1 && !bRe.test(n.tagName)));
    doc.body.querySelectorAll('p,pre,blockquote,img').forEach(el => {
      if (el.tagName === 'IMG' || isTextOnly(el)) textLeaves.push(el);
    });
    doc.body.querySelectorAll('div,section,article,main,td,li').forEach(el => {
      if (el.querySelector('p,pre,blockquote,section,article,main,td,li')) return;
      if (!isTextOnly(el) || !(el.textContent || '').trim()) return;
      let top = el;
      while (top.parentNode && top.parentNode !== doc.body && isTextOnly(top.parentNode)) top = top.parentNode;
      textLeaves.push(top);
    });
    const scoreBlock = p => {
      const txt = (p.textContent || '').trim();
      if (txt.length < 25) return 0;
      let a = p.parentNode;
      while (a && a !== doc.body && !cRe.test(a.tagName.toLowerCase())) a = a.parentNode;
      if (!a) return 0;
      if (a === doc.body || a.tagName === 'HTML') a = doc.body; // 容器链到 body 为止（老版式）
      const add = (el, v) => {
        let e = cands.get(el);
        if (!e) { e = { score: 0, paras: 0 }; cands.set(el, e); }
        e.score += v; e.paras++;
      };
      const s = candScore(p);
      add(a, s);
      let b = a.parentNode;
      while (b && b !== doc.body && !cRe.test(b.tagName.toLowerCase())) b = b.parentNode;
      if (b && b !== doc.body && b.tagName !== 'HTML' && cRe.test(b.tagName.toLowerCase())) add(b, s / 2);
      return s;
    };
    textLeaves.forEach(scoreBlock);
    if (!cands.size) { dbg('未找到任何≥25字的文本块，回退整页'); return null; }
    // 3) 链接密度：对每个块级节点统计“链接文字 / 全部文字”比例
    const linkMap = new Map();
    doc.body.querySelectorAll('div,section,article,main,td,ul,dl,p').forEach(el => {
      const t = (el.textContent || '').replace(/\s+/g, '').length;
      if (!t) { linkMap.set(el, 0); return; }
      let lt = 0;
      el.querySelectorAll('a').forEach(a => lt += (a.textContent || '').replace(/\s+/g, '').length);
      linkMap.set(el, lt / t);
    });
    cands.forEach((e, el) => {
      const d = linkMap.has(el) ? linkMap.get(el) : 1;
      if (d > 0.6 && e.paras < 3) e.score = 0;           // 导航/友情链接/推广板块
      else if (d > 0.5 && e.paras < 5) e.score *= 0.3;
      else if (d > 0.3) e.score *= 0.7;
      if (NEGATIVE_RE.test(el.className + ' ' + (el.id || ''))) e.score /= 3;
    });
    if (!cands.size) return null;
    const sc = el => { const e = cands.get(el); return e ? e.score : 0; };
    const parasOf = el => { const e = cands.get(el); return e ? e.paras : 0; };
    const depth = el => { let d = 0; for (let x = el; x; x = x.parentNode) d++; return d; };
    const trust = el => /(^|[-_\s])(content|article|art(?:icle)?[-_]?(?:body|txt|con)?|post(?:[-_]?body|[-_]?content)?|entry(?:[-_]?content)?|text|main|detail|read)[-_]?\d*($|[-_\s])/i
      .test(' ' + (el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '') + ' ');
    // 3a) 同页多篇文章（博客归档页、连载页）：先定位与页面标题吻合的那个标题，
    //     正文只取“它之后、下一个同类标题之前”这一段
    const pgT = norm(pageTitle());
    const cls = el => typeof el.className === 'string' ? el.className : '';
    const heads = Array.from(doc.body.querySelectorAll('h1,h2,h3')).filter(el => {
      const s = norm(el.textContent);
      return s.length > 3 && s.length < 120;
    });
    const hTitle = heads.filter(el => {
      const s = norm(el.textContent);
      return pgT && (pgT.indexOf(s) >= 0 || s.indexOf(pgT) === 0);
    })[0] || null;
    // “下一篇的标题”必须和本篇标题同标签、同类名、同层级，否则会把侧栏/页脚里
    // 随手写的 h1 当成分界，导致正文窗口被压成一小块
    const hNext = hTitle ? (function () {
      const after = el => !!(hTitle.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
      const same = el => el !== hTitle && after(el) && el.tagName === hTitle.tagName &&
        cls(el) === cls(hTitle) && depth(el) === depth(hTitle);
      return heads.filter(same)[0] || null;
    })() : null;
    // 严格判定：节点确实落在“本篇标题 ~ 下一篇标题”之间（收集段落时用）
    const inWindow = el => {
      if (!hTitle) return true;
      const hasT = el === hTitle || el.contains(hTitle);
      const hasN = !!hNext && el.contains(hNext);
      if (hasT && !hasN) return true;               // 正好包住这篇文章的容器
      if (hasT || hasN) return false;               // 罩住两篇的公共祖先：钻进去再说
      return !!(hTitle.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) &&
        (!hNext || !!(el.compareDocumentPosition(hNext) & Node.DOCUMENT_POSITION_FOLLOWING));
    };
    // 宽松判定：整块都在本篇标题之前、或整块都在下一篇标题之后，才判为“与本篇无关”
    // （选正文盒时用宽松判定，含标题的大容器允许入选，真正的杂质由 inWindow 在段落层挡掉）
    const outsideWin = el => {
      if (!hTitle || el === hTitle || el.contains(hTitle)) return false;
      if (hTitle.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) return true;
      if (hNext && !el.contains(hNext) &&
          (el.compareDocumentPosition(hNext) & Node.DOCUMENT_POSITION_PRECEDING)) return true;
      return false;
    };
    if (hTitle) dbg('定位到标题：<' + hTitle.tagName.toLowerCase() + '> ' +
      norm(hTitle.textContent).slice(0, 24) + (hNext ? '，到下一个同类标题为止' : ''));
    // 4) 正文盒 = 段落多、密度真的容器。侧栏/推荐板块凑不够 5 个正文段
    const notBody = el => el !== doc.body;
    const artBoxes = Array.from(cands.keys())
      .filter(el => notBody(el) && parasOf(el) >= 5 && !outsideWin(el));
    let best = null, bestScore = 0;
    const take = list => list.forEach(el => {
      let s = sc(el);
      if (POSITIVE_RE.test(el.className + ' ' + (el.id || ''))) s *= 2;
      if (hNext && el.contains(hNext)) s *= 0.1; // 罩住别篇文章的公共祖先打折，让更里层的盒胜出
      if (s > bestScore || (s === bestScore && best && depth(el) > depth(best))) { bestScore = s; best = el; }
    });
    const trusted = artBoxes.filter(trust);
    take(trusted.length ? trusted : artBoxes.length ? artBoxes
      : Array.from(cands.keys()).filter(el => notBody(el) && !outsideWin(el)));
    if (!best || bestScore < 20) {
      dbg('选不出正文盒：best=' + (best ? best.tagName + '#' + (best.id || '') : 'null') +
        ' score=' + Math.round(bestScore) + '（阈值20），回退整页');
      return null;
    }
    dbg('正文盒: <' + best.tagName.toLowerCase() + ' id="' + (best.id || '') + '" class="' +
      (typeof best.className === 'string' ? best.className : '') + '"> paras=' + parasOf(best) + ' score=' + Math.round(bestScore));
    // 5) 只平铺合格的文字块/图片块，不克隆任何容器结构
    savedTokens = new Set();
    // 只收正文盒里的 class/id，否则整页的图标类名都会命中，拽进一堆用不到的字体
    const tokEls = [best].concat(Array.from(best.querySelectorAll('[class],[id]')));
    tokEls.forEach(el => {
      tok(typeof el.className === 'string' ? el.className : '').forEach(t => savedTokens.add(t));
      if (el.id) tok(el.id).forEach(t => savedTokens.add(t));
    });
    const wrap = doc.createElement('div');
    const linkTextOf = el => {
      let lt = 0;
      el.querySelectorAll('a').forEach(a => lt += norm(a.textContent).length);
      return lt;
    };
    // 正文起点：标题向前并到祖先层（最多向上 3 层，只要看起来是标题的元素）
    const starts = [];
    const markStart = (node) => {
      let cur = node, levels = 0;
      while (cur && cur !== doc.body && levels++ < 4) {
        let found = false;
        for (let s = cur.previousSibling; s && !found; s = s.previousSibling) {
          if (s.nodeType !== 1) continue;
          const tag = s.tagName.toLowerCase();
          if (tag === 'body' || tag === 'html' || tag === 'head') break; // 绝不搬运整页节点
          const h = /^H[123]$/.test(s.tagName) || tag === 'time' || tag === 'p'
            ? s
            : (/title|h[123]$/.test((s.id || '') + ' ' + (typeof s.className === 'string' ? s.className : ''))
              ? s.querySelector('h1,h2,h3') : null);
          if (!h) continue;
          const t = norm(h.textContent).length;
          if (t > 0 && t < 120) {
            const c = h.cloneNode(true);
            c.dataset.spfStart = '1';
            starts.push(c);
            found = true;
          }
        }
        cur = cur.parentNode;
      }
    };
    if (best.parentNode) markStart(best);
    // 没按页面标题定位成功时，退回老办法：正文盒里的第一个标题当文章标题。
    // 已经定位到 hTitle 就不要乱标盒内的标题，免得把正文里的小标题吞掉
    if (!hTitle) {
      const inBox = best.querySelector('h1,h2,h3');
      if (inBox && norm(inBox.textContent).length < 120) {
        inBox.dataset.spfStart = '1';
        starts.unshift(inBox);
      }
    }
    const SECTION_RE = /精选|栏目|列表|推荐|热门|相关|更多|专题|标签|阅读|评论|关注/;
    const okBlock = el => {
      const t = norm(el.textContent).length;
      const img = !!el.querySelector('img') || el.tagName === 'IMG';
      const lt = linkTextOf(el);
      if (img) return t === 0 || lt / t < 0.4;  // 正文图：纯图行或低文案
      if (t < 20) return false;                  // 碎屑（含空行）
      if (t < 60 && lt > 0 && !/https?:\/\/|www\./i.test(el.textContent || '')) return false; // 短条目行：栏目列表/日期条目
      if (t < 80 && SECTION_RE.test(el.textContent)) return false;
      return true;
    };
    // 5) 递归收集正文盒内的“叶子块”：只认“里面没有别的块级元素”的最内层文字块，
    //    老式排版常见的 <div><table><tr><td>段落</td></tr></table></div> 会被钻到 td
    const TEXT_LEAF_RE = /^(P|PRE|BLOCKQUOTE|IMG|DIV|SPAN|FONT|TD|LI|DT|DD|H[1-6])$/;
    const INNER_BLOCK = 'div,p,table,ul,ol,section,article,main,td,li,blockquote,pre,h1,h2,h3';
    const blocks = [];
    (function walk(node) {
      Array.from(node.children).forEach(c => {
        if (c.hasAttribute('data-spf-start') || c === hTitle) return; // 标题单独放在最前面
        if (!inWindow(c)) { walk(c); return; } // 罩住别篇文章的容器：钻进去继续找
        if (c.tagName === 'IMG') { blocks.push(c); return; }
        if (TEXT_LEAF_RE.test(c.tagName) && !(c.querySelector && c.querySelector(INNER_BLOCK)) &&
            (c.textContent || '').trim()) {
          blocks.push(c);
          return;
        }
        walk(c); // 容器：继续往下找
      });
    })(best);
    // 5a) 三档分级：2=正文长段/图片行，1=无链接的短标题行，0=噪声。
    //     保留“第一个正文段 ~ 最后一个正文段”之间的全部内容（正文常被插图/引文截成
    //     好几段，不能只取最长的一段，否则开头的正文会被丢掉），
    //     区间内的孤立碎段（块数少、字数占比极低）才当侧栏杂质剔除
    const URLISH_RE = /https?:\/\/|www\.|[\w-]+\.(com|cn|net|org|io|dev|top|xyz|me|cc)\b/i;
    const kind = blocks.map(el => {
      const s = el.textContent || '';
      const t = norm(s).length;
      const img = el.tagName === 'IMG' || (t < 40 && !!el.querySelector('img'));
      const lt = linkTextOf(el);
      if (img) return (t === 0 || lt / t < 0.4) ? 2 : 0;
      // 正文里的裸链接（文尾参考资料、出处/链接行）也是正文，不能因链接密度被踢掉
      if (t > 0 && t < 200 && URLISH_RE.test(s) && !SECTION_RE.test(s)) return 2;
      if (t >= 35 && lt / t < 0.5) return 2;
      if (t > 0 && lt === 0 && !SECTION_RE.test(s)) return 1;
      return 0;
    });
    const charsAt = i => norm(blocks[i].textContent).length;
    const bodyIdx = kind.map((k, i) => k === 2 ? i : -1).filter(i => i >= 0);
    if (!bodyIdx.length) { dbg('正文盒内没有正文长段/图片行，回退整页'); return null; }
    const first = bodyIdx[0];
    let last = bodyIdx[bodyIdx.length - 1];
    const tailFrom = last + 1;
    // 紧跟正文末尾的短行（作者/出处/链接等）一并保留，最多 6 行
    for (let i = tailFrom, n = 0; i < kind.length && n < 6; i++, n++) {
      const el = blocks[i];
      const s = el.textContent || '';
      const t = norm(s).length;
      const img = el.tagName === 'IMG' || !!el.querySelector('img');
      if ((!t && !img) || t > 200 || SECTION_RE.test(s)) break;
      last = i;
    }
    let total = 0;
    for (let i = first; i <= last; i++) if (kind[i]) total += charsAt(i);
    const keep = new Array(kind.length).fill(false);
    for (let i = first; i <= last;) {
      if (!kind[i]) { i++; continue; }
      let e = i, sum = 0;
      while (e + 1 <= last && kind[e + 1]) e++;
      for (let j = i; j <= e; j++) sum += charsAt(j);
      const junk = (e - i + 1) < 3 && sum < Math.max(60, total * 0.05);
      if (!junk) for (let j = i; j <= e; j++) keep[j] = true;
      i = e + 1;
    }
    for (let i = tailFrom; i <= last; i++) keep[i] = true; // 文尾那几行不管链接密度都留
    const inSpan = (el, i) => keep[i] && (i >= tailFrom || kind[i] === 1 || okBlock(el));
    const kept = blocks.filter(inSpan);
    // 输出时统一“脱壳”：td/li/span 之类的单元格块改写成 <p>，并去掉排版属性，
    // 免得老站用表格排版时段落在纯净页面里变成一格一格的方框
    const LAYOUT_ATTRS = ['class', 'id', 'align', 'valign', 'border', 'cellpadding',
      'cellspacing', 'bgcolor', 'width', 'height', 'hspace', 'vspace', 'itemprop', 'role'];
    const cleanLayout = root => {
      const els = root.tagName === 'IMG' ? [root] : [root].concat(Array.from(root.querySelectorAll('*')));
      els.forEach(el => {
        LAYOUT_ATTRS.forEach(a => {
          if (el.tagName === 'IMG' && (a === 'width' || a === 'height')) return;
          el.removeAttribute(a);
        });
        Array.from(el.attributes || []).forEach(at => {
          if (/^data-|^on/i.test(at.name)) el.removeAttribute(at.name);
        });
        if (el.hasAttribute('style')) {
          const rest = (el.getAttribute('style') || '')
            .split(';')
            .filter(d => d.trim() && !/^\s*(border|background|padding|margin|width|float|display|position|text-align)/i.test(d.trim()))
            .join(';');
          if (rest) el.setAttribute('style', rest);
          else el.removeAttribute('style');
        }
      });
    };
    const appendBlock = el => {
      let node;
      if (/^(TD|LI|DT|DD|SPAN|FONT|CAPTION)$/.test(el.tagName)) {
        node = doc.createElement('p');
        Array.from(el.childNodes).forEach(n => node.appendChild(n.cloneNode(true)));
      } else {
        node = el.cloneNode(true);
      }
      node.removeAttribute('data-spf-start');
      cleanLayout(node);
      wrap.appendChild(node);
    };
    // 标题：上面按页面标题定位到的 hTitle 优先，其次正文盒附近的同名标题，
    // 都对不上就用 document.title 生成一个 h1
    let title = hTitle || starts.filter(el => /^H[123]$/.test(el.tagName)).find(el => {
      const s = norm(el.textContent);
      return s.length > 3 && (pgT.indexOf(s) >= 0 || s.indexOf(pgT) === 0);
    }) || null;
    if (!title && document.title) {
      title = doc.createElement('h1');
      title.textContent = pageTitle();
    }
    if (title) appendBlock(title);
    kept.forEach(appendBlock);
    // 清洗后文字太少视为提取失败，交回上层回退整页
    const remain = Array.from(wrap.children)
      .reduce((a, e) => a + norm(e.textContent).length, 0);
    dbg('块=' + blocks.length + ' 正文区=[' + first + ',' + last + '] 保留=' + kept.length +
      ' 标题=' + (title ? norm(title.textContent).slice(0, 24) : '无') +
      ' 字数=' + remain + (remain < 200 ? ' → 不足200字，回退整页' : ''));
    if (remain < 200) return null;
    return wrap;
  }

  function extractArticle(doc, main) {
    // Document 只能有一个元素子节点 <html>；一次替换出唯一的一对 head/body，
    // 不要用 innerHTML 清空（会留下多余的 <body>，导致正文“看不见”）
    const body = doc.createElement('body');
    while (main.firstChild) body.appendChild(main.firstChild); // 不保留外层包装 div
    // 标题下附上原文地址，离线回看时能直接跳回原页面
    const src = doc.createElement('p');
    src.className = 'spf-src';
    const a = doc.createElement('a');
    a.href = location.href;
    a.textContent = location.href;
    src.appendChild(a);
    const first = body.firstElementChild;
    if (first && /^H[1-6]$/.test(first.tagName)) first.insertAdjacentElement('afterend', src);
    else body.insertBefore(src, body.firstChild);
    doc.documentElement.replaceChildren(articleHead(doc), body);
  }

  /* 知乎这类站点的公式渲染器会同时留下一份渲染好的 <math> 和一份 LaTeX 源码副本
     （源码副本靠原页面 CSS 藏起来）。正文模式把原页面 CSS 全删了，副本就露出
     来变成满屏 \frac、\begin 源码。这里给它加 hidden，只留渲染结果。
     限定条件很窄：叶子节点 + 内容是 LaTeX + 同一父级（或祖父级）里确实有 <math>，
     避免误伤讨论 LaTeX 的正文段落 */
  const TEX_SRC_RE = /\\[A-Za-z]+|_\{|\^\{/;
  function hideTexSource(root) {
    if (!root || !root.querySelectorAll) return 0;
    let n = 0;
    root.querySelectorAll('*').forEach(el => {
      if (el.children.length || el.tagName === 'MATH') return;
      if (el.closest && (el.closest('math') || el.closest('pre') || el.closest('code'))) return;
      const t = el.textContent || '';
      if (!t || t.length > 400 || !TEX_SRC_RE.test(t)) return;
      let p = el.parentNode, near = false;
      for (let k = 0; k < 2 && p && p.querySelector; k++, p = p.parentNode) {
        if (p.querySelector('math')) { near = true; break; }
      }
      if (!near) return;
      el.setAttribute('hidden', '');
      n++;
    });
    return n;
  }

  function articleHead(doc) {
    const head = doc.createElement('head');
    const add = (tag, attrs, text) => {
      const n = doc.createElement(tag);
      Object.keys(attrs || {}).forEach(k => n.setAttribute(k, attrs[k]));
      if (text !== undefined) n.textContent = text;
      head.appendChild(n);
    };
    add('meta', { charset: 'utf-8' });
    add('meta', { name: 'viewport', content: 'width=device-width,initial-scale=1' });
    add('title', null, pageTitle());
    add('meta', { name: 'generator', content: 'save-page-as-single-file ' + VERSION });
    add('link', { rel: 'document', href: location.href });
    add('style', null,
      'body{max-width:720px;margin:40px auto;padding:0 20px;font:17px/1.8 -apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Microsoft YaHei",sans-serif;color:#222;word-wrap:break-word}' +
      'h1{font-size:28px;line-height:1.4;margin:0 0 .8em}' +
      'h2{font-size:22px;line-height:1.5;margin:1.4em 0 .6em}' +
      'h3{font-size:19px;line-height:1.5;margin:1.2em 0 .5em}' +
      'img,video{max-width:100%;height:auto}' +
      '.spf-src{font-size:13px;color:#57606a;margin:-.2em 0 1.4em;word-break:break-all}' +
      '.spf-src a{color:#0969da;text-decoration:none}' +
      'p,div{margin:0 0 1em}' +
      'pre{overflow:auto;background:#f6f8fa;padding:12px;border-radius:6px}' +
      'code{font-family:ui-monospace,Consolas,monospace}' +
      'blockquote{margin:1em 0;padding-left:1em;border-left:3px solid #d0d7de;color:#57606a}' +
      'table{max-width:100%}td,th{padding:4px 8px;vertical-align:top}');
    // 正文用到的字体 / 图标符号样式：内容由主流程第 3 步补进去（@font-face 里的
    // url() 会跟着一起被内联），没抓到规则时留空注释便于排查
    add('style', { 'data-href': '(正文用字体/图标样式)' }, fontCssText || '/* 未提取到 @font-face */');
    if (CFG.mathFallback && doc.body &&
        /(\$\$|\\\(|\\\[(\\begin\{|\(image|公式|latex))/i.test(doc.body.textContent || '')) {
      // 公式脚本被移除后 LaTeX 只剩源码，这里留一条联网渲染的后备（离线不生效）
      const s = doc.createElement('script');
      s.async = true;
      s.src = 'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js';
      head.appendChild(s);
    }
    return head;
  }

  /* ---------------- 收集资源 URL ---------------- */
  function collectDomUrls(doc, push) {
    doc.querySelectorAll('img').forEach(el => {
      push(el.getAttribute('src'));
      const ss = el.getAttribute('srcset');
      if (ss) splitSrcset(ss).forEach(push);
    });
    doc.querySelectorAll('source').forEach(el => {
      push(el.getAttribute('src'));
      const ss = el.getAttribute('srcset');
      if (ss) splitSrcset(ss).forEach(push);
    });
    doc.querySelectorAll('video[poster]').forEach(el => push(el.getAttribute('poster')));
    doc.querySelectorAll('input[type="image"][src]').forEach(el => push(el.getAttribute('src')));
    doc.querySelectorAll('svg image').forEach(el => {
      push(el.getAttribute('href'));
      push(el.getAttribute('xlink:href'));
    });
    doc.querySelectorAll('[style]').forEach(el => {
      cssUrls(el.getAttribute('style') || '').forEach(push);
    });
  }

  /* ---------------- UI ---------------- */
  let logEl, barEl, panel, saveBtn, copyBtn;
  const logLines = [];   // 完整日志，面板里只显示末尾几条，复制时全给
  let missingMsgs = [];  // 本次保存没能内联的图片地址（复制日志用）
  function pushLine(msg) { logLines.push(msg); }
  function log(msg, bad) {
    pushLine(msg);
    show(msg, bad);
  }
  function note(msg, bad) {
    pushLine(msg);
    append(msg, bad);
  }
  function status(msg) { show(msg, false); }
  function show(msg, bad) {
    if (!logEl) return;
    logEl.textContent = msg;
    logEl.className = bad ? 'bad' : '';
  }
  function append(msg, bad) {
    if (!logEl) return;
    const line = (logEl.textContent ? logEl.textContent + '\n' : '') + msg;
    logEl.textContent = line.split('\n').slice(-8).join('\n');
    if (bad) logEl.className = 'bad';
  }
  const NOISE_RE = /^(克隆页面|解析正文|下载样式表|内联资源|下载资源 \d+\/)/;
  function copyLogs() {
    const text = [location.href,
      'GM.xmlHttpRequest: ' + (gmXhr ? '可用' : '不可用'),
      'canvas 兜底: 尝试 ' + canvasTried + ' / 成功 ' + canvasSaved]
      .concat(logLines.filter(l => !NOISE_RE.test(l)))
      .concat(missingMsgs)
      .join('\n');
    const old = copyBtn ? copyBtn.textContent : '';
    const ok = () => { if (copyBtn) { copyBtn.textContent = '已复制 ✓'; setTimeout(() => { if (copyBtn) copyBtn.textContent = old; }, 1800); } };
    const bad = () => { if (copyBtn) { copyBtn.textContent = '复制失败'; setTimeout(() => { if (copyBtn) copyBtn.textContent = old; }, 1800); } };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok, () => fallbackCopy(text) ? ok() : bad());
    } else fallbackCopy(text) ? ok() : bad();
    console.log('[SPF 日志]\n' + text);
  }
  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.documentElement.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }
  function progress(p) { if (barEl) barEl.style.width = Math.max(0, Math.min(100, p * 100)) + '%'; }

  function buildUI() {
    const css = document.createElement('style');
    css.id = 'spf-css';
    css.textContent = `
#spf-panel{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:250px;
  font:12px/1.5 -apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Microsoft YaHei",sans-serif;
  color:#222;background:#fff;border:1px solid #d0d7de;border-radius:10px;
  box-shadow:0 8px 28px rgba(0,0,0,.22)}
#spf-panel *{box-sizing:border-box}
#spf-head{-webkit-user-select:none;user-select:none}
#spf-body label{-webkit-user-select:none;user-select:none}
#spf-head{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;
  font-weight:600;border-bottom:1px solid #eee;background:#f6f8fa;border-radius:10px 10px 0 0;cursor:move}
#spf-close{cursor:pointer;font-size:16px;line-height:1;color:#888;padding:0 2px}
#spf-body{padding:8px 10px 10px}
#spf-body label{display:block;margin:4px 0;cursor:pointer}
#spf-save{padding:7px 0;border:0;border-radius:6px;cursor:pointer;
  background:#1f883d;color:#fff;font-size:13px;font-weight:600}
#spf-save:disabled{background:#94d3a2;cursor:default}
#spf-bar{height:5px;margin-top:8px;background:#eee;border-radius:3px;overflow:hidden}
#spf-bar-i{display:block;height:100%;width:0;background:#0969da;transition:width .15s}
#spf-log{margin-top:6px;color:#57606a;word-break:break-all;max-height:150px;overflow:auto;
  -webkit-user-select:text;user-select:text;cursor:text;white-space:pre-wrap}
#spf-log.bad{color:#d1242f;font-weight:600}
#spf-row{display:flex;gap:6px;margin-top:8px}
#spf-row #spf-save{flex:1 1 auto;min-width:0}
#spf-copy{flex:0 0 auto;padding:0 10px;border:1px solid #d0d7de;border-radius:6px;background:#f6f8fa;
  color:#57606a;font-size:12px;cursor:pointer;white-space:nowrap}
#spf-copy:hover{background:#eaeef2;color:#222}
#spf-min{position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:6px 10px;border-radius:20px;
  border:1px solid #d0d7de;background:#fff;box-shadow:0 4px 14px rgba(0,0,0,.2);cursor:pointer;
  font:12px sans-serif;display:none}`;
    document.documentElement.appendChild(css);

    panel = document.createElement('div');
    panel.id = 'spf-panel';
    panel.innerHTML =
      '<div id="spf-head"><span>保存单文件网页 v' + VERSION + '</span><span id="spf-close" title="收起">&times;</span></div>' +
      '<div id="spf-body">' +
      '<label><input type="checkbox" id="spf-lazy" checked> 还原懒加载图片</label>' +
      '<label><input type="checkbox" id="spf-fonts" checked> 内联字体文件</label>' +
      '<label><input type="checkbox" id="spf-scripts" checked> 移除脚本（推荐）</label>' +
      '<label><input type="checkbox" id="spf-article" checked> 仅保存正文（默认选中）</label>' +
      '<div id="spf-row">' +
      '<button id="spf-save">保存为单个 HTML 文件</button>' +
      '<button id="spf-copy" title="复制完整日志和未内联的图片地址">复制日志</button>' +
      '</div>' +
      '<div id="spf-bar"><i id="spf-bar-i"></i></div>' +
      '<div id="spf-log">就绪 · Alt+S 保存 · Alt+C 复制日志</div>' +
      '</div>';
    document.documentElement.appendChild(panel);

    const min = document.createElement('div');
    min.id = 'spf-min';
    min.textContent = '保存网页';
    min.onclick = () => { min.style.display = 'none'; panel.style.display = ''; };
    document.documentElement.appendChild(min);

    logEl = panel.querySelector('#spf-log');
    barEl = panel.querySelector('#spf-bar-i');
    saveBtn = panel.querySelector('#spf-save');
    copyBtn = panel.querySelector('#spf-copy');
    saveBtn.onclick = () => save();
    if (copyBtn) copyBtn.onclick = copyLogs;
    panel.querySelector('#spf-close').onclick = () => { panel.style.display = 'none'; min.style.display = ''; };

    // 拖动
    const head = panel.querySelector('#spf-head');
    let sx = 0, sy = 0, sr = 0, sb = 0, dragging = false;
    head.addEventListener('mousedown', e => {
      const r = panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; sr = r.right; sb = r.bottom; dragging = true;
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      panel.style.left = '0px'; panel.style.top = '0px';
      panel.style.right = Math.max(0, window.innerWidth - (sr + (e.clientX - sx))) + 'px';
      panel.style.bottom = Math.max(0, window.innerHeight - (sb + (e.clientY - sy))) + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });

    if (CFG.hotkey) {
      document.addEventListener('keydown', e => {
        if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        const t = e.target;
        if (t && (t.tagName === 'TEXTAREA' || t.isContentEditable === true)) return; // 别抢打字
        if (e.key === 's' || e.key === 'S') { e.preventDefault(); save(); }
        else if (e.key === 'c' || e.key === 'C') { e.preventDefault(); copyLogs(); }
      });
    }
  }

  function opt(id) { const el = document.getElementById(id); return el ? el.checked : true; }

  /* ---------------- 主流程 ---------------- */
  let saving = false;

  async function save() {
    if (saving) return;
    saving = true;
    if (saveBtn) saveBtn.disabled = true;
    const t0 = Date.now();

    try {
      progress(0);
      status('克隆页面…');
      failHosts.clear();
      gmMissingWarned = false;
      canvasTried = 0; canvasSaved = 0;
      savedTokens = new Set();
      fontCssText = '';
      fontCssDown = [];
      fontCssUrls.clear();
      logLines.length = 0;
      missingMsgs = [];
      const doc = document.cloneNode(true);
      const lazy = opt('spf-lazy'), fonts = opt('spf-fonts'), noScript = opt('spf-scripts');
      const keepFontCss = CFG.keepFonts && fonts;
      if (lazy) unlazy(doc);

      // 0) 可选：仅保留正文
      const asArticle = opt('spf-article');
      if (asArticle) {
        status('解析正文…');
        // 正文模式会删掉所有样式表，先把外链 CSS 地址记下来好找回字体/图标规则
        Array.from(doc.querySelectorAll('link[rel~="stylesheet"][href]')).forEach(l => {
          const u = toAbs(l.getAttribute('href'));
          if (u) fontCssUrls.add(u);
        });
        const main = candidatesToMain(doc);
        if (!main) {
          log('未识别到正文，按整页保存');
        } else {
          extractArticle(doc, main);
          const hid = hideTexSource(doc.body);
          if (hid) note('公式：隐藏 ' + hid + ' 处 LaTeX 源码副本，保留渲染好的 <math>');
        }
      }

      // 1) 收集内联 <style> / 外链 <link rel=stylesheet>
      const cssItems = [];   // {el, text, base}
      doc.querySelectorAll('style').forEach(el => cssItems.push({ el, text: el.textContent || '', base: BASE, link: false }));
      const links = Array.from(doc.querySelectorAll('link[rel~="stylesheet"][href]'));
      for (const l of links) {
        const abs = toAbs(l.getAttribute('href'));
        cssItems.push({ el: l, text: null, url: abs, base: abs || BASE, link: true });
      }

      // 2) 收集所有需要下载的资源
      const urls = [];
      const seen = new Set();
      const push = (raw, base) => {
        const abs = toAbs(raw, base);
        if (!abs || seen.has(abs)) return;
        if (!fonts && FONT_EXT.test(abs)) return;
        seen.add(abs); urls.push(abs);
      };
      collectDomUrls(doc, raw => push(raw, BASE));
      for (const ci of cssItems) if (ci.text) cssUrls(ci.text).forEach(u => push(u, ci.base));

      // 3) 并发下载外链 CSS（文本），失败则回退读 CSSOM
      status('下载样式表…');
      await pool(cssItems.filter(ci => ci.link && ci.url), 6, async ci => {
        const release = await hostSlot(ci.url);
        const r = await fetchBuf(ci.url, ci.base);
        release();
        if (r && r.buf) {
          ci.text = new TextDecoder('utf-8').decode(r.buf);
        } else {
          try { // 回退：直接读 CSSOM（跨域样式表的 cssRules 会抛，只救同源）
            const norm = s => { try { return new URL(s).href; } catch (e) { return s; } };
            const sheet = Array.from(document.styleSheets)
              .find(s => s.href && norm(s.href) === norm(ci.url));
            ci.text = Array.from(sheet.cssRules).map(x => x.cssText).join('\n');
          } catch (e) { ci.text = ''; }
        }
        cssUrls(ci.text).forEach(u => push(u, ci.base));
      });

      // 3b) 正文模式：下载原页面样式表，挑出正文用到的 @font-face / 图标符号规则内联
      let fontKeptRules = 0, fontCssGot = 0, fontCssWant = 0;
      if (keepFontCss && fontCssUrls.size) {
        status('下载字体样式…');
        fontCssWant = fontCssUrls.size;
        const fl = Array.from(fontCssUrls).map(u => ({ url: u, base: BASE, text: null }));
        await pool(fl, 4, async ci => {
          const release = await hostSlot(ci.url);
          const r = await fetchBuf(ci.url, BASE);
          release();
          ci.text = (r && r.buf) ? new TextDecoder('utf-8').decode(r.buf) : '';
          if (!ci.text) {
            // 回退：读 CSSOM（跨域样式表的 cssRules 会抛，只救得回同源或扩展放开的那几张）
            try {
              const nu = s => { try { return new URL(s).href; } catch (e) { return s; } };
              const sheet = Array.from(document.styleSheets)
                .find(s => s.href && nu(s.href) === nu(ci.url));
              ci.text = sheet ? Array.from(sheet.cssRules).map(x => x.cssText).join('\n') : '';
            } catch (e) { ci.text = ''; }
          }
          if (ci.text) fontCssGot++;
        });
        fontCssDown = fl;
        fl.forEach(ci => { if (ci.text) fontCssText += '\n' + ci.text; });
        const picked = collectFontCss();
        if (picked) {
          const ph = doc.querySelector('style[data-href="(正文用字体/图标样式)"]');
          if (ph) {
            ph.textContent = picked;
            cssUrls(picked).forEach(u => push(u, BASE));   // 字体文件跟着进下载队列
            fontKeptRules = picked.split('\n').filter(Boolean).length;
          }
        }
      }

      // 4) 并发下载全部资源 -> data URI（按域名限速，429 退避）
      const map = new Map();
      let done = 0, limited = 0, tooBig = 0, badType = 0;
      status('下载资源 0/' + urls.length);
      await pool(urls, CFG.concurrency, async url => {
        let res;
        const release = await hostSlot(url);
        try { res = await fetchBuf(url, BASE); } finally { release(); }
        if (res && res.rateLimit && !limited++) note('该站点限流(429)，已放慢速度');
        if ((!res || !res.buf) && !res.rateLimit && CFG.retry > 0) {
          const alts = altUrls(url);                                   // 换 CDN 域名再试一次
          for (let k = 0; k < alts.length && (!res || !res.buf); k++) {
            const release = await hostSlot(alts[k]);
            res = await fetchBuf(alts[k], url);
            release();
          }
        }
        if (res && res.buf && res.buf.byteLength > CFG.maxSize) { res = null; tooBig++; }
        if (res && res.buf) {
          try {
            const type = fixType(url, res.buf, res.type);
            map.set(url, await toDataURL(res.buf, type));
            if (/^application\/octet-stream$/i.test(type)) badType++;
          } catch (e) { /* 忽略 */ }
        }
        done++;
        progress(urls.length ? done / urls.length : 1);
        status('下载资源 ' + done + '/' + urls.length + '（成功 ' + map.size + '）');
      });

      // 5) 替换 DOM / CSS
      status('内联资源…');
      const conv = (raw, base) => {
        const abs = toAbs(raw, base);
        return (abs && map.get(abs)) ? map.get(abs) : raw;
      };
      const convCss = (css, base) => css.replace(URL_RE, (m, q1, q2, q3) => {
        const q = q1 !== undefined ? '"' : (q2 !== undefined ? "'" : '');
        const u = (q1 || q2 || q3 || '').trim();
        const d = conv(u, base);
        return 'url(' + q + d + q + ')';
      });

      doc.querySelectorAll('img, source').forEach(el => {
        if (el.getAttribute('src')) el.setAttribute('src', conv(el.getAttribute('src'), BASE));
        const ss = el.getAttribute('srcset');
        if (ss) {
          const cands = splitSrcset(ss);
          const d = cands.length ? conv(cands[0], BASE) : null;
          // 只下载了最大候选：命中则替换，未命中则去掉 srcset 让浏览器用 src
          if (d && d !== cands[0]) el.setAttribute('srcset', d);
          else el.removeAttribute('srcset');
        }
      });
      doc.querySelectorAll('video[poster]').forEach(el => el.setAttribute('poster', conv(el.getAttribute('poster'), BASE)));
      doc.querySelectorAll('input[type="image"][src]').forEach(el => el.setAttribute('src', conv(el.getAttribute('src'), BASE)));
      doc.querySelectorAll('svg image').forEach(el => {
        ['href', 'xlink:href'].forEach(a => { if (el.getAttribute(a)) el.setAttribute(a, conv(el.getAttribute(a), BASE)); });
      });
      doc.querySelectorAll('[style]').forEach(el => {
        el.setAttribute('style', convCss(el.getAttribute('style') || '', BASE));
      });

      for (const ci of cssItems) {
        const text = convCss(ci.text || '', ci.base);
        if (ci.link) {
          const s = doc.createElement('style');
          s.setAttribute('data-href', ci.url || '');
          s.textContent = text;
          ci.el.parentNode && ci.el.parentNode.replaceChild(s, ci.el);
        } else {
          ci.el.textContent = text;
        }
      }

      // 5a) 没能内联、仍指向远程站点的图片：标出来，省得离线打开时满屏空白还找不到原因
      //     （file:// 页面被浏览器禁止加载远程内容，这些图必然显示不出来）
      let missing = 0;
      const missSet = new Set();
      doc.querySelectorAll('img').forEach(el => {
        const s = el.getAttribute('src') || '';
        if (/^(https?:)?\/\//i.test(s)) {
          missing++;
          missSet.add(s);
          el.style.outline = '2px dashed #d1242f';
          el.setAttribute('data-spf-missing', s);
        }
      });
      if (missSet.size) missingMsgs = ['未内联的图片地址：'].concat(Array.from(missSet));

      // 6) 清理：去掉脚本、预加载链接，以及本脚本自己注入的面板
      ['spf-panel', 'spf-min', 'spf-css'].forEach(id => {
        const el = doc.getElementById(id);
        if (el && el.parentNode) el.parentNode.removeChild(el);
      });
      if (noScript) {
        doc.querySelectorAll('script').forEach(el => el.remove());
        doc.querySelectorAll('link[rel~="preload"], link[rel~="prefetch"], link[rel~="modulepreload"]').forEach(el => el.remove());
      }
      doc.querySelectorAll('link[rel~="preconnect"], link[rel~="dns-prefetch"]').forEach(el => el.remove());
      if (!doc.querySelector('meta[charset]')) {
        const m = doc.createElement('meta');
        m.setAttribute('charset', 'utf-8');
        doc.head && doc.head.insertBefore(m, doc.head.firstChild);
      }

      // 7) 输出
      const dt = document.doctype && document.doctype.name ? '<!DOCTYPE ' + document.doctype.name + '>' : '<!DOCTYPE html>';
      const html = dt + '\n' + doc.documentElement.outerHTML;
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const name = (pageTitle() || location.hostname || 'page')
        .replace(/[\\/:*?"<>|\n\r\t]+/g, '_').slice(0, 80) + '.html';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.documentElement.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);

      progress(1);
      const pct = urls.length ? map.size / urls.length : 1;
      log('完成：' + name + ' · ' + (blob.size / 1048576).toFixed(2) + ' MB · ' +
        ((Date.now() - t0) / 1000).toFixed(1) + 's · 内联 ' + map.size + '/' + urls.length,
        pct < 1 - CFG.inlineFailWarn);
      const tops = Array.from(failHosts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3);
      if (map.size < urls.length) {
        note('未内联 ' + (urls.length - map.size) + ' 个（跳过超大文件 ' + tooBig +
          ' 个，类型仍是 octet-stream ' + badType + ' 个）' +
          (tops.length ? '，失败域名：' + tops.map(x => x[0] + '×' + x[1]).join('、') : ''), true);
      }
      if (keepFontCss) {
        const mnote = fontCssWant === 0 ? '（正文里没有外链样式表）'
          : fontCssGot === 0 ? '（样式表一张都没拿到：无 GM 权限且对方不给 CORS 头）'
          : fontKeptRules === 0 ? '（' + fontCssGot + '/' + fontCssWant + ' 张样式表拿到了但里面没有 @font-face）' : '';
        note('字体/图标：样式表 ' + fontCssGot + '/' + fontCssWant +
          '，抓到规则 ' + fontKeptRules + ' 条，涉及字体文件 ' +
          Array.from(seen).filter(u => FONT_EXT.test(u)).length + ' 个' + mnote,
          fontKeptRules === 0);
      }
      if (!gmXhr) {
        note('无 GM.xmlHttpRequest 权限：图片走 canvas 兜底（尝试 ' + canvasTried +
          '、成功 ' + canvasSaved + '）；字体和样式表走普通 fetch，服务器必须带 CORS 头才能拿到',
          canvasSaved < canvasTried);
      } else if (tops.length) note('这些请求被拒：多为防盗链 / 需要登录，可先滚动页面让图片全部加载完再保存', true);
      if (missing) note('离线打开时红框标出的 ' + missing + ' 张图会空白（file:// 页面禁止加载远程图片）', true);
    } catch (err) {
      log('失败：' + (err && err.message ? err.message : err), true);
      console.error(err);
    } finally {
      saving = false;
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  /* ---------------- 启动 ---------------- */
  console.log('[保存单文件网页] v' + VERSION + ' 已加载 @ ' + location.hostname);
  try { buildUI(); } catch (e) { console.error(e); }
  menu('保存当前页面为单文件 HTML', save);
  menu('复制保存日志（含未内联图片地址）', copyLogs);
  menu('显示/隐藏保存面板', () => {
    if (!panel) return;
    const min = document.getElementById('spf-min');
    if (panel.style.display === 'none') { panel.style.display = ''; if (min) min.style.display = 'none'; }
    else { panel.style.display = 'none'; if (min) min.style.display = ''; }
  });
})();
