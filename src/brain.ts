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
}

const PLANNING_SYSTEM = `You are the planning brain of an AI agent system. Your ONLY job is to produce action plans.

OUTPUT FORMAT: Return a JSON action plan inside \`\`\`json ... \`\`\` block:
{
  "goal": "what this plan achieves",
  "steps": [
    {
      "id": "step-name",
      "worker": "researcher|coder|reviewer|shell|analyst|explorer",
      "task": "specific task description — reference previous results with {{stepId.result}} or {{stepId.summary}}",
      "dependsOn": ["step-ids-that-must-complete-first"],
      "condition": { "stepId": "x", "check": "completed|failed|contains|not_contains", "value": "optional" }
    }
  ]
}

RULES:
- Steps with empty dependsOn run in parallel (Wave 0)
- Use {{stepId.result}} to pass data between steps
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
export async function brainDigest(brain: LLMProvider, goal: string, planResult: PlanResult, additionalContext?: string): Promise<string> {
  const prompt = [
    `Original goal: ${goal}\n`,
    `Plan: "${planResult.goal}" — ${planResult.summary.completed} completed, ${planResult.summary.failed} failed, ${planResult.summary.skipped} skipped\n`,
    `Duration: ${(planResult.totalDurationMs / 1000).toFixed(1)}s\n\n`,
    planResult.digestContext,
    additionalContext ? `\n\nAdditional context:\n${additionalContext}` : '',
  ].join('');
  return brain.think(prompt, DIGEST_SYSTEM);
}
