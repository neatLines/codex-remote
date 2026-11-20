import './relay-transport.js';

// === App State ===
const state = {
  ws: null,
  agents: [],
  selectedAgentId: localStorage.getItem('codex_selected_agent') || null,
  selectedApp: null,
  customEmbedUrl: null,
  customEmbedTitle: null,
  manualOverview: false,
  activeFrameUrl: '',
  runtimeDeviceId: null,
  files: { items: [], nextCursor: null, request: 0, loading: false },
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
  btnCollapseSidebar: document.getElementById('btn-collapse-sidebar'),
  drawerBackdrop: document.getElementById('drawer-backdrop'),
  sidebarDrawer: document.getElementById('sidebar-drawer'),
  agentSelect: document.getElementById('agent-select'),
  deviceList: document.getElementById('device-list'),
  agentStatusPill: document.getElementById('agent-status-pill'),
  sidebarTrustBox: document.getElementById('sidebar-trust-box'),
  sidebarTrustText: document.getElementById('sidebar-trust-text'),
  btnSidebarTrust: document.getElementById('btn-sidebar-trust'),
  sidebarServicesSection: document.getElementById('sidebar-services-section'),
  servicesCountBadge: document.getElementById('services-count-badge'),
  sidebarServices: document.getElementById('sidebar-services'),
  localWebForm: document.getElementById('local-web-form'),
  localWebUrl: document.getElementById('local-web-url'),
  localWebOpen: document.getElementById('local-web-open'),
  localWebExternal: document.getElementById('local-web-external'),
  localWebError: document.getElementById('local-web-error'),
  btnLogout: document.getElementById('btn-logout'),
  currentThreadTitle: document.getElementById('current-thread-title'),
  currentWorkspaceBadge: document.getElementById('current-workspace-badge'),
  wsStatusDot: document.getElementById('ws-status-dot'),
  btnDeviceApps: document.getElementById('btn-device-apps'),
  btnReloadFrame: document.getElementById('btn-reload-frame'),
  btnOpenExternal: document.getElementById('btn-open-external'),
  btnTopbarFiles: document.getElementById('btn-topbar-files'),
  btnFiles: document.getElementById('btn-files'),
  untrustedBanner: document.getElementById('untrusted-banner'),
  serviceFrame: document.getElementById('service-frame'),
  deviceApps: document.getElementById('device-apps'),
  deviceAppsTitle: document.getElementById('device-apps-title'),
  deviceAppsStatus: document.getElementById('device-apps-status'),
  deviceServicesTitle: document.getElementById('device-services-title'),
  appCards: document.getElementById('app-cards'),
  modalFiles: document.getElementById('modal-files'),
  filesList: document.getElementById('files-list'),
  filesStatus: document.getElementById('files-status'),
  filesStorage: document.getElementById('files-storage'),
  btnRefreshFiles: document.getElementById('btn-refresh-files'),
  btnMoreFiles: document.getElementById('btn-more-files'),
  btnCloseFiles: document.getElementById('btn-close-files'),
};

function getSelectedAgent() {
  return state.agents.find((a) => a.agentId === state.selectedAgentId) || null;
}

function isT3CodeService(app) {
  return Boolean(app && (app.id === 't3-code' || app.kind === 't3-code' || /t3[\s_-]*code/i.test(app.name || '')));
}

function serviceBadgeLabel(app) {
  if (isT3CodeService(app)) return 'T3';
  if (app?.kind === 'dsh' || app?.id === 'dsh') return 'DSH';
  if (app?.kind === 'opencode' || app?.id === 'opencode') return 'OC';
  return 'WEB';
}

function serviceStatusLabel(agent, app) {
  if (!agent?.online) return '设备离线';
  if (!agent?.trusted) return '等待信任';
  if (app.status === 'ready') return '运行中';
  if (app.status === 'error') return '异常重试中';
  return '启动中…';
}

function updateAgentStatusUI(agent) {
  if (!el.agentStatusPill) return;
  if (!agent) {
    el.agentStatusPill.textContent = '无设备';
    el.agentStatusPill.className = 'status-pill';
  } else if (!agent.online) {
    el.agentStatusPill.textContent = '离线';
    el.agentStatusPill.className = 'status-pill offline';
  } else if (!agent.trusted) {
    el.agentStatusPill.textContent = '待信任';
    el.agentStatusPill.className = 'status-pill warning';
  } else {
    el.agentStatusPill.textContent = '在线';
    el.agentStatusPill.className = 'status-pill online';
  }

  if (el.sidebarTrustBox) {
    const needsTrust = Boolean(agent && agent.online && !agent.trusted);
    el.sidebarTrustBox.classList.toggle('hidden', !needsTrust);
    if (needsTrust && el.btnSidebarTrust) {
      el.btnSidebarTrust.onclick = () => trustAgent(agent.agentId, true);
    }
  }
}

function renderDeviceList() {
  if (!el.deviceList) return;
  el.deviceList.replaceChildren();
  if (state.agents.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sidebar-service-empty';
    empty.textContent = '等待运行 codex-up 接入…';
    el.deviceList.appendChild(empty);
    return;
  }
  for (const a of state.agents) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'device-item';
    if (a.agentId === state.selectedAgentId) btn.classList.add('active');
    btn.onclick = () => {
      el.agentSelect.value = a.agentId;
      el.agentSelect.onchange();
    };

    const dot = document.createElement('span');
    dot.className = 'device-item-dot' + (a.online ? (a.trusted ? ' online' : ' warning') : '');

    const info = document.createElement('div');
    info.className = 'device-item-info';

    const name = document.createElement('div');
    name.className = 'device-item-name';
    name.textContent = a.name || a.agentId;

    const meta = document.createElement('div');
    meta.className = 'device-item-meta';
    const stateLabel = a.online ? (a.trusted ? '已连接' : '待授权') : '离线';
    const serviceCount = Array.isArray(a.webServices) ? `${a.webServices.length} 项服务` : a.localWeb?.enabled ? '端口直连' : '';
    meta.textContent = [stateLabel, a.platform, serviceCount].filter(Boolean).join(' · ');

    info.appendChild(name);
    info.appendChild(meta);
    btn.appendChild(dot);
    btn.appendChild(info);
    el.deviceList.appendChild(btn);
  }
}

function setEmbeddedFrame(activeEmbed, agent) {
  if (activeEmbed && agent?.online && agent?.trusted) {
    el.serviceFrame?.classList.remove('hidden');
    el.deviceApps?.classList.add('hidden');
    if (state.activeFrameUrl !== activeEmbed.url) {
      state.activeFrameUrl = activeEmbed.url;
      if (el.serviceFrame) el.serviceFrame.src = activeEmbed.url;
    }
    el.currentWorkspaceBadge.textContent = agent.name || agent.agentId;
    el.currentThreadTitle.textContent = activeEmbed.title;
    el.btnDeviceApps?.classList.remove('hidden');
    el.btnReloadFrame?.classList.remove('hidden');
    if (el.btnOpenExternal) {
      el.btnOpenExternal.href = activeEmbed.url;
      el.btnOpenExternal.classList.remove('hidden');
    }
  } else {
    el.serviceFrame?.classList.add('hidden');
    el.deviceApps?.classList.remove('hidden');
    if (state.activeFrameUrl) {
      state.activeFrameUrl = '';
      if (el.serviceFrame) el.serviceFrame.src = 'about:blank';
    }
    el.currentWorkspaceBadge.textContent = agent?.name || '未选择设备';
    el.currentThreadTitle.textContent = '服务工作台';
    el.btnDeviceApps?.classList.add('hidden');
    el.btnReloadFrame?.classList.add('hidden');
    el.btnOpenExternal?.classList.add('hidden');
  }
}

function renderDeviceApps() {
  const agent = getSelectedAgent();
  updateAgentStatusUI(agent);
  renderDeviceList();

  const apps = Array.isArray(agent?.webServices)
    ? agent.webServices.map((service) => ({
        ...service,
        path: service.path || '/',
        href: `/local/${encodeURIComponent(agent.agentId)}/${service.port}${service.path || '/'}`,
      }))
    : [];

  if (state.runtimeDeviceId !== agent?.agentId) {
    state.runtimeDeviceId = agent?.agentId || null;
    state.selectedApp = null;
    state.customEmbedUrl = null;
    state.customEmbedTitle = null;
    state.manualOverview = false;
    el.localWebUrl.value = (agent && localStorage.getItem(`codex_local_web_url_${agent.agentId}`)) || '';
  }

  if (state.selectedApp && state.selectedApp !== '__custom__' && !apps.some((app) => app.id === state.selectedApp)) {
    state.selectedApp = null;
  }

  // Automatically embed T3 Code (or the primary ready service) when device is online & trusted
  if (agent?.online && agent?.trusted && !state.selectedApp && !state.manualOverview) {
    const preferred =
      apps.find((app) => app.status === 'ready' && isT3CodeService(app)) ||
      apps.find((app) => app.status === 'ready');
    if (preferred) {
      state.selectedApp = preferred.id;
    }
  }

  // 1. Render Sidebar Service List
  if (el.servicesCountBadge) el.servicesCountBadge.textContent = String(apps.length);
  if (el.sidebarServices) {
    el.sidebarServices.replaceChildren();
    if (apps.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sidebar-service-empty';
      empty.textContent = !agent
        ? '暂无在线设备'
        : agent.localWeb?.enabled
          ? '可在下方输入任意本地端口内嵌访问'
          : '该设备未配置网页服务清单';
      el.sidebarServices.appendChild(empty);
    } else {
      for (const app of apps) {
        const ready = Boolean(agent?.online && agent?.trusted && app.status === 'ready');
        const row = document.createElement('div');
        row.className = 'sidebar-service-item';
        if (state.selectedApp === app.id && ready) row.classList.add('active');
        row.dataset.app = app.id;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sidebar-service-btn';
        btn.disabled = !ready;
        btn.onclick = () => selectDeviceApp(app.id);

        const icon = document.createElement('span');
        icon.className = 'sidebar-service-icon' + (isT3CodeService(app) ? ' is-t3' : '');
        icon.textContent = serviceBadgeLabel(app);

        const content = document.createElement('div');
        content.className = 'sidebar-service-content';

        const top = document.createElement('div');
        top.className = 'sidebar-service-top';
        const name = document.createElement('span');
        name.className = 'sidebar-service-name';
        name.textContent = app.name;
        top.appendChild(name);

        const meta = document.createElement('div');
        meta.className = 'sidebar-service-meta';
        meta.textContent = `:${app.port} · ${serviceStatusLabel(agent, app)}`;

        content.appendChild(top);
        content.appendChild(meta);
        btn.appendChild(icon);
        btn.appendChild(content);
        row.appendChild(btn);

        if (ready) {
          const ext = document.createElement('a');
          ext.className = 'sidebar-service-ext';
          ext.href = app.href;
          ext.target = '_blank';
          ext.rel = 'noopener noreferrer';
          ext.title = '在新标签页打开';
          ext.textContent = '↗';
          row.appendChild(ext);
        }

        el.sidebarServices.appendChild(row);
      }
    }
  }

  // 2. Render Overview Cards
  el.appCards.replaceChildren();
  el.deviceServicesTitle?.classList.toggle('hidden', apps.length === 0);
  for (const app of apps) {
    const ready = Boolean(agent?.online && agent?.trusted && app.status === 'ready');
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'app-card';
    card.dataset.app = app.id;
    card.disabled = !ready;
    if (ready) {
      card.href = app.href;
      card.onclick = () => selectDeviceApp(app.id);
    }
    const name = document.createElement('strong');
    name.textContent = app.name;
    const status = document.createElement('span');
    status.className = 'app-status';
    status.textContent = `127.0.0.1:${app.port} · ${serviceStatusLabel(agent, app)}`;
    const action = document.createElement('span');
    action.className = 'app-action';
    action.textContent = ready ? '点击内嵌打开 →' : '暂不可用';
    card.appendChild(name);
    card.appendChild(status);
    card.appendChild(action);
    el.appCards.appendChild(card);
  }

  // 3. Generic Port Forwarding Form in Sidebar
  const showLocalForm = Boolean(agent?.localWeb?.enabled && !Array.isArray(agent?.webServices));
  el.localWebForm.classList.toggle('hidden', !showLocalForm);
  el.localWebOpen.disabled = !agent?.online || !agent?.trusted;
  if (el.localWebExternal) el.localWebExternal.disabled = el.localWebOpen.disabled;
  el.localWebUrl.disabled = el.localWebOpen.disabled;
  el.localWebError.textContent = !agent?.online
    ? '设备离线'
    : !agent?.trusted
      ? '请先信任设备'
      : '通过当前设备转发，需登录并信任设备。';

  // 4. Overview Header Status
  el.deviceAppsTitle.textContent = agent?.name || '等待设备连接';
  el.deviceAppsStatus.textContent = !agent
    ? '在电脑或服务器上运行 codex-up，即可在这里选择设备并内嵌访问 T3 Code、DSH 或 OpenCode。'
    : !agent.online
      ? '设备当前离线。重新连接后，可继续在页面内嵌访问它的服务。'
      : !agent.trusted
        ? '请先点击上方或左侧的【信任并绑定】授权这台设备。'
        : !apps.length && !agent.localWeb?.enabled
          ? '这台设备尚未启用任何网页服务。'
          : '在左侧菜单或下方卡片中选择要在页面内嵌打开的服务。';

  // 5. Determine Active Embedded View
  let activeEmbed = null;
  if (agent?.online && agent?.trusted) {
    if (state.selectedApp === '__custom__' && state.customEmbedUrl) {
      activeEmbed = {
        url: state.customEmbedUrl,
        title: state.customEmbedTitle || '本地网页',
      };
    } else if (state.selectedApp) {
      const selectedService = apps.find((app) => app.id === state.selectedApp);
      if (selectedService && selectedService.status === 'ready') {
        activeEmbed = {
          url: selectedService.href,
          title: `${selectedService.name}  :${selectedService.port}`,
        };
      }
    }
  }
  setEmbeddedFrame(activeEmbed, agent);
}

function localWebDestination(value, agentId) {
  let input = value.trim();
  if (/^\d+$/.test(input)) input = `http://127.0.0.1:${input}/`;
  else if (/^(?:127\.0\.0\.1|localhost)(?::|\/|$)/i.test(input)) input = 'http://' + input;
  const url = new URL(input);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password) {
    throw new Error('请输入本地 HTTP 网址或端口（1–65535）');
  }
  const port = Number(url.port || 80);
  if (port < 1 || port > 65535) throw new Error('端口应为 1–65535');
  return `/local/${encodeURIComponent(agentId)}/${port}${url.pathname}${url.search}${url.hash}`;
}

function openLocalWebInput({ external = false } = {}) {
  const agent = getSelectedAgent();
  if (!agent?.online || !agent?.trusted || !agent?.localWeb?.enabled) return;
  try {
    const raw = el.localWebUrl.value.trim();
    const url = localWebDestination(raw, agent.agentId);
    localStorage.setItem(`codex_local_web_url_${agent.agentId}`, raw);
    if (external) {
      window.open(url, '_blank', 'noopener,noreferrer');
      el.localWebError.textContent = '已在新窗口打开当前设备的本地网页。';
    } else {
      state.selectedApp = '__custom__';
      state.customEmbedUrl = url;
      state.customEmbedTitle = `本地端口 (${raw})`;
      state.manualOverview = false;
      el.localWebError.textContent = '已在右侧工作区内嵌打开。';
      renderDeviceApps();
      closeDrawer();
    }
  } catch (error) {
    el.localWebError.textContent = error.message || '请输入有效的本地 HTTP 网址或端口';
  }
}

el.localWebForm.onsubmit = (event) => {
  event.preventDefault();
  openLocalWebInput({ external: false });
};

if (el.localWebExternal) {
  el.localWebExternal.onclick = () => openLocalWebInput({ external: true });
}

function selectDeviceApp(value) {
  const agent = getSelectedAgent();
  if (value === null) {
    state.selectedApp = null;
    state.customEmbedUrl = null;
    state.manualOverview = true;
    renderDeviceApps();
    closeDrawer();
    return;
  }
  if (!agent?.online || !agent?.trusted) return;
  const service = Array.isArray(agent.webServices)
    ? agent.webServices.find((entry) => entry.id === value)
    : null;
  if (!service || service.status !== 'ready') return;
  state.selectedApp = value;
  state.customEmbedUrl = null;
  state.manualOverview = false;
  renderDeviceApps();
  closeDrawer();
}

function updateBanners() {
  renderDeviceApps();
  const untrustedOnline = state.agents.filter((a) => a.online && !a.trusted);
  if (untrustedOnline.length > 0) {
    const first = untrustedOnline[0];
    el.untrustedBanner.classList.remove('hidden');
    el.untrustedBanner.innerHTML = `
      <span>发现新设备接入：<b>${escapeHtml(first.name)}</b> (${escapeHtml(first.platform)})</span>
      <button class="btn-small" id="btn-trust-now">信任并绑定</button>
    `;
    const btn = document.getElementById('btn-trust-now');
    if (btn) btn.onclick = () => trustAgent(first.agentId, true);
  } else {
    el.untrustedBanner.classList.add('hidden');
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
    el.wsStatusDot.title = ws.transport === 'poll' ? '已连接（HTTP 长轮询）' : '已连接（WebSocket）';
  };

  ws.onclose = () => {
    if (state.ws !== ws) return;
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
      return;
    }

    if (msg.type === 'relay/filesChanged') {
      if (!el.modalFiles.classList.contains('hidden')) loadCloudFiles();
    }
  };
}

function handleAgentsList(agents) {
  state.agents = agents;
  const onlineTrusted = agents.filter((a) => a.online && a.trusted);
  const current = agents.find((a) => a.agentId === state.selectedAgentId);

  if (!current) {
    state.selectedAgentId = (onlineTrusted[0] || agents[0])?.agentId || null;
    if (state.selectedAgentId) {
      localStorage.setItem('codex_selected_agent', state.selectedAgentId);
    }
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
      opt.textContent = `${statusText} ${a.name}`;
      if (a.agentId === state.selectedAgentId) opt.selected = true;
      el.agentSelect.appendChild(opt);
    }
  }

  updateBanners();
}

// === Sidebar Collapse & Mobile Drawer ===
function toggleDrawer() {
  if (window.innerWidth >= 900) {
    document.body.classList.toggle('pc-sidebar-collapsed');
  } else if (el.sidebarDrawer.classList.contains('open')) {
    closeDrawer();
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

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatFileBytes(value) {
  let bytes = Number(value) || 0, index = 0;
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  while (bytes >= 1024 && index < units.length - 1) { bytes /= 1024; index++; }
  return `${index ? bytes.toFixed(1) : bytes} ${units[index]}`;
}

function renderCloudFiles() {
  el.filesList.replaceChildren();
  for (const file of state.files.items) {
    if (!/^[a-f0-9]{32}$/.test(file.id)) continue;
    const row = document.createElement('div'); row.className = 'cloud-file-row';
    const info = document.createElement('div'); info.className = 'cloud-file-info';
    const name = document.createElement('div'); name.className = 'cloud-file-name'; name.textContent = file.name;
    const metadata = document.createElement('div'); metadata.className = 'cloud-file-meta';
    metadata.textContent = `${formatFileBytes(file.size)} · ${file.agentName || 'Agent'} · ${new Date(file.createdAt).toLocaleString()}`;
    const download = document.createElement('a'); download.className = 'btn-small cloud-file-download';
    download.href = `/api/files/${file.id}/download`; download.download = file.name; download.textContent = '下载';
    info.appendChild(name); info.appendChild(metadata); row.appendChild(info); row.appendChild(download);
    el.filesList.appendChild(row);
  }
  el.btnMoreFiles.classList.toggle('hidden', !state.files.nextCursor);
}

async function loadCloudFiles({ more = false } = {}) {
  if (more && (state.files.loading || !state.files.nextCursor)) return;
  const request = ++state.files.request;
  state.files.loading = true;
  el.btnMoreFiles.disabled = true;
  el.filesStatus.textContent = '正在加载文件…';
  try {
    const cursor = more ? `&cursor=${encodeURIComponent(state.files.nextCursor)}` : '';
    const response = await fetch(`/api/files?limit=50${cursor}`, { cache: 'no-store' });
    const data = await response.json();
    if (request !== state.files.request) return;
    if (!response.ok || !data.ok) throw new Error(response.status === 401 ? '登录已过期，请重新登录后访问文件' : data.error || '加载文件失败');
    const files = new Map((more ? state.files.items : []).map((file) => [file.id, file]));
    for (const file of data.files || []) files.set(file.id, file);
    state.files.items = [...files.values()]; state.files.nextCursor = data.nextCursor || null;
    el.filesStorage.textContent = data.storage ? `已用 ${formatFileBytes(data.storage.usedBytes)} / ${formatFileBytes(data.storage.maxBytes)}` : '';
    renderCloudFiles();
    el.filesStatus.textContent = state.files.items.length ? '' : '暂无文件。Agent 上传后会显示在这里。';
  } catch (error) {
    if (request === state.files.request) el.filesStatus.textContent = error.message;
  } finally {
    if (request === state.files.request) { state.files.loading = false; el.btnMoreFiles.disabled = false; }
  }
}

function openFilesModal() {
  el.modalFiles.classList.remove('hidden');
  loadCloudFiles();
}

// === Event Bindings ===
el.btnFiles.onclick = openFilesModal;
if (el.btnTopbarFiles) el.btnTopbarFiles.onclick = openFilesModal;
el.btnCloseFiles.onclick = () => el.modalFiles.classList.add('hidden');
el.btnRefreshFiles.onclick = () => loadCloudFiles();
el.btnMoreFiles.onclick = () => loadCloudFiles({ more: true });

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
if (el.btnCollapseSidebar) el.btnCollapseSidebar.onclick = toggleDrawer;
el.drawerBackdrop.onclick = closeDrawer;

el.agentSelect.onchange = () => {
  state.selectedAgentId = el.agentSelect.value;
  localStorage.setItem('codex_selected_agent', state.selectedAgentId);
  updateBanners();
  closeDrawer();
};

el.btnDeviceApps.onclick = () => selectDeviceApp(null);

if (el.btnReloadFrame) {
  el.btnReloadFrame.onclick = () => {
    if (!state.activeFrameUrl || !el.serviceFrame) return;
    el.serviceFrame.src = state.activeFrameUrl;
  };
}

el.btnLogout.onclick = async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.reload();
};

// === Mobile Virtual Keyboard Viewport Lock ===
function setupVisualViewportFix() {
  const vv = window.visualViewport;
  if (!vv) return;

  const syncViewport = () => {
    const root = document.documentElement;
    root.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
    root.style.setProperty('--vvo', `${Math.round(vv.offsetTop)}px`);
    if (window.scrollY !== 0 || window.scrollX !== 0) {
      window.scrollTo(0, 0);
    }
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
  if (destination && /^\/local\/[a-zA-Z0-9_-]+\/[1-9][0-9]{0,4}\//.test(destination) && !/[\\\r\n]/.test(destination)) {
    location.replace(destination + (destination.includes('#') ? '' : location.hash || ''));
    return true;
  }
  return false;
}

// === Bootstrap ===
(async function init() {
  setupVisualViewportFix();
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
