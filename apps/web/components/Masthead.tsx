'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CostMeter } from './CostMeter';
import { TAGLINE } from '../config/demo';

// Demo order first (ask → timeline → compare), then Limits: it is the strongest artifact here —
// the failure modes named and measured rather than hidden — and it was buried in last place.
const NAV = [
  { href: '/', label: 'Ask' },
  { href: '/timeline', label: 'Timeline' },
  { href: '/compare', label: 'Compare' },
  { href: '/limits', label: 'Limits' },
  { href: '/results', label: 'Results' },
  { href: '/exhibit', label: 'Exhibit' },
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
