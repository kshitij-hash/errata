import Link from 'next/link';
import { QUESTIONS, citedAnswers, ctxTokens, p50, p50Ratio } from '../../lib/results';

/**
 * The economics line under the hero's argument: what an answer costs to read, how long it takes,
 * and the citation invariant — each one linking to the thing that proves it rather than to a
 * restatement of it.
 *
 * It used to lead with 60.0 vs 47.5 and close with the revision chain. The hero band above now
 * states both first and larger, which left this strip a quieter echo of the thing it is supposed to
 * follow, so it carries only what the hero does not. Every figure but the latency is recomputed
 * from the judged rows (lib/results.ts) and cannot drift from /results; latency is the one quantity
 * those rows do not carry, and it comes from the published constant rather than being retyped here.
 */
export function EvidenceStrip() {
  const cites = citedAnswers();
  return (
    <div className="evidence">
      <Link href="/results#arms">
        <b>
          {p50Ratio('errata', 'full_context')}× <i>lower p50</i>
        </b>
        <span>
          {p50('errata')}s vs {p50('full_context')}s to answer, p50 — reading the full history is the slow way
        </span>
      </Link>
      <Link href="/results/errata/overall">
        <b>{Math.round(ctxTokens('errata')).toLocaleString('en-US')} tok</b>
        <span>
          read per question, against {Math.round(ctxTokens('full_context')).toLocaleString('en-US')} — 1/
          {Math.round(ctxTokens('full_context') / ctxTokens('errata'))}rd the context for the same {QUESTIONS.length}{' '}
          questions
        </span>
      </Link>
      <Link href="/results/errata/overall">
        <b>
          {cites.cited} <i>of</i> {cites.answered}
        </b>
        <span>answered rows carry their session·turn citation — abstentions are not answers and are counted apart</span>
      </Link>
    </div>
  );
}
