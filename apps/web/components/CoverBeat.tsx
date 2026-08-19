'use client';

import { useEffect, useState } from 'react';

const KEY = 'errata.cover.seen';

/** Decided once per page load, outside the component: StrictMode double-invokes effects, and a
 *  sessionStorage flag written by the first invocation would make the second one bail mid-beat. */
let decided: boolean | null = null;
let replaying = false;

/**
 * First visit only — wordmark, the strike drawing through *forgets*, then it
 * fades to Ask. `?stage=cover` replays it for the video title card. Any input skips it.
 * Reduced motion: the cover never plays at all (the choreography IS the content here).
 */
export function CoverBeat() {
  const [phase, setPhase] = useState<'idle' | 'play' | 'gone'>('idle');

  useEffect(() => {
    if (decided === null) {
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      replaying = new URLSearchParams(window.location.search).get('stage') === 'cover';
      decided = replaying || (!reduced && sessionStorage.getItem(KEY) !== '1');
      sessionStorage.setItem(KEY, '1');
    }
    if (!decided) return;
    setPhase('play');
    const t = setTimeout(() => setPhase('gone'), replaying ? 4200 : 2600);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (phase !== 'play') return;
    const skip = () => setPhase('gone');
    window.addEventListener('keydown', skip);
    window.addEventListener('pointerdown', skip);
    return () => {
      window.removeEventListener('keydown', skip);
      window.removeEventListener('pointerdown', skip);
    };
  }, [phase]);

  if (phase === 'idle') return null;

  return (
    <div className={`cover ${phase === 'play' ? 'play' : 'gone'}`} aria-hidden="true">
      <div className="cw">
        Errata<i>.</i>
      </div>
      <div className="ct">
        memory that{' '}
        <span className="fx">
          forgets
          <span className="cstk" />
        </span>
        &nbsp;keeps its corrections.
      </div>
      <div className="skip">click anywhere to enter · ?stage=cover replays</div>
    </div>
  );
}
