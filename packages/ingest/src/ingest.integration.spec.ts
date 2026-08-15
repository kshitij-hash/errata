// Live: ingest a synthetic belief-revision history through the FULL pipeline into HydraDB, then read
// it back and fold to the current belief. Gated on ERRATA_IT=1. Proves ingest → graph → core e2e.
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveBelief } from '@errata/core';
import type { ClaimRow, RevisionEdgeRow } from '@errata/core';
import { GraphClient, keys, vid, claimsForEntityAttribute, revisionEdgesForEntity } from '@errata/graph';
import { parseHistory } from './reader.js';
import type { RawRecord } from './reader.js';
import { RuleExtractor } from './extract.js';
import { ingestHistory } from './pipeline.js';

const RUN = process.env.ERRATA_IT === '1';
const HID = 'ingest_it';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const REC: RawRecord = {
  question_id: HID,
  question: 'What was the amount I was pre-approved for from Wells Fargo?',
  answer: '$400,000',
  question_date: '2023/12/18 (Mon) 04:17',
  answer_session_ids: ['s_aug', 's_nov'],
  haystack_session_ids: ['s_aug', 's_nov'],
  haystack_dates: ['2023/08/11 (Fri) 00:01', '2023/11/30 (Thu) 00:36'],
  haystack_sessions: [
    [{ role: 'user', content: 'I am buying a $325,000 house, and I got pre-approved for $350,000 from Wells Fargo. What closing costs should I expect?' }, { role: 'assistant', content: 'Congratulations on your pre-approval!' }],
    [{ role: 'user', content: 'I am moving into my new home soon. Remember when I got pre-approved for $400,000 from Wells Fargo?' }, { role: 'assistant', content: 'Congrats on the new home!' }],
  ],
};

describe.skipIf(!RUN)('ingest pipeline — live against HydraDB', () => {
  let client: GraphClient;
  const userEntity = vid(keys.entity(HID, 'the user'));

  beforeAll(async () => {
    const token = readFileSync('.data/hydra/auth-token', 'utf8').trim();
    client = new GraphClient({ url: 'bolt://127.0.0.1:7687', token });
    await client.verify();
    const summary = await ingestHistory(client, parseHistory(REC), {
      extractor: new RuleExtractor(),
      ingestTime: 1_700_000_000,
      runId: 'it-run',
      lexiconDir: 'var/lexicon-it',
    });
    expect(summary.counts.supersedes).toBe(1);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('reads back the belief graph and folds to the current pre-approval ($400,000)', async () => {
    let claims: Record<string, unknown>[] = [];
    for (let i = 0; i < 15; i++) {
      claims = await client.read(claimsForEntityAttribute(userEntity, HID, 'mortgage_preapproval_amount'));
      if (claims.length >= 2) break;
      await sleep(400);
    }
    expect(claims.length).toBe(2);

    const sup = await client.read(revisionEdgesForEntity(userEntity, HID, 'mortgage_preapproval_amount', 'SUPERSEDES'));
    expect(sup.length).toBe(1);

    const edges: RevisionEdgeRow[] = sup.map((r) => ({ ...(r as unknown as RevisionEdgeRow), relation: 'SUPERSEDES' }));
    const belief = resolveBelief(claims as unknown as ClaimRow[], edges);
    expect(belief.head?.value).toBe('$400,000');
    expect(belief.head?.citation.session_id).toBe('s_nov');
    expect(belief.superseded.map((s) => s.value)).toEqual(['$350,000']);
  }, 30_000);
});
