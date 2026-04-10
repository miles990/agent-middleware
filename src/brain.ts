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
- Add retry for unreliable steps (web fetch, API calls): { "maxRetries": 2, "onExhausted": "skip" }
- DO NOT execute tools yourself — only produce the plan`;

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
    agents: getSdkAgentDefinitions(),
    identityMode: 'override',
  });
}

export async function brainPlan(brain: LLMProvider, goal: string, context?: string): Promise<string> {
  const prompt = [context ? `Context:\n${context}\n\n` : '', `Goal: ${goal}`].join('');
  return brain.think(prompt, PLANNING_SYSTEM);
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
