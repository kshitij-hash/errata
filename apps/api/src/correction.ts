// apps/api/src/correction.ts — the ONE mutating code path behind an HTTP route (blocker B1).
//
// APPEND-ONLY INVARIANT. This module writes exactly two rows: a new Claim vertex, and one
// SUPERSEDES edge from it to the claim it displaces. It never updates a property of an existing
// vertex, never deletes anything, and never re-keys an existing claim. The displaced claim keeps
// its id, its value, its citation and its confidence; it only gains an inbound revision edge — the
// edge IS the history (AGENTS.md). Filing the same correction twice appends a SECOND claim (the
// natural key carries the correction's wall-clock instant), because a repeat correction is a
// second assertion, not an overwrite of the first.
//
// The rows are assembled by `buildCorrection` in @errata/ingest (the same build path the ingest
// CLI uses) and written by `GraphClient.loadTwoPhase` (the same two-phase loader): no Cypher is
// written here, and none is duplicated.

import { z } from 'zod';
import { claimsForEntityAttribute, keys, revisionEdgesForEntity, vid } from '@errata/graph';
import type { EdgeBatch, NodeBatch, Stmt } from '@errata/graph';
import { resolveBelief } from '@errata/core';
import type { ClaimRow, RevisionEdgeRow } from '@errata/core';
import { buildCorrection } from '@errata/ingest';
import { normAttr, normText } from './query.js';

/** The write surface a correction needs — narrower than GraphClient, so tests can stub it. */
export interface WriteClient {
  read(stmt: Stmt): Promise<Record<string, unknown>[]>;
  loadTwoPhase(nodes: NodeBatch[], edges: EdgeBatch[]): Promise<{ nodeBatches: number; edgeBatches: number }>;
}

/** The request contract the web app is already wired to (var/frontend-blockers.md B1). */
export const CorrectionBody = z.object({
  history_id: z.string().min(1).optional(),
  subject: z.string().min(1).max(200),
  attribute: z.string().min(1).max(200),
  value: z.string().min(1).max(500),
  supersedes_claim_id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
export type CorrectionBody = z.infer<typeof CorrectionBody>;

export interface CorrectionResult {
  claim_id: number;
  edge_id: number;
  event_time: number;
  /** the claim this correction supersedes — echoed so the UI can label the slip honestly */
  supersedes_claim_id: number;
  appended: true;
}

/** A rejection carrying the HTTP status the route should answer with. */
export class CorrectionError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.status = status;
    this.name = 'CorrectionError';
  }
}

export interface CorrectionQuery extends CorrectionBody {
  historyId: string;
  /** wall-clock injection point; defaults to now (the test pins it) */
  atMillis?: number;
}

export async function correctionWrite(client: WriteClient, q: CorrectionQuery): Promise<CorrectionResult> {
  const historyId = q.historyId;
  const subjectNorm = normText(q.subject);
  const attribute = normAttr(q.attribute);
  if (!subjectNorm) throw new CorrectionError(400, 'subject normalizes to empty');
  if (!attribute) throw new CorrectionError(400, 'attribute normalizes to empty');

  const entityKey = keys.entity(historyId, subjectNorm);
  const entityId = vid(entityKey);

  // An unknown subject and an unknown attribute both surface as "no claims at this anchor": a
  // correction may only displace a belief this history actually holds. The validating read runs
  // FIRST and alone — both because there is nothing to fetch edges for if it comes back empty, and
  // because opening four Bolt sessions concurrently on a cold pool trips the driver's v2 handshake
  // anomaly (docs/gauntlets.md G1); one read warms the pool before the parallel fan-out.
  const claims = (await client.read(claimsForEntityAttribute(entityId, historyId, attribute))) as unknown as ClaimRow[];
  if (claims.length === 0) {
    throw new CorrectionError(
      404,
      `unknown subject/attribute for this history: no claim about '${subjectNorm}' with attribute '${attribute}' in ${historyId}`,
    );
  }
  const [supRows, conRows, sptRows] = await Promise.all([
    client.read(revisionEdgesForEntity(entityId, historyId, attribute, 'SUPERSEDES')),
    client.read(revisionEdgesForEntity(entityId, historyId, attribute, 'CONTRADICTS')),
    client.read(revisionEdgesForEntity(entityId, historyId, attribute, 'SUPPORTS')),
  ]);

  const tag = (rows: Record<string, unknown>[], relation: RevisionEdgeRow['relation']): RevisionEdgeRow[] =>
    rows.map((r) => ({ ...(r as unknown as RevisionEdgeRow), relation }));
  const edges = [...tag(supRows, 'SUPERSEDES'), ...tag(conRows, 'CONTRADICTS'), ...tag(sptRows, 'SUPPORTS')];

  // the claim being displaced: the caller's explicit target, else the current head of the chain
  let target: ClaimRow | undefined;
  if (q.supersedes_claim_id != null) {
    target = claims.find((c) => c.claim_id === q.supersedes_claim_id);
    if (!target) {
      throw new CorrectionError(
        409,
        `supersedes_claim_id ${q.supersedes_claim_id} is not a claim about '${subjectNorm}'.'${attribute}' in this history`,
      );
    }
  } else {
    const belief = resolveBelief(claims, edges);
    const head = belief.head ?? belief.heads[0] ?? null;
    if (!head) throw new CorrectionError(409, 'no current head claim to supersede');
    target = claims.find((c) => c.claim_id === head.claim_id);
    if (!target) throw new CorrectionError(409, 'head claim vanished between read and write');
  }
  if (!target.claim_key) throw new CorrectionError(409, 'target claim carries no natural key (re-ingest required)');

  const built = buildCorrection({
    historyId,
    subject: q.subject,
    subjectNorm,
    entityId,
    entityKey,
    attribute,
    value: q.value,
    supersedesClaimId: target.claim_id,
    supersedesClaimKey: target.claim_key,
    atMillis: q.atMillis ?? Date.now(),
  });

  await client.loadTwoPhase(built.nodes, built.edges);

  return {
    claim_id: built.claimId,
    edge_id: built.edgeId,
    event_time: built.eventTime,
    supersedes_claim_id: target.claim_id,
    appended: true,
  };
}
