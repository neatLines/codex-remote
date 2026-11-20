import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createCloudServer } from '../src/cloud-server.mjs';
import { generateTotpCode } from '../src/crypto-auth.mjs';
import { startLocalAgent } from '../src/local-agent.mjs';
import { connectWebSocketClient } from '../src/ws-minimal.mjs';

async function until(predicate) {
  for (let i = 0; i < 150; i++) {
    const value = await predicate();
    if (value) return value;
    await delay(80);
  }
  throw new Error('T3 Code fixture timed out');
}

test('T3 Code is started, paired locally, and reachable through a trusted gateway without exposing its session', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-t3-'));
  const password = 'fixture-password', totpSecret = 'JBSWY3DPEHPK3PXP';
  const cloud = createCloudServer({ host: '127.0.0.1', port: 0, dataDir: path.join(directory, 'cloud'),
    quiet: true, env: { CODEX_ADMIN_PASSWORD: password, CODEX_TOTP_SECRET: totpSecret } });
  let agent, ws;
  try {
    const listener = net.createServer();
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    const gatewayPort = await cloud.listen();
    const origin = `http://127.0.0.1:${gatewayPort}`;
    const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, totpCode: generateTotpCode(totpSecret) }) });
    const headers = { Cookie: login.headers.get('set-cookie').split(';', 1)[0], Origin: origin };
    agent = startLocalAgent({
      relayUrl: `ws://127.0.0.1:${gatewayPort}/ws/agent`, codexHome: path.join(directory, 'agent'),
      codexEnabled: false, quiet: true, defaultCwd: directory,
      t3CodeBin: fileURLToPath(new URL('./fixtures/fake-t3-code.mjs', import.meta.url)),
      webServices: [{ id: 't3-code', name: 'T3 Code', kind: 't3-code', port }],
    });
    const agentId = agent.identity.agentId;
    const service = await until(() => {
      const current = cloud.agents.get(agentId)?.webServices?.[0];
      return current?.status === 'ready' && current;
    });
    assert.deepEqual(service, { id: 't3-code', name: 'T3 Code', kind: 'http', port,
      path: '/?transport=websocket', status: 'ready' });
    const url = `${origin}/local/${agentId}/${port}/`;
    assert.equal((await fetch(url, { headers })).status, 403);
    await fetch(origin + '/api/agents/trust', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, trusted: true }) });
    const page = await fetch(url, { headers });
    assert.equal(page.status, 200);
    assert.deepEqual(page.headers.getSetCookie(), []);
    assert.equal(page.headers.get('x-frame-options'), null);
    assert.equal(page.headers.get('content-security-policy'), null);
    assert.match(await page.text(), /T3 fixture workspace/);
    ws = await connectWebSocketClient(url.replace('http:', 'ws:') + 'ws', { headers });
    const echoed = new Promise(resolve => ws.once('message', resolve));
    ws.send('ready');
    assert.equal(await echoed, 'ready');
    ws.close();

    const pidPath = path.join(directory, 't3-pid.fixture');
    const originalPid = Number(fs.readFileSync(pidPath));
    process.kill(originalPid, 'SIGTERM');
    await until(() => Number(fs.readFileSync(pidPath)) !== originalPid);
    await until(async () => (await fetch(url, { headers })).status === 200);
  } finally {
    ws?.close();
    agent?.stop();
    await cloud.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
