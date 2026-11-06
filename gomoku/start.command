#!/bin/bash
# 双击即可启动（macOS）。Windows 可用 `npm start`。
cd "$(dirname "$0")" || exit 1
echo ""
echo "  ♟  五子棋 · 内网双人对战"
echo ""
node server.js
echo ""
read -r -p "服务已停止，按回车关闭窗口..." _
