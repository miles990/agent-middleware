/**
 * Agent Middleware — standalone HTTP server.
 *
 * Run: pnpm dev (development) or pnpm start (production)
 * Port: env PORT or 3100
 */

import { serve } from '@hono/node-server';
import { createRouter } from './api.js';

const port = parseInt(process.env.PORT ?? '3100');
const app = createRouter({ cwd: process.env.CWD ?? process.cwd() });

console.log(`[middleware] Starting on port ${port}...`);
console.log(`[middleware] Workers: researcher, coder, reviewer, shell, analyst, explorer`);
console.log(`[middleware] Endpoints: /dispatch, /plan, /status/:id, /plan/:id, /pool, /events, /tasks`);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[middleware] Ready at http://localhost:${info.port}`);
});
