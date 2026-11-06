'use strict';

/**
 * 演示用：自动开一间象棋房，走几步开局并保持连接
 * 用法: PORT=3211 node tools/demo-room.js
 */

const fs = require('fs');
const { TestClient } = require('./ws-client');
const { idx } = require('../lib/rules');

const PORT = Number(process.env.PORT) || 3211;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await sleep(30);
  }
  throw new Error(`超时: ${label}`);
}

async function main() {
  const red = await TestClient.connect(PORT);
  red.send({ type: 'join', create: true, name: '红方演示' });
  await waitFor(() => red.welcome && red.state, '创建房间');
  const roomId = red.welcome.roomId;

  const black = await TestClient.connect(PORT);
  black.send({ type: 'join', roomId, name: '黑方演示' });
  await waitFor(() => black.state && black.state.room.status === 'playing', '开局');

  const moves = [
    [red, [1, 7], [4, 7]],
    [black, [1, 2], [4, 2]],
    [red, [1, 9], [2, 7]],
    [black, [1, 0], [2, 2]],
    [red, [0, 9], [0, 8]],
    [black, [0, 0], [0, 1]],
    [red, [0, 8], [0, 7]],
    [black, [0, 1], [0, 2]],
  ];

  let count = 0;
  for (const [client, from, to] of moves) {
    client.send({ type: 'move', from: idx(from[0], from[1]), to: idx(to[0], to[1]) });
    count += 1;
    await waitFor(() => red.state.room.moveCount === count, `第 ${count} 手`);
    await sleep(180);
  }

  fs.writeFileSync('/tmp/xiangqi-demo.json', JSON.stringify({ roomId }));
  console.log(`READY ${roomId}`);

  setInterval(() => red.send({ type: 'ping' }), 20000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
