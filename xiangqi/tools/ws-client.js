'use strict';

/**
 * 测试/演示用的极简 WebSocket 客户端（零依赖）
 */

const crypto = require('crypto');
const net = require('net');

class TestClient {
  constructor(target) {
    if (typeof target === 'number') {
      this.host = '127.0.0.1';
      this.port = target;
      this.path = '/';
    } else {
      const url = new URL(String(target));
      this.host = url.hostname;
      this.port = Number(url.port) || (url.protocol === 'wss:' ? 443 : 80);
      this.path = `${url.pathname || '/'}${url.search || ''}`;
    }
    this.socket = null;
    this.onmessage = null;
    this.buf = Buffer.alloc(0);
    this.handshakeDone = false;
    this.state = null;
    this.welcome = null;
    this.errors = [];
    this.messages = [];
  }

  static connect(target) {
    const client = new TestClient(target);
    return client.open();
  }

  open() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const socket = net.connect(this.port, this.host, () => {
        socket.write(
          [
            `GET ${this.path} HTTP/1.1`,
            `Host: ${this.host}:${this.port}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            '',
            '',
          ].join('\r\n')
        );
      });
      this.socket = socket;

      const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), 4000);

      socket.on('data', (chunk) => {
        this.buf = Buffer.concat([this.buf, chunk]);

        if (!this.handshakeDone) {
          const end = this.buf.indexOf('\r\n\r\n');
          if (end === -1) return;
          const head = this.buf.subarray(0, end).toString();
          if (!/^HTTP\/1\.1 101/i.test(head)) {
            clearTimeout(timer);
            reject(new Error(`握手失败: ${head.split('\r\n')[0]}`));
            return;
          }
          this.handshakeDone = true;
          this.buf = this.buf.subarray(end + 4);
          clearTimeout(timer);
          resolve(this);
        }

        this.parseFrames();
      });

      socket.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      socket.on('close', () => {
        this.closed = true;
      });
    });
  }

  parseFrames() {
    for (;;) {
      if (this.buf.length < 2) return;
      const first = this.buf[0];
      const second = this.buf[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.buf.length < 4) return;
        length = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buf.length < 10) return;
        length = Number(this.buf.readBigUInt64BE(2));
        offset = 10;
      }

      let maskKey = null;
      if (masked) {
        if (this.buf.length < offset + 4) return;
        maskKey = this.buf.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this.buf.length < offset + length) return;
      const payload = Buffer.from(this.buf.subarray(offset, offset + length));
      this.buf = this.buf.subarray(offset + length);

      if (maskKey) {
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i & 3];
      }

      if (opcode === 0x1) {
        let msg;
        try {
          msg = JSON.parse(payload.toString('utf8'));
        } catch (err) {
          continue;
        }
        this.messages.push(msg);
        if (this.onmessage) this.onmessage(msg);
        if (msg.type === 'welcome') this.welcome = msg;
        if (msg.type === 'state') this.state = msg;
        if (msg.type === 'error') this.errors.push(msg.message);
      } else if (opcode === 0x9) {
        this.sendFrame(0x0a, payload);
      } else if (opcode === 0x8) {
        this.socket.end();
      }
    }
  }

  sendFrame(opcode, payload) {
    if (!this.socket || this.socket.destroyed) return;
    const mask = crypto.randomBytes(4);
    const length = payload.length;
    let header;

    if (length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | length]);
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }

    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  send(obj) {
    this.sendFrame(0x1, Buffer.from(JSON.stringify(obj)));
  }

  close() {
    if (!this.socket || this.socket.destroyed) return;
    this.socket.end();
  }
}


module.exports = { TestClient };
