// packages/graph/src/ids.ts
//
// THE single place Errata computes vertex and edge ids (CLAUDE.md hard rule 5).
// 53-bit, non-negative, JS-safe, and byte-identical across TS and Python (spec 31 §2.3, ADR-10).
//
//   vid(key) = be_uint64(blake2b(utf8(key), dkLen=8)) >> 11
//
// No key/salt/personalization is passed to blake2b — that is the ONLY configuration under which
// @noble/hashes and Python's hashlib.blake2b(digest_size=8) agree. Parity is pinned by
// fixtures/id-vectors.json, asserted here (vitest) and in eval/ (pytest). A drift fails CI in both.
//
// NB: @noble/hashes v2 exposes blake2b from '@noble/hashes/blake2.js' (v1 used '/blake2b').

import { blake2b } from '@noble/hashes/blake2.js';

const enc = new TextEncoder();

/** blake2b-8 digest of `s` as raw bytes (big-endian on the wire). */
function digest8(s: string): Uint8Array {
  return blake2b(enc.encode(s), { dkLen: 8 });
}

/** 53-bit non-negative integer id for a natural key. Stable across runs, processes, languages. */
export function vid(key: string): number {
  const d = digest8(key);
  let n = 0n;
  for (const b of d) n = (n << 8n) | BigInt(b);
  return Number(n >> 11n); // 64 - 11 = 53 bits → exact in a JS number, JSON, and Python int
}

/** 16-hex (8-byte) blake2b digest used *inside* the Claim natural key (spec 31 §2.2). */
function b16(s: string): string {
  const d = digest8(s);
  let hex = '';
  for (const b of d) hex += b.toString(16).padStart(2, '0');
  return hex;
}

// Natural-key builders. `|` is the field delimiter; free string segments must not contain it or
// two distinct logical keys could render to the same string (e.g. a session id "s3|t:11" would
// collide with turn 11 of session s3). Claim inner fields are hashed, so they are immune, but we
// still guard them to fail loud rather than mint a wrong-vertex id. Inputs here are already
// normalized by the ingest layer; the guard only ever fires on a real bug.
const DELIM = '|';
function seg(label: string, v: string): string {
  if (v.includes(DELIM)) {
    throw new Error(`ids: '${label}' segment must not contain '|' — got ${JSON.stringify(v)}`);
  }
  return v;
}

export const keys = {
  session: (historyId: string, sessionId: string): string =>
    `h:${seg('history_id', historyId)}|s:${seg('session_id', sessionId)}`,

  turn: (historyId: string, sessionId: string, turnIdx: number): string =>
    `h:${seg('history_id', historyId)}|s:${seg('session_id', sessionId)}|t:${turnIdx}`,

  speaker: (historyId: string, role: string): string =>
    `h:${seg('history_id', historyId)}|sp:${seg('role', role)}`,

  entity: (historyId: string, normName: string): string =>
    `h:${seg('history_id', historyId)}|e:${seg('norm_name', normName)}`,

  claim: (
    historyId: string,
    subjectNorm: string,
    attribute: string,
    valueNorm: string,
    sessionId: string,
    turnIdx: number,
  ): string => {
    const inner = `${seg('subject_norm', subjectNorm)}|${seg('attribute', attribute)}|${seg(
      'value_norm',
      valueNorm,
    )}|${seg('session_id', sessionId)}|${turnIdx}`;
    return `h:${seg('history_id', historyId)}|c:${b16(inner)}`;
  },

  // Edge ids are integers too (Day-0 gauntlet law: edge writes are single-statement
  // MERGE (s)-[r:T {id: row.rid}]->(d), so every edge needs an allocated id).
  edge: (type: string, srcKey: string, dstKey: string): string => `edge:${type}:${srcKey}:${dstKey}`,
} as const;

/** Convenience: mint id + carry the key (nodes/edges store their `key` for collision detection). */
export interface Minted {
  readonly id: number;
  readonly key: string;
}
export function mint(key: string): Minted {
  return { id: vid(key), key };
}
