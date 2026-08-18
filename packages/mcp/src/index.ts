#!/usr/bin/env node
// packages/mcp/src/index.ts — errata-mcp: an MCP stdio server over apps/api's HTTP surface.
//
// This process makes NO LLM calls of its own (CLAUDE.md hard rule 6) and never touches Bolt or
// HydraDB directly — every tool is a thin, typed wrapper around apps/api's read/write routes
// (same boundary discipline as the eval harness). All synthesis, retrieval and calibration happen
// server-side; this package only shapes the JSON into MCP tool results.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { apiBaseUrl, ErrataClient } from './client.js';
import { registerAsk } from './tools/ask.js';
import { registerCorrect } from './tools/correct.js';
import { registerHistory } from './tools/history.js';
import { registerRemember } from './tools/remember.js';

async function main(): Promise<void> {
  const client = new ErrataClient(apiBaseUrl());
  const server = new McpServer({ name: 'errata-mcp', version: '0.1.0' });

  registerAsk(server, client);
  registerRemember(server, client);
  registerCorrect(server, client);
  registerHistory(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  console.error('errata-mcp failed to start:', err);
  process.exit(1);
});
