import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Field notes',
  description:
    'What broke, honestly — the substrate limits we hit, the workaround beside each, and what we will not claim.',
};

/** Curated from the build repo's docs/gauntlets.md (G0–G3, Block A, Block B). */
const ROWS: { limit: string; work: string; src: string }[] = [
  {
    limit: 'The OpenCypher subset rejects IN, min()/max(), RETURN *, filtering WITH and unbounded *.',
    work: 'hand-written Cypher only; the belief head is chosen by a deterministic fold in TypeScript, not by the query',
    src: 'G0/G1',
  },
  {
    limit: 'Integer params sent as Bolt Floats are rejected on id fields.',
    work: 'neo4j.int() at one choke point (toBoltParams); 53-bit blake2b ids for nodes AND edges',
    src: 'G0',
  },
  {
    limit: 'MERGE (n:Label {id}) and two SET clauses are both rejected — only one upsert form is recognized.',
    work: 'emit MERGE (n {id}) SET n:Label, n.a = … exactly; edges carry allocated ids in a single comma-joined statement',
    src: 'G1',
  },
  {
    limit: 'algo.MSpaths with a list sourceValues: "composite parameter only supported as UNWIND input".',
    work: 'co-mention expansion deferred by design before the build started; the ask path uses id-pinned UNION arms instead',
    src: 'G1',
  },
  {
    limit: "The driver's manifest Bolt handshake intermittently mis-negotiates (RangeError in its varint read).",
    work: 'GraphClient.verify() retries and recreates the driver; the demo path uses the right-directed, id-anchored form',
    src: 'G1',
  },
  {
    limit:
      'Writer-lease demotion on write-idle re-opens SlateDB on the next write — ~200 MB retained per re-open, ratcheting to an OOM kill.',
    work: 'lease 120 s (outlives the LLM gaps), 60 s stop grace, shadow-lease backoff, and a memory guard that drains at a history boundary',
    src: 'G3',
  },
  {
    limit: 'A killed node’s lease shadows the cell; readyz reports healthy while every write is refused.',
    work: '"is not owned by this node" is treated as a wait-condition with 20/40/60 s backoff, not as corruption',
    src: 'G3',
  },
  {
    limit: 'MERGE batches time out at 30 s under compaction debt on back-to-back writes.',
    work: 'idempotent retry at 2/4/8 s; batches stay ≤1024 rows via UNWIND over Bolt',
    src: 'G3',
  },
  {
    limit: 'countLabel is a full label scan — seconds per call on 246K Turn nodes.',
    work: 'admin-only (/api/meta/health); never on the id-anchored answer path',
    src: 'Block A',
  },
  {
    limit: '13 of 500 histories reuse a session_id within the history, so session_id is not a key.',
    work: 'sessions, turns and claims key on the positional ordinal; session_id is a display property',
    src: 'Block A',
  },
  {
    limit: 'The upstream image ships no curl, wget or nc — the compose healthcheck could never run.',
    work: 'a bash /dev/tcp probe of /readyz on the admin port; healthy in ~10 s from cold',
    src: 'Block B',
  },
];

export default function LimitsPage() {
  return (
    <main className="route limits">
      <h1 className="rtitle">Field notes — what the substrate rejected, and the workaround beside each</h1>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Limit we hit</th>
              <th>Our workaround</th>
              <th>Gauntlet</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.limit}>
                <td>{r.limit}</td>
                <td className="mono">{r.work}</td>
                <td className="mono">{r.src}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={3} className="mono nongoals">
                non-goals: benchmark supremacy · schema-free magic · answers without citations · deleting anything, ever
                · dark mode (the print metaphor is light, deliberately)
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </main>
  );
}
