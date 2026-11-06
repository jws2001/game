'use strict';

/**
 * 端到端联机测试：真实启动服务 + 两个 WebSocket 客户端对弈
 * 运行: npm test
 */

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const { TestClient } = require('./ws-client');

const PORT = Number(process.env.TEST_PORT) || 33210;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error(`超时: ${label}`);
}

/* ------------------------------------------------------------------ */
/* 测试主体                                                            */
/* ------------------------------------------------------------------ */

async function main() {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  server.stdout.on('data', () => {});
  server.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));

  const clients = [];

  try {
    await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
        return res.ok;
      } catch (err) {
        return false;
      }
    }, '服务启动');

    console.log('✓ 服务启动');

    const info = await fetch(`http://127.0.0.1:${PORT}/api/info`).then((r) => r.json());
    assert.ok(info.urls.some((u) => u.includes(String(PORT))), '返回访问地址');
    const html = await fetch(`http://127.0.0.1:${PORT}/`).then((r) => r.text());
    assert.ok(html.includes('五子棋'), '首页可访问');
    console.log('✓ 静态页面与 /api/info 正常');

    const alice = await TestClient.connect(PORT);
    clients.push(alice);
    alice.send({ type: 'join', create: true, name: 'Alice' });
    await waitFor(() => alice.welcome && alice.state, 'Alice 创建房间');
    const roomId = alice.welcome.roomId;
    assert.match(roomId, /^[A-Z0-9]{3,8}$/);
    assert.strictEqual(alice.state.room.status, 'waiting');
    assert.strictEqual(alice.state.you.color, 1);

    const openRooms = await fetch(`http://127.0.0.1:${PORT}/api/rooms`).then((r) => r.json());
    assert.ok(openRooms.rooms.some((room) => room.id === roomId), '空闲房间可被扫描到');
    console.log(`✓ 创建房间 ${roomId}，房主执黑，可被扫描到`);

    const bob = await TestClient.connect(PORT);
    clients.push(bob);
    bob.send({ type: 'join', roomId, name: 'Bob' });
    await waitFor(
      () => alice.state.room.status === 'playing' && bob.state.room.status === 'playing',
      '两人到齐开局'
    );
    assert.strictEqual(bob.state.you.color, 2);
    assert.strictEqual(alice.state.room.turn, 1);

    const busyRooms = await fetch(`http://127.0.0.1:${PORT}/api/rooms`).then((r) => r.json());
    assert.ok(!busyRooms.rooms.some((room) => room.id === roomId), '满员房间不再出现在扫描列表');
    console.log('✓ Bob 加入，自动开局，白棋后手，房间从扫描列表移除');

    const carol = await TestClient.connect(PORT);
    clients.push(carol);
    carol.send({ type: 'join', roomId, name: 'Carol' });
    await waitFor(() => carol.welcome && carol.state, '观战者加入');
    assert.strictEqual(carol.welcome.spectator, true);
    console.log('✓ 第三人自动进入观战');

    bob.send({ type: 'move', x: 7, y: 7 });
    await waitFor(() => bob.errors.includes('还没轮到你落子'), '拒绝抢手');
    console.log('✓ 非当前回合落子被拒绝');

    const blackMoves = [
      [7, 7],
      [7, 8],
      [7, 9],
      [7, 10],
      [7, 11],
    ];
    const whiteMoves = [
      [8, 8],
      [8, 9],
      [8, 10],
      [8, 11],
    ];

    for (let i = 0; i < blackMoves.length; i += 1) {
      alice.send({ type: 'move', x: blackMoves[i][0], y: blackMoves[i][1] });
      await waitFor(() => bob.state.room.moveCount === i * 2 + 1, `Alice 第 ${i + 1} 手`);
      if (i < whiteMoves.length) {
        bob.send({ type: 'move', x: whiteMoves[i][0], y: whiteMoves[i][1] });
        await waitFor(() => alice.state.room.moveCount === i * 2 + 2, `Bob 第 ${i + 1} 手`);
      }
    }

    await waitFor(() => alice.state.room.status === 'over', '对局结束');
    assert.strictEqual(alice.state.room.winner, 1, '黑棋获胜');
    assert.ok(alice.state.room.winLine.length >= 5, '返回获胜连线');
    assert.strictEqual(carol.state.room.winner, 1, '观战者同步结果');
    console.log('✓ 五连获胜判定 + 观战同步');

    const blackBefore = alice.state.you.color;
    alice.send({ type: 'restart' });
    await waitFor(() => bob.state.room.restartVotes.black === true, '第一票');
    assert.strictEqual(alice.state.room.status, 'over', '单方同意不重开');
    bob.send({ type: 'restart' });
    await waitFor(
      () => alice.state.room.status === 'playing' && alice.state.room.moveCount === 0,
      '双方同意重开'
    );
    assert.notStrictEqual(alice.state.you.color, blackBefore, '重开后交换黑白');
    assert.strictEqual(bob.state.you.color, 1);
    console.log('✓ 双方同意后再来一局，黑白互换');

    bob.send({ type: 'move', x: 0, y: 0 });
    await waitFor(() => alice.state.room.moveCount === 1, '重开后落子');
    assert.strictEqual(alice.state.room.turn, 2);

    alice.send({ type: 'undo-request' });
    await waitFor(() => bob.state.room.undoRequest && bob.state.room.undoRequest.by === 2, '悔棋请求');
    bob.send({ type: 'undo-response', accept: true });
    await waitFor(
      () => alice.state.room.undoRequest === null && alice.state.room.moveCount === 0,
      '同意悔棋'
    );
    assert.strictEqual(alice.state.room.turn, 1, '悔棋后轮到被撤销一手的一方');
    console.log('✓ 悔棋请求 / 同意 / 回退');

    carol.send({ type: 'move', x: 5, y: 5 });
    await waitFor(() => carol.errors.includes('观战者不能落子'), '观战者禁手');
    console.log('✓ 观战者不能落子');

    bob.send({ type: 'resign' });
    await waitFor(() => alice.state.room.reason === 'resign', '认输');
    assert.strictEqual(alice.state.room.winner, 2);
    console.log('✓ 认输判定');

    const bobToken = bob.welcome.token;
    bob.close();
    await waitFor(
      () => alice.state.room.players.black.connected === false,
      '离线状态同步'
    );

    const bob2 = await TestClient.connect(PORT);
    clients.push(bob2);
    bob2.send({ type: 'join', roomId, name: 'Bob', token: bobToken });
    await waitFor(() => bob2.welcome && bob2.state, '断线重连');
    assert.strictEqual(bob2.state.you.color, 1, '重连回到原座位');
    assert.strictEqual(bob2.state.room.status, 'over', '重连不重置棋局');
    assert.strictEqual(bob2.state.room.moveCount, 0);
    console.log('✓ 断线重连找回座位，棋局不丢');

    const bad = await TestClient.connect(PORT);
    clients.push(bad);
    bad.send({ type: 'join', roomId: '0000', name: 'Lost' });
    await waitFor(() => bad.errors.some((m) => m.includes('不存在')), '不存在房间提示');
    console.log('✓ 不存在的房间返回友好提示');

    console.log('\n全部 11 项联机测试通过 ✅\n');
  } finally {
    for (const client of clients) {
      try {
        client.close();
      } catch (err) {
        /* noop */
      }
    }
    server.kill('SIGTERM');
    await sleep(200);
    if (!server.killed) server.kill('SIGKILL');
  }
}

main().catch((err) => {
  console.error('\n测试失败:', err);
  process.exitCode = 1;
});
