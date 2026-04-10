/**
 * Google Gemini Provider — Gemini 2.0 Pro/Flash via Google AI Studio API.
 * Requires: GOOGLE_API_KEY env var.
 */

import type { LLMProvider, Prompt } from './llm-provider.js';

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

      const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];

      // Gemini uses system_instruction for system prompt
      const promptStr = typeof prompt === 'string'
        ? prompt
        : prompt.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n\n');

      contents.push({ role: 'user', parts: [{ text: promptStr }] });

      // Handle multimodal content
      if (typeof prompt !== 'string') {
        for (const block of prompt) {
          if (block.type === 'image') {
            if (block.source.type === 'base64') {
              contents[0].parts.push({
                inline_data: { mime_type: block.source.mediaType, data: block.source.data },
              });
            } else {
              // URL images — Gemini supports file_data for GCS URIs, fallback to text ref
              contents[0].parts.push({ text: `[Image URL: ${block.source.data}]` });
            }
          } else if (block.type === 'file') {
            contents[0].parts.push({ text: `[File: ${block.path}${block.mediaType ? ` (${block.mediaType})` : ''}]` });
          }
        }
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
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
