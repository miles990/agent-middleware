/**
 * Plan Engine — Pure DAG executor. No special cases.
 *
 * Everything is a DAG node: data collection, synthesis, validation, retry.
 * Brain decides what each node does. Engine only handles execution + scheduling.
 *
 * Features:
 * - Streaming DAG: dispatch when dependency satisfied
 * - Step-level retry with backoff
 * - Plan mutation: add/skip/replace steps during execution
 * - Convergence loop: repeat waves until condition met
 * - Structured output parsing
 * - Per-worker concurrency limits
 * - Dynamic branching via condition field
 * - Fail policies: cancel-dependents / cancel-all / continue
 */

// =============================================================================
// Types
// =============================================================================

export interface PlanStep {
  id: string;
  worker: string;
  task: string;
  /** Human-readable label for dashboard */
  label?: string;
  dependsOn: string[];
  backend?: 'sdk' | 'acp' | 'shell' | 'middleware';
  timeoutSeconds?: number;
  maxConcurrency?: number;
  /** Dynamic branching */
  condition?: {
    stepId: string;
    check: 'completed' | 'failed' | 'contains' | 'not_contains';
    value?: string;
  };
  /** Step-level retry policy */
  retry?: {
    maxRetries: number;
    backoffMs?: number;       // base backoff (default 1000), doubles each retry
    onExhausted: 'skip' | 'fail';  // what to do when retries exhausted
  };
}

export interface ActionPlan {
  goal: string;
  acceptance?: string;
  steps: PlanStep[];
  /** Convergence: re-evaluate after each complete wave. If returns new steps, add them. */
  convergence?: {
    /** Max iterations to prevent infinite loops */
    maxIterations: number;
    /** Check function ID — a step that returns { converged: boolean, nextSteps?: PlanStep[] } */
    checkStepId?: string;
  };
}

export interface StructuredOutput {
  summary: string;
  artifacts?: Array<{ type: string; path?: string; content?: string }>;
  findings?: string[];
  confidence?: number;
  raw?: string;
  // Synthesis fields
  accepted?: boolean;
  gaps?: string[];
  recommendations?: string[];
  deliverable?: string;
  // Convergence
  converged?: boolean;
  nextSteps?: PlanStep[];
}

export interface StepResult {
  id: string;
  worker: string;
  status: 'completed' | 'failed' | 'timeout' | 'skipped' | 'condition_skipped';
  output: string;
  structured?: StructuredOutput;
  durationMs: number;
  dispatchOrder: number;
  retryCount?: number;
}

export interface DigestInput {
  goal: string;
  acceptance?: string;
  completedSteps: Array<{
    id: string; worker: string; summary: string;
    confidence?: number; artifactRefs: string[]; findings: string[];
  }>;
  failedSteps: Array<{ id: string; worker: string; error: string }>;
  criticalFindings: string[];
  replanCandidates: Array<{ id: string; reason: string; confidence?: number }>;
}

export type StepRisk = 'safe' | 'moderate' | 'dangerous';

export interface ConfirmationResult {
  approved: boolean;
  modifiedSteps?: PlanStep[];
  reason?: string;
}

export interface PlanResult {
  goal: string;
  acceptance?: string;
  steps: StepResult[];
  totalDurationMs: number;
  summary: { completed: number; failed: number; skipped: number; conditionSkipped: number };
  lowConfidenceSteps: Array<{ id: string; confidence: number; reason?: string }>;
  digestContext: string;
  digestInput: DigestInput;
  accepted: boolean | null;
  /** How many convergence iterations ran */
  convergenceIterations: number;
}

export type WorkerExecutor = (worker: string, task: string | import('./llm-provider.js').ContentBlock[], timeoutMs: number) => Promise<string>;

// =============================================================================
// Helpers
// =============================================================================

const LOW_CONFIDENCE_THRESHOLD = 0.6;

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

function classifyStepRisk(step: PlanStep): StepRisk {
  const dangerous = new Set(['coder', 'shell']);
  const moderate = new Set(['analyst', 'researcher']);
  if (dangerous.has(step.worker)) return 'dangerous';
  if (moderate.has(step.worker)) return 'moderate';
  return 'safe';
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// =============================================================================
// Plan Engine — Pure DAG Executor
// =============================================================================

export interface PlanEngineOptions {
  onStepComplete?: (step: StepResult) => void;
  onStepDispatch?: (step: PlanStep) => void;
  onStepRetry?: (step: PlanStep, attempt: number, error: string) => void;
  onPlanMutation?: (type: 'add' | 'skip' | 'replace', stepId: string) => void;
  failurePolicy?: 'none' | 'cancel-dependents' | 'cancel-all';
  confirmationGate?: (plan: ActionPlan, risks: Array<{ step: PlanStep; risk: StepRisk }>) => Promise<ConfirmationResult>;
}

export class PlanEngine {
  private executor: WorkerExecutor;
  private opts: PlanEngineOptions;

  constructor(executor: WorkerExecutor, opts?: PlanEngineOptions) {
    this.executor = executor;
    this.opts = opts ?? {};
  }

  // ─── Validation ───

  validate(plan: ActionPlan, availableWorkers: Set<string>): string[] {
    const errors: string[] = [];
    const ids = new Set(plan.steps.map(s => s.id));
    for (const step of plan.steps) {
      if (!availableWorkers.has(step.worker)) errors.push(`Step ${step.id}: unknown worker '${step.worker}'`);
      for (const dep of step.dependsOn) {
        if (!ids.has(dep)) errors.push(`Step ${step.id}: depends on unknown '${dep}'`);
        if (dep === step.id) errors.push(`Step ${step.id}: self-dependency`);
      }
      if (step.condition && !ids.has(step.condition.stepId))
        errors.push(`Step ${step.id}: condition references unknown '${step.condition.stepId}'`);
    }
    // Cycle detection
    const visited = new Set<string>(), visiting = new Set<string>();
    const stepMap = new Map(plan.steps.map(s => [s.id, s]));
    const hasCycle = (id: string): boolean => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      for (const dep of stepMap.get(id)?.dependsOn ?? []) if (hasCycle(dep)) return true;
      visiting.delete(id); visited.add(id); return false;
    };
    for (const step of plan.steps) {
      if (hasCycle(step.id)) { errors.push(`Cycle detected involving '${step.id}'`); break; }
    }
    return errors;
  }

  // ─── Plan Mutation ───

  /** Add a step to a live plan (for convergence loops or dynamic replanning) */
  addStep(plan: ActionPlan, step: PlanStep): void {
    plan.steps.push(step);
    this.opts.onPlanMutation?.('add', step.id);
  }

  /** Skip a step (mark it so executor won't run it) */
  skipStep(plan: ActionPlan, stepId: string, results: Map<string, StepResult>): void {
    if (!results.has(stepId)) {
      results.set(stepId, { id: stepId, worker: '', status: 'skipped', output: 'Skipped by mutation', durationMs: 0, dispatchOrder: -1 });
      this.opts.onPlanMutation?.('skip', stepId);
    }
  }

  /** Replace a step's task/worker (must not have started yet) */
  replaceStep(plan: ActionPlan, stepId: string, updates: Partial<PlanStep>): boolean {
    const idx = plan.steps.findIndex(s => s.id === stepId);
    if (idx === -1) return false;
    plan.steps[idx] = { ...plan.steps[idx], ...updates, id: stepId };
    this.opts.onPlanMutation?.('replace', stepId);
    return true;
  }

  // ─── Surgical Replan ───

  async replanSteps(plan: ActionPlan, stepIds: string[], previousResults: Map<string, StepResult>): Promise<PlanResult> {
    const stepsToRerun = plan.steps.filter(s => stepIds.includes(s.id));
    const subPlan: ActionPlan = {
      goal: plan.goal, acceptance: plan.acceptance,
      steps: stepsToRerun.map(s => ({ ...s, dependsOn: s.dependsOn.filter(d => stepIds.includes(d)) })),
    };
    const result = await this.execute(subPlan);
    const merged = new Map(previousResults);
    for (const step of result.steps) merged.set(step.id, step);
    return buildResult(plan, merged, Date.now());
  }

  // ─── Execute ───

  async execute(plan: ActionPlan): Promise<PlanResult> {
    // Confirmation gate
    if (this.opts.confirmationGate) {
      const risks = plan.steps.map(step => ({ step, risk: classifyStepRisk(step) }));
      const confirmation = await this.opts.confirmationGate(plan, risks);
      if (!confirmation.approved) {
        return buildResult(
          plan,
          new Map(plan.steps.map(s => [s.id, { id: s.id, worker: s.worker, status: 'skipped' as const, output: `Blocked: ${confirmation.reason ?? 'not approved'}`, durationMs: 0, dispatchOrder: 0 }])),
          Date.now(),
        );
      }
      if (confirmation.modifiedSteps) plan = { ...plan, steps: confirmation.modifiedSteps };
    }

    const start = Date.now();
    const results = new Map<string, StepResult>();
    const running = new Set<string>();
    const retryCounts = new Map<string, number>();
    let dispatchOrder = 0;
    let aborted = false;
    let convergenceIterations = 0;
    const workerRunning = new Map<string, number>();

    return new Promise<PlanResult>((resolve) => {
      const tryDispatch = () => {
        if (aborted) return;

        for (const step of plan.steps) {
          if (results.has(step.id) || running.has(step.id)) continue;

          // Check dependencies
          const depsOk = step.dependsOn.every(d => {
            const r = results.get(d);
            return r && (r.status === 'completed' || r.status === 'condition_skipped');
          });

          if (!depsOk) {
            // Dep failed → skip (unless retry pending)
            const depFailed = step.dependsOn.some(d => {
              const r = results.get(d);
              return r && r.status !== 'completed' && r.status !== 'condition_skipped';
            });
            if (depFailed) {
              results.set(step.id, { id: step.id, worker: step.worker, status: 'skipped', output: 'Dependency failed', durationMs: 0, dispatchOrder: dispatchOrder++ });
              this.opts.onStepComplete?.(results.get(step.id)!);
              setTimeout(tryDispatch, 0);
            }
            continue;
          }

          // Check condition
          if (step.condition) {
            if (!results.has(step.condition.stepId)) continue;
            if (!evaluateCondition(step.condition, results)) {
              results.set(step.id, { id: step.id, worker: step.worker, status: 'condition_skipped', output: `Condition not met: ${step.condition.stepId}.${step.condition.check}`, durationMs: 0, dispatchOrder: dispatchOrder++ });
              this.opts.onStepComplete?.(results.get(step.id)!);
              setTimeout(tryDispatch, 0);
              continue;
            }
          }

          // Check concurrency
          const maxConc = step.maxConcurrency ?? 4;
          const currentConc = workerRunning.get(step.worker) ?? 0;
          if (currentConc >= maxConc) continue;

          // DISPATCH
          running.add(step.id);
          workerRunning.set(step.worker, currentConc + 1);
          this.opts.onStepDispatch?.(step);

          const resolvedTask = resolveStepContext(step.task, results);
          const timeoutMs = (step.timeoutSeconds ?? 120) * 1000;
          const order = dispatchOrder++;

          this.executeWithRetry(step, resolvedTask, timeoutMs, order, retryCounts)
            .then(res => {
              running.delete(step.id);
              workerRunning.set(step.worker, (workerRunning.get(step.worker) ?? 1) - 1);
              results.set(res.id, res);
              this.opts.onStepComplete?.(res);

              // Cancel-all policy
              if ((res.status === 'failed' || res.status === 'timeout') && this.opts.failurePolicy === 'cancel-all') {
                aborted = true;
                for (const s of plan.steps) {
                  if (!results.has(s.id) && !running.has(s.id))
                    results.set(s.id, { id: s.id, worker: s.worker, status: 'skipped', output: 'Aborted: cancel-all', durationMs: 0, dispatchOrder: dispatchOrder++ });
                }
                if (running.size === 0) resolve(buildResult(plan, results, start, convergenceIterations));
                return;
              }

              // Check convergence
              if (plan.convergence && results.size === plan.steps.length && running.size === 0) {
                convergenceIterations++;
                if (convergenceIterations < plan.convergence.maxIterations) {
                  // Check if converged via designated check step
                  const checkResult = plan.convergence.checkStepId ? results.get(plan.convergence.checkStepId) : undefined;
                  const structured = checkResult?.structured;
                  if (structured?.converged === false && structured.nextSteps?.length) {
                    // Add new steps and continue
                    for (const ns of structured.nextSteps) {
                      const newId = `${ns.id}-iter${convergenceIterations}`;
                      plan.steps.push({ ...ns, id: newId });
                      this.opts.onPlanMutation?.('add', newId);
                    }
                    setTimeout(tryDispatch, 0);
                    return;
                  }
                }
              }

              // All done?
              if (results.size === plan.steps.length && running.size === 0) {
                resolve(buildResult(plan, results, start, convergenceIterations));
              } else {
                tryDispatch();
              }
            });
        }

        // Deadlock guard
        if (running.size === 0 && results.size < plan.steps.length) {
          for (const s of plan.steps) {
            if (!results.has(s.id))
              results.set(s.id, { id: s.id, worker: s.worker, status: 'skipped', output: 'Deadlock', durationMs: 0, dispatchOrder: dispatchOrder++ });
          }
          resolve(buildResult(plan, results, start, convergenceIterations));
        }
      };

      tryDispatch();
    });
  }

  // ─── Execute with Retry ───

  private async executeWithRetry(step: PlanStep, task: string, timeoutMs: number, order: number, retryCounts: Map<string, number>): Promise<StepResult> {
    const maxRetries = step.retry?.maxRetries ?? 0;
    const baseBackoff = step.retry?.backoffMs ?? 1000;
    let lastError = '';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        retryCounts.set(step.id, attempt);
        this.opts.onStepRetry?.(step, attempt, lastError);
        await sleep(baseBackoff * Math.pow(2, attempt - 1));
      }

      const stepStart = Date.now();
      try {
        const output = await this.executor(step.worker, task, timeoutMs);
        const structured = parseStructuredOutput(output);
        return { id: step.id, worker: step.worker, status: 'completed', output, structured, durationMs: Date.now() - stepStart, dispatchOrder: order, retryCount: attempt };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt === maxRetries) {
          const status = lastError.includes('timeout') ? 'timeout' as const : 'failed' as const;
          if (step.retry?.onExhausted === 'skip') {
            return { id: step.id, worker: step.worker, status: 'skipped', output: `Retries exhausted (${maxRetries}): ${lastError}`, durationMs: Date.now() - stepStart, dispatchOrder: order, retryCount: attempt };
          }
          return { id: step.id, worker: step.worker, status, output: lastError, durationMs: Date.now() - stepStart, dispatchOrder: order, retryCount: attempt };
        }
      }
    }

    // Should never reach here
    return { id: step.id, worker: step.worker, status: 'failed', output: lastError, durationMs: 0, dispatchOrder: order };
  }
}

// =============================================================================
// Build Result
// =============================================================================

function buildResult(plan: ActionPlan, results: Map<string, StepResult>, start: number, convergenceIterations: number = 0): PlanResult {
  const steps = plan.steps.map(s => results.get(s.id)).filter((s): s is StepResult => s != null);

  const completedSteps = steps.filter(s => s.status === 'completed');
  const failedSteps = steps.filter(s => s.status === 'failed' || s.status === 'timeout');

  const criticalFindings: string[] = [];
  for (const s of completedSteps) {
    if (s.structured?.findings) criticalFindings.push(...s.structured.findings);
  }

  const replanCandidates = steps
    .filter(s => s.status === 'failed' || s.status === 'timeout' || (s.status === 'completed' && s.structured?.confidence !== undefined && s.structured.confidence < LOW_CONFIDENCE_THRESHOLD))
    .map(s => ({ id: s.id, reason: s.status !== 'completed' ? s.status : `low confidence (${s.structured!.confidence})`, confidence: s.structured?.confidence }));

  const digestInput: DigestInput = {
    goal: plan.goal, acceptance: plan.acceptance,
    completedSteps: completedSteps.map(s => ({
      id: s.id, worker: s.worker,
      summary: s.structured?.summary ?? s.output?.slice(0, 500) ?? '',
      confidence: s.structured?.confidence,
      artifactRefs: s.structured?.artifacts?.map(a => a.path ?? a.type) ?? [],
      findings: s.structured?.findings ?? [],
    })),
    failedSteps: failedSteps.map(s => ({ id: s.id, worker: s.worker, error: s.output })),
    criticalFindings: [...new Set(criticalFindings)],
    replanCandidates,
  };

  // Build text digest
  const digestParts: string[] = [`# Plan Result: ${plan.goal}\n`];
  if (plan.acceptance) digestParts.push(`Acceptance: ${plan.acceptance}\n`);
  for (const s of steps) {
    const summary = s.structured?.summary ?? s.output?.slice(0, 500);
    const icon = s.status === 'completed' ? '✅' : s.status === 'condition_skipped' ? '⏭' : '❌';
    const retryNote = s.retryCount ? ` (${s.retryCount} retries)` : '';
    digestParts.push(`## ${icon} ${s.id} [${s.worker}] (${(s.durationMs / 1000).toFixed(1)}s${retryNote})`);
    digestParts.push(summary); digestParts.push('');
  }
  if (replanCandidates.length > 0)
    digestParts.push(`\n⚠ Replan candidates: ${replanCandidates.map(s => `${s.id}(${s.reason})`).join(', ')}`);

  // Acceptance via structured output
  let accepted: boolean | null = null;
  const lastStep = steps[steps.length - 1];
  if (lastStep?.structured && 'accepted' in (lastStep.structured as unknown as Record<string, unknown>)) {
    accepted = Boolean((lastStep.structured as unknown as Record<string, unknown>).accepted);
  } else if (plan.acceptance) {
    accepted = failedSteps.length === 0 && replanCandidates.length === 0;
  }

  return {
    goal: plan.goal, acceptance: plan.acceptance, steps,
    totalDurationMs: Date.now() - start,
    summary: {
      completed: steps.filter(s => s.status === 'completed').length,
      failed: steps.filter(s => s.status === 'failed' || s.status === 'timeout').length,
      skipped: steps.filter(s => s.status === 'skipped').length,
      conditionSkipped: steps.filter(s => s.status === 'condition_skipped').length,
    },
    lowConfidenceSteps: replanCandidates.filter(r => r.confidence !== undefined) as Array<{ id: string; confidence: number; reason?: string }>,
    digestContext: digestParts.join('\n'), digestInput, accepted,
    convergenceIterations,
  };
}

// =============================================================================
// Parse Plan
// =============================================================================

export function parsePlan(response: string): ActionPlan | null {
  const match = response.match(/```json\s*([\s\S]*?)```/) ?? response.match(/(\{[\s\S]*"steps"[\s\S]*\})/);
  if (!match) return null;
  try {
    const plan = JSON.parse(match[1]) as ActionPlan;
    if (!plan.goal || !Array.isArray(plan.steps)) return null;
    for (const s of plan.steps) s.dependsOn ??= [];
    return plan;
  } catch { return null; }
}
