// ==UserScript==
// @name         保存网页为单 HTML 文件（图片内联）
// @name:en      Save Page As Single HTML (inline images)
// @namespace    https://gist.github.com/
// @version      1.13.0
// @description  把当前页面保存成一个 .html 文件：图片 / CSS / 字体全部内联为 data URI，离线打开不丢图；仅保存正文时也会挑出正文用到的 @font-face 和图标符号样式一起内联；跨域走 GM 请求 → 普通 fetch → canvas 三级兜底，失败会明确报告原因；AI 问答页（Gemini 这类）按“提问→回答”逐轮保留，shadow DOM 里的公式和列表不再存成空壳
// @author       CodeBuddy
// @match        *://*/*
// @grant        GM.xmlHttpRequest
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

  const VERSION = '1.13.0';

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
    mathFallback: true,      // 正文里有 LaTeX 公式且已移除脚本时，留一条联网渲染公式的后备脚本
    fontSlim: true,          // 正文模式只内联正文真正用到的 @font-face，其余丢掉（知乎图标字体抓不到时自动退回全留）
    fontFaceCap: 24,         // 瘦身后最多留几个 @font-face 家族
    chatMode: true,          // 识别 AI 问答页：正文盒上提到整个会话，逐轮保留提问和回答
    shadowLift: true         // 把 shadow DOM 的内容搬进宿主子节点，否则 KaTeX 公式、组件代码块存出来是空壳
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
    // 每个名字单独 try：未授权时读这个属性会抛，一个抛了不能连累后面几个
    const one = get => { try { const f = get(); return typeof f === 'function' ? f : null; } catch (e) { return null; } };
    return one(() => GM.xmlHttpRequest) || one(() => GM.xmlhttpRequest) ||
      one(() => GM.XMLHttpRequest) || one(() => GM_xmlhttpRequest) || one(() => GM_xmlHttpRequest);
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

  const FILE_PAGE = location.protocol === 'file:';
  function toAbs(raw, base) {
    if (!raw) return '';
    raw = raw.trim();
    if (!raw || /^(data|blob|about|javascript|chrome|moz-extension):/i.test(raw) || raw.charAt(0) === '#') return '';
    // 网页里的 file:// 地址浏览器一律拒绝加载（控制台刷“安全错误：…不可以加载或者链接至 file:///”），
    // 不去碰它；只有页面本身就是本地文件时才照常处理
    if (!FILE_PAGE && /^file:/i.test(raw)) return '';
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

  /* ---------------- Shadow DOM 展开 ----------------
     Gemini 这类站点把 KaTeX 公式、代码块、图标渲染在 shadow root 里：宿主标签自己
     不含内容。document.cloneNode(true) 虽然会连 shadow 树一起克隆，但最后输出走
     outerHTML，而 outerHTML 不序列化 shadow 内容 —— 存下来就是
     <span class="katex"></span> 这种空壳，整篇公式全丢。
     这里在克隆出来的文档上按“原节点 ↔ 克隆节点”成对下钻，把每个开放 shadow root 的
     子节点搬进宿主元素的普通子节点，后续的资源收集、正文提取、序列化就全都看得见 */
  let shadowCss = [];              // 攒起来的 shadow 样式，最后作为一段 <style> 挂进文档
  const shadowCssSeen = new Set();
  const SHADOW_HOST = 'spf-shadow-host';
  let shadowLifted = 0;
  const SHADOW_CAP = 3000;         // 展开上限：整站都是 Web Component 时也不至于把文件撑爆

  /* :host / ::slotted 只在 shadow 树里合法，搬到文档上下文必须改写选择器，
     否则整条规则被浏览器判为无效直接丢掉（KaTeX 的样式大量用 :host 定宿主尺寸）。
     近似改写：宿主元素统一打上 SHADOW_HOST 类 */
  function scopeShadowCss(text) {
    return (text || '')
      .replace(/::slotted\(([^)]*)\)/gi, '.' + SHADOW_HOST + ' $1')
      .replace(/:host\([^)]*\)/gi, '.' + SHADOW_HOST)
      .replace(/:host\b/gi, '.' + SHADOW_HOST);
  }

  /* adoptedStyleSheets 是 JS 对象不是节点，克隆时不会带过来，只能读 cssText 自己搬。
     Firefox 里构造样式表的 cssText 有可能是空的，退回逐条规则拼一遍 */
  function shadowSheetTexts(sr) {
    const out = [];
    try {
      Array.from(sr.adoptedStyleSheets || []).forEach(s => {
        if (!s) return;
        let t = '';
        try { t = s.cssText || ''; } catch (e) { t = ''; }
        if (!t) {
          try { t = Array.from(s.cssRules || []).map(r => r.cssText).join('\n'); } catch (e) { t = ''; }
        }
        if (t) out.push(t);
      });
    } catch (e) { /* 读不了就算了 */ }
    return out;
  }

  function pushShadowCss(text) {
    const t = scopeShadowCss(text).trim();
    if (t && !shadowCssSeen.has(t)) { shadowCssSeen.add(t); shadowCss.push(t); }
  }

  /* closed shadow root 的引用浏览器不会挂在 el.shadowRoot 上，但渲染框架自己几乎
     都把它存成了实例属性（Lit 的 renderRoot、老 Angular/shady 的 _shadowRoot 等），
     照着这几个名字捞一把，命中就能照常展开 */
  function shadowOf(el) {
    if (!el) return null;
    const names = ['shadowRoot', 'renderRoot', '_shadowRoot', '__shadowRoot', 'shadyRoot', 'shadow_'];
    for (const n of names) {
      let v = null;
      try { v = el[n]; } catch (e) { continue; }
      if (v && typeof v.querySelectorAll === 'function') return v;
    }
    /* 名字猜不到就穷举这个元素身上的属性（含 Symbol 键，Angular/Tiger 都往符号键上挂）。
       只认 host 指回自己的那个 root，别把随便一个 DocumentFragment 当成 shadow 树搬出来。
       穷举有成本，只花在“可能是自定义元素或公式宿主”身上 */
    const tag = (el.tagName || '');
    const looksMath = /katex|math|mjx/i.test(typeof el.className === 'string' ? el.className : '');
    if (tag.indexOf('-') < 0 && !looksMath) return null;
    const vals = [];
    try { vals.push.apply(vals, Object.values(el)); } catch (e) { /* 读不到就算了 */ }
    try {
      Object.getOwnPropertySymbols(el).forEach(sym => {
        try { vals.push(el[sym]); } catch (e) { /* 个别 getter 会抛 */ }
      });
    } catch (e) { /* 拿不到符号键 */ }
    for (const v of vals) {
      if (v && typeof v.querySelectorAll === 'function' && v.host === el) return v;
    }
    return null;
  }

  function liftShadow(orig, clone) {
    if (!orig || !clone || shadowLifted >= SHADOW_CAP) return;
    const oc = Array.from(orig.children || []), cc = Array.from(clone.children || []);
    for (let i = 0; i < oc.length && i < cc.length; i++) liftShadow(oc[i], cc[i]);
    const sr = shadowOf(orig);
    if (!sr) return;
    shadowLifted++;
    shadowSheetTexts(sr).forEach(pushShadowCss);
    if (clone.classList) clone.classList.add(SHADOW_HOST);
    /* shadow 里的 <style> 跟着内容一起搬出来（稍后集中到文档级）；<slot> 序列化后是空的，
       真正被分发的轻 DOM 内容仍在宿主自己的子节点里，两边不会重复一遍正文 */
    Array.from(sr.childNodes).forEach(node => {
      const c = node.cloneNode(true);
      clone.appendChild(c);
      if (node.nodeType === 1) liftShadow(node, c);
    });
  }

  /* shadow 组件自带的 <style> 挪到文档级：正文模式会把原页面样式表全删掉，
     留在正文子树里的会被一起删，挪出来才能和 adoptedStyleSheets 一起补回去 */
  function gatherShadowStyles(doc) {
    let moved = 0;
    doc.querySelectorAll('.' + SHADOW_HOST + ' style').forEach(s => {
      if (s.textContent) { pushShadowCss(s.textContent); moved++; }
      s.remove();
    });
    return moved;
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
  let fontFaceStats = { total: 0, kept: 0, slim: false };   // @font-face 瘦身前后的条数
  // 本次正文里有没有公式 / 代码 / 表格：决定要不要把对应的原文样式一起留下来
  let articleFlags = { math: false, code: false, table: false };
  let articleTitle = '';   // 正文模式定位到的文章标题，文件名优先用它

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

  /* @font-face 里的 font-family 名（可能带引号、可能是 "X", serif 这种栈） */
  function faceFamily(t) {
    const m = /font-family\s*:\s*(?:"([^"]*)"|'([^']*)'|([^;}"']+))/i.exec(t || '');
    return ((m && (m[1] || m[2] || m[3]) || '').trim()).replace(/^["']|["']$/g, '');
  }

  function collectFontCss() {
    const rules = [], seenRule = new Set();
    const keep = t => { t = (t || '').trim(); if (t && !seenRule.has(t)) { seenRule.add(t); rules.push(t); } };
    /* @font-face 先全捞进 faces，最后按“正文到底用没用到这个 family”筛掉一批。
       知乎把图标字体按 unicode-range 切成多个子集，同一个 family 会有好几条规则，
       所以去重键必须是整条规则文本，不能只按 family */
    const faces = [], seenFace = new Set();
    const FACE_SCAN_CAP = 200;
    const addFace = t => {
      t = trimFace(t);
      const key = t.trim();
      if (!key || seenFace.has(key) || faces.length >= FACE_SCAN_CAP) return;
      seenFace.add(key);
      faces.push({ text: key, fam: faceFamily(key).toLowerCase() });
    };
    // 正文里有公式 / 代码 / 表格时，光留 @font-face 不够：
    // 公式会散成没有上下标、没有根号的一行乱字，代码会丢掉高亮配色，表格会丢掉边框表头
    const isMathRule = sel => articleFlags.math && /\.(katex|MathJax|mjx)/i.test(sel || '');
    const isCodeRule = sel => articleFlags.code &&
      /(\.token|\.hljs|\.highlight|language-|(^|[>\s,])(pre|code)([.\[:,\s>]|$))/i.test(sel || '');
    const isTableRule = sel => articleFlags.table &&
      /(^|[>\s,.])(\btable|\bthead|\btbody|\btr|\btd|\bth)\b/i.test(sel || '');
    // 同一字体常常同时给出 woff2 / woff / ttf 三份（KaTeX 一套就有 20 个 family），
    // 全内联会让文件平白胖几 MB。有 woff2 就只留它，后面那些备选源去掉：
    // 浏览器按 src 顺序挑，woff2 本来就排在最前面
    function trimFace(t) {
      const m = /format\(\s*["']?woff2/i.exec(t);
      if (!m) return t;
      const brace = t.indexOf('}', m.index);
      if (brace < 0) return t;
      const comma = t.indexOf(',', m.index);
      const cut = (comma > 0 && comma < brace) ? comma : brace;
      return t.slice(0, cut) + t.slice(brace);
    }
    // a) 能直接读到的样式表（同源，或扩展已开 web-access）
    for (const sheet of Array.from(document.styleSheets)) {
      let rs = null;
      try { rs = sheet.cssRules; } catch (e) { continue }   // 跨域读不了，交给 b) 下载
      for (const r of Array.from(rs || [])) {
        const t = (r.cssText || '').trim();
        if (!t) continue;
        if (r.type === CSSRule.FONT_FACE_RULE) {
          addFace(t);
        } else if (r.selectorText && /\S::?(before|after)/i.test(r.selectorText)) {
          if (selTokens(r.selectorText).some(x => savedTokens.has(x))) keep(t);
        } else if (isMathRule(r.selectorText) || isCodeRule(r.selectorText) || isTableRule(r.selectorText)) {
          keep(t);
        }
      }
    }
    // b) 下载回来的跨域样式表：正则切块（@import 嵌套进来的字体表覆盖不到）
    for (const item of fontCssDown) {
      const txt = (item.text || '').replace(/\r\n?/g, '\n');
      if (!txt.trim()) continue;
      const blockRe = /@font-face\s*\{[^}]*\}/gi;
      let m;
      while ((m = blockRe.exec(txt)) !== null) addFace(m[0]);
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
        } else if (isMathRule(sel) || isCodeRule(sel) || isTableRule(sel)) {
          keep(sel + txt.slice(b, e).replace(/\s*\n\s*/g, ''));
        }
        // 前进到 b+1 而不是 e：这样 @media / @supports 里的规则也能被扫到
        i = b + 1;
      }
    }
    /* 瘦身：只留正文真正用到的 family。依据两条——
       1) 上面挑中的那条规则（图标伪元素 / 公式 / 代码 / 表格）自己声明的 font-family，
          图标字体和 KaTeX 各 family 都是这样被正文引用的；
       2) family 名的分词命中正文里的 class/id（字体名常和图标类名同源，如 iconfont）。
       抓不到任何依据时退回原样全留：宁可胖，也不要漏一个子集变成方块字 */
    const used = new Set();
    // font: 简写里家族名前面还挂着字号、字重这些，得先剥掉；通用字体族本身不是 @font-face 目标
    const SKIP_WORD = /^(normal|bold|bolder|lighter|italic|oblique|small-caps|caption|icon|menu|message-box|small-caption|status-bar|inherit|initial|unset|revert|auto|serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-monospace|ui-serif|ui-sans-serif|math|emoji|linguistics)$/i;
    const addFam = seg => {
      seg = (seg || '').trim().toLowerCase().replace(/^["']|["']$/g, '').trim();
      if (!seg) return;
      const parts = seg.split(/\s+/).filter(w => w && !SKIP_WORD.test(w) &&
        !/^[0-9.]+(px|em|rem|pt|pc|in|cm|mm|ex|ch|%)$/.test(w) && !/^var\(/i.test(w));
      if (!parts.length) return;
      used.add(parts.join(' '));
      parts.forEach(p => { if (p.length > 2) used.add(p); });
    };
    const ruleText = rules.join('\n');
    // 图标伪元素规则里的 font-family、KaTeX 规则里的 font 简写，都是“正文确实用到这个 family”的证据
    (ruleText.match(/font-family\s*:[^;{}]+/gi) || []).forEach(d =>
      d.replace(/^font-family\s*:/i, '').split(',').forEach(addFam));
    (ruleText.match(/(?:[{;\s])font\s*:\s*[^;{}]+/gi) || []).forEach(d =>
      d.replace(/^[^:]*:/, '').split(',').forEach(addFam));
    const famHit = f => {
      if (!f) return false;
      if (used.has(f)) return true;
      return f.split(/[^a-z0-9_-]+/).some(x => x.length > 2 && savedTokens.has(x));
    };
    let picked = faces;
    if (CFG.fontSlim && used.size) {
      const hit = faces.filter(x => famHit(x.fam));
      if (hit.length) picked = hit;
    }
    if (CFG.fontSlim && picked.length > CFG.fontFaceCap) picked = picked.slice(0, CFG.fontFaceCap);
    fontFaceStats = { total: faces.length, kept: picked.length, slim: picked.length < faces.length };
    return picked.map(x => x.text).join('\n') + (picked.length && rules.length ? '\n' : '') + rules.join('\n');
  }

  /* 知乎把未读消息数塞进 document.title：
     "(63 封私信 / 2 条消息) 正文标题 - 知乎"。
     这个前缀会写进 <title>、<h1> 和文件名，还会干扰“正文标题 vs 页面标题”的匹配，先剥掉 */
  function pageTitle() {
    const raw = (document.title || '').trim();
    let t = raw.replace(
      /^[\[(（【]?\s*(?:\d+\s*[封条个篇]\s*[\u4e00-\u9fa5]{2,4}\s*[/、,，]\s*)*\d+\s*[封条个篇]\s*[\u4e00-\u9fa5]{2,4}\s*[\])）】]\s*/, '');
    t = t.replace(/\s*[-|｜–—]\s*[\u4e00-\u9fa5A-Za-z0-9 ]{1,8}$/, '');
    // CSDN 这类还会把“_专栏名”接在标题后面（"文章标题_stable diffusion-CSDN博客"），
    // 文件名要的是文章标题本身。只在切掉后还剩至少 8 个字时才动刀，
    // 免得把本来就带下划线的标题（"A_B"）砍掉一半
    t = t.replace(/_[^_]{1,30}$/, m => (t.length - m.length >= 8 ? '' : m));
    return t.trim() || raw;
  }

  /* 正文提取要先把样式表、导航这类样板从快照里删掉才好打分，但“没认出正文”时
     上层会拿同一个 doc 回退整页 —— 删都删了，存出来就是一张没样式的裸页。
     所以删除动作记在 cut 里，失败时按原位插回去 */
  /* 展开完还是空的公式宿主：光看保存结果分不出“浏览器不让读”还是“页面压根没渲染”，
     所以就地探一个宿主，把能问到的都写进日志——shadowRoot 是不是 null、框架有没有把
     root 存成实例属性、元素有没有尺寸、命中的是不是宿主自己。有了这几行才知道下一步
     该往哪儿捞，不用来回让人贴控制台输出 */
  const MATH_SEL = '.katex,.katex-display,.mjx-container,math,[class*="katex"]';
  /* 只剩空壳的公式宿主。.katex-display 里套着一个 .katex，同一处公式会数两遍，
     所以只认最外面那一层 */
  function mathShells(root) {
    if (!root || !root.querySelectorAll) return [];
    let list;
    try {
      list = Array.from(root.querySelectorAll(MATH_SEL))
        .filter(el => !(el.textContent || '').trim() && !el.querySelector('svg,math,img'));
    } catch (e) { return []; }
    return list.filter(el => !el.parentElement || !el.parentElement.closest(MATH_SEL));
  }
  /* KaTeX 把渲染结果整块包在 <span class="katex-html" aria-hidden="true"> 里（MathJax 的
     assistive 层同理）：这个 aria-hidden 是“别让屏幕阅读器念两遍”的意思，不是装饰。
     按装饰删掉，公式就只剩 <span class="katex"></span> 一个空壳，整篇数学全丢 */
  const MATH_HOST_SEL = '.katex,.katex-display,.mjx-container,.mjx-chtml,.MathJax,.MathJax_Display,' +
    '.MathJax_SVG,math,semantics,annotation,mspace,mrow,[data-katex]';
  function inMathTree(el) {
    if (!el || !el.closest) return false;
    try { return !!el.closest(MATH_HOST_SEL); } catch (e) { return false; }
  }
  function probeMath() {
    const empty = mathShells(document);
    if (!empty.length) return 0;
    const one = empty[0];
    const clsOf = el => (typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '');
    const chain = [];
    for (let a = one, n = 0; a && n < 6; a = a.parentElement, n++) {
      chain.push(a.tagName.toLowerCase() + (clsOf(a) ? '.' + clsOf(a) : ''));
    }
    const props = [];
    ['shadowRoot', 'renderRoot', '_shadowRoot', '__shadowRoot', 'shadyRoot', 'shadow_'].forEach(n => {
      let v = null;
      try { v = one[n]; } catch (e) { v = '读取异常'; }
      props.push(n + '=' + (v && typeof v === 'object' ? (v.querySelectorAll ? 'root(' + v.childNodes.length + ')' : 'obj') : String(v)));
    });
    const r = one.getBoundingClientRect();
    let hit = '取不到';
    try {
      const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      hit = h ? h.tagName.toLowerCase() + (clsOf(h) ? '.' + clsOf(h) : '') + (h === one ? '（就是宿主自己）' : '') : 'null';
    } catch (e) { /* 元素不在视口里，elementFromPoint 会返回 null，不算异常 */ }
    const own = Object.keys(one).slice(0, 14);
    const strProps = own.filter(k => typeof one[k] === 'string' && one[k])
      .map(k => k + '="' + String(one[k]).slice(0, 60) + '"');
    log('公式宿主探针：<' + one.tagName.toLowerCase() + '> 属性[' +
      Array.from(one.attributes).map(a => a.name + '=' + String(a.value).slice(0, 40)).join(' ') + '] ' +
      props.join(' ') + ' 尺寸=' + Math.round(r.width) + '×' + Math.round(r.height) +
      ' 命中=' + hit + ' 祖先=' + chain.join('<') +
      ' 自有键=' + (own.join(',') || '无') + (strProps.length ? ' 字符串属性=' + strProps.join(' ') : ''));
    return empty.length;
  }

  function candidatesToMain(doc) {
    const cut = [];
    doc.querySelectorAll('script,style,noscript,link,iframe,form,nav,header,footer,aside,[hidden],[aria-hidden="true"]')
      .forEach(el => {
        // 公式子树里的 aria-hidden / hidden 是排版语义，不是可丢的装饰，见 inMathTree
        if (inMathTree(el) && (el.hasAttribute('aria-hidden') || el.hasAttribute('hidden'))) return;
        const p = el.parentNode;
        if (!p) return;
        cut.push([el, p, el.nextSibling]);
        p.removeChild(el);
      });
    let main = null;
    try {
      main = pickMain(doc);
    } finally {
      // 抛异常也算失败，一样得把删掉的东西放回原处
      if (!main) {
        // 倒序插回：正序时后一个兄弟还捏在 cut 里没上树，insertBefore 会抛错只能 append，
        // 结果顺序就乱了。倒着来，每个节点的 next 都已经回到原位
        for (let i = cut.length - 1; i >= 0; i--) {
          const [el, p, next] = cut[i];
          try { p.insertBefore(el, next); } catch (e) { p.appendChild(el); }
        }
        // 定位正文起点时打的标记，回退路径上没人清理
        doc.querySelectorAll('[data-spf-start]').forEach(el => el.removeAttribute('data-spf-start'));
      }
    }
    return main;
  }

  function pickMain(doc) {
    const norm = s => (s || '').replace(/\s+/g, '');
    const dbg = m => console.log('[SPF] ' + m);
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
    /* 4b) AI 问答页：上面按段落打分挑出来的十有八九是“最后一条回答”那一个气泡
       （Gemini 的 .markdown-main-panel、ChatGPT 的 [data-message-author-role]），
       用户提问和其它轮次都在它外面，直接保存就只剩半截对话。识别到会话容器时
       把正文盒上提，按“提问 → 回答”的文档顺序逐轮保留 */
    let chatBox = false;
    if (CFG.chatMode) {
      // “回答块”标记：数它有几个才知道这是不是一轮以上的会话
      const ANSWER_SEL = '.markdown-main-panel,.markdown-body,.ProseMirror,' +
        '[class*="model-response"],[class*="message-content"],[class*="response-container"],' +
        '[class*="message-bubble"],[data-message-author-role]';
      // 提问气泡只用来认“这是问答页”，不参与轮次计数：
      // 一个 .turn 里就有一问一答两个块，按它数会把每一轮都当成会话列表，
      // 上提停在第一轮里，第二轮照样丢
      const TURN_SEL = ANSWER_SEL + ',[class*="user-query"],[class*="message-content-user"]';
      const count = (el, sel) => { try { return el.querySelectorAll(sel).length; } catch (e) { return 0; } };
      /* 轮数只能数“最外层”的回答块：一条回答往往是 .response-container 套着
         .markdown-main-panel，气泡底下还挂着 .model-response-footer 这类操作条，
         按原始命中数算一条能数出四五个，于是“这条气泡其实只有一轮”会被误判成
         “已经是多轮容器”，上提直接跳过，存的还是单轮。
         操作条必须从计数里剔掉：Gemini 一条回答里 .model-response-footer +
         .message-content-actions 就能凑够 2，往上找的那一步于是停在单轮容器上 */
      const CHROME_YARD_RE = /footer|toolbar|action|vote|feedback|thumb|share|regenerate|cursor/i;
      const answerBlocks = el => {
        let list = [];
        try { list = Array.from(el.querySelectorAll(ANSWER_SEL)); } catch (e) { return 0; }
        if (list.length > 400) return list.length;
        list = list.filter(n => !CHROME_YARD_RE.test(cls(n)));
        return list.filter(n => !list.some(o => o !== n && o.contains(n))).length;
      };
      if (answerBlocks(best) < 2 && count(doc.body, TURN_SEL) >= 2) {
        const oneTurn = norm(best.textContent).length;
        /* 认类名靠不住：Gemini 每一轮自己就套着一个 .conversation-container，
           它在文档里排在回答前面，提问在它外面。停在“第一个像会话容器的祖先”上，
           存出来还是只有一轮。所以一路往上数，取“回答块最多”的那一层；
           文字量突然翻好几倍说明已经窜到整页布局，那层就不要了 */
        let want = null, wantN = answerBlocks(best);
        for (let a = best.parentNode; a && a !== doc.body; a = a.parentNode) {
          const n = answerBlocks(a);
          if (n < 2 || n <= wantN || outsideWin(a)) continue;
          if (norm(a.textContent).length > Math.max(6000, oneTurn * 10)) break;
          want = a;
          wantN = n;
        }
        if (want) {
          best = want;
          chatBox = true;
        } else {
          dbg('问答页：往上找不到同时装着多轮回答的容器，只保留当前这一轮');
        }
      }
      if (chatBox) dbg('问答页：正文盒上提到会话容器 <' + best.tagName.toLowerCase() +
        ' class="' + cls(best) + '">，圈进 ' + answerBlocks(best) + ' 个回答块');
    }
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
    // 问答盒的开头往往是侧栏标题、模型选择器之类，按“上一兄弟是标题”找正文起点
    // 只会搬错东西，这种情况直接用页面标题生成 h1
    if (best.parentNode && !chatBox) markStart(best);
    // 没按页面标题定位成功时，退回老办法：正文盒里的第一个标题当文章标题。
    // 已经定位到 hTitle 就不要乱标盒内的标题，免得把正文里的小标题吞掉
    if (!hTitle && !chatBox) {
      const inBox = best.querySelector('h1,h2,h3');
      if (inBox && norm(inBox.textContent).length < 120) {
        inBox.dataset.spfStart = '1';
        starts.unshift(inBox);
      }
    }
    const SECTION_RE = /精选|栏目|列表|推荐|热门|相关|更多|专题|标签|阅读|评论|关注/;
    /* “推荐/相关/精选”这类栏目词判杂质。问答模式下正文盒已经收到会话容器里了，
       提问和回答里出现“推荐个发行版”“相关阅读…”这种词太正常，按栏目词误杀会把
       整条提问丢掉；这里只让又短、又确实是界面标签的行（“相关内容”“查看引用”）命中 */
    const sectionNoise = (s, t) => SECTION_RE.test(s) && (!chatBox || t < 20);
    const okBlock = el => {
      const t = norm(el.textContent).length;
      // 只有几乎没文字的块才算“图片行”；正文段落里夹一张图、末尾再挂几条参考链接时
      // 链接密度会轻易超过 0.4，按图片行的严格标准判会把整段正文（和那张图）一起丢掉。
      // 判定要和下面 kind() 保持一致
      const img = el.tagName === 'IMG' || (t < 40 && !!el.querySelector('img'));
      const lt = linkTextOf(el);
      if (img) return t === 0 || lt / t < 0.4;  // 正文图：纯图行或低文案
      if (t < 20) return false;                  // 碎屑（含空行）
      if (t < 60 && lt > 0 && !/https?:\/\/|www\./i.test(el.textContent || '')) return false; // 短条目行：栏目列表/日期条目
      if (t < 80 && sectionNoise(el.textContent, t)) return false;
      return true;
    };
    // 5) 递归收集正文盒内的“叶子块”：只认“里面没有别的块级元素”的最内层文字块，
    //    老式排版常见的 <div><table><tr><td>段落</td></tr></table></div> 会被钻到 td
    // SECTION 也算文字块：不少站点（大道家园这类）正文就是一个个 <section>，
    // 不认它的话整段正文会被“往下钻”钻没了，只剩里面的图片
    const TEXT_LEAF_RE = /^(P|PRE|BLOCKQUOTE|IMG|DIV|SPAN|FONT|TD|LI|DT|DD|H[1-6]|SECTION)$/;
    const INNER_BLOCK = 'div,p,table,ul,ol,section,article,main,td,li,blockquote,pre,h1,h2,h3';
    // 代码块和表格的样式写在“外层 class + 内层标签”的组合选择器上
    // （如 .markdown_views .prism .token.comment / .markdown_views table tr），
    // 拆成一段段 <p> 就再也命中不了，所以这两种整块保留、不往下钻
    const CODE_BOX_RE = /(prism|highlight|hljs|prettyprint|syntax|language-|code)/i;
    // 纯链接列表（导航条、相关阅读、友情链接）：文字几乎全在 <a> 里，不是正文
    const isLinkList = el => {
      const t = norm(el.textContent).length;
      if (!t) return true;
      return linkTextOf(el) / t > 0.5;
    };
    /* Gemini 这类问答站会在句子中间插引用：一个 <source-footnote> 角标，紧跟一个来源条
       <div dir="auto"><span style="max-width: 20ch">腾讯云 - Tencent</span></div>。
       原样搬进离线文件，正文里就多出“Tiny Core / 腾讯云 - Tencent”这种断句碎片。
       ch 单位的 max-width 是它按文字宽度自适应的写法，认这个特征比认 Angular
       动态生成的 _ngcontent-* 属性可靠得多 */
    const CHIP_RE = /max-width:\s*\d+(?:\.\d+)?ch/i;
    const CITE_RE = /source-footnote|footnote-sup|citation|cdc-itibar|cdc-lib/i;
    const isCitation = el => {
      if (el.tagName.toLowerCase() === 'source-footnote' ||
          CITE_RE.test(cls(el)) || CITE_RE.test(el.id || '')) return true;
      const t = norm(el.textContent).length;
      if (!t || t > 30) return false;              // 来源条就是站点名，长不了
      if (CHIP_RE.test(el.getAttribute('style') || '')) return true;
      return /^(div|span|a|p|li)$/.test(el.tagName.toLowerCase()) &&
        Array.from(el.querySelectorAll('[style]')).some(n => CHIP_RE.test(n.getAttribute('style') || ''));
    };
    // 交互外壳：代码块的“复制/下载”按钮、图标按钮、引用角标，离线文件里点不动，留着只是噪音
    const CHROME_SEL = 'button, [role="button"], input[type="button"], [class*="icon-button"], ' +
      '[class*="copy-button"], mat-icon, gem-icon, gem-icon-button, source-footnote, [class*="source-footnote"]';
    const blocks = [];
    (function walk(node) {
      Array.from(node.children).forEach(c => {
        if (c.hasAttribute('data-spf-start') || c === hTitle) return; // 标题单独放在最前面
        if (!inWindow(c)) { walk(c); return; } // 罩住别篇文章的容器：钻进去继续找
        if (isCitation(c)) return;             // 引用碎片整块丢掉，不往下钻
        if (c.tagName === 'IMG') { blocks.push(c); return; }
        if (c.tagName === 'TABLE' && (c.querySelectorAll('tr').length >= 2 ||
            norm(c.textContent).length >= 80)) { blocks.push(c); return; }
        /* 列表整块保留：<li> 常见写成“行首粗体小标题 + 内层 <p> 说明”，往下钻只会
           收走内层 <p>，小标题和 1./2. 编号一起丢，存出来就是散装段落看着缺一段。
           纯链接列表（导航、相关阅读）不适用，照旧下钻当杂质处理 */
        if ((c.tagName === 'UL' || c.tagName === 'OL') && !isLinkList(c)) { blocks.push(c); return; }
        if (/^(DIV|FIGURE|SECTION)$/.test(c.tagName) && CODE_BOX_RE.test(cls(c)) &&
            c.querySelector('pre,code') &&
            !c.querySelector('p,h1,h2,h3,h4,h5,h6,li,blockquote,table')) {
          blocks.push(c); return;   // 纯代码块外壳（里面除了代码没有别的正文）
        }
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
      if (t > 0 && t < 200 && URLISH_RE.test(s) && !sectionNoise(s, t)) return 2;
      if (t >= 35 && lt / t < 0.5) return 2;
      if (t > 0 && lt === 0 && !sectionNoise(s, t)) return 1;
      return 0;
    });
    const charsAt = i => norm(blocks[i].textContent).length;
    const bodyIdx = kind.map((k, i) => k === 2 ? i : -1).filter(i => i >= 0);
    if (!bodyIdx.length) { dbg('正文盒内没有正文长段/图片行，回退整页'); return null; }
    let first = bodyIdx[0];
    /* 问答页：会话开头那句提问只有十几个字，判成“短标题行”排在第一个正文段前面，
       而窗口是从第一个正文段起算的，于是第一轮的问题被单独切在窗口外（第二轮的问题
       在窗口中间反而能留下）。往回并上紧邻的短行，每一轮的提问才齐全 */
    if (chatBox) { while (first > 0 && kind[first - 1] === 1) first--; }
    let last = bodyIdx[bodyIdx.length - 1];
    const tailFrom = last + 1;
    // 紧跟正文末尾的短行（作者/出处/链接等）一并保留，最多 6 行
    for (let i = tailFrom, n = 0; i < kind.length && n < 6; i++, n++) {
      const el = blocks[i];
      const s = el.textContent || '';
      const t = norm(s).length;
      const img = el.tagName === 'IMG' || !!el.querySelector('img');
      if ((!t && !img) || t > 200 || sectionNoise(s, t)) break;
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
    // 清洗会剥掉 class，所以要在清洗前判断正文里有没有这三类内容
    const hasKept = sel => kept.some(el => (el.matches && el.matches(sel)) || el.querySelector(sel));
    articleFlags = {
      math: hasKept('.katex,.MathJax,.mjx-chtml,.mjx-container,math'),
      code: hasKept('pre,code,.hljs,.highlight,[class*=language-]'),
      table: hasKept('table')
    };
    // 输出时统一“脱壳”：td/li/span 之类的单元格块改写成 <p>，并去掉排版属性，
    // 免得老站用表格排版时段落在纯净页面里变成一格一格的方框
    const LAYOUT_ATTRS = ['class', 'id', 'align', 'valign', 'border', 'cellpadding',
      'cellspacing', 'bgcolor', 'width', 'height', 'hspace', 'vspace', 'itemprop', 'role'];
    // 公式（KaTeX / MathJax）、代码块、表格全靠 class 和内联 style 排版，
    // 剥掉就散成一行乱字符 / 丢掉高亮和边框，所以这些子树整体跳过清洗，
    // 让上面按同样关键字挑出来的原文 CSS 能命中
    const KEEP_SEL = '.katex,.MathJax,.MathJax_Display,.MathJax_SVG,.mjx-container,.mjx-chtml,math,' +
      'pre,code,.hljs,.highlight,[class*=language-],table,thead,tbody,tfoot,tr,td,th,col,colgroup,caption';
    const cleanLayout = root => {
      const els = root.tagName === 'IMG' ? [root] : [root].concat(Array.from(root.querySelectorAll('*')));
      els.forEach(el => {
        const math = !!(el.closest && el.closest(KEEP_SEL));
        if (!math) LAYOUT_ATTRS.forEach(a => {
          // width/height 是 <img> 和 <svg> 的固有尺寸：删掉后 SVG 会掉回 300×150 的
          // 默认尺寸，公式里的重音/箭头小图标会被撑成一大块，所以这两个标签都豁免
          if ((a === 'width' || a === 'height') && /^(IMG|svg)$/.test(el.tagName)) return;
          el.removeAttribute(a);
        });
        Array.from(el.attributes || []).forEach(at => {
          if (/^data-|^on/i.test(at.name)) el.removeAttribute(at.name);
        });
        if (!math && el.hasAttribute('style')) {
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
      // 代码块外壳整块保留时，里面的“复制/下载代码”按钮一起进来了，剥掉
      if (node.querySelectorAll) node.querySelectorAll(CHROME_SEL).forEach(b => b.remove());
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
    if (title) {
      // 文件名就用文章自己的标题，别用 document.title（站名/专栏名都挂在上面）
      articleTitle = (title.textContent || '').replace(/\s+/g, ' ').trim();
      appendBlock(title);
    }
    kept.forEach(appendBlock);
    // 清洗后文字太少视为提取失败，交回上层回退整页
    const remain = Array.from(wrap.children)
      .reduce((a, e) => a + norm(e.textContent).length, 0);
    dbg('块=' + blocks.length + ' 正文区=[' + first + ',' + last + '] 保留=' + kept.length +
      ' 标题=' + (title ? norm(title.textContent).slice(0, 24) : '无') +
      ' 字数=' + remain + (remain < 200 ? ' → 不足200字，回退整页' : ''));
    if (remain < 200) return null;
    // 正文里有公式 / 代码 / 表格时，把正文盒自己的 class/id 挂回外层包装：
    // 原文那套组合选择器（.markdown_views .prism .token.comment、.markdown_views table）
    // 前缀就写在它身上，没有前缀规则根本命中不到。没有这三类内容时保持原来的干净输出
    if (articleFlags.math || articleFlags.code || articleFlags.table) {
      if (best.id) wrap.id = best.id;
      if (cls(best).trim()) wrap.className = cls(best).trim();
    }
    return wrap;
  }

  function extractArticle(doc, main) {
    // Document 只能有一个元素子节点 <html>；一次替换出唯一的一对 head/body，
    // 不要用 innerHTML 清空（会留下多余的 <body>，导致正文“看不见”）
    const body = doc.createElement('body');
    body.appendChild(main);   // 保留外层包装：它可能带着正文盒的 class/id，原文的组合选择器靠它命中
    // 标题下附上原文地址，离线回看时能直接跳回原页面
    const src = doc.createElement('p');
    src.className = 'spf-src';
    const a = doc.createElement('a');
    a.href = location.href;
    a.textContent = location.href;
    src.appendChild(a);
    const first = main.firstElementChild;
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
    // shadow DOM 里搬出来的组件样式（KaTeX 公式、代码块外壳）：正文模式把原页面样式表
    // 全删了，不补这一段的话公式虽然内容还在，也会散成一行没有排版的乱字
    if (shadowCss.length) add('style', { 'data-href': '(shadow DOM 组件样式)' }, shadowCss.join('\n'));
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

  // 勾选框自带的内联样式：有些站点把 input 整成 appearance:none / display:none，
  // 只靠 #spf-css 会被同优先级的页面规则压过去，这里再内联一份带 !important 的兜底
  const BOX_STYLE = ' style="appearance:checkbox!important;-webkit-appearance:checkbox!important;' +
    'display:inline-block!important;visibility:visible!important;opacity:1!important;' +
    'width:13px!important;height:13px!important;margin:0 6px 0 0!important;' +
    'vertical-align:middle!important;accent-color:#0969da!important"';

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
#spf-body input[type="checkbox"]{-webkit-appearance:checkbox!important;appearance:checkbox!important;
  display:inline-block!important;visibility:visible!important;opacity:1!important;
  width:13px!important;height:13px!important;min-width:13px!important;min-height:13px!important;
  max-width:none!important;max-height:none!important;margin:0 6px 0 0!important;padding:0!important;
  border:0!important;background:#fff!important;position:static!important;float:none!important;
  vertical-align:middle!important;accent-color:#0969da!important}
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
      '<label><input type="checkbox" id="spf-lazy" checked' + BOX_STYLE + '> 还原懒加载图片</label>' +
      '<label><input type="checkbox" id="spf-fonts" checked' + BOX_STYLE + '> 内联字体文件</label>' +
      '<label><input type="checkbox" id="spf-scripts" checked' + BOX_STYLE + '> 移除脚本（推荐）</label>' +
      '<label><input type="checkbox" id="spf-article" checked' + BOX_STYLE + '> 仅保存正文（默认选中）</label>' +
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
      articleFlags = { math: false, code: false, table: false };
      articleTitle = '';
      fontCssText = '';
      fontCssDown = [];
      fontCssUrls.clear();
      fontFaceStats = { total: 0, kept: 0, slim: false };
      shadowCss = [];
      shadowCssSeen.clear();
      shadowLifted = 0;
      logLines.length = 0;
      missingMsgs = [];
      const doc = document.cloneNode(true);
      /* shadow DOM 必须在取快照这一步就展开：正文提取、资源收集、最后的 outerHTML
         序列化全都只看轻 DOM，晚一步 KaTeX 公式就已经是个空壳了 */
      let shadowStyles = 0;
      if (CFG.shadowLift) {
        try {
          liftShadow(document.documentElement, doc.documentElement);
          shadowStyles = gatherShadowStyles(doc);
          if (shadowCss.length) {
            const st = doc.createElement('style');
            st.setAttribute('data-href', '(shadow DOM 组件样式)');
            st.textContent = shadowCss.join('\n');
            (doc.head || doc.documentElement).appendChild(st);
          }
        } catch (e) { console.warn('[SPF] shadow DOM 展开失败：' + (e && e.message)); }
      }
      if (shadowLifted) status('shadow DOM：展开 ' + shadowLifted + ' 个组件，样式 ' + shadowStyles + ' 段');
      /* 公式渲染在 closed shadow root 里时脚本读不到 shadowRoot，搬不出内容，
         轻 DOM 只剩 <span class="katex"></span> 一个空壳。这种必须说清楚，
         否则用户只看到“公式全没了”，根本猜不到是浏览器不让读 */
      const emptyMath = probeMath();
      if (emptyMath) note('公式：' + emptyMath + ' 处展开后仍是空的，渲染结果在脚本读不到的地方' +
        '（多半是 closed shadow root），细节看日志里的“公式宿主探针”', true);
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
          /* 上面探针查的是页面上的实时 DOM，这里查的是保存结果：页面上有内容而存出来
             是空壳，说明是清理/提取这一步把公式删了，不是浏览器不让读。少了这一行，
             自己删掉的东西只能靠人肉对比文件看出来 */
          const lost = mathShells(doc.body).length;
          if (lost) note('公式：保存结果里还有 ' + lost + ' 处空壳，页面上原本有内容，是提取过程丢的', true);
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
        if ((!res || !res.buf) && !(res && res.rateLimit) && CFG.retry > 0) {
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
        // 字体 / 公式样式是第 3b 步才写进占位 <style> 的（步骤 1 记录它时还是空的），
        // 这里得按元素当前内容来做替换，否则会被当初记下的空文本覆盖掉
        const isFontSlot = ci.el.getAttribute &&
          ci.el.getAttribute('data-href') === '(正文用字体/图标样式)';
        const text = convCss((isFontSlot ? ci.el.textContent : ci.text) || '', ci.base);
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
      const name = (articleTitle || pageTitle() || location.hostname || 'page')
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
          '，抓到规则 ' + fontKeptRules + ' 条，@font-face ' + fontFaceStats.kept + '/' + fontFaceStats.total +
          (fontFaceStats.slim ? '（瘦身后丢掉 ' + (fontFaceStats.total - fontFaceStats.kept) + ' 个用不上的家族）' : '') +
          '，涉及字体文件 ' +
          Array.from(seen).filter(u => FONT_EXT.test(u)).length + ' 个' + mnote,
          fontKeptRules === 0);
      }
      if (shadowLifted) note('Shadow DOM：展开 ' + shadowLifted + ' 个组件（公式、代码块这类内容渲染在 shadow 里，' +
        '不展开存出来是空壳），补回组件样式 ' + shadowCss.length + ' 段' +
        (shadowLifted >= SHADOW_CAP ? '，到上限 ' + SHADOW_CAP + ' 个为止' : ''));
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
