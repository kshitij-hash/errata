// packages/ingest/src/reader.ts — LongMemEval reader.
//
// A LongMemEval question record is one Errata "history" (history_id == question_id). Turns have NO
// id — turn identity is the POSITIONAL 0-based index within its session; ingest and the eval harness
// MUST count the same way (shared with the eval reader). haystack_dates is index-aligned with
// haystack_session_ids and haystack_sessions.

import { parseLmeDate } from './text.js';

export interface RawTurn {
  role: string;
  content: string;
  has_answer?: boolean;
}
export interface RawRecord {
  question_id: string;
  question: string;
  answer: string;
  question_date: string;
  answer_session_ids: string[];
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: RawTurn[][];
}

export interface Turn {
  sessionId: string;
  turnIdx: number; // 0-based positional
  turnId: string; // the citation half: `${sessionId}:${turnIdx}`
  role: 'user' | 'assistant';
  text: string;
}
export interface Session {
  sessionId: string;
  ordinal: number; // 0-based position in the history
  dateIso: string; // 'YYYY-MM-DD' or ''
  epoch: number; // session date as epoch seconds, -1 if unparseable
  turns: Turn[];
}
export interface History {
  historyId: string;
  question: string;
  questionDate: string;
  answerSessionIds: string[];
  sessions: Session[];
}

const MAX_TURN_CHARS = 4000;

export function truncate(s: string, n = MAX_TURN_CHARS): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/** Parse one raw record into a structured history (pure; no I/O). */
export function parseHistory(rec: RawRecord): History {
  const sessions: Session[] = rec.haystack_sessions.map((turns, i) => {
    const sessionId = rec.haystack_session_ids[i] ?? `s${i}`;
    const rawDate = rec.haystack_dates[i] ?? '';
    const { iso, epoch } = parseLmeDate(rawDate);
    return {
      sessionId,
      ordinal: i,
      dateIso: iso,
      epoch,
      turns: turns.map((t, j) => ({
        sessionId,
        turnIdx: j,
        turnId: `${sessionId}:${j}`,
        role: t.role === 'assistant' ? 'assistant' : 'user',
        text: t.content,
      })),
    };
  });
  return {
    historyId: rec.question_id,
    question: rec.question,
    questionDate: rec.question_date,
    answerSessionIds: rec.answer_session_ids ?? [],
    sessions,
  };
}

export function turnCount(h: History): number {
  return h.sessions.reduce((n, s) => n + s.turns.length, 0);
}
