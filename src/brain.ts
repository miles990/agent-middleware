/**
 * Brain — constrained planning/judging layer.
 *
 * Constraint Texture (framework-level):
 * Brain can ONLY dispatch workers via Agent tool.
 * It cannot Read, Write, Edit, Bash directly.
 * This forces multi-threading by design.
 */

import { createSdkProvider, type SdkProviderOptions } from './sdk-provider.js';
import { getSdkAgentDefinitions } from './workers.js';
import type { LLMProvider } from './llm-provider.js';

export interface BrainConfig {
  model?: string;
  cwd?: string;
  /** Additional tools beyond Agent (e.g. custom MCP tools for memory) */
  additionalTools?: string[];
}

/**
 * Create a brain provider — Opus with only Agent tool.
 * Workers auto-registered as subagent definitions.
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
