// Integration-assistant layer. These tools/resources/prompts help a developer's
// coding agent WRITE x-bridge into their own app — they never call the live API.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const docsRoot = process.env.BRIDGE_DOCS_DIR || join(here, "..", ".."); // dist/ -> mcp/ -> docs/

// The operating rules. Also surfaced as the server's MCP `instructions`.
export const RULES = `x-bridge Banking-as-a-Service — integration rules. Follow these; they prevent the common failures.

ENVIRONMENT & AUTH
- Exchange the API key (keyId + secret) for a Bearer token at POST /generate-token. Cache it for ~1h; on a 401, re-exchange and retry once.
- The BaaS core and the Collections gateway are separate services with their own base URL and key — but the same Bearer model.

CUSTOMERS (KYC)
- Create a customer, then ACTIVATE it. A customer must be ACTIVE before it can hold a wallet or loan.
- Look up by phone first and reuse the customerId if found, to avoid duplicates.

PRODUCTS
- Use only products with status "published". Draft products are rejected. A loan product also needs a fund configured; if origination fails generically, pick another published product.
- Loan principal must be within the product's config.terms.minPrincipal / maxPrincipal.

WALLETS
- Open, then approve, then activate a wallet before use.

LOANS
- To fund a wallet from a loan: open+approve+activate a wallet, then create the loan with linkWalletId. Do NOT use createWalletProductCode (auto-provision) — temporarily unavailable.
- Sequence: create -> approve -> disburse (or disburse-to-savings if a wallet is linked) -> settle with submit-payment.

PAYMENTS
- Collections run on the gateway service: trigger /collection/mobile, poll /collection/status until COMPLETED, then record with submit-payment (loan) or submit-deposit (wallet). Both verify on the gateway and are idempotent on the reference.`;

export const USE_CASES: Record<string, { recipe: string; title: string }> = {
  kyc: { recipe: "kyc-onboarding.mdx", title: "Customer onboarding (KYC)" },
  wallets: { recipe: "wallets.mdx", title: "Wallets" },
  lending: { recipe: "lending.mdx", title: "Lending" },
  bnpl: { recipe: "bnpl.mdx", title: "BNPL" },
  collections: { recipe: "collections.mdx", title: "Payment collections" },
};

export function getRecipe(useCase: string): string {
  const uc = USE_CASES[useCase];
  if (!uc) return `Unknown use case "${useCase}". Available: ${Object.keys(USE_CASES).join(", ")}.`;
  try {
    return readFileSync(join(docsRoot, "recipes", uc.recipe), "utf8");
  } catch {
    return `Recipe file not found for ${useCase}.`;
  }
}

export function getSpec(): string {
  try {
    return readFileSync(join(docsRoot, "api-reference", "openapi.json"), "utf8");
  } catch {
    return "{}";
  }
}

// Reference token clients — production-shaped (cache + 401 retry), brand-neutral so they paste anywhere.
export const CLIENTS: Record<string, string> = {
  typescript: `// x-bridge token client (TypeScript). Exchange key -> Bearer, cache ~1h, retry once on 401.
const BASE = process.env.XBRIDGE_BASE_URL ?? "https://services.finance.reli.co.tz/api";
const KEY_ID = process.env.XBRIDGE_KEY_ID!;
const SECRET = process.env.XBRIDGE_SECRET!;

let token: string | null = null;
let tokenExpiry = 0;

async function getToken(): Promise<string> {
  if (token && Date.now() < tokenExpiry) return token;
  const res = await fetch(\`\${BASE}/generate-token\`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keyId: KEY_ID, secret: SECRET }),
  });
  if (!res.ok) throw new Error(\`generate-token \${res.status}\`); // never log the body (contains the secret)
  const data = await res.json();
  token = data.token;
  tokenExpiry = data.expiresAt ? new Date(data.expiresAt).getTime() : Date.now() + 3600_000;
  return token!;
}

export async function xbridge(path: string, init: RequestInit = {}, retried = false): Promise<any> {
  const t = await getToken();
  const res = await fetch(\`\${BASE}\${path}\`, {
    ...init,
    headers: { ...init.headers, "Content-Type": "application/json", Authorization: \`Bearer \${t}\` },
  });
  if (res.status === 401 && !retried) { token = null; return xbridge(path, init, true); }
  const text = await res.text();
  if (!res.ok) throw new Error(\`\${init.method ?? "GET"} \${path} -> \${res.status}: \${text}\`);
  return text ? JSON.parse(text) : null;
}`,
  python: `# x-bridge token client (Python). Exchange key -> Bearer, cache ~1h, retry once on 401.
import os, time, requests

BASE = os.environ.get("XBRIDGE_BASE_URL", "https://services.finance.reli.co.tz/api")
KEY_ID = os.environ["XBRIDGE_KEY_ID"]
SECRET = os.environ["XBRIDGE_SECRET"]

_token = None
_token_expiry = 0.0

def _get_token():
    global _token, _token_expiry
    if _token and time.time() < _token_expiry:
        return _token
    r = requests.post(f"{BASE}/generate-token", json={"keyId": KEY_ID, "secret": SECRET})
    r.raise_for_status()  # do not log the body (contains the secret)
    data = r.json()
    _token = data["token"]
    _token_expiry = time.time() + 3600
    return _token

def xbridge(method, path, json=None, _retried=False):
    r = requests.request(method, f"{BASE}{path}",
                         headers={"Authorization": f"Bearer {_get_token()}"}, json=json)
    if r.status_code == 401 and not _retried:
        global _token; _token = None
        return xbridge(method, path, json, True)
    r.raise_for_status()
    return r.json() if r.text else None`,
};

// ---- Offline integration tools (no API calls) -------------------------------
export const INTEGRATION_TOOLS = [
  {
    name: "integration_guide",
    description: "How to integrate x-bridge into your app: the rules, the available use-case recipes, and the recommended steps. Start here. Does not call any API.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "recipe",
    description: "Get the verified end-to-end flow for a use case (paste-ready steps + curl), to translate into the developer's codebase. Does not call any API.",
    inputSchema: {
      type: "object",
      properties: { useCase: { type: "string", enum: Object.keys(USE_CASES), description: "Which flow to fetch." } },
      required: ["useCase"],
    },
  },
  {
    name: "client",
    description: "Get a production-ready x-bridge token client (generate-token + 1h cache + 401 retry) to drop into the developer's project. Does not call any API.",
    inputSchema: {
      type: "object",
      properties: { language: { type: "string", enum: Object.keys(CLIENTS), description: "Target language." } },
      required: ["language"],
    },
  },
];

export function handleIntegrationTool(name: string, args: Record<string, any>): string | null {
  switch (name) {
    case "integration_guide":
      return `${RULES}\n\n## Use-case recipes (call \`recipe\` with one of these)\n${Object.entries(USE_CASES)
        .map(([k, v]) => `- ${k} — ${v.title}`)
        .join("\n")}\n\n## Recommended steps\n1. \`client\` → drop a token client into the project.\n2. \`recipe\` for your use case → translate the flow into your code.\n3. Wire your own customer/order data in; keep secrets in env, never in the repo.\n4. Test against a sandbox key before production.`;
    case "recipe":
      return getRecipe(String(args.useCase));
    case "client":
      return CLIENTS[String(args.language)] ?? `Unknown language. Available: ${Object.keys(CLIENTS).join(", ")}.`;
    default:
      return null; // not an integration tool
  }
}

// ---- Resources --------------------------------------------------------------
export function listResources() {
  return [
    { uri: "xbridge://rules", name: "Integration rules", mimeType: "text/markdown" },
    { uri: "xbridge://openapi", name: "Curated OpenAPI spec", mimeType: "application/json" },
    ...Object.entries(USE_CASES).map(([k, v]) => ({
      uri: `xbridge://recipe/${k}`,
      name: `Recipe: ${v.title}`,
      mimeType: "text/markdown",
    })),
    ...Object.keys(CLIENTS).map((lang) => ({
      uri: `xbridge://client/${lang}`,
      name: `Token client (${lang})`,
      mimeType: "text/plain",
    })),
  ];
}

export function readResource(uri: string): { text: string; mimeType: string } | null {
  if (uri === "xbridge://rules") return { text: RULES, mimeType: "text/markdown" };
  if (uri === "xbridge://openapi") return { text: getSpec(), mimeType: "application/json" };
  const recipe = uri.match(/^xbridge:\/\/recipe\/(.+)$/);
  if (recipe) return { text: getRecipe(recipe[1]), mimeType: "text/markdown" };
  const client = uri.match(/^xbridge:\/\/client\/(.+)$/);
  if (client && CLIENTS[client[1]]) return { text: CLIENTS[client[1]], mimeType: "text/plain" };
  return null;
}

// ---- Prompts ----------------------------------------------------------------
export const PROMPTS = [
  {
    name: "integrate",
    description: "Integrate x-bridge into the current project (scaffold a token client + a use-case flow). Does not call live APIs.",
    arguments: [
      { name: "useCase", description: `One of: ${Object.keys(USE_CASES).join(", ")}`, required: false },
      { name: "language", description: `One of: ${Object.keys(CLIENTS).join(", ")}`, required: false },
    ],
  },
];

export function getPrompt(name: string, args: Record<string, any>) {
  if (name !== "integrate") return null;
  const useCase = args.useCase && USE_CASES[args.useCase] ? args.useCase : "the use case I describe";
  const language = args.language || "this project's language";
  return {
    description: "Integrate x-bridge",
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Integrate x-bridge into this project for **${useCase}** in **${language}**.

Do this:
1. Call the \`integration_guide\` tool (or read the \`xbridge://rules\` resource) and follow the rules exactly.
2. Call \`client\` to get a token client and add it to my codebase, matching my project's conventions and putting the key/secret in env (never committed).
3. Call \`recipe\` for the use case and translate the flow into idiomatic code in my project — wiring in my own customer/order data.
4. Show me where to set XBRIDGE_KEY_ID / XBRIDGE_SECRET and how to test against a sandbox key.

Do NOT call any live x-bridge API yourself. Only write integration code into my project unless I explicitly ask you to run a call.`,
        },
      },
    ],
  };
}
