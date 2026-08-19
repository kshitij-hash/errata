import Link from 'next/link';

/**
 * The appendix lives here, not in the masthead: field notes on the substrate's operating limits,
 * the exhibit, and the captured MCP transcript are for the reader who is already convinced.
 */
export function Colophon() {
  return (
    <footer className="colophon">
      <nav className="colo-docs" aria-label="Appendix">
        <span className="colo-h">Appendix</span>
        <Link href="/limits">Field notes — the substrate&apos;s limits, measured</Link>
        <Link href="/exhibit">Exhibit</Link>
        <a href="https://github.com/kshitij-hash/errata/blob/main/docs/mcp-demo.md">MCP demo transcript</a>
        <a href="https://github.com/kshitij-hash/errata">Source &amp; eval harness</a>
      </nav>
      <div className="colo-meta">
        <span>red = superseded · gold = author&apos;s query · teal = current</span>
      </div>
    </footer>
  );
}
