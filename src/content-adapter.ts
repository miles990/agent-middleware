/**
 * Content Adapter — 統一的 content block 轉換層。
 *
 * 中台的通用 ContentBlock ↔ 各家 AI API 的格式互轉。
 * 各家本質上都是 { role, content: [blocks] }，只是 block schema 略有不同。
 *
 * 通用格式:
 *   { type: 'text', text }
 *   { type: 'media', mediaType, source: { type: 'base64'|'url'|'file', ... } }
 *   { type: 'stream', mediaType, url, protocol }
 *   { type: 'ref', uri, mediaType }
 *
 * 各家格式:
 *   Anthropic: { type: 'text'|'image'|'document', source: { type, media_type, data } }
 *   OpenAI:    { type: 'text'|'image_url'|'input_audio', text|image_url|input_audio }
 *   Google:    { text } | { inline_data: { mime_type, data } } | { file_data: { file_uri } }
 */

import type { ContentBlock, Prompt } from './llm-provider.js';

// =============================================================================
// Target Formats
// =============================================================================

export type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'image'; source: { type: 'url'; url: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: string; data: string } };

export type OpenAIBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: string } };

export type GeminiPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } }
  | { file_data: { file_uri: string; mime_type: string } };

// =============================================================================
// Converters
// =============================================================================

/** Convert universal Prompt to plain text (fallback for providers that don't support multimodal) */
export function promptToText(prompt: Prompt): string {
  if (typeof prompt === 'string') return prompt;
  return prompt.map(b => {
    switch (b.type) {
      case 'text': return b.text;
      case 'media': return `[${b.mediaType}${b.label ? `: ${b.label}` : ''} via ${b.source.type}]`;
      case 'stream': return `[Stream: ${b.mediaType} ${b.url}]`;
      case 'ref': return `[Ref: ${b.uri}]`;
    }
  }).join('\n\n');
}

/** Convert universal ContentBlock[] to Anthropic format */
export function toAnthropic(blocks: ContentBlock[]): AnthropicBlock[] {
  const result: AnthropicBlock[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'text':
        result.push({ type: 'text', text: b.text });
        break;
      case 'media':
        if (b.mediaType.startsWith('image/')) {
          if (b.source.type === 'base64') {
            result.push({ type: 'image', source: { type: 'base64', media_type: b.mediaType, data: b.source.data } });
          } else if (b.source.type === 'url') {
            result.push({ type: 'image', source: { type: 'url', url: b.source.url } });
          } else {
            result.push({ type: 'text', text: `[Image file: ${b.source.path}]` });
          }
        } else if (b.mediaType === 'application/pdf' && b.source.type === 'base64') {
          result.push({ type: 'document', source: { type: 'base64', media_type: b.mediaType, data: b.source.data } });
        } else {
          result.push({ type: 'text', text: `[${b.mediaType}${b.label ? `: ${b.label}` : ''}]` });
        }
        break;
      case 'stream':
        result.push({ type: 'text', text: `[Stream: ${b.mediaType} ${b.url} (${b.protocol ?? 'unknown'})]` });
        break;
      case 'ref':
        result.push({ type: 'text', text: `[Ref: ${b.uri}]` });
        break;
    }
  }
  return result;
}

/** Convert universal ContentBlock[] to OpenAI format */
export function toOpenAI(blocks: ContentBlock[]): OpenAIBlock[] {
  const result: OpenAIBlock[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'text':
        result.push({ type: 'text', text: b.text });
        break;
      case 'media':
        if (b.mediaType.startsWith('image/')) {
          const url = b.source.type === 'url' ? b.source.url
            : b.source.type === 'base64' ? `data:${b.mediaType};base64,${b.source.data}`
            : `file://${b.source.path}`;
          result.push({ type: 'image_url', image_url: { url } });
        } else if (b.mediaType.startsWith('audio/') && b.source.type === 'base64') {
          const format = b.mediaType.split('/')[1] ?? 'mp3';
          result.push({ type: 'input_audio', input_audio: { data: b.source.data, format } });
        } else {
          result.push({ type: 'text', text: `[${b.mediaType}${b.label ? `: ${b.label}` : ''}]` });
        }
        break;
      case 'stream':
        result.push({ type: 'text', text: `[Stream: ${b.mediaType} ${b.url}]` });
        break;
      case 'ref':
        result.push({ type: 'text', text: `[Ref: ${b.uri}]` });
        break;
    }
  }
  return result;
}

/** Convert universal ContentBlock[] to Google Gemini format */
export function toGemini(blocks: ContentBlock[]): GeminiPart[] {
  const result: GeminiPart[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'text':
        result.push({ text: b.text });
        break;
      case 'media':
        if (b.source.type === 'base64') {
          result.push({ inline_data: { mime_type: b.mediaType, data: b.source.data } });
        } else if (b.source.type === 'url') {
          result.push({ file_data: { file_uri: b.source.url, mime_type: b.mediaType } });
        } else {
          result.push({ text: `[File: ${b.source.path} (${b.mediaType})]` });
        }
        break;
      case 'stream':
        result.push({ text: `[Stream: ${b.mediaType} ${b.url}]` });
        break;
      case 'ref':
        result.push({ text: `[Ref: ${b.uri}]` });
        break;
    }
  }
  return result;
}
