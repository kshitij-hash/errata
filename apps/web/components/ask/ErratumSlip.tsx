'use client';

import { useEffect, useState } from 'react';
import { prefersReducedMotion } from '../../lib/format';

export interface SlipState {
  /** the corrected value, typed on at ~34ms/char */
  value: string;
  caption: string;
  error?: boolean;
  /** bumped to replay the choreography */
  nonce: number;
}

/**
 * Prototype B, exactly: the slip arrives on --ease-spring 500ms and the correction types itself on
 * at ~34ms/char. Reduced motion: the slip is simply already there, fully typed.
 */
export function ErratumSlip({ slip }: { slip: SlipState | null }) {
  const [visible, setVisible] = useState(false);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (!slip) {
      setVisible(false);
      setTyped('');
      return;
    }
    if (prefersReducedMotion()) {
      setVisible(true);
      setTyped(slip.value);
      return;
    }
    setVisible(false);
    setTyped('');
    const timers: ReturnType<typeof setTimeout>[] = [];
    // the strike through the old belief runs first (600ms), then the slip files in
    timers.push(setTimeout(() => setVisible(true), 600));
    let i = 0;
    const start = setTimeout(() => {
      const t = setInterval(() => {
        i += 1;
        setTyped(slip.value.slice(0, i));
        if (i >= slip.value.length) clearInterval(t);
      }, 34);
      timers.push(t as unknown as ReturnType<typeof setTimeout>);
    }, 1000);
    timers.push(start);
    return () => timers.forEach(clearTimeout);
  }, [slip?.nonce, slip?.value, slip]);

  if (!slip) return null;

  return (
    <div className={`slip${visible ? ' in' : ''}${slip.error ? ' err' : ''}`} aria-live="polite">
      <div className="sh">ERRATUM · YOUR CORRECTION · JUST NOW</div>
      <div className="st">{typed}</div>
      <div className={slip.error ? 'sc errline' : 'sc'}>{slip.caption}</div>
    </div>
  );
}
