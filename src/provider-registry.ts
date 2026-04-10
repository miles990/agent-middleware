/**
 * Provider Registry — vendor-neutral LLM provider factory.
 *
 * Maps vendor names to provider constructors.
 * Default: anthropic (Agent SDK). Also supports: openai, google, local.
 *
 * Workers specify vendor + model → registry creates the right provider.
 */

import type { LLMProvider } from './llm-provider.js';
import { createSdkProvider, type SdkProviderOptions } from './sdk-provider.js';
import { createOpenAIProvider, type OpenAIProviderOptions } from './openai-provider.js';
import { createGoogleProvider, type GoogleProviderOptions } from './google-provider.js';
import { createLocalProvider, type LocalProviderOptions } from './local-provider.js';
import { createManagedAgentProvider, type ManagedAgentProviderOptions } from './managed-agent-provider.js';

export type Vendor = 'anthropic' | 'anthropic-managed' | 'openai' | 'google' | 'local';

export interface ProviderConfig {
  vendor: Vendor;
  model?: string;
  /** Vendor-specific options */
  options?: Record<string, unknown>;
}

/** Default models per vendor */
const VENDOR_DEFAULTS: Record<Vendor, { model: string; description: string }> = {
  'anthropic':         { model: 'sonnet', description: 'Claude (Agent SDK, subscription auth, tool use)' },
  'anthropic-managed': { model: 'claude-sonnet-4-6', description: 'Claude Managed Agents (cloud sandbox, web search, code exec, ANTHROPIC_API_KEY)' },
  'openai':            { model: 'gpt-4o', description: 'GPT-4o (OpenAI API, requires OPENAI_API_KEY)' },
  'google':            { model: 'gemini-2.0-flash', description: 'Gemini (Google AI Studio, requires GOOGLE_API_KEY)' },
  'local':             { model: 'llama3:8b', description: 'Local LLM (Ollama/llama.cpp/vLLM, requires running server)' },
};

/**
 * Create an LLM provider by vendor name.
 */
export function createProvider(config: ProviderConfig): LLMProvider {
  const model = config.model ?? VENDOR_DEFAULTS[config.vendor]?.model;

  switch (config.vendor) {
    case 'anthropic':
      return createSdkProvider({
        model,
        ...(config.options as SdkProviderOptions ?? {}),
      });

    case 'anthropic-managed':
      return createManagedAgentProvider({
        model,
        ...(config.options as ManagedAgentProviderOptions ?? {}),
      });

    case 'openai':
      return createOpenAIProvider({
        model,
        ...(config.options as OpenAIProviderOptions ?? {}),
      });

    case 'google':
      return createGoogleProvider({
        model,
        ...(config.options as GoogleProviderOptions ?? {}),
      });

    case 'local':
      return createLocalProvider({
        model,
        ...(config.options as LocalProviderOptions ?? {}),
      });

    default:
      throw new Error(`Unknown vendor: ${config.vendor}. Available: anthropic, openai, google, local`);
  }
}

/** List available vendors with default models */
export function listVendors(): Array<{ vendor: Vendor; model: string; description: string }> {
  return Object.entries(VENDOR_DEFAULTS).map(([vendor, info]) => ({
    vendor: vendor as Vendor,
    ...info,
  }));
}
