import http from 'node:http';
import { startLocalAgent } from '../../src/local-agent.mjs';

process.umask(0o077);
const agent = startLocalAgent({ codexEnabled: false, dshEnabled: false, opencodeEnabled: true });
const health = http.createServer((req, res) => {
  if (req.url !== '/health') { res.writeHead(404).end(); return; }
  const status = { connected: agent.connected, opencode: agent.opencodeStatus.status };
  res.writeHead(status.connected && status.opencode === 'ready' ? 200 : 503,
    { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(status));
});
health.listen(3090, '127.0.0.1');
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  health.close();
  agent.stop();
  // Let the child flush its database; Docker's init reaps any remaining descendants.
  setTimeout(() => process.exit(1), 15_000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
