'use client';

import { useEffect, useState } from 'react';
import { loadChain } from '../../lib/chain';
import type { Chain } from '../../lib/chain';
import { readParam, writeParams } from '../../lib/urlstate';
import { DEMO_HISTORY_ID, DEMO_SUBJECT, TIMELINE_ATTRIBUTES } from '../../config/demo';
import { HistoryTab } from './HistoryTab';
import { Constellation } from './Constellation';

type Tab = 'hist' | 'graph';

export function TimelinePanel() {
  const [tab, setTab] = useState<Tab>('hist');
  const [attribute, setAttribute] = useState(TIMELINE_ATTRIBUTES[0]!.attribute);
  const [chain, setChain] = useState<Chain | null>(null);
  const [error, setError] = useState<string | null>(null);

  // URL-addressable: ?tab=graph&attr=…
  useEffect(() => {
    const t = readParam('tab');
    if (t === 'graph') setTab('graph');
    const a = readParam('attr');
    if (a && TIMELINE_ATTRIBUTES.some((x) => x.attribute === a)) setAttribute(a);
  }, []);

  useEffect(() => {
    let alive = true;
    setChain(null);
    setError(null);
    loadChain(DEMO_SUBJECT, attribute, DEMO_HISTORY_ID)
      .then((c) => {
        if (alive) setChain(c);
      })
      .catch((e) => {
        if (alive) setError(String(e instanceof Error ? e.message : e));
      });
    return () => {
      alive = false;
    };
  }, [attribute]);

  return (
    <>
      <div className="tabs">
        <button
          type="button"
          className={`tab${tab === 'hist' ? ' on' : ''}`}
          onClick={() => {
            setTab('hist');
            writeParams({ tab: null });
          }}
        >
          History
        </button>
        <button
          type="button"
          className={`tab${tab === 'graph' ? ' on' : ''}`}
          onClick={() => {
            setTab('graph');
            writeParams({ tab: 'graph' });
          }}
        >
          Constellation
        </button>
        <select
          className="picker"
          value={attribute}
          aria-label="subject and attribute"
          onChange={(e) => {
            setAttribute(e.target.value);
            writeParams({ attr: e.target.value });
          }}
        >
          {TIMELINE_ATTRIBUTES.map((a) => (
            <option key={a.attribute} value={a.attribute}>
              the user · {a.label}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="card">
          <div className="sh mono" style={{ color: 'var(--red)' }}>
            THE API DID NOT ANSWER
          </div>
          <div className="mono" style={{ fontSize: '.8rem' }}>
            {error}
          </div>
        </div>
      )}
      {!error && !chain && <div className="hairline" aria-label="loading the chain" />}
      {!error && chain && tab === 'hist' && <HistoryTab key={attribute} chain={chain} />}
      {!error && chain && tab === 'graph' && <Constellation attribute={attribute} />}
    </>
  );
}
