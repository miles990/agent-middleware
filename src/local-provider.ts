/**
 * Local LLM Provider — OpenAI-compatible API (Ollama, llama.cpp, vLLM, LM Studio, MLX).
 * Requires: local server running on baseUrl (default: http://localhost:11434/v1 for Ollama).
 */

import type { LLMProvider, Prompt } from './llm-provider.js';

export interface LocalProviderOptions {
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
}

export function createLocalProvider(opts?: LocalProviderOptions): LLMProvider {
  const model = opts?.model ?? 'llama3:8b';
  const baseUrl = opts?.baseUrl ?? process.env.LOCAL_LLM_URL ?? 'http://localhost:11434/v1';
  const maxTokens = opts?.maxTokens ?? 2048;
  const temperature = opts?.temperature ?? 0.7;

  return {
    async think(prompt: Prompt, systemPrompt: string): Promise<string> {
      const messages: Array<{ role: string; content: string }> = [];

      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });

      // Local models: most support text only, some (LLaVA, Qwen-VL) support vision
      // For vision models: pass images as base64 in OpenAI-compatible format
      if (typeof prompt === 'string') {
        messages.push({ role: 'user', content: prompt });
      } else {
        const parts: Array<Record<string, unknown>> = [];
        for (const block of prompt) {
          if (block.type === 'text') {
            parts.push({ type: 'text', text: block.text });
          } else if (block.type === 'image') {
            if (block.source.type === 'url') {
              parts.push({ type: 'image_url', image_url: { url: block.source.data } });
            } else {
              parts.push({ type: 'image_url', image_url: { url: `data:${block.source.mediaType};base64,${block.source.data}` } });
            }
          } else if (block.type === 'file') {
            parts.push({ type: 'text', text: `[File: ${block.path}${block.mediaType ? ` (${block.mediaType})` : ''}]` });
          }
        }
        messages.push({ role: 'user', content: parts as unknown as string });
      }

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Local LLM error ${res.status}: ${err.slice(0, 200)}`);
      }

      const data = await res.json() as { choices: Array<{ message: { content: string } }> };
      return data.choices[0]?.message?.content ?? '';
    },
  };
}
