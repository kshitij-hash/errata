// packages/mcp/src/tools/ask.ts — memory_ask: ask the memory a question over POST /api/ask.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ErrataClient } from '../client.js';
import { AskInput } from '../schemas.js';
import { shapeAsk } from '../shape.js';
import type { AskApiResponse } from '../types.js';

export function registerAsk(server: McpServer, client: ErrataClient): void {
  server.registerTool(
    'memory_ask',
    {
      title: 'Ask memory',
      description:
        'Ask the memory a question. Returns the current belief with its citation (session_id + turn_index), ' +
        'confidence, and any superseded prior values — or, if the history never established an answer, a ' +
        'calibrated abstention with nearest-miss citations. Abstention is a normal, structured result, not an error.',
      inputSchema: AskInput,
    },
    async ({ question, history_id, question_date }) => {
      const res = await client.post<AskApiResponse>('/api/ask', { question, history_id, question_date });
      if (!res.ok) {
        return { isError: true, content: [{ type: 'text' as const, text: `errata /api/ask returned HTTP ${res.status}: ${JSON.stringify(res.body)}` }] };
      }
      const shaped = shapeAsk(res.body);
      return { content: [{ type: 'text' as const, text: JSON.stringify(shaped, null, 2) }], structuredContent: shaped as unknown as Record<string, unknown> };
    },
  );
}
