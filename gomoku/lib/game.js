'use strict';

/**
 * 五子棋核心规则（纯函数式，方便单测）
 * 棋盘坐标: x 从左到右 0..14, y 从上到下 0..14
 */

const SIZE = 15;
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;
const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];

function createBoard(size = SIZE) {
  return new Uint8Array(size * size);
}

function indexOf(size, x, y) {
  return y * size + x;
}

function inBounds(size, x, y) {
  return x >= 0 && y >= 0 && x < size && y < size;
}

/**
 * 判断落子在 (x,y) 后是否形成五连（含长连）。
 * @returns {number[]|null} 连成一线的所有格子索引（用于前端高亮）
 */
function findWinLine(board, size, x, y) {
  if (!inBounds(size, x, y)) return null;
  const color = board[indexOf(size, x, y)];
  if (color === EMPTY) return null;

  for (const [dx, dy] of DIRECTIONS) {
    const cells = [[x, y]];

    for (const sign of [-1, 1]) {
      let cx = x + dx * sign;
      let cy = y + dy * sign;
      while (inBounds(size, cx, cy) && board[indexOf(size, cx, cy)] === color) {
        cells.push([cx, cy]);
        cx += dx * sign;
        cy += dy * sign;
      }
    }

    if (cells.length >= 5) {
      cells.sort((a, b) => a[0] * dx + a[1] * dy - (b[0] * dx + b[1] * dy));
      return cells.map(([cx, cy]) => indexOf(size, cx, cy));
    }
  }

  return null;
}

/**
 * 在房间状态上落子（会直接修改传入的 state）。
 * @param {object} state { board, size, history, turn, status, winner, winLine, reason }
 * @param {1|2} color
 * @param {number} x
 * @param {number} y
 * @returns {{ok:boolean, error?:string}}
 */
function placeStone(state, color, x, y) {
  if (state.status !== 'playing') return { ok: false, error: '对局已结束' };
  if (color !== state.turn) return { ok: false, error: '还没轮到你落子' };
  if (!Number.isInteger(x) || !Number.isInteger(y) || !inBounds(state.size, x, y)) {
    return { ok: false, error: '落子位置不合法' };
  }

  const idx = indexOf(state.size, x, y);
  if (state.board[idx] !== EMPTY) return { ok: false, error: '这里已经有棋子了' };

  state.board[idx] = color;
  state.history.push({ x, y, color });
  state.undoRequest = null;

  const winLine = findWinLine(state.board, state.size, x, y);
  if (winLine) {
    state.status = 'over';
    state.winner = color;
    state.winLine = winLine;
    state.reason = 'five';
  } else if (state.history.length === state.size * state.size) {
    state.status = 'over';
    state.winner = EMPTY;
    state.winLine = null;
    state.reason = 'draw';
  } else {
    state.turn = color === BLACK ? WHITE : BLACK;
  }

  return { ok: true };
}

/**
 * 撤销最近一手（悔棋），返回被移除的落子。
 */
function undoLast(state) {
  const last = state.history.pop();
  if (!last) return null;
  state.board[indexOf(state.size, last.x, last.y)] = EMPTY;
  state.turn = last.color;
  state.status = 'playing';
  state.winner = EMPTY;
  state.winLine = null;
  state.reason = null;
  return last;
}

module.exports = {
  SIZE,
  EMPTY,
  BLACK,
  WHITE,
  DIRECTIONS,
  createBoard,
  indexOf,
  inBounds,
  findWinLine,
  placeStone,
  undoLast,
};
