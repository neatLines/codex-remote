import { createCloudServer } from '../../src/cloud-server.mjs';

process.umask(0o077);
const cloud = createCloudServer();
await cloud.listen();
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 15_000);
  deadline.unref();
  await cloud.close();
  clearTimeout(deadline);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
