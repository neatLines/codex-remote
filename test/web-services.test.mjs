import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCloudServer } from '../src/cloud-server.mjs';
import { startLocalAgent } from '../src/local-agent.mjs';
import { generateTotpCode } from '../src/crypto-auth.mjs';
import { normalizeWebServices } from '../src/web-services.mjs';
import { acceptWebSocketUpgrade, connectWebSocketClient } from '../src/ws-minimal.mjs';

async function until(check) { for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('Service registration timed out'); }
async function freePort() { const server = net.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise(r => server.close(r)); return port; }

test('service spec registers managed apps and generic auth, keeps tokens private, and reloads port additions/removals', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registered-services-')), connections = new Set(), sockets = [];
  const servers = [];
  const cloud = createCloudServer({ host: '127.0.0.1', port: 0, dataDir: path.join(dir, 'cloud'), quiet: true, env: { CODEX_ADMIN_PASSWORD: 'fixture-password', CODEX_TOTP_SECRET: 'JBSWY3DPEHPK3PXP' } });
  let agent;
  try {
    for (let i = 0; i < 2; i++) {
      const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ url: req.url, headers: req.headers })); });
      server.on('connection', socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
      server.on('upgrade', (req, socket, head) => { const ws = acceptWebSocketUpgrade(req, socket, head); ws?.on('message', raw => ws.send(raw)); });
      await new Promise(r => server.listen(0, '127.0.0.1', r)); servers.push(server);
    }
    const dshPort = await freePort(), opencodePort = await freePort(), httpPort = servers[0].address().port, addedPort = servers[1].address().port;
    const services = [
      { id: 'dsh', name: 'DSH', kind: 'dsh', port: dshPort },
      { id: 'opencode', name: 'OpenCode', kind: 'opencode', port: opencodePort },
      { id: 'panel', name: '面板', port: httpPort, path: '/ui/#/overview', auth: { headers: { Authorization: 'Bearer spec-secret', Cookie: 'application=session' }, query: { token: 'query-secret' } } },
    ];
    const file = path.join(dir, 'services.json'); fs.writeFileSync(file, JSON.stringify({ services }));
    const gatewayPort = await cloud.listen(), base = `http://127.0.0.1:${gatewayPort}`;
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'fixture-password', totpCode: generateTotpCode('JBSWY3DPEHPK3PXP') }) });
    const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: base };
    agent = startLocalAgent({
      relayUrl: `ws://127.0.0.1:${gatewayPort}/ws/agent`,
      codexHome: path.join(dir, 'identity'),
      webServicesFile: file,
      quiet: true,
      dshCwd: dir,
      opencodeCwd: dir,
      dshBin: fileURLToPath(new URL('./fixtures/fake-dsh.mjs', import.meta.url)),
      opencodeBin: fileURLToPath(new URL('./fixtures/fake-opencode.mjs', import.meta.url)),
    });
    const id = agent.identity.agentId;
    await until(() => cloud.agents.get(id)?.webServices?.every(service => service.status === 'ready'));
    await fetch(base + '/api/agents/trust', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: id, trusted: true }) });
    assert.equal(cloud.agents.get(id).webServices.find(s => s.kind === 'dsh').auth.token.length, 40);
    const list = await (await fetch(base + '/api/agents', { headers })).json();
    assert.equal(list.agents[0].webServices.length, 3);
    assert.ok(list.agents[0].webServices.every(service => !service.auth));
    const persisted = fs.readFileSync(path.join(dir, 'cloud', 'auth.json'), 'utf8');
    for (const secret of ['spec-secret', 'query-secret', cloud.agents.get(id).webServices[0].auth.token]) assert.ok(!persisted.includes(secret));
    const native = JSON.parse(fs.readFileSync(path.join(dir, 'identity', 'remote-native-services.json'), 'utf8'));
    const oc = native.find(s => s.id === 'opencode');
    assert.equal((await fetch(oc.url + 'api/info', { headers: { Authorization: 'Basic ' + Buffer.from(oc.username + ':' + oc.password).toString('base64') } })).status, 200, 'native OpenCode remains directly usable with native credentials');
    assert.equal((await fetch(native.find(s => s.id === 'dsh').url, { redirect: 'manual' })).status, 303);
    assert.equal(fs.statSync(path.join(dir, 'identity', 'remote-native-services.json')).mode & 0o777, 0o600);
    const dsh = await fetch(`${base}/local/${id}/${dshPort}/`, { headers });
    assert.equal(dsh.status, 200);
    assert.match(await dsh.text(), /DSH fixture/);
    const openCode = await (await fetch(`${base}/local/${id}/${opencodePort}/_assets/index.js`, { headers })).text();
    assert.ok(openCode.includes(`base:"/local/${id}/${opencodePort}"`));
    const echo = await (await fetch(`${base}/local/${id}/${httpPort}/headers?token=browser-value&keep=1`, { headers: { ...headers, Authorization: 'Bearer browser-value' } })).json();
    assert.equal(echo.headers.authorization, 'Bearer spec-secret');
    assert.equal(echo.headers.cookie, 'application=session');
    assert.equal(new URL(echo.url, 'http://local').searchParams.get('token'), 'query-secret');
    assert.ok(echo.url.includes('keep=1'));
    assert.equal((await fetch(`${base}/local/${id}/${addedPort}/`, { headers })).status, 403);
    services.push({ id: 'new-panel', name: '新增面板', port: addedPort });
    fs.writeFileSync(file, JSON.stringify({ services }));
    await until(() => cloud.agents.get(id)?.webServices?.length === 4 && cloud.agents.get(id)?.webServices?.find(s => s.port === addedPort)?.status === 'ready');
    assert.equal((await fetch(`${base}/local/${id}/${addedPort}/`, { headers })).status, 200);
    const socket = await connectWebSocketClient(`ws://127.0.0.1:${gatewayPort}/local/${id}/${addedPort}/ws`, { headers });
    sockets.push(socket);
    const closed = new Promise(r => socket.once('close', r));
    services.pop();
    fs.writeFileSync(file, JSON.stringify({ services }));
    await closed;
    assert.equal((await fetch(`${base}/local/${id}/${addedPort}/`, { headers })).status, 403);
    const previous = cloud.agents.get(id).webServices;
    fs.writeFileSync(file, 'invalid-json-with-secret');
    await new Promise(r => setTimeout(r, 2100));
    assert.deepEqual(cloud.agents.get(id).webServices, previous);
  } finally {
    sockets.forEach(s => s.close());
    agent?.stop();
    await cloud.close();
    connections.forEach(s => s.destroy());
    await Promise.all(servers.map(s => new Promise(r => s.close(r))));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('service specs reject destinations outside the local port model and unsafe authentication headers', () => {
  const entry = { id: 'panel', name: 'Panel', port: 9090 };
  for (const change of [{ port: 0 }, { port: 65536 }, { path: '//evil.test/' }, { id: 'codex' }, { auth: { headers: { Host: 'evil.test' } } }, { auth: { headers: { Authorization: 'token\r\nInjected: true' } } }]) {
    assert.throws(() => normalizeWebServices([{ ...entry, ...change }]));
  }
  assert.throws(() => normalizeWebServices([entry, entry]));
});
