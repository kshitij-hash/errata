#!/usr/bin/env node
// scripts/license-gate.mjs — fail if any production dependency carries a non-permissive license.
// The JS tree is deliberately MIT/Apache-2.0/BSD/ISC only (no copyleft); this enforces it in CI.
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

function normalize(license) {
  // strip SPDX combinators; treat "(A OR B)" as permissive if any operand is allowed
  return String(license)
    .replace(/[()]/g, '')
    .split(/\s+(?:OR|AND)\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

let raw;
try {
  raw = execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
} catch (e) {
  // pnpm exits non-zero when it has nothing to report on some versions; treat empty as clean
  raw = e.stdout?.toString() ?? '';
}

const data = raw.trim() ? JSON.parse(raw) : {};
// pnpm emits either { "<license>": [ {name,...} ] } or an array of package records
const violations = [];
const check = (license, pkg) => {
  const parts = normalize(license);
  if (parts.length && !parts.some((p) => ALLOW.has(p))) violations.push(`${pkg} → ${license}`);
};

if (Array.isArray(data)) {
  for (const rec of data) check(rec.license ?? rec.licenses ?? 'UNKNOWN', rec.name ?? '?');
} else {
  for (const [license, pkgs] of Object.entries(data)) {
    for (const p of pkgs) check(license, p.name ?? p.from ?? '?');
  }
}

if (violations.length) {
  console.error('::error::non-permissive licenses found:\n' + violations.join('\n'));
  process.exit(1);
}
console.log('license gate: all production dependencies are permissively licensed');
