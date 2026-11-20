import crypto from 'node:crypto';
import { Duplex, PassThrough } from 'node:stream';
import { MinimalWebSocket } from './ws-minimal.mjs';

const session = req => String(req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('codex_remote_session='));
const allowedPath = pathname => pathname === '/ws/client' || pathname === '/ws/agent' || /^\/local\/[a-zA-Z0-9_-]+\/[1-9][0-9]{0,4}\//.test(pathname);

// Enter the existing upgrade handlers over an in-memory socket pair. There is
// no second TCP connection, certificate exception, or parallel authorization path.
function internalWebSocket(server, request, target, protocols) {
  const a = new PassThrough(), b = new PassThrough();
  const client = Duplex.from({ readable: a, writable: b }), socket = Duplex.from({ readable: b, writable: a });
  for (const end of [client, socket]) { end.setNoDelay = () => {}; end.on('error', () => {}); }
  socket.remoteAddress = request.socket.remoteAddress; socket.encrypted = request.socket.encrypted;
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0), settled = false;
    const timer = setTimeout(() => fail(new Error('Upstream WebSocket timed out')), 10000); timer.unref();
    function fail(error) { if (settled) return; settled = true; clearTimeout(timer); client.destroy(); socket.destroy(); reject(error); }
    client.once('end', () => fail(new Error('Upstream WebSocket rejected')));
    client.on('data', function handshake(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const boundary = buffer.indexOf('\r\n\r\n');
      if (boundary < 0) { if (buffer.length > 65536) fail(new Error('Invalid upgrade response')); return; }
      const headers = buffer.subarray(0, boundary).toString();
      const status = Number(/^HTTP\/1\.1 (\d+)/.exec(headers)?.[1]);
      if (status !== 101) { const error = new Error('WebSocket upgrade rejected'); error.status = status || 502; fail(error); return; }
      settled = true; clearTimeout(timer); client.off('data', handshake);
      client.pause();
      const ws = new MinimalWebSocket(client, { isServer: false, maxPayloadBytes: 8 * 1024 * 1024 });
      ws.protocol = /^sec-websocket-protocol:\s*(.+)$/im.exec(headers)?.[1]?.trim() || '';
      const rest = buffer.subarray(boundary + 4);
      setImmediate(() => { if (rest.length) ws._onData(rest); client.resume(); });
      resolve(ws);
    });
    const headers = { host: request.headers.host, cookie: request.headers.cookie, origin: request.headers.origin,
      'sec-fetch-site': request.headers['sec-fetch-site'], connection: 'Upgrade', upgrade: 'websocket',
      'sec-websocket-key': crypto.randomBytes(16).toString('base64'), 'sec-websocket-version': '13',
      ...(protocols.length ? { 'sec-websocket-protocol': protocols.join(', ') } : {}) };
    server.emit('upgrade', { url: target, method: 'GET', headers, socket }, socket, Buffer.alloc(0));
  });
}

export function createHttpPollTransport({ server, isAuthenticated, readJsonBody, sendJson, publicOrigin,
  pollTimeoutMs = 20000, idleTimeoutMs = 60000, maxPeers = 128 } = {}) {
  const peers = new Map(); let queuedBytes = 0, stopping = false;
  function trustedOrigin(req) {
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    if (!req.headers.origin) return true;
    try { return new URL(req.headers.origin).origin === new URL(publicOrigin || `${req.socket.encrypted ? 'https:' : 'http:'}//${req.headers.host}`).origin; }
    catch { return false; }
  }
  function trim(peer, cursor) {
    while (peer.queue[0]?.seq <= cursor) { const event = peer.queue.shift(); peer.bytes -= event.bytes; queuedBytes -= event.bytes; }
    peer.acked = cursor;
  }
  function flush(peer) {
    if (!peer.waiter || (!peer.queue.length && !peer.closed)) return;
    const { res, timer } = peer.waiter; peer.waiter = null; clearTimeout(timer);
    sendJson(res, 200, { events: peer.queue.slice(0, 64).map(({ bytes, ...event }) => event), cursor: peer.queue[Math.min(peer.queue.length, 64) - 1]?.seq ?? peer.acked,
      closed: peer.closed && peer.queue.length <= 64, code: peer.closeCode, reason: peer.closeReason });
  }
  function enqueue(peer, value) {
    if (peer.closed && value.type === 'message') return;
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (peer.bytes + bytes > 8 * 1024 * 1024 || queuedBytes + bytes > 32 * 1024 * 1024) { closePeer(peer, 1013, 'HTTP polling consumer is too slow', true); return; }
    peer.queue.push({ ...value, seq: ++peer.seq, bytes }); peer.bytes += bytes; queuedBytes += bytes; flush(peer);
  }
  function closePeer(peer, code = 1000, reason = '', discard = false) {
    if (peer.closed) return;
    peer.closed = true; peer.closedAt = Date.now();
    peer.closeCode = code; peer.closeReason = reason;
    if (discard) { queuedBytes -= peer.bytes; peer.bytes = 0; peer.queue = []; }
    peer.ws?.close(code, reason);
    enqueue(peer, { type: 'close', code, reason });
  }
  function remove(peer) {
    closePeer(peer, 1001, 'HTTP polling session ended');
    if (peer.waiter) { clearTimeout(peer.waiter.timer); sendJson(peer.waiter.res, 410, { error: 'Session closed' }); peer.waiter = null; }
    queuedBytes -= peer.bytes; peer.bytes = 0; peer.queue = []; peers.delete(peer.id);
    peer.ws?.socket.destroy();
  }
  const sweep = setInterval(() => {
    for (const peer of peers.values()) if (Date.now() - (peer.closedAt || peer.lastSeen) > idleTimeoutMs) remove(peer);
  }, Math.min(10000, idleTimeoutMs)); sweep.unref();

  return {
    async handleHttp(req, res) {
      const url = new URL(req.url, 'http://poll.invalid');
      if (!url.pathname.startsWith('/api/socket/')) return false;
      if (!trustedOrigin(req)) { sendJson(res, 403, { error: 'Cross-origin transport request rejected' }); return true; }
      if (url.pathname === '/api/socket/open' && req.method === 'POST') {
        if (peers.size >= maxPeers) for (const old of peers.values()) { if (old.closed) remove(old); if (peers.size < maxPeers) break; }
        if (stopping || peers.size >= maxPeers) { sendJson(res, 503, { error: 'Transport capacity reached' }); return true; }
        let body;
        try { body = await readJsonBody(req); } catch { sendJson(res, 400, { error: 'Invalid request' }); return true; }
        let target;
        try {
          if (typeof body.path !== 'string' || !body.path.startsWith('/') || body.path.startsWith('//') || body.path.length > 8192 || /[\r\n\\]/.test(body.path)) throw new Error();
          target = new URL(body.path, 'http://poll.invalid');
          if (!allowedPath(target.pathname) || target.hash || target.origin !== 'http://poll.invalid') throw new Error();
        } catch { sendJson(res, 400, { error: 'Invalid WebSocket destination' }); return true; }
        const agent = target.pathname === '/ws/agent';
        if (!agent && !isAuthenticated(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
        const protocols = body.protocols || [];
        if (!Array.isArray(protocols) || protocols.length > 16 || protocols.some(p => typeof p !== 'string' || p.length > 200 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(p)) || new Set(protocols).size !== protocols.length) {
          sendJson(res, 400, { error: 'Invalid WebSocket protocols' }); return true;
        }
        const owner = agent ? `agent:${req.socket.remoteAddress}` : session(req);
        if ([...peers.values()].filter(p => p.owner === owner && !p.closed).length >= 24) { sendJson(res, 429, { error: 'Too many transport sessions' }); return true; }
        const peer = { id: crypto.randomBytes(18).toString('base64url'), token: crypto.randomBytes(32).toString('base64url'),
          owner, agent, queue: [], bytes: 0, seq: 0, acked: 0, sent: 0, lastSeen: Date.now() };
        peers.set(peer.id, peer);
        try {
          peer.ws = await internalWebSocket(server, req, target.pathname + target.search, protocols);
          peer.ws.on('message', data => enqueue(peer, { type: 'message', binary: Buffer.isBuffer(data), data: Buffer.isBuffer(data) ? data.toString('base64') : data }));
          peer.ws.on('close', (code, reason) => closePeer(peer, code, reason));
          peer.ws.on('error', () => closePeer(peer, 1011, 'Upstream connection failed'));
          if (stopping || peer.closed || !peers.has(peer.id) || res.destroyed) { remove(peer); return true; }
          sendJson(res, 200, { id: peer.id, token: peer.token, protocol: peer.ws.protocol });
        } catch (error) { remove(peer); if (!res.destroyed) sendJson(res, error.status || 502, { error: 'WebSocket destination unavailable' }); }
        return true;
      }
      const match = /^\/api\/socket\/([A-Za-z0-9_-]+)(?:\/(events|send))?$/.exec(url.pathname);
      const peer = match && peers.get(match[1]);
      if (!peer || req.headers['x-codex-poll-token'] !== peer.token) { sendJson(res, 404, { error: 'Transport session not found' }); return true; }
      if (!peer.agent && (!isAuthenticated(req) || session(req) !== peer.owner)) { remove(peer); sendJson(res, 401, { error: 'Unauthorized' }); return true; }
      peer.lastSeen = Date.now();
      if (req.method === 'DELETE' && !match[2]) { remove(peer); sendJson(res, 200, { ok: true }); return true; }
      if (req.method === 'GET' && match[2] === 'events') {
        const cursor = Number(url.searchParams.get('cursor') || 0);
        if (!Number.isSafeInteger(cursor) || cursor < peer.acked || cursor > peer.seq) { sendJson(res, 409, { error: 'Invalid transport cursor' }); return true; }
        if (peer.waiter) { sendJson(res, 409, { error: 'A poll is already pending' }); return true; }
        trim(peer, cursor);
        const timer = setTimeout(() => {
          if (peer.waiter?.res !== res) return;
          peer.waiter = null; sendJson(res, 200, { events: [], cursor });
        }, pollTimeoutMs); timer.unref();
        peer.waiter = { res, timer };
        res.once('close', () => { if (peer.waiter?.res === res) { clearTimeout(timer); peer.waiter = null; } });
        flush(peer); return true;
      }
      if (req.method === 'POST' && match[2] === 'send') {
        let body; try { body = await readJsonBody(req, 12 * 1024 * 1024); } catch { sendJson(res, 400, { error: 'Invalid message' }); return true; }
        if (!body || typeof body !== 'object' || Array.isArray(body)) { sendJson(res, 400, { error: 'Invalid message' }); return true; }
        if (!Number.isSafeInteger(body.seq) || body.seq < 1 || body.seq > peer.sent + 1) { sendJson(res, 409, { error: 'Invalid send sequence' }); return true; }
        if (body.seq <= peer.sent) { sendJson(res, 200, { seq: peer.sent }); return true; }
        if (peer.closed) { sendJson(res, 410, { error: 'Transport closed' }); return true; }
        if (typeof body.data !== 'string' || Buffer.byteLength(body.data) > 11 * 1024 * 1024) { sendJson(res, 400, { error: 'Invalid payload' }); return true; }
        const data = Buffer.from(body.data, body.binary ? 'base64' : 'utf8');
        if (body.binary && data.toString('base64') !== body.data) { sendJson(res, 400, { error: 'Invalid binary payload' }); return true; }
        if (data.length > 8 * 1024 * 1024) { sendJson(res, 413, { error: 'Message too large' }); return true; }
        peer.ws._writeFrame(body.binary ? 2 : 1, data); peer.sent = body.seq;
        sendJson(res, 200, { seq: peer.sent }); return true;
      }
      sendJson(res, 405, { error: 'Method not allowed' }); return true;
    },
    closeSession(req) { const owner = session(req); if (owner) for (const peer of peers.values()) if (!peer.agent && peer.owner === owner) remove(peer); },
    close() { stopping = true; clearInterval(sweep); for (const peer of peers.values()) remove(peer); },
    get size() { return peers.size; },
  };
}
