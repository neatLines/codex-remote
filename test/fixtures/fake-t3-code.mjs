#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { acceptWebSocketUpgrade } from '../../src/ws-minimal.mjs';

const [command, ...args] = process.argv.slice(2);
const pairingFile = 't3-pairing.fixture';
let cookie;

if (command === 'auth' && args[0] === 'pairing' && args[1] === 'create') {
  const token = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(pairingFile, token);
  console.log(JSON.stringify({ token }));
} else if (command === 'serve') {
  const port = Number(args[args.indexOf('--port') + 1]);
  fs.writeFileSync('t3-pid.fixture', String(process.pid));
  const validSession = req => Boolean(cookie && req.headers.cookie === cookie);
  const server = http.createServer(async (req, res) => {
    if (req.url === '/.well-known/t3/environment') {
      res.end(JSON.stringify({ environmentId: 'test-environment' }));
      return;
    }
    if (req.url === '/api/auth/session') {
      res.end(JSON.stringify({ authenticated: validSession(req) }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/auth/browser-session') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const { credential } = JSON.parse(Buffer.concat(chunks).toString());
      if (!fs.existsSync(pairingFile) || credential !== fs.readFileSync(pairingFile, 'utf8')) {
        res.writeHead(401).end();
        return;
      }
      fs.unlinkSync(pairingFile);
      cookie = 't3-session=private-fixture-session';
      res.writeHead(200, { 'Set-Cookie': cookie + '; Path=/; HttpOnly' }).end('{}');
      return;
    }
    if (!validSession(req)) {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Set-Cookie': cookie + '; Path=/; HttpOnly',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
    });
    res.end('<html><head></head><body>T3 fixture workspace</body></html>');
  });
  server.on('upgrade', (req, socket, head) => {
    if (!validSession(req)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    const ws = acceptWebSocketUpgrade(req, socket, head);
    ws?.on('message', message => ws.send(message));
  });
  server.listen(port, '127.0.0.1');
} else {
  process.exitCode = 2;
}
