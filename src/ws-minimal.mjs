import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * Minimal, standards-compliant RFC 6455 WebSocket connection wrapper (zero external dependencies).
 * Supports text frames, fragmented frames, ping/pong keepalive, and clean close handshakes.
 */
export class MinimalWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  /**
   * @param {import('node:net').Socket} socket
   * @param {{ isServer: boolean, maxPayloadBytes?: number }} options
   */
  constructor(socket, { isServer = true, maxPayloadBytes = 32 * 1024 * 1024 } = {}) {
    super();
    this.socket = socket;
    this.isServer = isServer;
    this.maxPayloadBytes = maxPayloadBytes;
    this.readyState = MinimalWebSocket.OPEN;
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOpcode = 0;
    this._fragmentBytes = 0;

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('end', () => this._finalizeClose(1000, 'socket end'));
    socket.on('close', () => this._finalizeClose(1006, 'socket close'));
    socket.on('error', (err) => {
      // A peer resetting its socket must not crash the relay without a listener.
      try {
        if (this.listenerCount('error') > 0) this.emit('error', err);
      } finally {
        this._finalizeClose(1006, err.message);
      }
    });
  }

  /**
   * Send a UTF-8 text message or JSON-serializable object.
   * @param {string | object} data
   */
  send(data) {
    if (this.readyState !== MinimalWebSocket.OPEN) return false;
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    const payload = Buffer.from(text, 'utf8');
    this._writeFrame(0x1, payload);
    return true;
  }

  ping(data = Buffer.alloc(0)) {
    if (this.readyState !== MinimalWebSocket.OPEN) return;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    this._writeFrame(0x9, payload);
  }

  close(code = 1000, reason = '') {
    if (this.readyState === MinimalWebSocket.CLOSED || this.readyState === MinimalWebSocket.CLOSING) {
      return;
    }
    this.readyState = MinimalWebSocket.CLOSING;
    const reasonBuf = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this._writeFrame(0x8, payload);
    setTimeout(() => {
      if (!this.socket.destroyed) this.socket.destroy();
    }, 1000).unref();
  }

  _writeFrame(opcode, payload) {
    if (this.socket.destroyed) return;
    const maskBit = this.isServer ? 0 : 0x80;
    const len = payload.length;
    let headerLen = 2;
    if (len >= 126 && len <= 65535) headerLen += 2;
    else if (len > 65535) headerLen += 8;

    const maskKey = this.isServer ? null : crypto.randomBytes(4);
    const frame = Buffer.allocUnsafe(headerLen + (maskKey ? 4 : 0) + len);
    frame[0] = 0x80 | (opcode & 0x0f);

    let offset = 2;
    if (len < 126) {
      frame[1] = maskBit | len;
    } else if (len <= 65535) {
      frame[1] = maskBit | 126;
      frame.writeUInt16BE(len, 2);
      offset = 4;
    } else {
      frame[1] = maskBit | 127;
      frame.writeBigUInt64BE(BigInt(len), 2);
      offset = 10;
    }

    if (maskKey) {
      maskKey.copy(frame, offset);
      offset += 4;
      for (let i = 0; i < len; i++) {
        frame[offset + i] = payload[i] ^ maskKey[i & 3];
      }
    } else {
      payload.copy(frame, offset);
    }

    try {
      this.socket.write(frame);
    } catch {
      // ignore write after close
    }
  }

  _onData(chunk) {
    this._buffer = this._buffer.length === 0 ? chunk : Buffer.concat([this._buffer, chunk]);

    while (this._buffer.length >= 2) {
      const firstByte = this._buffer[0];
      const secondByte = this._buffer[1];
      const fin = (firstByte & 0x80) !== 0;
      const opcode = firstByte & 0x0f;
      const masked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this._buffer.length < 4) return;
        payloadLen = this._buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this._buffer.length < 10) return;
        const bigLen = this._buffer.readBigUInt64BE(2);
        if (bigLen > BigInt(this.maxPayloadBytes)) {
          this.close(1009, 'Payload too large');
          this.socket.destroy();
          return;
        }
        payloadLen = Number(bigLen);
        offset = 10;
      }

      if (payloadLen > this.maxPayloadBytes) {
        this.close(1009, 'Payload too large');
        this.socket.destroy();
        return;
      }

      const maskLen = masked ? 4 : 0;
      const totalFrameLen = offset + maskLen + payloadLen;
      if (this._buffer.length < totalFrameLen) return;

      let payload = this._buffer.subarray(offset + maskLen, totalFrameLen);
      if (masked) {
        const maskKey = this._buffer.subarray(offset, offset + 4);
        const unmasked = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i++) {
          unmasked[i] = payload[i] ^ maskKey[i & 3];
        }
        payload = unmasked;
      } else {
        payload = Buffer.from(payload);
      }

      this._buffer = this._buffer.subarray(totalFrameLen);
      this._handleFrame(fin, opcode, payload);
    }
  }

  _handleFrame(fin, opcode, payload) {
    if (opcode === 0x8) {
      // Close frame
      let code = 1000;
      let reason = '';
      if (payload.length >= 2) {
        code = payload.readUInt16BE(0);
        reason = payload.subarray(2).toString('utf8');
      }
      if (this.readyState === MinimalWebSocket.OPEN) {
        this.readyState = MinimalWebSocket.CLOSING;
        this._writeFrame(0x8, payload.subarray(0, 2));
      }
      this.socket.end();
      this._finalizeClose(code, reason);
      return;
    }

    if (opcode === 0x9) {
      // Ping -> Pong
      this._writeFrame(0xA, payload);
      this.emit('ping', payload);
      return;
    }

    if (opcode === 0xA) {
      this.emit('pong', payload);
      return;
    }

    if (opcode === 0x0) {
      // Continuation frame
      this._fragmentBytes += payload.length;
      if (this._fragmentBytes > this.maxPayloadBytes) {
        this.close(1009, 'Payload too large');
        return;
      }
      this._fragments.push(payload);
      if (fin) {
        const full = Buffer.concat(this._fragments);
        const mode = this._fragmentOpcode;
        this._fragments = [];
        this._fragmentBytes = 0;
        this._fragmentOpcode = 0;
        this._deliverMessage(mode, full);
      }
      return;
    }

    if (opcode === 0x1 || opcode === 0x2) {
      if (fin) {
        this._deliverMessage(opcode, payload);
      } else {
        this._fragmentOpcode = opcode;
        this._fragments = [payload];
        this._fragmentBytes = payload.length;
      }
    }
  }

  _deliverMessage(opcode, buffer) {
    if (opcode === 0x1) {
      this.emit('message', buffer.toString('utf8'));
    } else {
      this.emit('message', buffer);
    }
  }

  _finalizeClose(code, reason) {
    if (this.readyState === MinimalWebSocket.CLOSED) return;
    this.readyState = MinimalWebSocket.CLOSED;
    this.emit('close', code, reason);
  }
}

/**
 * Upgrade an incoming HTTP request to a MinimalWebSocket.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:net').Socket} socket
 * @param {Buffer} head
 * @returns {MinimalWebSocket | null}
 */
export function acceptWebSocketUpgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = req.headers['upgrade'];
  if (!key || typeof key !== 'string' || String(upgrade).toLowerCase() !== 'websocket') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return null;
  }

  const accept = crypto
    .createHash('sha1')
    .update(key.trim() + WS_GUID)
    .digest('base64');

  const responseHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n',
  ];
  socket.write(responseHeaders.join('\r\n'));

  const ws = new MinimalWebSocket(socket, { isServer: true });
  if (head && head.length > 0) {
    const initialHead = Buffer.from(head);
    setImmediate(() => ws._onData(initialHead));
  }
  return ws;
}

/**
 * Connect as a WebSocket client to a ws:// or wss:// URL.
 * @param {string} urlString
 * @param {{ headers?: Record<string, string>, timeoutMs?: number, ca?: string | Buffer }} [options]
 * @returns {Promise<MinimalWebSocket>}
 */
export function connectWebSocketClient(urlString, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const isSecure = url.protocol === 'wss:' || url.protocol === 'https:';
    const clientMod = isSecure ? https : http;
    const key = crypto.randomBytes(16).toString('base64');
    const expectedAccept = crypto
      .createHash('sha1')
      .update(key + WS_GUID)
      .digest('base64');

    const req = clientMod.request({
      protocol: isSecure ? 'https:' : 'http:',
      hostname: url.hostname,
      port: url.port || (isSecure ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
        ...(options.headers || {}),
      },
      timeout: options.timeoutMs ?? 10000,
      ...(isSecure && options.ca ? { ca: options.ca } : {}),
    });

    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(err);
    };

    req.on('upgrade', (res, socket, head) => {
      if (settled) return;
      if (res.headers['sec-websocket-accept'] !== expectedAccept) {
        fail(new Error('Invalid Sec-WebSocket-Accept header'));
        return;
      }
      settled = true;
      const ws = new MinimalWebSocket(socket, { isServer: false });
      if (head && head.length > 0) {
        const initialHead = Buffer.from(head);
        setImmediate(() => ws._onData(initialHead));
      }
      resolve(ws);
    });

    req.on('response', (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        fail(new Error(`Unexpected HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
      });
    });

    req.on('timeout', () => fail(new Error('WebSocket connection timeout')));
    req.on('error', fail);
    req.end();
  });
}
