// packages/graph/src/cypher.ts — hand-written Cypher against HydraDB's deliberate OpenCypher
// subset (spec 31 §4, checked line-by-line against the rejected list in §4.8 / 11 §4).
//
// These are PURE {text, params} producers — DB-agnostic and unit-testable without a driver.
// Integer params/fields are left as plain JS numbers here and wrapped with neo4j.int() at the
// single choke point in bolt.ts (Day-0 law: a plain JS number is sent as a Bolt Float and HydraDB
// rejects id fields). `INTEGER_KEYS` is the shared list of keys that must be Bolt integers.
//
// House rules enforced by the linter: read anchored on {id}; every interior node named; no WITH;
// vertex upsert = MERGE on id then SET; explicit max hop on all variable-length patterns.

export interface Stmt {
  text: string;
  params: Record<string, unknown>;
}

export type NodeLabel = 'Session' | 'Turn' | 'Speaker' | 'Entity' | 'Claim';
export type EdgeType = 'STATED_IN' | 'ABOUT' | 'SUPPORTS' | 'SUPERSEDES' | 'CONTRADICTS';

/** Keys whose numeric values must be encoded as Bolt integers (never floats). `confidence` is a
 *  float and is deliberately absent. bolt.ts wraps exactly these with neo4j.int(). */
export const INTEGER_KEYS: ReadonlySet<string> = new Set([
  // scalar params
  'entity_vid', 'claim_vid', 'newer_vid', 'older_vid', 'at',
  'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7',
  // row fields
  'id', 'src', 'dst',
  'event_time', 'ingest_time', 'turn_idx', 'token_count', 'ordinal', 'turn_count', 'mention_count',
]);

// property lists per label (universal props + label-specific), spec 31 §2.2 / §4.1.
const NODE_PROPS: Record<NodeLabel, readonly string[]> = {
  Session: ['key', 'history_id', 'session_id', 'session_date_iso', 'turn_count', 'ordinal', 'event_time', 'event_time_iso', 'ingest_time', 'confidence', 'provenance', 'run_id'],
  Turn: ['key', 'history_id', 'session_id', 'turn_id', 'turn_idx', 'role', 'text', 'token_count', 'salient', 'event_time', 'event_time_iso', 'ingest_time', 'confidence', 'provenance', 'run_id'],
  Speaker: ['key', 'history_id', 'role', 'display', 'event_time', 'event_time_iso', 'ingest_time', 'confidence', 'provenance', 'run_id'],
  Entity: ['key', 'history_id', 'name', 'norm_name', 'etype', 'mention_count', 'event_time', 'event_time_iso', 'ingest_time', 'confidence', 'provenance', 'run_id'],
  Claim: ['key', 'history_id', 'subject', 'subject_norm', 'attribute', 'arity', 'attribute_registered', 'value_text', 'value_norm', 'polarity', 'event_time', 'event_time_iso', 'ingest_time', 'time_basis', 'confidence', 'provenance', 'session_id', 'turn_id', 'evidence_span', 'extractor_model', 'judge_status', 'run_id'],
};

const EDGE_PROPS: Record<EdgeType, readonly string[]> = {
  STATED_IN: ['key', 'history_id', 'event_time', 'ingest_time', 'event_time_iso', 'confidence', 'provenance', 'run_id'],
  ABOUT: ['key', 'history_id', 'role', 'event_time', 'ingest_time', 'event_time_iso', 'confidence', 'provenance', 'run_id'],
  SUPPORTS: ['key', 'history_id', 'judge_status', 'judge_model', 'event_time', 'ingest_time', 'event_time_iso', 'confidence', 'provenance', 'run_id'],
  SUPERSEDES: ['key', 'history_id', 'judge_status', 'judge_model', 'rationale', 'event_time', 'ingest_time', 'event_time_iso', 'confidence', 'provenance', 'run_id'],
  CONTRADICTS: ['key', 'history_id', 'judge_status', 'judge_model', 'rationale', 'event_time', 'ingest_time', 'event_time_iso', 'confidence', 'provenance', 'run_id'],
};

// Single-line SET is required by HydraDB's vertex/edge upsert recognizer; a comma-separated list of
// property assignments after one `SET` (with the label folded into the node SET) is the accepted form.
function setClause(alias: string, props: readonly string[]): string {
  return props.map((p) => `${alias}.${p} = row.${p}`).join(', ');
}

// ---------- write path (spec 31 §4.1, §4.2) ----------

/** Phase A — upsert one label's nodes. MERGE on id alone, then SET (never fold props into MERGE). */
export function upsertNodes(label: NodeLabel, rows: Record<string, unknown>[]): Stmt {
  const text =
    `UNWIND $rows AS row\n` +
    `MERGE (n {id: row.id})\n` +
    `SET n:${label}, ${setClause('n', NODE_PROPS[label])}`;
  return { text, params: { rows } };
}

/** Phase B — upsert one (type, srcLabel, dstLabel) triple's edges. Endpoints already exist. */
export function upsertEdges(
  type: EdgeType,
  srcLabel: NodeLabel,
  dstLabel: NodeLabel,
  rows: Record<string, unknown>[],
): Stmt {
  const text =
    `UNWIND $rows AS row\n` +
    `MATCH (s:${srcLabel} {id: row.src}), (d:${dstLabel} {id: row.dst})\n` +
    `MERGE (s)-[r:${type} {id: row.id}]->(d)\n` +
    `SET ${setClause('r', EDGE_PROPS[type])}`;
  return { text, params: { rows } };
}

// ---------- read path: current belief (spec 31 §4.3) ----------

/** Statement 1 — the candidate claims for (entity, attribute). */
export function claimsForEntityAttribute(entityVid: number, historyId: string, attribute: string): Stmt {
  const text =
    `MATCH (c:Claim)-[:ABOUT]->(e:Entity {id: $entity_vid})\n` +
    `WHERE c.history_id = $history_id\n` +
    `  AND c.attribute = $attribute\n` +
    `RETURN c.id AS claim_id, c.value_text AS value, c.value_norm AS value_norm,\n` +
    `       c.attribute AS attribute, c.arity AS arity, c.polarity AS polarity,\n` +
    `       c.event_time AS event_time, c.ingest_time AS ingest_time, c.confidence AS confidence,\n` +
    `       c.provenance AS provenance, c.judge_status AS judge_status,\n` +
    `       c.session_id AS session_id, c.turn_id AS turn_id, c.evidence_span AS evidence_span,\n` +
    `       c.key AS claim_key\n` +
    `ORDER BY event_time\n` +
    `LIMIT 500`;
  return { text, params: { entity_vid: entityVid, history_id: historyId, attribute } };
}

/** Statement 2 — the revision edges of one relation type among an entity's claims.
 *  `relation` is baked into the text (relationship types cannot be parameterized). */
export function revisionEdgesForEntity(
  entityVid: number,
  historyId: string,
  attribute: string,
  relation: 'SUPERSEDES' | 'CONTRADICTS' | 'SUPPORTS',
): Stmt {
  const text =
    `MATCH (newer:Claim)-[r:${relation}]->(older:Claim)-[:ABOUT]->(e:Entity {id: $entity_vid})\n` +
    `WHERE older.history_id = $history_id\n` +
    `  AND older.attribute = $attribute\n` +
    `RETURN newer.id AS newer_id, older.id AS older_id, r.ingest_time AS ingest_time,\n` +
    `       r.confidence AS confidence, r.provenance AS provenance, r.judge_status AS judge_status,\n` +
    `       r.rationale AS rationale\n` +
    `LIMIT 500`;
  return { text, params: { entity_vid: entityVid, history_id: historyId, attribute } };
}

// ---------- read path: as-of (spec 31 §4.4) ----------

/** As-of candidate claims, filtered server-side by the time axis (the same fold runs in core). */
export function asOfClaims(
  entityVid: number,
  historyId: string,
  attribute: string,
  at: number,
  axis: 'event' | 'ingest',
): Stmt {
  const timeFilter =
    axis === 'event'
      ? `  AND c.event_time <= $at\n  AND c.event_time > -1\n`
      : `  AND c.ingest_time <= $at\n`;
  const text =
    `MATCH (c:Claim)-[:ABOUT]->(e:Entity {id: $entity_vid})\n` +
    `WHERE c.history_id = $history_id\n` +
    `  AND c.attribute = $attribute\n` +
    timeFilter +
    `RETURN c.id AS claim_id, c.value_text AS value, c.value_norm AS value_norm,\n` +
    `       c.attribute AS attribute, c.arity AS arity, c.polarity AS polarity,\n` +
    `       c.event_time AS event_time, c.ingest_time AS ingest_time, c.confidence AS confidence,\n` +
    `       c.provenance AS provenance, c.judge_status AS judge_status,\n` +
    `       c.session_id AS session_id, c.turn_id AS turn_id, c.evidence_span AS evidence_span\n` +
    `ORDER BY event_time\n` +
    `LIMIT 500`;
  return { text, params: { entity_vid: entityVid, history_id: historyId, attribute, at } };
}

// ---------- read path: diff (spec 31 §4.5, §4.6) ----------

/** algo.SPpaths over SUPERSEDES between two claim heads. maxLen/pathCount are explicit literals. */
export function spPaths(newerVid: number, olderVid: number): Stmt {
  const text =
    `CALL algo.SPpaths({sourceNode: $newer_vid, targetNode: $older_vid,\n` +
    `                   relTypes: ['SUPERSEDES'], relDirection: 'both',\n` +
    `                   maxLen: 8, pathCount: 64})\n` +
    `YIELD path, pathWeight, pathCost\n` +
    `RETURN path, pathWeight, pathCost`;
  return { text, params: { newer_vid: newerVid, older_vid: olderVid } };
}

/** The mandatory cross-validation counterpart: bounded, directed enumeration (spec 31 §4.6). */
export function enumerateChain(newerVid: number, historyId: string): Stmt {
  const text =
    `MATCH (newer:Claim {id: $newer_vid})-[:SUPERSEDES*1..8]->(older:Claim)\n` +
    `WHERE older.history_id = $history_id\n` +
    `RETURN older.id AS older_id, older.event_time AS event_time, older.value_text AS value\n` +
    `ORDER BY older_id\n` +
    `LIMIT 500`;
  return { text, params: { newer_vid: newerVid, history_id: historyId } };
}

// ---------- read path: ask (spec 31 §4.7) ----------

/** Claims at up to 8 entity anchors, as a UNION of id-pinned arms (no IN, so this is the only way). */
export function claimsForEntities(anchorVids: number[], historyId: string): Stmt {
  const anchors = anchorVids.slice(0, 8);
  if (anchors.length === 0) throw new Error('claimsForEntities: at least one anchor required');
  const arm = (i: number): string =>
    `MATCH (c:Claim)-[:ABOUT]->(e:Entity {id: $a${i}})\n` +
    `WHERE c.history_id = $history_id\n` +
    `RETURN c.id AS claim_id, c.attribute AS attribute, c.value_text AS value,\n` +
    `       c.event_time AS event_time, c.confidence AS confidence,\n` +
    `       c.session_id AS session_id, c.turn_id AS turn_id, c.evidence_span AS evidence_span`;
  const text = anchors.map((_, i) => arm(i)).join('\nUNION\n');
  const params: Record<string, unknown> = { history_id: historyId };
  anchors.forEach((vid, i) => (params[`a${i}`] = vid));
  return { text, params };
}

/** Entity prefix lookup (fallback when the lexicon misses; never on the demo path). */
export function entityPrefix(historyId: string, prefix: string): Stmt {
  const text =
    `MATCH (e:Entity)\n` +
    `WHERE e.history_id = $history_id\n` +
    `  AND e.norm_name STARTS WITH $prefix\n` +
    `RETURN e.id AS entity_vid, e.name AS name, e.norm_name AS norm_name,\n` +
    `       e.mention_count AS mention_count\n` +
    `ORDER BY norm_name\n` +
    `LIMIT 25`;
  return { text, params: { history_id: historyId, prefix } };
}

/** Co-mention expansion across anchors (algo.MSpaths). The one read that is not id-pinned. */
export function msPaths(anchorKeys: string[]): Stmt {
  const text =
    `CALL algo.MSpaths({sourceLabel: 'Entity', sourceProperty: 'key', sourceValues: $anchor_keys,\n` +
    `                   targetLabel: 'Entity', targetProperty: 'key', targetValues: $anchor_keys,\n` +
    `                   pairwise: false,\n` +
    `                   relTypes: ['ABOUT'], relDirection: 'both',\n` +
    `                   maxLen: 2, pathCount: 8, resultLimit: 200})\n` +
    `YIELD path\n` +
    `RETURN path`;
  return { text, params: { anchor_keys: anchorKeys.slice(0, 16) } };
}

/** Citation hydration — render the full turn behind a claim (one hop). */
export function turnForClaim(claimVid: number): Stmt {
  const text =
    `MATCH (c:Claim {id: $claim_vid})-[:STATED_IN]->(t:Turn)\n` +
    `RETURN t.id AS turn_vid, t.session_id AS session_id, t.turn_id AS turn_id,\n` +
    `       t.role AS role, t.text AS text, t.event_time AS event_time`;
  return { text, params: { claim_vid: claimVid } };
}

/** Per-history node count for /api/meta/health (label scan; admin only, never demo path). */
export function countLabel(label: NodeLabel, historyId: string): Stmt {
  const text =
    `MATCH (n:${label})\n` +
    `WHERE n.history_id = $history_id\n` +
    `RETURN count(*) AS n`;
  return { text, params: { history_id: historyId } };
}
