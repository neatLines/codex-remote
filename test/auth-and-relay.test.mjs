import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCloudServer } from '../src/cloud-server.mjs';
import {
  generateTotpCode,
  generateTotpSecret,
  hashPassword,
  LoginRateLimiter,
  signSessionToken,
  verifyPassword,
  verifySessionToken,
  verifyTotpCode,
} from '../src/crypto-auth.mjs';
import { startLocalAgent } from '../src/local-agent.mjs';
import { connectWebSocketClient } from '../src/ws-minimal.mjs';

test('TOTP RFC 6238 generation and ±1 window verification', () => {
  const secret = generateTotpSecret();
  const now = 1762056000000;
  const codeNow = generateTotpCode(secret, now);
  const codePrev = generateTotpCode(secret, now - 30000);
  const codeNext = generateTotpCode(secret, now + 30000);
  const codeExpired = generateTotpCode(secret, now - 90000);

  assert.equal(codeNow.length, 6);
  assert.equal(verifyTotpCode(secret, codeNow, { timestampMs: now }), true);
  assert.equal(verifyTotpCode(secret, codePrev, { timestampMs: now }), true);
  assert.equal(verifyTotpCode(secret, codeNext, { timestampMs: now }), true);
  assert.equal(verifyTotpCode(secret, codeExpired, { timestampMs: now }), false);
  assert.equal(verifyTotpCode(secret, '000000', { timestampMs: now }), codeNow === '000000');
});

test('Password hashing, session token signing, and brute-force rate limiter', () => {
  const h = hashPassword('MySecretPass!123');
  assert.equal(verifyPassword('MySecretPass!123', h), true);
  assert.equal(verifyPassword('WrongPass', h), false);

  const cookieSecret = 'test_cookie_secret_1234567890';
  const token = signSessionToken(cookieSecret, { sub: 'owner', maxAgeMs: 10000, nowMs: 1000 });
  assert.equal(verifySessionToken(cookieSecret, token, 5000).valid, true);
  assert.equal(verifySessionToken(cookieSecret, token, 15000).valid, false);
  assert.equal(verifySessionToken('wrong_secret', token, 5000).valid, false);

  const limiter = new LoginRateLimiter({ maxAttemptsPerWindow: 3, maxConsecutiveFailures: 3 });
  assert.equal(limiter.check('1.2.3.4', 1000).allowed, true);
  limiter.recordAttempt('1.2.3.4', false, 1000);
  limiter.recordAttempt('1.2.3.4', false, 1001);
  limiter.recordAttempt('1.2.3.4', false, 1002);
  const locked = limiter.check('1.2.3.4', 1003);
  assert.equal(locked.allowed, false);
  assert.equal(locked.reason, 'locked');
});

test('Full integration: Cloud Relay + Local Agent + Web Client over WebSocket', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-remote-test-'));
  const upstream = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const servicePort = upstream.address().port;

  const cloud = createCloudServer({
    host: '127.0.0.1',
    port: 0,
    dataDir: tmpDir,
    env: {
      CODEX_ADMIN_PASSWORD: 'test-password-999',
      CODEX_TOTP_SECRET: 'JBSWY3DPEHPK3PXP',
    },
    quiet: true,
  });

  const port = await cloud.listen();
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsBaseUrl = `ws://127.0.0.1:${port}`;

  let localAgent = null;
  let clientWs = null;

  try {
    // 1. Login with Password + TOTP
    const totpCode = generateTotpCode('JBSWY3DPEHPK3PXP');
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-password-999', totpCode }),
    });
    assert.equal(loginRes.status, 200);
    const setCookie = loginRes.headers.get('set-cookie');
    assert.ok(setCookie && setCookie.includes('codex_remote_session='));
    const cookieHeader = setCookie.split(';')[0];

    // 2. Start Local Agent connecting to Cloud Relay
    localAgent = startLocalAgent({
      relayUrl: `${wsBaseUrl}/ws/agent`,
      agentName: 'test-workstation',
      codexHome: path.join(tmpDir, 'agent'),
      defaultCwd: tmpDir,
      webServices: [{ id: 't3-code', name: 'T3 Code', port: servicePort }],
      quiet: true,
    });

    // 3. Connect Web Client WebSocket
    clientWs = await connectWebSocketClient(`${wsBaseUrl}/ws/client`, {
      headers: { Cookie: cookieHeader },
    });

    // Wait for agent to appear in relay/agents or relay/welcome
    const agentId = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for agent registration')), 8000);
      clientWs.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if ((msg.type === 'relay/welcome' || msg.type === 'relay/agents') && Array.isArray(msg.agents)) {
          const found = msg.agents.find((a) => a.online && a.webServices?.[0]?.status === 'ready');
          if (found) {
            clearTimeout(timer);
            resolve(found.agentId);
          }
        }
      });
    });

    // 4. Before trusting, forwarding is rejected
    const untrustedRes = await fetch(`${baseUrl}/local/${agentId}/${servicePort}/api/test`, {
      headers: { Cookie: cookieHeader, Origin: baseUrl },
    });
    assert.equal(untrustedRes.status, 403);

    // 5. Trust the newly registered local agent
    const trustRes = await fetch(`${baseUrl}/api/agents/trust`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
      },
      body: JSON.stringify({ agentId, trusted: true }),
    });
    assert.equal(trustRes.status, 200);

    // 6. Access forwarded service through trusted relay
    const forwardedRes = await fetch(`${baseUrl}/local/${agentId}/${servicePort}/api/test`, {
      headers: { Cookie: cookieHeader, Origin: baseUrl },
    });
    assert.equal(forwardedRes.status, 200);
    assert.deepEqual(await forwardedRes.json(), { ok: true, path: '/api/test' });
  } finally {
    if (clientWs) clientWs.close();
    if (localAgent) localAgent.stop();
    await cloud.close();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
