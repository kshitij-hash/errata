'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CostMeter } from './CostMeter';
import { TAGLINE } from '../config/demo';

const NAV = [
  { href: '/', label: 'Ask' },
  { href: '/timeline', label: 'Timeline' },
  { href: '/compare', label: 'Compare' },
  { href: '/exhibit', label: 'Exhibit' },
  { href: '/limits', label: 'Limits' },
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
