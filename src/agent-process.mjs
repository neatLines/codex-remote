import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Older foreground Agents predate the launcher lock. Wait for them without
// stopping a model turn or opening a second relay connection for the same ID.
export function otherAgentPids(codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  if (process.platform !== 'linux') return [];
  const result = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const root = `/proc/${entry}`;
      if (fs.statSync(root).uid !== process.getuid()) continue;
      const args = fs.readFileSync(`${root}/cmdline`, 'utf8').split('\0');
      if (args.includes('--upload') || args.includes('--show-pairing-key')) continue;
      const script = args.find((arg) => /(?:^|\/)src\/local-agent\.mjs$/.test(arg));
      if (!script) continue;
      const cwd = fs.readlinkSync(`${root}/cwd`);
      const source = path.resolve(cwd, script);
      const packageFile = path.join(path.dirname(source), '..', 'package.json');
      if (JSON.parse(fs.readFileSync(packageFile, 'utf8')).name !== 'codex-remote') continue;
      const raw = fs.readFileSync(`${root}/environ`, 'utf8').split('\0');
      const value = (name) => raw.find((part) => part.startsWith(name + '='))?.slice(name.length + 1);
      const home = value('CODEX_HOME') || path.join(value('HOME') || os.homedir(), '.codex');
      if (path.resolve(cwd, home) === path.resolve(codexHome)) result.push(Number(entry));
    } catch { /* A process may exit while /proc is being inspected. */ }
  }
  return result;
}

export async function waitForPreviousAgent({ wait = false, codexHome } = {}) {
  let announced = false;
  const stop = () => process.exit(0);
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    while (true) {
      const pids = otherAgentPids(codexHome);
      if (!pids.length) return;
      if (!wait) throw new Error('已有 codex-up Agent 正在运行；请使用 systemctl --user 管理服务，或先停止前台进程');
      if (!announced) { console.log('检测到前台 Agent，等待其退出后自动接管。PID: ' + pids.join(', ')); announced = true; }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
}
