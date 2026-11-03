import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCloudServer } from '../src/cloud-server.mjs';
import { generateTotpCode, generateTotpSecret } from '../src/crypto-auth.mjs';
import { startLocalAgent } from '../src/local-agent.mjs';
import { uploadAgentFile, uploadCredentialsPath } from '../src/file-upload.mjs';
import { createFileStore } from '../src/file-store.mjs';

async function until(predicate) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('File fixture timed out');
}

async function fixture(limits = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-files-test-'));
  const dataDir = path.join(dir, 'cloud'), codexHome = path.join(dir, 'codex');
  const env = { CODEX_ADMIN_PASSWORD: crypto.randomBytes(24).toString('hex'), CODEX_TOTP_SECRET: generateTotpSecret(), ...limits };
  let cloud = createCloudServer({ host: '127.0.0.1', port: 0, dataDir, quiet: true, env });
  let base, relayUrl, cookie, agent;
  async function listen() {
    const port = await cloud.listen();
    base = `http://127.0.0.1:${port}`; relayUrl = `ws://127.0.0.1:${port}/ws/agent`;
    const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: env.CODEX_ADMIN_PASSWORD, totpCode: generateTotpCode(env.CODEX_TOTP_SECRET) }) });
    assert.equal(response.status, 200);
    cookie = response.headers.get('set-cookie').split(';')[0]; await response.arrayBuffer();
  }
  await listen();
  agent = startLocalAgent({ relayUrl, codexHome, quiet: true, dshEnabled: false, defaultCwd: dir,
    codexBin: fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)) });
  await until(() => cloud.agents.has(agent.identity.agentId));
  const agentId = agent.identity.agentId;
  async function trust(trusted) {
    const response = await fetch(base + '/api/agents/trust', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, trusted }) });
    assert.equal(response.status, 200); await response.arrayBuffer();
  }
  const authHeaders = () => {
    const credentials = JSON.parse(fs.readFileSync(uploadCredentialsPath(codexHome)));
    return { Authorization: `Bearer ${credentials.token}`, 'X-Codex-Agent-Id': agentId };
  };
  return {
    dir, dataDir, codexHome, agentId, get cloud() { return cloud; }, get base() { return base; }, get cookie() { return cookie; },
    get relayUrl() { return relayUrl; }, get agent() { return agent; }, trust, authHeaders,
    async ready() { await trust(true); await until(() => fs.existsSync(uploadCredentialsPath(codexHome))); },
    async upload(bytes, options = {}) {
      const source = path.join(dir, 'source.bin'); fs.writeFileSync(source, bytes);
      return uploadAgentFile(source, { codexHome, relayUrl, ...options });
    },
    async request(suffix, options = {}) { return fetch(base + suffix, { ...options, headers: { Cookie: cookie, ...options.headers } }); },
    async restart() { agent?.stop(); agent = null; await cloud.close(); cloud = createCloudServer({ host: '127.0.0.1', port: 0, dataDir, quiet: true, env }); await listen(); },
    async close() { agent?.stop(); await cloud.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('trusted Agent uploads stream to persistent storage and login is required for safe downloads', async () => {
  const env = await fixture();
  try {
    assert.equal(fs.existsSync(uploadCredentialsPath(env.codexHome)), false);
    assert.equal((await fetch(env.base + '/api/files')).status, 401);
    assert.equal((await env.request('/api/files', { method: 'POST', body: 'x' })).status, 403, 'Browser session is not an upload credential');
    await env.ready();
    assert.equal(fs.statSync(uploadCredentialsPath(env.codexHome)).mode & 0o777, 0o600);
    const body = crypto.randomBytes(400000);
    const file = await env.upload(body, { name: '报告 <img src=x>.html', threadId: 'thread-123' });
    assert.equal(file.size, body.length);
    assert.equal(file.sha256, crypto.createHash('sha256').update(body).digest('hex'));
    const list = await (await env.request('/api/files')).json();
    assert.equal(list.files.length, 1); assert.equal(list.files[0].name, file.name);
    assert.equal(list.files[0].threadId, 'thread-123');
    assert.equal(list.storage.usedBytes, body.length);
    assert.doesNotMatch(JSON.stringify(list), /fup_|fileUploadToken|source\.bin|localSigningKey/);
    assert.equal((await fetch(file.url)).status, 401);
    const download = await env.request(file.downloadUrl);
    assert.match(download.headers.get('content-disposition'), /^attachment;.*filename\*=UTF-8''/);
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), body);
    const head = await env.request(file.downloadUrl, { method: 'HEAD' });
    assert.equal(Number(head.headers.get('content-length')), body.length);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const partial = await env.request(file.downloadUrl, { headers: { Range: 'bytes=3-19' } });
    assert.equal(partial.status, 206); assert.deepEqual(Buffer.from(await partial.arrayBuffer()), body.subarray(3, 20));
    const suffix = await env.request(file.downloadUrl, { headers: { Range: 'bytes=-7' } });
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), body.subarray(-7));
    assert.equal((await env.request(file.downloadUrl, { headers: { Range: 'bytes=999999-' } })).status, 416);
    assert.equal((await env.request('/api/files/%2e%2e%2fauth.json/download')).status, 404);
    const tokenHeaders = env.authHeaders();
    await env.trust(false);
    await until(() => !fs.existsSync(uploadCredentialsPath(env.codexHome)));
    assert.equal((await env.request('/api/files', { method: 'POST', headers: { ...tokenHeaders, 'X-File-Name': 'denied.txt' }, body: 'x' })).status, 403);
    const retained = await env.request(file.downloadUrl);
    assert.equal(retained.status, 200, 'Existing files remain available after device revocation'); await retained.arrayBuffer();
  } finally { await env.close(); }
});

test('file limits, malicious names, pagination, duplicate names and empty files are handled without overwrites', async () => {
  const env = await fixture({ CODEX_FILES_MAX_BYTES: '10', CODEX_FILES_MAX_STORAGE_BYTES: '15' });
  try {
    await env.ready();
    const post = (name, body) => env.request('/api/files', { method: 'POST', headers: { ...env.authHeaders(), 'X-File-Name': name }, body });
    for (const name of ['..%2fprivate', 'x%5cy', 'x%0d%0ay', '%FF', '..', '']) assert.equal((await post(name, 'x')).status, 400);
    assert.equal((await post('big.bin', '12345678901')).status, 413);
    const first = await env.upload('1234567', { name: 'same.txt' });
    const second = await env.upload('ABCDEFG', { name: 'same.txt' });
    assert.notEqual(first.id, second.id);
    const empty = await env.upload('', { name: 'empty.txt' });
    const emptyDownload = await env.request(empty.downloadUrl); assert.equal((await emptyDownload.arrayBuffer()).byteLength, 0);
    assert.equal((await post('full.bin', '12')).status, 507);
    let cursor, ids = [];
    do {
      const page = await (await env.request('/api/files?limit=1' + (cursor ? '&cursor=' + cursor : ''))).json();
      ids.push(...page.files.map((file) => file.id)); cursor = page.nextCursor;
    } while (cursor);
    assert.equal(ids.length, 3); assert.equal(new Set(ids).size, 3);
    assert.equal((await env.request('/api/files?cursor=bogus')).status, 400);
    assert.equal((await env.request('/api/files?limit=101')).status, 400);
    assert.equal((await (await env.request('/api/files?threadId=absent')).json()).files.length, 0);
    await env.restart();
    assert.equal((await (await env.request('/api/files')).json()).files.length, 3);
    assert.equal(await (await env.request(first.downloadUrl)).text(), '1234567');
    assert.equal(await (await env.request(second.downloadUrl)).text(), 'ABCDEFG');
  } finally { await env.close(); }
});

test('interrupted uploads remove partial files and release reserved quota', async () => {
  const env = await fixture({ CODEX_FILES_MAX_BYTES: '1000', CODEX_FILES_MAX_STORAGE_BYTES: '1000' });
  let request;
  try {
    await env.ready();
    request = http.request(env.base + '/api/files', { method: 'POST', headers: {
      ...env.authHeaders(), 'X-File-Name': 'interrupted.bin', 'Content-Length': '1000',
    } });
    request.on('error', () => {}); request.write('first bytes');
    await until(() => fs.readdirSync(path.join(env.dataDir, 'files')).some((name) => name.endsWith('.part')));
    request.destroy();
    await until(() => !fs.readdirSync(path.join(env.dataDir, 'files')).some((name) => name.endsWith('.part')));
    assert.equal((await (await env.request('/api/files')).json()).files.length, 0);
    const complete = await env.upload(Buffer.alloc(1000));
    assert.equal(complete.size, 1000);
  } finally { request?.destroy(); await env.close(); }
});

test('the upload CLI works with the Agent offline and does not launch another Codex process', async () => {
  const env = await fixture();
  try {
    await env.ready(); env.agent.stop();
    const source = path.join(env.dir, 'cli.txt'); fs.writeFileSync(source, 'CLI upload');
    const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../src/local-agent.mjs', import.meta.url)),
      '--upload', source, '--relay', env.relayUrl, '--name', '命令行.txt'], {
      env: { ...process.env, CODEX_HOME: env.codexHome, CODEX_BIN: '/must-not-start-codex' }, timeout: 5000,
    });
    const data = JSON.parse(result.stdout);
    assert.equal(data.ok, true); assert.equal(data.file.name, '命令行.txt');
    assert.equal(await (await env.request(data.file.downloadUrl)).text(), 'CLI upload');
    await assert.rejects(uploadAgentFile(source, { codexHome: env.codexHome, relayUrl: 'wss://other.invalid/ws/agent' }), /不匹配/);
  } finally { await env.close(); }
});

test('downloads reject symlink replacements and restart removes unfinished temporary files', async () => {
  const env = await fixture();
  try {
    await env.ready(); const file = await env.upload('original');
    const root = path.join(env.dataDir, 'files');
    const outside = path.join(env.dir, 'outside.txt'); fs.writeFileSync(outside, 'must not be downloaded');
    fs.unlinkSync(path.join(root, file.id + '.blob')); fs.symlinkSync(outside, path.join(root, file.id + '.blob'));
    assert.equal((await env.request(file.downloadUrl)).status, 404);
    const temporary = 'f'.repeat(32) + '.part'; fs.writeFileSync(path.join(root, temporary), 'incomplete');
    await env.restart();
    assert.equal(fs.existsSync(path.join(root, temporary)), false);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'must not be downloaded');
    assert.equal((await (await env.request('/api/files')).json()).files.length, 0);
  } finally { await env.close(); }
});

test('concurrent reservations enforce storage and per-device limits and revocation aborts in-flight uploads', async () => {
  const env = await fixture({ CODEX_FILES_MAX_BYTES: '1000', CODEX_FILES_MAX_STORAGE_BYTES: '1000' });
  const requests = [];
  try {
    await env.ready();
    for (let index = 0; index < 2; index++) {
      const request = http.request(env.base + '/api/files', { method: 'POST', headers: {
        ...env.authHeaders(), 'X-File-Name': `slow-${index}`, 'Content-Length': '400',
      } });
      request.on('error', () => {}); request.write('first'); requests.push(request);
    }
    const root = path.join(env.dataDir, 'files');
    await until(() => fs.readdirSync(root).filter((name) => name.endsWith('.part')).length === 2);
    const response = await env.request('/api/files', { method: 'POST', headers: { ...env.authHeaders(), 'X-File-Name': 'third' }, body: 'x' });
    assert.equal(response.status, 429); await response.arrayBuffer();
    await env.trust(false);
    await until(() => !fs.readdirSync(root).some((name) => name.endsWith('.part')));
    assert.equal((await (await env.request('/api/files')).json()).files.length, 0);
    await env.ready();
    assert.equal((await env.upload(Buffer.alloc(1000))).size, 1000);
  } finally { for (const request of requests) request.destroy(); await env.close(); }
});

test('knowing a paired Agent ID cannot retrieve or rotate its existing upload credential', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-files-credentials-'));
  const authStore = { state: { trustedAgents: { device: { name: 'test device' } } }, save() {} };
  const store = createFileStore({ dataDir: dir, authStore, isAuthenticated: () => false });
  try {
    assert.equal(store.issueCredentials('unknown', { allowCreate: true }), null);
    assert.equal(store.issueCredentials('__proto__', { allowCreate: true }), null);
    assert.equal(store.issueCredentials('device'), null, 'Old Agents do not consume first-use credentials');
    const first = store.issueCredentials('device', { allowCreate: true });
    assert.ok(first.token);
    assert.equal(store.issueCredentials('device', { allowCreate: true }), null);
    assert.equal(store.issueCredentials('device', { token: 'invalid', allowCreate: true }), null);
    assert.equal(store.issueCredentials('device', { token: first.token }).token, first.token);
    const replacement = store.issueCredentials('device', { reset: true });
    assert.notEqual(replacement.token, first.token);
    assert.equal(store.issueCredentials('device', { token: first.token }), null);
    assert.equal(store.issueCredentials('device', { token: replacement.token }).token, replacement.token);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
