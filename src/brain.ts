/**
 * Brain — constrained planning/judging layer with dual modes.
 *
 * Key principle: Brain plans the FULL DAG including the final step.
 * No auto-synthesis — if Brain wants a summary, it puts a summary step in the DAG.
 * This makes synthesis a regular DAG node, not a special case.
 *
 * Constraint Texture (framework-level):
 * Brain can ONLY dispatch workers via Agent tool.
 */

import { createSdkProvider } from './sdk-provider.js';
import { getSdkAgentDefinitions } from './workers.js';
import type { LLMProvider } from './llm-provider.js';
import type { PlanResult } from './plan-engine.js';

export interface BrainConfig {
  model?: string;
  cwd?: string;
  additionalTools?: string[];
  maxReplanRounds?: number;
}

const DEFAULT_MAX_REPLAN = 3;

const PLANNING_SYSTEM = `You are the planning brain of an AI agent system. Your ONLY job is to produce action plans.

OUTPUT FORMAT: Return a JSON action plan inside \`\`\`json ... \`\`\` block:
{
  "goal": "用一句人話說明這個計劃要達成什麼",
  "acceptance": "驗收條件 — 怎麼判斷目標達成了（可選）",
  "steps": [
    {
      "id": "kebab-case-id",
      "worker": "researcher|coder|reviewer|shell|analyst|explorer",
      "task": "具體任務描述 — 可以引用前序結果 {{stepId.result}} 或 {{stepId.summary}}",
      "label": "給人看的摘要 < 30 字",
      "dependsOn": ["dependency-ids"],
      "acceptance_criteria": "string OR {type,value} — 收斂條件（多步計劃必填）",
      "retry": { "maxRetries": 2, "onExhausted": "skip" }
    }
  ]
}

CRITICAL RULES:
- YOU decide the last step. If goal is "寫報告", the last step is a report-writing step.
  If goal is "部署", the last step is a health-check step. Don't leave it to the framework.
- The last step should return structured JSON: { "accepted": bool, "summary": "...", "deliverable": "..." }
- Steps with empty dependsOn run in parallel
- Use {{stepId.result}} or {{stepId.summary}} to pass data between steps
- Keep steps at "independently verifiable work unit" granularity
- For multi-step plans (≥2 steps): EVERY step MUST have "acceptance_criteria" field (observable end state). Plans without per-step acceptance_criteria are INVALID.
- For single-step plans: acceptance_criteria is optional (plan-level acceptance suffices)
- acceptance_criteria describes WHAT to verify, not HOW — convergence condition, not prescription
- acceptance_criteria can be a string (semantic, checked by worker) OR structured for mechanical verification:
  - {"type":"output_contains","value":"SUCCESS"} — output must contain substring
  - {"type":"file_exists","value":"path/to/file"} — file must exist after step
  - {"type":"test_passes","value":"npm test"} — shell command must exit 0
  - {"type":"schema_match","value":"{\"key1\":\"\",\"key2\":\"\"}"} — output JSON must have these keys
- Use structured types when the check is mechanical; use string when it needs judgment
- Add retry for unreliable steps (web fetch, API calls): { "maxRetries": 2, "onExhausted": "skip" }
- DO NOT execute tools yourself — only produce the plan

WORKER-SPECIFIC TASK FORMAT:
- shell: task MUST be a pure shell command, NO description. Example: "wc -l src/*.ts | sort -rn | head -3"
- researcher/coder/reviewer/analyst/explorer: task is a natural language instruction
- Use "label" field for human-readable description, "task" field for the actual work

SHELL EXIT-CODE CONVENTIONS (shell worker only):
- Default: exit 0 = success, anything else = failure
- POSIX tools use non-zero exits as INFORMATION, not errors. Set "acceptableExitCodes": [0, 1]
  when the step uses one of these tools and exit 1 is a valid outcome:
  * grep: 1 = no match found
  * diff/cmp: 1 = files differ
  * test / [: 1 = condition false
  * find/xargs: specific non-zero codes for traversal
- Example: "task": "grep -r 'TODO' src/", "acceptableExitCodes": [0, 1]
  (Otherwise "no TODO found" incorrectly fails the step + cascades as "Dependency failed"
  to all downstream steps.)
- If a shell step depends on grep/diff/test for conditional logic, ALWAYS set
  acceptableExitCodes. Don't rely on "|| true" workarounds.`;

const DIGEST_SYSTEM = `You are the digest brain of an AI agent system. Workers have completed their tasks.

Your job:
1. Read all worker results
2. Decide: task complete → respond to user, OR need more work → produce another plan

If task is complete: respond naturally with the synthesized answer.
If more work needed: produce another action plan in \`\`\`json ... \`\`\` block.
If some steps had low confidence: you may produce a targeted replan for just those steps.`;

export function createBrain(config?: BrainConfig): LLMProvider {
  return createSdkProvider({
    model: config?.model ?? 'opus',
    cwd: config?.cwd ?? process.cwd(),
    allowedTools: ['Agent', ...(config?.additionalTools ?? [])],
    agents: getSdkAgentDefinitions() as Record<string, import('@anthropic-ai/claude-agent-sdk').AgentDefinition>,
    identityMode: 'override',
  });
}

/** Worker info for brain's planning context */
export interface WorkerInfo {
  name: string;
  description: string;
  backend: string;
  model?: string;
  maxConcurrency?: number;
}

export async function brainPlan(brain: LLMProvider, goal: string, opts?: { context?: string; availableWorkers?: WorkerInfo[]; convergenceIteration?: number }): Promise<string> {
  const parts: string[] = [];
  if (opts?.context) parts.push(`Context:\n${opts.context}\n`);
  if (opts?.availableWorkers?.length) {
    parts.push(`Available workers:\n${opts.availableWorkers.map(w => `- ${w.name} (${w.backend}/${w.model ?? 'default'}): ${w.description}`).join('\n')}\n`);
  }
  if (opts?.convergenceIteration) {
    parts.push(`⚠ This is convergence iteration ${opts.convergenceIteration}. Refine the plan based on previous results.\n`);
  }
  parts.push(`Goal: ${goal}`);
  return brain.think(parts.join('\n'), PLANNING_SYSTEM);
}

export async function brainDigest(
  brain: LLMProvider, goal: string, planResult: PlanResult,
  opts?: { additionalContext?: string; replanRound?: number; maxReplanRounds?: number },
): Promise<string> {
  const round = opts?.replanRound ?? 0;
  const maxRounds = opts?.maxReplanRounds ?? DEFAULT_MAX_REPLAN;

  const replanWarning = round >= maxRounds
    ? `\n\n⚠ REPLAN LIMIT (${round}/${maxRounds}). Produce final response NOW.`
    : round > 0 ? `\n\nReplan round ${round}/${maxRounds}.` : '';

  const prompt = [
    `Goal: ${goal}\n`,
    `Plan: ${planResult.summary.completed} completed, ${planResult.summary.failed} failed, ${planResult.summary.skipped} skipped`,
    ` (${(planResult.totalDurationMs / 1000).toFixed(1)}s, ${planResult.convergenceIterations} convergence iterations)\n\n`,
    planResult.digestContext,
    opts?.additionalContext ? `\n\n${opts.additionalContext}` : '',
    replanWarning,
  ].join('');
  return brain.think(prompt, DIGEST_SYSTEM);
}
