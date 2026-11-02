import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentInteractions } from '../src/agent-interactions.mjs';
import { validateFormValue, interactionKind, decisionLabel } from '../src/public/interactions.js';

const request = { id: 7, method: 'item/tool/requestUserInput', params: { threadId: 'thread', questions: [] } };
function setup(write = () => true, timeoutMs = 100) {
  const sent = [];
  const registry = new AgentInteractions({ write: (response) => { sent.push(response); return write(response); }, timeoutMs });
  registry.reset('epoch'); registry.capture(request);
  return { registry, sent, answer: { requestId: 7, requestEpoch: 'epoch', result: { answers: { q: { answers: ['private-answer'] } } } } };
}

test('interaction responses wait for a resolved event and deduplicate retries and other devices', async () => {
  const { registry, sent, answer } = setup();
  const first = registry.submit(answer);
  const second = registry.submit(answer);
  assert.equal(sent.length, 1);
  assert.equal(registry.snapshot()[0].state, 'submitting');
  assert.doesNotMatch(JSON.stringify(registry.snapshot()), /private-answer/);
  await assert.rejects(registry.submit({ ...answer, result: { answers: {} } }), /另一端/);
  registry.resolve(7);
  assert.equal((await first).resolved, true);
  assert.equal((await second).resolved, true);
  assert.equal((await registry.submit(answer)).resolved, true);
  assert.equal(sent.length, 1);
  await assert.rejects(registry.submit({ ...answer, result: { answers: {} } }), /其他答案/);
});

test('broken stdin preserves a pending interaction and allows a later retry', async () => {
  let writable = false;
  const { registry, sent, answer } = setup(() => writable);
  await assert.rejects(registry.submit(answer), /未发送/);
  assert.equal(registry.snapshot()[0].state, 'pending');
  writable = true;
  const retry = registry.submit(answer);
  registry.resolve(7);
  assert.equal((await retry).resolved, true);
  assert.equal(sent.length, 2);
});

test('acknowledgement timeout keeps an in-flight response without writing it twice', async () => {
  const { registry, sent, answer } = setup(() => true, 15);
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(registry.submit(answer), /尚未收到/);
    assert.equal(registry.snapshot()[0].state, 'submitting');
    const retry = registry.submit(answer);
    registry.resolve(7);
    await retry;
    assert.equal(sent.length, 1);
  } finally { clearTimeout(keepAlive); }
});

test('cancelled or old-process interactions reject stale responses and release waiting submissions', async () => {
  const { registry, answer } = setup();
  const first = registry.submit(answer);
  registry.cancelThread('thread', '轮次已停止');
  await assert.rejects(first, /已停止/);
  await assert.rejects(registry.submit(answer), /已停止/);
  registry.reset('new-epoch');
  registry.capture(request);
  await assert.rejects(registry.submit(answer), /已结束的 Codex 进程/);
  const next = registry.submit({ ...answer, requestEpoch: 'new-epoch' });
  registry.reset('third-epoch', '进程已退出');
  await assert.rejects(next, /已退出/);
});

test('MCP form validation enforces typed constraints and advertised options', () => {
  const schema = { type: 'object', required: ['count', 'region'], additionalProperties: false, properties: {
    count: { type: 'integer', minimum: 1, maximum: 3 },
    region: { type: 'string', oneOf: [{ const: 'east', title: 'East' }, { const: 'west', title: 'West' }] },
    choices: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', enum: ['a', 'b'] } },
  } };
  assert.deepEqual(validateFormValue({ count: 2, region: 'east', choices: ['a'] }, schema), { count: 2, region: 'east', choices: ['a'] });
  for (const value of [{ count: 1.5, region: 'east' }, { count: 9, region: 'east' }, { count: 1, region: 'other' },
    { count: 1 }, { count: 1, region: 'west', extra: true }, { count: 1, region: 'east', choices: ['c'] }]) {
    assert.throws(() => validateFormValue(value, schema));
  }
  assert.equal(interactionKind({ method: 'item/tool/call', params: { tool: 'functions.request_user_input_async' } }), 'dynamicQuestion');
  assert.match(decisionLabel({ applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.com', action: 'deny' } } }), /禁止/);
});
