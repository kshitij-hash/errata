#!/usr/bin/env node
// scripts/license-gate.mjs — fail if any production dependency carries a non-permissive license.
// The JS tree is deliberately MIT/Apache-2.0/BSD/ISC only (no copyleft); this enforces it in CI.
// FAIL-CLOSED: if the license listing itself cannot be produced or parsed, the gate fails — a
// broken data source must never read as "clean".
import { execFileSync } from 'node:child_process';

// Permissive licenses, plus WEAK/library copyleft that is fine for dependencies we consume
// unmodified: MPL-2.0 (file-level copyleft, no obligation on our source — lightningcss) and
// LGPL (applies to the dynamically-linked native library only — sharp's libvips). STRONG copyleft
// (GPL-*, AGPL-*) still fails: those would impose obligations on our distributed code.
const ALLOW = new Set([
  'MIT', 'MIT-0', 'ISC', '0BSD', 'BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0',
  'Python-2.0', 'CC0-1.0', 'CC-BY-4.0', 'Unlicense', 'BlueOak-1.0.0', 'WTFPL', 'Zlib',
  'MPL-2.0', 'LGPL-2.1', 'LGPL-2.1-or-later', 'LGPL-3.0', 'LGPL-3.0-or-later',
]);

/** SPDX semantics, not string soup: `A OR B` passes if ANY alternative passes; `A AND B` passes
 *  only if EVERY part is allowed (both licenses apply simultaneously). `WITH <exception>` keeps
 *  the base license id. An empty or unparseable expression is a violation, never a pass. */
function isAllowed(license) {
  const expr = String(license ?? '').replace(/[()]/g, '').trim();
  if (!expr) return false;
  const alternatives = expr.split(/\s+OR\s+/i);
  return alternatives.some((alt) => {
    const parts = alt.split(/\s+AND\s+/i).map((s) => s.replace(/\s+WITH\s+.*$/i, '').trim()).filter(Boolean);
    return parts.length > 0 && parts.every((p) => ALLOW.has(p));
  });
}

let raw = '';
let failed = null;
try {
  raw = execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  // some pnpm versions exit non-zero with the report still on stdout — usable; anything else is a
  // hard failure of the gate's data source.
  raw = e.stdout?.toString() ?? '';
  failed = e;
}

let data;
try {
  data = JSON.parse(raw);
} catch {
  console.error('::error::license gate could not obtain a license report from pnpm — failing closed');
  if (failed) console.error(String(failed.stderr ?? failed.message ?? failed));
  process.exit(1);
}

// pnpm emits either { "<license>": [ {name,...} ] } or an array of package records
const violations = [];
const check = (license, pkg) => {
  if (!isAllowed(license)) violations.push(`${pkg} → ${license || 'UNKNOWN'}`);
};

let checked = 0;
if (Array.isArray(data)) {
  for (const rec of data) {
    check(rec.license ?? rec.licenses ?? '', rec.name ?? '?');
    checked++;
  }
} else {
  for (const [license, pkgs] of Object.entries(data)) {
    for (const p of pkgs) {
      check(license, p.name ?? p.from ?? '?');
      checked++;
    }
  }
}

if (checked === 0) {
  console.error('::error::license gate saw ZERO packages — an empty report is a broken report, failing closed');
  process.exit(1);
}
if (violations.length) {
  console.error('::error::non-permissive licenses found:\n' + violations.join('\n'));
  process.exit(1);
}
console.log(`license gate: all ${checked} production dependency license entries are permissive`);
