'use client';

import { useEffect, useMemo, useState } from 'react';
import type { AskResponse } from '../../lib/api';
import { citeHuman, citeLabel, prefersReducedMotion } from '../../lib/format';

type RowState = 'hidden' | 'in' | 'aside';

/**
 * The refusal choreography (prototype F): each nearest miss is considered, then visibly set aside
 * with the reason it does not answer, and only then does the author's query file itself in.
 * Reduced motion collapses the whole thing to its end state.
 */
export function Refusal({ resp, replayKey }: { resp: AskResponse; replayKey: number }) {
  // one row per attribute: the graph legitimately holds several claim vertices for the same
  // attribute (two extractors normalised the value differently), and repeating them reads as noise.
  const misses = useMemo(() => {
    const seen = new Set<string>();
    return (resp.nearest_miss ?? [])
      .filter((m) => m.s > 0)
      .filter((m) => !seen.has(m.attribute) && seen.add(m.attribute))
      .slice(0, 3);
  }, [resp.nearest_miss]);
  const [rows, setRows] = useState<RowState[]>(() => misses.map(() => 'hidden'));
  const [abst, setAbst] = useState(false);

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (prefersReducedMotion()) {
      setRows(misses.map(() => 'aside'));
      setAbst(true);
      return;
    }
    setRows(misses.map(() => 'hidden'));
    setAbst(false);
    misses.forEach((_, i) => {
      timers.push(setTimeout(() => setRows((r) => r.map((v, j) => (j === i ? 'in' : v))), 180 + i * 520));
      timers.push(setTimeout(() => setRows((r) => r.map((v, j) => (j === i ? 'aside' : v))), 560 + i * 520));
    });
    timers.push(setTimeout(() => setAbst(true), 180 + misses.length * 520 + 320));
    return () => timers.forEach(clearTimeout);
    // the choreography re-runs on a new answer or an explicit replay ('.' in stage mode)
  }, [resp.trace_id, replayKey, misses]);

  return (
    <div>
      {misses.map((m, i) => (
        <div
          className={`consider${rows[i] === 'hidden' ? '' : rows[i] === 'in' ? ' in' : ' in aside'}`}
          key={`${m.attribute}-${i}`}
        >
          <span className="cw2">
            &ldquo;{m.value.length > 58 ? `${m.value.slice(0, 57)}…` : m.value}
            &rdquo;
            <span className="cite2" title={citeLabel(m.citation.session_id, m.citation.turn_index)}>{citeHuman(m.citation.session_id, m.citation.turn_index)}</span>
            <span className="cstk2" />
          </span>
          <span className="why">
            — {m.attribute.replace(/_/g, ' ')} · fit {m.s.toFixed(2)}. set aside.
          </span>
        </div>
      ))}
      {misses.length === 0 && <div className="consider in">nothing in this history came near the question.</div>}
      <div className={`abst${abst ? ' in' : ''}`}>
        <div className="qh">AUTHOR&apos;S QUERY</div>
        <div className="qt">The history never says.</div>
        <div className="qs">
          abstained · evidence {resp.confidence.toFixed(2)}
          {resp.evidence ? ` below τ ${resp.evidence.tau.toFixed(2)}` : ''} · {misses.length} nearest{' '}
          {misses.length === 1 ? 'miss' : 'misses'} cited above · {resp.latency_ms.toFixed(0)} ms
        </div>
      </div>
    </div>
  );
}
