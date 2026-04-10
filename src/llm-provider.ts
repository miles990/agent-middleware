/**
 * LLM Provider — abstraction over execution backends.
 * Brain and workers both use this interface.
 */

/** Content block — supports multimodal input (text, image, file) */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: ImageSource }
  | { type: 'file'; path: string; mediaType?: string };

export interface ImageSource {
  /** 'base64' for inline, 'url' for remote */
  type: 'base64' | 'url';
  /** MIME type: image/png, image/jpeg, image/gif, image/webp */
  mediaType: string;
  /** base64 data or URL */
  data: string;
}

/** Prompt can be a simple string or multimodal content blocks */
export type Prompt = string | ContentBlock[];

export interface LLMProvider {
  think(prompt: Prompt, systemPrompt: string): Promise<string>;
}
