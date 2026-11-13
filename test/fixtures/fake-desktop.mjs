#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { acceptWebSocketUpgrade } from '../../src/ws-minimal.mjs';

const args = process.argv.slice(2);
const value = (key) => args[args.indexOf(key) + 1];
if (args.includes('--unix-socket')) {
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.write('RFB 003.008\n');
    socket.on('data', (data) => socket.write(data));
  });
  server.listen(args.at(-1));
} else {
  const root = value('--web');
  const server = http.createServer((req, res) => {
    const name = req.url === '/' ? 'index.html' : req.url.slice(1);
    if (!['index.html', 'vnc.html'].includes(name)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(fs.readFileSync(path.join(root, name)));
  });
  server.on('upgrade', (req, socket, head) => {
    const ws = acceptWebSocketUpgrade(req, socket, head);
    if (!ws) return;
    const target = net.connect(value('--unix-target'));
    target.on('data', (data) => ws._writeFrame(0x2, data));
    target.on('error', () => ws.close());
    target.on('close', () => ws.close());
    ws.on('message', (data) => target.write(data));
    ws.on('error', () => target.destroy());
    ws.on('close', () => target.destroy());
  });
  server.listen(value('--unix-listen'), () => fs.chmodSync(value('--unix-listen'), 0o600));
}
