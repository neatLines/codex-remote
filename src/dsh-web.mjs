import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import { Readable } from 'node:stream';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { cleanHeaders, decodeChunk, queueChunk, acknowledge, endStream } from './dsh-tunnel.mjs';

const compressWebAsset = promisify(gzip);
const redact = (text) => String(text).replace(/([?&]token=)[^\s&]+/g, '$1[redacted]');

function exchangeCookie(base, token) {
  return new Promise((resolve, reject) => {
    const req = http.get(new URL(`/?token=${encodeURIComponent(token)}`, base), { agent: false, timeout: 10000 }, (res) => {
      res.resume();
      const cookies = res.headers['set-cookie'];
      if (![302, 303].includes(res.statusCode) || !Array.isArray(cookies) || !cookies.length) {
        reject(new Error('DSH launch-token exchange failed')); return;
      }
      resolve(cookies.map((cookie) => cookie.split(';')[0]).join('; '));
    });
    req.on('timeout', () => req.destroy(new Error('DSH login timeout')));
    req.on('error', reject);
  });
}

export function startManagedDsh({ bin = 'dsh', port = 3081, cwd = os.homedir(), publicUrl, quiet = false,
  startupTimeoutMs = 90000, onStatus = () => {}, onRestart = () => {} } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DSH port must be between 1 and 65535');
  let stopped = false;
  let process;
  let retry;
  let ready;
  let status = { enabled: true, status: 'starting' };
  const publish = (next) => { status = { enabled: true, status: next }; onStatus(status); };
  function launch() {
    publish('starting');
    let resolveReady, rejectReady;
    ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    // Readiness can reject before anyone has opened the proxy page.
    ready.catch(() => {});
    const env = { ...globalThis.process.env };
    if (/^socks/i.test(env.ALL_PROXY || '') && /^https?:/i.test(env.https_proxy || env.HTTPS_PROXY || '')) {
      env.ALL_PROXY = env.https_proxy || env.HTTPS_PROXY;
    }
    const args = ['web', '--no-open', '--host', '127.0.0.1', '--port', String(port)];
    if (publicUrl) args.push('--public-url', publicUrl);
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    process = child;
    let lineBuffer = '';
    let authenticating = false;
    let failed = false;
    const timer = setTimeout(() => {
      rejectReady(new Error('DSH startup timed out')); publish('error');
      try { globalThis.process.kill(-child.pid, 'SIGTERM'); } catch {}
    }, startupTimeoutMs);
    timer.unref();
    child.stdout.on('data', (chunk) => {
      lineBuffer += chunk.toString('utf8');
      const lines = lineBuffer.split('\n');
      lineBuffer = (lines.pop() || '').slice(-65536);
      for (const line of lines) {
        const match = line.match(/dsh web:\s+(https?:\/\/\S+)/);
        if (match && !authenticating && child === process && !stopped) {
          let token;
          try { token = new URL(match[1]).searchParams.get('token'); } catch {}
          if (token) {
            authenticating = true;
            const base = `http://127.0.0.1:${port}`;
            exchangeCookie(base, token).then((cookie) => {
              if (child !== process || stopped || failed) return;
              clearTimeout(timer);
              publish('ready'); resolveReady({ base, cookie });
              if (!quiet) console.log(`[dsh-web] Ready on 127.0.0.1:${port}`);
            }).catch(() => {
              rejectReady(new Error('DSH authentication failed')); publish('error');
              try { globalThis.process.kill(-child.pid, 'SIGTERM'); } catch {}
            });
            continue; // Never print or forward the launch token.
          }
        }
        if (!quiet && globalThis.process.env.CODEX_DEBUG === '1') console.log(`[dsh-web] ${redact(line)}`);
      }
    });
    child.stderr.on('data', (chunk) => {
      if (!quiet && globalThis.process.env.CODEX_DEBUG === '1') globalThis.process.stderr.write(`[dsh-web] ${redact(chunk)}`);
    });
    const exited = () => {
      if (failed) return;
      failed = true; clearTimeout(timer);
      rejectReady(new Error('DSH process is not available'));
      if (child !== process || stopped) return;
      publish('error'); onRestart();
      if (!quiet) console.warn('[dsh-web] Process exited; restarting in 3s (CODEX_DEBUG=1 for local diagnostics)');
      retry = setTimeout(launch, 3000); retry.unref();
    };
    child.on('error', exited);
    child.on('exit', exited);
  }
  launch();
  return {
    get status() { return status; },
    async target() { return ready; },
    stop() {
      stopped = true; clearTimeout(retry);
      if (process?.pid) { try { globalThis.process.kill(-process.pid, 'SIGTERM'); } catch {} }
      try { process?.kill('SIGTERM'); } catch {}
    },
  };
}

export function createDshAgentBridge({ getTarget, service = 'dsh', rewriteResponse }) {
  if (!['dsh', 'opencode'].includes(service)) throw new Error('Unknown web service');
  const tunnels = new Map();
  let send = () => false;
  function dispose(entry, notify = false) {
    if (!tunnels.delete(entry.id)) return;
    entry.request?.destroy(); entry.socket?.destroy();
    entry.source?.destroy();
    if (notify) entry.send({ type: 'dsh/close', id: entry.id });
  }
  function fail(entry) {
    if (!tunnels.has(entry.id)) return;
    entry.send({ type: 'dsh/error', id: entry.id }); dispose(entry);
  }
  function write(entry, chunk) {
    if (!entry.destination) { entry.pending = chunk; return; }
    entry.destination.write(chunk, (error) => {
      if (error) return fail(entry);
      if (tunnels.has(entry.id)) entry.send({ type: 'dsh/ack', id: entry.id });
    });
  }
  async function open(message) {
    const entry = { id: message.id, send, websocket: Boolean(message.websocket), ended: false };
    tunnels.set(entry.id, entry);
    try {
      if (typeof message.path !== 'string' || !message.path.startsWith('/') || /[\r\n]/.test(message.path)) throw new Error('Invalid DSH path');
      const target = await getTarget();
      if (!tunnels.has(entry.id)) return;
      const base = new URL(target.base);
      // The only destination is this managed process's loopback listener, never browser input.
      if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw new Error('Invalid DSH target');
      const headers = cleanHeaders(message.headers, entry.websocket);
      headers.host = base.host;
      headers.origin = base.origin;
      if (target.cookie) headers.cookie = target.cookie;
      if (target.authorization) headers.authorization = target.authorization;
      if (rewriteResponse) headers['accept-encoding'] = 'identity';
      if (entry.websocket) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket'; }
      const request = http.request({ hostname: base.hostname, port: base.port, method: message.method,
        path: message.path, headers, agent: false }, async (response) => {
        if (entry.websocket) { response.resume(); fail(entry); return; }
        if (!tunnels.has(entry.id)) { response.destroy(); return; }
        let source = response;
        const responseHeaders = cleanHeaders(response.headers);
        if (rewriteResponse?.matches(message.path, responseHeaders)) {
          try {
            const chunks = []; let length = 0;
            for await (const chunk of response) {
              length += chunk.length;
              if (length > 16 * 1024 * 1024) throw new Error('Web asset too large');
              chunks.push(chunk);
            }
            if (!tunnels.has(entry.id)) return;
            let body = await rewriteResponse.transform(message.path, Buffer.concat(chunks), responseHeaders);
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
        entry.send({ type: 'dsh/headers', id: entry.id, status: response.statusCode, headers: responseHeaders });
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
        entry.send({ type: 'dsh/headers', id: entry.id, status: 101, headers: cleanHeaders(response.headers, true) });
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
    attach(sender) { this.disconnect(); send = (message) => sender({ ...message, type: message.type.replace(/^dsh\//, `${service}/`) }); },
    handle(message) {
      if (!message.type?.startsWith(`${service}/`)) return false;
      message = { ...message, type: message.type.replace(`${service}/`, 'dsh/') };
      if (message.type === 'dsh/open') {
        if (typeof message.id !== 'string' || tunnels.has(message.id) || tunnels.size >= 128) return true;
        open(message); return true;
      }
      const entry = tunnels.get(message.id);
      if (!entry) return true;
      try {
        if (message.type === 'dsh/data') {
          if (entry.pending) throw new Error('DSH flow-control violation');
          write(entry, decodeChunk(message.data));
        } else if (message.type === 'dsh/ack') acknowledge(entry);
        else if (message.type === 'dsh/end') {
          entry.ended = true;
          if (entry.websocket) entry.socket?.end(); else entry.request?.end();
        } else if (message.type === 'dsh/close') dispose(entry);
      } catch { fail(entry); }
      return true;
    },
    disconnect(notify = false) { for (const entry of tunnels.values()) dispose(entry, notify); },
  };
}
