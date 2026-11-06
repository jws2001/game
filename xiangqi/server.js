#!/usr/bin/env node
'use strict';

/**
 * 中国象棋 · 内网双人对战
 * 零依赖 Node.js 服务：静态资源 + WebSocket 房间 + 对局规则
 *
 * 启动: node server.js   (默认 3211 端口)
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { WSConnection, acceptKey } = require('./lib/ws');
const {
  RED,
  BLACK,
  createBoard,
  getLegalMoves,
  getCaptures,
  applyMove,
  undoLast,
} = require('./lib/rules');

const PORT = Number(process.env.PORT) || 3211;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const ROOM_TTL = 15 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const rooms = new Map();
const connections = new Map();

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function hostUrls() {
  const port = PORT;
  const urls = [`http://localhost:${port}`];
  const candidates = [];
  const interfaces = os.networkInterfaces();
  const virtual = /^(utun|ipsec|bridge|vmnet|docker|veth|tun|tap|awdl|llw|anpi|gif|stf)/i;

  for (const name of Object.keys(interfaces)) {
    if (virtual.test(name)) continue;
    for (const net of interfaces[name] || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      if (/^169\.254\./.test(net.address)) continue;
      candidates.push({ name, address: net.address });
    }
  }

  candidates.sort((a, b) => {
    const rank = (n) => (n === 'en0' ? 0 : n === 'en1' ? 1 : n.startsWith('en') ? 2 : 3);
    return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name);
  });

  for (const item of candidates) {
    const url = `http://${item.address}:${port}`;
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

function cleanName(input) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 12);
}

function normalizeRoomId(input) {
  if (typeof input !== 'string') return '';
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

function generateRoomId() {
  for (let i = 0; i < 500; i += 1) {
    const id = String(crypto.randomInt(1000, 10000));
    if (!rooms.has(id)) return id;
  }
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function otherSeat(seat) {
  return seat === RED ? BLACK : RED;
}

/* ------------------------------------------------------------------ */
/* 房间                                                                */
/* ------------------------------------------------------------------ */

function createRoom(id) {
  return {
    id,
    board: createBoard(),
    history: [],
    turn: RED,
    status: 'waiting',
    winner: 0,
    reason: null,
    check: null,
    noCapturePlies: 0,
    undoRequest: null,
    restartVotes: { [RED]: false, [BLACK]: false },
    players: { [RED]: null, [BLACK]: null },
    spectators: new Set(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: 0,
  };
}

function resetBoard(room) {
  room.board = createBoard();
  room.history = [];
  room.turn = RED;
  room.winner = 0;
  room.reason = null;
  room.check = null;
  room.noCapturePlies = 0;
  room.undoRequest = null;
  room.restartVotes = { [RED]: false, [BLACK]: false };
  room.status = 'playing';
  room.startedAt = Date.now();
  room.updatedAt = Date.now();
}

function swapSeats(room) {
  const red = room.players[RED];
  const black = room.players[BLACK];
  room.players[RED] = black;
  room.players[BLACK] = red;
  for (const conn of connections.values()) {
    if (conn.meta.roomId !== room.id || !conn.meta.seat) continue;
    conn.meta.seat = conn.meta.seat === RED ? BLACK : RED;
  }
}

function groupMoves(moves) {
  const map = {};
  for (const { from, to } of moves) {
    if (!map[from]) map[from] = [];
    map[from].push(to);
  }
  return map;
}

function serializeRoom(room) {
  const last = room.history[room.history.length - 1] || null;
  return {
    id: room.id,
    board: Array.from(room.board),
    turn: room.turn,
    status: room.status,
    winner: room.winner,
    reason: room.reason,
    check: room.check,
    noCapturePlies: room.noCapturePlies,
    moveCount: room.history.length,
    lastMove: last
      ? { from: last.from, to: last.to, color: last.color, piece: last.piece, captured: last.captured }
      : null,
    legalMoves: room.status === 'playing' ? groupMoves(getLegalMoves(room.board, room.turn)) : {},
    captures: getCaptures(room.history),
    players: {
      red: room.players[RED]
        ? { name: room.players[RED].name, connected: room.players[RED].connected }
        : null,
      black: room.players[BLACK]
        ? { name: room.players[BLACK].name, connected: room.players[BLACK].connected }
        : null,
    },
    undoRequest: room.undoRequest ? { by: room.undoRequest.by } : null,
    restartVotes: {
      red: room.restartVotes[RED],
      black: room.restartVotes[BLACK],
    },
    spectatorCount: room.spectators.size,
    createdAt: room.createdAt,
    startedAt: room.startedAt,
  };
}

function send(conn, data) {
  conn.sendJSON(data);
}

function sendError(conn, message) {
  send(conn, { type: 'error', message });
}

function sendState(conn, room) {
  send(conn, {
    type: 'state',
    room: serializeRoom(room),
    you: {
      color: conn.meta.seat || null,
      spectator: !conn.meta.seat,
      name: conn.meta.name,
    },
  });
}

function broadcastRoom(room) {
  room.updatedAt = Date.now();
  for (const conn of connections.values()) {
    if (conn.meta.roomId !== room.id || conn.closed) continue;
    sendState(conn, room);
  }
}

function getRoom(conn) {
  return conn.meta.roomId ? rooms.get(conn.meta.roomId) || null : null;
}

/* ------------------------------------------------------------------ */
/* 进入 / 离开房间                                                     */
/* ------------------------------------------------------------------ */

function detach(conn, { explicit } = {}) {
  const room = getRoom(conn);
  const seat = conn.meta.seat;

  if (room) {
    if (seat) {
      const player = room.players[seat];
      if (player && player.connId === conn.id) {
        player.connected = false;
        player.connId = null;

        if (explicit) {
          if (room.status === 'playing') {
            room.status = 'over';
            room.winner = room.players[otherSeat(seat)] ? otherSeat(seat) : 0;
            room.reason = 'leave';
            room.check = null;
            room.undoRequest = null;
          }
          room.players[seat] = null;
          room.restartVotes[seat] = false;
          if (!room.players[RED] && !room.players[BLACK]) {
            rooms.delete(room.id);
          }
        }
      }
    } else {
      room.spectators.delete(conn.id);
    }

    if (rooms.has(room.id)) {
      room.updatedAt = Date.now();
      broadcastRoom(room);
    }
  }

  conn.meta.roomId = null;
  conn.meta.seat = 0;
}

function startNewGameIfReady(room, seatWasFilled) {
  if (!seatWasFilled) return;
  if (!room.players[RED] || !room.players[BLACK]) return;
  if (room.status === 'playing') return;
  resetBoard(room);
}

function handleJoin(conn, msg) {
  if (conn.meta.roomId) detach(conn, { explicit: false });

  const name = cleanName(msg.name) || `棋手${crypto.randomInt(100, 1000)}`;
  const requested = normalizeRoomId(msg.roomId);
  const wantCreate = msg.create === true;
  let room;

  if (wantCreate) {
    if (requested && rooms.has(requested)) {
      return sendError(conn, `房间号 ${requested} 已被占用，换一个吧`);
    }
    const id = requested || generateRoomId();
    room = createRoom(id);
    rooms.set(id, room);
  } else {
    if (!requested) return sendError(conn, '请输入房间号');
    room = rooms.get(requested);
    if (!room) return sendError(conn, `房间 ${requested} 不存在，检查一下房间号`);
  }

  // 先尝试用 token 找回座位（断线重连 / 刷新页面）
  const token = typeof msg.token === 'string' && /^[a-f0-9]{16,64}$/.test(msg.token) ? msg.token : null;
  let seat = 0;
  if (token) {
    if (room.players[RED] && room.players[RED].token === token) seat = RED;
    else if (room.players[BLACK] && room.players[BLACK].token === token) seat = BLACK;
  }

  let seatWasFilled = false;

  // 新玩家坐空位（仅在未开局 / 已结束的房间里）
  if (!seat && room.status !== 'playing') {
    if (!room.players[RED]) seat = RED;
    else if (!room.players[BLACK]) seat = BLACK;
  }

  if (seat) {
    const existing = room.players[seat];

    if (existing && token && existing.token === token) {
      // 顶掉同一座位的旧连接（例如同一个链接开了两个标签页）
      if (existing.connId && existing.connId !== conn.id) {
        const oldConn = connections.get(existing.connId);
        if (oldConn && !oldConn.closed) {
          oldConn.meta.seat = 0;
          oldConn.meta.isSpectator = true;
          room.spectators.add(oldConn.id);
          send(oldConn, { type: 'notice', message: '你的座位已在另一个页面打开，当前转为观战' });
        }
      }
      existing.name = name || existing.name;
      existing.connected = true;
      existing.connId = conn.id;
      // 重连不应触发重开对局
    } else {
      room.players[seat] = {
        token: token && !existing ? token : crypto.randomBytes(16).toString('hex'),
        name,
        connected: true,
        connId: conn.id,
      };
      seatWasFilled = true;
    }

    conn.meta.seat = seat;
    conn.meta.name = room.players[seat].name;
    conn.meta.isSpectator = false;
    room.spectators.delete(conn.id);
  } else {
    conn.meta.seat = 0;
    conn.meta.name = name;
    conn.meta.isSpectator = true;
    room.spectators.add(conn.id);
  }

  conn.meta.roomId = room.id;
  room.updatedAt = Date.now();
  startNewGameIfReady(room, seatWasFilled);

  const player = conn.meta.seat ? room.players[conn.meta.seat] : null;
  send(conn, {
    type: 'welcome',
    roomId: room.id,
    name: conn.meta.name,
    token: player ? player.token : null,
    seat: conn.meta.seat || null,
    spectator: !conn.meta.seat,
  });

  broadcastRoom(room);
}

function handleLeave(conn) {
  if (!conn.meta.roomId) return;
  detach(conn, { explicit: true });
  if (conn.meta.roomId === null) {
    send(conn, { type: 'left' });
  }
}

/* ------------------------------------------------------------------ */
/* 游戏操作                                                            */
/* ------------------------------------------------------------------ */

function handleMove(conn, msg) {
  const room = getRoom(conn);
  if (!room) return sendError(conn, '你还没有进入房间');
  if (!conn.meta.seat) return sendError(conn, '观战者不能走棋');
  if (room.status === 'waiting') return sendError(conn, '等待对手加入后再走棋');
  if (room.status !== 'playing') return sendError(conn, '对局已结束，点「再来一局」开局');

  const from = Number(msg.from);
  const to = Number(msg.to);
  const result = applyMove(room, conn.meta.seat, from, to);
  if (!result.ok) return sendError(conn, result.error);

  broadcastRoom(room);
}

function handleUndoRequest(conn) {
  const room = getRoom(conn);
  if (!room) return sendError(conn, '你还没有进入房间');
  if (!conn.meta.seat) return sendError(conn, '观战者不能操作');
  if (room.status !== 'playing') return sendError(conn, '对局已结束');
  if (!room.history.length) return sendError(conn, '还没有走棋');
  if (room.undoRequest) return sendError(conn, '已有待处理的悔棋请求');

  room.undoRequest = { by: conn.meta.seat, at: Date.now() };
  broadcastRoom(room);
}

function handleUndoResponse(conn, msg) {
  const room = getRoom(conn);
  if (!room) return sendError(conn, '你还没有进入房间');
  if (!conn.meta.seat) return sendError(conn, '观战者不能操作');
  if (!room.undoRequest) return sendError(conn, '没有待处理的悔棋请求');
  if (room.undoRequest.by === conn.meta.seat) {
    return sendError(conn, '不能处理自己的悔棋请求');
  }

  if (msg.accept === true) {
    undoLast(room);
    room.restartVotes = { [RED]: false, [BLACK]: false };
  }
  room.undoRequest = null;
  broadcastRoom(room);
}

function handleUndoCancel(conn) {
  const room = getRoom(conn);
  if (!room) return;
  if (!room.undoRequest) return;
  if (room.undoRequest.by !== conn.meta.seat) return sendError(conn, '只有发起者可以取消');
  room.undoRequest = null;
  broadcastRoom(room);
}

function handleResign(conn) {
  const room = getRoom(conn);
  if (!room) return sendError(conn, '你还没有进入房间');
  if (!conn.meta.seat) return sendError(conn, '观战者不能操作');
  if (room.status !== 'playing') return sendError(conn, '对局尚未开始');

  room.status = 'over';
  room.winner = otherSeat(conn.meta.seat);
  room.reason = 'resign';
  room.check = null;
  room.undoRequest = null;
  broadcastRoom(room);
}

function handleRestart(conn) {
  const room = getRoom(conn);
  if (!room) return sendError(conn, '你还没有进入房间');
  if (!conn.meta.seat) return sendError(conn, '观战者不能操作');
  if (room.status !== 'over') return sendError(conn, '对局还没有结束');
  if (!room.players[RED] || !room.players[BLACK]) {
    return sendError(conn, '等待对手加入后再开始');
  }

  room.restartVotes[conn.meta.seat] = true;

  if (room.restartVotes[RED] && room.restartVotes[BLACK]) {
    swapSeats(room);
    resetBoard(room);
  }

  broadcastRoom(room);
}

/* ------------------------------------------------------------------ */
/* 消息分发                                                            */
/* ------------------------------------------------------------------ */

function allowMessage(conn) {
  const now = Date.now();
  const rate = conn.meta.rate;
  if (now - rate.start > 1000) {
    rate.start = now;
    rate.count = 0;
  }
  rate.count += 1;
  return rate.count <= 30;
}

function handleMessage(conn, raw) {
  if (!allowMessage(conn)) {
    return sendError(conn, '操作太频繁，请稍后再试');
  }

  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (err) {
    return sendError(conn, '消息格式错误');
  }
  if (!msg || typeof msg.type !== 'string') return;

  switch (msg.type) {
    case 'join':
      return handleJoin(conn, msg);
    case 'leave':
      return handleLeave(conn);
    case 'move':
      return handleMove(conn, msg);
    case 'undo-request':
      return handleUndoRequest(conn);
    case 'undo-response':
      return handleUndoResponse(conn, msg);
    case 'undo-cancel':
      return handleUndoCancel(conn);
    case 'resign':
      return handleResign(conn);
    case 'restart':
      return handleRestart(conn);
    case 'ping':
      return send(conn, { type: 'pong', t: Date.now() });
    default:
      return;
  }
}

/* ------------------------------------------------------------------ */
/* 静态资源                                                            */
/* ------------------------------------------------------------------ */

function serveJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveFile(req, res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (err) {
    return serveJson(res, 400, { error: 'bad path' });
  }

  const relative = decoded === '/' ? '/index.html' : decoded;
  const filePath = path.normalize(path.join(PUBLIC_DIR, relative));

  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return serveJson(res, 403, { error: 'forbidden' });
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }

    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache',
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();

    const stream = fs.createReadStream(filePath);
    stream.on('error', () => res.end());
    stream.pipe(res);
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end('Method Not Allowed');
  }

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (err) {
    return serveJson(res, 400, { error: 'bad request' });
  }

  if (url.pathname === '/api/info') {
    return serveJson(res, 200, {
      port: PORT,
      urls: hostUrls(),
      rooms: rooms.size,
      online: connections.size,
      uptime: Math.floor(process.uptime()),
    });
  }

  if (url.pathname === '/api/rooms') {
    const list = [];
    for (const room of rooms.values()) {
      if (room.status === 'playing') continue;
      const hasFreeSeat = !room.players[RED] || !room.players[BLACK];
      if (!hasFreeSeat) continue;

      // 房主离线且无人可接手的房间不展示
      const seated = room.players[RED] || room.players[BLACK];
      if (seated && !seated.connected) continue;

      list.push({
        id: room.id,
        status: room.status,
        createdAt: room.createdAt,
        moveCount: room.history.length,
        players: {
          red: room.players[RED] ? room.players[RED].name : null,
          black: room.players[BLACK] ? room.players[BLACK].name : null,
        },
      });
    }
    list.sort((a, b) => b.createdAt - a.createdAt);
    return serveJson(res, 200, { rooms: list.slice(0, 30) });
  }

  if (url.pathname === '/healthz') {
    return serveJson(res, 200, { ok: true });
  }

  serveFile(req, res, url.pathname);
});

/* ------------------------------------------------------------------ */
/* WebSocket 握手 & 生命周期                                            */
/* ------------------------------------------------------------------ */

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();

  if (upgrade !== 'websocket' || !key) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '',
      '',
    ].join('\r\n')
  );

  const conn = new WSConnection(socket, {
    id: crypto.randomBytes(9).toString('hex'),
    roomId: null,
    seat: 0,
    name: '',
    isSpectator: true,
    rate: { start: Date.now(), count: 0 },
  });

  connections.set(conn.id, conn);
  conn.onmessage = (raw) => handleMessage(conn, raw);
  conn.onclose = () => {
    connections.delete(conn.id);
    const room = getRoom(conn);
    if (room) {
      if (conn.meta.seat) {
        const player = room.players[conn.meta.seat];
        if (player && player.connId === conn.id) {
          player.connected = false;
          player.connId = null;
        }
      } else {
        room.spectators.delete(conn.id);
      }
      if (rooms.has(room.id)) broadcastRoom(room);
    }
  };
});

/* 心跳 */
const heartbeat = setInterval(() => {
  for (const conn of connections.values()) {
    if (!conn.alive) {
      conn.close(1001, 'timeout');
      connections.delete(conn.id);
      continue;
    }
    conn.alive = false;
    conn.ping();
  }
}, 30000);
heartbeat.unref();

/* 定期清理无人房间 */
const cleaner = setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    let hasConnection = false;
    for (const conn of connections.values()) {
      if (conn.meta.roomId === id) {
        hasConnection = true;
        break;
      }
    }
    if (!hasConnection && now - room.updatedAt > ROOM_TTL) {
      rooms.delete(id);
    }
  }
}, 60000);
cleaner.unref();

server.listen(PORT, HOST, () => {
  const urls = hostUrls();
  const line = '─'.repeat(46);
  console.log(`\n  ♟  中国象棋 · 内网双人对战\n  ${line}`);
  for (const url of urls) {
    console.log(`  访问地址  ${url}`);
  }
  console.log(`  房间数量  ${rooms.size}`);
  console.log(`  ${line}\n  同一局域网内，两台设备打开上方地址即可对战（红方先行）\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  端口 ${PORT} 已被占用，换一个端口：PORT=3211 node server.js\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

function shutdown() {
  console.log('\n  正在关闭服务...');
  for (const conn of connections.values()) conn.close(1001, 'server shutdown');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
