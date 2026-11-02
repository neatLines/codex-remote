import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCloudServer } from '../src/cloud-server.mjs';
import { generateTotpCode } from '../src/crypto-auth.mjs';
import { startLocalAgent } from '../src/local-agent.mjs';
import { connectWebSocketClient, MinimalWebSocket } from '../src/ws-minimal.mjs';

function requestHttps(port, ca, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ? JSON.stringify(options.body) : undefined;
    const req = https.request({
      hostname: '127.0.0.1', port, path: requestPath, ca,
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
      ...(options.servername ? { servername: options.servername } : {}),
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('TLS configuration fails closed when incomplete or redirect origin is unsafe', () => {
  assert.throws(() => createCloudServer({ env: { CODEX_TLS_CERT_FILE: '/missing.crt' } }), /configured together/);
  assert.throws(() => createCloudServer({ env: { CODEX_HTTP_REDIRECT_PORT: '80' } }), /requires TLS/);
  assert.throws(() => createCloudServer({ env: {
    CODEX_TLS_CERT_FILE: '/missing.crt', CODEX_TLS_KEY_FILE: '/missing.key',
    CODEX_HTTP_REDIRECT_PORT: '80', CODEX_PUBLIC_ORIGIN: 'http://unsafe.test',
  } }), /HTTPS origin/);
});

test('HTTPS, secure login cookies, verified WSS and the local agent work with a private CA', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-remote-tls-'));
  const cert = path.join(directory, 'cert.pem');
  const key = path.join(directory, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', key, '-out', cert, '-subj', '/CN=Codex Remote Test',
    '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'pipe' });
  const ca = fs.readFileSync(cert);
  const cloud = createCloudServer({ host: '127.0.0.1', port: 0, dataDir: path.join(directory, 'cloud'), quiet: true,
    env: {
      CODEX_ADMIN_PASSWORD: 'tls-fixture-password', CODEX_TOTP_SECRET: 'JBSWY3DPEHPK3PXP',
      CODEX_TLS_CERT_FILE: cert, CODEX_TLS_KEY_FILE: key,
      CODEX_HTTP_REDIRECT_PORT: '0', CODEX_PUBLIC_ORIGIN: 'https://fixed.example.test',
    },
  });
  let agent;
  let client;
  try {
    const port = await cloud.listen();
    const url = `wss://127.0.0.1:${port}`;
    await assert.rejects(connectWebSocketClient(`${url}/ws/agent`), /self.signed certificate/i);
    await assert.rejects(requestHttps(port, ca, '/', { servername: 'wrong.example.test' }), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    const status = await requestHttps(port, ca, '/api/auth/status');
    assert.equal(status.status, 200);
    assert.equal(JSON.parse(status.body).authenticated, false);
    const login = await requestHttps(port, ca, '/api/auth/login', { body: {
      password: 'tls-fixture-password', totpCode: generateTotpCode('JBSWY3DPEHPK3PXP'),
    } });
    assert.equal(login.status, 200);
    assert.match(login.headers['set-cookie'][0], /; Secure/);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const redirectPort = cloud.redirectServer.address().port;
    const redirect = await fetch(`http://127.0.0.1:${redirectPort}/some/path?test=1`, {
      redirect: 'manual', headers: { Host: 'attacker.example.test' },
    });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get('location'), 'https://fixed.example.test/some/path?test=1');
    agent = startLocalAgent({ relayUrl: `${url}/ws/agent`, relayCaFile: cert,
      codexHome: path.join(directory, 'agent'), defaultCwd: directory,
      codexBin: fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)), quiet: true,
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { clearInterval(poll); reject(new Error('TLS agent did not register')); }, 5000);
      const poll = setInterval(() => {
        if (!cloud.agents.has(agent.identity.agentId)) return;
        clearInterval(poll); clearTimeout(timer); resolve();
      }, 20);
    });
    const trust = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ agentId: agent.identity.agentId, trusted: true });
      const req = https.request({ hostname: '127.0.0.1', port, path: '/api/agents/trust', ca, method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
      req.on('error', reject); req.end(body);
    });
    assert.equal(trust, 200);
    client = await connectWebSocketClient(`${url}/ws/client`, { ca, headers: { Cookie: cookie } });
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WSS RPC did not complete')), 5000);
      client.on('message', (raw) => {
        const message = JSON.parse(raw);
        if (message.type === 'relay/rpc' && message.payload?.id === 'tls-workspaces') {
          clearTimeout(timer); resolve(message.payload);
        }
      });
    });
    client.send({ type: 'client/rpc', agentId: agent.identity.agentId,
      payload: { id: 'tls-workspaces', method: 'remote/getWorkspacesAndThreads', params: {} } });
    assert.ok(Array.isArray((await result).result.projects));
  } finally {
    client?.close(); agent?.stop(); await cloud.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a reset WebSocket closes without crashing the relay when no error listener is registered', () => {
  const socket = new EventEmitter();
  socket.setNoDelay = () => {};
  const ws = new MinimalWebSocket(socket);
  let close;
  ws.on('close', (code, reason) => { close = { code, reason }; });
  assert.doesNotThrow(() => socket.emit('error', new Error('read ECONNRESET')));
  assert.equal(ws.readyState, MinimalWebSocket.CLOSED);
  assert.deepEqual(close, { code: 1006, reason: 'read ECONNRESET' });
});
