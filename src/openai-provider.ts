/**
 * OpenAI Provider — GPT-4o, o1, GPT-4o-mini via OpenAI API.
 * Uses content-adapter for multimodal conversion.
 * Requires: OPENAI_API_KEY env var.
 */

import type { LLMProvider, Prompt } from './llm-provider.js';
import { toOpenAI, promptToText } from './content-adapter.js';

export interface OpenAIProviderOptions {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
}

export function createOpenAIProvider(opts?: OpenAIProviderOptions): LLMProvider {
  const model = opts?.model ?? 'gpt-4o';
  const apiKey = opts?.apiKey ?? process.env.OPENAI_API_KEY;
  const baseUrl = opts?.baseUrl ?? 'https://api.openai.com/v1';
  const maxTokens = opts?.maxTokens ?? 4096;
  const temperature = opts?.temperature ?? 0.7;

  return {
    async think(prompt: Prompt, systemPrompt: string): Promise<string> {
      if (!apiKey) throw new Error('OPENAI_API_KEY not set');

      const messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }> = [];
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });

      if (typeof prompt === 'string') {
        messages.push({ role: 'user', content: prompt });
      } else {
        messages.push({ role: 'user', content: toOpenAI(prompt) as unknown as Array<Record<string, unknown>> });
      }

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`OpenAI API error ${res.status}: ${err.slice(0, 200)}`);
      }

      const data = await res.json() as { choices: Array<{ message: { content: string } }> };
      return data.choices[0]?.message?.content ?? '';
    },
  };
}
