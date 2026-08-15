// apps/api/src/index.ts — the API server. Binds 127.0.0.1 on the pod behind its HTTPS proxy;
// Bolt is localhost (spec 31 §1.4). Ingest runs as a CLI; every route here is read-only.
import { serve } from '@hono/node-server';
import { app } from './app.js';

const port = process.env.PORT ? Number(process.env.PORT) : 8787;
const hostname = process.env.HOST ?? '127.0.0.1';

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`errata-api listening on http://${info.address}:${info.port}`);
});
