// packages/core/src/lexical.spec.ts — the deterministic matcher's contract.
//
// These are the properties the ask path depends on: stemming collides the forms a question and a
// stored claim actually differ by, `$495` and `495 dollars` become the same two tokens, and ranking
// is a pure function of (question, rows) with a stable tie-break.

import { describe, expect, it } from 'vitest';
import {
  bigrams,
  canonicalizeNumbers,
  coverage,
  idfWeights,
  lexTokens,
  rankByRelevance,
  relevance,
  stem,
} from './lexical.js';

describe('stem (lemma-lite)', () => {
  it('collides the plural and verb forms a question differs by', () => {
    expect(stem('markets')).toBe(stem('market'));
    expect(stem('earnings')).toBe(stem('earning'));
    expect(stem('studies')).toBe(stem('study'));
    expect(stem('boxes')).toBe(stem('box'));
    expect(stem('running')).toBe('run');
    expect(stem('stopped')).toBe('stop');
    expect(stem('quickly')).toBe('quick');
  });

  it('leaves short tokens and ss/us/is endings alone (over-stemming makes wrong answers)', () => {
    for (const t of ['is', 'gas', 'bus', 'class', 'this', 'less', 'his']) {
      expect(stem(t)).toBe(t);
    }
  });

  it('is idempotent — stemming a stem changes nothing', () => {
    for (const t of ['markets', 'running', 'studies', 'boxes', 'quickly', 'employer']) {
      expect(stem(stem(t))).toBe(stem(t));
    }
  });
});

describe('canonicalizeNumbers', () => {
  it('collapses thousands separators', () => {
    expect(lexTokens('$400,000 pre-approval')).toContain('400000');
  });

  it('puts a currency symbol and its spelled-out word on the same ISO code (normValue v2 shape)', () => {
    expect(lexTokens('$495')).toEqual(lexTokens('495 dollars'));
    expect(lexTokens('£20')).toContain('gbp');
  });

  it('canonicalizes the three date surfaces onto one token triple', () => {
    const iso = lexTokens('2023-08-11');
    expect(lexTokens('2023/08/11')).toEqual(iso);
    expect(lexTokens('August 11, 2023')).toEqual(expect.arrayContaining(iso));
    expect(lexTokens('11 August 2023')).toEqual(expect.arrayContaining(iso));
  });

  it('keeps a bare month word and adds its number', () => {
    const t = lexTokens('in March');
    expect(t).toContain('march');
    expect(t).toContain('03');
  });

  it('is a pure string function (no state between calls)', () => {
    const a = canonicalizeNumbers('$10 and $20');
    expect(canonicalizeNumbers('$10 and $20')).toBe(a);
  });
});

describe('lexTokens', () => {
  it('drops stopwords and short tokens, dedupes, preserves order', () => {
    expect(lexTokens('What is the total amount of money I earned?')).toEqual([
      'total', 'amount', 'money', 'earn',
    ]);
  });

  it('keeps a hyphenated compound AND its closed form', () => {
    const t = lexTokens('How much was I pre-approved for?');
    expect(t).toContain('pre'); // the split halves
    expect(t).toContain('approv');
    expect(t).toContain('preapprov'); // and the closed compound, stemmed
    // the closed form is what lets a hyphenating question meet a closed-spelled stored value
    expect(lexTokens('preapproved for 400000')).toContain('preapprov');
  });

  it('makes a question and a differently-inflected claim share tokens', () => {
    const q = new Set(lexTokens('How much money did I earn at the markets?'));
    const claim = lexTokens('market earnings: earned $495 selling at three markets');
    expect(claim.some((t) => q.has(t))).toBe(true);
  });
});

describe('bigrams', () => {
  it('joins adjacent tokens for multi-word lexicon probes', () => {
    expect(bigrams(['st', 'mary', 'church'])).toEqual(['st mary', 'mary church']);
    expect(bigrams(['solo'])).toEqual([]);
  });
});

describe('idfWeights + coverage', () => {
  it('weighs a token every claim carries at ~0 and a rare one high', () => {
    const docs = [['user', 'bike'], ['user', 'car'], ['user', 'dog'], ['user', 'bike']];
    const idf = idfWeights(docs);
    expect(idf.get('user')!).toBeLessThan(idf.get('car')!);
  });

  it('is asymmetric: a long claim is not punished for covering the ask', () => {
    const idf = idfWeights([['a'], ['b']]);
    const short = coverage(['bike'], new Set(['bike']), idf);
    const long = coverage(['bike'], new Set(['bike', 'x', 'y', 'z', 'w']), idf);
    expect(long).toBe(short);
  });

  it('returns 0 for an empty question and 0 for no overlap', () => {
    const idf = idfWeights([['a']]);
    expect(coverage([], new Set(['a']), idf)).toBe(0);
    expect(coverage(['q'], new Set(['a']), idf)).toBe(0);
  });
});

describe('rankByRelevance', () => {
  const docs = [
    { id: 'unrelated', attrTokens: lexTokens('oil level status'), bodyTokens: lexTokens('oil level status looked a bit low') },
    { id: 'answer', attrTokens: lexTokens('market earnings'), bodyTokens: lexTokens('market earnings 495 usd — I earned $495 selling at the markets') },
    { id: 'nearby', attrTokens: lexTokens('market stall fee'), bodyTokens: lexTokens('market stall fee 30 usd') },
  ];

  it('puts the claim whose SPAN answers the question first', () => {
    const q = lexTokens('What is the total amount of money I earned from selling at the markets?');
    expect(rankByRelevance(q, docs, 3)[0]!.id).toBe('answer');
  });

  it('scores the evidence span, not just attribute+value (the taxonomy miss)', () => {
    const q = lexTokens('how much did I earn selling');
    const idf = idfWeights(docs.map((d) => d.bodyTokens));
    const withSpan = relevance(q, docs[1]!, idf);
    const attrOnly = relevance(q, { attrTokens: docs[1]!.attrTokens, bodyTokens: docs[1]!.attrTokens }, idf);
    expect(withSpan).toBeGreaterThan(attrOnly);
  });

  it('is deterministic and ties break by original order', () => {
    const q = lexTokens('nothing here matches at all');
    const a = rankByRelevance(q, docs, 3);
    expect(a.map((d) => d.id)).toEqual(['unrelated', 'answer', 'nearby']);
    expect(rankByRelevance(q, docs, 3).map((d) => d.id)).toEqual(a.map((d) => d.id));
  });

  it('returns zero-scoring candidates rather than dropping them (the refusal needs material)', () => {
    expect(rankByRelevance(lexTokens('zzz qqq'), docs, 3)).toHaveLength(3);
    expect(rankByRelevance(lexTokens('zzz qqq'), docs, 0)).toHaveLength(0);
  });
});
