/**
 * Agent SDK Provider — uses Claude Agent SDK (subscription auth).
 * Reference: Tanren's createAgentSdkProvider (verified working).
 */

import type { LLMProvider, Prompt, RuntimeOptions, ToolUseEvent } from './llm-provider.js';
import { promptToText } from './content-adapter.js';

/**
 * Replace unpaired UTF-16 surrogate code points with U+FFFD so the prompt
 * survives JSON serialization on the way to Anthropic's API.
 *
 * Background: Agent SDK serializes the request body via JSON.stringify, which
 * happily emits lone surrogates ("\uD83D" without paired low surrogate). The
 * Anthropic API JSON parser rejects those with HTTP 400 "no low surrogate in
 * string" — observed 30× across agent-brain failures (e.g. results.jsonl
 * task-1778314085124-cc, char 53948). Caller-supplied prompts can contain
 * lone surrogates after CJK/emoji content gets sliced mid-character upstream;
 * this sanitizer is the safety net at the API boundary.
 */
export function sanitizeUnpairedSurrogates(s: string): string {
  // Lone high surrogate (D800-DBFF) not followed by low surrogate (DC00-DFFF)
  // Lone low surrogate (DC00-DFFF) not preceded by high surrogate
  return s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '\uFFFD')
    .replace(/(^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g, '$1\uFFFD');
}

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

      // Defensive sanitize at the API boundary — lone UTF-16 surrogates
      // anywhere in the body trigger Anthropic 400 "no low surrogate in string".
      const safeSystemPrompt = systemPrompt ? sanitizeUnpairedSurrogates(systemPrompt) : systemPrompt;
      const sysOpt = safeSystemPrompt
        ? (identityMode === 'inherit-claude-code'
          ? { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: safeSystemPrompt } }
          : { systemPrompt: safeSystemPrompt })
        : {};

      // Agent SDK's query() prompt is string-based — convert multimodal to text
      const promptStr = sanitizeUnpairedSurrogates(promptToText(prompt));

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

