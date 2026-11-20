import http from 'node:http';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { brotliDecompressSync, gunzipSync, gzip, inflateSync } from 'node:zlib';
import { acknowledge, cleanHeaders, decodeChunk, endStream, queueChunk } from './dsh-tunnel.mjs';

const compressWebAsset = promisify(gzip);

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
  window.Request = class extends RequestBase { constructor(input, init) { super(input instanceof RequestBase ? input : map(input), init); } };
  async function fetchMappedRequest(input, init, url) {
    const request = new RequestBase(input, init);
    // Passing a Request as RequestInit exposes its ReadableStream body. Chromium
    // then requires HTTP/2 even when the original upload was an ordinary string.
    // Preserve native requests whenever possible; materialize only bodies whose
    // URL still needs rewriting (e.g. requests created before this shim loaded).
    const body = request.body === null ? undefined : await request.blob();
    return fetchBase(url, {
      method: request.method, headers: request.headers, body,
      mode: request.mode, credentials: request.credentials, cache: request.cache,
      redirect: request.redirect, referrer: request.referrer,
      referrerPolicy: request.referrerPolicy, integrity: request.integrity,
      keepalive: request.keepalive, signal: request.signal,
    });
  }
  window.fetch = (input, init) => {
    if (!(input instanceof RequestBase)) return fetchBase(map(input), init);
    const url = map(input.url);
    return url === input.url ? fetchBase(input, init) : fetchMappedRequest(input, init, url);
  };
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

export function createLocalAgentBridge({ getTarget }) {
  const tunnels = new Map();
  let send = () => false;
  function dispose(entry, notify = false) {
    if (!tunnels.delete(entry.id)) return;
    entry.request?.destroy(); entry.socket?.destroy();
    entry.source?.destroy();
    if (notify) entry.send({ type: 'local/close', id: entry.id });
  }
  function fail(entry) {
    if (!tunnels.has(entry.id)) return;
    entry.send({ type: 'local/error', id: entry.id }); dispose(entry);
  }
  function write(entry, chunk) {
    if (!entry.destination) { entry.pending = chunk; return; }
    entry.destination.write(chunk, (error) => {
      if (error) return fail(entry);
      if (tunnels.has(entry.id)) entry.send({ type: 'local/ack', id: entry.id });
    });
  }
  async function open(message) {
    const entry = { id: message.id, port: message.port, send, websocket: Boolean(message.websocket), ended: false };
    tunnels.set(entry.id, entry);
    try {
      if (typeof message.path !== 'string' || !message.path.startsWith('/') || /[\r\n]/.test(message.path)) throw new Error('Invalid local web path');
      const target = await getTarget(message);
      const rewriter = target.rewriteResponse;
      if (!tunnels.has(entry.id)) return;
      const base = new URL(target.base);
      if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw new Error('Invalid local web target');
      const localHeaders = { authorization: true, cookies: true };
      const headers = cleanHeaders(message.headers, entry.websocket, localHeaders);
      headers.host = base.host;
      headers.origin = base.origin;
      if (target.cookie) headers.cookie = target.cookie;
      if (target.authorization) headers.authorization = target.authorization;
      if (rewriter) headers['accept-encoding'] = 'identity';
      if (entry.websocket) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket'; }
      const request = http.request({ hostname: base.hostname, port: base.port, method: message.method,
        path: message.path, headers, agent: false }, async (response) => {
        if (entry.websocket) { response.resume(); fail(entry); return; }
        if (!tunnels.has(entry.id)) { response.destroy(); return; }
        let source = response;
        const responseHeaders = cleanHeaders(response.headers, false, localHeaders);
        if (target.privateSession) delete responseHeaders['set-cookie'];
        const rewrite = rewriter?.matches(message.path, responseHeaders);
        const html = /text\/html/i.test(responseHeaders['content-type'] || '');
        if (message.method !== 'HEAD' && (rewrite || html)) {
          try {
            const chunks = []; let length = 0;
            for await (const chunk of response) {
              length += chunk.length;
              if (length > 16 * 1024 * 1024) throw new Error('Web asset too large');
              chunks.push(chunk);
            }
            if (!tunnels.has(entry.id)) return;
            let body = Buffer.concat(chunks);
            if (rewrite) body = await rewriter.transform(message.path, body, responseHeaders);
            else {
              const coding = responseHeaders['content-encoding'], options = { maxOutputLength: 16 * 1024 * 1024 };
              if (coding === 'gzip') body = gunzipSync(body, options);
              else if (coding === 'br') body = brotliDecompressSync(body, options);
              else if (coding === 'deflate') body = inflateSync(body, options);
              else if (coding && coding !== 'identity') throw new Error('Unsupported HTML encoding');
            }
            if (html) {
              let text = body.toString('utf8');
              if (!text.includes('src="/relay-transport.js"')) {
                const script = '<script src="/relay-transport.js"></script>';
                text = /<head\b[^>]*>/i.test(text) ? text.replace(/<head\b[^>]*>/i, '$&' + script) : script + text;
              }
              body = Buffer.from(text);
            }
            delete responseHeaders['content-encoding']; delete responseHeaders.etag;
            if (/\bgzip\b(?!\s*;\s*q=0(?:\D|$))/i.test(message.headers?.['accept-encoding'] || '') && body.length > 1024) {
              body = await compressWebAsset(body);
              responseHeaders['content-encoding'] = 'gzip';
              responseHeaders.vary = 'Accept-Encoding';
            }
            if (!tunnels.has(entry.id)) return;
            responseHeaders['content-length'] = String(body.length);
            responseHeaders['cache-control'] = 'no-store';
            source = Readable.from([body]);
          } catch { fail(entry); return; }
        }
        entry.source = source;
        entry.onEndSent = () => dispose(entry);
        entry.send({ type: 'local/headers', id: entry.id, status: response.statusCode, headers: responseHeaders });
        source.on('data', (chunk) => { try { queueChunk(entry, chunk); } catch { fail(entry); } });
        source.on('end', () => endStream(entry));
        source.on('error', () => fail(entry));
        source.on('aborted', () => fail(entry));
      });
      entry.request = request;
      entry.destination = request;
      request.on('error', () => fail(entry));
      request.on('upgrade', (response, socket, head) => {
        if (!entry.websocket || !tunnels.has(entry.id)) { socket.destroy(); return; }
        entry.socket = socket; entry.source = socket; entry.destination = socket;
        entry.onEndSent = () => dispose(entry);
        socket.pause();
        entry.send({ type: 'local/headers', id: entry.id, status: 101, headers: cleanHeaders(response.headers, true, localHeaders) });
        socket.on('data', (chunk) => { try { queueChunk(entry, chunk); } catch { fail(entry); } });
        socket.on('end', () => endStream(entry));
        socket.on('error', () => fail(entry));
        socket.on('close', () => { if (!entry.endPending && !entry.outbound?.length) dispose(entry, true); });
        if (head.length) queueChunk(entry, head); else socket.resume();
      });
      if (entry.pending) { const chunk = entry.pending; entry.pending = null; write(entry, chunk); }
      if (entry.ended || entry.websocket) request.end();
    } catch { fail(entry); }
  }
  return {
    attach(sender) {
      this.disconnect();
      send = (message) => sender({ ...message, type: message.type.replace(/^dsh\//, 'local/') });
    },
    handle(message) {
      if (!message.type?.startsWith('local/')) return false;
      const type = message.type.slice('local/'.length);
      if (type === 'open') {
        if (typeof message.id !== 'string' || tunnels.has(message.id) || tunnels.size >= 128) return true;
        open(message); return true;
      }
      const entry = tunnels.get(message.id);
      if (!entry) return true;
      try {
        if (type === 'data') {
          if (entry.pending) throw new Error('Tunnel flow-control violation');
          write(entry, decodeChunk(message.data));
        } else if (type === 'ack') acknowledge(entry);
        else if (type === 'end') {
          entry.ended = true;
          if (entry.websocket) entry.socket?.end(); else entry.request?.end();
        } else if (type === 'close') dispose(entry);
      } catch { fail(entry); }
      return true;
    },
    disconnect(notify = false, port) {
      for (const entry of tunnels.values()) if (port === undefined || entry.port === port) dispose(entry, notify);
    },
  };
}
