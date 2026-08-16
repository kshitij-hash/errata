// apps/api/src/turns.ts — transcript context for a citation (blocker B2). READ-ONLY.
//
// `/api/belief`, `/api/diff` and `/api/ask` hand back a positional citation and the evidence span,
// but never the transcript around it. This returns the cited turn ± `radius` neighbours so the
// source column can read as a transcript instead of a lone line.
//
// The read is id-anchored, never a scan: a Turn's identity is `h:<history>|s:<ordinal>|t:<idx>`,
// so once the anchor's session ORDINAL is known every neighbour's id is a pure function and the
// window is fetched as bounded id-pinned UNION arms (packages/graph `turnsByIds`). The ordinal is
// resolved, in order of preference: from `claim_id` (one id-anchored hop via `turnForClaim`), from
// an explicit `session_ordinal`, or — last resort — from a bounded Session lookup by session_id.

import { keys, sessionsByExternalId, turnForClaim, turnsByIds, vid } from '@errata/graph';
import type { Stmt } from '@errata/graph';
import type { GraphClient } from '@errata/graph';

export const DEFAULT_RADIUS = 2;
export const MAX_RADIUS = 7; // 2*7+1 = 15 turns ≤ TURN_WINDOW_MAX

export interface TurnRow {
  turn_id: string;
  session_id: string;
  turn_index: number;
  role: string;
  text: string;
  event_time: number;
  event_time_iso: string;
  /** true for the turn the citation actually points at */
  anchor: boolean;
}

export interface TurnsQuery {
  historyId: string;
  sessionId: string;
  aroundTurn: number;
  radius?: number;
  /** id-anchored fast path: resolve the session ordinal from the citing claim */
  claimId?: number;
  /** caller already knows the positional session ordinal (the web app's pinned session config) */
  sessionOrdinal?: number;
  explain?: boolean;
}

export interface TurnsResult {
  history_id: string;
  session_id: string;
  session_ordinal: number;
  around_turn: number;
  radius: number;
  turns: TurnRow[];
  cypher?: { text: string; params: Record<string, unknown> }[];
}

/** The turn's natural key `h:<history>|s:<ordinal>|t:<idx>` → the session ordinal, or null. */
export function ordinalFromTurnKey(turnKey: string, historyId: string): number | null {
  const m = new RegExp(`^h:${historyId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\|s:(\\d+)\\|t:\\d+$`).exec(turnKey);
  return m ? Number(m[1]) : null;
}

function shape(row: Record<string, unknown>, anchorIdx: number): TurnRow {
  const idx = Number(row.turn_idx);
  return {
    turn_id: String(row.turn_id ?? ''),
    session_id: String(row.session_id ?? ''),
    turn_index: idx,
    role: String(row.role ?? ''),
    text: String(row.text ?? ''),
    event_time: Number(row.event_time ?? -1),
    event_time_iso: String(row.event_time_iso ?? ''),
    anchor: idx === anchorIdx,
  };
}

export async function turnsQuery(client: GraphClient, q: TurnsQuery): Promise<TurnsResult> {
  const sink: { text: string; params: Record<string, unknown> }[] | undefined = q.explain ? [] : undefined;
  const run = async (stmt: Stmt): Promise<Record<string, unknown>[]> => {
    sink?.push({ text: stmt.text, params: stmt.params });
    return client.read(stmt);
  };
  const radius = Math.max(0, Math.min(q.radius ?? DEFAULT_RADIUS, MAX_RADIUS));

  let ordinal = q.sessionOrdinal ?? -1;
  let around = q.aroundTurn;
  let sessionId = q.sessionId;

  if (q.claimId != null) {
    const rows = await run(turnForClaim(q.claimId));
    const r = rows[0];
    if (r) {
      const fromKey = ordinalFromTurnKey(String(r.turn_key ?? ''), q.historyId);
      if (fromKey != null) ordinal = fromKey;
      around = Number(r.turn_idx);
      sessionId = String(r.session_id ?? sessionId);
    }
  }

  if (ordinal < 0) {
    const rows = await run(sessionsByExternalId(q.historyId, sessionId));
    // session_id is not unique corpus-wide; within one history the first ordinal is the citation's
    // session unless the history itself reuses the id, in which case the caller must pass one.
    if (rows.length > 0) ordinal = Number(rows[0]!.ordinal);
  }

  if (ordinal < 0 || !Number.isFinite(around)) {
    return { history_id: q.historyId, session_id: sessionId, session_ordinal: ordinal, around_turn: around, radius, turns: [], ...(sink ? { cypher: sink } : {}) };
  }

  const wanted: number[] = [];
  for (let i = around - radius; i <= around + radius; i++) if (i >= 0) wanted.push(i);
  const ids = wanted.map((i) => vid(keys.turn(q.historyId, ordinal, i)));
  const rows = ids.length > 0 ? await run(turnsByIds(ids)) : [];

  const turns = rows.map((r) => shape(r, around)).sort((a, b) => a.turn_index - b.turn_index);
  return {
    history_id: q.historyId,
    session_id: sessionId,
    session_ordinal: ordinal,
    around_turn: around,
    radius,
    turns,
    ...(sink ? { cypher: sink } : {}),
  };
}
