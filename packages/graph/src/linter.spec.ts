import { describe, it, expect } from 'vitest';
import { lintCypher, lintBatchSize, assertCypher } from './linter.js';

const ruleset = (t: string): string[] => lintCypher(t).map((f) => f.rule);

describe('subset linter — rejections (spec 31 §4.8, §7 test 41)', () => {
  it('rejects IN over a list or param', () => {
    expect(ruleset('MATCH (n:X {id: $i}) WHERE n.a IN [1,2] RETURN n.a')).toContain('IN');
    expect(ruleset('MATCH (n:X {id: $i}) WHERE n.a IN $vals RETURN n.a')).toContain('IN');
  });
  it('rejects CONTAINS / ENDS WITH / IS (NOT) NULL', () => {
    expect(ruleset("MATCH (n:X {id: $i}) WHERE n.a CONTAINS 'z' RETURN n.a")).toContain('CONTAINS');
    expect(ruleset("MATCH (n:X {id: $i}) WHERE n.a ENDS WITH 'z' RETURN n.a")).toContain('ENDS_WITH');
    expect(ruleset('MATCH (n:X {id: $i}) WHERE n.a IS NULL RETURN n.a')).toContain('IS_NULL');
    expect(ruleset('MATCH (n:X {id: $i}) WHERE n.a IS NOT NULL RETURN n.a')).toContain('IS_NULL');
  });
  it('rejects RETURN * and min/max', () => {
    expect(ruleset('MATCH (n:X {id: $i}) RETURN *')).toContain('RETURN_STAR');
    expect(ruleset('MATCH (n:X {id: $i}) RETURN max(n.a)')).toContain('MIN_MAX');
    expect(ruleset('MATCH (n:X {id: $i}) RETURN min(n.a)')).toContain('MIN_MAX');
  });
  it('rejects a WITH clause but allows STARTS WITH', () => {
    expect(ruleset('MATCH (n:X {id: $i}) WITH n RETURN n.a')).toContain('WITH');
    expect(ruleset("MATCH (e:Entity) WHERE e.norm_name STARTS WITH $p RETURN e.id AS id")).not.toContain('WITH');
  });
  it('rejects undirected relationships', () => {
    expect(ruleset('MATCH (a:X {id: $i})-[:R]-(b:Y) RETURN a.id AS id')).toContain('UNDIRECTED');
    expect(ruleset('MATCH (a:X {id: $i})-[:R]->(b:Y) RETURN a.id AS id')).not.toContain('UNDIRECTED');
    expect(ruleset('MATCH (a:X {id: $i})<-[:R]-(b:Y) RETURN a.id AS id')).not.toContain('UNDIRECTED');
  });
  it('rejects unbounded variable-length but allows an explicit max hop', () => {
    expect(ruleset('MATCH (a:X {id: $i})-[:R*]->(b:Y) RETURN b.id AS id')).toContain('UNBOUNDED_VARLEN');
    expect(ruleset('MATCH (a:X {id: $i})-[:R*1..]->(b:Y) RETURN b.id AS id')).toContain('UNBOUNDED_VARLEN');
    expect(ruleset('MATCH (a:X {id: $i})-[:R*1..8]->(b:Y) RETURN b.id AS id')).not.toContain('UNBOUNDED_VARLEN');
  });
  it('rejects folding properties into a vertex MERGE (but allows relationship MERGE {id})', () => {
    expect(ruleset('MERGE (n {id: row.id, key: row.key})')).toContain('VERTEX_MERGE_PROPS');
    expect(ruleset('MERGE (n {id: row.id})')).not.toContain('VERTEX_MERGE_PROPS');
    expect(ruleset('MATCH (s:C {id: row.src}), (d:C {id: row.dst}) MERGE (s)-[r:SUPERSEDES {id: row.id}]->(d)')).not.toContain('VERTEX_MERGE_PROPS');
  });
  it('rejects anonymous interior nodes, DDL/procedures, and multi-statement bodies', () => {
    expect(ruleset('MATCH (a:X {id: $i})-[:R]->() RETURN a.id AS id')).toContain('ANON_INTERIOR');
    expect(ruleset('CREATE INDEX foo FOR (n:X) ON (n.a)')).toContain('DDL_OR_PROC');
    expect(ruleset('CALL db.labels()')).toContain('DDL_OR_PROC');
    expect(ruleset('CALL apoc.help("x")')).toContain('DDL_OR_PROC');
    expect(ruleset('RETURN 1 ; RETURN 2')).toContain('MULTI_STATEMENT');
  });
  it('allows algo.* procedures (not db./dbms./apoc.)', () => {
    expect(ruleset("CALL algo.SPpaths({sourceNode: $a, targetNode: $b, relTypes: ['R'], relDirection: 'both', maxLen: 8, pathCount: 64}) YIELD path RETURN path")).toEqual([]);
  });
  it('lintBatchSize flags > 1024 rows', () => {
    expect(lintBatchSize({ rows: new Array(1025).fill({}) })).toHaveLength(1);
    expect(lintBatchSize({ rows: new Array(1024).fill({}) })).toHaveLength(0);
  });
  it('assertCypher throws on a violation', () => {
    expect(() => assertCypher('RETURN *')).toThrow(/subset violation/);
    expect(() => assertCypher('MATCH (n:X {id: $i}) RETURN n.a')).not.toThrow();
  });
});
