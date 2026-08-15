import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { vid, keys, mint } from './ids.js';

interface Vector {
  key: string;
  vid: number;
}
const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/id-vectors.json', import.meta.url), 'utf8'),
) as { _count: number; vectors: Vector[] };

const MAX_53 = 2 ** 53;

describe('vid — golden vectors (cross-language parity, R1)', () => {
  it('matches every Python-generated golden vector', () => {
    expect(fixture.vectors.length).toBe(fixture._count);
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(100);
    for (const v of fixture.vectors) {
      expect(vid(v.key), `vid(${JSON.stringify(v.key)})`).toBe(v.vid);
    }
  });

  it('is stable across calls and identical rebuilt inputs', () => {
    const k = keys.entity('example_001', 'acme corp');
    const kRebuilt = ['h:example_001', 'e:acme corp'].join('|');
    expect(vid(k)).toBe(vid(k));
    expect(vid(k)).toBe(vid(kRebuilt));
  });
});

describe('vid — range and safety (spec 31 §7 tests 3)', () => {
  it('every golden vid is a non-negative safe integer below 2^53', () => {
    for (const v of fixture.vectors) {
      expect(Number.isSafeInteger(v.vid)).toBe(true);
      expect(v.vid).toBeGreaterThanOrEqual(0);
      expect(v.vid).toBeLessThan(MAX_53);
    }
  });

  it('holds over a 100k generated key sweep, with zero collisions', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 100_000; i++) {
      const id = vid(`h:sweep|e:entity_${i}`);
      expect(Number.isSafeInteger(id)).toBe(true);
      expect(id).toBeGreaterThanOrEqual(0);
      expect(id).toBeLessThan(MAX_53);
      seen.add(id);
    }
    expect(seen.size).toBe(100_000); // distinct keys → distinct vids
  });
});

describe('key builders (spec 31 §7 tests 5, 6)', () => {
  it('is history-scoped: same entity in two histories → different vids', () => {
    const a = keys.entity('example_001', 'acme corp');
    const b = keys.entity('example_042', 'acme corp');
    expect(a).not.toBe(b);
    expect(vid(a)).not.toBe(vid(b));
  });

  it('emits the documented natural-key shapes', () => {
    expect(keys.session('h1', 's1')).toBe('h:h1|s:s1');
    expect(keys.turn('h1', 's1', 7)).toBe('h:h1|s:s1|t:7');
    expect(keys.speaker('h1', 'user')).toBe('h:h1|sp:user');
    expect(keys.entity('h1', 'acme corp')).toBe('h:h1|e:acme corp');
    expect(keys.claim('h1', 'the user', 'employer', 'globex', 's9', 4)).toMatch(
      /^h:h1\|c:[0-9a-f]{16}$/,
    );
    expect(keys.edge('SUPERSEDES', 'h:h1|c:aa', 'h:h1|c:bb')).toBe(
      'edge:SUPERSEDES:h:h1|c:aa:h:h1|c:bb',
    );
  });

  it('rejects delimiter injection in free segments (injectivity guard)', () => {
    // A session id containing the turn delimiter would collide with a turn key.
    expect(() => keys.session('h1', 's3|t:11')).toThrow(/must not contain/);
    expect(() => keys.entity('h1', 'x|e:y')).toThrow(/must not contain/);
    expect(() => keys.turn('h1', 's3|x', 1)).toThrow(/must not contain/);
    // Claim inner fields are guarded too, so a "a|b"/"c" vs "a"/"b|c" ambiguity cannot arise.
    expect(() => keys.claim('h1', 'a|b', 'c', 'v', 's1', 0)).toThrow(/must not contain/);
  });

  it('mint carries both id and key', () => {
    const k = keys.entity('example_001', 'the user');
    expect(mint(k)).toEqual({ id: vid(k), key: k });
  });
});
