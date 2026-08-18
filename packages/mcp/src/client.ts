// packages/mcp/src/client.ts — the ONE seam that talks to the network. Everything else in this
// package is pure. HTTP to apps/api only (CLAUDE.md's boundary discipline: never Bolt, never
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
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
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
    return this.request<T>(path, { method: 'POST', body: JSON.stringify(body) });
  }
}

/** `ERRATA_API_URL`, default matching apps/api's own default bind (apps/api/src/index.ts). */
export function apiBaseUrl(): string {
  return process.env.ERRATA_API_URL ?? 'http://127.0.0.1:8787';
}
