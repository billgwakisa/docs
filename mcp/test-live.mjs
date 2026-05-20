#!/usr/bin/env node
// Drives the MCP server through a real client. Exercises the integration surface
// (tools/resources/prompts) and, when live tools exist, a read call against the sandbox.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node", args: ["dist/index.js"], env: { ...process.env }, stderr: "inherit",
});
const client = new Client({ name: "live-test", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const instr = client.getInstructions?.();
console.log("instructions:", instr ? `${instr.length} chars` : "none");

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

// Integration surface (offline)
const guide = await client.callTool({ name: "integration_guide", arguments: {} });
console.log("integration_guide ->", (guide.content?.[0]?.text ?? "").split("\n")[0]);
const bnpl = await client.callTool({ name: "recipe", arguments: { useCase: "bnpl" } });
console.log("recipe(bnpl) ->", (bnpl.content?.[0]?.text ?? "").slice(0, 60).replace(/\n/g, " "), "...");
const ts = await client.callTool({ name: "client", arguments: { language: "typescript" } });
console.log("client(typescript) ->", (ts.content?.[0]?.text ?? "").split("\n")[0]);

const { resources } = await client.listResources();
console.log("resources:", resources.map((r) => r.uri).join(", "));
const { prompts } = await client.listPrompts();
console.log("prompts:", prompts.map((p) => p.name).join(", "));

// Live read (only if a live tool exists)
if (tools.some((t) => t.name === "get_lms_products")) {
  const res = await client.callTool({ name: "get_lms_products", arguments: {} });
  let arr; try { arr = JSON.parse(res.content?.[0]?.text ?? ""); } catch {}
  console.log("LIVE get_lms_products ->", Array.isArray(arr) ? `array[${arr.length}]: ${arr.map((p) => `${p.productCode}(${p.status})`).join(", ")}` : "n/a");
} else {
  console.log("LIVE get_lms_products -> (no live tools in this mode)");
}

await client.close();
