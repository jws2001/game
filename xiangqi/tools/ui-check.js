'use strict';

/**
 * 用无头 Chrome + CDP 走一遍象棋 UI 流程并截图
 * 前置: node server.js 运行在 3211
 * 运行: node tools/ui-check.js
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { TestClient } = require('./ws-client');
const { idx } = require('../lib/rules');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const GAME_PORT = Number(process.env.PORT) || 3211;
const CDP_PORT = 9335;
const OUT_DIR = '/tmp/xiangqi-shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, label, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
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
  const profile = '/tmp/xiangqi-chrome-profile';
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
        return (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok;
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
      document.getElementById('nameInput').value = '红方玩家';
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
    bot.send({ type: 'join', roomId, name: '黑方玩家' });
    await waitFor(() => bot.state && bot.state.room.status === 'playing', '对手加入');
    await waitFor(
      async () => (await evaluate(`document.getElementById('statusTitle').textContent`)) === '轮到你走棋',
      '轮到玩家'
    );
    console.log('✓ 对手加入，红方先行');

    const clickCell = (x, y) =>
      evaluate(`(() => {
        const c = document.getElementById('board');
        const r = c.getBoundingClientRect();
        const cell = Math.min(r.width / 10.2, r.height / 11.2);
        const ox = (r.width - cell * 8) / 2;
        const oy = (r.height - cell * 9) / 2;
        const flip = document.getElementById('boardFrame').dataset.view === 'black';
        const vx = flip ? 8 - ${x} : ${x};
        const vy = flip ? 9 - ${y} : ${y};
        c.dispatchEvent(new MouseEvent('click', {
          clientX: r.left + ox + vx * cell,
          clientY: r.top + oy + vy * cell,
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
        const cell = Math.min(r.width / 10.2, r.height / 11.2);
        const ox = (r.width - cell * 8) / 2;
        const oy = (r.height - cell * 9) / 2;
        const flip = document.getElementById('boardFrame').dataset.view === 'black';
        const vx = flip ? 8 - ${x} : ${x};
        const vy = flip ? 9 - ${y} : ${y};
        c.dispatchEvent(new PointerEvent('pointermove', {
          clientX: r.left + ox + vx * cell,
          clientY: r.top + oy + vy * cell,
          bubbles: true
        }));
        return true;
      })()`);

    const redMoves = [
      [1, 7, 4, 7],
      [1, 9, 2, 7],
      [0, 9, 0, 8],
    ];
    const blackMoves = [
      [1, 2, 4, 2],
      [1, 0, 2, 2],
      [0, 0, 0, 1],
    ];

    let count = 0;
    for (let i = 0; i < redMoves.length; i += 1) {
      const [fx, fy, tx, ty] = redMoves[i];
      await clickCell(fx, fy);
      await sleep(120);
      await clickCell(tx, ty);
      count += 1;
      await waitFor(() => bot.state.room.moveCount === count, `红方第 ${i + 1} 手`);
      await sleep(160);

      const [bfx, bfy, btx, bty] = blackMoves[i];
      bot.send({ type: 'move', from: idx(bfx, bfy), to: idx(btx, bty) });
      count += 1;
      await waitFor(() => bot.state.room.moveCount === count, `黑方第 ${i + 1} 手`);
      await sleep(160);
    }

    await waitFor(
      async () => (await evaluate(`document.getElementById('statusTitle').textContent`)) === '轮到你走棋',
      '再次轮到玩家'
    );

    // 选中红车，展示合法落点
    await clickCell(0, 8);
    await hoverCell(0, 7);
    await sleep(450);
    await shot('02-room-player.png');
    console.log('✓ 对局中截图（含合法走法提示）');

    bot.send({ type: 'undo-request' });
    await waitFor(
      async () => (await evaluate(`document.getElementById('undoBanner').hidden`)) === false,
      '悔棋请求展示'
    );
    await sleep(200);
    await shot('03-undo-request.png');
    console.log('✓ 悔棋请求弹层截图');

    await evaluate(`document.querySelector('[data-undo="accept"]').click()`);
    await waitFor(() => bot.state.room.moveCount === count - 1, '同意悔棋');
    console.log(`✓ 同意悔棋，回退到 ${count - 1} 手`);

    bot.send({ type: 'resign' });
    await waitFor(
      async () => (await evaluate(`document.getElementById('boardOverlay').hidden`)) === false,
      '胜负弹层'
    );
    await sleep(500);
    await shot('04-result.png');
    console.log('✓ 胜负弹层截图');

    await evaluate(`document.getElementById('overlayRestart').click()`);
    await waitFor(() => bot.state.room.restartVotes.red === true, '玩家准备');
    bot.send({ type: 'restart' });
    await waitFor(() => bot.state.room.status === 'playing' && bot.state.room.moveCount === 0, '重开');
    await waitFor(
      async () => (await evaluate(`document.getElementById('statusTitle').textContent`)) === '等待对方走棋',
      '互换红黑'
    );
    console.log('✓ 再来一局，红黑互换');

    bot.send({ type: 'move', from: idx(1, 7), to: idx(4, 7) });
    await waitFor(() => bot.state.room.moveCount === 1, '新局第一手');

    // 此时浏览器执黑，棋盘应翻转；用黑方视角走一步验证坐标映射
    await waitFor(
      async () => (await evaluate(`document.getElementById('statusTitle').textContent`)) === '轮到你走棋',
      '黑方视角轮到玩家'
    );
    await clickCell(0, 3);
    await sleep(120);
    await clickCell(0, 4);
    await waitFor(() => bot.state.room.moveCount === 2, '黑方视角走子');
    await sleep(300);

    await evaluate(`document.getElementById('qrBtn').click()`);
    await waitFor(async () => await evaluate(`!!document.querySelector('#qrFrame svg')`), '二维码生成');
    await sleep(400);
    const qrLink = await evaluate(`document.getElementById('qrLink').textContent`);
    if (!qrLink.includes(`:${GAME_PORT}`) || !qrLink.includes(roomId)) {
      throw new Error(`二维码链接异常: ${qrLink}`);
    }
    await shot('05-qr.png');
    await evaluate(`document.getElementById('qrClose').click()`);
    console.log(`✓ 二维码截图：${qrLink}`);

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await sleep(900);
    await shot('06-mobile.png');
    console.log('✓ 移动端布局截图');

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await sleep(300);

    console.log('\n象棋 UI 检查全部通过 ✅\n');
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
  .then(() => setTimeout(() => process.exit(0), 150))
  .catch((err) => {
    console.error('\n象棋 UI 检查失败:', err);
    process.exit(1);
  });
