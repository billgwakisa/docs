# Bridge docs — tools/

Build artifacts for the docs. **Not** part of the Mintlify site (Mintlify only renders files in `docs.json` navigation).

| File | Purpose |
|------|---------|
| `contract.md` | Phase 0 output: the Rafiki-proven contract — the source of truth behind the spec. |
| `allowlist.json` | The curated public surface. BaaS paths are filtered from live `/docs/json`; collections are hand-authored. |
| `build-spec.mjs` | Reconciliation helper: fetch live spec, report drift + thin (unannotated) ops + un-exposed candidates. Does NOT overwrite the curated spec. |
| `drift-check.mjs` | CI gate: fails if a curated path is missing from the committed spec, or (with `BRIDGE_SPEC_URL`) from the live spec. |
| `smoke/` | (Phase 4) E2E smoke runner against a sandbox business. Needs credentials. |

## Usage
```bash
# Offline: verify the committed spec covers the allowlist
node tools/drift-check.mjs

# On creds/URL handover: reconcile against the live API
BRIDGE_SPEC_URL=https://api.reli.co.tz/docs/json node tools/build-spec.mjs
BRIDGE_SPEC_URL=https://api.reli.co.tz/docs/json node tools/drift-check.mjs
```

## Curated spec model
`api-reference/openapi.json` is the curated, richly-described truth (hand-authored from `contract.md`).
The live spec is the upstream; `build-spec.mjs` surfaces divergence but never clobbers the curated
descriptions/examples/unit-callouts. Reconcile drift by hand.
