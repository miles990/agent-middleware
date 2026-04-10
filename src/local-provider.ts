/**
 * Local LLM Provider — OpenAI-compatible API (Ollama, llama.cpp, vLLM, LM Studio, MLX).
 * Uses content-adapter for multimodal conversion (vision models like LLaVA/Qwen-VL).
 * Requires: local server running on baseUrl.
 */

import type { LLMProvider, Prompt } from './llm-provider.js';
import { toOpenAI, promptToText } from './content-adapter.js';

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
      const messages: Array<{ role: string; content: unknown }> = [];
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });

      if (typeof prompt === 'string') {
        messages.push({ role: 'user', content: prompt });
      } else {
        // Use OpenAI-compatible format (works with LLaVA, Qwen-VL on Ollama)
        messages.push({ role: 'user', content: toOpenAI(prompt) });
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
