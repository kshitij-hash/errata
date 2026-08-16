import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Exhibit',
  description: 'Exhibit A — bitemporal grounding: the market leader stamped 2026 on a 2023 event.',
};

export default function ExhibitPage() {
  return (
    <main className="route">
      <h1 className="rtitle">The exhibit</h1>
      <div className="plaque">
        <div className="plq">EXHIBIT A · BITEMPORAL GROUNDING</div>
        <div className="pt">The market leader stamped 2026 on a 2023 event.</div>
        <blockquote>
          &ldquo;Caroline attended an LGBTQ conference in early January 2026…&rdquo; — stored by mem0&apos;s platform
          for an event dated 7 May 2023 (their issue #3944; staff: &ldquo;storing fabricated details&rdquo;)
        </blockquote>
        <div className="ours">
          errata · the same transcript:
          <br />
          event_time <b>2023-05-07</b> · ingest_time <b>2026-08-17</b> · both queryable, forever
        </div>
      </div>
      <p className="q" style={{ marginTop: '1.4rem', maxWidth: '560px' }}>
        Two clocks, never collapsed: when it happened, and when we learned it. A memory that keeps only one of them has
        to guess — and guessing is how a 2023 conference becomes a 2026 one.
      </p>
    </main>
  );
}
