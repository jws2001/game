'use strict';

/**
 * 象棋规则单元测试
 * 运行: node tools/rules-test.js
 */

const assert = require('assert');
const {
  COLS,
  ROWS,
  CELLS,
  RED,
  BLACK,
  KING,
  ADVISOR,
  ELEPHANT,
  HORSE,
  ROOK,
  CANNON,
  PAWN,
  idx,
  makePiece,
  createBoard,
  findKing,
  pseudoMovesFrom,
  getLegalMoves,
  isKingInCheck,
  createGame,
  applyMove,
  undoLast,
} = require('../lib/rules');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

function emptyBoard() {
  return new Uint8Array(CELLS);
}

function put(board, x, y, color, type) {
  board[idx(x, y)] = makePiece(color, type);
}

function baseState(board, turn = RED) {
  return {
    board,
    turn,
    status: 'playing',
    winner: 0,
    reason: null,
    check: null,
    history: [],
    noCapturePlies: 0,
  };
}

/* ------------------------------------------------------------------ */

test('初始棋盘 32 枚棋子、红先、双方均有合法走法', () => {
  const game = createGame();
  let pieces = 0;
  for (let i = 0; i < CELLS; i += 1) if (game.board[i]) pieces += 1;
  assert.strictEqual(pieces, 32);
  assert.strictEqual(game.turn, RED);
  assert.ok(findKing(game.board, RED) >= 0);
  assert.ok(findKing(game.board, BLACK) >= 0);
  assert.ok(getLegalMoves(game.board, RED).length > 0);
  assert.ok(getLegalMoves(game.board, BLACK).length > 0);
});

test('车：沿直线行走，被己方棋子阻挡', () => {
  const board = emptyBoard();
  put(board, 0, 0, RED, ROOK);
  put(board, 3, 0, BLACK, PAWN);
  put(board, 5, 0, RED, PAWN);
  const moves = pseudoMovesFrom(board, idx(0, 0));
  assert.ok(moves.includes(idx(1, 0)));
  assert.ok(moves.includes(idx(2, 0)));
  assert.ok(moves.includes(idx(3, 0)), '可吃对方棋子');
  assert.ok(!moves.includes(idx(4, 0)), '不能越过棋子');
  assert.ok(!moves.includes(idx(5, 0)), '不能吃己方棋子');
});

test('炮：无炮架不能吃子，有且仅有一个炮架才能隔空打子', () => {
  const board = emptyBoard();
  put(board, 0, 5, RED, CANNON);
  put(board, 4, 5, BLACK, PAWN);
  let moves = pseudoMovesFrom(board, idx(0, 5));
  assert.ok(moves.includes(idx(1, 5)));
  assert.ok(!moves.includes(idx(4, 5)), '无炮架不能吃');

  put(board, 2, 5, RED, PAWN); // 炮架
  moves = pseudoMovesFrom(board, idx(0, 5));
  assert.ok(moves.includes(idx(4, 5)), '隔一子可吃');
  assert.ok(!moves.includes(idx(3, 5)), '炮架后不能落空位');
  assert.ok(!moves.includes(idx(2, 5)), '不能吃炮架');
});

test('马：蹩马腿时不能走', () => {
  const board = emptyBoard();
  put(board, 4, 4, RED, HORSE);
  put(board, 5, 4, RED, PAWN); // 挡住 (+2,+1) / (+2,-1) 的马腿
  const moves = pseudoMovesFrom(board, idx(4, 4));
  assert.ok(!moves.includes(idx(6, 5)));
  assert.ok(!moves.includes(idx(6, 3)));
  assert.ok(moves.includes(idx(5, 6)));
  assert.ok(moves.includes(idx(3, 2)));
});

test('象：塞象眼不能走，不能过河', () => {
  const board = emptyBoard();
  put(board, 2, 9, RED, ELEPHANT);
  let moves = pseudoMovesFrom(board, idx(2, 9));
  assert.ok(moves.includes(idx(0, 7)));
  assert.ok(moves.includes(idx(4, 7)));

  put(board, 1, 8, RED, PAWN); // 塞住 (0,7) 的象眼
  moves = pseudoMovesFrom(board, idx(2, 9));
  assert.ok(!moves.includes(idx(0, 7)));
  assert.ok(moves.includes(idx(4, 7)));

  const board2 = emptyBoard();
  put(board2, 6, 5, RED, ELEPHANT);
  const moves2 = pseudoMovesFrom(board2, idx(6, 5));
  assert.ok(!moves2.includes(idx(4, 3)), '红象不能过河');
  assert.ok(!moves2.includes(idx(8, 3)));
});

test('士：只能在九宫内斜走', () => {
  const board = emptyBoard();
  put(board, 4, 8, RED, ADVISOR);
  const moves = pseudoMovesFrom(board, idx(4, 8));
  assert.deepStrictEqual(
    moves.sort((a, b) => a - b),
    [idx(3, 7), idx(3, 9), idx(5, 7), idx(5, 9)].sort((a, b) => a - b)
  );

  board[idx(4, 8)] = 0;
  put(board, 3, 9, RED, ADVISOR); // 九宫角，只能往中宫走
  const corner = pseudoMovesFrom(board, idx(3, 9));
  assert.deepStrictEqual(corner, [idx(4, 8)]);
});

test('兵/卒：过河前只能前进，过河后可横走', () => {
  const board = emptyBoard();
  put(board, 4, 6, RED, PAWN);
  assert.deepStrictEqual(pseudoMovesFrom(board, idx(4, 6)), [idx(4, 5)]);

  board[idx(4, 6)] = 0;
  put(board, 4, 4, RED, PAWN);
  const moves = pseudoMovesFrom(board, idx(4, 4));
  assert.ok(moves.includes(idx(4, 3)));
  assert.ok(moves.includes(idx(3, 4)));
  assert.ok(moves.includes(idx(5, 4)));

  const board2 = emptyBoard();
  put(board2, 0, 5, BLACK, PAWN);
  const blackMoves = pseudoMovesFrom(board2, idx(0, 5));
  assert.ok(blackMoves.includes(idx(0, 6)));
  assert.ok(blackMoves.includes(idx(1, 5)));
});

test('白脸将：不能走出让双方将帅照面的棋', () => {
  const board = emptyBoard();
  put(board, 4, 0, BLACK, KING);
  put(board, 4, 9, RED, KING);
  put(board, 4, 5, RED, ROOK);
  put(board, 0, 9, RED, ROOK);

  assert.strictEqual(isKingInCheck(board, RED), false);

  const moves = getLegalMoves(board, RED);
  const rookMoves = moves.filter((m) => m.from === idx(4, 5));
  assert.ok(!rookMoves.some((m) => m.to === idx(3, 5)), '移开中路会导致将帅照面');
  assert.ok(rookMoves.some((m) => m.to === idx(4, 4)), '沿中路移动仍然挡着，合法');
});

test('将军检测', () => {
  const board = emptyBoard();
  put(board, 4, 0, BLACK, KING);
  put(board, 4, 9, RED, KING);
  put(board, 4, 5, RED, PAWN); // 挡住将帅照面
  put(board, 0, 0, RED, ROOK);

  assert.strictEqual(isKingInCheck(board, BLACK), true);
  assert.strictEqual(isKingInCheck(board, RED), false);
});

test('将死判定', () => {
  const board = emptyBoard();
  put(board, 4, 0, BLACK, KING);
  put(board, 4, 1, BLACK, PAWN);
  put(board, 4, 9, RED, KING);
  put(board, 4, 5, RED, PAWN); // 挡将帅照面
  put(board, 3, 2, RED, ROOK);
  put(board, 5, 2, RED, ROOK);
  put(board, 4, 2, RED, ROOK);
  put(board, 0, 1, RED, ROOK);

  const state = baseState(board, RED);
  const result = applyMove(state, RED, idx(0, 1), idx(4, 1));
  assert.ok(result.ok, result.error);
  assert.strictEqual(state.status, 'over');
  assert.strictEqual(state.winner, RED);
  assert.strictEqual(state.reason, 'checkmate');
});

test('困毙（无棋可走但未被将军）判负', () => {
  const board = emptyBoard();
  put(board, 4, 0, BLACK, KING);
  put(board, 4, 9, RED, KING);
  put(board, 4, 5, RED, PAWN);
  put(board, 3, 1, RED, ROOK);
  put(board, 5, 1, RED, ROOK);

  assert.strictEqual(isKingInCheck(board, BLACK), false);
  assert.strictEqual(getLegalMoves(board, BLACK).length, 0);
});

test('悔棋恢复被吃棋子与行棋方', () => {
  const board = emptyBoard();
  put(board, 4, 0, BLACK, KING);
  put(board, 4, 9, RED, KING);
  put(board, 4, 5, RED, PAWN);
  put(board, 0, 0, RED, ROOK);
  put(board, 0, 3, BLACK, PAWN);

  const state = baseState(board, RED);
  const result = applyMove(state, RED, idx(0, 0), idx(0, 3));
  assert.ok(result.ok, result.error);
  assert.strictEqual(state.history.length, 1);
  assert.strictEqual(state.board[idx(0, 3)], makePiece(RED, ROOK));
  assert.strictEqual(state.noCapturePlies, 0);

  const last = undoLast(state);
  assert.ok(last);
  assert.strictEqual(state.board[idx(0, 0)], makePiece(RED, ROOK));
  assert.strictEqual(state.board[idx(0, 3)], makePiece(BLACK, PAWN));
  assert.strictEqual(state.turn, RED);
  assert.strictEqual(state.noCapturePlies, 0);
  assert.strictEqual(state.status, 'playing');
});

test('不能走对方的棋 / 不能在对方回合走棋', () => {
  const state = createGame();
  const result = applyMove(state, BLACK, idx(0, 0), idx(0, 1));
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /还没轮到/);
});

test('连续 60 回合无吃子判和', () => {
  const board = emptyBoard();
  put(board, 4, 0, BLACK, KING);
  put(board, 4, 9, RED, KING);
  put(board, 4, 5, RED, PAWN);
  put(board, 0, 5, RED, ROOK);

  const state = baseState(board, RED);
  state.noCapturePlies = 119;

  const result = applyMove(state, RED, idx(0, 5), idx(0, 4));
  assert.ok(result.ok, result.error);
  assert.strictEqual(state.status, 'over');
  assert.strictEqual(state.winner, 0);
  assert.strictEqual(state.reason, 'draw');
});

console.log(`\n${passed} 项象棋规则测试通过 ✅\n`);
