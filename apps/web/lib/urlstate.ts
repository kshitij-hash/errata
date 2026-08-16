/** Every state on every route is URL-addressable (36 §7). replaceState keeps the address bar in
 * step without pushing history entries the demo would then have to walk back through. */
export function readParam(name: string): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get(name);
}

export function writeParams(patch: Record<string, string | null>): void {
  if (typeof window === 'undefined') return;
  const p = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === '') p.delete(k);
    else p.set(k, v);
  }
  const qs = p.toString();
  window.history.replaceState(null, '', qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
}
