// Also loaded by Node's Agent adapter. Only browsers install the global shim.
(function(global) {
  if (global.CodexRelayTransport) return;
  function createWebSocketClass({ NativeWebSocket = global.WebSocket, fetch: fetcher = global.fetch.bind(global),
    location: where = global.location, mode = 'auto', handshakeTimeoutMs = 4000, rememberPoll = () => {} } = {}) {
    let preferPoll = mode === 'poll';
    const base = new URL('/api/socket/', where.href);
    function encode(bytes) {
      let text = ''; for (let i = 0; i < bytes.length; i += 16384) text += String.fromCharCode(...bytes.subarray(i, i + 16384));
      return btoa(text);
    }
    function decode(value) { const text = atob(value), bytes = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i); return bytes; }
    class TransportWebSocket extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      get CONNECTING() { return 0; } get OPEN() { return 1; } get CLOSING() { return 2; } get CLOSED() { return 3; }
      constructor(value, protocols = []) {
        super();
        const url = new URL(value, where.href);
        if (url.protocol === 'https:') url.protocol = 'wss:'; if (url.protocol === 'http:') url.protocol = 'ws:';
        if (!['ws:', 'wss:'].includes(url.protocol) || url.hash) throw new SyntaxError('Invalid WebSocket URL');
        const gatewaySocket = url.host === where.host && (['/ws/client', '/ws/agent'].includes(url.pathname) || /^\/local\/[a-zA-Z0-9_-]+\/[1-9][0-9]{0,4}\//.test(url.pathname));
        // Leave unrelated sockets as native objects, including browser tooling
        // and applications that depend on the browser's WebSocket internal slots.
        if (!gatewaySocket && NativeWebSocket) return new NativeWebSocket(url.href, protocols);
        this.url = url.href; this._target = url; this._protocols = typeof protocols === 'string' ? [protocols] : protocols;
        if (!Array.isArray(this._protocols) || this._protocols.some(p => typeof p !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(p)) || new Set(this._protocols).size !== this._protocols.length) throw new SyntaxError('Invalid WebSocket protocols');
        this.readyState = 0; this.protocol = ''; this.extensions = ''; this.transport = 'connecting';
        this.onopen = this.onmessage = this.onclose = this.onerror = null;
        this._binaryType = 'blob'; this._buffered = 0; this._cursor = 0; this._seq = 0; this._controllers = new Set(); this._sendChain = Promise.resolve();
        this._canPoll = gatewaySocket;
        if (preferPoll && this._canPoll) void this._openPoll(); else this._openNative();
      }
      get bufferedAmount() { return this._native?.bufferedAmount ?? this._buffered; }
      get binaryType() { return this._binaryType; }
      set binaryType(value) { if (!['blob', 'arraybuffer'].includes(value)) return; this._binaryType = value; if (this._native) this._native.binaryType = value; }
      _emit(type, values = {}) {
        const event = type === 'message' ? new MessageEvent(type, { data: values.data, origin: new URL(this.url).origin }) : new Event(type);
        if (type !== 'message') for (const [key, value] of Object.entries(values)) Object.defineProperty(event, key, { value });
        this.dispatchEvent(event);
        try { this['on' + type]?.call(this, event); } catch (error) { setTimeout(() => { throw error; }, 0); }
      }
      _openNative() {
        let native;
        try { if (!NativeWebSocket) throw new Error('WebSocket unavailable'); native = new NativeWebSocket(this.url, this._protocols); }
        catch { this._fallback(); return; }
        this._native = native; native.binaryType = this.binaryType;
        const timer = setTimeout(() => { if (this.readyState === 0) this._fallback(); }, handshakeTimeoutMs);
        this._nativeTimer = timer;
        native.onopen = () => {
          if (this._native !== native || this.readyState !== 0) return;
          clearTimeout(timer); this.readyState = 1; this.transport = 'websocket'; this.protocol = native.protocol; this.extensions = native.extensions; this._emit('open');
        };
        native.onmessage = event => { if (this._native === native && this.readyState === 1) this._emit('message', { data: event.data }); };
        native.onerror = () => { if (this._native !== native) return; if (this.readyState === 0) this._fallback(); else this._emit('error'); };
        native.onclose = event => {
          if (this._native !== native) return;
          clearTimeout(timer);
          if (this.readyState === 0) { this._fallback(); return; }
          if (event.code !== 1000 && this._canPoll && mode !== 'websocket') { preferPoll = true; rememberPoll(); }
          this._finish(event.code, event.reason, event.wasClean);
        };
      }
      _fallback() {
        if (this.readyState !== 0) return;
        clearTimeout(this._nativeTimer);
        const native = this._native; this._native = null;
        if (native) { native.onopen = native.onclose = native.onerror = native.onmessage = null; try { native.close(); } catch {} }
        if (!this._canPoll || mode === 'websocket') { this._emit('error'); this._finish(1006, 'WebSocket connection failed', false); return; }
        preferPoll = true; rememberPoll(); void this._openPoll();
      }
      async _request(path, { method = 'GET', body, timeout = 30000 } = {}) {
        const controller = new AbortController(); this._controllers.add(controller);
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
          const response = await fetcher(new URL(path, base).href, { method, credentials: 'same-origin', cache: 'no-store',
            headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this._token ? { 'X-Codex-Poll-Token': this._token } : {}) },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: controller.signal });
          if (!response.ok) { const error = new Error('HTTP transport returned ' + response.status); error.status = response.status; throw error; }
          return await response.json();
        } finally { clearTimeout(timer); this._controllers.delete(controller); }
      }
      async _openPoll() {
        if (this._openingPoll || this.readyState !== 0) return; this._openingPoll = true; this.transport = 'poll';
        try {
          const info = await this._request('open', { method: 'POST', body: { path: this._target.pathname + this._target.search, protocols: this._protocols }, timeout: 15000 });
          this._id = info.id; this._token = info.token;
          if (this.readyState !== 0) { void this._request(this._id, { method: 'DELETE' }).catch(() => {}); return; }
          this.readyState = 1; this.protocol = info.protocol || ''; this._emit('open'); void this._poll();
        } catch { if (this.readyState < 2) { this._emit('error'); this._finish(1006, 'HTTP polling connection failed', false); } }
      }
      async _poll() {
        let failures = 0;
        while (this.readyState === 1) {
          try {
            const batch = await this._request(this._id + '/events?cursor=' + this._cursor); failures = 0;
            for (const event of batch.events) {
              if (event.seq <= this._cursor) continue;
              if (event.type === 'close') { this._cursor = event.seq; this._finish(event.code, event.reason, event.code === 1000); return; }
              let data = event.data;
              if (event.binary) { const bytes = decode(data); data = this.binaryType === 'arraybuffer' ? bytes.buffer : new Blob([bytes]); }
              this._emit('message', { data }); this._cursor = event.seq;
              if (this.readyState !== 1) return;
            }
            this._cursor = batch.cursor;
            if (batch.closed) { this._finish(batch.code || 1000, batch.reason || '', batch.code === 1000); return; }
          } catch (error) {
            if (this.readyState !== 1) return;
            if ((error.status && ![409, 429, 502, 503, 504].includes(error.status)) || ++failures > 8) { this._emit('error'); this._finish(1006, 'HTTP polling disconnected', false); return; }
            await new Promise(resolve => setTimeout(resolve, Math.min(500 * failures, 2000)));
          }
        }
      }
      send(value) {
        if (this.readyState !== 1) throw new DOMException('WebSocket is not open', 'InvalidStateError');
        if (this._native) { this._native.send(value); return; }
        const size = typeof value === 'string' ? value.length : value.byteLength ?? value.size ?? String(value).length;
        const sendDeadline = Date.now() + 45000;
        this._buffered += size;
        if (this._buffered > 16 * 1024 * 1024) { this._finish(1009, 'Send queue limit exceeded', false); return; }
        // Copy mutable byte views at send time, matching the WebSocket API.
        if (value instanceof ArrayBuffer) value = new Uint8Array(value).slice();
        else if (ArrayBuffer.isView(value)) value = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
        this._sendChain = this._sendChain.then(async () => {
          if (this.readyState !== 1) return;
          const binary = value instanceof Uint8Array || value instanceof Blob;
          const data = binary ? encode(value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : value) : String(value);
          const body = { seq: ++this._seq, binary, data };
          for (let retry = 0; ; retry++) {
            try {
              const remaining = sendDeadline - Date.now();
              if (remaining <= 0) throw new Error('HTTP send deadline exceeded');
              await this._request(this._id + '/send', { method: 'POST', body, timeout: Math.min(30000, remaining) }); break;
            }
            catch (error) {
              if (this.readyState !== 1) return;
              if (retry >= 4 || Date.now() + 500 * (retry + 1) >= sendDeadline || (error.status && error.status < 500 && error.status !== 429)) throw error;
              await new Promise(resolve => setTimeout(resolve, 500 * (retry + 1)));
            }
          }
        }).catch(() => { if (this.readyState === 1) { this._emit('error'); this._finish(1006, 'HTTP send failed', false); } }).finally(() => { this._buffered -= size; });
      }
      _finish(code = 1000, reason = '', wasClean = true) {
        if (this.readyState === 3) return;
        clearTimeout(this._nativeTimer); this.readyState = 3;
        for (const controller of this._controllers) controller.abort();
        this._emit('close', { code, reason, wasClean });
      }
      close(code = 1000, reason = '') {
        if (this.readyState >= 2) return;
        if (this._native) { this.readyState = 2; this._native.close(code, reason); return; }
        // Do not abort the close request itself; idle expiry covers network loss.
        const id = this._id, token = this._token;
        this._finish(code, reason, true);
        if (id) this.closed = fetcher(new URL(id, base).href, { method: 'DELETE', credentials: 'same-origin', headers: { 'X-Codex-Poll-Token': token }, keepalive: true }).catch(() => {});
      }
    }
    return TransportWebSocket;
  }
  global.CodexRelayTransport = { createWebSocketClass };
  if (typeof window !== 'undefined' && global === window && window.document) {
    const native = window.WebSocket;
    let mode = 'auto', store;
    try {
      store = window.sessionStorage;
      const requested = new URLSearchParams(location.search).get('transport');
      if (['auto', 'poll', 'websocket'].includes(requested)) store.setItem('codex_relay_transport', requested);
      mode = requested || store.getItem('codex_relay_transport') || 'auto';
    } catch {}
    if (!['auto', 'poll', 'websocket'].includes(mode)) mode = 'auto';
    window.WebSocket = createWebSocketClass({ NativeWebSocket: native, mode, rememberPoll: () => { try { store?.setItem('codex_relay_transport', 'poll'); } catch {} } });
  }
})(globalThis);
