'use client';

import { useEffect, useState } from 'react';
import { api, usd } from '../lib/api';
import { DEMO_HISTORY_ID } from '../config/demo';

/** Masthead cost meter (36 §4.1): the ledger rollup, polled every 30s, in mono tabular figures. */
export function CostMeter() {
  const [spend, setSpend] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const pull = () => {
      api
        .costs()
        .then((c) => {
          if (alive) setSpend(c.spent_usd);
        })
        .catch(() => {
          /* the meter is decoration for a dead API — never a page error */
        });
    };
    pull();
    const t = setInterval(pull, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="meter" title="ledger rollup — every model call this project has ever made">
      spend <b>{spend == null ? '$——.————' : usd(spend)}</b> · h:
      {DEMO_HISTORY_ID}
    </div>
  );
}
