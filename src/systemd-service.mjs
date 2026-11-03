import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SERVICE_NAME = 'codex-up.service';
const MARKER = '# Managed by codex-up; reinstall with codex-up service install.';
const PROJECT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVICE_ENV_KEYS = ['PATH', 'CODEX_HOME', 'CODEX_BIN', 'CODEX_PROFILE', 'CODEX_AGENT_NAME',
  'CODEX_RELAY_URL', 'CODEX_RELAY_CA_FILE', 'CODEX_DSH_ENABLED', 'CODEX_DSH_BIN', 'CODEX_DSH_CWD', 'CODEX_DSH_PORT',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'];

function clean(value) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw new Error('服务配置不能包含控制字符');
  return value;
}
export function unitQuote(value, executable = false) {
  return '"' + clean(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')
    .replace(/\$/g, executable ? '$$$$' : '$') + '"';
}
function envQuote(value) { return '"' + clean(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }

export function buildUserService({ project = PROJECT, cwd = process.cwd(), configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  node = process.execPath, env = process.env, args = [] } = {}) {
  if (![project, cwd, configHome, node].every((value) => path.isAbsolute(clean(value)))) throw new Error('服务配置路径必须是绝对路径');
  const unitDir = path.join(configHome, 'systemd', 'user');
  const environmentPath = path.join(configHome, 'codex-remote', 'service.env');
  const exec = ['/usr/bin/bash', path.join(project, 'bin', 'codex-up'), '--service-run', ...args].map((value) => unitQuote(value, true)).join(' ');
  const environment = [MARKER, ...SERVICE_ENV_KEYS.filter((key) => env[key] !== undefined)
    .map((key) => `${key}=${envQuote(env[key])}`), `CODEX_SERVICE_NODE=${envQuote(node)}`, ''].join('\n');
  // Path directives are raw strings, unlike the argument list in ExecStart.
  // A final '/.' also preserves directory names ending in whitespace or '\\'.
  const workingDirectory = clean(cwd).replace(/%/g, '%%').replace(/\/$/, '') + '/.';
  const unit = `${MARKER}\n[Unit]\nDescription=Codex Remote local agent\nStartLimitIntervalSec=0\n\n[Service]\nType=exec\nWorkingDirectory=${workingDirectory}\nEnvironmentFile=${clean(environmentPath).replace(/%/g, '%%')}\nExecStart=${exec}\nRestart=always\nRestartSec=5\nTimeoutStopSec=20\nKillMode=control-group\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
  return { unit, environment, unitPath: path.join(unitDir, SERVICE_NAME), environmentPath };
}

function atomicWrite(target, contents, mode) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try { fs.writeFileSync(temporary, contents, { flag: 'wx', mode }); fs.renameSync(temporary, target); }
  finally { try { fs.unlinkSync(temporary); } catch {} }
}
function invoke(command, args, { quiet = false, allowFailure = false } = {}) {
  const result = spawnSync(command, args, { stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8', timeout: 30000 });
  if (result.error || result.status !== 0) {
    if (allowFailure) return result;
    throw new Error(`${command} 执行失败${result.error?.code ? ` (${result.error.code})` : ` (${result.status})`}，请确认 systemd 用户会话可用`);
  }
  return result;
}
function requireManaged(target) {
  if (fs.existsSync(target) && !fs.readFileSync(target, 'utf8').startsWith(MARKER)) {
    throw new Error('目标位置已有非 codex-up 生成的配置，未覆盖：' + target);
  }
}
function parseInstallArgs(args) {
  let cwd = process.cwd(), start = true;
  const agentArgs = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--no-start') start = false;
    else if (['--cwd', '--profile', '-p', '--relay', '--name'].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('服务安装参数缺少值');
      clean(value);
      if (arg === '--cwd') cwd = path.resolve(value);
      else agentArgs.push(arg, value);
    } else if (['--no-dsh', '--dsh', '--no-e2e'].includes(arg)) agentArgs.push(arg);
    else throw new Error('不支持的服务安装参数');
  }
  if (!fs.statSync(cwd).isDirectory()) throw new Error('服务工作目录不存在');
  return { cwd, start, agentArgs };
}

export function manageService(args = process.argv.slice(2)) {
  const [action, ...options] = args;
  if (!action || action === '--help' || action === 'help') {
    console.log('用法：codex-up service install [--cwd 目录] [--profile 名称] [--no-start]\n' +
      '      codex-up service start|stop|restart|status|logs|uninstall\n' +
      '对应 systemctl --user 管理的 codex-up.service；install 默认启用开机自启并启动服务。');
    return 0;
  }
  if (process.platform !== 'linux') throw new Error('systemd 服务管理仅支持 Linux');
  const config = buildUserService();
  if (action === 'install') {
    const parsed = parseInstallArgs(options);
    const generated = buildUserService({ cwd: parsed.cwd, args: parsed.agentArgs });
    requireManaged(generated.unitPath); requireManaged(generated.environmentPath);
    invoke('systemctl', ['--user', 'show-environment'], { quiet: true });
    invoke('flock', ['--version'], { quiet: true });
    atomicWrite(generated.environmentPath, generated.environment, 0o600);
    atomicWrite(generated.unitPath, generated.unit, 0o644);
    invoke('systemd-analyze', ['--user', 'verify', generated.unitPath], { quiet: true });
    invoke('systemctl', ['--user', 'daemon-reload']);
    invoke('systemctl', ['--user', 'enable', SERVICE_NAME]);
    const username = os.userInfo().username;
    let linger = invoke('loginctl', ['--no-ask-password', 'enable-linger', username], { quiet: true, allowFailure: true });
    if (linger.error || linger.status !== 0) {
      linger = invoke('sudo', ['-n', 'loginctl', 'enable-linger', username], { quiet: true, allowFailure: true });
    }
    if (parsed.start) invoke('systemctl', ['--user', 'start', SERVICE_NAME]);
    console.log('已安装并启用 codex-up.service；配置读取项目 .env，代理与命令路径已保存到仅当前用户可读的 service.env。');
    console.log('如已有前台 Agent，服务将等待其退出后自动接管。查看状态：systemctl --user status codex-up');
    if (linger.error || linger.status !== 0) {
      console.error('用户服务已启用，但开机前启动仍需管理员执行：sudo loginctl enable-linger ' + username);
      return 1;
    }
    console.log('已启用用户驻留：开机可启动，退出登录后继续运行。');
    return 0;
  }
  if (options.length) throw new Error('该服务命令不接受额外参数');
  if (['start', 'stop', 'restart', 'status'].includes(action)) {
    const result = invoke('systemctl', ['--user', action, SERVICE_NAME, ...(action === 'status' ? ['--no-pager'] : [])], { allowFailure: true });
    if (result.error) throw new Error('无法执行 systemctl，请确认 systemd 用户会话可用');
    return result.status ?? 1;
  }
  if (action === 'logs') {
    const result = spawnSync('journalctl', ['--user', '-u', SERVICE_NAME, '-f', '-n', '50'], { stdio: 'inherit' });
    return result.status ?? (result.signal === 'SIGINT' ? 0 : 1);
  }
  if (action === 'uninstall') {
    requireManaged(config.unitPath); requireManaged(config.environmentPath);
    invoke('systemctl', ['--user', 'disable', '--now', SERVICE_NAME]);
    fs.rmSync(config.unitPath, { force: true }); fs.rmSync(config.environmentPath, { force: true });
    invoke('systemctl', ['--user', 'daemon-reload']);
    console.log('已卸载 codex-up 用户服务。');
    return 0;
  }
  throw new Error('未知服务命令；使用 codex-up service --help 查看用法');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = manageService(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
