// Launch-time configuration. The OPERATOR sets these via env when starting the
// server. The agent cannot change environment or unlock money-movers at call time.

export interface ServiceConfig {
  baseUrl: string;
  keyId: string;
  secret: string;
}

export interface Config {
  baas: ServiceConfig;
  gateway: ServiceConfig | null; // optional; collections disabled if absent
  /** When false (default), money-moving tools are NOT registered at all. */
  enableMoneyMovers: boolean;
  /** Informational label surfaced to the agent. The real environment is fixed by the key. */
  environmentLabel: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function loadConfig(): Config {
  const gatewayConfigured = Boolean(process.env.BRIDGE_GATEWAY_KEY_ID && process.env.BRIDGE_GATEWAY_SECRET);
  return {
    baas: {
      baseUrl: process.env.BRIDGE_BAAS_URL || "https://api.reli.co.tz",
      keyId: required("BRIDGE_BAAS_KEY_ID"),
      secret: required("BRIDGE_BAAS_SECRET"),
    },
    gateway: gatewayConfigured
      ? {
          baseUrl: process.env.BRIDGE_GATEWAY_URL || "https://api.reli.co.tz/api",
          keyId: process.env.BRIDGE_GATEWAY_KEY_ID!,
          secret: process.env.BRIDGE_GATEWAY_SECRET!,
        }
      : null,
    // Default OFF. Operator must opt in explicitly. The agent has no say.
    enableMoneyMovers: process.env.BRIDGE_ENABLE_MONEY_MOVERS === "true",
    environmentLabel: process.env.BRIDGE_ENVIRONMENT || "sandbox",
  };
}

// Operations that move real money or trigger external collection. Gated behind
// enableMoneyMovers. Matched by "METHOD /path-with-{params}".
export const MONEY_MOVERS = new Set<string>([
  "POST /v1/lms/loans/{loanId}/disburse",
  "POST /v1/lms/loans/{loanId}/disburse-to-savings",
  "POST /v1/lms/loans/{loanId}/repayments",
  "POST /v1/lms/loans/{loanId}/submit-payment",
  "POST /v1/wms/wallets/{walletId}/submit-deposit",
  "POST /v1/wms/wallets/{walletId}/reserve",
  "POST /v1/wms/transactions/{transactionId}/commit",
  "POST /v1/wms/transactions/{transactionId}/release",
  "POST /collection/mobile",
]);
