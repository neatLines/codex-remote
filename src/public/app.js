import { renderMarkdown } from './markdown.js';
import { createInteractionCard } from './interactions.js';

// Pure-JS SHA-256 & HMAC-SHA256 so E2E signing works even on plain HTTP (http://IP:PORT) mobile browsers
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(n, x) {
  return (x >>> n) | (x << (32 - n));
}

function sha256Bytes(msgBytes) {
  const l = msgBytes.length;
  const bitLenHi = Math.floor((l * 8) / 0x100000000);
  const bitLenLo = (l * 8) >>> 0;
  const padLen = ((l + 9 + 63) & ~63);
  const padded = new Uint8Array(padLen);
  padded.set(msgBytes);
  padded[l] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padLen - 8, bitLenHi, false);
  dv.setUint32(padLen - 4, bitLenLo, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let i = 0; i < padLen; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4, false);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(7, w[t - 15]) ^ rotr(18, w[t - 15]) ^ (w[t - 15] >>> 3);
      const s1 = rotr(17, w[t - 2]) ^ rotr(19, w[t - 2]) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[t] + w[t]) >>> 0;
      const S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outDv = new DataView(out.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((v, idx) => outDv.setUint32(idx * 4, v, false));
  return out;
}

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function sha256Hex(str) {
  return toHex(sha256Bytes(new TextEncoder().encode(str)));
}

function hmacSha256Hex(keyStr, messageStr) {
  const enc = new TextEncoder();
  let keyBytes = enc.encode(keyStr);
  if (keyBytes.length > 64) keyBytes = sha256Bytes(keyBytes);
  const kPad = new Uint8Array(64);
  kPad.set(keyBytes);

  const ipad = new Uint8Array(64);
  const opad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    ipad[i] = kPad[i] ^ 0x36;
    opad[i] = kPad[i] ^ 0x5c;
  }

  const msgBytes = enc.encode(messageStr);
  const innerInput = new Uint8Array(64 + msgBytes.length);
  innerInput.set(ipad, 0);
  innerInput.set(msgBytes, 64);
  const innerHash = sha256Bytes(innerInput);

  const outerInput = new Uint8Array(64 + 32);
  outerInput.set(opad, 0);
  outerInput.set(innerHash, 64);
  return toHex(sha256Bytes(outerInput));
}

// === App State ===
const state = {
  ws: null,
  reqSeq: 1,
  pendingRpc: new Map(),
  agents: [],
  selectedAgentId: localStorage.getItem('codex_selected_agent') || null,
  projects: [],
  threads: [],
  models: [],
  selectedModel: localStorage.getItem('codex_selected_model') || 'gpt-6-astra',
  selectedEffort: localStorage.getItem('codex_selected_effort') || 'xhigh',
  selectedCwd: localStorage.getItem('codex_selected_cwd') || null,
  currentThreadId: null,
  activeTurnId: null,
  agentStates: new Map(),
  agentSyncs: new Map(),
  restoreAgentId: null,
  threadsNextCursor: null,
  loadingThreads: false,
  threadViews: new Map(),
  currentView: null,
  collapsedWorkspaces: new Set(),
};

const EFFORT_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  ultra: 'Ultra',
};

// === DOM Elements ===
const el = {
  loginView: document.getElementById('login-view'),
  appView: document.getElementById('app-view'),
  loginForm: document.getElementById('login-form'),
  loginPassword: document.getElementById('login-password'),
  loginTotp: document.getElementById('login-totp'),
  loginError: document.getElementById('login-error'),
  btnDrawer: document.getElementById('btn-drawer'),
  drawerBackdrop: document.getElementById('drawer-backdrop'),
  sidebarDrawer: document.getElementById('sidebar-drawer'),
  agentSelect: document.getElementById('agent-select'),
  btnRefreshThreads: document.getElementById('btn-refresh-threads'),
  btnBrowseDir: document.getElementById('btn-browse-dir'),
  btnSwitchProfile: document.getElementById('btn-switch-profile'),
  threadSearchInput: document.getElementById('thread-search-input'),
  workspacesContainer: document.getElementById('workspaces-container'),
  btnLogout: document.getElementById('btn-logout'),
  currentThreadTitle: document.getElementById('current-thread-title'),
  currentWorkspaceBadge: document.getElementById('current-workspace-badge'),
  wsStatusDot: document.getElementById('ws-status-dot'),
  btnE2EKey: document.getElementById('btn-e2e-key'),
  btnDshWeb: document.getElementById('btn-dsh-web'),
  btnNewThread: document.getElementById('btn-new-thread'),
  untrustedBanner: document.getElementById('untrusted-banner'),
  e2eBanner: document.getElementById('e2e-banner'),
  btnBannerE2E: document.getElementById('btn-banner-e2e'),
  chatContainer: document.getElementById('chat-container'),
  chatEmpty: document.getElementById('chat-empty'),
  quickWorkspaces: document.getElementById('quick-workspaces'),
  chatMessages: document.getElementById('chat-messages'),
  threadStatus: document.getElementById('thread-status'),
  btnLoadHistory: document.getElementById('btn-load-history'),
  btnMoreThreads: document.getElementById('btn-more-threads'),
  btnPendingRequests: document.getElementById('btn-pending-requests'),
  btnJumpLatest: document.getElementById('btn-jump-latest'),
  modelSelect: document.getElementById('model-select'),
  effortSelect: document.getElementById('effort-select'),
  promptInput: document.getElementById('prompt-input'),
  btnStopTurn: document.getElementById('btn-stop-turn'),
  btnSend: document.getElementById('btn-send'),
  modalE2E: document.getElementById('modal-e2e'),
  inputE2EKey: document.getElementById('input-e2e-key'),
  e2eFingerprintHint: document.getElementById('e2e-fingerprint-hint'),
  btnCloseE2E: document.getElementById('btn-close-e2e'),
  btnSaveE2E: document.getElementById('btn-save-e2e'),
  modalDir: document.getElementById('modal-dir'),
  inputDirPath: document.getElementById('input-dir-path'),
  btnDirGo: document.getElementById('btn-dir-go'),
  dirEntriesList: document.getElementById('dir-entries-list'),
  btnCloseDir: document.getElementById('btn-close-dir'),
  btnSelectDir: document.getElementById('btn-select-dir'),
};

function getStoredE2EKey(agentId) {
  if (!agentId) return '';
  return localStorage.getItem(`codex_e2e_key_${agentId}`) || '';
}

function setStoredE2EKey(agentId, key) {
  if (!agentId) return;
  localStorage.setItem(`codex_e2e_key_${agentId}`, key.trim());
}

function getSelectedAgent() {
  return state.agents.find((a) => a.agentId === state.selectedAgentId) || null;
}

function updateBanners() {
  const untrustedOnline = state.agents.filter((a) => a.online && !a.trusted);
  if (untrustedOnline.length > 0) {
    const first = untrustedOnline[0];
    el.untrustedBanner.classList.remove('hidden');
    el.untrustedBanner.innerHTML = `
      <span>发现本机设备接入：<b>${escapeHtml(first.name)}</b> (${escapeHtml(first.platform)})</span>
      <button class="btn-small" id="btn-trust-now">信任并绑定</button>
    `;
    document.getElementById('btn-trust-now').onclick = () => trustAgent(first.agentId, true);
  } else {
    el.untrustedBanner.classList.add('hidden');
  }

  const currentAgent = getSelectedAgent();
  const dshAvailable = currentAgent?.online && currentAgent.trusted && currentAgent.dshWeb?.enabled;
  el.btnDshWeb.classList.toggle('hidden', !dshAvailable);
  el.btnDshWeb.href = currentAgent ? `/dsh/${encodeURIComponent(currentAgent.agentId)}/` : '#';
  el.btnDshWeb.title = currentAgent?.dshWeb?.status === 'ready' ? '打开 DSH Web' : 'DSH Web 正在启动或重连';
  if (currentAgent && currentAgent.online && currentAgent.trusted && currentAgent.requiresE2E) {
    const key = getStoredE2EKey(currentAgent.agentId);
    const matchesFingerprint =
      key && (!currentAgent.e2eKeyFingerprint || sha256Hex(key).slice(0, 10) === currentAgent.e2eKeyFingerprint);
    if (!matchesFingerprint) {
      el.e2eBanner.classList.remove('hidden');
    } else {
      el.e2eBanner.classList.add('hidden');
    }
  } else {
    el.e2eBanner.classList.add('hidden');
  }
}

async function trustAgent(agentId, trusted) {
  const res = await fetch('/api/agents/trust', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, trusted }),
  });
  const data = await res.json();
  if (data.ok && Array.isArray(data.agents)) {
    handleAgentsList(data.agents);
  }
}

function buildE2EEnvelope(agentId, payloadObj) {
  const key = getStoredE2EKey(agentId);
  if (!key) return null;
  const timestamp = Date.now();
  const nonce = `${timestamp}_${Math.random().toString(36).slice(2, 10)}`;
  const bodyString = JSON.stringify(payloadObj);
  const signature = hmacSha256Hex(key, `${timestamp}.${nonce}.${bodyString}`);
  return { timestamp, nonce, signature };
}

function sendCodexRpc(method, params = {}, agentId = state.selectedAgentId) {
  return new Promise((resolve, reject) => {
    const agent = state.agents.find((a) => a.agentId === agentId);
    if (!agent || !agent.online) return reject(new Error('当前未连接在线的本机 Agent'));
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      return reject(new Error('云端 WebSocket 未连接'));
    }
    const id = `req_${++state.reqSeq}_${Date.now()}`;
    const payload = { id, method, params };
    const timer = setTimeout(() => {
      const pending = state.pendingRpc.get(id);
      if (!pending) return;
      state.pendingRpc.delete(id);
      pending.reject(new Error('请求超时，请刷新会话确认执行状态后再重试'));
    }, 60000);
    state.pendingRpc.set(id, { resolve, reject, timer, agentId });
    try {
      state.ws.send(JSON.stringify({
        type: 'client/rpc', agentId, payload, e2e: buildE2EEnvelope(agentId, payload),
      }));
    } catch (err) {
      clearTimeout(timer);
      state.pendingRpc.delete(id);
      reject(err);
    }
  });
}

function rejectPendingRpc(message) {
  for (const pending of state.pendingRpc.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(message));
  }
  state.pendingRpc.clear();
}

async function submitInteraction(request, response, view) {
  // Do not hide or forget a request until the Agent confirms that Codex resolved it.
  const result = await sendCodexRpc('remote/respondToRequest', {
    requestId: request.id, requestEpoch: request.requestEpoch, ...response,
  }, view.agentId);
  if (!result?.resolved) throw new Error('未收到处理确认，交互已保留');
  resolveInteraction(view, request.id, 'Codex 已确认处理', request.requestEpoch);
  return result;
}

function resolveInteraction(view, requestId, message = '请求已结束', epoch) {
  const pending = view.approvals.get(requestId);
  if (epoch !== undefined && pending && pending.requestEpoch !== epoch) return;
  view.approvals.delete(requestId);
  view.interactionCards.get(requestId)?.resolve(message);
  updatePendingIndicators(view);
}

async function syncAgentState(agentId = state.selectedAgentId) {
  if (!agentId) return;
  if (state.agentSyncs.has(agentId)) return state.agentSyncs.get(agentId);
  const operation = (async () => {
    try {
      const snapshot = await sendCodexRpc('remote/getAgentState', {}, agentId);
      applyAgentState(snapshot, agentId);
    } catch (error) {
      if (state.currentView?.agentId === agentId) {
        state.currentView.syncError = `同步执行状态失败：${error.message}。请确认本机 codex-up 已更新并重启。`;
        syncThreadControls();
      }
    } finally { state.agentSyncs.delete(agentId); }
  })();
  state.agentSyncs.set(agentId, operation);
  return operation;
}

function applyAgentState(snapshot, agentId) {
  if (!snapshot || !snapshot.epoch || !Array.isArray(snapshot.requests)) return;
  const previous = state.agentStates.get(agentId);
  if (previous?.epoch === snapshot.epoch && previous.revision > snapshot.revision) return;
  state.agentStates.set(agentId, snapshot);
  const running = new Map((snapshot.activeTurns || []).map((turn) => [turn.threadId, turn]));
  const pendingIds = new Set(snapshot.requests.map((request) => JSON.stringify([request.requestEpoch, request.id])));
  for (const view of state.threadViews.values()) {
    if (view.agentId !== agentId) continue;
    view.syncError = null;
    const turn = running.get(view.threadId);
    if (previous && (previous.epoch !== snapshot.epoch || snapshot.status === 'error') && view.activeTurnId) {
      view.runStatus = snapshot.status === 'error' ? 'failed' : 'interrupted';
      appendSystemNotice('本机 Codex 已重启，原任务已中断；历史已保留，请确认状态后继续。', view);
    }
    view.activeTurnId = turn?.turnId || (turn ? 'active' : null);
    if (turn) { view.runStatus = turn.status || 'running'; view.retryMessage = turn.message || ''; }
    view.statusRevision++;
    if (snapshot.status === 'error') view.syncError = snapshot.error || '本机 Codex 正在恢复';
    for (const [id, request] of view.approvals) {
      if (!pendingIds.has(JSON.stringify([request.requestEpoch, id]))) resolveInteraction(view, id);
    }
  }
  for (const turn of running.values()) {
    const view = getThreadView(turn.threadId, agentId);
    view.activeTurnId = turn.turnId || 'active'; view.runStatus = turn.status || 'running';
  }
  for (const request of snapshot.requests) {
    const threadId = request.params?.threadId || request.params?.thread_id || null;
    handleServerRequest(request, getThreadView(threadId, agentId));
  }
  syncThreadControls();
}

// === WebSocket Connection ===
function connectRelayWebSocket() {
  if (state.ws) {
    try { state.ws.close(); } catch {}
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws/client`);
  state.ws = ws;

  ws.onopen = () => {
    if (state.ws !== ws) return;
    el.wsStatusDot.className = 'status-dot online';
  };

  ws.onclose = () => {
    if (state.ws !== ws) return;
    rejectPendingRpc('连接已断开，请重新打开会话确认执行状态');
    for (const view of state.threadViews.values()) view.historyLoadedAt = 0;
    el.wsStatusDot.className = 'status-dot offline';
    setTimeout(() => {
      if (!el.appView.classList.contains('hidden')) {
        connectRelayWebSocket();
      }
    }, 2500);
  };

  ws.onmessage = (ev) => {
    if (state.ws !== ws) return;
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (msg.type === 'relay/welcome' || msg.type === 'relay/agents') {
      handleAgentsList(msg.agents || []);
      if (msg.type === 'relay/welcome') syncAgentState();
      if (msg.type === 'relay/welcome' && state.currentView?.threadId) {
        const view = state.currentView;
        openExistingThread(state.threads.find((thread) => thread.id === view.threadId) || { id: view.threadId });
      }
      return;
    }

    if (msg.type === 'relay/error' || msg.type === 'relay/e2e_error') {
      const reqId = msg.requestId;
      if (reqId && state.pendingRpc.has(reqId)) {
        const h = state.pendingRpc.get(reqId);
        state.pendingRpc.delete(reqId);
        clearTimeout(h.timer);
        h.reject(new Error(msg.error || msg.reason));
      }
      if (msg.type === 'relay/e2e_error') {
        openE2EModal(msg.reason);
      } else if (msg.error) {
        appendSystemNotice(`错误: ${msg.error}`);
      }
      return;
    }

    if (msg.type === 'relay/rpc') {
      handleIncomingCodexPayload(msg.payload, msg.agentId);
      return;
    }

    // Responses from another browser are only hints. The authoritative resolved
    // event / Agent snapshot controls pending cards after local E2E verification.
    if (msg.type === 'relay/client_sync') return;
  };
}

function handleAgentsList(agents) {
  const previousAgentId = state.selectedAgentId;
  state.agents = agents;
  const onlineTrusted = agents.filter((a) => a.online && a.trusted);
  const current = agents.find((a) => a.agentId === state.selectedAgentId);

  if (!current || (!current.online && onlineTrusted.length > 0)) {
    state.selectedAgentId = (onlineTrusted[0] || agents[0])?.agentId || null;
    if (state.selectedAgentId) {
      localStorage.setItem('codex_selected_agent', state.selectedAgentId);
    }
  }

  if (previousAgentId !== state.selectedAgentId) {
    state.projects = []; state.threads = []; state.models = []; state.threadsNextCursor = null;
    state.restoreAgentId = state.selectedAgentId;
    activateThreadView(createThreadView(), { remember: false });
    el.currentThreadTitle.textContent = '选择或新建会话';
  }

  el.agentSelect.innerHTML = '';
  if (agents.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '等待本机运行 codex-up...';
    el.agentSelect.appendChild(opt);
  } else {
    for (const a of agents) {
      const opt = document.createElement('option');
      opt.value = a.agentId;
      const statusText = a.online ? (a.trusted ? '[在线]' : '[待信任]') : '[离线]';
      const prof = a.profile ? ` (${a.profile})` : '';
      opt.textContent = `${statusText} ${a.name}${prof}`;
      if (a.agentId === state.selectedAgentId) opt.selected = true;
      el.agentSelect.appendChild(opt);
    }
  }

  updateBanners();

  const active = getSelectedAgent();
  if (active && active.online && active.trusted) {
    loadWorkspacesAndThreads();
    syncAgentState(active.agentId);
  }
  syncThreadControls();
}

async function loadWorkspacesAndThreads({ more = false } = {}) {
  const agentId = state.selectedAgentId;
  if (more && (!state.threadsNextCursor || state.loadingThreads)) return;
  state.loadingThreads = true;
  el.btnMoreThreads.disabled = true;
  try {
    const res = await sendCodexRpc('remote/getWorkspacesAndThreads', {
      limit: 100, cursor: more ? state.threadsNextCursor : undefined,
    }, agentId);
    if (agentId !== state.selectedAgentId) return;
    const projects = new Map((more ? state.projects : []).map((project) => [project.id, project]));
    for (const project of res.projects || []) projects.set(project.id, project);
    state.projects = [...projects.values()];
    const threads = new Map((more ? state.threads : []).map((thread) => [thread.id, thread]));
    for (const thread of res.threads || []) threads.set(thread.id, thread);
    state.threads = [...threads.values()];
    state.threadsNextCursor = res.nextCursor || null;
    el.btnMoreThreads.classList.toggle('hidden', !state.threadsNextCursor);
    if (Array.isArray(res.models) && res.models.length > 0) {
      state.models = res.models;
    }
    if (!localStorage.getItem('codex_selected_model') && res.currentModel) {
      state.selectedModel = res.currentModel;
    }
    if (!localStorage.getItem('codex_selected_effort') && res.currentEffort) {
      state.selectedEffort = res.currentEffort;
    }
    if (!state.selectedCwd) {
      state.selectedCwd =
        state.projects[0]?.rootPaths?.[0] || res.defaultCwd || getSelectedAgent()?.defaultCwd || '/';
    }
    renderModelAndEffortSelectors();
    updateTopbarWorkspace();
    renderWorkspacesDrawer();
    renderQuickWorkspaces();
    if (!more && (!state.currentView || state.restoreAgentId === agentId)) {
      const saved = localStorage.getItem(`codex_selected_thread_${agentId}`);
      state.restoreAgentId = null;
      if (saved) openExistingThread(state.threads.find((thread) => thread.id === saved) || { id: saved });
    }
  } catch (err) {
    if (agentId === state.selectedAgentId) appendSystemNotice(`加载会话列表失败：${err.message}`);
  } finally {
    if (agentId === state.selectedAgentId) { state.loadingThreads = false; el.btnMoreThreads.disabled = false; }
  }
}

function renderModelAndEffortSelectors() {
  if (!el.modelSelect || !el.effortSelect) return;

  const modelList =
    state.models.length > 0
      ? [...state.models]
      : [
          { id: 'gpt-6-astra', displayName: 'GPT-6-Astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
          { id: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
          { id: 'gpt-6.1-terra', displayName: 'GPT-6.1 Terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
          { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
        ];

  if (state.selectedModel && !modelList.some((m) => m.id === state.selectedModel)) {
    modelList.unshift({
      id: state.selectedModel,
      displayName: state.selectedModel,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    });
  }

  el.modelSelect.innerHTML = '';
  for (const m of modelList) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.displayName || m.id;
    if (m.id === state.selectedModel) opt.selected = true;
    el.modelSelect.appendChild(opt);
  }

  const activeModelObj = modelList.find((m) => m.id === state.selectedModel) || modelList[0];
  const efforts =
    activeModelObj?.efforts?.length > 0
      ? activeModelObj.efforts
      : ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

  el.effortSelect.innerHTML = '';
  for (const eff of efforts) {
    const opt = document.createElement('option');
    opt.value = eff;
    opt.textContent = EFFORT_LABELS[eff] || eff;
    if (eff === state.selectedEffort) opt.selected = true;
    el.effortSelect.appendChild(opt);
  }
}

function updateTopbarWorkspace() {
  const cwd = state.selectedCwd || getSelectedAgent()?.defaultCwd || '/';
  const matchedProj = state.projects.find((p) => p.rootPaths?.includes(cwd));
  el.currentWorkspaceBadge.textContent = matchedProj
    ? `${matchedProj.name} · ${cwd}`
    : cwd;
}

function renderQuickWorkspaces() {
  el.quickWorkspaces.innerHTML = '';
  for (const proj of state.projects.slice(0, 6)) {
    const root = proj.rootPaths?.[0] || '';
    const count = state.threads.filter(
      (t) => t.projectId === proj.id || (root && t.cwd === root)
    ).length;
    const card = document.createElement('div');
    card.className = 'quick-ws-card';
    card.innerHTML = `
      <div>
        <div style="font-weight:600;color:var(--text-primary)">${escapeHtml(proj.name)}</div>
        <div style="font-size:11px;color:var(--text-secondary)">${escapeHtml(root)}</div>
      </div>
      <span style="font-size:12px;color:var(--accent)">${count} 个会话 →</span>
    `;
    card.onclick = () => {
      state.selectedCwd = root;
      localStorage.setItem('codex_selected_cwd', root);
      updateTopbarWorkspace();
      openDrawer();
    };
    el.quickWorkspaces.appendChild(card);
  }
}

function renderWorkspacesDrawer() {
  const q = (el.threadSearchInput.value || '').trim().toLowerCase();
  el.workspacesContainer.innerHTML = '';

  const groups = new Map();
  for (const p of state.projects) {
    groups.set(p.id, { project: p, threads: [] });
  }

  const unassigned = [];
  const listedThreads = [...state.threads];
  for (const view of state.threadViews.values()) {
    if (view.agentId === state.selectedAgentId && pendingQuestionCards(view).length &&
        !listedThreads.some((thread) => thread.id === view.threadId)) {
      listedThreads.push({ id: view.threadId, name: view.threadId ? `会话 ${view.threadId.slice(0, 8)}` : '设备待处理请求' });
    }
  }
  for (const t of listedThreads) {
    const titleText = (t.name || t.preview || t.id || '').toLowerCase();
    const cwdText = (t.cwd || '').toLowerCase();
    if (q && !titleText.includes(q) && !cwdText.includes(q)) continue;

    if (t.projectId && groups.has(t.projectId)) {
      groups.get(t.projectId).threads.push(t);
    } else {
      unassigned.push(t);
    }
  }

  if (unassigned.length > 0) {
    groups.set('__other__', {
      project: { id: '__other__', name: '其他目录会话', rootPaths: [] },
      threads: unassigned,
    });
  }

  for (const [gid, { project, threads }] of groups.entries()) {
    if (q && threads.length === 0) continue;
    const isCollapsed = state.collapsedWorkspaces.has(gid) && !q;
    const primaryRoot = project.rootPaths?.[0] || threads[0]?.cwd || '';

    const groupEl = document.createElement('div');
    groupEl.className = 'workspace-group';

    const headerEl = document.createElement('div');
    headerEl.className = 'workspace-header';
    headerEl.innerHTML = `
      <div class="workspace-title-wrap">
        <div class="workspace-name">
          <span>${isCollapsed ? '▸' : '▾'} ${escapeHtml(project.name)}</span>
          <span style="color:var(--text-secondary);font-weight:400;font-size:11px">(${threads.length})</span>
        </div>
        <div class="workspace-path">${escapeHtml(primaryRoot)}</div>
      </div>
    `;
    const groupPending = threads.reduce((count, thread) => count + threadPendingCount(thread.id), 0);
    if (groupPending) headerEl.appendChild(createPendingBadge(groupPending));

    if (primaryRoot) {
      const newBtn = document.createElement('button');
      newBtn.className = 'workspace-new-btn';
      newBtn.textContent = '+ 新建';
      newBtn.onclick = (e) => {
        e.stopPropagation();
        startNewThreadInWorkspace(primaryRoot, project.name);
      };
      headerEl.appendChild(newBtn);
    }

    headerEl.onclick = () => {
      if (state.collapsedWorkspaces.has(gid)) state.collapsedWorkspaces.delete(gid);
      else state.collapsedWorkspaces.add(gid);
      renderWorkspacesDrawer();
    };
    groupEl.appendChild(headerEl);

    if (!isCollapsed) {
      for (const t of threads) {
        const itemEl = document.createElement('div');
        itemEl.className = `thread-item ${t.id === state.currentThreadId ? 'active' : ''}`;
        itemEl.dataset.threadId = t.id || '';
        const displayTitle = (t.name || t.preview || '新对话').replace(/\s+/g, ' ').slice(0, 60);
        const dateStr = t.updatedAt ? formatRelativeTime(t.updatedAt * 1000) : '';
        const modelInfo = [t.model || t.modelProvider || '', t.reasoningEffort || '']
          .filter(Boolean)
          .join(' · ');
        itemEl.innerHTML = `
          <div class="thread-item-meta">
            <span class="thread-model-tag">${escapeHtml(modelInfo || 'default')}</span>
            <span>${escapeHtml(dateStr)}</span>
          </div>
        `;
        const titleRow = document.createElement('div'); titleRow.className = 'thread-item-heading';
        const title = document.createElement('div'); title.className = 'thread-item-title'; title.textContent = displayTitle;
        titleRow.appendChild(title);
        const count = threadPendingCount(t.id);
        if (count) titleRow.appendChild(createPendingBadge(count));
        itemEl.prepend(titleRow);
        itemEl.onclick = () => {
          closeDrawer();
          if (t.id) openExistingThread(t);
          else { activateThreadView(getThreadView(null)); el.currentThreadTitle.textContent = '设备待处理请求'; }
        };
        groupEl.appendChild(itemEl);
      }
    }

    el.workspacesContainer.appendChild(groupEl);
  }
}

// Each thread retains its messages, pending sends, turn and approvals while detached.
function createThreadView(threadId = null, agentId = state.selectedAgentId) {
  const messages = document.createElement('div');
  messages.className = 'thread-messages';
  return {
    threadId, agentId, messages, itemElements: new Map(), optimisticUserBubbles: [],
    activeTurnId: null, sending: false, approvals: new Map(), revision: 0,
    interactionCards: new Map(), runStatus: null, retryMessage: '', syncError: null,
    asyncQuestions: new Map(), answeredAsyncQuestions: new Set(),
    followOutput: true, scrollTop: 0, historyOrder: [], historyCursor: null, historyAnchor: null,
    historyLoading: false, historyLoadedAt: 0, historyVersions: new Map(),
    statusRevision: 0, itemRevisions: new Map(), itemTurnIds: new Map(), historyRequest: 0,
    reasoningSummaries: new Map(), pendingCount: 0,
  };
}

function getThreadView(threadId, agentId = state.selectedAgentId) {
  const key = JSON.stringify([agentId, threadId]);
  if (!state.threadViews.has(key)) state.threadViews.set(key, createThreadView(threadId, agentId));
  return state.threadViews.get(key);
}

function activateThreadView(view, { remember = true } = {}) {
  if (state.currentView) state.currentView.scrollTop = el.chatContainer.scrollTop || 0;
  state.currentView = view;
  state.currentThreadId = view.threadId;
  el.chatMessages.replaceChildren(view.messages);
  el.chatContainer.scrollTop = view.scrollTop;
  if (remember) {
    state.restoreAgentId = null;
    const key = `codex_selected_thread_${view.agentId}`;
    if (view.threadId) localStorage.setItem(key, view.threadId);
    else localStorage.removeItem(key);
  }
  syncThreadControls();
}

function pendingQuestionCards(view) {
  if (!view) return [];
  return [...view.approvals.keys()].map((id) => view.interactionCards.get(id)).filter(Boolean)
    .concat([...view.asyncQuestions.values()].filter((entry) => !entry.answered).map((entry) => entry.card));
}

function threadPendingCount(threadId) {
  return pendingQuestionCards(state.threadViews.get(JSON.stringify([state.selectedAgentId, threadId]))).length;
}

function createPendingBadge(count) {
  const badge = document.createElement('span'); badge.className = 'thread-pending-badge';
  badge.textContent = `${count} 项待处理`;
  return badge;
}

function updatePendingIndicators(view) {
  const count = pendingQuestionCards(view).length;
  if (view.pendingCount !== count) {
    view.pendingCount = count;
    if (view.agentId === state.selectedAgentId) renderWorkspacesDrawer();
  }
  if (state.currentView === view) syncThreadControls();
}

function syncThreadControls() {
  const view = state.currentView;
  state.activeTurnId = view?.activeTurnId || null;
  const currentRequests = pendingQuestionCards(view).length;
  el.btnPendingRequests.classList.toggle('hidden', currentRequests === 0);
  el.btnPendingRequests.textContent = `${currentRequests} 项待处理`;
  el.btnStopTurn.classList.toggle('hidden', !state.activeTurnId || state.activeTurnId === 'active');
  el.btnSend.disabled = Boolean(view?.sending);
  el.btnSend.textContent = view?.sending ? '发送中' : view?.activeTurnId ? '追加' : '发送';
  el.promptInput.placeholder = view?.activeTurnId ? '追加要求（回答问题请使用问答卡片）…' : '输入指令…';
  el.modelSelect.disabled = Boolean(view?.activeTurnId);
  el.effortSelect.disabled = Boolean(view?.activeTurnId);
  const terminal = { failed: '执行失败', interrupted: '任务已停止', completed: '本轮已完成' };
  el.threadStatus.textContent = view?.syncError || (view?.sending ? '正在提交消息…' : currentRequests ?
    `有 ${currentRequests} 项等待你的操作` : view?.runStatus === 'retrying' ? `正在重连，任务仍在重试：${view.retryMessage || ''}` :
    view?.activeTurnId ? '正在执行…' : terminal[view?.runStatus] || '');
  el.threadStatus.classList.toggle('hidden', !el.threadStatus.textContent);
  el.btnLoadHistory.classList.toggle('hidden', !view?.historyCursor);
  el.btnLoadHistory.disabled = Boolean(view?.historyLoading);
  el.btnJumpLatest.classList.toggle('hidden', !view || view.followOutput);
}

async function startNewThreadInWorkspace(cwd, projectName) {
  state.selectedCwd = cwd;
  localStorage.setItem('codex_selected_cwd', cwd);
  activateThreadView(createThreadView());
  el.chatEmpty.classList.add('hidden');
  el.currentThreadTitle.textContent = `新对话 · ${projectName || cwd.split('/').pop()}`;
  updateTopbarWorkspace();
  renderWorkspacesDrawer();
  closeDrawer();
  el.promptInput.focus();
}

async function openExistingThread(threadSummary) {
  const view = getThreadView(threadSummary.id);
  activateThreadView(view);
  if (threadSummary.cwd) {
    state.selectedCwd = threadSummary.cwd;
    localStorage.setItem('codex_selected_cwd', threadSummary.cwd);
  }
  if (threadSummary.model) state.selectedModel = threadSummary.model;
  if (threadSummary.reasoningEffort) state.selectedEffort = threadSummary.reasoningEffort;
  renderModelAndEffortSelectors();
  el.currentThreadTitle.textContent =
    (threadSummary.name || threadSummary.preview || '对话详情').replace(/\s+/g, ' ').slice(0, 50);
  updateTopbarWorkspace();
  renderWorkspacesDrawer();
  el.chatEmpty.classList.add('hidden');

  // Detached DOM is shown immediately. Rapid switches reuse the recent page;
  // explicit sync and later opens still refresh it, while live events keep flowing.
  if (!view.historyLoading && Date.now() - view.historyLoadedAt > 15000) await loadThreadHistory(view);
}

async function loadThreadStatus(view, request) {
  const statusRevision = view.statusRevision;
  try {
    const response = await sendCodexRpc('thread/turns/list', {
      threadId: view.threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded',
    }, view.agentId);
    if (request !== view.historyRequest || view.statusRevision !== statusRevision) return;
    const latest = response?.data?.[0];
    if (!latest) return;
    view.activeTurnId = latest.status === 'inProgress' ? latest.id : null;
    view.runStatus = latest.status === 'inProgress' ? 'running' : latest.status;
    if (state.currentView === view) syncThreadControls();
  } catch { /* History remains readable; Agent snapshots also restore execution state. */ }
}

async function loadThreadHistory(view, { older = false } = {}) {
  if (view.historyLoading || (older && !view.historyCursor)) return;
  const request = ++view.historyRequest;
  const revision = view.revision;
  const beforeHeight = el.chatContainer.scrollHeight || 0;
  const beforeTop = el.chatContainer.scrollTop || 0;
  view.historyLoading = true;
  if (state.currentView === view) syncThreadControls();
  try {
    // Item pagination preserves native async questions without hydrating 20 full
    // turns (which can contain hundreds of tool results). Status is independent.
    const pending = sendCodexRpc('thread/items/list', {
      threadId: view.threadId, limit: 60, sortDirection: 'desc', cursor: older ? view.historyCursor : undefined,
    }, view.agentId);
    if (!older) void loadThreadStatus(view, request);
    const response = await pending;
    if (request !== view.historyRequest) return;
    const entries = (response?.data || []).slice().reverse();
    const items = entries.map((entry) => entry.item || entry).filter(Boolean);
    const overlapsHistory = items.some((item) => view.historyVersions.has(item.id));
    for (const entry of entries) {
      if (entry.item?.id && entry.turnId) view.itemTurnIds.set(entry.item.id, entry.turnId);
    }
    for (const item of items) {
      const live = view.itemElements.get(item.id);
      const isOlderText = item.type === 'agentMessage' && live?.dataset.markdown &&
        live.dataset.markdown.startsWith(item.text || '') && live.dataset.markdown.length > (item.text || '').length;
      if ((view.itemRevisions.get(item.id) || 0) <= revision && !isOlderText) {
        const version = JSON.stringify(item);
        if (view.historyVersions.get(item.id) !== version) {
          renderThreadItem(item, view, view.itemTurnIds.get(item.id) || null);
          view.historyVersions.set(item.id, version);
        }
      }
    }
    const ids = items.map((item) => item.id).filter((id) => view.itemElements.has(id));
    const incoming = new Set(ids);
    const previousOrder = view.historyOrder;
    const existing = view.historyOrder.filter((id) => !incoming.has(id));
    if (older) {
      const anchor = existing.indexOf(view.historyAnchor);
      existing.splice(Math.max(0, anchor), 0, ...new Set(ids));
      view.historyOrder = existing;
    } else view.historyOrder = [...existing, ...new Set(ids)];
    if (previousOrder.length !== view.historyOrder.length || previousOrder.some((id, index) => id !== view.historyOrder[index])) {
      const history = document.createDocumentFragment();
      for (const id of view.historyOrder) {
        const element = view.itemElements.get(id);
        if (element) history.appendChild(element);
      }
      view.messages.prepend(history);
    }
    // Refreshing the latest page must not reset pagination of already read pages.
    if (older || !view.historyLoadedAt || !overlapsHistory) {
      view.historyCursor = response?.nextCursor || null;
      view.historyAnchor = ids[0] || view.historyAnchor;
    }
    if (!older) view.historyLoadedAt = Date.now();
    if (state.currentView === view) {
      if (older || !view.followOutput) el.chatContainer.scrollTop = beforeTop + (el.chatContainer.scrollHeight || 0) - beforeHeight;
      else scrollToBottom();
    }
  } catch (err) {
    if (request === view.historyRequest) appendSystemNotice(`加载会话失败: ${err.message}`, view);
  } finally {
    if (request === view.historyRequest) view.historyLoading = false;
    if (state.currentView === view) syncThreadControls();
  }
}

function handleIncomingCodexPayload(payload, agentId = state.selectedAgentId) {
  if (!payload || typeof payload !== 'object') return;
  if (payload.id !== undefined && payload.method === undefined && state.pendingRpc.has(payload.id)) {
    const handler = state.pendingRpc.get(payload.id);
    if (handler.agentId !== agentId) return;
    state.pendingRpc.delete(payload.id);
    clearTimeout(handler.timer);
    if (payload.error) handler.reject(new Error(payload.error.message || JSON.stringify(payload.error)));
    else handler.resolve(payload.result);
    return;
  }
  if (payload.id !== undefined && typeof payload.method === 'string') {
    const threadId = payload.params?.threadId || payload.params?.thread_id;
    const view = getThreadView(threadId || null, agentId);
    if (view) handleServerRequest(payload, view);
    return;
  }
  const { method, params } = payload;
  if (!method || !params) return;
  if (method === 'remote/agentState') { applyAgentState(params, agentId); return; }
  if (method === 'remote/threadForked') {
    const oldKey = JSON.stringify([agentId, params.oldThreadId]);
    const view = state.threadViews.get(oldKey);
    if (view && params.newThreadId) {
      state.threadViews.delete(oldKey);
      view.threadId = params.newThreadId;
      state.threadViews.set(JSON.stringify([agentId, view.threadId]), view);
      if (state.currentView === view) {
        state.currentThreadId = view.threadId;
        localStorage.setItem(`codex_selected_thread_${agentId}`, view.threadId);
      }
      appendSystemNotice('该会话正在本机桌面端占用，已自动分叉并接续上下文。', view);
      if (agentId === state.selectedAgentId) loadWorkspacesAndThreads();
    }
    return;
  }
  if (method === 'serverRequest/resolved') {
    for (const view of state.threadViews.values()) {
      if (view.agentId === agentId) resolveInteraction(view, params.requestId, '请求已结束', payload.requestEpoch);
    }
    syncThreadControls();
    return;
  }
  if (!params.threadId) return;
  const view = getThreadView(params.threadId, agentId);
  if (method === 'turn/started') {
    view.statusRevision++;
    view.activeTurnId = params.turn?.id || params.turnId || 'active';
    view.runStatus = 'running'; view.retryMessage = '';
  } else if (method === 'turn/completed') {
    view.statusRevision++;
    view.activeTurnId = null;
    view.runStatus = params.turn?.status === 'failed' ? 'failed' : params.turn?.status === 'interrupted' ? 'interrupted' : 'completed';
    for (const id of view.approvals.keys()) resolveInteraction(view, id, '本轮已结束');
    if (params.turn?.error) appendSystemNotice(`执行失败: ${params.turn.error.message || '未知错误'}`, view);
  } else if (method === 'thread/status/changed') {
    view.statusRevision++;
    const status = params.status?.type;
    if (['idle', 'notLoaded', 'systemError'].includes(status)) view.activeTurnId = null;
    else if (status === 'active' && !view.activeTurnId) view.activeTurnId = 'active';
  } else if ((method === 'item/started' || method === 'item/completed') && params.item) {
    view.historyVersions.delete(params.item.id);
    view.itemRevisions.set(params.item.id, ++view.revision);
    renderThreadItem(params.item, view);
    if (view.activeTurnId) view.runStatus = 'running';
  } else if (method === 'item/agentMessage/delta') {
    view.historyVersions.delete(params.itemId);
    view.itemRevisions.set(params.itemId, ++view.revision);
    appendAgentDelta(params.itemId, params.delta || '', view);
    if (view.activeTurnId) view.runStatus = 'running';
  } else if (method === 'item/commandExecution/outputDelta') {
    view.itemRevisions.set(params.itemId, ++view.revision);
    appendCommandDelta(params.itemId, params.delta || '', view);
  } else if (method === 'turn/plan/updated') {
    renderThreadItem({ id: `plan_${params.turnId}`, type: 'plan', plan: params.plan, text: params.explanation }, view);
  } else if (method === 'turn/diff/updated') {
    renderThreadItem({ id: `diff_${params.turnId}`, type: 'aggregateDiff', diff: params.diff, status: 'updated' }, view);
  } else if (method === 'item/mcpToolCall/progress') {
    appendToolProgress(params.itemId, params.message || params.progress || '', view);
  } else if (method === 'item/reasoning/summaryTextDelta' && params.itemId) {
    view.itemRevisions.set(params.itemId, ++view.revision);
    view.historyVersions.delete(params.itemId);
    const summary = view.reasoningSummaries.get(params.itemId) || [];
    const index = Number.isInteger(params.summaryIndex) && params.summaryIndex >= 0 ? params.summaryIndex : 0;
    summary[index] = (summary[index] || '') + (params.delta || '');
    renderOtherItem({ id: params.itemId, type: 'reasoning', summary }, view);
  } else if (method === 'error') {
    const message = params.error?.message || params.message || '未知错误';
    view.runStatus = params.willRetry ? 'retrying' : 'failed';
    view.retryMessage = params.willRetry ? message : '';
    if (!params.willRetry) appendSystemNotice(`执行失败: ${message}`, view);
  } else if (method === 'warning' || method === 'model/rerouted') {
    appendSystemNotice(params.message || `模型已切换为 ${params.toModel || ''}：${params.reason || ''}`, view);
  }
  if (state.currentView === view) {
    syncThreadControls();
    scrollToBottom();
  }
}

function handleServerRequest(request, view = state.currentView) {
  if (!view) return;
  const previous = view.approvals.get(request.id);
  if (previous && previous.requestEpoch !== request.requestEpoch) {
    resolveInteraction(view, request.id, '旧请求已失效');
    view.interactionCards.delete(request.id);
  }
  view.approvals.set(request.id, request);
  let card = view.interactionCards.get(request.id);
  if (card && card.requestEpoch !== request.requestEpoch) {
    card.resolve('旧请求已失效'); view.interactionCards.delete(request.id); card = null;
  }
  if (!card) {
    card = createInteractionCard(request, {
      onSubmit: (response) => submitInteraction(request, response, view),
      onSync: () => syncAgentState(view.agentId),
    });
    view.interactionCards.set(request.id, card);
    view.messages.appendChild(card.element);
  } else card.update(request);
  updatePendingIndicators(view);
  if (state.currentView === view) {
    el.chatEmpty.classList.add('hidden');
    syncThreadControls();
    scrollToBottom();
  }
}

// Async questions are persisted agentMessage items, not outstanding server RPCs.
// Their replies use the native client's structured user-message format.
function parseQuestionReplies(text) {
  const match = text.trim().match(/^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/);
  if (!match) return [];
  try {
    const replies = JSON.parse(match[1]);
    if (!Array.isArray(replies)) return [];
    return replies.filter((reply) => {
      if (typeof reply.questionItemId !== 'string' || typeof reply.question !== 'string' || typeof reply.answer !== 'string') return false;
      const id = JSON.parse(reply.questionItemId);
      return Array.isArray(id) && id.length === 3 && id[0] === 'request_user_input_async' && typeof id[1] === 'string' && Number.isInteger(id[2]) && id[2] >= 0;
    }).map((reply) => ({ ...reply, questionItemId: JSON.stringify(JSON.parse(reply.questionItemId)) }));
  } catch { return []; }
}

function markAsyncQuestionAnswered(view, id) {
  view.answeredAsyncQuestions.add(id);
  const entry = view.asyncQuestions.get(id);
  if (entry) { entry.answered = true; entry.card.resolve('答案已发送'); }
  updatePendingIndicators(view);
}

async function submitAsyncQuestion(view, id, question, response) {
  if (view.answeredAsyncQuestions.has(id)) return;
  if (view.sending) throw new Error('正在提交另一条消息，请稍后重试');
  if (!view.threadId) throw new Error('会话尚未就绪，请重新打开会话');
  view.sending = true;
  if (state.currentView === view) syncThreadControls();
  try {
    if (view.activeTurnId === 'active') {
      await syncAgentState(view.agentId);
      if (view.activeTurnId === 'active') throw new Error('尚未取得当前轮次 ID，请同步状态后重试');
    }
    const answer = response.result?.answers?.[id]?.answers?.[0];
    if (typeof answer !== 'string' || !answer.trim()) throw new Error('请选择或填写答案');
    const text = `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: id, question: question.title, answer }])}\n</send_user_message_question_reply>`;
    const params = { threadId: view.threadId, input: [{ type: 'text', text, text_elements: [] }],
      clientUserMessageId: `question_reply_${sha256Hex(JSON.stringify([view.agentId, view.threadId, id]))}` };
    const turnId = view.activeTurnId;
    const statusRevision = view.statusRevision;
    const result = turnId
      ? await sendCodexRpc('turn/steer', { ...params, expectedTurnId: turnId }, view.agentId)
      : await sendCodexRpc('turn/start', params, view.agentId);
    if (!turnId && view.statusRevision === statusRevision && result?.turn) {
      const terminal = ['completed', 'failed', 'interrupted'].includes(result.turn.status);
      view.activeTurnId = terminal ? null : result.turn.id;
      view.runStatus = terminal ? result.turn.status : 'running';
      view.statusRevision++;
    }
    markAsyncQuestionAnswered(view, id);
  } catch (error) {
    // A userMessage event may have already confirmed delivery before the RPC
    // connection dropped. Never reopen a confirmed answer in that case.
    if (!view.answeredAsyncQuestions.has(id)) throw error;
  } finally {
    view.sending = false;
    if (state.currentView === view) syncThreadControls();
  }
}

function renderAsyncQuestions(item, view) {
  let container = view.itemElements.get(item.id);
  if (!container) {
    container = document.createElement('div');
    view.itemElements.set(item.id, container); view.messages.appendChild(container);
  }
  if (!container.dataset.asyncQuestions) {
    container.replaceChildren(); container.className = 'async-question-message';
    container.dataset.asyncQuestions = 'true';
  }
  item.questions.forEach((question, index) => {
    const id = JSON.stringify(['request_user_input_async', item.id, index]);
    if (view.asyncQuestions.has(id)) return;
    const request = { id, method: 'item/tool/requestUserInput', params: { isBlocking: false, questions: [{
      id, header: `问题 ${index + 1}`, question: question.title, isOther: true,
      options: question.options?.map((label) => ({ label, description: '' })) || null,
    }] } };
    const card = createInteractionCard(request, {
      onSubmit: (response) => submitAsyncQuestion(view, id, question, response),
      onSync: async () => { await loadThreadHistory(view); await syncAgentState(view.agentId); },
    });
    const answered = view.answeredAsyncQuestions.has(id);
    view.asyncQuestions.set(id, { card, answered });
    container.appendChild(card.element);
    if (answered) card.resolve('答案已发送');
  });
  updatePendingIndicators(view);
}

function renderThreadItem(item, view = state.currentView, optimisticTurnId = undefined) {
  if (!view) return;
  if (!item || !item.id) return;

  if (item.type === 'userMessage') {
    let bubble = view.itemElements.get(item.id);
    const textParts = (item.content || [])
      .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
    const questionReplies = parseQuestionReplies(textParts);
    for (const reply of questionReplies) markAsyncQuestionAnswered(view, reply.questionItemId);
    const optimisticIndex = view.optimisticUserBubbles.findIndex((node) =>
      node.textContent === textParts &&
      (optimisticTurnId === undefined || node.dataset.turnId === optimisticTurnId));
    if (optimisticIndex >= 0) {
      const [optimistic] = view.optimisticUserBubbles.splice(optimisticIndex, 1);
      if (bubble && bubble !== optimistic) optimistic.remove();
      else bubble = optimistic;
      view.itemElements.set(item.id, bubble);
    }
    if (!bubble) {
      bubble = document.createElement('div');
      bubble.className = 'msg-bubble msg-user';
      view.itemElements.set(item.id, bubble);
      view.messages.appendChild(bubble);
    }
    bubble.textContent = questionReplies.length
      ? questionReplies.map((reply) => `回答「${reply.question}」：${reply.answer}`).join('\n') : textParts;
    return;
  }

  if (item.type === 'agentMessage') {
    if (item.questions?.length) { renderAsyncQuestions(item, view); return; }
    let bubble = view.itemElements.get(item.id);
    if (bubble?.dataset.asyncQuestions) return;
    if (!bubble) {
      bubble = document.createElement('div');
      bubble.className = 'msg-bubble msg-agent';
      view.itemElements.set(item.id, bubble);
      view.messages.appendChild(bubble);
    }
    if (typeof item.text === 'string' && (item.text || !bubble.dataset.markdown)) {
      bubble.dataset.markdown = item.text;
      renderMarkdown(bubble, item.text);
    }
    return;
  }

  if (item.type === 'commandExecution') {
    let card = view.itemElements.get(item.id);
    if (!card) {
      card = document.createElement('div');
      card.className = 'tool-card';
      card.innerHTML = `
        <div class="tool-card-header">
          <span class="tool-cmd"></span>
          <span class="tool-status"></span>
        </div>
        <div class="tool-card-body hidden"></div>
      `;
      card.querySelector('.tool-card-header').onclick = () => {
        card.querySelector('.tool-card-body').classList.toggle('hidden');
      };
      view.itemElements.set(item.id, card);
      view.messages.appendChild(card);
    }
    card.querySelector('.tool-cmd').textContent = `$ ${item.command || ''}`;
    const exitInfo = item.exitCode !== null && item.exitCode !== undefined ? ` (exit ${item.exitCode})` : '';
    card.querySelector('.tool-status').textContent = `${item.status || 'running'}${exitInfo}`;
    if (item.aggregatedOutput) {
      card.querySelector('.tool-card-body').textContent = item.aggregatedOutput;
    }
    return;
  }

  if (item.type === 'fileChange') {
    let card = view.itemElements.get(item.id);
    if (!card) {
      card = document.createElement('div');
      card.className = 'tool-card';
      card.innerHTML = `
        <div class="tool-card-header">
          <span class="tool-cmd"></span>
          <span class="tool-status"></span>
        </div>
        <div class="tool-card-body hidden"></div>
      `;
      card.querySelector('.tool-card-header').onclick = () => {
        card.querySelector('.tool-card-body').classList.toggle('hidden');
      };
      view.itemElements.set(item.id, card);
      view.messages.appendChild(card);
    }
    const files = (item.changes || []).map((c) => c.path).join(', ');
    card.querySelector('.tool-cmd').textContent = `修改文件: ${files || 'patch'}`;
    card.querySelector('.tool-status').textContent = item.status || 'applied';
    const diffText = (item.changes || []).map((c) => `--- ${c.path}\n${c.diff || ''}`).join('\n\n');
    card.querySelector('.tool-card-body').textContent = diffText;
  }
  if (item.type !== 'fileChange') renderOtherItem(item, view);

}

function renderOtherItem(item, view) {
  let summaryText;
  if (item.type === 'reasoning') {
    // Empty reasoning items are protocol placeholders, not visible messages.
    // Only public summaries are rendered; never use the raw content field.
    const summary = Array.isArray(item.summary) ? item.summary.map((part) => typeof part === 'string' ? part : '') : [];
    if (summary.some((part) => part.trim())) view.reasoningSummaries.set(item.id, summary);
    summaryText = (view.reasoningSummaries.get(item.id) || []).filter((part) => part.trim()).join('\n\n');
    if (!summaryText) return;
  }
  const labels = { plan: '执行计划', reasoning: '思考摘要', mcpToolCall: '工具调用', dynamicToolCall: '外部工具',
    webSearch: '网页搜索', imageGeneration: '图片生成', imageView: '查看图片', aggregateDiff: '本轮修改',
    contextCompaction: '上下文整理', collabAgentToolCall: '协作任务', functionCallOutput: '工具结果' };
  let card = view.itemElements.get(item.id);
  if (!card) {
    card = document.createElement('details'); card.className = 'tool-card generic-tool';
    const header = document.createElement('summary'); header.className = 'tool-card-header';
    const body = document.createElement('div'); body.className = 'tool-card-body';
    card.appendChild(header); card.appendChild(body);
    view.itemElements.set(item.id, card); view.messages.appendChild(card);
  }
  card.querySelector('.tool-card-header').textContent =
    [labels[item.type] || item.type, item.tool || item.name || '', item.status || ''].filter(Boolean).join(' · ');
  const body = card.querySelector('.tool-card-body');
  if (item.type === 'plan') {
    const list = (item.plan || []).map((step) => `${step.status === 'completed' ? '✓' : step.status === 'inProgress' ? '→' : '·'} ${step.step}`).join('\n');
    renderMarkdown(body, [item.text, list].filter(Boolean).join('\n\n'));
    card.open = true;
  } else if (item.type === 'reasoning') {
    renderMarkdown(body, summaryText);
  } else {
    const text = item.type === 'aggregateDiff' ? item.diff : JSON.stringify(item, null, 2);
    body.textContent = (text || '').slice(0, 100000);
  }
}

function appendToolProgress(itemId, delta, view, type = 'mcpToolCall') {
  if (!view.itemElements.has(itemId)) renderOtherItem({ id: itemId, type, status: 'inProgress' }, view);
  const body = view.itemElements.get(itemId)?.querySelector('.tool-card-body');
  if (body) body.textContent = (body.textContent + String(delta)).slice(-100000);
}

function appendAgentDelta(itemId, delta, view = state.currentView) {
  let bubble = view.itemElements.get(itemId);
  if (bubble?.dataset.asyncQuestions) return;
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.className = 'msg-bubble msg-agent';
    view.itemElements.set(itemId, bubble);
    view.messages.appendChild(bubble);
  }
  bubble.dataset.markdown = (bubble.dataset.markdown || '') + delta;
  renderMarkdown(bubble, bubble.dataset.markdown);
}

function appendCommandDelta(itemId, delta, view = state.currentView) {
  const card = view.itemElements.get(itemId);
  if (!card) return;
  const body = card.querySelector('.tool-card-body');
  if (body) body.textContent += delta;
}

function appendSystemNotice(text, view = state.currentView) {
  if (!view) {
    view = createThreadView();
    activateThreadView(view);
  }
  if (state.currentView === view) el.chatEmpty.classList.add('hidden');
  const div = document.createElement('div');
  div.className = 'msg-bubble msg-agent msg-notice';
  div.style.borderColor = 'var(--warning)';
  div.textContent = text;
  view.messages.appendChild(div);
  if (state.currentView === view) scrollToBottom();
}

function scrollToBottom(force = false) {
  const view = state.currentView;
  if (!view) return;
  if (force) view.followOutput = true;
  if (view.followOutput) el.chatContainer.scrollTop = el.chatContainer.scrollHeight;
  else el.btnJumpLatest.classList.remove('hidden');
}

async function sendUserPrompt() {
  const text = el.promptInput.value.trim();
  if (!text) return;
  const agent = getSelectedAgent();
  if (!agent || !agent.online) return appendSystemNotice('请先等待本机 Agent 在线');
  if (agent.requiresE2E && !getStoredE2EKey(agent.agentId)) {
    openE2EModal('请在本机运行 codex-up --show-pairing-key 查看并填写配对密钥');
    return;
  }
  if (!state.currentView) activateThreadView(createThreadView());
  // Capture the target and settings before the first await; navigation cannot redirect this send.
  const view = state.currentView;
  if (view.sending) return;
  const continuing = Boolean(view.activeTurnId);
  if (view.activeTurnId === 'active') {
    await syncAgentState(view.agentId);
    if (!view.activeTurnId || view.activeTurnId === 'active') {
      appendSystemNotice('尚未取得当前轮次 ID，请先同步状态后再追加要求。', view);
      return;
    }
  }
  const targetTurnId = view.activeTurnId;
  const cwd = state.selectedCwd || agent.defaultCwd || '/';
  const model = state.selectedModel || undefined;
  const effort = state.selectedEffort || undefined;
  view.statusRevision++;
  view.sending = true;
  syncThreadControls();
  el.promptInput.value = '';
  el.promptInput.style.height = 'auto';
  el.chatEmpty.classList.add('hidden');
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble msg-user';
  bubble.textContent = text;
  view.messages.appendChild(bubble);
  view.optimisticUserBubbles.push(bubble);
  scrollToBottom(true);
  try {
    if (!view.threadId) {
      const startRes = await sendCodexRpc('thread/start', { cwd, model }, view.agentId);
      const newThread = startRes.thread || startRes;
      if (!newThread.id) throw new Error('服务器未返回会话 ID');
      view.threadId = newThread.id;
      state.threadViews.set(JSON.stringify([view.agentId, view.threadId]), view);
      if (state.currentView === view) {
        state.currentThreadId = view.threadId;
        localStorage.setItem(`codex_selected_thread_${view.agentId}`, view.threadId);
        el.currentThreadTitle.textContent = text.slice(0, 40);
      }
      if (state.selectedAgentId === view.agentId) loadWorkspacesAndThreads();
    }
    const curThread = state.threads.find((t) => t.id === view.threadId);
    if (curThread && state.selectedAgentId === view.agentId) {
      curThread.model = model;
      curThread.reasoningEffort = effort;
      renderWorkspacesDrawer();
    }
    const statusRevision = view.statusRevision;
    const input = [{ type: 'text', text, text_elements: [] }];
    const result = continuing
      ? await sendCodexRpc('turn/steer', { threadId: view.threadId, expectedTurnId: targetTurnId, input }, view.agentId)
      : await sendCodexRpc('turn/start', { threadId: view.threadId, model, effort, input }, view.agentId);
    if (result?.turn?.id) {
      bubble.dataset.turnId = result.turn.id;
      for (const item of result.turn.items || []) renderThreadItem(item, view);
      // A history response may have arrived before the turn/start acknowledgement.
      for (const [itemId, turnId] of view.itemTurnIds) {
        const historical = view.itemElements.get(itemId);
        if (turnId === result.turn.id && historical?.classList.contains('msg-user') &&
            historical !== bubble && historical.textContent === text) {
          bubble.remove();
          const index = view.optimisticUserBubbles.indexOf(bubble);
          if (index >= 0) view.optimisticUserBubbles.splice(index, 1);
          break;
        }
      }
    }
    if (!continuing && view.statusRevision === statusRevision) {
      const terminalStatus = ['completed', 'failed', 'interrupted'].includes(result?.turn?.status);
      view.activeTurnId = terminalStatus ? null : result?.turn?.id || view.activeTurnId;
      view.runStatus = terminalStatus ? result.turn.status : 'running';
      view.retryMessage = '';
      view.statusRevision++;
    }
  } catch (err) {
    bubble.classList.add('msg-send-failed');
    bubble.title = '消息提交失败，请确认执行状态后重试';
    const index = view.optimisticUserBubbles.indexOf(bubble);
    if (index >= 0) view.optimisticUserBubbles.splice(index, 1);
    appendSystemNotice(`发送失败: ${err.message}`, view);
  } finally {
    view.sending = false;
    if (state.currentView === view) syncThreadControls();
  }
}

// === Drawer & Modals ===
function toggleDrawer() {
  if (window.innerWidth >= 900) {
    document.body.classList.toggle('pc-sidebar-collapsed');
  } else {
    openDrawer();
  }
}

function openDrawer() {
  if (window.innerWidth >= 900) {
    document.body.classList.remove('pc-sidebar-collapsed');
    return;
  }
  el.drawerBackdrop.classList.remove('hidden');
  el.sidebarDrawer.classList.add('open');
}

function closeDrawer() {
  el.drawerBackdrop.classList.add('hidden');
  el.sidebarDrawer.classList.remove('open');
}

function openE2EModal(hint = '') {
  const agent = getSelectedAgent();
  el.inputE2EKey.value = agent ? getStoredE2EKey(agent.agentId) : '';
  el.e2eFingerprintHint.textContent =
    hint || (agent?.e2eKeyFingerprint ? `本机密钥指纹: ${agent.e2eKeyFingerprint}` : '');
  el.modalE2E.classList.remove('hidden');
  el.inputE2EKey.focus();
}

async function openDirectoryBrowser(dirPath) {
  const agent = getSelectedAgent();
  const targetPath = dirPath || state.selectedCwd || agent?.defaultCwd || '/';
  el.inputDirPath.value = targetPath;
  el.modalDir.classList.remove('hidden');
  el.dirEntriesList.innerHTML = '<div style="padding:12px;color:var(--text-secondary)">读取目录中...</div>';

  try {
    const res = await sendCodexRpc('fs/readDirectory', { path: targetPath });
    const entries = (res.entries || [])
      .filter((e) => e.isDirectory && !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name));

    el.dirEntriesList.innerHTML = '';

    // Parent directory entry
    const parentPath = targetPath.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
    if (parentPath !== targetPath) {
      const upEl = document.createElement('div');
      upEl.className = 'dir-entry';
      upEl.textContent = '.. (返回上级目录)';
      upEl.onclick = () => openDirectoryBrowser(parentPath);
      el.dirEntriesList.appendChild(upEl);
    }

    for (const entry of entries) {
      const full = `${targetPath.replace(/\/+$/, '')}/${entry.name}`;
      const row = document.createElement('div');
      row.className = 'dir-entry';
      row.textContent = `${entry.name}/`;
      row.onclick = () => openDirectoryBrowser(full);
      el.dirEntriesList.appendChild(row);
    }
  } catch (err) {
    el.dirEntriesList.innerHTML = `<div style="padding:12px;color:var(--danger)">无法读取目录: ${escapeHtml(err.message)}</div>`;
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatRelativeTime(ms) {
  const diffSec = Math.floor((Date.now() - ms) / 1000);
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}小时前`;
  return `${Math.floor(diffSec / 86400)}天前`;
}

// === Event Bindings ===
el.loginForm.onsubmit = async (e) => {
  e.preventDefault();
  el.loginError.classList.add('hidden');
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        password: el.loginPassword.value,
        totpCode: el.loginTotp.value,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      el.loginError.textContent = data.error || '登录失败';
      el.loginError.classList.remove('hidden');
      return;
    }
    el.loginView.classList.add('hidden');
    el.appView.classList.remove('hidden');
    if (resumeLoginDestination()) return;
    connectRelayWebSocket();
  } catch (err) {
    el.loginError.textContent = err.message;
    el.loginError.classList.remove('hidden');
  }
};

el.btnDrawer.onclick = toggleDrawer;
el.drawerBackdrop.onclick = closeDrawer;

if (el.modelSelect) {
  el.modelSelect.onchange = () => {
    state.selectedModel = el.modelSelect.value;
    localStorage.setItem('codex_selected_model', state.selectedModel);
    renderModelAndEffortSelectors();
    const cur = state.threads.find((t) => t.id === state.currentThreadId);
    if (cur) {
      cur.model = state.selectedModel;
      renderWorkspacesDrawer();
    }
  };
}

if (el.effortSelect) {
  el.effortSelect.onchange = () => {
    state.selectedEffort = el.effortSelect.value;
    localStorage.setItem('codex_selected_effort', state.selectedEffort);
    const cur = state.threads.find((t) => t.id === state.currentThreadId);
    if (cur) {
      cur.reasoningEffort = state.selectedEffort;
      renderWorkspacesDrawer();
    }
  };
}

el.promptInput.oninput = () => {
  el.promptInput.style.height = 'auto';
  el.promptInput.style.height = `${Math.min(el.promptInput.scrollHeight, 120)}px`;
};

el.agentSelect.onchange = () => {
  state.selectedAgentId = el.agentSelect.value;
  state.projects = []; state.threads = []; state.models = []; state.threadsNextCursor = null;
  state.restoreAgentId = state.selectedAgentId;
  activateThreadView(createThreadView(), { remember: false });
  el.currentThreadTitle.textContent = '选择或新建会话';
  localStorage.setItem('codex_selected_agent', state.selectedAgentId);
  updateBanners();
  loadWorkspacesAndThreads();
};

el.btnRefreshThreads.onclick = () => loadWorkspacesAndThreads();
el.threadSearchInput.oninput = () => renderWorkspacesDrawer();

el.btnBrowseDir.onclick = () => {
  closeDrawer();
  openDirectoryBrowser(state.selectedCwd);
};

el.btnDirGo.onclick = () => openDirectoryBrowser(el.inputDirPath.value.trim());
el.btnCloseDir.onclick = () => el.modalDir.classList.add('hidden');
el.btnSelectDir.onclick = () => {
  const chosen = el.inputDirPath.value.trim();
  if (chosen) {
    el.modalDir.classList.add('hidden');
    startNewThreadInWorkspace(chosen, chosen.split('/').pop());
  }
};

el.btnSwitchProfile.onclick = async () => {
  const agent = getSelectedAgent();
  const current = agent?.profile || '';
  const next = prompt('输入要切换的本机 Codex Profile 名称（如 deepseek，留空恢复默认）:', current);
  if (next === null) return;
  try {
    await sendCodexRpc('remote/switchProfile', { profile: next.trim() || null });
    closeDrawer();
    appendSystemNotice(`已切换本机 Codex Profile 为: ${next.trim() || '(默认)'}`);
  } catch (err) {
    alert(`切换失败: ${err.message}`);
  }
};

el.btnE2EKey.onclick = () => openE2EModal();
el.btnBannerE2E.onclick = () => openE2EModal();
el.btnCloseE2E.onclick = () => el.modalE2E.classList.add('hidden');
el.btnSaveE2E.onclick = () => {
  const agent = getSelectedAgent();
  if (agent) {
    setStoredE2EKey(agent.agentId, el.inputE2EKey.value.trim());
  }
  el.modalE2E.classList.add('hidden');
  updateBanners();
};

el.btnNewThread.onclick = () => {
  startNewThreadInWorkspace(
    state.selectedCwd || getSelectedAgent()?.defaultCwd || '/',
    (state.selectedCwd || '').split('/').pop()
  );
};

el.btnSend.onclick = sendUserPrompt;
el.promptInput.onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendUserPrompt();
  }
};

el.btnStopTurn.onclick = async () => {
  const view = state.currentView;
  if (!view?.threadId || !view.activeTurnId || view.activeTurnId === 'active') return;
  try {
    await sendCodexRpc('turn/interrupt', { threadId: view.threadId, turnId: view.activeTurnId }, view.agentId);
    view.activeTurnId = null;
    view.runStatus = 'interrupted';
    for (const id of view.approvals.keys()) resolveInteraction(view, id, '用户已停止任务');
  } catch (err) {
    if (String(err.message).toLowerCase().includes('no active turn')) view.activeTurnId = null;
    else appendSystemNotice(`中断失败: ${err.message}`, view);
  }
  if (state.currentView === view) syncThreadControls();
};

el.btnLoadHistory.onclick = () => {
  if (state.currentView) loadThreadHistory(state.currentView, { older: true });
};
el.btnMoreThreads.onclick = () => loadWorkspacesAndThreads({ more: true });
el.btnJumpLatest.onclick = () => { scrollToBottom(true); syncThreadControls(); };
el.btnPendingRequests.onclick = () => {
  pendingQuestionCards(state.currentView)[0]?.element.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
};
el.chatContainer.onscroll = () => {
  const view = state.currentView;
  if (!view) return;
  view.scrollTop = el.chatContainer.scrollTop;
  view.followOutput = el.chatContainer.scrollHeight - el.chatContainer.clientHeight - el.chatContainer.scrollTop < 80;
  el.btnJumpLatest.classList.toggle('hidden', view.followOutput);
};

el.btnLogout.onclick = async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.reload();
};

// === Mobile Virtual Keyboard Viewport Lock ===
function setupVisualViewportFix() {
  const vv = window.visualViewport;
  if (!vv) return;

  let lastHeight = vv.height;
  const syncViewport = () => {
    const root = document.documentElement;
    root.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
    root.style.setProperty('--vvo', `${Math.round(vv.offsetTop)}px`);
    if (window.scrollY !== 0 || window.scrollX !== 0) {
      window.scrollTo(0, 0);
    }
    // If keyboard just opened (viewport shrunk significantly), keep current scroll context
    const delta = lastHeight - vv.height;
    if (delta > 80 && el.chatContainer) {
      el.chatContainer.scrollTop += delta;
    }
    lastHeight = vv.height;
  };

  vv.addEventListener('resize', syncViewport);
  vv.addEventListener('scroll', syncViewport);
  window.addEventListener('scroll', () => {
    if (window.scrollY !== 0) window.scrollTo(0, 0);
  });
  syncViewport();
}

function resumeLoginDestination() {
  const destination = new URLSearchParams(location.search).get('next');
  if (destination && /^\/dsh\/[a-zA-Z0-9_-]+\//.test(destination) && !/[\\\r\n]/.test(destination)) {
    location.replace(destination);
    return true;
  }
  return false;
}

// === Bootstrap ===
(async function init() {
  setupVisualViewportFix();
  renderModelAndEffortSelectors();
  try {
    const res = await fetch('/api/auth/status');
    const data = await res.json();
    if (data.authenticated) {
      if (resumeLoginDestination()) return;
      el.appView.classList.remove('hidden');
      connectRelayWebSocket();
    } else {
      el.loginView.classList.remove('hidden');
    }
  } catch {
    el.loginView.classList.remove('hidden');
  }
})();
