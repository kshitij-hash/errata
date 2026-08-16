import { describe, it, expect } from 'vitest';
import { keys } from '@errata/graph';
import { resolveBelief } from '@errata/core';
import type { ClaimRow, RevisionEdgeRow } from '@errata/core';
import { parseHistory } from './reader.js';
import type { RawRecord } from './reader.js';
import { RuleExtractor } from './extract.js';
import { prepareClaims, resolveConflicts } from './build.js';
import { assemble } from './pipeline.js';
import { NORM_VERSION, isSalient, normValue } from './text.js';
import { buildLexicon } from './lexicon.js';

const REC: RawRecord = {
  question_id: 'ingest_test',
  question: 'What was the amount I was pre-approved for from Wells Fargo?',
  answer: '$400,000',
  question_date: '2023/12/18 (Mon) 04:17',
  answer_session_ids: ['s_aug', 's_nov'],
  haystack_session_ids: ['s_aug', 's_nov'],
  haystack_dates: ['2023/08/11 (Fri) 00:01', '2023/11/30 (Thu) 00:36'],
  haystack_sessions: [
    [
      { role: 'user', content: 'I am buying a $325,000 house, and I got pre-approved for $350,000 from Wells Fargo. What closing costs should I expect?' },
      { role: 'assistant', content: 'Congratulations on your pre-approval! Here is a breakdown of estimated closing costs for you.' },
    ],
    [
      { role: 'user', content: 'I am moving into my new home soon. Remember when I got pre-approved for $400,000 from Wells Fargo?' },
      { role: 'assistant', content: 'I do not retain personal details between conversations, but congratulations on your new home!' },
    ],
  ],
};

const H = parseHistory(REC);

describe('reader + salience', () => {
  it('parses sessions with positional turn ids and aligned dates', () => {
    expect(H.sessions).toHaveLength(2);
    expect(H.sessions[0]!.turns[0]!.turnId).toBe('s_aug:0');
    expect(H.sessions[0]!.dateIso).toBe('2023-08-11');
    expect(H.sessions[1]!.dateIso).toBe('2023-11-30');
  });
  it('marks the fact-bearing user turns salient', () => {
    expect(isSalient(H.sessions[0]!.turns[0]!, true)).toBe(true);
  });
});

describe('deterministic extraction + conflict (the belief-revision demo)', () => {
  it('extracts the pre-approval amounts and lender from the transcript', async () => {
    const claims = await new RuleExtractor().extract(H);
    const amounts = claims.filter((c) => c.attribute === 'mortgage_preapproval_amount').map((c) => c.value);
    expect(amounts).toEqual(['$350,000', '$400,000']);
    expect(claims.some((c) => c.attribute === 'mortgage_lender' && /wells fargo/i.test(c.value))).toBe(true);
  });

  it('resolves the later pre-approval as superseding the earlier one', async () => {
    const extracted = await new RuleExtractor().extract(H);
    const prepared = prepareClaims(H, extracted);
    const revision = resolveConflicts(prepared);
    const sup = revision.filter((r) => r.type === 'SUPERSEDES');
    expect(sup).toHaveLength(1);

    // fold the amount claims + the supersession → current belief must be $400,000
    const amountClaims = prepared.filter((p) => p.attribute === 'mortgage_preapproval_amount');
    const rows: ClaimRow[] = amountClaims.map((p) => ({
      claim_id: p.claimId, value: p.value, value_norm: p.valueNorm, attribute: p.attribute, arity: p.arity,
      polarity: p.polarity, event_time: p.eventTime, ingest_time: 1_700_000_000, confidence: p.confidence,
      provenance: 'EXTRACTED', judge_status: 'NONE', session_id: p.sessionId, turn_id: p.turnId, turn_index: p.turnIdx, evidence_span: p.evidenceSpan,
    }));
    const edges: RevisionEdgeRow[] = revision
      .filter((r) => amountClaims.some((a) => a.claimId === r.newerId))
      .map((r) => ({ newer_id: r.newerId, older_id: r.olderId, relation: r.type, ingest_time: 1_700_000_000, confidence: r.confidence, provenance: 'INFERRED', judge_status: r.judge_status as ClaimRow['judge_status'], rationale: r.rationale }));
    const belief = resolveBelief(rows, edges);
    expect(belief.head?.value).toBe('$400,000');
    expect(belief.head?.citation.session_id).toBe('s_nov');
    expect(belief.superseded.map((s) => s.value)).toContain('$350,000');
  });
});

describe('assemble — full batch shape', () => {
  it('produces the five node labels and revision edges, null-free', async () => {
    const extracted = await new RuleExtractor().extract(H);
    const a = assemble(H, extracted, { model: 'rule@1', runId: 'r1', ingestTime: 1_700_000_000 });
    const labels = a.nodes.map((n) => n.label);
    expect(labels).toEqual(['Speaker', 'Session', 'Turn', 'Entity', 'Claim']);
    expect(a.counts.claims).toBeGreaterThanOrEqual(4);
    expect(a.counts.supersedes).toBe(1);
    expect(a.counts.supports).toBeGreaterThanOrEqual(1);
    // null-free: every node row has every declared property defined
    for (const nb of a.nodes) for (const row of nb.rows) for (const v of Object.values(row)) expect(v).not.toBeUndefined();
  });

  it('emits ONE ABOUT edge when the value resolves to the subject entity (SUBJECT wins, no id clash)', () => {
    // subject "Ethan" + proper-noun value "Ethan" → same entity on both ends of ABOUT; two rows
    // with the same edge id and differing `role` made HydraDB reject the batch (G2 sample-150).
    const a = assemble(
      H,
      [{ subject: 'Ethan', attribute: 'nickname', value: 'Ethan', polarity: 'AFFIRM', eventTimeIso: '', sessionId: 's1', turnIdx: 0, evidenceSpan: 'ethan', confidence: 0.8 }],
      { model: 'rule@1', runId: 'r1', ingestTime: 1_700_000_000 },
    );
    const aboutRows = a.edges.filter((b) => b.type === 'ABOUT').flatMap((b) => b.rows) as { id: number; role: string }[];
    const ids = aboutRows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate edge ids
    expect(aboutRows.filter((r) => r.role === 'SUBJECT')).toHaveLength(1);
  });

  it('builds a lexicon that anchors first-person questions to the SELF entity', async () => {
    const extracted = await new RuleExtractor().extract(H);
    const a = assemble(H, extracted, { model: 'rule@1', runId: 'r1', ingestTime: 1_700_000_000 });
    const lex = buildLexicon(H.historyId, a.entities);
    expect(lex.self.length).toBeGreaterThan(0);
    expect(lex.terms['i']).toEqual(lex.self);
    expect(lex.terms['wells']).toBeDefined(); // the mention entity is retrievable by name token
  });
});

// B5 — the demo history was double-ingested and one attribute ended up holding `$400,000` and
// `400000 USD` as two claim vertices. Re-ingesting the SAME history must never grow the graph:
// every vertex id is a pure function of (history, normalization version, position, normalized
// text), so a second load is a MERGE onto the same ids and the counts do not move. These tests
// pin exactly that, and pin that the normalization version is what a normalizer change moves.
describe('re-ingest idempotence (B5)', () => {
  const idsOf = (a: ReturnType<typeof assemble>): { nodes: Map<string, number[]>; edges: Map<string, number[]> } => ({
    nodes: new Map(a.nodes.map((n) => [n.label, n.rows.map((r) => Number(r.id)).sort((x, y) => x - y)])),
    edges: new Map(a.edges.map((e) => [e.type, e.rows.map((r) => Number(r.id)).sort((x, y) => x - y)])),
  });

  it('ingesting the same history twice yields identical vertex counts and identical ids', async () => {
    const extracted = await new RuleExtractor().extract(H);
    const first = assemble(H, extracted, { model: 'rule@1', runId: 'run-one', ingestTime: 1_700_000_000 });
    // a genuinely separate run: different run id, different ingest clock, re-parsed history
    const second = assemble(parseHistory(REC), await new RuleExtractor().extract(parseHistory(REC)), {
      model: 'rule@1',
      runId: 'run-two',
      ingestTime: 1_800_000_000,
    });

    expect(second.counts).toEqual(first.counts);
    const a = idsOf(first);
    const b = idsOf(second);
    expect([...b.nodes.keys()]).toEqual([...a.nodes.keys()]);
    for (const [label, ids] of a.nodes) expect(b.nodes.get(label), label).toEqual(ids);
    for (const [type, ids] of a.edges) expect(b.edges.get(type), type).toEqual(ids);

    // the union of both runs' vertex ids is the size of ONE run: the second load adds nothing
    const union = new Set([...a.nodes.values(), ...b.nodes.values()].flat());
    const single = new Set([...a.nodes.values()].flat());
    expect(union.size).toBe(single.size);
  });

  it('every claim id is distinct within a run (no accidental MERGE of two claims onto one vertex)', async () => {
    const extracted = await new RuleExtractor().extract(H);
    const a = assemble(H, extracted, { model: 'rule@1', runId: 'r', ingestTime: 1 });
    const claimIds = a.nodes.find((n) => n.label === 'Claim')!.rows.map((r) => Number(r.id));
    expect(new Set(claimIds).size).toBe(claimIds.length);
  });

  it('normValue collapses the same amount written two ways onto ONE claim key (the B5 defect)', () => {
    // the rule extractor wrote `$400,000`; the LLM extractor wrote `400000 USD` — same sentence,
    // same turn, same fact. v1 keyed them apart and the chain forked.
    expect(normValue('$400,000')).toBe('400000 usd');
    expect(normValue('400000 USD')).toBe('400000 usd');
    expect(normValue('$400,000')).toBe(normValue('400000 USD'));
    const k = (v: string): string => keys.claim('h1', 'the user', 'mortgage_preapproval_amount', normValue(v), 36, 0, NORM_VERSION);
    expect(k('$400,000')).toBe(k('400000 USD'));
    expect(k('$400,000')).not.toBe(k('$350,000'));
  });

  it('normValue stays narrow — it never invents a currency or merges unlike values', () => {
    expect(normValue('400000 EUR')).toBe('400000 eur'); // currencies stay distinct
    expect(normValue('400000')).toBe('400000'); // no marker, no guess
    expect(normValue('about 30')).toBe('about 30'); // a phrase is left alone
    expect(normValue('400000 miles')).toBe('400000 miles');
    expect(normValue('Wells Fargo')).toBe('wells fargo');
    expect(normValue('')).toBe('');
  });

  it('a normalization-version bump re-keys claims instead of colliding with the old generation', () => {
    const args = ['h1', 'the user', 'mortgage_preapproval_amount', '400 000', 31, 0] as const;
    expect(keys.claim(...args, NORM_VERSION)).not.toBe(keys.claim(...args, NORM_VERSION + 1));
  });
});
