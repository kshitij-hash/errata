// packages/graph/src/bolt.ts — the Bolt client. The ONLY module in Errata that opens a socket.
//
// Two Day-0 gauntlet laws are law here:
//   1. Every integer param MUST be wrapped neo4j.int() — a plain JS number is sent as a Bolt Float
//      and HydraDB rejects id fields ("field id must be a non-negative integer"). We wrap at THIS
//      single choke point (`toBoltParams`), never at call sites, keyed off cypher.ts INTEGER_KEYS.
//      `disableLosslessIntegers` affects READS only.
//   2. Edge writes are a single comma-joined MATCH…,… MERGE-with-relationship-id (see cypher.ts).
//
// Connection scheme is bolt:// (never neo4j://) so the driver dials the URI directly and never
// consults GRAPH_ADVERTISED_BOLT_ADDR (spec 33 §2.3). Reads use causal consistency with the last
// write bookmark, defending against the WAL-overlay read anomaly (bug #69).

import neo4j from 'neo4j-driver-lite';
import type { Driver } from 'neo4j-driver-lite';
import { INTEGER_KEYS, upsertEdges, upsertNodes } from './cypher.js';
import type { EdgeType, NodeLabel, Stmt } from './cypher.js';
import { assertCypher, lintBatchSize } from './linter.js';

export const BATCH_LIMIT = 1024;

/** Recursively wrap integer-keyed numeric values as Bolt integers; leave floats/strings/bools. */
export function toBoltParams(params: Record<string, unknown>): Record<string, unknown> {
  return mapValue(params, undefined) as Record<string, unknown>;
}

function mapValue(v: unknown, key: string | undefined): unknown {
  if (typeof v === 'number' && key !== undefined && INTEGER_KEYS.has(key)) {
    if (!Number.isInteger(v)) throw new Error(`bolt: integer key '${key}' received a non-integer value ${v}`);
    return neo4j.int(v);
  }
  if (Array.isArray(v)) return v.map((el) => mapValue(el, key));
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = mapValue(val, k);
    return out;
  }
  return v;
}

export function chunk<T>(rows: readonly T[], size = BATCH_LIMIT): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

export interface BoltConfig {
  url: string; // bolt://127.0.0.1:7687
  token: string; // the auth-token file contents; username is literally "neo4j"
  database?: string; // maps to GRAPH_ID; default "default"
}

export interface NodeBatch {
  label: NodeLabel;
  rows: Record<string, unknown>[];
}
export interface EdgeBatch {
  type: EdgeType;
  srcLabel: NodeLabel;
  dstLabel: NodeLabel;
  rows: Record<string, unknown>[];
}

export function makeDriver(cfg: BoltConfig): Driver {
  if (!cfg.url.startsWith('bolt://')) {
    throw new Error(`bolt: URL must be bolt:// (never neo4j://) — got ${cfg.url}`);
  }
  return neo4j.driver(cfg.url, neo4j.auth.basic('neo4j', cfg.token), {
    disableLosslessIntegers: true, // reads come back as JS numbers (our ids are 53-bit safe)
  });
}

export class GraphClient {
  private driver: Driver;
  private readonly cfg: BoltConfig;
  private readonly database: string;
  private bookmarks: string[] = [];

  constructor(cfg: BoltConfig) {
    this.cfg = cfg;
    this.driver = makeDriver(cfg);
    this.database = cfg.database ?? 'default';
  }

  /** Connect, retrying the Bolt handshake. The driver's v2 (manifest) handshake intermittently
   *  mis-negotiates with HydraDB (a RangeError in its varint read, spec 33 §2.3); recreating the
   *  driver and retrying clears it. */
  async verify(attempts = 5): Promise<void> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        await this.driver.verifyConnectivity();
        return;
      } catch (e) {
        lastErr = e;
        try {
          await this.driver.close();
        } catch {
          /* ignore */
        }
        this.driver = makeDriver(this.cfg);
        await new Promise((r) => setTimeout(r, 100 * (i + 1)));
      }
    }
    throw lastErr;
  }
  async close(): Promise<void> {
    await this.driver.close();
  }
  setBookmarks(bm: string[]): void {
    this.bookmarks = bm;
  }
  get bookmark(): string[] {
    return this.bookmarks;
  }

  /** Read a statement (causal consistency with the last write bookmark). Returns plain row objects. */
  async read(stmt: Stmt): Promise<Record<string, unknown>[]> {
    assertCypher(stmt.text);
    const session = this.driver.session({
      database: this.database,
      defaultAccessMode: neo4j.session.READ,
      bookmarks: this.bookmarks,
    });
    try {
      const res = await session.run(stmt.text, toBoltParams(stmt.params));
      return res.records.map((r) => r.toObject() as Record<string, unknown>);
    } finally {
      await session.close();
    }
  }

  /** Run several reads in parallel on independent sessions (reads parallelize; only writes do not). */
  async readAll(stmts: Stmt[]): Promise<Record<string, unknown>[][]> {
    return Promise.all(stmts.map((s) => this.read(s)));
  }

  /** Write a single statement through the serialized writer; advance the bookmark. */
  async write(stmt: Stmt): Promise<void> {
    assertCypher(stmt.text);
    const over = lintBatchSize(stmt.params);
    if (over.length > 0) throw new Error(over[0]!.message);
    const session = this.driver.session({
      database: this.database,
      defaultAccessMode: neo4j.session.WRITE,
      bookmarks: this.bookmarks,
    });
    try {
      await session.run(stmt.text, toBoltParams(stmt.params));
      this.bookmarks = session.lastBookmarks();
    } finally {
      await session.close();
    }
  }

  /** Two-phase batched loader: ALL nodes, then ALL edges, ≤1024 rows/batch, single writer. */
  /**
   * A batch write, retried on HydraDB's fixed 30 s query timeout (Transaction.Terminated: SlateDB
   * compaction debt on a grown store can push an occasional MERGE batch over the limit — seen on
   * the sample-150 cache replay, where writes arrive back-to-back with no LLM pauses). Safe by
   * construction: every batch is an idempotent MERGE-by-id, so a replay changes nothing.
   */
  private async writeWithRetry(stmt: Stmt, attempts = 4): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.write(stmt);
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const code = (e as { code?: string }).code;
        const timedOut = msg.includes('query timeout') || code === 'Neo.ClientError.Transaction.Terminated';
        // ServiceUnavailable = the node itself went away (seen: OOM kill mid-load). The compose
        // restart policy brings it back in ~15 s; reconnect and wait it out before retrying.
        const nodeDown = code === 'ServiceUnavailable' || code === 'SessionExpired';
        if ((!timedOut && !nodeDown) || attempt >= attempts) throw e;
        if (nodeDown) {
          await new Promise((r) => setTimeout(r, 15_000 * attempt)); // 15s/30s/45s: container restart window
          await this.verify(); // recreates the driver; throws only if the node stays down
        } else {
          await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1))); // 2s/4s/8s: let compaction drain
        }
      }
    }
  }

  async loadTwoPhase(
    nodes: NodeBatch[],
    edges: EdgeBatch[],
    onProgress?: (phase: 'nodes' | 'edges', label: string, done: number, total: number) => void,
  ): Promise<{ nodeBatches: number; edgeBatches: number }> {
    let nodeBatches = 0;
    let edgeBatches = 0;
    for (const n of nodes) {
      const parts = chunk(n.rows);
      for (let i = 0; i < parts.length; i++) {
        await this.writeWithRetry(upsertNodes(n.label, parts[i]!));
        nodeBatches++;
        onProgress?.('nodes', n.label, i + 1, parts.length);
      }
    }
    for (const e of edges) {
      const parts = chunk(e.rows);
      for (let i = 0; i < parts.length; i++) {
        await this.writeWithRetry(upsertEdges(e.type, e.srcLabel, e.dstLabel, parts[i]!));
        edgeBatches++;
        onProgress?.('edges', e.type, i + 1, parts.length);
      }
    }
    return { nodeBatches, edgeBatches };
  }
}
