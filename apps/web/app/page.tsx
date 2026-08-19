import Link from 'next/link';
import { StoryChain } from '../components/landing/StoryChain';
import { CHIPS, HISTORY_BLURB } from '../config/demo';
import { cell, cut, pct } from '../lib/results';

const ASK_Q = CHIPS.find((c) => !c.abstains)!.question;

export default function LandingPage() {
  const overall = cut('overall')!;
  const errata = pct(cell('errata', overall).pct);
  const fullCtx = pct(cell('full_context', overall).pct);
  const naive = pct(cell('naive', overall).pct);

  return (
    <main className="route landing">
      <section className="story-hero" aria-labelledby="story-h">
        <p className="kicker">An agent-memory layer on HydraDB</p>
        <h1 id="story-h">Memory that keeps its corrections.</h1>
        <p className="dek">
          Errata stores what a conversation established as an append-only graph of claims. When a fact
          changes, nothing is overwritten: the new claim supersedes the old one, and both stay dated,
          cited, and queryable.
        </p>
      </section>

      <section className="story" aria-labelledby="story-thread">
        <h2 id="story-thread" className="story-title">
          Watch it happen to one fact
        </h2>
        <p className="story-sub">
          The demo memory is one person&apos;s real chat history — {HISTORY_BLURB}. One thread runs
          through it: a mortgage pre-approval that would not sit still.
        </p>

        <StoryChain />

        <div className="story-ask">
          <p className="sa-q">&ldquo;{ASK_Q}&rdquo;</p>
          <Link className="cta" href={`/ask?q=${encodeURIComponent(ASK_Q)}`}>
            Ask the live graph
          </Link>
          <p className="sa-cap">
            the answer arrives cited to the exact turn, with every displaced value struck through
            beside it — and a question the history never answers gets an honest refusal, not a guess
          </p>
        </div>
      </section>

      <section className="story-proof" aria-labelledby="story-p">
        <h2 id="story-p" className="story-title">
          Measured, not asserted
        </h2>
        <p className="story-sub">
          On 150 LongMemEval questions, against the same reader model reading the <em>entire</em>{' '}
          history and against naive vector retrieval, Errata scores <b>{errata}</b> overall to their{' '}
          {fullCtx} and {naive} — at a fraction of the context — and the columns it loses are printed
          with the rest, every cell opening the judged rows behind it.
        </p>
        <div className="story-ctas">
          <Link className="cta" href="/results">
            See the evidence
          </Link>
          <Link className="cta ghost" href="/timeline">
            Replay the timeline
          </Link>
        </div>
      </section>
    </main>
  );
}
