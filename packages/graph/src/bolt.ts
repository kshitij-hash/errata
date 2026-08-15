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
  private readonly driver: Driver;
  private readonly database: string;
  private bookmarks: string[] = [];

  constructor(cfg: BoltConfig) {
    this.driver = makeDriver(cfg);
    this.database = cfg.database ?? 'default';
  }

  async verify(): Promise<void> {
    await this.driver.verifyConnectivity();
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
        await this.write(upsertNodes(n.label, parts[i]!));
        nodeBatches++;
        onProgress?.('nodes', n.label, i + 1, parts.length);
      }
    }
    for (const e of edges) {
      const parts = chunk(e.rows);
      for (let i = 0; i < parts.length; i++) {
        await this.write(upsertEdges(e.type, e.srcLabel, e.dstLabel, parts[i]!));
        edgeBatches++;
        onProgress?.('edges', e.type, i + 1, parts.length);
      }
    }
    return { nodeBatches, edgeBatches };
  }
}
