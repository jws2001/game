'use strict';

(() => {
  const COLS = 9;
  const ROWS = 10;
  const RED = 1;
  const BLACK = 2;
  const KING = 1;

  const PIECE_NAMES = {
    [RED]: ['', '帅', '仕', '相', '马', '车', '炮', '兵'],
    [BLACK]: ['', '将', '士', '象', '马', '车', '炮', '卒'],
  };

  const STORAGE_NAME = 'xiangqi.name';
  const STORAGE_SOUND = 'xiangqi.sound';
  const SESSION_KEY = 'xiangqi.session';

  const $ = (id) => document.getElementById(id);

  const S = {
    lanUrl: location.origin,
    lanInfoPromise: null,
    ws: null,
    connected: false,
    reconnectTimer: null,
    reconnectAttempt: 0,
    room: null,
    you: null,
    prevRoom: null,
    prevBoard: null,
    lastMoveKey: '',
    selected: null,
    hover: null,
    anim: null,
    rafId: 0,
    soundOn: localStorage.getItem(STORAGE_SOUND) !== 'off',
    roomsTimer: null,
    toastTimer: 0,
  };

  const params = new URLSearchParams(location.search);
  const roomFromUrl = (params.get('room') || '').trim().toUpperCase();
  const nameFromUrl = (params.get('name') || '').trim().slice(0, 12);

  /* ------------------------------------------------------------------ */
  /* DOM                                                                 */
  /* ------------------------------------------------------------------ */

  const canvas = $('board');
  const ctx = canvas.getContext('2d');
  const boardFrame = $('boardFrame');
  const els = {
    lobby: $('lobby'),
    lobbyHint: $('lobbyHint'),
    lobbyAddr: $('lobbyAddr'),
    nameInput: $('nameInput'),
    roomInput: $('roomInput'),
    createBtn: $('createBtn'),
    joinBtn: $('joinBtn'),
    scanBtn: $('scanBtn'),
    connBadge: $('connBadge'),
    roomCode: $('roomCode'),
    copyBtn: $('copyBtn'),
    qrBtn: $('qrBtn'),
    qrModal: $('qrModal'),
    qrClose: $('qrClose'),
    qrFrame: $('qrFrame'),
    qrRoomCode: $('qrRoomCode'),
    qrLink: $('qrLink'),
    qrCopy: $('qrCopy'),
    roomsModal: $('roomsModal'),
    roomsClose: $('roomsClose'),
    roomsHint: $('roomsHint'),
    roomsList: $('roomsList'),
    roomsRefresh: $('roomsRefresh'),
    players: $('players'),
    statusBox: $('statusBox'),
    statusTitle: $('statusTitle'),
    statusSub: $('statusSub'),
    moveMeta: $('moveMeta'),
    roomMeta: $('roomMeta'),
    undoBtn: $('undoBtn'),
    resignBtn: $('resignBtn'),
    restartBtn: $('restartBtn'),
    undoBanner: $('undoBanner'),
    undoText: $('undoText'),
    undoActions: $('undoActions'),
    spectatorNote: $('spectatorNote'),
    leaveBtn: $('leaveBtn'),
    rulesBtn: $('rulesBtn'),
    rulesBtnTop: $('rulesBtnTop'),
    rulesModal: $('rulesModal'),
    rulesClose: $('rulesClose'),
    boardOverlay: $('boardOverlay'),
    resultTitle: $('resultTitle'),
    resultSub: $('resultSub'),
    resultStones: $('resultStones'),
    resultHint: $('resultHint'),
    overlayRestart: $('overlayRestart'),
    soundBtn: $('soundBtn'),
    toast: $('toast'),
  };

  /* ------------------------------------------------------------------ */
  /* 棋盘绘制                                                            */
  /* ------------------------------------------------------------------ */

  const G = { w: 0, h: 0, cell: 0, ox: 0, oy: 0, dpr: 1 };
  let grain = [];

  function colorOf(piece) {
    if (!piece) return 0;
    return piece <= 7 ? RED : BLACK;
  }

  function typeOf(piece) {
    if (!piece) return 0;
    return piece <= 7 ? piece : piece - 7;
  }

  function labelOf(piece) {
    return PIECE_NAMES[colorOf(piece)][typeOf(piece)];
  }

  const idx = (x, y) => y * COLS + x;
  const cellX = (x) => G.ox + x * G.cell;
  const cellY = (y) => G.oy + y * G.cell;

  function buildGrain() {
    let seed = 19;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    grain = [];
    for (let i = 0; i < 26; i += 1) {
      grain.push({
        y: rand(),
        amp: 2 + rand() * 9,
        phase: rand() * Math.PI * 2,
        freq: 0.7 + rand() * 2.4,
        width: 0.5 + rand() * 1.6,
        alpha: 0.012 + rand() * 0.022,
      });
    }
  }
  buildGrain();

  function resizeBoard() {
    const rect = boardFrame.getBoundingClientRect();
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);
    if (!w || !h) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    G.w = w;
    G.h = h;
    G.dpr = dpr;
    G.cell = Math.min(w / 10.2, h / 11.2);
    G.ox = (w - G.cell * (COLS - 1)) / 2;
    G.oy = (h - G.cell * (ROWS - 1)) / 2;
    requestDraw();
  }

  function drawBoard() {
    const w = G.w;
    const h = G.h;
    const cell = G.cell;
    const ox = G.ox;
    const oy = G.oy;

    const grad = ctx.createLinearGradient(0, 0, w * 0.9, h);
    grad.addColorStop(0, '#e8c58f');
    grad.addColorStop(0.45, '#ddb47a');
    grad.addColorStop(0.75, '#d4a76b');
    grad.addColorStop(1, '#c8955a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    for (const f of grain) {
      ctx.beginPath();
      for (let x = 0; x <= w; x += 6) {
        const y = f.y * h + Math.sin((x / w) * Math.PI * f.freq + f.phase) * f.amp;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = `rgba(104, 61, 20, ${f.alpha})`;
      ctx.lineWidth = f.width;
      ctx.stroke();
    }
    ctx.restore();

    const line = (x1, y1, x2, y2) => {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    };

    // 横线
    ctx.strokeStyle = 'rgba(72, 43, 14, 0.62)';
    ctx.lineWidth = Math.max(1, w / 620);
    for (let y = 0; y < ROWS; y += 1) {
      line(ox, oy + y * cell, ox + (COLS - 1) * cell, oy + y * cell);
    }

    // 竖线：中间七条在楚河汉界处断开，左右两条为外框
    for (let x = 0; x < COLS; x += 1) {
      if (x === 0 || x === COLS - 1) {
        line(ox + x * cell, oy, ox + x * cell, oy + (ROWS - 1) * cell);
      } else {
        line(ox + x * cell, oy, ox + x * cell, oy + 4 * cell);
        line(ox + x * cell, oy + 5 * cell, ox + x * cell, oy + 9 * cell);
      }
    }

    // 九宫斜线
    const palace = (x1, y1, x2, y2) => {
      line(ox + x1 * cell, oy + y1 * cell, ox + x2 * cell, oy + y2 * cell);
    };
    palace(3, 0, 5, 2);
    palace(5, 0, 3, 2);
    palace(3, 7, 5, 9);
    palace(5, 7, 3, 9);

    // 外框
    ctx.strokeStyle = 'rgba(56, 32, 10, 0.85)';
    ctx.lineWidth = Math.max(1.6, w / 340);
    ctx.strokeRect(ox, oy, (COLS - 1) * cell, (ROWS - 1) * cell);

    // 楚河汉界
    ctx.save();
    ctx.fillStyle = 'rgba(70, 40, 13, 0.52)';
    ctx.font = `600 ${Math.max(14, cell * 0.46)}px "Kaiti SC", "STKaiti", "KaiTi", "Songti SC", serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const riverY = oy + 4.5 * cell;
    ctx.fillText('楚  河', ox + 2 * cell, riverY);
    ctx.fillText('汉  界', ox + 6 * cell, riverY);
    ctx.restore();

    // 兵、炮位置标记
    const marks = [
      [1, 2], [7, 2], [1, 7], [7, 7],
      [0, 3], [2, 3], [4, 3], [6, 3], [8, 3],
      [0, 6], [2, 6], [4, 6], [6, 6], [8, 6],
    ];
    ctx.save();
    ctx.strokeStyle = 'rgba(72, 43, 14, 0.5)';
    ctx.lineWidth = Math.max(1, w / 700);
    const gap = cell * 0.1;
    const len = cell * 0.17;
    for (const [mx, my] of marks) {
      const cx = ox + mx * cell;
      const cy = oy + my * cell;
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          if ((mx === 0 && sx < 0) || (mx === COLS - 1 && sx > 0)) continue;
          if ((my === 0 && sy < 0) || (my === ROWS - 1 && sy > 0)) continue;
          ctx.beginPath();
          ctx.moveTo(cx + sx * gap, cy + sy * (gap + len));
          ctx.lineTo(cx + sx * gap, cy + sy * gap);
          ctx.lineTo(cx + sx * (gap + len), cy + sy * gap);
          ctx.stroke();
        }
      }
    }
    ctx.restore();

    // 暗角
    const vignette = ctx.createRadialGradient(w * 0.45, h * 0.42, Math.min(w, h) * 0.18, w * 0.5, h * 0.5, Math.max(w, h) * 0.72);
    vignette.addColorStop(0, 'rgba(90, 50, 12, 0)');
    vignette.addColorStop(1, 'rgba(88, 48, 12, 0.26)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);
  }

  function drawPiece(cx, cy, piece, options = {}) {
    const { scale = 1, selected = false, checked = false, alpha = 1 } = options;
    const r = G.cell * 0.43 * scale;
    if (r <= 0.2) return;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.shadowColor = 'rgba(34, 17, 2, 0.46)';
    ctx.shadowBlur = r * 0.5;
    ctx.shadowOffsetY = r * 0.16;

    const grad = ctx.createRadialGradient(cx - r * 0.34, cy - r * 0.38, r * 0.12, cx, cy, r * 1.08);
    grad.addColorStop(0, '#fffdf4');
    grad.addColorStop(0.55, '#f5e8cb');
    grad.addColorStop(0.86, '#ead8b4');
    grad.addColorStop(1, '#d6c19a');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowColor = 'transparent';
    const color = colorOf(piece) === RED ? '#a5342a' : '#252525';
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.5, r * 0.1);
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.97, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = colorOf(piece) === RED ? 'rgba(165, 52, 42, 0.35)' : 'rgba(37, 37, 37, 0.32)';
    ctx.lineWidth = Math.max(0.8, r * 0.035);
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.8, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.font = `600 ${r * 1.18}px "Songti SC", "STSong", "SimSun", "Noto Serif SC", serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    const glyph = labelOf(piece);
    const metrics = ctx.measureText(glyph);
    const inkLeft = metrics.actualBoundingBoxLeft || 0;
    const inkRight = metrics.actualBoundingBoxRight || metrics.width;
    const inkAscent = metrics.actualBoundingBoxAscent || r * 0.8;
    const inkDescent = metrics.actualBoundingBoxDescent || r * 0.12;

    // 按字形实际墨迹范围做水平 / 垂直居中（不同字体的基线偏移不同）
    ctx.fillText(
      glyph,
      cx - (inkRight - inkLeft) / 2,
      cy + (inkAscent - inkDescent) / 2
    );

    if (selected) {
      ctx.strokeStyle = 'rgba(255, 209, 126, 0.95)';
      ctx.lineWidth = Math.max(2, r * 0.12);
      ctx.shadowColor = 'rgba(255, 190, 80, 0.9)';
      ctx.shadowBlur = r * 0.6;
      ctx.beginPath();
      ctx.arc(cx, cy, r + Math.max(2.5, r * 0.12), 0, Math.PI * 2);
      ctx.stroke();
    }

    if (checked) {
      ctx.strokeStyle = 'rgba(232, 74, 54, 0.95)';
      ctx.lineWidth = Math.max(2, r * 0.12);
      ctx.shadowColor = 'rgba(232, 74, 54, 0.95)';
      ctx.shadowBlur = r * 0.9;
      ctx.beginPath();
      ctx.arc(cx, cy, r + Math.max(3, r * 0.16), 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  function drawLastMove(room) {
    const last = room.lastMove;
    if (!last) return;

    const from = viewPoint(last.from);
    const to = viewPoint(last.to);

    ctx.save();
    if (!room.board[last.from]) {
      ctx.strokeStyle = 'rgba(120, 74, 30, 0.42)';
      ctx.lineWidth = Math.max(1, G.cell * 0.04);
      ctx.beginPath();
      ctx.arc(cellX(from.x), cellY(from.y), G.cell * 0.09, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255, 196, 104, 0.38)';
    ctx.lineWidth = Math.max(1.5, G.cell * 0.06);
    ctx.beginPath();
    ctx.arc(cellX(to.x), cellY(to.y), G.cell * 0.495, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawSelection(room) {
    if (S.selected === null) return;
    const targets = legalTargetsFor(S.selected);
    if (!targets.length) return;

    ctx.save();
    for (const to of targets) {
      const point = viewPoint(to);
      const occupied = !!room.board[to];

      if (!occupied) {
        ctx.beginPath();
        ctx.arc(cellX(point.x), cellY(point.y), G.cell * 0.085, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 206, 120, 0.62)';
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(cellX(point.x), cellY(point.y), G.cell * 0.5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(232, 92, 68, 0.82)';
        ctx.lineWidth = Math.max(1.8, G.cell * 0.06);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawHover() {
    if (S.selected === null || !S.hover) return;
    if (!legalTargetsFor(S.selected).includes(S.hover)) return;

    const point = viewPoint(S.hover);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cellX(point.x), cellY(point.y), G.cell * 0.47, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 226, 170, 0.92)';
    ctx.lineWidth = Math.max(2, G.cell * 0.075);
    ctx.shadowColor = 'rgba(255, 190, 80, 0.9)';
    ctx.shadowBlur = G.cell * 0.35;
    ctx.stroke();
    ctx.restore();
  }

  function draw() {
    const w = G.w;
    const h = G.h;
    if (!w || !h) return;
    ctx.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    drawBoard();

    const room = S.room;
    if (!room) {
      ctx.save();
      ctx.fillStyle = 'rgba(74, 43, 14, 0.5)';
      ctx.font = `500 ${Math.max(12, G.cell * 0.34)}px -apple-system, "PingFang SC", sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('创建或加入房间后开始对局', w / 2, h / 2 + G.cell * 0.9);
      ctx.restore();
      return;
    }

    drawLastMove(room);

    const now = performance.now();
    let animating = false;
    let anim = S.anim;

    if (anim) {
      const t = Math.min(1, (now - anim.start) / anim.duration);
      if (t >= 1) {
        S.anim = null;
        anim = null;
      } else {
        animating = true;
      }
    }

    for (let y = 0; y < ROWS; y += 1) {
      for (let x = 0; x < COLS; x += 1) {
        const piece = room.board[idx(x, y)];
        if (!piece) continue;
        // 正在滑动的棋子单独绘制
        if (anim && anim.to === idx(x, y)) continue;

        const point = viewPoint(idx(x, y));
        drawPiece(cellX(point.x), cellY(point.y), piece, {
          selected: S.selected === idx(x, y),
          checked: room.check === colorOf(piece) && typeOf(piece) === KING,
        });
      }
    }

    if (anim) {
      const t = Math.min(1, (now - anim.start) / anim.duration);
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const fromPoint = viewPoint(anim.from);
      const toPoint = viewPoint(anim.to);
      const vx = fromPoint.x + (toPoint.x - fromPoint.x) * eased;
      const vy = fromPoint.y + (toPoint.y - fromPoint.y) * eased;

      if (anim.captured) {
        drawPiece(cellX(toPoint.x), cellY(toPoint.y), anim.captured, {
          alpha: Math.max(0, 1 - t * 1.8),
          scale: 1 - t * 0.12,
        });
      }

      const lift = 1 + Math.sin(Math.PI * t) * 0.045;
      drawPiece(cellX(vx), cellY(vy), anim.piece, {
        scale: lift,
        selected: S.selected === anim.to,
      });
    }

    drawSelection(room);
    drawHover();

    if (animating) requestDraw();
  }

  function requestDraw() {
    if (S.rafId) return;
    S.rafId = requestAnimationFrame(() => {
      S.rafId = 0;
      draw();
    });
  }

  function legalTargetsFor(from) {
    if (!S.room || !S.room.legalMoves) return [];
    return S.room.legalMoves[from] || [];
  }

  function isFlipped() {
    return !!(S.you && S.you.color === BLACK && !S.you.spectator);
  }

  function viewPoint(index) {
    const x = index % COLS;
    const y = Math.floor(index / COLS);
    if (!isFlipped()) return { x, y };
    return { x: COLS - 1 - x, y: ROWS - 1 - y };
  }

  function canMove() {
    return !!(
      S.connected &&
      S.room &&
      S.room.status === 'playing' &&
      S.you &&
      S.you.color &&
      !S.you.spectator &&
      S.room.turn === S.you.color
    );
  }

  function eventToCell(event) {
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const vx = Math.round((px - G.ox) / G.cell);
    const vy = Math.round((py - G.oy) / G.cell);
    if (vx < 0 || vy < 0 || vx >= COLS || vy >= ROWS) return null;
    if (Math.hypot(px - cellX(vx), py - cellY(vy)) > G.cell * 0.56) return null;

    const x = isFlipped() ? COLS - 1 - vx : vx;
    const y = isFlipped() ? ROWS - 1 - vy : vy;
    return idx(x, y);
  }

  canvas.addEventListener('pointermove', (event) => {
    if (!canMove() || S.selected === null) {
      if (S.hover !== null) {
        S.hover = null;
        requestDraw();
      }
      return;
    }
    const cell = eventToCell(event);
    const next = cell !== null && legalTargetsFor(S.selected).includes(cell) ? cell : null;
    if (next === S.hover) return;
    S.hover = next;
    requestDraw();
  });

  canvas.addEventListener('pointerleave', () => {
    if (S.hover === null) return;
    S.hover = null;
    requestDraw();
  });

  canvas.addEventListener('click', (event) => {
    if (!S.room) {
      showLobby();
      return;
    }
    if (!canMove()) {
      if (S.room.status === 'playing' && S.you && S.you.spectator) {
        toast('观战中，不能走棋');
      }
      return;
    }

    const cell = eventToCell(event);
    if (cell === null) return;

    if (S.selected !== null) {
      if (legalTargetsFor(S.selected).includes(cell)) {
        send({ type: 'move', from: S.selected, to: cell });
        S.selected = null;
        S.hover = null;
        requestDraw();
        return;
      }
      if (cell === S.selected) {
        S.selected = null;
        S.hover = null;
        render();
        requestDraw();
        return;
      }
    }

    const piece = S.room.board[cell];
    if (
      piece &&
      colorOf(piece) === S.you.color &&
      legalTargetsFor(cell).length > 0
    ) {
      S.selected = cell;
      S.hover = null;
      render();
      requestDraw();
    } else {
      S.selected = null;
      S.hover = null;
      requestDraw();
    }
  });

  /* ------------------------------------------------------------------ */
  /* 音效                                                                */
  /* ------------------------------------------------------------------ */

  let audioCtx = null;

  function tone(freq, duration, type = 'sine', volume = 0.04) {
    if (!S.soundOn) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(volume, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + duration);
    } catch (err) {
      /* 忽略音频错误 */
    }
  }

  function playMoveSound() {
    tone(520, 0.06, 'triangle', 0.05);
    setTimeout(() => tone(220, 0.08, 'sine', 0.03), 20);
  }

  function playCaptureSound() {
    tone(300, 0.08, 'triangle', 0.06);
    setTimeout(() => tone(140, 0.14, 'sine', 0.05), 40);
  }

  function playCheckSound() {
    tone(880, 0.1, 'triangle', 0.05);
    setTimeout(() => tone(1174, 0.16, 'triangle', 0.05), 90);
  }

  function playWinSound() {
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
      setTimeout(() => tone(freq, 0.22, 'sine', 0.05), i * 120);
    });
  }

  function syncSoundButton() {
    els.soundBtn.classList.toggle('is-muted', !S.soundOn);
    els.soundBtn.title = S.soundOn ? '关闭音效' : '开启音效';
  }

  els.soundBtn.addEventListener('click', () => {
    S.soundOn = !S.soundOn;
    localStorage.setItem(STORAGE_SOUND, S.soundOn ? 'on' : 'off');
    syncSoundButton();
    if (S.soundOn) playMoveSound();
  });
  syncSoundButton();

  /* ------------------------------------------------------------------ */
  /* 网络                                                                */
  /* ------------------------------------------------------------------ */

  function readSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      return data && data.roomId ? data : null;
    } catch (err) {
      return null;
    }
  }

  function saveSession(session) {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch (err) {
      /* 忽略 */
    }
  }

  function clearSession() {
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch (err) {
      /* 忽略 */
    }
  }

  function getSession() {
    return readSession();
  }

  function send(data) {
    if (!S.ws || S.ws.readyState !== WebSocket.OPEN) {
      toast('网络尚未连接，请稍候', true);
      return false;
    }
    S.ws.send(JSON.stringify(data));
    return true;
  }

  function setConn(state) {
    const badge = els.connBadge;
    badge.classList.remove('is-online', 'is-offline', 'is-connecting');
    const label = badge.querySelector('span');
    if (state === 'online') {
      badge.classList.add('is-online');
      label.textContent = '已连接';
    } else if (state === 'offline') {
      badge.classList.add('is-offline');
      label.textContent = '已断开';
    } else {
      badge.classList.add('is-connecting');
      label.textContent = '连接中';
    }
  }

  function connect() {
    if (S.ws && (S.ws.readyState === WebSocket.OPEN || S.ws.readyState === WebSocket.CONNECTING)) return;
    setConn('connecting');

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    try {
      ws = new WebSocket(`${proto}//${location.host}`);
    } catch (err) {
      scheduleReconnect();
      return;
    }
    S.ws = ws;

    ws.addEventListener('open', () => {
      S.connected = true;
      S.reconnectAttempt = 0;
      setConn('online');
      onConnected();
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      handleMessage(msg);
    });

    ws.addEventListener('close', () => {
      S.connected = false;
      setConn('offline');
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      /* close 事件统一处理 */
    });
  }

  function scheduleReconnect() {
    if (S.reconnectTimer) return;
    const delay = Math.min(8000, 500 * 2 ** S.reconnectAttempt);
    S.reconnectAttempt += 1;
    setConn('offline');
    S.reconnectTimer = setTimeout(() => {
      S.reconnectTimer = null;
      connect();
    }, delay);
  }

  function onConnected() {
    const session = getSession();
    if (session && (!roomFromUrl || roomFromUrl === session.roomId)) {
      autoJoin(session.roomId, session.token, session.name);
      return;
    }
    if (session && roomFromUrl && roomFromUrl !== session.roomId) {
      clearSession();
    }
    if (roomFromUrl && nameFromUrl) {
      autoJoin(roomFromUrl, null, nameFromUrl);
      return;
    }
    showLobby();
    if (roomFromUrl) {
      els.roomInput.value = roomFromUrl;
      els.lobbyHint.textContent = `输入昵称后加入房间 ${roomFromUrl}`;
      if (window.matchMedia('(pointer: fine)').matches) els.nameInput.focus();
    }
  }

  function autoJoin(roomId, token, name) {
    const payload = { type: 'join', roomId, name: name || getNickname() };
    if (token) payload.token = token;
    send(payload);
  }

  /* ------------------------------------------------------------------ */
  /* 消息处理                                                            */
  /* ------------------------------------------------------------------ */

  function handleMessage(msg) {
    switch (msg.type) {
      case 'welcome':
        saveSession({ roomId: msg.roomId, token: msg.token, name: msg.name });
        els.lobby.hidden = true;
        history.replaceState(null, '', `${location.pathname}?room=${msg.roomId}`);
        toast(`已进入房间 ${msg.roomId}`);
        break;

      case 'state':
        applyRoomState(msg);
        break;

      case 'error':
        toast(msg.message || '操作失败', true);
        if (msg.message && /不存在/.test(msg.message)) {
          const wasAuto = !!getSession() || !!nameFromUrl;
          clearSession();
          if (wasAuto) showLobby();
          if (els.lobbyHint) {
            els.lobbyHint.textContent = `房间 ${roomFromUrl || ''} 不存在，请检查房间号或重新创建。`;
            els.lobbyHint.classList.add('is-error');
          }
        }
        break;

      case 'notice':
        toast(msg.message || '');
        break;

      case 'left':
        resetToLobby();
        break;

      case 'pong':
        break;

      default:
        break;
    }
  }

  function applyRoomState(msg) {
    const prev = S.room;
    S.room = msg.room;
    S.you = msg.you;
    els.lobby.hidden = true;

    S.prevBoard = msg.room.board.slice();

    const last = msg.room.lastMove;
    const key = last ? `${last.from}-${last.to}-${msg.room.moveCount}` : '';
    const undone = prev && msg.room.moveCount < prev.moveCount;

    if (undone || !last) S.anim = null;

    if (prev && !undone && last && key !== S.lastMoveKey) {
      const fx = last.from % COLS;
      const fy = Math.floor(last.from / COLS);
      const tx = last.to % COLS;
      const ty = Math.floor(last.to / COLS);
      const dist = Math.hypot(tx - fx, ty - fy);

      S.anim = {
        from: last.from,
        to: last.to,
        piece: last.piece,
        captured: last.captured,
        start: performance.now(),
        duration: 210 + Math.min(80, dist * 16),
      };

      if (last.captured) playCaptureSound();
      else playMoveSound();

      if (prev && msg.room.check && prev.check !== msg.room.check) {
        setTimeout(playCheckSound, 160);
        toast(msg.room.check === (S.you && S.you.color) ? '你被将军了！' : '将军！');
      }
    }
    S.lastMoveKey = key;

    if ((!prev || prev.status !== 'over') && msg.room.status === 'over') {
      setTimeout(playWinSound, 180);
      if (navigator.vibrate) {
        try {
          navigator.vibrate([30, 60, 30]);
        } catch (err) {
          /* noop */
        }
      }
    }

    if (prev && (prev.turn !== msg.room.turn || msg.room.moveCount === 0)) {
      S.selected = null;
      S.hover = null;
    }
    if (prev && prev.id !== msg.room.id) {
      S.selected = null;
      S.hover = null;
      S.lastMoveKey = '';
    }

    render();
    requestDraw();
  }

  /* ------------------------------------------------------------------ */
  /* 渲染                                                                */
  /* ------------------------------------------------------------------ */

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => {
      switch (ch) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        default: return '&#39;';
      }
    });
  }

  function playerOnline(connected) {
    return connected
      ? '<span class="online-dot"></span>在线'
      : '<span class="online-dot off"></span>离线';
  }

  function capturesHtml(types, color) {
    if (!types || !types.length) return '';
    const names = PIECE_NAMES[color];
    return types.map((type) => `<span class="mini-piece ${color === RED ? 'red' : 'black'}">${names[type]}</span>`).join('');
  }

  function render() {
    const room = S.room;
    if (!room) return;

    boardFrame.dataset.view = isFlipped() ? 'black' : 'red';
    els.roomCode.textContent = room.id;
    els.moveMeta.textContent = room.status === 'waiting' ? '等待开局' : `第 ${room.moveCount} 手`;
    els.roomMeta.textContent = `房间 ${room.id} · 9 × 10`;

    renderPlayers(room);
    renderStatus(room);
    renderActions(room);
    renderOverlay(room);

    if (S.you && S.you.spectator) {
      els.spectatorNote.hidden = false;
      els.spectatorNote.textContent = `你正在观战 · 当前 ${room.spectatorCount} 位观众 · 棋盘实时同步`;
    } else {
      els.spectatorNote.hidden = true;
    }
  }

  function renderPlayers(room) {
    const seats = [
      { color: RED, key: 'red', label: '红方', char: '帅' },
      { color: BLACK, key: 'black', label: '黑方', char: '将' },
    ];

    els.players.innerHTML = seats
      .map(({ color, key, label, char }) => {
        const player = room.players[key];
        const isMe = S.you && S.you.color === color;
        const active = room.status === 'playing' && room.turn === color;
        const captured = room.captures ? room.captures[key] : [];

        if (!player) {
          return `
            <div class="player-card is-empty">
              <span class="piece-badge is-ghost">${char}</span>
              <div class="player-info">
                <div class="player-name">等待加入</div>
                <div class="player-sub">分享房间号 ${escapeHtml(room.id)} 给朋友</div>
              </div>
            </div>`;
        }

        return `
          <div class="player-card ${active ? 'is-active' : ''}">
            <span class="piece-badge ${color === RED ? 'red' : 'black'}">${char}</span>
            <div class="player-info">
              <div class="player-name">
                ${escapeHtml(player.name)}
                ${isMe ? '<span class="tag">你</span>' : ''}
              </div>
              <div class="player-sub">${label} · ${playerOnline(player.connected)}</div>
              ${captured.length ? `<div class="captures">${capturesHtml(captured, color === RED ? BLACK : RED)}</div>` : ''}
            </div>
            ${active ? '<span class="turn-indicator" title="行棋中"></span>' : ''}
          </div>`;
      })
      .join('');
  }

  function reasonText(reason) {
    switch (reason) {
      case 'checkmate': return '将死';
      case 'stalemate': return '困毙';
      case 'resign': return '对方认输';
      case 'leave': return '对方离开房间';
      case 'draw': return '60 回合无吃子';
      default: return '对局结束';
    }
  }

  function renderStatus(room) {
    const box = els.statusBox;
    box.classList.remove('is-live', 'is-mine', 'is-check');
    let title = '';
    let sub = '';

    if (room.status === 'waiting') {
      title = '等待对手加入';
      sub = `把房间号 ${room.id} 或邀请链接发给同一内网的朋友`;
    } else if (room.status === 'playing') {
      if (S.you && S.you.spectator) {
        title = '观战中';
        sub = '棋盘实时同步，等待本局结束';
      } else if (S.you && S.you.color === room.turn) {
        if (room.check === S.you.color) {
          title = '你被将军了';
          sub = '必须应将，否则将被将死';
          box.classList.add('is-check', 'is-live');
        } else {
          title = '轮到你走棋';
          sub = S.selected !== null ? '选择目标位置，或点击其他棋子' : '点击自己的棋子，再点击目标位置';
          box.classList.add('is-mine', 'is-live');
        }
      } else {
        if (room.check) {
          title = '将军！';
          sub = '对方正在应将';
          box.classList.add('is-live');
        } else {
          title = '等待对方走棋';
          sub = '对方正在思考中…';
          box.classList.add('is-live');
        }
      }
    } else {
      if (room.winner === 0) {
        title = '和棋';
        sub = '60 回合无吃子，势均力敌';
      } else if (S.you && S.you.color === room.winner) {
        title = '你赢了';
        sub = reasonText(room.reason);
      } else if (S.you && S.you.color) {
        title = '你输了';
        sub = reasonText(room.reason);
      } else {
        title = `${room.winner === RED ? '红方' : '黑方'}获胜`;
        sub = reasonText(room.reason);
      }
    }

    els.statusTitle.textContent = title;
    els.statusSub.textContent = sub;
  }

  function renderActions(room) {
    const seated = !!(S.you && S.you.color && !S.you.spectator);
    const playing = room.status === 'playing';

    els.undoBtn.disabled = !(seated && playing && room.moveCount > 0 && !room.undoRequest);
    els.resignBtn.disabled = !(seated && playing);

    const bothSeated = !!(room.players.red && room.players.black);
    const showRestart = room.status === 'over' && seated && bothSeated;
    els.restartBtn.hidden = !showRestart;
    els.overlayRestart.hidden = !showRestart;

    if (showRestart) {
      const key = S.you.color === RED ? 'red' : 'black';
      const otherKey = S.you.color === RED ? 'black' : 'red';
      const myVote = room.restartVotes[key];
      const otherVote = room.restartVotes[otherKey];
      els.restartBtn.textContent = myVote
        ? otherVote
          ? '开始新一局…'
          : '已准备 · 等待对方'
        : otherVote
        ? '再来一局 · 对方已准备'
        : '再来一局';
      els.overlayRestart.textContent = myVote ? '等待对方…' : '再来一局';
      els.overlayRestart.disabled = !!myVote;
      els.resultHint.hidden = !myVote;
      els.resultHint.textContent = myVote ? '已发送准备，等待对方确认…' : '';
    } else {
      els.resultHint.hidden = true;
      if (room.status === 'over' && seated && !bothSeated) {
        els.resultHint.hidden = false;
        els.resultHint.textContent = '等待新对手加入…';
      }
    }

    renderUndoBanner(room, seated);
  }

  function renderUndoBanner(room, seated) {
    const req = room.undoRequest;
    els.undoBanner.hidden = true;
    if (!req || !S.you) return;

    const mine = req.by === S.you.color;
    if (!S.you.color) {
      els.undoBanner.hidden = false;
      els.undoText.textContent = `${req.by === RED ? '红方' : '黑方'}请求悔棋，等待对方确认`;
      els.undoActions.innerHTML = '';
      return;
    }

    els.undoBanner.hidden = false;
    if (mine) {
      els.undoText.textContent = '悔棋请求已发送，等待对方确认…';
      els.undoActions.innerHTML = '<button class="mini-btn" data-undo="cancel" type="button">取消请求</button>';
    } else if (seated) {
      els.undoText.textContent = '对方请求悔棋，撤销最近一手。';
      els.undoActions.innerHTML = `
        <button class="mini-btn accept" data-undo="accept" type="button">同意</button>
        <button class="mini-btn" data-undo="reject" type="button">拒绝</button>`;
    } else {
      els.undoText.textContent = '双方正在处理悔棋请求';
      els.undoActions.innerHTML = '';
    }
  }

  function renderOverlay(room) {
    const over = room.status === 'over';
    els.boardOverlay.hidden = !over;
    if (!over) return;

    let title;
    if (room.winner === 0) title = '和棋';
    else if (S.you && S.you.color === room.winner) title = '你赢了';
    else if (S.you && S.you.color) title = '你输了';
    else title = `${room.winner === RED ? '红方' : '黑方'}获胜`;

    els.resultTitle.textContent = title;

    if (room.winner === 0) {
      els.resultStones.innerHTML =
        '<span class="xq-piece red">帅</span><span class="xq-piece black">将</span>';
    } else {
      const cls = room.winner === RED ? 'red' : 'black';
      const char = room.winner === RED ? '帅' : '将';
      els.resultStones.innerHTML = `<span class="xq-piece ${cls}">${char}</span>`;
    }

    els.resultSub.textContent = `${reasonText(room.reason)} · ${room.moveCount} 手`;
  }

  /* ------------------------------------------------------------------ */
  /* 大厅 / 房间操作                                                     */
  /* ------------------------------------------------------------------ */

  function getNickname() {
    const typed = els.nameInput ? els.nameInput.value.trim().slice(0, 12) : '';
    if (typed) return typed;
    const stored = localStorage.getItem(STORAGE_NAME);
    if (stored) return stored;
    return `棋手${Math.floor(100 + Math.random() * 900)}`;
  }

  function rememberName(name) {
    try {
      localStorage.setItem(STORAGE_NAME, name);
    } catch (err) {
      /* 忽略 */
    }
  }

  function showLobby(message) {
    els.lobby.hidden = false;
    els.lobbyHint.classList.remove('is-error');
    if (message) {
      els.lobbyHint.textContent = message;
    } else if (!S.room) {
      els.lobbyHint.textContent = '创建后，把房间链接发给同一内网的朋友即可开局。';
    }
    if (roomFromUrl && !els.roomInput.value) els.roomInput.value = roomFromUrl;
  }

  function createRoom() {
    if (!S.connected) {
      toast('正在连接服务器，请稍候', true);
      return;
    }
    const name = getNickname();
    rememberName(name);
    els.createBtn.disabled = true;
    const ok = send({ type: 'join', create: true, name });
    if (!ok) els.createBtn.disabled = false;
    setTimeout(() => {
      els.createBtn.disabled = false;
    }, 1200);
  }

  function attemptJoin(roomId) {
    if (!S.connected) {
      toast('正在连接服务器，请稍候', true);
      return false;
    }
    const name = getNickname();
    rememberName(name);
    const session = getSession();
    const token = session && session.roomId === roomId && session.token ? session.token : undefined;
    const payload = { type: 'join', roomId, name };
    if (token) payload.token = token;
    return send(payload);
  }

  function joinRoom() {
    if (!S.connected) {
      toast('正在连接服务器，请稍候', true);
      return;
    }
    const roomId = els.roomInput.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!roomId) {
      toast('请先输入房间号', true);
      els.roomInput.focus();
      return;
    }
    els.joinBtn.disabled = true;
    const ok = attemptJoin(roomId);
    if (!ok) els.joinBtn.disabled = false;
    setTimeout(() => {
      els.joinBtn.disabled = false;
    }, 1200);
  }

  function resetToLobby() {
    clearSession();
    S.room = null;
    S.you = null;
    S.prevRoom = null;
    S.prevBoard = null;
    S.lastMoveKey = '';
    S.selected = null;
    S.hover = null;
    S.anim = null;
    history.replaceState(null, '', location.pathname);
    els.roomCode.textContent = '— — — —';
    els.players.innerHTML = '';
    els.statusTitle.textContent = '等待进入房间';
    els.statusSub.textContent = '创建房间，邀请同一内网的朋友';
    els.moveMeta.textContent = '尚未开局';
    els.roomMeta.textContent = '未进入房间';
    els.undoBanner.hidden = true;
    els.boardOverlay.hidden = true;
    els.spectatorNote.hidden = true;
    els.undoBtn.disabled = true;
    els.resignBtn.disabled = true;
    els.restartBtn.hidden = true;
    els.roomInput.value = '';
    showLobby();
    requestDraw();
  }

  function leaveRoom() {
    if (!S.room) {
      resetToLobby();
      return;
    }
    send({ type: 'leave' });
    resetToLobby();
  }

  /* ------------------------------------------------------------------ */
  /* 邀请二维码 / 附近房间                                               */
  /* ------------------------------------------------------------------ */

  function loadLanInfo() {
    if (S.lanInfoPromise) return S.lanInfoPromise;
    S.lanInfoPromise = fetch('/api/info', { cache: 'no-store' })
      .then((res) => res.json())
      .then((info) => {
        const lan = (info.urls || []).find((url) => !/localhost|127\.0\.0\.1/.test(url));
        if (lan) {
          S.lanUrl = lan;
          els.lobbyAddr.innerHTML = `同一 Wi-Fi 下访问 <b>${escapeHtml(lan)}</b> · 点击复制`;
          els.lobbyAddr.hidden = false;
          els.lobbyAddr.addEventListener('click', () => copyText(lan, '内网地址已复制'));
        }
        return S.lanUrl;
      })
      .catch(() => S.lanUrl);
    return S.lanInfoPromise;
  }

  function inviteUrl() {
    const localHost = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
    const base = localHost && S.lanUrl ? S.lanUrl : location.origin;
    return S.room ? `${base}/?room=${S.room.id}` : base;
  }

  async function copyText(text, okMessage) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMessage);
    } catch (err) {
      const input = document.createElement('input');
      input.value = text;
      document.body.appendChild(input);
      input.select();
      try {
        document.execCommand('copy');
        toast(okMessage);
      } catch (e) {
        toast(text);
      }
      input.remove();
    }
  }

  function renderQr() {
    if (!S.room) return;
    els.qrRoomCode.textContent = S.room.id;
    const url = inviteUrl();
    els.qrLink.textContent = url;

    if (typeof qrcode !== 'function') {
      els.qrFrame.innerHTML = '<p class="qr-fallback">二维码组件加载失败</p>';
      return;
    }

    try {
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      els.qrFrame.innerHTML = qr.createSvgTag({
        cellSize: 6,
        margin: 10,
        scalable: true,
        alt: `加入中国象棋房间 ${S.room.id}`,
        title: '房间邀请二维码',
      });
    } catch (err) {
      els.qrFrame.innerHTML = '<p class="qr-fallback">二维码生成失败</p>';
    }
  }

  function openQr() {
    if (!S.room) {
      toast('进入房间后即可生成邀请二维码', true);
      return;
    }
    els.qrModal.hidden = false;
    renderQr();
    loadLanInfo().then(() => {
      if (!els.qrModal.hidden) renderQr();
    });
  }

  function closeQr() {
    els.qrModal.hidden = true;
  }

  function openRooms() {
    els.roomsModal.hidden = false;
    scanRooms();
    if (S.roomsTimer) clearInterval(S.roomsTimer);
    S.roomsTimer = setInterval(scanRooms, 4000);
  }

  function closeRooms() {
    els.roomsModal.hidden = true;
    if (S.roomsTimer) {
      clearInterval(S.roomsTimer);
      S.roomsTimer = null;
    }
  }

  async function scanRooms() {
    els.roomsHint.textContent = '正在扫描同一服务下的空闲房间…';
    try {
      const res = await fetch('/api/rooms', { cache: 'no-store' });
      if (!res.ok) throw new Error('bad status');
      const data = await res.json();
      renderRoomList(Array.isArray(data.rooms) ? data.rooms : []);
    } catch (err) {
      els.roomsHint.textContent = '扫描失败，请检查服务是否在线';
      els.roomsList.innerHTML = '';
    }
  }

  function renderRoomList(rooms) {
    const list = rooms.filter(
      (room) => room && room.id && (!room.players || !room.players.red || !room.players.black)
    );

    if (!list.length) {
      els.roomsHint.textContent = '附近暂时没有空闲房间';
      els.roomsList.innerHTML = `
        <div class="room-empty">
          <strong>没有发现可加入的房间</strong>
          <span>让朋友先创建房间，或稍后点击「重新扫描」。</span>
        </div>`;
      return;
    }

    els.roomsHint.textContent = `发现 ${list.length} 个可加入的房间`;
    els.roomsList.innerHTML = list
      .map((room) => {
        const host = room.players.red || room.players.black || '匿名棋手';
        const status = room.status === 'waiting' ? '等待对手' : '上一局已结束 · 可开新局';
        return `
          <div class="room-item">
            <div class="room-item-main">
              <div class="room-item-code">${escapeHtml(room.id)}</div>
              <div class="room-item-sub">${escapeHtml(host)} · ${status}</div>
            </div>
            <button class="btn copper" type="button" data-join-room="${escapeHtml(room.id)}">加入</button>
          </div>`;
      })
      .join('');
  }

  /* ------------------------------------------------------------------ */
  /* 事件绑定                                                            */
  /* ------------------------------------------------------------------ */

  els.createBtn.addEventListener('click', createRoom);
  els.joinBtn.addEventListener('click', joinRoom);

  els.nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (els.roomInput.value.trim()) joinRoom();
      else createRoom();
    }
  });

  els.roomInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      joinRoom();
    }
  });

  els.roomInput.addEventListener('input', () => {
    els.roomInput.value = els.roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  els.copyBtn.addEventListener('click', () => copyText(inviteUrl(), '邀请链接已复制'));
  els.qrBtn.addEventListener('click', openQr);
  els.qrClose.addEventListener('click', closeQr);
  els.qrModal.addEventListener('click', (event) => {
    if (event.target === els.qrModal) closeQr();
  });
  els.qrCopy.addEventListener('click', () => copyText(inviteUrl(), '邀请链接已复制'));

  els.scanBtn.addEventListener('click', openRooms);
  els.roomsClose.addEventListener('click', closeRooms);
  els.roomsRefresh.addEventListener('click', scanRooms);
  els.roomsModal.addEventListener('click', (event) => {
    if (event.target === els.roomsModal) closeRooms();
  });
  els.roomsList.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-join-room]');
    if (!btn) return;
    const roomId = btn.getAttribute('data-join-room');
    closeRooms();
    attemptJoin(roomId);
  });

  els.undoBtn.addEventListener('click', () => send({ type: 'undo-request' }));
  els.resignBtn.addEventListener('click', () => {
    if (window.confirm('确定要认输吗？')) send({ type: 'resign' });
  });
  els.restartBtn.addEventListener('click', () => send({ type: 'restart' }));
  els.overlayRestart.addEventListener('click', () => send({ type: 'restart' }));
  els.leaveBtn.addEventListener('click', leaveRoom);

  els.undoActions.addEventListener('click', (event) => {
    const action = event.target && event.target.getAttribute('data-undo');
    if (!action) return;
    if (action === 'cancel') send({ type: 'undo-cancel' });
    else send({ type: 'undo-response', accept: action === 'accept' });
  });

  const openRules = () => {
    els.rulesModal.hidden = false;
  };
  const closeRules = () => {
    els.rulesModal.hidden = true;
  };
  els.rulesBtn.addEventListener('click', openRules);
  els.rulesBtnTop.addEventListener('click', openRules);
  els.rulesClose.addEventListener('click', closeRules);
  els.rulesModal.addEventListener('click', (event) => {
    if (event.target === els.rulesModal) closeRules();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!els.qrModal.hidden) closeQr();
      else if (!els.roomsModal.hidden) closeRooms();
      else if (!els.rulesModal.hidden) closeRules();
      else if (!els.lobby.hidden && S.room) els.lobby.hidden = true;
    } else if (
      (event.key === 'z' || event.key === 'Z') &&
      (event.metaKey || event.ctrlKey) &&
      !/^(INPUT|TEXTAREA)$/.test(event.target.tagName)
    ) {
      send({ type: 'undo-request' });
    }
  });

  /* ------------------------------------------------------------------ */
  /* 启动                                                                */
  /* ------------------------------------------------------------------ */

  function toast(message, isError) {
    if (!message) return;
    els.toast.textContent = message;
    els.toast.classList.toggle('is-error', !!isError);
    els.toast.classList.add('show');
    clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2600);
  }

  const observer = new ResizeObserver(resizeBoard);
  observer.observe(boardFrame);

  window.addEventListener('orientationchange', () => setTimeout(resizeBoard, 180));
  window.addEventListener('resize', () => requestAnimationFrame(resizeBoard));

  const session = getSession();
  if (session && session.name) {
    els.nameInput.value = session.name;
  } else {
    els.nameInput.value = localStorage.getItem(STORAGE_NAME) || '';
  }

  if (roomFromUrl) els.roomInput.value = roomFromUrl;

  els.roomMeta.textContent = '未进入房间';
  els.statusTitle.textContent = '等待进入房间';
  els.statusSub.textContent = '创建房间，邀请同一内网的朋友';

  loadLanInfo();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !S.connected) {
      if (S.reconnectTimer) {
        clearTimeout(S.reconnectTimer);
        S.reconnectTimer = null;
      }
      connect();
    }
  });

  els.lobby.hidden = false;
  resizeBoard();
  connect();
})();
