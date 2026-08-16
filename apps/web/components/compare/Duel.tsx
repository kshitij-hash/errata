'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import beat from '../../fixtures/beat-0.94.json';
import { CHIPS } from '../../config/demo';
import { prefersReducedMotion } from '../../lib/format';
import { readParam } from '../../lib/urlstate';

// Two measurements, both from eval/embed_beat.py against the real demo history, both in the
// fixture with their provenance (B3):
//   pair.cosine  — the superseded claim's span against the current claim's span. THIS is the beat's
//                  number: two claims an embedder cannot tell apart, one of them retired.
//   retrieval    — the question against dated session chunks, the granularity a vector store
//                  actually indexes. On this history its top hit is the SUPERSEDED session.
const STALE = beat.pair.superseded;
const CURRENT = beat.pair.current;
const PAIR_COSINE = beat.pair.cosine;
const RETRIEVAL = beat.retrieval;
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
      setCos(PAIR_COSINE);
      setFill(PAIR_COSINE * 100);
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
        setFill(PAIR_COSINE * 100);
        let c = 0;
        const m = setInterval(() => {
          c += 0.02 + Math.random() * 0.03;
          if (c >= PAIR_COSINE) {
            c = PAIR_COSINE;
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
            <span>similarity to the current claim</span>
          </div>
          <div className={`stamp${stamp ? ' in' : ''}`}>SUPERSEDED FACT</div>
          <div className="pnote">
            {STALE.citation.session_id} · {STALE.citation.session_date} · retrieved FIRST for this
            question at cos {RETRIEVAL.top.cosine.toFixed(4)} over {RETRIEVAL.chunks} session chunks
          </div>
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
              the claim no SUPERSEDES points away from · {CURRENT.citation.session_id} ·{' '}
              {CURRENT.citation.session_date} · its session ranks BELOW the retired one for the same
              question, at cos {RETRIEVAL.current_session.cosine.toFixed(4)} · embedder: {beat.embedder}
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
        both panes read <code>apps/web/fixtures/beat-0.94.json</code> — measured on {beat.measured_at} by{' '}
        <code>{beat.measured_by}</code> against {beat.embedder} over history <code>{beat.history_id}</code>, committed,
        so the demo makes no network call to an embedding service. The {PAIR_COSINE.toFixed(4)} is the cosine between
        the two claims&rsquo; own evidence spans; {RETRIEVAL.top.cosine.toFixed(4)} vs{' '}
        {RETRIEVAL.current_session.cosine.toFixed(4)} is what the same embedder retrieves for the question above. The
        same shape on live graph data:{' '}
        <Link href={`/?q=${encodeURIComponent(CHIPS[0]!.question)}`}>the pre-approval answer</Link> and its{' '}
        <Link href="/timeline">revision chain</Link>.
      </p>
    </div>
  );
}
