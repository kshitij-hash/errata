'use client';

import { useEffect, useState } from 'react';
import { DEMO_HISTORY_ID, DEMO_SUBJECT, TIMELINE_ATTRIBUTES } from '../../config/demo';
import { loadChain } from '../../lib/chain';
import { citeLabel, citeMark, sameValue } from '../../lib/format';

interface Beat {
  head: { value: string; cite: string; span: string };
  struck: { value: string; cite: string }[];
}

const MECHANISM = 'every strike is a SUPERSEDES edge; nothing deleted, all of it queryable';

/**
 * The hero's first beat, read from the graph rather than typed into the page — the same read
 * the timeline makes, and for the same reason: a hero that asserts a chain the answer card below it
 * contradicts is the exact failure this demo exists to argue against. Before the read lands, and if
 * it never does, the claim is made without the figures and never with stale ones.
 */
export function HeroChain() {
  const attribute = TIMELINE_ATTRIBUTES[0]!.attribute;
  const [beat, setBeat] = useState<Beat | null>(null);

  useEffect(() => {
    let alive = true;
    loadChain(DEMO_SUBJECT, attribute, DEMO_HISTORY_ID)
      .then((c) => {
        if (!alive) return;
        const head = c.claims.find((x) => x.id === c.headId);
        if (!head) return;
        const superseded = new Set(c.supersededIds);
        const seen = new Set<string>();
        setBeat({
          head: {
            value: head.value,
            cite: citeMark(head.session_id, head.turn_index),
            span: head.span,
          },
          struck: c.claims
            .filter((x) => superseded.has(x.id) && !sameValue(x.value, head.value))
            .filter((x) => !seen.has(x.value) && seen.add(x.value))
            .map((x) => ({ value: x.value, cite: citeLabel(x.session_id, x.turn_index) })),
        });
      })
      .catch(() => alive && setBeat(null));
    return () => {
      alive = false;
    };
  }, [attribute]);

  if (!beat || beat.struck.length === 0) {
    return (
      <>
        <p className="bbody">
          <span className="bhead">the revision chain</span>
        </p>
        <p className="bcap">{MECHANISM}</p>
      </>
    );
  }

  return (
    <>
      <p className="bbody">
        {beat.struck.map((s) => (
          <span className="bstruck" key={s.value}>
            <s>{s.value}</s>
            <i className="bcite">{s.cite}</i>
          </span>
        ))}
        <span className="bhead">{beat.head.value}</span>
      </p>
      <p className="bcap">
        {beat.head.cite} · &ldquo;{beat.head.span}&rdquo; · {MECHANISM}
      </p>
    </>
  );
}
