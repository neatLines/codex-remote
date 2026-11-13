import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

const gateway = process.argv[2] === 'gateway';
const options = gateway ? {
  hostname: '127.0.0.1', port: Number(process.env.CODEX_CLOUD_PORT), path: '/api/auth/status',
  ca: fs.readFileSync(process.env.CODEX_HEALTH_CA_FILE),
  checkServerIdentity: (_, cert) => tls.checkServerIdentity(new URL(process.env.CODEX_PUBLIC_ORIGIN).hostname, cert),
} : { hostname: '127.0.0.1', port: 3090, path: '/health' };
const req = (gateway ? https : http).get(options, (res) => {
  res.resume();
  res.on('end', () => process.exit(res.statusCode === 200 ? 0 : 1));
});
req.setTimeout(4000, () => req.destroy(new Error('Health check timed out')));
req.on('error', () => process.exit(1));
