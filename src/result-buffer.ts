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

// =============================================================================
// Result Buffer
// =============================================================================

export class ResultBuffer {
  private tasks = new Map<string, TaskRecord>();
  private listeners = new Set<(event: TaskEvent) => void>();
  private counter = 0;
  private persistPath: string | null = null;

  /** Enable JSONL persistence — results survive restarts */
  enablePersistence(cwd: string): void {
    this.persistPath = path.join(cwd, 'results.jsonl');
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

  /** Generate unique task ID */
  nextId(): string {
    return `task-${Date.now()}-${(this.counter++).toString(36)}`;
  }

  /** Submit a new task (task is pass-through — any format) */
  submit(opts: { id?: string; planId?: string; worker: string; task: unknown; label?: string; caller?: string }): string {
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
  list(filter?: { planId?: string; status?: TaskStatus; caller?: string; limit?: number }): TaskRecord[] {
    let records = [...this.tasks.values()];
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

    // Compact JSONL: rewrite with only active + archived tasks (remove expired)
    if ((archivedCount > 0 || expiredCount > 0) && this.persistPath) {
      try {
        const allRecords = [...this.tasks.values(), ...this.archived.values()];
        fs.writeFileSync(this.persistPath, allRecords.map(r => JSON.stringify(r)).join('\n') + '\n');
      } catch { /* fail-open */ }
    }

    return { archived: archivedCount, expired: expiredCount };
  }

  /** Emit a task event to all subscribers */
  emit(event: TaskEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* fire-and-forget */ }
    }
  }

  /** Broadcast a raw event (for plan-level events like retry, convergence, mutation) */
  broadcast(event: { type: string; data: unknown }): void {
    const taskEvent = { type: event.type, task: event.data, timestamp: new Date() } as unknown as TaskEvent;
    this.emit(taskEvent);
  }
}
