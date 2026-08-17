import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parseHistory } from './reader.js';
import type { RawRecord } from './reader.js';

interface Expected {
  session_ordinal: number;
  turn_index: number;
  session_id: string;
  role: string;
  content: string;
}
const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/turn-index-vectors.json', import.meta.url), 'utf8'),
) as { raw: RawRecord; expected: Expected[] };

describe('turn-index golden — positional turn identity (integration seam)', () => {
  const h = parseHistory(fixture.raw);

  it('the reader counts turns 0-based within each session', () => {
    for (const e of fixture.expected) {
      const session = h.sessions[e.session_ordinal]!;
      const turn = session.turns[e.turn_index]!;
      expect(turn.turnIdx, `${e.session_ordinal}/${e.turn_index}`).toBe(e.turn_index);
      expect(session.sessionId).toBe(e.session_id);
      expect(turn.role).toBe(e.role);
      expect(turn.text).toBe(e.content);
    }
  });

  it('duplicate session_ids remain distinct sessions (keyed by ordinal, not session_id)', () => {
    expect(h.sessions[1]!.sessionId).toBe('dupe_sid');
    expect(h.sessions[2]!.sessionId).toBe('dupe_sid');
    expect(h.sessions[1]!.ordinal).not.toBe(h.sessions[2]!.ordinal);
  });
});
