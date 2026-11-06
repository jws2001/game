'use strict';

/**
 * 用无头 Chrome + CDP 走一遍真实 UI 流程并截图：
 * 大厅 → 创建房间 → 双人对弈 → 悔棋弹层 → 胜负弹层 → 移动端布局
 *
 * 前置: 服务已运行在 3210 端口
 * 运行: node tools/ui-check.js
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { TestClient } = require('./ws-client');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const GAME_PORT = Number(process.env.PORT) || 3210;
const CDP_PORT = 9333;
const OUT_DIR = '/tmp/gomoku-shots';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await predicate()) return;
    await sleep(40);
  }
  throw new Error(`超时: ${label}`);
}

function createCdp(ws) {
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (msg) => {
    if (!msg || !msg.id || !pending.has(msg.id)) return;
    const task = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) task.reject(new Error(`${task.method}: ${msg.error.message}`));
    else task.resolve(msg.result);
  };
  return {
    send(method, params = {}) {
      const id = (seq += 1);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        ws.send({ id, method, params });
        setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }, 12000);
      });
    },
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const profile = '/tmp/gomoku-chrome-profile';
  fs.rmSync(profile, { recursive: true, force: true });

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-allow-origins=*',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      '--window-size=1440,1000',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] }
  );

  let bot = null;
  let cdpWs = null;

  try {
    await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
        return res.ok;
      } catch (err) {
        return false;
      }
    }, 'Chrome 调试端口就绪');

    const target = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, {
      method: 'PUT',
    }).then((res) => res.json());

    cdpWs = await TestClient.connect(target.webSocketDebuggerUrl);
    const cdp = createCdp(cdpWs);

    const evaluate = async (expression) => {
      const result = await cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        throw new Error(
          `页面 JS 异常: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`
        );
      }
      return result.result.value;
    };

    const shot = async (name) => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(OUT_DIR, name);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      console.log(`  📸 ${file}`);
    };

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 2,
      mobile: false,
    });

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${GAME_PORT}/` });
    await sleep(1600);
    await shot('01-lobby.png');
    console.log('✓ 大厅截图');

    await evaluate(`(() => {
      document.getElementById('nameInput').value = '小明';
      document.getElementById('createBtn').click();
      return true;
    })()`);

    await waitFor(async () => {
      const code = await evaluate(`document.getElementById('roomCode').textContent.trim()`);
      return /^[A-Z0-9]{3,8}$/.test(code);
    }, '房间创建');

    const roomId = await evaluate(`document.getElementById('roomCode').textContent.trim()`);
    console.log(`✓ 房间创建 ${roomId}`);

    bot = await TestClient.connect(GAME_PORT);
    bot.send({ type: 'join', roomId, name: '阿青' });
    await waitFor(() => bot.state && bot.state.room.status === 'playing', '机器人加入');
    await waitFor(
      async () => (await evaluate(`document.getElementById('statusTitle').textContent`)) === '轮到你落子',
      '轮到玩家落子'
    );
    console.log('✓ 对手加入，轮到玩家');

    const clickCell = (x, y) =>
      evaluate(`(() => {
        const c = document.getElementById('board');
        const r = c.getBoundingClientRect();
        const pad = r.width * 0.068;
        const cell = (r.width - pad * 2) / 14;
        c.dispatchEvent(new MouseEvent('click', {
          clientX: r.left + pad + ${x} * cell,
          clientY: r.top + pad + ${y} * cell,
          bubbles: true,
          cancelable: true,
          view: window
        }));
        return true;
      })()`);

    const hoverCell = (x, y) =>
      evaluate(`(() => {
        const c = document.getElementById('board');
        const r = c.getBoundingClientRect();
        const pad = r.width * 0.068;
        const cell = (r.width - pad * 2) / 14;
        c.dispatchEvent(new PointerEvent('pointermove', {
          clientX: r.left + pad + ${x} * cell,
          clientY: r.top + pad + ${y} * cell,
          bubbles: true
        }));
        return true;
      })()`);

    const blackMoves = [
      [7, 7],
      [6, 7],
      [5, 7],
      [4, 7],
      [7, 9],
      [9, 7],
      [6, 6],
    ];
    const whiteMoves = [
      [8, 8],
      [5, 6],
      [8, 7],
      [3, 7],
      [6, 8],
      [9, 8],
      [10, 7],
    ];

    let moveCount = 0;
    for (let i = 0; i < blackMoves.length; i += 1) {
      await clickCell(blackMoves[i][0], blackMoves[i][1]);
      moveCount += 1;
      await waitFor(() => bot.state.room.moveCount === moveCount, `玩家第 ${i + 1} 手`);
      await sleep(160);

      if (i < whiteMoves.length) {
        bot.send({ type: 'move', x: whiteMoves[i][0], y: whiteMoves[i][1] });
        moveCount += 1;
        await waitFor(() => bot.state.room.moveCount === moveCount, `对手第 ${i + 1} 手`);
        await sleep(160);
      }
    }

    await waitFor(
      async () => (await evaluate(`document.getElementById('statusTitle').textContent`)) === '轮到你落子',
      '再次轮到玩家'
    );
    await hoverCell(8, 6);
    await sleep(350);
    await shot('02-room-player.png');
    console.log('✓ 对弈中截图（玩家视角，含落子预览）');

    bot.send({ type: 'undo-request' });
    await waitFor(
      async () => (await evaluate(`document.getElementById('undoBanner').hidden`)) === false,
      '悔棋请求展示'
    );
    await sleep(200);
    await shot('03-undo-request.png');
    console.log('✓ 悔棋请求弹层截图');

    await evaluate(`document.querySelector('[data-undo="accept"]').click()`);
    await waitFor(() => bot.state.room.moveCount === moveCount - 1, '同意悔棋');
    console.log(`✓ 同意悔棋，回退到 ${moveCount - 1} 手`);

    bot.send({ type: 'resign' });
    await waitFor(
      async () => (await evaluate(`document.getElementById('boardOverlay').hidden`)) === false,
      '胜负弹层'
    );
    await sleep(500);
    await shot('04-result.png');
    console.log('✓ 胜负弹层截图');

    await evaluate(`document.getElementById('overlayRestart').click()`);
    await waitFor(() => bot.state.room.restartVotes.black === true, '玩家准备');
    bot.send({ type: 'restart' });
    await waitFor(() => bot.state.room.status === 'playing' && bot.state.room.moveCount === 0, '重开');
    await waitFor(
      async () =>
        (await evaluate(`document.getElementById('statusTitle').textContent`)) === '等待对方落子',
      '互换黑白后等待对手'
    );
    console.log('✓ 再来一局，黑白互换');

    bot.send({ type: 'move', x: 7, y: 7 });
    await waitFor(() => bot.state.room.moveCount === 1, '新局第一手');
    await sleep(300);

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await sleep(900);
    await shot('05-mobile.png');
    console.log('✓ 移动端布局截图');

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await sleep(300);

    console.log('\nUI 检查全部通过 ✅\n');
  } finally {
    if (bot) {
      try {
        bot.close();
      } catch (err) {
        /* noop */
      }
    }
    if (cdpWs) {
      try {
        cdpWs.close();
      } catch (err) {
        /* noop */
      }
    }
    try {
      chrome.kill('SIGKILL');
    } catch (err) {
      /* noop */
    }
  }
}

main()
  .then(() => {
    setTimeout(() => process.exit(0), 150);
  })
  .catch((err) => {
    console.error('\nUI 检查失败:', err);
    process.exit(1);
  });
