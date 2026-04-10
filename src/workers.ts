/**
 * Worker Definitions — pluggable backends (SDK / ACP / Shell).
 * Each worker is a specialized execution unit with scoped tools and identity.
 */

import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

export type WorkerBackend = 'sdk' | 'acp' | 'shell';

export interface WorkerDefinition {
  agent: AgentDefinition;
  backend: WorkerBackend;
  /** For ACP backend: CLI command (e.g. 'claude', 'kiro-cli', 'codex') */
  acpCommand?: string;
  /** LLM vendor: 'anthropic' (default), 'anthropic-managed', 'openai', 'google', 'local' */
  vendor?: 'anthropic' | 'anthropic-managed' | 'openai' | 'google' | 'local';
  defaultTimeoutSeconds: number;
}

export const WORKERS: Record<string, WorkerDefinition> = {
  researcher: {
    agent: {
      description: 'Research a topic: read URLs, search web, read files. Returns concise summary.',
      tools: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Bash'],
      prompt: 'You are a research assistant. Read thoroughly, extract key facts, return concise summary (max 500 words). Cite sources. Never fabricate.',
      model: 'sonnet',
      maxTurns: 10,
    },
    backend: 'sdk',
    defaultTimeoutSeconds: 120,
  },

  coder: {
    agent: {
      description: 'Write, edit, or refactor code. Returns what changed and test results.',
      tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
      prompt: 'You are a coding assistant. Write clean, minimal code. Run tests after changes. Report changes and test status.',
      model: 'sonnet',
      maxTurns: 15,
    },
    backend: 'sdk',
    defaultTimeoutSeconds: 180,
  },

  reviewer: {
    agent: {
      description: 'Review code/documents for quality. Returns structured feedback.',
      tools: ['Read', 'Grep', 'Glob'],
      prompt: 'You are a reviewer. Read carefully, identify issues, provide specific actionable feedback.',
      model: 'haiku',
      maxTurns: 5,
    },
    backend: 'sdk',
    defaultTimeoutSeconds: 60,
  },

  shell: {
    agent: {
      description: 'Execute shell commands. For: tests, git ops, curl, file queries.',
      tools: ['Bash', 'Read'],
      prompt: 'Execute the command(s) and report output. Report errors if any.',
      model: 'haiku',
      maxTurns: 3,
    },
    backend: 'shell',
    defaultTimeoutSeconds: 30,
  },

  analyst: {
    agent: {
      description: 'Analyze data, compare options, produce structured reports.',
      tools: ['Read', 'Grep', 'Glob', 'WebFetch'],
      prompt: 'You are an analyst. Identify patterns, produce structured analysis with tables. Be opinionated — recommend a clear path.',
      model: 'sonnet',
      maxTurns: 8,
    },
    backend: 'sdk',
    defaultTimeoutSeconds: 120,
  },

  explorer: {
    agent: {
      description: 'Explore a codebase or system: find files, understand architecture, map dependencies.',
      tools: ['Read', 'Grep', 'Glob', 'Bash'],
      prompt: 'You are a codebase explorer. Map structure, find key files, understand architecture. Report concisely.',
      model: 'haiku',
      maxTurns: 10,
    },
    backend: 'sdk',
    defaultTimeoutSeconds: 60,
  },

  'cloud-agent': {
    agent: {
      description: 'Cloud-hosted managed agent with web search and code execution. No local tools needed — runs in Anthropic sandbox. Use for: tasks requiring internet access, running untrusted code, isolated execution.',
      tools: [],
      prompt: 'You are a cloud-hosted research and execution agent. You have web search and code execution in a sandbox. Complete the task and return results.',
      model: 'claude-sonnet-4-6',
      maxTurns: 10,
    },
    backend: 'sdk',
    vendor: 'anthropic-managed',
    defaultTimeoutSeconds: 180,
  },
};

/** Get AgentDefinitions for brain's SDK options (SDK workers only) */
export function getSdkAgentDefinitions(): Record<string, AgentDefinition> {
  const defs: Record<string, AgentDefinition> = {};
  for (const [name, w] of Object.entries(WORKERS)) {
    if (w.backend === 'sdk') defs[name] = w.agent;
  }
  return defs;
}

/** Get all available worker names */
export function getWorkerNames(): string[] {
  return Object.keys(WORKERS);
}
