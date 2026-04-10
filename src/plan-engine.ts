/**
 * Action Plan Engine — DAG-based parallel execution of worker tasks.
 *
 * Brain produces plan → engine validates → dispatches in dependency waves → results flow back.
 *
 * Wave execution:
 *   Wave 0: steps with no dependencies (all run in parallel)
 *   Wave 1: steps depending only on Wave 0 (run when Wave 0 completes)
 *   ...
 *
 * Fail-fast: if a step fails and downstream steps depend on it, they're skipped.
 */

// =============================================================================
// Types
// =============================================================================

export interface PlanStep {
  id: string;
  worker: string;
  task: string;
  dependsOn: string[];
  backend?: 'sdk' | 'acp' | 'shell';
  timeoutSeconds?: number;
}

export interface ActionPlan {
  goal: string;
  steps: PlanStep[];
}

export interface StepResult {
  id: string;
  worker: string;
  status: 'completed' | 'failed' | 'timeout' | 'skipped';
  output: string;
  durationMs: number;
}

export interface PlanResult {
  goal: string;
  steps: StepResult[];
  totalDurationMs: number;
  summary: { completed: number; failed: number; skipped: number };
}

export type WorkerExecutor = (worker: string, task: string | import('./llm-provider.js').ContentBlock[], timeoutMs: number) => Promise<string>;

// =============================================================================
// Plan Engine
// =============================================================================

export class PlanEngine {
  private executor: WorkerExecutor;
  private onStepComplete?: (step: StepResult, wave: number) => void;

  constructor(
    executor: WorkerExecutor,
    opts?: { onStepComplete?: (step: StepResult, wave: number) => void },
  ) {
    this.executor = executor;
    this.onStepComplete = opts?.onStepComplete;
  }

  /** Validate plan: no cycles, valid workers, valid dependencies */
  validate(plan: ActionPlan, availableWorkers: Set<string>): string[] {
    const errors: string[] = [];
    const ids = new Set(plan.steps.map(s => s.id));

    for (const step of plan.steps) {
      if (!availableWorkers.has(step.worker)) {
        errors.push(`Step ${step.id}: unknown worker '${step.worker}'`);
      }
      for (const dep of step.dependsOn) {
        if (!ids.has(dep)) {
          errors.push(`Step ${step.id}: depends on unknown step '${dep}'`);
        }
        if (dep === step.id) {
          errors.push(`Step ${step.id}: self-dependency`);
        }
      }
    }

    // Cycle detection (topological sort)
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const stepMap = new Map(plan.steps.map(s => [s.id, s]));

    const hasCycle = (id: string): boolean => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      const step = stepMap.get(id);
      if (step) {
        for (const dep of step.dependsOn) {
          if (hasCycle(dep)) return true;
        }
      }
      visiting.delete(id);
      visited.add(id);
      return false;
    };

    for (const step of plan.steps) {
      if (hasCycle(step.id)) {
        errors.push(`Cycle detected involving step '${step.id}'`);
        break;
      }
    }

    return errors;
  }

  /** Execute plan in dependency waves */
  async execute(plan: ActionPlan): Promise<PlanResult> {
    const start = Date.now();
    const results = new Map<string, StepResult>();
    let wave = 0;

    while (results.size < plan.steps.length) {
      // Ready: all deps completed successfully
      const ready = plan.steps.filter(s =>
        !results.has(s.id) &&
        s.dependsOn.every(d => results.get(d)?.status === 'completed'),
      );

      // Skipped: any dep failed/timeout/skipped
      const skipped = plan.steps.filter(s =>
        !results.has(s.id) &&
        !ready.includes(s) &&
        s.dependsOn.some(d => {
          const r = results.get(d);
          return r && r.status !== 'completed';
        }),
      );

      for (const s of skipped) {
        const res: StepResult = {
          id: s.id, worker: s.worker, status: 'skipped',
          output: 'Dependency failed', durationMs: 0,
        };
        results.set(s.id, res);
        this.onStepComplete?.(res, wave);
      }

      if (ready.length === 0 && skipped.length === 0) break; // deadlock guard
      if (ready.length === 0) continue;

      // Execute wave in parallel
      const waveResults = await Promise.allSettled(
        ready.map(async (step): Promise<StepResult> => {
          const stepStart = Date.now();
          const timeoutMs = (step.timeoutSeconds ?? 120) * 1000;
          try {
            const output = await this.executor(step.worker, step.task, timeoutMs);
            return {
              id: step.id, worker: step.worker, status: 'completed',
              output, durationMs: Date.now() - stepStart,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              id: step.id, worker: step.worker,
              status: msg.includes('timeout') ? 'timeout' : 'failed',
              output: msg, durationMs: Date.now() - stepStart,
            };
          }
        }),
      );

      for (const r of waveResults) {
        const res = r.status === 'fulfilled'
          ? r.value
          : { id: '?', worker: '?', status: 'failed' as const, output: String(r.reason), durationMs: 0 };
        results.set(res.id, res);
        this.onStepComplete?.(res, wave);
      }

      wave++;
    }

    const steps = plan.steps.map(s => results.get(s.id)!);
    return {
      goal: plan.goal,
      steps,
      totalDurationMs: Date.now() - start,
      summary: {
        completed: steps.filter(s => s.status === 'completed').length,
        failed: steps.filter(s => s.status === 'failed' || s.status === 'timeout').length,
        skipped: steps.filter(s => s.status === 'skipped').length,
      },
    };
  }
}

/** Parse ActionPlan JSON from brain response */
export function parsePlan(response: string): ActionPlan | null {
  const match = response.match(/```json\s*([\s\S]*?)```/)
    ?? response.match(/(\{[\s\S]*"steps"[\s\S]*\})/);
  if (!match) return null;
  try {
    const plan = JSON.parse(match[1]) as ActionPlan;
    if (!plan.goal || !Array.isArray(plan.steps)) return null;
    for (const s of plan.steps) s.dependsOn ??= [];
    return plan;
  } catch { return null; }
}
