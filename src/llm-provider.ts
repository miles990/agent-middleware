/**
 * LLM Provider — abstraction over execution backends.
 * Brain and workers both use this interface.
 */
export interface LLMProvider {
  think(prompt: string, systemPrompt: string): Promise<string>;
}
