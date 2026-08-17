// packages/graph/src/cypher.ts — hand-written Cypher against HydraDB's deliberate OpenCypher
// subset .
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

/** Arms per id-pinned probe statement — the widest UNION any builder here emits. Declared before
 *  INTEGER_KEYS because it sizes the `a<i>` anchor-key list: an anchor key missing from that set
 *  is sent as a Bolt Float and the engine answers "node id property must be an integer". */
export const PROBE_ARM_MAX = 64;

/** Keys whose numeric values must be encoded as Bolt integers (never floats). `confidence` is a
 *  float and is deliberately absent. bolt.ts wraps exactly these with neo4j.int(). */
export const INTEGER_KEYS: ReadonlySet<string> = new Set([
  // scalar params
  'entity_vid', 'claim_vid', 'newer_vid', 'older_vid', 'at',
  // id-pinned UNION arms: 8 entity anchors on the ask path, TURN_WINDOW_MAX on /api/turns,
  // PROBE_ARM_MAX on the health probes.
  ...Array.from({ length: PROBE_ARM_MAX }, (_, i) => `a${i}`),
  // row fields
  'id', 'src', 'dst',
  'event_time', 'ingest_time', 'turn_idx', 'turn_index', 'token_count', 'ordinal', 'turn_count', 'mention_count',
]);

// property lists per label (universal props + label-specific), the storage design.
const NODE_PROPS: Record<NodeLabel, readonly string[]> = {
  Session: ['key', 'history_id', 'session_id', 'session_date_iso', 'turn_count', 'ordinal', 'event_time', 'event_time_iso', 'ingest_time', 'confidence', 'provenance', 'run_id'],
  Turn: ['key', 'history_id', 'session_id', 'turn_id', 'turn_idx', 'role', 'text', 'token_count', 'salient', 'event_time', 'event_time_iso', 'ingest_time', 'confidence', 'provenance', 'run_id'],
  Speaker: ['key', 'history_id', 'role', 'display', 'event_time', 'event_time_iso', 'ingest_time', 'confidence', 'provenance', 'run_id'],
  Entity: ['key', 'history_id', 'name', 'norm_name', 'etype', 'mention_count', 'event_time', 'event_time_iso', 'ingest_time', 'confidence', 'provenance', 'run_id'],
  Claim: ['key', 'history_id', 'subject', 'subject_norm', 'attribute', 'arity', 'attribute_registered', 'value_text', 'value_norm', 'polarity', 'event_time', 'event_time_iso', 'ingest_time', 'time_basis', 'confidence', 'provenance', 'session_id', 'turn_id', 'turn_index', 'evidence_span', 'extractor_model', 'judge_status', 'run_id'],
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

// ---------- write path  ----------

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

// ---------- read path: current belief  ----------

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
    `       c.session_id AS session_id, c.turn_id AS turn_id, c.turn_index AS turn_index,\n` +
    `       c.evidence_span AS evidence_span, c.key AS claim_key\n` +
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

// ---------- read path: as-of  ----------

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
    `       c.session_id AS session_id, c.turn_id AS turn_id, c.turn_index AS turn_index,\n` +
    `       c.evidence_span AS evidence_span\n` +
    `ORDER BY event_time\n` +
    `LIMIT 500`;
  return { text, params: { entity_vid: entityVid, history_id: historyId, attribute, at } };
}

// ---------- read path: diff  ----------

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

/** The mandatory cross-validation counterpart: bounded, directed enumeration . */
export function enumerateChain(newerVid: number, historyId: string): Stmt {
  const text =
    `MATCH (newer:Claim {id: $newer_vid})-[:SUPERSEDES*1..8]->(older:Claim)\n` +
    `WHERE older.history_id = $history_id\n` +
    `RETURN older.id AS older_id, older.event_time AS event_time, older.value_text AS value\n` +
    `ORDER BY older_id\n` +
    `LIMIT 500`;
  return { text, params: { newer_vid: newerVid, history_id: historyId } };
}

// ---------- read path: ask  ----------

/** Claims at up to 8 entity anchors, as a UNION of id-pinned arms (no IN, so this is the only way). */
export function claimsForEntities(anchorVids: number[], historyId: string): Stmt {
  const anchors = anchorVids.slice(0, 8);
  if (anchors.length === 0) throw new Error('claimsForEntities: at least one anchor required');
  const arm = (i: number): string =>
    `MATCH (c:Claim)-[:ABOUT]->(e:Entity {id: $a${i}})\n` +
    `WHERE c.history_id = $history_id\n` +
    `RETURN c.id AS claim_id, c.attribute AS attribute, c.subject_norm AS subject_norm,\n` +
    `       c.value_text AS value, c.event_time AS event_time, c.confidence AS confidence,\n` +
    `       c.session_id AS session_id, c.turn_id AS turn_id, c.turn_index AS turn_index,\n` +
    `       c.evidence_span AS evidence_span`;
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

/** Citation hydration — render the full turn behind a claim (one hop).
 *  `turn_key` and `turn_idx` come back so the caller can derive the session ORDINAL (the Turn's
 *  identity is `h:<history>|s:<ordinal>|t:<idx>`) and mint its neighbours' ids without a scan. */
export function turnForClaim(claimVid: number): Stmt {
  const text =
    `MATCH (c:Claim {id: $claim_vid})-[:STATED_IN]->(t:Turn)\n` +
    `RETURN t.id AS turn_vid, t.key AS turn_key, t.session_id AS session_id, t.turn_id AS turn_id,\n` +
    `       t.turn_idx AS turn_idx, t.role AS role, t.text AS text,\n` +
    `       t.event_time AS event_time, t.event_time_iso AS event_time_iso`;
  return { text, params: { claim_vid: claimVid } };
}

/** Transcript context — the turns at a bounded set of ids, as id-pinned UNION arms.
 *
 *  This is the neighbours-by-turn_idx read. It is deliberately NOT a property filter
 *  on `turn_idx`: HydraDB's subset has no `IN`, and a range predicate over `t.turn_idx` would be a
 *  label scan of every Turn in the store (246K on the full corpus — see G3's `countLabel` note).
 *  Turn ids are pure functions of (history_id, session ordinal, turn_idx), so the caller mints the
 *  window's ids with `keys.turn` and each arm is anchored on one of them. Capped at 16 arms.
 */
export const TURN_WINDOW_MAX = 16;

export function turnsByIds(turnVids: number[]): Stmt {
  const ids = turnVids.slice(0, TURN_WINDOW_MAX);
  if (ids.length === 0) throw new Error('turnsByIds: at least one turn id required');
  const arm = (i: number): string =>
    `MATCH (t:Turn {id: $a${i}})\n` +
    `RETURN t.id AS turn_vid, t.key AS turn_key, t.session_id AS session_id, t.turn_id AS turn_id,\n` +
    `       t.turn_idx AS turn_idx, t.role AS role, t.text AS text,\n` +
    `       t.event_time AS event_time, t.event_time_iso AS event_time_iso`;
  const text = ids.map((_, i) => arm(i)).join('\nUNION\n');
  const params: Record<string, unknown> = {};
  ids.forEach((id, i) => (params[`a${i}`] = id));
  return { text, params };
}

/** session_id → ordinal, for callers that only carry the display id (session_id is NOT unique
 *  across the corpus, so this can legitimately return several rows; they are ordered and bounded).
 *  A Session label scan filtered by history — the same admin-class read as `countLabel`, off the
 *  id-anchored path. Prefer anchoring on a claim id (`turnForClaim`) when one is available. */
export function sessionsByExternalId(historyId: string, sessionId: string): Stmt {
  const text =
    `MATCH (s:Session)\n` +
    `WHERE s.history_id = $history_id\n` +
    `  AND s.session_id = $session_id\n` +
    `RETURN s.id AS session_vid, s.ordinal AS ordinal, s.session_id AS session_id,\n` +
    `       s.session_date_iso AS session_date_iso, s.turn_count AS turn_count\n` +
    `ORDER BY ordinal\n` +
    `LIMIT 8`;
  return { text, params: { history_id: historyId, session_id: sessionId } };
}

/** Every Claim in one history — a bounded label scan, DIAGNOSTIC ONLY (the failure-taxonomy replay
 *  asks "does a claim supporting the gold answer exist at all?"). Same admin class as `countLabel`:
 *  never on the ask path, never on the demo path. */
export function claimsForHistory(historyId: string, limit = 2000): Stmt {
  const text =
    `MATCH (c:Claim)\n` +
    `WHERE c.history_id = $history_id\n` +
    `RETURN c.id AS claim_id, c.attribute AS attribute, c.subject_norm AS subject_norm,\n` +
    `       c.value_text AS value, c.event_time AS event_time,\n` +
    `       c.session_id AS session_id, c.turn_index AS turn_index,\n` +
    `       c.evidence_span AS evidence_span\n` +
    `LIMIT ${Math.max(1, Math.floor(limit))}`;
  return { text, params: { history_id: historyId } };
}

/** Per-history node count by label scan. ADMIN/DIAGNOSTIC ONLY — no longer used by any route.
 *
 *  Kept as the thing the health route stopped doing, with the reason attached. A label scan's
 *  candidate set is the WHOLE label, not the filtered subset, so once the store passed 250K Turns
 *  the engine refused it outright — `cypher_vertex_label_index_candidates rejected by admission
 *  control: actual 250001 exceeds limit 250000` — and 503'd the deployed demo's health route (G5).
 *  Speaker, whose two-nodes-per-history shape looks trivial, timed out at 30 s for the same
 *  reason: the scan is over every Speaker in the store. Health now counts id-anchored
 *  (`nodesByIds` → `entityIdsForSessions` → `claimIdsForEntities`), bounded by the HISTORY's size
 *  rather than the STORE's, which is the same discipline the ask path has always had.
 */
export function countLabel(label: NodeLabel, historyId: string): Stmt {
  const text =
    `MATCH (n:${label})\n` +
    `WHERE n.history_id = $history_id\n` +
    `RETURN count(*) AS n`;
  return { text, params: { history_id: historyId } };
}

function idPinnedUnion(
  arm: (i: number) => string,
  vids: number[],
  extraParams: Record<string, unknown> = {},
): Stmt {
  const ids = vids.slice(0, PROBE_ARM_MAX);
  const text = ids.map((_, i) => arm(i)).join('\nUNION\n');
  const params: Record<string, unknown> = { ...extraParams };
  ids.forEach((id, i) => (params[`a${i}`] = id));
  return { text, params };
}

/** Id-pinned node probe: N UNION arms, one per id, returning `id` plus the requested properties.
 *
 *  `turnsByIds` generalised to any label — the read shape bounded by what the caller asked for
 *  instead of by what the store happens to hold. Property names are checked against the label's
 *  declared property list, so the interpolation can only emit a property this schema defines.
 */
export function nodesByIds(label: NodeLabel, vids: number[], props: readonly string[] = []): Stmt {
  if (vids.length === 0) throw new Error('nodesByIds: at least one id required');
  const allowed = new Set<string>([...NODE_PROPS[label], 'id']);
  for (const p of props) {
    if (!allowed.has(p)) throw new Error(`nodesByIds: ${label} has no property '${p}'`);
  }
  const returned = ['id', ...props.filter((p) => p !== 'id')];
  return idPinnedUnion(
    (i) =>
      `MATCH (n:${label} {id: $a${i}})\n` +
      `RETURN ${returned.map((p) => `n.${p} AS ${p}`).join(', ')}`,
    vids,
  );
}

/** The distinct Entity ids reachable from a bounded set of Sessions (Session←Turn←Claim→Entity).
 *  UNION dedupes, so the row count IS the distinct entity count. Admin class, never the ask path.
 *
 *  The pattern is written ANCHOR-FIRST, and that is not cosmetic: the planner starts at the first
 *  element it can bind, so the same four hops written `(e:Entity)<-[:ABOUT]-…-(s:Session {id})`
 *  measured 1,233 ms per arm against 22 ms for this order, and 52 arms of the slow form exceeded
 *  the engine's 30 s query timeout outright. Anchor first, walk outwards. */
export function entityIdsForSessions(sessionVids: number[]): Stmt {
  if (sessionVids.length === 0) throw new Error('entityIdsForSessions: at least one session id required');
  return idPinnedUnion(
    (i) =>
      `MATCH (s:Session {id: $a${i}})<-[:STATED_IN]-(t:Turn)<-[:STATED_IN]-(c:Claim)-[:ABOUT]->(e:Entity)\n` +
      `RETURN e.id AS id`,
    sessionVids,
  );
}

/** The distinct Claim ids at a bounded set of Entity anchors — `claimsForEntities`' read, ids
 *  only, wider bound, written anchor-first for the planner. Anchoring on the ENTITY rather than on
 *  the Turn is what makes a user correction countable: a correction claim is ABOUT its subject but
 *  is STATED_IN no turn, so a turn-anchored count would miss exactly the claims the demo makes. */
export function claimIdsForEntities(entityVids: number[], historyId: string): Stmt {
  if (entityVids.length === 0) throw new Error('claimIdsForEntities: at least one anchor required');
  return idPinnedUnion(
    (i) =>
      `MATCH (e:Entity {id: $a${i}})<-[:ABOUT]-(c:Claim)\n` +
      `WHERE c.history_id = $history_id\n` +
      `RETURN c.id AS id`,
    entityVids,
    { history_id: historyId },
  );
}
