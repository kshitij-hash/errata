import { describe, it, expect } from 'vitest';
import { parseHistory } from './reader.js';
import type { RawRecord } from './reader.js';
import { prepareClaims } from './build.js';
import { LlmExtractor, makeJudge, resolveConflictsWithJudge, verdictToEdge } from './llm.js';
import type { Completer, JudgeVerdict } from './llm.js';

class MockCompleter implements Completer {
  calls: { role: string; messages: { role: string; content: string }[] }[] = [];
  constructor(private readonly byRole: Record<string, unknown>) {}
  async complete(args: Parameters<Completer['complete']>[0]): Promise<{ text: string; json?: unknown }> {
    this.calls.push({ role: args.role, messages: args.messages });
    const json = this.byRole[args.role];
    return { text: JSON.stringify(json), json };
  }
}

const REC: RawRecord = {
  question_id: 'llm_test',
  question: 'q',
  answer: 'a',
  question_date: '2023/12/01 (Fri) 00:00',
  answer_session_ids: [],
  haystack_session_ids: ['s1'],
  haystack_dates: ['2023/08/01 (Tue) 00:00'],
  haystack_sessions: [[{ role: 'user', content: 'I am now working at Globex as an engineer and I recently moved to Berlin.' }]],
};
const H = parseHistory(REC);

describe('LlmExtractor (mocked completer)', () => {
  it('maps model claims to ExtractedClaim and rejects hallucinated citations', async () => {
    const completer = new MockCompleter({
      extractor: {
        claims: [
          { subject: 'the user', attribute: 'employer', value: 'Globex', polarity: 'AFFIRM', event_time_iso: '', session_id: 's1', turn_idx: 0, evidence_span: 'working at Globex' },
          { subject: 'the user', attribute: 'employer', value: 'Ghost', polarity: 'AFFIRM', event_time_iso: '', session_id: 's9', turn_idx: 99, evidence_span: 'nope' }, // bad citation
        ],
      },
    });
    const claims = await new LlmExtractor(completer).extract(H);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.value).toBe('Globex');
    expect(claims[0]!.sessionId).toBe('s1');
    expect(completer.calls.some((c) => c.role === 'extractor')).toBe(true);
  });

  it('keeps the valid claims when ONE claim in the batch is malformed (per-claim resilience, P2-13)', async () => {
    const completer = new MockCompleter({
      extractor: {
        claims: [
          { subject: 'the user', attribute: 'employer', value: 'Globex', polarity: 'AFFIRM', event_time_iso: '', session_id: 's1', turn_idx: 0, evidence_span: 'globex' },
          { subject: 'the user', attribute: 'employer', polarity: 'AFFIRM', event_time_iso: '', session_id: 's1', turn_idx: 0, evidence_span: 'no value → malformed' }, // missing `value`
          { subject: 'the user', attribute: 'city_of_residence', value: 'Berlin', polarity: 'AFFIRM', event_time_iso: '', session_id: 's1', turn_idx: 0, evidence_span: 'berlin' },
        ],
      },
    });
    const claims = await new LlmExtractor(completer).extract(H);
    expect(claims.map((c) => c.value).sort()).toEqual(['Berlin', 'Globex']); // malformed dropped, siblings survive
  });
});

describe('makeJudge payload (spec 31 §3.5)', () => {
  it('sends history_id + per-side claim_id, time_basis, and confidence', async () => {
    const completer = new MockCompleter({ judge: { relation: 'SUPERSEDES', confidence: 0.9, same_attribute: true, temporal_order: 'CANDIDATE_NEWER', rationale: 'r' } });
    const judge = makeJudge(completer, 'hist_x');
    const side = (value: string, id: number): never =>
      ({ claimKey: `k${id}`, claimId: id, subjectNorm: 'the user', attribute: 'employer', arity: 'FUNCTIONAL', value, valueNorm: value.toLowerCase(), eventTimeIso: '2023-01-01', timeBasis: 'EXPLICIT', confidence: 0.8, evidenceSpan: value } as never);
    await judge(side('Acme', 1), side('Globex', 2));
    const user = completer.calls[0]!.messages.find((m) => m.role === 'user')!;
    const payload = JSON.parse(user.content) as { history_id: string; incumbent: Record<string, unknown>; candidate: Record<string, unknown> };
    expect(payload.history_id).toBe('hist_x');
    for (const s of [payload.incumbent, payload.candidate]) {
      expect(s).toHaveProperty('claim_id');
      expect(s).toHaveProperty('time_basis');
      expect(s).toHaveProperty('confidence');
    }
  });
});

describe('verdictToEdge (spec 31 §3.5 mapping)', () => {
  const cand = { claimKey: 'ck', claimId: 2 } as never;
  const head = { claimKey: 'hk', claimId: 1 } as never;
  const v = (p: Partial<JudgeVerdict>): JudgeVerdict => ({ relation: 'SUPERSEDES', confidence: 0.86, same_attribute: true, temporal_order: 'CANDIDATE_NEWER', rationale: 'r', ...p });

  it('SUPERSEDES with candidate newer → SUPERSEDES/OK', () => {
    const e = verdictToEdge(v({}), cand, head);
    expect(e.type).toBe('SUPERSEDES');
    expect(e.judge_status).toBe('OK');
  });
  it('SUPERSEDES but incumbent newer → downgraded to CONTRADICTS/LOW_CONF', () => {
    expect(verdictToEdge(v({ temporal_order: 'INCUMBENT_NEWER' }), cand, head).type).toBe('CONTRADICTS');
  });
  it('low confidence → CONTRADICTS/LOW_CONF, never dropped', () => {
    const e = verdictToEdge(v({ confidence: 0.3 }), cand, head);
    expect(e.type).toBe('CONTRADICTS');
    expect(e.judge_status).toBe('LOW_CONF');
    expect(e.confidence).toBeGreaterThanOrEqual(0.1);
  });
  it('SUPPORTS → SUPPORTS', () => {
    expect(verdictToEdge(v({ relation: 'SUPPORTS' }), cand, head).type).toBe('SUPPORTS');
  });
  it('UNRELATED / different attribute → no revision edge (claim appended, edge withheld)', () => {
    expect(verdictToEdge(v({ relation: 'UNRELATED' }), cand, head)).toBeNull();
    expect(verdictToEdge(v({ same_attribute: false }), cand, head)).toBeNull();
  });
});

describe('resolveConflictsWithJudge', () => {
  it('uses the judge for a FUNCTIONAL differ and advances the chain on SUPERSEDES', async () => {
    const rec: RawRecord = {
      ...REC,
      haystack_session_ids: ['s1', 's2'],
      haystack_dates: ['2023/08/01 (Tue) 00:00', '2023/11/01 (Wed) 00:00'],
      haystack_sessions: [
        [{ role: 'user', content: 'My employer is Acme.' }],
        [{ role: 'user', content: 'My employer is Globex now.' }],
      ],
    };
    const h2 = parseHistory(rec);
    const prepared = prepareClaims(h2, [
      { subject: 'the user', attribute: 'employer', value: 'Acme', polarity: 'AFFIRM', eventTimeIso: '', sessionId: 's1', turnIdx: 0, evidenceSpan: 'employer is Acme', confidence: 0.8 },
      { subject: 'the user', attribute: 'employer', value: 'Globex', polarity: 'AFFIRM', eventTimeIso: '', sessionId: 's2', turnIdx: 0, evidenceSpan: 'employer is Globex', confidence: 0.8 },
    ]);
    const judge = makeJudge(new MockCompleter({ judge: { relation: 'SUPERSEDES', confidence: 0.9, same_attribute: true, temporal_order: 'CANDIDATE_NEWER', rationale: 'newer' } }), 'llm_test');
    const edges = await resolveConflictsWithJudge(prepared, judge);
    expect(edges.filter((e) => e.type === 'SUPERSEDES')).toHaveLength(1);
  });
});
