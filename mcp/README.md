# @bridge/mcp

An MCP server that exposes the **curated Bridge API** to AI agents (Claude Code, Cursor, any MCP client). Tools are generated from `api-reference/openapi.json`, so they stay in sync with the docs.

> Prototype. Lives in the docs repo for now; will move to its own npm package (`npx @bridge/mcp`).

## Safety model — launch-time lock

Safety is decided by the **operator at launch**, never by the agent at call time:

- **Environment is fixed by the key.** You start the server with a sandbox or production key. The agent cannot switch environments.
- **Money-movers are locked by default.** Tools that move real funds (disburse, repayments, deposits, escrow commit/release, collection trigger) are only registered when you set `BRIDGE_ENABLE_MONEY_MOVERS=true`. Otherwise the agent only gets read/lookup + safe writes.

## Install

```bash
cd mcp
npm install
npm run build
```

## Configure (env)

| Var | Required | Default | Purpose |
|-----|----------|---------|---------|
| `BRIDGE_BAAS_KEY_ID` / `BRIDGE_BAAS_SECRET` | yes | — | BaaS core key |
| `BRIDGE_BAAS_URL` | no | `https://api.reli.co.tz` | BaaS base URL |
| `BRIDGE_GATEWAY_KEY_ID` / `BRIDGE_GATEWAY_SECRET` | no | — | Collections gateway key (enables collection tools) |
| `BRIDGE_GATEWAY_URL` | no | `https://api.reli.co.tz/api` | Gateway base URL |
| `BRIDGE_ENABLE_MONEY_MOVERS` | no | `false` | Register money-moving tools |
| `BRIDGE_ENVIRONMENT` | no | `sandbox` | Informational label |

## Use with Claude Code

```bash
claude mcp add bridge -- node /absolute/path/to/docs/mcp/dist/index.js
```
With env (sandbox, read-only by default):
```bash
BRIDGE_BAAS_KEY_ID=... BRIDGE_BAAS_SECRET=... claude mcp add bridge -- node /abs/path/docs/mcp/dist/index.js
```

## Use with Cursor (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "bridge": {
      "command": "node",
      "args": ["/absolute/path/to/docs/mcp/dist/index.js"],
      "env": {
        "BRIDGE_BAAS_KEY_ID": "your-key-id",
        "BRIDGE_BAAS_SECRET": "your-secret",
        "BRIDGE_ENVIRONMENT": "sandbox"
      }
    }
  }
}
```

To allow the agent to move money in sandbox, add `"BRIDGE_ENABLE_MONEY_MOVERS": "true"`.

## How it works

- `config.ts` — reads launch-time env; defines the `MONEY_MOVERS` set.
- `client.ts` — token exchange + 1h cache + 401 re-token retry + secret redaction (never logs `secret`/`token`).
- `index.ts` — loads the spec, builds one tool per operation, gates money-movers, routes BaaS vs gateway, serves over stdio.
