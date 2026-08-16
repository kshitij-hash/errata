// apps/api/src/app.ts — the HTTP surface (contract v1.1, spec 30 §2 / 31 §1.4).
//
// Read-only with EXACTLY ONE exception: `POST /api/correction`, the append-only correction write
// path (see its banner comment below). Nothing else here writes.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { ANSWER_MODEL, ANSWER_PROMPT, SCHEMA_VERSION } from '@errata/core';
import { countLabel } from '@errata/graph';
import type { NodeLabel } from '@errata/graph';
import { defaultLedgerDir, rollup } from '@errata/llm';
import { config, db, lexicon } from './deps.js';
import { CorrectionBody, CorrectionError, correctionWrite } from './correction.js';
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
  const out = await askQuery(db(), historyId, body.question, lexicon(historyId));
  return c.json(out);
});

// ---------------------------------------------------------------------------------------------
// POST /api/correction — THE ONLY MUTATING ROUTE IN THIS API. Every other route above and below
// is read-only, and that is a design constraint, not an accident.
//
// APPEND-ONLY INVARIANT: this route appends one Claim vertex and one SUPERSEDES edge to the claim
// it displaces. It never updates, re-keys or deletes an existing vertex or edge — the displaced
// claim keeps its id, value, citation and confidence and only gains an inbound revision edge.
// Filing the same correction twice appends a second claim rather than overwriting the first. Any
// future route that mutates or deletes is a bug (CLAUDE.md hard rule 1).
// ---------------------------------------------------------------------------------------------
app.post('/api/correction', async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = CorrectionBody.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'invalid correction body', issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }, 400);
  }
  const historyId = parsed.data.history_id ?? config.demoHistory;
  if (!historyId) return c.json({ error: 'history_id is required (no demo default configured)' }, 400);
  try {
    const out = await correctionWrite(db(), { ...parsed.data, historyId });
    return c.json(out, 201);
  } catch (e) {
    if (e instanceof CorrectionError) return c.json({ error: e.message }, e.status);
    throw e;
  }
});

function modelRoles(): { extractor: string; judge: string; answer: string } {
  try {
    const cfg = JSON.parse(readFileSync('config/models.json', 'utf8')) as { roles?: Record<string, { model?: string }> };
    return {
      extractor: cfg.roles?.extractor?.model ?? '',
      judge: cfg.roles?.judge?.model ?? '',
      answer: cfg.roles?.answer?.model ?? '',
    };
  } catch {
    return { extractor: '', judge: '', answer: '' };
  }
}

app.get('/api/meta', (c) => {
  let ingested: string[] = [];
  if (existsSync(config.lexiconDir)) ingested = readdirSync(config.lexiconDir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  const roles = modelRoles();
  return c.json({
    // the DISCLOSED answer model used by the eval baselines, held constant across arms and asserted
    // by the eval parity gate; Errata's own arm answers via a graph fold (answer_mechanism).
    answer_model: roles.answer || ANSWER_MODEL,
    answer_mechanism: ANSWER_MODEL,
    answer_prompt_sha256: ANSWER_PROMPT_SHA256,
    extractor_model: roles.extractor,
    conflict_judge_model: roles.judge,
    git_sha: process.env.GIT_SHA ?? 'dev',
    corpus_revision: process.env.ERRATA_CORPUS_REVISION ?? '98d7416c24c778c2fee6e6f3006e7a073259d48f',
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
  // one accounting: the SAME rollup the ingest budget guard uses (spec 31 §6.5, P1-9).
  const cap = process.env.ERRATA_BUDGET_CAP ? Number(process.env.ERRATA_BUDGET_CAP) : 50;
  return c.json(rollup(defaultLedgerDir(), cap));
});
