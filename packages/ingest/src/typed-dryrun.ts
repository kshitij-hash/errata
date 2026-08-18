#!/usr/bin/env node
// errata-typed-dryrun — run the typed pass over real histories and print what it WOULD write.
//
//   errata-typed-dryrun 85fa3a3f 031748ae            two histories, per-family counts
//   errata-typed-dryrun --ids-file eval/sample-150.json --limit 20
//   errata-typed-dryrun 85fa3a3f --samples 8         also print example claims
//   errata-typed-dryrun --all --limit 150 --tsv      one row per history, for a spreadsheet
//   errata-typed-dryrun 85fa3a3f --families money,date,relative_time,duration,time   (drop lists)
//
// This file deliberately imports NOTHING from @errata/graph and NOTHING from @errata/llm. It cannot
// open a Bolt session, it cannot spend a token, and it writes no file. The whole point is to size
// the claim-count multiplier BEFORE anyone applies the pass to a live graph.

import { readFileSync } from 'node:fs';
import { parseHistory, turnCount } from './reader.js';
import type { RawRecord } from './reader.js';
import { buildClaims, prepareClaims, resolveConflicts } from './build.js';
import { ALL_FAMILIES, extractTyped, summarizeTyped } from './typed.js';
import type { TypedClaim, TypedFamily, TypedOptions } from './typed.js';

const FAMILIES = ALL_FAMILIES;

function arg(name: string, fallback = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

function main(): void {
  const file = arg('file', 'data-raw/longmemeval_s_cleaned.json');
  const limit = Number(arg('limit', '0')) || 0;
  const samples = Number(arg('samples', '0')) || 0;
  const tsv = has('tsv');
  const familyArg = arg('families');
  const opts: TypedOptions = familyArg ? { families: familyArg.split(',').map((s) => s.trim()) as TypedFamily[] } : {};

  const idsFile = arg('ids-file');
  const cliIds = process.argv.slice(2).filter((a) => !a.startsWith('--') && !isFlagValue(a));
  const wanted = new Set<string>(
    idsFile ? (JSON.parse(readFileSync(idsFile, 'utf8')) as string[]) : cliIds,
  );
  if (!has('all') && wanted.size === 0) {
    console.error('usage: errata-typed-dryrun <history_id…> | --ids-file <json-array> | --all [--limit n] [--samples n] [--tsv]');
    process.exit(1);
  }

  const corpus = JSON.parse(readFileSync(file, 'utf8')) as RawRecord[];
  let records = has('all') ? corpus : corpus.filter((r) => wanted.has(r.question_id));
  if (limit > 0) records = records.slice(0, limit);
  if (records.length === 0) {
    console.error(`no matching histories in ${file}`);
    process.exit(1);
  }

  if (tsv) console.log(['history_id', 'sessions', 'turns', ...FAMILIES, 'typed_claims', 'claim_rows', 'entities', 'edges', 'revision_edges', 'resolved', 'rows_per_turn'].join('\t'));

  const totals: Record<string, number> = {};
  let allTurns = 0;
  let allClaims = 0;
  let allPrepared = 0;
  let allResolved = 0;
  let allEntities = 0;
  let allEdges = 0;
  let allRevision = 0;

  for (const rec of records) {
    const history = parseHistory(rec);
    const claims = extractTyped(history, opts);
    // prepareClaims is the real gate: it drops empty-normalizing values and collapses claims that
    // would MERGE onto one vertex, so ITS count is the number of Claim rows a load would write.
    const prepared = prepareClaims(history, claims);
    // ...and buildClaims is what sizes the WRITE: entity vertices and ABOUT/STATED_IN edge rows.
    // `resolveConflicts` runs here purely to prove the claim of this pass: a typed-only run must
    // produce ZERO revision edges, because every typed attribute is unregistered → MULTI.
    const revision = resolveConflicts(prepared);
    const built = buildClaims(history, prepared, revision, 'dryrun', 'dryrun', 0);
    const edgeRows = built.edges.reduce((n, b) => n + b.rows.length, 0);
    const summary = summarizeTyped(claims);
    const turns = turnCount(history);
    const resolved = claims.filter((c) => c.resolved).length;

    allTurns += turns;
    allClaims += claims.length;
    allPrepared += prepared.length;
    allResolved += resolved;
    allEntities += built.entities.length;
    allEdges += edgeRows;
    allRevision += revision.length;
    for (const f of FAMILIES) totals[f] = (totals[f] ?? 0) + summary[f].claims;

    if (tsv) {
      console.log([
        history.historyId, history.sessions.length, turns,
        ...FAMILIES.map((f) => summary[f].claims),
        claims.length, prepared.length, built.entities.length, edgeRows, revision.length, resolved,
        (prepared.length / Math.max(turns, 1)).toFixed(2),
      ].join('\t'));
      continue;
    }

    console.log(`\n${history.historyId} — ${history.sessions.length} sessions, ${turns} turns`);
    for (const f of FAMILIES) {
      const s = summary[f];
      if (s.claims === 0) continue;
      console.log(`  ${f.padEnd(14)} ${String(s.claims).padStart(5)} claims  ${String(s.attributes).padStart(4)} distinct attributes  ${String(s.resolved).padStart(4)} temporally resolved`);
    }
    console.log(`  ${'TOTAL'.padEnd(14)} ${String(claims.length).padStart(5)} typed → ${prepared.length} claim rows, ${built.entities.length} entities, ${edgeRows} edge rows, ${revision.length} revision edges (${(prepared.length / Math.max(turns, 1)).toFixed(1)} claims per turn)`);
    if (samples > 0) printSamples(claims, samples);
  }

  const n = records.length;
  const datedFamilies = allDated(totals);
  console.log(`\n=== ${n} histor${n === 1 ? 'y' : 'ies'} ===`);
  for (const f of FAMILIES) console.log(`  ${f.padEnd(14)} ${String(totals[f] ?? 0).padStart(7)}  (${((totals[f] ?? 0) / n).toFixed(1)} per history)`);
  console.log(`  ${'typed claims'.padEnd(14)} ${String(allClaims).padStart(7)}`);
  console.log(`  ${'claim rows'.padEnd(14)} ${String(allPrepared).padStart(7)}  (${(allPrepared / n).toFixed(0)} per history, ${(allPrepared / Math.max(allTurns, 1)).toFixed(2)} per turn)`);
  console.log(`  ${'entity rows'.padEnd(14)} ${String(allEntities).padStart(7)}  (${(allEntities / n).toFixed(0)} per history)`);
  console.log(`  ${'edge rows'.padEnd(14)} ${String(allEdges).padStart(7)}  (${(allEdges / n).toFixed(0)} per history)`);
  console.log(`  ${'revision'.padEnd(14)} ${String(allRevision).padStart(7)}  (MUST be 0: every typed attribute is unregistered → MULTI)`);
  console.log(`  ${'resolved'.padEnd(14)} ${String(allResolved).padStart(7)}  (${((100 * allResolved) / Math.max(datedFamilies, 1)).toFixed(1)}% of the ${datedFamilies} date/relative-time claims carry a computed absolute event_time)`);
  console.log('\nNOTHING WAS WRITTEN. This command has no graph client and no LLM client.');
}

/** the two families that can carry a computed absolute event_time — the denominator for `resolved`. */
function allDated(totals: Record<string, number>): number {
  return (totals['date'] ?? 0) + (totals['relative_time'] ?? 0);
}

/** true when this bare token is the VALUE of a preceding `--flag`, not a history id. */
function isFlagValue(token: string): boolean {
  const i = process.argv.indexOf(token);
  return i > 0 && process.argv[i - 1]!.startsWith('--');
}

function printSamples(claims: readonly TypedClaim[], n: number): void {
  for (const f of FAMILIES) {
    const rows = claims.filter((c) => c.family === f).slice(0, n);
    if (rows.length === 0) continue;
    console.log(`  — ${f} —`);
    for (const c of rows) {
      const when = c.eventTimeIso ? ` event_time=${c.eventTimeIso}` : '';
      console.log(`    (${c.sessionId}:${c.turnIdx}) ${c.subject} · ${c.attribute} = ${JSON.stringify(c.value)}${when}`);
      console.log(`        “${c.evidenceSpan}”`);
    }
  }
}

main();
