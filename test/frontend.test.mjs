import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// A small DOM stand-in keeps navigation/routing regression tests dependency-free.
// Markdown and layout are also checked in a real browser during manual QA.
class Element {
  constructor(fragment = false, tag = 'div') {
    this.tagName = tag.toUpperCase(); this.attributes = {};
    this.children = []; this.parent = null; this.fragment = fragment;
    this.className = ''; this.style = {}; this.dataset = {}; this.value = '';
    this.text = ''; this.queries = new Map();
    this.classList = {
      contains: (name) => this.className.split(' ').includes(name),
      add: (name) => this.classList.toggle(name, true),
      remove: (name) => this.classList.toggle(name, false),
      toggle: (name, force) => {
        const names = new Set(this.className.split(' ').filter(Boolean));
        const add = force ?? !names.has(name);
        if (add) names.add(name); else names.delete(name);
        this.className = [...names].join(' ');
        return add;
      },
    };
  }
  set textContent(text) { this.text = String(text); this.children = []; }
  get textContent() { return this.text + this.children.map((node) => node.textContent).join(''); }
  set innerHTML(_) { this.replaceChildren(); }
  appendChild(node) {
    if (node.fragment) { for (const child of [...node.children]) this.appendChild(child); return node; }
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    this.children.push(node); node.parent = this; return node;
  }
  prepend(node) {
    const nodes = node.fragment ? [...node.children] : [node];
    for (const child of nodes.reverse()) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
      this.children.unshift(child); child.parent = this;
    }
  }
  replaceChildren(...nodes) {
    for (const node of this.children) node.parent = null;
    this.children = []; this.text = '';
    for (const node of nodes) this.appendChild(node);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  insertBefore(node, reference) {
    if (!reference) return this.appendChild(node);
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    this.children.splice(this.children.indexOf(reference), 0, node); node.parent = this; return node;
  }
  get options() { return this.children.filter((node) => node.tagName === 'OPTION'); }
  querySelectorAll(selector) {
    const matches = (node, pattern) => {
      if (pattern.startsWith('.')) return node.classList.contains(pattern.slice(1));
      const match = pattern.match(/^([a-z]+)(?:\[([a-z]+)=([^\]]+)\])?$/i);
      return match && node.tagName === match[1].toUpperCase() && (!match[2] || node[match[2]] === match[3].replace(/["']/g, ''));
    };
    const all = [];
    const walk = (parent) => { for (const child of parent.children) { all.push(child); walk(child); } };
    walk(this);
    return all.filter((node) => selector.split(',').some((pattern) => matches(node, pattern.trim())));
  }
  querySelector(selector) {
    const found = this.querySelectorAll(selector)[0];
    if (found) return found;
    if (!this.queries.has(selector)) this.queries.set(selector, new Element());
    return this.queries.get(selector);
  }
  scrollIntoView() { this.scrolledIntoView = true; }
  focus() {}
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
}

function setup(options = {}) {
  const nodes = new Map();
  const timers = new Map();
  const sent = [];
  const storage = new Map();
  const context = vm.createContext({
    document: { visibilityState: 'visible', getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, new Element());
      return nodes.get(id);
    }, createElement: (tag) => new Element(false, tag), createDocumentFragment: () => new Element(true), body: new Element() },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    window: { innerWidth: 1000 }, WebSocket: { OPEN: 1 }, TextEncoder,
    fetch: options.fetch,
    setTimeout: (fn) => { const id = {}; timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id), console: { warn() {} },
    renderMarkdown: (node, text) => { node.textContent = text; node.markdownRenders = (node.markdownRenders || 0) + 1; },
  });
  let source = fs.readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
  source = source.replace(/^import .*;$/gm, '').split('// === Bootstrap ===')[0];
  const interactions = fs.readFileSync(new URL('../src/public/interactions.js', import.meta.url), 'utf8')
    .replace(/^import .*;$/gm, '').replace(/^export /gm, '');
  source = interactions + '\n' + source;
  vm.runInContext(source + '\nglobalThis.app = { state, el, getThreadView, createThreadView, activateThreadView, openExistingThread, startNewThreadInWorkspace, sendUserPrompt, handleIncomingCodexPayload, rejectPendingRpc, syncThreadControls, applyAgentState, submitInteraction, loadThreadHistory, loadWorkspacesAndThreads, renderThreadItem, syncAgentState, renderWorkspacesDrawer, loadCloudFiles, refreshVisibleThread, scheduleHistoryRefresh, openDirectoryBrowser, renderDeviceApps, selectDeviceApp, handleAgentsList, document };', context);
  const app = context.app;
  app.state.selectedAgentId = 'agent';
  app.state.selectedApp = 'codex';
  app.state.runtimeDeviceId = 'agent';
  app.state.agents = [{ agentId: 'agent', online: true, trusted: true }];
  app.state.ws = { readyState: 1, send: (data) => sent.push(JSON.parse(data)) };
  app.activateThreadView(app.getThreadView('A'));
  const respond = (request, result, error) => {
    if (result && request.payload.method === 'remote/getWorkspacesAndThreads') result = { threadSortKey: 'updated_at', ...result };
    app.handleIncomingCodexPayload({ id: request.payload.id, result, error }, request.agentId);
  };
  const notify = (method, params) => app.handleIncomingCodexPayload({ method, params }, 'agent');
  return { ...app, sent, respond, notify, timers, storage };
}

test('device launcher lists only enabled applications and links each native UI to its device', async () => {
  const app = setup();
  app.state.agents = [
    { agentId: 'agent', name: '本地电脑', online: true, trusted: true, dshWeb: { enabled: true, status: 'ready' }, opencodeWeb: { enabled: true, status: 'ready' } },
    { agentId: 'server', name: '测试服务器', online: true, trusted: true, codexEnabled: false, opencodeWeb: { enabled: true, status: 'ready' } },
  ];
  app.selectDeviceApp(null);
  assert.equal(app.el.appCards.children.length, 3);
  assert.equal(app.el.appCards.children[1].href, '/dsh/agent/');
  assert.equal(app.el.appCards.children[2].href, '/opencode/agent/');
  assert.equal(app.el.appCards.children[2].target, '_blank');
  assert.ok(app.el.chatContainer.classList.contains('hidden'));
  app.el.agentSelect.value = 'server'; app.el.agentSelect.onchange();
  assert.equal(app.state.selectedApp, null);
  assert.equal(app.el.appCards.children.length, 1);
  assert.equal(app.el.appCards.children[0].href, '/opencode/server/');
  await app.loadWorkspacesAndThreads(); await app.syncAgentState();
  assert.equal(app.sent.length, 0, 'OpenCode-only devices must not receive Codex RPCs');
});

test('offline or untrusted devices stay selected with disabled applications', () => {
  const app = setup();
  app.state.selectedApp = null;
  app.handleAgentsList([
    { agentId: 'agent', name: '离线电脑', online: false, trusted: true, opencodeWeb: { enabled: true, status: 'offline' } },
    { agentId: 'server', name: '服务器', online: true, trusted: true, codexEnabled: false },
  ]);
  assert.equal(app.state.selectedAgentId, 'agent');
  assert.ok(app.el.appCards.children.every((card) => card.disabled && !card.href));
  app.selectDeviceApp('codex');
  assert.equal(app.state.selectedApp, null);
  app.state.agents[0].online = true; app.state.agents[0].trusted = false;
  app.renderDeviceApps();
  assert.ok(app.el.appCards.children.every((card) => card.disabled));
});

const user = (id, text) => ({ id, type: 'userMessage', content: [{ type: 'text', text }] });
const agent = (id, text) => ({ id, type: 'agentMessage', text });
const history = (turnId, items, nextCursor = null) => ({
  data: items.slice().reverse().map((item) => ({ turnId, item })), nextCursor,
});
const tick = () => Promise.resolve();

test('switching threads preserves background deltas, completion and approvals', () => {
  const app = setup();
  const a = app.state.currentView;
  app.notify('turn/started', { threadId: 'A', turn: { id: 'turn-A' } });
  app.activateThreadView(app.getThreadView('B'));
  app.notify('item/agentMessage/delta', { threadId: 'A', itemId: 'answer', delta: '**hello' });
  app.notify('item/agentMessage/delta', { threadId: 'A', itemId: 'answer', delta: ' world**' });
  app.handleIncomingCodexPayload({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'A', command: 'pwd' } });
  assert.equal(app.state.currentView.approvals.size, 0);
  app.activateThreadView(a);
  assert.equal(app.state.activeTurnId, 'turn-A');
  assert.equal(app.el.btnStopTurn.classList.contains('hidden'), false);
  assert.equal(a.approvals.size, 1);
  assert.ok(a.interactionCards.has('approval'));
  assert.match(a.messages.textContent, /\*\*hello world\*\*/);
  app.activateThreadView(app.getThreadView('B'));
  app.notify('turn/completed', { threadId: 'A', turn: { id: 'turn-A' } });
  app.activateThreadView(a);
  assert.equal(app.state.activeTurnId, null);
  assert.equal(app.el.btnSend.disabled, false);
  assert.equal(a.approvals.size, 0);
});

test('new thread creation cannot redirect a send after navigation or device switch', async () => {
  const app = setup();
  await app.startNewThreadInWorkspace('/workspace', 'project');
  const draft = app.state.currentView;
  app.el.promptInput.value = 'run task';
  const send = app.sendUserPrompt();
  const create = app.sent[0];
  app.state.selectedAgentId = 'other-agent';
  app.state.agents.push({ agentId: 'other-agent', online: true });
  const other = app.getThreadView('B');
  app.activateThreadView(other);
  app.respond(create, { thread: { id: 'created' } });
  await tick();
  const turn = app.sent.find((request) => request.payload.method === 'turn/start');
  assert.equal(turn.agentId, 'agent');
  assert.equal(turn.payload.params.threadId, 'created');
  assert.equal(app.state.currentView, other);
  app.respond(turn, { turn: { id: 'running', status: 'inProgress' } });
  await send;
  assert.equal(draft.activeTurnId, 'running');
  assert.equal(app.state.currentThreadId, 'B');
});

test('history cannot overwrite live messages or clear a newly started turn', async () => {
  const app = setup();
  const load = app.openExistingThread({ id: 'A' });
  const request = app.sent[0];
  app.notify('turn/started', { threadId: 'A', turn: { id: 'new-turn' } });
  app.notify('item/agentMessage/delta', { threadId: 'A', itemId: 'answer', delta: 'newer answer' });
  app.respond(request, history('old-turn', [agent('answer', 'old answer'), user('user', 'hello')]));
  app.respond(app.sent[1], { data: [{ id: 'old-turn', status: 'completed', items: [] }] });
  await load;
  assert.match(app.state.currentView.messages.textContent, /newer answer/);
  assert.doesNotMatch(app.state.currentView.messages.textContent, /old answer/);
  assert.equal(app.state.activeTurnId, 'new-turn');
});

test('a stale history failure cannot clear another thread', async () => {
  const app = setup();
  const load = app.openExistingThread({ id: 'A' });
  const request = app.sent[0];
  const b = app.getThreadView('B');
  app.activateThreadView(b);
  app.notify('item/completed', { threadId: 'B', item: agent('answer', 'B answer') });
  app.respond(request, undefined, { message: 'history unavailable' });
  await load;
  assert.equal(b.messages.textContent, 'B answer');
  assert.match(app.getThreadView('A').messages.textContent, /history unavailable/);
});

test('duplicate sends are blocked and optimistic messages reconcile by content', async () => {
  const app = setup();
  app.el.promptInput.value = 'run task';
  const send = app.sendUserPrompt();
  app.el.promptInput.value = 'duplicate';
  await app.sendUserPrompt();
  assert.equal(app.sent.filter((request) => request.payload.method === 'turn/start').length, 1);
  app.notify('item/started', { threadId: 'A', item: user('u', 'run task') });
  app.notify('item/completed', { threadId: 'A', item: user('u', 'run task') });
  assert.equal(app.state.currentView.messages.children.length, 1);
  app.respond(app.sent[0], { turn: { id: 'turn', status: 'inProgress' } });
  await send;
  assert.equal(app.state.activeTurnId, 'turn');
});

test('completion before turn/start response cannot revive a completed turn', async () => {
  const app = setup();
  app.el.promptInput.value = 'hello';
  const send = app.sendUserPrompt();
  app.notify('turn/started', { threadId: 'A', turn: { id: 'turn' } });
  app.notify('turn/completed', { threadId: 'A', turn: { id: 'turn' } });
  app.respond(app.sent[0], { turn: { id: 'turn', status: 'inProgress' } });
  await send;
  assert.equal(app.state.activeTurnId, null);
  assert.equal(app.el.btnSend.disabled, false);
});

test('send errors stay on the originating thread and restore its controls', async () => {
  const app = setup();
  const a = app.state.currentView;
  app.el.promptInput.value = 'hello';
  const send = app.sendUserPrompt();
  const b = app.getThreadView('B');
  app.activateThreadView(b);
  app.respond(app.sent[0], undefined, { message: 'cannot start turn' });
  await send;
  assert.match(a.messages.textContent, /cannot start turn/);
  assert.equal(b.messages.textContent, '');
  app.activateThreadView(a);
  assert.equal(app.el.btnSend.disabled, false);
  assert.equal(a.optimisticUserBubbles.length, 0);
});

test('timeouts and disconnected RPCs settle instead of hanging indefinitely', async () => {
  for (const timeout of [false, true]) {
    const app = setup();
    app.el.promptInput.value = 'hello';
    const send = app.sendUserPrompt();
    if (timeout) [...app.timers.values()][0]();
    else app.rejectPendingRpc('connection lost');
    await send;
    assert.equal(app.state.pendingRpc.size, 0);
    assert.equal(app.state.currentView.sending, false);
    assert.equal(app.el.btnSend.disabled, false);
    assert.match(app.state.currentView.messages.textContent, timeout ? /请求超时/ : /connection lost/);
  }
});

test('external in-progress history does not expose local stop or steer controls', async () => {
  const app = setup();
  const load = app.openExistingThread({ id: 'A' });
  app.respond(app.sent[0], history('running', [user('u', 'task')]));
  app.respond(app.sent[1], { data: [{ id: 'running', status: 'inProgress', items: [] }] });
  await load;
  assert.equal(app.state.activeTurnId, null);
  assert.equal(app.el.btnStopTurn.classList.contains('hidden'), true);
  assert.equal(app.el.btnSend.disabled, false);
  assert.equal(app.el.btnSend.textContent, '发送');
  assert.match(app.el.threadStatus.textContent, /外部会话/);
});

test('old identical prompts cannot consume a new optimistic message', async () => {
  const app = setup();
  app.el.promptInput.value = 'repeat';
  const sending = app.sendUserPrompt();
  const load = app.openExistingThread({ id: 'A' });
  app.respond(app.sent[1], history('old-turn', [user('old-user', 'repeat')]));
  await load;
  assert.equal(app.state.currentView.messages.children.length, 2);
  assert.equal(app.state.currentView.optimisticUserBubbles.length, 1);
  app.respond(app.sent[0], { turn: { id: 'new-turn', status: 'inProgress', items: [user('new-user', 'repeat')] } });
  await sending;
  assert.equal(app.state.currentView.messages.children.length, 2);
  assert.equal(app.state.currentView.optimisticUserBubbles.length, 0);
});

test('history arriving before the send acknowledgement still reconciles the submitted message', async () => {
  const app = setup();
  app.el.promptInput.value = 'hello';
  const sending = app.sendUserPrompt();
  const load = app.openExistingThread({ id: 'A' });
  app.respond(app.sent[1], history('new-turn', [user('new-user', 'hello')]));
  await load;
  app.respond(app.sent[0], { turn: { id: 'new-turn', status: 'inProgress' } });
  await sending;
  assert.equal(app.state.currentView.messages.children.length, 1);
  assert.equal(app.state.currentView.optimisticUserBubbles.length, 0);
});

test('thread forks migrate background state and later sends use the fork', async () => {
  const app = setup();
  const a = app.state.currentView;
  app.activateThreadView(app.getThreadView('B'));
  app.notify('remote/threadForked', { oldThreadId: 'A', newThreadId: 'fork-A' });
  assert.equal(app.getThreadView('fork-A'), a);
  assert.equal(app.state.currentThreadId, 'B');
  app.activateThreadView(a);
  app.el.promptInput.value = 'continue';
  const sending = app.sendUserPrompt();
  const request = app.sent.find((entry) => entry.payload.method === 'turn/start');
  assert.equal(request.payload.params.threadId, 'fork-A');
  app.respond(request, { turn: { id: 'fork-turn', status: 'inProgress' } });
  await sending;
});

const drain = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const questionRequest = (id = 'question') => ({
  id, method: 'item/tool/requestUserInput', requestEpoch: 'epoch',
  params: { threadId: 'A', turnId: 'turn', itemId: 'tool', isBlocking: true, questions: [
    { id: 'choice', header: '方案', question: '**选择方案**', options: [
      { label: '方案一', description: '第一种方式' }, { label: '方案二', description: '第二种方式' },
    ], isOther: true },
    { id: 'details', header: '补充', question: '补充说明', options: null },
  ] },
});

// Shape observed from a real request_user_input_async call: it is an
// agentMessage carrying questions, not item/tool/requestUserInput.
const asyncQuestionItem = () => ({ id: 'call_real_async', type: 'agentMessage', delivery: 'async', phase: 'final_answer',
  text: '你现在能在网页端看到这张问答卡片吗？\n- 能看到\n- 操作有问题',
  questions: [{ title: '你现在能在网页端看到这张问答卡片吗？', options: ['能看到', '操作有问题'] },
    { title: '补充说明', options: null }],
});
const asyncQuestionId = (index = 0) => JSON.stringify(['request_user_input_async', 'call_real_async', index]);
const asyncReplyText = (index = 0) => `<send_user_message_question_reply>\n${JSON.stringify([{
  questionItemId: asyncQuestionId(index), question: asyncQuestionItem().questions[index].title, answer: '能看到',
}])}\n</send_user_message_question_reply>`;

test('native async agent messages become question cards that survive turn completion and snapshots', () => {
  const app = setup();
  app.notify('item/agentMessage/delta', { threadId: 'A', itemId: 'call_real_async', delta: 'plain preview' });
  app.notify('item/completed', { threadId: 'A', item: asyncQuestionItem() });
  const view = app.state.currentView;
  assert.equal(view.asyncQuestions.size, 2);
  assert.equal(view.itemElements.get('call_real_async').querySelectorAll('form').length, 2);
  app.notify('turn/completed', { threadId: 'A', turn: { status: 'completed' } });
  app.applyAgentState({ epoch: 'epoch', revision: 1, status: 'ready', requests: [], activeTurns: [] }, 'agent');
  assert.match(app.el.btnPendingRequests.textContent, /2 项/);
  app.renderThreadItem(asyncQuestionItem(), view);
  app.notify('item/agentMessage/delta', { threadId: 'A', itemId: 'call_real_async', delta: 'late preview' });
  assert.equal(view.itemElements.get('call_real_async').querySelectorAll('form').length, 2);
  assert.doesNotMatch(view.messages.textContent, /preview/);
});

test('async answers use a structured user message in their original thread after navigation', async () => {
  const app = setup();
  const view = app.state.currentView;
  app.renderThreadItem(asyncQuestionItem(), view);
  const card = view.asyncQuestions.get(asyncQuestionId()).card.element;
  card.querySelectorAll('input[type=radio]')[0].checked = true;
  app.activateThreadView(app.getThreadView('B'));
  app.activateThreadView(view);
  assert.equal(card.querySelectorAll('input[type=radio]')[0].checked, true);
  card.querySelector('form').onsubmit({ preventDefault() {} });
  const request = app.sent[0];
  assert.equal(request.payload.method, 'turn/start');
  assert.equal(request.payload.params.threadId, 'A');
  assert.equal(request.payload.params.input[0].text, asyncReplyText());
  assert.ok(request.payload.params.clientUserMessageId);
  app.activateThreadView(app.getThreadView('B'));
  app.respond(request, { turn: { id: 'answer-turn', status: 'inProgress' } });
  await drain();
  assert.equal(view.asyncQuestions.get(asyncQuestionId()).answered, true);
  assert.equal(view.asyncQuestions.get(asyncQuestionId(1)).answered, false);
  assert.equal(app.state.currentThreadId, 'B');
  assert.equal(view.activeTurnId, 'answer-turn');
});

test('native async answers steer an active turn and retain drafts when submission fails', async () => {
  const app = setup();
  const view = app.state.currentView;
  app.renderThreadItem(asyncQuestionItem(), view);
  app.notify('turn/started', { threadId: 'A', turn: { id: 'running' } });
  const card = view.asyncQuestions.get(asyncQuestionId(1)).card.element;
  card.querySelector('textarea').value = '需要保留的回答';
  card.querySelector('form').onsubmit({ preventDefault() {} });
  assert.equal(app.sent[0].payload.method, 'turn/steer');
  assert.equal(app.sent[0].payload.params.expectedTurnId, 'running');
  app.respond(app.sent[0], undefined, { message: 'signature rejected' }); await drain();
  assert.equal(card.querySelector('textarea').value, '需要保留的回答');
  assert.equal(view.asyncQuestions.get(asyncQuestionId(1)).answered, false);
  assert.equal(view.sending, false);
  assert.match(card.textContent, /signature rejected/);
});

test('async questions and answer receipts restore from actual message history in either order', async () => {
  const app = setup();
  const view = app.state.currentView;
  const loading = app.loadThreadHistory(view);
  assert.equal(app.sent[0].payload.method, 'thread/items/list');
  assert.equal(app.sent[0].payload.params.limit, 60);
  app.respond(app.sent[0], history('turn', [asyncQuestionItem(), user('reply', asyncReplyText())]));
  await loading;
  assert.equal(view.asyncQuestions.get(asyncQuestionId()).answered, true);
  assert.equal(view.asyncQuestions.get(asyncQuestionId(1)).answered, false);
  assert.match(app.el.btnPendingRequests.textContent, /1 项/);
  assert.doesNotMatch(view.itemElements.get('reply').textContent, /send_user_message_question_reply/);
  const refreshed = setup();
  refreshed.renderThreadItem(user('reply', asyncReplyText()));
  refreshed.renderThreadItem(asyncQuestionItem());
  assert.equal(refreshed.state.currentView.asyncQuestions.get(asyncQuestionId()).answered, true);
});

test('an async answer delivered by another device closes the card even if its local RPC disconnects', async () => {
  const app = setup();
  const view = app.state.currentView;
  app.renderThreadItem(asyncQuestionItem());
  const card = view.asyncQuestions.get(asyncQuestionId()).card.element;
  card.querySelectorAll('input[type=radio]')[0].checked = true;
  card.querySelector('form').onsubmit({ preventDefault() {} });
  app.notify('item/completed', { threadId: 'A', item: user('other-device-reply', asyncReplyText()) });
  app.rejectPendingRpc('connection lost'); await drain();
  assert.equal(view.asyncQuestions.get(asyncQuestionId()).answered, true);
  assert.equal(card.querySelectorAll('form')[0].children.length, 0);
  assert.doesNotMatch(card.textContent, /connection lost/);
});

test('questions validate all answers and retain the card until the Agent acknowledges resolution', async () => {
  const app = setup();
  const view = app.state.currentView;
  app.handleIncomingCodexPayload(questionRequest());
  const card = view.interactionCards.get('question').element;
  const form = card.querySelector('form');
  form.onsubmit({ preventDefault() {} });
  assert.equal(app.sent.length, 0);
  assert.match(card.textContent, /请选择或填写答案/);
  card.querySelectorAll('input[type=radio]')[1].checked = true;
  card.querySelectorAll('textarea')[1].value = '按这个方式执行';
  form.onsubmit({ preventDefault() {} });
  assert.equal(app.sent[0].payload.method, 'remote/respondToRequest');
  const params = app.sent[0].payload.params;
  assert.equal(params.requestEpoch, 'epoch');
  assert.equal(params.result.answers.choice.answers[0], '方案二');
  assert.equal(params.result.answers.details.answers[0], '按这个方式执行');
  assert.equal(view.approvals.size, 1);
  app.respond(app.sent[0], { resolved: true });
  await drain();
  assert.equal(view.approvals.size, 0);
  assert.match(card.textContent, /已处理/);
  assert.equal(card.querySelectorAll('textarea').length, 0);
});

test('a disconnected approval remains visible and can be retried after reconnecting', async () => {
  const app = setup();
  const view = app.state.currentView;
  app.handleIncomingCodexPayload({ id: 'approval', method: 'item/commandExecution/requestApproval', requestEpoch: 'epoch', params: { threadId: 'A', command: 'pwd' } });
  const card = view.interactionCards.get('approval').element;
  app.state.ws.readyState = 3;
  card.querySelectorAll('button')[0].onclick();
  await drain();
  assert.equal(app.sent.length, 0);
  assert.equal(view.approvals.size, 1);
  assert.equal(card.querySelector('fieldset').disabled, false);
  assert.match(card.textContent, /未连接/);
  app.state.ws.readyState = 1;
  card.querySelectorAll('button')[0].onclick();
  assert.equal(app.sent.length, 1);
  app.respond(app.sent[0], { resolved: true });
  await drain();
  assert.equal(view.approvals.size, 0);
});

test('an E2E or server rejection preserves interaction data for retry', async () => {
  const app = setup();
  app.handleIncomingCodexPayload(questionRequest());
  const view = app.state.currentView;
  const card = view.interactionCards.get('question').element;
  card.querySelectorAll('input[type=radio]')[0].checked = true;
  const text = card.querySelectorAll('textarea')[1]; text.value = '保留草稿';
  card.querySelector('form').onsubmit({ preventDefault() {} });
  app.respond(app.sent[0], undefined, { message: 'signature rejected' });
  await drain();
  assert.equal(view.approvals.size, 1);
  assert.equal(text.value, '保留草稿');
  assert.match(card.textContent, /signature rejected/);
});

test('snapshots restore pending questions and resolve stale cards after a refresh or process restart', () => {
  const app = setup();
  const snapshot = { version: 1, epoch: 'epoch', revision: 2, status: 'ready', requests: [questionRequest()],
    activeTurns: [{ threadId: 'A', turnId: 'turn', status: 'running' }] };
  app.applyAgentState(snapshot, 'agent');
  assert.equal(app.state.currentView.approvals.size, 1);
  assert.equal(app.state.activeTurnId, 'turn');
  const refreshed = setup();
  refreshed.applyAgentState(snapshot, 'agent');
  assert.equal(refreshed.state.currentView.approvals.size, 1);
  refreshed.applyAgentState({ ...snapshot, revision: 1, requests: [] }, 'agent');
  assert.equal(refreshed.state.currentView.approvals.size, 1, 'older snapshots must not erase newer requests');
  refreshed.applyAgentState({ ...snapshot, epoch: 'new-epoch', revision: 3, requests: [], activeTurns: [] }, 'agent');
  assert.equal(refreshed.state.currentView.approvals.size, 0);
  assert.equal(refreshed.state.activeTurnId, null);
  assert.match(refreshed.state.currentView.messages.textContent, /已重启/);
});

test('permission approval grants only explicitly selected requested permissions', async () => {
  const app = setup();
  app.handleIncomingCodexPayload({ id: 'permissions', method: 'item/permissions/requestApproval', requestEpoch: 'epoch', params: {
    threadId: 'A', cwd: '/workspace', permissions: { network: { enabled: true }, fileSystem: { read: ['/specific/file'] } },
  } });
  const card = app.state.currentView.interactionCards.get('permissions').element;
  card.querySelectorAll('input[type=checkbox]')[0].checked = true;
  card.querySelectorAll('button')[0].onclick();
  const result = app.sent[0].payload.params.result;
  assert.equal(result.permissions.network.enabled, true);
  assert.equal(result.permissions.fileSystem, undefined);
  assert.equal(result.scope, 'turn');
  app.respond(app.sent[0], { resolved: true });
  await drain();
});

test('an old acknowledgement or resolved event cannot clear a reused request ID in a new process', async () => {
  const app = setup();
  const view = app.state.currentView;
  app.handleIncomingCodexPayload(questionRequest());
  const oldCard = view.interactionCards.get('question').element;
  oldCard.querySelectorAll('input[type=radio]')[0].checked = true;
  oldCard.querySelectorAll('textarea')[1].value = '旧答案';
  oldCard.querySelector('form').onsubmit({ preventDefault() {} });
  app.applyAgentState({ epoch: 'new', revision: 1, status: 'ready', activeTurns: [],
    requests: [{ ...questionRequest(), requestEpoch: 'new' }] }, 'agent');
  const newCard = view.interactionCards.get('question').element;
  assert.notEqual(newCard, oldCard);
  app.respond(app.sent[0], { resolved: true });
  await drain();
  app.handleIncomingCodexPayload({ method: 'serverRequest/resolved', requestEpoch: 'epoch', params: { requestId: 'question' } }, 'agent');
  assert.equal(view.approvals.get('question').requestEpoch, 'new');
  assert.equal(newCard.classList.contains('is-resolved'), false);
  assert.equal(newCard.querySelectorAll('textarea')[1].value, '');
});

test('terminal turn acknowledgements show a terminal state even without a completion event', async () => {
  const app = setup();
  app.el.promptInput.value = 'run';
  const sending = app.sendUserPrompt();
  app.respond(app.sent[0], { turn: { id: 'finished', status: 'failed', items: [] } });
  await sending;
  assert.equal(app.state.currentView.activeTurnId, null);
  assert.equal(app.state.currentView.runStatus, 'failed');
  assert.match(app.el.threadStatus.textContent, /执行失败/);
});

test('MCP forms render enum fields and submit structured typed values', async () => {
  const app = setup();
  app.handleIncomingCodexPayload({ id: 'form', method: 'mcpServer/elicitation/request', requestEpoch: 'epoch', params: {
    threadId: 'A', mode: 'form', message: '选择操作', requestedSchema: {
      type: 'object', required: ['region', 'count'], additionalProperties: false, properties: {
        region: { type: 'string', enum: ['east', 'west'], enumNames: ['东部', '西部'] },
        count: { type: 'integer', minimum: 1, maximum: 10 },
      },
    },
  } });
  const card = app.state.currentView.interactionCards.get('form').element;
  card.querySelector('select').value = '1';
  card.querySelectorAll('input')[0].value = '3';
  card.querySelector('form').onsubmit({ preventDefault() {} });
  const response = app.sent[0].payload.params.result;
  assert.equal(response.action, 'accept');
  assert.equal(response.content.region, 'west');
  assert.equal(response.content.count, 3);
  app.respond(app.sent[0], { resolved: true }); await drain();
});

test('unknown server requests expose an explicit refusal instead of being silently dropped', async () => {
  const app = setup();
  app.handleIncomingCodexPayload({ id: 'unknown', method: 'future/request', requestEpoch: 'epoch', params: { threadId: 'A' } });
  const card = app.state.currentView.interactionCards.get('unknown').element;
  assert.match(card.textContent, /无法执行此类请求/);
  card.querySelectorAll('button')[0].onclick();
  assert.equal(app.sent[0].payload.params.error.code, -32601);
  app.respond(app.sent[0], { resolved: true }); await drain();
});

test('dynamic questions also accept titled prompts and string options', async () => {
  const app = setup();
  app.handleIncomingCodexPayload({ id: 'dynamic', method: 'item/tool/call', requestEpoch: 'epoch', params: {
    threadId: 'A', tool: 'functions.request_user_input_async', arguments: {
      questions: [{ title: '选择发布方式', options: ['滚动发布', '直接替换'] }],
    },
  } });
  const card = app.state.currentView.interactionCards.get('dynamic').element;
  assert.match(card.textContent, /选择发布方式/);
  card.querySelectorAll('input[type=radio]')[0].checked = true;
  card.querySelector('form').onsubmit({ preventDefault() {} });
  const result = app.sent[0].payload.params.result;
  assert.equal(result.success, true);
  assert.equal(JSON.parse(result.contentItems[0].text).answers.question_1.answers[0], '滚动发布');
  app.respond(app.sent[0], { resolved: true }); await drain();
});

test('follow-up instructions steer the captured active turn without starting another turn', async () => {
  const app = setup();
  app.notify('turn/started', { threadId: 'A', turn: { id: 'run-A' } });
  app.el.promptInput.value = '追加一个要求';
  const sending = app.sendUserPrompt();
  const request = app.sent[0];
  assert.equal(request.payload.method, 'turn/steer');
  assert.equal(request.payload.params.expectedTurnId, 'run-A');
  assert.equal(request.payload.params.threadId, 'A');
  app.activateThreadView(app.getThreadView('B'));
  app.respond(request, { turnId: 'run-A' });
  await sending;
  assert.equal(app.state.currentThreadId, 'B');
  assert.equal(app.getThreadView('A').activeTurnId, 'run-A');
});

test('transient reconnects are status updates, while terminal failures are shown as failures', () => {
  const app = setup();
  app.notify('turn/started', { threadId: 'A', turn: { id: 'turn' } });
  app.notify('error', { threadId: 'A', willRetry: true, error: { message: 'Reconnecting... 2/5' } });
  assert.match(app.el.threadStatus.textContent, /正在重连/);
  assert.equal(app.state.currentView.messages.textContent, '');
  app.notify('error', { threadId: 'A', willRetry: false, error: { message: 'network unavailable' } });
  app.notify('turn/completed', { threadId: 'A', turn: { id: 'turn', status: 'failed' } });
  assert.match(app.el.threadStatus.textContent, /执行失败/);
  assert.match(app.state.currentView.messages.textContent, /network unavailable/);
});

test('tool and plan events have visible representations and raw reasoning is excluded', () => {
  const app = setup();
  for (const type of ['plan', 'mcpToolCall', 'webSearch', 'imageGeneration', 'dynamicToolCall', 'futureTool']) {
    app.notify('item/completed', { threadId: 'A', item: { id: type, type, text: 'fixture', status: 'completed' } });
    assert.ok(app.state.currentView.itemElements.has(type));
  }
  app.notify('turn/plan/updated', { threadId: 'A', turnId: 'turn', plan: [{ step: '验证结果', status: 'completed' }] });
  assert.match(app.state.currentView.messages.textContent, /验证结果/);
  app.notify('item/completed', { threadId: 'A', item: { id: 'reasoning', type: 'reasoning', summary: ['公开摘要'], content: ['private raw reasoning'] } });
  assert.match(app.state.currentView.messages.textContent, /公开摘要/);
  app.notify('item/reasoning/textDelta', { threadId: 'A', itemId: 'reasoning', delta: 'private raw reasoning delta' });
  app.notify('item/reasoning/summaryTextDelta', { threadId: 'A', itemId: 'summary', delta: '新的公开摘要' });
  assert.match(app.state.currentView.messages.textContent, /新的公开摘要/);
  assert.doesNotMatch(app.state.currentView.messages.textContent, /private raw reasoning/);
});

test('history pagination prepends older messages and live updates respect manual scrolling', async () => {
  const app = setup();
  const view = app.state.currentView;
  const first = app.openExistingThread({ id: 'A' });
  app.respond(app.sent[0], history('new-turn', [agent('new', 'new message')], 'older-page'));
  await first;
  const older = app.loadThreadHistory(view, { older: true });
  assert.equal(app.sent[2].payload.params.cursor, 'older-page');
  app.respond(app.sent[2], history('old-turn', [agent('old', 'old message')]));
  await older;
  assert.equal(view.messages.textContent, 'old messagenew message');
  assert.equal(view.historyCursor, null);
  app.el.chatContainer.scrollHeight = 1000; app.el.chatContainer.clientHeight = 300;
  app.el.chatContainer.scrollTop = 100; app.el.chatContainer.onscroll();
  app.notify('item/agentMessage/delta', { threadId: 'A', itemId: 'live', delta: 'new output' });
  assert.equal(app.el.chatContainer.scrollTop, 100);
  assert.equal(app.el.btnJumpLatest.classList.contains('hidden'), false);
  app.el.btnJumpLatest.onclick();
  assert.equal(view.followOutput, true);
  assert.equal(app.el.chatContainer.scrollTop, 1000);
});

test('thread list pagination forwards opaque cursors and merges pages without duplicates', async () => {
  const app = setup();
  const first = app.loadWorkspacesAndThreads();
  app.respond(app.sent[0], { projects: [], threads: [{ id: 'A', preview: 'first' }], nextCursor: 'next-threads' });
  await first;
  const second = app.loadWorkspacesAndThreads({ more: true });
  assert.equal(app.sent[1].payload.params.cursor, 'next-threads');
  app.respond(app.sent[1], { projects: [], threads: [{ id: 'A' }, { id: 'B' }], nextCursor: null });
  await second;
  assert.equal(app.state.threads.length, 2);
  assert.equal(app.state.threadsNextCursor, null);
});

test('empty reasoning stays hidden and indexed summary streaming produces readable text without duplicates', () => {
  const app = setup(), view = app.state.currentView;
  for (const summary of [undefined, [], ['', ' \n']]) {
    app.notify('item/started', { threadId: 'A', item: { id: 'reasoning', type: 'reasoning', summary, content: ['private'] } });
    assert.equal(view.itemElements.has('reasoning'), false);
  }
  app.notify('item/reasoning/summaryTextDelta', { threadId: 'A', itemId: 'reasoning', summaryIndex: 0, delta: '**公开' });
  app.notify('item/reasoning/summaryTextDelta', { threadId: 'A', itemId: 'reasoning', summaryIndex: 0, delta: '摘要**' });
  app.notify('item/reasoning/summaryTextDelta', { threadId: 'A', itemId: 'reasoning', summaryIndex: 1, delta: '第二段' });
  const body = view.itemElements.get('reasoning').querySelector('.tool-card-body');
  assert.equal(body.textContent, '**公开摘要**\n\n第二段');
  app.notify('item/completed', { threadId: 'A', item: { id: 'reasoning', type: 'reasoning', summary: ['**公开摘要**', '第二段'], content: ['private'] } });
  assert.equal(body.textContent, '**公开摘要**\n\n第二段');
  app.renderThreadItem({ id: 'reasoning', type: 'reasoning', summary: [] });
  assert.equal(body.textContent, '**公开摘要**\n\n第二段');
  assert.doesNotMatch(view.messages.textContent, /summary|private/);
});

test('a late history snapshot cannot erase a streaming reasoning summary', async () => {
  const app = setup(), view = app.state.currentView;
  const loading = app.loadThreadHistory(view);
  app.notify('item/reasoning/summaryTextDelta', { threadId: 'A', itemId: 'r', delta: '最新摘要' });
  app.respond(app.sent[0], history('turn', [{ id: 'r', type: 'reasoning', summary: ['旧摘要'] }]));
  await loading;
  assert.equal(view.itemElements.get('r').querySelector('.tool-card-body').textContent, '最新摘要');
});

test('pending controls stay in the current chat while sidebar badges track background answers and approvals', () => {
  const app = setup(), a = app.state.currentView;
  app.state.threads = [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }];
  app.renderWorkspacesDrawer();
  app.activateThreadView(app.getThreadView('B'));
  app.notify('item/completed', { threadId: 'A', item: asyncQuestionItem() });
  app.handleIncomingCodexPayload(questionRequest());
  const row = (id) => app.el.workspacesContainer.querySelectorAll('.thread-item').find((node) => node.dataset.threadId === id);
  assert.equal(row('A').querySelector('.thread-pending-badge').textContent, '3 项待处理');
  assert.equal(row('B').querySelectorAll('.thread-pending-badge').length, 0);
  assert.equal(app.el.btnPendingRequests.classList.contains('hidden'), true);
  app.el.btnPendingRequests.onclick();
  assert.equal(app.state.currentThreadId, 'B');
  app.activateThreadView(a);
  assert.equal(app.el.btnPendingRequests.textContent, '3 项待处理');
  app.el.btnPendingRequests.onclick();
  assert.equal(a.interactionCards.get('question').element.scrolledIntoView, true);
  app.activateThreadView(app.getThreadView('B'));
  app.notify('item/completed', { threadId: 'A', item: user('reply', asyncReplyText()) });
  assert.equal(row('A').querySelector('.thread-pending-badge').textContent, '2 项待处理');
  app.notify('serverRequest/resolved', { requestId: 'question' });
  app.notify('item/completed', { threadId: 'A', item: user('reply-2', asyncReplyText(1)) });
  assert.equal(row('A').querySelectorAll('.thread-pending-badge').length, 0);
  assert.equal(app.el.btnPendingRequests.classList.contains('hidden'), true);
});

test('pending badges cover unloaded chats and collapsed groups without leaking across devices', () => {
  const app = setup();
  app.applyAgentState({ epoch: 'epoch', revision: 1, status: 'ready', activeTurns: [], requests: [questionRequest()] }, 'agent');
  assert.equal(app.el.workspacesContainer.querySelectorAll('.thread-item').length, 1);
  app.state.collapsedWorkspaces.add('__other__');
  app.renderWorkspacesDrawer();
  assert.equal(app.el.workspacesContainer.querySelectorAll('.thread-item').length, 0);
  assert.equal(app.el.workspacesContainer.querySelectorAll('.thread-pending-badge')[0].textContent, '1 项待处理');
  app.state.selectedAgentId = 'other';
  app.state.threads = [{ id: 'A', name: 'same id on other device' }];
  app.activateThreadView(app.getThreadView('A'));
  app.renderWorkspacesDrawer();
  assert.equal(app.el.workspacesContainer.querySelectorAll('.thread-pending-badge').length, 0);
  assert.equal(app.el.btnPendingRequests.classList.contains('hidden'), true);
});

test('unscoped device requests do not become pending requests of the current chat', () => {
  const app = setup(), request = questionRequest();
  delete request.params.threadId;
  app.handleIncomingCodexPayload(request);
  assert.equal(app.state.currentView.approvals.size, 0);
  assert.equal(app.getThreadView(null).approvals.size, 1);
  assert.equal(app.el.btnPendingRequests.classList.contains('hidden'), true);
  assert.match(app.el.workspacesContainer.textContent, /设备待处理请求/);
});

test('bounded history renders before status returns and rapid switches reuse content and drafts', async () => {
  const app = setup(), view = app.state.currentView;
  const loading = app.openExistingThread({ id: 'A' });
  await app.openExistingThread({ id: 'A' });
  assert.equal(app.sent.length, 2, 'coalesce in-flight page requests');
  assert.equal(app.sent[0].payload.method, 'thread/items/list');
  assert.equal(app.sent[0].payload.params.limit, 60);
  assert.equal(app.sent[1].payload.params.itemsView, 'notLoaded');
  assert.equal(app.sent[1].payload.params.limit, 1);
  app.respond(app.sent[0], history('turn', [agent('text', '**history**'), asyncQuestionItem()], 'older'));
  await loading; // No response to the status request: it must not block the messages.
  const card = view.asyncQuestions.get(asyncQuestionId(1)).card.element;
  card.querySelector('textarea').value = '草稿';
  app.activateThreadView(app.getThreadView('B'));
  await app.openExistingThread({ id: 'A' });
  assert.equal(app.sent.length, 2);
  assert.equal(card.querySelector('textarea').value, '草稿');
  const body = view.itemElements.get('text');
  const refresh = app.loadThreadHistory(view);
  app.respond(app.sent[2], history('turn', [agent('text', '**history**'), asyncQuestionItem()], 'older'));
  await refresh;
  assert.equal(body.markdownRenders, 1, 'unchanged Markdown is not reparsed');
  assert.equal(view.asyncQuestions.get(asyncQuestionId(1)).card.element, card);
  assert.equal(card.querySelector('textarea').value, '草稿');
});

test('paging older question receipts and refreshing latest preserves the oldest cursor', async () => {
  const app = setup(), view = app.state.currentView;
  const first = app.loadThreadHistory(view);
  app.respond(app.sent[0], history('answer-turn', [user('reply', asyncReplyText())], 'questions'));
  await first;
  const older = app.loadThreadHistory(view, { older: true });
  app.respond(app.sent[2], history('question-turn', [asyncQuestionItem()], 'older-still'));
  await older;
  assert.equal(view.asyncQuestions.get(asyncQuestionId()).answered, true);
  assert.equal(view.asyncQuestions.get(asyncQuestionId(1)).answered, false);
  const refresh = app.loadThreadHistory(view);
  app.respond(app.sent[3], history('answer-turn', [user('reply', asyncReplyText())], 'questions'));
  await refresh;
  assert.equal(view.historyCursor, 'older-still');
  assert.equal(view.historyOrder.join(','), 'call_real_async,reply');
});

test('history can fill a gap after a long disconnect without reversing already cached messages', async () => {
  const app = setup(), view = app.state.currentView;
  let loading = app.loadThreadHistory(view);
  app.respond(app.sent[1], { data: [] });
  app.respond(app.sent[0], history('turn', [agent('old', 'old')])); await loading;
  loading = app.loadThreadHistory(view);
  app.respond(app.sent[2], history('turn', [agent('new', 'new')], 'gap')); await loading;
  loading = app.loadThreadHistory(view, { older: true });
  assert.equal(app.sent[4].payload.params.cursor, 'gap');
  app.respond(app.sent[4], history('turn', [agent('old', 'old'), agent('middle', 'middle')])); await loading;
  assert.equal(view.messages.textContent, 'oldmiddlenew');
  assert.equal(view.historyCursor, null);
});

test('cloud files render untrusted names as text and downloads always use authenticated same-origin routes', async () => {
  const id = 'a'.repeat(32);
  const filename = '<img src=x onerror=alert(1)>.html';
  const calls = [];
  const app = setup({ fetch: async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ ok: true, files: [{ id, name: filename, size: 2500, createdAt: Date.now(),
      agentName: '<b>Agent</b>', downloadUrl: 'https://evil.test/leak' }], nextCursor: 'next', storage: { usedBytes: 2500, maxBytes: 10000 } }) };
  } });
  await app.loadCloudFiles();
  const link = app.el.filesList.querySelector('a');
  assert.equal(link.href, `/api/files/${id}/download`);
  assert.equal(link.download, filename);
  assert.equal(app.el.filesList.querySelector('.cloud-file-name').textContent, filename);
  assert.equal(app.el.filesList.querySelectorAll('img').length, 0);
  assert.equal(app.el.btnMoreFiles.classList.contains('hidden'), false);
  await app.loadCloudFiles({ more: true });
  assert.match(calls[1], /cursor=next/);
  assert.equal(app.el.filesList.querySelectorAll('a').length, 1, 'Pagination deduplicates entries');
});

test('cloud file refresh ignores stale replies and reports expired login without replacing chat state', async () => {
  const pending = [];
  const app = setup({ fetch: () => new Promise((resolve) => pending.push(resolve)) });
  const first = app.loadCloudFiles(), second = app.loadCloudFiles();
  pending[1]({ ok: true, json: async () => ({ ok: true, files: [], nextCursor: null }) }); await second;
  pending[0]({ ok: true, json: async () => ({ ok: true, files: [{ id: 'b'.repeat(32), name: 'stale' }] }) }); await first;
  assert.equal(app.state.files.items.length, 0);
  const current = app.state.currentView;
  const expired = app.loadCloudFiles();
  pending[2]({ ok: false, status: 401, json: async () => ({ ok: false }) }); await expired;
  assert.match(app.el.filesStatus.textContent, /登录已过期/);
  assert.equal(app.state.currentView, current);
  assert.equal(app.state.files.loading, false);
});

test('polling reads external messages without live events and does not infer stopped from history', async () => {
  const app = setup(), view = app.state.currentView;
  app.state.threadsLoadedAt = Date.now();
  const first = app.refreshVisibleThread();
  app.respond(app.sent[0], history('external', [user('u', 'task'), agent('answer', 'first')]));
  app.respond(app.sent[1], { data: [{ id: 'external', status: 'interrupted' }] });
  await first;
  assert.match(app.el.threadStatus.textContent, /外部会话/);
  assert.doesNotMatch(app.el.threadStatus.textContent, /任务已停止/);
  const bubble = view.itemElements.get('answer');
  app.applyAgentState({ epoch: 'first', revision: 1, requests: [], activeTurns: [] }, 'agent');
  app.applyAgentState({ epoch: 'second', revision: 1, requests: [], activeTurns: [] }, 'agent');
  assert.doesNotMatch(view.messages.textContent, /已重启/);
  const second = app.refreshVisibleThread();
  app.respond(app.sent[2], history('external', [user('u', 'task'), agent('answer', 'first, updated'), agent('next', 'new message')]));
  app.respond(app.sent[3], { data: [{ id: 'external', status: 'completed' }] });
  await second;
  assert.equal(view.itemElements.get('answer'), bubble);
  assert.match(view.messages.textContent, /first, updatednew message/);
  assert.equal(app.el.threadStatus.textContent, '本轮已完成');
});

test('polling pauses when hidden or offline, avoids overlaps and preserves the captured thread after navigation', async () => {
  const app = setup(), a = app.state.currentView;
  app.state.threadsLoadedAt = Date.now();
  app.document.visibilityState = 'hidden';
  await app.refreshVisibleThread();
  assert.equal(app.sent.length, 0);
  app.document.visibilityState = 'visible';
  app.state.agents[0].online = false;
  await app.refreshVisibleThread();
  assert.equal(app.sent.length, 0);
  app.state.agents[0].online = true;
  const polling = app.refreshVisibleThread();
  await app.refreshVisibleThread();
  assert.equal(app.sent.length, 2);
  const b = app.getThreadView('B');
  app.activateThreadView(b);
  app.el.promptInput.value = 'draft';
  app.respond(app.sent[0], history('external', [agent('a', 'A update')]));
  app.respond(app.sent[1], { data: [] });
  await polling;
  assert.equal(a.messages.textContent, 'A update');
  assert.equal(b.messages.textContent, '');
  assert.equal(app.el.promptInput.value, 'draft');
  const retry = app.refreshVisibleThread();
  app.respond(app.sent[2], undefined, { message: 'temporary' });
  app.respond(app.sent[3], { data: [] });
  await retry;
  assert.equal(b.messages.textContent, '');
  assert.match(app.el.threadStatus.textContent, /自动重试/);
  const recovery = app.refreshVisibleThread();
  app.respond(app.sent[4], history('b', [agent('b', 'B recovered')]));
  app.respond(app.sent[5], { data: [] });
  await recovery;
  assert.equal(b.historySyncError, null);
  assert.equal(b.messages.textContent, 'B recovered');
});

test('scheduled polling reschedules after errors and cannot erase a locally confirmed running turn', async () => {
  const app = setup();
  app.state.threadsLoadedAt = Date.now();
  app.notify('turn/started', { threadId: 'A', turn: { id: 'local' } });
  app.scheduleHistoryRefresh();
  const timer = app.state.refreshTimer;
  const polling = app.timers.get(timer)();
  app.respond(app.sent[0], undefined, { message: 'temporary' });
  app.respond(app.sent[1], { data: [{ id: 'old', status: 'interrupted' }] });
  await polling;
  assert.notEqual(app.state.refreshTimer, timer);
  assert.equal(app.state.activeTurnId, 'local');
  assert.equal(app.el.btnStopTurn.classList.contains('hidden'), false);
});

test('sidebar groups and threads follow recent updates and background refresh retains older pages', async () => {
  const app = setup();
  app.state.projects = [{ id: 'p', name: 'P' }, { id: 'q', name: 'Q' }];
  app.state.threads = [
    { id: 'old', projectId: 'p', updatedAt: 10 },
    { id: 'new', projectId: 'p', updatedAt: 30 },
    { id: 'middle', projectId: 'q', updatedAt: 20 },
  ];
  app.state.threadsNextCursor = 'older-page';
  app.renderWorkspacesDrawer();
  const order = () => app.el.workspacesContainer.querySelectorAll('.thread-item').map((node) => node.dataset.threadId);
  assert.deepEqual(order(), ['new', 'old', 'middle']);
  const loading = app.loadWorkspacesAndThreads({ background: true });
  app.respond(app.sent[0], { projects: [], threads: [{ id: 'middle', projectId: 'q', updatedAt: 40 }], nextCursor: 'first-page-cursor' });
  await loading;
  assert.deepEqual(order(), ['middle', 'new', 'old']);
  assert.equal(app.state.threadsNextCursor, 'older-page');
  assert.equal(app.state.threads.length, 3);
});

test('older Agents use a native sorted query, including pagination and workspace discovery', async () => {
  const app = setup();
  const first = app.loadWorkspacesAndThreads();
  app.respond(app.sent[0], { threadSortKey: null, projects: [], threads: [{ id: 'created-recently' }] });
  await tick();
  const sorted = app.sent[1];
  assert.equal(sorted.payload.method, 'thread/list');
  assert.equal(sorted.payload.params.sortKey, 'updated_at');
  assert.equal(sorted.payload.params.sortDirection, 'desc');
  app.respond(sorted, { data: [{ id: 'old-but-used-today', cwd: '/work/project', updatedAt: 100 }], nextCursor: 'sorted-next' });
  await first;
  assert.equal(app.state.threads[0].id, 'old-but-used-today');
  assert.equal(app.state.threads[0].projectId, 'cwd:/work/project');
  const second = app.loadWorkspacesAndThreads({ more: true });
  assert.equal(app.sent[2].payload.params.cursor, undefined, 'legacy composite queries must not receive a cursor from another sort order');
  app.respond(app.sent[2], { threadSortKey: null, projects: [], threads: [] });
  await tick();
  assert.equal(app.sent[3].payload.params.cursor, 'sorted-next');
  app.respond(app.sent[3], { data: [], nextCursor: null });
  await second;
  assert.equal(app.state.threads.length, 1);
});

test('polling can recover a missed local completion after the Agent snapshot clears the active turn', async () => {
  const app = setup(), view = app.state.currentView;
  app.applyAgentState({ epoch: 'same', revision: 1, requests: [], activeTurns: [{ threadId: 'A', turnId: 'local' }] }, 'agent');
  app.applyAgentState({ epoch: 'same', revision: 2, requests: [], activeTurns: [] }, 'agent');
  const loading = app.loadThreadHistory(view);
  app.respond(app.sent[0], history('local', [agent('answer', 'done')]));
  app.respond(app.sent[1], { data: [{ id: 'local', status: 'completed' }] });
  await loading;
  assert.equal(app.el.threadStatus.textContent, '本轮已完成');
});

test('stale list replies cannot replace a newer manual refresh', async () => {
  const app = setup();
  const background = app.loadWorkspacesAndThreads({ background: true });
  const manual = app.loadWorkspacesAndThreads();
  app.respond(app.sent[1], { threads: [{ id: 'latest', updatedAt: 20 }] });
  await manual;
  app.respond(app.sent[0], { threads: [{ id: 'stale', updatedAt: 10 }] });
  await background;
  assert.equal(app.state.threads[0].id, 'latest');
  assert.equal(app.state.loadingThreads, false);
});

test('workspace directory selection handles native fileName entries and navigates into the selected child', async () => {
  const app = setup();
  const loading = app.openDirectoryBrowser('/workspace/');
  assert.equal(app.sent[0].payload.method, 'fs/readDirectory');
  assert.equal(app.sent[0].payload.params.path, '/workspace/');
  app.respond(app.sent[0], { entries: [
    { fileName: 'z-project', isDirectory: true, isFile: false },
    { fileName: 'a project', isDirectory: true, isFile: false },
    { fileName: '.private', isDirectory: true, isFile: false },
    { fileName: 'README.md', isDirectory: false, isFile: true },
  ] });
  await loading;
  const rows = app.el.dirEntriesList.querySelectorAll('.dir-entry');
  assert.deepEqual(rows.map((row) => row.textContent), ['.. (返回上级目录)', 'a project/', 'z-project/']);
  const child = rows[1].onclick();
  assert.equal(app.sent[1].payload.params.path, '/workspace/a project');
  app.respond(app.sent[1], { entries: [] });
  await child;
  app.el.btnSelectDir.onclick();
  assert.equal(app.state.selectedCwd, '/workspace/a project');
  assert.equal(app.state.currentThreadId, null);
});

test('directory browsing accepts legacy names and skips incomplete entries without throwing', async () => {
  const app = setup();
  const loading = app.openDirectoryBrowser('/');
  app.respond(app.sent[0], { entries: [
    null, { isDirectory: true }, { fileName: 42, isDirectory: true },
    { name: 'legacy', isDirectory: true }, { fileName: '<project>', isDirectory: true },
  ] });
  await loading;
  assert.deepEqual(app.el.dirEntriesList.querySelectorAll('.dir-entry').map((row) => row.textContent), ['<project>/', 'legacy/']);
  assert.equal(app.el.dirEntriesList.querySelectorAll('project').length, 0);
});

test('older directory replies and failures cannot overwrite the latest navigation or another device', async () => {
  const app = setup();
  const old = app.openDirectoryBrowser('/old');
  const latest = app.openDirectoryBrowser('/new');
  app.respond(app.sent[1], { entries: [{ fileName: 'current', isDirectory: true }] });
  await latest;
  app.respond(app.sent[0], undefined, { message: 'old failure' });
  await old;
  assert.equal(app.el.inputDirPath.value, '/new');
  assert.match(app.el.dirEntriesList.textContent, /current/);
  const stale = app.openDirectoryBrowser('/stale');
  app.state.selectedAgentId = 'other';
  app.respond(app.sent[2], { entries: [{ fileName: 'wrong-device', isDirectory: true }] });
  await stale;
  assert.equal(app.el.dirEntriesList.querySelectorAll('.dir-entry').length, 0);
});
