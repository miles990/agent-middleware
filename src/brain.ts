/**
 * Brain — constrained planning/judging layer with dual modes.
 *
 * Two explicit modes (Akari's recommendation):
 * - Planning mode: produce ActionPlan DAG, no tool calls
 * - Digest mode: synthesize worker results, decide next step
 *
 * Constraint Texture (framework-level):
 * Brain can ONLY dispatch workers via Agent tool.
 * It cannot Read, Write, Edit, Bash directly.
 */

import { createSdkProvider, type SdkProviderOptions } from './sdk-provider.js';
import { getSdkAgentDefinitions } from './workers.js';
import type { LLMProvider } from './llm-provider.js';
import type { PlanResult } from './plan-engine.js';

export interface BrainConfig {
  model?: string;
  cwd?: string;
  additionalTools?: string[];
  /** Max replanning rounds before accepting imperfect results (default: 3) */
  maxReplanRounds?: number;
}

/** Max replan attempts to prevent infinite loops */
const DEFAULT_MAX_REPLAN = 3;

const PLANNING_SYSTEM = `You are the planning brain of an AI agent system. Your ONLY job is to produce action plans.

OUTPUT FORMAT: Return a JSON action plan inside \`\`\`json ... \`\`\` block:
{
  "goal": "用一句人話說明這個計劃要達成什麼（例：分析 Kuro 的回應延遲問題並找出根因）",
  "steps": [
    {
      "id": "簡短英文 kebab-case（例：check-logs）",
      "worker": "researcher|coder|reviewer|shell|analyst|explorer",
      "task": "具體任務描述 — 用人能理解的語言，不是指令語法",
      "label": "這個步驟在做什麼（人類看的，顯示在 dashboard 上，例：檢查最近 24 小時的錯誤 log）",
      "dependsOn": ["依賴的 step id"],
      "condition": { "stepId": "x", "check": "completed|failed|contains|not_contains", "value": "optional" }
    }
  ]
}

WRITING RULES:
- goal 必須用自然語言，讓不懂技術的人也看得懂在做什麼
- 每個 step 的 label 是給人看的摘要（< 30 字）
- task 是給 worker 看的詳細指令（可以技術化）
- Steps with empty dependsOn run in parallel
- Use {{stepId.result}} or {{stepId.summary}} to pass data between steps
- Keep steps at "independently verifiable work unit" granularity — NOT tool-call level
- condition field is optional — use for dynamic branching
- DO NOT execute tools yourself — only produce the plan`;

const DIGEST_SYSTEM = `You are the digest brain of an AI agent system. Workers have completed their tasks.

Your job:
1. Read all worker results
2. Synthesize findings into a coherent response
3. Decide: task complete → respond to user, OR need more work → produce another plan

If task is complete: respond naturally with the synthesized answer.
If more work needed: produce another action plan in \`\`\`json ... \`\`\` block.`;

/**
 * Create a brain provider — Opus with only Agent tool.
 */
export function createBrain(config?: BrainConfig): LLMProvider {
  return createSdkProvider({
    model: config?.model ?? 'opus',
    cwd: config?.cwd ?? process.cwd(),
    allowedTools: ['Agent', ...(config?.additionalTools ?? [])],
    agents: getSdkAgentDefinitions(),
    identityMode: 'override',
  });
}

/**
 * Planning mode: brain produces an ActionPlan.
 * Input: user goal + available workers.
 * Output: ActionPlan JSON string.
 */
export async function brainPlan(brain: LLMProvider, goal: string, context?: string): Promise<string> {
  const prompt = [
    context ? `Context:\n${context}\n\n` : '',
    `Goal: ${goal}`,
  ].join('');
  return brain.think(prompt, PLANNING_SYSTEM);
}

/**
 * Digest mode: brain synthesizes worker results.
 * Input: original goal + plan results.
 * Output: final response or new plan.
 */
export async function brainDigest(
  brain: LLMProvider,
  goal: string,
  planResult: PlanResult,
  opts?: { additionalContext?: string; replanRound?: number; maxReplanRounds?: number },
): Promise<string> {
  const round = opts?.replanRound ?? 0;
  const maxRounds = opts?.maxReplanRounds ?? DEFAULT_MAX_REPLAN;

  const replanWarning = round >= maxRounds
    ? `\n\n⚠ REPLAN LIMIT REACHED (${round}/${maxRounds}). You MUST produce a final response now — do NOT output another plan. Accept imperfect results and summarize what you have.`
    : round > 0
    ? `\n\nReplan round ${round}/${maxRounds}. You may produce another plan if needed, or finalize.`
    : '';

  const prompt = [
    `Original goal: ${goal}\n`,
    `Plan: "${planResult.goal}" — ${planResult.summary.completed} completed, ${planResult.summary.failed} failed, ${planResult.summary.skipped} skipped\n`,
    `Duration: ${(planResult.totalDurationMs / 1000).toFixed(1)}s\n\n`,
    planResult.digestContext,
    opts?.additionalContext ? `\n\nAdditional context:\n${opts.additionalContext}` : '',
    replanWarning,
  ].join('');
  return brain.think(prompt, DIGEST_SYSTEM);
}
