/**
 * Agent Middleware — standalone HTTP server.
 *
 * Run: pnpm dev (development) or pnpm start (production)
 * Port: env PORT or 3200
 *
 * Lifecycle (OpenClaw pattern):
 *   - SIGTERM/SIGINT → graceful shutdown → exit(0)
 *   - SIGUSR1        → proactive drain → exit(0) → PM2 relaunches fresh heap
 *   - RSS > threshold OR uptime > threshold → self-SIGUSR1
 * PM2's max_memory_restart is the outer safety net (kill -9); SIGUSR1 lets us
 * exit cleanly before PM2 has to SIGKILL.
 */

import { serve } from '@hono/node-server';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRouter } from './api.js';

const port = parseInt(process.env.PORT ?? '3200');
const app = createRouter({ cwd: process.env.CWD ?? process.cwd() });

console.log(`[middleware] Starting on port ${port}...`);
console.log(`[middleware] Workers: researcher, coder, reviewer, shell, analyst, explorer`);
console.log(`[middleware] Endpoints: /dispatch, /plan, /status/:id, /plan/:id, /pool, /events, /tasks`);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[middleware] Ready at http://localhost:${info.port}`);
});

// ── Graceful Shutdown ──────────────────────────────────────────────────────

let shuttingDown = false;
const SHUTDOWN_FORCE_MS = 10_000;

function shutdown(code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  const mem = process.memoryUsage();
  console.log(`[middleware] shutdown heap=${Math.round(mem.heapUsed / 1048576)}MB rss=${Math.round(mem.rss / 1048576)}MB`);
  try { server.close(); } catch { /* already closed */ }
  setTimeout(() => {
    console.log('[middleware] force exit after', SHUTDOWN_FORCE_MS, 'ms');
    process.exit(code);
  }, SHUTDOWN_FORCE_MS).unref();
  // If server closes cleanly, exit sooner
  server.on?.('close', () => process.exit(code));
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

// ── SIGUSR1: Proactive Drain (OpenClaw pattern) ────────────────────────────
// Long-running HTTP handlers (dispatch → worker subprocess) may take 1-5 min.
// We stop accepting new connections (server.close implicit via Node http),
// wait DRAIN_WAIT_MS for in-flight requests, then exit. PM2 KeepAlive relaunches.

const DRAIN_WAIT_MS = 120_000;
let draining = false;

function drainAndExit(reason: string): void {
  if (draining || shuttingDown) return;
  draining = true;
  console.log(`[middleware] drain start (reason=${reason}), waiting up to ${DRAIN_WAIT_MS}ms for inflight`);
  logRecycleEvent({ type: 'drain-start', reason });
  // Node's http.Server.close() stops accepting new connections and waits for
  // existing ones to finish. Invoke, then force exit after DRAIN_WAIT_MS.
  try { server.close(() => {
    console.log('[middleware] drain complete, server closed');
    logRecycleEvent({ type: 'drain-complete', reason });
    process.exit(0);
  }); } catch (e) {
    console.warn('[middleware] server.close error', e);
  }
  setTimeout(() => {
    console.log(`[middleware] drain timeout after ${DRAIN_WAIT_MS}ms — forcing exit`);
    logRecycleEvent({ type: 'drain-timeout', reason });
    process.exit(0);
  }, DRAIN_WAIT_MS).unref();
}

process.on('SIGUSR1', () => drainAndExit('SIGUSR1'));

// ── RSS Self-Recycle ────────────────────────────────────────────────────────
// PM2 already has max_memory_restart=1G (ecosystem.config.cjs) which SIGKILLs
// on RSS breach. Here we SIGUSR1 ourselves at a lower threshold so we exit
// cleanly via drain before PM2 has to kill -9.

const RECYCLE_RSS_MB = parseInt(process.env.MIDDLEWARE_RECYCLE_RSS_MB ?? '768');
const RECYCLE_UPTIME_HOURS = parseFloat(process.env.MIDDLEWARE_RECYCLE_UPTIME_HOURS ?? '24');
const RECYCLE_MIN_UPTIME_MS = 10 * 60_000;
let recycleTriggered = false;

function maybeRecycle(): void {
  if (recycleTriggered || shuttingDown || draining) return;
  if (process.env.MIDDLEWARE_RECYCLE_DISABLED === 'true') return;
  const uptimeMs = process.uptime() * 1000;
  if (uptimeMs < RECYCLE_MIN_UPTIME_MS) return;
  const rssMB = Math.round(process.memoryUsage().rss / 1048576);
  const uptimeHours = uptimeMs / 3_600_000;
  const rssHit = rssMB > RECYCLE_RSS_MB;
  const uptimeHit = uptimeHours > RECYCLE_UPTIME_HOURS;
  if (!rssHit && !uptimeHit) return;
  recycleTriggered = true;
  const reason = rssHit ? `rss=${rssMB}MB>${RECYCLE_RSS_MB}MB` : `uptime=${uptimeHours.toFixed(1)}h>${RECYCLE_UPTIME_HOURS}h`;
  console.log(`[middleware] RECYCLE self-SIGUSR1 (${reason}) — PM2 will relaunch`);
  logRecycleEvent({ type: 'recycle-trigger', reason, rssMB, uptimeHours: Math.round(uptimeHours * 10) / 10 });
  try { process.kill(process.pid, 'SIGUSR1'); } catch (e) {
    console.warn('[middleware] self-SIGUSR1 failed', e);
    recycleTriggered = false;
  }
}

setInterval(maybeRecycle, 30_000).unref();

// ── Recycle Event Log ───────────────────────────────────────────────────────
// Append-only JSONL for post-hoc tuning of thresholds.

function logRecycleEvent(event: Record<string, unknown>): void {
  try {
    const dir = path.join(os.homedir(), '.agent-middleware', 'state');
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...event }) + '\n';
    fs.appendFileSync(path.join(dir, 'recycle-events.jsonl'), line);
  } catch { /* never block on log failure */ }
}
