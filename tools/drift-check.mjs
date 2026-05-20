#!/usr/bin/env node
// drift-check.mjs — fails CI if a curated allowlist path no longer exists in the
// live BaaS spec, or if the committed openapi.json drops an allowlisted path.
// Network check runs only when BRIDGE_SPEC_URL is set; otherwise it validates the
// committed spec against the allowlist offline.
//
//   BRIDGE_SPEC_URL=https://api.reli.co.tz/docs/json node tools/drift-check.mjs
//
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const allowlist = JSON.parse(readFileSync(join(here, 'allowlist.json'), 'utf8'));
const committed = JSON.parse(readFileSync(join(here, '..', 'api-reference', 'openapi.json'), 'utf8'));

const parse = (entry) => {
  const [method, path] = entry.split(' ');
  return { method: method.toLowerCase(), path };
};
const has = (spec, { method, path }) => Boolean(spec?.paths?.[path]?.[method]);

let failures = [];

// 1) Committed spec must contain every allowlisted + collections path.
for (const entry of [...allowlist.baasPaths, ...allowlist.collectionsSlice]) {
  if (!has(committed, parse(entry))) failures.push(`committed openapi.json missing: ${entry}`);
}

// 2) If a live URL is provided, every baasPath must still exist upstream.
const url = process.env.BRIDGE_SPEC_URL;
if (url) {
  const res = await fetch(url);
  if (!res.ok) { console.error(`Could not fetch live spec (${res.status}) from ${url}`); process.exit(2); }
  const live = await res.json();
  for (const entry of allowlist.baasPaths) {
    if (!has(live, parse(entry))) failures.push(`LIVE spec dropped allowlisted path: ${entry} (rename/removal?)`);
  }
  console.log(`Checked ${allowlist.baasPaths.length} baasPaths against live spec at ${url}`);
} else {
  console.log('BRIDGE_SPEC_URL not set — offline check only (committed spec vs allowlist).');
}

if (failures.length) {
  console.error(`\nDRIFT CHECK FAILED (${failures.length}):`);
  failures.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}
console.log(`Drift check passed: ${allowlist.baasPaths.length + allowlist.collectionsSlice.length} curated paths present.`);
