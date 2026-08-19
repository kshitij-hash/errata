'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Chain } from '../../lib/chain';
import { citeConv, citeHuman, citeLabel, monthStamp, prefersReducedMotion, provenanceLabel, stamp } from '../../lib/format';
import { IconElbow, IconPause, IconPlay, IconReplay } from '../icons';

const AUTOPLAY_MS = 5000;

interface Span {
  t0: number;
  t1: number;
}

function spanOf(chain: Chain): Span {
  const times = chain.claims.map((c) => c.event_time);
  if (times.length === 0) return { t0: 0, t1: 1 };
  const lo = Math.min(...times);
  const hi = Math.max(...times);
  const pad = Math.max((hi - lo) * 0.12, 86_400 * 21);
  return { t0: lo - pad, t1: hi + pad };
}

const atOf = (s: Span, v: number): number => s.t0 + ((s.t1 - s.t0) * v) / 100;

/**
 * The hybrid Timeline: a big rewriting belief atop the ledger chain. Every entry, strike, edge
 * label and citation is real claim data — births are the claims' own event_times.
 *
 * It OPENS RESOLVED — at today, with the current belief and every strike already on screen — and
 * the transport button replays the rewrite. It used to autoplay from t=0 on entry, which meant the
 * first ~5 seconds of the page a judge sees read "— nothing yet —" over an empty ledger. The
 * animation is the argument, but it is worth nothing if the resting state is blank.
 */
export function HistoryTab({ chain }: { chain: Chain }) {
  const span = useMemo(() => spanOf(chain), [chain]);
  const [v, setV] = useState(100);
  const [playing, setPlaying] = useState(false);
  const [done, setDone] = useState(true);
  const raf = useRef<number | null>(null);
  const start = useRef<{ t: number; from: number } | null>(null);

  const step = useCallback((now: number) => {
    const s = start.current;
    if (!s) return;
    const p = Math.min(1, ((now - s.t) / AUTOPLAY_MS) * ((100 - s.from) / 100 || 1));
    const eased = 1 - Math.pow(1 - p, 2.1);
    setV(s.from + (100 - s.from) * eased);
    if (p < 1) raf.current = requestAnimationFrame(step);
    else {
      setPlaying(false);
      setDone(true);
    }
  }, []);

  const play = useCallback(
    (from: number) => {
      if (raf.current) cancelAnimationFrame(raf.current);
      // reduced motion gets the end state, not a 5s rewrite it did not ask for
      if (prefersReducedMotion()) {
        setV(100);
        setPlaying(false);
        setDone(true);
        return;
      }
      start.current = { t: performance.now(), from };
      setV(from);
      setPlaying(true);
      raf.current = requestAnimationFrame(step);
    },
    [step],
  );

  const pause = useCallback(() => {
    if (raf.current) cancelAnimationFrame(raf.current);
    setPlaying(false);
  }, []);

  // opens at today; a switched attribute re-lands there rather than rewinding to an empty ledger
  useEffect(() => {
    if (raf.current) cancelAnimationFrame(raf.current);
    setV(100);
    setPlaying(false);
    setDone(true);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [chain]);

  const at = atOf(span, v);
  const born = chain.claims.filter((c) => c.event_time <= at);
  // struck = the target of a born SUPERSEDES edge, or a claim the fold set aside once something
  // later than it exists (the head is chosen by the fold, not by the edges alone)
  const foldAside = new Set(chain.supersededIds);
  const struckIds = new Set(
    chain.claims
      .filter(
        (c) =>
          chain.revisions.some((r) => r.olderId === c.id && r.at <= at) ||
          (foldAside.has(c.id) && born.some((o) => o.event_time > c.event_time)),
      )
      .map((c) => c.id),
  );
  const live = born.filter((c) => !struckIds.has(c.id));
  const current = live.length > 0 ? live[live.length - 1]! : null;

  // newest first, the way a ledger reads
  const ledger = [...chain.claims].reverse();

  return (
    <div className="card">
      <div className="bar">
        <button
          type="button"
          aria-label={playing ? 'pause' : done ? 'replay' : 'play'}
          onClick={() => (playing ? pause() : play(v >= 100 ? 0 : v))}
        >
          {playing ? <IconPause /> : done && v >= 99.5 ? <IconReplay /> : <IconPlay />}
        </button>
        <input
          type="range"
          min={0}
          max={100}
          step={0.1}
          value={v}
          aria-label="playhead"
          onChange={(e) => {
            pause();
            setDone(true);
            setV(Number(e.target.value));
          }}
        />
        <span className="date">{monthStamp(at)}</span>
      </div>

      <div className="now">
        <div className="smallcaps">CURRENT BELIEF · THE USER — {chain.attribute.replace(/_/g, ' ')}</div>
        <div className="bigwrap">
          <div className={`big${current == null ? ' on' : ''}`} style={{ color: 'var(--faint)' }}>
            — nothing yet —
          </div>
          {chain.claims.map((c) => (
            <div
              key={c.id}
              className={`big${current?.id === c.id ? ' on' : ''}`}
              style={c.id === chain.headId ? { color: 'var(--teal)' } : undefined}
            >
              {c.value}
              <span className="cite" title={citeLabel(c.session_id, c.turn_index)}>{citeHuman(c.session_id, c.turn_index)}</span>
            </div>
          ))}
        </div>
        <div className="nowmeta">
          {current == null
            ? 'the history begins…'
            : `held since ${stamp(current.event_time)} · ${struckIds.size} superseded, kept · chain length ${chain.claims.length} · ${provenanceLabel(current.provenance)}`}
        </div>
      </div>

      <div className="ledger">
        {ledger.map((c) => {
          const isBorn = c.event_time <= at;
          const isOld = struckIds.has(c.id);
          const rev = chain.revisions.find((r) => r.newerId === c.id);
          const older = rev ? chain.claims.find((x) => x.id === rev.olderId) : undefined;
          return (
            <div key={c.id}>
              <div className={`lc${isBorn ? ' in' : ''}${isOld ? ' old' : ''}`}>
                <div className="when">
                  <span title={citeLabel(c.session_id, c.turn_index)}>{stamp(c.event_time)} · {citeConv(c.session_id, c.turn_index)}</span>
                </div>
                <span className="what">
                  {c.value}
                  <span className="stk" style={{ '--sx': isOld ? 1 : 0 } as CSSProperties} />
                </span>
                <span className="cite">
                  confidence {c.confidence.toFixed(2)} · {provenanceLabel(c.provenance)}
                </span>
              </div>
              {rev && (
                <div className={`redgeL${isBorn ? ' in' : ''}`}>
                  <IconElbow className="iel" /> {rev.relation}
                  {older ? ` · ${older.value}` : ''}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className={`hintline${done ? ' in' : ''}`}>
        now it&apos;s yours — drag the playhead. every strike is an edge; nothing was deleted.
      </div>
    </div>
  );
}
