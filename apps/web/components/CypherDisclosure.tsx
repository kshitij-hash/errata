import type { CypherStmt } from '../lib/api';

/** The disclosure the whole thesis rests on: the exact hand-written Cypher behind this answer. */
export function CypherDisclosure({ statements }: { statements: CypherStmt[] }) {
  if (statements.length === 0) return null;
  return (
    <details className="cypher">
      <summary>the Cypher behind this answer · {statements.length} statements</summary>
      {statements.map((s, i) => (
        <div key={i}>
          <pre>{s.text}</pre>
          <div className="params">{JSON.stringify(s.params)}</div>
        </div>
      ))}
    </details>
  );
}
