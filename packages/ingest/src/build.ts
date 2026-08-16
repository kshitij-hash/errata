// packages/ingest/src/build.ts — claims, entities, and revision edges (spec 31 §3 S4-S6, §3.5).
//
// The extractor produces (subject, attribute, value, citation) tuples; here we normalize them,
// mint ids, build Claim/Entity nodes with ABOUT + STATED_IN edges, and derive revision edges via
// the conflict step. Without OpenRouter credits the conflict step uses a DETERMINISTIC temporal
// rule (later event supersedes earlier); the LLM judge replaces exactly this function when funded.
// Nothing is ever dropped — an unresolved conflict becomes a low-confidence CONTRADICTS (ADR-11).

import { keys, vid } from '@errata/graph';
import type { EdgeBatch, NodeBatch } from '@errata/graph';
import { resolveAttribute } from '@errata/core';
import type { Arity, Relation, TimeBasis } from '@errata/core';
import type { History } from './reader.js';
import type { ExtractedClaim } from './extract.js';
import { NORM_VERSION, epochToIso, isoToEpoch, normText, normValue } from './text.js';

const SELF = new Set(['the user', 'i', 'me', 'user', 'myself', 'my']);

export interface PreparedClaim {
  claimId: number;
  claimKey: string;
  subject: string;
  subjectNorm: string;
  attribute: string;
  arity: Arity;
  registered: boolean;
  value: string;
  valueNorm: string;
  polarity: 'AFFIRM' | 'NEGATE';
  eventTime: number;
  eventTimeIso: string;
  timeBasis: TimeBasis;
  sessionId: string;
  ordinal: number; // session position — the identity that keys sessions/turns/claims
  turnIdx: number;
  turnId: string;
  evidenceSpan: string;
  confidence: number;
}

export interface RevisionEdgeSpec {
  type: Relation;
  newerKey: string;
  newerId: number;
  olderKey: string;
  olderId: number;
  judge_status: string;
  judge_model: string;
  rationale: string;
  confidence: number;
  provenance: 'EXTRACTED' | 'INFERRED';
}

function isProperNoun(v: string): boolean {
  return /^[A-Z][A-Za-z]/.test(v.trim()) && /[A-Za-z]{2}/.test(v) && !/^\$?\d/.test(v.trim());
}
function etypeOf(norm: string): string {
  if (SELF.has(norm)) return 'SELF';
  return 'ORG';
}

/** Normalize + mint ids for extracted claims against a history (S4 input). */
export function prepareClaims(history: History, extracted: ExtractedClaim[]): PreparedClaim[] {
  const byOrdinal = new Map(history.sessions.map((s) => [s.ordinal, s]));
  // first-occurrence fallback for extractors that only report session_id (not the ordinal)
  const firstOrdinal = new Map<string, number>();
  for (const s of history.sessions) if (!firstOrdinal.has(s.sessionId)) firstOrdinal.set(s.sessionId, s.ordinal);

  const out: PreparedClaim[] = [];
  for (const c of extracted) {
    const subjectNorm = normText(c.subject);
    if (!subjectNorm) continue;
    const { name: attribute, arity, registered } = resolveAttribute(c.attribute);
    const valueNorm = normValue(c.value);
    if (!valueNorm) continue;
    const ordinal = c.sessionOrdinal ?? firstOrdinal.get(c.sessionId) ?? 0;
    const session = byOrdinal.get(ordinal);
    let eventTime: number;
    let eventTimeIso: string;
    let timeBasis: TimeBasis;
    if (c.eventTimeIso) {
      eventTime = isoToEpoch(c.eventTimeIso);
      eventTimeIso = c.eventTimeIso;
      timeBasis = 'EXPLICIT';
    } else {
      eventTime = session?.epoch ?? -1;
      eventTimeIso = session?.dateIso ?? '';
      timeBasis = eventTime > -1 ? 'SESSION_DATE' : 'UNKNOWN';
    }
    const claimKey = keys.claim(history.historyId, subjectNorm, attribute, valueNorm, ordinal, c.turnIdx, NORM_VERSION);
    out.push({
      claimId: vid(claimKey),
      claimKey,
      subject: c.subject,
      subjectNorm,
      attribute,
      arity,
      registered,
      value: c.value,
      valueNorm,
      polarity: c.polarity,
      eventTime,
      eventTimeIso,
      timeBasis,
      sessionId: c.sessionId,
      ordinal,
      turnIdx: c.turnIdx,
      turnId: `${c.sessionId}:${c.turnIdx}`,
      evidenceSpan: c.evidenceSpan,
      confidence: c.confidence,
    });
  }
  return out;
}

/** Deterministic conflict resolution → revision edges (spec 31 §3.5, no-LLM path). */
export function resolveConflicts(prepared: PreparedClaim[]): RevisionEdgeSpec[] {
  const edges: RevisionEdgeSpec[] = [];
  const groups = new Map<string, PreparedClaim[]>();
  for (const c of prepared) {
    const k = `${c.subjectNorm}\u0000${c.attribute}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(c);
  }
  const byEvent = (a: PreparedClaim, b: PreparedClaim): number =>
    a.eventTime - b.eventTime || a.claimId - b.claimId;

  for (const group of groups.values()) {
    const sorted = group.slice().sort(byEvent);
    const arity = sorted[0]!.arity;
    if (arity === 'FUNCTIONAL') {
      let head = sorted[0]!;
      for (let i = 1; i < sorted.length; i++) {
        const cur = sorted[i]!;
        if (cur.valueNorm === head.valueNorm) {
          edges.push(mkEdge('SUPPORTS', cur, head, 'NONE', '', 'same value corroborates', cur.confidence, 'EXTRACTED'));
        } else if (cur.eventTime > head.eventTime && cur.eventTime > -1 && head.eventTime > -1) {
          edges.push(mkEdge('SUPERSEDES', cur, head, 'NONE', '', 'later statement supersedes earlier (temporal rule)', 0.7, 'INFERRED'));
          head = cur;
        } else {
          // same/unknown time and differing value: unresolved — surface it, never drop it.
          edges.push(mkEdge('CONTRADICTS', cur, head, 'UNJUDGED', '', 'differing value, no defensible ordering', 0.1, 'INFERRED'));
        }
      }
    } else {
      // MULTI: AFFIRM values coexist; a NEGATE matching a member supersedes that member.
      const members = sorted.filter((c) => c.polarity === 'AFFIRM');
      for (const c of sorted) {
        if (c.polarity !== 'NEGATE') continue;
        const target = members.find((m) => m.valueNorm === c.valueNorm && m.eventTime <= c.eventTime);
        if (target) edges.push(mkEdge('SUPERSEDES', c, target, 'NONE', '', 'negation supersedes member', 0.7, 'INFERRED'));
      }
    }
  }
  return edges;
}

function mkEdge(type: Relation, newer: PreparedClaim, older: PreparedClaim, judge_status: string, judge_model: string, rationale: string, confidence: number, provenance: 'EXTRACTED' | 'INFERRED'): RevisionEdgeSpec {
  return { type, newerKey: newer.claimKey, newerId: newer.claimId, olderKey: older.claimKey, olderId: older.claimId, judge_status, judge_model, rationale, confidence, provenance };
}

export interface ClaimBuild {
  nodes: NodeBatch[];
  edges: EdgeBatch[];
  entities: { norm: string; id: number; key: string; etype: string }[];
}

/** Assemble Claim + Entity nodes and ABOUT / STATED_IN / revision edges (S6). */
export function buildClaims(
  history: History,
  prepared: PreparedClaim[],
  revisionEdges: RevisionEdgeSpec[],
  extractorModel: string,
  runId: string,
  ingestTime: number,
): ClaimBuild {
  const h = history.historyId;
  const claimRows: Record<string, unknown>[] = [];
  const entityMap = new Map<string, { norm: string; id: number; key: string; etype: string; name: string; mentions: number }>();
  const about: Record<string, unknown>[] = [];
  const statedIn: Record<string, unknown>[] = [];

  const ensureEntity = (name: string, etype: string): { id: number; key: string; norm: string } => {
    const norm = normText(name);
    let e = entityMap.get(norm);
    if (!e) {
      const key = keys.entity(h, norm);
      e = { norm, id: vid(key), key, etype, name, mentions: 0 };
      entityMap.set(norm, e);
    }
    e.mentions++;
    return { id: e.id, key: e.key, norm: e.norm };
  };

  for (const c of prepared) {
    // Claim node (all properties present — null-free)
    claimRows.push({
      id: c.claimId, key: c.claimKey, history_id: h, subject: c.subject, subject_norm: c.subjectNorm,
      attribute: c.attribute, arity: c.arity, attribute_registered: c.registered, value_text: c.value, value_norm: c.valueNorm,
      polarity: c.polarity, event_time: c.eventTime, event_time_iso: c.eventTimeIso, ingest_time: ingestTime,
      time_basis: c.timeBasis, confidence: c.confidence, provenance: 'EXTRACTED', session_id: c.sessionId, turn_id: c.turnId, turn_index: c.turnIdx,
      evidence_span: c.evidenceSpan, extractor_model: extractorModel, judge_status: 'NONE', run_id: runId,
    });

    // subject entity + ABOUT(SUBJECT)
    const subj = ensureEntity(c.subject, etypeOf(c.subjectNorm));
    about.push(aboutRow(c.claimId, c.claimKey, subj.id, subj.key, 'SUBJECT', h, c.eventTime, c.eventTimeIso, ingestTime, c.confidence, runId));

    // proper-noun value → mention entity + ABOUT(MENTION), so it is retrievable by that name.
    // When the value resolves to the SUBJECT's own entity (e.g. subject "Ethan", value "Ethan"),
    // SUBJECT wins: both rows would share the same edge id (same endpoints) with a differing
    // `role`, and HydraDB rejects the batch as an idempotency-key conflict (G2 sample-150 finding).
    if (isProperNoun(c.value)) {
      const ve = ensureEntity(c.value, 'ORG');
      if (ve.id !== subj.id) {
        about.push(aboutRow(c.claimId, c.claimKey, ve.id, ve.key, 'MENTION', h, c.eventTime, c.eventTimeIso, ingestTime, c.confidence, runId));
      }
    }

    // STATED_IN: Claim → Turn (keyed by session ordinal, matching the structural Turn node)
    const tKey = keys.turn(h, c.ordinal, c.turnIdx);
    const eKey = keys.edge('STATED_IN', c.claimKey, tKey);
    statedIn.push({
      id: vid(eKey), src: c.claimId, dst: vid(tKey), key: eKey, history_id: h,
      event_time: c.eventTime, event_time_iso: c.eventTimeIso, ingest_time: ingestTime, confidence: c.confidence, provenance: 'EXTRACTED', run_id: runId,
    });
  }

  const entityRows: Record<string, unknown>[] = [...entityMap.values()].map((e) => ({
    id: e.id, key: e.key, history_id: h, name: e.name, norm_name: e.norm, etype: e.etype, mention_count: e.mentions,
    event_time: -1, event_time_iso: '', ingest_time: ingestTime, confidence: -1.0, provenance: 'INFERRED', run_id: runId,
  }));

  // revision edge rows, grouped by relation type (each is (Claim,Claim))
  const revRows: Record<Relation, Record<string, unknown>[]> = { SUPERSEDES: [], CONTRADICTS: [], SUPPORTS: [] };
  for (const r of revisionEdges) {
    const eKey = keys.edge(r.type, r.newerKey, r.olderKey);
    revRows[r.type].push({
      id: vid(eKey), src: r.newerId, dst: r.olderId, key: eKey, history_id: h,
      judge_status: r.judge_status, judge_model: r.judge_model, rationale: r.rationale,
      event_time: -1, event_time_iso: '', ingest_time: ingestTime, confidence: r.confidence, provenance: r.provenance, run_id: runId,
    });
  }

  const nodes: NodeBatch[] = [
    { label: 'Entity', rows: entityRows },
    { label: 'Claim', rows: claimRows },
  ];
  const allEdges: EdgeBatch[] = [
    { type: 'ABOUT', srcLabel: 'Claim', dstLabel: 'Entity', rows: about },
    { type: 'STATED_IN', srcLabel: 'Claim', dstLabel: 'Turn', rows: statedIn },
    { type: 'SUPERSEDES', srcLabel: 'Claim', dstLabel: 'Claim', rows: revRows.SUPERSEDES },
    { type: 'CONTRADICTS', srcLabel: 'Claim', dstLabel: 'Claim', rows: revRows.CONTRADICTS },
    { type: 'SUPPORTS', srcLabel: 'Claim', dstLabel: 'Claim', rows: revRows.SUPPORTS },
  ];
  const edges = allEdges.filter((b) => b.rows.length > 0);

  return { nodes, edges, entities: [...entityMap.values()].map((e) => ({ norm: e.norm, id: e.id, key: e.key, etype: e.etype })) };
}

// ---------- user corrections (the ONE mutating HTTP path, apps/api POST /api/correction) ----------
//
// A correction is not a new kind of write: it is the SAME append the extractor performs, with the
// user as the extractor. It emits exactly two rows — one Claim vertex and one SUPERSEDES edge to
// the claim it displaces — and they go through `GraphClient.loadTwoPhase` like every other batch.
// Nothing is updated in place, nothing is deleted; the displaced claim keeps its vertex, its
// citation and its confidence, and only gains an inbound revision edge.

/** provenance is EXTRACTED (a person asserted it), and the "extractor" is named as such. */
export const CORRECTION_MODEL = 'user-correction';
export const CORRECTION_CONFIDENCE = 0.99;
/** corrections have no transcript turn; the citation is the correction itself (turn_index = -1). */
export const CORRECTION_SESSION_ID = 'user-correction';

export interface CorrectionInput {
  historyId: string;
  /** surface form of the subject, as the answer resolved it */
  subject: string;
  /** normalized subject — must equal the target Entity's norm_name */
  subjectNorm: string;
  /** the subject Entity vertex id (already present; corrections never mint entities) */
  entityId: number;
  entityKey: string;
  /** canonical attribute name (already registry-resolved by the caller's normalizer) */
  attribute: string;
  /** the corrected value, verbatim as the user typed it */
  value: string;
  /** the current head claim this correction displaces */
  supersedesClaimId: number;
  supersedesClaimKey: string;
  /** wall-clock of the correction, ms since epoch (identity + event_time) */
  atMillis: number;
}

export interface CorrectionBuild {
  nodes: NodeBatch[];
  edges: EdgeBatch[];
  claimId: number;
  claimKey: string;
  edgeId: number;
  eventTime: number;
  runId: string;
}

/** Assemble the two rows a user correction appends: the Claim, and its SUPERSEDES edge. */
export function buildCorrection(input: CorrectionInput): CorrectionBuild {
  const h = input.historyId;
  const valueNorm = normValue(input.value);
  if (!valueNorm) throw new Error('buildCorrection: value normalizes to empty');
  const eventTime = Math.floor(input.atMillis / 1000);
  const eventTimeIso = epochToIso(eventTime);
  const { name: attribute, arity, registered } = resolveAttribute(input.attribute);
  const claimKey = keys.correction(h, input.subjectNorm, attribute, valueNorm, input.supersedesClaimId, input.atMillis, NORM_VERSION);
  const claimId = vid(claimKey);
  const runId = `correction-${input.atMillis}`;

  const claimRow: Record<string, unknown> = {
    id: claimId, key: claimKey, history_id: h, subject: input.subject, subject_norm: input.subjectNorm,
    attribute, arity, attribute_registered: registered, value_text: input.value, value_norm: valueNorm,
    polarity: 'AFFIRM', event_time: eventTime, event_time_iso: eventTimeIso, ingest_time: eventTime,
    time_basis: 'EXPLICIT', confidence: CORRECTION_CONFIDENCE, provenance: 'EXTRACTED',
    session_id: CORRECTION_SESSION_ID, turn_id: `${CORRECTION_SESSION_ID}:-1`, turn_index: -1,
    evidence_span: `corrected by the user to ${input.value}`, extractor_model: CORRECTION_MODEL,
    judge_status: 'NONE', run_id: runId,
  };

  // ABOUT(SUBJECT) is what makes the appended claim visible to the belief read, which is anchored
  // on the Entity. The Entity itself is NOT written — corrections attach to an entity that exists.
  const aboutKey = keys.edge('ABOUT', claimKey, input.entityKey);
  const aboutRowOut: Record<string, unknown> = {
    id: vid(aboutKey), src: claimId, dst: input.entityId, key: aboutKey, history_id: h, role: 'SUBJECT',
    event_time: eventTime, event_time_iso: eventTimeIso, ingest_time: eventTime,
    confidence: CORRECTION_CONFIDENCE, provenance: 'EXTRACTED', run_id: runId,
  };

  const supKey = keys.edge('SUPERSEDES', claimKey, input.supersedesClaimKey);
  const supRow: Record<string, unknown> = {
    id: vid(supKey), src: claimId, dst: input.supersedesClaimId, key: supKey, history_id: h,
    judge_status: 'NONE', judge_model: '', rationale: 'user correction supersedes the current head claim',
    event_time: eventTime, event_time_iso: eventTimeIso, ingest_time: eventTime,
    confidence: CORRECTION_CONFIDENCE, provenance: 'EXTRACTED', run_id: runId,
  };

  return {
    nodes: [{ label: 'Claim', rows: [claimRow] }],
    edges: [
      { type: 'ABOUT', srcLabel: 'Claim', dstLabel: 'Entity', rows: [aboutRowOut] },
      { type: 'SUPERSEDES', srcLabel: 'Claim', dstLabel: 'Claim', rows: [supRow] },
    ],
    claimId,
    claimKey,
    edgeId: vid(supKey),
    eventTime,
    runId,
  };
}

function aboutRow(claimId: number, claimKey: string, entId: number, entKey: string, role: string, h: string, event: number, eventIso: string, ingest: number, conf: number, runId: string): Record<string, unknown> {
  const eKey = keys.edge('ABOUT', claimKey, entKey);
  return {
    id: vid(eKey), src: claimId, dst: entId, key: eKey, history_id: h, role,
    event_time: event, event_time_iso: eventIso, ingest_time: ingest, confidence: conf, provenance: 'EXTRACTED', run_id: runId,
  };
}
