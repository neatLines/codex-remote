import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCloudServer } from '../src/cloud-server.mjs';
import {
  E2EVerifier,
  generateTotpCode,
  generateTotpSecret,
  hashPassword,
  LoginRateLimiter,
  signE2EPayload,
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

test('E2E HMAC signature verification and replay prevention', () => {
  const key = 'ABCD-1234-EFGH';
  const verifier = new E2EVerifier(key, { maxSkewMs: 30000 });
  const now = Date.now();
  const bodyString = JSON.stringify({ id: '1', method: 'turn/start', params: { text: 'hi' } });
  const nonce = 'nonce_123456';
  const signature = signE2EPayload(key, { timestamp: now, nonce, bodyString });

  const first = verifier.verify({ timestamp: now, nonce, bodyString, signature }, now);
  assert.equal(first.ok, true);

  // Replay with same nonce must fail
  const replay = verifier.verify({ timestamp: now, nonce, bodyString, signature }, now + 100);
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, 'replay_detected');

  // Expired timestamp must fail
  const expiredSig = signE2EPayload(key, { timestamp: now - 60000, nonce: 'nonce_999999', bodyString });
  const expired = verifier.verify(
    { timestamp: now - 60000, nonce: 'nonce_999999', bodyString, signature: expiredSig },
    now
  );
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, 'timestamp_out_of_range');
});

test('Full E2E integration: Cloud Relay + Local Agent + Mobile Client over WebSocket', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-remote-test-'));
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
      codexBin: fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)),
      quiet: true,
    });

    // 3. Connect Mobile Client WebSocket
    clientWs = await connectWebSocketClient(`${wsBaseUrl}/ws/client`, {
      headers: { Cookie: cookieHeader },
    });

    const received = [];
    clientWs.on('message', (raw) => received.push(JSON.parse(raw)));

    // Wait for agent to appear in relay/agents or relay/welcome
    const agentId = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for agent registration')), 8000);
      clientWs.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if ((msg.type === 'relay/welcome' || msg.type === 'relay/agents') && Array.isArray(msg.agents)) {
          const found = msg.agents.find((a) => a.online);
          if (found) {
            clearTimeout(timer);
            resolve(found.agentId);
          }
        }
      });
    });

    // 4. Trust the newly registered local agent
    const trustRes = await fetch(`${baseUrl}/api/agents/trust`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
      },
      body: JSON.stringify({ agentId, trusted: true }),
    });
    assert.equal(trustRes.status, 200);

    // 5. Request workspaces and threads across all desktop projects
    const rpcPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for workspaces RPC')), 10000);
      clientWs.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'relay/rpc' && msg.payload?.id === 'req_ws_1') {
          clearTimeout(timer);
          resolve(msg.payload);
        }
      });
    });

    clientWs.send({
      type: 'client/rpc',
      agentId,
      payload: {
        id: 'req_ws_1',
        method: 'remote/getWorkspacesAndThreads',
        params: { limit: 20 },
      },
    });

    const rpcResponse = await rpcPromise;
    assert.ok(!rpcResponse.error, `Unexpected RPC error: ${JSON.stringify(rpcResponse.error)}`);
    assert.ok(Array.isArray(rpcResponse.result.projects), 'Expected projects array');
    assert.ok(Array.isArray(rpcResponse.result.threads), 'Expected threads array');
    assert.ok(rpcResponse.result.projects.length > 0, 'Expected workspaces to be discovered');

    function waitForPayload(predicate) {
      const found = received.find((message) => message.type === 'relay/rpc' && predicate(message.payload));
      if (found) return Promise.resolve(found.payload);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { clientWs.off('message', onMessage); reject(new Error('Timeout waiting for fixture RPC')); }, 5000);
        function onMessage(raw) {
          const message = JSON.parse(raw);
          if (message.type !== 'relay/rpc' || !predicate(message.payload)) return;
          clearTimeout(timer);
          clientWs.off('message', onMessage);
          resolve(message.payload);
        }
        clientWs.on('message', onMessage);
      });
    }
    function sendRpc(id, method, params) {
      const payload = { id, method, params };
      const timestamp = Date.now();
      const nonce = `fixture_${id}`;
      const signature = signE2EPayload(localAgent.identity.localSigningKey, {
        timestamp, nonce, bodyString: JSON.stringify(payload),
      });
      clientWs.send({ type: 'client/rpc', agentId, payload, e2e: { timestamp, nonce, signature } });
      return waitForPayload((response) => response.id === id);
    }

    // A history request lasting longer than the 350ms lock-release delay must survive.
    await sendRpc('turn_ok', 'turn/start', { threadId: 'fixture-thread', input: [{ type: 'text', text: 'hello' }] });
    await waitForPayload((payload) => payload.method === 'turn/completed');
    const history = await sendRpc('history_slow', 'thread/turns/list', { threadId: 'fixture-thread' });
    assert.ok(Array.isArray(history.result?.data), 'In-flight history must not be killed by recycling');

    // A rejected start must not leave the thread permanently marked active.
    const rejected = await sendRpc('turn_fail', 'turn/start', { threadId: 'fixture-thread', input: [{ type: 'text', text: 'fail' }] });
    assert.match(rejected.error.message, /fixture rejected turn/);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const log = fs.readFileSync(path.join(tmpDir, 'fake-codex.log'), 'utf8');
    assert.ok(log.split(' start\n').length >= 3, 'Rejected turns should release locks and allow recycling');
  } finally {
    if (clientWs) clientWs.close();
    if (localAgent) localAgent.stop();
    await cloud.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
