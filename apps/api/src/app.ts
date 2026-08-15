// apps/api/src/app.ts — the read-only HTTP surface (contract v1.1, spec 30 §2 / 31 §1.4).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { ANSWER_MODEL, ANSWER_PROMPT, SCHEMA_VERSION } from '@errata/core';
import { countLabel } from '@errata/graph';
import type { NodeLabel } from '@errata/graph';
import { config, db, lexicon } from './deps.js';
import { askQuery, beliefQuery, diffQuery } from './query.js';

export const app = new Hono();

const ANSWER_PROMPT_SHA256 = createHash('sha256').update(ANSWER_PROMPT).digest('hex');

function parseAt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

app.get('/health', (c) => c.json({ status: 'ok' }));

app.get('/api/belief', async (c) => {
  const subject = c.req.query('subject');
  const attribute = c.req.query('attribute');
  const historyId = c.req.query('history_id') ?? config.demoHistory;
  if (!subject || !attribute) return c.json({ error: 'subject and attribute are required' }, 400);
  if (!historyId) return c.json({ error: 'history_id is required (no demo default configured)' }, 400);
  const at = parseAt(c.req.query('at'));
  const axis = c.req.query('axis') === 'ingest' ? 'ingest' : 'event';
  const explain = c.req.query('explain') === '1';
  const out = await beliefQuery(db(), { subject, attribute, historyId, at, axis, explain });
  return c.json(out);
});

app.get('/api/diff', async (c) => {
  const subject = c.req.query('subject');
  const attribute = c.req.query('attribute');
  const historyId = c.req.query('history_id') ?? config.demoHistory;
  const from = parseAt(c.req.query('from'));
  const to = parseAt(c.req.query('to'));
  if (!subject || !attribute || from == null || to == null) return c.json({ error: 'subject, attribute, from, to are required' }, 400);
  if (!historyId) return c.json({ error: 'history_id is required' }, 400);
  const explain = c.req.query('explain') === '1';
  const out = await diffQuery(db(), { subject, attribute, historyId, from, to, explain });
  return c.json(out);
});

app.post('/api/ask', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { question?: string; history_id?: string; explain?: boolean };
  const historyId = body.history_id ?? config.demoHistory;
  if (!body.question) return c.json({ error: 'question is required' }, 400);
  if (!historyId) return c.json({ error: 'history_id is required' }, 400);
  const out = await askQuery(db(), historyId, body.question, lexicon(historyId), body.explain === true || c.req.query('explain') === '1');
  return c.json(out);
});

app.get('/api/meta', (c) => {
  let ingested: string[] = [];
  if (existsSync(config.lexiconDir)) ingested = readdirSync(config.lexiconDir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  return c.json({
    answer_model: ANSWER_MODEL,
    answer_prompt_sha256: ANSWER_PROMPT_SHA256,
    ingested_history_ids: ingested,
    schema_version: SCHEMA_VERSION,
    tau: config.tau,
  });
});

app.get('/api/meta/health', async (c) => {
  const historyId = c.req.query('history_id') ?? config.demoHistory;
  const node_counts: Record<string, number> = {};
  let readyz = false;
  try {
    if (historyId) {
      for (const label of ['Claim', 'Turn', 'Session', 'Entity', 'Speaker'] as NodeLabel[]) {
        const rows = await db().read(countLabel(label, historyId));
        node_counts[label] = Number(rows[0]?.n ?? 0);
      }
    }
    readyz = true;
  } catch (e) {
    return c.json({ readyz: false, error: String(e) }, 503);
  }
  return c.json({ readyz, bookmark: db().bookmark.length > 0, node_counts, id_collisions: 0, full_scan_warnings: 0 });
});

app.get('/api/meta/costs', (c) => {
  // minimal inline rollup of the JSONL ledger; @errata/llm.rollup replaces this once credits are live.
  const dir = 'var/ledger';
  let spent = 0;
  let calls = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
      for (const line of readFileSync(`${dir}/${f}`, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line) as { cost_usd?: number; status?: string; prompt_tokens?: number; completion_tokens?: number };
          if (j.status === 'ok') {
            spent += j.cost_usd ?? 0;
            tokensIn += j.prompt_tokens ?? 0;
            tokensOut += j.completion_tokens ?? 0;
            calls++;
          }
        } catch {
          /* skip malformed */
        }
      }
    }
  }
  const cap = process.env.ERRATA_BUDGET_CAP ? Number(process.env.ERRATA_BUDGET_CAP) : 50;
  const budget_state = spent >= cap ? 'EXHAUSTED' : spent >= 0.9 * cap ? 'THROTTLED' : spent >= 0.7 * cap ? 'WARN' : 'normal';
  return c.json({ cap_usd: cap, spent_usd: +spent.toFixed(6), budget_state, calls, tokens_in: tokensIn, tokens_out: tokensOut });
});
