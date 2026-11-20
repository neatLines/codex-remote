import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';

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
  let credentials;
  const publish = (next) => { status = { enabled: true, status: next }; onStatus(status); };
  function launch() {
    credentials = undefined;
    publish('starting');
    let resolveReady, rejectReady;
    ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
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
              credentials = { token, cookie };
              publish('ready'); resolveReady({ base, cookie });
              if (!quiet) console.log(`[dsh-web] Ready on 127.0.0.1:${port}`);
            }).catch(() => {
              rejectReady(new Error('DSH authentication failed')); publish('error');
              try { globalThis.process.kill(-child.pid, 'SIGTERM'); } catch {}
            });
            continue;
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
    get credentials() { return credentials; },
    async target() { return ready; },
    stop() {
      stopped = true; clearTimeout(retry);
      if (process?.pid) { try { globalThis.process.kill(-process.pid, 'SIGTERM'); } catch {} }
      try { process?.kill('SIGTERM'); } catch {}
    },
  };
}
