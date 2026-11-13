import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

export function localWebPrefix(agentId, port) {
  if (!/^[a-zA-Z0-9_-]+$/.test(agentId) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local web target');
  return `/local/${agentId}/${port}/`;
}
export function localCookiePrefix(agentId, port) { return `codex_local_${agentId}_${port}_`; }
export function localRequestCookie(value, agentId, port) {
  const prefix = localCookiePrefix(agentId, port);
  return String(value || '').split(';').map(v => v.trim()).filter(v => v.startsWith(prefix)).map(v => v.slice(prefix.length)).join('; ');
}
export function localResponseCookies(values, agentId, port) {
  const prefix = localWebPrefix(agentId, port), namePrefix = localCookiePrefix(agentId, port);
  return (Array.isArray(values) ? values : values ? [values] : []).map(value => {
    const [cookie, ...attributes] = value.split(';');
    let cookiePath = '/';
    const keep = attributes.filter(attribute => {
      const [name, ...rest] = attribute.trim().split('=');
      if (name.toLowerCase() === 'domain') return false;
      if (name.toLowerCase() === 'path') { cookiePath = rest.join('='); return false; }
      return true;
    });
    return `${namePrefix}${cookie}; Path=${prefix}${cookiePath.replace(/^\/+/, '')}${keep.map(v => ';' + v).join('')}`;
  });
}

export function rewriteLocalLocation(value, agentId, port) {
  const prefix = localWebPrefix(agentId, port);
  if (value.startsWith(prefix)) return value;
  if (value.startsWith('/') && !value.startsWith('//')) return prefix.slice(0, -1) + value;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)) {
      return localWebPrefix(agentId, Number(url.port || 80)) + url.pathname.slice(1) + url.search + url.hash;
    }
  } catch {}
  return value;
}

// Delivered before application scripts. Root-relative requests must stay under
// this device/port mount; absolute loopback URLs are routed to that device too.
function installLocalWebProxy({ agentId, port, cookiePrefix }) {
  const mount = `/local/${agentId}/${port}/`, origin = location.origin;
  function map(value) {
    const text = String(value);
    if (/^(?:data:|blob:|javascript:|mailto:|tel:|#)/i.test(text)) return text;
    let url; try { url = new URL(text, location.href); } catch { return text; }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return text;
    const websocket = /^wss?:$/.test(url.protocol);
    if (['127.0.0.1', 'localhost'].includes(url.hostname) && url.host !== location.host) {
      const targetPort = url.port || (['https:', 'wss:'].includes(url.protocol) ? '443' : '80');
      url = new URL(`/local/${agentId}/${targetPort}${url.pathname}${url.search}${url.hash}`, origin);
    } else if (url.host === location.host) {
      if (!url.pathname.startsWith(mount)) url.pathname = mount.slice(0, -1) + url.pathname;
    } else return text;
    if (websocket) url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.href;
  }
  const RequestBase = window.Request;
  const fetchBase = window.fetch.bind(window);
  window.Request = class extends RequestBase { constructor(input, init) { super(input instanceof RequestBase ? new RequestBase(map(input.url), input) : map(input), init); } };
  window.fetch = (input, init) => fetchBase(input instanceof RequestBase ? new RequestBase(map(input.url), input) : map(input), init);
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) { return open.call(this, method, map(url), ...rest); };
  const Socket = window.WebSocket;
  window.WebSocket = class extends Socket { constructor(url, protocols) { super(map(url), protocols); } };
  const Events = window.EventSource;
  if (Events) window.EventSource = class extends Events { constructor(url, options) { super(map(url), options); } };
  if (navigator.sendBeacon) { const beacon = navigator.sendBeacon.bind(navigator); navigator.sendBeacon = (url, data) => beacon(map(url), data); }
  for (const name of ['pushState', 'replaceState']) {
    const original = history[name].bind(history);
    history[name] = (state, title, url) => original(state, title, url == null ? url : map(url));
  }
  // Keep client-side cookie access consistent with proxy-side cookie namespacing.
  const cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  if (cookie?.get && cookie?.set) Object.defineProperty(document, 'cookie', {
    get() { return cookie.get.call(document).split(';').map(v => v.trim()).filter(v => v.startsWith(cookiePrefix)).map(v => v.slice(cookiePrefix.length)).join('; '); },
    set(value) {
      const [pair, ...attributes] = String(value).split(';');
      const keep = attributes.filter(v => !/^\s*(?:domain|path)\s*=/i.test(v));
      const path = attributes.find(v => /^\s*path\s*=/i.test(v))?.split('=').slice(1).join('=') || '/';
      cookie.set.call(document, cookiePrefix + pair + '; Path=' + mount + path.replace(/^\/+/, '') + keep.map(v => ';' + v).join(''));
    },
  });
  // Separate application preferences between devices and ports.
  for (const storageName of ['localStorage', 'sessionStorage']) {
    try {
      const native = window[storageName], prefix = `codex_local:${agentId}:${port}:`;
      const keys = () => Array.from({ length: native.length }, (_, i) => native.key(i)).filter(k => k?.startsWith(prefix));
      const methods = { getItem: key => native.getItem(prefix + key), setItem: (key, value) => native.setItem(prefix + key, value),
        removeItem: key => native.removeItem(prefix + key), clear: () => keys().forEach(k => native.removeItem(k)), key: index => keys()[index]?.slice(prefix.length) ?? null };
      Object.defineProperty(window, storageName, { value: new Proxy(methods, {
        get: (target, key) => key === 'length' ? keys().length : key in target ? target[key] : typeof key === 'string' ? methods.getItem(key) : undefined,
        set: (_, key, value) => { methods.setItem(key, value); return true; },
        deleteProperty: (_, key) => { methods.removeItem(key); return true; },
        ownKeys: () => keys().map(k => k.slice(prefix.length)),
        getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true }),
      }) });
    } catch {}
  }
  // A service worker scoped at '/' could intercept the gateway and other apps.
  if (navigator.serviceWorker) {
    try { Object.defineProperty(navigator, 'serviceWorker', { value: {
      getRegistrations: async () => [], getRegistration: async () => undefined,
      register: async () => { throw new Error('Service workers are unavailable through the local web proxy'); }, controller: null,
    } }); } catch {}
  }
  for (const [type, attr] of [[HTMLAnchorElement, 'href'], [HTMLScriptElement, 'src'], [HTMLLinkElement, 'href'], [HTMLImageElement, 'src'], [HTMLFormElement, 'action']]) {
    const descriptor = Object.getOwnPropertyDescriptor(type.prototype, attr);
    if (descriptor?.set) Object.defineProperty(type.prototype, attr, { ...descriptor, set(value) { descriptor.set.call(this, map(value)); } });
  }
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    return setAttribute.call(this, name, /^(?:href|src|action|poster)$/i.test(name) ? map(value) : value);
  };
  document.addEventListener('click', event => {
    const a = event.target.closest?.('a[href]');
    if (a) { const value = a.getAttribute('href'); if (value && !value.startsWith('#')) a.setAttribute('href', map(value)); }
  }, true);
  document.addEventListener('submit', event => { const form = event.target; if (form.action) form.action = map(form.action); }, true);
}

export function localWebScript(agentId, port) {
  localWebPrefix(agentId, port);
  return `(${installLocalWebProxy.toString()})(${JSON.stringify({ agentId, port, cookiePrefix: localCookiePrefix(agentId, port) })});`;
}

export function localWebRewriter(agentId, port) {
  const prefix = localWebPrefix(agentId, port);
  const rewrite = value => rewriteLocalLocation(value, agentId, port);
  return {
    matches(_path, headers) { return /(?:text\/html|text\/css|(?:java|ecma)script)/i.test(headers['content-type'] || ''); },
    transform(_path, body, headers) {
      const coding = headers['content-encoding'];
      const options = { maxOutputLength: 16 * 1024 * 1024 };
      if (coding === 'gzip') body = gunzipSync(body, options);
      else if (coding === 'br') body = brotliDecompressSync(body, options);
      else if (coding === 'deflate') body = inflateSync(body, options);
      else if (coding && coding !== 'identity') throw new Error('Unsupported local web content encoding');
      let text = body.toString('utf8');
      if (/text\/html/i.test(headers['content-type'])) {
        text = text.replace(/\b(src|href|action|poster)=(['"])((?:\/|https?:\/\/)[^'"]*)\2/gi, (_, attr, quote, url) => `${attr}=${quote}${rewrite(url)}${quote}`);
        const script = `<script src="${prefix}.codex-proxy.js"></script>`;
        if (/<head\b[^>]*>/i.test(text)) text = text.replace(/<head\b[^>]*>/i, '$&' + script);
        else text = script + text;
      } else if (/text\/css/i.test(headers['content-type'])) {
        text = text.replace(/url\(\s*(['"]?)(\/[^)'"\s]+)\1\s*\)/gi, (_, quote, url) => `url(${quote}${rewrite(url)}${quote})`);
      } else {
        // Static module imports bypass fetch(), unlike application API calls.
        text = text.replace(/(\b(?:from\s*|import\s*\(\s*|import\s*))(['"])(\/(?!\/)[^'"\n]+)\2/g, (_, before, quote, url) => before + quote + rewrite(url) + quote);
      }
      return Buffer.from(text);
    },
  };
}
