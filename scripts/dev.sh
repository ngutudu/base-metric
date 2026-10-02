#!/usr/bin/env bash
# Starts a clean local test environment: Hardhat node → deploy → UI dev server.
# Ctrl+C stops everything (UI in foreground, node killed via the trap below).
#
# Usage: ./scripts/dev.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UI_DIR="$ROOT_DIR/ui"
NODE_LOG="/tmp/basemetric-hardhat-node.log"
RPC_URL="http://127.0.0.1:8545"

cleanup() {
  if [[ -n "${NODE_PID:-}" ]] && kill -0 "$NODE_PID" 2>/dev/null; then
    echo "Stopping Hardhat node (pid $NODE_PID)…"
    kill "$NODE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "==> Stopping any previous Hardhat node for this project…"
pkill -f "$ROOT_DIR/node_modules/.bin/hardhat node" 2>/dev/null || true
sleep 1

echo "==> Starting Hardhat node (log: $NODE_LOG)…"
cd "$ROOT_DIR"
nohup npx hardhat node > "$NODE_LOG" 2>&1 &
NODE_PID=$!

echo "==> Waiting for RPC at $RPC_URL…"
for i in $(seq 1 30); do
  if curl -s -o /dev/null -X POST -H "Content-Type: application/json" \
      --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' "$RPC_URL"; then
    echo "    ready."
    break
  fi
  if [[ "$i" -eq 30 ]]; then
    echo "Hardhat node did not come up in time — check $NODE_LOG" >&2
    exit 1
  fi
  sleep 0.5
done

echo "==> Deploying contracts (writes ui/src/deployment.json)…"
npx hardhat run scripts/deploy.js --network localhost

if [[ ! -d "$UI_DIR/node_modules" ]]; then
  echo "==> Installing ui/ dependencies (first run)…"
  (cd "$UI_DIR" && npm install)
fi

echo "==> Starting UI dev server — http://localhost:5173  (Ctrl+C to stop everything)"
cd "$UI_DIR"
npm run dev
