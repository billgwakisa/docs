#!/usr/bin/env node
// Bridge smoke runner — proves the documented APIs actually work against a sandbox.
//
//   Read-only (default, safe):   node tools/smoke/smoke.mjs
//   Full E2E (mutating, sandbox): node tools/smoke/smoke.mjs --full
//
// Credentials come from env (never hardcoded, never logged):
//   BRIDGE_BAAS_URL     (default https://services.finance.reli.co.tz/api)
//   BRIDGE_BAAS_KEY_ID, BRIDGE_BAAS_SECRET            (required)
//   BRIDGE_GATEWAY_URL, BRIDGE_GATEWAY_KEY_ID, BRIDGE_GATEWAY_SECRET  (optional; enables collections checks)
//
// Full mode is ring-fenced: unique customer per run (idempotency), small amounts,
// and best-effort cleanup via undo/withdraw. It refuses to run unless the token's
// environment is "sandbox".

const FULL = process.argv.includes("--full");
const BASE = process.env.BRIDGE_BAAS_URL || "https://services.finance.reli.co.tz/api";
const KEY = process.env.BRIDGE_BAAS_KEY_ID;
const SECRET = process.env.BRIDGE_BAAS_SECRET;
const runId = Date.now().toString(36);

if (!KEY || !SECRET) { console.error("Set BRIDGE_BAAS_KEY_ID and BRIDGE_BAAS_SECRET"); process.exit(2); }

const results = [];
let token = null, tokenEnv = null, businessId = null;
const log = (ok, name, detail = "") => { results.push({ ok, name }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const redact = (s) => String(s).replace(SECRET, "***").replace(/Bearer [\w.\-]+/g, "Bearer ***");

async function generateToken() {
  const res = await fetch(`${BASE}/generate-token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keyId: KEY, secret: SECRET }),
  });
  if (!res.ok) throw new Error(`generate-token ${res.status}`);
  const j = await res.json();
  token = j.token; tokenEnv = j.environment; businessId = j.businessId;
  if (!token) throw new Error("no token");
  return j;
}

async function call(method, path, { body, retried = false } = {}) {
  if (!token) await generateToken();
  const res = await fetch(`${BASE}${path}`, {
    method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !retried) { token = null; return call(method, path, { body, retried: true }); }
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

async function readOnly() {
  console.log(`\n== Read-only suite (${BASE}) ==`);
  const t = await generateToken().then(() => true).catch((e) => { log(false, "POST /generate-token", redact(e.message)); return false; });
  if (t) log(true, "POST /generate-token", `env=${tokenEnv} business=${businessId}`);

  for (const [name, path] of [
    ["GET /v1/lms/products", "/v1/lms/products"],
    ["GET /v1/wms/products", "/v1/wms/products"],
    ["GET /v1/lms/payment-types", "/v1/lms/payment-types"],
  ]) {
    try { const r = await call("GET", path); log(r.status === 200 && Array.isArray(r.data), name, `${r.status}, ${Array.isArray(r.data) ? r.data.length + " items" : "non-array"}`); }
    catch (e) { log(false, name, redact(e.message)); }
  }
}

async function full() {
  console.log(`\n== Full E2E suite (mutating, sandbox only) ==`);
  if (tokenEnv !== "sandbox") { log(false, "environment guard", `refusing: env=${tokenEnv} (not sandbox)`); return; }

  // Discover real codes
  const lms = await call("GET", "/v1/lms/products");
  const wms = await call("GET", "/v1/wms/products");
  const pts = await call("GET", "/v1/lms/payment-types");
  // Pick by env override (BRIDGE_LOAN_PRODUCT / BRIDGE_WALLET_PRODUCT) if set, else first published.
  const pick = (arr, code) =>
    code ? (arr || []).find((p) => p.productCode === code) : (arr || []).find((p) => p.status === "published");
  const loanProduct = pick(lms.data, process.env.BRIDGE_LOAN_PRODUCT);   // loan creation requires a PUBLISHED product
  const walletProduct = pick(wms.data, process.env.BRIDGE_WALLET_PRODUCT);
  const productCode = loanProduct?.productCode;
  const fspFundId = loanProduct?.fspFundId;
  const walletProductCode = walletProduct?.productCode;
  const paymentTypeId = pts.data?.[0]?.id;
  log(Boolean(productCode && walletProductCode), "discover published products", `loan=${productCode} wallet=${walletProductCode} payType=${paymentTypeId} fspFundId=${fspFundId}`);
  if (!productCode || !walletProductCode) { log(false, "blocked", "no PUBLISHED loan/wallet product on this business — publish one to run the loan flow"); return; }

  const mobile = `+2557${runId.slice(-8).padStart(8, "0")}`;

  // KYC: dedup -> upsert -> activate
  const existing = await call("GET", `/v1/kyc/customers/phone/${encodeURIComponent(mobile)}`);
  // Note: this endpoint returns 200 with a null body (not 404) when no match.
  log([200, 404].includes(existing.status), "GET kyc/customers/phone (dedup)", `${existing.status}${existing.data ? " found" : " null (new)"}`);
  let customerId = existing.status === 200 && existing.data ? (existing.data.customerId || existing.data.id) : null;
  if (!customerId) {
    const c = await call("POST", "/v1/kyc/customers", { body: { legalName: `Smoke ${runId}`, type: "PERSON", mobile } });
    customerId = c.data?.customerId || c.data?.id;
    log(Boolean(customerId), "POST kyc/customers (upsert)", `${c.status} id=${customerId}`);
  }
  if (!customerId) return;
  const act = await call("PATCH", `/v1/kyc/customers/${customerId}/activate`, { body: { customerId, status: "ACTIVE", activatedOn: new Date().toISOString().slice(0, 10) } });
  log([200, 201].includes(act.status), "PATCH kyc/customers/activate", `${act.status}`);

  // principal in MAJOR units — use the product's min so we exercise the real flow.
  const today = new Date().toISOString().slice(0, 10);
  const terms = loanProduct.config?.terms || {};
  const principal = terms.minPrincipal || terms.principal || 1000;
  // link = verified working (open wallet -> linkWalletId). standalone = loan only.
  // wallet = createWalletProductCode auto-provision (currently hits a backend 500 bug).
  const strategy = process.env.BRIDGE_LOAN_STRATEGY || "link";

  const loanBody = { customerId, productCode, principal };
  if (fspFundId != null) loanBody.fspFundId = fspFundId;

  if (strategy === "wallet") {
    loanBody.createWalletProductCode = walletProductCode; // auto-provision (Strategy C)
  } else if (strategy === "link") {
    // Strategy B: open + approve + activate a wallet, then link it.
    const w = await call("POST", "/v1/wms/wallets", { body: { customerId, productCode: walletProductCode } });
    const linkWalletId = w.data?.id;
    log(Boolean(linkWalletId), "POST wms/wallets (open)", `${w.status} id=${linkWalletId}`);
    if (linkWalletId) {
      const a1 = await call("POST", `/v1/wms/wallets/${linkWalletId}/approve`, { body: {} });
      const a2 = await call("POST", `/v1/wms/wallets/${linkWalletId}/activate`, { body: {} });
      log([200, 201].includes(a1.status) && [200, 201].includes(a2.status), "wms/wallets approve+activate", `${a1.status}/${a2.status}`);
      loanBody.linkWalletId = linkWalletId;
    }
  } // strategy === "standalone": no wallet

  const loanRes = await call("POST", "/v1/lms/loans", { body: loanBody });
  const loanId = loanRes.data?.loanId;
  const loanDetail = loanId ? `loanId=${loanId} state=${loanRes.data?.state}` : `${loanRes.status}: ${redact(JSON.stringify(loanRes.data)).slice(0, 200)}`;
  log(Boolean(loanId), `POST lms/loans (strategy=${strategy})`, loanDetail);
  if (!loanId) { log(false, "loan flow blocked", "see error above"); return; }

  const appr = await call("POST", `/v1/lms/loans/${loanId}/approve`, { body: { approvedOnDate: today, note: `smoke ${runId}` } });
  log([200, 201].includes(appr.status), "POST lms/loans/approve", `${appr.status}`);

  const disbPath = strategy === "standalone" ? "disburse" : "disburse-to-savings";
  const disb = await call("POST", `/v1/lms/loans/${loanId}/${disbPath}`, { body: { disbursedOnDate: today } });
  log([200, 201].includes(disb.status), `POST lms/loans/${disbPath}`, `${disb.status}: ${disb.status >= 400 ? redact(JSON.stringify(disb.data)).slice(0, 160) : "ok"}`);

  const sched = await call("GET", `/v1/lms/loans/${loanId}/schedule`);
  log(sched.status === 200, "GET lms/loans/schedule", `${sched.status}`);

  // Best-effort cleanup (ledger entries are not deletable; undo where allowed)
  console.log("-- cleanup (best-effort) --");
  const undoDisb = await call("POST", `/v1/lms/loans/${loanId}/undo-disbursement`, { body: { note: "smoke cleanup" } }).catch((e) => ({ status: "err", data: e.message }));
  console.log(`   undo-disbursement: ${undoDisb.status}`);
  const undoAppr = await call("POST", `/v1/lms/loans/${loanId}/undo-approval`, { body: { note: "smoke cleanup" } }).catch((e) => ({ status: "err", data: e.message }));
  console.log(`   undo-approval: ${undoAppr.status}`);
  const withdraw = await call("POST", `/v1/lms/loans/${loanId}/withdraw`, { body: { withdrawnOnDate: today, note: "smoke cleanup" } }).catch((e) => ({ status: "err", data: e.message }));
  console.log(`   withdraw: ${withdraw.status}`);
}

await readOnly();
if (FULL) await full();
else console.log("\n(read-only mode — pass --full to run the mutating E2E in sandbox)");

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
process.exit(failed.length ? 1 : 0);
