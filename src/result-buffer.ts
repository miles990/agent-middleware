/**
 * Result Buffer — task tracking + event subscription + JSONL persistence.
 * Any caller can submit tasks, poll results, subscribe to SSE events.
 * Results persisted to results.jsonl — survives restarts.
 */

import fs from 'node:fs';
import path from 'node:path';

// =============================================================================
// Types
// =============================================================================

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled';

export interface TaskRecord {
  id: string;
  planId?: string;
  worker: string;
  /** Human-readable label (from PlanStep.label) */
  label?: string;
  /** Task input — pass-through, any format */
  task: unknown;
  status: TaskStatus;
  /** Task output — pass-through, any format */
  result?: unknown;
  metadata?: Record<string, unknown>;
  error?: string;
  submittedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
  /** Who submitted this task */
  caller?: string;
}

export type TaskEvent = {
  type: 'task.submitted' | 'task.started' | 'task.completed' | 'task.failed' | 'task.cancelled';
  task: TaskRecord;
  timestamp: Date;
};

// ─── Event Severity (T11) ───
// Static classification used for SSE filter + JSONL persistence.
// Per brain-only-kuro-v2 Phase D — agent consumers (Kuro) filter by severity
// to decide preempt vs routine-pickup. Rubric-driven dynamic severity lives
// at T4 needs-attention layer (more expensive LLM call); this is the cheap
// always-on classification.

export type EventSeverity = 'critical' | 'anomaly' | 'info' | 'routine';

export function classifyEventSeverity(event: TaskEvent): EventSeverity {
  switch (event.type) {
    case 'task.failed':
      // Failed task = critical if blocking (has error or timeout status)
      return 'critical';
    case 'task.cancelled':
      // Cancellation is anomaly — not routine, but not necessarily failure
      return 'anomaly';
    case 'task.completed':
      // Completed successfully — routine signal
      return 'routine';
    case 'task.started':
    case 'task.submitted':
      return 'info';
    default:
      return 'info';
  }
}

// =============================================================================
// Result Buffer
// =============================================================================

export class ResultBuffer {
  private tasks = new Map<string, TaskRecord>();
  private listeners = new Set<(event: TaskEvent) => void>();
  private counter = 0;
  private persistPath: string | null = null;
  private eventsPath: string | null = null;

  /** Enable JSONL persistence — results + events survive restarts */
  enablePersistence(cwd: string): void {
    this.persistPath = path.join(cwd, 'results.jsonl');
    this.eventsPath = path.join(cwd, 'events.jsonl');
    // Load existing results
    try {
      const lines = fs.readFileSync(this.persistPath, 'utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const record = JSON.parse(line) as TaskRecord;
          if (record.id) {
            // Restore dates
            if (record.submittedAt) record.submittedAt = new Date(record.submittedAt);
            if (record.startedAt) record.startedAt = new Date(record.startedAt);
            if (record.completedAt) record.completedAt = new Date(record.completedAt);
            this.tasks.set(record.id, record);
          }
        } catch { /* skip malformed lines */ }
      }
    } catch { /* no file yet — normal on first run */ }
  }

  private persist(record: TaskRecord): void {
    if (!this.persistPath) return;
    try { fs.appendFileSync(this.persistPath, JSON.stringify(record) + '\n'); } catch { /* fail-open */ }
  }

  /** Atomic rewrite: write to tmp file, rename over original */
  private persistAtomic(records: TaskRecord[]): void {
    if (!this.persistPath) return;
    const tmp = this.persistPath + '.tmp';
    try {
      fs.writeFileSync(tmp, records.map(r => JSON.stringify(r)).join('\n') + '\n');
      fs.renameSync(tmp, this.persistPath);
    } catch { /* fail-open */ }
  }

  /** Generate unique task ID */
  nextId(): string {
    return `task-${Date.now()}-${(this.counter++).toString(36)}`;
  }

  /** Submit a new task (task is pass-through — any format) */
  submit(opts: { id?: string; planId?: string; worker: string; task: unknown; label?: string; caller?: string; metadata?: Record<string, unknown> }): string {
    const id = opts.id ?? this.nextId();
    const record: TaskRecord = {
      id,
      planId: opts.planId,
      worker: opts.worker,
      label: opts.label,
      task: opts.task,
      status: 'pending',
      submittedAt: new Date(),
      caller: opts.caller,
      metadata: opts.metadata,
    };
    this.tasks.set(id, record);
    this.emit({ type: 'task.submitted', task: record, timestamp: new Date() });
    return id;
  }

  /** Mark task as running */
  start(id: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.status = 'running';
    task.startedAt = new Date();
    this.emit({ type: 'task.started', task, timestamp: new Date() });
  }

  /** Mark task as completed (result is pass-through — any format) */
  complete(id: string, result: unknown): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.status = 'completed';
    task.result = result;
    task.completedAt = new Date();
    task.durationMs = task.startedAt ? Date.now() - task.startedAt.getTime() : 0;
    this.persist(task);
    this.emit({ type: 'task.completed', task, timestamp: new Date() });
  }

  /** Mark task as failed */
  fail(id: string, error: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.status = 'failed';
    task.error = error;
    task.completedAt = new Date();
    task.durationMs = task.startedAt ? Date.now() - task.startedAt.getTime() : 0;
    this.persist(task);
    this.emit({ type: 'task.failed', task, timestamp: new Date() });
  }

  /** Cancel a task */
  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.status === 'completed' || task.status === 'failed') return false;
    task.status = 'cancelled';
    task.completedAt = new Date();
    this.emit({ type: 'task.cancelled', task, timestamp: new Date() });
    return true;
  }

  /** Get single task */
  get(id: string): TaskRecord | undefined {
    return this.tasks.get(id);
  }

  /** List tasks with optional filter */
  list(filter?: { planId?: string; status?: TaskStatus; caller?: string; limit?: number; includeArchived?: boolean }): TaskRecord[] {
    let records = [...this.tasks.values()];
    if (filter?.includeArchived) records.push(...this.archived.values());
    if (filter?.planId) records = records.filter(r => r.planId === filter.planId);
    if (filter?.status) records = records.filter(r => r.status === filter.status);
    if (filter?.caller) records = records.filter(r => r.caller === filter.caller);
    records.sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime());
    if (filter?.limit) records = records.slice(0, filter.limit);
    return records;
  }

  /** Subscribe to task events (for SSE) */
  subscribe(listener: (event: TaskEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Move completed tasks to archived after archiveAfterMs (default 1 hour) */
  private archived = new Map<string, TaskRecord>();

  /** Get archived (achieved) tasks */
  getArchived(limit: number = 50): TaskRecord[] {
    return [...this.archived.values()]
      .sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0))
      .slice(0, limit);
  }

  /**
   * Cancel orphaned tasks: pending tasks whose planId is not in the active plan set.
   * These are remnants from plans lost on restart or evicted from memory.
   * Returns count of cancelled tasks.
   */
  cancelOrphans(activePlanIds: Set<string>): number {
    let count = 0;
    for (const [id, task] of this.tasks) {
      if (task.status === 'pending' && task.planId && !activePlanIds.has(task.planId)) {
        task.status = 'cancelled';
        task.error = 'Parent plan no longer active (orphaned)';
        task.completedAt = new Date();
        this.persist(task);
        this.emit({ type: 'task.cancelled', task, timestamp: new Date() });
        count++;
      }
    }
    return count;
  }

  /**
   * Timeout tasks stuck in `running` longer than maxRunningMs. Worker process
   * likely died without updating status (seen: analyst task stuck 6 days, 04-12).
   * Returns count of tasks timed out.
   */
  timeoutStuckRunning(maxRunningMs: number = 3_600_000): number {
    const now = Date.now();
    let count = 0;
    for (const [id, task] of this.tasks) {
      if (task.status !== 'running' || !task.startedAt) continue;
      const runningMs = now - task.startedAt.getTime();
      if (runningMs > maxRunningMs) {
        task.status = 'timeout';
        task.error = `stuck in running ${Math.round(runningMs / 1000)}s > ${Math.round(maxRunningMs / 1000)}s (worker likely died)`;
        task.completedAt = new Date();
        task.durationMs = runningMs;
        this.persist(task);
        this.emit({ type: 'task.failed', task, timestamp: new Date() });
        count++;
      }
    }
    return count;
  }

  /**
   * Archive completed tasks older than archiveAfterMs.
   * Remove archived tasks older than expireAfterMs.
   * Called periodically.
   */
  cleanup(opts?: { archiveAfterMs?: number; expireAfterMs?: number }): { archived: number; expired: number } {
    const archiveAfter = opts?.archiveAfterMs ?? 3_600_000;  // 1 hour → move to achieved
    const expireAfter = opts?.expireAfterMs ?? 7 * 24 * 3_600_000; // 7 days → remove
    const now = Date.now();
    let archivedCount = 0;
    let expiredCount = 0;

    // Archive: completed tasks older than archiveAfter → move from tasks to archived
    for (const [id, task] of this.tasks) {
      if ((task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled')
        && task.completedAt && (now - task.completedAt.getTime()) > archiveAfter) {
        this.archived.set(id, task);
        this.tasks.delete(id);
        archivedCount++;
      }
    }

    // Expire: archived tasks older than expireAfter → remove completely
    for (const [id, task] of this.archived) {
      if (task.completedAt && (now - task.completedAt.getTime()) > expireAfter) {
        this.archived.delete(id);
        expiredCount++;
      }
    }

    // Compact JSONL: atomic rewrite with only active + archived tasks (remove expired)
    if (archivedCount > 0 || expiredCount > 0) {
      this.persistAtomic([...this.tasks.values(), ...this.archived.values()]);
    }

    return { archived: archivedCount, expired: expiredCount };
  }

  /** Emit a task event to all subscribers + persist to events.jsonl */
  emit(event: TaskEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* fire-and-forget */ }
    }
    this.persistEvent(event);
  }

  /** Persist event to events.jsonl (fire-and-forget) */
  private persistEvent(event: TaskEvent): void {
    if (!this.eventsPath) return;
    try {
      const record = {
        type: event.type,
        severity: classifyEventSeverity(event),
        taskId: event.task.id,
        planId: event.task.planId,
        worker: event.task.worker,
        status: event.task.status,
        label: event.task.label,
        caller: event.task.caller,
        durationMs: event.task.durationMs,
        error: event.task.error,
        timestamp: event.timestamp.toISOString(),
      };
      fs.appendFileSync(this.eventsPath, JSON.stringify(record) + '\n');
    } catch { /* fail-open */ }
  }

  /** Query historical events from events.jsonl */
  queryEvents(opts?: { since?: string; type?: string; limit?: number }): Array<Record<string, unknown>> {
    if (!this.eventsPath) return [];
    try {
      const raw = fs.readFileSync(this.eventsPath, 'utf-8');
      let events = raw.split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean) as Array<Record<string, unknown>>;
      if (opts?.since) events = events.filter(e => (e.timestamp as string) >= opts.since!);
      if (opts?.type) events = events.filter(e => (e.type as string) === opts.type);
      events.sort((a, b) => ((b.timestamp as string) || '').localeCompare((a.timestamp as string) || ''));
      if (opts?.limit) events = events.slice(0, opts.limit);
      return events;
    } catch { return []; }
  }

  /** Compact events.jsonl — keep only last N days */
  compactEvents(maxAgeDays = 7): { removed: number; kept: number } {
    if (!this.eventsPath) return { removed: 0, kept: 0 };
    try {
      const raw = fs.readFileSync(this.eventsPath, 'utf-8');
      const lines = raw.split('\n').filter(Boolean);
      const cutoff = new Date(Date.now() - maxAgeDays * 86400000).toISOString();
      const kept = lines.filter(line => {
        try { const e = JSON.parse(line); return (e.timestamp || '') >= cutoff; } catch { return false; }
      });
      fs.writeFileSync(this.eventsPath, kept.join('\n') + (kept.length ? '\n' : ''), 'utf-8');
      return { removed: lines.length - kept.length, kept: kept.length };
    } catch { return { removed: 0, kept: 0 }; }
  }

  /** Broadcast a raw event (for plan-level events like retry, convergence, mutation) */
  broadcast(event: { type: string; data: unknown }): void {
    // Plan events have different shape than TaskEvents — broadcast to listeners directly
    // with a clearly-typed wrapper so subscribers can distinguish
    const planEvent = { type: event.type as TaskEvent['type'], task: { id: 'plan-event', status: 'completed' as const, worker: 'system' } as TaskRecord, timestamp: new Date(), planData: event.data };
    for (const listener of this.listeners) {
      try { listener(planEvent); } catch { /* fire-and-forget */ }
    }
  }
}
