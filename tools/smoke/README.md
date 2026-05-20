# Smoke runner

Proves the documented Bridge APIs actually work against a sandbox business. Credentials come from env — never hardcoded, never committed, never logged (the secret + Bearer token are redacted in output).

## Run

```bash
export BRIDGE_BAAS_URL="https://services.finance.reli.co.tz/api"
export BRIDGE_BAAS_KEY_ID="<sandbox-key-id>"
export BRIDGE_BAAS_SECRET="<sandbox-secret>"

# Read-only (safe): auth + product/payment-type reads
node tools/smoke/smoke.mjs

# Full E2E (mutating, sandbox only): customer -> loan + wallet -> approve -> disburse -> schedule, then best-effort cleanup
node tools/smoke/smoke.mjs --full
```

## Guarantees / guardrails
- **Sandbox guard**: `--full` refuses to run unless the token reports `environment: "sandbox"`.
- **Idempotency**: each run uses a unique customer mobile (`runId`), so reruns don't collide.
- **Small amounts**: full mode disburses a tiny principal (1,000 major units).
- **Cleanup**: best-effort `undo-disbursement` / `undo-approval` / `withdraw`. Ledger entries are not deletable — expect residual sandbox records.

## Targeting products + loan strategy

```bash
BRIDGE_LOAN_PRODUCT=DF-001 BRIDGE_WALLET_PRODUCT=SAV2 \
BRIDGE_LOAN_STRATEGY=link \           # link (default, verified) | standalone | wallet
node tools/smoke/smoke.mjs --full
```
- `link` — open + activate a wallet, then `linkWalletId` (Strategy B). **Verified end to end.**
- `standalone` — loan only, direct `disburse`. Verified.
- `wallet` — `createWalletProductCode` auto-provision (Strategy C). **Currently fails** with a backend `500` (`invalid input syntax for type uuid: "provisioned"`) — kept so the regression is visible.

If `BRIDGE_LOAN_PRODUCT`/`BRIDGE_WALLET_PRODUCT` are unset, the runner picks the first **published** product.

## Collections
Set `BRIDGE_GATEWAY_URL`, `BRIDGE_GATEWAY_KEY_ID`, `BRIDGE_GATEWAY_SECRET` to extend coverage to `/collection/*`. The gateway is a separate service with its own key (see [Collections recipe](../../recipes/collections.mdx)). Collection checks use a fixed test reference and do not page a real person; do not point them at a live MSISDN without a gateway mock/test mode.

## CI
Run read-only on every push; gate `--full` behind a manual/nightly job (mutations write real sandbox records). Pair with `node tools/drift-check.mjs` (with `BRIDGE_SPEC_URL`) to catch spec drift.
