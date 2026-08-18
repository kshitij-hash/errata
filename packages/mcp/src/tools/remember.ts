// packages/mcp/src/tools/remember.ts — memory_remember: append an observation as a claim.
//
// apps/api's ONLY mutating route is POST /api/correction (apps/api/src/app.ts banner comment); it
// appends a Claim + a SUPERSEDES edge to the belief it displaces. There is no separate ingest/turns
// write route — turn-level extraction is an offline, LLM-backed pipeline (packages/ingest), never
// exposed over HTTP (CLAUDE.md hard rule 6: no LLM call inside this server). `memory_remember`
// records a new observation about a (subject, attribute) the memory already has SOME claim about,
// auto-superseding the current head. A genuinely first-ever fact about a (subject, attribute) this
// history has never seen needs the offline ingest pipeline first; this tool reports that plainly
// (`reason: "unknown_subject_attribute"`) instead of pretending to write it.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ErrataClient } from '../client.js';
import { RememberInput } from '../schemas.js';
import { shapeCorrectionError, shapeCorrectionOk } from '../shape.js';
import type { CorrectionApiError, CorrectionApiResponse } from '../types.js';

export function registerRemember(server: McpServer, client: ErrataClient): void {
  server.registerTool(
    'memory_remember',
    {
      title: 'Remember an observation',
      description:
        'Record a new observation as a claim: (subject, attribute, value). If the memory already holds a belief ' +
        'for this (subject, attribute), the new value supersedes it (append-only: the old value is kept, struck, ' +
        'not deleted). If this (subject, attribute) has no prior claim in the history at all, the write is ' +
        'rejected with a structured reason (first-ever facts require the offline ingest pipeline) — never a ' +
        'silent failure.',
      inputSchema: RememberInput,
    },
    async ({ subject, attribute, value, history_id }) => {
      const res = await client.post<CorrectionApiResponse | CorrectionApiError>('/api/correction', { subject, attribute, value, history_id });
      const shaped = res.ok ? shapeCorrectionOk(res.body as CorrectionApiResponse) : shapeCorrectionError(res.status, res.body as CorrectionApiError);
      return { content: [{ type: 'text' as const, text: JSON.stringify(shaped, null, 2) }], structuredContent: shaped as unknown as Record<string, unknown> };
    },
  );
}
