import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { gzipSync } from 'node:zlib';
import { createCloudServer } from '../src/cloud-server.mjs';
import { startLocalAgent } from '../src/local-agent.mjs';
import { generateTotpCode } from '../src/crypto-auth.mjs';
import { acceptWebSocketUpgrade, connectWebSocketClient } from '../src/ws-minimal.mjs';
import { localWebScript, localCookiePrefix } from '../src/local-web.mjs';

async function until(check) {
  for (let i = 0; i < 250; i++) { if (check()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('Local web fixture timed out');
}
test('generic loopback proxy handles multiple ports, assets, cookies, bearer auth, streams and WebSockets behind gateway login', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-web-test-'));
  const servers = [], agents = [], sockets = [], connections = new Set();
  const cloud = createCloudServer({ host: '127.0.0.1', port: 0, dataDir: path.join(dir, 'cloud'), quiet: true,
    env: { CODEX_ADMIN_PASSWORD: 'fixture-password', CODEX_TOTP_SECRET: 'JBSWY3DPEHPK3PXP' } });
  try {
    for (let i = 0; i < 2; i++) {
      const server = http.createServer((req, res) => {
        if (req.url === '/api/headers') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.headers)); }
        else if (req.url === '/api/cookie') { res.setHeader('Set-Cookie', ['session=value; Path=/; HttpOnly', 'theme=dark; Path=/ui; SameSite=Strict']); res.end('ok'); }
        else if (req.url === '/api/redirect') { res.writeHead(302, { Location: `http://127.0.0.1:${server.address().port}/ui/#/overview` }); res.end(); }
        else if (req.url === '/api/sse') { res.setHeader('Content-Type', 'text/event-stream'); res.end('data: first\n\ndata: second\n\n'); }
        else if (req.url === '/api/echo') { req.pipe(res); }
        else if (req.url === '/asset.js') { res.setHeader('Content-Type', 'text/javascript'); res.end('import "/module.js"; export { x } from "/other.js";'); }
        else if (req.url === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end('body{background:url(/icon.png)}'); }
        else { res.setHeader('Content-Type', 'text/html'); res.setHeader('Content-Encoding', 'gzip'); res.end(gzipSync(`<html><head><script src="/asset.js"></script></head><body>service-${i}</body></html>`)); }
      });
      server.on('upgrade', (req, socket, head) => { const ws = acceptWebSocketUpgrade(req, socket, head); if (ws) ws.on('message', data => ws._writeFrame(2, Buffer.from(data))); });
      server.on('connection', socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
      await new Promise(r => server.listen(0, '127.0.0.1', r)); servers.push(server);
    }
    const gatewayPort = await cloud.listen(), base = `http://127.0.0.1:${gatewayPort}`;
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'fixture-password', totpCode: generateTotpCode('JBSWY3DPEHPK3PXP') }) });
    const cookie = login.headers.get('set-cookie').split(';')[0], headers = { Cookie: cookie, Origin: base };
    for (let i = 0; i < 2; i++) {
      const agent = startLocalAgent({ relayUrl: `ws://127.0.0.1:${gatewayPort}/ws/agent`, codexHome: path.join(dir, 'agent-' + i),
        codexEnabled: false, dshEnabled: false, opencodeEnabled: false, desktopEnabled: false, localWebEnabled: i === 0, quiet: true });
      agents.push(agent); await until(() => cloud.agents.has(agent.identity.agentId));
    }
    const id = agents[0].identity.agentId;
    const trust = (agentId, trusted) => fetch(base + '/api/agents/trust', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId, trusted }) });
    const targetPorts = servers.map(s => s.address().port);
    const prefix = `/local/${id}/${targetPorts[0]}/`, url = base + prefix;
    assert.equal((await fetch(url)).status, 401);
    const redirect = await fetch(url, { redirect: 'manual', headers: { Accept: 'text/html' } });
    assert.equal(redirect.status, 302); assert.match(redirect.headers.get('location'), /^\/\?next=/);
    assert.equal((await fetch(url, { headers })).status, 403);
    await assert.rejects(connectWebSocketClient(url.replace('http:', 'ws:') + 'ws'), /401/);
    await trust(id, true); await trust(agents[1].identity.agentId, true);
    assert.equal((await fetch(base + `/local/${agents[1].identity.agentId}/${targetPorts[0]}/`, { headers })).status, 503);
    for (const bad of ['0', '65536', '-1', '9090@evil.test', '127.0.0.2:9090']) assert.equal((await fetch(base + `/local/${id}/${bad}/`, { headers })).status, 404);
    assert.equal((await fetch(url, { headers: { ...headers, Origin: 'https://evil.test' } })).status, 403);
    await assert.rejects(connectWebSocketClient(url.replace('http:', 'ws:') + 'ws', { headers: { ...headers, Origin: 'https://evil.test' } }), /403/);
    for (let i = 0; i < servers.length; i++) {
      const mount = `/local/${id}/${targetPorts[i]}/`;
      const html = await (await fetch(base + mount + 'ui/', { headers })).text();
      assert.ok(html.includes(`src="${mount}.codex-proxy.js"`));
      assert.ok(html.includes(`src="${mount}asset.js"`)); assert.ok(html.includes('service-' + i));
      assert.ok((await (await fetch(base + mount + '.codex-proxy.js', { headers })).text()).includes(id));
    }
    assert.match(await (await fetch(url + 'asset.js', { headers })).text(), new RegExp(prefix + 'module.js'));
    assert.ok((await (await fetch(url + 'style.css', { headers })).text()).includes(prefix + 'icon.png'));
    assert.equal((await fetch(url + 'api/redirect', { headers, redirect: 'manual' })).headers.get('location'), prefix + 'ui/#/overview');
    const cookies = (await fetch(url + 'api/cookie', { headers })).headers.getSetCookie();
    const name = localCookiePrefix(id, targetPorts[0]);
    assert.ok(cookies[0].startsWith(name + 'session=')); assert.ok(cookies[0].includes('Path=' + prefix));
    const upstream = await (await fetch(url + 'api/headers', { headers: { ...headers, Authorization: 'Bearer local-secret',
      Cookie: `${cookie}; ${name}session=value; ${localCookiePrefix(id, targetPorts[1])}session=wrong-port; other=hidden` } })).json();
    assert.equal(upstream.authorization, 'Bearer local-secret'); assert.equal(upstream.cookie, 'session=value');
    assert.equal(upstream.host, `127.0.0.1:${targetPorts[0]}`); assert.doesNotMatch(JSON.stringify(upstream), /codex_remote_session/);
    const upload = Buffer.alloc(200000, 47);
    assert.deepEqual(Buffer.from(await (await fetch(url + 'api/echo', { method: 'POST', headers, body: upload })).arrayBuffer()), upload);
    assert.equal(await (await fetch(url + 'api/sse', { headers })).text(), 'data: first\n\ndata: second\n\n');
    const ws = await connectWebSocketClient(url.replace('http:', 'ws:') + 'ws', { headers: { ...headers, Cookie: cookie + `; ${name}session=value` } }); sockets.push(ws);
    const echoed = new Promise(r => ws.once('message', r)); ws._writeFrame(2, upload); assert.deepEqual(await echoed, upload);
    const closed = new Promise(r => ws.once('close', r));
    await fetch(base + '/api/auth/logout', { method: 'POST', headers }); await closed;
    const ws2 = await connectWebSocketClient(url.replace('http:', 'ws:') + 'ws', { headers }); sockets.push(ws2);
    const revoked = new Promise(r => ws2.once('close', r)); await trust(id, false); await revoked;
    assert.equal((await fetch(url, { headers })).status, 403);
  } finally {
    sockets.forEach(s => s.close()); agents.forEach(a => a.stop()); await cloud.close();
    connections.forEach(socket => socket.destroy());
    await Promise.all(servers.map(s => new Promise(r => s.close(r)))); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('browser URL mapping retains mount paths, routes absolute loopback ports and preserves fetch requests', async () => {
  const calls = [], storage = new Map([['codex_e2e_key_agent', 'gateway-only']]);
  const nativeStorage = { get length() { return storage.size; }, key: i => [...storage.keys()][i], getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) };
  class Dummy { setAttribute() {} }
  class Document {}
  const context = vm.createContext({ URL, Request, Document, Element: Dummy,
    HTMLAnchorElement: Dummy, HTMLScriptElement: Dummy, HTMLLinkElement: Dummy, HTMLImageElement: Dummy, HTMLFormElement: Dummy,
    XMLHttpRequest: class { open(...args) { calls.push(args); } },
    location: new URL('https://gateway.test/local/agent/9090/ui/#/overview'),
    document: { addEventListener() {} }, navigator: { serviceWorker: {} }, history: { pushState() {}, replaceState() {} },
    window: { Request, fetch: (...args) => { calls.push(args); return Promise.resolve(); }, WebSocket: class { constructor(...args) { calls.push(args); } }, EventSource: class { constructor(...args) { calls.push(args); } }, localStorage: nativeStorage, sessionStorage: nativeStorage },
  });
  vm.runInContext(localWebScript('agent', 9090), context);
  await context.window.fetch('/version'); assert.equal(calls.pop()[0], 'https://gateway.test/local/agent/9090/version');
  await context.window.fetch('/local/agent/9090/ui/config.js'); assert.equal(calls.pop()[0], 'https://gateway.test/local/agent/9090/ui/config.js');
  await context.window.fetch('http://127.0.0.1:8080/api'); assert.equal(calls.pop()[0], 'https://gateway.test/local/agent/8080/api');
  await context.window.fetch('https://external.test/api'); assert.equal(calls.pop()[0], 'https://external.test/api');
  await context.window.fetch(new Request('http://127.0.0.1:9090/post', { method: 'POST', body: 'payload' }));
  const request = calls.pop()[0]; assert.equal(request.url, 'https://gateway.test/local/agent/9090/post'); assert.equal(await request.text(), 'payload');
  new context.window.WebSocket('ws://localhost:9090/traffic'); assert.equal(calls.pop()[0], 'wss://gateway.test/local/agent/9090/traffic');
  assert.equal(context.window.localStorage.getItem('codex_e2e_key_agent'), null);
  context.window.localStorage.setItem('backend', 'saved'); assert.equal(storage.get('codex_local:agent:9090:backend'), 'saved');
  assert.equal((await context.navigator.serviceWorker.getRegistrations()).length, 0);
});
