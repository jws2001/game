'use strict';

/**
 * 极简 WebSocket 服务端实现（RFC 6455），零依赖。
 * 只处理文本消息、ping/pong、close 与分片。
 */

const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 256 * 1024;

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

class WSConnection {
  constructor(socket, meta = {}) {
    this.socket = socket;
    this.meta = meta;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.alive = true;
    this.closed = false;
    this.onmessage = null;
    this.onclose = null;

    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      this.alive = true;
      this._onData(chunk);
    });
    socket.on('close', () => this._finish());
    socket.on('error', () => this._finish());
    socket.on('end', () => this._finish());
  }

  get id() {
    return this.meta.id;
  }

  _onData(chunk) {
    if (this.closed) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;

    while (!this.closed) {
      const buf = this.buffer;
      if (buf.length < 2) return;

      const first = buf[0];
      const second = buf[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (buf.length < 4) return;
        length = buf.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buf.length < 10) return;
        const high = buf.readUInt32BE(2);
        const low = buf.readUInt32BE(6);
        if (high > 0) return this.close(1009, 'message too large');
        length = low;
        offset = 10;
      }

      if (length > MAX_MESSAGE) return this.close(1009, 'message too large');
      if (!masked) return this.close(1002, 'client frames must be masked');

      if (buf.length < offset + 4) return;
      const maskKey = buf.subarray(offset, offset + 4);
      offset += 4;

      if (buf.length < offset + length) return;
      const payload = Buffer.from(buf.subarray(offset, offset + length));
      this.buffer = buf.subarray(offset + length);

      for (let i = 0; i < payload.length; i += 1) {
        payload[i] ^= maskKey[i & 3];
      }

      this._handleFrame(fin, opcode, payload);
    }
  }

  _handleFrame(fin, opcode, payload) {
    if (opcode === 0x8) {
      this.close(1000, 'bye');
      return;
    }
    if (opcode === 0x9) {
      this._sendFrame(0x0a, payload);
      return;
    }
    if (opcode === 0x0a) {
      this.alive = true;
      return;
    }
    if (opcode === 0x1 || opcode === 0x2) {
      if (fin) {
        this._deliver(payload);
      } else {
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
      }
      return;
    }
    if (opcode === 0x0) {
      if (!this.fragmentOpcode) return this.close(1002, 'unexpected continuation');
      this.fragments.push(payload);
      if (fin) {
        const full = Buffer.concat(this.fragments);
        this.fragments = [];
        this.fragmentOpcode = 0;
        this._deliver(full);
      }
    }
  }

  _deliver(payload) {
    if (!this.onmessage) return;
    try {
      this.onmessage(payload.toString('utf8'));
    } catch (err) {
      // 忽略无法解析的消息
    }
  }

  sendJSON(data) {
    this._sendFrame(0x1, Buffer.from(JSON.stringify(data)));
  }

  ping() {
    this._sendFrame(0x9, Buffer.alloc(0));
  }

  _sendFrame(opcode, payload) {
    if (this.closed || !this.socket.writable) return;
    const length = payload.length;
    let header;

    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeUInt32BE(Math.floor(length / 2 ** 32), 2);
      header.writeUInt32BE(length >>> 0, 6);
    }

    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch (err) {
      this._finish();
    }
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this._sendFrame(0x8, body);
    this.closed = true;
    try {
      this.socket.end();
    } catch (err) {
      /* noop */
    }
    this._finish();
  }

  _finish() {
    if (this.finished) return;
    this.finished = true;
    this.closed = true;
    if (typeof this.onclose === 'function') {
      try {
        this.onclose();
      } catch (err) {
        /* noop */
      }
    }
  }
}

module.exports = { WSConnection, acceptKey };
