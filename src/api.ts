/**
 * Middleware HTTP API — agent-agnostic, any caller can use.
 *
 * POST /dispatch      — single task
 * POST /plan          — action plan (DAG)
 * GET  /status/:id    — task status
 * GET  /plan/:id      — plan status + all steps
 * GET  /pool          — worker pool status
 * GET  /events        — SSE event stream
 * DELETE /task/:id    — cancel task
 * GET  /health        — health check
 * GET  /workers       — list all workers
 * POST /workers       — add custom worker
 * PUT  /workers/:name — update worker
 * DELETE /workers/:name — remove worker
 * GET  /dashboard     — management UI
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlanEngine, parsePlan, type ActionPlan, type StepResult } from './plan-engine.js';
import { ResultBuffer, classifyEventSeverity, type TaskEvent, type TaskRecord, type TaskStatus, type EventSeverity } from './result-buffer.js';
import { HookRegistry, WebhookDispatcher, type HookEventPattern, type HookInput } from './webhook-dispatcher.js';
import { triggerAndWait as ciTriggerAndWait } from './ci-trigger.js';
import { execShellWithProgress, withProgressTimeout } from './progress-timeout.js';
import { WORKERS, getWorkerNames, allWorkers, type WorkerDefinition } from './workers.js';
import { createSdkProvider } from './sdk-provider.js';
import { createProvider, type Vendor } from './provider-registry.js';
import { PresetManager } from './presets.js';
import { createGateway, type ACPGateway, type CLIBackend } from './acp-gateway.js';
import type { LLMProvider } from './llm-provider.js';
import { PLAN_TEMPLATES } from './templates.js';
import { execSync, execFileSync } from 'node:child_process';
import { brainPlan, brainDigest, type WorkerInfo } from './brain.js';
import { openStore as openCommitmentStore, validateInput as validateCommitmentInput, type CommitmentStatus, type CommitmentChannel, type CommitmentOwner, type CommitmentPatch } from './commitment-ledger.js';
import * as forgeClient from './forge-client.js';
import { ForgeError } from './forge-client.js';

// Auth middleware — Bearer token from MIDDLEWARE_API_KEY env
const API_KEY = process.env.MIDDLEWARE_API_KEY;
function authMiddleware(c: { req: { header: (name: string) => string | undefined }; json: (body: unknown, status: number) => Response }, next: () => Promise<void | Response>): Promise<void | Response> {
  if (!API_KEY) return next(); // no key configured → open access (dev mode)
  const auth = c.req.header('Authorization');
  if (auth === `Bearer ${API_KEY}`) return next();
  return Promise.resolve(c.json({ error: 'Unauthorized' }, 401));
}

// =============================================================================
// Middleware Instance
// =============================================================================

export interface MiddlewareConfig {
  cwd?: string;
}

export interface PlanHistoryRecord {
  planId: string;
  createdAt: string;
  caller?: string;
  plan?: ActionPlan;
  event?: 'created' | 'completed' | 'failed';
  /** Terminal events: result summary */
  summary?: { completed: number; failed: number; skipped: number };
  /** Terminal events: overall acceptance status */
  accepted?: boolean | null;
  convergenceIterations?: number;
  durationMs?: number;
}

export interface RecoveryOption {
  action: 'wait_and_retry' | 'alternative_approach' | 'escalate' | 'abort';
  description: string;
  confidence: number;
  wait_ms?: number;
  why?: string;
}

export function createMiddleware(config?: MiddlewareConfig) {
  const cwd = config?.cwd ?? process.cwd();
  const buffer = new ResultBuffer();
  buffer.enablePersistence(cwd);

  // T16/T17/T18: webhook dispatcher — outbound event hooks with registry,
  // HMAC signing, retry + DLQ, batching. Subscribes to buffer events.
  const hookRegistry = new HookRegistry();
  const webhookDispatcher = new WebhookDispatcher(hookRegistry);
  webhookDispatcher.enablePersistence(cwd);
  buffer.subscribe((event) => { webhookDispatcher.onTaskEvent(event); });
  webhookDispatcher.start();
  const customWorkers = new Map<string, WorkerDefinition>();

  // Load persisted custom workers
  const customWorkersPath = path.join(cwd, 'workers.json');
  try {
    const raw = fs.readFileSync(customWorkersPath, 'utf-8');
    const saved = JSON.parse(raw) as Record<string, WorkerDefinition>;
    for (const [name, def] of Object.entries(saved)) {
      customWorkers.set(name, def);
    }
  } catch { /* no saved workers — normal on first run */ }

  // ACP Gateway — session pool for cross-CLI backends
  const acpGateway = createGateway();

  // Preset Manager — templates for quick worker creation
  const presetManager = new PresetManager(cwd);

  const persistCustomWorkers = () => {
    try {
      const obj: Record<string, WorkerDefinition> = {};
      for (const [name, def] of customWorkers) obj[name] = def;
      fs.writeFileSync(customWorkersPath, JSON.stringify(obj, null, 2), 'utf-8');
    } catch { /* fail-open */ }
  };

  // Create per-worker LLM providers (built-in + custom)
  const workerProviders = new Map<string, LLMProvider>();
  const allWorkers = (): Record<string, WorkerDefinition> => {
    const all = { ...WORKERS };
    for (const [name, def] of customWorkers) all[name] = def;
    return all;
  };

  for (const [name, def] of Object.entries(allWorkers())) {
    if (def.backend === 'sdk' || def.backend === 'acp') {
      // Use vendor from worker def, default to anthropic
      const vendor = def.vendor ?? 'anthropic';
      if (vendor === 'anthropic') {
        // Anthropic uses Agent SDK (has tools, subagents, permissions)
        workerProviders.set(name, createSdkProvider({
          model: def.agent.model ?? 'sonnet',
          cwd,
          allowedTools: def.agent.tools as string[] | undefined,
          maxTurns: def.agent.maxTurns,
          maxBudgetUsd: def.maxBudgetUsd ?? 5,
          mcpServers: def.mcpServers,
        }));
      } else {
        // Other vendors (openai, google, local, anthropic-managed) use direct API
        workerProviders.set(name, createProvider({
          vendor: vendor as import('./provider-registry.js').Vendor,
          model: def.agent.model,
        }));
      }
    }
  }

  // Compose worker prompt with skills at runtime — never mutate def.agent.prompt
  const composePrompt = (def: WorkerDefinition): string => {
    const base = def.agent.prompt ?? '';
    if (!def.skills?.length) return base;
    return `${base}\n\n<skills>\n${def.skills.join('\n---\n')}\n</skills>`;
  };

  // Worker executor — routes to correct backend (built-in + custom), supports multimodal.
  // opts.cwd: per-task workdir override (validated at /dispatch + /plan boundary).
  const executeWorker = async (
    worker: string,
    task: string | import('./llm-provider.js').ContentBlock[],
    timeoutMs: number,
    opts?: { cwd?: string; acceptableExitCodes?: number[] },
  ): Promise<string> => {
    const def = allWorkers()[worker];
    if (!def) throw new Error(`Unknown worker: ${worker}`);
    const taskCwd = opts?.cwd;

    switch (def.backend) {
      case 'sdk': {
        const provider = workerProviders.get(worker);
        if (!provider) throw new Error(`No SDK provider for worker: ${worker}`);
        // SDK workers: two-tier timeout (2026-04-17 per Alex framing).
        //   - hard cap: max(caller's timeoutMs, maxTurns * 120s) — absolute wall-clock
        //   - progress cap: worker.progressTimeoutSeconds or default 120s — stall detect
        //     (each SDK yielded message resets the stall timer via onActivity)
        const maxTurns = def.agent.maxTurns ?? 10;
        const hardMs = Math.max(timeoutMs, maxTurns * 120_000);
        const progressMs = (def.progressTimeoutSeconds ?? 120) * 1000;
        return withProgressTimeout(
          (signal, markActive) => provider.think(task, composePrompt(def), {
            cwd: taskCwd,
            signal,
            onActivity: markActive,
          }),
          { progressMs, hardMs },
        );
      }
      case 'shell': {
        // Two input formats supported (Constraint Texture: shell = POSIX process, not LLM prompt):
        //
        //   1. LEGACY string: task = "ls -la && cat foo.json"
        //      Full bash string, all dependencies must be inlined (escape hell for JSON).
        //
        //   2. STRUCTURED workspace: task = ContentBlock[] containing a JSON block
        //      { "command": "...", "workspace": { "files": {...}, "env": {...}, "stdin": "..." } }
        //      Middleware creates scratch dir, writes files, pipes stdin, executes command.
        //      Dependencies ({{stepId.result}}) are resolved BEFORE this layer by plan engine,
        //      so workspace.files values are already-resolved strings.
        //
        // Detection: if task is a ContentBlock[] with a single text block whose first char is '{'
        // AND parses to an object with a "command" field → structured mode.
        // Otherwise → legacy mode.

        const tryParseStructured = (): {
          command: string;
          workspace?: {
            files?: Record<string, string>;
            env?: Record<string, string>;
            stdin?: string;
          };
        } | null => {
          let raw: string;
          if (typeof task === 'string') {
            raw = task.trim();
          } else {
            const textBlock = task.find(b => b.type === 'text');
            if (!textBlock) return null;
            raw = (textBlock as { text: string }).text.trim();
          }
          if (!raw.startsWith('{')) return null;
          try {
            const parsed = JSON.parse(raw) as { command?: unknown; workspace?: unknown };
            if (typeof parsed.command !== 'string') return null;
            return parsed as { command: string; workspace?: { files?: Record<string, string>; env?: Record<string, string>; stdin?: string } };
          } catch {
            return null;
          }
        };

        const structured = tryParseStructured();

        if (structured) {
          // Structured workspace mode — middleware manages scratch dir + deps.
          const fsMod = await import('node:fs');
          const pathMod = await import('node:path');
          const osMod = await import('node:os');
          const scratchDir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'mw-shell-'));
          try {
            // Write dependency files
            if (structured.workspace?.files) {
              for (const [filename, content] of Object.entries(structured.workspace.files)) {
                // Prevent path traversal — files must be relative and contain no ..
                if (filename.includes('..') || pathMod.isAbsolute(filename)) {
                  throw new Error(`Invalid file path in workspace.files: ${filename}`);
                }
                const fullPath = pathMod.join(scratchDir, filename);
                fsMod.mkdirSync(pathMod.dirname(fullPath), { recursive: true });
                fsMod.writeFileSync(fullPath, content, 'utf-8');
              }
            }
            // Execute command in scratch dir with optional env + stdin
            const execOpts: Parameters<typeof execSync>[1] = {
              cwd: scratchDir,
              timeout: timeoutMs,
              encoding: 'utf-8',
              maxBuffer: 2 * 1024 * 1024,
              shell: '/bin/bash',
              env: { ...process.env, ...(structured.workspace?.env ?? {}) },
            };
            if (structured.workspace?.stdin !== undefined) {
              (execOpts as Record<string, unknown>).input = structured.workspace.stdin;
            }
            return execSync(structured.command, execOpts) as string;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const e = err as { stdout?: Buffer|string; stderr?: Buffer|string; status?: number; signal?: string };
            const stderr = e.stderr ? String(e.stderr).slice(0, 500) : '';
            const stdout = e.stdout ? String(e.stdout).slice(0, 200) : '';
            console.error(`[worker:shell-structured] FAIL worker=${worker} cwd=${scratchDir} timeoutMs=${timeoutMs} cmd=${structured.command.slice(0, 200)} status=${e.status ?? '-'} signal=${e.signal ?? '-'} stderr=${stderr} stdout=${stdout} err=${msg.slice(0, 200)}`);
            throw new Error(`Shell error (structured): ${msg.slice(0, 500)}`);
          } finally {
            // Always clean up scratch dir
            try { fsMod.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best-effort */ }
          }
        }

        // Legacy string mode — preserved for backward compatibility.
        // taskCwd overrides middleware root cwd (validated at dispatch boundary).
        // Two-tier timeout (per 2026-04-17 Alex framing): progress (stall-kill)
        // + hard (wall-clock). See src/progress-timeout.ts.
        const execCwd = taskCwd ?? cwd;
        const shellCmd = typeof task === 'string' ? task : task.filter(b => b.type === 'text').map(b => (b as {text:string}).text).join('\n');
        if (def.shellAllowlist?.length) {
          const parts = shellCmd.trim().split(/\s+/);
          const cmdBase = parts[0];
          if (!def.shellAllowlist.some(a => cmdBase === a || cmdBase.endsWith(`/${a}`))) {
            throw new Error(`Shell command "${cmdBase}" not in allowlist: ${def.shellAllowlist.join(', ')}`);
          }
          // Allowlist mode keeps execFileSync (no shell features needed).
          try {
            return execFileSync(cmdBase, parts.slice(1), { cwd: execCwd, timeout: timeoutMs, encoding: 'utf-8', maxBuffer: 2 * 1024 * 1024 });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`Shell error (allowlist): ${msg.slice(0, 500)}`);
          }
        }
        // No allowlist → trusted agent, full shell features via progress-timeout helper.
        // progressMs from worker config (default 60s if not set; undefined disables stall-kill).
        const progressMs = (def.progressTimeoutSeconds ?? 60) * 1000;
        try {
          return await execShellWithProgress(shellCmd, {
            cwd: execCwd,
            progressMs,
            hardMs: timeoutMs,
            ...(opts?.acceptableExitCodes ? { acceptableExitCodes: opts.acceptableExitCodes } : {}),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const cmdPreview = shellCmd.slice(0, 200);
          console.error(`[worker:shell] FAIL worker=${worker} cwd=${execCwd} progressMs=${progressMs} hardMs=${timeoutMs} cmd=${cmdPreview} err=${msg.slice(0, 300)}`);
          throw new Error(`Shell error: ${msg.slice(0, 500)}`);
        }
      }
      case 'acp': {
        const acpCommand = def.acpCommand ?? 'claude';
        const taskStr = typeof task === 'string' ? task : JSON.stringify(task);
        return acpGateway.dispatch(acpCommand, taskStr, timeoutMs);
      }
      case 'webhook': {
        // HTTP API call — like n8n's HTTP node
        const wh = def.webhook;
        if (!wh?.url) throw new Error(`Worker ${worker}: webhook.url not configured`);
        const method = wh.method ?? 'GET';
        const taskStr = typeof task === 'string' ? task : JSON.stringify(task);
        const body = method !== 'GET'
          ? (wh.bodyTemplate ? wh.bodyTemplate.replace('{{input}}', taskStr) : taskStr)
          : undefined;
        const res = await fetch(wh.url, {
          method,
          headers: { 'Content-Type': 'application/json', ...wh.headers },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`Webhook ${wh.url} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const responseText = await res.text();
        // Extract result from response via simple path
        if (wh.resultPath) {
          try {
            const json = JSON.parse(responseText);
            const value = wh.resultPath.split('.').reduce((o: unknown, k: string) => (o as Record<string, unknown>)?.[k], json);
            return typeof value === 'string' ? value : JSON.stringify(value);
          } catch { return responseText; }
        }
        return responseText;
      }
      case 'logic': {
        // Pure JS function — deterministic, zero LLM
        // Safety: vm.runInNewContext isolates from global scope (no require/process/import)
        const fn = def.logicFn;
        if (!fn) throw new Error(`Worker ${worker}: logicFn not configured`);
        const taskStr = typeof task === 'string' ? task : JSON.stringify(task);
        try {
          const vm = await import('node:vm');
          const sandbox = { input: taskStr, context: { cwd, worker }, result: undefined as unknown, JSON, Math, Date, Array, Object, String, Number, Boolean, RegExp, Map, Set, parseInt, parseFloat, isNaN, isFinite };
          const script = new vm.Script(`result = (function(input, context) { ${fn} })(input, context);`);
          script.runInNewContext(sandbox, { timeout: timeoutMs });
          const resolved = sandbox.result;
          return typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error ? err.stack?.slice(0, 500) : undefined;
          const fnPreview = fn.slice(0, 200).replace(/\n/g, '\\n');
          const inputPreview = taskStr.slice(0, 200).replace(/\n/g, '\\n');
          console.error(`[worker:logic] FAIL worker=${worker} timeoutMs=${timeoutMs} fnPreview=${fnPreview} inputPreview=${inputPreview} err=${msg}${stack ? `\n${stack}` : ''}`);
          throw new Error(`Logic error: ${msg}`);
        }
      }
      case 'middleware': {
        const url = def.middlewareUrl;
        if (!url) throw new Error(`Worker ${worker}: middlewareUrl not configured`);
        const upstreamWorker = def.middlewareWorker ?? worker;
        const res = await fetch(`${url}/dispatch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worker: upstreamWorker, task, timeout: timeoutMs / 1000 }),
        });
        const { taskId } = await res.json() as { taskId: string };
        // Poll for result with exponential backoff + jitter
        const start = Date.now();
        let pollInterval = 2000;
        while (Date.now() - start < timeoutMs) {
          const statusRes = await fetch(`${url}/status/${taskId}`);
          const status = await statusRes.json() as { status: string; result?: unknown; error?: string };
          if (status.status === 'completed') return typeof status.result === 'string' ? status.result : JSON.stringify(status.result);
          if (status.status === 'failed') throw new Error(status.error ?? 'Upstream task failed');
          const jitter = Math.random() * pollInterval * 0.3;
          await new Promise(r => setTimeout(r, pollInterval + jitter));
          pollInterval = Math.min(pollInterval * 1.5, 15000);
        }
        // Cancel upstream task on timeout — prevent resource leak
        fetch(`${url}/task/${taskId}`, { method: 'DELETE' }).catch(() => {});
        throw new Error(`Upstream middleware timeout after ${timeoutMs}ms (cancel sent)`);
      }
      case 'ci-trigger': {
        // T22: Trigger GitHub Actions workflow via local gh CLI, poll for completion.
        // Task is JSON string (see ci-trigger.ts for schema).
        const rawTask = typeof task === 'string'
          ? task
          : (task.find(b => b.type === 'text') as { text: string } | undefined)?.text ?? '';
        if (!rawTask) throw new Error(`ci-trigger: task must be non-empty JSON string`);
        return Promise.race([
          ciTriggerAndWait(rawTask),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`ci-trigger timeout after ${timeoutMs}ms`)), timeoutMs),
          ),
        ]);
      }
      default:
        throw new Error(`Unknown backend: ${def.backend}`);
    }
  };

  // Plan engine with event callbacks
  const planEngine = new PlanEngine(executeWorker, {
    // Middleware cwd — threaded so structured acceptance path resolution and
    // dispatch-time convergence injection use middleware cwd (not process.cwd())
    // as the fallback base for relative paths.
    cwd,
    // Let plan engine use worker-specific timeouts instead of hardcoded 120s
    getWorkerTimeoutSeconds: (workerName) => allWorkers()[workerName]?.defaultTimeoutSeconds ?? 120,
    // Bridge ALL plan events to result buffer → SSE stream
    onEvent: (event) => {
      switch (event.type) {
        case 'step.dispatched': {
          buffer.start(event.step.id);
          // Update buffer task with resolved content (so dashboard shows actual prompt, not template)
          if (event.resolvedTask) {
            const entry = buffer.get(event.step.id);
            if (entry) entry.task = event.resolvedTask;
          }
          break;
        }
        case 'step.completed': buffer.complete(event.result.id, event.result.output); break;
        case 'step.failed': buffer.fail(event.result.id, event.result.output); break;
        default:
          // Plan-level events (retry, cancel, mutation, convergence, plan.completed)
          // → broadcast to SSE subscribers
          buffer.broadcast({ type: event.type, data: event });
          break;
      }
    },
  });

  // Track plans (max capacity to prevent OOM)
  const MAX_PLANS = 100;
  const plans = new Map<string, { plan: ActionPlan; resultPromise: Promise<import('./plan-engine.js').PlanResult>; createdAt: string }>();
  let planCounter = 0;

  // Evict oldest completed plans when capacity exceeded
  const completedPlans = new Set<string>();
  const markPlanCompleted = (planId: string) => completedPlans.add(planId);
  const evictOldPlans = () => {
    if (plans.size <= MAX_PLANS) return;
    // Only evict completed plans — never remove running ones
    for (const [id] of plans) {
      if (plans.size <= MAX_PLANS) break;
      if (completedPlans.has(id)) {
        plans.delete(id);
        completedPlans.delete(id);
      }
    }
  };

  // Plan definition persistence (for replay/audit). Separate from result-buffer
  // which stores per-task records. This stores plan-level metadata: goal, full
  // step structure (dependsOn, label, retry), createdAt, caller. Survives
  // middleware restart and evict-after-1h. Append-only JSONL.
  const planHistoryPath = path.join(cwd, 'plan-history.jsonl');
  const persistPlanHistory = (record: PlanHistoryRecord): void => {
    try { fs.appendFileSync(planHistoryPath, JSON.stringify(record) + '\n'); } catch { /* fail-open */ }
  };
  const readPlanHistory = (): PlanHistoryRecord[] => {
    try {
      const raw = fs.readFileSync(planHistoryPath, 'utf-8');
      return raw.split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line) as PlanHistoryRecord; } catch { return null; }
      }).filter((x): x is PlanHistoryRecord => x !== null);
    } catch { return []; }
  };
  /** Compact plan-history.jsonl — remove records older than maxAgeDays. */
  const compactPlanHistory = (maxAgeDays = 30): { removed: number; kept: number } => {
    const records = readPlanHistory();
    const cutoff = Date.now() - maxAgeDays * 24 * 3_600_000;
    const kept = records.filter(r => new Date(r.createdAt).getTime() >= cutoff);
    const removed = records.length - kept.length;
    if (removed > 0) {
      try {
        fs.writeFileSync(planHistoryPath, kept.map(r => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''), 'utf-8');
      } catch { /* fail-open */ }
    }
    return { removed, kept: kept.length };
  };

  // Lazy-init internal brain for /accomplish endpoint.
  // Uses sonnet by default — brain.ts createBrain defaults to opus which is
  // ill-suited as planner (per arxiv 2604.06296 §6.2 role2_never_called finding:
  // stronger models in planner role systematically fail to delegate).
  // Sonnet has a better delegation disposition while still producing valid JSON plans.
  let _brain: LLMProvider | null = null;
  const getBrain = (): LLMProvider => {
    if (_brain) return _brain;
    _brain = createSdkProvider({
      model: process.env.MIDDLEWARE_BRAIN_MODEL ?? 'sonnet',
      cwd,
      allowedTools: [], // brain ONLY produces plans, never dispatches directly
      maxTurns: 1, // single-shot planning call — no tool use needed
      maxBudgetUsd: 1,
    });
    return _brain;
  };

  // Lazy-init critic model for recovery_options generation.
  // Uses Haiku — per arxiv 2604.06296 Table 1: "Opus answerer + Haiku critic = 98.84%"
  // beats Opus+Opus on MathQA. Critic role (judging failure + proposing options)
  // benefits from cheaper models, not stronger ones.
  let _critic: LLMProvider | null = null;
  const getCritic = (): LLMProvider => {
    if (_critic) return _critic;
    _critic = createSdkProvider({
      model: process.env.MIDDLEWARE_CRITIC_MODEL ?? 'haiku',
      cwd,
      allowedTools: [],
      maxTurns: 1,
      maxBudgetUsd: 0.5,
    });
    return _critic;
  };

  // Generate recovery_options for a failed plan — AI-actionable alternatives
  // instead of raw stack traces. See proposal: Constraint Texture for errors.
  const RECOVERY_SYSTEM = `You are a failure diagnosis critic. Given a failed task plan, produce 2-4 actionable recovery options.

OUTPUT FORMAT: Return JSON inside \`\`\`json ... \`\`\` block:
{
  "semantic_diagnosis": "one-sentence human-readable explanation of what went wrong",
  "options": [
    {
      "action": "wait_and_retry" | "alternative_approach" | "escalate" | "abort",
      "description": "what the caller should do",
      "confidence": 0.0-1.0,
      "wait_ms": <only for wait_and_retry>,
      "why": "brief rationale"
    }
  ]
}

RULES:
- action values are a closed set — don't invent new ones
- confidence reflects how likely this option succeeds
- Order options by recommended priority (best first)
- Be specific: "retry with exponential backoff" not "try again"
- If the failure is unrecoverable, include { "action": "abort", ... } with confidence 1.0`;

  const generateRecoveryOptions = async (
    goal: string,
    failedSteps: Array<{ id: string; worker: string; error: string }>,
    fullErrorContext: string,
  ): Promise<{ semantic_diagnosis: string; options: RecoveryOption[] } | null> => {
    if (!failedSteps.length) return null;
    const prompt = [
      `Goal: ${goal}`,
      `Failed steps:\n${failedSteps.map(s => `  - ${s.id} (${s.worker}): ${s.error.slice(0, 300)}`).join('\n')}`,
      `Full context:\n${fullErrorContext.slice(0, 2000)}`,
    ].join('\n\n');
    try {
      const response = await getCritic().think(prompt, RECOVERY_SYSTEM);
      const match = response.match(/```json\s*([\s\S]*?)```/) ?? response.match(/(\{[\s\S]*"options"[\s\S]*\})/);
      if (!match) return null;
      const parsed = JSON.parse(match[1]) as { semantic_diagnosis?: string; options?: RecoveryOption[] };
      if (!Array.isArray(parsed.options)) return null;
      return {
        semantic_diagnosis: parsed.semantic_diagnosis ?? 'No diagnosis produced',
        options: parsed.options,
      };
    } catch {
      return null; // fail-open — if critic fails, caller still gets raw errors
    }
  };

  // Convert worker definitions to brain-visible info (drops backend details,
  // keeps only what brain needs to choose wisely: name, description, model tier).
  const brainWorkerInfo = (): WorkerInfo[] => {
    const out: WorkerInfo[] = [];
    for (const [name, def] of Object.entries(allWorkers())) {
      out.push({
        name,
        description: def.agent.description ?? '',
        backend: def.backend,
        model: def.agent.model,
        maxConcurrency: def.maxConcurrency,
      });
    }
    return out;
  };

  // Commitments ledger — cross-cycle "I will do X" promises (proposal §5)
  const commitments = openCommitmentStore(cwd);

  return { buffer, planEngine, executeWorker, workerProviders, customWorkers, persistCustomWorkers, acpGateway, presetManager, plans, planCounter, evictOldPlans, markPlanCompleted, persistPlanHistory, readPlanHistory, compactPlanHistory, getBrain, brainWorkerInfo, generateRecoveryOptions, commitments, hookRegistry, webhookDispatcher };
}

// =============================================================================
// Hono Router
// =============================================================================

export function createRouter(config?: MiddlewareConfig): Hono {
  const mw = createMiddleware(config);
  const app = new Hono();

  // Startup: compaction + stale-scan (before recovery, so recovered data is clean)
  {
    // Compact JSONL files — deduplicate commitments, prune old plan history
    const phResult = mw.compactPlanHistory(30);
    if (phResult.removed > 0) console.log(`[lifecycle] startup: compacted plan-history (removed ${phResult.removed}, kept ${phResult.kept})`);
    const cmResult = mw.commitments.compact();
    if (cmResult) console.log(`[lifecycle] startup: compacted commitments (${cmResult.after} unique records)`);

    // Stale-scan commitments immediately (don't wait for 60s periodic)
    const COMMITMENT_STALE_SECONDS_STARTUP = 7 * 24 * 3600;
    const stale = mw.commitments.stale({ older_than_seconds: COMMITMENT_STALE_SECONDS_STARTUP, status: 'active' });
    for (const c of stale) {
      mw.commitments.patch(c.id, { status: 'cancelled', resolution: { kind: 'cancel', evidence: 'lifecycle-gc: startup stale-scan > 7d' } });
    }
    if (stale.length > 0) console.log(`[lifecycle] startup: expired ${stale.length} stale commitments`);
  }

  // Startup recovery: cancel orphaned pending tasks from plans lost on prior restart
  {
    const activePlanIds = new Set(mw.plans.keys());
    const orphaned = mw.buffer.cancelOrphans(activePlanIds);
    if (orphaned > 0) console.log(`[lifecycle] startup: cancelled ${orphaned} orphaned tasks`);
  }

  // Startup plan recovery: resume non-terminal plans from last session.
  // Recovery = normal execution starting from the middle (Akari pattern).
  {
    const history = mw.readPlanHistory();
    const planEvents = new Map<string, PlanHistoryRecord[]>();
    for (const r of history) {
      const arr = planEvents.get(r.planId) ?? [];
      arr.push(r);
      planEvents.set(r.planId, arr);
    }

    const RECOVERY_WINDOW_MS = 3_600_000; // Only recover plans < 1h old
    const now = Date.now();
    let recovered = 0;

    for (const [planId, events] of planEvents) {
      const hasTerminal = events.some(e => e.event === 'completed' || e.event === 'failed');
      if (hasTerminal) continue;

      const created = events.find(e => e.plan);
      if (!created?.plan) continue;

      const age = now - new Date(created.createdAt).getTime();
      if (age > RECOVERY_WINDOW_MS) {
        // Too old — mark as failed instead of recovering
        mw.persistPlanHistory({ planId, createdAt: created.createdAt, event: 'failed' });
        continue;
      }

      // Rebuild exec plan with prefixed IDs (same transform as POST /plan)
      const plan = created.plan;
      const idMap = new Map(plan.steps.map(s => [s.id, `${planId}_${s.id}`]));
      const remapTemplates = (task: string) => {
        let t = task;
        for (const [orig, prefixed] of idMap) t = t.replaceAll(`{{${orig}.`, `{{${prefixed}.`);
        return t;
      };
      const execPlan: ActionPlan = {
        ...plan,
        steps: plan.steps.map(s => ({
          ...s,
          id: idMap.get(s.id)!,
          task: remapTemplates(s.task),
          dependsOn: (s.dependsOn ?? []).map(d => idMap.get(d) ?? d),
        })),
      };

      // Rebuild initialResults from ResultBuffer (completed steps survive restart)
      const existingTasks = mw.buffer.list({ planId });
      const initialResults = new Map<string, StepResult>();
      for (const task of existingTasks) {
        if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
          initialResults.set(task.id, {
            id: task.id,
            worker: task.worker,
            status: task.status === 'cancelled' ? 'skipped' : task.status as 'completed' | 'failed',
            output: typeof task.result === 'string' ? task.result : (task.error ?? ''),
            durationMs: task.durationMs ?? 0,
            dispatchOrder: 0,
          });
        }
      }

      // All steps already have results — plan was complete, just missing terminal event
      if (initialResults.size >= execPlan.steps.length) {
        mw.persistPlanHistory({ planId, createdAt: created.createdAt, event: 'completed' });
        continue;
      }

      // Re-submit pending steps to buffer (so dashboard shows them)
      for (const step of execPlan.steps) {
        if (!initialResults.has(step.id) && !mw.buffer.get(step.id)) {
          mw.buffer.submit({ id: step.id, planId, worker: step.worker, task: step.task, label: step.label, caller: created.caller });
        }
      }

      // Resume execution with existing results
      const resultPromise = mw.planEngine.execute(execPlan, initialResults);
      mw.plans.set(planId, { plan: execPlan, resultPromise, createdAt: created.createdAt });
      resultPromise.then(result => {
        mw.markPlanCompleted(planId);
        (mw.plans.get(planId) as Record<string, unknown>).result = result;
        mw.persistPlanHistory({ planId, createdAt: created.createdAt, event: 'completed', summary: result.summary, accepted: result.accepted, convergenceIterations: result.convergenceIterations, durationMs: result.totalDurationMs });
        setTimeout(() => mw.plans.delete(planId), 3_600_000);
      }).catch(() => {
        mw.markPlanCompleted(planId);
        mw.persistPlanHistory({ planId, createdAt: created.createdAt, event: 'failed' });
        setTimeout(() => mw.plans.delete(planId), 3_600_000);
      });

      recovered++;
      console.log(`[lifecycle] recovered plan ${planId} (${initialResults.size}/${execPlan.steps.length} steps already complete)`);
    }

    if (recovered > 0) console.log(`[lifecycle] startup: recovered ${recovered} interrupted plans`);
  }

  // Global error handler — uncaught exceptions in routes return structured JSON
  // instead of bare "Internal Server Error" text. This matters for AI callers:
  // a 21-byte text crash is opaque; a JSON body with error+message is debuggable.
  app.onError((err, c) => {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack?.split('\n').slice(0, 3).join('\n') : undefined;
    console.error(`[api] uncaught ${c.req.method} ${c.req.url}: ${msg}`);
    if (stack) console.error(stack);
    return c.json({
      error: 'internal_server_error',
      message: msg,
      path: new URL(c.req.url).pathname,
      method: c.req.method,
    }, 500);
  });

  // Auth on all mutating endpoints (health/dashboard/events exempt)
  app.use('/dispatch', authMiddleware as never);
  app.use('/plan', authMiddleware as never);
  app.use('/plan/*', authMiddleware as never);
  app.use('/plans', authMiddleware as never);
  app.use('/plans/*', authMiddleware as never);
  app.use('/accomplish', authMiddleware as never);
  app.use('/workers', authMiddleware as never);
  app.use('/workers/*', authMiddleware as never);
  app.use('/gateway/*', authMiddleware as never);
  app.use('/presets', authMiddleware as never);
  app.use('/presets/*', authMiddleware as never);
  app.use('/task/*', authMiddleware as never);
  app.use('/commit', authMiddleware as never);
  app.use('/commit/*', authMiddleware as never);
  app.use('/commits', authMiddleware as never);
  app.use('/commits/*', authMiddleware as never);
  app.use('/forge', authMiddleware as never);
  app.use('/forge/*', authMiddleware as never);

  // Helper: all workers (built-in + custom)
  const mergedWorkerNames = () => [...getWorkerNames(), ...Array.from(mw.customWorkers.keys())];

  // Validate caller-supplied per-task cwd. Returns null on ok, error string on reject.
  // Trust model: API is auth-gated (MIDDLEWARE_API_KEY), so caller is trusted. These
  // checks catch typos + obvious misuse, not hostile attackers.
  const validateTaskCwd = (cwd: string): string | null => {
    if (typeof cwd !== 'string' || !cwd) return 'cwd must be a non-empty string';
    if (!path.isAbsolute(cwd)) return `cwd must be absolute path: ${cwd}`;
    try {
      const st = fs.statSync(cwd);
      if (!st.isDirectory()) return `cwd is not a directory: ${cwd}`;
    } catch {
      return `cwd does not exist: ${cwd}`;
    }
    return null;
  };

  // Webhook callback — fire-and-forget POST to caller's endpoint on events
  const sendCallback = (url: string, from: string, event: { type: string; id: string; status: string; result?: unknown; error?: string }) => {
    const text = event.type === 'task.completed'
      ? `Task ${event.id} completed: ${typeof event.result === 'string' ? event.result.slice(0, 2000) : JSON.stringify(event.result).slice(0, 2000)}`
      : event.type === 'task.failed'
        ? `Task ${event.id} failed: ${event.error ?? 'unknown error'}`
        : event.type === 'plan.completed'
          ? `Plan ${event.id} completed. Status: ${event.status}`
          : `Event: ${event.type} on ${event.id}`;
    // Payload carries both chat-shaped fields (from/text for Chat Room ingestion)
    // and structured event fields (type/id/status/result/error for programmatic
    // drainage, e.g. mini-agent delegation result reconciliation). One code path,
    // one payload; consumers pick what they need.
    const payload: Record<string, unknown> = { from, text, type: event.type, id: event.id, status: event.status };
    if (event.result !== undefined) payload.result = event.result;
    if (event.error !== undefined) payload.error = event.error;
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    }).catch((err) => { console.error(`[sendCallback] POST ${url} failed:`, err instanceof Error ? err.message : err); });
  };

  // Health
  app.get('/health', (c) => c.json({
    status: 'ok',
    service: 'agent-middleware',
    workers: mergedWorkerNames(),
    tasks: mw.buffer.list({ limit: 0 }).length,
  }));

  // ─── Capabilities — self-describing entry point for AI agents ───
  app.get('/capabilities', (c) => {
    const allW = { ...WORKERS, ...Object.fromEntries(mw.customWorkers) };
    const workerList = Object.entries(allW).map(([name, def]) => ({
      name,
      backend: def.backend,
      model: def.agent.model ?? null,
      when: def.agent.description ?? '',
      tools: def.agent.tools ?? [],
      maxTurns: def.agent.maxTurns ?? null,
      hasMcp: !!def.mcpServers,
      hasSkills: !!(def.skills?.length),
      builtin: !!WORKERS[name],
      example: def.backend === 'shell'
        ? { worker: name, task: 'echo hello && ls -la' }
        : { worker: name, task: `[describe what you want ${name} to do]` },
    }));
    const templateList = PLAN_TEMPLATES.map(t => ({
      name: t.name,
      when: t.description,
      params: t.params.map(p => ({ name: p.name, description: p.description, required: p.required })),
      steps: t.plan.steps.length,
      example: { template: t.name, params: Object.fromEntries(t.params.map(p => [p.name, p.required ? `<${p.name}>` : ''])) },
    }));
    return c.json({
      service: 'agent-middleware',
      purpose: '幫你分解步驟、並行執行、結果回流。你規劃，我執行。',
      quickstart: {
        '單一任務': { method: 'POST /dispatch', body: { worker: 'shell', task: 'echo hello' }, note: '立即派給 worker 執行，回傳 taskId' },
        '多步驟計劃': { method: 'POST /plan', body: { goal: '描述目標', steps: [{ id: 'step-id', worker: 'worker-name', task: '任務描述', dependsOn: [], label: '給人看的標籤' }] }, note: 'DAG 自動並行，dependsOn=[] 的步驟同時跑' },
        '用模板': { method: 'POST /plan/from-template', body: { template: 'template-name', params: {} }, note: '一行建立完整 plan' },
        '查狀態': { method: 'GET /status/:taskId 或 GET /plan/:planId' },
        '即時事件': { method: 'GET /events', note: 'SSE stream — task.submitted/started/completed/failed' },
      },
      workers: workerList,
      templates: templateList,
      dataFlow: {
        description: '步驟間用 {{stepId.result}} 傳遞資料',
        fields: ['{{stepId.result}}', '{{stepId.summary}}', '{{stepId.findings}}', '{{stepId.status}}', '{{stepId.confidence}}'],
        example: { id: 'analyze', worker: 'analyst', task: 'Analyze: {{scan.result}}', dependsOn: ['scan'] },
      },
      parallelism: {
        description: 'dependsOn=[] 或相同依賴的步驟自動並行',
        example: [
          { id: 'a', worker: 'shell', task: 'task-a', dependsOn: [] },
          { id: 'b', worker: 'shell', task: 'task-b', dependsOn: [] },
          { id: 'c', worker: 'analyst', task: 'Combine: {{a.result}} + {{b.result}}', dependsOn: ['a', 'b'] },
        ],
        note: 'a 和 b 同時跑，c 等兩個都完成才開始',
      },
      callback: {
        description: '完成後自動 POST 通知你，不用 poll',
        usage: { worker: 'shell', task: '...', callback: 'http://your-agent:3002/chat', callbackFrom: 'middleware' },
      },
      extensibility: {
        '自訂 worker': { method: 'POST /workers', body: { name: 'my-worker', description: '做什麼用', prompt: 'You are...', tools: ['Read', 'Grep'], backend: 'sdk' }, note: '建好就能在 plan 裡用' },
        '帶 skills': { method: 'POST /workers', body: { name: 'my-worker', prompt: '...', skills: ['# Skill Name\nSkill prompt content...'] }, note: 'skills 注入 worker prompt，worker-scoped' },
        '帶 MCP': { method: 'POST /workers', body: { name: 'db-worker', prompt: '...', mcpServers: { sqlite: { command: 'mcp-server-sqlite', args: ['--db', 'data.db'] } } }, note: '讓 worker 用外部工具' },
        '用 preset': { method: 'GET /presets', note: '預設模板快速建 worker' },
        'health check': { method: 'GET /workers/health', note: '規劃前先檢查，不健康的 worker 會附帶 fix 命令' },
        '自訂 health': { method: 'POST /workers', body: { name: 'my-worker', healthCheck: 'pg_isready', healthFix: 'brew services restart postgresql' }, note: 'AI 定義檢查命令 + 修復提示。中台只回報狀態，修復由 AI 自己決定' },
      },
      workerSelection: {
        description: '根據任務性質選 worker — 不是所有任務都需要 AI',
        rules: [
          { condition: '確定性任務（有明確命令、不需判斷）', worker: 'shell', reason: '毫秒級，零 AI 成本' },
          { condition: '抓網頁內容（不需 JS 渲染）', worker: 'web-fetch', reason: 'curl 快且輕' },
          { condition: '需要 JS 渲染或瀏覽器互動', worker: 'web-browser', reason: 'CDP 完整瀏覽器能力' },
          { condition: '部署後視覺驗證', worker: 'web-verify', reason: 'HTTP 200 ≠ 頁面正常' },
          { condition: '搜尋/閱讀/收集資訊', worker: 'researcher', reason: '有 WebFetch + WebSearch' },
          { condition: '寫/改/重構 code', worker: 'coder', reason: '有 Write + Edit + 測試' },
          { condition: '評估品質/review', worker: 'reviewer', reason: '唯讀分析，Haiku 快且便宜' },
          { condition: '分析/比較/產出報告', worker: 'analyst', reason: '結構化輸出，有主見' },
          { condition: '探索 codebase 結構', worker: 'explorer', reason: 'Haiku + 檔案工具' },
        ],
        antipatterns: [
          '用 SDK worker 做 shell 能做的事 — 浪費 30 秒等 AI 回答 echo hello',
          '一個 step 做所有事 — context 爆炸，拆開並行更快',
          '串行做可以並行的事 — dependsOn=[] 就能並行',
          '大資料直接塞進 AI prompt — 先用 shell+jq 提取需要的部分，或用 GET /status/:stepId/result?offset=0&limit=5000 分頁取',
          'shell worker 用 {{stepId.result}} 引用 JSON — 引號衝突會炸。shell 要取上游資料請用 curl localhost:3200/status/:stepId/result | jq。{{template}} 是給 AI workers 用的',
        ],
      },
      planPatterns: {
        description: '常見 DAG 組合模式',
        patterns: [
          {
            name: '收集 → 分析 → 產出',
            when: '需要先拿資料再做判斷',
            shape: 'shell(收集) → analyst(分析) → analyst(報告)',
            example: [
              { id: 'scan', worker: 'shell', task: 'ls -la src/', dependsOn: [] },
              { id: 'analyze', worker: 'analyst', task: 'Analyze: {{scan.result}}', dependsOn: ['scan'] },
            ],
          },
          {
            name: '並行收集 → 匯總',
            when: '多個獨立資料來源',
            shape: 'shell(A) + shell(B) + shell(C) → analyst(匯總)',
            example: [
              { id: 'a', worker: 'shell', task: 'task-a', dependsOn: [] },
              { id: 'b', worker: 'shell', task: 'task-b', dependsOn: [] },
              { id: 'c', worker: 'analyst', task: 'Combine: {{a.result}} + {{b.result}}', dependsOn: ['a', 'b'] },
            ],
          },
          {
            name: '實作 → 測試 → 驗證',
            when: '改 code 需要驗證',
            shape: 'coder(改) → shell(測試) → reviewer(review)',
            example: [
              { id: 'code', worker: 'coder', task: 'Fix the bug in X', dependsOn: [] },
              { id: 'test', worker: 'shell', task: 'npm test', dependsOn: ['code'] },
              { id: 'review', worker: 'reviewer', task: 'Review changes: {{code.result}}', dependsOn: ['code'] },
            ],
          },
          {
            name: '部署 → 健檢 → 視覺驗證',
            when: '部署後需要確認服務正常',
            shape: 'shell(部署) → web-fetch(健檢) + web-verify(截圖)',
            example: [
              { id: 'deploy', worker: 'shell', task: 'npm run deploy', dependsOn: [] },
              { id: 'health', worker: 'web-fetch', task: 'curl -sf http://service/health', dependsOn: ['deploy'] },
              { id: 'visual', worker: 'web-verify', task: 'screenshot http://service/', dependsOn: ['deploy'] },
            ],
          },
        ],
      },
      tips: [
        'shell / web-fetch 最快（毫秒級），優先用',
        'SDK workers 用 Claude API，較慢但能思考 — 只在需要判斷時用',
        '大任務拆成多個小 steps 並行跑，比一個大 step 快且 context 小',
        'retry 設在不穩定的步驟上：{ retry: { maxRetries: 2, onExhausted: "skip" } }',
        'callback 比 polling 好 — 設了就不用自己查狀態。callbackFrom 要用目標 API 接受的身份（如 alex/kuro/claude-code）',
        '不確定路徑？先加一個 shell step 跑 ls/find 驗證，再用結果設計後續 steps — 寫錯路徑整個下游都會 skip',
        'web-fetch 不能處理 JS 渲染的頁面 — 需要 JS 就用 web-browser',
      ],
    });
  });

  // POST /dispatch — single task (supports multimodal)
  // Body: { worker, task, timeout?, caller?, cwd? }
  //   task: string (text only) OR ContentBlock[] (multimodal)
  //   ContentBlock: { type: 'text', text } | { type: 'image', source: { type, mediaType, data } } | { type: 'file', path, mediaType? }
  //   cwd: absolute directory path — scopes this task's filesystem access (sdk/shell backends).
  //        Must exist + be a directory. Caller owns lifecycle (create before, cleanup after).
  app.post('/dispatch', async (c) => {
    const body = await c.req.json<{
      worker: string;
      task: string | import('./llm-provider.js').ContentBlock[];
      timeout?: number;
      caller?: string;
      callback?: string;       // webhook URL — POST event on completion/failure
      callbackFrom?: string;   // "from" field in callback payload (default: "middleware")
      wait?: boolean;          // block until task complete
      cwd?: string;            // per-task workdir (see validateTaskCwd)
    }>();
    const waitMode = body.wait || c.req.query('wait') === 'true';
    if (!body.worker || !body.task) return c.json({ error: 'worker and task required' }, 400);

    const allW = { ...WORKERS, ...Object.fromEntries(mw.customWorkers) };
    if (!allW[body.worker]) return c.json({ error: `Unknown worker: ${body.worker}` }, 400);

    // Validate caller-supplied cwd before spending a taskId / starting work.
    const cwdErr = body.cwd !== undefined ? validateTaskCwd(body.cwd) : null;
    if (cwdErr) return c.json({ error: cwdErr }, 400);

    const def = allW[body.worker];
    const timeoutMs = (body.timeout ?? def.defaultTimeoutSeconds) * 1000;
    const taskDesc = typeof body.task === 'string' ? body.task : `[multimodal: ${body.task.length} blocks]`;
    // Persist dispatch context (cwd, timeoutMs, raw task) in metadata so the
    // task is retryable without the caller needing to remember any of it.
    const taskId = mw.buffer.submit({
      worker: body.worker,
      task: taskDesc,
      caller: body.caller,
      metadata: { cwd: body.cwd, timeoutMs, rawTask: body.task },
    });
    mw.buffer.start(taskId);

    const cb = body.callback;
    const cbFrom = body.callbackFrom ?? 'middleware';
    const execPromise = mw.executeWorker(body.worker, body.task, timeoutMs, body.cwd ? { cwd: body.cwd } : undefined)
      .then(result => {
        mw.buffer.complete(taskId, result);
        if (cb) sendCallback(cb, cbFrom, { type: 'task.completed', id: taskId, status: 'completed', result });
        return result;
      })
      .catch(err => {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack?.slice(0, 500) : undefined;
        const taskPreview = (typeof body.task === 'string' ? body.task : JSON.stringify(body.task)).slice(0, 200).replace(/\n/g, '\\n');
        console.error(`[api:dispatch] FAIL taskId=${taskId} worker=${body.worker} cwd=${body.cwd ?? '-'} timeoutMs=${timeoutMs} taskPreview=${taskPreview} err=${msg}${stack ? `\n${stack}` : ''}`);
        mw.buffer.fail(taskId, msg);
        if (cb) sendCallback(cb, cbFrom, { type: 'task.failed', id: taskId, status: 'failed', error: msg });
        throw err;
      });

    // Blocking mode: wait for completion, return result directly
    if (waitMode) {
      try {
        const result = await execPromise;
        return c.json({ taskId, status: 'completed', result });
      } catch (err) {
        return c.json({ taskId, status: 'failed', error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // Non-wait mode: nobody awaits execPromise, so the .catch re-throw at L1007
    // becomes an unhandled rejection and crashes the process. Silence here —
    // errors are already recorded via buffer.fail + callback.
    execPromise.catch(() => { /* swallowed — state captured in ResultBuffer + callback */ });

    return c.json({ taskId, status: 'running' });
  });

  // POST /plan — submit action plan. ?wait=true blocks until all steps complete.
  app.post('/plan', async (c) => {
    const body = await c.req.json<ActionPlan & { caller?: string; callback?: string; callbackFrom?: string; wait?: boolean }>();
    const waitMode = body.wait || c.req.query('wait') === 'true';
    const plan: ActionPlan = { goal: body.goal, steps: body.steps, acceptance: body.acceptance, convergence: body.convergence };

    // Validate
    const errors = mw.planEngine.validate(plan, new Set(mergedWorkerNames()));
    if (errors.length > 0) return c.json({ error: 'validation_failed', errors }, 400);

    // Validate per-step cwd (if any). Reject whole plan if any step's cwd is invalid.
    const cwdErrors: Array<{ stepId: string; error: string }> = [];
    for (const step of plan.steps) {
      if (step.cwd !== undefined) {
        const err = validateTaskCwd(step.cwd);
        if (err) cwdErrors.push({ stepId: step.id, error: err });
      }
    }
    if (cwdErrors.length > 0) return c.json({ error: 'cwd_validation_failed', errors: cwdErrors }, 400);

    const planId = `plan-${Date.now()}-${(mw.planCounter++).toString(36)}`;

    // Submit steps to buffer with unique IDs (planId_stepId) to avoid cross-plan collision
    for (const step of plan.steps) {
      const uid = `${planId}_${step.id}`;
      mw.buffer.submit({ id: uid, planId, worker: step.worker, task: step.task, label: step.label, caller: body.caller });
    }

    // Remap plan step IDs to match buffer UIDs — plan engine events will use these IDs
    // Also remap {{stepId.xxx}} template references in task strings
    const idMap = new Map(plan.steps.map(s => [s.id, `${planId}_${s.id}`]));
    const remapTemplates = (task: string) => {
      let t = task;
      for (const [orig, prefixed] of idMap) {
        t = t.replaceAll(`{{${orig}.`, `{{${prefixed}.`);
      }
      return t;
    };
    const execPlan = {
      ...plan,
      steps: plan.steps.map(s => ({
        ...s,
        id: idMap.get(s.id)!,
        task: remapTemplates(s.task),
        dependsOn: (s.dependsOn ?? []).map(d => idMap.get(d) ?? d),
      })),
    };

    // Execute — plan engine events (dispatched/completed/failed) use remapped IDs → match buffer
    const resultPromise = mw.planEngine.execute(execPlan);
    const createdAt = new Date().toISOString();
    mw.plans.set(planId, { plan: execPlan, resultPromise, createdAt });
    mw.evictOldPlans();
    // Persist LOGICAL plan definition (pre-prefix) for replay/audit. Persisting
    // execPlan would leak planId prefixes into step.id, dependsOn, condition.stepId,
    // and {{template.result}} references — making replay require complex stripping.
    // Storing logical means replay just re-runs the same POST /plan flow.
    mw.persistPlanHistory({ planId, createdAt, caller: body.caller, plan, event: 'created' });

    // Cleanup after completion + evict plan after 1h + webhook callback
    const planCb = body.callback;
    const planCbFrom = body.callbackFrom ?? 'middleware';
    resultPromise.then(result => {
      for (const step of result.steps) {
        if (step.status === 'skipped' || step.status === 'condition_skipped') {
          mw.buffer.skip(step.id, step.output);
        } else if (step.status !== 'completed') {
          mw.buffer.fail(step.id, step.output);
        }
      }
      mw.markPlanCompleted(planId);
      (mw.plans.get(planId) as Record<string, unknown>).result = result;
      mw.persistPlanHistory({ planId, createdAt, event: 'completed', summary: result.summary, accepted: result.accepted, convergenceIterations: result.convergenceIterations, durationMs: result.totalDurationMs });
      setTimeout(() => mw.plans.delete(planId), 3_600_000);
      // Webhook callback on plan completion
      if (planCb) {
        const completed = result.steps.filter(s => s.status === 'completed').length;
        const summary = result.steps.map(s => `${s.id}: ${s.status}`).join(', ');
        sendCallback(planCb, planCbFrom, { type: 'plan.completed', id: planId, status: `${completed}/${result.steps.length} completed`, result: summary });
        (mw.plans.get(planId) as Record<string, unknown>).callbackSentAt = new Date().toISOString();
      }
    }).catch(() => {
      mw.markPlanCompleted(planId);
      mw.persistPlanHistory({ planId, createdAt, event: 'failed' });
      setTimeout(() => mw.plans.delete(planId), 3_600_000);
      if (planCb) sendCallback(planCb, planCbFrom, { type: 'plan.failed', id: planId, status: 'failed', error: 'Plan execution error' });
    });

    // Blocking mode: wait for all steps to complete, return full result
    if (waitMode) {
      try {
        const result = await resultPromise;
        // Store result on plan entry immediately — resultPromise.then() may not have run yet
        mw.markPlanCompleted(planId);
        (mw.plans.get(planId) as Record<string, unknown>).result = result;
        const steps = mw.buffer.list({ planId });
        return c.json({
          planId, status: 'completed', steps: steps.map(s => ({
            id: s.id, worker: s.worker, label: s.label, status: s.status,
            result: s.result, error: s.error, durationMs: s.durationMs,
          })),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack?.slice(0, 500) : undefined;
        const stepsSoFar = mw.buffer.list({ planId });
        const stepsSummary = stepsSoFar.map(s => `${s.id}:${s.status}`).join(',');
        console.error(`[api:plan] FAIL planId=${planId} totalSteps=${plan.steps.length} stepsSoFar=${stepsSummary} err=${msg}${stack ? `\n${stack}` : ''}`);
        mw.markPlanCompleted(planId);
        return c.json({ planId, status: 'failed', error: msg }, 500);
      }
    }

    return c.json({
      planId,
      status: 'executing',
      steps: plan.steps.length,
    });
  });

  // POST /accomplish — goal-oriented API (Constraint Texture: convergence over prescription)
  //
  // Caller provides WHAT they want (goal + success_criteria + constraints).
  // Middleware decides HOW — brain generates DAG plan, auto-routes workers,
  // caller never needs to know worker catalog or shell syntax.
  //
  // Body: {
  //   goal: "natural-language description of desired end state",
  //   success_criteria?: "how to judge when done",
  //   constraints?: { max_latency_ms?, max_cost_usd?, must_use?, must_not? },
  //   context?: { prior_attempts?, caller_identity?, extra? },
  //   caller?, callback?, callbackFrom?, wait?
  // }
  //
  // Rationale: POST /dispatch forces caller to know worker catalog; POST /plan
  // forces caller to write DAG. Both are prescription patterns — they push
  // structural decisions onto the caller. /accomplish accepts convergence
  // conditions and lets brain produce the path. See arxiv 2604.06296 — the
  // optimal pipeline has model selection happen at plan-level, not call-level.
  app.post('/accomplish', async (c) => {
    const body = await c.req.json<{
      goal: string;
      success_criteria?: string;
      constraints?: {
        max_latency_ms?: number;
        max_cost_usd?: number;
        must_use?: string[];
        must_not?: string[];
      };
      context?: {
        prior_attempts?: Array<{ error?: string; tried?: string }>;
        caller_identity?: string;
        extra?: string;
      };
      caller?: string;
      callback?: string;
      callbackFrom?: string;
      wait?: boolean;
    }>();

    if (!body.goal || typeof body.goal !== 'string') {
      return c.json({ error: 'goal (string) required' }, 400);
    }

    const waitMode = body.wait || c.req.query('wait') === 'true';

    // Build composite goal + context string for brain
    const fullGoal = body.success_criteria
      ? `${body.goal}\n\nSuccess criteria: ${body.success_criteria}`
      : body.goal;

    const contextParts: string[] = [];
    if (body.constraints) {
      const c = body.constraints;
      const lines: string[] = [];
      if (c.max_latency_ms) lines.push(`- Max latency: ${c.max_latency_ms}ms`);
      if (c.max_cost_usd) lines.push(`- Max cost: $${c.max_cost_usd}`);
      if (c.must_use?.length) lines.push(`- Must use: ${c.must_use.join(', ')}`);
      if (c.must_not?.length) lines.push(`- Must NOT: ${c.must_not.join(', ')}`);
      if (lines.length) contextParts.push(`Constraints:\n${lines.join('\n')}`);
    }
    if (body.context?.prior_attempts?.length) {
      const attempts = body.context.prior_attempts
        .map((a, i) => `  ${i + 1}. ${a.tried ?? 'unknown'} → ${a.error ?? 'unknown error'}`)
        .join('\n');
      contextParts.push(`Prior attempts (avoid repeating):\n${attempts}`);
    }
    if (body.context?.caller_identity) contextParts.push(`Caller: ${body.context.caller_identity}`);
    if (body.context?.extra) contextParts.push(body.context.extra);
    const brainContext = contextParts.length > 0 ? contextParts.join('\n\n') : undefined;

    // Ask brain to produce a DAG plan
    let rawBrainResponse: string;
    try {
      rawBrainResponse = await brainPlan(mw.getBrain(), fullGoal, {
        context: brainContext,
        availableWorkers: mw.brainWorkerInfo(),
      });
    } catch (err) {
      return c.json({
        status: 'planning_failed',
        goal: body.goal,
        error: `Brain planning failed: ${err instanceof Error ? err.message : String(err)}`,
      }, 500);
    }

    // Parse brain's JSON response
    const plan = parsePlan(rawBrainResponse);
    if (!plan) {
      return c.json({
        status: 'planning_failed',
        goal: body.goal,
        error: 'Brain did not produce a valid plan (missing ```json``` block or invalid structure)',
        raw_response: rawBrainResponse.slice(0, 2000),
      }, 500);
    }

    // Validate plan against worker catalog
    const validationErrors = mw.planEngine.validate(plan, new Set(mergedWorkerNames()));
    if (validationErrors.length > 0) {
      return c.json({
        status: 'planning_failed',
        goal: body.goal,
        error: 'Brain produced invalid plan',
        validation_errors: validationErrors,
        plan,
      }, 500);
    }

    // Phase 2b enforcement: multi-step plans must have per-step acceptance_criteria.
    // If brain omitted it, auto-generate from task description (soft enforcement —
    // better than nothing, brain will improve over time).
    if (plan.steps.length >= 2) {
      for (const step of plan.steps) {
        if (!step.acceptance_criteria) {
          step.acceptance_criteria = `Step "${step.label ?? step.id}" completes successfully with relevant output`;
          console.log(`[phase2b] auto-filled acceptance_criteria for step ${step.id}`);
        }
      }
    }

    // From here on: reuse the /plan execution path (ID remap + buffer + engine).
    const planId = `acc-${Date.now()}-${(mw.planCounter++).toString(36)}`;
    for (const step of plan.steps) {
      const uid = `${planId}_${step.id}`;
      mw.buffer.submit({ id: uid, planId, worker: step.worker, task: step.task, label: step.label, caller: body.caller });
    }

    const idMap = new Map(plan.steps.map(s => [s.id, `${planId}_${s.id}`]));
    const remapTemplates = (task: string) => {
      let t = task;
      for (const [orig, prefixed] of idMap) {
        t = t.replaceAll(`{{${orig}.`, `{{${prefixed}.`);
      }
      return t;
    };
    const execPlan = {
      ...plan,
      steps: plan.steps.map(s => ({
        ...s,
        id: idMap.get(s.id)!,
        task: remapTemplates(s.task),
        dependsOn: (s.dependsOn ?? []).map(d => idMap.get(d) ?? d),
      })),
    };

    const resultPromise = mw.planEngine.execute(execPlan);
    const createdAt = new Date().toISOString();
    mw.plans.set(planId, { plan: execPlan, resultPromise, createdAt });
    mw.evictOldPlans();
    // Persist logical plan + original goal for audit/replay
    mw.persistPlanHistory({ planId, createdAt, caller: body.caller, plan, event: 'created' });

    const planCb = body.callback;
    const planCbFrom = body.callbackFrom ?? 'middleware';

    // Shared post-processing for any completed phase's result — used once per phase.
    const postProcessPhase = (result: typeof plan extends never ? never : Awaited<ReturnType<typeof mw.planEngine.execute>>, pid: string, createdAtStr: string) => {
      for (const step of result.steps) {
        if (step.status === 'skipped' || step.status === 'condition_skipped') mw.buffer.skip(step.id, step.output);
        else if (step.status !== 'completed') mw.buffer.fail(step.id, step.output);
      }
      mw.markPlanCompleted(pid);
      (mw.plans.get(pid) as Record<string, unknown>).result = result;
      mw.persistPlanHistory({ planId: pid, createdAt: createdAtStr, event: 'completed', summary: result.summary, accepted: result.accepted, convergenceIterations: result.convergenceIterations, durationMs: result.totalDurationMs });
      setTimeout(() => mw.plans.delete(pid), 3_600_000);
    };

    // ── Chain: Phase 1 → (optional) Phase 2 → final result ──
    // Both waitMode and async-callback paths await THIS promise, so Phase 2
    // is guaranteed to be run exactly once, and both paths see the final
    // (post-Phase-2 if applicable) result. Akari review (2026-04-18): fixes
    // P0 "wait mode returns Phase 1 probe result, Phase 2 runs invisible".
    type PhaseResult = { result: Awaited<ReturnType<typeof mw.planEngine.execute>>; planId: string; plan: ActionPlan; createdAt: string };
    const finalResultPromise: Promise<PhaseResult> = resultPromise.then(async phase1Result => {
      postProcessPhase(phase1Result, planId, createdAt);

      // Gate: Phase 2 only if probe completed cleanly. `condition_skipped` is
      // tracked separately (plan-engine buildResult L863-864) and doesn't
      // block — intentional branch-not-taken is valid observation data.
      if (plan.phase !== 'probe') return { result: phase1Result, planId, plan, createdAt };
      if (phase1Result.summary.failed !== 0 || phase1Result.summary.skipped !== 0) {
        console.log(`[phased] ${planId} probe had failures/skips (${phase1Result.summary.failed}F/${phase1Result.summary.skipped}S) — NOT invoking phase 2`);
        return { result: phase1Result, planId, plan, createdAt };
      }

      // Extract probe findings — prefer last step's structured output; fallback to text.
      // Known limitation (Akari P2): brittle if brain emits multiple parallel
      // aggregator steps. v0: rely on PLANNING_SYSTEM prompt mandating single
      // last aggregator. TODO: promote to explicit marker.
      try {
        const lastStep = phase1Result.steps[phase1Result.steps.length - 1];
        const probeResults = lastStep.structured
          ? JSON.stringify(lastStep.structured, null, 2)
          : (lastStep.output ?? '').slice(0, 4000);
        console.log(`[phased] probe completed for ${planId}, invoking brain for phase 2`);

        const phase2Raw = await brainPlan(mw.getBrain(), fullGoal, {
          context: brainContext,
          availableWorkers: mw.brainWorkerInfo(),
          phase: 'execute',
          probeResults,
        });
        const phase2Plan = parsePlan(phase2Raw);
        if (!phase2Plan) {
          console.warn(`[phased] ${planId} phase 2 brain response did not parse — falling back to phase 1 result`);
          return { result: phase1Result, planId, plan, createdAt };
        }
        phase2Plan.phase = 'execute'; // enforce marker for audit trail

        // Akari P1: validate Phase 2 plan (was skipped in v0)
        const valErrors = mw.planEngine.validate(phase2Plan, new Set(mergedWorkerNames()));
        if (valErrors.length > 0) {
          console.warn(`[phased] ${planId} phase 2 invalid plan: ${valErrors.join(', ')} — falling back to phase 1 result`);
          return { result: phase1Result, planId, plan, createdAt };
        }
        // Akari P1: auto-fill acceptance_criteria for multi-step phase 2 (matches phase 1 behavior)
        if (phase2Plan.steps.length >= 2) {
          for (const step of phase2Plan.steps) {
            if (!step.acceptance_criteria) step.acceptance_criteria = `Step "${step.label ?? step.id}" completes successfully with relevant output`;
          }
        }

        const phase2PlanId = `${planId}-phase2`;
        for (const step of phase2Plan.steps) {
          const uid = `${phase2PlanId}_${step.id}`;
          mw.buffer.submit({ id: uid, planId: phase2PlanId, worker: step.worker, task: step.task, label: step.label, caller: body.caller, metadata: { parentPlanId: planId } });
        }
        const idMap2 = new Map(phase2Plan.steps.map(s => [s.id, `${phase2PlanId}_${s.id}`]));
        const remap2 = (task: string) => {
          let t = task;
          for (const [orig, prefixed] of idMap2) t = t.replaceAll(`{{${orig}.`, `{{${prefixed}.`);
          return t;
        };
        const execPlan2: ActionPlan = {
          ...phase2Plan,
          steps: phase2Plan.steps.map(s => ({
            ...s,
            id: idMap2.get(s.id)!,
            task: remap2(s.task),
            dependsOn: (s.dependsOn ?? []).map(d => idMap2.get(d) ?? d),
          })),
        };
        const phase2Promise = mw.planEngine.execute(execPlan2);
        const phase2CreatedAt = new Date().toISOString();
        const phase2Entry = { plan: execPlan2, resultPromise: phase2Promise, createdAt: phase2CreatedAt } as Parameters<typeof mw.plans.set>[1] & { parentPlanId?: string };
        phase2Entry.parentPlanId = planId;
        mw.plans.set(phase2PlanId, phase2Entry);
        mw.persistPlanHistory({ planId: phase2PlanId, createdAt: phase2CreatedAt, caller: body.caller, plan: phase2Plan, event: 'created' });
        console.log(`[phased] ${planId} → ${phase2PlanId} (${phase2Plan.steps.length} steps)`);

        try {
          const phase2Result = await phase2Promise;
          postProcessPhase(phase2Result, phase2PlanId, phase2CreatedAt);
          return { result: phase2Result, planId: phase2PlanId, plan: phase2Plan, createdAt: phase2CreatedAt };
        } catch (err) {
          console.error(`[phased] ${phase2PlanId} execute failed:`, err);
          // Akari P2 fix: clean up Phase 2 plan entry on failure — prevents
          // memory leak in mw.plans Map + audit gap (created without terminal).
          mw.markPlanCompleted(phase2PlanId);
          mw.persistPlanHistory({ planId: phase2PlanId, createdAt: phase2CreatedAt, event: 'failed' });
          setTimeout(() => mw.plans.delete(phase2PlanId), 3_600_000);
          // TODO (Akari P1): no replan loop for phase 2 failures — add brainDigest→replan in future
          return { result: phase1Result, planId, plan, createdAt };
        }
      } catch (err) {
        console.warn(`[phased] ${planId} phase 2 invocation error:`, err);
        return { result: phase1Result, planId, plan, createdAt };
      }
    });

    // Akari P1 fix: suppress unhandled rejection when fire-and-forget (no wait, no callback).
    // Persistence cleanup is handled by resultPromise.catch() below; this handler exists
    // only to absorb the otherwise-unhandled rejection so Node doesn't warn/crash.
    finalResultPromise.catch(() => { /* persistence handled elsewhere */ });

    // Async-mode callback — fires on FINAL result (Phase 2 if phased, else Phase 1).
    // Akari P0 fix: previously callback fired after Phase 1 only, leaving Phase 2 caller-invisible.
    if (planCb && !waitMode) {
      finalResultPromise.then(({ result, planId: finalId }) => {
        const completed = result.steps.filter(s => s.status === 'completed').length;
        sendCallback(planCb, planCbFrom, {
          type: 'accomplish.completed',
          id: finalId,
          status: `${completed}/${result.steps.length} completed`,
          result: { goal: body.goal, accepted: result.accepted },
        });
      }).catch(() => {
        sendCallback(planCb, planCbFrom, {
          type: 'accomplish.failed',
          id: planId,
          status: 'failed',
          error: `goal: ${body.goal}`,
        });
      });
    }
    // Plan-1-failure path (Phase 1 itself rejected) — still needs persistence cleanup
    resultPromise.catch(() => {
      mw.markPlanCompleted(planId);
      setTimeout(() => mw.plans.delete(planId), 3_600_000);
      mw.persistPlanHistory({ planId, createdAt, event: 'failed' });
    });

    if (waitMode) {
      try {
        const MAX_REPLAN_ROUNDS = 3;
        // Akari P0 fix: await finalResultPromise (not resultPromise) so we see
        // Phase 2's result when plan was phased. finalResultPromise itself
        // handles postProcessPhase for each phase, so buffer/persistence are
        // already cleaned — don't re-mark.
        const finalState = await finalResultPromise;
        let currentResult = finalState.result;
        let currentPlanId = finalState.planId;
        let currentPlan = finalState.plan;
        let replanRound = 0;
        const replanHistory: Array<{ planId: string; round: number; summary: { completed: number; failed: number; skipped: number } }> = [];

        // Brain feedback loop: on failure, ask brain to replan (max 3 rounds).
        // Brain sees full context (completed + failed steps) and decides:
        // - prose response → done (goal achieved or unrecoverable)
        // - new plan → re-execute
        while (
          replanRound < MAX_REPLAN_ROUNDS &&
          !currentResult.accepted &&
          currentResult.summary.failed > 0
        ) {
          replanRound++;
          replanHistory.push({ planId: currentPlanId, round: replanRound - 1, summary: currentResult.summary });
          console.log(`[replan] round ${replanRound}/${MAX_REPLAN_ROUNDS} for goal: ${body.goal}`);

          let digestResponse: string;
          try {
            digestResponse = await brainDigest(mw.getBrain(), body.goal, currentResult, {
              additionalContext: body.success_criteria ? `Success criteria: ${body.success_criteria}` : undefined,
              replanRound,
              maxReplanRounds: MAX_REPLAN_ROUNDS,
            });
          } catch (err) {
            console.warn(`[replan] brainDigest failed: ${err instanceof Error ? err.message : err}`);
            break;
          }

          const newPlan = parsePlan(digestResponse);
          if (!newPlan) break; // Brain returned prose — done

          const valErrors = mw.planEngine.validate(newPlan, new Set(mergedWorkerNames()));
          if (valErrors.length > 0) {
            console.warn(`[replan] round ${replanRound} invalid plan: ${valErrors.join(', ')}`);
            break;
          }

          // Phase 2b enforcement on replan
          if (newPlan.steps.length >= 2) {
            for (const step of newPlan.steps) {
              if (!step.acceptance_criteria) {
                step.acceptance_criteria = `Step "${step.label ?? step.id}" completes successfully with relevant output`;
              }
            }
          }

          // Execute new plan
          const newPlanId = `acc-${Date.now()}-${(mw.planCounter++).toString(36)}`;
          for (const step of newPlan.steps) {
            mw.buffer.submit({ id: `${newPlanId}_${step.id}`, planId: newPlanId, worker: step.worker, task: step.task, label: step.label, caller: body.caller });
          }
          const newIdMap = new Map(newPlan.steps.map(s => [s.id, `${newPlanId}_${s.id}`]));
          const newRemap = (task: string) => {
            let t = task;
            for (const [orig, prefixed] of newIdMap) t = t.replaceAll(`{{${orig}.`, `{{${prefixed}.`);
            return t;
          };
          const newExecPlan: ActionPlan = {
            ...newPlan,
            steps: newPlan.steps.map(s => ({
              ...s,
              id: newIdMap.get(s.id)!,
              task: newRemap(s.task),
              dependsOn: (s.dependsOn ?? []).map(d => newIdMap.get(d) ?? d),
            })),
          };

          const newCreatedAt = new Date().toISOString();
          mw.persistPlanHistory({ planId: newPlanId, createdAt: newCreatedAt, caller: body.caller, plan: newPlan, event: 'created' });
          const newResultPromise = mw.planEngine.execute(newExecPlan);
          mw.plans.set(newPlanId, { plan: newExecPlan, resultPromise: newResultPromise, createdAt: newCreatedAt });

          currentResult = await newResultPromise;
          currentPlanId = newPlanId;
          currentPlan = newPlan;

          mw.markPlanCompleted(currentPlanId);
          (mw.plans.get(currentPlanId) as Record<string, unknown>).result = currentResult;
          const termEvent = currentResult.accepted ? 'completed' as const : 'failed' as const;
          mw.persistPlanHistory({ planId: currentPlanId, createdAt: newCreatedAt, event: termEvent, summary: currentResult.summary, accepted: currentResult.accepted, convergenceIterations: currentResult.convergenceIterations, durationMs: currentResult.totalDurationMs });
          setTimeout(() => mw.plans.delete(currentPlanId), 3_600_000);
        }

        const finalSteps = mw.buffer.list({ planId: currentPlanId });

        // Recovery options for remaining failures after replan exhausted
        let recovery: Awaited<ReturnType<typeof mw.generateRecoveryOptions>> = null;
        if (!currentResult.accepted && currentResult.summary.failed > 0) {
          const failedDetails = currentResult.steps
            .filter(s => s.status === 'failed' || s.status === 'timeout')
            .map(s => ({ id: s.id, worker: s.worker, error: s.output }));
          recovery = await mw.generateRecoveryOptions(body.goal, failedDetails, currentResult.digestContext);
        }

        return c.json({
          planId: currentPlanId,
          status: currentResult.accepted ? 'completed' : (replanRound >= MAX_REPLAN_ROUNDS ? 'plan_exhausted' : 'partial'),
          goal: body.goal,
          success_criteria: body.success_criteria,
          plan: {
            goal: currentPlan.goal,
            acceptance: currentPlan.acceptance,
            steps: currentPlan.steps.map(s => ({ id: s.id, worker: s.worker, label: s.label, dependsOn: s.dependsOn, acceptance_criteria: s.acceptance_criteria })),
          },
          steps: finalSteps.map(s => ({
            id: s.id, worker: s.worker, label: s.label, status: s.status,
            result: s.result, error: s.error, durationMs: s.durationMs,
          })),
          summary: currentResult.summary,
          ...(replanRound > 0 && { replan: { rounds: replanRound, history: replanHistory } }),
          ...(recovery && { recovery_options: recovery.options, semantic_diagnosis: recovery.semantic_diagnosis }),
        });
      } catch (err) {
        mw.markPlanCompleted(planId);
        return c.json({
          planId,
          status: 'failed',
          goal: body.goal,
          error: err instanceof Error ? err.message : String(err),
        }, 500);
      }
    }

    return c.json({
      planId,
      status: 'executing',
      goal: body.goal,
      success_criteria: body.success_criteria,
      plan: {
        goal: plan.goal,
        acceptance: plan.acceptance,
        steps: plan.steps.map(s => ({ id: s.id, worker: s.worker, label: s.label, dependsOn: s.dependsOn, acceptance_criteria: s.acceptance_criteria })),
      },
    });
  });

  // GET /status/:id — task status (full result inline)
  app.get('/status/:id', (c) => {
    const task = mw.buffer.get(c.req.param('id'));
    if (!task) return c.json({ error: 'not found' }, 404);
    const resultSize = (() => {
      const r = task.result;
      if (typeof r === 'string') return r.length;
      if (r != null) return JSON.stringify(r).length;
      return undefined;
    })();
    return c.json({ ...task, ...(resultSize !== undefined ? { resultSize } : {}) });
  });

  // GET /status/:id/result — paginated result access for large outputs
  // Query: ?offset=0&limit=5000 (default: full result)
  app.get('/status/:id/result', (c) => {
    const task = mw.buffer.get(c.req.param('id'));
    if (!task) return c.json({ error: 'not found' }, 404);
    const raw = typeof task.result === 'string' ? task.result : JSON.stringify(task.result ?? '');
    const offset = parseInt(c.req.query('offset') ?? '0');
    const limit = parseInt(c.req.query('limit') ?? '0') || raw.length;
    const slice = raw.slice(offset, offset + limit);
    return c.json({ id: task.id, totalSize: raw.length, offset, limit, hasMore: offset + limit < raw.length, data: slice });
  });

  // GET /plan/:id — plan status with merged plan structure + runtime state
  app.get('/plan/:id', async (c) => {
    const planId = c.req.param('id');
    const entry = mw.plans.get(planId);
    if (!entry) return c.json({ error: 'not found' }, 404);

    const runtimeSteps = mw.buffer.list({ planId, includeArchived: true });
    const completed = runtimeSteps.filter(s => s.status === 'completed').length;
    const failed = runtimeSteps.filter(s => s.status === 'failed').length;
    const running = runtimeSteps.filter(s => s.status === 'running').length;

    // Merge plan definition (static: dependsOn, worker, label) with runtime state
    // (status, timings, result). Source of truth for structure is the plan;
    // source of truth for execution state is the buffer. This matches GET /plans.
    const mergedSteps = entry.plan.steps.map(planStep => {
      const runtime = runtimeSteps.find(r => r.id === planStep.id);
      return {
        id: planStep.id,
        worker: planStep.worker,
        label: planStep.label,
        dependsOn: planStep.dependsOn ?? [],
        status: runtime?.status ?? 'pending',
        submittedAt: runtime?.submittedAt,
        startedAt: runtime?.startedAt,
        completedAt: runtime?.completedAt,
        durationMs: runtime?.durationMs,
        error: runtime?.error,
        result: runtime?.result,
        metadata: runtime?.metadata,
      };
    });

    const planResult = (entry as Record<string, unknown>).result as Record<string, unknown> | undefined;
    // Total duration: earliest submit to latest completion
    const submittedTimes = runtimeSteps.map(s => s.submittedAt ? new Date(s.submittedAt).getTime() : Infinity);
    const completedTimes = runtimeSteps.filter(s => s.completedAt).map(s => new Date(s.completedAt!).getTime());
    const totalDurationMs = submittedTimes.length && completedTimes.length
      ? Math.max(...completedTimes) - Math.min(...submittedTimes)
      : undefined;
    const callbackSentAt = (entry as Record<string, unknown>).callbackSentAt as string | undefined;
    return c.json({
      planId,
      goal: entry.plan.goal,
      createdAt: entry.createdAt,
      totalSteps: entry.plan.steps.length,
      completed, failed, running,
      pending: entry.plan.steps.length - completed - failed - running,
      ...(totalDurationMs !== undefined ? { totalDurationMs } : {}),
      ...(callbackSentAt ? { callbackSentAt } : {}),
      steps: mergedSteps,
      ...(planResult ? { result: { acceptance: planResult.acceptance, digestContext: planResult.digestContext } } : {}),
    });
  });

  // DELETE /plan/:id — cancel all running steps (triggers AbortController in plan engine)
  app.delete('/plan/:id', (c) => {
    const planId = c.req.param('id');
    const entry = mw.plans.get(planId);
    if (!entry) return c.json({ error: 'not found' }, 404);
    const steps = mw.buffer.list({ planId });
    let cancelled = 0;
    for (const step of steps) {
      if (step.status === 'running') {
        mw.planEngine.cancelStep(step.id); // abort the actual SDK/shell process
        mw.buffer.cancel(step.id);
        cancelled++;
      } else if (step.status === 'pending') {
        mw.buffer.cancel(step.id);
        cancelled++;
      }
    }
    return c.json({ ok: true, cancelled });
  });

  // DELETE /task/:id — cancel
  app.delete('/task/:id', (c) => {
    const ok = mw.buffer.cancel(c.req.param('id'));
    return ok ? c.json({ ok: true }) : c.json({ error: 'cannot cancel' }, 400);
  });

  // POST /task/:id/retry — manual retry of a failed/timeout/cancelled task.
  // Reuses worker + rawTask + cwd + timeoutMs from the original TaskRecord
  // metadata; caller may override cwd/timeout via body. Returns new taskId.
  app.post('/task/:id/retry', async (c) => {
    const origId = c.req.param('id');
    const original = mw.buffer.get(origId);
    if (!original) return c.json({ error: `task not found: ${origId}` }, 404);
    if (!['failed', 'timeout', 'cancelled'].includes(original.status)) {
      return c.json({ error: `cannot retry task in status: ${original.status}`, status: original.status }, 400);
    }

    const body = await c.req.json<{ cwd?: string; timeout?: number; caller?: string }>().catch(() => ({} as { cwd?: string; timeout?: number; caller?: string }));
    const meta = (original.metadata ?? {}) as { cwd?: string; timeoutMs?: number; rawTask?: unknown };
    const rawTask = meta.rawTask ?? original.task;
    const cwdOverride = body.cwd ?? meta.cwd;
    const cwdErr = cwdOverride !== undefined ? validateTaskCwd(cwdOverride) : null;
    if (cwdErr) return c.json({ error: cwdErr }, 400);

    const allW = { ...WORKERS, ...Object.fromEntries(mw.customWorkers) };
    const def = allW[original.worker];
    if (!def) return c.json({ error: `worker no longer exists: ${original.worker}` }, 400);
    const timeoutMs = body.timeout !== undefined
      ? body.timeout * 1000
      : (meta.timeoutMs ?? def.defaultTimeoutSeconds * 1000);

    const taskDesc = typeof rawTask === 'string' ? rawTask : `[multimodal: retry of ${origId}]`;
    const newId = mw.buffer.submit({
      worker: original.worker,
      task: taskDesc,
      caller: body.caller ?? `retry:${origId}`,
      metadata: { cwd: cwdOverride, timeoutMs, rawTask, retryOf: origId },
    });
    mw.buffer.start(newId);

    console.log(`[api:retry] taskId=${newId} retryOf=${origId} worker=${original.worker} cwd=${cwdOverride ?? '-'} timeoutMs=${timeoutMs}`);

    mw.executeWorker(original.worker, rawTask as string | import('./llm-provider.js').ContentBlock[], timeoutMs, cwdOverride ? { cwd: cwdOverride } : undefined)
      .then(result => {
        mw.buffer.complete(newId, result);
      })
      .catch(err => {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack?.slice(0, 500) : undefined;
        console.error(`[api:retry] FAIL taskId=${newId} retryOf=${origId} worker=${original.worker} err=${msg}${stack ? `\n${stack}` : ''}`);
        mw.buffer.fail(newId, msg);
      });

    return c.json({ taskId: newId, retryOf: origId, status: 'running', worker: original.worker });
  });

  // POST /plan/:planId/retry-failed — retry all failed/timeout steps of a plan
  // as independent dispatches (not a full plan replay). Useful when most of a
  // plan succeeded and only a few steps need a second chance. Each failed step
  // becomes a new task. Returns { retried: [{ origId, newId }], skipped: [...] }.
  app.post('/plan/:planId/retry-failed', async (c) => {
    const planId = c.req.param('planId');
    const steps = mw.buffer.list({ planId });
    if (steps.length === 0) return c.json({ error: `plan not found or has no steps: ${planId}` }, 404);

    const retryable = steps.filter(s => ['failed', 'timeout'].includes(s.status));
    if (retryable.length === 0) {
      return c.json({ error: 'no failed or timeout steps to retry', total: steps.length }, 400);
    }

    const allW = { ...WORKERS, ...Object.fromEntries(mw.customWorkers) };
    const retried: Array<{ origId: string; newId: string; worker: string }> = [];
    const skipped: Array<{ origId: string; reason: string }> = [];

    for (const step of retryable) {
      const def = allW[step.worker];
      if (!def) {
        skipped.push({ origId: step.id, reason: `worker no longer exists: ${step.worker}` });
        continue;
      }
      const meta = (step.metadata ?? {}) as { cwd?: string; timeoutMs?: number; rawTask?: unknown };
      const rawTask = meta.rawTask ?? step.task;
      const timeoutMs = meta.timeoutMs ?? def.defaultTimeoutSeconds * 1000;
      const taskDesc = typeof rawTask === 'string' ? rawTask : `[multimodal: retry of ${step.id}]`;
      const newId = mw.buffer.submit({
        worker: step.worker,
        task: taskDesc,
        caller: `retry-failed:${planId}`,
        metadata: { cwd: meta.cwd, timeoutMs, rawTask, retryOf: step.id },
      });
      mw.buffer.start(newId);
      console.log(`[api:retry-failed] taskId=${newId} retryOf=${step.id} planId=${planId} worker=${step.worker}`);

      mw.executeWorker(step.worker, rawTask as string | import('./llm-provider.js').ContentBlock[], timeoutMs, meta.cwd ? { cwd: meta.cwd } : undefined)
        .then(result => { mw.buffer.complete(newId, result); })
        .catch(err => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[api:retry-failed] FAIL taskId=${newId} retryOf=${step.id} planId=${planId} err=${msg}`);
          mw.buffer.fail(newId, msg);
        });

      retried.push({ origId: step.id, newId, worker: step.worker });
    }

    return c.json({ planId, retried, skipped, total: retryable.length });
  });

  // GET /pool — worker pool + ACP gateway status
  app.get('/pool', (c) => {
    const allW = { ...WORKERS, ...Object.fromEntries(mw.customWorkers) };
    const pool = Object.entries(allW).map(([name, def]) => ({
      name,
      backend: def.backend,
      model: def.agent.model,
      timeout: def.defaultTimeoutSeconds,
    }));
    return c.json({ workers: pool, gateway: mw.acpGateway.getStats() });
  });

  // GET /events — SSE stream
  app.get('/events', (c) => {
    // T11: optional severity filter via ?severity=critical,anomaly
    const severityFilterRaw = c.req.query('severity');
    const severityFilter = severityFilterRaw
      ? new Set(severityFilterRaw.split(',').map(s => s.trim()).filter(Boolean) as EventSeverity[])
      : null;

    return streamSSE(c, async (stream) => {
      const unsubscribe = mw.buffer.subscribe((event: TaskEvent & { planData?: unknown }) => {
        const severity = event.planData ? 'info' : classifyEventSeverity(event);
        // Apply severity filter if caller specified one
        if (severityFilter && !severityFilter.has(severity)) return;
        // Plan-level events carry planData; task events carry task record
        const base = event.planData
          ? (typeof event.planData === 'object' ? event.planData as Record<string, unknown> : {})
          : (event.task as unknown as Record<string, unknown>);
        const data = JSON.stringify({
          ...base,
          severity,
          ...(event.planData ? { worker: 'brain' } : {}),
        });
        stream.writeSSE({
          event: event.type,
          data,
        }).catch(() => {});
      });

      // Keep alive
      const interval = setInterval(() => {
        stream.writeSSE({ event: 'ping', data: new Date().toISOString() }).catch(() => {});
      }, 30_000);

      stream.onAbort(() => {
        unsubscribe();
        clearInterval(interval);
      });

      // Block until client disconnects
      await new Promise(() => {});
    });
  });

  // GET /events/history — persisted event log (survives restarts)
  // Query params: ?since=ISO&type=task.completed&limit=200
  app.get('/events/history', (c) => {
    const since = c.req.query('since') || undefined;
    const type = c.req.query('type') || undefined;
    const limit = Math.min(parseInt(c.req.query('limit') ?? '200', 10), 1000);
    const events = mw.buffer.queryEvents({ since, type, limit });
    return c.json({ events, total: events.length });
  });

  // GET /tasks — list recent tasks
  app.get('/tasks', (c) => {
    const status = c.req.query('status') as import('./result-buffer.js').TaskStatus | undefined;
    const limit = parseInt(c.req.query('limit') ?? '50');
    const tasks = mw.buffer.list({ status, limit });
    return c.json({ tasks, total: tasks.length });
  });

  // ─── Worker CRUD API ───
  // Custom workers are stored in runtime + persisted to workers.json

  // GET /workers — complete representation of all workers (no hidden fields)
  app.get('/workers', (c) => {
    const serialize = (name: string, def: WorkerDefinition, builtin: boolean) => ({
      name,
      backend: def.backend,
      vendor: def.vendor ?? 'anthropic',
      model: def.agent.model,
      description: def.agent.description,
      prompt: def.agent.prompt,
      tools: def.agent.tools,
      maxTurns: def.agent.maxTurns,
      timeout: def.defaultTimeoutSeconds,
      maxConcurrency: def.maxConcurrency,
      maxBudgetUsd: def.maxBudgetUsd,
      builtin,
      ...(def.acpCommand ? { acpCommand: def.acpCommand } : {}),
      ...(def.middlewareUrl ? { middlewareUrl: def.middlewareUrl } : {}),
      ...(def.middlewareWorker ? { middlewareWorker: def.middlewareWorker } : {}),
      ...(def.mcpServers ? { mcpServers: def.mcpServers, mcpServerNames: Object.keys(def.mcpServers) } : {}),
      ...(def.skills?.length ? { skills: def.skills } : {}),
      ...(def.shellAllowlist?.length ? { shellAllowlist: def.shellAllowlist } : {}),
      ...(def.webhook ? { webhook: def.webhook } : {}),
      ...(def.logicFn ? { logicFn: def.logicFn, hasLogicFn: true } : {}),
      ...(def.healthCheck ? { healthCheck: def.healthCheck } : {}),
      ...(def.healthFix ? { healthFix: def.healthFix } : {}),
    });
    const all = [
      ...Object.entries(WORKERS).map(([name, def]) => serialize(name, def, true)),
      ...[...mw.customWorkers.entries()].map(([name, def]) => serialize(name, def, false)),
    ];
    return c.json({ workers: all });
  });

  // GET /workers/health — check all workers' health. Returns fix commands for unhealthy workers.
  app.get('/workers/health', async (c) => {
    const allW = { ...WORKERS, ...Object.fromEntries(mw.customWorkers) };
    const results: Record<string, { healthy: boolean; reason?: string; fix?: string; checkMs?: number }> = {};
    await Promise.all(Object.entries(allW).map(async ([name, def]) => {
      if (!def.healthCheck) {
        results[name] = { healthy: true, reason: 'no health check defined — assumed healthy' };
        return;
      }
      const start = Date.now();
      try {
        execSync(def.healthCheck, { timeout: 10_000, stdio: 'ignore', cwd: config?.cwd ?? process.cwd() });
        results[name] = { healthy: true, checkMs: Date.now() - start };
      } catch {
        results[name] = { healthy: false, reason: `health check failed: ${def.healthCheck}`, checkMs: Date.now() - start, ...(def.healthFix ? { fix: def.healthFix } : {}) };
      }
    }));
    const healthyCount = Object.values(results).filter(r => r.healthy).length;
    return c.json({ total: Object.keys(results).length, healthy: healthyCount, workers: results });
  });

  // healthFix is informational — AI reads it from GET /workers/health and decides what to do

  // POST /workers — add a custom worker
  app.post('/workers', async (c) => {
    const body = await c.req.json<{
      name: string; backend?: string; model?: string; vendor?: string;
      description?: string; prompt?: string; tools?: string[];
      maxTurns?: number; timeout?: number;
      maxConcurrency?: number; maxBudgetUsd?: number;
      acpCommand?: string;
      middlewareUrl?: string; middlewareWorker?: string;
      webhook?: { url: string; method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; headers?: Record<string, string>; bodyTemplate?: string; resultPath?: string };
      logicFn?: string;
      shellAllowlist?: string[];
      mcpServers?: Record<string, unknown>; skills?: string[];
      healthCheck?: string; healthFix?: string;
    }>();
    if (!body.name) return c.json({ error: 'name required' }, 400);
    if (WORKERS[body.name]) return c.json({ error: 'cannot override built-in worker' }, 400);

    const def: WorkerDefinition = {
      agent: {
        description: body.description ?? `Custom worker: ${body.name}`,
        tools: body.tools ?? ['Read', 'Grep', 'Glob', 'Bash'],
        prompt: body.prompt ?? 'You are a helpful assistant.',
        model: body.model ?? 'sonnet',
        maxTurns: body.maxTurns ?? 10,
      },
      backend: (body.backend ?? 'sdk') as WorkerDefinition['backend'],
      vendor: (body.vendor ?? 'anthropic') as WorkerDefinition['vendor'],
      defaultTimeoutSeconds: body.timeout ?? 120,
      ...(body.maxConcurrency != null ? { maxConcurrency: body.maxConcurrency } : {}),
      ...(body.maxBudgetUsd != null ? { maxBudgetUsd: body.maxBudgetUsd } : {}),
      ...(body.acpCommand ? { acpCommand: body.acpCommand } : {}),
      ...(body.middlewareUrl ? { middlewareUrl: body.middlewareUrl } : {}),
      ...(body.middlewareWorker ? { middlewareWorker: body.middlewareWorker } : {}),
      ...(body.webhook ? { webhook: body.webhook } : {}),
      ...(body.logicFn ? { logicFn: body.logicFn } : {}),
      ...(body.shellAllowlist?.length ? { shellAllowlist: body.shellAllowlist } : {}),
      ...(body.mcpServers ? { mcpServers: body.mcpServers } : {}),
      ...(body.skills ? { skills: body.skills } : {}),
      ...(body.healthCheck ? { healthCheck: body.healthCheck } : {}),
      ...(body.healthFix ? { healthFix: body.healthFix } : {}),
    };

    mw.customWorkers.set(body.name, def);
    // Register SDK provider if sdk backend (skills composed at runtime via composePrompt)
    if (def.backend === 'sdk') {
      mw.workerProviders.set(body.name, createSdkProvider({
        model: def.agent.model ?? 'sonnet',
        cwd: config?.cwd ?? process.cwd(),
        allowedTools: def.agent.tools as string[] | undefined,
        maxTurns: def.agent.maxTurns,
        maxBudgetUsd: def.maxBudgetUsd ?? 5,
        mcpServers: def.mcpServers,
      }));
    }
    mw.persistCustomWorkers();
    return c.json({ ok: true, name: body.name });
  });

  // PUT /workers/:name — update a custom worker
  app.put('/workers/:name', async (c) => {
    const name = c.req.param('name');
    if (WORKERS[name]) return c.json({ error: 'cannot modify built-in worker' }, 400);
    if (!mw.customWorkers.has(name)) return c.json({ error: 'worker not found' }, 404);

    const body = await c.req.json<{
      backend?: string; vendor?: string; model?: string; description?: string;
      prompt?: string; tools?: string[]; maxTurns?: number; timeout?: number;
      maxConcurrency?: number; maxBudgetUsd?: number;
      acpCommand?: string;
      middlewareUrl?: string; middlewareWorker?: string;
      webhook?: { url: string; method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; headers?: Record<string, string>; bodyTemplate?: string; resultPath?: string };
      logicFn?: string;
      shellAllowlist?: string[];
      mcpServers?: Record<string, unknown>; skills?: string[];
      healthCheck?: string; healthFix?: string;
    }>();

    const existing = mw.customWorkers.get(name)!;
    const updated: WorkerDefinition = {
      agent: {
        description: body.description ?? existing.agent.description,
        tools: body.tools ?? existing.agent.tools,
        prompt: body.prompt ?? existing.agent.prompt,
        model: body.model ?? existing.agent.model,
        maxTurns: body.maxTurns ?? existing.agent.maxTurns,
      },
      backend: (body.backend ?? existing.backend) as WorkerDefinition['backend'],
      vendor: (body.vendor ?? existing.vendor) as WorkerDefinition['vendor'],
      defaultTimeoutSeconds: body.timeout ?? existing.defaultTimeoutSeconds,
      maxConcurrency: body.maxConcurrency ?? existing.maxConcurrency,
      maxBudgetUsd: body.maxBudgetUsd ?? existing.maxBudgetUsd,
      acpCommand: body.acpCommand ?? existing.acpCommand,
      middlewareUrl: body.middlewareUrl ?? existing.middlewareUrl,
      middlewareWorker: body.middlewareWorker ?? existing.middlewareWorker,
      webhook: body.webhook ?? existing.webhook,
      logicFn: body.logicFn ?? existing.logicFn,
      shellAllowlist: body.shellAllowlist ?? existing.shellAllowlist,
      mcpServers: body.mcpServers ?? existing.mcpServers,
      skills: body.skills ?? existing.skills,
      healthCheck: body.healthCheck ?? existing.healthCheck,
      healthFix: body.healthFix ?? existing.healthFix,
    };

    mw.customWorkers.set(name, updated);
    if (updated.backend === 'sdk') {
      mw.workerProviders.set(name, createSdkProvider({
        model: updated.agent.model ?? 'sonnet',
        cwd: config?.cwd ?? process.cwd(),
        allowedTools: updated.agent.tools as string[] | undefined,
        maxTurns: updated.agent.maxTurns,
        maxBudgetUsd: updated.maxBudgetUsd ?? 5,
        mcpServers: updated.mcpServers,
      }));
    }
    mw.persistCustomWorkers();
    return c.json({ ok: true, name });
  });

  // DELETE /workers/:name — remove a custom worker
  app.delete('/workers/:name', (c) => {
    const name = c.req.param('name');
    if (WORKERS[name]) return c.json({ error: 'cannot delete built-in worker' }, 400);
    if (!mw.customWorkers.has(name)) return c.json({ error: 'worker not found' }, 404);
    mw.customWorkers.delete(name);
    mw.workerProviders.delete(name);
    mw.persistCustomWorkers();
    return c.json({ ok: true });
  });

  // GET /plans/history — paginated audit log of all plans ever submitted
  // Reads from append-only JSONL (survives 1h evict + middleware restart).
  // Merges with live buffer state for runtime status when available.
  // Query params: ?since=ISO&until=ISO&status=completed|failed|running&limit=N&offset=N
  app.get('/plans/history', (c) => {
    const records = mw.readPlanHistory();
    const since = c.req.query('since');
    const until = c.req.query('until');
    const statusFilter = c.req.query('status');
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 500);
    const offset = parseInt(c.req.query('offset') ?? '0', 10);

    // Build terminal event map: planId → last event (completed/failed)
    const terminalEvents = new Map<string, PlanHistoryRecord>();
    for (const r of records) {
      if (r.event === 'completed' || r.event === 'failed') terminalEvents.set(r.planId, r);
    }

    // Enrich each record with current runtime state from buffer
    const enriched = records.filter(r => r.plan).map(r => {
      const runtimeSteps = mw.buffer.list({ planId: r.planId });
      const completed = runtimeSteps.filter(s => s.status === 'completed').length;
      const failed = runtimeSteps.filter(s => s.status === 'failed' || s.status === 'timeout').length;
      const running = runtimeSteps.filter(s => s.status === 'running').length;
      const total = r.plan!.steps.length;

      // Check JSONL terminal event when buffer is empty (tasks evicted after 1h)
      const terminal = terminalEvents.get(r.planId);
      const planStatus =
        running > 0 ? 'running'
        : failed > 0 ? 'failed'
        : completed === total ? 'completed'
        : completed === 0 && failed === 0 && running === 0
          ? (terminal?.event === 'completed' ? 'completed'
             : terminal?.event === 'failed' ? 'failed'
             : 'unknown')
        : 'partial';

      // Use terminal summary when buffer is evicted
      const termCompleted = terminal?.summary?.completed ?? completed;
      const termFailed = terminal?.summary?.failed ?? failed;

      return {
        planId: r.planId,
        createdAt: r.createdAt,
        caller: r.caller,
        goal: r.plan!.goal,
        totalSteps: total,
        completed: completed || termCompleted,
        failed: failed || termFailed,
        running,
        status: planStatus,
        durationMs: terminal?.durationMs,
      };
    });

    // Filter
    let filtered = enriched;
    if (since) filtered = filtered.filter(r => r.createdAt >= since);
    if (until) filtered = filtered.filter(r => r.createdAt <= until);
    if (statusFilter) filtered = filtered.filter(r => r.status === statusFilter);

    // Sort newest first
    filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    // Paginate
    const total = filtered.length;
    const page = filtered.slice(offset, offset + limit);
    return c.json({ total, offset, limit, plans: page });
  });

  // GET /plans/history/:planId — single historical plan with full definition
  // Returns plan.steps with dependsOn/worker/label/retry — enables replay.
  // Works even for 1h-evicted plans (reads from JSONL).
  app.get('/plans/history/:planId', (c) => {
    const planId = c.req.param('planId');
    const records = mw.readPlanHistory();
    const record = records.find(r => r.planId === planId && r.plan);
    if (!record || !record.plan) return c.json({ error: 'not found in history' }, 404);
    // Historical plan uses LOGICAL step IDs (pre-prefix). Runtime buffer uses
    // prefixed IDs (`{planId}_{stepId}`). Match by constructing the expected
    // runtime ID from logical + planId.
    const runtimeSteps = mw.buffer.list({ planId, includeArchived: true });
    const mergedSteps = record.plan.steps.map(ps => {
      const runtimeId = `${planId}_${ps.id}`;
      const runtime = runtimeSteps.find(r => r.id === runtimeId);
      return {
        id: ps.id,
        worker: ps.worker,
        label: ps.label,
        task: ps.task,
        dependsOn: ps.dependsOn ?? [],
        retry: ps.retry,
        condition: ps.condition,
        // Runtime fields (may be undefined if evicted from buffer too)
        status: runtime?.status,
        submittedAt: runtime?.submittedAt,
        startedAt: runtime?.startedAt,
        completedAt: runtime?.completedAt,
        durationMs: runtime?.durationMs,
        error: runtime?.error,
        result: runtime?.result,
      };
    });
    return c.json({
      planId,
      createdAt: record.createdAt,
      caller: record.caller,
      goal: record.plan.goal,
      acceptance: record.plan.acceptance,
      totalSteps: record.plan.steps.length,
      steps: mergedSteps,
    });
  });

  // POST /plans/history/:planId/replay — create a NEW plan from historical definition
  // History stores LOGICAL plan (pre-prefix), so replay just re-runs the same
  // submission flow as POST /plan: validate → prefix → execute. Zero stripping needed.
  // Returns new planId. Original remains unchanged in history.
  app.post('/plans/history/:planId/replay', async (c) => {
    const originalId = c.req.param('planId');
    const records = mw.readPlanHistory();
    const record = records.find(r => r.planId === originalId && r.plan);
    if (!record || !record.plan) return c.json({ error: 'not found in history' }, 404);

    // Logical plan from history — all IDs/dependsOn/condition.stepId/templates
    // are in their pre-prefix form. This is structurally identical to what
    // POST /plan receives as `body.steps` + `body.goal`.
    const logicalPlan: ActionPlan = record.plan;
    const errors = mw.planEngine.validate(logicalPlan, new Set(mergedWorkerNames()));
    if (errors.length > 0) return c.json({ error: 'replay validation failed', errors, originalPlanId: originalId }, 400);

    const newPlanId = `plan-${Date.now()}-${(mw.planCounter++).toString(36)}`;
    const replayCaller = `replay:${originalId}`;
    for (const step of logicalPlan.steps) {
      const uid = `${newPlanId}_${step.id}`;
      mw.buffer.submit({ id: uid, planId: newPlanId, worker: step.worker, task: step.task, label: step.label, caller: replayCaller });
    }
    const idMap = new Map(logicalPlan.steps.map(s => [s.id, `${newPlanId}_${s.id}`]));
    const remapTemplates = (task: string) => {
      let t = task;
      for (const [orig, prefixed] of idMap) t = t.replaceAll(`{{${orig}.`, `{{${prefixed}.`);
      return t;
    };
    const execPlan: ActionPlan = {
      ...logicalPlan,
      steps: logicalPlan.steps.map(s => ({
        ...s,
        id: idMap.get(s.id)!,
        task: typeof s.task === 'string' ? remapTemplates(s.task) : s.task,
        dependsOn: (s.dependsOn ?? []).map(d => idMap.get(d) ?? d),
        // Remap condition.stepId if present — it references another step by logical ID
        condition: s.condition ? { ...s.condition, stepId: idMap.get(s.condition.stepId) ?? s.condition.stepId } : undefined,
      })),
      // Remap convergence.checkStepId if present
      convergence: logicalPlan.convergence
        ? { ...logicalPlan.convergence, checkStepId: logicalPlan.convergence.checkStepId ? (idMap.get(logicalPlan.convergence.checkStepId) ?? logicalPlan.convergence.checkStepId) : undefined }
        : undefined,
    };
    const resultPromise = mw.planEngine.execute(execPlan);
    const createdAt = new Date().toISOString();
    mw.plans.set(newPlanId, { plan: execPlan, resultPromise, createdAt });
    mw.evictOldPlans();
    // Persist the LOGICAL plan (not execPlan) — matches POST /plan behavior
    mw.persistPlanHistory({ planId: newPlanId, createdAt, caller: replayCaller, plan: logicalPlan, event: 'created' });

    // Match POST /plan lifecycle: mark completed + 1h cleanup after completion
    resultPromise.then(result => {
      for (const step of result.steps) {
        if (step.status === 'skipped' || step.status === 'condition_skipped') {
          mw.buffer.skip(step.id, step.output);
        } else if (step.status !== 'completed') {
          mw.buffer.fail(step.id, step.output);
        }
      }
      mw.markPlanCompleted(newPlanId);
      (mw.plans.get(newPlanId) as Record<string, unknown>).result = result;
      mw.persistPlanHistory({ planId: newPlanId, createdAt, event: 'completed', summary: result.summary, accepted: result.accepted, convergenceIterations: result.convergenceIterations, durationMs: result.totalDurationMs });
      setTimeout(() => mw.plans.delete(newPlanId), 3_600_000);
    }).catch(() => {
      mw.markPlanCompleted(newPlanId);
      mw.persistPlanHistory({ planId: newPlanId, createdAt, event: 'failed' });
      setTimeout(() => mw.plans.delete(newPlanId), 3_600_000);
    });

    return c.json({
      planId: newPlanId,
      replayedFrom: originalId,
      status: 'executing',
      steps: execPlan.steps.length,
    });
  });

  // GET /plans — list all plans with goals
  app.get('/plans', (c) => {
    const plans = [...mw.plans.entries()].map(([id, entry]) => {
      const steps = mw.buffer.list({ planId: id });
      const completed = steps.filter(s => s.status === 'completed').length;
      const failed = steps.filter(s => s.status === 'failed' || s.status === 'timeout').length;
      const running = steps.filter(s => s.status === 'running').length;
      return {
        planId: id,
        goal: entry.plan.goal,
        acceptance: entry.plan.acceptance,
        createdAt: entry.createdAt,
        totalSteps: entry.plan.steps.length,
        completed, failed, running,
        steps: entry.plan.steps.map(s => ({
          id: s.id, worker: s.worker, label: s.label, dependsOn: s.dependsOn,
          status: steps.find(t => t.id === s.id)?.status ?? 'pending',
          durationMs: steps.find(t => t.id === s.id)?.durationMs,
          resultSize: (() => { const r = steps.find(t => t.id === s.id)?.result; if (typeof r === 'string') return r.length; if (r != null) return JSON.stringify(r).length; return undefined; })(),
        })),
      };
    });
    return c.json({ plans });
  });

  // ─── Plan Validate (dry-run) ───
  app.post('/plan/validate', async (c) => {
    const body = await c.req.json<ActionPlan>();
    const allW = { ...WORKERS, ...Object.fromEntries(mw.customWorkers) };
    const errors = mw.planEngine.validate(body, new Set(Object.keys(allW)));
    return c.json({ valid: errors.length === 0, errors });
  });

  // ─── Plan Templates ───
  app.get('/templates', (c) => {
    return c.json({ templates: PLAN_TEMPLATES });
  });

  app.post('/plan/from-template', async (c) => {
    const body = await c.req.json<{ template: string; params: Record<string, string>; caller?: string }>();
    const tpl = PLAN_TEMPLATES.find(t => t.name === body.template);
    if (!tpl) return c.json({ error: `Unknown template: ${body.template}` }, 400);

    // Validate required params
    const missing = tpl.params.filter(p => p.required && !body.params[p.name]);
    if (missing.length > 0) return c.json({ error: 'missing_params', missing: missing.map(p => p.name) }, 400);

    // Instantiate template — replace all params (required + optional fallback to empty)
    // Values are JSON-escaped to prevent injection (quotes, newlines, backslashes)
    let planJson = JSON.stringify(tpl.plan);
    for (const param of tpl.params) {
      const value = body.params[param.name] ?? '';
      // JSON.stringify adds surrounding quotes — slice them off to get escaped interior
      const escaped = JSON.stringify(value).slice(1, -1);
      planJson = planJson.replaceAll(`{{${param.name}}}`, escaped);
    }
    const plan = JSON.parse(planJson) as ActionPlan;

    // Submit as normal plan
    const errors = mw.planEngine.validate(plan, new Set(Object.keys({ ...WORKERS, ...Object.fromEntries(mw.customWorkers) })));
    if (errors.length > 0) return c.json({ error: 'template_validation_failed', errors }, 400);

    const planId = `plan-${Date.now()}-${(mw.planCounter++).toString(36)}`;
    for (const step of plan.steps) {
      mw.buffer.submit({ id: `${planId}_${step.id}`, planId, worker: step.worker, task: step.task, label: step.label, caller: body.caller });
    }
    const tplIdMap = new Map(plan.steps.map(s => [s.id, `${planId}_${s.id}`]));
    const tplRemapTemplates = (task: string) => {
      let t = task;
      for (const [orig, prefixed] of tplIdMap) t = t.replaceAll(`{{${orig}.`, `{{${prefixed}.`);
      return t;
    };
    const execPlan = {
      ...plan,
      steps: plan.steps.map(s => ({
        ...s,
        id: tplIdMap.get(s.id)!,
        task: tplRemapTemplates(s.task),
        dependsOn: (s.dependsOn ?? []).map((d: string) => tplIdMap.get(d) ?? d),
      })),
    };
    const resultPromise = mw.planEngine.execute(execPlan);
    const createdAt = new Date().toISOString();
    mw.plans.set(planId, { plan: execPlan, resultPromise, createdAt });
    mw.evictOldPlans();
    // Persist LOGICAL plan (pre-prefix) for replay/audit
    mw.persistPlanHistory({ planId, createdAt, plan, event: 'created' });
    resultPromise.then(result => {
      mw.markPlanCompleted(planId);
      (mw.plans.get(planId) as Record<string, unknown>).result = result;
      mw.persistPlanHistory({ planId, createdAt, event: 'completed', summary: result.summary, accepted: result.accepted, convergenceIterations: result.convergenceIterations, durationMs: result.totalDurationMs });
      setTimeout(() => mw.plans.delete(planId), 3_600_000);
    }).catch(() => {
      mw.markPlanCompleted(planId);
      mw.persistPlanHistory({ planId, createdAt, event: 'failed' });
      setTimeout(() => mw.plans.delete(planId), 3_600_000);
    });

    return c.json({ planId, status: 'executing', steps: plan.steps.length, template: body.template });
  });

  // ─── Archived (Achieved) API ───

  // GET /archived — completed tasks moved from main list
  app.get('/archived', (c) => {
    const limit = parseInt(c.req.query('limit') ?? '50');
    return c.json({ tasks: mw.buffer.getArchived(limit) });
  });

  // Periodic cleanup: archive completed tasks after 1h, expire after 7d
  // + lifecycle sweep: cancel orphaned tasks, expire stale commitments
  const COMMITMENT_STALE_SECONDS = 7 * 24 * 3600; // 7 days
  const cleanupTimer = setInterval(() => {
    mw.buffer.cleanup({ archiveAfterMs: 3_600_000, expireAfterMs: 7 * 24 * 3_600_000 });

    // Timeout stuck-running tasks (worker died without updating status).
    // Seen 2026-04-18: analyst task plan-1775966160998 stuck in running 6 days.
    // Threshold 1h > any legitimate worker timeout (max seen: 1500s = 25min).
    const timedOut = mw.buffer.timeoutStuckRunning(3_600_000);
    if (timedOut > 0) console.log(`[lifecycle] timed out ${timedOut} stuck-running tasks`);

    // Lifecycle sweep: cancel orphaned pending tasks (plan lost on restart/eviction)
    const activePlanIds = new Set(mw.plans.keys());
    const orphaned = mw.buffer.cancelOrphans(activePlanIds);
    if (orphaned > 0) console.log(`[lifecycle] cancelled ${orphaned} orphaned tasks`);

    // Lifecycle sweep: expire stale commitments (active > 7 days)
    try {
      const stale = mw.commitments.stale({ older_than_seconds: COMMITMENT_STALE_SECONDS, status: 'active' });
      for (const c of stale) {
        mw.commitments.patch(c.id, { status: 'cancelled', resolution: { kind: 'cancel', evidence: 'lifecycle-gc: auto-expired active > 7d' } });
      }
      if (stale.length > 0) console.log(`[lifecycle] expired ${stale.length} stale commitments`);
    } catch (e) { console.warn('[lifecycle] commitment GC error (fail-open):', e); }
  }, 60_000);
  // Periodic compaction: compact JSONL files every 6h
  const compactionTimer = setInterval(() => {
    const ph = mw.compactPlanHistory(30);
    if (ph.removed > 0) console.log(`[lifecycle] compaction: plan-history removed ${ph.removed}, kept ${ph.kept}`);
    const cm = mw.commitments.compact();
    if (cm) console.log(`[lifecycle] compaction: commitments deduped to ${cm.after} records`);
    const ev = mw.buffer.compactEvents(7);
    if (ev.removed > 0) console.log(`[lifecycle] compaction: events removed ${ev.removed}, kept ${ev.kept}`);
  }, 6 * 3_600_000);
  // Graceful shutdown: clear intervals
  process.on('SIGTERM', () => { clearInterval(cleanupTimer); clearInterval(compactionTimer); });
  process.on('SIGINT', () => { clearInterval(cleanupTimer); clearInterval(compactionTimer); });

  // ─── Presets API ───

  // GET /presets — list all presets
  app.get('/presets', (c) => c.json({ presets: mw.presetManager.list() }));

  // POST /presets — create custom preset
  app.post('/presets', async (c) => {
    const body = await c.req.json<{
      name: string; description?: string; tools?: string[]; model?: string;
      vendor?: string; backend?: string; timeout?: number; maxTurns?: number;
    }>();
    if (!body.name) return c.json({ error: 'name required' }, 400);
    try {
      mw.presetManager.set({
        name: body.name,
        description: body.description ?? `Custom preset: ${body.name}`,
        tools: body.tools ?? ['Read', 'Grep', 'Glob', 'Bash'],
        model: body.model ?? 'sonnet',
        vendor: body.vendor ?? 'anthropic',
        backend: body.backend ?? 'sdk',
        timeout: body.timeout ?? 120,
        maxTurns: body.maxTurns ?? 10,
      });
      return c.json({ ok: true, name: body.name });
    } catch (e) { return c.json({ error: e instanceof Error ? e.message : String(e) }, 400); }
  });

  // DELETE /presets/:name — delete custom preset
  app.delete('/presets/:name', (c) => {
    try {
      const ok = mw.presetManager.delete(c.req.param('name'));
      return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
    } catch (e) { return c.json({ error: e instanceof Error ? e.message : String(e) }, 400); }
  });

  // ─── ACP Gateway API ───

  // GET /gateway — gateway stats (backends, sessions, dispatch count)
  app.get('/gateway', (c) => {
    return c.json(mw.acpGateway.getStats());
  });

  // POST /gateway/backends — register a new CLI backend
  app.post('/gateway/backends', async (c) => {
    const body = await c.req.json<CLIBackend>();
    if (!body.name || !body.command) return c.json({ error: 'name and command required' }, 400);
    body.maxSessions ??= 2;
    body.args ??= [];
    mw.acpGateway.register(body);
    return c.json({ ok: true, name: body.name });
  });

  // DELETE /gateway/backends/:name — unregister a CLI backend
  app.delete('/gateway/backends/:name', (c) => {
    const name = c.req.param('name');
    mw.acpGateway.unregister(name);
    return c.json({ ok: true });
  });

  // POST /gateway/dispatch — dispatch directly to ACP (bypass worker routing)
  app.post('/gateway/dispatch', async (c) => {
    const body = await c.req.json<{ backend: string; task: string; timeout?: number }>();
    if (!body.backend || !body.task) return c.json({ error: 'backend and task required' }, 400);
    const timeoutMs = (body.timeout ?? 120) * 1000;
    const taskId = mw.buffer.submit({ worker: `acp:${body.backend}`, task: body.task });
    mw.buffer.start(taskId);
    mw.acpGateway.dispatch(body.backend, body.task, timeoutMs)
      .then(result => mw.buffer.complete(taskId, result))
      .catch(err => mw.buffer.fail(taskId, err instanceof Error ? err.message : String(err)));
    return c.json({ taskId, status: 'running', backend: body.backend });
  });

  // ─── Commitments Ledger (proposal §5 — cross-cycle "I will do X" durability) ───
  // POST /commit       — create
  // PATCH /commit/:id  — update status / resolution / linked ids
  // GET /commits       — query (status, channel)
  // GET /commits/stale — older-than filter (perception hook)
  app.post('/commit', async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
    const v = validateCommitmentInput(body);
    if (!v.ok) return c.json({ error: 'validation_failed', message: v.error }, 400);
    const cmt = mw.commitments.create(v.value);
    return c.json(cmt);
  });

  app.get('/commit/:id', (c) => {
    const cmt = mw.commitments.get(c.req.param('id'));
    if (!cmt) return c.json({ error: 'not_found' }, 404);
    return c.json(cmt);
  });

  app.patch('/commit/:id', async (c) => {
    const id = c.req.param('id');
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
    if (!body || typeof body !== 'object') return c.json({ error: 'body must be object' }, 400);
    const b = body as Record<string, unknown>;
    const validStatuses: CommitmentStatus[] = ['active', 'fulfilled', 'superseded', 'cancelled'];
    if (b.status !== undefined && !validStatuses.includes(b.status as CommitmentStatus)) {
      return c.json({ error: `status must be one of: ${validStatuses.join(',')}` }, 400);
    }
    const patch: CommitmentPatch = {};
    if (b.status) patch.status = b.status as CommitmentStatus;
    if (b.linked_task_id !== undefined) patch.linked_task_id = typeof b.linked_task_id === 'string' ? b.linked_task_id : undefined;
    if (b.linked_dag_id !== undefined) patch.linked_dag_id = typeof b.linked_dag_id === 'string' ? b.linked_dag_id : undefined;
    if (b.resolution && typeof b.resolution === 'object') {
      const r = b.resolution as Record<string, unknown>;
      if (typeof r.kind === 'string' && typeof r.evidence === 'string') {
        patch.resolution = { kind: r.kind as CommitmentPatch['resolution'] extends infer T ? T extends { kind: infer K } ? K : never : never, evidence: r.evidence };
      }
    }
    const updated = mw.commitments.patch(id, patch);
    if (!updated) return c.json({ error: 'not_found', id }, 404);
    return c.json(updated);
  });

  app.get('/commits', (c) => {
    const status = c.req.query('status') as CommitmentStatus | undefined;
    const channel = (c.req.query('channel') ?? c.req.query('source.channel')) as CommitmentChannel | undefined;
    const owner = c.req.query('owner') as CommitmentOwner | undefined;
    const items = mw.commitments.query({ status, channel, owner });
    return c.json({ count: items.length, items });
  });

  app.get('/commits/stale', (c) => {
    const olderThanRaw = c.req.query('older_than_seconds') ?? '900';
    const older_than_seconds = Number.parseInt(olderThanRaw, 10);
    if (!Number.isFinite(older_than_seconds) || older_than_seconds < 0) {
      return c.json({ error: 'older_than_seconds must be non-negative integer' }, 400);
    }
    const status = c.req.query('status') as CommitmentStatus | undefined;
    const items = mw.commitments.stale({ older_than_seconds, status });
    return c.json({ count: items.length, older_than_seconds, items });
  });

  // ─── Tactical Command Board (T1/T2/T4) ───
  // Per brain-only-kuro-v2 proposal §7 Phase C — unified view of in-flight /
  // historical tasks, keyed on agent (caller). Data source: ResultBuffer.
  // T4 (needs-attention) = T1 piped through scorer-worker + Kuro rubric.
  const ACTIVE_STATUSES: TaskStatus[] = ['pending', 'running'];
  const TERMINAL_STATUSES: TaskStatus[] = ['completed', 'failed', 'timeout', 'cancelled'];

  interface TacticRecord {
    task_id: string;
    plan_id?: string;
    worker: string;
    label?: string;
    status: TaskStatus;
    caller?: string;
    submitted_at: string;
    started_at?: string;
    completed_at?: string;
    duration_ms?: number;
    error?: string;
  }

  const taskToTactic = (t: TaskRecord): TacticRecord => ({
    task_id: t.id,
    plan_id: t.planId,
    worker: t.worker,
    label: t.label,
    status: t.status,
    caller: t.caller,
    submitted_at: t.submittedAt instanceof Date ? t.submittedAt.toISOString() : String(t.submittedAt),
    started_at: t.startedAt instanceof Date ? t.startedAt.toISOString() : t.startedAt as string | undefined,
    completed_at: t.completedAt instanceof Date ? t.completedAt.toISOString() : t.completedAt as string | undefined,
    duration_ms: t.durationMs,
    error: t.error,
  });

  // Parse window like "24h", "7d", "1200s", "30m" → seconds
  const parseWindow = (s: string): number | null => {
    const m = s.match(/^(\d+)(s|m|h|d)$/);
    if (!m) return null;
    const n = Number.parseInt(m[1], 10);
    const mult = ({ s: 1, m: 60, h: 3600, d: 86400 } as const)[m[2] as 's' | 'm' | 'h' | 'd'];
    return n * mult;
  };

  app.get('/api/tactics/in-flight', (c) => {
    const agent = c.req.query('agent');
    const items: TacticRecord[] = [];
    for (const status of ACTIVE_STATUSES) {
      for (const t of mw.buffer.list({ caller: agent, status })) {
        items.push(taskToTactic(t));
      }
    }
    // Sort ascending by submitted_at (oldest first = earliest waiting)
    items.sort((a, b) => a.submitted_at.localeCompare(b.submitted_at));
    return c.json({ count: items.length, agent: agent ?? null, items });
  });

  // ─── Worker Capabilities / Service Discovery ───
  // Per Alex 2026-04-17 "中台的 worker 服務發現問題". Agents query this to
  // learn what workers are available + how to invoke — prevents mis-invocation
  // (e.g. shell worker receiving natural language instead of valid bash cmd).
  //
  // Output: compact list suitable for prompt injection. Bad/good examples
  // live in worker.agent.description (updated as we observe failure patterns).
  app.get('/api/workers/capabilities', (c) => {
    const workers = allWorkers();
    const capabilities = Object.entries(workers).map(([name, rawDef]) => {
      const def = rawDef as WorkerDefinition;
      return {
        name,
        description: def.agent?.description ?? '',
        backend: def.backend,
        model: def.agent?.model,
        maxTurns: def.agent?.maxTurns,
        tools: (def.agent?.tools ?? []) as unknown[],
        maxConcurrency: def.maxConcurrency,
        defaultTimeoutSeconds: def.defaultTimeoutSeconds,
      };
    });
    return c.json({ count: capabilities.length, workers: capabilities });
  });

  // ─── Webhook Hook Registry (T16) + DLQ read (T17) ───
  // Per brain-only-kuro-v2 Phase E. Outbound event notification to third parties.
  app.post('/api/hooks', async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
    if (!body || typeof body !== 'object') return c.json({ error: 'body must be object' }, 400);
    const b = body as { url?: unknown; event_pattern?: unknown; severity_filter?: unknown; secret?: unknown };
    if (typeof b.url !== 'string' || !b.url.trim()) return c.json({ error: 'url required' }, 400);
    if (typeof b.event_pattern !== 'string') return c.json({ error: 'event_pattern required' }, 400);
    const validPatterns: HookEventPattern[] = ['*', 'task.*', 'task.submitted', 'task.started', 'task.completed', 'task.failed', 'task.cancelled'];
    if (!validPatterns.includes(b.event_pattern as HookEventPattern)) {
      return c.json({ error: 'invalid_event_pattern', accepted: validPatterns }, 400);
    }
    const input: HookInput = {
      url: b.url,
      event_pattern: b.event_pattern as HookEventPattern,
    };
    if (Array.isArray(b.severity_filter)) input.severity_filter = b.severity_filter as EventSeverity[];
    if (typeof b.secret === 'string' && b.secret.length > 0) input.secret = b.secret;
    const hook = mw.hookRegistry.create(input);
    // Don't echo secret back
    const { secret: _s, ...safe } = hook;
    return c.json(safe);
  });

  app.get('/api/hooks', (c) => {
    const items = mw.hookRegistry.list().map(h => {
      const { secret: _s, ...safe } = h;
      return safe;
    });
    return c.json({ count: items.length, items });
  });

  app.delete('/api/hooks/:id', (c) => {
    const ok = mw.hookRegistry.delete(c.req.param('id'));
    if (!ok) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true });
  });

  app.get('/api/hooks/dlq', (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10), 500);
    const entries = mw.webhookDispatcher.readDLQ(limit);
    return c.json({ count: entries.length, entries });
  });

  // T9: Tactics amend — runtime modification of in-flight plans.
  // Per brain-only-kuro-v2 Phase C. MVP scope: cancel_step + cancel_plan.
  // insert_step / modify_step require DAG state rewire — return 501 with hint.
  app.post('/api/tactics/amend', async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
    if (!body || typeof body !== 'object') return c.json({ error: 'body must be object' }, 400);
    const b = body as { operation?: unknown; plan_id?: unknown; step_id?: unknown };
    const operation = typeof b.operation === 'string' ? b.operation : null;
    if (!operation) {
      return c.json({
        error: 'operation_required',
        accepted: ['cancel_step', 'cancel_plan', 'insert_step (not impl)', 'modify_step (not impl)'],
      }, 400);
    }

    interface AmendDiffEntry {
      op: string;
      step_id: string;
      ok: boolean;
      reason?: string;
    }

    if (operation === 'cancel_step') {
      const stepId = typeof b.step_id === 'string' ? b.step_id : null;
      if (!stepId) return c.json({ error: 'step_id_required', operation }, 400);
      const ok = mw.planEngine.cancelStep(stepId);
      const diff: AmendDiffEntry[] = [
        { op: 'cancel_step', step_id: stepId, ok, reason: ok ? undefined : 'step not running or unknown' },
      ];
      return c.json({ operation, applied: ok ? 1 : 0, diff });
    }

    if (operation === 'cancel_plan') {
      const planId = typeof b.plan_id === 'string' ? b.plan_id : null;
      if (!planId) return c.json({ error: 'plan_id_required', operation }, 400);
      const planEntry = mw.plans.get(planId) as { plan?: { steps?: Array<{ id?: string }> } } | undefined;
      if (!planEntry) return c.json({ error: 'plan_not_found', plan_id: planId }, 404);
      const steps = planEntry.plan?.steps ?? [];
      const diff: AmendDiffEntry[] = [];
      let applied = 0;
      for (const step of steps) {
        if (!step.id) continue;
        const ok = mw.planEngine.cancelStep(step.id);
        diff.push({ op: 'cancel_step', step_id: step.id, ok });
        if (ok) applied++;
      }
      return c.json({
        operation,
        plan_id: planId,
        applied,
        total_steps: steps.length,
        diff,
      });
    }

    if (operation === 'insert_step' || operation === 'modify_step') {
      return c.json({
        error: 'operation_not_implemented',
        operation,
        hint: 'T9 MVP implements cancel_step + cancel_plan. insert/modify require DAG state rewire — defer to v1.x. Use /dispatch for ad-hoc task additions; re-submit new /plan for whole-plan modifications.',
      }, 501);
    }

    return c.json({
      error: 'unknown_operation',
      operation,
      accepted: ['cancel_step', 'cancel_plan'],
    }, 400);
  });

  // T3: Scorer endpoint — wraps rubric + items into a worker-ready prompt.
  // Per brain-only-kuro-v2 Phase C. Input: {items:[], rubric:string, output_shape:object, timeout_ms?:number}
  // Downstream uses: T4 needs-attention filter, KG bridge, webhook severity, DAG improvement scoring.
  app.post('/api/workers/scorer/run', async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
    if (!body || typeof body !== 'object') return c.json({ error: 'body must be object' }, 400);
    const b = body as { items?: unknown; rubric?: unknown; output_shape?: unknown; timeout_ms?: unknown };
    if (!Array.isArray(b.items)) return c.json({ error: 'items must be array' }, 400);
    if (typeof b.rubric !== 'string' || !b.rubric.trim()) {
      return c.json({ error: 'rubric must be non-empty string' }, 400);
    }
    const outputShape = (b.output_shape && typeof b.output_shape === 'object')
      ? b.output_shape as Record<string, unknown>
      : { ranked: [], confidence: 0 };
    const timeoutMs = typeof b.timeout_ms === 'number' && b.timeout_ms > 0
      ? Math.min(b.timeout_ms, 180_000) // hard cap 3 min — rubric scoring should be fast
      : 60_000;

    const task = [
      '# Rubric (agent-provided taste — apply mechanically)',
      b.rubric.trim(),
      '',
      '# Items (JSON array)',
      JSON.stringify(b.items, null, 2),
      '',
      '# Required output shape',
      'Return strict JSON matching this structure. Do not add extra fields. Do not drop items silently.',
      JSON.stringify(outputShape, null, 2),
      '',
      'Return ONLY the JSON. No prose. No markdown code fences.',
    ].join('\n');

    try {
      const raw = await mw.executeWorker('scorer', task, timeoutMs);
      // Try to parse strict JSON; if scorer leaked prose, extract first {...} block.
      let parsed: unknown = null;
      let parseError: string | null = null;
      const trimmed = raw.trim();
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        const match = trimmed.match(/\{[\s\S]*\}/);
        if (match) {
          try { parsed = JSON.parse(match[0]); } catch (e) {
            parseError = e instanceof Error ? e.message : String(e);
          }
        } else {
          parseError = 'no JSON object in scorer output';
        }
      }
      if (parsed != null) {
        return c.json({ ok: true, result: parsed });
      }
      return c.json({ ok: false, error: 'scorer_output_not_json', parse_error: parseError, raw: raw.slice(0, 500) }, 502);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ ok: false, error: 'scorer_failed', message: msg.slice(0, 300) }, 500);
    }
  });

  // T4: Needs-attention filter — Tactical Board + scorer + rubric combined.
  // Per brain-only-kuro-v2 Phase C. Agent posts rubric inline; endpoint collects
  // tactics (in-flight + recent history), scores via T3, returns items whose
  // severity matches audit-worthy set (critical | anomaly | blocked).
  //
  // Design: rubric 透過 body 傳 (Kuro-side ownership of taste file location).
  // Middleware 不直接讀 mini-agent filesystem — 保持 cross-agent 中立性.
  const NEEDS_ATTENTION_SEVERITIES = new Set(['critical', 'anomaly', 'blocked']);
  const NEEDS_ATTENTION_OUTPUT_SHAPE = {
    filtered: [{ task_id: '', severity: 'critical|anomaly|blocked|routine', confidence: 0, rationale: '' }],
  };

  app.post('/api/tactics/needs-attention', async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
    if (!body || typeof body !== 'object') return c.json({ error: 'body must be object' }, 400);
    const b = body as { agent?: unknown; rubric?: unknown; window?: unknown; max_items?: unknown };

    if (typeof b.rubric !== 'string' || !b.rubric.trim()) {
      return c.json({
        error: 'rubric_missing',
        hint: 'POST body must include non-empty "rubric" string. This is the agent\'s taste source (品味不外包)—middleware will not fabricate defaults.',
      }, 400);
    }
    const agent = typeof b.agent === 'string' ? b.agent : undefined;
    const windowStr = typeof b.window === 'string' ? b.window : '24h';
    const windowSec = parseWindow(windowStr);
    if (windowSec == null) {
      return c.json({ error: 'invalid_window', accepted: 'e.g. "24h", "7d", "1200s", "30m"' }, 400);
    }
    const maxItems = typeof b.max_items === 'number' && b.max_items > 0 ? Math.min(b.max_items, 200) : 50;

    // Collect in-flight + recent history → unified TacticRecord[]
    const items: TacticRecord[] = [];
    for (const status of ACTIVE_STATUSES) {
      for (const t of mw.buffer.list({ caller: agent, status })) {
        items.push(taskToTactic(t));
      }
    }
    const cutoff = Date.now() - windowSec * 1000;
    for (const status of TERMINAL_STATUSES) {
      for (const t of mw.buffer.list({ caller: agent, status, limit: 500, includeArchived: true })) {
        const endTs = t.completedAt instanceof Date ? t.completedAt.getTime()
          : t.submittedAt instanceof Date ? t.submittedAt.getTime()
          : 0;
        if (endTs >= cutoff) items.push(taskToTactic(t));
      }
    }

    // Cap input to avoid runaway scoring cost. Agent can adjust max_items.
    const truncated = items.length > maxItems;
    const itemsToScore = truncated ? items.slice(0, maxItems) : items;

    if (itemsToScore.length === 0) {
      return c.json({ count: 0, total_assessed: 0, agent: agent ?? null, truncated: false, items: [] });
    }

    // Build scorer task — rubric + items + strict output shape
    const task = [
      '# Rubric (agent-provided — apply mechanically, never override)',
      b.rubric.trim(),
      '',
      '# Items (JSON array of TacticRecord)',
      JSON.stringify(itemsToScore, null, 2),
      '',
      '# Output shape (strict)',
      'Return strict JSON. Include ALL items in `filtered` array (never drop silently — endpoint will filter).',
      JSON.stringify(NEEDS_ATTENTION_OUTPUT_SHAPE, null, 2),
      '',
      'Return ONLY the JSON — no prose, no markdown fences.',
    ].join('\n');

    let scoredRaw: string;
    try {
      scoredRaw = await mw.executeWorker('scorer', task, 120_000);
    } catch (e) {
      return c.json({ error: 'scorer_failed', message: e instanceof Error ? e.message.slice(0, 300) : String(e) }, 500);
    }

    // Parse with fallback extract
    let scored: unknown = null;
    try { scored = JSON.parse(scoredRaw.trim()); } catch {
      const m = scoredRaw.trim().match(/\{[\s\S]*\}/);
      if (m) { try { scored = JSON.parse(m[0]); } catch { /* noop */ } }
    }

    const scoredArr = (scored && typeof scored === 'object' && Array.isArray((scored as { filtered?: unknown }).filtered))
      ? (scored as { filtered: Array<Record<string, unknown>> }).filtered
      : null;

    if (!scoredArr) {
      return c.json({
        error: 'scorer_output_invalid',
        hint: 'Expected {filtered: [...]} — scorer may have leaked prose or deviated from output_shape',
        raw: scoredRaw.slice(0, 500),
      }, 502);
    }

    // Filter: only severities in the audit-worthy set
    const attentionItems = scoredArr.filter((x) => {
      const sev = typeof x.severity === 'string' ? x.severity : '';
      return NEEDS_ATTENTION_SEVERITIES.has(sev);
    });

    return c.json({
      count: attentionItems.length,
      total_assessed: itemsToScore.length,
      total_seen: items.length,
      truncated,
      agent: agent ?? null,
      window_seconds: windowSec,
      items: attentionItems,
    });
  });

  app.get('/api/tactics/history', (c) => {
    const agent = c.req.query('agent');
    const windowStr = c.req.query('window') ?? '24h';
    const windowSec = parseWindow(windowStr);
    if (windowSec == null) {
      return c.json({ error: 'invalid_window', accepted: 'e.g. "24h", "7d", "1200s", "30m"' }, 400);
    }
    const cutoff = Date.now() - windowSec * 1000;
    const items: TacticRecord[] = [];
    for (const status of TERMINAL_STATUSES) {
      for (const t of mw.buffer.list({ caller: agent, status, limit: 500, includeArchived: true })) {
        const endTs = t.completedAt instanceof Date ? t.completedAt.getTime()
          : t.submittedAt instanceof Date ? t.submittedAt.getTime()
          : 0;
        if (endTs >= cutoff) items.push(taskToTactic(t));
      }
    }
    // Sort descending by completion (most recent first)
    items.sort((a, b) => (b.completed_at ?? b.submitted_at).localeCompare(a.completed_at ?? a.submitted_at));
    return c.json({ count: items.length, agent: agent ?? null, window_seconds: windowSec, items });
  });

  // ─── Forge worktree endpoints (W7) ───
  // Shell out to mini-agent's forge-lite.sh via FORGE_LITE_PATH env var.
  // If unset, all routes return 503 { error: "forge_not_configured" }.
  const forgeErrorResponse = (c: {
    json: (body: unknown, status: number) => Response;
  }, err: unknown): Response => {
    if (err instanceof ForgeError) {
      if (err.code === 'FORGE_NOT_CONFIGURED') {
        return c.json({ error: 'forge_not_configured' }, 503);
      }
      if (err.code === 'NO_FREE_SLOT') {
        let inUse: string[] = [];
        try { inUse = err.stderr ? JSON.parse(err.stderr) : []; } catch { /* ignore */ }
        return c.json({ error: 'no_free_slot', in_use: inUse }, 503);
      }
      if (err.code === 'NOT_FOUND') {
        return c.json({ error: 'not_found', message: err.message }, 404);
      }
      if (err.code === 'INVALID_SLOT_ID') {
        return c.json({ error: 'invalid_slot_id', message: err.message }, 400);
      }
      return c.json({ error: 'forge_error', message: err.message, stderr: err.stderr }, 500);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'forge_error', message: msg }, 500);
  };

  // Forge scope is single-repo (middleware's own cwd). Cross-repo worktree
  // allocation is deferred to Phase 2; body.repo_path intentionally not accepted
  // here to avoid silent-ignore surprise.
  app.post('/forge/allocate', async (c) => {
    let body: { purpose?: string; ttl_sec?: number; files?: string; no_install?: boolean } = {};
    try { body = await c.req.json(); } catch { /* allow empty body */ }
    const purpose = (body.purpose ?? '').trim();
    if (!purpose) {
      return c.json({ error: 'purpose is required' }, 400);
    }
    const pidHeader = c.req.header('X-Caller-Pid');
    const callerPid = pidHeader ? Number.parseInt(pidHeader, 10) : 0;
    try {
      const result = await forgeClient.allocate({
        purpose,
        callerPid: Number.isFinite(callerPid) ? callerPid : 0,
        files: body.files,
        noInstall: body.no_install,
      });
      return c.json(result);
    } catch (err) {
      return forgeErrorResponse(c, err);
    }
  });

  app.post('/forge/release/:slot_id', async (c) => {
    const slotId = c.req.param('slot_id');
    try {
      const result = await forgeClient.release(slotId);
      return c.json(result);
    } catch (err) {
      return forgeErrorResponse(c, err);
    }
  });

  app.get('/forge/list', async (c) => {
    try {
      const result = await forgeClient.list();
      return c.json(result);
    } catch (err) {
      return forgeErrorResponse(c, err);
    }
  });

  app.get('/forge/info/:slot_id', async (c) => {
    const slotId = c.req.param('slot_id');
    try {
      const result = await forgeClient.info(slotId);
      return c.json(result);
    } catch (err) {
      return forgeErrorResponse(c, err);
    }
  });

  app.post('/forge/cleanup', async (c) => {
    try {
      const result = await forgeClient.cleanup();
      return c.json(result);
    } catch (err) {
      return forgeErrorResponse(c, err);
    }
  });

  // ─── Dashboard (always fresh — no server cache, no browser cache) ───
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  app.get('/dashboard', (c) => {
    const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf-8');
    c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    c.header('Pragma', 'no-cache');
    return c.html(html);
  });
  // Redirect root to dashboard
  app.get('/', (c) => c.redirect('/dashboard'));

  return app;
}
