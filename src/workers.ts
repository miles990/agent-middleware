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

export type WorkerBackend = 'sdk' | 'acp' | 'shell' | 'middleware' | 'webhook' | 'logic' | 'ci-trigger';

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
  /**
   * Progress-based timeout (2026-04-17): max idle time with no observable
   * activity before stall-kill. Independent from defaultTimeoutSeconds (the
   * absolute wall-clock cap). A worker is "alive" if it produces any signal
   * (stdout/stderr write, SDK message, etc.) within this window.
   * Undefined → progress monitoring disabled for this worker.
   */
  progressTimeoutSeconds?: number;
  /** Budget per task in USD (for SDK backend). Default: 5 */
  maxBudgetUsd?: number;
  /** Shell backend: optional command allowlist. Empty = allow all (default). */
  shellAllowlist?: string[];
  /** Health check: shell command that returns exit 0 = healthy. AI can define per-worker. */
  healthCheck?: string;
  /** Health fix: shell command or instruction to restore unhealthy worker. AI can auto-dispatch to fix. */
  healthFix?: string;
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
      maxTurns: 10,
    },
    backend: 'sdk',
    maxConcurrency: 6,
    defaultTimeoutSeconds: 120,
  },

  shell: {
    agent: {
      description: 'Execute shell commands. For: tests, git ops, curl, file queries. Typical duration: <30s for quick queries, 1-5min for scripts (pnpm tsx, npm run). Progress-monitored (60s no stdout = stall-kill); hard cap 10min. Set explicit timeoutSeconds in plan step if wrapping long-running build/train tasks.',
      tools: [],
      prompt: '',
    },
    backend: 'shell',
    maxConcurrency: 4,
    defaultTimeoutSeconds: 600, // hard cap 10min (was 30s — too strict for scripts)
    progressTimeoutSeconds: 60, // stall-kill if no stdout for 60s
    healthCheck: 'echo ok',
  },

  analyst: {
    agent: {
      description: 'Analyze data, compare options, produce structured reports.',
      tools: ['Read', 'Grep', 'Glob', 'WebFetch'],
      prompt: 'You are an analyst. Identify patterns, produce structured analysis. Return structured JSON: { "summary": "...", "findings": ["..."], "confidence": 0.0-1.0 }. Use tables. Be opinionated — recommend a clear path.',
      model: 'sonnet',
      maxTurns: 12,
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

  // ─── Web Workers (L0/L1/L2 per Kuro's CDP experience) ───

  'web-fetch': {
    agent: {
      description: 'Fetch web pages/APIs (L0) via shell — pass a curl/wget command string (e.g. `curl -sf https://api.example.com/x`), NOT natural language. Fast, no browser, no JS. For JS-rendered pages use web-browser; for LLM summary use researcher.',
      tools: [],
      prompt: '',
    },
    backend: 'shell',
    maxConcurrency: 8,
    defaultTimeoutSeconds: 30,
    healthCheck: 'curl -sf --max-time 5 https://httpbin.org/get > /dev/null',
    healthFix: 'echo "Check network connection and DNS resolution"',
  },

  'web-browser': {
    agent: {
      description: 'Browser automation via CDP (L1/L2). For: JS-rendered pages, screenshots, DOM inspection, click/type/interact, form submission. Use when web-fetch is not enough (JS rendering, login, interaction needed).',
      tools: ['Read', 'Bash'],
      prompt: 'You are a browser automation agent. Use CDP (Chrome DevTools Protocol) scripts to interact with web pages. Available commands via cdp-fetch.mjs: fetch (get page content), screenshot (capture page), inspect (a11y tree), click/type (interact), watch (monitor changes), network (intercept). Return JSON: { "summary": "...", "findings": ["..."], "confidence": 0.0-1.0 }.',
      model: 'sonnet',
      maxTurns: 8,
    },
    backend: 'sdk',
    maxConcurrency: 2,  // shared Chrome — limit concurrency
    defaultTimeoutSeconds: 120,
    healthCheck: 'curl -sf --max-time 3 http://localhost:9222/json/version > /dev/null',
    healthFix: 'open -a "Google Chrome" --args --remote-debugging-port=9222 --no-first-run --no-default-browser-check',
  },

  'web-verify': {
    agent: {
      description: 'Verify a web page visually — screenshot + check page loaded correctly. HTTP 200 ≠ page OK. Use after deploy or when checking if a page renders correctly.',
      tools: [],
      prompt: '',
    },
    backend: 'shell',
    maxConcurrency: 4,
    defaultTimeoutSeconds: 30,
    healthCheck: 'curl -sf --max-time 3 http://localhost:9222/json/version > /dev/null',
    healthFix: 'open -a "Google Chrome" --args --remote-debugging-port=9222 --no-first-run --no-default-browser-check',
  },

  // ─── Cognitive Workers (mini-agent capability map: learn / create) ───
  // Researcher extracts facts; learn extracts principles for the agent's own model.
  // Coder writes code; create produces written/conceptual artifacts (essays, plans, ideas).

  learn: {
    agent: {
      description: 'Internalize a topic — extract principles, mental models, and connections (not just facts). Use when the agent needs to understand HOW something works, not just WHAT it is. For fact extraction use researcher.',
      tools: ['Read', 'Grep', 'Glob', 'WebFetch', 'Bash'],
      prompt: 'You are a learning assistant. Read deeply, identify underlying principles, name the mental model. Return structured JSON: { "summary": "the principle in one sentence", "findings": ["mental model", "key distinctions", "connections to known concepts"], "confidence": 0.0-1.0 }. Prefer depth over breadth.',
      model: 'haiku',
      maxTurns: 5,
    },
    backend: 'sdk',
    maxConcurrency: 4,
    defaultTimeoutSeconds: 300,
  },

  create: {
    agent: {
      description: 'Produce written or conceptual artifacts — essays, plans, designs, content drafts. For code use coder; for analysis use analyst.',
      tools: ['Read', 'Write', 'Edit', 'Glob'],
      prompt: 'You are a creator. Produce a coherent artifact with voice and structure. Return structured JSON: { "summary": "what you made", "artifacts": [{"type":"file","path":"..."}], "findings": ["design choices made", "tradeoffs considered"], "confidence": 0.0-1.0 }. Prefer fewer, sharper words over more.',
      model: 'sonnet',
      maxTurns: 8,
    },
    backend: 'sdk',
    maxConcurrency: 3,
    defaultTimeoutSeconds: 480,
  },

  planner: {
    agent: {
      description: 'Decompose a goal into an executable DAG of nodes (id / worker / task / dependsOn / acceptance). For architecture / strategy use analyst; for actual execution submit the plan back via /plan.',
      tools: ['Read', 'Grep', 'Glob', 'WebFetch'],
      prompt: 'You are a planner. Given a goal, produce a DAG plan. Nodes: { id, worker, task, dependsOn?, acceptance }. Keep nodes atomic and parallel where possible. Use `acceptance` (convergence condition) not time estimates. Return structured JSON: { "summary": "...", "artifacts": [{"type":"plan","nodes":[...]}], "findings": ["assumptions made", "risks"], "confidence": 0.0-1.0 }.',
      model: 'sonnet',
      maxTurns: 10,
    },
    backend: 'sdk',
    maxConcurrency: 4,
    defaultTimeoutSeconds: 240,
  },

  debugger: {
    agent: {
      description: 'Investigate a bug or failure — form hypotheses, gather evidence, find root cause. For writing fixes use coder; for code review use reviewer.',
      tools: ['Read', 'Grep', 'Glob', 'Bash'],
      prompt: 'You are a debugger. Start from the symptom, form ranked hypotheses, gather evidence (logs, repro, file reads), converge on root cause. Do not patch — report the cause. Return structured JSON: { "summary": "root cause in one sentence", "findings": ["hypothesis tested", "evidence", "ruled-out paths"], "artifacts": [{"type":"file","path":"..."}], "confidence": 0.0-1.0 }.',
      model: 'sonnet',
      maxTurns: 12,
    },
    backend: 'sdk',
    maxConcurrency: 4,
    defaultTimeoutSeconds: 300,
  },

  // ─── Agent Runtime Essentials (predefined system workers, 2026-04-17) ───
  // Per Alex "預設系統 workers 固化" — these are bundled defaults that let
  // agents externalize preprocess/triage/extract work without per-instance forge.
  // Use Haiku for speed + cost; strict JSON output for reliable parsing.

  summarizer: {
    agent: {
      description: 'Text summarizer. Input: arbitrary text (log, chat, document, perception output). Output JSON: {summary, key_points[], confidence}. Keeps summaries 1-3 sentences. Use for: perception summarization (externalize from local oMLX), conversation digest, delegate result summary. NOT for: code analysis (use reviewer), deep research (use learn).',
      tools: [],
      prompt: 'You are a text summarizer. Produce JSON matching {summary: string (1-3 sentences), key_points: string[] (3-7 bullet items), confidence: 0-1}. Be faithful to source — no hallucination. Return ONLY JSON, no prose.',
      model: 'haiku',
      maxTurns: 3,
    },
    backend: 'sdk',
    maxConcurrency: 6,
    defaultTimeoutSeconds: 60,
  },

  classifier: {
    agent: {
      description: 'Text classifier. Input JSON: {text, labels: string[]}. Output JSON: {label, confidence, rationale}. Picks one label from provided list. Use for: inbox triage (critical/normal/spam), sentiment, intent, routing decisions. NOT for: open-ended categorization (use analyst) or rubric-based scoring (use scorer).',
      tools: [],
      prompt: 'You are a classifier. Input is JSON {text, labels}. Pick ONE label from labels[] that best matches text. Return JSON {label: string, confidence: 0-1, rationale: string (≤1 sentence)}. If no label fits well, pick closest + low confidence + explain. Return ONLY JSON.',
      model: 'haiku',
      maxTurns: 3,
    },
    backend: 'sdk',
    maxConcurrency: 6,
    defaultTimeoutSeconds: 60,
  },

  extractor: {
    agent: {
      description: 'Structured data extractor. Input JSON: {text, schema: {field_name: description}}. Output JSON: {extracted: {field: value}, missing: string[], confidence}. Use for: parse unstructured output into structured, pull specific fields from documents, convert chat to task entries. NOT for: transformation (use coder), general summarization (use summarizer).',
      tools: [],
      prompt: 'You are a structured extractor. Input is JSON {text, schema}. For each schema key, extract the value from text. Return JSON {extracted: object matching schema keys, missing: string[] of keys unfilled, confidence: 0-1}. Use null for values not in source (never fabricate). Return ONLY JSON.',
      model: 'haiku',
      maxTurns: 3,
    },
    backend: 'sdk',
    maxConcurrency: 4,
    defaultTimeoutSeconds: 60,
  },

  // ─── Agent Brain (per brain-only-kuro-v2 Layer C, 2026-04-17) ───
  // Bare Claude Opus passthrough — accepts caller's full prompt as-is, no
  // middleware system prompt override. Used when agent (e.g. Kuro) wants to
  // offload cycle LLM iteration from its own event loop: agent POSTs prompt
  // to /dispatch, polls /status, and only receives final result — zero
  // for-await iteration in agent's main thread.
  //
  // Trade-off: adds ~100ms network round-trip for dispatch + polling overhead,
  // but completely decouples agent event loop from SDK subprocess iteration.
  // Solves 160s loop-lag catastrophe observed when SDK runs in-process.

  'agent-brain': {
    agent: {
      description: 'Bare Claude Opus passthrough. Accepts caller-supplied full prompt as-is (no middleware system prompt override, no tool scope override). For agent cycle LLM calls where the caller owns the prompt and only wants to offload the iteration overhead.',
      tools: [],
      prompt: '',
      model: 'claude-opus-4-7',
      maxTurns: 30,
    },
    backend: 'sdk',
    maxConcurrency: 2,
    defaultTimeoutSeconds: 1500,
  },

  // ─── CI Trigger (per brain-only-kuro-v2 Phase F T22) ───
  // Bridges agent DAG and GitHub Actions. Input is JSON string with workflow + inputs.
  // Auth via local `gh` CLI (keyring token) — no API key env needed on middleware host.

  'ci-trigger': {
    agent: {
      description: 'Trigger GitHub Actions workflow and wait for result. Input (JSON string): {workflow: "deploy.yml", ref?: "main", inputs?: {key:"value"}, repo?: "owner/name", poll_timeout_sec?: 1200, poll_interval_sec?: 10}. Output (JSON string): {ok, run_id, status, conclusion, html_url, elapsed_sec, error?}. Use when DAG step needs to trigger CI/CD workflow and synchronize on its outcome.',
      tools: [],
      prompt: '',
    },
    backend: 'ci-trigger',
    maxConcurrency: 4,
    defaultTimeoutSeconds: 1500, // 25min — workflow + polling upper bound
    healthCheck: 'gh auth status > /dev/null 2>&1',
    healthFix: 'gh auth login',
  },

  // ─── Judgment Workers (rubric-driven, per brain-only-kuro-v2 Phase C T3) ───
  // Agent provides the rubric (taste source); scorer applies mechanically.
  // Used by: needs-attention filter (T4), KG bridge judgment, webhook severity,
  //          audit-worthiness assessment, DAG improvement digest scoring.

  scorer: {
    agent: {
      description: 'Rubric-driven scorer. Accept {items, rubric, output_shape} and apply the rubric to score/rank/filter items mechanically. Return strict JSON matching output_shape. Use when agent needs rubric-based sorting/filtering/judging without hard-coded thresholds. NEVER override the rubric — it is the agent\'s taste, your job is pure application.',
      tools: ['Read'],
      prompt: 'You are a scorer. Apply the provided rubric to the items and return strict JSON matching the specified output_shape. Principles: (1) The rubric IS the truth — never override, infer, or second-guess it. (2) Be conservative — unsure cases get confidence < 0.7 with rationale. (3) Preserve item identity — never drop items silently; use {keep:false, reason:"..."} instead. (4) Return ONLY JSON matching output_shape — no prose, no markdown fences, no explanations outside structured output. (5) If rubric is ambiguous for a specific item, include with confidence < 0.5 and explain the ambiguity in the rationale field.',
      model: 'haiku',
      maxTurns: 3,
    },
    backend: 'sdk',
    maxConcurrency: 4,
    defaultTimeoutSeconds: 60,
  },

  // ─── Auth Workers ───

  'google-oauth': {
    agent: {
      description: 'Google OAuth login via CDP (Chrome DevTools Protocol). Actions: check (verify login state), login (full OAuth flow), login <service-url> (OAuth on a specific service), cookies (dump auth cookies). Outputs NDJSON step-by-step diagnostics with screenshots. Exit 0=success, 1=failure, 2=needs human (2FA/CAPTCHA).',
      tools: [],
      prompt: '',
    },
    backend: 'shell',
    maxConcurrency: 1,  // shared Chrome — only one auth flow at a time
    defaultTimeoutSeconds: 60,
    healthCheck: 'curl -sf --max-time 3 http://localhost:9222/json/version > /dev/null',
    healthFix: 'open -a "Google Chrome" --args --remote-debugging-port=9222 --no-first-run --no-default-browser-check --user-data-dir=$HOME/.mini-agent/chrome-cdp-profile',
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
