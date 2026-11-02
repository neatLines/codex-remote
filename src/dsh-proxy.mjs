import crypto from 'node:crypto';
import { cleanHeaders, decodeChunk, queueChunk, acknowledge, endStream, MAX_BODY_BYTES } from './dsh-tunnel.mjs';

const ROUTE = /^\/dsh\/([a-zA-Z0-9_-]+)(\/.*)?$/;

export function createDshProxy({ agents, isAuthenticated, isTrusted, publicOrigin }) {
  const tunnels = new Map();
  function route(req) {
    const url = new URL(req.url, 'http://remote.invalid');
    const match = ROUTE.exec(url.pathname);
    return match ? { agentId: match[1], prefix: `/dsh/${match[1]}/`, path: `${match[2] || '/'}${url.search}`, slash: Boolean(match[2]) } : null;
  }
  function error(target, status, message, websocket = false) {
    if (websocket) { target.end(`HTTP/1.1 ${status} Error\r\nConnection: close\r\n\r\n`); return; }
    if (target.headersSent) { target.destroy(); return; }
    target.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    target.end(message);
  }
  function trustedOrigin(req) {
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    if (!req.headers.origin) return true;
    try {
      const expected = publicOrigin || `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
      return new URL(req.headers.origin).origin === new URL(expected).origin;
    } catch { return false; }
  }
  function authorize(req, target, info, websocket) {
    if (!isAuthenticated(req)) {
      if (!websocket && req.method === 'GET' && req.headers.accept?.includes('text/html')) {
        target.writeHead(302, { Location: `/?next=${encodeURIComponent(req.url)}`, 'Cache-Control': 'no-store' }); target.end();
      } else error(target, 401, '请先登录 Codex Remote', websocket);
      return null;
    }
    if (!trustedOrigin(req)) { error(target, 403, '跨站 DSH 请求被拒绝', websocket); return null; }
    const agent = agents.get(info.agentId);
    if (!isTrusted(info.agentId)) { error(target, 403, '请先信任目标设备', websocket); return null; }
    if (!agent) { error(target, 503, '目标设备不在线', websocket); return null; }
    if (!agent.dshWeb?.enabled) { error(target, 503, '目标设备未启用 DSH Web，请重启 codex-up', websocket); return null; }
    if (tunnels.size >= 512 || [...tunnels.values()].filter((entry) => entry.agentId === info.agentId).length >= 128) {
      error(target, 503, 'DSH 连接过多，请稍后重试', websocket); return null;
    }
    return agent;
  }
  function dispose(entry, notify = true) {
    if (!tunnels.delete(entry.id)) return;
    clearTimeout(entry.timer);
    if (notify) entry.send({ type: 'dsh/close', id: entry.id });
  }
  function fail(entry, status, message) {
    if (!tunnels.has(entry.id)) return;
    error(entry.target, status, message, entry.websocket);
    dispose(entry);
  }
  function open(req, target, info, agent, websocket, head) {
    const id = crypto.randomUUID();
    const entry = { id, agentId: info.agentId, agentWs: agent.ws, target, websocket, source: websocket ? target : req,
      prefix: info.prefix, session: req.headers.cookie, bytes: 0, upgraded: false, head,
      send: (message) => agent.ws.send(message) };
    tunnels.set(id, entry);
    entry.timer = setTimeout(() => fail(entry, 504, 'DSH Web 启动或响应超时'), 120000);
    entry.timer.unref();
    entry.source.pause();
    entry.source.on('data', (chunk) => {
      if (!tunnels.has(id)) return;
      try {
        entry.bytes += chunk.length;
        if (!websocket && entry.bytes > MAX_BODY_BYTES) return fail(entry, 413, 'DSH 请求超过 256 MiB');
        queueChunk(entry, chunk);
      } catch { fail(entry, 502, 'DSH 数据传输失败'); }
    });
    entry.source.on('end', () => { if (tunnels.has(id)) endStream(entry); });
    entry.source.on('error', () => dispose(entry));
    target.on('close', () => dispose(entry));
    if (!websocket) req.on('aborted', () => dispose(entry));
    entry.send({ type: 'dsh/open', id, method: req.method, path: info.path,
      headers: cleanHeaders(req.headers, websocket), websocket });
    if (!websocket) entry.source.resume();
  }
  return {
    handleHttp(req, res) {
      const info = route(req);
      if (!info) return false;
      const agent = authorize(req, res, info, false);
      if (!agent) return true;
      if (!info.slash) {
        res.writeHead(308, { Location: info.prefix + new URL(req.url, 'http://remote.invalid').search }); res.end(); return true;
      }
      open(req, res, info, agent, false); return true;
    },
    handleUpgrade(req, socket, head) {
      const info = route(req);
      if (!info) return false;
      const agent = authorize(req, socket, info, true);
      if (agent) open(req, socket, info, agent, true, head);
      return true;
    },
    handleMessage(agentId, ws, message) {
      if (!message.type?.startsWith('dsh/')) return false;
      const entry = tunnels.get(message.id);
      if (!entry || entry.agentId !== agentId || entry.agentWs !== ws) return true;
      try {
        if (message.type === 'dsh/headers') {
          if (entry.headersReceived) throw new Error('Duplicate DSH headers');
          entry.headersReceived = true;
          clearTimeout(entry.timer);
          const headers = cleanHeaders(message.headers, entry.websocket);
          if (typeof headers.location === 'string' && headers.location.startsWith('/')) {
            headers.location = entry.prefix + headers.location.replace(/^\/+/, '');
          }
          if (entry.websocket) {
            if (message.status !== 101 || !headers['sec-websocket-accept']) throw new Error('DSH upgrade rejected');
            entry.target.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
              Object.entries(headers).map(([key, value]) => `${key}: ${value}\r\n`).join('') + '\r\n');
            entry.upgraded = true;
            if (entry.head?.length) queueChunk(entry, entry.head);
            else entry.source.resume();
          } else {
            if (!Number.isInteger(message.status) || message.status < 200 || message.status > 599) throw new Error('Invalid DSH status');
            entry.target.writeHead(message.status, headers);
          }
        } else if (message.type === 'dsh/data') {
          if (!entry.headersReceived) throw new Error('Missing DSH headers');
          entry.target.write(decodeChunk(message.data), () => {
            if (tunnels.has(entry.id)) entry.send({ type: 'dsh/ack', id: entry.id });
          });
        } else if (message.type === 'dsh/ack') acknowledge(entry);
        else if (message.type === 'dsh/end') {
          entry.target.end(); dispose(entry, false);
        } else if (message.type === 'dsh/error') fail(entry, 502, 'DSH Web 暂不可用，请检查本机 Agent');
        else if (message.type === 'dsh/close') { entry.target.destroy(); dispose(entry, false); }
      } catch { fail(entry, 502, 'DSH 代理响应无效'); }
      return true;
    },
    disconnect(ws) {
      for (const entry of tunnels.values()) if (entry.agentWs === ws) fail(entry, 503, '本机 Agent 连接已断开');
    },
    revoke(agentId) {
      for (const entry of tunnels.values()) if (entry.agentId === agentId) fail(entry, 403, '设备信任已撤销');
    },
    closeSession(cookie) {
      for (const entry of tunnels.values()) if (entry.session === cookie) fail(entry, 401, '已退出登录');
    },
    close() {
      for (const entry of tunnels.values()) fail(entry, 503, 'Remote 正在重启');
    },
  };
}
