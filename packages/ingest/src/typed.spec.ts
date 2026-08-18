import { describe, it, expect } from 'vitest';
import { resolveAttribute } from '@errata/core';
import { parseHistory } from './reader.js';
import type { RawRecord } from './reader.js';
import type { ExtractedClaim, Extractor } from './extract.js';
import { buildClaims, prepareClaims, resolveConflicts } from './build.js';
import { assemble } from './pipeline.js';
import { sessionSalience } from './text.js';
import {
  ALL_FAMILIES,
  TYPED_MODEL,
  TYPED_PREFIX,
  TypedExtractor,
  UnionExtractor,
  extractTyped,
  localNounPhrase,
  maskCode,
  parseLists,
  sentenceAround,
  slugOf,
  summarizeTyped,
} from './typed.js';
import type { TypedClaim } from './typed.js';

// ------------------------------------------------------------------------------------------------
// the 85fa3a3f shape: four money addends the LLM pass never emitted, all four in plain prose
// ------------------------------------------------------------------------------------------------

const PET: RawRecord = {
  question_id: 'typed_pet',
  question: 'What is the total cost of the new food bowl, measuring cup, dental chews, and flea and tick collar I got for Max?',
  answer: '$50',
  question_date: '2023/06/01 (Thu) 09:00',
  answer_session_ids: ['pet_may', 'pet_late_may'],
  haystack_session_ids: ['pet_may', 'pet_late_may'],
  haystack_dates: ['2023/05/22 (Mon) 07:04', '2023/05/26 (Fri) 02:01'],
  haystack_sessions: [
    [
      { role: 'user', content: 'Can you help me work out what I spend on my dog Max every month?' },
      { role: 'assistant', content: 'Of course. Tell me what you buy for him and roughly what each thing costs.' },
      { role: 'user', content: 'I buy grain-free kibble every month. There are occasional things too, like the dental chews I started for his teeth — the chews are $10 a pack.' },
      { role: 'user', content: 'I think I forgot to mention that I also got a flea and tick collar for Max recently, which was $20, but that was a one-off.' },
      {
        role: 'assistant',
        content: 'Got it. Here is the breakdown:\n\n**Recurring expenses:**\n\n1. Grain-free kibble: $50/month\n2. Dental chews: $10/month\n\n**One-time expenses:**\n\n1. Flea and tick collar: $20 (one-time expense)\n',
      },
    ],
    [
      { role: 'user', content: 'I just got him a new stainless steel food bowl from Amazon for $15, and a measuring cup from the pet store down the street for $5, which has been working out great for his kibble.' },
      { role: 'assistant', content: 'Those both sound like sensible buys.' },
    ],
  ],
};
const H_PET = parseHistory(PET);

/** every (value, session, turn) triple the typed money family produced, for readable assertions */
const moneyCitations = (claims: readonly TypedClaim[]): { value: string; at: string; subject: string; attribute: string }[] =>
  claims.filter((c) => c.family === 'money').map((c) => ({ value: c.value, at: `${c.sessionId}:${c.turnIdx}`, subject: c.subject, attribute: c.attribute }));

describe('typed money — the 85fa3a3f defect', () => {
  const claims = extractTyped(H_PET);

  it('recovers ALL FOUR addends with their exact positional citations', () => {
    const money = moneyCitations(claims);
    const find = (value: string, at: string): (typeof money)[number] | undefined =>
      money.find((m) => m.value === value && m.at === at);

    // food bowl $15 and measuring cup $5 — same sentence, same turn, two different things
    expect(find('$15', 'pet_late_may:0'), '$15 food bowl').toBeDefined();
    expect(find('$5', 'pet_late_may:0'), '$5 measuring cup').toBeDefined();
    // dental chews $10 — stated by the user, restated by the assistant
    expect(find('$10', 'pet_may:2'), '$10 dental chews').toBeDefined();
    // flea and tick collar $20
    expect(find('$20', 'pet_may:3'), '$20 collar').toBeDefined();

    // the four amounts sum to the gold answer — stated here to make the test's purpose explicit.
    // Errata never does this arithmetic; it only has to make all four addends citable.
    expect(15 + 5 + 10 + 20).toBe(50);
  });

  it('names each amount after the thing it was spent on, where the sentence says so', () => {
    const money = moneyCitations(claims);
    const at = (value: string, loc: string): (typeof money)[number] =>
      money.find((m) => m.value === value && m.at === loc)!;

    expect(at('$15', 'pet_late_may:0').subject).toMatch(/food bowl/i);
    expect(at('$5', 'pet_late_may:0').subject).toMatch(/measuring cup/i);
    expect(at('$10', 'pet_may:2').subject).toMatch(/chews/i);
    expect(at('$20', 'pet_may:3').subject).toMatch(/collar/i);
    // and the attribute carries the same tokens, so the ask path can anchor either way
    expect(at('$15', 'pet_late_may:0').attribute).toContain('food_bowl');
    expect(at('$5', 'pet_late_may:0').attribute).toContain('measuring_cup');
  });

  it('quotes the amount and the sentence verbatim — no reformatting, no arithmetic', () => {
    for (const c of claims.filter((x) => x.family === 'money')) {
      const turn = H_PET.sessions[c.sessionOrdinal!]!.turns[c.turnIdx]!;
      expect(turn.text).toContain(c.value);
      // the evidence span is a whitespace-collapsed slice of the turn it cites
      const flat = turn.text.replace(/\s+/g, ' ');
      expect(flat).toContain(c.evidenceSpan.replace(/…$/, '').slice(0, 60));
    }
  });

  it('carries the pass tag on every claim, so the whole pass is filterable at read time', () => {
    expect(claims.length).toBeGreaterThan(0);
    for (const c of claims) expect(c.extractorModel).toBe(TYPED_MODEL);
  });

  it('every attribute it mints is namespaced, and every one of them is unregistered → MULTI', () => {
    for (const c of claims) {
      expect(c.attribute.startsWith(TYPED_PREFIX), c.attribute).toBe(true);
      const r = resolveAttribute(c.attribute);
      expect(r.registered, c.attribute).toBe(false);
      expect(r.arity, c.attribute).toBe('MULTI');
    }
  });

  it('is deterministic — the same history twice gives byte-identical claims', () => {
    expect(extractTyped(parseHistory(PET))).toEqual(claims);
  });
});

// ------------------------------------------------------------------------------------------------
// the salience gate is exactly what this pass is here to bypass
// ------------------------------------------------------------------------------------------------

describe('coverage — the pass is NOT gated by salience', () => {
  const REC: RawRecord = {
    ...PET,
    question_id: 'typed_salience',
    haystack_session_ids: ['s1'],
    haystack_dates: ['2023/05/22 (Mon) 07:04'],
    answer_session_ids: ['s1'],
    haystack_sessions: [[
      { role: 'user', content: 'Oh — the collar was $20.' },
      { role: 'assistant', content: 'Noted.' },
    ]],
  };
  const h = parseHistory(REC);

  it('extracts from a turn the salience gate drops', () => {
    const flags = sessionSalience(h.sessions[0]!.turns);
    expect(flags[0], 'the fixture must be a turn the gate rejects').toBe(false);
    const claims = extractTyped(h);
    expect(claims.filter((c) => c.family === 'money').map((c) => c.value)).toEqual(['$20']);
    expect(claims[0]!.turnIdx).toBe(0);
    expect(claims[0]!.sessionId).toBe('s1');
  });
});

// ------------------------------------------------------------------------------------------------
// enumerations — "the 7th job in the list you gave me"
// ------------------------------------------------------------------------------------------------

const twelveJobs = [
  'Here are twelve work-from-home jobs worth a look:',
  '',
  '1. Customer support representative',
  '2. Virtual assistant',
  '3. Transcriptionist',
  '4. Bookkeeper',
  '5. Online tutor',
  '6. Data entry clerk',
  '7. Medical coder',
  '8. Social media manager',
  '9. Technical writer',
  '10. Translator',
  '11. Travel consultant',
  '12. Proofreader',
].join('\n');

describe('typed enumerations', () => {
  const REC: RawRecord = {
    ...PET,
    question_id: 'typed_jobs',
    question: 'What was the 7th job in the list you gave me?',
    answer: 'Medical coder',
    haystack_session_ids: ['jobs'],
    haystack_dates: ['2023/05/22 (Mon) 07:04'],
    answer_session_ids: ['jobs'],
    haystack_sessions: [[
      { role: 'user', content: 'What jobs could I do from home?' },
      { role: 'assistant', content: twelveJobs },
    ]],
  };
  const claims = extractTyped(parseHistory(REC)).filter((c) => c.family === 'list_item');

  it('a twelve-item list survives WHOLE — the cap that broke this was 10 across a whole batch', () => {
    expect(claims).toHaveLength(12);
    for (let i = 1; i <= 12; i++) {
      expect(claims.some((c) => c.attribute === `${TYPED_PREFIX}list_item_${i}`), `item ${i}`).toBe(true);
    }
  });

  it('indexes by the PRINTED number, which is what "the 7th job" refers to', () => {
    const seventh = claims.find((c) => c.attribute === `${TYPED_PREFIX}list_item_7`)!;
    expect(seventh.value).toBe('Medical coder');
    expect(seventh.sessionId).toBe('jobs');
    expect(seventh.turnIdx).toBe(1);
    expect(seventh.subject).toContain('work-from-home jobs');
  });

  it('caps a very long list generously, not at 10', () => {
    const thirty = ['Options:', ...Array.from({ length: 30 }, (_, i) => `${i + 1}. option ${i + 1}`)].join('\n');
    const long = extractTyped(
      parseHistory({ ...REC, question_id: 'typed_long', haystack_sessions: [[{ role: 'assistant', content: thirty }]] }),
    ).filter((c) => c.family === 'list_item');
    expect(long).toHaveLength(25);
    expect(long.at(-1)!.attribute).toBe(`${TYPED_PREFIX}list_item_25`);
  });

  it('parseLists: bullets are positional, numbers are printed, and a lone bullet is not a list', () => {
    const bullets = parseLists('Shopping:\n- milk\n- eggs\n- bread\n');
    expect(bullets).toHaveLength(1);
    expect(bullets[0]!.leadIn).toBe('Shopping');
    expect(bullets[0]!.items.map((i) => [i.index, i.text])).toEqual([[1, 'milk'], [2, 'eggs'], [3, 'bread']]);

    expect(parseLists('A thought:\n- just the one\n')).toHaveLength(0);

    // a numbered list that restarts is two lists, each with its own lead-in
    const two = parseLists('**Recurring:**\n1. kibble\n2. chews\n\n\n**One-time:**\n1. collar\n2. bed\n');
    expect(two).toHaveLength(2);
    expect(two.map((l) => l.leadIn)).toEqual(['Recurring', 'One-time']);
  });
});

// ------------------------------------------------------------------------------------------------
// the correctness constraint: a typed claim can never manufacture a revision
// ------------------------------------------------------------------------------------------------

describe('no false supersession', () => {
  it('nothing in the registry is reachable from the typed namespace', () => {
    for (const a of ['typed_money_amount', 'typed_money_salary', 'typed_money_current_salary', 'typed_duration', 'typed_date', 'typed_list_item_7', 'typed_relative_time', 'typed_time']) {
      const r = resolveAttribute(a);
      expect(r.registered, a).toBe(false);
      expect(r.arity, a).toBe('MULTI');
      expect(r.name, a).toBe(a);
    }
  });

  it('a typed money claim does not collide with a registered FUNCTIONAL attribute in the same turn', () => {
    // The LLM pass extracts `current_salary` (FUNCTIONAL) from two turns and the later one must
    // supersede the earlier one. The typed pass quotes the SAME two amounts. If a typed attribute
    // could land on the registered name, the chain would fork or a typed row would displace a
    // real belief. It cannot: `typed_money_*` is unregistered → MULTI.
    const REC: RawRecord = {
      ...PET,
      question_id: 'typed_salary',
      haystack_session_ids: ['jan', 'jun'],
      haystack_dates: ['2023/01/10 (Tue) 09:00', '2023/06/10 (Sat) 09:00'],
      answer_session_ids: ['jun'],
      haystack_sessions: [
        [{ role: 'user', content: 'My salary is $95,000 at the moment.' }],
        [{ role: 'user', content: 'I got a raise — my salary is $120,000 now.' }],
      ],
    };
    const h = parseHistory(REC);
    const llm: ExtractedClaim[] = [
      { subject: 'the user', attribute: 'current_salary', value: '$95,000', polarity: 'AFFIRM', eventTimeIso: '', sessionId: 'jan', sessionOrdinal: 0, turnIdx: 0, evidenceSpan: 'My salary is $95,000 at the moment.', confidence: 0.8 },
      { subject: 'the user', attribute: 'current_salary', value: '$120,000', polarity: 'AFFIRM', eventTimeIso: '', sessionId: 'jun', sessionOrdinal: 1, turnIdx: 0, evidenceSpan: 'my salary is $120,000 now', confidence: 0.8 },
    ];
    const typed = extractTyped(h);
    expect(typed.filter((c) => c.family === 'money')).toHaveLength(2); // it really does see them

    const llmOnly = resolveConflicts(prepareClaims(h, llm));
    const union = prepareClaims(h, [...llm, ...typed]);
    const withTyped = resolveConflicts(union);

    // exactly the same revision graph, before and after the typed pass joins
    expect(withTyped).toEqual(llmOnly);
    expect(llmOnly.filter((e) => e.type === 'SUPERSEDES')).toHaveLength(1);

    // and no revision edge touches a typed claim, in either direction
    const typedIds = new Set(union.filter((c) => c.attribute.startsWith(TYPED_PREFIX)).map((c) => c.claimId));
    expect(typedIds.size).toBeGreaterThan(0);
    for (const e of withTyped) {
      expect(typedIds.has(e.newerId)).toBe(false);
      expect(typedIds.has(e.olderId)).toBe(false);
    }
  });

  it('a whole real-shaped history yields ZERO revision edges from the typed pass alone', () => {
    const prepared = prepareClaims(H_PET, extractTyped(H_PET));
    expect(prepared.length).toBeGreaterThan(5);
    expect(resolveConflicts(prepared)).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------
// temporal normalization through the pipeline
// ------------------------------------------------------------------------------------------------

describe('temporal normalization lands on the claim', () => {
  const REC: RawRecord = {
    ...PET,
    question_id: 'typed_time',
    haystack_session_ids: ['may'],
    haystack_dates: ['2023/05/22 (Mon) 07:04'],
    answer_session_ids: ['may'],
    haystack_sessions: [[
      { role: 'user', content: 'I adopted Max three months ago. I also booked a vet visit for a few weeks ago, and another on December 22, 2023.' },
    ]],
  };
  const h = parseHistory(REC);
  const prepared = prepareClaims(h, extractTyped(h));

  it('resolves an exact relative offset to an absolute event_time, tagged RELATIVE', () => {
    const c = prepared.find((p) => p.value === 'three months ago')!;
    expect(c.eventTimeIso).toBe('2023-02-22');
    expect(c.eventTime).toBe(Date.UTC(2023, 1, 22) / 1000);
    expect(c.timeBasis).toBe('RELATIVE');
  });

  it('leaves a vague phrase on the session-date fallback rather than guessing', () => {
    const c = prepared.find((p) => p.value === 'a few weeks ago')!;
    expect(c.eventTimeIso).toBe('2023-05-22'); // the session date, exactly as the pipeline already does
    expect(c.timeBasis).toBe('SESSION_DATE');
  });

  it('a date written out in the turn is EXPLICIT, not RELATIVE', () => {
    const c = prepared.find((p) => p.value === 'December 22, 2023')!;
    expect(c.eventTimeIso).toBe('2023-12-22');
    expect(c.timeBasis).toBe('EXPLICIT');
  });

  it('with no session date at all, event_time stays the -1 sentinel', () => {
    const undated = parseHistory({ ...REC, question_id: 'typed_undated', haystack_dates: [''] });
    const p = prepareClaims(undated, extractTyped(undated)).find((x) => x.value === 'three months ago')!;
    expect(p.eventTime).toBe(-1);
    expect(p.timeBasis).toBe('UNKNOWN');
  });
});

// ------------------------------------------------------------------------------------------------
// noise control and helpers
// ------------------------------------------------------------------------------------------------

describe('noise control', () => {
  it('does not extract from code blocks, and offsets still line up afterwards', () => {
    const text = 'Budget below.\n\n```python\nprice = 9999  # $9,999\n```\n\nThe real total was $42.';
    const masked = maskCode(text);
    expect(masked).toHaveLength(text.length);
    expect(masked).not.toContain('9,999');
    const h = parseHistory({ ...PET, question_id: 'typed_code', haystack_session_ids: ['c'], haystack_dates: ['2023/05/22 (Mon) 07:04'], answer_session_ids: ['c'], haystack_sessions: [[{ role: 'user', content: text }]] });
    const money = extractTyped(h).filter((c) => c.family === 'money');
    expect(money.map((c) => c.value)).toEqual(['$42']);
  });

  it('a rate is not a duration — "$50 a month" contributes no "a month" fact', () => {
    const h = parseHistory({ ...PET, question_id: 'typed_rate', haystack_session_ids: ['r'], haystack_dates: ['2023/05/22 (Mon) 07:04'], answer_session_ids: ['r'], haystack_sessions: [[{ role: 'user', content: 'The kibble is $50 a month and the gym is $30 a week.' }]] });
    const claims = extractTyped(h);
    expect(claims.filter((c) => c.family === 'duration')).toEqual([]);
    expect(claims.filter((c) => c.family === 'money').map((c) => c.value)).toEqual(['$50', '$30']);
  });

  it('a longer, more specific family claims its characters first', () => {
    const h = parseHistory({ ...PET, question_id: 'typed_overlap', haystack_session_ids: ['o'], haystack_dates: ['2023/05/22 (Mon) 07:04'], answer_session_ids: ['o'], haystack_sessions: [[{ role: 'user', content: 'I started three months ago and trained for three months.' }]] });
    const claims = extractTyped(h);
    expect(claims.filter((c) => c.family === 'relative_time').map((c) => c.value)).toEqual(['three months ago']);
    expect(claims.filter((c) => c.family === 'duration').map((c) => c.value)).toEqual(['three months']);
  });

  it('quotes a numeric range whole rather than truncating it', () => {
    const h = parseHistory({ ...PET, question_id: 'typed_range', haystack_session_ids: ['g'], haystack_dates: ['2023/05/22 (Mon) 07:04'], answer_session_ids: ['g'], haystack_sessions: [[{ role: 'user', content: 'Repeat for 20-30 minutes.' }]] });
    expect(extractTyped(h).filter((c) => c.family === 'duration').map((c) => c.value)).toEqual(['20-30 minutes']);
  });

  it('the amount span never swallows the comma that follows it', () => {
    const h = parseHistory({ ...PET, question_id: 'typed_comma', haystack_session_ids: ['k'], haystack_dates: ['2023/05/22 (Mon) 07:04'], answer_session_ids: ['k'], haystack_sessions: [[{ role: 'user', content: 'I paid $15, then $1,250.50, then €20.' }]] });
    expect(extractTyped(h).filter((c) => c.family === 'money').map((c) => c.value)).toEqual(['$15', '$1,250.50', '€20']);
  });
});

describe('helpers', () => {
  it('sentenceAround picks the sentence, and stops at a line break', () => {
    const t = 'One. Two is here. Three.';
    const i = t.indexOf('here');
    expect(t.slice(...Object.values(sentenceAround(t, i, i + 4)) as [number, number]).trim()).toBe('Two is here.');
    const lines = 'alpha\nbeta gamma\ndelta';
    const j = lines.indexOf('gamma');
    const b = sentenceAround(lines, j, j + 5);
    expect(lines.slice(b.from, b.to)).toBe('beta gamma');
  });

  it('localNounPhrase strips copulas, hedges, and trailing prepositional phrases', () => {
    // [sentence, the amount to read, the phrase it should be attributed to]
    const cases: [string, string, string][] = [
      ['the chews are $10 a pack', '$10', 'chews'],
      ['The grain-free kibble is about $50 a month.', '$50', 'grain-free kibble'],
      ['a measuring cup from the pet store down the street for $5', '$5', 'measuring cup'],
      ['I spent $200 on a new laptop', '$200', 'new laptop'],
      ['I raised $500 for the cause', '$500', 'cause'],
      ['Total recurring expenses: $50 + $10 = $60/month', '$10', 'Total recurring expenses'],
      ['1. Dog bed: $40 (one-time expense)', '$40', 'Dog bed'],
      ['I got a flea and tick collar for Max recently, which was $20.', '$20', 'flea and tick collar'],
      ['I got him a new stainless steel food bowl from Amazon for $15, and more.', '$15', 'stainless steel food bowl'],
    ];
    for (const [text, amount, expected] of cases) {
      const start = text.indexOf(amount);
      expect(localNounPhrase(text, start, start + amount.length), `${text} → ${amount}`).toBe(expected);
    }
  });

  it('slugOf keeps the tokens a question would carry', () => {
    expect(slugOf('flea and tick collar')).toBe('flea_tick_collar');
    expect(slugOf('the new stainless steel food bowl')).toBe('steel_food_bowl');
    expect(slugOf('cup')).toBe('cup');
  });

  it('summarizeTyped covers every family', () => {
    const s = summarizeTyped(extractTyped(H_PET));
    expect(Object.keys(s).sort()).toEqual([...ALL_FAMILIES].sort());
    expect(s.money.claims).toBeGreaterThan(0);
    expect(s.list_item.claims).toBeGreaterThan(0);
  });

  it('a family filter turns a family off completely', () => {
    const only = extractTyped(H_PET, { families: ['money'] });
    expect(new Set(only.map((c) => c.family))).toEqual(new Set(['money']));
  });
});

// ------------------------------------------------------------------------------------------------
// the union: two passes over one history
// ------------------------------------------------------------------------------------------------

class FakeExtractor implements Extractor {
  readonly model = 'fake@1';
  async extract(): Promise<ExtractedClaim[]> {
    return [{ subject: 'the user', attribute: 'owns_pet', value: 'Max', polarity: 'AFFIRM', eventTimeIso: '', sessionId: 'pet_may', sessionOrdinal: 0, turnIdx: 0, evidenceSpan: 'my dog Max', confidence: 0.8 }];
  }
}

describe('UnionExtractor', () => {
  it('concatenates passes and tags each claim with the pass that produced it', async () => {
    const union = new UnionExtractor([new FakeExtractor(), new TypedExtractor()]);
    expect(union.model).toBe(`fake@1+${TYPED_MODEL}`);
    const claims = await union.extract(H_PET);
    expect(claims.filter((c) => c.extractorModel === 'fake@1')).toHaveLength(1);
    expect(claims.filter((c) => c.extractorModel === TYPED_MODEL).length).toBeGreaterThan(5);
  });

  it('the tag survives onto the Claim row, so a read path can filter the pass out', async () => {
    const union = new UnionExtractor([new FakeExtractor(), new TypedExtractor()]);
    const prepared = prepareClaims(H_PET, await union.extract(H_PET));
    const built = buildClaims(H_PET, prepared, [], 'run-model@1', 'r1', 1_700_000_000);
    const rows = built.nodes.find((n) => n.label === 'Claim')!.rows as { extractor_model: string; provenance: string }[];
    expect(rows.some((r) => r.extractor_model === 'fake@1')).toBe(true);
    expect(rows.filter((r) => r.extractor_model === TYPED_MODEL).length).toBeGreaterThan(5);
    // typed claims quote the transcript, so they are EXTRACTED, never INFERRED
    for (const r of rows) expect(r.provenance).toBe('EXTRACTED');
  });

  it('a claim with no tag of its own still inherits the run model (existing passes unchanged)', async () => {
    const prepared = prepareClaims(H_PET, await new FakeExtractor().extract());
    const built = buildClaims(H_PET, prepared, [], 'run-model@1', 'r1', 1);
    const rows = built.nodes.find((n) => n.label === 'Claim')!.rows as { extractor_model: string }[];
    expect(rows.map((r) => r.extractor_model)).toEqual(['run-model@1']);
  });

  it('duplicate claims across passes collapse onto one vertex instead of clashing in a batch', async () => {
    const twice = new UnionExtractor([new TypedExtractor(), new TypedExtractor()]);
    const once = prepareClaims(H_PET, await new TypedExtractor().extract(H_PET));
    const dup = prepareClaims(H_PET, await twice.extract(H_PET));
    expect(dup.map((c) => c.claimId)).toEqual(once.map((c) => c.claimId));
    const ids = dup.map((c) => c.claimId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('assembles into the usual batch shape, null-free, with unique ids', async () => {
    const a = assemble(H_PET, await new TypedExtractor().extract(H_PET), { model: TYPED_MODEL, runId: 'r1', ingestTime: 1_700_000_000 });
    expect(a.nodes.map((n) => n.label)).toEqual(['Speaker', 'Session', 'Turn', 'Entity', 'Claim']);
    expect(a.counts.supersedes).toBe(0);
    expect(a.counts.contradicts).toBe(0);
    for (const nb of a.nodes) {
      const ids = nb.rows.map((r) => Number(r.id));
      expect(new Set(ids).size, nb.label).toBe(ids.length);
      for (const row of nb.rows) for (const v of Object.values(row)) expect(v).not.toBeUndefined();
    }
    for (const eb of a.edges) {
      const ids = eb.rows.map((r) => Number(r.id));
      expect(new Set(ids).size, eb.type).toBe(ids.length);
    }
  });
});
