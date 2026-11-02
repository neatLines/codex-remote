import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCloudServer } from '../src/cloud-server.mjs';
import { startLocalAgent } from '../src/local-agent.mjs';
import { generateTotpCode } from '../src/crypto-auth.mjs';
import { connectWebSocketClient } from '../src/ws-minimal.mjs';
import { decodeChunk } from '../src/dsh-tunnel.mjs';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function until(predicate, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error('Timed out waiting for fixture state');
}
const message = (ws) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('DSH WebSocket response timed out')), 5000);
  ws.once('message', (data) => { clearTimeout(timer); resolve(data); });
});

test('DSH managed process, shared login, binary HTTP/SSE and WebSocket reverse tunnel', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dsh-test-'));
  const cloud = createCloudServer({ host: '127.0.0.1', port: 0, dataDir: path.join(dir, 'cloud'), quiet: true,
    env: { CODEX_ADMIN_PASSWORD: 'fixture-password', CODEX_TOTP_SECRET: 'JBSWY3DPEHPK3PXP' } });
  let agent, ws;
  let managedPid;
  try {
    const port = await cloud.listen();
    const base = `http://127.0.0.1:${port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'fixture-password', totpCode: generateTotpCode('JBSWY3DPEHPK3PXP') }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    agent = startLocalAgent({ relayUrl: `ws://127.0.0.1:${port}/ws/agent`, quiet: true,
      codexHome: path.join(dir, 'codex'), defaultCwd: dir,
      codexBin: fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)),
      dshEnabled: true, dshPort: await freePort(), dshCwd: dir,
      dshBin: fileURLToPath(new URL('./fixtures/fake-dsh.mjs', import.meta.url)),
    });
    const agentId = agent.identity.agentId;
    const prefix = `/dsh/${agentId}/`;
    const url = base + prefix;
    await until(() => cloud.agents.get(agentId)?.dshWeb?.status === 'ready');
    managedPid = Number(fs.readFileSync(path.join(dir, 'fake-dsh.pid'), 'utf8'));
    assert.equal((await fetch(url)).status, 401);
    const navigate = await fetch(url, { redirect: 'manual', headers: { Accept: 'text/html' } });
    assert.equal(navigate.status, 302);
    assert.match(navigate.headers.get('location'), /^\/\?next=/);
    await assert.rejects(connectWebSocketClient(`ws://127.0.0.1:${port}${prefix}api/remote.mux`), /HTTP 401/);
    assert.equal((await fetch(url, { headers: { Cookie: cookie } })).status, 403);
    await fetch(`${base}/api/agents/trust`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ agentId, trusted: true }) });
    const headers = { Cookie: cookie, Origin: base };
    const root = await fetch(url, { headers });
    assert.equal(root.status, 200);
    assert.match(await root.text(), /DSH fixture/);
    assert.equal(root.headers.get('set-cookie'), null, 'DSH cookie must stay on the local agent');
    assert.match(await (await fetch(url + 'assets/app.js', { headers })).text(), /dshLoaded/);
    assert.equal((await fetch(url + 'api/headers', { headers: { ...headers, Origin: 'https://evil.test' } })).status, 403);
    const forwarded = await (await fetch(url + 'api/headers', { headers: { ...headers, Authorization: 'must-not-forward' } })).json();
    assert.match(forwarded.cookie, /^dsh_browser=/);
    assert.doesNotMatch(forwarded.cookie, /codex_remote/);
    assert.equal(forwarded.authorization, undefined);
    assert.match(forwarded.origin, /^http:\/\/127\.0\.0\.1:/);
    const upload = Buffer.alloc(400000, 189);
    const echo = await fetch(url + 'api/echo', { method: 'POST', headers, body: upload });
    assert.deepEqual(Buffer.from(await echo.arrayBuffer()), upload);
    const large = await fetch(url + 'api/large', { headers });
    assert.deepEqual(Buffer.from(await large.arrayBuffer()), Buffer.alloc(350000, 137));
    const sse = await fetch(url + 'api/sse', { headers });
    assert.equal(sse.headers.get('content-type'), 'text/event-stream');
    assert.equal(await sse.text(), 'data: first\n\ndata: second\n\n');
    const redirect = await fetch(url + 'api/redirect', { headers, redirect: 'manual' });
    assert.equal(redirect.headers.get('location'), prefix);
    const wsUrl = `ws://127.0.0.1:${port}${prefix}api/remote.mux`;
    await assert.rejects(connectWebSocketClient(wsUrl, { headers: { Cookie: cookie, Origin: 'https://evil.test' } }), /HTTP 403/);
    ws = await connectWebSocketClient(wsUrl, { headers });
    let incoming = message(ws); ws.send('DSH streamed event');
    assert.equal(await incoming, 'DSH streamed event');
    incoming = message(ws); ws._writeFrame(2, Buffer.from([0, 255, 127, 9]));
    assert.deepEqual(await incoming, Buffer.from([0, 255, 127, 9]));
    const closed = new Promise((resolve) => ws.once('close', resolve));
    await fetch(`${base}/api/agents/trust`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ agentId, trusted: false }) });
    await closed;
    assert.equal((await fetch(url, { headers })).status, 403);
    await fetch(`${base}/api/agents/trust`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ agentId, trusted: true }) });
    process.kill(managedPid, 'SIGTERM');
    await until(() => cloud.agents.get(agentId)?.dshWeb?.status === 'ready' &&
      Number(fs.readFileSync(path.join(dir, 'fake-dsh.pid'), 'utf8')) !== managedPid);
    managedPid = Number(fs.readFileSync(path.join(dir, 'fake-dsh.pid'), 'utf8'));
    assert.equal((await fetch(url, { headers })).status, 200, 'Restart should automatically exchange the new DSH token');
    ws = await connectWebSocketClient(wsUrl, { headers });
    const loggedOut = new Promise((resolve) => ws.once('close', resolve));
    await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
    await loggedOut;
    agent.stop();
    await until(() => { try { process.kill(managedPid, 0); return false; } catch { return true; } });
  } finally {
    ws?.close(); agent?.stop(); await cloud.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DSH tunnel chunks reject malformed and unbounded input', () => {
  assert.throws(() => decodeChunk('not base64!'), /Invalid/);
  assert.throws(() => decodeChunk('AAAA'.repeat(30000)), /Invalid/);
  assert.deepEqual(decodeChunk('AP8='), Buffer.from([0, 255]));
});
