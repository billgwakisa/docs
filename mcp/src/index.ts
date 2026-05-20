#!/usr/bin/env node
// Bridge MCP server. Tools are DERIVED from the curated OpenAPI spec, so they stay
// in sync with the docs. Safety is enforced at LAUNCH time by the operator:
//   - which environment (sandbox/prod) is fixed by the key in env — the agent can't switch it
//   - money-moving tools are only registered when BRIDGE_ENABLE_MONEY_MOVERS=true
// The agent cannot escalate either at call time.

import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, MONEY_MOVERS } from "./config.js";
import { BridgeClient } from "./client.js";

const config = loadConfig();
const specPath = process.env.BRIDGE_SPEC_PATH || new URL("../../api-reference/openapi.json", import.meta.url).pathname;
const spec: any = JSON.parse(readFileSync(specPath, "utf8"));

const baas = new BridgeClient(config.baas);
const gateway = config.gateway ? new BridgeClient(config.gateway) : null;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: any;
  method: string;
  pathTemplate: string;
  pathParams: string[];
  queryParams: string[];
  service: "baas" | "gateway";
  isMoneyMover: boolean;
}

function resolveSchema(s: any): any {
  if (!s) return undefined;
  if (s.$ref) {
    const name = s.$ref.split("/").pop();
    return spec.components?.schemas?.[name];
  }
  return s;
}

function slug(method: string, path: string): string {
  const parts = path.split("/").filter((p) => p && p !== "v1" && !p.startsWith("{"));
  return [method.toLowerCase(), ...parts].join("_").replace(/[^a-z0-9_]/g, "");
}

function buildTools(): { tools: ToolDef[]; skipped: string[] } {
  const tools: ToolDef[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();

  for (const [path, ops] of Object.entries<any>(spec.paths)) {
    for (const [method, op] of Object.entries<any>(ops)) {
      const M = method.toUpperCase();
      const opKey = `${M} ${path}`;
      if (opKey === "POST /generate-token") continue; // auth handled internally

      const isCollections = (op.tags || []).includes("Collections");
      const service: "baas" | "gateway" = isCollections ? "gateway" : "baas";
      if (service === "gateway" && !gateway) { skipped.push(`${opKey} (gateway not configured)`); continue; }

      const isMoneyMover = MONEY_MOVERS.has(opKey);
      if (isMoneyMover && !config.enableMoneyMovers) { skipped.push(`${opKey} (money-mover, locked)`); continue; }

      // Parameters
      const params = op.parameters || [];
      const pathParams = params.filter((p: any) => p.in === "path").map((p: any) => p.name);
      const queryParams = params.filter((p: any) => p.in === "query").map((p: any) => p.name);
      const properties: Record<string, any> = {};
      const required: string[] = [];
      for (const p of params) {
        properties[p.name] = { ...(p.schema || { type: "string" }), description: p.description };
        if (p.required) required.push(p.name);
      }
      // Request body
      const bodySchema = resolveSchema(op.requestBody?.content?.["application/json"]?.schema);
      if (bodySchema?.properties) {
        for (const [k, v] of Object.entries<any>(bodySchema.properties)) properties[k] = v;
        for (const r of bodySchema.required || []) required.push(r);
      }

      let name = slug(M, path);
      while (seen.has(name)) name += "_x";
      seen.add(name);

      const moneyTag = isMoneyMover ? " [MONEY-MOVER: moves real funds]" : "";
      tools.push({
        name,
        description: `${op.summary || opKey}. ${(op.description || "").split("\n")[0]}${moneyTag}`.trim(),
        inputSchema: { type: "object", properties, required: [...new Set(required)] },
        method: M,
        pathTemplate: path,
        pathParams,
        queryParams,
        service,
        isMoneyMover,
      });
    }
  }
  return { tools, skipped };
}

const { tools, skipped } = buildTools();
const byName = new Map(tools.map((t) => [t.name, t]));

const server = new Server(
  { name: "bridge-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const t = byName.get(req.params.name);
  if (!t) return { isError: true, content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }] };
  const args = (req.params.arguments || {}) as Record<string, any>;
  const client = t.service === "gateway" ? gateway! : baas;
  try {
    const result = await client.call(t.method, t.pathTemplate, t.pathParams, t.queryParams, args);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (e: any) {
    return { isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

// Startup banner on stderr (stdout is the MCP channel).
console.error(
  `[bridge-mcp] env=${config.environmentLabel} | money-movers=${config.enableMoneyMovers ? "ENABLED" : "locked"} | ` +
  `tools=${tools.length} | skipped=${skipped.length}` +
  (skipped.length ? `\n[bridge-mcp] skipped: ${skipped.join(", ")}` : ""),
);
