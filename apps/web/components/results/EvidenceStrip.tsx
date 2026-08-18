import Link from 'next/link';
import { QUESTIONS, cell, citedAnswers, ctxTokens, cut, pct } from '../../lib/results';

/**
 * Three claims above the fold, each linking to the thing that proves it rather than to a
 * restatement of it. The two numbers are recomputed from the judged rows (lib/results.ts), so this
 * strip cannot drift from /results.
 */
export function EvidenceStrip() {
  const overall = cut('overall')!;
  const cites = citedAnswers();
  return (
    <div className="evidence">
      <Link href="/results">
        <b>
          {pct(cell('errata', overall).pct)} <i>vs</i> {pct(cell('full_context', overall).pct)}
        </b>
        <span>
          overall against full-context on {QUESTIONS.length} LongMemEval questions — every cell opens the rows it was
          counted from
        </span>
      </Link>
      <Link href="/results/errata/overall">
        <b>{Math.round(ctxTokens('errata')).toLocaleString('en-US')} tok</b>
        <span>
          read per question, against {Math.round(ctxTokens('full_context')).toLocaleString('en-US')} — and all{' '}
          {cites.cited} of {cites.answered} answered rows carry their session·turn citation
        </span>
      </Link>
      <Link href="/timeline">
        <b>
          $350,000 <i>→</i> $400,000
        </b>
        <span>the correction and the thing it corrected are both still queryable — the revision chain, replayed</span>
      </Link>
    </div>
  );
}
