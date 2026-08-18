import type { CypherStmt } from '../lib/api';

/** The revision relations the demo's whole thesis rests on — labelled so the traversal that does
 *  the work is findable without reading five statements of Cypher. */
const RELATIONS: Record<string, string> = {
  SUPERSEDES: 'the edge that retires a claim',
  CONTRADICTS: 'the edge that puts two claims in conflict',
  SUPPORTS: 'the edge that corroborates a claim',
};

function relationOf(text: string): [string, string] | null {
  const hit = Object.keys(RELATIONS).find((r) => text.includes(`:${r}]`));
  return hit ? [hit, RELATIONS[hit]!] : null;
}

/**
 * The disclosure the whole thesis rests on: the exact hand-written Cypher behind this answer.
 *
 * `defaultOpen` is on for an answered card. Folded away, the single most persuasive artifact on the
 * page — the SUPERSEDES traversal that is the reason the answer is the corrected value and not the
 * retired one — was one click nobody takes. It opens, and the relation each statement traverses is
 * tagged in the margin.
 */
export function CypherDisclosure({
  statements,
  defaultOpen = false,
}: {
  statements: CypherStmt[];
  defaultOpen?: boolean;
}) {
  if (statements.length === 0) return null;
  return (
    <details className="cypher" open={defaultOpen}>
      <summary>the Cypher behind this answer · {statements.length} statements</summary>
      {statements.map((s, i) => {
        const rel = relationOf(s.text);
        return (
          <div key={i}>
            {rel && (
              <div className={`cyrel${rel[0] === 'SUPERSEDES' ? ' lead' : ''}`}>
                {rel[0]} traversal · {rel[1]}
              </div>
            )}
            <pre>{s.text}</pre>
            <div className="params">{JSON.stringify(s.params)}</div>
          </div>
        );
      })}
    </details>
  );
}
