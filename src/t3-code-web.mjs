import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function sessionIsValid(base, cookie) {
  const response = await fetch(base + '/api/auth/session', {
    headers: { cookie }, redirect: 'error', signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    return false;
  }
  return (await response.json()).authenticated === true;
}

async function pairBrowserSession(bin, cwd, base, signal) {
  const { stdout } = await run(bin, ['auth', 'pairing', 'create', '--json', '--ttl', '1m', '--base-url', base,
    '--label', 'RemoteHub'], { cwd, signal, timeout: 10000 });
  const { token, credential } = JSON.parse(stdout);
  const pairingCode = token ?? credential ?? stdout.match(/#token=([A-Za-z0-9._~-]+)/)?.[1];
  if (typeof pairingCode !== 'string' || !pairingCode) throw new Error('T3 Code did not issue a pairing code');

  const response = await fetch(base + '/api/auth/browser-session', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ credential: pairingCode }), redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  const cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
  await response.body?.cancel();
  if (!response.ok || !cookie || !await sessionIsValid(base, cookie)) {
    throw new Error('T3 Code browser pairing failed');
  }
  return cookie;
}

export function startManagedT3Code({ bin = 't3', port, cwd, quiet = false, checkIntervalMs = 2000,
  onStatus = () => {}, onRestart = () => {} }) {
  const base = `http://127.0.0.1:${port}`;
  const lifetime = new AbortController();
  let child;
  let session;
  let checking;
  let retryAt = 0;
  let status = 'starting';

  function publish(next, error) {
    if (lifetime.signal.aborted || status === next) return;
    status = next;
    if (next === 'error' && !quiet) console.warn('[t3-code] ' + error);
    onStatus();
  }

  function clearSession() {
    if (!session) return;
    session = undefined;
    onRestart();
  }

  function launch() {
    if (child || Date.now() < retryAt || lifetime.signal.aborted) return;
    publish('starting');
    const process = spawn(bin, ['serve', '--host', '127.0.0.1', '--port', String(port), '--no-browser'], {
      cwd, detached: true, stdio: 'ignore',
    });
    child = process;
    const exited = () => {
      if (child !== process) return;
      child = undefined;
      clearSession();
      retryAt = Date.now() + 3000;
      publish('error', 'T3 Code exited. Check the CLI and local port.');
    };
    process.once('error', exited);
    process.once('exit', exited);
  }

  async function check() {
    let descriptor;
    try {
      const response = await fetch(base + '/.well-known/t3/environment', {
        redirect: 'error', signal: AbortSignal.timeout(2500),
      });
      if (response.status === 503) {
        await response.body?.cancel();
        return;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Invalid T3 Code environment');
      }
      descriptor = await response.json();
      if (typeof descriptor.environmentId !== 'string' || !descriptor.environmentId) {
        throw new Error('Invalid T3 Code environment');
      }
    } catch (error) {
      if (lifetime.signal.aborted) return;
      clearSession();
      if (error.cause?.code === 'ECONNREFUSED') launch();
      else publish('error', 'The configured port did not respond as a T3 Code server.');
      return;
    }

    if (lifetime.signal.aborted) return;
    try {
      if (session?.environmentId === descriptor.environmentId && await sessionIsValid(base, session.cookie)) return;
      clearSession();
      if (Date.now() < retryAt) return;
      const cookie = await pairBrowserSession(bin, cwd, base, lifetime.signal);
      if (lifetime.signal.aborted) return;
      session = { environmentId: descriptor.environmentId, cookie };
      publish('ready');
    } catch {
      clearSession();
      retryAt = Date.now() + 3000;
      publish('error', 'Could not pair with T3 Code. Check the CLI and its data directory.');
    }
  }

  function refresh() {
    checking ??= check().finally(() => { checking = undefined; });
    return checking;
  }

  const timer = setInterval(refresh, checkIntervalMs);
  timer.unref();
  void refresh();
  return {
    get status() { return status; },
    async target() {
      if (!session) await refresh();
      if (!session || lifetime.signal.aborted) throw new Error('T3 Code is not ready');
      return { base, cookie: session.cookie, privateSession: true };
    },
    stop() {
      lifetime.abort();
      clearInterval(timer);
      clearSession();
      const process = child;
      child = undefined;
      if (process?.pid && globalThis.process.platform !== 'win32') {
        try { globalThis.process.kill(-process.pid, 'SIGTERM'); return; } catch {}
      }
      process?.kill();
    },
  };
}
