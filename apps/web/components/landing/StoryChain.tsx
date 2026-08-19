'use client';

import { useEffect, useState } from 'react';
import { DEMO_HISTORY_ID, DEMO_SUBJECT, TIMELINE_ATTRIBUTES } from '../../config/demo';
import { loadChain, type ChainClaim } from '../../lib/chain';
import { citeHuman, isCorrection, sameValue, stamp } from '../../lib/format';

/**
 * The landing's story, read from the live graph — the same two id-anchored reads the timeline
 * makes. Nothing here is typed into the page: if the graph changed tomorrow, so would the story.
 * Until the read lands (and if it never does) the pinned fallback tells the same story in the
 * same shape, clearly marked as the story rather than the live chain.
 */
interface Beat {
  date: string;
  cite: string;
  span: string;
  value: string;
  struck: boolean;
  correction: boolean;
}

const FALLBACK: Beat[] = [
  { date: 'AUG 11 2023', cite: 'a conversation', span: 'pre-approved for $350,000 from Wells Fargo.', value: '$350,000', struck: true, correction: false },
  { date: 'NOV 30 2023', cite: 'a later conversation', span: 'I got pre-approved for $400,000 from Wells Fargo', value: '$400,000', struck: true, correction: false },
  { date: 'AUG 18 2026', cite: 'a live correction', span: 'corrected by the user to $425,000', value: '$425,000', struck: false, correction: true },
];

export function StoryChain() {
  const attribute = TIMELINE_ATTRIBUTES[0]!.attribute;
  const [beats, setBeats] = useState<Beat[]>(FALLBACK);
  const [live, setLive] = useState(false);

  useEffect(() => {
    let alive = true;
    loadChain(DEMO_SUBJECT, attribute, DEMO_HISTORY_ID)
      .then((c) => {
        if (!alive || c.headId == null) return;
        const head = c.claims.find((x) => x.id === c.headId);
        if (!head) return;
        const superseded = new Set(c.supersededIds);
        const seen = new Set<string>();
        const picked: ChainClaim[] = c.claims
          .filter((x) => x.id === c.headId || superseded.has(x.id))
          .filter((x) => x.id === c.headId || !sameValue(x.value, head.value))
          .filter((x) => {
            const k = x.value.toLowerCase();
            return !seen.has(k) && seen.add(k);
          });
        if (picked.length < 2) return;
        setBeats(
          picked.map((x) => ({
            date: stamp(x.event_time),
            cite: citeHuman(x.session_id, x.turn_index),
            span: x.span,
            value: x.value,
            struck: x.id !== c.headId,
            correction: isCorrection(x.session_id),
          })),
        );
        setLive(true);
      })
      .catch(() => {
        /* the fallback already tells the story */
      });
    return () => {
      alive = false;
    };
  }, [attribute]);

  return (
    <div className="story-chain" data-live={live || undefined}>
      {beats.map((b, i) => (
        <div className={`story-beat${b.correction ? ' is-correction' : ''}`} key={b.value}>
          <p className="sb-when">
            <i>{i + 1}</i> {b.date}
            {b.correction ? ' · filed through the API' : ''}
          </p>
          <p className="sb-quote">&ldquo;{b.span}&rdquo;</p>
          <p className="sb-value">{b.struck ? <s>{b.value}</s> : <b>{b.value}</b>}</p>
        </div>
      ))}
      <p className="story-cap">
        {live ? 'read from the live graph just now' : 'the chain as ingested'} — every strike is a{' '}
        <span className="mono">SUPERSEDES</span> edge; nothing was deleted, all of it is still queryable
      </p>
    </div>
  );
}
