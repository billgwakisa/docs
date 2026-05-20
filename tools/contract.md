# Phase 0 — Bridge curated contract (Rafiki-proven)

Source of truth for the curated OpenAPI spec, recipes, smoke tests, and MCP.
Derived from: Rafiki production clients (`rafiki-engine/engine/src/common/lms/lms.service.ts`,
`.../payments/bridge.service.ts`) + reli-finance controllers/DTOs. "Verified" = Rafiki calls it in prod.

## Two services, two keys, one auth model
| Service | Base URL (env) | Key (env) | Auth |
|---------|----------------|-----------|------|
| BaaS core (KYC/LMS/WMS) | `RELI_FINANCE_URL` (api.reli.co.tz) | `RELI_FINANCE_API_KEY`/`_SECRET` | Bearer JWT |
| Collections gateway | `BRIDGE_PAYMENT_URL` (host + `/api`) | `BRIDGE_PAYMENT_API_KEY`/`_SECRET` | Bearer JWT (BridgeAK header is a documented alternative) |

Both expose `POST /generate-token` → `{ token, businessId, scopes, expiresAt }` (clients also tolerate `expiresIn`).
Token TTL ~1h. **401 recovery (canonical):** clear token → re-`generate-token` → retry once. Document this everywhere.

OpenAPI spec → 2 `servers` (BaaS + gateway) as a parameterized server **variable** `{host}`; one Bearer security scheme.

## Auth
- `POST /generate-token` body `{ keyId, secret }` → `{ token, expiresAt, businessId, environment: "sandbox"|"production", scopes:[] }`

## KYC / Customers  (server: BaaS core)
| Verified | Method/Path | Body (Rafiki) | Notes |
|----------|-------------|---------------|-------|
| ✅ | POST /v1/kyc/customers | `{customerId?, legalName, type:"PERSON"|"BUSINESS", mobile?, email?, dob?, nationalId?, address?}` | upsert → `{customerId}` |
| ✅ | GET /v1/kyc/customers/{customerId} | — | → `{customerId, profile{...}, externalData{...Fineract...}}` (LEAK: externalData is raw Fineract) |
| ✅ | GET /v1/kyc/customers/phone/{mobile} | — | same shape as get-by-id |
| ✅ | POST /v1/kyc/customers/{customerId}/kyc | `{documents:[{type,url}], identifiers:[{type,value}]}` | |
| ✅ | PATCH /v1/kyc/customers/{customerId}/activate | `{customerId, status:"ACTIVE", activatedOn:"yyyy-MM-dd"}` | gates wallets/loans |
| ◻️ | GET /v1/kyc/customers | query `page,limit,status,type,search` | documented-only (Rafiki doesn't call) |

## LMS — products & loans  (server: BaaS core)
| Verified | Method/Path | Body | Notes |
|----------|-------------|------|-------|
| ✅ | GET /v1/lms/products | — | list; → `[{id,code,name,currency,status,config{terms,interest}}]` |
| ◻️ | GET /v1/lms/products/{code} | — | documented-only |
| ✅ | POST /v1/lms/loans | `{customerId, productCode, principal, numberOfRepayments?, repaymentFrequency?, expectedDisbursementDate?, linkWalletId?|createWalletProductCode?, fspFundId?}` | 3 strategies; `createWalletProductCode` auto-provisions wallet + standing instruction. **principal is MAJOR units (footgun)** |
| ✅ | POST /v1/lms/loans/{loanId}/approve | `{approvedOnDate, note?}` | |
| ✅ | POST /v1/lms/loans/{loanId}/disburse | `{disbursedOnDate, amount?}` | |
| ✅ | POST /v1/lms/loans/{loanId}/disburse-to-savings | `{disbursedOnDate}` | credits linked wallet |
| ✅ | GET /v1/lms/loans/{loanId}/schedule | — | |
| ✅ | POST /v1/lms/loans/calculate-schedule | same as create loan | preview, no record |
| ✅ | POST /v1/lms/loans/{loanId}/repayments | `{transactionAmount, transactionDate, paymentTypeId, note?, receiptNumber?}` | receiptNumber = idempotency |
| ✅ | POST /v1/lms/loans/{loanId}/submit-payment | `{gatewayReference, amount, fspId, note?}` | verifies gateway before posting; idempotent on gatewayReference |
| ✅ | GET /v1/lms/loans/{loanId}/pay-link | — | → `{payLink}` (NOTE: returns reli.finance domain) |
| ✅ | GET /v1/lms/payment-types | — | for paymentTypeId |
| ◻️ | GET /v1/lms/loans/{loanId} | — | documented-only; LEAK: returns raw Fineract (int id, loanStatusType.*, principal in major units) |

## WMS — wallets  (server: BaaS core)
| Verified | Method/Path | Body | Notes |
|----------|-------------|------|-------|
| ✅ | GET /v1/wms/products | — | |
| ✅ | POST /v1/wms/wallets | `{customerId, productCode}` | → `{id,...}`; businessId from token |
| ✅ | POST /v1/wms/wallets/{walletId}/approve | `{}` | |
| ✅ | POST /v1/wms/wallets/{walletId}/activate | `{}` | |
| ✅ | GET /v1/wms/wallets/{walletId} | — | balance, status, linkedLoan |
| ✅ | GET /v1/wms/wallets?customerId={id} | — | list for customer |
| ✅ | GET /v1/wms/wallets/{walletId}/transactions | — | |
| ✅ | POST /v1/wms/wallets/{walletId}/submit-deposit | `{gatewayReference, amount, fspId, description?}` | verified deposit; idempotent |
| ✅ | POST /v1/wms/wallets/{walletId}/reserve | `{amount, currency, reference, description}` | escrow hold → `{transactionId}` |
| ✅ | POST /v1/wms/transactions/{transactionId}/commit | `{note?}` | capture hold |
| ✅ | POST /v1/wms/transactions/{transactionId}/release | `{reason?}` | cancel hold |
| ◻️ | POST /v1/wms/wallets/{walletId}/topup | `{amountMinor, currency}` | documented-only (Rafiki uses submit-deposit) |
| ◻️ | GET /v1/wms/wallets/{walletId}/statement | — | documented-only |

## Collections gateway  (server: BRIDGE_PAYMENT_URL, Bearer)
| Verified | Method/Path | Body/Query | Notes |
|----------|-------------|-----------|-------|
| ✅ | POST /collection/mobile | `{amount, currency, payerPhone, fspId:"CLICKPESA", transactionId}` | USSD push; transactionId = your ref |
| ✅ | GET /collection/status?transactionId=&fspId= | — | poll until COMPLETED |
| ✅ | GET /collection/transactions?page=&limit= | — | paginated, newest first |

(Path note: api-docs.txt shows `/api/collection/*`; Rafiki calls `${BRIDGE_PAYMENT_URL}/collection/*`, so `/api` is part of the base URL. Confirm exact base on creds handover.)

## Money units — CRITICAL
- WMS amounts: `amountMinor` (integer cents).
- LMS loan `principal`, `transactionAmount`: MAJOR units (e.g. 25000 = 25,000 TZS).
- → 100x disbursement footgun. Per-field unit callouts everywhere; lending recipe soft-blocked on backend normalization.

## Fineract leaks to document honestly (or normalize backend)
- GET customer `.externalData`, GET loan (int `id`, `status.value:"loanStatusType.*"`, `principal` major) return raw Fineract shapes. Document the real shape Rafiki consumes.

## Verified live (2026-05-20, sandbox `2c0219b4-...`, `services.finance.reli.co.tz/api`)
- Auth + reads (products, payment-types): PASS.
- KYC: dedup-by-phone (returns **200 + null body** when new, not 404) → upsert → activate: PASS.
- Lending/BNPL via **link strategy** (open wallet `SAV2` → approve → activate → loan `DF-001` with `linkWalletId` → approve → disburse-to-savings → schedule): **PASS 14/14**.
- **standalone** (loan only → disburse): PASS.
- **`createWalletProductCode` auto-provision (Strategy C): FAILS** — backend `500 22P02 invalid input syntax for type uuid: "provisioned"`. Isolated to that path; independent of product/fund config. BACKEND BUG.
- Loan products must be `status: "published"` (DG30/DF-001 published; RELI_LOAN draft). Loan products with `requiresAccounting:true` need an `fspFundId` (DG30 fund=null → opaque "Failed to create loan"; DF-001 fund=2 → works).
- Disbursed loans can't be undone (`undo-disbursement`/`undo-approval`/`withdraw` → 400). Residual sandbox records expected.

## Reconciliation TODO (on creds/URL handover, Phase 4)
- Fetch live `/docs/json` from both services; diff against this contract; confirm `◻️ documented-only` extras (keep or cut); confirm collections base path (`/api`), and whether collections has its own swagger.
