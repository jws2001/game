'use strict';

/**
 * 中国象棋核心规则（纯逻辑，方便单测）
 *
 * 棋盘：9 列 × 10 行，红方在下，黑方在上，红先。
 * 坐标：x = 0..8（左→右），y = 0..9（上→下）。
 *
 * 棋子编码：红 1..7，黑 8..14，0 为空。
 *   1/8 将帅、2/9 士仕、3/10 象相、4/11 马、5/12 车、6/13 炮、7/14 兵卒
 */

const COLS = 9;
const ROWS = 10;
const CELLS = COLS * ROWS;

const RED = 1;
const BLACK = 2;

const KING = 1;
const ADVISOR = 2;
const ELEPHANT = 3;
const HORSE = 4;
const ROOK = 5;
const CANNON = 6;
const PAWN = 7;

const RED_NAMES = ['', '帅', '仕', '相', '马', '车', '炮', '兵'];
const BLACK_NAMES = ['', '将', '士', '象', '马', '车', '炮', '卒'];

const BACK_RANK = [ROOK, HORSE, ELEPHANT, ADVISOR, KING, ADVISOR, ELEPHANT, HORSE, ROOK];
const ORTHO = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const DIAG = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
const HORSE_MOVES = [
  [2, 1],
  [2, -1],
  [-2, 1],
  [-2, -1],
  [1, 2],
  [1, -2],
  [-1, 2],
  [-1, -2],
];

const idx = (x, y) => y * COLS + x;
const inBoard = (x, y) => x >= 0 && x < COLS && y >= 0 && y < ROWS;
const other = (color) => (color === RED ? BLACK : RED);

function makePiece(color, type) {
  return color === RED ? type : type + 7;
}

function colorOf(piece) {
  if (!piece) return 0;
  return piece <= 7 ? RED : BLACK;
}

function typeOf(piece) {
  if (!piece) return 0;
  return piece <= 7 ? piece : piece - 7;
}

function labelOf(piece) {
  if (!piece) return '';
  return colorOf(piece) === RED ? RED_NAMES[typeOf(piece)] : BLACK_NAMES[typeOf(piece)];
}

function inPalace(color, x, y) {
  if (x < 3 || x > 5) return false;
  return color === RED ? y >= 7 && y <= 9 : y >= 0 && y <= 2;
}

function crossedRiver(color, y) {
  return color === RED ? y <= 4 : y >= 5;
}

function createBoard() {
  const board = new Uint8Array(CELLS);

  for (let x = 0; x < COLS; x += 1) {
    board[idx(x, 0)] = makePiece(BLACK, BACK_RANK[x]);
    board[idx(x, 9)] = makePiece(RED, BACK_RANK[x]);
  }

  board[idx(1, 2)] = makePiece(BLACK, CANNON);
  board[idx(7, 2)] = makePiece(BLACK, CANNON);
  board[idx(1, 7)] = makePiece(RED, CANNON);
  board[idx(7, 7)] = makePiece(RED, CANNON);

  for (const x of [0, 2, 4, 6, 8]) {
    board[idx(x, 3)] = makePiece(BLACK, PAWN);
    board[idx(x, 6)] = makePiece(RED, PAWN);
  }

  return board;
}

function findKing(board, color) {
  const king = makePiece(color, KING);
  for (let i = 0; i < CELLS; i += 1) {
    if (board[i] === king) return i;
  }
  return -1;
}

function pushMove(out, board, from, x, y, color) {
  if (!inBoard(x, y)) return false;
  const to = idx(x, y);
  const target = board[to];
  if (target && colorOf(target) === color) return false;
  out.push(to);
  return true;
}

/* ------------------------------------------------------------------ */
/* 伪合法走法（不检查己方被将军）                                       */
/* ------------------------------------------------------------------ */

function pseudoMovesFrom(board, from) {
  const piece = board[from];
  const color = colorOf(piece);
  const type = typeOf(piece);
  const x = from % COLS;
  const y = Math.floor(from / COLS);
  const out = [];

  if (type === ROOK) {
    for (const [dx, dy] of ORTHO) {
      let nx = x + dx;
      let ny = y + dy;
      while (inBoard(nx, ny)) {
        const to = idx(nx, ny);
        const target = board[to];
        if (!target) {
          out.push(to);
        } else {
          if (colorOf(target) !== color) out.push(to);
          break;
        }
        nx += dx;
        ny += dy;
      }
    }
    return out;
  }

  if (type === CANNON) {
    for (const [dx, dy] of ORTHO) {
      let nx = x + dx;
      let ny = y + dy;
      let screen = false;

      while (inBoard(nx, ny)) {
        const to = idx(nx, ny);
        const target = board[to];

        if (!screen) {
          if (!target) out.push(to);
          else screen = true;
        } else if (target) {
          if (colorOf(target) !== color) out.push(to);
          break;
        }

        nx += dx;
        ny += dy;
      }
    }
    return out;
  }

  if (type === HORSE) {
    for (const [dx, dy] of HORSE_MOVES) {
      const lx = x + (Math.abs(dx) === 2 ? dx / 2 : 0);
      const ly = y + (Math.abs(dy) === 2 ? dy / 2 : 0);
      if (!inBoard(lx, ly) || board[idx(lx, ly)]) continue;
      pushMove(out, board, from, x + dx, y + dy, color);
    }
    return out;
  }

  if (type === ELEPHANT) {
    for (const [dx, dy] of DIAG) {
      const tx = x + dx * 2;
      const ty = y + dy * 2;
      if (!inBoard(tx, ty)) continue;
      if (color === RED ? ty < 5 : ty > 4) continue;
      if (board[idx(x + dx, y + dy)]) continue;
      pushMove(out, board, from, tx, ty, color);
    }
    return out;
  }

  if (type === ADVISOR) {
    for (const [dx, dy] of DIAG) {
      const tx = x + dx;
      const ty = y + dy;
      if (!inPalace(color, tx, ty)) continue;
      pushMove(out, board, from, tx, ty, color);
    }
    return out;
  }

  if (type === KING) {
    for (const [dx, dy] of ORTHO) {
      const tx = x + dx;
      const ty = y + dy;
      if (!inPalace(color, tx, ty)) continue;
      pushMove(out, board, from, tx, ty, color);
    }

    // 白脸将：同列且中间无子时，将/帅可以“看到”并吃掉对方将/帅
    const enemyKing = findKing(board, other(color));
    if (enemyKing >= 0) {
      const ex = enemyKing % COLS;
      const ey = Math.floor(enemyKing / COLS);
      if (ex === x) {
        let clear = true;
        let cy = y + (ey > y ? 1 : -1);
        while (cy !== ey) {
          if (board[idx(x, cy)]) {
            clear = false;
            break;
          }
          cy += ey > y ? 1 : -1;
        }
        if (clear) out.push(enemyKing);
      }
    }
    return out;
  }

  if (type === PAWN) {
    if (color === RED) {
      pushMove(out, board, from, x, y - 1, color);
      if (crossedRiver(RED, y)) {
        pushMove(out, board, from, x - 1, y, color);
        pushMove(out, board, from, x + 1, y, color);
      }
    } else {
      pushMove(out, board, from, x, y + 1, color);
      if (crossedRiver(BLACK, y)) {
        pushMove(out, board, from, x - 1, y, color);
        pushMove(out, board, from, x + 1, y, color);
      }
    }
    return out;
  }

  return out;
}

function pseudoMoves(board, color) {
  const out = [];
  for (let from = 0; from < CELLS; from += 1) {
    if (!board[from] || colorOf(board[from]) !== color) continue;
    for (const to of pseudoMovesFrom(board, from)) out.push({ from, to });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 合法性 / 将军                                                       */
/* ------------------------------------------------------------------ */

function isKingInCheck(board, color) {
  const king = findKing(board, color);
  if (king < 0) return true;

  const enemy = other(color);
  for (let from = 0; from < CELLS; from += 1) {
    if (!board[from] || colorOf(board[from]) !== enemy) continue;
    if (pseudoMovesFrom(board, from).includes(king)) return true;
  }
  return false;
}

/**
 * 返回某一方的所有合法走法。
 * @returns {{from:number,to:number,captured:number}[]}
 */
function getLegalMoves(board, color) {
  if (findKing(board, color) < 0) return [];

  const moves = [];
  for (let from = 0; from < CELLS; from += 1) {
    const piece = board[from];
    if (!piece || colorOf(piece) !== color) continue;

    for (const to of pseudoMovesFrom(board, from)) {
      const captured = board[to];
      board[to] = piece;
      board[from] = 0;

      const illegal = isKingInCheck(board, color);

      board[from] = piece;
      board[to] = captured;

      if (!illegal) moves.push({ from, to, captured });
    }
  }
  return moves;
}

function isLegalMove(board, color, from, to) {
  return getLegalMoves(board, color).some((move) => move.from === from && move.to === to);
}

/* ------------------------------------------------------------------ */
/* 对局状态                                                            */
/* ------------------------------------------------------------------ */

function createGame() {
  return {
    board: createBoard(),
    turn: RED,
    status: 'playing',
    winner: 0,
    reason: null,
    check: null,
    history: [],
    noCapturePlies: 0,
  };
}

/**
 * 在 state 上走一步棋（state 需包含 board/turn/status/history/noCapturePlies 等）。
 * @returns {{ok:boolean, error?:string, captured?:number, winner?:number}}
 */
function applyMove(state, color, from, to) {
  if (state.status !== 'playing') return { ok: false, error: '对局已结束' };
  if (color !== state.turn) return { ok: false, error: '还没轮到你走棋' };
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    from >= CELLS ||
    to < 0 ||
    to >= CELLS
  ) {
    return { ok: false, error: '走法不合法' };
  }
  if (from === to) return { ok: false, error: '起点和终点相同' };

  const piece = state.board[from];
  if (!piece || colorOf(piece) !== color) return { ok: false, error: '请选择自己的棋子' };

  const legal = getLegalMoves(state.board, color);
  if (!legal.some((move) => move.from === from && move.to === to)) {
    return { ok: false, error: isKingInCheck(state.board, color) ? '当前被将军，必须应将' : '这步棋走不了' };
  }

  const captured = state.board[to];
  const noCaptureBefore = state.noCapturePlies;

  state.board[to] = piece;
  state.board[from] = 0;
  state.history.push({
    from,
    to,
    piece,
    captured,
    color,
    noCaptureBefore,
  });

  state.noCapturePlies = captured ? 0 : noCaptureBefore + 1;

  const opponent = other(color);
  state.turn = opponent;

  const opponentMoves = getLegalMoves(state.board, opponent);
  const capturedKing = typeOf(captured) === KING;

  if (capturedKing || opponentMoves.length === 0) {
    state.status = 'over';
    state.winner = color;
    state.reason =
      capturedKing || isKingInCheck(state.board, opponent) ? 'checkmate' : 'stalemate';
    state.check = null;
  } else if (state.noCapturePlies >= 120) {
    state.status = 'over';
    state.winner = 0;
    state.reason = 'draw';
    state.check = null;
  } else {
    state.check = isKingInCheck(state.board, opponent) ? opponent : null;
  }

  return { ok: true, captured: typeOf(captured), winner: state.winner };
}

function undoLast(state) {
  const last = state.history.pop();
  if (!last) return null;

  state.board[last.from] = last.piece;
  state.board[last.to] = last.captured;
  state.turn = last.color;
  state.status = 'playing';
  state.winner = 0;
  state.reason = null;
  state.noCapturePlies = last.noCaptureBefore;
  state.check = isKingInCheck(state.board, state.turn) ? state.turn : null;

  return last;
}

function getCaptures(history) {
  const captures = { red: [], black: [] };
  for (const move of history) {
    if (!move.captured) continue;
    const key = move.color === RED ? 'red' : 'black';
    captures[key].push(typeOf(move.captured));
  }
  return captures;
}

module.exports = {
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
  RED_NAMES,
  BLACK_NAMES,
  idx,
  inBoard,
  inPalace,
  other,
  makePiece,
  colorOf,
  typeOf,
  labelOf,
  createBoard,
  findKing,
  pseudoMovesFrom,
  pseudoMoves,
  isKingInCheck,
  getLegalMoves,
  isLegalMove,
  createGame,
  applyMove,
  undoLast,
  getCaptures,
};
