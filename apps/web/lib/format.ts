import { DEMO_SESSIONS } from '../config/demo';

const BY_ID = new Map(DEMO_SESSIONS.map((s) => [s.session_id, s]));

/**
 * The synthetic session a correction's own claim cites (apps/api/src/correction.ts, via
 * @errata/ingest's buildCorrection): `session_id "user-correction"`, `turn_index -1`. It is a real
 * citation — it just points at this conversation instead of a transcript line, and there is no
 * ordinal to number it with.
 */
export const CORRECTION_SESSION = 'user-correction';

export function isCorrection(sessionId: string): boolean {
  return sessionId === CORRECTION_SESSION;
}

/** Positional citation label: s<session ordinal>:t<turn index> (integration seam — turn identity is positional). */
export function citeLabel(sessionId: string, turnIndex: number): string {
  if (isCorrection(sessionId)) return 'your correction';
  const s = BY_ID.get(sessionId);
  return `s${s ? s.ordinal + 1 : '?'}:t${turnIndex}`;
}

/** The same citation as a superscript footnote marker, where "your correction" is too long to sit
 *  beside three others on one line. */
export function citeMark(sessionId: string, turnIndex: number): string {
  return isCorrection(sessionId) ? 'you' : citeLabel(sessionId, turnIndex);
}

export function sessionOrdinal(sessionId: string): number | null {
  const s = BY_ID.get(sessionId);
  return s ? s.ordinal : null;
}

export function sessionDate(sessionId: string): string | null {
  return BY_ID.get(sessionId)?.date ?? null;
}

const MONTHS_TITLE = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2023-08-11" → "Aug 11, 2023" — the reader voice for a session date. */
export function humanDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${MONTHS_TITLE[m - 1]} ${d}, ${y}`;
}

/**
 * The reader-facing citation. The positional `s3:t2` form stays the auditor's identity for a turn
 * (citeLabel); this is the same citation said out loud: the conversation's date and the turn within
 * it. Falls back to the positional form when the session is not in the demo index.
 */
export function citeHuman(sessionId: string, turnIndex: number): string {
  if (isCorrection(sessionId)) return 'your correction, this session';
  const s = BY_ID.get(sessionId);
  if (!s) return citeLabel(sessionId, turnIndex);
  return `${humanDate(s.date)} · turn ${turnIndex}`;
}

/** The same citation when the date is already printed beside it: which conversation, which turn. */
export function citeConv(sessionId: string, turnIndex: number): string {
  if (isCorrection(sessionId)) return 'your correction';
  const s = BY_ID.get(sessionId);
  if (!s) return citeLabel(sessionId, turnIndex);
  return `conversation ${s.ordinal + 1} · turn ${turnIndex}`;
}

/** EXTRACTED/INFERRED said out loud. The uppercase tag stays the wire identity. */
export function provenanceLabel(p: string): string {
  if (p === 'EXTRACTED') return 'stated in the transcript';
  if (p === 'INFERRED') return 'inferred';
  return p.toLowerCase();
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
