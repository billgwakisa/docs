#!/usr/bin/env node
// build-spec.mjs — reconciliation helper for the curated spec.
//
// The committed api-reference/openapi.json is the curated, richly-described truth
// (hand-authored from the Phase 0 Rafiki contract). This script does NOT overwrite it.
// Instead it fetches the live /docs/json, filters to the allowlist, and reports:
//   - paths in the allowlist that are missing upstream (drift)
//   - live paths NOT in our allowlist (candidates to expose)
//   - operations whose request/response schemas are EMPTY upstream (annotation grade)
// It writes tools/.live-filtered.json for inspection. Run on creds/URL handover.
//
//   BRIDGE_SPEC_URL=https://api.reli.co.tz/docs/json node tools/build-spec.mjs
//
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const allowlist = JSON.parse(readFileSync(join(here, 'allowlist.json'), 'utf8'));
const url = process.env.BRIDGE_SPEC_URL;
if (!url) { console.error('Set BRIDGE_SPEC_URL=https://<host>/docs/json'); process.exit(2); }

const res = await fetch(url);
if (!res.ok) { console.error(`Fetch failed (${res.status}) from ${url}`); process.exit(2); }
const live = await res.json();

const want = new Set(allowlist.baasPaths.map((e) => e.toUpperCase()));
const livePairs = [];
for (const [path, ops] of Object.entries(live.paths || {})) {
  for (const method of Object.keys(ops)) livePairs.push(`${method.toUpperCase()} ${path}`);
}
const liveSet = new Set(livePairs.map((p) => p.toUpperCase()));

const missingUpstream = [...want].filter((w) => !liveSet.has(w));
const notExposed = livePairs.filter((p) => !want.has(p.toUpperCase()));

// Annotation grade: operations on allowlisted paths with empty req/res schemas.
const thin = [];
for (const entry of allowlist.baasPaths) {
  const [m, path] = entry.split(' ');
  const op = live.paths?.[path]?.[m.toLowerCase()];
  if (!op) continue;
  const reqEmpty = op.requestBody && !JSON.stringify(op.requestBody).includes('schema');
  const resEmpty = op.responses && !Object.values(op.responses).some((r) => JSON.stringify(r).includes('schema') || JSON.stringify(r).includes('example'));
  if (reqEmpty || resEmpty) thin.push(entry);
}

// Filtered live spec for inspection.
const filtered = { ...live, paths: {} };
for (const entry of allowlist.baasPaths) {
  const [m, path] = entry.split(' ');
  if (live.paths?.[path]?.[m.toLowerCase()]) {
    filtered.paths[path] = filtered.paths[path] || {};
    filtered.paths[path][m.toLowerCase()] = live.paths[path][m.toLowerCase()];
  }
}
writeFileSync(join(here, '.live-filtered.json'), JSON.stringify(filtered, null, 2));

console.log(`\n=== build-spec reconciliation (${url}) ===`);
console.log(`Allowlisted baasPaths: ${allowlist.baasPaths.length}`);
console.log(`Missing upstream (DRIFT — fix allowlist or backend): ${missingUpstream.length}`);
missingUpstream.forEach((m) => console.log('  - ' + m));
console.log(`Thin/unannotated upstream (curated spec carries the schema): ${thin.length}`);
thin.forEach((t) => console.log('  ~ ' + t));
console.log(`Live paths NOT exposed (candidates): ${notExposed.length} (see .live-filtered.json)`);
console.log('\nWrote tools/.live-filtered.json. Reconcile any drift into api-reference/openapi.json by hand (curated descriptions/examples are intentional).');
