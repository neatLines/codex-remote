import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectRelayTransport } from './relay-transport.mjs';
import { startManagedDsh } from './dsh-web.mjs';
import { clearUploadCredentials, registrationUploadToken, saveUploadCredentials, uploadAgentFile } from './file-upload.mjs';
import { waitForPreviousAgent } from './agent-process.mjs';
import { startManagedOpenCode, openCodeRewriter } from './opencode-web.mjs';
import { startManagedT3Code } from './t3-code-web.mjs';
import { createLocalAgentBridge, localWebRewriter } from './local-web.mjs';
import { readWebServices, normalizeWebServices } from './web-services.mjs';

/**
 * Load or create persistent local agent identity.
 * @param {string} codexHome
 */
export function loadOrCreateAgentIdentity(codexHome = path.join(os.homedir(), '.codex')) {
  fs.mkdirSync(codexHome, { recursive: true });
  const idFile = path.join(codexHome, 'remote-agent-identity.json');
  let data = {};
  if (fs.existsSync(idFile)) {
    try {
      data = JSON.parse(fs.readFileSync(idFile, 'utf8'));
    } catch {
      data = {};
    }
  }

  let dirty = false;
  if (!data.agentId) {
    data.agentId = `agent_${os.hostname().replace(/[^a-zA-Z0-9_-]/g, '')}_${crypto.randomBytes(4).toString('hex')}`;
    dirty = true;
  }

  if (dirty) {
    fs.writeFileSync(idFile, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  return {
    idFile,
    agentId: data.agentId,
  };
}

/**
 * Start the local Agent bridge and connect to the Cloud Relay.
 * @param {{
 *   relayUrl?: string,
 *   relayCaFile?: string,
 *   relayTransport?: 'auto' | 'poll' | 'websocket',
 *   localWebEnabled?: boolean,
 *   webServices?: Array<object>,
 *   webServicesFile?: string,
 *   t3CodeBin?: string,
 *   dshBin?: string,
 *   dshCwd?: string,
 *   opencodeBin?: string,
 *   opencodeCwd?: string,
 *   codexHome?: string,
 *   agentName?: string,
 *   defaultCwd?: string,
 *   quiet?: boolean
 * }} [options]
 */
export function startLocalAgent(options = {}) {
  const servicesFile = options.webServicesFile ?? (!options.codexHome ? process.env.CODEX_WEB_SERVICES_FILE : undefined);
  let services = options.webServices !== undefined
    ? normalizeWebServices(options.webServices)
    : servicesFile ? readWebServices(servicesFile) : undefined;
  const serviceOf = kind => services?.find(service => service.kind === kind);
  const localWebEnabled = services
    ? services.length > 0
    : (options.localWebEnabled ?? (process.env.CODEX_LOCAL_WEB_ENABLED !== '0'));
  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const relayUrl =
    options.relayUrl || process.env.CODEX_RELAY_URL || 'ws://127.0.0.1:3280/ws/agent';
  const relayCaFile = options.relayCaFile || (!options.codexHome ? process.env.CODEX_RELAY_CA_FILE : undefined);
  const relayCa = relayCaFile ? fs.readFileSync(relayCaFile) : undefined;
  const defaultCwd = options.defaultCwd || process.cwd();

  const identity = loadOrCreateAgentIdentity(codexHome);
  const agentName = options.agentName || process.env.CODEX_AGENT_NAME || os.hostname();

  let activeWs = null;
  let stopped = false;
  let reconnectTimer = null;
  let dshManager = null;
  let opencodeManager = null;
  let t3CodeManager = null;
  const httpServiceStates = new Map(), serviceProbes = new Set();

  function serviceStatus(service) {
    if (service.kind === 'dsh') return dshManager?.status.status || 'starting';
    if (service.kind === 'opencode') return opencodeManager?.status.status || 'starting';
    if (service.kind === 't3-code') return t3CodeManager?.status || 'starting';
    return httpServiceStates.get(service.port) || 'starting';
  }

  function registeredServices() {
    return services?.map(service => ({
      ...service,
      // T3 Code uses the generic relay; the Agent injects its session at the loopback hop.
      kind: service.kind === 't3-code' ? 'http' : service.kind,
      status: serviceStatus(service),
      ...(service.kind === 'dsh' && dshManager?.credentials ? {
        auth: {
          ...service.auth,
          token: dshManager.credentials.token,
          headers: { ...service.auth?.headers, cookie: dshManager.credentials.cookie },
        },
      } : {}),
      ...(service.kind === 'opencode' && opencodeManager?.credentials ? {
        auth: {
          ...service.auth,
          headers: { ...service.auth?.headers, authorization: opencodeManager.credentials.authorization },
        },
      } : {}),
    }));
  }

  const nativeServicesFile = path.join(codexHome, 'remote-native-services.json');
  function saveNativeServices() {
    if (!services) return;
    const entries = services.filter(service => service.kind !== 'http').map(service => {
      const url = new URL(`http://127.0.0.1:${service.port}/`);
      if (service.kind === 'dsh' && dshManager?.credentials) url.searchParams.set('token', dshManager.credentials.token);
      return {
        id: service.id,
        name: service.name,
        url: url.href,
        ...(service.kind === 'opencode' && opencodeManager?.credentials ? {
          username: opencodeManager.credentials.username,
          password: opencodeManager.credentials.password,
        } : {}),
        status: serviceStatus(service),
      };
    });
    const temporary = nativeServicesFile + '.' + crypto.randomBytes(6).toString('hex');
    fs.writeFileSync(temporary, JSON.stringify(entries, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, nativeServicesFile);
  }

  function publishServices() {
    if (services) {
      saveNativeServices();
      activeWs?.send({ type: 'agent/services', webServices: registeredServices() });
    }
  }

  function probeServices() {
    for (const service of services || []) {
      if (service.kind !== 'http') continue;
      const socket = net.connect({ host: '127.0.0.1', port: service.port });
      serviceProbes.add(socket);
      let settled = false;
      const finish = status => {
        if (settled) return;
        settled = true;
        socket.destroy();
        serviceProbes.delete(socket);
        if (stopped || !services.some(entry => entry.port === service.port) || httpServiceStates.get(service.port) === status) return;
        httpServiceStates.set(service.port, status);
        publishServices();
      };
      socket.setTimeout(1000, () => finish('error'));
      socket.once('connect', () => finish('ready'));
      socket.once('error', () => finish('error'));
    }
  }

  const managedSignature = list => JSON.stringify(
    list.filter(service => service.kind !== 'http').map(({ id, kind, port }) => ({ id, kind, port }))
  );
  const reloadServices = () => {
    try {
      const next = readWebServices(servicesFile);
      if (JSON.stringify(next) === JSON.stringify(services)) return;
      if (managedSignature(next) !== managedSignature(services)) {
        throw new Error('托管应用的启动配置变化，请重启 Agent');
      }
      services = next;
      publishServices();
      probeServices();
      if (!options.quiet) console.log('[web-services] Service spec reloaded');
    } catch {
      if (!options.quiet) {
        console.warn('[web-services] Spec not applied; check JSON/schema, or restart Agent after changing managed application startup settings');
      }
    }
  };
  if (servicesFile && options.webServices === undefined) {
    fs.watchFile(servicesFile, { interval: 2000, persistent: false }, reloadServices);
  }
  const serviceProbeTimer = services ? setInterval(probeServices, 5000) : null;
  serviceProbeTimer?.unref();
  if (services) probeServices();

  const localBridge = createLocalAgentBridge({
    getTarget: async (message) => {
      if (!localWebEnabled || !Number.isInteger(message.port) || message.port < 1 || message.port > 65535) {
        throw new Error('Invalid local web port');
      }
      const service = services?.find(entry => entry.port === message.port);
      if (services && !service) throw new Error('Local web service is not registered');
      const target = service?.kind === 't3-code'
        ? await t3CodeManager.target()
        : { base: `http://127.0.0.1:${message.port}` };
      return {
        ...target,
        rewriteResponse: service?.kind === 'opencode'
          ? openCodeRewriter(identity.agentId, { prefix: `/local/${identity.agentId}/${message.port}` })
          : localWebRewriter(identity.agentId, message.port),
      };
    },
  });

  const t3CodeService = serviceOf('t3-code');
  if (t3CodeService) {
    t3CodeManager = startManagedT3Code({
      bin: options.t3CodeBin || process.env.CODEX_T3_CODE_BIN || 't3',
      port: t3CodeService.port,
      cwd: defaultCwd,
      quiet: options.quiet,
      onStatus: publishServices,
      onRestart: () => localBridge.disconnect(true, t3CodeService.port),
    });
  }

  const opencodeService = serviceOf('opencode');
  if (opencodeService) {
    opencodeManager = startManagedOpenCode({
      bin: options.opencodeBin || process.env.CODEX_OPENCODE_BIN || 'opencode',
      port: opencodeService.port,
      passwordRequired: false,
      cwd: options.opencodeCwd || process.env.CODEX_OPENCODE_CWD || defaultCwd,
      quiet: options.quiet,
      onStatus: publishServices,
      onRestart: () => localBridge.disconnect(true, opencodeService.port),
    });
  }

  const dshService = serviceOf('dsh');
  if (dshService) {
    dshManager = startManagedDsh({
      bin: options.dshBin || process.env.CODEX_DSH_BIN || 'dsh',
      port: dshService.port,
      cwd: options.dshCwd || process.env.CODEX_DSH_CWD || os.homedir(),
      quiet: options.quiet,
      onStatus: publishServices,
      onRestart: () => localBridge.disconnect(true, dshService.port),
    });
  }

  async function connectLoop() {
    if (stopped) return;
    try {
      const ws = await connectRelayTransport(relayUrl, { ca: relayCa, mode: options.relayTransport });
      if (stopped) { ws.close(); return; }
      activeWs = ws;
      localBridge.attach((message) => ws.send(message));

      ws.send({
        type: 'agent/register',
        localWeb: { enabled: localWebEnabled, status: localWebEnabled ? 'ready' : 'disabled' },
        webServices: registeredServices(),
        agentId: identity.agentId,
        name: agentName,
        hostname: os.hostname(),
        platform: `${os.platform()}-${os.arch()}`,
        defaultCwd,
        fileUploads: true,
        fileUploadToken: registrationUploadToken(codexHome, relayUrl, identity.agentId),
      });

      ws.on('message', (raw) => {
        if (typeof raw !== 'string') return;
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }

        if (localBridge.handle(msg)) return;

        if (msg.type === 'relay/registered') {
          if (!msg.trusted) clearUploadCredentials(codexHome, relayUrl);
          if (!options.quiet) {
            console.log(
              `✅ Connected to Cloud Relay (${relayUrl}) | Trusted: ${
                msg.trusted ? 'YES' : 'PENDING (请在网页顶部点击【信任并绑定】)'
              }`
            );
          }
          return;
        }

        if (msg.type === 'relay/trusted') {
          if (!msg.trusted) clearUploadCredentials(codexHome, relayUrl);
          if (!options.quiet) {
            console.log(`🔒 Device trust updated: ${msg.trusted ? 'TRUSTED' : 'UNTRUSTED'}`);
          }
          return;
        }

        if (msg.type === 'relay/fileUploadCredentials') {
          try { saveUploadCredentials(codexHome, relayUrl, identity.agentId, msg); }
          catch { if (!options.quiet) console.warn('[local-agent] 无法保存文件上传凭据，请检查本机配置目录权限'); }
        }
      });

      ws.on('close', () => {
        if (activeWs === ws) {
          activeWs = null;
          localBridge.disconnect();
        }
        if (!stopped) {
          reconnectTimer = setTimeout(connectLoop, 2500);
          reconnectTimer.unref();
        }
      });

      ws.on('error', () => {
        // handled by close
      });
    } catch (err) {
      if (stopped) return;
      if (!options.quiet) {
        console.warn(`[local-agent] Relay connection failed (${err.message}), retrying in 3s...`);
      }
      if (!stopped) {
        reconnectTimer = setTimeout(connectLoop, 3000);
        reconnectTimer.unref();
      }
    }
  }

  connectLoop();

  if (!options.quiet) {
    console.log('==========================================================');
    console.log('💻 RemoteHub Local Agent Started');
    console.log(`🆔 Agent ID          : ${identity.agentId} (${agentName})`);
    console.log(`☁️  Cloud Relay URL   : ${relayUrl}`);
    console.log(`📂 Default Workspace : ${defaultCwd}`);
    console.log('==========================================================');
  }

  return {
    identity,
    get connected() { return activeWs?.readyState === 1; },
    get dshStatus() { return dshManager?.status || { enabled: false, status: 'disabled' }; },
    get opencodeStatus() { return opencodeManager?.status || { enabled: false, status: 'disabled' }; },
    stop() {
      stopped = true;
      localBridge.disconnect();
      dshManager?.stop();
      opencodeManager?.stop();
      t3CodeManager?.stop();
      clearInterval(serviceProbeTimer);
      serviceProbes.forEach(socket => socket.destroy());
      if (servicesFile) fs.unwatchFile(servicesFile, reloadServices);
      if (services) fs.rmSync(nativeServicesFile, { force: true });
      if (reconnectTimer) clearTimeout(reconnectTimer);
      return activeWs?.close();
    },
  };
}

// Run directly if invoked as main script
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('用法：codex-up [--name 设备名] [--services /path/to/services.json] [--local-web|--no-local-web]\n' +
      '      codex-up --upload 文件路径 [--name 下载名称]\n' +
      '      codex-up --show-local-services\n' +
      '      codex-up service install|start|stop|restart|status|logs|uninstall');
    process.exit(0);
  }
  let relayUrl = process.env.CODEX_RELAY_URL;
  let agentName = process.env.CODEX_AGENT_NAME;
  let localWebEnabled = process.env.CODEX_LOCAL_WEB_ENABLED !== '0';
  let webServicesFile = process.env.CODEX_WEB_SERVICES_FILE;
  let threadId;
  let uploadName;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--relay' && args[i + 1]) relayUrl = args[++i];
    else if (args[i] === '--name' && args[i + 1]) { agentName = args[++i]; uploadName = agentName; }
    else if (args[i] === '--local-web') localWebEnabled = true;
    else if (args[i] === '--no-local-web') localWebEnabled = false;
    else if (args[i] === '--services' && args[i + 1]) webServicesFile = path.resolve(args[++i]);
    else if (args[i] === '--thread-id' && args[i + 1]) threadId = args[++i];
  }

  if (args.includes('--show-local-services')) {
    const file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'remote-native-services.json');
    try {
      const list = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const service of list) {
        console.log(`${service.name} [${service.status}]: ${service.url}`);
        if (service.password) console.log(`  username: ${service.username}\n  password: ${service.password}`);
      }
    } catch {
      console.error('没有本机服务信息；请先用服务 spec 启动 Agent');
      process.exitCode = 1;
    }
    process.exit(process.exitCode || 0);
  }

  if (args.includes('--upload')) {
    const filePath = args[args.indexOf('--upload') + 1];
    try {
      if (!filePath || filePath.startsWith('--')) throw new Error('用法：codex-up --upload 文件路径 [--name 下载文件名] [--thread-id 会话ID]');
      const file = await uploadAgentFile(filePath, { relayUrl, name: uploadName, threadId });
      console.log(JSON.stringify({ ok: true, file }));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  } else {
    try { await waitForPreviousAgent({ wait: args.includes('--service-run') }); }
    catch (error) { console.error(error.message); process.exit(75); }
    const agent = startLocalAgent({ relayUrl, agentName, localWebEnabled, webServicesFile });
    process.on('SIGINT', async () => { await agent.stop(); process.exit(0); });
    process.on('SIGTERM', async () => { await agent.stop(); process.exit(0); });
  }
}
