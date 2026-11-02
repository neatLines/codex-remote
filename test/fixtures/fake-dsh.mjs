#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { acceptWebSocketUpgrade } from '../../src/ws-minimal.mjs';
const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
const port = Number(arg('--port'));
const token = crypto.randomBytes(20).toString('hex');
const cookie = `dsh_browser=${crypto.randomBytes(20).toString('hex')}`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  if (url.pathname === '/' && url.searchParams.get('token') === token) {
    res.writeHead(303, { 'Set-Cookie': `${cookie}; Path=/; HttpOnly; SameSite=Strict`, Location: './' }); res.end(); return;
  }
  if (req.headers.cookie !== cookie) { res.writeHead(401); res.end('DSH auth required'); return; }
  if (url.pathname === '/api/echo') { req.pipe(res); return; }
  if (url.pathname === '/api/large') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(Buffer.alloc(350000, 137)); return; }
  if (url.pathname === '/api/headers') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.headers)); return; }
  if (url.pathname === '/api/redirect') { res.writeHead(302, { Location: '/' }); res.end(); return; }
  if (url.pathname === '/api/sse') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: first\n\n');
    setTimeout(() => res.end('data: second\n\n'), 30); return;
  }
  if (url.pathname === '/assets/app.js') { res.setHeader('Content-Type', 'application/javascript'); res.end('window.dshLoaded = true'); return; }
  res.setHeader('Content-Type', 'text/html'); res.end('<html><body><h1>DSH fixture</h1><script src="./assets/app.js"></script></body></html>');
});
server.on('upgrade', (req, socket, head) => {
  if (req.headers.cookie !== cookie) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
  const ws = acceptWebSocketUpgrade(req, socket, head);
  ws.on('message', (data) => { if (Buffer.isBuffer(data)) ws._writeFrame(2, data); else ws.send(data); });
});
server.listen(port, '127.0.0.1', () => {
  fs.writeFileSync(path.join(process.cwd(), 'fake-dsh.pid'), String(process.pid));
  const publicUrl = new URL(arg('--public-url') || `http://127.0.0.1:${port}/`);
  publicUrl.searchParams.set('token', token);
  console.log(`dsh web: ${publicUrl}`);
});
