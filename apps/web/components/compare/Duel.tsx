'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import beat from '../../fixtures/beat-0.94.json';
import { CHIPS } from '../../config/demo';
import { prefersReducedMotion } from '../../lib/format';
import { readParam } from '../../lib/urlstate';

const sorted = [...beat.candidates].sort((a, b) => b.cosine - a.cosine);
/** a vector store serves the HIGHEST cosine — which here is the stale claim. That is the beat. */
const STALE = sorted[0]!;
const CURRENT = sorted[sorted.length - 1]!;
const TYPED = `“${STALE.text}”`;

export function Duel() {
  const [typed, setTyped] = useState('');
  const [typing, setTyping] = useState(false);
  const [cos, setCos] = useState(0);
  const [fill, setFill] = useState(0);
  const [stamp, setStamp] = useState(false);
  const [graph, setGraph] = useState(false);
  const [verdict, setVerdict] = useState(false);
  const [ran, setRan] = useState(false);

  const reset = useCallback(() => {
    setTyped('');
    setTyping(false);
    setCos(0);
    setFill(0);
    setStamp(false);
    setGraph(false);
    setVerdict(false);
    setRan(false);
  }, []);

  const run = useCallback(() => {
    reset();
    setRan(true);
    if (prefersReducedMotion()) {
      setTyped(TYPED);
      setCos(STALE.cosine);
      setFill(STALE.cosine * 100);
      setStamp(true);
      setGraph(true);
      setVerdict(true);
      return;
    }
    const timers: ReturnType<typeof setTimeout>[] = [];
    setTyping(true);
    let i = 0;
    timers.push(
      setTimeout(() => {
        const t = setInterval(() => {
          i += 1;
          setTyped(TYPED.slice(0, i));
          if (i >= TYPED.length) {
            clearInterval(t);
            setTyping(false);
          }
        }, 30);
      }, 220),
    );
    timers.push(
      setTimeout(() => {
        setFill(STALE.cosine * 100);
        let c = 0;
        const m = setInterval(() => {
          c += 0.02 + Math.random() * 0.03;
          if (c >= STALE.cosine) {
            c = STALE.cosine;
            clearInterval(m);
          }
          setCos(c);
        }, 40);
      }, 280),
    );
    timers.push(setTimeout(() => setStamp(true), 1800));
    timers.push(setTimeout(() => setGraph(true), 2150));
    timers.push(setTimeout(() => setVerdict(true), 2650));
    return () => timers.forEach(clearTimeout);
  }, [reset]);

  // ?stage=1 auto-runs the duel (36 §4.4) — the video needs it to start without a click
  useEffect(() => {
    if (readParam('stage') != null) run();
  }, [run]);

  return (
    <div className="card">
      <p className="q">{beat.query}</p>
      <div className="duel">
        <div className="pane v">
          <div className="ph">
            <span>VECTOR SEARCH</span>
            <span>cos {cos.toFixed(4)}</span>
          </div>
          <div className={`ptext${typing ? ' typing' : ''}`}>{typed}</div>
          <div className="meter2">
            <div className="mbar">
              <div className="mfill" style={{ width: `${fill}%` }} />
            </div>
            <span>similarity</span>
          </div>
          <div className={`stamp${stamp ? ' in' : ''}`}>SUPERSEDED FACT</div>
        </div>
        <div className="pane g">
          <div className="ph">
            <span>ERRATA · BELIEF GRAPH</span>
            <span>as of today</span>
          </div>
          <div className={`ptext gt${graph ? ' in' : ''}`}>
            {CURRENT.text}
            <br />
            <span style={{ font: '400 .74rem var(--mono)', color: 'var(--sub)' }}>
              the claim no SUPERSEDES points away from · cos {CURRENT.cosine.toFixed(4)} — lower, and right · embedder:{' '}
              {beat.embedder}
            </span>
          </div>
        </div>
      </div>
      <div className={`verdict${verdict ? ' in' : ''}`}>&ldquo;Similar, sure. Relevant? Almost never.&rdquo;</div>
      <div className="corrbar">
        <button type="button" className="act" onClick={run}>
          {ran ? 'Run it again' : 'Run the duel'}
        </button>
        <button type="button" className="act ghosty" onClick={reset}>
          reset
        </button>
      </div>
      <p className="mono" style={{ fontSize: '.74rem', color: 'var(--faint)', marginTop: '1.1rem' }}>
        both panes read <code>apps/web/fixtures/beat-0.94.json</code> — cosines computed offline against {beat.embedder}
        , committed, so the demo makes no network call to an embedding service. The same shape on live graph data:{' '}
        <Link href={`/?q=${encodeURIComponent(CHIPS[0]!.question)}`}>the pre-approval answer</Link> and its{' '}
        <Link href="/timeline">revision chain</Link>.
      </p>
    </div>
  );
}
