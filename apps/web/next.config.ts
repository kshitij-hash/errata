import type { NextConfig } from 'next';

const dev = process.env.NODE_ENV !== 'production';

/**
 * Craft rule 5: the browser talks ONLY to this origin. connect-src 'self' makes that a
 * machine-checked promise rather than a claim; font-src 'self' is affordable because the three
 * families are vendored (apps/web/fonts). frame-ancestors 'none' keeps the demo un-embeddable.
 */
const csp = [
  "default-src 'self'",
  // Next's runtime inlines its bootstrap; dev additionally needs eval for react-refresh.
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

const nextConfig: NextConfig = {
  // the repo already carries its conventions in the root CLAUDE.md; don't scatter generated copies
  agentRules: false,
  // the dev overlay sits on top of the paper in every review screenshot
  devIndicators: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
