// packages/mcp/src/tools/correct.ts — memory_correct: file a correction and return the resulting
// revision chain. Same write path as memory_remember (POST /api/correction is apps/api's only
// mutating route), but explicit: it accepts `supersedes_claim_id` to target a specific prior claim
// (useful when a chain is disputed or has more than one live head), and on success it reads the
// chain back via GET /api/belief so the caller sees the SUPERSEDES edge it just appended without a
// second round trip.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ErrataClient } from '../client.js';
import { CorrectInput } from '../schemas.js';
import { shapeCorrectionError, shapeCorrectionOk, shapeHistory } from '../shape.js';
import type { BeliefApiResponse, CorrectionApiError, CorrectionApiResponse } from '../types.js';

export function registerCorrect(server: McpServer, client: ErrataClient): void {
  server.registerTool(
    'memory_correct',
    {
      title: 'Correct memory',
      description:
        'Record a correction: (subject, attribute, new value), optionally naming the exact claim_id it ' +
        'supersedes. Appends a new claim and a SUPERSEDES revision edge to the claim it displaces — the ' +
        'displaced claim keeps its id, value and citation, it is never mutated or deleted. Returns the ' +
        'resulting revision chain (current belief + everything it superseded).',
      inputSchema: CorrectInput,
    },
    async ({ subject, attribute, value, history_id, supersedes_claim_id }) => {
      const res = await client.post<CorrectionApiResponse | CorrectionApiError>('/api/correction', { subject, attribute, value, history_id, supersedes_claim_id });
      if (!res.ok) {
        const shaped = shapeCorrectionError(res.status, res.body as CorrectionApiError);
        return { content: [{ type: 'text' as const, text: JSON.stringify(shaped, null, 2) }], structuredContent: shaped as unknown as Record<string, unknown> };
      }
      const correction = shapeCorrectionOk(res.body as CorrectionApiResponse);
      const belief = await client.get<BeliefApiResponse>('/api/belief', { subject, attribute, history_id });
      const revision_chain = belief.ok ? shapeHistory(subject, attribute, belief.body, null) : null;
      const shaped = { ...correction, revision_chain };
      return { content: [{ type: 'text' as const, text: JSON.stringify(shaped, null, 2) }], structuredContent: shaped as unknown as Record<string, unknown> };
    },
  );
}
