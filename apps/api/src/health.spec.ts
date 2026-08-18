import { describe, it, expect } from 'vitest';
import { keys, lintCypher, vid } from '@errata/graph';
import type { Stmt } from '@errata/graph';
import { historyCounts, SKIPPED } from './health.js';

const HISTORY = 'h1';

const sessionVid = (ordinal: number): number => vid(keys.session(HISTORY, ordinal));

/** A graph stub that answers by matching the statement's shape, and records everything it ran. */
interface FakeGraphOpts {
  sessions?: { ordinal: number; turn_count: number }[];
  entities?: number[];
  claims?: number[];
  speakers?: number;
  failOn?: RegExp;
  /** ms each read takes, for budget tests */
  latencyMs?: number;
}

class FakeGraph {
  readonly ran: Stmt[] = [];
  // Field + assignment rather than a parameter property: `erasableSyntaxOnly` forbids the latter.
  readonly opts: FakeGraphOpts;
  constructor(opts: FakeGraphOpts = {}) {
    this.opts = opts;
  }

  async read(stmt: Stmt): Promise<Record<string, unknown>[]> {
    this.ran.push(stmt);
    if (this.opts.latencyMs) await new Promise((r) => setTimeout(r, this.opts.latencyMs));
    if (this.opts.failOn?.test(stmt.text)) throw new Error('admission control refused this read');
    const anchors = Object.entries(stmt.params)
      .filter(([k]) => /^a\d+$/.test(k))
      .map(([, v]) => Number(v));
    if (stmt.text.includes('(n:Session')) {
      const known = new Map((this.opts.sessions ?? []).map((s) => [sessionVid(s.ordinal), s]));
      return anchors
        .filter((id) => known.has(id))
        .map((id) => ({ id, turn_count: known.get(id)!.turn_count }));
    }
    if (stmt.text.includes('(n:Speaker')) {
      return anchors.slice(0, this.opts.speakers ?? 2).map((id) => ({ id }));
    }
    if (stmt.text.includes('(e:Entity {id:')) return (this.opts.claims ?? []).map((id) => ({ id }));
    if (stmt.text.includes('(e:Entity)')) return (this.opts.entities ?? []).map((id) => ({ id }));
    throw new Error(`unexpected statement: ${stmt.text}`);
  }
}

const threeSessions = [
  { ordinal: 0, turn_count: 12 },
  { ordinal: 1, turn_count: 8 },
  { ordinal: 2, turn_count: 5 },
];

describe('/api/meta/health counts (G5: the label scan that 503d the demo)', () => {
  it('counts a history without ever scanning a label', async () => {
    const db = new FakeGraph({ sessions: threeSessions, entities: [7, 8], claims: [1, 2, 3] });
    const { counts, complete } = await historyCounts(db, HISTORY, { deep: true });

    expect(counts).toEqual({ Session: 3, Turn: 25, Speaker: 2, Entity: 2, Claim: 3 });
    expect(complete).toBe(true);
    // the actual protection: every statement is id-pinned and subset-clean, and none is a scan.
    for (const stmt of db.ran) {
      expect(lintCypher(stmt.text), stmt.text).toEqual([]);
      for (const line of stmt.text.split('\n').filter((l) => l.startsWith('MATCH'))) {
        expect(line, line).toMatch(/\{id: \$a\d+\}/);
      }
      expect(stmt.text).not.toMatch(/MATCH \(\w+:\w+\)\nWHERE \w+\.history_id/);
      // anchor-first, and not for tidiness: the planner binds the first element it can, so the
      // four-hop entity walk written entity-first measured 1,233 ms per arm against 22 ms this way
      // and blew the engine's 30 s timeout at 52 arms.
      for (const line of stmt.text.split('\n').filter((l) => l.startsWith('MATCH'))) {
        expect(line.slice(0, line.indexOf(')') + 1), line).toMatch(/\{id: \$a\d+\}\)/);
      }
    }
  });

  it('takes Turn from each Session own turn_count, never from the Turn label', async () => {
    const db = new FakeGraph({ sessions: threeSessions });
    const { counts } = await historyCounts(db, HISTORY);
    expect(counts.Turn).toBe(25);
    expect(db.ran.some((s) => s.text.includes(':Turn {id:'))).toBe(false);
    expect(db.ran.some((s) => s.text.includes('MATCH (n:Turn)'))).toBe(false);
  });

  it('anchors claims on entities, so a correction claim stated in no turn is still counted', async () => {
    const db = new FakeGraph({ sessions: threeSessions, entities: [7], claims: [1, 2, 3, 4] });
    const { counts } = await historyCounts(db, HISTORY, { deep: true });
    expect(counts.Claim).toBe(4);
    const claimStmt = db.ran.find((s) => s.text.includes('(e:Entity {id:'))!;
    expect(claimStmt.text).toContain('(e:Entity {id: $a0})');
    expect(claimStmt.params.history_id).toBe(HISTORY);
  });

  it('stops probing session ordinals at the first gap instead of walking a fixed ceiling', async () => {
    const db = new FakeGraph({ sessions: threeSessions });
    await historyCounts(db, HISTORY);
    expect(db.ran.filter((s) => s.text.includes('(n:Session')).length).toBe(1);
  });

  it('an empty history reports zeroes rather than failing', async () => {
    const db = new FakeGraph({ sessions: [] });
    const { counts, complete } = await historyCounts(db, HISTORY, { deep: true });
    expect(counts).toEqual({ Session: 0, Turn: 0, Speaker: 2, Entity: 0, Claim: 0 });
    expect(complete).toBe(true);
  });

  it('skips the traversals unless they are asked for, and runs no query for them', async () => {
    // the default a health POLL gets: three single-hop id reads and nothing that walks the graph.
    const db = new FakeGraph({ sessions: threeSessions, entities: [7], claims: [1] });
    const { counts, complete } = await historyCounts(db, HISTORY);
    expect(counts).toEqual({ Speaker: 2, Session: 3, Turn: 25, Entity: SKIPPED, Claim: SKIPPED });
    expect(complete).toBe(false);
    expect(db.ran.some((s) => s.text.includes('(e:Entity'))).toBe(false);
  });

  it('degrades a refused count to skipped_at_scale instead of 503-ing the route', async () => {
    const db = new FakeGraph({ sessions: threeSessions, failOn: /\(e:Entity\)$/m });
    const { counts, complete } = await historyCounts(db, HISTORY, { deep: true });
    expect(counts.Speaker).toBe(2);
    expect(counts.Session).toBe(3);
    expect(counts.Turn).toBe(25);
    expect(counts.Entity).toBe(SKIPPED);
    expect(counts.Claim).toBe(SKIPPED); // no anchors => the claim count cannot be taken either
    expect(complete).toBe(false);
  });

  it('propagates a failed readiness probe — an unreachable graph IS a 503', async () => {
    // the readiness probe is the two-id Speaker read, the cheapest thing this route can ask.
    const db = new FakeGraph({ sessions: threeSessions, failOn: /\(n:Speaker/ });
    await expect(historyCounts(db, HISTORY)).rejects.toThrow(/admission control/);
    expect(db.ran).toHaveLength(1); // and nothing more was attempted
  });

  it('a slow count is abandoned at the budget, so the route answers instead of hanging', async () => {
    // the shape that made a live health call take 30 s and then 503 on the retry.
    const db = new FakeGraph({ sessions: threeSessions, entities: [7], claims: [1], latencyMs: 40 });
    const started = Date.now();
    const { counts, complete } = await historyCounts(db, HISTORY, { deep: true, budgetMs: 50 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(counts.Speaker).toBe(2); // the readiness probe is outside the budget
    expect(complete).toBe(false);
    expect(Object.values(counts)).toContain(SKIPPED);
  });

  it('chunks a long anchor list rather than truncating the count', async () => {
    const sessions = Array.from({ length: 100 }, (_, i) => ({ ordinal: i, turn_count: 1 }));
    const entities = Array.from({ length: 150 }, (_, i) => i + 1);
    const db = new FakeGraph({ sessions, entities, claims: [1] });
    const { counts } = await historyCounts(db, HISTORY, { deep: true });
    expect(counts.Session).toBe(100); // two blocks of 64 ordinals, second one partial
    expect(counts.Entity).toBe(150); // deduped across chunks, not capped at one statement's arms
    expect(db.ran.filter((s) => s.text.includes('(n:Session')).length).toBe(2);
    expect(db.ran.filter((s) => s.text.includes('(e:Entity {id:')).length).toBe(3);
  });
});
