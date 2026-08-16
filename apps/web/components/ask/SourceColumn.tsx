import type { CSSProperties } from 'react';
import type { AskResponse, BeliefValue } from '../../lib/api';
import { citeLabel, sessionDate, sessionOrdinal } from '../../lib/format';

interface Line {
  key: string;
  sessionId: string;
  turnIndex: number;
  span: string;
  superseded: boolean;
}

function group(lines: Line[]): { sessionId: string; lines: Line[] }[] {
  const out: { sessionId: string; lines: Line[] }[] = [];
  for (const l of lines) {
    const last = out[out.length - 1];
    if (last && last.sessionId === l.sessionId) last.lines.push(l);
    else out.push({ sessionId: l.sessionId, lines: [l] });
  }
  return out;
}

function header(sessionId: string, tail: string): string {
  const ord = sessionOrdinal(sessionId);
  const date = sessionDate(sessionId);
  return `SESSION ${ord == null ? sessionId : ord + 1}${date ? ` · ${date}` : ''}${tail}`;
}

/**
 * The right leaf of the Spread: the transcript evidence, always visible. The cited span takes the
 * highlighter sweep every time an answer lands; a span whose claim has been superseded keeps its
 * in-situ strike and a SUPERSEDED badge — the source is never edited, only marked.
 *
 * NOTE: spans only. The surrounding turns the work order asks for need a turn/transcript read the
 * API does not expose yet (blocker B2).
 */
export function SourceColumn({
  resp,
  swept,
  predecessors,
}: {
  resp: AskResponse | null;
  swept: boolean;
  predecessors: BeliefValue[];
}) {
  if (!resp) {
    return (
      <div>
        <div className="smallcaps">THE SOURCE</div>
        <div className="tline">— pick a question; the transcript evidence lands here —</div>
      </div>
    );
  }

  if (resp.abstained) {
    const seen = new Set<string>();
    const misses = (resp.nearest_miss ?? [])
      .filter((m) => m.s > 0)
      .filter((m) => !seen.has(m.span) && seen.add(m.span));
    return (
      <div>
        <div className="smallcaps" style={{ marginBottom: '.5rem' }}>
          NEAREST SOURCES · CONSIDERED
        </div>
        {misses.length === 0 ? (
          <div className="tline">— nothing in this history came near the question —</div>
        ) : (
          misses.map((m, i) => (
            <div className="tline" key={`${m.attribute}-${i}`}>
              <span className="who">{citeLabel(m.citation.session_id, m.citation.turn_index)} ·</span> {m.span}
            </div>
          ))
        )}
      </div>
    );
  }

  const cited: Line[] = resp.citations.map((c, i) => ({
    key: `c${i}`,
    sessionId: c.session_id,
    turnIndex: c.turn_index,
    span: c.span,
    superseded: false,
  }));
  const struck: Line[] = predecessors.map((s, i) => ({
    key: `s${i}`,
    sessionId: s.citation.session_id,
    turnIndex: s.citation.turn_index,
    span: s.evidence_span,
    superseded: true,
  }));

  return (
    <div>
      {group(cited).map((g, gi) => (
        <div key={`cur-${g.sessionId}-${gi}`}>
          <div className="smallcaps" style={{ margin: gi === 0 ? '0 0 .5rem' : '1rem 0 .45rem' }}>
            {header(g.sessionId, ' · THE SOURCE')}
          </div>
          {g.lines.map((l) => (
            <div className="tline" key={l.key}>
              <span className="who">{citeLabel(l.sessionId, l.turnIndex)} ·</span>{' '}
              <span className={`hlspan${swept ? ' swept' : ''}`}>{l.span}</span>
            </div>
          ))}
        </div>
      ))}
      {group(struck).map((g, gi) => (
        <div key={`old-${g.sessionId}-${gi}`}>
          <div className="smallcaps" style={{ margin: '1rem 0 .45rem' }}>
            {header(g.sessionId, ' · SUPERSEDED')}
          </div>
          {g.lines.map((l) => (
            <div className="tline" key={l.key}>
              <span className="who">{citeLabel(l.sessionId, l.turnIndex)} ·</span>{' '}
              <span className="claimline">
                {l.span}
                <span className="stk" style={{ '--sx': 1, height: '1.6px' } as CSSProperties} />
              </span>
              <span className="srcbadge">SUPERSEDED</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
