/**
 * Agent SDK Provider — uses Claude Agent SDK (subscription auth).
 * Reference: Tanren's createAgentSdkProvider (verified working).
 */

import type { LLMProvider, Prompt, ContentBlock } from './llm-provider.js';

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
}

export function createSdkProvider(opts?: SdkProviderOptions): LLMProvider {
  const identityMode = opts?.identityMode ?? 'override';

  return {
    async think(prompt: Prompt, systemPrompt: string): Promise<string> {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');

      const sysOpt = systemPrompt
        ? (identityMode === 'inherit-claude-code'
          ? { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: systemPrompt } }
          : { systemPrompt })
        : {};

      // Convert multimodal prompt to SDK format
      // SDK accepts string or AsyncIterable<SDKUserMessage>
      // For multimodal: build a text prompt that includes image/file references
      // Agent SDK's query() prompt is string-based; images go through tool results
      // So we serialize content blocks into a structured text prompt
      const promptStr = typeof prompt === 'string'
        ? prompt
        : serializeContentBlocks(prompt);

      let result = '';

      for await (const msg of query({
        prompt: promptStr,
        options: {
          cwd: opts?.cwd ?? process.cwd(),
          allowedTools: opts?.allowedTools ?? ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
          disallowedTools: opts?.disallowedTools,
          maxTurns: opts?.maxTurns,
          maxBudgetUsd: opts?.maxBudgetUsd ?? 10,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          ...sysOpt,
          ...(opts?.model ? { model: opts.model } : {}),
          ...(opts?.agents ? { agents: opts.agents } : {}),
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

/**
 * Serialize multimodal content blocks into a text prompt.
 * Images are referenced as file paths (worker can Read them) or described.
 * Files are referenced by path for workers to read.
 */
function serializeContentBlocks(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        parts.push(block.text);
        break;
      case 'image':
        if (block.source.type === 'url') {
          parts.push(`[Image: ${block.source.data}]`);
        } else {
          // base64 — save to temp file so worker can Read it
          const tmpPath = `/tmp/mw-img-${Date.now()}.${block.source.mediaType.split('/')[1] || 'png'}`;
          try {
            const fs = require('node:fs');
            fs.writeFileSync(tmpPath, Buffer.from(block.source.data, 'base64'));
            parts.push(`[Image saved to: ${tmpPath} (${block.source.mediaType})]`);
          } catch {
            parts.push(`[Image: base64 ${block.source.mediaType}, ${block.source.data.length} chars]`);
          }
        }
        break;
      case 'file':
        parts.push(`[File: ${block.path}${block.mediaType ? ` (${block.mediaType})` : ''}]`);
        break;
    }
  }
  return parts.join('\n\n');
}
