#!/usr/bin/env bash
set -euo pipefail

NODE_BIN="${NODE_BIN:-/opt/homebrew/opt/node@24/bin/node}"
export PATH="$(dirname "$NODE_BIN"):$PATH"

if [[ ! -x "$NODE_BIN" ]]; then
  echo "Node 24 not found at $NODE_BIN. Set NODE_BIN." >&2
  exit 1
fi

echo "== typecheck =="
pnpm typecheck

echo "== tests =="
pnpm test

echo "== build =="
pnpm build

echo "== MCP + daemon mock acceptance =="
"$NODE_BIN" scripts/e2e-mock.mjs

if [[ "${OPENCODE_LIVE:-0}" == "1" ]]; then
  echo "== live OpenCode no-model smoke =="
  OPENCODE_LIVE=1 pnpm test tests/integration/opencode-live.smoke.test.ts
fi

echo "acceptance passed"
