import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Exhibit',
  description: 'Exhibit A — bitemporal grounding: two clocks, when it happened and when we learned it, never collapsed.',
};

/*
 * This plaque used to carry a verbatim quote of a stored memory (including a named individual), a
 * quoted line attributed to another project's staff, and the framing "the market leader stamped
 * 2026 on a 2023 event". None of that is verifiable from here, and the framing read as an
 * attack rather than an argument. What is checkable is the public issue itself, so the claim is now
 * attributed to it, at the level of detail the tracker supports, and nothing more is asserted about
 * what any other team did or said. Our own two timestamps below are the actual exhibit.
 */
export default function ExhibitPage() {
  return (
    <main className="route">
      <h1 className="rtitle">The exhibit</h1>
      <div className="plaque">
        <div className="plq">EXHIBIT A · BITEMPORAL GROUNDING</div>
        <div className="pt">Two clocks. Never collapsed into one.</div>
        <blockquote>
          A memory stored with an event date years apart from the date of the conversation it was
          extracted from, as reported in mem0&apos;s public issue tracker (issue #3944). Reported there,
          not verified here.
        </blockquote>
        <div className="ours">
          errata · the same shape of transcript:
          <br />
          event_time <b>2023-05-07</b> · ingest_time <b>2026-08-17</b> · both stored, both queryable, forever
        </div>
      </div>
      <p className="q" style={{ marginTop: '1.4rem', maxWidth: '560px' }}>
        Two clocks, never collapsed: when it happened, and when we learned it. A memory that keeps only one of them has
        to guess at the other — and a guessed date is indistinguishable, downstream, from a recorded one.
      </p>
    </main>
  );
}
