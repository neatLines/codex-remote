#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const log = (event) => fs.appendFileSync(path.join(process.cwd(), 'fake-codex.log'), `${process.pid} ${event}\n`);
const emit = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);
const pending = new Map();
log('start');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === undefined) {
    const original = pending.get(request.id);
    if (original) {
      log('interaction-response');
      pending.delete(request.id);
      setTimeout(() => {
        emit({ method: 'serverRequest/resolved', params: { threadId: original.threadId, requestId: request.id } });
        if (original.finishTurn) emit({ method: 'turn/completed', params: { threadId: original.threadId, turn: { id: 'turn', status: 'completed' } } });
      }, 60);
    }
    return;
  }
  const reply = (result) => emit({ id: request.id, result });
  const threadId = request.params?.threadId || 'fixture-thread';
  if (request.method === 'initialize') reply({});
  else if (request.method === 'config/read') reply({ config: { model: 'fixture-model' } });
  else if (request.method === 'model/list') reply({ data: [] });
  else if (request.method === 'thread/list') {
    log(`thread-list ${request.params?.sortKey} ${request.params?.sortDirection}`);
    if (request.params?.limit === 999) return;
    reply({ data: [{ id: request.params?.cursor ? 'fixture-page-2' : threadId, cwd: process.cwd(), preview: 'Fixture thread' }],
      nextCursor: request.params?.cursor ? null : 'fixture-next-page' });
  }
  else if (request.method === 'thread/resume') {
    if (threadId !== 'hang-resume') reply({ thread: { id: threadId } });
  }
  else if (request.method === 'thread/turns/list') {
    log('history-start');
    setTimeout(() => { log('history-reply'); reply({ data: [{ id: 'turn', status: 'completed', items: [] }] }); }, 700);
  } else if (request.method === 'fixture/requestInteraction') {
    const id = request.params.requestId || 'fixture-question';
    pending.set(id, { threadId, finishTurn: false });
    emit({ id, method: request.params.method || 'item/tool/requestUserInput', params: {
      threadId, turnId: 'turn', itemId: 'item', isBlocking: true,
      questions: [{ id: 'choice', header: '选择', question: '选择一个方案', options: [{ label: 'One', description: 'one' }, { label: 'Two', description: 'two' }] }],
    } });
    reply({ requestId: id });
  } else if (request.method === 'fixture/hang') {
    log('hanging-request');
  } else if (request.method === 'fixture/crash') {
    process.exit(1);
  } else if (request.method === 'turn/steer') {
    reply({ turnId: request.params.expectedTurnId });
    emit({ method: 'item/completed', params: { threadId, item: { id: 'steer-user', type: 'userMessage', content: request.params.input } } });
  } else if (request.method === 'turn/start') {
    if (request.params?.input?.[0]?.text === 'fail') {
      log('turn-rejected');
      emit({ id: request.id, error: { code: -32000, message: 'fixture rejected turn' } });
    } else {
      emit({ method: 'turn/started', params: { threadId, turn: { id: 'turn', status: 'inProgress' } } });
      reply({ turn: { id: 'turn', status: 'inProgress' } });
      if (request.params?.input?.[0]?.text === 'ask') {
        pending.set('fixture-question', { threadId, finishTurn: true });
        emit({ id: 'fixture-question', method: 'item/tool/requestUserInput', params: {
          threadId, turnId: 'turn', itemId: 'item', isBlocking: true,
          questions: [{ id: 'choice', header: '选择', question: '选择一个方案', options: [{ label: 'One', description: 'one' }] }],
        } });
      } else setTimeout(() => emit({ method: 'turn/completed', params: { threadId, turn: { id: 'turn', status: 'completed' } } }), 20);
    }
  } else reply({});
});
