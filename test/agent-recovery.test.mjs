import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCloudServer } from '../src/cloud-server.mjs';
import { generateTotpCode, signE2EPayload } from '../src/crypto-auth.mjs';
import { startLocalAgent } from '../src/local-agent.mjs';
import { connectWebSocketClient } from '../src/ws-minimal.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(check, timeout = 5000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const result = await check(); if (result) return result; await sleep(20); }
  throw new Error('Timed out waiting for fixture state');
}

async function fixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-agent-recovery-'));
  const cloud = createCloudServer({ host: '127.0.0.1', port: 0, dataDir: path.join(directory, 'cloud'), quiet: true,
    env: { CODEX_ADMIN_PASSWORD: 'fixture-password', CODEX_TOTP_SECRET: 'JBSWY3DPEHPK3PXP' } });
  const port = await cloud.listen();
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'fixture-password', totpCode: generateTotpCode('JBSWY3DPEHPK3PXP') }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const agent = startLocalAgent({ relayUrl: `ws://127.0.0.1:${port}/ws/agent`,
    codexHome: path.join(directory, 'agent'), defaultCwd: directory,
    codexBin: fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)),
    quiet: true, dshEnabled: false, requestTimeoutMs: 500, restartDelayMs: 30, ...options });
  await eventually(() => cloud.agents.has(agent.identity.agentId));
  await fetch(`${base}/api/agents/trust`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ agentId: agent.identity.agentId, trusted: true }) });
  let sequence = 0;
  const clients = [];
  async function connect() {
    const ws = await connectWebSocketClient(`ws://127.0.0.1:${port}/ws/client`, { headers: { Cookie: cookie } });
    clients.push(ws);
    const messages = [];
    ws.on('message', (raw) => messages.push(JSON.parse(raw)));
    async function rpc(method, params = {}, signed = true) {
      const id = `fixture-${++sequence}`;
      const payload = { id, method, params };
      const timestamp = Date.now(); const nonce = `nonce-${id}`;
      const e2e = signed ? { timestamp, nonce, signature: signE2EPayload(agent.identity.localSigningKey,
        { timestamp, nonce, bodyString: JSON.stringify(payload) }) } : null;
      ws.send({ type: 'client/rpc', agentId: agent.identity.agentId, payload, e2e });
      const result = await eventually(() => messages.find((message) =>
        (message.type === 'relay/rpc' && message.payload?.id === id) ||
        (message.type === 'relay/e2e_error' && message.requestId === id)), 6000);
      return result.payload || { error: { message: result.reason } };
    }
    return { ws, rpc, messages };
  }
  return { cloud, agent, directory, connect,
    async close() { for (const ws of clients) ws.close(); agent.stop(); await cloud.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('pending questions survive browser reconnects; signed multi-device answers are confirmed exactly once', async () => {
  const env = await fixture();
  try {
    const first = await env.connect();
    const started = await first.rpc('turn/start', { threadId: 'A', input: [{ type: 'text', text: 'ask' }] });
    assert.equal(started.result.turn.id, 'turn');
    const initial = await first.rpc('remote/getAgentState');
    assert.equal(initial.result.requests.length, 1);
    assert.equal(initial.result.activeTurns[0].threadId, 'A');
    const question = initial.result.requests[0];
    first.ws.close();
    const phone = await env.connect();
    const tablet = await env.connect();
    const restored = await phone.rpc('remote/getAgentState');
    assert.equal(restored.result.requests[0].id, question.id);
    assert.equal(restored.result.epoch, initial.result.epoch);
    const answer = { requestId: question.id, requestEpoch: question.requestEpoch,
      result: { answers: { choice: { answers: ['One'] } } } };
    const unsigned = await phone.rpc('remote/respondToRequest', answer, false);
    assert.match(unsigned.error.message, /验签/);
    const answers = await Promise.all([phone.rpc('remote/respondToRequest', answer), tablet.rpc('remote/respondToRequest', answer)]);
    for (const response of answers) assert.equal(response.result?.resolved, true);
    const state = await phone.rpc('remote/getAgentState');
    assert.equal(state.result.requests.length, 0);
    assert.equal(state.result.activeTurns.length, 0);
    const duplicate = await phone.rpc('remote/respondToRequest', answer);
    assert.equal(duplicate.result.resolved, true);
    const log = fs.readFileSync(path.join(env.directory, 'fake-codex.log'), 'utf8');
    assert.equal(log.split('interaction-response').length - 1, 1);
  } finally { await env.close(); }
});

test('internal and forwarded RPC timeouts settle; a crashing child clears stale work and recovers', async () => {
  const env = await fixture();
  try {
    const client = await env.connect();
    const before = (await client.rpc('remote/getAgentState')).result;
    const internalTimeout = await client.rpc('remote/getWorkspacesAndThreads', { limit: 999 });
    assert.match(internalTimeout.error.message, /超时/);
    const resumeTimeout = await client.rpc('turn/start', { threadId: 'hang-resume', input: [{ type: 'text', text: 'task' }] });
    assert.match(resumeTimeout.error.message, /超时/);
    const forwardedTimeout = await client.rpc('fixture/hang');
    assert.match(forwardedTimeout.error.message, /超时/);
    const hanging = client.rpc('fixture/hang');
    const crash = client.rpc('fixture/crash');
    for (const response of await Promise.all([hanging, crash])) assert.match(response.error.message, /退出|中断/);
    const recovered = await eventually(async () => {
      const state = (await client.rpc('remote/getAgentState')).result;
      return state.status === 'ready' && state.epoch !== before.epoch ? state : null;
    });
    assert.equal(recovered.requests.length, 0);
    const workspaces = await client.rpc('remote/getWorkspacesAndThreads');
    assert.ok(Array.isArray(workspaces.result.projects));
    const page = await client.rpc('remote/getWorkspacesAndThreads', { cursor: workspaces.result.nextCursor });
    assert.equal(page.result.threads[0].id, 'fixture-page-2');
    assert.equal(workspaces.result.threadSortKey, 'updated_at');
    assert.ok(fs.readFileSync(path.join(env.directory, 'fake-codex.log'), 'utf8').split('\n')
      .filter((line) => line.endsWith('thread-list updated_at desc')).length >= 2);
  } finally { await env.close(); }
});

test('a missing Codex executable produces a recoverable Agent state instead of an unhandled process error', async () => {
  const env = await fixture({ codexBin: '/definitely-missing/codex', restartDelayMs: 1000 });
  try {
    const client = await env.connect();
    const state = (await client.rpc('remote/getAgentState')).result;
    assert.equal(state.status, 'error');
    assert.match(state.error, /无法启动/);
    const result = await client.rpc('thread/list');
    assert.match(result.error.message, /尚未就绪|重启/);
  } finally { await env.close(); }
});

test('busy profiles cannot discard active questions and stale epochs are rejected', async () => {
  const env = await fixture();
  try {
    const client = await env.connect();
    await client.rpc('turn/start', { threadId: 'A', input: [{ type: 'text', text: 'ask' }] });
    const state = (await client.rpc('remote/getAgentState')).result;
    const blocked = await client.rpc('remote/switchProfile', { profile: 'other' });
    assert.match(blocked.error.message, /先等待/);
    assert.equal((await client.rpc('remote/getAgentState')).result.epoch, state.epoch);
    const stale = await client.rpc('remote/respondToRequest', { requestId: state.requests[0].id,
      requestEpoch: 'previous-process', result: { answers: {} } });
    assert.match(stale.error.message, /已结束的 Codex 进程/);
    const steer = await client.rpc('turn/steer', { threadId: 'A', expectedTurnId: 'turn', input: [{ type: 'text', text: 'extra' }] });
    assert.equal(steer.result.turnId, 'turn');
  } finally { await env.close(); }
});

test('normal startup logs contain no password, TOTP seed, authenticator URI or local pairing key', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-redacted-logs-'));
  const original = console.log;
  const output = [];
  let cloud; let agent;
  try {
    console.log = (...args) => output.push(args.join(' '));
    cloud = createCloudServer({ host: '127.0.0.1', port: 0, dataDir: path.join(directory, 'cloud'), env: {
      CODEX_ADMIN_PASSWORD: 'do-not-log-password', CODEX_TOTP_SECRET: 'JBSWY3DPEHPK3PXP',
    } });
    const port = await cloud.listen();
    agent = startLocalAgent({ relayUrl: `ws://127.0.0.1:${port}/ws/agent`,
      codexHome: path.join(directory, 'agent'), defaultCwd: directory, dshEnabled: false,
      codexBin: fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)) });
    const text = output.join('\n');
    assert.doesNotMatch(text, /do-not-log-password|JBSWY3DPEHPK3PXP|otpauth:\/\//);
    assert.equal(text.includes(agent.identity.localSigningKey), false);
    assert.match(text, /show-pairing-key/);
  } finally {
    console.log = original; agent?.stop(); if (cloud) await cloud.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
