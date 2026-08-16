// packages/ingest/src/extract.ts — claim extraction behind one interface (spec 31 §3 S3).
//
// Three implementations share the `Extractor` interface so the write path is identical regardless
// of source:
//   RuleExtractor   — deterministic regex extraction over salient turns. Zero LLM, zero credits;
//                     enough to drive the belief-revision demo from the real transcript text.
//   ReplayExtractor — returns a committed fixture of claims for a history (curated demo path).
//   LlmExtractor    — the real path via @errata/llm (wired when credits are confirmed).
// The extractor NEVER decides revision edges — that is the conflict step (build.ts / core).

import { readFileSync } from 'node:fs';
import type { History, Turn } from './reader.js';
import { sessionSalience } from './text.js';

export interface ExtractedClaim {
  subject: string; // surface form
  attribute: string; // raw; mapped to the registry downstream
  value: string; // value_text (display form)
  polarity: 'AFFIRM' | 'NEGATE';
  eventTimeIso: string; // '' → fall back to the session date
  sessionId: string;
  sessionOrdinal?: number; // 0-based session position — the true identity (session_id is not unique)
  turnIdx: number; // positional citation half
  evidenceSpan: string; // ≤160 chars, verbatim
  confidence: number;
}

export interface Extractor {
  readonly model: string;
  extract(history: History): Promise<ExtractedClaim[]>;
}

function span(s: string, n = 160): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

// --- deterministic regex patterns. Each maps a first-person statement to (attribute, value). ---
interface Pattern {
  re: RegExp;
  emit: (m: RegExpExecArray, turn: Turn) => Omit<ExtractedClaim, 'sessionId' | 'turnIdx' | 'evidenceSpan' | 'confidence' | 'polarity' | 'eventTimeIso'>[];
}

const PATTERNS: Pattern[] = [
  {
    // "I got pre-approved for $400,000 from Wells Fargo"
    re: /pre-?approved for (\$[\d,]+)(?:\s+from\s+([A-Z][A-Za-z&'. ]+?))?[.?!,]/gi,
    emit: (m) => {
      const out = [{ subject: 'the user', attribute: 'mortgage_preapproval_amount', value: m[1]!.trim() }];
      if (m[2]) out.push({ subject: 'the user', attribute: 'mortgage_lender', value: m[2].trim() });
      return out;
    },
  },
  {
    re: /\bmy employer is\s+([A-Z][A-Za-z0-9&'. ]+?)[.?!,]/gi,
    emit: (m) => [{ subject: 'the user', attribute: 'employer', value: m[1]!.trim() }],
  },
  {
    re: /\bI (?:work at|joined|started (?:working )?at)\s+([A-Z][A-Za-z0-9&'. ]+?)[.?!,]/gi,
    emit: (m) => [{ subject: 'the user', attribute: 'employer', value: m[1]!.trim() }],
  },
  {
    re: /\bI (?:moved to|now live in|relocated to)\s+([A-Z][A-Za-z. ]+?)[.?!,]/gi,
    emit: (m) => [{ subject: 'the user', attribute: 'city_of_residence', value: m[1]!.trim() }],
  },
];

export class RuleExtractor implements Extractor {
  readonly model = 'rule-extractor@1';

  async extract(history: History): Promise<ExtractedClaim[]> {
    const claims: ExtractedClaim[] = [];
    for (const session of history.sessions) {
      const flags = sessionSalience(session.turns);
      for (const [i, turn] of session.turns.entries()) {
        if (turn.role !== 'user') continue; // the rule extractor only reads user statements
        if (!flags[i]) continue;
        for (const pat of PATTERNS) {
          pat.re.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = pat.re.exec(turn.text)) !== null) {
            for (const base of pat.emit(m, turn)) {
              claims.push({
                ...base,
                polarity: 'AFFIRM',
                eventTimeIso: '',
                sessionId: turn.sessionId,
                sessionOrdinal: session.ordinal,
                turnIdx: turn.turnIdx,
                evidenceSpan: span(m[0]),
                confidence: 0.72,
              });
            }
          }
        }
      }
    }
    return claims;
  }
}

export class ReplayExtractor implements Extractor {
  readonly model: string;
  private readonly fixtureDir: string;
  constructor(fixtureDir: string, model = 'replay@1') {
    this.fixtureDir = fixtureDir;
    this.model = model;
  }
  async extract(history: History): Promise<ExtractedClaim[]> {
    try {
      const raw = readFileSync(`${this.fixtureDir}/${history.historyId}.json`, 'utf8');
      return JSON.parse(raw) as ExtractedClaim[];
    } catch {
      return [];
    }
  }
}

/** Structural-only ingest: no claims. The S1 pass alone (sessions/turns/speakers + STATED_IN) makes
 *  a history queryable and citable at zero token cost — the full-corpus unlock (wrap-up Block A). */
export class NullExtractor implements Extractor {
  readonly model = 'structural-only@1';
  async extract(): Promise<ExtractedClaim[]> {
    return [];
  }
}
