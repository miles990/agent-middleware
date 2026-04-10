/**
 * Result Buffer — task tracking + event subscription.
 * Any caller can submit tasks, poll results, subscribe to SSE events.
 */

// =============================================================================
// Types
// =============================================================================

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled';

export interface TaskRecord {
  id: string;
  planId?: string;
  worker: string;
  /** Task input — pass-through, any format (text, multimodal, structured) */
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

  /** Generate unique task ID */
  nextId(): string {
    return `task-${Date.now()}-${(this.counter++).toString(36)}`;
  }

  /** Submit a new task (task is pass-through — any format) */
  submit(opts: { id?: string; planId?: string; worker: string; task: unknown; caller?: string }): string {
    const id = opts.id ?? this.nextId();
    const record: TaskRecord = {
      id,
      planId: opts.planId,
      worker: opts.worker,
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

  /** Cleanup old completed tasks (keep last N) */
  cleanup(keepLast: number = 100): number {
    const completed = [...this.tasks.values()]
      .filter(t => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled')
      .sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0));

    let removed = 0;
    for (const task of completed.slice(keepLast)) {
      this.tasks.delete(task.id);
      removed++;
    }
    return removed;
  }

  private emit(event: TaskEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* fire-and-forget */ }
    }
  }
}
