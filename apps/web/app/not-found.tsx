import Link from 'next/link';

/** In-theme 404 (36 §6b): the author's-query card, gold — the same voice used for abstention. */
export default function NotFound() {
  return (
    <main className="nf">
      <div className="abst">
        <div className="qh">AUTHOR&apos;S QUERY</div>
        <div className="qt">This page is not in the history.</div>
        <div className="qs">no claim supports this route · nothing was deleted — it was never written</div>
      </div>
      <p className="q" style={{ marginTop: '1.2rem' }}>
        <Link href="/">← back to Ask</Link>
      </p>
    </main>
  );
}
