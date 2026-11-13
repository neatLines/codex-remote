import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import './public/relay-transport.js';
import { connectWebSocketClient } from './ws-minimal.mjs';

const preferPoll = new Set();
function nodeFetch(ca) {
  return (url, options = {}) => new Promise((resolve, reject) => {
    const target = new URL(url), secure = target.protocol === 'https:';
    const request = (secure ? https : http).request(target, { method: options.method || 'GET', headers: options.headers,
      ...(secure && ca ? { ca } : {}), signal: options.signal }, response => {
      let size = 0; const chunks = [];
      response.on('data', chunk => { size += chunk.length; if (size > 16 * 1024 * 1024) response.destroy(new Error('HTTP transport response too large')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300,
        json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    request.on('error', reject); request.end(options.body);
  });
}

export async function connectHttpPollClient(url, { ca, headers = {} } = {}) {
  const target = new URL(url); target.protocol = ['wss:', 'https:'].includes(target.protocol) ? 'https:' : 'http:';
  const fetcher = nodeFetch(ca);
  const Socket = globalThis.CodexRelayTransport.createWebSocketClass({ NativeWebSocket: null, mode: 'poll', location: target,
    fetch: (address, options) => fetcher(address, { ...options, headers: { ...headers, ...options.headers } }) });
  const socket = new Socket(url); socket.binaryType = 'arraybuffer';
  class Connection extends EventEmitter {
    get readyState() { return socket.readyState; }
    get transport() { return 'poll'; }
    send(data) { if (socket.readyState !== 1) return false; socket.send(typeof data === 'string' || ArrayBuffer.isView(data) || data instanceof ArrayBuffer ? data : JSON.stringify(data)); return true; }
    _writeFrame(opcode, data) { socket.send(opcode === 2 ? data : data.toString()); }
    close(code = 1000, reason = '') {
      socket.close(code, reason);
      return new Promise(resolve => {
        const timer = setTimeout(resolve, 1500);
        Promise.resolve(socket.closed).finally(() => { clearTimeout(timer); resolve(); });
      });
    }
    ping() {}
  }
  const connection = new Connection();
  socket.onmessage = event => connection.emit('message', typeof event.data === 'string' ? event.data : Buffer.from(event.data));
  socket.onclose = event => connection.emit('close', event.code, event.reason);
  socket.onerror = () => { if (connection.listenerCount('error')) connection.emit('error', new Error('HTTP polling transport error')); };
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('close', () => reject(new Error('HTTP polling connection failed')), { once: true });
  });
  return connection;
}

export async function connectRelayTransport(url, options = {}) {
  const mode = options.mode || process.env.CODEX_RELAY_TRANSPORT || 'auto';
  if (!['auto', 'poll', 'websocket'].includes(mode)) throw new Error('Invalid relay transport');
  if (mode !== 'poll' && !(mode === 'auto' && preferPoll.has(url))) {
    try {
      const ws = await connectWebSocketClient(url, { ...options, timeoutMs: options.timeoutMs ?? 4000 });
      const started = Date.now();
      ws.on('close', code => { if (mode === 'auto' && code !== 1000 && Date.now() - started < 10000) preferPoll.add(url); });
      ws.transport = 'websocket'; return ws;
    } catch (error) { if (mode === 'websocket') throw error; preferPoll.add(url); }
  }
  return connectHttpPollClient(url, options);
}
