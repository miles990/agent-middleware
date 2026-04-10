/**
 * Anthropic Managed Agents Provider
 *
 * Uses Anthropic Messages API with Container + Skills for cloud-hosted agentic execution.
 * Containers provide: persistent sandbox, code execution, web search, file access, MCP servers.
 * Skills are reusable capabilities loaded into containers (built-in: web-search, code-interpreter, etc.)
 *
 * Requires: ANTHROPIC_API_KEY env var.
 *
 * API: POST /v1/messages with container + skills + tools (code_execution, web_search, etc.)
 */

import type { LLMProvider, Prompt } from './llm-provider.js';
import { toAnthropic, promptToText } from './content-adapter.js';

export interface ManagedAgentProviderOptions {
  /** Model (default: claude-sonnet-4-6) */
  model?: string;
  /** Container ID for persistent state across calls (optional — auto-created if omitted) */
  containerId?: string;
  /** Skills to load in container */
  skills?: Array<{ skillId: string; type: 'anthropic' | 'custom'; version?: string }>;
  /** Tools: code execution, web search, MCP servers */
  tools?: Array<
    | { type: 'code_execution'; version?: string }
    | { type: 'web_search'; version?: string }
    | { type: 'mcp'; name: string; url: string; authorizationToken?: string }
  >;
  /** Max tokens */
  maxTokens?: number;
  /** API key override */
  apiKey?: string;
  /** Base URL override */
  baseUrl?: string;
  /** Beta headers to enable */
  betas?: string[];
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: string;
}

interface ApiResponse {
  id: string;
  content: ContentBlock[];
  model: string;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
  container?: { id: string; expires_at: string };
}

export function createManagedAgentProvider(opts?: ManagedAgentProviderOptions): LLMProvider {
  const apiKey = opts?.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const baseUrl = opts?.baseUrl ?? 'https://api.anthropic.com';
  const model = opts?.model ?? 'claude-sonnet-4-6';
  const maxTokens = opts?.maxTokens ?? 16384;

  // Build tools array
  const tools: Array<Record<string, unknown>> = [];
  for (const t of opts?.tools ?? [{ type: 'code_execution' as const }, { type: 'web_search' as const }]) {
    if (t.type === 'code_execution') {
      tools.push({ name: 'code_execution', type: t.version ?? 'code_execution_20260120' });
    } else if (t.type === 'web_search') {
      tools.push({ name: 'web_search', type: t.version ?? 'web_search_20250305' });
    } else if (t.type === 'mcp') {
      tools.push({
        type: 'url',
        name: t.name,
        url: t.url,
        ...(t.authorizationToken ? { authorization_token: t.authorizationToken } : {}),
      });
    }
  }

  // Build container config
  const container = opts?.containerId || opts?.skills
    ? {
        ...(opts?.containerId ? { id: opts.containerId } : {}),
        ...(opts?.skills ? {
          skills: opts.skills.map(s => ({
            skill_id: s.skillId,
            type: s.type,
            ...(s.version ? { version: s.version } : {}),
          })),
        } : {}),
      }
    : undefined;

  // Beta headers
  const betas = opts?.betas ?? [
    'code-execution-2025-05-22',
    'skills-2025-10-02',
  ];

  // Track container ID for reuse
  let activeContainerId = opts?.containerId;

  return {
    async think(prompt: Prompt, systemPrompt: string): Promise<string> {
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set for Managed Agents');

      // Build multimodal content via adapter
      const userContent = typeof prompt === 'string' ? prompt : toAnthropic(prompt);

      const body: Record<string, unknown> = {
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: userContent }],
        ...(systemPrompt ? { system: systemPrompt } : {}),
        ...(tools.length > 0 ? { tools } : {}),
        ...(container ? { container: activeContainerId ? { id: activeContainerId, ...container } : container } : {}),
      };

      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2024-01-01',
          ...(betas.length > 0 ? { 'anthropic-beta': betas.join(',') } : {}),
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Managed Agent API error ${res.status}: ${err.slice(0, 300)}`);
      }

      const data = await res.json() as ApiResponse;

      // Save container ID for reuse
      if (data.container?.id) {
        activeContainerId = data.container.id;
      }

      // Extract text from response content blocks
      const textBlocks = data.content
        .filter(b => b.type === 'text' && b.text)
        .map(b => b.text!);

      return textBlocks.join('\n') || JSON.stringify(data.content);
    },
  };
}
