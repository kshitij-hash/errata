// apps/api/src/ratelimit.ts — a per-caller fixed-window request cap, held in this process's memory.
//
// The API has no accounts, so the caller's address is the finest thing a quota can be attributed to.
// This is an abuse brake for a publicly proxied pod, not a fairness scheduler: one Map, one counter
// per window, entries dropped as their windows roll. Nothing is shared between processes — a pod
// runs exactly one API — and nothing survives a restart, which is the right trade for a demo.
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, MiddlewareHandler } from 'hono';

/** Same-host callers: the eval harness, failure_review.py and the ingest CLI all talk to the API
 *  over loopback, and on the pod nothing from outside arrives that way (RunPod's proxy is a hop). */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * The bucket key: X-Forwarded-For's leftmost entry when a proxy set one (both the Vercel route
 * handler and RunPod's HTTPS proxy do), else the socket address. XFF is caller-controlled and so
 * spoofable — accepted deliberately: this counter slows a naive flood, and the one mutating route
 * is gated by a shared secret (auth.ts), never by this.
 */
export function clientKey(c: Context): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff) return xff.split(',')[0]?.trim() || 'unknown';
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown'; // no Node socket behind this request (vitest's app.request)
  }
}

export interface RateLimitOptions {
  /** requests allowed per window, per key. */
  limit?: number;
  windowMs?: number;
  /** injected clock, so the spec never has to sleep a minute. */
  now?: () => number;
  /** injected key derivation, so the spec never has to fake a socket. */
  keyOf?: (c: Context) => string;
}

/** Fixed-window counter over `keyOf`; 429 with `retry-after` once a key exceeds `limit`. */
export function rateLimit(opts: RateLimitOptions = {}): MiddlewareHandler {
  const limit = opts.limit ?? 60;
  const windowMs = opts.windowMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const keyOf = opts.keyOf ?? clientKey;
  const hits = new Map<string, { count: number; start: number }>();
  return async (c, next) => {
    const key = keyOf(c);
    if (LOOPBACK.has(key)) return next();
    const t = now();
    // bounded memory: sweep expired windows only once the table is big enough to be worth sweeping.
    if (hits.size > 1024) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
    const slot = hits.get(key);
    if (!slot || t - slot.start >= windowMs) {
      hits.set(key, { count: 1, start: t });
      return next();
    }
    slot.count += 1;
    if (slot.count > limit) {
      const retry = Math.max(1, Math.ceil((slot.start + windowMs - t) / 1000));
      return c.json({ error: 'rate limit exceeded' }, 429, { 'retry-after': String(retry) });
    }
    return next();
  };
}
