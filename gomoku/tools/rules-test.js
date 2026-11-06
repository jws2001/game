'use strict';

/**
 * 规则单元测试：五连判定 / 边界 / 悔棋 / 和棋
 * 运行: node tools/rules-test.js
 */

const assert = require('assert');
const {
  SIZE,
  EMPTY,
  BLACK,
  WHITE,
  createBoard,
  indexOf,
  findWinLine,
  placeStone,
  undoLast,
} = require('../lib/game');

function makeState(size = SIZE) {
  return {
    size,
    board: createBoard(size),
    history: [],
    turn: BLACK,
    status: 'playing',
    winner: EMPTY,
    winLine: null,
    reason: null,
    undoRequest: null,
  };
}

function put(board, size, x, y, color) {
  board[indexOf(size, x, y)] = color;
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

test('横向五连获胜', () => {
  const s = makeState();
  const moves = [
    [2, 5],
    [0, 0],
    [3, 5],
    [1, 0],
    [4, 5],
    [2, 0],
    [5, 5],
    [3, 0],
    [6, 5],
  ];
  for (const [x, y] of moves) {
    const color = s.turn;
    assert.ok(placeStone(s, color, x, y).ok);
  }
  assert.strictEqual(s.status, 'over');
  assert.strictEqual(s.winner, BLACK);
  assert.strictEqual(s.winLine.length, 5);
});

test('纵向六连（长连）同样获胜', () => {
  const board = createBoard(SIZE);
  for (let y = 3; y <= 8; y += 1) put(board, SIZE, 10, y, WHITE);
  const line = findWinLine(board, SIZE, 10, 5);
  assert.ok(line && line.length === 6);
});

test('两条斜线均能判胜', () => {
  const b1 = createBoard(SIZE);
  for (let i = 0; i < 5; i += 1) put(b1, SIZE, 2 + i, 2 + i, BLACK);
  assert.ok(findWinLine(b1, SIZE, 4, 4));

  const b2 = createBoard(SIZE);
  for (let i = 0; i < 5; i += 1) put(b2, SIZE, 10 - i, 3 + i, WHITE);
  assert.ok(findWinLine(b2, SIZE, 8, 5));
});

test('四连 / 中间断点不判胜', () => {
  const board = createBoard(SIZE);
  for (let x = 1; x <= 4; x += 1) put(board, SIZE, x, 7, BLACK);
  assert.strictEqual(findWinLine(board, SIZE, 2, 7), null);

  put(board, SIZE, 6, 7, BLACK);
  put(board, SIZE, 5, 7, EMPTY);
  assert.strictEqual(findWinLine(board, SIZE, 6, 7), null);
});

test('重复落子 / 越界 / 抢手均被拒绝', () => {
  const s = makeState();
  assert.strictEqual(placeStone(s, WHITE, 7, 7).ok, false);
  assert.ok(placeStone(s, BLACK, 7, 7).ok);
  assert.strictEqual(placeStone(s, WHITE, 7, 7).ok, false, '同位置');
  assert.strictEqual(placeStone(s, BLACK, 15, 0).ok, false, '越界');
  assert.strictEqual(placeStone(s, BLACK, -1, 0).ok, false, '越界');
});

test('悔棋回退最近一手并交还回合', () => {
  const s = makeState();
  placeStone(s, BLACK, 7, 7);
  placeStone(s, WHITE, 8, 8);
  placeStone(s, BLACK, 6, 6);

  const removed = undoLast(s);
  assert.deepStrictEqual(removed, { x: 6, y: 6, color: BLACK });
  assert.strictEqual(s.board[indexOf(SIZE, 6, 6)], EMPTY);
  assert.strictEqual(s.turn, BLACK);
  assert.strictEqual(s.history.length, 2);
  assert.strictEqual(s.status, 'playing');
});

test('棋盘下满判和棋', () => {
  const s = makeState(3);
  const cells = [];
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 3; x += 1) cells.push([x, y]);
  }
  for (const [x, y] of cells) {
    const color = s.turn;
    assert.ok(placeStone(s, color, x, y).ok);
  }
  assert.strictEqual(s.status, 'over');
  assert.strictEqual(s.winner, EMPTY);
  assert.strictEqual(s.reason, 'draw');
});

console.log(`\n${passed} 项规则测试通过 ✅\n`);
