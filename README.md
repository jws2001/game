# 游戏合集 · 内网双人对战

同一个仓库里的两个零依赖网页棋类游戏，均支持同一局域网内两台设备开房对战。

| 游戏 | 目录 | 默认端口 | 说明 |
| --- | --- | --- | --- |
| 五子棋 | [`gomoku/`](gomoku/README.md) | 3210 | 15 × 15，五连获胜，悔棋 / 观战 / 扫码邀请 |
| 中国象棋 | [`xiangqi/`](xiangqi/README.md) | 3211 | 9 × 10，完整走法与将死 / 困毙，悔棋 / 观战 / 扫码邀请 |

两个游戏互不依赖，各自带 `package.json`，可以独立启动、独立部署。项目当前没有 npm 运行时依赖；二维码库以 vendored 静态文件引入。

## 启动

```bash
# 终端 1：五子棋
cd gomoku && npm start

# 终端 2：象棋
cd xiangqi && npm start
```

启动后终端会打印本机地址和内网地址，例如：

- 五子棋：`http://10.100.1.123:3210`
- 象棋：`http://10.100.1.123:3211`

同一 Wi-Fi 下的手机 / 平板 / 电脑打开对应地址即可创建或加入房间。

## 目录

```
game/
├── gomoku/
│   ├── server.js
│   ├── lib/
│   ├── public/
│   ├── tools/
│   └── README.md
└── xiangqi/
    ├── server.js
    ├── lib/
    ├── public/
    ├── tools/
    └── README.md
```

## 测试

```bash
cd gomoku && npm test
cd xiangqi && npm test
```

各自包含规则单元测试和真实 WebSocket 双端联机测试。象棋另提供 `npm run test:ui` 用无头 Chrome 跑完整界面流程。

## 后续扩展

两个游戏当前都保持零依赖、各自独立。若后续要共享服务端代码或引入 npm 依赖，可以在仓库根目录升级为 npm workspaces，一次安装、统一锁文件；具体方案见项目讨论记录。
