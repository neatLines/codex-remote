import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

function probeVnc(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.setTimeout(2000, () => socket.destroy(new Error('VNC not ready')));
    let greeting = '';
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      greeting += chunk.toString('ascii');
      if (greeting.length < 12) return;
      socket.destroy();
      if (/^RFB \d{3}\.\d{3}\n/.test(greeting)) resolve();
      else reject(new Error('Unexpected VNC server'));
    });
    socket.on('end', () => reject(new Error('VNC disconnected')));
  });
}

function probeWeb(socketPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath, path: '/vnc.html', agent: false, timeout: 2000 }, (res) => {
      res.resume();
      if (res.statusCode === 200) resolve(); else reject(new Error('noVNC assets unavailable'));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('noVNC not ready')));
  });
}

// Both listeners live inside a private 0700 directory. Only this user's Agent
// can reach them; the existing gateway checks login, origin and device trust.
export function startManagedDesktop({ agentId, wayvncBin = 'wayvnc', websockifyBin = 'websockify',
  novncDir = '/usr/share/novnc', output, fps = 12, onStatus = () => {}, onRestart = () => {},
  quiet = false, startupTimeoutMs = 20000 } = {}) {
  if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) throw new Error('Invalid desktop device ID');
  if (!Number.isInteger(fps) || fps < 1 || fps > 30) throw new Error('Desktop FPS must be between 1 and 30');
  let stopped = false, retry, ready, disposeLaunch = () => {};
  let status = { enabled: true, status: 'starting' };
  const publish = (value) => { status = { enabled: true, status: value }; onStatus(status); };
  function launch() {
    publish('starting');
    let resolveReady, rejectReady, poll, directory, failed = false;
    const children = [];
    ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    ready.catch(() => {});
    disposeLaunch = () => {
      failed = true; clearTimeout(poll); rejectReady(new Error('Desktop stopped'));
      for (const child of children) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
        try { child.kill('SIGTERM'); } catch {}
      }
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
    };
    const fail = () => {
      if (stopped || failed) return;
      disposeLaunch(); publish('error'); onRestart();
      if (!quiet) console.warn('[desktop-web] Desktop unavailable; check Wayland session and dependencies (CODEX_DEBUG=1 for details)');
      retry = setTimeout(launch, 3000); retry.unref();
    };
    function worker(bin, args) {
      const child = spawn(bin, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child); child.stdout.resume();
      child.stderr.on('data', (chunk) => {
        if (!quiet && process.env.CODEX_DEBUG === '1') process.stderr.write(`[desktop-web] ${chunk}`);
      });
      child.on('error', fail); child.on('exit', fail);
    }
    try {
      const assets = fs.realpathSync(novncDir);
      if (!fs.statSync(path.join(assets, 'vnc.html')).isFile()) throw new Error('Missing noVNC');
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-desktop-'));
      fs.chmodSync(directory, 0o700);
      const vncSocket = path.join(directory, 'vnc.sock');
      const webSocket = path.join(directory, 'web.sock');
      const webRoot = path.join(directory, 'web'); fs.mkdirSync(webRoot, { mode: 0o700 });
      for (const name of fs.readdirSync(assets)) {
        if (name !== 'index.html') fs.symlinkSync(path.join(assets, name), path.join(webRoot, name));
      }
      const query = new URLSearchParams({ autoconnect: '1', resize: 'scale', quality: '3', compression: '9',
        path: `desktop/${agentId}/websockify` });
      fs.writeFileSync(path.join(webRoot, 'index.html'),
        `<!doctype html><meta charset="utf-8"><title>远程桌面</title><meta http-equiv="refresh" content="0;url=vnc.html?${query.toString().replaceAll('&', '&amp;')}">`, { mode: 0o600 });
      // Ignore unrelated personal wayvnc settings; never open a TCP listener or
      // resize the physical screen when a browser window changes dimensions.
      const config = path.join(directory, 'wayvnc.conf'); fs.writeFileSync(config, '', { mode: 0o600 });
      worker(wayvncBin, ['--config', config, '--unix-socket', '--socket', path.join(directory, 'control.sock'),
        '--disable-resizing', '--max-fps', String(fps), ...(output ? ['--output', output] : []), vncSocket]);
      worker(websockifyBin, ['--unix-listen', webSocket, '--unix-listen-mode', '600', '--unix-target', vncSocket,
        '--web', webRoot, '--file-only', '--heartbeat', '30']);
      const deadline = Date.now() + startupTimeoutMs;
      async function check() {
        if (stopped || failed) return;
        try {
          await Promise.all([probeVnc(vncSocket), probeWeb(webSocket)]);
          if (stopped || failed) return;
          publish('ready'); resolveReady({ base: 'http://127.0.0.1', socketPath: webSocket });
          if (!quiet) console.log('[desktop-web] Ready via private Unix sockets');
        } catch {
          if (stopped || failed) return;
          if (Date.now() >= deadline) { fail(); return; }
          poll = setTimeout(check, 250); poll.unref();
        }
      }
      void check();
    } catch { fail(); }
  }
  launch();
  return {
    get status() { return status; },
    async target() { return ready; },
    stop() { stopped = true; clearTimeout(retry); disposeLaunch(); },
  };
}
