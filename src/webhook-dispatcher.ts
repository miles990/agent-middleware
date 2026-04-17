/**
 * Webhook Dispatcher (T16/T17/T18) — outbound event hook system.
 *
 * Per brain-only-kuro-v2 Phase E. Subscribes to ResultBuffer events,
 * matches against registered hooks, POSTs CloudEvents envelope with
 * HMAC-SHA256 signature, retries with exponential backoff, persists
 * DLQ on exhaustion, batches same-type events within 1s window.
 *
 * Three responsibilities collapsed into one module because they are
 * tightly coupled — splitting would need scaffolding between layers.
 *
 *   T16: Hook registry (persistence + CRUD)
 *   T17: Outbound dispatcher (match + sign + post + retry + DLQ)
 *   T18: Batching/debounce (1s window merge)
 *
 * Not-implemented (deferred to v1.x):
 *   - Per-hook rate limiting (add when Kuro rubric-tuned)
 *   - Priority-aware DLQ replay (manual redelivery via endpoint for now)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { classifyEventSeverity, type TaskEvent, type EventSeverity } from './result-buffer.js';

// ─── Types ──────────────────────────────────────────────────────────────

export type HookEventPattern =
  | '*'
  | 'task.*'
  | 'task.submitted'
  | 'task.started'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled';

export interface Hook {
  id: string;
  url: string;
  event_pattern: HookEventPattern;
  severity_filter?: EventSeverity[];
  secret?: string; // used for HMAC-SHA256 signing
  active: boolean;
  created_at: string;
  stats: {
    delivered: number;
    failed: number;
    last_delivery?: string;
    last_error?: string;
  };
}

export interface HookInput {
  url: string;
  event_pattern: HookEventPattern;
  severity_filter?: EventSeverity[];
  secret?: string;
}

// CloudEvents 1.0 envelope — https://github.com/cloudevents/spec
export interface CloudEventEnvelope {
  specversion: '1.0';
  id: string;
  source: string; // "/middleware/{agent}"
  type: string; // e.g. "task.failed"
  time: string;
  subject?: string;
  datacontenttype: 'application/json';
  data: Record<string, unknown>;
  // Not part of CloudEvents spec but carried for convenience
  severity?: EventSeverity;
}

export interface DLQEntry {
  hook_id: string;
  envelope: CloudEventEnvelope | { batched: true; events: CloudEventEnvelope[] };
  attempts: number;
  last_error: string;
  queued_at: string;
}

// ─── Hook Registry (T16) ────────────────────────────────────────────────

export class HookRegistry {
  private hooks = new Map<string, Hook>();
  private persistPath: string | null = null;
  private counter = 0;

  enablePersistence(cwd: string): void {
    this.persistPath = path.join(cwd, 'hooks.json');
    try {
      if (fs.existsSync(this.persistPath)) {
        const raw = fs.readFileSync(this.persistPath, 'utf-8');
        const loaded = JSON.parse(raw) as Hook[];
        for (const h of loaded) this.hooks.set(h.id, h);
      }
    } catch { /* fail-open */ }
  }

  private persist(): void {
    if (!this.persistPath) return;
    try {
      fs.writeFileSync(this.persistPath, JSON.stringify([...this.hooks.values()], null, 2) + '\n', 'utf-8');
    } catch { /* fail-open */ }
  }

  private newId(): string {
    this.counter = (this.counter + 1) % 10000;
    return `hook-${Date.now()}-${this.counter.toString().padStart(4, '0')}`;
  }

  create(input: HookInput): Hook {
    const hook: Hook = {
      id: this.newId(),
      url: input.url,
      event_pattern: input.event_pattern,
      severity_filter: input.severity_filter,
      secret: input.secret,
      active: true,
      created_at: new Date().toISOString(),
      stats: { delivered: 0, failed: 0 },
    };
    this.hooks.set(hook.id, hook);
    this.persist();
    return hook;
  }

  get(id: string): Hook | undefined {
    return this.hooks.get(id);
  }

  list(): Hook[] {
    return [...this.hooks.values()];
  }

  delete(id: string): boolean {
    const ok = this.hooks.delete(id);
    if (ok) this.persist();
    return ok;
  }

  updateStats(id: string, patch: Partial<Hook['stats']>): void {
    const h = this.hooks.get(id);
    if (!h) return;
    h.stats = { ...h.stats, ...patch };
    this.persist();
  }

  /** Find hooks matching an event type + severity. */
  match(eventType: string, severity: EventSeverity): Hook[] {
    const matches: Hook[] = [];
    for (const h of this.hooks.values()) {
      if (!h.active) continue;
      if (!patternMatches(h.event_pattern, eventType)) continue;
      if (h.severity_filter && h.severity_filter.length > 0 && !h.severity_filter.includes(severity)) continue;
      matches.push(h);
    }
    return matches;
  }
}

function patternMatches(pattern: HookEventPattern, eventType: string): boolean {
  if (pattern === '*') return true;
  if (pattern === 'task.*') return eventType.startsWith('task.');
  return pattern === eventType;
}

// ─── CloudEvents Envelope Builder ──────────────────────────────────────

let envelopeCounter = 0;

function buildEnvelope(event: TaskEvent, sourceAgent: string): CloudEventEnvelope {
  envelopeCounter = (envelopeCounter + 1) % 100000;
  const severity = classifyEventSeverity(event);
  return {
    specversion: '1.0',
    id: `evt-${Date.now()}-${envelopeCounter.toString().padStart(5, '0')}`,
    source: `/middleware/${sourceAgent}`,
    type: event.type,
    time: event.timestamp.toISOString(),
    subject: event.task.id,
    datacontenttype: 'application/json',
    data: {
      taskId: event.task.id,
      planId: event.task.planId,
      worker: event.task.worker,
      status: event.task.status,
      label: event.task.label,
      caller: event.task.caller,
      durationMs: event.task.durationMs,
      error: event.task.error,
    },
    severity,
  };
}

// ─── HMAC Signing ──────────────────────────────────────────────────────

function signPayload(secret: string, body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

// ─── Retry Policy ──────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const BACKOFF_SCHEDULE_MS = [1_000, 2_000, 4_000]; // aligned to Stripe-style

async function deliverWithRetry(
  url: string,
  body: string,
  signature: string | null,
  signal: AbortSignal,
): Promise<{ ok: true } | { ok: false; error: string; attempts: number }> {
  let lastError = '';
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = BACKOFF_SCHEDULE_MS[Math.min(attempt - 1, BACKOFF_SCHEDULE_MS.length - 1)];
      await new Promise<void>(r => setTimeout(r, delay));
    }
    if (signal.aborted) return { ok: false, error: 'aborted', attempts: attempt };
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'agent-middleware-webhook/1.0',
      };
      if (signature) headers['X-Signature-256'] = signature;
      const res = await fetch(url, { method: 'POST', headers, body, signal });
      if (res.ok) return { ok: true };
      lastError = `HTTP ${res.status}`;
      if (res.status < 500 && res.status !== 429) {
        // 4xx (except 429) are not retryable — fail fast
        return { ok: false, error: lastError, attempts: attempt + 1 };
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, error: lastError, attempts: MAX_RETRIES + 1 };
}

// ─── Dead Letter Queue ─────────────────────────────────────────────────

class DLQ {
  private path: string | null = null;
  enablePersistence(cwd: string): void {
    this.path = path.join(cwd, 'webhook-dlq.jsonl');
  }
  append(entry: DLQEntry): void {
    if (!this.path) return;
    try {
      fs.appendFileSync(this.path, JSON.stringify(entry) + '\n');
    } catch { /* fail-open */ }
  }
  read(limit = 100): DLQEntry[] {
    if (!this.path || !fs.existsSync(this.path)) return [];
    try {
      return fs.readFileSync(this.path, 'utf-8')
        .split('\n').filter(Boolean)
        .slice(-limit)
        .map(l => { try { return JSON.parse(l) as DLQEntry; } catch { return null; } })
        .filter((x): x is DLQEntry => !!x);
    } catch { return []; }
  }
}

// ─── Batching (T18) ────────────────────────────────────────────────────
// Same event type within BATCH_WINDOW_MS → merge payload into one POST.
// Different types → separate POSTs.

const BATCH_WINDOW_MS = 1_000;

interface BatchBucket {
  hook: Hook;
  envelopes: CloudEventEnvelope[];
  timer: NodeJS.Timeout;
}

// ─── Dispatcher Orchestrator ───────────────────────────────────────────

export class WebhookDispatcher {
  private registry: HookRegistry;
  private dlq = new DLQ();
  private sourceAgent: string;
  private batchBuckets = new Map<string, BatchBucket>(); // key = hookId:eventType
  private abortController = new AbortController();
  private started = false;

  constructor(registry: HookRegistry, sourceAgent = 'middleware') {
    this.registry = registry;
    this.sourceAgent = sourceAgent;
  }

  enablePersistence(cwd: string): void {
    this.registry.enablePersistence(cwd);
    this.dlq.enablePersistence(cwd);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
  }

  stop(): void {
    this.started = false;
    this.abortController.abort();
    for (const b of this.batchBuckets.values()) clearTimeout(b.timer);
    this.batchBuckets.clear();
  }

  /** Entry point — wire this to buffer.subscribe. */
  onTaskEvent(event: TaskEvent): void {
    if (!this.started) return;
    const severity = classifyEventSeverity(event);
    const hooks = this.registry.match(event.type, severity);
    if (hooks.length === 0) return;
    const envelope = buildEnvelope(event, this.sourceAgent);
    for (const hook of hooks) {
      this.enqueueForHook(hook, envelope, event.type);
    }
  }

  private enqueueForHook(hook: Hook, envelope: CloudEventEnvelope, eventType: string): void {
    const key = `${hook.id}:${eventType}`;
    let bucket = this.batchBuckets.get(key);
    if (bucket) {
      bucket.envelopes.push(envelope);
      return;
    }
    bucket = {
      hook,
      envelopes: [envelope],
      timer: setTimeout(() => {
        this.flushBucket(key).catch(() => { /* swallowed — DLQ handles */ });
      }, BATCH_WINDOW_MS),
    };
    this.batchBuckets.set(key, bucket);
  }

  private async flushBucket(key: string): Promise<void> {
    const bucket = this.batchBuckets.get(key);
    if (!bucket) return;
    this.batchBuckets.delete(key);

    const isBatched = bucket.envelopes.length > 1;
    const payload = isBatched
      ? { batched: true as const, events: bucket.envelopes }
      : bucket.envelopes[0];
    const body = JSON.stringify(payload);
    const signature = bucket.hook.secret ? signPayload(bucket.hook.secret, body) : null;

    const result = await deliverWithRetry(bucket.hook.url, body, signature, this.abortController.signal);

    if (result.ok) {
      this.registry.updateStats(bucket.hook.id, {
        delivered: (this.registry.get(bucket.hook.id)?.stats.delivered ?? 0) + bucket.envelopes.length,
        last_delivery: new Date().toISOString(),
      });
    } else {
      this.registry.updateStats(bucket.hook.id, {
        failed: (this.registry.get(bucket.hook.id)?.stats.failed ?? 0) + 1,
        last_error: result.error,
      });
      this.dlq.append({
        hook_id: bucket.hook.id,
        envelope: payload,
        attempts: result.attempts,
        last_error: result.error,
        queued_at: new Date().toISOString(),
      });
    }
  }

  readDLQ(limit = 100): DLQEntry[] {
    return this.dlq.read(limit);
  }
}
