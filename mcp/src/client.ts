// Bridge HTTP client: token exchange + cache + 401 retry + secret redaction.
// One instance per service (BaaS core, Collections gateway).

import type { ServiceConfig } from "./config.js";

export class BridgeClient {
  private token: string | null = null;
  private tokenExpiry = 0;

  constructor(private readonly svc: ServiceConfig) {}

  private async generateToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiry) return this.token;
    const res = await fetch(`${this.svc.baseUrl}/generate-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyId: this.svc.keyId, secret: this.svc.secret }),
    });
    if (!res.ok) throw new Error(`generate-token failed: ${res.status}`); // never log body (would leak secret)
    const data: any = await res.json();
    if (!data.token) throw new Error("generate-token returned no token");
    this.token = data.token as string;
    this.tokenExpiry = data.expiresAt ? new Date(data.expiresAt).getTime() : Date.now() + 3600_000;
    return this.token;
  }

  /** Call the API. Resolves path params from `args`, sends body/query, retries once on 401. */
  async call(
    method: string,
    pathTemplate: string,
    pathParams: string[],
    queryParams: string[],
    args: Record<string, any>,
    retried = false,
  ): Promise<unknown> {
    let path = pathTemplate;
    for (const p of pathParams) {
      if (args[p] == null) throw new Error(`Missing path parameter: ${p}`);
      path = path.replace(`{${p}}`, encodeURIComponent(String(args[p])));
    }
    const query = new URLSearchParams();
    for (const q of queryParams) if (args[q] != null) query.set(q, String(args[q]));
    const qs = query.toString();

    const bodyKeys = Object.keys(args).filter((k) => !pathParams.includes(k) && !queryParams.includes(k));
    const hasBody = method !== "GET" && bodyKeys.length > 0;
    const body: Record<string, any> = {};
    for (const k of bodyKeys) body[k] = args[k];

    const token = await this.generateToken();
    const res = await fetch(`${this.svc.baseUrl}${path}${qs ? `?${qs}` : ""}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: hasBody ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401 && !retried) {
      this.token = null; // force refresh, retry once
      return this.call(method, pathTemplate, pathParams, queryParams, args, true);
    }

    const text = await res.text();
    const data = text ? safeJson(text) : null;
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    return data;
  }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}
