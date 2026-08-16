// The origin-only proxy (36 §3.5). The browser never learns the API's address: it talks to this
// route handler on the Vercel origin, which forwards to the pod over the server-side network.
// Cross-origin callers are refused so the handler can't be used as an open relay.

const UPSTREAM = process.env.ERRATA_API_URL ?? 'http://127.0.0.1:8787';

/** The read surface the UI is allowed to reach, plus the correction write path (blocker B1). */
const ALLOW_GET = new Set(['meta', 'meta/costs', 'meta/health', 'belief', 'diff']);
const ALLOW_POST = new Set(['ask', 'correction']);

export const dynamic = 'force-dynamic';

function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true; // same-origin GETs and server-side calls send no Origin
  const host = req.headers.get('host');
  try {
    return new URL(origin).host === (host ?? new URL(req.url).host);
  } catch {
    return false;
  }
}

async function forward(req: Request, path: string, allow: Set<string>): Promise<Response> {
  if (!sameOrigin(req)) return Response.json({ error: 'cross-origin requests are refused' }, { status: 403 });
  if (!allow.has(path)) return Response.json({ error: `path not allowed: ${path}` }, { status: 404 });

  const search = new URL(req.url).search;
  const target = `${UPSTREAM}/api/${path}${search}`;
  const init: RequestInit = {
    method: req.method,
    headers: { accept: 'application/json' },
  };
  if (req.method === 'POST') {
    init.body = await req.text();
    init.headers = { ...init.headers, 'content-type': 'application/json' };
  }
  try {
    const upstream = await fetch(target, init);
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store',
      },
    });
  } catch (e) {
    return Response.json({ error: 'upstream unreachable', detail: String(e) }, { status: 502 });
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  return forward(req, path.join('/'), ALLOW_GET);
}

export async function POST(req: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  return forward(req, path.join('/'), ALLOW_POST);
}
