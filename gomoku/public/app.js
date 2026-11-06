'use strict';

(() => {
  const SIZE = 15;
  const EMPTY = 0;
  const BLACK = 1;
  const WHITE = 2;
  const STARS = [7, 7, 3, 3, 11, 3, 3, 11, 11, 11];
  const STORAGE_NAME = 'gomoku.name';
  const STORAGE_SOUND = 'gomoku.sound';
  const SESSION_KEY = 'gomoku.session';

  const $ = (id) => document.getElementById(id);

  /* ------------------------------------------------------------------ */
  /* 状态                                                                */
  /* ------------------------------------------------------------------ */

  const S = {
    lanUrl: location.origin,
    ws: null,
    connected: false,
    reconnectTimer: null,
    reconnectAttempt: 0,
    room: null,
    you: null,
    session: readSession(),
    prevRoom: null,
    prevBoard: null,
    hover: null,
    anim: null,
    rafId: 0,
    soundOn: localStorage.getItem(STORAGE_SOUND) !== 'off',
    autoJoin: null,
    leaving: false,
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
    nameInput: $('nameInput'),
    roomInput: $('roomInput'),
    createBtn: $('createBtn'),
    joinBtn: $('joinBtn'),
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
    scanBtn: $('scanBtn'),
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
    lobbyAddr: $('lobbyAddr'),
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
    turnChip: $('turnChip'),
    soundBtn: $('soundBtn'),
    toast: $('toast'),
  };

  /* ------------------------------------------------------------------ */
  /* 棋盘绘制                                                            */
  /* ------------------------------------------------------------------ */

  const G = { w: 0, pad: 0, cell: 0, dpr: 1 };
  let grain = [];
  let toastTimer = 0;

  function buildGrain() {
    let seed = 11;
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
    const w = Math.floor(Math.min(rect.width, rect.height) || rect.width || 0);
    if (!w) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(w * dpr);
    G.w = w;
    G.dpr = dpr;
    G.pad = w * 0.068;
    G.cell = (w - G.pad * 2) / (SIZE - 1);
    requestDraw();
  }

  const toX = (x) => G.pad + x * G.cell;
  const toY = (y) => G.pad + y * G.cell;

  function drawBoard() {
    const w = G.w;
    const grad = ctx.createLinearGradient(0, 0, w * 0.9, w);
    grad.addColorStop(0, '#e7c38d');
    grad.addColorStop(0.42, '#dcb277');
    grad.addColorStop(0.72, '#d3a568');
    grad.addColorStop(1, '#c69257');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, w);

    // 木纹
    ctx.save();
    for (const f of grain) {
      ctx.beginPath();
      for (let x = 0; x <= w; x += 6) {
        const y = f.y * w + Math.sin((x / w) * Math.PI * f.freq + f.phase) * f.amp;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = `rgba(104, 61, 20, ${f.alpha})`;
      ctx.lineWidth = f.width;
      ctx.stroke();
    }
    ctx.restore();

    // 暗角
    const vignette = ctx.createRadialGradient(w * 0.45, w * 0.4, w * 0.12, w * 0.5, w * 0.5, w * 0.78);
    vignette.addColorStop(0, 'rgba(90, 50, 12, 0)');
    vignette.addColorStop(1, 'rgba(88, 48, 12, 0.24)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, w);

    // 网格
    ctx.save();
    ctx.strokeStyle = 'rgba(70, 41, 13, 0.6)';
    ctx.lineWidth = Math.max(1, w / 620);

    for (let i = 0; i < SIZE; i += 1) {
      const p = G.pad + i * G.cell;
      ctx.beginPath();
      ctx.moveTo(G.pad, p);
      ctx.lineTo(w - G.pad, p);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p, G.pad);
      ctx.lineTo(p, w - G.pad);
      ctx.stroke();
    }

    // 外框
    ctx.strokeStyle = 'rgba(58, 33, 9, 0.8)';
    ctx.lineWidth = Math.max(1.6, w / 360);
    ctx.strokeRect(G.pad, G.pad, w - G.pad * 2, w - G.pad * 2);
    ctx.restore();

    // 星位
    ctx.fillStyle = 'rgba(52, 29, 8, 0.85)';
    for (let i = 0; i < STARS.length; i += 2) {
      const x = toX(STARS[i]);
      const y = toY(STARS[i + 1]);
      const r = Math.max(2, G.cell * 0.085);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // 坐标
    const fontSize = Math.max(8, G.cell * 0.27);
    ctx.save();
    ctx.fillStyle = 'rgba(74, 43, 14, 0.52)';
    ctx.font = `500 ${fontSize}px -apple-system, "PingFang SC", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < SIZE; i += 1) {
      const x = G.pad + i * G.cell;
      ctx.fillText(String.fromCharCode(65 + i), x, G.pad * 0.46);
      ctx.fillText(String.fromCharCode(65 + i), x, G.w - G.pad * 0.42);
      const y = G.pad + i * G.cell;
      ctx.textAlign = 'right';
      ctx.fillText(String(i + 1), G.pad * 0.56, y + 0.5);
      ctx.textAlign = 'left';
      ctx.fillText(String(i + 1), G.w - G.pad * 0.56, y + 0.5);
      ctx.textAlign = 'center';
    }
    ctx.restore();
  }

  function drawStone(cx, cy, color, radius, options = {}) {
    const { alpha = 1, scale = 1 } = options;
    const r = radius * scale;
    if (r <= 0.2) return;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.shadowColor = 'rgba(34, 17, 2, 0.5)';
    ctx.shadowBlur = r * 0.55;
    ctx.shadowOffsetY = r * 0.2;

    const g = ctx.createRadialGradient(cx - r * 0.36, cy - r * 0.4, r * 0.1, cx, cy, r * 1.16);
    if (color === BLACK) {
      g.addColorStop(0, '#8b929c');
      g.addColorStop(0.24, '#454a52');
      g.addColorStop(0.62, '#1a1d22');
      g.addColorStop(1, '#040506');
    } else {
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.5, '#f6f3ec');
      g.addColorStop(0.85, '#e0dacd');
      g.addColorStop(1, '#bdb5a5');
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowColor = 'transparent';
    if (color === WHITE) {
      ctx.strokeStyle = 'rgba(90, 78, 56, 0.28)';
      ctx.lineWidth = Math.max(0.6, r * 0.05);
      ctx.stroke();
    } else {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.09)';
      ctx.lineWidth = Math.max(0.5, r * 0.045);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawWinHighlight(room) {
    if (!room.winLine || room.winLine.length < 2) return;
    const first = room.winLine[0];
    const last = room.winLine[room.winLine.length - 1];
    const x1 = toX(first % SIZE);
    const y1 = toY(Math.floor(first / SIZE));
    const x2 = toX(last % SIZE);
    const y2 = toY(Math.floor(last / SIZE));

    ctx.save();
    ctx.strokeStyle = 'rgba(255, 199, 110, 0.9)';
    ctx.lineWidth = Math.max(2, G.cell * 0.085);
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(255, 186, 72, 0.95)';
    ctx.shadowBlur = G.cell * 0.6;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  }

  function draw() {
    const w = G.w;
    if (!w) return;
    ctx.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
    ctx.clearRect(0, 0, w, w);

    drawBoard();

    const room = S.room;
    if (!room) {
      drawCenterHint();
      return;
    }

    drawWinHighlight(room);

    const radius = G.cell * 0.44;
    const now = performance.now();
    let animating = false;

    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        const color = room.board[y * SIZE + x];
        if (!color) continue;
        let scale = 1;
        if (S.anim && S.anim.index === y * SIZE + x) {
          const t = Math.min(1, (now - S.anim.start) / 220);
          scale = 0.55 + 0.45 * (1 - Math.pow(1 - t, 3));
          if (t < 1) animating = true;
        }
        drawStone(toX(x), toY(y), color, radius, { scale });
      }
    }

    drawWinRings(room);

    if (room.lastMove) {
      const lx = toX(room.lastMove.x);
      const ly = toY(room.lastMove.y);
      const dotColor = room.lastMove.color === BLACK ? '#f0c884' : '#b33b2e';
      ctx.save();
      ctx.beginPath();
      ctx.arc(lx, ly, Math.max(2.4, G.cell * 0.105), 0, Math.PI * 2);
      ctx.fillStyle = dotColor;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.lineWidth = Math.max(1, G.cell * 0.035);
      ctx.stroke();
      ctx.restore();
    }

    drawHover(room);

    if (animating) requestDraw();
    else S.anim = null;
  }

  function drawCenterHint() {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(74, 43, 14, 0.5)';
    ctx.font = `500 ${Math.max(11, G.w * 0.026)}px -apple-system, "PingFang SC", sans-serif`;
    ctx.fillText('创建或加入房间后开始对局', G.w / 2, G.w / 2 + G.cell);
    ctx.restore();
  }

  function drawWinRings(room) {
    if (!room.winLine || room.winLine.length < 5) return;

    ctx.save();
    for (const idx of room.winLine) {
      const x = idx % SIZE;
      const y = Math.floor(idx / SIZE);
      const cx = toX(x);
      const cy = toY(y);
      const r = G.cell * 0.58;
      const halo = ctx.createRadialGradient(cx, cy, G.cell * 0.4, cx, cy, r);
      halo.addColorStop(0, 'rgba(255, 205, 115, 0)');
      halo.addColorStop(0.62, 'rgba(255, 202, 112, 0.34)');
      halo.addColorStop(1, 'rgba(255, 190, 90, 0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.strokeStyle = 'rgba(255, 214, 140, 0.95)';
    ctx.lineWidth = Math.max(1.8, G.cell * 0.052);
    ctx.shadowColor = 'rgba(255, 184, 74, 0.95)';
    ctx.shadowBlur = G.cell * 0.55;
    for (const idx of room.winLine) {
      const x = idx % SIZE;
      const y = Math.floor(idx / SIZE);
      ctx.beginPath();
      ctx.arc(toX(x), toY(y), G.cell * 0.56, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawHover(room) {
    if (!S.hover) return;
    if (!canPlay()) return;
    const { x, y } = S.hover;
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
    if (room.board[y * SIZE + x] !== EMPTY) return;

    drawStone(toX(x), toY(y), S.you.color, G.cell * 0.44, { alpha: 0.38 });

    ctx.save();
    ctx.strokeStyle = 'rgba(255, 214, 148, 0.5)';
    ctx.lineWidth = Math.max(1, G.cell * 0.04);
    const p = G.cell * 0.16;
    ctx.beginPath();
    ctx.moveTo(toX(x) - p, toY(y));
    ctx.lineTo(toX(x) + p, toY(y));
    ctx.moveTo(toX(x), toY(y) - p);
    ctx.lineTo(toX(x), toY(y) + p);
    ctx.stroke();
    ctx.restore();
  }

  function requestDraw() {
    if (S.rafId) return;
    S.rafId = requestAnimationFrame(() => {
      S.rafId = 0;
      draw();
    });
  }

  function canPlay() {
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
    const gx = Math.round((px - G.pad) / G.cell);
    const gy = Math.round((py - G.pad) / G.cell);
    if (gx < 0 || gy < 0 || gx >= SIZE || gy >= SIZE) return null;
    const cx = toX(gx);
    const cy = toY(gy);
    if (Math.hypot(px - cx, py - cy) > G.cell * 0.5) return null;
    return { x: gx, y: gy };
  }

  canvas.addEventListener('pointermove', (event) => {
    const cell = eventToCell(event);
    const hover = cell && S.room && S.room.board[cell.y * SIZE + cell.x] === EMPTY ? cell : null;
    if (JSON.stringify(hover) === JSON.stringify(S.hover)) return;
    S.hover = hover;
    requestDraw();
  });

  canvas.addEventListener('pointerleave', () => {
    if (!S.hover) return;
    S.hover = null;
    requestDraw();
  });

  canvas.addEventListener('click', (event) => {
    if (!S.room) {
      showLobby();
      return;
    }
    if (!canPlay()) return;
    const cell = eventToCell(event);
    if (!cell) return;
    if (S.room.board[cell.y * SIZE + cell.x] !== EMPTY) return;
    send({ type: 'move', x: cell.x, y: cell.y });
    S.hover = null;
    requestDraw();
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

  function playPlace() {
    tone(660, 0.05, 'triangle', 0.05);
    setTimeout(() => tone(260, 0.09, 'sine', 0.035), 25);
  }

  function playWin() {
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
    if (S.soundOn) playPlace();
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
      if (!data || !data.roomId) return null;
      return data;
    } catch (err) {
      return null;
    }
  }

  function saveSession(session) {
    S.session = session;
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch (err) {
      /* 忽略 */
    }
  }

  function clearSession() {
    S.session = null;
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch (err) {
      /* 忽略 */
    }
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
      /* close 事件里统一处理 */
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
    if (S.session && S.session.roomId) {
      if (!roomFromUrl || roomFromUrl === S.session.roomId) {
        autoJoin(S.session.roomId, S.session.token, S.session.name);
        return;
      }
      // 打开了另一间房的邀请链接，放弃旧会话
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
          const wasAuto = !!S.session || !!nameFromUrl;
          clearSession();
          if (wasAuto) {
            showLobby();
            if (roomFromUrl) els.roomInput.value = roomFromUrl;
            if (els.lobbyHint) {
              els.lobbyHint.textContent = `房间 ${roomFromUrl || ''} 不存在，请检查房间号或重新创建。`;
              els.lobbyHint.classList.add('is-error');
            }
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

    if (!S.prevBoard || S.prevBoard.length !== msg.room.board.length) {
      S.prevBoard = msg.room.board.slice();
    } else {
      const added = [];
      for (let i = 0; i < msg.room.board.length; i += 1) {
        if (msg.room.board[i] && !S.prevBoard[i]) added.push(i);
      }
      if (added.length === 1) {
        S.anim = { index: added[0], start: performance.now() };
        playPlace();
      }
      S.prevBoard = msg.room.board.slice();
    }

    if (
      (!prev || prev.status !== 'over') &&
      msg.room.status === 'over' &&
      msg.room.reason === 'five'
    ) {
      setTimeout(playWin, 120);
      if (navigator.vibrate) {
        try {
          navigator.vibrate([30, 60, 30]);
        } catch (err) {
          /* noop */
        }
      }
    }

    if (!prev || prev.id !== msg.room.id) {
      S.hover = null;
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

  function render() {
    const room = S.room;
    if (!room) return;

    els.roomCode.textContent = room.id;
    els.moveMeta.textContent = room.status === 'waiting' ? '等待开局' : `第 ${room.moveCount} 手`;
    els.roomMeta.textContent = `房间 ${room.id} · 15 路`;

    renderPlayers(room);
    renderStatus(room);
    renderActions(room);
    renderOverlay(room);
    renderTurnChip(room);

    if (S.you && S.you.spectator) {
      els.spectatorNote.hidden = false;
      els.spectatorNote.textContent = `你正在观战 · 当前 ${room.spectatorCount} 位观众 · 棋盘实时同步`;
    } else {
      els.spectatorNote.hidden = true;
    }
  }

  function playerSub(connected) {
    return connected
      ? '<span class="online-dot"></span>在线'
      : '<span class="online-dot off"></span>离线';
  }

  function renderPlayers(room) {
    const seats = [
      { color: BLACK, label: '黑方', cls: 'black', key: 'black' },
      { color: WHITE, label: '白方', cls: 'white', key: 'white' },
    ];

    els.players.innerHTML = seats
      .map(({ color, label, cls, key }) => {
        const player = room.players[key];
        const isMe = S.you && S.you.color === color;
        const active = room.status === 'playing' && room.turn === color;

        if (!player) {
          return `
            <div class="player-card is-empty">
              <span class="stone-badge is-ghost"></span>
              <div class="player-info">
                <div class="player-name">等待加入</div>
                <div class="player-sub">分享房间号 ${escapeHtml(room.id)} 给朋友</div>
              </div>
            </div>`;
        }

        return `
          <div class="player-card ${active ? 'is-active' : ''}">
            <span class="stone-badge ${cls}"></span>
            <div class="player-info">
              <div class="player-name">
                ${escapeHtml(player.name)}
                ${isMe ? '<span class="tag">你</span>' : ''}
              </div>
              <div class="player-sub">${label} · ${playerSub(player.connected)}</div>
            </div>
            ${active ? '<span class="turn-indicator" title="落子中"></span>' : ''}
          </div>`;
      })
      .join('');
  }

  function renderStatus(room) {
    const box = els.statusBox;
    box.classList.remove('is-live', 'is-mine');
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
        title = '轮到你落子';
        sub = `${S.you.color === BLACK ? '黑方' : '白方'} · 第 ${room.moveCount + 1} 手`;
        box.classList.add('is-mine', 'is-live');
      } else {
        title = '等待对方落子';
        sub = '对手正在思考中…';
        box.classList.add('is-live');
      }
    } else {
      const winnerName = room.winner === BLACK ? '黑棋' : room.winner === WHITE ? '白棋' : '';
      if (room.winner === EMPTY) {
        title = '和棋';
        sub = '棋盘已满，势均力敌';
      } else if (S.you && S.you.color === room.winner) {
        title = '你赢了';
        sub = '五子连珠，漂亮';
      } else if (S.you && S.you.color) {
        title = '你输了';
        sub = `${winnerName}五子连珠`;
      } else {
        title = `${winnerName}获胜`;
        sub = '本局结束';
      }

      if (room.reason === 'resign') sub = '对手认输';
      if (room.reason === 'leave') sub = '对手离开房间';
      if (room.reason === 'draw') sub = '棋盘已满，平局';
    }

    els.statusTitle.textContent = title;
    els.statusSub.textContent = sub;
  }

  function renderActions(room) {
    const seated = !!(S.you && S.you.color && !S.you.spectator);
    const playing = room.status === 'playing';

    els.undoBtn.disabled = !(seated && playing && room.moveCount > 0 && !room.undoRequest);
    els.resignBtn.disabled = !(seated && playing);

    const bothSeated = !!(room.players.black && room.players.white);
    const showRestart = room.status === 'over' && seated && bothSeated;
    els.restartBtn.hidden = !showRestart;
    els.overlayRestart.hidden = !showRestart;

    if (showRestart) {
      const myVote =
        S.you.color === BLACK ? room.restartVotes.black : room.restartVotes.white;
      const otherVote =
        S.you.color === BLACK ? room.restartVotes.white : room.restartVotes.black;
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
      els.undoText.textContent = `${req.by === BLACK ? '黑方' : '白方'}请求悔棋，等待对方确认`;
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
    if (room.winner === EMPTY) title = '和棋';
    else if (S.you && S.you.color === room.winner) title = '你赢了';
    else if (S.you && S.you.color) title = '你输了';
    else title = `${room.winner === BLACK ? '黑棋' : '白棋'}获胜`;

    const winnerColor = room.winner === BLACK ? 'black' : room.winner === WHITE ? 'white' : null;
    els.resultTitle.textContent = title;
    els.resultStones.innerHTML = winnerColor
      ? `<span class="stone ${winnerColor}"></span>`
      : '<span class="stone black"></span><span class="stone white"></span>';

    let sub = '五子连珠';
    if (room.reason === 'draw') sub = '棋盘已满，平局';
    else if (room.reason === 'resign') sub = '对手认输';
    else if (room.reason === 'leave') sub = '对手离开房间';
    else if (room.winner !== EMPTY) {
      sub = `${room.winner === BLACK ? '黑棋' : '白棋'} · ${room.moveCount} 手`;
    }
    els.resultSub.textContent = sub;
  }

  function renderTurnChip(room) {
    const show = room.status === 'playing' && !(S.you && S.you.spectator);
    if (!show) {
      els.turnChip.hidden = true;
      return;
    }
    const mine = S.you && S.you.color === room.turn;
    els.turnChip.hidden = false;
    els.turnChip.textContent = mine ? '轮到你落子' : '等待对方落子';
  }

  /* ------------------------------------------------------------------ */
  /* 大厅                                                                */
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
    const token =
      S.session && S.session.roomId === roomId && S.session.token ? S.session.token : undefined;
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
    els.turnChip.hidden = true;
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
    S.leaving = true;
    send({ type: 'leave' });
    resetToLobby();
    S.leaving = false;
  }

  /* ------------------------------------------------------------------ */
  /* 交互绑定                                                            */
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

  let lanInfoPromise = null;

  function loadLanInfo() {
    if (lanInfoPromise) return lanInfoPromise;
    lanInfoPromise = fetch('/api/info', { cache: 'no-store' })
      .then((res) => res.json())
      .then((info) => {
        const lan = (info.urls || []).find((url) => !/localhost|127\.0\.0\.1/.test(url));
        if (lan) {
          S.lanUrl = lan;
          els.lobbyAddr.innerHTML = `同一 Wi-Fi 下访问 <b>${escapeHtml(lan)}</b> · 点击复制`;
          els.lobbyAddr.hidden = false;
          els.lobbyAddr.addEventListener('click', () => {
            copyText(lan, '内网地址已复制');
          });
        }
        return S.lanUrl;
      })
      .catch(() => S.lanUrl);
    return lanInfoPromise;
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
        alt: `加入五子棋房间 ${S.room.id}`,
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

  let roomsTimer = null;

  function openRooms() {
    els.roomsModal.hidden = false;
    scanRooms();
    if (roomsTimer) clearInterval(roomsTimer);
    roomsTimer = setInterval(scanRooms, 4000);
  }

  function closeRooms() {
    els.roomsModal.hidden = true;
    if (roomsTimer) {
      clearInterval(roomsTimer);
      roomsTimer = null;
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
      (room) => room && room.id && (!room.players || !room.players.black || !room.players.white)
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
        const host = (room.players.black || room.players.white || '匿名棋手');
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
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2600);
  }

  const observer = new ResizeObserver(resizeBoard);
  observer.observe(boardFrame);

  window.addEventListener('orientationchange', () => setTimeout(resizeBoard, 180));
  window.addEventListener('resize', () => requestAnimationFrame(resizeBoard));

  if (S.session && S.session.name) {
    els.nameInput.value = S.session.name;
  } else {
    els.nameInput.value = localStorage.getItem(STORAGE_NAME) || '';
  }

  if (roomFromUrl) {
    els.roomInput.value = roomFromUrl;
  }

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
