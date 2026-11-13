import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCloudServer } from '../src/cloud-server.mjs';
import { startLocalAgent } from '../src/local-agent.mjs';
import { generateTotpCode } from '../src/crypto-auth.mjs';
import { connectWebSocketClient } from '../src/ws-minimal.mjs';
import { startManagedDesktop } from '../src/desktop-web.mjs';

async function until(check) {
  for (let i = 0; i < 300; i++) { const result = await check(); if (result) return result; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('Desktop fixture timed out');
}

test('desktop uses private sockets and authenticated device-scoped HTTP/WebSocket routes; logout and revocation disconnect it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-desktop-test-'));
  const assets = path.join(dir, 'novnc'); fs.mkdirSync(assets); fs.writeFileSync(path.join(assets, 'vnc.html'), '<html>noVNC fixture</html>');
  const cloud = createCloudServer({ host: '127.0.0.1', port: 0, dataDir: path.join(dir, 'cloud'), quiet: true,
    env: { CODEX_ADMIN_PASSWORD: 'fixture-password', CODEX_TOTP_SECRET: 'JBSWY3DPEHPK3PXP' } });
  const agents = [], sockets = [];
  try {
    const port = await cloud.listen(), base = `http://127.0.0.1:${port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'fixture-password', totpCode: generateTotpCode('JBSWY3DPEHPK3PXP') }) });
    const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: base };
    async function trust(id, trusted) {
      const res = await fetch(base + '/api/agents/trust', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: id, trusted }) });
      assert.equal(res.status, 200);
    }
    for (let i = 0; i < 2; i++) {
      const bin = fileURLToPath(new URL('./fixtures/fake-desktop.mjs', import.meta.url));
      const agent = startLocalAgent({ relayUrl: `ws://127.0.0.1:${port}/ws/agent`, codexHome: path.join(dir, `agent-${i}`),
        codexEnabled: false, dshEnabled: false, opencodeEnabled: false, desktopEnabled: true,
        wayvncBin: bin, websockifyBin: bin, novncDir: assets, quiet: true });
      agents.push(agent);
      await until(() => cloud.agents.get(agent.identity.agentId)?.desktopWeb.status === 'ready');
      const id = agent.identity.agentId, url = `${base}/desktop/${id}/`;
      assert.equal((await fetch(url)).status, 401);
      assert.equal((await fetch(url, { headers })).status, 403);
      await assert.rejects(connectWebSocketClient(url.replace('http:', 'ws:') + 'websockify'), /401/);
      await trust(id, true);
      assert.equal((await fetch(url, { headers: { ...headers, Origin: 'https://evil.test' } })).status, 403);
      await assert.rejects(connectWebSocketClient(url.replace('http:', 'ws:') + 'websockify', {
        headers: { ...headers, Origin: 'https://evil.test' } }), /403/);
      const html = await (await fetch(url, { headers })).text();
      assert.ok(html.includes(`path=desktop%2F${id}%2Fwebsockify`));
      assert.ok(html.includes('resize=scale'));
      assert.match(await (await fetch(url + 'vnc.html', { headers })).text(), /noVNC fixture/);
      const socket = await connectWebSocketClient(url.replace('http:', 'ws:') + 'websockify', { headers });
      sockets.push(socket); const chunks = []; socket.on('message', (data) => chunks.push(data));
      const input = Buffer.alloc(150000, i + 65); socket._writeFrame(0x2, input);
      await until(() => Buffer.concat(chunks).length >= input.length);
      const received = Buffer.concat(chunks);
      assert.deepEqual(received.subarray(received.length - input.length), input);
    }
    const list = (await (await fetch(base + '/api/agents', { headers })).json()).agents;
    assert.equal(list.filter(a => a.desktopWeb.status === 'ready').length, 2);
    const closed = new Promise((r) => sockets[0].once('close', r));
    await trust(agents[0].identity.agentId, false); await closed;
    assert.equal(sockets[1].readyState, 1);
    const logoutClosed = new Promise((r) => sockets[1].once('close', r));
    assert.equal((await fetch(base + '/api/auth/logout', { method: 'POST', headers })).status, 200);
    await logoutClosed;
    agents[1].stop();
    await until(() => !cloud.agents.has(agents[1].identity.agentId));
    assert.equal(agents[1].connected, false);
  } finally {
    sockets.forEach(s => s.close()); agents.forEach(a => a.stop()); await cloud.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('desktop recovers when dependencies become available and removes private sockets on stop', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-lifecycle-'));
  const assets = path.join(dir, 'novnc');
  const bin = fileURLToPath(new URL('./fixtures/fake-desktop.mjs', import.meta.url));
  const manager = startManagedDesktop({ agentId: 'lifecycle', wayvncBin: bin, websockifyBin: bin, novncDir: assets, quiet: true });
  try {
    assert.equal(manager.status.status, 'error');
    await assert.rejects(manager.target());
    fs.mkdirSync(assets); fs.writeFileSync(path.join(assets, 'vnc.html'), 'ready');
    await until(() => manager.status.status === 'ready');
    const target = await manager.target(), runtime = path.dirname(target.socketPath);
    assert.equal(fs.statSync(runtime).mode & 0o777, 0o700);
    assert.equal(fs.statSync(target.socketPath).mode & 0o777, 0o600);
    assert.ok(fs.existsSync(path.join(runtime, 'vnc.sock')));
    manager.stop();
    assert.equal(fs.existsSync(runtime), false);
  } finally { manager.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
