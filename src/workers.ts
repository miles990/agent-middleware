/**
 * Worker Definitions — pluggable backends (SDK / ACP / Shell).
 * Each worker is a specialized execution unit with scoped tools and identity.
 *
 * Timeout philosophy:
 * - SDK workers: maxTurns is the real scope control. Timeout is a safety net,
 *   auto-derived from maxTurns (2min/turn) at execution time. defaultTimeoutSeconds
 *   is only a fallback for non-plan dispatch.
 * - Shell workers: timeout is the real control (deterministic execution).
 */

import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

export type WorkerBackend = 'sdk' | 'acp' | 'shell' | 'middleware' | 'webhook' | 'logic';

export interface WorkerDefinition {
  agent: AgentDefinition;
  backend: WorkerBackend;
  /** For ACP backend: CLI command (e.g. 'claude', 'kiro-cli', 'codex') */
  acpCommand?: string;
  /** For middleware backend: URL of upstream middleware */
  middlewareUrl?: string;
  /** For middleware backend: worker name on the upstream middleware */
  middlewareWorker?: string;
  /** For webhook backend: HTTP config */
  webhook?: {
    url: string;
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    headers?: Record<string, string>;
    /** Template: {{input}} replaced with task content */
    bodyTemplate?: string;
    /** jq-style path to extract result from response (default: entire body) */
    resultPath?: string;
  };
  /** For logic backend: inline JS/TS function body (receives `input` and `context` args) */
  logicFn?: string;
  /** LLM vendor: 'anthropic' (default), 'anthropic-managed', 'openai', 'google', 'local' */
  vendor?: 'anthropic' | 'anthropic-managed' | 'openai' | 'google' | 'local';
  /** Max concurrent instances of this worker type (readers=high, writers=low) */
  maxConcurrency?: number;
  /** Fallback timeout for non-plan dispatch. For SDK workers in plans, actual timeout = max(this, maxTurns * 120s) */
  defaultTimeoutSeconds: number;
  /** Budget per task in USD (for SDK backend). Default: 5 */
  maxBudgetUsd?: number;
  /** MCP servers available to this worker — gives access to external tools (DB, browser, APIs, cross-agent comms) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mcpServers?: Record<string, any>;
  /** Skills (markdown prompts) injected into worker's system prompt — worker-scoped, not agent-scoped */
  skills?: string[];
}

export const WORKERS: Record<string, WorkerDefinition> = {
  researcher: {
    agent: {
      description: 'Research a topic: read URLs, search web, read files. Returns concise summary.',
      tools: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Bash'],
      prompt: 'You are a research assistant. Read thoroughly, extract key facts. Return structured JSON: { "summary": "...", "findings": ["..."], "confidence": 0.0-1.0 }. Cite sources. Never fabricate.',
      model: 'sonnet',
      maxTurns: 10,
    },
    backend: 'sdk',
    maxConcurrency: 8,
    defaultTimeoutSeconds: 300,
  },

  coder: {
    agent: {
      description: 'Write, edit, or refactor code. Returns what changed and test results.',
      tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
      prompt: 'You are a coding assistant. Write clean, minimal code. Run tests after changes. Return structured JSON: { "summary": "what changed", "artifacts": [{"type":"file","path":"..."}], "findings": ["test results"], "confidence": 0.0-1.0 }.',
      model: 'sonnet',
      maxTurns: 15,
    },
    backend: 'sdk',
    maxConcurrency: 2,
    defaultTimeoutSeconds: 300,
  },

  reviewer: {
    agent: {
      description: 'Review code/documents for quality. Returns structured feedback.',
      tools: ['Read', 'Grep', 'Glob'],
      prompt: 'You are a reviewer. Read carefully, identify issues. Return structured JSON: { "summary": "...", "findings": ["issue1", "issue2"], "confidence": 0.0-1.0 }.',
      model: 'haiku',
      maxTurns: 5,
    },
    backend: 'sdk',
    maxConcurrency: 6,
    defaultTimeoutSeconds: 120,
  },

  shell: {
    agent: {
      description: 'Execute shell commands. For: tests, git ops, curl, file queries.',
      tools: [],
      prompt: '',
    },
    backend: 'shell',
    maxConcurrency: 4,
    defaultTimeoutSeconds: 30,
  },

  analyst: {
    agent: {
      description: 'Analyze data, compare options, produce structured reports.',
      tools: ['Read', 'Grep', 'Glob', 'WebFetch'],
      prompt: 'You are an analyst. Identify patterns, produce structured analysis. Return structured JSON: { "summary": "...", "findings": ["..."], "confidence": 0.0-1.0 }. Use tables. Be opinionated — recommend a clear path.',
      model: 'sonnet',
      maxTurns: 8,
    },
    backend: 'sdk',
    maxConcurrency: 4,
    defaultTimeoutSeconds: 300,
  },

  explorer: {
    agent: {
      description: 'Explore a codebase or system: find files, understand architecture, map dependencies.',
      tools: ['Read', 'Grep', 'Glob', 'Bash'],
      prompt: 'You are a codebase explorer. Map structure, find key files, understand architecture. Return structured JSON: { "summary": "...", "findings": ["..."], "confidence": 0.0-1.0 }.',
      model: 'haiku',
      maxTurns: 10,
    },
    backend: 'sdk',
    maxConcurrency: 8,
    defaultTimeoutSeconds: 120,
  },

  'cloud-agent': {
    agent: {
      description: 'Cloud-hosted managed agent with web search and code execution. No local tools needed — runs in Anthropic sandbox. Use for: tasks requiring internet access, running untrusted code, isolated execution.',
      tools: [],
      prompt: '',
    },
    backend: 'sdk',
    vendor: 'anthropic-managed',
    maxConcurrency: 4,
    defaultTimeoutSeconds: 300,
  },
};

// ─── Runtime Worker Registry ───

const customWorkers: Record<string, WorkerDefinition> = {};

export function allWorkers(): Record<string, WorkerDefinition> {
  return { ...WORKERS, ...customWorkers };
}

export function getWorkerNames(): string[] {
  return Object.keys(allWorkers());
}

export function addCustomWorker(name: string, def: WorkerDefinition): void {
  customWorkers[name] = def;
}

export function removeCustomWorker(name: string): boolean {
  if (WORKERS[name]) return false;
  delete customWorkers[name];
  return true;
}

/** Get SDK agent definitions for brain planning context */
export function getSdkAgentDefinitions(): Record<string, { description: string; tools: string[]; model?: string; prompt?: string }> {
  const result: Record<string, { description: string; tools: string[]; model?: string; prompt?: string }> = {};
  for (const [name, def] of Object.entries(allWorkers())) {
    if (def.backend === 'sdk' || def.backend === 'acp') {
      result[name] = { description: def.agent.description ?? '', tools: (def.agent.tools ?? []) as string[], model: def.agent.model, prompt: def.agent.prompt };
    }
  }
  return result;
}
