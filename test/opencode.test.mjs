import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCloudServer } from '../src/cloud-server.mjs';
import { startLocalAgent } from '../src/local-agent.mjs';
import { openCodeRewriter } from '../src/opencode-web.mjs';
import { generateTotpCode } from '../src/crypto-auth.mjs';
import { connectWebSocketClient } from '../src/ws-minimal.mjs';

async function port() {
  const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const result = s.address().port; await new Promise((r) => s.close(r)); return result;
}
async function until(check) {
  for (let i = 0; i < 400; i++) { if (check()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('OpenCode fixture timed out');
}

test('OpenCode-only devices share login but isolate native UI, APIs, streams and WebSockets by device', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-opencode-'));
  const cloud = createCloudServer({ host: '127.0.0.1', port: 0, dataDir: path.join(dir, 'cloud'), quiet: true,
    env: { CODEX_ADMIN_PASSWORD: 'fixture-password', CODEX_TOTP_SECRET: 'JBSWY3DPEHPK3PXP' } });
  const agents = []; let ws;
  try {
    const cloudPort = await cloud.listen(); const base = `http://127.0.0.1:${cloudPort}`;
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'fixture-password', totpCode: generateTotpCode('JBSWY3DPEHPK3PXP') }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const headers = { Cookie: cookie, Origin: base };
    for (const name of ['server', 'laptop']) {
      const cwd = path.join(dir, name); fs.mkdirSync(cwd);
      const agent = startLocalAgent({ relayUrl: `ws://127.0.0.1:${cloudPort}/ws/agent`, codexHome: path.join(cwd, 'identity'),
        defaultCwd: cwd, codexEnabled: false, dshEnabled: false, opencodeEnabled: true, quiet: true,
        opencodeCwd: cwd, opencodePort: await port(), opencodeBin: fileURLToPath(new URL('./fixtures/fake-opencode.mjs', import.meta.url)) });
      agents.push(agent);
      await until(() => cloud.agents.get(agent.identity.agentId)?.opencodeWeb.status === 'ready');
      const url = `${base}/opencode/${agent.identity.agentId}/`;
      assert.equal((await fetch(url)).status, 401);
      assert.equal((await fetch(url, { headers })).status, 403);
      await fetch(`${base}/api/agents/trust`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: agent.identity.agentId, trusted: true }) });
      assert.equal((await fetch(url, { headers: { ...headers, Origin: 'https://evil.test' } })).status, 403);
      assert.match(await (await fetch(url, { headers })).text(), new RegExp(`/opencode/${agent.identity.agentId}/_assets/index.js`));
      const js = await (await fetch(url + '_assets/index.js', { headers })).text();
      assert.ok(js.includes(`base:"/opencode/${agent.identity.agentId}"`));
      assert.ok(js.includes(`currentServerUrl:location.origin+"/opencode/${agent.identity.agentId}"`));
      assert.doesNotMatch(js, /serviceWorker\.register/);
      const compressed = await fetch(url + '_assets/index.js', { headers: { ...headers, 'Accept-Encoding': 'gzip' } });
      assert.equal(compressed.headers.get('content-encoding'), 'gzip');
      assert.equal(await compressed.text(), js);
      const plain = await fetch(url + '_assets/index.js', { headers: { ...headers, 'Accept-Encoding': 'gzip;q=0, identity' } });
      assert.equal(plain.headers.get('content-encoding'), null);
      assert.equal(await plain.text(), js);
      const device = await (await fetch(url + 'api/device', { headers: { ...headers, Authorization: 'untrusted-browser-value' } })).json();
      assert.deepEqual(device, { device: name, cookieForwarded: false, authorizationMatched: true });
      assert.equal(await (await fetch(url + 'api/events', { headers })).text(), `data: ${name}\n\ndata: done\n\n`);
      const body = Buffer.alloc(200000, name === 'server' ? 12 : 13);
      assert.deepEqual(Buffer.from(await (await fetch(url + 'api/echo', { method: 'POST', headers, body })).arrayBuffer()), body);
    }
    const list = await (await fetch(`${base}/api/agents`, { headers })).json();
    assert.equal(list.agents.length, 2);
    assert.ok(list.agents.every((agent) => agent.codexEnabled === false && agent.opencodeWeb.enabled));
    const id = agents[0].identity.agentId;
    ws = await connectWebSocketClient(`ws://127.0.0.1:${cloudPort}/opencode/${id}/api/pty`, { headers });
    const incoming = new Promise((resolve) => ws.once('message', resolve)); ws.send('terminal');
    assert.equal(await incoming, 'server:terminal');
    const closed = new Promise((resolve) => ws.once('close', resolve));
    await fetch(`${base}/api/agents/trust`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: id, trusted: false }) });
    await closed;
    assert.equal((await fetch(`${base}/opencode/${id}/api/device`, { headers })).status, 403);
    const otherId = agents[1].identity.agentId;
    assert.equal((await fetch(`${base}/opencode/${otherId}/api/device`, { headers })).status, 200);
  } finally { ws?.close(); agents.forEach((agent) => agent.stop()); await cloud.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('native web adaptation rejects incompatible entry bundles and leaves APIs untouched', () => {
  const rewrite = openCodeRewriter('device_1');
  assert.equal(rewrite.matches('/api/session', { 'content-type': 'application/json' }), false);
  assert.equal(rewrite.matches('/api/file/code.js', { 'content-type': 'application/javascript' }), false);
  assert.throws(() => openCodeRewriter('</script>'), /Invalid/);
  assert.throws(() => rewrite.transform('/_assets/index.js', Buffer.from('const a={currentServerUrl:changed()}'),
    { 'content-type': 'application/javascript' }), /Unsupported/);
});

test('native route parser and dynamic CSS preloader stay inside the selected device mount', () => {
  const rewrite = openCodeRewriter('server');
  const headers = { 'content-type': 'application/javascript' };
  const parser = 'const parse=(path,search)=>{let parts=path.split(`/`).filter(Boolean);if(parts.length===0)return{type:`home`};if(parts[0]===`new-session`)return{type:`draft`};throw Error(`Unrecognised route!`)};return parse;';
  const parse = new Function(rewrite.transform('/_assets/runtime.js', Buffer.from(parser), headers).toString())();
  assert.deepEqual(parse('/opencode/server/', ''), { type: 'home' });
  assert.deepEqual(parse('/opencode/server/new-session', ''), { type: 'draft' });
  assert.throws(() => parse('/opencode/other/new-session', ''), /Unrecognised/);
  const preload = 'return function(asset){return`/`+asset}';
  const url = new Function(rewrite.transform('/_assets/preload-helper-test.js', Buffer.from(preload), headers).toString())();
  assert.equal(url('_assets/dialog.css'), '/opencode/server/_assets/dialog.css');
});
