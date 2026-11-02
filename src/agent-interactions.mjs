import crypto from 'node:crypto';

// Pending RPC callbacks belong to one app-server process, not one browser connection.
// Answers are never persisted, replayed to browsers or written to logs.
export class AgentInteractions {
  constructor({ write, changed = () => {}, timeoutMs = 15000 }) {
    this.write = write;
    this.changed = changed;
    this.timeoutMs = timeoutMs;
    this.epoch = null;
    this.pending = new Map();
    this.receipts = new Map();
  }

  reset(epoch, reason = '本机 Codex 已重启，旧交互已失效') {
    for (const request of this.pending.values()) this.finish(request, false, reason);
    this.pending.clear();
    this.receipts.clear();
    this.epoch = epoch;
    this.changed();
  }

  capture(payload) {
    if (payload.id === undefined || !payload.method) return;
    if (!this.pending.has(payload.id)) {
      this.pending.set(payload.id, { payload, state: 'pending', receivedAt: Date.now(), waiters: [], digest: null });
      this.changed();
    }
    return { ...payload, requestEpoch: this.epoch };
  }

  snapshot() {
    return [...this.pending.values()].map(({ payload, state, receivedAt }) => ({
      ...payload, requestEpoch: this.epoch, state, receivedAt,
    }));
  }

  finish(request, accepted, reason) {
    for (const waiter of request.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      if (accepted) waiter.resolve({ resolved: true, requestId: request.payload.id, requestEpoch: this.epoch });
      else waiter.reject(new Error(reason));
    }
  }

  resolve(id, { cancelled = false, reason = '交互已取消或失效' } = {}) {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    this.receipts.set(id, { digest: request.digest, cancelled, reason });
    while (this.receipts.size > 200) this.receipts.delete(this.receipts.keys().next().value);
    this.finish(request, !cancelled, reason);
    this.changed();
  }

  cancelThread(threadId, reason) {
    for (const [id, request] of this.pending) {
      if (request.payload.params?.threadId === threadId || request.payload.params?.thread_id === threadId) {
        this.resolve(id, { cancelled: true, reason });
      }
    }
  }

  async submit({ requestId, requestEpoch, result, error }) {
    if (requestEpoch !== this.epoch) throw new Error('该交互属于已结束的 Codex 进程，请刷新会话');
    if ((result === undefined) === (error === undefined)) throw new Error('必须提供且只能提供一种交互响应');
    const response = { id: requestId, ...(error === undefined ? { result } : { error }) };
    const digest = crypto.createHash('sha256').update(JSON.stringify(response)).digest('hex');
    const receipt = this.receipts.get(requestId);
    if (receipt) {
      if (receipt.cancelled) throw new Error(receipt.reason);
      if (receipt.digest && receipt.digest !== digest) throw new Error('该交互已经提交了其他答案');
      return { resolved: true, requestId, requestEpoch };
    }
    const request = this.pending.get(requestId);
    if (!request) throw new Error('交互不存在或已失效，请同步会话');
    if (request.digest && request.digest !== digest) throw new Error('另一端正在提交该交互，请等待确认');
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        request.waiters = request.waiters.filter((entry) => entry !== waiter);
        reject(new Error('尚未收到 Codex 的处理确认；交互已保留，请同步状态后重试'));
      }, this.timeoutMs);
      waiter.timer.unref?.();
      request.waiters.push(waiter);
      if (request.state === 'submitting') return; // A retry waits for the original write; it never writes twice.
      request.state = 'submitting';
      request.digest = digest;
      this.changed();
      let written = false;
      try { written = this.write(response); } catch { /* treat a broken stdin as a failed write */ }
      if (!written) {
        request.state = 'pending';
        request.digest = null;
        this.finish(request, false, 'Codex 连接不可写，答案未发送，请重试');
        this.changed();
      }
    });
  }
}
