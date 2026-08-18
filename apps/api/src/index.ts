// apps/api/src/index.ts — the API server. HOST decides the bind, and the two modes differ:
//   - unset (local dev, the compose stack, vitest): 127.0.0.1, reachable only from this machine.
//   - HOST=0.0.0.0 (baked into deploy/pod/Dockerfile): every interface in the container, because
//     RunPod's HTTPS proxy reaches the API from outside the container's own loopback.
// Either way 8787 is the only port anything outside can reach: Bolt (7687) and the HydraDB admin
// port stay on the container's localhost and are never in the pod's port list.
// Ingest runs as a CLI. Every route here is read-only except POST /api/correction, which appends
// and, on the pod, requires ERRATA_WRITE_KEY (apps/api/src/auth.ts).
import { serve } from '@hono/node-server';
import { app } from './app.js';

const port = process.env.PORT ? Number(process.env.PORT) : 8787;
const hostname = process.env.HOST ?? '127.0.0.1';

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`errata-api listening on http://${info.address}:${info.port}`);
});
