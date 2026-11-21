import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

class Element {
  constructor(fragment = false, tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.attributes = {};
    this.children = [];
    this.parent = null;
    this.fragment = fragment;
    this.className = '';
    this.style = {};
    this.dataset = {};
    this.value = '';
    this.src = '';
    this.href = '';
    this.text = '';
    this.queries = new Map();
    this.classList = {
      contains: (name) => this.className.split(' ').includes(name),
      add: (name) => this.classList.toggle(name, true),
      remove: (name) => this.classList.toggle(name, false),
      toggle: (name, force) => {
        const names = new Set(this.className.split(' ').filter(Boolean));
        const add = force ?? !names.has(name);
        if (add) names.add(name);
        else names.delete(name);
        this.className = [...names].join(' ');
        return add;
      },
    };
  }
  set textContent(text) {
    this.text = String(text);
    this.children = [];
  }
  get textContent() {
    return this.text + this.children.map((node) => node.textContent).join('');
  }
  set innerHTML(_) {
    this.replaceChildren();
  }
  appendChild(node) {
    if (node.fragment) {
      for (const child of [...node.children]) this.appendChild(child);
      return node;
    }
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    this.children.push(node);
    node.parent = this;
    return node;
  }
  replaceChildren(...nodes) {
    for (const node of this.children) node.parent = null;
    this.children = [];
    this.text = '';
    for (const node of nodes) this.appendChild(node);
  }
  get options() {
    return this.children.filter((node) => node.tagName === 'OPTION');
  }
}

function setup(options = {}) {
  const nodes = new Map();
  const opened = [];
  const storage = new Map();
  const body = new Element();
  const win = { innerWidth: 1200, open: (...args) => opened.push(args) };
  const context = vm.createContext({
    document: {
      visibilityState: 'visible',
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, new Element());
        return nodes.get(id);
      },
      createElement: (tag) => new Element(false, tag),
      createDocumentFragment: () => new Element(true),
      body,
    },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    window: win,
    WebSocket: { OPEN: 1 },
    URL,
    URLSearchParams,
    fetch: options.fetch,
    location: options.location,
    setTimeout: () => ({}),
    clearTimeout: () => {},
    console: { warn() {} },
  });
  let source = fs.readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
  source = source.replace(/^import .*;$/gm, '').split('// === Bootstrap ===')[0];
  vm.runInContext(
    source +
      '\nglobalThis.app = { state, el, renderDeviceApps, selectDeviceApp, handleAgentsList, toggleDrawer, openDrawer, closeDrawer, loadCloudFiles, resumeLoginDestination, document, window };',
    context
  );
  return { ...context.app, storage, opened };
}

test('T3 Code auto-embeds in the main iframe when ready and sidebar switches services without redundant reloads', () => {
  const app = setup();
  app.handleAgentsList([
    {
      agentId: 'workstation',
      name: '开发主机',
      online: true,
      trusted: true,
      webServices: [
        { id: 'dsh', name: 'DSH', kind: 'dsh', port: 3081, path: '/', status: 'ready' },
        { id: 'opencode', name: 'OpenCode', kind: 'opencode', port: 3082, path: '/', status: 'ready' },
        { id: 'panel', name: '9090 面板', port: 9090, path: '/ui/#/overview', status: 'ready' },
        { id: 't3-code', name: 'T3 Code', port: 3773, path: '/?transport=websocket', status: 'ready' },
      ],
    },
    {
      agentId: 'server',
      name: '远端服务器',
      online: true,
      trusted: true,
      webServices: [{ id: 't3-code', name: 'T3 Code', port: 3773, path: '/?transport=websocket', status: 'ready' }],
    },
  ]);

  // Auto-selects T3 Code and embeds it in the iframe
  assert.equal(app.state.selectedAgentId, 'workstation');
  assert.equal(app.state.selectedApp, 't3-code');
  assert.equal(app.el.serviceFrame.classList.contains('hidden'), false);
  assert.equal(app.el.deviceApps.classList.contains('hidden'), true);
  assert.equal(app.el.serviceFrame.src, '/local/workstation/3773/?transport=websocket');
  assert.equal(app.el.btnOpenExternal.href, '/local/workstation/3773/?transport=websocket');
  assert.equal(app.el.sidebarServices.children.length, 4);

  // Switch to DSH, OpenCode, and generic HTTP panel in the embedded iframe
  app.selectDeviceApp('dsh');
  assert.equal(app.state.selectedApp, 'dsh');
  assert.equal(app.el.serviceFrame.src, '/local/workstation/3081/');

  app.selectDeviceApp('opencode');
  assert.equal(app.state.selectedApp, 'opencode');
  assert.equal(app.el.serviceFrame.src, '/local/workstation/3082/');

  // Switch to another service from the left sidebar
  app.selectDeviceApp('panel');
  assert.equal(app.state.selectedApp, 'panel');
  assert.equal(app.el.serviceFrame.src, '/local/workstation/9090/ui/#/overview');

  // Return to service cards overview
  app.selectDeviceApp(null);
  assert.equal(app.state.selectedApp, null);
  assert.equal(app.el.serviceFrame.classList.contains('hidden'), true);
  assert.equal(app.el.deviceApps.classList.contains('hidden'), false);
  assert.equal(app.el.serviceFrame.src, 'about:blank');

  // Switch device in sidebar dropdown
  app.el.agentSelect.value = 'server';
  app.el.agentSelect.onchange();
  assert.equal(app.state.selectedAgentId, 'server');
  assert.equal(app.state.selectedApp, 't3-code');
  assert.equal(app.el.serviceFrame.src, '/local/server/3773/?transport=websocket');
});

test('left sidebar collapses on desktop and slides as a drawer on mobile viewports', () => {
  const app = setup();
  app.window.innerWidth = 1280;
  assert.equal(app.document.body.classList.contains('pc-sidebar-collapsed'), false);
  app.toggleDrawer();
  assert.equal(app.document.body.classList.contains('pc-sidebar-collapsed'), true);
  app.toggleDrawer();
  assert.equal(app.document.body.classList.contains('pc-sidebar-collapsed'), false);

  app.window.innerWidth = 480;
  assert.equal(app.el.sidebarDrawer.classList.contains('open'), false);
  app.toggleDrawer();
  assert.equal(app.el.sidebarDrawer.classList.contains('open'), true);
  assert.equal(app.el.drawerBackdrop.classList.contains('hidden'), false);
  app.toggleDrawer();
  assert.equal(app.el.sidebarDrawer.classList.contains('open'), false);
  assert.equal(app.el.drawerBackdrop.classList.contains('hidden'), true);
});

test('local web port forwarding embeds valid loopback ports in the iframe, supports external tabs, and rejects remote hosts', () => {
  const app = setup();
  app.handleAgentsList([
    { agentId: 'agent', name: '本地电脑', online: true, trusted: true, localWeb: { enabled: true } },
    { agentId: 'other', name: '另一设备', online: true, trusted: true, localWeb: { enabled: true } },
  ]);

  const submitEmbed = (value) => {
    app.el.localWebUrl.value = value;
    app.el.localWebForm.onsubmit({ preventDefault() {} });
  };

  submitEmbed('http://127.0.0.1:9090/ui/#/overview');
  assert.equal(app.el.serviceFrame.classList.contains('hidden'), false);
  assert.equal(app.el.serviceFrame.src, '/local/agent/9090/ui/#/overview');

  submitEmbed('3773');
  assert.equal(app.el.serviceFrame.src, '/local/agent/3773/');

  app.el.localWebExternal.onclick();
  assert.equal(app.opened.at(-1)[0], '/local/agent/3773/');

  for (const invalid of ['http://evil.test:9090/', 'https://127.0.0.1:9090/', 'http://user:pass@localhost:9090/', '0', '65536']) {
    const previousSrc = app.el.serviceFrame.src;
    submitEmbed(invalid);
    assert.equal(app.el.serviceFrame.src, previousSrc);
  }

  app.state.selectedAgentId = 'other';
  app.renderDeviceApps();
  assert.equal(app.el.localWebUrl.value, '');
  submitEmbed('localhost:8080/test?q=1#hash');
  assert.equal(app.el.serviceFrame.src, '/local/other/8080/test?q=1#hash');

  app.state.agents[1].trusted = false;
  app.renderDeviceApps();
  assert.equal(app.el.serviceFrame.classList.contains('hidden'), true);
  assert.equal(app.el.localWebOpen.disabled, true);
});

test('offline or untrusted devices stay selected with disabled services and unmounted iframe', () => {
  const app = setup();
  app.handleAgentsList([
    {
      agentId: 'agent',
      name: '离线电脑',
      online: false,
      trusted: true,
      webServices: [{ id: 't3-code', name: 'T3 Code', port: 3773, path: '/?transport=websocket', status: 'offline' }],
    },
  ]);
  assert.equal(app.state.selectedAgentId, 'agent');
  assert.equal(app.el.serviceFrame.classList.contains('hidden'), true);
  assert.ok(app.el.appCards.children.every((card) => card.disabled));
  app.selectDeviceApp('t3-code');
  assert.equal(app.state.selectedApp, null);
  app.state.agents[0].online = true;
  app.state.agents[0].trusted = false;
  app.renderDeviceApps();
  assert.ok(app.el.appCards.children.every((card) => card.disabled));
});

test('login resumes the local web destination with its hash route and rejects external destinations', () => {
  const redirects = [];
  const location = {
    search: '?next=' + encodeURIComponent('/local/agent/9090/ui/'),
    hash: '#/overview',
    replace: (url) => redirects.push(url),
  };
  const app = setup({ location });
  assert.equal(app.resumeLoginDestination(), true);
  assert.equal(redirects[0], '/local/agent/9090/ui/#/overview');
  location.search = '?next=' + encodeURIComponent('https://evil.test/local/agent/9090/');
  assert.equal(app.resumeLoginDestination(), false);
  assert.equal(redirects.length, 1);
});

test('cloud files modal renders uploaded files, storage summary, pagination and deletion', async () => {
  const calls = [];
  const fileId = 'a'.repeat(32);
  const app = setup({
    fetch: async (url, options = {}) => {
      calls.push({ url, method: options.method || 'GET' });
      if (options.method === 'DELETE') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            id: fileId,
            storage: { usedBytes: 0, maxBytes: 1048576 },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          files: [
            {
              id: fileId,
              name: 'archive.tar.gz',
              size: 2048,
              agentName: '开发主机',
              createdAt: 1762056000000,
            },
          ],
          nextCursor: 'cursor_2',
          storage: { usedBytes: 2048, maxBytes: 1048576 },
        }),
      };
    },
  });
  await app.loadCloudFiles();
  assert.equal(app.el.filesList.children.length, 1);
  assert.match(app.el.filesStorage.textContent, /2\.0 KiB \/ 1\.0 MiB/);
  assert.equal(app.el.btnMoreFiles.classList.contains('hidden'), false);
  const actions = app.el.filesList.children[0].children[1];
  const delBtn = actions.children[1];
  assert.equal(delBtn.textContent, '删除');
  await delBtn.onclick();
  assert.deepEqual(calls.at(-1), { url: `/api/files/${fileId}`, method: 'DELETE' });
  assert.equal(app.el.filesList.children.length, 0);
  assert.match(app.el.filesStorage.textContent, /0 B \/ 1\.0 MiB/);
  assert.match(app.el.filesStatus.textContent, /暂无文件/);
});
