# Bridge / reli-finance — backend issues found during docs verification

Found 2026-05-20 while smoke-testing the documented API against the sandbox business
`2c0219b4-8c70-418d-9e9a-449e7b7643eb` at `https://services.finance.reli.co.tz/api`.
These block or degrade the documented loan-origination flow. KYC, wallets, reads, and the
link/standalone loan strategies all work — these are the exceptions.

Repro setup (sandbox key):
```bash
export BASE="https://services.finance.reli.co.tz/api"
export TOKEN=$(curl -s -X POST $BASE/generate-token -H "Content-Type: application/json" \
  -d '{"keyId":"<SANDBOX_KEY_ID>","secret":"<SANDBOX_SECRET>"}' | jq -r .token)
# Create + activate a customer first:
CID=$(curl -s -X POST $BASE/v1/kyc/customers -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"legalName":"Repro","type":"PERSON","mobile":"+255700009999"}' | jq -r '.customerId // .id')
curl -s -X PATCH $BASE/v1/kyc/customers/$CID/activate -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"customerId\":\"$CID\",\"status\":\"ACTIVE\",\"activatedOn\":\"$(date +%F)\"}" >/dev/null
```

---

## Issue 1 — `createWalletProductCode` auto-provision returns 500 (UUID column gets the string "provisioned")  [P1]

`POST /v1/lms/loans` with `createWalletProductCode` (Strategy C — auto-provision a wallet
+ standing instruction) fails with a Postgres `22P02` error.

**Repro** (published product `DF-001`, published wallet `SAV2`):
```bash
curl -s -X POST $BASE/v1/lms/loans -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"customerId\":\"$CID\",\"productCode\":\"DF-001\",\"principal\":100000,\"createWalletProductCode\":\"SAV2\",\"fspFundId\":2}"
```
**Actual:**
```json
{"statusCode":500,"code":"22P02","error":"Internal Server Error",
 "message":"invalid input syntax for type uuid: \"provisioned\""}
```
**Expected:** loan created, wallet auto-provisioned, standing instruction set up.

- Reproduces with both `DF-001`/`SAV2` and `DG30`/`RLOP` → independent of product/fund config.
- Hypothesis: the auto-provision path writes the literal string `"provisioned"` (a status/marker?)
  into a `uuid` column (a wallet/transaction id field) instead of an id.
- Impact: the one-call BNPL shortcut is unusable. Workaround in docs: open + approve + activate
  a wallet, then pass `linkWalletId` (verified working 14/14).

---

## Issue 2 — Published loan product with no fund gives an opaque error  [P2]

`DG30` is `status: "published"` but has `fspFundId: null` and `requiresAccounting: true`.
Originating against it fails unhelpfully.

**Repro:**
```bash
curl -s -X POST $BASE/v1/lms/loans -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"customerId\":\"$CID\",\"productCode\":\"DG30\",\"principal\":50000}"
```
**Actual:** `{"message":"Failed to create loan","error":"[object Object]"}`

Two problems:
1. A product that `requiresAccounting` but has no `fspFundId` shouldn't be publishable (or origination
   should return a clear "product is not fully configured: missing fund" error).
2. `error: "[object Object]"` — an error object is being string-coerced. Serialize the real cause.

(`DF-001` has `fspFundId: 2` and originates fine — confirming fund config is the differentiator.)

---

## Minor — `GET /v1/kyc/customers/phone/{mobile}` returns 200 + null when not found  [P3]

Returns `200` with a `null` body for a non-existent customer rather than `404`. Forces clients to
null-check a 200. Consider `404`, or document the 200+null contract. (Docs currently document the
200+null behavior.)

---

## Not bugs (verified working)
Auth, `GET` products/payment-types, KYC (dedup→upsert→submit-docs→activate), wallet open/approve/activate,
loan via `linkWalletId` and standalone, approve, `disburse` / `disburse-to-savings`, schedule.
Note: disbursed loans can't be undone (`undo-disbursement`/`undo-approval`/`withdraw` → 400) — expected,
but worth a sandbox reset path for testing.
