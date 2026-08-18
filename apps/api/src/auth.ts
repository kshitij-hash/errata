// apps/api/src/auth.ts — the shared-secret gate in front of the one mutating route.
//
// FAIL-OPEN WHEN UNCONFIGURED, CLOSED WHEN CONFIGURED. With ERRATA_WRITE_KEY unset the route behaves
// exactly as it always has, so local dev, vitest, the compose stack and the eval harness are all
// untouched. Set the variable — which the deployed pod does — and every POST /api/correction must
// carry the same value in X-Errata-Write-Key or it is refused before any graph write is attempted.
// That asymmetry is the point: the correction path is append-only, so a bad write cannot be undone.
//
// The env is read per request rather than at import, so a spec can set and clear it around a case.
import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

export const WRITE_KEY_HEADER = 'x-errata-write-key';

/** Length-safe constant-time compare (timingSafeEqual throws on a length mismatch). */
function equal(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

export function writeKeyGuard(): MiddlewareHandler {
  return async (c, next) => {
    const expected = process.env.ERRATA_WRITE_KEY ?? '';
    if (expected === '') return next(); // unconfigured: open, exactly as before this gate existed
    if (!equal(c.req.header(WRITE_KEY_HEADER) ?? '', expected)) {
      return c.json({ error: 'a valid X-Errata-Write-Key is required for this route' }, 401);
    }
    return next();
  };
}
