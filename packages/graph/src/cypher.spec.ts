import { describe, it, expect } from 'vitest';
import { lintCypher, lintBatchSize } from './linter.js';
import * as cy from './cypher.js';
import { keys, vid } from './ids.js';

// Mirrors packages/ingest NORM_VERSION. Not imported: @errata/ingest depends on @errata/graph, so
// importing it here would make the package graph circular.
const NORM_VERSION = 2;

function sampleNodeRow(): Record<string, unknown> {
  const key = keys.claim('h', 'the user', 'employer', 'globex', 9, 4, NORM_VERSION);
  return {
    id: vid(key),
    key,
    history_id: 'h',
    subject: 'the user',
    subject_norm: 'the user',
    attribute: 'employer',
    arity: 'FUNCTIONAL',
    attribute_registered: true,
    value_text: 'Globex',
    value_norm: 'globex',
    polarity: 'AFFIRM',
    event_time: 1683417600,
    event_time_iso: '2023-05-07',
    ingest_time: 1755302400,
    time_basis: 'EXPLICIT',
    confidence: 0.82,
    provenance: 'EXTRACTED',
    session_id: 's9',
    turn_id: 's9:t4',
    evidence_span: 'now at globex',
    extractor_model: 'x',
    judge_status: 'OK',
    run_id: 'r1',
  };
}
function sampleEdgeRow(): Record<string, unknown> {
  return {
    id: vid(keys.edge('SUPERSEDES', 'a', 'b')),
    src: 1,
    dst: 2,
    key: keys.edge('SUPERSEDES', 'a', 'b'),
    history_id: 'h',
    judge_status: 'OK',
    judge_model: 'j',
    rationale: 'newer employment',
    event_time: 1,
    event_time_iso: '',
    ingest_time: 2,
    confidence: 0.9,
    provenance: 'INFERRED',
    run_id: 'r1',
  };
}

// every builder, with representative arguments
const stmts = (): cy.Stmt[] => [
  cy.upsertNodes('Claim', [sampleNodeRow()]),
  cy.upsertNodes('Session', [{ id: 1, key: 'k', history_id: 'h', session_id: 's1', session_date_iso: '2023-01-01', turn_count: 3, ordinal: 0, event_time: 1, event_time_iso: '', ingest_time: 2, confidence: -1.0, provenance: 'EXTRACTED', run_id: 'r' }]),
  cy.upsertNodes('Turn', [{ id: 1, key: 'k', history_id: 'h', session_id: 's1', turn_id: 's1:t0', turn_idx: 0, role: 'user', text: 't', token_count: 5, salient: true, event_time: 1, event_time_iso: '', ingest_time: 2, confidence: -1.0, provenance: 'EXTRACTED', run_id: 'r' }]),
  cy.upsertNodes('Speaker', [{ id: 1, key: 'k', history_id: 'h', role: 'user', display: 'User', event_time: 1, event_time_iso: '', ingest_time: 2, confidence: -1.0, provenance: 'EXTRACTED', run_id: 'r' }]),
  cy.upsertNodes('Entity', [{ id: 1, key: 'k', history_id: 'h', name: 'Globex', norm_name: 'globex', etype: 'ORG', mention_count: 2, event_time: 1, event_time_iso: '', ingest_time: 2, confidence: -1.0, provenance: 'EXTRACTED', run_id: 'r' }]),
  cy.upsertEdges('SUPERSEDES', 'Claim', 'Claim', [sampleEdgeRow()]),
  cy.upsertEdges('ABOUT', 'Claim', 'Entity', [{ ...sampleEdgeRow(), role: 'SUBJECT' }]),
  cy.upsertEdges('STATED_IN', 'Claim', 'Turn', [sampleEdgeRow()]),
  cy.claimsForEntityAttribute(123, 'h', 'employer'),
  cy.revisionEdgesForEntity(123, 'h', 'employer', 'SUPERSEDES'),
  cy.revisionEdgesForEntity(123, 'h', 'employer', 'CONTRADICTS'),
  cy.revisionEdgesForEntity(123, 'h', 'employer', 'SUPPORTS'),
  cy.spPaths(1, 2),
  cy.enumerateChain(1, 'h'),
  cy.claimsForEntities([1, 2, 3], 'h'),
  cy.turnForClaim(1),
  cy.turnsByIds([11, 22, 33]),
  cy.sessionsByExternalId('h', 's9'),
  cy.claimsForHistory('h'),
  cy.countLabel('Turn', 'h'),
  cy.nodesByIds('Session', [1, 2, 3], ['turn_count']),
  cy.nodesByIds('Speaker', [1, 2]),
  cy.entityIdsForSessions([1, 2, 3]),
  cy.claimIdsForEntities([1, 2, 3], 'h'),
];

describe('cypher builders ', () => {
  it('42: every builder produces subset-clean text and ≤1024-row batches', () => {
    for (const s of stmts()) {
      expect(lintCypher(s.text), s.text).toEqual([]);
      expect(lintBatchSize(s.params)).toEqual([]);
    }
  });

  it('43: node upsert MERGEs on id alone, then SET (no properties in the MERGE pattern)', () => {
    const s = cy.upsertNodes('Claim', [sampleNodeRow()]);
    expect(s.text).toContain('MERGE (n {id: row.id})');
    expect(s.text).toContain('SET n:Claim');
    // the MERGE line carries only id — no comma between the braces
    const mergeLine = s.text.split('\n').find((l) => l.startsWith('MERGE'))!;
    expect(mergeLine.includes(',')).toBe(false);
  });

  it('43b: edge upsert is a single MATCH…,… MERGE-with-relationship-id (Day-0 law)', () => {
    const s = cy.upsertEdges('SUPERSEDES', 'Claim', 'Claim', [sampleEdgeRow()]);
    expect(s.text).toContain('MATCH (s:Claim {id: row.src}), (d:Claim {id: row.dst})');
    expect(s.text).toContain('MERGE (s)-[r:SUPERSEDES {id: row.id}]->(d)');
    expect(s.text).toContain('SET r.key = row.key'); // the SET keyword must be present (regression guard)
  });

  it('43c: every write builder carries a single-line SET clause', () => {
    for (const s of stmts().filter((x) => x.text.startsWith('UNWIND'))) {
      const setLines = s.text.split('\n').filter((l) => l.trimStart().startsWith('SET '));
      expect(setLines).toHaveLength(1); // exactly one SET line, single-line form
    }
  });

  it('44: every multi-hop read names its interior nodes (no ]->() )', () => {
    for (const s of stmts()) expect(/\]\s*->\s*\(\s*\)/.test(s.text)).toBe(false);
  });

  it('claimsForEntities builds one id-pinned UNION arm per anchor', () => {
    const s = cy.claimsForEntities([10, 20, 30], 'h');
    expect(s.text.match(/UNION/g)).toHaveLength(2); // 3 arms → 2 UNIONs
    expect(s.params).toMatchObject({ a0: 10, a1: 20, a2: 30, history_id: 'h' });
  });

  it('turnsByIds builds one id-pinned UNION arm per turn and caps the window', () => {
    const s = cy.turnsByIds([11, 22, 33]);
    expect(s.text.match(/UNION/g)).toHaveLength(2); // 3 arms → 2 UNIONs
    expect(s.params).toEqual({ a0: 11, a1: 22, a2: 33 });
    expect(s.text.includes('WHERE')).toBe(false); // anchored on {id}, never a turn_idx filter
    const capped = cy.turnsByIds(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(Object.keys(capped.params)).toHaveLength(cy.TURN_WINDOW_MAX);
    expect(lintCypher(capped.text)).toEqual([]);
    expect(() => cy.turnsByIds([])).toThrow(/at least one turn id/);
  });

  it('the health probes are id-pinned, capped, and never scan a label', () => {
    // G5: five per-history label scans 503'd /api/meta/health once the store passed 250K Turns.
    const probes = [
      cy.nodesByIds('Session', [1, 2, 3], ['turn_count']),
      cy.nodesByIds('Speaker', [1, 2]),
      cy.entityIdsForSessions([1, 2, 3]),
      cy.claimIdsForEntities([1, 2, 3], 'h'),
    ];
    for (const s of probes) {
      expect(lintCypher(s.text), s.text).toEqual([]);
      // every MATCH arm pins a vertex by id; none opens on a bare label.
      for (const line of s.text.split('\n').filter((l) => l.startsWith('MATCH'))) {
        expect(line, line).toMatch(/\{id: \$a\d+\}/);
      }
    }
    expect(cy.nodesByIds('Session', [1, 2, 3], ['turn_count']).text.match(/UNION/g)).toHaveLength(2);
    expect(cy.claimIdsForEntities([1, 2], 'h').params).toEqual({ history_id: 'h', a0: 1, a1: 2 });
  });

  it('the health probes cap their arms and refuse an empty anchor list', () => {
    const many = Array.from({ length: 200 }, (_, i) => i + 1);
    expect(Object.keys(cy.nodesByIds('Session', many).params)).toHaveLength(cy.PROBE_ARM_MAX);
    expect(Object.keys(cy.entityIdsForSessions(many).params)).toHaveLength(cy.PROBE_ARM_MAX);
    // history_id rides along with the arms, so the claim probe carries one extra param
    expect(Object.keys(cy.claimIdsForEntities(many, 'h').params)).toHaveLength(cy.PROBE_ARM_MAX + 1);
    expect(() => cy.nodesByIds('Session', [])).toThrow(/at least one id/);
    expect(() => cy.entityIdsForSessions([])).toThrow(/at least one session id/);
    expect(() => cy.claimIdsForEntities([], 'h')).toThrow(/at least one anchor/);
  });

  it('nodesByIds only ever returns a property the label actually declares', () => {
    expect(cy.nodesByIds('Session', [1], ['turn_count']).text).toContain('n.turn_count AS turn_count');
    expect(cy.nodesByIds('Speaker', [1]).text).toContain('n.id AS id');
    expect(() => cy.nodesByIds('Session', [1], ['text'])).toThrow(/Session has no property 'text'/);
    expect(() => cy.nodesByIds('Session', [1], ['1 AS x} RETURN 1 //'])).toThrow(/no property/);
  });

  it('turnForClaim returns the key and turn_idx a neighbour window needs', () => {
    const s = cy.turnForClaim(7);
    expect(s.text).toContain('t.key AS turn_key');
    expect(s.text).toContain('t.turn_idx AS turn_idx');
  });

  it('property: 500 generated node batches stay clean and within the row cap', () => {
    for (let i = 0; i < 500; i++) {
      const rows = Array.from({ length: (i % 1024) + 1 }, (_, j) => ({ ...sampleNodeRow(), id: i * 1000 + j }));
      const s = cy.upsertNodes('Claim', rows);
      expect(lintCypher(s.text)).toEqual([]);
      expect(lintBatchSize(s.params)).toEqual([]);
    }
  });
});
