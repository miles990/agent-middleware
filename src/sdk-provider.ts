/**
 * Agent SDK Provider — uses Claude Agent SDK (subscription auth).
 * Reference: Tanren's createAgentSdkProvider (verified working).
 */

import type { LLMProvider, Prompt, RuntimeOptions } from './llm-provider.js';
import { promptToText } from './content-adapter.js';

export interface SdkProviderOptions {
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  cwd?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  agents?: Record<string, import('@anthropic-ai/claude-agent-sdk').AgentDefinition>;
  /** 'override' = agent's own identity, 'inherit-claude-code' = CC defaults + append */
  identityMode?: 'override' | 'inherit-claude-code';
  /** MCP servers available to this worker */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mcpServers?: Record<string, any>;
}

export function createSdkProvider(opts?: SdkProviderOptions): LLMProvider {
  const identityMode = opts?.identityMode ?? 'override';

  return {
    async think(prompt: Prompt, systemPrompt: string, runtimeOpts?: RuntimeOptions): Promise<string> {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');

      const sysOpt = systemPrompt
        ? (identityMode === 'inherit-claude-code'
          ? { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: systemPrompt } }
          : { systemPrompt })
        : {};

      // Agent SDK's query() prompt is string-based — convert multimodal to text
      const promptStr = promptToText(prompt);

      let result = '';

      for await (const msg of query({
        prompt: promptStr,
        options: {
          // Precedence: per-call runtimeOpts.cwd > provider-baked opts.cwd > process.cwd()
          cwd: runtimeOpts?.cwd ?? opts?.cwd ?? process.cwd(),
          allowedTools: opts?.allowedTools ?? ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
          disallowedTools: opts?.disallowedTools,
          maxTurns: opts?.maxTurns,
          maxBudgetUsd: opts?.maxBudgetUsd ?? 10,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          ...sysOpt,
          ...(opts?.model ? { model: opts.model } : {}),
          ...(opts?.agents ? { agents: opts.agents } : {}),
          ...(opts?.mcpServers ? { mcpServers: opts.mcpServers } : {}),
        },
      })) {
        if ('result' in msg && typeof msg.result === 'string') {
          result = msg.result;
        }
      }

      return result;
    },
  };
}

