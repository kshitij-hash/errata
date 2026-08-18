'use client';

import { useEffect, useState } from 'react';
import { DEMO_HISTORY_ID, DEMO_SUBJECT, TIMELINE_ATTRIBUTES } from '../config/demo';
import { loadChain } from '../lib/chain';

/**
 * The revision beat above the fold, read from the graph instead of typed into the page.
 *
 * It used to read a hard-coded `$350,000 → $400,000`. A correction later moved the head to
 * $425,000 and this strip went on asserting the old chain three inches above an answer card that
 * said otherwise — the exact contradiction the demo exists to argue against. It now renders
 * whatever the chain actually holds, oldest to newest, so it cannot drift again.
 */
export function ChainStrip() {
  const attribute = TIMELINE_ATTRIBUTES[0]!.attribute;
  const [values, setValues] = useState<string[] | null>(null);

  useEffect(() => {
    let alive = true;
    loadChain(DEMO_SUBJECT, attribute, DEMO_HISTORY_ID)
      .then((c) => {
        if (!alive) return;
        const seen = new Set<string>();
        setValues(c.claims.map((x) => x.value).filter((v) => !seen.has(v) && seen.add(v)));
      })
      .catch(() => alive && setValues([]));
    return () => {
      alive = false;
    };
  }, [attribute]);

  // before the read lands (and if it never does) the claim is made without the figures, never with
  // stale ones
  if (!values || values.length < 2) return <b>the revision chain</b>;
  return (
    <b>
      {values.map((v, i) => (
        <span key={v}>
          {i > 0 && <i> → </i>}
          {v}
        </span>
      ))}
    </b>
  );
}
