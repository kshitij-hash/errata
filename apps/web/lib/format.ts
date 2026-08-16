import { DEMO_SESSIONS } from '../config/demo';

const BY_ID = new Map(DEMO_SESSIONS.map((s) => [s.session_id, s]));

/** Positional citation label: s<session ordinal>:t<turn index> (seam #2 — turn identity is positional). */
export function citeLabel(sessionId: string, turnIndex: number): string {
  const s = BY_ID.get(sessionId);
  return `s${s ? s.ordinal + 1 : '?'}:t${turnIndex}`;
}

export function sessionOrdinal(sessionId: string): number | null {
  const s = BY_ID.get(sessionId);
  return s ? s.ordinal : null;
}

export function sessionDate(sessionId: string): string | null {
  return BY_ID.get(sessionId)?.date ?? null;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** Epoch seconds → "NOV 30 2023", the ledger voice. */
export function stamp(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')} ${d.getUTCFullYear()}`;
}

/** Epoch seconds → "Nov 2023", the scrubber voice. */
export function monthStamp(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const m = MONTHS[d.getUTCMonth()]!;
  return `${m[0]}${m.slice(1).toLowerCase()} ${d.getUTCFullYear()}`;
}

/** "400000 USD" and "$400,000" are the same fact minted twice (two extractors normalised the value
 *  differently — docs/gauntlets.md G2). Both vertices are real and both are kept in the graph; the
 *  answer card just doesn't show a predecessor that says exactly what the head says. */
export function sameValue(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\b(usd|dollars?)\b/g, '')
      .replace(/[^a-z0-9]/g, '');
  return norm(a) === norm(b);
}

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
