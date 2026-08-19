import Link from 'next/link';
import { CHIPS } from '../../config/demo';
import { cell, cut, pct } from '../../lib/results';
import { AskLink } from './AskLink';
import { HeroChain } from './HeroChain';

/** The gold chip is the single source of the refusal question — the two must never drift. */
const ABSTAIN = CHIPS.find((c) => c.abstains)!;

/**
 * The refusal beat's two measurements. /api/ask is the only route that computes E, and it is a
 * priced model call, so firing one on every landing render would put the hero on the cost meter to
 * restate a number that has not moved. Both are therefore printed, not fetched — and verified
 * against the live demo history before being printed.
 *
 * Verified 2026-08-19 against the running API on history 852ce960-clean:
 * `POST /api/ask {"question":"What is my dog's name?"}` → abstained, E = 0.29317844 (τ = 0.35),
 * one nearest miss above s = 0 (favorite_book_interest, s = 0.5285) — which is the one the refusal
 * card shows and sets aside.
 */
const ABSTAIN_EVIDENCE = '0.29';
const ABSTAIN_MISSES = 1;

export function HeroBand() {
  const extraction = cut('information-extraction')!;
  const overall = cut('overall')!;
  const lost = pct(cell('errata', extraction).pct);
  const lostTo = pct(cell('full_context', extraction).pct);

  return (
    <section className="hero" aria-labelledby="hero-h">
      <p className="kicker">Errata — Track 3, measured entry</p>
      <h1 id="hero-h">
        <span>Everyone claims contradiction handling.</span>
        <span>Here is what it scores.</span>
      </h1>
      <p className="dek">
        Three claims, one screen, each one checkable behind its card. The whole argument before your first click.
      </p>

      <div className="beats">
        <Link href="/timeline" className="beat">
          <p className="bh">
            <i>I.</i> The correction is kept
          </p>
          <HeroChain />
        </Link>

        <AskLink question={ABSTAIN.question} className="beat">
          <p className="bh">
            <i>II.</i> It refuses what it never learned
          </p>
          <p className="bbody">
            <span className="bq">{ABSTAIN.question}</span>
            <span className="plate">The history never says.</span>
          </p>
          <p className="bcap">
            evidence {ABSTAIN_EVIDENCE} · {ABSTAIN_MISSES} nearest miss retrieved, shown, and set aside — the chunk a
            vector store would have returned
          </p>
        </AskLink>

        <Link href="/results" className="beat">
          <p className="bh">
            <i>III.</i> The losses are printed
          </p>
          <p className="bbody">
            <span className="bloss">
              {lost} <i>vs</i> {lostTo}
            </span>
            <span className="bq">single-fact extraction — the column it loses</span>
          </p>
          <p className="bcap">
            two rejected experiments published at full size · reverts verified answer-for-answer ·{' '}
            {pct(cell('errata', overall).pct)} vs {pct(cell('full_context', overall).pct)} overall, judged rows attached
          </p>
        </Link>
      </div>

      <div className="herocta">
        <a href="#ask" className="cta">
          Open the instrument
        </a>
        <p className="itin">
          or take the four stops: <a href="#ask">the correction</a> <i>→</i> <Link href="/timeline">the chain</Link>{' '}
          <i>→</i> <AskLink question={ABSTAIN.question}>the refusal</AskLink> <i>→</i>{' '}
          <Link href="/results">the receipts</Link>
        </p>
      </div>
    </section>
  );
}
