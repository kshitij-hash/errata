import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { fraunces, inter, plexMono } from './fonts';
import { Masthead } from '../components/Masthead';
import { Colophon } from '../components/Colophon';
import { CoverBeat } from '../components/CoverBeat';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'https://errata.tools'),
  title: {
    default: 'Errata — memory that keeps its corrections',
    template: '%s · Errata',
  },
  description:
    'An append-only belief graph for agent memory: every answer cited, every revision kept, refusal when the history never says.',
  applicationName: 'Errata',
  openGraph: {
    title: 'Errata — memory that keeps its corrections',
    description: 'Every answer cited, every revision kept, refusal when the history never says.',
    siteName: 'Errata',
    type: 'website',
    images: ['/og.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Errata',
    description: 'Memory that keeps its corrections.',
    images: ['/og.png'],
  },
  robots: { index: true, follow: true },
};

/** 36 §6b: light-only, enforced — an auto-darkening browser must not invert the paper. */
export const viewport: Viewport = {
  themeColor: '#FAF8F4',
  colorScheme: 'only light',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${inter.variable} ${plexMono.variable}`}>
      <body>
        <CoverBeat />
        <Masthead />
        {children}
        <Colophon />
      </body>
    </html>
  );
}
