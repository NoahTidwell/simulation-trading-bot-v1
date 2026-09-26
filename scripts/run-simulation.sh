#!/usr/bin/env bash
# Build and run simulation_trading_bot_v1.
# SIMULATION_MODE is hardcoded true in src/config.ts; the env var below is
# exported only so the intent is visible in the process environment.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "No .env found. Copy .env.example to .env and add your (read-only) API keys." >&2
  echo "The bot will still start, but candidate discovery needs HELIUS_API_KEY." >&2
fi

export SIMULATION_MODE=true

if [ ! -d node_modules ]; then
  npm install
fi

npm run build
exec node dist/index.js
