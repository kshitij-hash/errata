// packages/mcp/src/client.ts — the ONE seam that talks to the network. Everything else in this
// package is pure. HTTP to apps/api only (CONVENTIONS.md's boundary discipline: never Bolt, never
// HydraDB directly — the eval harness holds the same line).
//
// Non-2xx responses are NOT thrown: apps/api answers a bad correction with a structured 400/404/409
// JSON body, and the whole point of `memory_correct`/`memory_remember` is to hand that back to the
// agent as a typed result instead of an exception. `request` always resolves; only a network-level
// failure (the API unreachable) throws.

export interface ApiResult<T> {
  status: number;
  ok: boolean;
  body: T;
}

export class ErrataClient {
  private readonly baseUrl: string;
  private readonly writeKey: string | undefined;
  constructor(baseUrl: string, writeKey?: string) {
    this.baseUrl = baseUrl;
    this.writeKey = writeKey;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
    const res = await fetch(new URL(path, this.baseUrl), {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
    });
    const body = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, ok: res.ok, body };
  }

  get<T>(path: string, params: Record<string, string | number | undefined>): Promise<ApiResult<T>> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    return this.request<T>(`${path}?${qs.toString()}`);
  }

  post<T>(path: string, body: unknown): Promise<ApiResult<T>> {
    // The API's one write route is gated by X-Errata-Write-Key when the server configures it
    // (apps/api/src/auth.ts). Attached only when this process was given the key: a keyless local
    // stack keeps working exactly as before, and against a deployed API the write tools carry the
    // credential instead of bouncing off the 401.
    const headers: Record<string, string> = this.writeKey ? { 'x-errata-write-key': this.writeKey } : {};
    return this.request<T>(path, { method: 'POST', body: JSON.stringify(body), headers });
  }
}

/** `ERRATA_API_URL`, default matching apps/api's own default bind (apps/api/src/index.ts). */
export function apiBaseUrl(): string {
  return process.env.ERRATA_API_URL ?? 'http://127.0.0.1:8787';
}

/** `ERRATA_WRITE_KEY` — required only for `memory_correct`/`memory_remember` against a deployed
 *  API whose write gate is configured; leave unset against a local stack. */
export function writeKey(): string | undefined {
  return process.env.ERRATA_WRITE_KEY || undefined;
}
