'use strict';

/**
 * 演示用：自动开一间房并让两个机器人下到中盘，保持连接。
 * 用法: PORT=3210 node tools/demo-room.js
 * 输出: READY <roomId>
 */

const fs = require('fs');
const path = require('path');
const { TestClient } = require('./ws-client');

const PORT = Number(process.env.PORT) || 3210;
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
  const black = await TestClient.connect(PORT);
  black.send({ type: 'join', create: true, name: '林深' });
  await waitFor(() => black.welcome && black.state, '创建房间');

  const roomId = black.welcome.roomId;

  const white = await TestClient.connect(PORT);
  white.send({ type: 'join', roomId, name: '苏晚' });
  await waitFor(() => white.state && white.state.room.status === 'playing', '开局');

  const moves = [
    [7, 7],
    [8, 8],
    [6, 7],
    [5, 6],
    [5, 7],
    [8, 7],
    [4, 7],
    [3, 7],
    [7, 9],
    [6, 8],
    [9, 7],
    [9, 8],
    [6, 6],
    [10, 7],
    [7, 6],
    [5, 9],
  ];

  let count = 0;
  for (let i = 0; i < moves.length; i += 1) {
    const client = i % 2 === 0 ? black : white;
    const [x, y] = moves[i];
    client.send({ type: 'move', x, y });
    count += 1;
    await waitFor(
      () => black.state && black.state.room.moveCount === count,
      `第 ${count} 手落子`
    );
    await sleep(180);
  }

  const payload = { roomId, black: '林深', white: '苏晚' };
  fs.writeFileSync('/tmp/gomoku-demo.json', JSON.stringify(payload));
  console.log(`READY ${roomId}`);

  // 保持连接，等待截图 / 人工查看
  setInterval(() => {
    black.send({ type: 'ping' });
  }, 20000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
