// Live integration test against a running HydraDB (docker compose up). Gated on ERRATA_IT=1 so the
// normal `pnpm test` (and CI, which has no HydraDB) skips it. Proves the two Day-0 laws end to end:
// int-choke on write, single-statement edge writes, and a read-back that folds to the right belief.
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveBelief } from '@errata/core';
import type { ClaimRow, RevisionEdgeRow } from '@errata/core';
import { GraphClient, keys, vid, claimsForEntityAttribute, revisionEdgesForEntity } from './index.js';

const RUN = process.env.ERRATA_IT === '1';
const IT = 1_700_000_000;
const H = 'graph_it';

function token(): string {
  return readFileSync('.data/hydra/auth-token', 'utf8').trim();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!RUN)('GraphClient — live round-trip against HydraDB', () => {
  let client: GraphClient;
  const eKey = keys.entity(H, 'the user');
  const eId = vid(eKey);
  const c1Key = keys.claim(H, 'the user', 'employer', 'acme', 0, 0);
  const c1Id = vid(c1Key);
  const c2Key = keys.claim(H, 'the user', 'employer', 'globex', 1, 0);
  const c2Id = vid(c2Key);

  beforeAll(async () => {
    client = new GraphClient({ url: 'bolt://127.0.0.1:7687', token: token() });
    await client.verify();

    const entity = { id: eId, key: eKey, history_id: H, name: 'the user', norm_name: 'the user', etype: 'SELF', mention_count: 2, event_time: -1, event_time_iso: '', ingest_time: IT, confidence: -1.0, provenance: 'INFERRED', run_id: 'it' };
    const claim = (id: number, key: string, value: string, valueNorm: string, sid: string, et: number) => ({ id, key, history_id: H, subject: 'the user', subject_norm: 'the user', attribute: 'employer', arity: 'FUNCTIONAL', attribute_registered: true, value_text: value, value_norm: valueNorm, polarity: 'AFFIRM', event_time: et, event_time_iso: '', ingest_time: IT, time_basis: 'EXPLICIT', confidence: 0.8, provenance: 'EXTRACTED', session_id: sid, turn_id: `${sid}:0`, turn_index: 0, evidence_span: `works at ${value}`, extractor_model: 'replay', judge_status: 'NONE', run_id: 'it' });
    const about = (claimId: number, claimKey: string, et: number) => ({ id: vid(keys.edge('ABOUT', claimKey, eKey)), src: claimId, dst: eId, key: keys.edge('ABOUT', claimKey, eKey), history_id: H, role: 'SUBJECT', event_time: et, event_time_iso: '', ingest_time: IT, confidence: 0.8, provenance: 'EXTRACTED', run_id: 'it' });
    const supersedes = { id: vid(keys.edge('SUPERSEDES', c2Key, c1Key)), src: c2Id, dst: c1Id, key: keys.edge('SUPERSEDES', c2Key, c1Key), history_id: H, judge_status: 'OK', judge_model: 'replay', rationale: 'newer employer', event_time: 200, event_time_iso: '', ingest_time: IT, confidence: 0.9, provenance: 'INFERRED', run_id: 'it' };

    await client.loadTwoPhase(
      [
        { label: 'Entity', rows: [entity] },
        { label: 'Claim', rows: [claim(c1Id, c1Key, 'Acme', 'acme', 's1', 100), claim(c2Id, c2Key, 'Globex', 'globex', 's2', 200)] },
      ],
      [
        { type: 'ABOUT', srcLabel: 'Claim', dstLabel: 'Entity', rows: [about(c1Id, c1Key, 100), about(c2Id, c2Key, 200)] },
        { type: 'SUPERSEDES', srcLabel: 'Claim', dstLabel: 'Claim', rows: [supersedes] },
      ],
    );
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('reads back two claims and one supersession, folding to the current belief (Globex)', async () => {
    // tolerate indexer lag: read until both claims are visible (causal bookmark should suffice)
    let claims: Record<string, unknown>[] = [];
    for (let attempt = 0; attempt < 15; attempt++) {
      claims = await client.read(claimsForEntityAttribute(eId, H, 'employer'));
      if (claims.length >= 2) break;
      await sleep(400);
    }
    expect(claims.length).toBe(2);

    const supRows = await client.read(revisionEdgesForEntity(eId, H, 'employer', 'SUPERSEDES'));
    expect(supRows.length).toBe(1);
    expect(supRows[0]!.newer_id).toBe(c2Id);
    expect(supRows[0]!.older_id).toBe(c1Id);

    const edges: RevisionEdgeRow[] = supRows.map((r) => ({ ...(r as unknown as RevisionEdgeRow), relation: 'SUPERSEDES' }));
    const belief = resolveBelief(claims as unknown as ClaimRow[], edges);
    expect(belief.head?.value).toBe('Globex');
    expect(belief.head?.citation.session_id).toBe('s2');
    expect(belief.chain_len).toBe(2);
    expect(belief.superseded.map((s) => s.value)).toEqual(['Acme']);
  }, 30_000);
});
