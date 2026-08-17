// Self-hosted type: no runtime font request ever leaves the origin, so the CSP can say
// font-src 'self'. All three families are OFL 1.1 — see apps/web/fonts/LICENSE.md.
import localFont from 'next/font/local';

export const fraunces = localFont({
  src: [
    {
      path: '../fonts/fraunces-normal-400-700.woff2',
      weight: '400 700',
      style: 'normal',
    },
    {
      path: '../fonts/fraunces-italic-400-700.woff2',
      weight: '400 700',
      style: 'italic',
    },
  ],
  variable: '--font-fraunces',
  display: 'swap',
  fallback: ['Georgia', 'serif'],
});

export const inter = localFont({
  src: [
    {
      path: '../fonts/inter-normal-400-700.woff2',
      weight: '400 700',
      style: 'normal',
    },
  ],
  variable: '--font-inter',
  display: 'swap',
  fallback: ['-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
});

export const plexMono = localFont({
  src: [
    {
      path: '../fonts/ibm-plex-mono-normal-400.woff2',
      weight: '400',
      style: 'normal',
    },
    {
      path: '../fonts/ibm-plex-mono-normal-500.woff2',
      weight: '500',
      style: 'normal',
    },
  ],
  variable: '--font-plex-mono',
  display: 'swap',
  fallback: ['ui-monospace', 'monospace'],
});
