#!/usr/bin/env bash
# x-bridge MCP setup: build the server and register it with your coding agent.
# Usage:  cd mcp && ./setup.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "Installing + building the x-bridge MCP..."
npm install --no-fund --no-audit
npm run build

ABS="$(pwd)/dist/index.js"
echo
echo "Built: $ABS"
echo

if command -v claude >/dev/null 2>&1; then
  echo "Registering with Claude Code (integrate mode — no API calls)..."
  claude mcp add x-bridge -e BRIDGE_MODE=integrate -- node "$ABS"
  echo
  echo "Done. In your editor, ask:  \"Use the x-bridge MCP to add BNPL to my app.\""
else
  echo "Claude Code CLI not found — register manually:"
  echo
  echo "  Claude Code:"
  echo "    claude mcp add x-bridge -e BRIDGE_MODE=integrate -- node \"$ABS\""
  echo
  echo "  Cursor (~/.cursor/mcp.json) — add under mcpServers:"
  echo "    \"x-bridge\": { \"command\": \"node\", \"args\": [\"$ABS\"], \"env\": { \"BRIDGE_MODE\": \"integrate\" } }"
fi
