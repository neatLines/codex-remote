import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateTotpSecret,
  hashPassword,
  LoginRateLimiter,
  parseCookies,
  signSessionToken,
  verifyPassword,
  verifySessionToken,
  verifyTotpCode,
} from './crypto-auth.mjs';
import { acceptWebSocketUpgrade } from './ws-minimal.mjs';
import { createDshProxy } from './dsh-proxy.mjs';
import { createFileStore } from './file-store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_COOKIE_NAME = 'codex_remote_session';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.crt': 'application/x-x509-ca-cert',
};

/**
 * Load or initialize persistent cloud authentication state.
 * @param {string} dataDir
 * @param {NodeJS.ProcessEnv} env
 */
export function loadOrInitAuthState(dataDir, env = process.env) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const stateFile = path.join(dataDir, 'auth.json');

  let stored = {};
  if (fs.existsSync(stateFile)) {
    try {
      stored = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch {
      stored = {};
    }
  }

  let dirty = false;
  let generatedPlaintextPassword = stored.initialPassword || null;

  if (env.CODEX_ADMIN_PASSWORD) {
    stored.passwordHash = hashPassword(env.CODEX_ADMIN_PASSWORD);
    delete stored.initialPassword;
    generatedPlaintextPassword = null;
    dirty = true;
  } else if (!stored.passwordHash) {
    generatedPlaintextPassword = crypto.randomBytes(9).toString('base64url');
    stored.initialPassword = generatedPlaintextPassword;
    stored.passwordHash = hashPassword(generatedPlaintextPassword);
    dirty = true;
  }

  if (env.CODEX_TOTP_SECRET) {
    stored.totpSecret = env.CODEX_TOTP_SECRET.trim().toUpperCase();
    dirty = true;
  } else if (!stored.totpSecret) {
    stored.totpSecret = generateTotpSecret();
    dirty = true;
  }

  if (env.CODEX_COOKIE_SECRET) {
    stored.cookieSecret = env.CODEX_COOKIE_SECRET;
    dirty = true;
  } else if (!stored.cookieSecret) {
    stored.cookieSecret = crypto.randomBytes(32).toString('hex');
    dirty = true;
  }

  if (!stored.trustedAgents || typeof stored.trustedAgents !== 'object') {
    stored.trustedAgents = {};
    dirty = true;
  }

  const save = () => {
    fs.writeFileSync(stateFile, JSON.stringify(stored, null, 2), { mode: 0o600 });
  };

  if (dirty) {
    save();
  }

  return {
    stateFile,
    state: stored,
    generatedPlaintextPassword,
    save,
  };
}

/**
 * Create a Cloud Relay + Mobile Web UI server instance.
 * @param {{
 *   host?: string,
 *   port?: number,
 *   dataDir?: string,
 *   env?: NodeJS.ProcessEnv,
 *   quiet?: boolean
 * }} [options]
 */
export function createCloudServer(options = {}) {
  const env = options.env || process.env;
  const host = options.host ?? env.CODEX_CLOUD_HOST ?? '0.0.0.0';
  const port = Number(options.port ?? env.CODEX_CLOUD_PORT ?? 3280);
  const dataDir = path.resolve(options.dataDir ?? env.CODEX_DATA_DIR ?? path.join(__dirname, '..', 'data'));
  const tlsCertFile = env.CODEX_TLS_CERT_FILE;
  const tlsKeyFile = env.CODEX_TLS_KEY_FILE;
  if (Boolean(tlsCertFile) !== Boolean(tlsKeyFile)) {
    throw new Error('CODEX_TLS_CERT_FILE and CODEX_TLS_KEY_FILE must be configured together');
  }
  const tlsEnabled = Boolean(tlsCertFile);
  const redirectPort = env.CODEX_HTTP_REDIRECT_PORT;
  let redirectOrigin = null;
  if (redirectPort !== undefined && redirectPort !== '') {
    if (!tlsEnabled || !env.CODEX_PUBLIC_ORIGIN) {
      throw new Error('HTTP redirect requires TLS and CODEX_PUBLIC_ORIGIN');
    }
    const origin = new URL(env.CODEX_PUBLIC_ORIGIN);
    if (origin.protocol !== 'https:' || origin.username || origin.password ||
        origin.pathname !== '/' || origin.search || origin.hash) {
      throw new Error('CODEX_PUBLIC_ORIGIN must be an HTTPS origin');
    }
    redirectOrigin = origin.origin;
  }

  const authStore = loadOrInitAuthState(dataDir, env);
  const rateLimiter = new LoginRateLimiter();

  /** @type {Map<string, object>} */
  const agents = new Map();
  /** @type {Set<object>} */
  const clients = new Set();

  function getClientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) {
      return xff.split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function isRequestAuthenticated(req) {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE_NAME];
    const res = verifySessionToken(authStore.state.cookieSecret, token);
    return res.valid;
  }

  function sendJson(res, statusCode, body, extraHeaders = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(payload),
      ...extraHeaders,
    });
    res.end(payload);
  }

  function readJsonBody(req, maxBytes = 64 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          reject(new Error('Request body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve(text ? JSON.parse(text) : {});
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  function serializeAgentsList() {
    const list = [];
    for (const [agentId, info] of agents.entries()) {
      list.push({
        agentId,
        name: info.name,
        hostname: info.hostname,
        platform: info.platform,
        defaultCwd: info.defaultCwd,
        profile: info.profile || null,
        dshWeb: info.dshWeb || { enabled: false, status: 'disabled' },
        opencodeWeb: info.opencodeWeb || { enabled: false, status: 'disabled' },
        codexEnabled: info.codexEnabled !== false,
        codexStatus: info.codexStatus || 'ready',
        requiresE2E: Boolean(info.requiresE2E),
        e2eKeyFingerprint: info.e2eKeyFingerprint || null,
        trusted: Boolean(authStore.state.trustedAgents[agentId]),
        connectedAt: info.connectedAt,
        online: true,
      });
    }
    // Also include previously trusted offline agents
    for (const [agentId, saved] of Object.entries(authStore.state.trustedAgents)) {
      if (!agents.has(agentId)) {
        list.push({
          agentId,
          name: saved.name || agentId,
          hostname: saved.hostname || '',
          platform: saved.platform || '',
          defaultCwd: saved.defaultCwd || '',
          profile: saved.profile || null,
          codexEnabled: saved.codexEnabled !== false,
          codexStatus: 'offline',
          dshWeb: { enabled: saved.dshWeb?.enabled === true, status: 'offline' },
          opencodeWeb: { enabled: saved.opencodeWeb?.enabled === true, status: 'offline' },
          requiresE2E: Boolean(saved.requiresE2E),
          e2eKeyFingerprint: saved.e2eKeyFingerprint || null,
          trusted: true,
          connectedAt: saved.lastSeenAt || null,
          online: false,
        });
      }
    }
    return list;
  }

  function broadcastToClients(message) {
    const raw = typeof message === 'string' ? message : JSON.stringify(message);
    for (const client of clients) {
      client.ws.send(raw);
    }
  }

  function broadcastAgentsUpdate() {
    broadcastToClients({
      type: 'relay/agents',
      agents: serializeAgentsList(),
    });
  }

  const dshProxy = createDshProxy({
    agents, isAuthenticated: isRequestAuthenticated,
    isTrusted: (agentId) => Boolean(authStore.state.trustedAgents[agentId]),
    publicOrigin: env.CODEX_PUBLIC_ORIGIN,
  });
  const opencodeProxy = createDshProxy({
    agents, isAuthenticated: isRequestAuthenticated,
    isTrusted: (agentId) => Boolean(authStore.state.trustedAgents[agentId]),
    publicOrigin: env.CODEX_PUBLIC_ORIGIN, service: 'opencode',
  });
  const fileStore = createFileStore({ dataDir, env, authStore, isAuthenticated: isRequestAuthenticated,
    onChange: (file) => broadcastToClients({ type: 'relay/filesChanged', file }),
  });

  function sendUploadCredentials(agentId, ws, options) {
    const credentials = fileStore.issueCredentials(agentId, options);
    if (credentials) ws.send(credentials);
  }

  const server = tlsEnabled
    ? https.createServer({
        cert: fs.readFileSync(tlsCertFile), key: fs.readFileSync(tlsKeyFile), minVersion: 'TLSv1.2',
      })
    : http.createServer();
  const redirectServer = redirectOrigin ? http.createServer((req, res) => {
    // Use the configured origin, never the untrusted Host header.
    const requestPath = req.url?.startsWith('/') ? req.url : '/';
    res.writeHead(308, { Location: `${redirectOrigin}${requestPath}`, 'Cache-Control': 'no-store' });
    res.end();
  }) : null;

  server.on('request', async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // 1. Auth Status
    if (req.method === 'GET' && pathname === '/api/auth/status') {
      sendJson(res, 200, {
        authenticated: isRequestAuthenticated(req),
      });
      return;
    }

    // 2. Login with Password + TOTP 2FA
    if (req.method === 'POST' && pathname === '/api/auth/login') {
      const ip = getClientIp(req);
      const check = rateLimiter.check(ip);
      if (!check.allowed) {
        sendJson(res, 429, {
          ok: false,
          error:
            check.reason === 'locked'
              ? `登录失败次数过多，该 IP 已被临时封禁（请在 ${check.retryAfterSeconds} 秒后重试）`
              : `请求过于频繁，请在 ${check.retryAfterSeconds} 秒后重试`,
        });
        return;
      }

      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { ok: false, error: '无效的请求格式' });
        return;
      }

      const passwordOk = verifyPassword(body.password || '', authStore.state.passwordHash);
      const totpOk = verifyTotpCode(authStore.state.totpSecret, body.totpCode || '');
      const success = passwordOk && totpOk;

      rateLimiter.recordAttempt(ip, success);

      if (!success) {
        sendJson(res, 401, {
          ok: false,
          error: '访问口令或 6 位 TOTP 动态验证码错误',
        });
        return;
      }

      const maxAgeSeconds = 30 * 24 * 60 * 60;
      const sessionToken = signSessionToken(authStore.state.cookieSecret, {
        sub: 'owner',
        maxAgeMs: maxAgeSeconds * 1000,
      });

      const isHttps =
        req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket.encrypted);
      const cookieParts = [
        `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionToken)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        `Max-Age=${maxAgeSeconds}`,
      ];
      if (isHttps) cookieParts.push('Secure');

      sendJson(
        res,
        200,
        { ok: true },
        { 'Set-Cookie': cookieParts.join('; ') }
      );
      return;
    }

    // 3. Logout
    if (req.method === 'POST' && pathname === '/api/auth/logout') {
      dshProxy.closeSession(req.headers.cookie);
      opencodeProxy.closeSession(req.headers.cookie);
      sendJson(
        res,
        200,
        { ok: true },
        {
          'Set-Cookie': `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
        }
      );
      return;
    }

    // 4. List Agents
    if (req.method === 'GET' && pathname === '/api/agents') {
      if (!isRequestAuthenticated(req)) {
        sendJson(res, 401, { ok: false, error: 'Unauthorized' });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        agents: serializeAgentsList(),
      });
      return;
    }

    // 5. Trust / Untrust / Remove an Agent
    if (req.method === 'POST' && pathname === '/api/agents/trust') {
      if (!isRequestAuthenticated(req)) {
        sendJson(res, 401, { ok: false, error: 'Unauthorized' });
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { ok: false, error: 'Invalid JSON' });
        return;
      }

      const { agentId, trusted } = body;
      if (!agentId || typeof agentId !== 'string') {
        sendJson(res, 400, { ok: false, error: 'Missing agentId' });
        return;
      }

      const live = agents.get(agentId);
      if (trusted) {
        authStore.state.trustedAgents[agentId] = {
          agentId,
          name: live?.name || body.name || agentId,
          hostname: live?.hostname || '',
          platform: live?.platform || '',
          defaultCwd: live?.defaultCwd || '',
          profile: live?.profile || null,
          codexEnabled: live?.codexEnabled !== false,
          dshWeb: live?.dshWeb,
          opencodeWeb: live?.opencodeWeb,
          requiresE2E: Boolean(live?.requiresE2E),
          e2eKeyFingerprint: live?.e2eKeyFingerprint || null,
          trustedAt: Date.now(),
          lastSeenAt: Date.now(),
        };
        if (live) {
          live.ws.send({ type: 'relay/trusted', trusted: true });
          if (live.fileUploads) sendUploadCredentials(agentId, live.ws, { reset: true });
        }
      } else {
        delete authStore.state.trustedAgents[agentId];
        fileStore.revoke(agentId);
        dshProxy.revoke(agentId);
        opencodeProxy.revoke(agentId);
        if (live) {
          live.ws.send({ type: 'relay/trusted', trusted: false });
        }
      }
      authStore.save();
      broadcastAgentsUpdate();

      sendJson(res, 200, {
        ok: true,
        agents: serializeAgentsList(),
      });
      return;
    }

    if (await fileStore.handleHttp(req, res)) return;
    if (dshProxy.handleHttp(req, res)) return;
    if (opencodeProxy.handleHttp(req, res)) return;

    // 6. Serve Static Assets
    let relPath = pathname === '/' ? '/index.html' : pathname;
    const safePath = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
    const filePath = path.join(PUBLIC_DIR, safePath);

    if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'Content-Length': content.length,
    });
    res.end(content);
  });

  // WebSocket Upgrade Handling
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (dshProxy.handleUpgrade(req, socket, head)) return;
    if (opencodeProxy.handleUpgrade(req, socket, head)) return;

    if (url.pathname === '/ws/client') {
      if (!isRequestAuthenticated(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      const ws = acceptWebSocketUpgrade(req, socket, head);
      if (!ws) return;

      const clientId = `client_${crypto.randomBytes(6).toString('hex')}`;
      const clientObj = { clientId, ws, connectedAt: Date.now() };
      clients.add(clientObj);

      ws.send({
        type: 'relay/welcome',
        clientId,
        agents: serializeAgentsList(),
      });

      ws.on('message', (raw) => {
        if (typeof raw !== 'string') return;
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }

        if (msg.type === 'client/ping') {
          ws.send({ type: 'relay/pong', ts: Date.now() });
          return;
        }

        if (msg.type === 'client/rpc') {
          const { agentId, payload, e2e } = msg;
          const targetAgent = agents.get(agentId);
          if (!targetAgent) {
            ws.send({
              type: 'relay/error',
              agentId,
              requestId: payload?.id ?? null,
              error: '目标本地 Agent 当前不在线',
            });
            return;
          }

          if (!authStore.state.trustedAgents[agentId]) {
            ws.send({
              type: 'relay/error',
              agentId,
              requestId: payload?.id ?? null,
              error: '该设备尚未被信任，请先在顶部点击【信任该设备】',
            });
            return;
          }

          targetAgent.ws.send({
            type: 'relay/client_rpc',
            clientId,
            payload,
            e2e: e2e || null,
          });

          // Broadcast mutating actions to other mobile devices so multiple phones stay in sync
          if (
            payload?.method === 'turn/start' ||
            payload?.method === 'turn/steer' ||
            payload?.method === 'turn/interrupt' ||
            payload?.result !== undefined
          ) {
            for (const other of clients) {
              if (other !== clientObj) {
                other.ws.send({
                  type: 'relay/client_sync',
                  agentId,
                  fromClientId: clientId,
                  payload,
                });
              }
            }
          }
        }
      });

      ws.on('close', () => {
        clients.delete(clientObj);
      });
      return;
    }

    if (url.pathname === '/ws/agent') {
      const ws = acceptWebSocketUpgrade(req, socket, head);
      if (!ws) return;

      let registeredAgentId = null;

      ws.on('message', (raw) => {
        if (typeof raw !== 'string') return;
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }

        if (msg.type === 'agent/register') {
          const agentId = String(msg.agentId || '').trim();
          if (!agentId) {
            ws.close(1008, 'Missing agentId');
            return;
          }

          // Replace old connection if same agentId reconnects
          const existing = agents.get(agentId);
          if (existing && existing.ws !== ws) {
            existing.ws.close(1000, 'Replaced by new connection');
          }

          registeredAgentId = agentId;
          const agentInfo = {
            agentId,
            ws,
            name: String(msg.name || msg.hostname || agentId),
            hostname: String(msg.hostname || ''),
            platform: String(msg.platform || ''),
            defaultCwd: String(msg.defaultCwd || ''),
            profile: msg.profile ? String(msg.profile) : null,
            requiresE2E: Boolean(msg.requiresE2E),
            fileUploads: msg.fileUploads === true,
            codexEnabled: msg.codexEnabled !== false,
            codexStatus: ['starting', 'ready', 'error', 'disabled'].includes(msg.codexStatus) ? msg.codexStatus : 'ready',
            e2eKeyFingerprint: msg.e2eKeyFingerprint ? String(msg.e2eKeyFingerprint) : null,
            connectedAt: Date.now(),
            dshWeb: { enabled: msg.dshWeb?.enabled === true,
              status: ['starting', 'ready', 'error'].includes(msg.dshWeb?.status) ? msg.dshWeb.status : 'disabled' },
            opencodeWeb: { enabled: msg.opencodeWeb?.enabled === true,
              status: ['starting', 'ready', 'error'].includes(msg.opencodeWeb?.status) ? msg.opencodeWeb.status : 'disabled' },
          };
          agents.set(agentId, agentInfo);

          const isTrusted = Boolean(authStore.state.trustedAgents[agentId]);
          if (isTrusted) {
            authStore.state.trustedAgents[agentId] = {
              ...authStore.state.trustedAgents[agentId],
              name: agentInfo.name,
              hostname: agentInfo.hostname,
              platform: agentInfo.platform,
              defaultCwd: agentInfo.defaultCwd,
              profile: agentInfo.profile,
              codexEnabled: agentInfo.codexEnabled,
              dshWeb: agentInfo.dshWeb,
              opencodeWeb: agentInfo.opencodeWeb,
              requiresE2E: agentInfo.requiresE2E,
              e2eKeyFingerprint: agentInfo.e2eKeyFingerprint,
              lastSeenAt: Date.now(),
            };
            authStore.save();
          }

          ws.send({
            type: 'relay/registered',
            agentId,
            trusted: isTrusted,
          });
          if (isTrusted && agentInfo.fileUploads) {
            sendUploadCredentials(agentId, ws, { token: msg.fileUploadToken, allowCreate: true });
          }

          broadcastAgentsUpdate();
          return;
        }

        if (!registeredAgentId) return;
        if (dshProxy.handleMessage(registeredAgentId, ws, msg)) return;
        if (opencodeProxy.handleMessage(registeredAgentId, ws, msg)) return;
        if (msg.type === 'agent/codex_status') {
          const agent = agents.get(registeredAgentId);
          if (agent?.ws === ws && agent.codexStatus !== msg.status && ['starting', 'ready', 'error', 'disabled'].includes(msg.status)) {
            agent.codexStatus = msg.status;
            broadcastAgentsUpdate();
          }
          return;
        }
        if (msg.type === 'agent/opencode_status') {
          const agent = agents.get(registeredAgentId);
          if (agent?.ws === ws) {
            agent.opencodeWeb = { enabled: msg.opencodeWeb?.enabled === true,
              status: ['starting', 'ready', 'error'].includes(msg.opencodeWeb?.status) ? msg.opencodeWeb.status : 'disabled' };
            broadcastAgentsUpdate();
          }
          return;
        }
        if (msg.type === 'agent/dsh_status') {
          const agent = agents.get(registeredAgentId);
          if (agent?.ws === ws) {
            agent.dshWeb = { enabled: msg.dshWeb?.enabled === true,
              status: ['starting', 'ready', 'error'].includes(msg.dshWeb?.status) ? msg.dshWeb.status : 'disabled' };
            broadcastAgentsUpdate();
          }
          return;
        }

        if (msg.type === 'agent/rpc') {
          // Broadcast all Codex RPC responses, streaming notifications, and approval requests to all mobile devices
          broadcastToClients({
            type: 'relay/rpc',
            agentId: registeredAgentId,
            clientId: msg.clientId || null,
            payload: msg.payload,
          });
          return;
        }

        if (msg.type === 'agent/e2e_error') {
          broadcastToClients({
            type: 'relay/e2e_error',
            agentId: registeredAgentId,
            clientId: msg.clientId || null,
            requestId: msg.requestId ?? null,
            reason: msg.reason || '端到端签名校验失败',
          });
        }
      });

      ws.on('close', () => {
        dshProxy.disconnect(ws);
        opencodeProxy.disconnect(ws);
        if (registeredAgentId && agents.get(registeredAgentId)?.ws === ws) {
          agents.delete(registeredAgentId);
          if (authStore.state.trustedAgents[registeredAgentId]) {
            authStore.state.trustedAgents[registeredAgentId].lastSeenAt = Date.now();
            authStore.save();
          }
          broadcastAgentsUpdate();
        }
      });
      return;
    }

    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });

  // Periodic WebSocket Ping Keepalive
  const pingTimer = setInterval(() => {
    for (const client of clients) {
      client.ws.ping();
    }
    for (const agent of agents.values()) {
      agent.ws.ping();
    }
  }, 25000);
  pingTimer.unref();

  return {
    server,
    redirectServer,
    authStore,
    rateLimiter,
    agents,
    clients,
    async listen() {
      const listenOn = (target, targetPort) => new Promise((resolve, reject) => {
        target.once('error', reject);
        target.listen(targetPort, host, () => {
          target.removeListener('error', reject);
          resolve();
        });
      });
      await listenOn(server, port);
      if (redirectServer) {
        try {
          await listenOn(redirectServer, Number(redirectPort));
        } catch (error) {
          await new Promise((resolve) => server.close(resolve));
          throw error;
        }
      }
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      if (!options.quiet) {
        console.log('==========================================================');
        console.log('🚀 Codex Remote Cloud Server Started');
        console.log(`🌐 Listen Address : ${tlsEnabled ? 'https' : 'http'}://${host}:${actualPort}`);
        console.log(`📂 Auth State File: ${authStore.stateFile}`);
        console.log('🔐 登录口令与 TOTP 初始化资料仅保存在上述文件，不写入日志。');
        console.log('==========================================================');
      }
      return actualPort;
    },
    async close() {
      clearInterval(pingTimer);
      fileStore.close();
      dshProxy.close();
      opencodeProxy.close();
      for (const c of clients) c.ws.close();
      for (const a of agents.values()) a.ws.close();
      await Promise.all([server, redirectServer].filter(Boolean).map((target) =>
        new Promise((resolve) => target.close(() => resolve()))));
    },
  };
}

// Run directly if invoked as main script
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cloud = createCloudServer();
  cloud.listen().catch((err) => {
    console.error('Failed to start cloud server:', err);
    process.exit(1);
  });
}
