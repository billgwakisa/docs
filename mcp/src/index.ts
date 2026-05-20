#!/usr/bin/env node
// x-bridge MCP server. Two jobs:
//   1. INTEGRATE (default focus): help a developer's agent write x-bridge into their
//      own app — offline tools/resources/prompts, no live API calls.
//   2. EXECUTE (optional): call the live x-bridge API. Tools derived from the curated
//      OpenAPI spec. Safety is set by the OPERATOR at launch:
//        - environment is fixed by the key (the agent can't switch it)
//        - money-moving tools register only when BRIDGE_ENABLE_MONEY_MOVERS=true
// Mode is chosen with BRIDGE_MODE = integrate | execute | both (default both).

import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, MONEY_MOVERS } from "./config.js";
import { BridgeClient } from "./client.js";
import {
  RULES,
  INTEGRATION_TOOLS,
  handleIntegrationTool,
  listResources,
  readResource,
  PROMPTS,
  getPrompt,
} from "./integration.js";

const config = loadConfig();
const specPath = process.env.BRIDGE_SPEC_PATH || new URL("../../api-reference/openapi.json", import.meta.url).pathname;
const spec: any = JSON.parse(readFileSync(specPath, "utf8"));

// Per-tool reminders appended to the generated tool description (the model sees these when choosing a tool).
const TOOL_HINTS: Record<string, string> = {
  "POST /v1/lms/loans":
    "RULES: customer must be ACTIVE; productCode must be a PUBLISHED loan product with a fund; principal within the product min/max. To fund a wallet, open+approve+activate a wallet and pass linkWalletId — do NOT use createWalletProductCode (temporarily unavailable).",
  "POST /v1/wms/wallets": "After opening, you must approve then activate the wallet before it can be used.",
  "POST /v1/kyc/customers": "Then activate the customer (PATCH .../activate) before opening wallets or loans.",
};

const liveEnabled = config.mode !== "integrate";
const baas = liveEnabled && config.baas ? new BridgeClient(config.baas) : null;
const gateway = liveEnabled && config.gateway ? new BridgeClient(config.gateway) : null;

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
  if (s.$ref) return spec.components?.schemas?.[s.$ref.split("/").pop()];
  return s;
}

function slug(method: string, path: string): string {
  const parts = path.split("/").filter((p) => p && p !== "v1" && !p.startsWith("{"));
  return [method.toLowerCase(), ...parts].join("_").replace(/[^a-z0-9_]/g, "");
}

function buildLiveTools(): { tools: ToolDef[]; skipped: string[] } {
  const tools: ToolDef[] = [];
  const skipped: string[] = [];
  if (!liveEnabled) return { tools, skipped: ["all live API tools (integrate mode)"] };
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

      const params = op.parameters || [];
      const pathParams = params.filter((p: any) => p.in === "path").map((p: any) => p.name);
      const queryParams = params.filter((p: any) => p.in === "query").map((p: any) => p.name);
      const properties: Record<string, any> = {};
      const required: string[] = [];
      for (const p of params) {
        properties[p.name] = { ...(p.schema || { type: "string" }), description: p.description };
        if (p.required) required.push(p.name);
      }
      const bodySchema = resolveSchema(op.requestBody?.content?.["application/json"]?.schema);
      if (bodySchema?.properties) {
        for (const [k, v] of Object.entries<any>(bodySchema.properties)) properties[k] = v;
        for (const r of bodySchema.required || []) required.push(r);
      }

      let name = slug(M, path);
      while (seen.has(name)) name += "_x";
      seen.add(name);

      const moneyTag = isMoneyMover ? " [MONEY-MOVER: moves real funds]" : "";
      const hint = TOOL_HINTS[opKey] ? ` ${TOOL_HINTS[opKey]}` : "";
      tools.push({
        name,
        description: `${op.summary || opKey}. ${(op.description || "").split("\n")[0]}${moneyTag}${hint}`.trim(),
        inputSchema: { type: "object", properties, required: [...new Set(required)] },
        method: M, pathTemplate: path, pathParams, queryParams, service, isMoneyMover,
      });
    }
  }
  return { tools, skipped };
}

const { tools: liveTools, skipped } = buildLiveTools();
const liveByName = new Map(liveTools.map((t) => [t.name, t]));

const modeNote =
  config.mode === "integrate"
    ? "\n\nMODE: integrate — there are NO live API tools. Use integration_guide / recipe / client and the xbridge:// resources to scaffold x-bridge into the developer's app. Do not attempt live calls."
    : config.mode === "execute"
    ? "\n\nMODE: execute — live API tools are available."
    : "\n\nMODE: both — use integration_guide / recipe / client to scaffold code, and the live tools only when the developer explicitly asks to run a call.";

const server = new Server(
  { name: "x-bridge-mcp", version: "0.1.0" },
  { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: RULES + modeNote },
);

// Tools = integration tools (always) + live API tools (unless integrate mode).
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    ...INTEGRATION_TOOLS,
    ...liveTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments || {}) as Record<string, any>;
  // Integration tools first (offline; never touch the API).
  const integrationResult = handleIntegrationTool(req.params.name, args);
  if (integrationResult !== null) return { content: [{ type: "text", text: integrationResult }] };
  // Live tools.
  const t = liveByName.get(req.params.name);
  if (!t) return { isError: true, content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }] };
  const client = t.service === "gateway" ? gateway! : baas!;
  try {
    const result = await client.call(t.method, t.pathTemplate, t.pathParams, t.queryParams, args);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (e: any) {
    return { isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] };
  }
});

// Resources: rules, spec, recipes, reference clients.
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: listResources() }));
server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const r = readResource(req.params.uri);
  if (!r) throw new Error(`Unknown resource: ${req.params.uri}`);
  return { contents: [{ uri: req.params.uri, mimeType: r.mimeType, text: r.text }] };
});

// Prompts: the one-tap "integrate" workflow.
server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));
server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const p = getPrompt(req.params.name, (req.params.arguments || {}) as Record<string, any>);
  if (!p) throw new Error(`Unknown prompt: ${req.params.name}`);
  return p;
});

const transport = new StdioServerTransport();
await server.connect(transport);

console.error(
  `[x-bridge-mcp] mode=${config.mode} | env=${config.environmentLabel} | ` +
  `integration tools=${INTEGRATION_TOOLS.length} | live tools=${liveTools.length} | ` +
  `money-movers=${config.enableMoneyMovers ? "ENABLED" : "locked"}` +
  (skipped.length ? `\n[x-bridge-mcp] skipped: ${skipped.join(", ")}` : ""),
);
