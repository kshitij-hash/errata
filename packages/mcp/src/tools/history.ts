// packages/mcp/src/tools/history.ts — memory_history: the revision chain for one
// (subject, attribute) over GET /api/belief + GET /api/diff. Every claim that ever held, struck
// values included — nothing is ever mutated or deleted (CONVENTIONS.md: "the edge IS the history").
//
// NOT an as-of view. /api/belief takes `at` + `axis` and will fold the belief as it stood at time
// t; this tool sends neither, so it returns the whole chain as of now. `from`/`to` bound the /diff
// revision window only. See packages/mcp/README.md.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ErrataClient } from '../client.js';
import { HistoryInput } from '../schemas.js';
import { shapeHistory } from '../shape.js';
import type { BeliefApiResponse, DiffApiResponse } from '../types.js';

export function registerHistory(server: McpServer, client: ErrataClient): void {
  server.registerTool(
    'memory_history',
    {
      title: 'Memory revision history',
      description:
        'The revision chain for one (subject, attribute): every claim that ever held, with its event_time and ' +
        'citation, and what displaced it. Current values are unstruck; every superseded value is struck ' +
        'alongside the SUPERSEDES/CONTRADICTS edge and rationale that displaced it. Nothing is ever deleted, ' +
        "so a value's full history is always retrievable here even after a correction.",
      inputSchema: HistoryInput,
    },
    async ({ subject, attribute, history_id, from, to }) => {
      const belief = await client.get<BeliefApiResponse>('/api/belief', { subject, attribute, history_id });
      if (!belief.ok) {
        return { isError: true, content: [{ type: 'text' as const, text: `errata /api/belief returned HTTP ${belief.status}: ${JSON.stringify(belief.body)}` }] };
      }
      const nowSeconds = Math.floor(Date.now() / 1000);
      const diff = await client.get<DiffApiResponse>('/api/diff', { subject, attribute, history_id, from: from ?? '0', to: to ?? String(nowSeconds) });
      const shaped = shapeHistory(subject, attribute, belief.body, diff.ok ? diff.body : null);
      return { content: [{ type: 'text' as const, text: JSON.stringify(shaped, null, 2) }], structuredContent: shaped as unknown as Record<string, unknown> };
    },
  );
}
