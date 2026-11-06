'use strict';

/**
 * 中国象棋端到端联机测试
 * 运行: npm test
 */

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const { TestClient } = require('./ws-client');
const { RED, BLACK, idx } = require('../lib/rules');

const PORT = Number(process.env.TEST_PORT) || 33211;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeout = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error(`超时: ${label}`);
}

async function main() {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  server.stdout.on('data', () => {});
  server.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));

  const clients = [];
  const other = (c) => (c === RED ? BLACK : RED);

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
    assert.ok(info.urls.some((u) => u.includes(String(PORT))));
    const html = await fetch(`http://127.0.0.1:${PORT}/`).then((r) => r.text());
    assert.ok(html.includes('象棋'), '首页可访问');
    console.log('✓ 页面与 API 正常');

    const alice = await TestClient.connect(PORT);
    clients.push(alice);
    alice.send({ type: 'join', create: true, name: '红方' });
    await waitFor(() => alice.welcome && alice.state, '创建房间');
    const roomId = alice.welcome.roomId;
    assert.strictEqual(alice.state.room.status, 'waiting');
    assert.strictEqual(alice.state.you.color, RED);
    const openRooms = await fetch(`http://127.0.0.1:${PORT}/api/rooms`).then((r) => r.json());
    assert.ok(openRooms.rooms.some((r) => r.id === roomId), '等待房间可被扫描');
    console.log(`✓ 房间 ${roomId} 创建，房主执红，可被扫描`);

    const bob = await TestClient.connect(PORT);
    clients.push(bob);
    bob.send({ type: 'join', roomId, name: '黑方' });
    await waitFor(
      () => alice.state.room.status === 'playing' && bob.state.room.status === 'playing',
      '开局'
    );
    assert.strictEqual(bob.state.you.color, BLACK);
    assert.strictEqual(alice.state.room.turn, RED);
    assert.ok(Object.keys(alice.state.room.legalMoves).length > 0, '返回红方合法走法');
    console.log('✓ 双方到齐，红方先行，合法走法已下发');

    bob.send({ type: 'move', from: idx(1, 7), to: idx(4, 7) });
    await waitFor(() => bob.errors.includes('还没轮到你走棋'), '拒绝抢手');
    console.log('✓ 非当前回合走棋被拒绝');

    alice.send({ type: 'move', from: idx(0, 6), to: idx(0, 7) });
    await waitFor(() => alice.errors.some((e) => /走不了|不合法/.test(e)), '拒绝非法走法');
    console.log('✓ 非法走法被拒绝');

    const carol = await TestClient.connect(PORT);
    clients.push(carol);
    carol.send({ type: 'join', roomId, name: '观战者' });
    await waitFor(() => carol.welcome && carol.state, '观战加入');
    assert.strictEqual(carol.welcome.spectator, true);
    console.log('✓ 第三人进入观战');

    const moves = [
      [RED, [1, 7], [4, 7]],
      [BLACK, [1, 2], [4, 2]],
      [RED, [1, 9], [2, 7]],
      [BLACK, [1, 0], [2, 2]],
      [RED, [0, 9], [0, 8]],
      [BLACK, [0, 0], [0, 1]],
    ];

    for (let i = 0; i < moves.length; i += 1) {
      const [color, from, to] = moves[i];
      const client = color === RED ? alice : bob;
      client.send({ type: 'move', from: idx(from[0], from[1]), to: idx(to[0], to[1]) });
      await waitFor(() => alice.state.room.moveCount === i + 1, `第 ${i + 1} 手`);
    }
    assert.strictEqual(alice.state.room.turn, RED);
    console.log('✓ 完整走子流程正常');

    alice.send({ type: 'undo-request' });
    await waitFor(() => bob.state.room.undoRequest && bob.state.room.undoRequest.by === RED, '悔棋请求');
    bob.send({ type: 'undo-response', accept: true });
    await waitFor(
      () => alice.state.room.undoRequest === null && alice.state.room.moveCount === 5,
      '同意悔棋'
    );
    assert.strictEqual(alice.state.room.turn, BLACK, '悔棋后由被撤销方走棋');
    console.log('✓ 悔棋请求 / 同意 / 回退');

    carol.send({ type: 'move', from: idx(0, 3), to: idx(0, 4) });
    await waitFor(() => carol.errors.includes('观战者不能走棋'), '观战者禁手');
    console.log('✓ 观战者不能走棋');

    bob.send({ type: 'resign' });
    await waitFor(() => alice.state.room.reason === 'resign', '认输');
    assert.strictEqual(alice.state.room.winner, RED);
    console.log('✓ 认输判定');

    const bobToken = bob.welcome.token;
    bob.close();
    await waitFor(() => alice.state.room.players.black.connected === false, '离线同步');
    const bob2 = await TestClient.connect(PORT);
    clients.push(bob2);
    bob2.send({ type: 'join', roomId, name: '黑方', token: bobToken });
    await waitFor(() => bob2.welcome && bob2.state, '断线重连');
    assert.strictEqual(bob2.state.you.color, BLACK);
    assert.strictEqual(bob2.state.room.status, 'over');
    console.log('✓ 断线重连回到原座位');

    alice.send({ type: 'restart' });
    await waitFor(() => bob2.state.room.restartVotes.red === true, '第一票');
    assert.strictEqual(alice.state.room.status, 'over');
    bob2.send({ type: 'restart' });
    await waitFor(
      () => alice.state.room.status === 'playing' && alice.state.room.moveCount === 0,
      '再来一局'
    );
    assert.strictEqual(alice.state.you.color, BLACK, '重开后交换红黑');
    assert.strictEqual(bob2.state.you.color, RED);
    assert.strictEqual(alice.state.room.turn, RED);
    console.log('✓ 再来一局，红黑互换，红方先行');

    const bad = await TestClient.connect(PORT);
    clients.push(bad);
    bad.send({ type: 'join', roomId: '0000', name: '迷路' });
    await waitFor(() => bad.errors.some((m) => m.includes('不存在')), '不存在房间');
    console.log('✓ 不存在的房间返回提示');

    console.log('\n全部 13 项象棋联机测试通过 ✅\n');
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
