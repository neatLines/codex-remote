import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';

// OpenCode 2's shipped SPA assumes an origin-root mount. Keep its own UI and
// SDK, adapting only the router base, default server and static asset paths.
// Every device gets a separate URL namespace; no mutable global device cookie.
export function openCodeRewriter(agentId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) throw new Error('Invalid device ID');
  const prefix = `/opencode/${agentId}`;
  return {
    matches(requestPath, headers) {
      if (/^\/api(?:\/|\?|$)/.test(requestPath)) return false;
      return /(?:text\/html|(?:java|ecma)script|text\/css|manifest\+json)/i.test(headers['content-type'] || '');
    },
    transform(requestPath, body, headers) {
      let text = body.toString('utf8');
      const type = headers['content-type'] || '';
      if (/text\/html/i.test(type)) {
        text = text.replace(/(<(?:script|link|img)\b[^>]*?\b(?:src|href)=['"])\/(?!\/)/gi, `$1${prefix}/`);
      } else if (/(?:java|ecma)script/i.test(type)) {
        if (/\/_assets\/preload-helper-[^/]+\.js(?:\?|$)/.test(requestPath)) {
          const preloadPattern = /return`\/`\+([\w$]+)/g;
          if ([...text.matchAll(preloadPattern)].length !== 1) throw new Error('Unsupported OpenCode asset preloader');
          text = text.replace(preloadPattern, `return${JSON.stringify(prefix + '/')}+$1`);
        }
        // The native shell parses useLocation().pathname itself, which includes
        // Solid Router's base. Strip only this device's mount before parsing.
        if (text.includes('Unrecognised route!')) {
          const routePattern = /(\([\w$]+,[\w$]+\)=>\{let [\w$]+=)([\w$]+)(\.split\(`\/`\)\.filter\(Boolean\);if\([\w$]+\.length===0\)return\{type:`home`\})/g;
          if ([...text.matchAll(routePattern)].length !== 1) throw new Error('Unsupported OpenCode route parser');
          text = text.replace(routePattern, (_, start, pathname, end) =>
            `${start}(${pathname}.startsWith(${JSON.stringify(prefix + '/')})?${pathname}.slice(${prefix.length}):${pathname})${end}`);
        }
        if (text.includes('currentServerUrl:')) {
          const serverPattern = /currentServerUrl:[\w$]+\(\)/g;
          const routerPattern = /(get component\(\)\{return [\w$]+\.router\?\?[\w$]+\},)root:/g;
          if ([...text.matchAll(serverPattern)].length !== 1 || [...text.matchAll(routerPattern)].length !== 1) {
            throw new Error('Unsupported OpenCode web bundle; verify the installed version');
          }
          text = text.replace(serverPattern, `currentServerUrl:location.origin+${JSON.stringify(prefix)}`)
            .replace(routerPattern, `$1base:${JSON.stringify(prefix)},root:`);
        }
        // A service worker must never cache authenticated cross-device API data.
        text = text.replace(/navigator\.serviceWorker\.register\([^)]*\)/g, 'Promise.resolve()');
      }
      text = text.replace(/(["'`(])\/(?=(?:_assets|assets|icons|fonts|sounds|images)\/)/g, `$1${prefix}/`);
      return Buffer.from(text);
    },
  };
}

export function startManagedOpenCode({ bin = 'opencode', port = 3082, cwd = os.homedir(),
  onStatus = () => {}, onRestart = () => {}, quiet = false, startupTimeoutMs = 90000 } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('OpenCode port must be between 1 and 65535');
  let stopped = false, child, retry, poll, ready;
  let status = { enabled: true, status: 'starting' };
  const publish = (value) => { status = { enabled: true, status: value }; onStatus(status); };
  const kill = (proc) => { try { process.kill(-proc.pid, 'SIGTERM'); } catch {} try { proc.kill('SIGTERM'); } catch {} };
  function launch() {
    publish('starting');
    const password = crypto.randomBytes(32).toString('base64url');
    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    const base = `http://127.0.0.1:${port}`;
    let resolveReady, rejectReady;
    ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    ready.catch(() => {});
    const proc = spawn(bin, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd, env: { ...process.env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: 'opencode' },
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = proc;
    // OpenCode may print connection credentials; never forward child output.
    proc.stdout.resume(); proc.stderr.resume();
    let failed = false;
    const fail = () => {
      if (failed) return;
      failed = true; clearTimeout(poll);
      rejectReady(new Error('OpenCode process is unavailable'));
      if (stopped || proc !== child) return;
      kill(proc); publish('error'); onRestart();
      if (!quiet) console.warn('[opencode-web] Process unavailable; restarting in 3s');
      retry = setTimeout(launch, 3000); retry.unref();
    };
    proc.on('error', fail); proc.on('exit', fail);
    const deadline = Date.now() + startupTimeoutMs;
    async function check() {
      if (stopped || failed || proc !== child) return;
      try {
        const response = await fetch(`${base}/api/info`, { headers: { Authorization: authorization }, signal: AbortSignal.timeout(2000) });
        if (!response.ok) throw new Error('not ready');
        const info = await response.json();
        if (info.pid !== proc.pid || info.version !== '2.0.32') throw new Error('unexpected server version; expected OpenCode 2.0.32');
        if (stopped || failed || proc !== child) return;
        publish('ready'); resolveReady({ base, authorization });
        if (!quiet) console.log(`[opencode-web] Ready on 127.0.0.1:${port} (${info.version})`);
      } catch {
        if (Date.now() >= deadline) { fail(); return; }
        if (!stopped && !failed) { poll = setTimeout(check, 250); poll.unref(); }
      }
    }
    void check();
  }
  launch();
  return {
    get status() { return status; },
    async target() { return ready; },
    stop() { stopped = true; clearTimeout(retry); clearTimeout(poll); if (child) kill(child); },
  };
}
