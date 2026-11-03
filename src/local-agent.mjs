import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2EVerifier } from './crypto-auth.mjs';
import { AgentInteractions } from './agent-interactions.mjs';
import { connectWebSocketClient } from './ws-minimal.mjs';
import { startManagedDsh, createDshAgentBridge } from './dsh-web.mjs';
import { clearUploadCredentials, registrationUploadToken, saveUploadCredentials, uploadAgentFile } from './file-upload.mjs';

const READ_ONLY_METHODS = new Set([
  'remote/getWorkspacesAndThreads',
  'remote/ping',
  'remote/getAgentState',
  'thread/list',
  'thread/loaded/list',
  'thread/read',
  'thread/resume',
  'thread/turns/list',
  'thread/items/list',
  'project/list',
  'project/read',
  'model/list',
  'fs/readDirectory',
  'fs/getMetadata',
  'fs/readFile',
  'config/read',
  'skills/list',
]);

/**
 * Load or create persistent local agent identity and E2E signing key.
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

  if (!data.localSigningKey) {
    const raw = crypto.randomBytes(9).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, 'X');
    data.localSigningKey = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
    dirty = true;
  }

  if (dirty) {
    fs.writeFileSync(idFile, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  const e2eKeyFingerprint = crypto
    .createHash('sha256')
    .update(String(data.localSigningKey))
    .digest('hex')
    .slice(0, 10);

  return {
    idFile,
    agentId: data.agentId,
    localSigningKey: data.localSigningKey,
    e2eKeyFingerprint,
  };
}

/**
 * Read desktop workspaces and thread-project mappings from ~/.codex/.codex-global-state.json.
 * @param {string} codexHome
 */
export function readDesktopGlobalWorkspaces(codexHome = path.join(os.homedir(), '.codex')) {
  const globalStateFile = path.join(codexHome, '.codex-global-state.json');
  if (!fs.existsSync(globalStateFile)) {
    return { projects: [], threadProjectAssignments: {}, sidebarOrders: {} };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(globalStateFile, 'utf8'));
    const localProjects = raw['local-projects'] || {};
    const projectOrder = Array.isArray(raw['project-order'])
      ? raw['project-order']
      : Object.keys(localProjects);
    const threadProjectAssignments = raw['thread-project-assignments'] || {};
    const sidebarOrders = raw['sidebar-project-thread-orders'] || {};

    const seen = new Set();
    const projects = [];
    for (const pid of [...projectOrder, ...Object.keys(localProjects)]) {
      if (seen.has(pid) || !localProjects[pid]) continue;
      seen.add(pid);
      const p = localProjects[pid];
      projects.push({
        id: p.id || pid,
        name: p.name || path.basename((p.rootPaths && p.rootPaths[0]) || pid),
        rootPaths: Array.isArray(p.rootPaths) ? p.rootPaths : [],
        updatedAt: p.updatedAt || p.createdAt || 0,
      });
    }

    return { projects, threadProjectAssignments, sidebarOrders };
  } catch {
    return { projects: [], threadProjectAssignments: {}, sidebarOrders: {} };
  }
}

/**
 * Start the local Codex App-Server bridge and connect to the Cloud Relay.
 * @param {{
 *   relayUrl?: string,
 *   relayCaFile?: string,
 *   dshEnabled?: boolean,
 *   dshBin?: string,
 *   dshPort?: number,
 *   dshCwd?: string,
 *   codexBin?: string,
 *   codexHome?: string,
 *   profile?: string | null,
 *   agentName?: string,
 *   defaultCwd?: string,
 *   requiresE2E?: boolean,
 *   quiet?: boolean,
 *   requestTimeoutMs?: number,
 *   restartDelayMs?: number
 * }} [options]
 */
export function startLocalAgent(options = {}) {
  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const relayUrl =
    options.relayUrl || process.env.CODEX_RELAY_URL || 'ws://127.0.0.1:3280/ws/agent';
  const relayCaFile = options.relayCaFile || process.env.CODEX_RELAY_CA_FILE;
  const relayCa = relayCaFile ? fs.readFileSync(relayCaFile) : undefined;
  const codexBin = options.codexBin || process.env.CODEX_BIN || 'codex';
  const defaultCwd = options.defaultCwd || process.cwd();
  const requiresE2E = options.requiresE2E ?? process.env.CODEX_DISABLE_E2E !== '1';
  let currentProfile = options.profile ?? process.env.CODEX_PROFILE ?? null;

  const identity = loadOrCreateAgentIdentity(codexHome);
  const agentName = options.agentName || process.env.CODEX_AGENT_NAME || os.hostname();
  const verifier = new E2EVerifier(identity.localSigningKey);

  let codexProc = null;
  let codexReady = false;
  let codexReadyResolve = null;
  let codexReadyPromise = Promise.resolve();
  let cachedModels = null;
  let cachedConfig = null;
  let internalReqSeq = 900000;
  /** @type {Map<string | number, { resolve: Function, reject: Function }>} */
  const internalPending = new Map();
  /** @type {Map<string | number, { clientId: string, method: string, threadId?: string }>} */
  const clientRequestOwners = new Map();
  /** @type {Set<string>} */
  const activeTurnThreads = new Set();
  let recycleTimer = null;
  const pendingTurnStarts = new Set();
  const activeTurns = new Map();
  const completedTurns = new Set();
  const requestTimeoutMs = options.requestTimeoutMs ?? 30000;
  let processEpoch = null;
  let stateRevision = 0;
  let serverStatus = 'starting';
  let serverError = null;
  let processRestartTimer = null;
  let resettingProcess = false;
  const interactions = new AgentInteractions({
    write: (response) => writeToCodex(response),
    timeoutMs: Math.min(requestTimeoutMs, 15000),
    changed: () => { if (!resettingProcess) publishAgentState(); },
  });

  function agentSnapshot() {
    return {
      version: 1, epoch: processEpoch, revision: stateRevision,
      status: serverStatus, error: serverError,
      activeTurns: [...activeTurns.values()], requests: interactions.snapshot(),
    };
  }

  function publishAgentState() {
    stateRevision++;
    activeWs?.send({ type: 'agent/rpc', clientId: null,
      payload: { method: 'remote/agentState', params: agentSnapshot() } });
  }

  function replyToClient(clientId, id, result, error) {
    if (id === undefined) return;
    activeWs?.send({ type: 'agent/rpc', clientId,
      payload: { id, ...(error ? { error: { code: -32000, message: error.message || String(error) } } : { result }) } });
  }

  function clearProcessRequests(reason) {
    resettingProcess = true;
    for (const pending of internalPending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    internalPending.clear();
    for (const [id, pending] of clientRequestOwners) {
      clearTimeout(pending.timer);
      replyToClient(pending.clientId, id, null, new Error(reason));
    }
    clientRequestOwners.clear();
    pendingTurnStarts.clear();
    activeTurnThreads.clear();
    activeTurns.clear();
    completedTurns.clear();
    interactions.reset(processEpoch, reason);
    resettingProcess = false;
    codexReady = false;
    codexReadyResolve?.();
  }

  function failProcess(proc, reason) {
    if (proc !== codexProc) return;
    codexProc = null;
    killCodexProcTree(proc);
    serverStatus = 'error';
    serverError = reason;
    clearProcessRequests(reason);
    publishAgentState();
    if (!stopped && !processRestartTimer) {
      processRestartTimer = setTimeout(() => {
        processRestartTimer = null;
        if (!stopped) spawnCodexAppServer();
      }, options.restartDelayMs ?? 1000);
      processRestartTimer.unref();
    }
  }
  let lockReleaseNeeded = false;

  let activeWs = null;
  let stopped = false;
  let reconnectTimer = null;
  let dshManager = null;
  const dshEnabled = options.dshEnabled ?? process.env.CODEX_DSH_ENABLED === '1';
  const dshBridge = createDshAgentBridge({ getTarget: async () => {
    if (!dshManager) throw new Error('DSH Web is disabled');
    return dshManager.target();
  } });
  if (dshEnabled) {
    const relay = new URL(relayUrl);
    const publicUrl = `${relay.protocol === 'wss:' ? 'https:' : 'http:'}//${relay.host}/dsh/${identity.agentId}/`;
    dshManager = startManagedDsh({
      bin: options.dshBin || process.env.CODEX_DSH_BIN || 'dsh',
      port: Number(options.dshPort ?? process.env.CODEX_DSH_PORT ?? 3081),
      cwd: options.dshCwd || process.env.CODEX_DSH_CWD || os.homedir(),
      publicUrl, quiet: options.quiet,
      onStatus: (dshWeb) => activeWs?.send({ type: 'agent/dsh_status', dshWeb }),
      onRestart: () => dshBridge.disconnect(true),
    });
  }

  function killCodexProcTree(proc) {
    if (!proc) return;
    try {
      if (proc.pid) process.kill(-proc.pid, 'SIGTERM');
    } catch {
      // ignore
    }
    try {
      proc.kill('SIGTERM');
    } catch {
      // ignore
    }
  }

  function scheduleLockReleaseRecycle() {
    lockReleaseNeeded = true;
    if (recycleTimer) clearTimeout(recycleTimer);
    recycleTimer = setTimeout(() => {
      recycleTimer = null;
      if (!stopped && activeTurnThreads.size === 0 && pendingTurnStarts.size === 0 && interactions.pending.size === 0 &&
          internalPending.size === 0 && clientRequestOwners.size === 0) {
        // Recycle codex app-server process tree so all ~/.codex/thread-writer-locks/*.lock FDs are immediately released for local Desktop App
        lockReleaseNeeded = false;
        spawnCodexAppServer();
      }
    }, 350);
    recycleTimer.unref();
  }

  function spawnCodexAppServer() {
    if (processRestartTimer) { clearTimeout(processRestartTimer); processRestartTimer = null; }
    clearProcessRequests('本机 Codex 已重启，未完成的操作已中断，请刷新会话');
    processEpoch = crypto.randomUUID();
    interactions.reset(processEpoch);
    serverStatus = 'starting';
    serverError = null;
    publishAgentState();
    if (recycleTimer) {
      clearTimeout(recycleTimer);
      recycleTimer = null;
    }
    if (codexProc) {
      const prev = codexProc;
      codexProc = null;
      killCodexProcTree(prev);
    }

    const args = [];
    if (currentProfile) {
      args.push('--profile', currentProfile);
    }
    args.push('app-server');

    codexReady = false;
    codexReadyPromise = new Promise((resolve) => {
      codexReadyResolve = resolve;
    });

    const proc = spawn(codexBin, args, {
      cwd: defaultCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: codexHome },
      detached: true,
    });
    codexProc = proc;

    let stdoutBuf = '';
    proc.stdout.on('data', (chunk) => {
      if (proc !== codexProc) return;
      stdoutBuf += chunk.toString('utf8');
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        handleCodexStdoutLine(line);
      }
    });

    proc.stderr.on('data', (chunk) => {
      if (!options.quiet && process.env.CODEX_DEBUG === '1') {
        process.stderr.write(`[codex-stderr] ${chunk}`);
      }
    });

    proc.stdin.on('error', () => failProcess(proc, 'Codex 通信中断，未完成的操作已结束'));
    proc.on('error', () => failProcess(proc, '无法启动 Codex，请检查 CODEX_BIN 和本机安装'));
    proc.on('exit', (code) => failProcess(proc, `Codex 进程已退出（${code ?? 'signal'}），正在恢复连接`));

    // Perform JSON-RPC initialize handshake
    sendInternalRpc('initialize', {
      clientInfo: {
        name: 'codex-remote-agent',
        title: 'Codex Mobile Remote Agent',
        version: '1.0.0',
      },
      capabilities: { experimentalApi: true },
    })
      .then(() => {
        if (proc !== codexProc) return;
        writeToCodex({ method: 'initialized' });
        codexReady = true;
        serverStatus = 'ready';
        serverError = null;
        publishAgentState();
        if (codexReadyResolve) codexReadyResolve();
        // Pre-warm models and config in background for instant UI loading
        if (!cachedModels) {
          sendInternalRpc('model/list', {})
            .then((res) => {
              if (Array.isArray(res?.data)) cachedModels = res.data;
            })
            .catch(() => {});
        }
        if (!cachedConfig) {
          sendInternalRpc('config/read', {})
            .then((res) => {
              if (res?.config) cachedConfig = res.config;
            })
            .catch(() => {});
        }
      })
      .catch(() => {
        failProcess(proc, 'Codex 初始化失败或超时，正在重启');
      });
  }

  function writeToCodex(obj) {
    if (!codexProc?.stdin.writable || codexProc.stdin.destroyed) return false;
    try { codexProc.stdin.write(`${JSON.stringify(obj)}\n`); return true; } catch { return false; }
  }

  function sendInternalRpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = `internal_${++internalReqSeq}`;
      const epoch = processEpoch;
      const timer = setTimeout(() => {
        if (internalPending.get(id)?.epoch !== epoch) return;
        internalPending.delete(id);
        reject(new Error(`Codex 请求 ${method} 超时`));
        if (lockReleaseNeeded) scheduleLockReleaseRecycle();
      }, requestTimeoutMs);
      timer.unref();
      internalPending.set(id, { resolve, reject, timer, epoch });
      if (!writeToCodex({ id, method, params })) {
        clearTimeout(timer);
        internalPending.delete(id);
        reject(new Error('Codex 连接不可写'));
      }
    });
  }

  function handleCodexStdoutLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    // Check if it's a response to an internal request
    if (msg.id !== undefined && internalPending.has(msg.id)) {
      const handler = internalPending.get(msg.id);
      internalPending.delete(msg.id);
      clearTimeout(handler.timer);
      if (lockReleaseNeeded) scheduleLockReleaseRecycle();
      if (msg.error) {
        handler.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        handler.resolve(msg.result);
      }
      return;
    }

    if (msg.id !== undefined && msg.method === 'currentTime/read') {
      writeToCodex({ id: msg.id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } });
      return;
    }
    if (msg.id !== undefined && typeof msg.method === 'string') {
      const payload = interactions.capture(msg);
      activeWs?.send({ type: 'agent/rpc', clientId: null, payload });
      return;
    }
    if (msg.method === 'serverRequest/resolved') {
      msg.requestEpoch = processEpoch;
      interactions.resolve(msg.params?.requestId);
    }
    if (msg.method === 'turn/started' && msg.params?.threadId) {
      const { threadId, turn } = msg.params;
      completedTurns.delete(JSON.stringify([threadId, turn?.id]));
      activeTurnThreads.add(threadId);
      activeTurns.set(threadId, { threadId, turnId: turn?.id, status: 'running' });
    }
    if (msg.method === 'error' && msg.params?.threadId) {
      const turn = activeTurns.get(msg.params.threadId);
      if (turn) { turn.status = msg.params.willRetry ? 'retrying' : 'failed'; turn.message = msg.params.error?.message; }
    }
    const startingThisThread = [...clientRequestOwners.values()].some((entry) =>
      entry.method === 'turn/start' && entry.threadId === msg.params?.threadId);
    const idleFinished = msg.method === 'thread/status/changed' && msg.params?.status?.type === 'idle' &&
      activeTurnThreads.has(msg.params?.threadId) && !startingThisThread && pendingTurnStarts.size === 0;
    if ((msg.method === 'turn/completed' || idleFinished) && msg.params?.threadId) {
      const threadId = msg.params.threadId;
      completedTurns.add(JSON.stringify([threadId, msg.params.turn?.id]));
      while (completedTurns.size > 200) completedTurns.delete(completedTurns.values().next().value);
      activeTurnThreads.delete(threadId);
      activeTurns.delete(threadId);
      interactions.cancelThread(threadId, '当前轮次已结束，该交互已失效');
      scheduleLockReleaseRecycle();
      if (idleFinished) activeWs?.send({ type: 'agent/rpc', clientId: null,
        payload: { method: 'turn/completed', params: { threadId, turn: { id: 'idle', status: 'completed' } } } });
    }

    // Otherwise forward to Cloud Relay
    let ownerClientId = null;
    if (msg.id !== undefined && msg.method === undefined && clientRequestOwners.has(msg.id)) {
      const request = clientRequestOwners.get(msg.id);
      ownerClientId = request.clientId;
      clientRequestOwners.delete(msg.id);
      clearTimeout(request.timer);
      if (request.method === 'turn/start' && msg.error) {
        activeTurnThreads.delete(request.threadId);
        activeTurns.delete(request.threadId);
        scheduleLockReleaseRecycle();
      } else if (request.method === 'turn/start' && msg.result?.turn) {
        const turn = msg.result.turn;
        if (!completedTurns.has(JSON.stringify([request.threadId, turn.id])) &&
            !['completed', 'failed', 'interrupted'].includes(turn.status)) {
          activeTurnThreads.add(request.threadId);
          if (activeTurns.get(request.threadId)?.turnId !== turn.id) {
            activeTurns.set(request.threadId, { threadId: request.threadId, turnId: turn.id, status: 'running' });
          }
        } else if (!activeTurns.has(request.threadId)) activeTurnThreads.delete(request.threadId);
      }
      if (lockReleaseNeeded) scheduleLockReleaseRecycle();
    }

    if (activeWs && activeWs.readyState === 1) {
      activeWs.send({
        type: 'agent/rpc',
        clientId: ownerClientId,
        payload: msg,
      });
    }
    if (msg.method?.startsWith('turn/') || msg.method === 'error' || msg.method === 'thread/status/changed' ||
        msg.method === 'serverRequest/resolved' || msg.id !== undefined) publishAgentState();
  }

  async function handleClientRpcMessage(msg) {
    const { clientId, payload, e2e } = msg;
    if (!payload || typeof payload !== 'object') return;

    const isClientResponseToServerRequest =
      payload.id !== undefined && payload.method === undefined && (payload.result !== undefined || payload.error !== undefined);
    const isReadOnlyMethod = payload.method && READ_ONLY_METHODS.has(payload.method);

    // Verify E2E signature for mutating methods and server request approval responses
    if (requiresE2E && !isReadOnlyMethod) {
      const bodyString = JSON.stringify(payload);
      const check = verifier.verify({
        timestamp: e2e?.timestamp,
        nonce: e2e?.nonce,
        signature: e2e?.signature,
        bodyString,
      });
      if (!check.ok) {
        if (activeWs && activeWs.readyState === 1) {
          activeWs.send({
            type: 'agent/e2e_error',
            clientId,
            requestId: payload.id ?? null,
            reason: `本机端到端安全验签未通过 (${check.reason})，请确认手机端已填入本机配对密钥`,
          });
        }
        return;
      }
    }

    if (payload.method === 'remote/getAgentState') {
      replyToClient(clientId, payload.id, agentSnapshot());
      return;
    }
    if (payload.method === 'remote/respondToRequest') {
      try { replyToClient(clientId, payload.id, await interactions.submit(payload.params || {})); }
      catch (error) { replyToClient(clientId, payload.id, null, error); }
      return;
    }
    if (isClientResponseToServerRequest) {
      try {
        await interactions.submit({ requestId: payload.id, requestEpoch: processEpoch,
          result: payload.result, error: payload.error });
      } catch (error) {
        activeWs?.send({ type: 'agent/e2e_error', clientId, requestId: payload.id, reason: error.message });
      }
      return;
    }
    const epoch = processEpoch;
    if (!codexReady) await codexReadyPromise;
    if (!codexReady || epoch !== processEpoch) {
      replyToClient(clientId, payload.id, null, new Error('Codex 正在重启或尚未就绪，请稍后重试'));
      return;
    }

    // Handle synthetic composite RPC: remote/getWorkspacesAndThreads
    if (payload.method === 'remote/getWorkspacesAndThreads') {
      try {
        const desktop = readDesktopGlobalWorkspaces(codexHome);
        const threadRes = await sendInternalRpc('thread/list', {
          limit: payload.params?.limit ?? 100,
          cursor: payload.params?.cursor || undefined,
          useStateDbOnly: true,
          modelProviders: [],
          sourceKinds: ['cli', 'vscode', 'appServer', 'exec', 'unknown'],
        });

        const threads = Array.isArray(threadRes?.data) ? threadRes.data : [];
        // Enrich threads with desktop projectId assignment if present
        for (const t of threads) {
          if (!t.projectId && desktop.threadProjectAssignments[t.id]) {
            t.projectId = desktop.threadProjectAssignments[t.id];
          }
        }

        // Also build workspace entries for any cwd in threads not yet covered by desktop.projects
        const coveredRoots = new Set();
        for (const p of desktop.projects) {
          for (const r of p.rootPaths) coveredRoots.add(r);
        }

        const extraCwdMap = new Map();
        for (const t of threads) {
          if (!t.cwd) continue;
          // Check if t.cwd matches any desktop project root
          let matchedProject = null;
          for (const p of desktop.projects) {
            if (p.id === t.projectId || p.rootPaths.includes(t.cwd)) {
              matchedProject = p.id;
              break;
            }
          }
          if (matchedProject) {
            t.projectId = matchedProject;
          } else {
            if (!extraCwdMap.has(t.cwd)) {
              const syntheticId = `cwd:${t.cwd}`;
              extraCwdMap.set(t.cwd, {
                id: syntheticId,
                name: path.basename(t.cwd) || t.cwd,
                rootPaths: [t.cwd],
                updatedAt: (t.updatedAt || 0) * 1000,
                isAutoDiscovered: true,
              });
            }
            t.projectId = `cwd:${t.cwd}`;
          }
        }

        const mergedProjects = [
          ...desktop.projects,
          ...Array.from(extraCwdMap.values()),
        ];

        if (!cachedConfig) {
          try {
            const cfgRes = await Promise.race([
              sendInternalRpc('config/read', {}),
              new Promise((r) => setTimeout(() => r(null), 400)),
            ]);
            if (cfgRes?.config) cachedConfig = cfgRes.config;
          } catch {
            // ignore
          }
        }

        if (!cachedModels) {
          try {
            const mdlRes = await Promise.race([
              sendInternalRpc('model/list', {}),
              new Promise((r) => setTimeout(() => r(null), 600)),
            ]);
            if (Array.isArray(mdlRes?.data)) cachedModels = mdlRes.data;
          } catch {
            // ignore
          }
        }

        const compactModels = Array.isArray(cachedModels)
          ? cachedModels
              .filter((m) => !m.hidden)
              .map((m) => ({
                id: m.id || m.model,
                displayName: m.displayName || m.id || m.model,
                description: m.description || '',
                defaultReasoningEffort: m.defaultReasoningEffort || 'medium',
                isDefault: Boolean(m.isDefault),
                efforts: Array.isArray(m.supportedReasoningEfforts)
                  ? m.supportedReasoningEfforts.map((e) => e.reasoningEffort)
                  : ['low', 'medium', 'high', 'xhigh'],
              }))
          : [];

        if (activeWs && activeWs.readyState === 1) {
          activeWs.send({
            type: 'agent/rpc',
            clientId,
            payload: {
              id: payload.id,
              result: {
                projects: mergedProjects,
                threads,
                nextCursor: threadRes?.nextCursor || null,
                defaultCwd,
                profile: currentProfile,
                models: compactModels,
                currentModel: cachedConfig?.model || threads[0]?.model || 'gpt-6-astra',
                currentEffort:
                  cachedConfig?.model_reasoning_effort ||
                  threads[0]?.reasoningEffort ||
                  'xhigh',
              },
            },
          });
        }
      } catch (err) {
        if (activeWs && activeWs.readyState === 1) {
          activeWs.send({
            type: 'agent/rpc',
            clientId,
            payload: {
              id: payload.id,
              error: { code: -32000, message: err.message },
            },
          });
        }
      }
      return;
    }

    // Handle profile switch request from mobile UI
    if (payload.method === 'remote/switchProfile') {
      if (activeTurnThreads.size || interactions.pending.size || pendingTurnStarts.size) {
        replyToClient(clientId, payload.id, null, new Error('请先等待当前任务结束或停止任务，再切换 Profile'));
        return;
      }
      currentProfile = payload.params?.profile ? String(payload.params.profile).trim() : null;
      spawnCodexAppServer();
      if (activeWs && activeWs.readyState === 1) {
        activeWs.send({
          type: 'agent/rpc',
          clientId,
          payload: {
            id: payload.id,
            result: { ok: true, profile: currentProfile },
          },
        });
      }
      return;
    }

    // On-demand lightweight resume before turn/start (with auto-fork fallback if Desktop App holds writer lock)
    if (payload.method === 'turn/start' && payload.params?.threadId) {
      const startToken = {};
      pendingTurnStarts.add(startToken);
      if (recycleTimer) {
        clearTimeout(recycleTimer);
        recycleTimer = null;
      }
      let targetThreadId = payload.params.threadId;
      try {
        try {
          await sendInternalRpc('thread/resume', { threadId: targetThreadId, excludeTurns: true });
        } catch (error) {
          if (!String(error.message).includes('already has an active writer')) throw error;
          const forkRes = await sendInternalRpc('thread/fork', { threadId: targetThreadId, excludeTurns: true });
          const forkedThread = forkRes?.thread || forkRes;
          if (!forkedThread?.id) throw new Error('分叉会话未返回有效 ID');
          const originalThreadId = targetThreadId;
          targetThreadId = forkedThread.id;
          payload.params.threadId = targetThreadId;
          activeWs?.send({ type: 'agent/rpc', clientId,
            payload: { method: 'remote/threadForked', params: { oldThreadId: originalThreadId, newThreadId: targetThreadId } } });
        }
      } catch (error) {
        replyToClient(clientId, payload.id, null, error);
        return;
      } finally {
        pendingTurnStarts.delete(startToken);
      }
      if (epoch !== processEpoch || !codexReady) {
        replyToClient(clientId, payload.id, null, new Error('Codex 已重启，本次消息未提交，请重新发送'));
        return;
      }
      activeTurnThreads.add(targetThreadId);
    }

    // Track owner of standard client request
    if (payload.id !== undefined && !isClientResponseToServerRequest && clientId) {
      const timer = setTimeout(() => {
        const pending = clientRequestOwners.get(payload.id);
        if (!pending || pending.epoch !== epoch) return;
        clientRequestOwners.delete(payload.id);
        replyToClient(clientId, payload.id, null, new Error('Codex 请求超时，请同步状态后再决定是否重试'));
        if (pending.method === 'turn/start' && !activeTurns.has(pending.threadId)) {
          activeTurnThreads.delete(pending.threadId);
          scheduleLockReleaseRecycle();
        }
        if (lockReleaseNeeded) scheduleLockReleaseRecycle();
      }, requestTimeoutMs);
      timer.unref();
      clientRequestOwners.set(payload.id, {
        clientId, method: payload.method, threadId: payload.params?.threadId, timer, epoch,
      });
    }

    if (!writeToCodex(payload)) {
      clearTimeout(clientRequestOwners.get(payload.id)?.timer);
      clientRequestOwners.delete(payload.id);
      if (payload.method === 'turn/start') activeTurnThreads.delete(payload.params?.threadId);
      if (activeWs && activeWs.readyState === 1 && payload.method && payload.id !== undefined) {
        activeWs.send({
          type: 'agent/rpc', clientId,
          payload: { id: payload.id, error: { code: -32000, message: 'codex app-server stdin not writable' } },
        });
      }
    }
  }

  async function connectLoop() {
    if (stopped) return;
    try {
      const ws = await connectWebSocketClient(relayUrl, { ca: relayCa });
      if (stopped) { ws.close(); return; }
      activeWs = ws;
      dshBridge.attach((message) => ws.send(message));

      ws.send({
        type: 'agent/register',
        dshWeb: dshManager?.status || { enabled: false, status: 'disabled' },
        agentId: identity.agentId,
        name: agentName,
        hostname: os.hostname(),
        platform: `${os.platform()}-${os.arch()}`,
        defaultCwd,
        profile: currentProfile,
        requiresE2E,
        e2eKeyFingerprint: identity.e2eKeyFingerprint,
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

        if (dshBridge.handle(msg)) return;

        if (msg.type === 'relay/registered') {
          if (!msg.trusted) clearUploadCredentials(codexHome, relayUrl);
          publishAgentState();
          if (!options.quiet) {
            console.log(
              `✅ Connected to Cloud Relay (${relayUrl}) | Trusted: ${
                msg.trusted ? 'YES' : 'PENDING (请在手机网页顶部点击【信任该设备】)'
              }`
            );
          }
          return;
        }

        if (msg.type === 'relay/trusted') {
          if (!msg.trusted) clearUploadCredentials(codexHome, relayUrl);
          if (!options.quiet) {
            console.log(`🔒 Device trust updated by mobile user: ${msg.trusted ? 'TRUSTED' : 'UNTRUSTED'}`);
          }
          return;
        }

        if (msg.type === 'relay/fileUploadCredentials') {
          try { saveUploadCredentials(codexHome, relayUrl, identity.agentId, msg); }
          catch { if (!options.quiet) console.warn('[local-agent] 无法保存文件上传凭据，请检查本机配置目录权限'); }
          return;
        }

        if (msg.type === 'relay/client_rpc') {
          handleClientRpcMessage(msg).catch((error) => replyToClient(msg.clientId, msg.payload?.id, null, error));
        }
      });

      ws.on('close', () => {
        if (activeWs === ws) { activeWs = null; dshBridge.disconnect(); }
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

  spawnCodexAppServer();
  connectLoop();

  if (!options.quiet) {
    console.log('==========================================================');
    console.log('💻 Codex Local Remote Agent Started');
    console.log(`🆔 Agent ID          : ${identity.agentId} (${agentName})`);
    console.log(`☁️  Cloud Relay URL   : ${relayUrl}`);
    console.log(`📂 Default Workspace : ${defaultCwd}`);
    console.log(`⚙️  Codex Profile     : ${currentProfile || '(default)'}`);
    if (requiresE2E) {
      console.log('🔐 配对密钥已保存；在本机运行 codex-up --show-pairing-key 查看');
    }
    console.log('==========================================================');
  }

  return {
    identity,
    get dshStatus() { return dshManager?.status || { enabled: false, status: 'disabled' }; },
    stop() {
      stopped = true;
      dshBridge.disconnect();
      dshManager?.stop();
      if (recycleTimer) clearTimeout(recycleTimer);
      if (processRestartTimer) clearTimeout(processRestartTimer);
      clearProcessRequests('本机 Agent 已停止');
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (activeWs) activeWs.close();
      if (codexProc) {
        const prev = codexProc;
        codexProc = null;
        killCodexProcTree(prev);
      }
    },
  };
}

// Run directly if invoked as main script
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let relayUrl = process.env.CODEX_RELAY_URL;
  let profile = process.env.CODEX_PROFILE || null;
  let agentName = process.env.CODEX_AGENT_NAME;
  let requiresE2E = process.env.CODEX_DISABLE_E2E !== '1';
  let dshEnabled = process.env.CODEX_DSH_ENABLED !== '0';
  let threadId;
  let uploadName;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--relay' && args[i + 1]) relayUrl = args[++i];
    else if ((args[i] === '--profile' || args[i] === '-p') && args[i + 1]) profile = args[++i];
    else if (args[i] === '--name' && args[i + 1]) { agentName = args[++i]; uploadName = agentName; }
    else if (args[i] === '--no-e2e') requiresE2E = false;
    else if (args[i] === '--no-dsh') dshEnabled = false;
    else if (args[i] === '--dsh') dshEnabled = true;
    else if (args[i] === '--thread-id' && args[i + 1]) threadId = args[++i];
  }

  if (args.includes('--show-pairing-key')) {
    const identity = loadOrCreateAgentIdentity(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
    console.log(identity.localSigningKey);
    process.exit(0);
  }
  if (args.includes('--upload')) {
    const filePath = args[args.indexOf('--upload') + 1];
    try {
      if (!filePath || filePath.startsWith('--')) throw new Error('用法：codex-up --upload 文件路径 [--name 下载文件名] [--thread-id 会话ID]');
      const file = await uploadAgentFile(filePath, { relayUrl, name: uploadName, threadId });
      console.log(JSON.stringify({ ok: true, file }));
    } catch (error) {
      console.error(error.message); process.exitCode = 1;
    }
  } else {
    const agent = startLocalAgent({ relayUrl, profile, agentName, requiresE2E, dshEnabled });
    process.on('SIGINT', () => { agent.stop(); process.exit(0); });
    process.on('SIGTERM', () => { agent.stop(); process.exit(0); });
  }
}
