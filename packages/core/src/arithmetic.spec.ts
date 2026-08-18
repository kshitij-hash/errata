// packages/core/src/arithmetic.spec.ts — pure arithmetic, tested as arithmetic (hard rule 6).

import { describe, expect, it } from 'vitest';
import {
  arithmeticIntent,
  computeTotals,
  enumeratedItems,
  formatAmount,
  parseAmounts,
  renderTotals,
} from './arithmetic.js';
import type { AmountClaim } from './arithmetic.js';

const claim = (attribute: string, value: string, turnIndex = 0, sessionId = 's1'): AmountClaim => ({
  attribute,
  value,
  sessionId,
  turnIndex,
});

describe('arithmeticIntent', () => {
  it('fires on explicit aggregation questions', () => {
    for (const q of [
      'What is the total cost of the new food bowl, measuring cup, dental chews, and flea and tick collar?',
      'How much did I spend on pet supplies?',
      'What did all of that come to altogether?',
      'What is the combined price?',
      'How much have I paid in total?',
    ]) {
      expect(arithmeticIntent(q).total, q).toBe(true);
    }
  });

  it('does NOT fire on a single-value question', () => {
    for (const q of [
      'How much was I pre-approved for by Wells Fargo?',
      'What is my mortgage lender?',
      'When did I join the gym?',
      'How many followers do I have on Instagram now?',
    ]) {
      expect(arithmeticIntent(q).total, q).toBe(false);
    }
  });
});

describe('parseAmounts', () => {
  it('reads symbol-prefixed amounts including separators and decimals', () => {
    expect(parseAmounts('$15')).toEqual([{ amount: 15, currency: 'USD' }]);
    expect(parseAmounts('$1,250.50')).toEqual([{ amount: 1250.5, currency: 'USD' }]);
    expect(parseAmounts('£20 and €30')).toEqual([
      { amount: 20, currency: 'GBP' },
      { amount: 30, currency: 'EUR' },
    ]);
  });

  it('reads word-suffixed amounts', () => {
    expect(parseAmounts('20 dollars')).toEqual([{ amount: 20, currency: 'USD' }]);
    expect(parseAmounts('45 USD')).toEqual([{ amount: 45, currency: 'USD' }]);
  });

  it('does NOT read a bare number as money', () => {
    expect(parseAmounts('5 years')).toEqual([]);
    expect(parseAmounts('7:30 AM')).toEqual([]);
    expect(parseAmounts('3 classes a week')).toEqual([]);
    expect(parseAmounts('1300')).toEqual([]);
  });

  it('keeps the amount when a rate qualifier follows it', () => {
    expect(parseAmounts('$10 per pack, purchased monthly')).toEqual([{ amount: 10, currency: 'USD' }]);
    expect(parseAmounts('$10/month')).toEqual([{ amount: 10, currency: 'USD' }]);
  });

  it('does not double-count one amount written with a symbol', () => {
    expect(parseAmounts('$20, one-time expense')).toEqual([{ amount: 20, currency: 'USD' }]);
  });
});

describe('computeTotals — the restatement trap', () => {
  // the flagship: four purchases arriving as eight claims
  const flagship: AmountClaim[] = [
    claim('max_flea_tick_collar_cost', '$20, one-time expense', 0),
    claim('flea_and_tick_collar_cost', '$20', 6),
    claim('max_supply_dental_chews_cost', '$10 per pack, purchased monthly one pack at a time', 4),
    claim('monthly_dental_chew_cost', '$10', 4),
    claim('pet_bowl_purchase', 'recently bought Max a stainless steel food bowl from Amazon for $15', 2),
    claim('pet_measuring_cup_purchase', 'recently bought a measuring cup from a nearby pet store for $5', 2),
    claim('pet_name', 'Max', 2),
    claim('pet_breed', 'golden retriever', 2),
  ];

  it('sums the DISTINCT amounts, not every claim (the $50 case, not $80)', () => {
    const t = computeTotals(flagship);
    expect(t.sums.get('USD')).toBe(50);
    expect(t.byCurrency.get('USD')!.map((l) => l.amount)).toEqual([5, 10, 15, 20]);
  });

  it('records how many claims restated each figure', () => {
    const t = computeTotals(flagship);
    const byAmount = new Map(t.byCurrency.get('USD')!.map((l) => [l.amount, l.mentions]));
    expect(byAmount.get(20)).toBe(2);
    expect(byAmount.get(10)).toBe(2);
    expect(byAmount.get(15)).toBe(1);
  });

  it('counts claims with no readable amount instead of guessing at them', () => {
    expect(computeTotals(flagship).unsummable).toBe(2); // pet_name, pet_breed
  });

  it('never sums across currencies', () => {
    const t = computeTotals([claim('a', '$10'), claim('b', '$5'), claim('c', '€7'), claim('d', '€3')]);
    expect(t.sums.get('USD')).toBe(10 + 5);
    expect(t.sums.get('EUR')).toBe(7 + 3);
  });

  it('is a pure function — identical input, identical output', () => {
    expect(computeTotals(flagship).sums.get('USD')).toBe(computeTotals(flagship).sums.get('USD'));
  });
});

describe('formatAmount', () => {
  it('formats with a symbol and thousands separators, dropping empty cents', () => {
    expect(formatAmount(50, 'USD')).toBe('$50');
    expect(formatAmount(1250.5, 'USD')).toBe('$1,250.50');
    expect(formatAmount(30, 'EUR')).toBe('€30');
    expect(formatAmount(12, 'CAD')).toBe('12 CAD');
  });
});

// The real window also holds amounts the question did NOT ask about — this is the case that makes
// a blind window sum wrong ($1,640 instead of $50).
const REAL_WINDOW: AmountClaim[] = [
  claim('max_flea_tick_collar_cost', '$20, one-time expense', 6),
  claim('flea_and_tick_collar_cost', '$20', 6),
  claim('max_supply_dental_chews_cost', '$10 per pack, purchased monthly', 4),
  claim('monthly_dental_chew_cost', '$10', 4),
  claim('pet_bowl_purchase', 'recently bought Max a stainless steel food bowl from Amazon for $15', 0),
  claim('pet_measuring_cup_purchase', 'recently bought a measuring cup from a nearby pet store for $5', 0),
  claim('max_dog_bed_cost', 'around $40, one-time expense', 4),
  claim('max_supply_grain_free_kibble_cost', '$50 per month', 4),
  claim('luxury_watch_purchase_cost', '$1,500', 0),
  claim('pet_name', 'Max', 0),
];
const FLAGSHIP_Q =
  'What is the total cost of the new food bowl, measuring cup, dental chews, and flea and tick collar I got for Max?';

describe('enumeratedItems', () => {
  it('splits the question’s own list, dropping the interrogative head', () => {
    expect(enumeratedItems(FLAGSHIP_Q)).toEqual([
      'the new food bowl',
      'measuring cup',
      'dental chews',
      'flea and tick collar I got for Max',
    ]);
  });

  it('does NOT tear a multi-word item name apart on its internal "and"', () => {
    // "flea and tick collar" is ONE item; splitting it double-counts the collar
    expect(enumeratedItems(FLAGSHIP_Q)).toContain('flea and tick collar I got for Max');
  });

  it('still splits on "and" when the question uses no commas', () => {
    expect(enumeratedItems('What is the total cost of the food bowl and the measuring cup?')).toEqual([
      'the food bowl',
      'the measuring cup',
    ]);
  });

  it('returns fewer than two phrases when the question enumerates nothing', () => {
    expect(enumeratedItems('How much did I spend on pet supplies?').length).toBeLessThan(2);
  });
});

describe('computeTotals — question-scoped subset', () => {
  it('totals ONLY the items the question names, not the whole window', () => {
    const t = computeTotals(REAL_WINDOW, FLAGSHIP_Q);
    expect(t.matchedSums.get('USD')).toBe(50);
    // the window's own blind sum is much larger, and is never published as the answer
    expect(t.sums.get('USD')).toBe(1640);
  });

  it('matches each named item to a distinct amount', () => {
    const t = computeTotals(REAL_WINDOW, FLAGSHIP_Q);
    expect(t.matched.map((m) => m.line.amount).sort((a, b) => a - b)).toEqual([5, 10, 15, 20]);
  });

  it('publishes no subset total when the question enumerates nothing', () => {
    const t = computeTotals(REAL_WINDOW, 'How much did I spend on pet supplies?');
    expect(t.matchedSums.size).toBe(0);
  });

  it('never counts one amount for two different named items', () => {
    const t = computeTotals(
      [claim('bowl_cost', 'food bowl $15'), claim('cup_cost', 'measuring cup $15')],
      'What is the total cost of the food bowl and the measuring cup?',
    );
    expect(t.matched).toHaveLength(2);
    expect(new Set(t.matched.map((m) => m.line.label)).size).toBe(2);
  });
});

describe('renderTotals', () => {
  it('prints the itemisation, the named-item mapping and the scoped total', () => {
    const out = renderTotals(computeTotals(REAL_WINDOW, FLAGSHIP_Q));
    expect(out).toContain('$5 — pet measuring cup purchase (session s1, turn 0)');
    expect(out).toContain('$20 — max flea tick collar cost (session s1, turn 6) [stated in 2 claims]');
    expect(out).toContain('TOTAL of the 4 items the question names = $50');
    // the blind window sum must never be printed as a total
    expect(out).not.toContain('$1,640');
  });

  it('discloses a named item it could not price rather than dropping it', () => {
    const out = renderTotals(
      computeTotals(
        [claim('bowl_cost', 'food bowl $15'), claim('cup_cost', 'measuring cup $5')],
        'What is the total cost of the food bowl, the measuring cup, and the leash?',
      ),
    );
    expect(out).toContain('No amount was found for: "the leash"');
    expect(out).toContain('TOTAL of the 2 items the question names = $20');
  });

  it('renders NOTHING when a currency has fewer than two distinct amounts', () => {
    expect(renderTotals(computeTotals([claim('a', '$20'), claim('b', '$20')], 'total of a and b?'))).toBe('');
    expect(renderTotals(computeTotals([claim('a', 'Max'), claim('b', 'dog')], 'total of a and b?'))).toBe('');
  });

  it('is deterministic', () => {
    const a = renderTotals(computeTotals(REAL_WINDOW, FLAGSHIP_Q));
    expect(a).toBe(renderTotals(computeTotals(REAL_WINDOW, FLAGSHIP_Q)));
  });
});
