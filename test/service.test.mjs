import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildUserService } from '../src/systemd-service.mjs';
import { otherAgentPids, waitForPreviousAgent } from '../src/agent-process.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const manager = path.join(root, 'src/systemd-service.mjs');
async function until(predicate) {
  const limit = Date.now() + 5000;
  while (Date.now() < limit) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error('Service fixture timed out');
}

test('systemd units safely quote paths and arguments and keep proxy values and API credentials out of the unit', () => {
  const secret = crypto.randomBytes(24).toString('hex');
  const config = buildUserService({ project: '/workspace/path with space/%x/$USER/"quote"', cwd: '/workspace/a b',
    configHome: '/config/a b', node: '/opt/node/bin/node', args: ['--name', 'a "$NAME" %n'],
    env: { PATH: '/opt/node/bin:/usr/bin', https_proxy: 'http://127.0.0.1:7890', OPENAI_API_KEY: secret } });
  assert.match(config.unit, /%%x\/\$\$USER/);
  assert.match(config.unit, /\\"\$\$NAME\\" %%n/);
  assert.match(config.unit, /WorkingDirectory=\/workspace\/a b\/\./);
  assert.match(config.unit, /EnvironmentFile=\/config\/a b\/codex-remote\/service.env/);
  assert.match(config.unit, /Restart=always/);
  assert.match(config.unit, /KillMode=control-group/);
  assert.doesNotMatch(config.unit, /127\.0\.0\.1|OPENAI_API_KEY/);
  assert.doesNotMatch(config.environment, new RegExp(secret));
  assert.match(config.environment, /https_proxy="http:\/\/127\.0\.0\.1:7890"/);
  assert.match(config.environment, /CODEX_SERVICE_NODE="\/opt\/node\/bin\/node"/);
  assert.throws(() => buildUserService({ args: ['bad\nExecStart=unsafe'] }), /控制字符/);
  assert.throws(() => buildUserService({ configHome: 'relative/config' }), /绝对路径/);
});

test('generated unit passes the real systemd verifier with spaces and specifier characters in paths', { skip: process.platform !== 'linux' || !process.env.XDG_RUNTIME_DIR }, (context) => {
  const available = spawnSync('systemd-analyze', ['--version']);
  if (available.error) { context.skip('systemd-analyze is unavailable'); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-unit-verify-'));
  try {
    const cwd = path.join(directory, 'workspace %x $USER "quoted" ');
    const project = path.join(directory, 'project %n $USER');
    const configHome = path.join(directory, 'config %n space');
    fs.mkdirSync(cwd); fs.mkdirSync(path.join(project, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(project, 'bin/codex-up'), '#!/bin/bash\nexit 0\n');
    const generated = buildUserService({ project, cwd, configHome, args: ['--name', 'unit %n "$NAME"'], env: { PATH: process.env.PATH } });
    fs.mkdirSync(path.dirname(generated.unitPath), { recursive: true });
    fs.mkdirSync(path.dirname(generated.environmentPath), { recursive: true });
    fs.writeFileSync(generated.unitPath, generated.unit); fs.writeFileSync(generated.environmentPath, generated.environment);
    const verified = spawnSync('systemd-analyze', ['--user', 'verify', generated.unitPath], { encoding: 'utf8' });
    assert.equal(verified.status, 0, verified.stderr);
    assert.doesNotMatch(verified.stderr, /path is not absolute|ignoring/i);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('service install enables startup and linger; uninstall only removes generated service configuration', { skip: process.platform !== 'linux' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-service-test-'));
  const configHome = path.join(directory, 'config'), commands = path.join(directory, 'bin'), log = path.join(directory, 'calls.jsonl');
  fs.mkdirSync(commands);
  for (const name of ['systemctl', 'systemd-analyze', 'loginctl', 'sudo']) {
    const source = '#!' + process.execPath + '\n' +
      `require('node:fs').appendFileSync(process.env.SERVICE_TEST_LOG,JSON.stringify({command:${JSON.stringify(name)},args:process.argv.slice(2)})+'\\n');\n` +
      `if(${JSON.stringify(name)}==='systemctl'&&process.argv.includes('status'))process.exit(3);\n`;
    fs.writeFileSync(path.join(commands, name), source, { mode: 0o755 });
  }
  const env = { ...process.env, XDG_CONFIG_HOME: configHome, PATH: commands + ':' + process.env.PATH,
    SERVICE_TEST_LOG: log, https_proxy: 'http://127.0.0.1:7890' };
  const run = (...args) => spawnSync(process.execPath, [manager, ...args], { cwd: directory, env, encoding: 'utf8' });
  try {
    const installed = run('install', '--profile', 'test-profile');
    assert.equal(installed.status, 0, installed.stderr);
    const unit = path.join(configHome, 'systemd/user/codex-up.service');
    const environment = path.join(configHome, 'codex-remote/service.env');
    assert.match(fs.readFileSync(unit, 'utf8'), /--profile" "test-profile/);
    assert.equal(fs.statSync(environment).mode & 0o777, 0o600);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(calls.some((call) => call.command === 'systemctl' && call.args.includes('enable')));
    assert.ok(calls.some((call) => call.command === 'systemctl' && call.args.includes('start')));
    assert.ok(calls.some((call) => call.command === 'loginctl' && call.args.includes('enable-linger')));
    assert.equal(run('status').status, 3);
    const previousCalls = calls.length;
    assert.equal(run('install', '--no-start').status, 0);
    const additional = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).slice(previousCalls);
    assert.equal(additional.some((call) => call.command === 'systemctl' && call.args.includes('start')), false);
    const invalid = run('install', '--upload', '/private/file');
    assert.equal(invalid.status, 1);
    assert.equal(run('uninstall').status, 0);
    assert.equal(fs.existsSync(unit), false); assert.equal(fs.existsSync(environment), false);
    fs.writeFileSync(unit, '[Service]\nExecStart=/unrelated/service\n');
    assert.equal(run('install').status, 1);
    assert.match(fs.readFileSync(unit, 'utf8'), /unrelated\/service/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('launcher prevents duplicate Agents, permits one-off commands and hands its lock to a waiting service', { skip: process.platform !== 'linux' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-lock-test-'));
  const project = path.join(directory, 'project'), codexHome = path.join(directory, 'codex'), ready = path.join(directory, 'ready');
  fs.mkdirSync(path.join(project, 'bin'), { recursive: true }); fs.mkdirSync(path.join(project, 'src'));
  fs.copyFileSync(path.join(root, 'bin/codex-up'), path.join(project, 'bin/codex-up'));
  fs.writeFileSync(path.join(project, 'src/local-agent.mjs'), `import fs from 'node:fs';
if(process.argv.includes('--upload')){console.log('one-off');process.exit(0);}
fs.appendFileSync(process.env.SERVICE_TEST_READY,process.pid+'\\n');
process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);
`);
  const env = { ...process.env, CODEX_HOME: codexHome, SERVICE_TEST_READY: ready };
  const launch = (...args) => spawn('/bin/bash', [path.join(project, 'bin/codex-up'), ...args], { env, stdio: 'pipe' });
  let first, service;
  try {
    first = launch(); await until(() => fs.existsSync(ready));
    const duplicate = spawnSync('/bin/bash', [path.join(project, 'bin/codex-up')], { env, encoding: 'utf8' });
    assert.equal(duplicate.status, 75); assert.match(duplicate.stderr, /已经|已有/);
    const oneOff = spawnSync('/bin/bash', [path.join(project, 'bin/codex-up'), '--upload', 'fixture'], { env, encoding: 'utf8' });
    assert.equal(oneOff.status, 0); assert.match(oneOff.stdout, /one-off/);
    service = launch('--service-run');
    let output = ''; service.stdout.on('data', (chunk) => { output += chunk; });
    await until(() => output.includes('等待'));
    assert.equal(fs.readFileSync(ready, 'utf8').trim().split('\n').length, 1);
    const exited = once(first, 'exit'); first.kill('SIGTERM'); await exited;
    await until(() => fs.readFileSync(ready, 'utf8').trim().split('\n').length === 2);
    const done = once(service, 'exit'); service.kill('SIGTERM'); await done;
  } finally {
    first?.kill('SIGKILL'); service?.kill('SIGKILL'); fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy process discovery is scoped to the same Codex identity and never terminates that process', { skip: process.platform !== 'linux' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-legacy-agent-test-'));
  const project = path.join(directory, 'project'), codexHome = path.join(directory, 'codex');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'codex-remote', type: 'module' }));
  const source = path.join(project, 'src/local-agent.mjs');
  fs.writeFileSync(source, 'setInterval(()=>{},1000);');
  const child = spawn(process.execPath, [source], { env: { ...process.env, CODEX_HOME: codexHome } });
  try {
    await until(() => otherAgentPids(codexHome).includes(child.pid));
    assert.equal(otherAgentPids(path.join(directory, 'another-home')).includes(child.pid), false);
    await assert.rejects(waitForPreviousAgent({ codexHome }), /已有 codex-up Agent/);
    assert.doesNotThrow(() => process.kill(child.pid, 0));
  } finally { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; fs.rmSync(directory, { recursive: true, force: true }); }
});
