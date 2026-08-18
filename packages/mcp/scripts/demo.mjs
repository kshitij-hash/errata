#!/usr/bin/env node
// packages/mcp/scripts/demo.mjs — drives errata-mcp as a real MCP client over stdio, against a
// running apps/api + HydraDB stack, and prints every tool call/result as JSON. This is exactly how
// docs/mcp-demo.md was captured: `node packages/mcp/scripts/demo.mjs > transcript.json`.
//
// Requires: `pnpm typecheck` already run (so packages/mcp/dist/index.js exists), the stack up
// (`pnpm stack:up`) and apps/api running and serving the target history (`ERRATA_DEMO_HISTORY`).
//
// Writes ONE new claim to the given history (a memory_correct call) — append-only, so safe to
// re-run, and by design never touches any history other than the one passed in.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = join(HERE, '..', 'dist', 'index.js');
const HISTORY = process.env.ERRATA_DEMO_HISTORY ?? '852ce960-clean';
const API_URL = process.env.ERRATA_API_URL ?? 'http://127.0.0.1:8787';

const transport = new StdioClientTransport({
  command: 'node',
  args: [SERVER_ENTRY],
  env: { ...process.env, ERRATA_API_URL: API_URL },
});

const client = new Client({ name: 'errata-mcp-demo', version: '0.1.0' });
await client.connect(transport);

const steps = [];
async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.type === 'text' ? res.content[0].text : JSON.stringify(res);
  steps.push({ tool: name, args, isError: res.isError ?? false, result: JSON.parse(text) });
}

const tools = await client.listTools();
steps.push({ listTools: tools.tools.map((t) => ({ name: t.name, description: t.description })) });

const QUESTION = 'What was the amount I was pre-approved for when I got my mortgage from Wells Fargo?';

// 1. ask -> cited answer
await call('memory_ask', { question: QUESTION, history_id: HISTORY });
// an abstention, with nearest-miss citations
await call('memory_ask', { question: 'What is my favorite color?', history_id: HISTORY });
// the honest gap: memory_remember on a (subject, attribute) this history has never held a claim about
await call('memory_remember', { subject: 'the user', attribute: 'favorite_color', value: 'blue', history_id: HISTORY });
// 2/3. the correction
await call('memory_correct', { subject: 'the user', attribute: 'mortgage_preapproval_amount', value: '$425,000', history_id: HISTORY });
// 4. the SUPERSEDES chain, struck values included
await call('memory_history', { subject: 'the user', attribute: 'mortgage_preapproval_amount', history_id: HISTORY });
// 5. re-ask
await call('memory_ask', { question: QUESTION, history_id: HISTORY });

await client.close();
console.log(JSON.stringify(steps, null, 2));
