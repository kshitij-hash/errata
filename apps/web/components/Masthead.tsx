'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CostMeter } from './CostMeter';
import { TAGLINE } from '../config/demo';

// The instrument first (ask → timeline → compare), then the evidence. The appendix pages —
// field notes on the substrate, the exhibit — live in the footer's docs cluster, not here:
// they are for the reader who is already convinced, and a warning label is a poor greeting.
const NAV = [
  { href: '/ask', label: 'Ask' },
  { href: '/timeline', label: 'Timeline' },
  { href: '/compare', label: 'Compare' },
  { href: '/results', label: 'Results' },
];

export function Masthead() {
  const pathname = usePathname();
  return (
    <div className="masthead">
      <div className="mh-in">
        <Link href="/" className="wordmark">
          Errata<i>.</i>
        </Link>
        <nav aria-label="Sections">
          {NAV.map((n) => {
            const on = n.href === '/' ? pathname === '/' : pathname.startsWith(n.href);
            return (
              <Link key={n.href} href={n.href} className={on ? 'on' : undefined} aria-current={on ? 'page' : undefined}>
                {n.label}
              </Link>
            );
          })}
        </nav>
        <CostMeter />
      </div>
      <div className="tagline">{TAGLINE}</div>
    </div>
  );
}
