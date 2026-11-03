#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import { acceptWebSocketUpgrade } from '../../src/ws-minimal.mjs';

const args = process.argv.slice(2);
const authorization = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`;
const device = path.basename(process.cwd());
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== authorization) { res.writeHead(401); res.end(); return; }
  if (req.url === '/api/info') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ version: '2.0.32', pid: process.pid })); return; }
  if (req.url === '/api/device') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ device, cookieForwarded: Boolean(req.headers.cookie), authorizationMatched: true })); return;
  }
  if (req.url === '/api/events') {
    res.setHeader('Content-Type', 'text/event-stream'); res.write(`data: ${device}\n\n`);
    setTimeout(() => res.end('data: done\n\n'), 20); return;
  }
  if (req.url === '/api/echo') { req.pipe(res); return; }
  if (req.url === '/_assets/index.js') {
    res.setHeader('Content-Type', 'application/javascript');
    res.end('function origin(){return location.origin};const a={currentServerUrl:origin()};const b={get component(){return e.router??R},root:t};navigator.serviceWorker.register(`/sw.js`);const asset=`/_assets/sprite.svg`;' + '/* web asset */'.repeat(150)); return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end('<html><head><script type="module" src="/_assets/index.js"></script></head><body>OpenCode fixture</body></html>');
});
server.on('upgrade', (req, socket, head) => {
  if (req.headers.authorization !== authorization) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
  const ws = acceptWebSocketUpgrade(req, socket, head);
  ws.on('message', (data) => ws.send(device + ':' + data));
});
server.listen(Number(args[args.indexOf('--port') + 1]), '127.0.0.1');
