'use client';

import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { AskResponse, BeliefValue, TurnRow } from '../../lib/api';
import { DEMO_HISTORY_ID } from '../../config/demo';
import { citeLabel, humanDate, isCorrection, sessionDate, sessionOrdinal } from '../../lib/format';

interface Line {
  key: string;
  sessionId: string;
  turnIndex: number;
  claimId?: number;
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
  // a correction cites this conversation, not a transcript session — it gets its own plate.
  if (isCorrection(sessionId)) return `THE CORRECTION · APPENDED BY YOU${tail}`;
  const ord = sessionOrdinal(sessionId);
  const date = sessionDate(sessionId);
  return `CONVERSATION ${ord == null ? sessionId : ord + 1}${date ? ` · ${humanDate(date).toUpperCase()}` : ''}${tail}`;
}

/** long assistant turns are prose; the source column shows the head of one, not a wall of it. */
const NEIGHBOUR_CHARS = 240;
function clip(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= NEIGHBOUR_CHARS ? t : `${t.slice(0, NEIGHBOUR_CHARS - 1)}…`;
}

/**
 * The surrounding transcript for one cited span (roadmap item, now unblocked by `GET /api/turns`).
 * The cited turn itself is already on screen as the highlighted span, so the window renders the
 * NEIGHBOURS around it — who · text, in transcript order, above and below the span.
 */
function TurnWindow({ line, radius = 2 }: { line: Line; radius?: number }) {
  const [turns, setTurns] = useState<TurnRow[] | null>(null);

  useEffect(() => {
    let live = true;
    setTurns(null);
    api
      .turns(DEMO_HISTORY_ID, {
        claimId: line.claimId,
        sessionId: line.sessionId,
        aroundTurn: line.turnIndex,
        radius,
      })
      .then((r) => {
        if (live) setTurns(r.turns);
      })
      .catch(() => {
        if (live) setTurns([]); // the spans still read correctly without their neighbours
      });
    return () => {
      live = false;
    };
  }, [line.claimId, line.sessionId, line.turnIndex, radius]);

  if (!turns || turns.length === 0) return null;
  const before = turns.filter((t) => !t.anchor && t.turn_index < line.turnIndex);
  const after = turns.filter((t) => !t.anchor && t.turn_index > line.turnIndex);
  if (before.length === 0 && after.length === 0) return null;

  const row = (t: TurnRow) => (
    <div className="tline nbr" key={t.turn_id}>
      <span className="who">{t.role} ·</span> {clip(t.text)}
    </div>
  );

  return (
    <div className="nbrs">
      {before.map(row)}
      {after.map(row)}
    </div>
  );
}

/**
 * The right leaf of the Spread: the transcript evidence, always visible. The cited span takes the
 * highlighter sweep every time an answer lands; a span whose claim has been superseded keeps its
 * in-situ strike and a SUPERSEDED badge — the source is never edited, only marked. Each span is
 * shown in context: `GET /api/turns` fetches the neighbouring turns around it.
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
              <span className="who" title={citeLabel(m.citation.session_id, m.citation.turn_index)}>turn {m.citation.turn_index} ·</span> {m.span}
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
    claimId: c.claim_id,
    span: c.span,
    superseded: false,
  }));
  const struck: Line[] = predecessors.map((s, i) => ({
    key: `s${i}`,
    sessionId: s.citation.session_id,
    turnIndex: s.citation.turn_index,
    claimId: s.citation.claim_id,
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
            <div key={l.key}>
              <div className="tline">
                <span className="who" title={citeLabel(l.sessionId, l.turnIndex)}>{isCorrection(l.sessionId) ? 'filed live' : `turn ${l.turnIndex}`} ·</span>{' '}
                <span className={`hlspan${swept ? ' swept' : ''}`}>{l.span}</span>
              </div>
              {/* a correction has no surrounding transcript to open — it IS the turn */}
              {isCorrection(l.sessionId) ? null : <TurnWindow line={l} />}
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
            <div key={l.key}>
              <div className="tline">
                <span className="who" title={citeLabel(l.sessionId, l.turnIndex)}>{isCorrection(l.sessionId) ? 'filed live' : `turn ${l.turnIndex}`} ·</span>{' '}
                <span className="claimline">
                  {l.span}
                  <span className="stk" style={{ '--sx': 1, height: '1.6px' } as CSSProperties} />
                </span>
                <span className="srcbadge">SUPERSEDED</span>
              </div>
              <TurnWindow line={l} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
