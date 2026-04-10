// Agent Middleware — public API

// Core types
export type { LLMProvider, Prompt, ContentBlock, TextContent, MediaContent, StreamContent, RefContent, StructuredResponse, StreamChunk, ImageSource } from './llm-provider.js';
export { toAnthropic, toOpenAI, toGemini, promptToText } from './content-adapter.js';
export type { AnthropicBlock, OpenAIBlock, GeminiPart } from './content-adapter.js';
export type { ActionPlan, PlanStep, PlanResult, StepResult, WorkerExecutor } from './plan-engine.js';
export type { TaskRecord, TaskStatus, TaskEvent } from './result-buffer.js';
export type { WorkerBackend, WorkerDefinition } from './workers.js';
export type { SdkProviderOptions } from './sdk-provider.js';
// Implementations
export { PlanEngine, parsePlan } from './plan-engine.js';
export { ResultBuffer } from './result-buffer.js';
export { WORKERS, getSdkAgentDefinitions, getWorkerNames } from './workers.js';
export { createSdkProvider } from './sdk-provider.js';
export { createOpenAIProvider } from './openai-provider.js';
export { createGoogleProvider } from './google-provider.js';
export { createLocalProvider } from './local-provider.js';
export { createManagedAgentProvider } from './managed-agent-provider.js';
export type { ManagedAgentProviderOptions } from './managed-agent-provider.js';
export { createProvider, listVendors } from './provider-registry.js';
export type { Vendor, ProviderConfig } from './provider-registry.js';
export { createBrain, brainPlan, brainDigest } from './brain.js';
export type { BrainConfig } from './brain.js';
export type { StructuredOutput } from './plan-engine.js';
export { PresetManager, type WorkerPreset } from './presets.js';
export { ACPGateway, createGateway, DEFAULT_BACKENDS } from './acp-gateway.js';
export type { CLIBackend, ACPSession, GatewayStats } from './acp-gateway.js';
export { createRouter, createMiddleware } from './api.js';
