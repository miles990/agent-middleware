/**
 * Action Plan Engine — DAG-based parallel execution of worker tasks.
 *
 * Brain produces plan → engine validates → dispatches in dependency waves → results flow back.
 *
 * Features:
 * - Wave-based parallel execution (independent steps run concurrently)
 * - Step context injection: {{stepId.result}} templates resolved before dispatch
 * - Per-worker concurrency limits (readers=many, writers=few)
 * - Structured output: { summary, artifacts, findings, confidence }
 * - Dynamic branching: conditional steps via `condition` field
 * - Fail-fast: failed step → downstream skipped
 */

// =============================================================================
// Types
// =============================================================================

export interface PlanStep {
  id: string;
  worker: string;
  /** Task description — can reference previous step results via {{stepId.result}} or {{stepId.summary}} */
  task: string;
  dependsOn: string[];
  backend?: 'sdk' | 'acp' | 'shell' | 'middleware';
  timeoutSeconds?: number;
  /** Dynamic branching: only run this step if condition is met */
  condition?: {
    /** Step ID to check */
    stepId: string;
    /** Check type: 'completed' (ran ok), 'contains' (output contains text), 'not_contains' */
    check: 'completed' | 'failed' | 'contains' | 'not_contains';
    /** For contains/not_contains: text to search in step output */
    value?: string;
  };
  /** Max concurrency for this step's worker type (overrides worker default) */
  maxConcurrency?: number;
}

export interface ActionPlan {
  goal: string;
  steps: PlanStep[];
  /** Brain mode after execution: 'digest' (synthesize results) or 'continue' (plan next wave) */
  afterExecution?: 'digest' | 'continue';
}

/** Structured step output — workers should return this format when possible */
export interface StructuredOutput {
  /** Brief summary for brain consumption */
  summary: string;
  /** Artifacts produced (files, diffs, data) */
  artifacts?: Array<{ type: string; path?: string; content?: string }>;
  /** Key findings (signals for brain) */
  findings?: string[];
  /** Worker's confidence in output (0-1) */
  confidence?: number;
  /** Raw output text */
  raw?: string;
}

export interface StepResult {
  id: string;
  worker: string;
  status: 'completed' | 'failed' | 'timeout' | 'skipped' | 'condition_skipped';
  output: string;
  /** Parsed structured output (if worker returned JSON) */
  structured?: StructuredOutput;
  durationMs: number;
  wave: number;
}

export interface PlanResult {
  goal: string;
  steps: StepResult[];
  totalDurationMs: number;
  summary: { completed: number; failed: number; skipped: number; conditionSkipped: number };
  /** Aggregated context for brain digest mode */
  digestContext: string;
}

export type WorkerExecutor = (worker: string, task: string | import('./llm-provider.js').ContentBlock[], timeoutMs: number) => Promise<string>;

// =============================================================================
// Step Context Resolution
// =============================================================================

/**
 * Resolve {{stepId.result}}, {{stepId.summary}}, {{stepId.output}} templates in task text.
 * Injects previous step results so downstream steps have context.
 */
function resolveStepContext(task: string, results: Map<string, StepResult>): string {
  return task.replace(/\{\{(\w[\w-]*)\.(\w+)\}\}/g, (match, stepId, field) => {
    const result = results.get(stepId);
    if (!result) return match; // leave unresolved if step not found

    switch (field) {
      case 'result':
      case 'output':
        return result.output?.slice(0, 4000) ?? '';
      case 'summary':
        return result.structured?.summary ?? result.output?.slice(0, 500) ?? '';
      case 'status':
        return result.status;
      case 'findings':
        return result.structured?.findings?.join('\n') ?? '';
      case 'confidence':
        return String(result.structured?.confidence ?? '');
      default:
        return match;
    }
  });
}

/**
 * Try to parse structured output from worker response.
 * Workers can return JSON with { summary, artifacts, findings, confidence }.
 */
function parseStructuredOutput(output: string): StructuredOutput | undefined {
  // Try JSON parse
  try {
    const jsonMatch = output.match(/```json\s*([\s\S]*?)```/) ?? output.match(/(\{[\s\S]*"summary"[\s\S]*\})/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1]);
      if (parsed.summary) return parsed as StructuredOutput;
    }
  } catch { /* not structured JSON */ }

  // Not structured — return undefined, use raw output
  return undefined;
}

/**
 * Check if a conditional step should run based on dependency results.
 */
function evaluateCondition(condition: PlanStep['condition'], results: Map<string, StepResult>): boolean {
  if (!condition) return true;

  const depResult = results.get(condition.stepId);
  if (!depResult) return false;

  switch (condition.check) {
    case 'completed':
      return depResult.status === 'completed';
    case 'failed':
      return depResult.status === 'failed' || depResult.status === 'timeout';
    case 'contains':
      return condition.value ? depResult.output.includes(condition.value) : false;
    case 'not_contains':
      return condition.value ? !depResult.output.includes(condition.value) : true;
    default:
      return true;
  }
}

// =============================================================================
// Plan Engine
// =============================================================================

export class PlanEngine {
  private executor: WorkerExecutor;
  private onStepComplete?: (step: StepResult, wave: number) => void;
  private onWaveStart?: (wave: number, steps: PlanStep[]) => void;

  constructor(
    executor: WorkerExecutor,
    opts?: {
      onStepComplete?: (step: StepResult, wave: number) => void;
      onWaveStart?: (wave: number, steps: PlanStep[]) => void;
    },
  ) {
    this.executor = executor;
    this.onStepComplete = opts?.onStepComplete;
    this.onWaveStart = opts?.onWaveStart;
  }

  /** Validate plan: no cycles, valid workers, valid dependencies, valid conditions */
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
      // Validate condition references
      if (step.condition && !ids.has(step.condition.stepId)) {
        errors.push(`Step ${step.id}: condition references unknown step '${step.condition.stepId}'`);
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

  /** Execute plan in dependency waves with context injection */
  async execute(plan: ActionPlan): Promise<PlanResult> {
    const start = Date.now();
    const results = new Map<string, StepResult>();
    let wave = 0;

    while (results.size < plan.steps.length) {
      // Ready: all deps completed successfully + condition met
      const ready = plan.steps.filter(s => {
        if (results.has(s.id)) return false;
        if (!s.dependsOn.every(d => results.get(d)?.status === 'completed')) return false;
        // Check dynamic condition
        if (s.condition) {
          const condDep = results.get(s.condition.stepId);
          if (!condDep) return false; // condition dependency not yet resolved
          if (!evaluateCondition(s.condition, results)) {
            // Condition not met — mark as condition_skipped
            const res: StepResult = {
              id: s.id, worker: s.worker, status: 'condition_skipped',
              output: `Condition not met: ${s.condition.stepId}.${s.condition.check}`, durationMs: 0, wave,
            };
            results.set(s.id, res);
            this.onStepComplete?.(res, wave);
            return false;
          }
        }
        return true;
      });

      // Skipped: any dep failed/timeout/skipped
      const skipped = plan.steps.filter(s =>
        !results.has(s.id) &&
        !ready.includes(s) &&
        s.dependsOn.some(d => {
          const r = results.get(d);
          return r && r.status !== 'completed' && r.status !== 'condition_skipped';
        }),
      );

      for (const s of skipped) {
        const res: StepResult = {
          id: s.id, worker: s.worker, status: 'skipped',
          output: 'Dependency failed', durationMs: 0, wave,
        };
        results.set(s.id, res);
        this.onStepComplete?.(res, wave);
      }

      if (ready.length === 0 && skipped.length === 0) break; // deadlock guard
      if (ready.length === 0) continue;

      this.onWaveStart?.(wave, ready);

      // Group by concurrency limits and execute
      const waveResults = await Promise.allSettled(
        ready.map(async (step): Promise<StepResult> => {
          const stepStart = Date.now();
          const timeoutMs = (step.timeoutSeconds ?? 120) * 1000;

          // Resolve {{stepId.result}} templates in task
          const resolvedTask = resolveStepContext(step.task, results);

          try {
            const output = await this.executor(step.worker, resolvedTask, timeoutMs);
            const structured = parseStructuredOutput(output);
            return {
              id: step.id, worker: step.worker, status: 'completed',
              output, structured, durationMs: Date.now() - stepStart, wave,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              id: step.id, worker: step.worker,
              status: msg.includes('timeout') ? 'timeout' : 'failed',
              output: msg, durationMs: Date.now() - stepStart, wave,
            };
          }
        }),
      );

      for (const r of waveResults) {
        const res = r.status === 'fulfilled'
          ? r.value
          : { id: '?', worker: '?', status: 'failed' as const, output: String(r.reason), durationMs: 0, wave };
        results.set(res.id, res);
        this.onStepComplete?.(res, wave);
      }

      wave++;
    }

    const steps = plan.steps.map(s => results.get(s.id)!);

    // Build digest context for brain
    const digestParts: string[] = [`# Plan Result: ${plan.goal}\n`];
    for (const s of steps) {
      const summary = s.structured?.summary ?? s.output?.slice(0, 500);
      const status = s.status === 'completed' ? '✅' : s.status === 'condition_skipped' ? '⏭' : '❌';
      digestParts.push(`## ${status} ${s.id} [${s.worker}] (${(s.durationMs / 1000).toFixed(1)}s)`);
      digestParts.push(summary);
      if (s.structured?.findings?.length) {
        digestParts.push(`Findings: ${s.structured.findings.join('; ')}`);
      }
      digestParts.push('');
    }

    return {
      goal: plan.goal,
      steps,
      totalDurationMs: Date.now() - start,
      summary: {
        completed: steps.filter(s => s.status === 'completed').length,
        failed: steps.filter(s => s.status === 'failed' || s.status === 'timeout').length,
        skipped: steps.filter(s => s.status === 'skipped').length,
        conditionSkipped: steps.filter(s => s.status === 'condition_skipped').length,
      },
      digestContext: digestParts.join('\n'),
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
    for (const s of plan.steps) {
      s.dependsOn ??= [];
    }
    return plan;
  } catch { return null; }
}
