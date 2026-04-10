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
  /** Task — detailed instruction for worker, can reference {{stepId.result}} */
  task: string;
  /** Human-readable label for dashboard display (< 30 chars) */
  label?: string;
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
  /** What this plan achieves (human-readable) */
  goal: string;
  /** Acceptance criteria — how to verify the goal is achieved.
   *  Brain uses this to plan the final verification step.
   *  Example: "所有 unit tests 通過，無 lint error" */
  acceptance?: string;
  steps: PlanStep[];
  /**
   * Auto-synthesis: after all steps complete, run a final step that uses
   * goal + acceptance + all results to produce the deliverable.
   * Defaults to true. Set to false for fire-and-forget plans.
   * The last DAG node's output becomes the plan's result.
   */
  synthesis?: false | {
    worker?: string;
    prompt?: string;
    label?: string;
  };
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
  acceptance?: string;
  steps: StepResult[];
  totalDurationMs: number;
  summary: { completed: number; failed: number; skipped: number; conditionSkipped: number };
  /** Steps with low confidence (< threshold) — brain should consider replanning */
  lowConfidenceSteps: Array<{ id: string; confidence: number; reason?: string }>;
  /** Compressed digest for brain (summary only, artifacts by reference) */
  digestContext: string;
  /** Structured digest input for programmatic access */
  digestInput: DigestInput;
  /** Whether the plan's acceptance criteria was met (null if no acceptance defined) */
  accepted: boolean | null;
}

/** Compressed input for brain digest — avoids context window overflow */
export interface DigestInput {
  goal: string;
  acceptance?: string;
  completedSteps: Array<{
    id: string;
    worker: string;
    summary: string;
    confidence?: number;
    /** Artifact references (paths/ids), not content — brain fetches on demand */
    artifactRefs: string[];
    findings: string[];
  }>;
  failedSteps: Array<{ id: string; worker: string; error: string }>;
  criticalFindings: string[];
  /** Steps that need surgical replan (low confidence or partial results) */
  replanCandidates: Array<{ id: string; reason: string; confidence?: number }>;
}

/** Risk level for confirmation gate */
export type StepRisk = 'safe' | 'moderate' | 'dangerous';

/** Confirmation gate result */
export interface ConfirmationResult {
  approved: boolean;
  modifiedSteps?: PlanStep[];
  reason?: string;
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
      if (parsed.summary) {
        // Map synthesis output fields to StructuredOutput
        return {
          summary: parsed.summary,
          findings: parsed.findings ?? parsed.recommendations ?? [],
          confidence: parsed.accepted === true ? 1.0 : parsed.accepted === false ? 0.2 : undefined,
          artifacts: parsed.deliverable ? [{ type: 'deliverable', content: parsed.deliverable }] : parsed.artifacts,
          // Preserve extra fields (accepted, gaps, etc.) for downstream use
          ...(parsed.accepted !== undefined ? { accepted: parsed.accepted } : {}),
          ...(parsed.gaps ? { gaps: parsed.gaps } : {}),
        } as StructuredOutput;
      }
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
  /**
   * Confirmation gate: called before execution starts.
   * Receives plan with risk assessment. Return approved=false to block.
   * If not provided, auto-approves (all steps are trusted).
   */
  confirmationGate?: (plan: ActionPlan, risks: Array<{ step: PlanStep; risk: StepRisk }>) => Promise<ConfirmationResult>;
}

/** Classify step risk based on worker type and tools */
function classifyStepRisk(step: PlanStep): StepRisk {
  const dangerousWorkers = new Set(['coder', 'shell']);
  const moderateWorkers = new Set(['analyst', 'researcher']);

  if (dangerousWorkers.has(step.worker)) return 'dangerous';
  if (moderateWorkers.has(step.worker)) return 'moderate';
  return 'safe';
}

export class PlanEngine {
  private executor: WorkerExecutor;
  private onStepComplete?: (step: StepResult) => void;
  private onStepDispatch?: (step: PlanStep) => void;
  private failurePolicy: 'none' | 'cancel-dependents' | 'cancel-all';
  private confirmationGate?: PlanEngineOptions['confirmationGate'];

  constructor(executor: WorkerExecutor, opts?: PlanEngineOptions) {
    this.executor = executor;
    this.onStepComplete = opts?.onStepComplete;
    this.onStepDispatch = opts?.onStepDispatch;
    this.failurePolicy = opts?.failurePolicy ?? 'cancel-dependents';
    this.confirmationGate = opts?.confirmationGate;
  }

  /** Surgical replan: re-execute only specific failed/low-confidence steps */
  async replanSteps(plan: ActionPlan, stepIds: string[], previousResults: Map<string, StepResult>): Promise<PlanResult> {
    // Create a sub-plan with only the specified steps
    const stepsToRerun = plan.steps.filter(s => stepIds.includes(s.id));
    const subPlan: ActionPlan = {
      goal: plan.goal,
      acceptance: plan.acceptance,
      steps: stepsToRerun.map(s => ({
        ...s,
        // Clear dependencies on already-completed steps (they have results)
        dependsOn: s.dependsOn.filter(d => stepIds.includes(d)),
      })),
      synthesis: false, // no synthesis on replan — let caller handle
    };

    // Inject previous results into context so replan steps can reference them
    const result = await this.execute(subPlan);

    // Merge: replan results override previous results
    const merged = new Map(previousResults);
    for (const step of result.steps) {
      merged.set(step.id, step);
    }

    return buildResult(plan, merged, Date.now());
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
    // Confirmation gate: assess risk and get approval before executing
    if (this.confirmationGate) {
      const risks = plan.steps.map(step => ({ step, risk: classifyStepRisk(step) }));
      const confirmation = await this.confirmationGate(plan, risks);
      if (!confirmation.approved) {
        return {
          goal: plan.goal, acceptance: plan.acceptance,
          steps: plan.steps.map(s => ({ id: s.id, worker: s.worker, status: 'skipped' as const, output: `Blocked by confirmation gate: ${confirmation.reason ?? 'not approved'}`, durationMs: 0, dispatchOrder: 0 })),
          totalDurationMs: 0,
          summary: { completed: 0, failed: 0, skipped: plan.steps.length, conditionSkipped: 0 },
          lowConfidenceSteps: [], digestContext: `Plan blocked: ${confirmation.reason}`, digestInput: { goal: plan.goal, completedSteps: [], failedSteps: [], criticalFindings: [], replanCandidates: [] },
          accepted: false,
        };
      }
      // Apply any step modifications from gate
      if (confirmation.modifiedSteps) {
        plan = { ...plan, steps: confirmation.modifiedSteps };
      }
    }

    const start = Date.now();
    const results = new Map<string, StepResult>();
    const running = new Set<string>();
    let dispatchOrder = 0;
    let aborted = false;

    const workerRunning = new Map<string, number>();

    return new Promise<PlanResult>((resolve) => {
      // Finalize: auto-synthesize results to achieve the plan's goal.
      // Every plan synthesizes by default — goal IS the synthesis instruction.
      // Set synthesis: false to disable (fire-and-forget plans only).
      const finalize = async () => {
        if (plan.synthesis !== false) {
          const synthConfig = typeof plan.synthesis === 'object' ? plan.synthesis : {};
          const synthWorker = synthConfig.worker ?? 'analyst';
          const synthLabel = synthConfig.label ?? '達成目標：匯總分析';
          const synthId = '__synthesis__';

          // Build context from all completed steps
          const completedSteps = [...results.values()].filter(r => r.status === 'completed');
          const context = completedSteps.map(s => {
            const label = s.structured?.summary ? `## ${s.id}\n${s.structured.summary}` : `## ${s.id}\n${s.output?.slice(0, 2000) ?? ''}`;
            return label;
          }).join('\n\n');

          // Goal-driven synthesis: goal + acceptance criteria = convergence condition
          const acceptanceLine = plan.acceptance
            ? `\n# 驗收條件\n${plan.acceptance}\n`
            : '';

          const acceptanceInstruction = plan.acceptance
            ? `\n驗收條件：${plan.acceptance}\n\n確認是否達成驗收條件。`
            : '';

          const defaultPrompt = `根據以上所有任務結果，完整達成目標「${plan.goal}」。${acceptanceInstruction}

你的輸出必須是 JSON 格式（放在 \`\`\`json ... \`\`\` block 裡）：
{
  "accepted": boolean,
  "summary": "一段話總結",
  "findings": ["關鍵發現1", "關鍵發現2"],
  "recommendations": ["具體建議1", "具體建議2"],
  "gaps": ["未達成的項目（若有）"],
  "deliverable": "最終交付物的完整內容"
}`;

          const synthPrompt = [
            `# 目標\n${plan.goal}\n`,
            acceptanceLine,
            `\n# 所有任務結果\n\n${context}\n\n`,
            `# 你的任務\n`,
            synthConfig.prompt ?? defaultPrompt,
          ].join('');

          this.onStepDispatch?.({ id: synthId, worker: synthWorker, task: synthPrompt, label: synthLabel, dependsOn: [] });

          try {
            const synthStart = Date.now();
            const output = await this.executor(synthWorker, synthPrompt, 180_000);
            const structured = parseStructuredOutput(output);
            const synthResult: StepResult = {
              id: synthId, worker: synthWorker, status: 'completed',
              output, structured, durationMs: Date.now() - synthStart, dispatchOrder: dispatchOrder++,
            };
            results.set(synthId, synthResult);
            this.onStepComplete?.(synthResult);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const synthResult: StepResult = {
              id: synthId, worker: synthWorker, status: 'failed',
              output: msg, durationMs: 0, dispatchOrder: dispatchOrder++,
            };
            results.set(synthId, synthResult);
            this.onStepComplete?.(synthResult);
          }
        }
        resolve(buildResult(plan, results, start));
      };

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
              if ((res.status === 'failed' || res.status === 'timeout') && this.failurePolicy === 'cancel-all') {
                aborted = true;
                // Mark all pending steps as skipped
                for (const s of plan.steps) {
                  if (!results.has(s.id) && !running.has(s.id)) {
                    results.set(s.id, { id: s.id, worker: s.worker, status: 'skipped', output: 'Aborted: cancel-all policy', durationMs: 0, dispatchOrder: dispatchOrder++ });
                  }
                }
                // Wait for running steps to finish naturally, then resolve
                if (running.size === 0) finalize();
                return;
              }

              // Check if all done
              if (results.size === plan.steps.length && running.size === 0) {
                finalize();
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
          finalize();
        }
      };

      tryDispatch();
    });
  }
}

function buildResult(plan: ActionPlan, results: Map<string, StepResult>, start: number): PlanResult {
  // Get steps (including synthesis if present)
  const allStepIds = [...new Set([...plan.steps.map(s => s.id), ...results.keys()])];
  const steps = allStepIds.map(id => results.get(id)).filter((s): s is StepResult => s != null);

  // Build compressed DigestInput
  const completedSteps = steps.filter(s => s.status === 'completed' && s.id !== '__synthesis__');
  const failedSteps = steps.filter(s => s.status === 'failed' || s.status === 'timeout');

  // Collect critical findings across all steps
  const criticalFindings: string[] = [];
  for (const s of completedSteps) {
    if (s.structured?.findings) criticalFindings.push(...s.structured.findings);
  }

  // Identify replan candidates (surgical replan targets)
  const replanCandidates = steps
    .filter(s => {
      if (s.status === 'failed' || s.status === 'timeout') return true;
      if (s.status === 'completed' && s.structured?.confidence !== undefined && s.structured.confidence < LOW_CONFIDENCE_THRESHOLD) return true;
      return false;
    })
    .map(s => ({
      id: s.id,
      reason: s.status !== 'completed' ? s.status : `low confidence (${s.structured!.confidence})`,
      confidence: s.structured?.confidence,
    }));

  const digestInput: DigestInput = {
    goal: plan.goal,
    acceptance: plan.acceptance,
    completedSteps: completedSteps.map(s => ({
      id: s.id,
      worker: s.worker,
      summary: s.structured?.summary ?? s.output?.slice(0, 500) ?? '',
      confidence: s.structured?.confidence,
      artifactRefs: s.structured?.artifacts?.map(a => a.path ?? a.type) ?? [],
      findings: s.structured?.findings ?? [],
    })),
    failedSteps: failedSteps.map(s => ({ id: s.id, worker: s.worker, error: s.output })),
    criticalFindings: [...new Set(criticalFindings)],
    replanCandidates,
  };

  // Build text digest from compressed input
  const digestParts: string[] = [`# Plan Result: ${plan.goal}\n`];
  if (plan.acceptance) digestParts.push(`Acceptance: ${plan.acceptance}\n`);

  for (const s of steps) {
    if (s.id === '__synthesis__') continue;
    const summary = s.structured?.summary ?? s.output?.slice(0, 500);
    const icon = s.status === 'completed' ? '✅' : s.status === 'condition_skipped' ? '⏭' : '❌';
    digestParts.push(`## ${icon} ${s.id} [${s.worker}] (${(s.durationMs / 1000).toFixed(1)}s)`);
    digestParts.push(summary);
    if (s.structured?.findings?.length) digestParts.push(`Findings: ${s.structured.findings.join('; ')}`);
    digestParts.push('');
  }

  // Synthesis result
  const synthStep = results.get('__synthesis__');
  if (synthStep) {
    digestParts.push(`\n## 📋 Synthesis [${synthStep.worker}] (${(synthStep.durationMs / 1000).toFixed(1)}s)`);
    digestParts.push(synthStep.output?.slice(0, 2000) ?? '');
  }

  if (replanCandidates.length > 0) {
    digestParts.push(`\n⚠ Replan candidates: ${replanCandidates.map(s => `${s.id}(${s.reason})`).join(', ')}`);
  }

  // Check acceptance via structured output (not regex — Akari review: "職責錯置")
  // Synthesis worker returns { accepted: bool } in JSON — language-independent
  let accepted: boolean | null = null;
  if (synthStep?.status === 'completed') {
    const structured = synthStep.structured ?? parseStructuredOutput(synthStep.output ?? '');
    if (structured && 'accepted' in (structured as unknown as Record<string, unknown>)) {
      accepted = Boolean((structured as unknown as Record<string, unknown>).accepted);
    } else if (plan.acceptance) {
      // Fallback: if no structured output, check if any gap was reported
      accepted = failedSteps.length === 0 && replanCandidates.length === 0;
    }
  }

  return {
    goal: plan.goal,
    acceptance: plan.acceptance,
    steps,
    totalDurationMs: Date.now() - start,
    summary: {
      completed: steps.filter(s => s.status === 'completed').length,
      failed: steps.filter(s => s.status === 'failed' || s.status === 'timeout').length,
      skipped: steps.filter(s => s.status === 'skipped').length,
      conditionSkipped: steps.filter(s => s.status === 'condition_skipped').length,
    },
    lowConfidenceSteps: replanCandidates.filter(r => r.confidence !== undefined) as Array<{ id: string; confidence: number; reason?: string }>,
    digestContext: digestParts.join('\n'),
    digestInput,
    accepted,
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
