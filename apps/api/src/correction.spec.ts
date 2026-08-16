// The append-only correction write path, against a stubbed GraphClient: the assertions are on the
// EXACT rows that reach the loader, because the invariant this route has to keep ("nothing is ever
// mutated or deleted") is a property of those rows and nothing else.

import { describe, it, expect } from 'vitest';
import { keys, vid } from '@errata/graph';
import { NORM_VERSION } from '@errata/ingest';
import type { EdgeBatch, NodeBatch, Stmt } from '@errata/graph';
import { CorrectionError, correctionWrite } from './correction.js';
import type { WriteClient } from './correction.js';

const HISTORY = 'demo_h';
const SUBJECT = 'the user';
const ATTRIBUTE = 'mortgage_preapproval_amount';
const AT_MS = 1_786_900_000_000;

const entityKey = keys.entity(HISTORY, SUBJECT);
const entityId = vid(entityKey);

const OLDER_KEY = keys.claim(HISTORY, SUBJECT, ATTRIBUTE, '350000 usd', 3, 2, NORM_VERSION);
const HEAD_KEY = keys.claim(HISTORY, SUBJECT, ATTRIBUTE, '400000 usd', 31, 0, NORM_VERSION);
const OLDER_ID = vid(OLDER_KEY);
const HEAD_ID = vid(HEAD_KEY);

function claimRow(id: number, key: string, value: string, valueNorm: string, eventTime: number, turnIndex: number) {
  return {
    claim_id: id, claim_key: key, value, value_norm: valueNorm, attribute: ATTRIBUTE,
    arity: 'FUNCTIONAL', polarity: 'AFFIRM', event_time: eventTime, ingest_time: 1_786_800_000,
    confidence: 0.8, provenance: 'EXTRACTED', judge_status: 'NONE', session_id: 's31',
    turn_id: `s31:${turnIndex}`, turn_index: turnIndex, evidence_span: `I got pre-approved for ${value}`,
  };
}

const CLAIMS = [
  claimRow(OLDER_ID, OLDER_KEY, '$350,000', '350000 usd', 1_691_712_000, 2),
  claimRow(HEAD_ID, HEAD_KEY, '$400,000', '400000 usd', 1_701_304_560, 0),
];
const SUPERSEDES_EDGES = [
  { newer_id: HEAD_ID, older_id: OLDER_ID, ingest_time: 1_786_800_000, confidence: 0.7, provenance: 'INFERRED', judge_status: 'NONE', rationale: 'later statement supersedes earlier' },
];

interface Stub extends WriteClient {
  reads: Stmt[];
  written: { nodes: NodeBatch[]; edges: EdgeBatch[] }[];
}

function stub(claims: Record<string, unknown>[] = CLAIMS): Stub {
  const reads: Stmt[] = [];
  const written: { nodes: NodeBatch[]; edges: EdgeBatch[] }[] = [];
  return {
    reads,
    written,
    async read(stmt: Stmt) {
      reads.push(stmt);
      if (stmt.text.startsWith('MATCH (c:Claim)')) return claims;
      if (stmt.text.includes('[r:SUPERSEDES]')) return SUPERSEDES_EDGES;
      return [];
    },
    async loadTwoPhase(nodes: NodeBatch[], edges: EdgeBatch[]) {
      written.push({ nodes, edges });
      return { nodeBatches: nodes.length, edgeBatches: edges.length };
    },
  };
}

const req = (over: Record<string, unknown> = {}) => ({
  historyId: HISTORY, subject: SUBJECT, attribute: ATTRIBUTE, value: '$425,000', atMillis: AT_MS, ...over,
});

describe('POST /api/correction — the rows it appends', () => {
  it('writes exactly one Claim vertex and two edges (ABOUT + SUPERSEDES), nothing else', async () => {
    const s = stub();
    const out = await correctionWrite(s, req());

    expect(s.written).toHaveLength(1);
    const { nodes, edges } = s.written[0]!;
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.label).toBe('Claim');
    expect(nodes[0]!.rows).toHaveLength(1);
    expect(edges.map((e) => e.type)).toEqual(['ABOUT', 'SUPERSEDES']);
    expect(edges.every((e) => e.rows.length === 1)).toBe(true);

    // no Entity/Session/Turn/Speaker row, and no write touches the displaced claim's vertex
    expect(nodes.some((n) => n.label !== 'Claim')).toBe(false);
    expect(nodes[0]!.rows.some((r) => r.id === HEAD_ID || r.id === OLDER_ID)).toBe(false);
    expect(out.appended).toBe(true);
  });

  it('the appended Claim row carries the exact user-correction provenance fields', async () => {
    const s = stub();
    const out = await correctionWrite(s, req());
    const row = s.written[0]!.nodes[0]!.rows[0]!;

    const expectedKey = keys.correction(HISTORY, SUBJECT, ATTRIBUTE, '425000 usd', HEAD_ID, AT_MS, NORM_VERSION);
    expect(row).toEqual({
      id: vid(expectedKey),
      key: expectedKey,
      history_id: HISTORY,
      subject: SUBJECT,
      subject_norm: SUBJECT,
      attribute: ATTRIBUTE,
      arity: 'FUNCTIONAL',
      attribute_registered: true,
      value_text: '$425,000',
      value_norm: '425000 usd', // normValue canonicalizes the amount (NORM_VERSION 2)
      polarity: 'AFFIRM',
      event_time: Math.floor(AT_MS / 1000),
      event_time_iso: '2026-08-16',
      ingest_time: Math.floor(AT_MS / 1000),
      time_basis: 'EXPLICIT',
      confidence: 0.99,
      provenance: 'EXTRACTED',
      session_id: 'user-correction',
      turn_id: 'user-correction:-1',
      turn_index: -1,
      evidence_span: 'corrected by the user to $425,000',
      extractor_model: 'user-correction',
      judge_status: 'NONE',
      run_id: `correction-${AT_MS}`,
    });
    expect(out.claim_id).toBe(vid(expectedKey));
    expect(Number.isSafeInteger(out.claim_id)).toBe(true);
    expect(out.claim_id).toBeLessThan(2 ** 53); // 53-bit id via packages/graph
  });

  it('the SUPERSEDES edge points from the new claim to the current head, at 0.99', async () => {
    const s = stub();
    const out = await correctionWrite(s, req());
    const edgeRow = s.written[0]!.edges[1]!.rows[0]!;
    const claimKey = String(s.written[0]!.nodes[0]!.rows[0]!.key);
    const expectedKey = keys.edge('SUPERSEDES', claimKey, HEAD_KEY);

    expect(edgeRow).toEqual({
      id: vid(expectedKey),
      key: expectedKey,
      src: out.claim_id,
      dst: HEAD_ID,
      history_id: HISTORY,
      judge_status: 'NONE',
      judge_model: '',
      rationale: 'user correction supersedes the current head claim',
      event_time: Math.floor(AT_MS / 1000),
      event_time_iso: '2026-08-16',
      ingest_time: Math.floor(AT_MS / 1000),
      confidence: 0.99,
      provenance: 'EXTRACTED',
      run_id: `correction-${AT_MS}`,
    });
    expect(out.edge_id).toBe(vid(expectedKey));
    expect(out.supersedes_claim_id).toBe(HEAD_ID);
  });

  it('the ABOUT edge anchors the new claim on the existing subject Entity', async () => {
    const s = stub();
    const out = await correctionWrite(s, req());
    const aboutRow = s.written[0]!.edges[0]!.rows[0]!;
    expect(aboutRow.src).toBe(out.claim_id);
    expect(aboutRow.dst).toBe(entityId);
    expect(aboutRow.role).toBe('SUBJECT');
  });

  it('supersedes the caller-named claim when supersedes_claim_id is given', async () => {
    const s = stub();
    const out = await correctionWrite(s, req({ supersedes_claim_id: OLDER_ID }));
    expect(out.supersedes_claim_id).toBe(OLDER_ID);
    expect(s.written[0]!.edges[1]!.rows[0]!.dst).toBe(OLDER_ID);
  });

  it('a repeat correction APPENDS again — a second, distinct claim vertex', async () => {
    const s = stub();
    const first = await correctionWrite(s, req());
    const second = await correctionWrite(s, req({ atMillis: AT_MS + 1000 }));
    expect(second.claim_id).not.toBe(first.claim_id);
    expect(second.edge_id).not.toBe(first.edge_id);
    expect(s.written).toHaveLength(2);
    // and the second write is still one vertex + two edges — nothing is rewritten
    expect(s.written[1]!.nodes[0]!.rows).toHaveLength(1);
  });

  it('never emits a mutating or deleting statement — the loader only ever receives batches', async () => {
    const s = stub();
    await correctionWrite(s, req());
    // reads are the four belief statements; no read is a write, and no DELETE/REMOVE is built here
    expect(s.reads).toHaveLength(4);
    expect(s.reads[0]!.text.startsWith('MATCH (c:Claim)')).toBe(true); // the validating read runs first
    for (const r of s.reads) {
      expect(r.text).not.toMatch(/\b(DELETE|REMOVE|DETACH)\b/i);
      expect(r.text.startsWith('MATCH ')).toBe(true);
    }
  });

  it('rejects an unknown subject/attribute with 404, before reading anything else', async () => {
    const s = stub([]);
    await expect(correctionWrite(s, req())).rejects.toMatchObject({
      name: 'CorrectionError',
      status: 404,
    });
    expect(s.written).toHaveLength(0);
    expect(s.reads).toHaveLength(1);
  });

  it('rejects a supersedes_claim_id outside this chain with 409', async () => {
    const s = stub();
    const err = await correctionWrite(s, req({ supersedes_claim_id: 12345 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CorrectionError);
    expect((err as CorrectionError).status).toBe(409);
    expect(s.written).toHaveLength(0);
  });
});
