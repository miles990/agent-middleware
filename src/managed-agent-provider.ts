/**
 * Anthropic Managed Agents Provider
 *
 * Uses Anthropic's cloud-hosted agent platform (/v1/agents, /v1/sessions).
 * Agents run in Anthropic's sandbox with built-in tools (web search, code exec, file access).
 * No local CLI needed — pure API.
 *
 * Requires: ANTHROPIC_API_KEY env var.
 *
 * Ref: jiexi.page/vol5-managed-agents.html
 */

import type { LLMProvider, Prompt } from './llm-provider.js';

export interface ManagedAgentProviderOptions {
  /** Agent ID (pre-created via API) or inline agent config */
  agentId?: string;
  /** Model for the managed agent */
  model?: string;
  /** Max turns for the agent session */
  maxTurns?: number;
  /** Tools to enable: 'web_search', 'code_execution', 'file_access', 'mcp' */
  tools?: Array<'web_search' | 'code_execution' | 'file_access' | 'mcp'>;
  /** API key override */
  apiKey?: string;
  /** Base URL override (for proxy/testing) */
  baseUrl?: string;
  /** Custom instructions appended to agent */
  instructions?: string;
}

interface SessionMessage {
  role: 'user' | 'assistant';
  content: string;
}

export function createManagedAgentProvider(opts?: ManagedAgentProviderOptions): LLMProvider {
  const apiKey = opts?.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const baseUrl = opts?.baseUrl ?? 'https://api.anthropic.com';
  const model = opts?.model ?? 'claude-sonnet-4-6';

  return {
    async think(prompt: Prompt, systemPrompt: string): Promise<string> {
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set for Managed Agents');

      const promptStr = typeof prompt === 'string'
        ? prompt
        : prompt.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n\n');

      // Build agent tools config
      const tools: Array<Record<string, unknown>> = [];
      for (const t of opts?.tools ?? ['web_search', 'code_execution']) {
        tools.push({ type: t });
      }

      // Create a session and send the message
      // Step 1: Create session with agent config
      const sessionRes = await fetch(`${baseUrl}/v1/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2024-01-01',
          'anthropic-beta': 'managed-agents-2025-04-15',
        },
        body: JSON.stringify({
          model,
          instructions: [systemPrompt, opts?.instructions].filter(Boolean).join('\n\n') || undefined,
          tools,
          max_turns: opts?.maxTurns ?? 10,
        }),
      });

      if (!sessionRes.ok) {
        const err = await sessionRes.text();
        throw new Error(`Managed Agent session creation failed ${sessionRes.status}: ${err.slice(0, 300)}`);
      }

      const session = await sessionRes.json() as { id: string };

      // Step 2: Send message to session
      const msgRes = await fetch(`${baseUrl}/v1/sessions/${session.id}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2024-01-01',
          'anthropic-beta': 'managed-agents-2025-04-15',
        },
        body: JSON.stringify({
          role: 'user',
          content: promptStr,
        }),
      });

      if (!msgRes.ok) {
        const err = await msgRes.text();
        throw new Error(`Managed Agent message failed ${msgRes.status}: ${err.slice(0, 300)}`);
      }

      // Step 3: Poll for completion (SSE or polling)
      // The response may stream — collect all assistant messages
      const result = await msgRes.json() as {
        content?: Array<{ type: string; text?: string }>;
        messages?: SessionMessage[];
        result?: string;
      };

      // Extract text from response
      if (result.result) return result.result;
      if (result.content) {
        return result.content
          .filter(b => b.type === 'text' && b.text)
          .map(b => b.text!)
          .join('\n');
      }
      if (result.messages) {
        return result.messages
          .filter(m => m.role === 'assistant')
          .map(m => m.content)
          .join('\n');
      }

      return JSON.stringify(result);
    },
  };
}
