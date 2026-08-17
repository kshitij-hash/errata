'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { CHIPS } from '../config/demo';

const ANSWERING = CHIPS.find((c) => !c.abstains)!;
const ABSTAINING = CHIPS.find((c) => c.abstains)!;

/**
 * Add-on №5: keyboard demo mode. With `?stage` on the URL, → and ← step through the five
 * beats; the routes carry the stage flag onward so each one arrives already choreographed.
 * `.` re-runs the current choreography (handled by the route that owns it). No visible UI.
 */
const BEATS = [
  '/?stage=cover',
  '/compare?stage=1',
  `/?stage=1&q=${encodeURIComponent(ANSWERING.question)}&correct=1`,
  '/timeline?stage=1',
  `/?stage=1&q=${encodeURIComponent(ABSTAINING.question)}`,
];

let index = -1;

export function StageKeys() {
  const router = useRouter();

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('stage') == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      index = e.key === 'ArrowRight' ? Math.min(BEATS.length - 1, index + 1) : Math.max(0, index - 1);
      router.push(BEATS[index]!);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

  return null;
}
