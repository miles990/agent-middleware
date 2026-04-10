/**
 * Action Plan Engine — DAG-based parallel execution of worker tasks.
 *
 * Features:
 * - Streaming DAG: steps dispatch immediately when dependencies satisfy (not wave-batched)
 * - Step context injection: {{stepId.result}} templates resolved before dispatch
 * - Per-worker concurrency limits
 * - Structured output: { summary, artifacts, findings, confidence }
 * - Dynamic branching: conditional steps via `condition` field
 * - Fail-fast: failed step → downstream skipped
 * - Low confidence detection → flagged for brain replanning
 */

// =============================================================================
// Types
// =============================================================================

export interface PlanStep {
  id: string;
  worker: string;
  /** Task — can reference previous results via {{stepId.result}}, {{stepId.summary}}, {{stepId.findings}} */
  task: string;
  dependsOn: string[];
  backend?: 'sdk' | 'acp' | 'shell' | 'middleware';
  timeoutSeconds?: number;
  /** Dynamic branching: only run if condition met */
  condition?: {
    stepId: string;
    check: 'completed' | 'failed' | 'contains' | 'not_contains';
    value?: string;
  };
  maxConcurrency?: number;
}

export interface ActionPlan {
  goal: string;
  steps: PlanStep[];
  afterExecution?: 'digest' | 'continue';
}

export interface StructuredOutput {
  summary: string;
  artifacts?: Array<{ type: string; path?: string; content?: string }>;
  findings?: string[];
  confidence?: number;
  raw?: string;
}

export interface StepResult {
  id: string;
  worker: string;
  status: 'completed' | 'failed' | 'timeout' | 'skipped' | 'condition_skipped';
  output: string;
  structured?: StructuredOutput;
  durationMs: number;
  /** Which wave this step dispatched in (for observability) */
  dispatchOrder: number;
}

export interface PlanResult {
  goal: string;
  steps: StepResult[];
  totalDurationMs: number;
  summary: { completed: number; failed: number; skipped: number; conditionSkipped: number };
  /** Steps with low confidence (< threshold) — brain should consider replanning */
  lowConfidenceSteps: Array<{ id: string; confidence: number }>;
  /** Pre-built digest for brain */
  digestContext: string;
}

export type WorkerExecutor = (worker: string, task: string | import('./llm-provider.js').ContentBlock[], timeoutMs: number) => Promise<string>;

// =============================================================================
// Helpers
// =============================================================================

function resolveStepContext(task: string, results: Map<string, StepResult>): string {
  return task.replace(/\{\{(\w[\w-]*)\.(\w+)\}\}/g, (match, stepId, field) => {
    const result = results.get(stepId);
    if (!result) return match;
    switch (field) {
      case 'result': case 'output': return result.output?.slice(0, 4000) ?? '';
      case 'summary': return result.structured?.summary ?? result.output?.slice(0, 500) ?? '';
      case 'status': return result.status;
      case 'findings': return result.structured?.findings?.join('\n') ?? '';
      case 'confidence': return String(result.structured?.confidence ?? '');
      default: return match;
    }
  });
}

function parseStructuredOutput(output: string): StructuredOutput | undefined {
  try {
    const jsonMatch = output.match(/```json\s*([\s\S]*?)```/) ?? output.match(/(\{[\s\S]*"summary"[\s\S]*\})/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1]);
      if (parsed.summary) return parsed as StructuredOutput;
    }
  } catch { /* not structured */ }
  return undefined;
}

function evaluateCondition(condition: PlanStep['condition'], results: Map<string, StepResult>): boolean {
  if (!condition) return true;
  const dep = results.get(condition.stepId);
  if (!dep) return false;
  switch (condition.check) {
    case 'completed': return dep.status === 'completed';
    case 'failed': return dep.status === 'failed' || dep.status === 'timeout';
    case 'contains': return condition.value ? dep.output.includes(condition.value) : false;
    case 'not_contains': return condition.value ? !dep.output.includes(condition.value) : true;
    default: return true;
  }
}

// =============================================================================
// Plan Engine — Streaming DAG
// =============================================================================

const LOW_CONFIDENCE_THRESHOLD = 0.6;

export interface PlanEngineOptions {
  onStepComplete?: (step: StepResult) => void;
  onStepDispatch?: (step: PlanStep) => void;
  /**
   * Sibling cancellation policy:
   * - 'none': siblings continue running (default — maximizes completed results)
   * - 'cancel-dependents': only skip downstream steps (current fail-fast)
   * - 'cancel-all': abort all running steps on any failure (fast exit)
   */
  failurePolicy?: 'none' | 'cancel-dependents' | 'cancel-all';
}

export class PlanEngine {
  private executor: WorkerExecutor;
  private onStepComplete?: (step: StepResult) => void;
  private onStepDispatch?: (step: PlanStep) => void;
  private failurePolicy: 'none' | 'cancel-dependents' | 'cancel-all';

  constructor(executor: WorkerExecutor, opts?: PlanEngineOptions) {
    this.executor = executor;
    this.onStepComplete = opts?.onStepComplete;
    this.onStepDispatch = opts?.onStepDispatch;
    this.failurePolicy = opts?.failurePolicy ?? 'cancel-dependents';
  }

  validate(plan: ActionPlan, availableWorkers: Set<string>): string[] {
    const errors: string[] = [];
    const ids = new Set(plan.steps.map(s => s.id));

    for (const step of plan.steps) {
      if (!availableWorkers.has(step.worker)) {
        errors.push(`Step ${step.id}: unknown worker '${step.worker}'`);
      }
      for (const dep of step.dependsOn) {
        if (!ids.has(dep)) errors.push(`Step ${step.id}: depends on unknown step '${dep}'`);
        if (dep === step.id) errors.push(`Step ${step.id}: self-dependency`);
      }
      if (step.condition && !ids.has(step.condition.stepId)) {
        errors.push(`Step ${step.id}: condition references unknown step '${step.condition.stepId}'`);
      }
    }

    // Cycle detection
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const stepMap = new Map(plan.steps.map(s => [s.id, s]));
    const hasCycle = (id: string): boolean => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      for (const dep of stepMap.get(id)?.dependsOn ?? []) {
        if (hasCycle(dep)) return true;
      }
      visiting.delete(id);
      visited.add(id);
      return false;
    };
    for (const step of plan.steps) {
      if (hasCycle(step.id)) { errors.push(`Cycle detected involving step '${step.id}'`); break; }
    }

    return errors;
  }

  /**
   * Streaming DAG execution — steps dispatch immediately when dependencies satisfy.
   * No wave batching: if step C depends only on A, it starts as soon as A completes
   * (even if B from the same "wave" is still running).
   */
  async execute(plan: ActionPlan): Promise<PlanResult> {
    const start = Date.now();
    const results = new Map<string, StepResult>();
    const running = new Set<string>();
    let dispatchOrder = 0;
    let aborted = false; // cancel-all flag

    // Track per-worker concurrency
    const workerRunning = new Map<string, number>();

    return new Promise<PlanResult>((resolve) => {
      const tryDispatch = () => {
        if (aborted) return; // cancel-all: stop dispatching

        // Find steps ready to dispatch
        for (const step of plan.steps) {
          if (results.has(step.id) || running.has(step.id)) continue;

          // Check dependencies satisfied
          const depsOk = step.dependsOn.every(d => {
            const r = results.get(d);
            return r && (r.status === 'completed' || r.status === 'condition_skipped');
          });
          if (!depsOk) {
            // Check if any dep failed → skip this step
            const depFailed = step.dependsOn.some(d => {
              const r = results.get(d);
              return r && r.status !== 'completed' && r.status !== 'condition_skipped';
            });
            if (depFailed && !running.has(step.id)) {
              const res: StepResult = {
                id: step.id, worker: step.worker, status: 'skipped',
                output: 'Dependency failed', durationMs: 0, dispatchOrder: dispatchOrder++,
              };
              results.set(step.id, res);
              this.onStepComplete?.(res);
              // Cascade: this skip may unblock other steps
              setTimeout(tryDispatch, 0);
            }
            continue;
          }

          // Check condition
          if (step.condition) {
            const condDep = results.get(step.condition.stepId);
            if (!condDep) continue; // condition dep not resolved yet
            if (!evaluateCondition(step.condition, results)) {
              const res: StepResult = {
                id: step.id, worker: step.worker, status: 'condition_skipped',
                output: `Condition not met: ${step.condition.stepId}.${step.condition.check}`,
                durationMs: 0, dispatchOrder: dispatchOrder++,
              };
              results.set(step.id, res);
              this.onStepComplete?.(res);
              setTimeout(tryDispatch, 0);
              continue;
            }
          }

          // Check worker concurrency limit
          const maxConc = step.maxConcurrency ?? 4;
          const currentConc = workerRunning.get(step.worker) ?? 0;
          if (currentConc >= maxConc) continue; // wait for a slot

          // DISPATCH
          running.add(step.id);
          workerRunning.set(step.worker, currentConc + 1);
          this.onStepDispatch?.(step);

          const resolvedTask = resolveStepContext(step.task, results);
          const timeoutMs = (step.timeoutSeconds ?? 120) * 1000;
          const stepStart = Date.now();
          const order = dispatchOrder++;

          this.executor(step.worker, resolvedTask, timeoutMs)
            .then(output => {
              const structured = parseStructuredOutput(output);
              return { id: step.id, worker: step.worker, status: 'completed' as const, output, structured, durationMs: Date.now() - stepStart, dispatchOrder: order };
            })
            .catch(err => {
              const msg = err instanceof Error ? err.message : String(err);
              return { id: step.id, worker: step.worker, status: (msg.includes('timeout') ? 'timeout' : 'failed') as 'timeout' | 'failed', output: msg, durationMs: Date.now() - stepStart, dispatchOrder: order };
            })
            .then(res => {
              running.delete(step.id);
              workerRunning.set(step.worker, (workerRunning.get(step.worker) ?? 1) - 1);
              results.set(res.id, res);
              this.onStepComplete?.(res);

              // Cancel-all policy: abort on any failure
              if (res.status !== 'completed' && res.status !== 'condition_skipped' && this.failurePolicy === 'cancel-all') {
                aborted = true;
                // Mark all pending steps as skipped
                for (const s of plan.steps) {
                  if (!results.has(s.id) && !running.has(s.id)) {
                    results.set(s.id, { id: s.id, worker: s.worker, status: 'skipped', output: 'Aborted: cancel-all policy', durationMs: 0, dispatchOrder: dispatchOrder++ });
                  }
                }
                // Wait for running steps to finish naturally, then resolve
                if (running.size === 0) resolve(buildResult(plan, results, start));
                return;
              }

              // Check if all done
              if (results.size === plan.steps.length && running.size === 0) {
                resolve(buildResult(plan, results, start));
              } else {
                tryDispatch();
              }
            });
        }

        // If nothing is running and not all complete → deadlock
        if (running.size === 0 && results.size < plan.steps.length) {
          // Mark remaining as skipped
          for (const step of plan.steps) {
            if (!results.has(step.id)) {
              results.set(step.id, {
                id: step.id, worker: step.worker, status: 'skipped',
                output: 'Deadlock — unresolvable dependencies', durationMs: 0, dispatchOrder: dispatchOrder++,
              });
            }
          }
          resolve(buildResult(plan, results, start));
        }
      };

      tryDispatch();
    });
  }
}

function buildResult(plan: ActionPlan, results: Map<string, StepResult>, start: number): PlanResult {
  const steps = plan.steps.map(s => results.get(s.id)!);

  // Build digest
  const digestParts: string[] = [`# Plan Result: ${plan.goal}\n`];
  for (const s of steps) {
    const summary = s.structured?.summary ?? s.output?.slice(0, 500);
    const icon = s.status === 'completed' ? '✅' : s.status === 'condition_skipped' ? '⏭' : '❌';
    digestParts.push(`## ${icon} ${s.id} [${s.worker}] (${(s.durationMs / 1000).toFixed(1)}s)`);
    digestParts.push(summary);
    if (s.structured?.findings?.length) digestParts.push(`Findings: ${s.structured.findings.join('; ')}`);
    if (s.structured?.confidence !== undefined) digestParts.push(`Confidence: ${s.structured.confidence}`);
    digestParts.push('');
  }

  // Flag low confidence
  const lowConfidenceSteps = steps
    .filter(s => s.status === 'completed' && s.structured?.confidence !== undefined && s.structured.confidence < LOW_CONFIDENCE_THRESHOLD)
    .map(s => ({ id: s.id, confidence: s.structured!.confidence! }));

  if (lowConfidenceSteps.length > 0) {
    digestParts.push(`\n⚠ Low confidence steps (< ${LOW_CONFIDENCE_THRESHOLD}): ${lowConfidenceSteps.map(s => `${s.id}(${s.confidence})`).join(', ')}`);
    digestParts.push('Consider replanning these steps with more specific instructions.');
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
    lowConfidenceSteps,
    digestContext: digestParts.join('\n'),
  };
}

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
