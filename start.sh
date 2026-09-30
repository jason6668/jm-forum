#!/usr/bin/env bash
# JM Forum 一键启动脚本 (Linux / macOS)
set -e
cd "$(dirname "$0")"

echo "============================================"
echo "  JM Forum - NodeSeek style community"
echo "============================================"

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js not found. Please install:"
  echo "  Ubuntu/Debian: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs"
  echo "  macOS: brew install node"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "[INFO] Installing dependencies..."
  npm install
fi

echo "[INFO] Starting server at http://localhost:3000"
echo "[INFO] Press Ctrl+C to stop"
echo
exec node server.js
