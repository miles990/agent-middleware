/**
 * Agent SDK Provider — uses Claude Agent SDK (subscription auth).
 * Reference: Tanren's createAgentSdkProvider (verified working).
 */

import type { LLMProvider, Prompt, RuntimeOptions, ToolUseEvent } from './llm-provider.js';
import { promptToText } from './content-adapter.js';

/**
 * Best-effort target extraction for common tools so consumers can render
 * a compact `Read(/path/to/file)` summary without having to introspect input.
 */
function extractToolTarget(name: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const o = input as Record<string, unknown>;
  // Common shapes across Claude tools
  const candidates = ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'description'];
  for (const k of candidates) {
    const v = o[k];
    if (typeof v === 'string' && v.length > 0) {
      return v.length > 200 ? v.slice(0, 197) + '...' : v;
    }
  }
  return undefined;
}

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

      // Progress-based timeout wiring: onActivity fired on every yielded
      // message so stall detector resets. signal lets caller abort mid-iteration.
      const abortController = new AbortController();
      if (runtimeOpts?.signal) {
        if (runtimeOpts.signal.aborted) throw new Error('aborted before start');
        runtimeOpts.signal.addEventListener('abort', () => abortController.abort());
      }

      // tool_use accounting (issue #1): track in-flight tool_use ids so we can
      // emit a second event with ok-status when the matching tool_result arrives.
      const onToolUse = runtimeOpts?.onToolUse;
      const inflightToolUses = new Map<string, ToolUseEvent>();

      for await (const msg of query({
        prompt: promptStr,
        options: {
          // Precedence: per-call runtimeOpts.cwd > provider-baked opts.cwd > process.cwd()
          cwd: runtimeOpts?.cwd ?? opts?.cwd ?? process.cwd(),
          abortController,
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
        runtimeOpts?.onActivity?.();
        // Inspect message content for tool_use / tool_result blocks before
        // checking for the final result. Agent SDK yields assistant messages
        // with content arrays; user messages may carry tool_result blocks.
        if (onToolUse) {
          try {
            const m = msg as { type?: string; message?: { content?: unknown } };
            const content = m?.message?.content;
            if (Array.isArray(content)) {
              for (const block of content as Array<Record<string, unknown>>) {
                if (block?.type === 'tool_use' && typeof block.name === 'string') {
                  const id = typeof block.id === 'string' ? block.id : undefined;
                  const ev: ToolUseEvent = {
                    name: block.name,
                    target: extractToolTarget(block.name, block.input),
                    id,
                    ts: Date.now(),
                  };
                  if (id) inflightToolUses.set(id, ev);
                  onToolUse(ev);
                } else if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
                  const prior = inflightToolUses.get(block.tool_use_id);
                  if (prior) {
                    const ok = block.is_error !== true;
                    onToolUse({ ...prior, ok, ts: Date.now() });
                    inflightToolUses.delete(block.tool_use_id);
                  }
                }
              }
            }
          } catch {
            // Best-effort observability — never let instrumentation throw.
          }
        }
        if ('result' in msg && typeof msg.result === 'string') {
          result = msg.result;
        }
      }

      return result;
    },
  };
}

