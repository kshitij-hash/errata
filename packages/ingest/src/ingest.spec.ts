import { describe, it, expect } from 'vitest';
import { resolveBelief } from '@errata/core';
import type { ClaimRow, RevisionEdgeRow } from '@errata/core';
import { parseHistory } from './reader.js';
import type { RawRecord } from './reader.js';
import { RuleExtractor } from './extract.js';
import { prepareClaims, resolveConflicts } from './build.js';
import { assemble } from './pipeline.js';
import { isSalient } from './text.js';
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

  it('builds a lexicon that anchors first-person questions to the SELF entity', async () => {
    const extracted = await new RuleExtractor().extract(H);
    const a = assemble(H, extracted, { model: 'rule@1', runId: 'r1', ingestTime: 1_700_000_000 });
    const lex = buildLexicon(H.historyId, a.entities);
    expect(lex.self.length).toBeGreaterThan(0);
    expect(lex.terms['i']).toEqual(lex.self);
    expect(lex.terms['wells']).toBeDefined(); // the mention entity is retrievable by name token
  });
});
