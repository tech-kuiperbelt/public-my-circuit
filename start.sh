#!/usr/bin/env bash
# 本地调试入口：启动静态服务器并打开浏览器。
# 用法：./start.sh [端口]       默认 8000
#       NO_OPEN=1 ./start.sh   只起服务，不打开浏览器
set -euo pipefail

cd "$(dirname "$0")"

PORT="${1:-8000}"
HOST="127.0.0.1"
URL="http://${HOST}:${PORT}/"

if [ ! -f index.html ]; then
  echo "start.sh: 未找到 index.html，请在项目根目录运行。" >&2
  exit 1
fi

if [ ! -f serve.py ]; then
  echo "start.sh: 未找到 serve.py（开发服务器）。" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "start.sh: 需要 python3 来提供静态文件服务。" >&2
  exit 1
fi

echo "my-circuit: $(pwd)"
echo "serving at ${URL}"
echo "按 Ctrl+C 停止。"
echo

if [ "${NO_OPEN:-0}" != "1" ]; then
  (
    sleep 0.6
    if command -v xdg-open >/dev/null 2>&1; then
      xdg-open "$URL" >/dev/null 2>&1 || true
    elif command -v open >/dev/null 2>&1; then
      open "$URL" >/dev/null 2>&1 || true
    fi
  ) &
fi

exec python3 serve.py "$PORT"
