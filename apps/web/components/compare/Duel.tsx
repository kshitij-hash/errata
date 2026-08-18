'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import beat from '../../fixtures/beat-0.94.json';
import { CHIPS, DEMO_HISTORY_ID, DEMO_SUBJECT } from '../../config/demo';
import { loadChain } from '../../lib/chain';
import type { Chain } from '../../lib/chain';
import { citeLabel, prefersReducedMotion } from '../../lib/format';

// Two measurements, both from eval/embed_beat.py against the real demo history, both in the
// fixture with their provenance (B3):
//   pair.cosine  — the superseded claim's span against the current claim's span. THIS is the beat's
//                  number: two claims an embedder cannot tell apart, one of them retired.
//   retrieval    — the question against dated session chunks, the granularity a vector store
//                  actually indexes. On this history its top hit is the SUPERSEDED session.
const STALE = beat.pair.superseded;
const PAIR_COSINE = beat.pair.cosine;
const RETRIEVAL = beat.retrieval;
const TYPED = `“${STALE.text}”`;

/** `current_session` is null when the current claim is not a transcript line at all (a correction
 *  lives in no session chunk). Widened here so the fixture can honestly carry either. */
interface Hit {
  cosine: number;
  session_id: string;
  session_date: string;
  session_ordinal: number;
  superseded: boolean;
}
const CURRENT_SESSION = RETRIEVAL.current_session as Hit | null;

/** the fixture's own record of the current claim — the fallback if /api/belief is unreachable */
const FIXTURE_CURRENT = beat.pair.current;

export function Duel() {
  // Opens RESOLVED. This pane used to start blank — no typed span, cos 0.0000, no verdict — until
  // someone found the "Run the duel" button, so the first thing a judge saw on /compare was an
  // empty comparison. The end state is the argument; the animation is now a replay.
  const [typed, setTyped] = useState(TYPED);
  const [cos, setCos] = useState(PAIR_COSINE);
  const [fill, setFill] = useState(PAIR_COSINE * 100);
  const [typing, setTyping] = useState(false);
  const [stamp, setStamp] = useState(true);
  const [graph, setGraph] = useState(true);
  const [verdict, setVerdict] = useState(true);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // The graph pane reads the LIVE chain, not the fixture's snapshot of it. The fixture is an
  // EMBEDDING measurement and has to stay committed (no network call to an embedding service); the
  // belief it is compared against is whatever the graph currently holds, which is the only way this
  // page cannot drift out of agreement with /ask the next time someone files a correction.
  const [chain, setChain] = useState<Chain | null>(null);
  useEffect(() => {
    let alive = true;
    loadChain(DEMO_SUBJECT, beat.pair.attribute, DEMO_HISTORY_ID)
      .then((c) => alive && setChain(c))
      .catch(() => alive && setChain(null));
    return () => {
      alive = false;
    };
  }, []);

  const head = chain?.claims.find((c) => c.id === chain.headId) ?? null;
  const struck = chain ? chain.claims.filter((c) => c.id !== chain.headId).reverse() : [];

  const clearTimers = () => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
  };

  const replay = useCallback(() => {
    clearTimers();
    if (prefersReducedMotion()) return; // already at the end state
    setTyped('');
    setCos(0);
    setFill(0);
    setStamp(false);
    setGraph(false);
    setVerdict(false);
    setTyping(true);
    let i = 0;
    timers.current.push(
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
    timers.current.push(
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
    timers.current.push(setTimeout(() => setStamp(true), 1800));
    timers.current.push(setTimeout(() => setGraph(true), 2150));
    timers.current.push(setTimeout(() => setVerdict(true), 2650));
  }, []);

  useEffect(() => clearTimers, []);

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
            {STALE.citation.session_id} · {STALE.citation.session_date} · retrieved FIRST for this question at cos{' '}
            {RETRIEVAL.top.cosine.toFixed(4)} over {RETRIEVAL.chunks} session chunks
          </div>
        </div>
        <div className="pane g">
          <div className="ph">
            <span>ERRATA · BELIEF GRAPH</span>
            <span>{chain ? 'live, as of now' : 'as of the fixture'}</span>
          </div>
          <div className={`ptext gt${graph ? ' in' : ''}`}>
            {head ? head.value : FIXTURE_CURRENT.value}
            <br />
            <span style={{ font: '400 .74rem var(--mono)', color: 'var(--sub)' }}>
              the claim no SUPERSEDES points away from ·{' '}
              {head ? citeLabel(head.session_id, head.turn_index) : FIXTURE_CURRENT.citation.session_id}
              {struck.length > 0 && (
                <>
                  {' '}
                  · struck behind it:{' '}
                  {struck.map((c, i) => (
                    <span key={c.id}>
                      {i > 0 ? ', ' : ''}
                      <s>{c.value}</s>
                    </span>
                  ))}
                </>
              )}
              <br />
              {CURRENT_SESSION
                ? `its session ranks BELOW the retired one for the same question, at cos ${CURRENT_SESSION.cosine.toFixed(4)}`
                : 'no session chunk contains it at all — it was appended as a correction, so retrieval over the transcript cannot return it at any cosine'}{' '}
              · embedder: {beat.embedder}
            </span>
          </div>
        </div>
      </div>
      <div className={`verdict${verdict ? ' in' : ''}`}>&ldquo;Similar, sure. Relevant? Almost never.&rdquo;</div>
      <div className="corrbar">
        <button type="button" className="act" onClick={replay}>
          ⟲ replay the duel
        </button>
      </div>
      <p className="mono" style={{ fontSize: '.74rem', color: 'var(--faint)', marginTop: '1.1rem' }}>
        The vector pane reads <code>apps/web/fixtures/beat-0.94.json</code> — measured on {beat.measured_at} by{' '}
        <code>{beat.measured_by}</code> against {beat.embedder} over history <code>{beat.history_id}</code>, committed,
        so the demo makes no network call to an embedding service. The {PAIR_COSINE.toFixed(4)} is the cosine between
        the two claims&rsquo; own evidence spans; {RETRIEVAL.top.cosine.toFixed(4)} is what the same embedder retrieves
        first for the question above, and it is the retired claim&rsquo;s session. The belief pane is not a fixture: it
        is <code>/api/belief</code> at page load, the same read{' '}
        <Link href={`/?q=${encodeURIComponent(CHIPS[0]!.question)}`}>the pre-approval answer</Link> and its{' '}
        <Link href="/timeline">revision chain</Link> are built from.
      </p>
    </div>
  );
}
