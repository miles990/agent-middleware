/**
 * Google Gemini Provider — Gemini 2.0 Pro/Flash via Google AI Studio API.
 * Uses content-adapter for multimodal conversion.
 * Requires: GOOGLE_API_KEY env var.
 */

import type { LLMProvider, Prompt } from './llm-provider.js';
import { toGemini, promptToText } from './content-adapter.js';

export interface GoogleProviderOptions {
  model?: string;
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
}

export function createGoogleProvider(opts?: GoogleProviderOptions): LLMProvider {
  const model = opts?.model ?? 'gemini-2.0-flash';
  const apiKey = opts?.apiKey ?? process.env.GOOGLE_API_KEY;
  const maxTokens = opts?.maxTokens ?? 4096;
  const temperature = opts?.temperature ?? 0.7;

  return {
    async think(prompt: Prompt, systemPrompt: string): Promise<string> {
      if (!apiKey) throw new Error('GOOGLE_API_KEY not set');

      const parts = typeof prompt === 'string'
        ? [{ text: prompt }]
        : toGemini(prompt);

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
          generationConfig: { maxOutputTokens: maxTokens, temperature },
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Gemini API error ${res.status}: ${err.slice(0, 200)}`);
      }

      const data = await res.json() as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
      return data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? '';
    },
  };
}
