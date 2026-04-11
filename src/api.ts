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
import { PlanEngine, parsePlan, type ActionPlan } from './plan-engine.js';
import { ResultBuffer, type TaskEvent } from './result-buffer.js';
import { WORKERS, getWorkerNames, type WorkerDefinition } from './workers.js';
import { createSdkProvider } from './sdk-provider.js';
import { createProvider, type Vendor } from './provider-registry.js';
import { PresetManager } from './presets.js';
import { createGateway, type ACPGateway, type CLIBackend } from './acp-gateway.js';
import type { LLMProvider } from './llm-provider.js';
import { PLAN_TEMPLATES } from './templates.js';
import { execSync, execFileSync } from 'node:child_process';
import { createBrain, brainPlan, brainDigest, type WorkerInfo } from './brain.js';

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

export function createMiddleware(config?: MiddlewareConfig) {
  const cwd = config?.cwd ?? process.cwd();
  const buffer = new ResultBuffer();
  buffer.enablePersistence(cwd);
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

  // Worker executor — routes to correct backend (built-in + custom), supports multimodal
  const executeWorker = async (worker: string, task: string | import('./llm-provider.js').ContentBlock[], timeoutMs: number): Promise<string> => {
    const def = allWorkers()[worker];
    if (!def) throw new Error(`Unknown worker: ${worker}`);

    switch (def.backend) {
      case 'sdk': {
        const provider = workerProviders.get(worker);
        if (!provider) throw new Error(`No SDK provider for worker: ${worker}`);
        // SDK workers: maxTurns is the real scope control.
        // Timeout is a safety net — derived from maxTurns (2min per turn) or caller's explicit timeout, whichever is larger.
        const maxTurns = def.agent.maxTurns ?? 10;
        const safetyTimeout = Math.max(timeoutMs, maxTurns * 120_000);
        return Promise.race([
          provider.think(task, composePrompt(def)),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Worker ${worker} timeout after ${safetyTimeout}ms (maxTurns=${maxTurns})`)), safetyTimeout),
          ),
        ]);
      }
      case 'shell': {
        try {
          const shellCmd = typeof task === 'string' ? task : task.filter(b => b.type === 'text').map(b => (b as {text:string}).text).join('\n');
          if (def.shellAllowlist?.length) {
            // Structural enforcement: execFileSync bypasses shell interpretation entirely.
            // No pipes, semicolons, $() — the allowlist is enforced by the OS, not regex.
            const parts = shellCmd.trim().split(/\s+/);
            const cmdBase = parts[0];
            if (!def.shellAllowlist.some(a => cmdBase === a || cmdBase.endsWith(`/${a}`))) {
              throw new Error(`Shell command "${cmdBase}" not in allowlist: ${def.shellAllowlist.join(', ')}`);
            }
            const output = execFileSync(cmdBase, parts.slice(1), { cwd, timeout: timeoutMs, encoding: 'utf-8', maxBuffer: 1024 * 1024 });
            return output;
          }
          // No allowlist → trusted agent, full shell features (pipes, redirection, etc.)
          const output = execSync(shellCmd, { cwd, timeout: timeoutMs, encoding: 'utf-8', maxBuffer: 1024 * 1024 });
          return output;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
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
          throw new Error(`Logic error: ${err instanceof Error ? err.message : String(err)}`);
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
      default:
        throw new Error(`Unknown backend: ${def.backend}`);
    }
  };

  // Plan engine with event callbacks
  const planEngine = new PlanEngine(executeWorker, {
    // Let plan engine use worker-specific timeouts instead of hardcoded 120s
    getWorkerTimeoutSeconds: (workerName) => allWorkers()[workerName]?.defaultTimeoutSeconds ?? 120,
    // Bridge ALL plan events to result buffer → SSE stream
    onEvent: (event) => {
      switch (event.type) {
        case 'step.dispatched': buffer.start(event.step.id); break;
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
  const plans = new Map<string, { plan: ActionPlan; resultPromise: Promise<import('./plan-engine.js').PlanResult> }>();
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

  return { buffer, planEngine, executeWorker, workerProviders, customWorkers, persistCustomWorkers, acpGateway, presetManager, plans, planCounter, evictOldPlans, markPlanCompleted };
}

// =============================================================================
// Hono Router
// =============================================================================

export function createRouter(config?: MiddlewareConfig): Hono {
  const mw = createMiddleware(config);
  const app = new Hono();

  // Auth on all mutating endpoints (health/dashboard/events exempt)
  app.use('/dispatch', authMiddleware as never);
  app.use('/plan', authMiddleware as never);
  app.use('/plan/*', authMiddleware as never);
  app.use('/workers', authMiddleware as never);
  app.use('/workers/*', authMiddleware as never);
  app.use('/gateway/*', authMiddleware as never);
  app.use('/presets', authMiddleware as never);
  app.use('/presets/*', authMiddleware as never);
  app.use('/task/*', authMiddleware as never);
  app.use('/goal', authMiddleware as never);

  // Helper: all workers (built-in + custom)
  const mergedWorkerNames = () => [...getWorkerNames(), ...Array.from(mw.customWorkers.keys())];

  // Webhook callback — fire-and-forget POST to caller's endpoint on events
  const sendCallback = (url: string, from: string, event: { type: string; id: string; status: string; result?: unknown; error?: string }) => {
    const text = event.type === 'task.completed'
      ? `Task ${event.id} completed: ${typeof event.result === 'string' ? event.result.slice(0, 2000) : JSON.stringify(event.result).slice(0, 2000)}`
      : event.type === 'task.failed'
        ? `Task ${event.id} failed: ${event.error ?? 'unknown error'}`
        : event.type === 'plan.completed'
          ? `Plan ${event.id} completed. Status: ${event.status}`
          : `Event: ${event.type} on ${event.id}`;
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, text }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => { /* fire-and-forget */ });
  };

  // Health
  app.get('/health', (c) => c.json({
    status: 'ok',
    service: 'agent-middleware',
    workers: mergedWorkerNames(),
    tasks: mw.buffer.list({ limit: 0 }).length,
  }));

  // POST /dispatch — single task (supports multimodal)
  // Body: { worker, task, timeout?, caller? }
  //   task: string (text only) OR ContentBlock[] (multimodal)
  //   ContentBlock: { type: 'text', text } | { type: 'image', source: { type, mediaType, data } } | { type: 'file', path, mediaType? }
  app.post('/dispatch', async (c) => {
    const body = await c.req.json<{
      worker: string;
      task: string | import('./llm-provider.js').ContentBlock[];
      timeout?: number;
      caller?: string;
      callback?: string;       // webhook URL — POST event on completion/failure
      callbackFrom?: string;   // "from" field in callback payload (default: "middleware")
    }>();
    if (!body.worker || !body.task) return c.json({ error: 'worker and task required' }, 400);

    const allW = { ...WORKERS, ...Object.fromEntries(mw.customWorkers) };
    if (!allW[body.worker]) return c.json({ error: `Unknown worker: ${body.worker}` }, 400);

    const def = allW[body.worker];
    const timeoutMs = (body.timeout ?? def.defaultTimeoutSeconds) * 1000;
    const taskDesc = typeof body.task === 'string' ? body.task : `[multimodal: ${body.task.length} blocks]`;
    const taskId = mw.buffer.submit({ worker: body.worker, task: taskDesc, caller: body.caller });
    mw.buffer.start(taskId);

    const cb = body.callback;
    const cbFrom = body.callbackFrom ?? 'middleware';
    mw.executeWorker(body.worker, body.task, timeoutMs)
      .then(result => {
        mw.buffer.complete(taskId, result);
        if (cb) sendCallback(cb, cbFrom, { type: 'task.completed', id: taskId, status: 'completed', result });
      })
      .catch(err => {
        const msg = err instanceof Error ? err.message : String(err);
        mw.buffer.fail(taskId, msg);
        if (cb) sendCallback(cb, cbFrom, { type: 'task.failed', id: taskId, status: 'failed', error: msg });
      });

    return c.json({ taskId, status: 'running' });
  });

  // POST /plan — submit action plan
  app.post('/plan', async (c) => {
    const body = await c.req.json<ActionPlan & { caller?: string; callback?: string; callbackFrom?: string }>();
    const plan: ActionPlan = { goal: body.goal, steps: body.steps, acceptance: body.acceptance, convergence: body.convergence };

    // Validate
    const errors = mw.planEngine.validate(plan, new Set(mergedWorkerNames()));
    if (errors.length > 0) return c.json({ error: 'validation_failed', errors }, 400);

    const planId = `plan-${Date.now()}-${(mw.planCounter++).toString(36)}`;

    // Submit all steps to buffer
    for (const step of plan.steps) {
      mw.buffer.submit({ id: step.id, planId, worker: step.worker, task: step.task, label: step.label, caller: body.caller });
    }

    // Execute in background
    const resultPromise = mw.planEngine.execute(plan);
    mw.plans.set(planId, { plan, resultPromise });
    mw.evictOldPlans();

    // Cleanup after completion + evict plan after 1h + webhook callback
    const planCb = body.callback;
    const planCbFrom = body.callbackFrom ?? 'middleware';
    resultPromise.then(result => {
      for (const step of result.steps) {
        if (step.status !== 'completed') {
          mw.buffer.fail(step.id, step.output);
        }
      }
      mw.markPlanCompleted(planId);
      (mw.plans.get(planId) as Record<string, unknown>).result = result;
      setTimeout(() => mw.plans.delete(planId), 3_600_000);
      // Webhook callback on plan completion
      if (planCb) {
        const completed = result.steps.filter(s => s.status === 'completed').length;
        const summary = result.steps.map(s => `${s.id}: ${s.status}`).join(', ');
        sendCallback(planCb, planCbFrom, { type: 'plan.completed', id: planId, status: `${completed}/${result.steps.length} completed`, result: summary });
      }
    }).catch(() => {
      mw.markPlanCompleted(planId);
      setTimeout(() => mw.plans.delete(planId), 3_600_000);
      if (planCb) sendCallback(planCb, planCbFrom, { type: 'plan.failed', id: planId, status: 'failed', error: 'Plan execution error' });
    });

    return c.json({
      planId,
      status: 'executing',
      steps: plan.steps.length,
      // Self-documenting: callers learn template syntax from the response itself
      templateSyntax: '{{stepId.result}}, {{stepId.summary}}, {{stepId.status}}, {{stepId.findings}}, {{stepId.confidence}}',
    });
  });

  // GET /status/:id — task status
  app.get('/status/:id', (c) => {
    const task = mw.buffer.get(c.req.param('id'));
    if (!task) return c.json({ error: 'not found' }, 404);
    return c.json(task);
  });

  // GET /plan/:id — plan status
  app.get('/plan/:id', async (c) => {
    const planId = c.req.param('id');
    const entry = mw.plans.get(planId);
    if (!entry) return c.json({ error: 'not found' }, 404);

    const steps = mw.buffer.list({ planId });
    const completed = steps.filter(s => s.status === 'completed').length;
    const failed = steps.filter(s => s.status === 'failed').length;
    const running = steps.filter(s => s.status === 'running').length;

    const planResult = (entry as Record<string, unknown>).result as Record<string, unknown> | undefined;
    return c.json({
      planId,
      goal: entry.plan.goal,
      totalSteps: entry.plan.steps.length,
      completed, failed, running,
      pending: entry.plan.steps.length - completed - failed - running,
      steps,
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
    return streamSSE(c, async (stream) => {
      const unsubscribe = mw.buffer.subscribe((event: TaskEvent) => {
        stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event.task),
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
      builtin,
      ...(def.mcpServers ? { mcpServers: Object.keys(def.mcpServers) } : {}),
      ...(def.skills?.length ? { skills: def.skills } : {}),
      ...(def.shellAllowlist?.length ? { shellAllowlist: def.shellAllowlist } : {}),
      ...(def.webhook ? { webhook: { url: def.webhook.url, method: def.webhook.method ?? 'GET' } } : {}),
      ...(def.logicFn ? { hasLogicFn: true } : {}),
    });
    const all = [
      ...Object.entries(WORKERS).map(([name, def]) => serialize(name, def, true)),
      ...[...mw.customWorkers.entries()].map(([name, def]) => serialize(name, def, false)),
    ];
    return c.json({ workers: all });
  });

  // POST /workers — add a custom worker
  app.post('/workers', async (c) => {
    const body = await c.req.json<{
      name: string; backend?: string; model?: string; vendor?: string;
      description?: string; prompt?: string; tools?: string[];
      maxTurns?: number; timeout?: number;
      webhook?: { url: string; method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; headers?: Record<string, string>; bodyTemplate?: string; resultPath?: string };
      logicFn?: string;
      mcpServers?: Record<string, unknown>; skills?: string[];
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
      ...(body.webhook ? { webhook: body.webhook } : {}),
      ...(body.logicFn ? { logicFn: body.logicFn } : {}),
      ...(body.mcpServers ? { mcpServers: body.mcpServers } : {}),
      ...(body.skills ? { skills: body.skills } : {}),
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
      backend?: string; model?: string; description?: string;
      prompt?: string; tools?: string[]; maxTurns?: number; timeout?: number;
      mcpServers?: Record<string, unknown>; skills?: string[];
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
      defaultTimeoutSeconds: body.timeout ?? existing.defaultTimeoutSeconds,
      mcpServers: body.mcpServers ?? existing.mcpServers,
      skills: body.skills ?? existing.skills,
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
        totalSteps: entry.plan.steps.length,
        completed, failed, running,
        steps: entry.plan.steps.map(s => ({
          id: s.id, worker: s.worker, label: s.label, dependsOn: s.dependsOn,
          status: steps.find(t => t.id === s.id)?.status ?? 'pending',
          durationMs: steps.find(t => t.id === s.id)?.durationMs,
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
      mw.buffer.submit({ id: step.id, planId, worker: step.worker, task: step.task, label: step.label, caller: body.caller });
    }
    const resultPromise = mw.planEngine.execute(plan);
    mw.plans.set(planId, { plan, resultPromise });
    mw.evictOldPlans();
    resultPromise.then(result => {
      mw.markPlanCompleted(planId);
      (mw.plans.get(planId) as Record<string, unknown>).result = result;
      setTimeout(() => mw.plans.delete(planId), 3_600_000);
    }).catch(() => {
      mw.markPlanCompleted(planId);
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
  const cleanupTimer = setInterval(() => {
    mw.buffer.cleanup({ archiveAfterMs: 3_600_000, expireAfterMs: 7 * 24 * 3_600_000 });
  }, 60_000);
  // Graceful shutdown: clear interval
  process.on('SIGTERM', () => clearInterval(cleanupTimer));
  process.on('SIGINT', () => clearInterval(cleanupTimer));

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

  // ─── Goal-Driven Execution — Brain plans, middleware executes ───
  // POST /goal — agent just says what it wants, brain figures out how
  app.post('/goal', async (c) => {
    const body = await c.req.json<{
      goal: string;
      context?: string;
      callback?: string;
      callbackFrom?: string;
      caller?: string;
      maxReplanRounds?: number;
    }>();
    if (!body.goal?.trim()) return c.json({ error: 'goal required' }, 400);

    const goalId = `goal-${Date.now()}-${(mw.planCounter++).toString(36)}`;
    const cwd = config?.cwd ?? process.cwd();
    const brain = createBrain({ cwd });

    // Gather worker capabilities for brain
    const allW = { ...WORKERS, ...Object.fromEntries(mw.customWorkers) };
    const workerInfo: WorkerInfo[] = Object.entries(allW).map(([name, def]) => ({
      name, description: def.agent.description ?? '', backend: def.backend,
      model: def.agent.model, maxConcurrency: def.maxConcurrency,
    }));

    // Start goal execution in background
    const goalPromise = (async () => {
      const maxReplan = body.maxReplanRounds ?? 3;
      let finalResult = '';

      // Phase 1: Brain plans
      const planText = await brainPlan(brain, body.goal, {
        context: body.context,
        availableWorkers: workerInfo,
      });

      // Extract JSON plan from brain output
      const jsonMatch = planText.match(/```json\s*([\s\S]*?)```/);
      if (!jsonMatch) return { goalId, status: 'failed', error: 'Brain failed to produce a plan', raw: planText.slice(0, 1000) };

      let plan: ActionPlan;
      try { plan = JSON.parse(jsonMatch[1]) as ActionPlan; }
      catch { return { goalId, status: 'failed', error: 'Brain produced invalid JSON', raw: jsonMatch[1].slice(0, 500) }; }

      // Validate plan
      const errors = mw.planEngine.validate(plan, new Set(mergedWorkerNames()));
      if (errors.length > 0) return { goalId, status: 'failed', error: 'Plan validation failed', errors };

      // Phase 2: Execute plan
      for (const step of plan.steps) {
        mw.buffer.submit({ id: `${goalId}_${step.id}`, planId: goalId, worker: step.worker, task: step.task, label: step.label, caller: body.caller });
      }
      // Remap step IDs to include goalId prefix (avoid collisions)
      const prefixedPlan = { ...plan, steps: plan.steps.map(s => ({ ...s, id: `${goalId}_${s.id}`, dependsOn: s.dependsOn.map(d => `${goalId}_${d}`) })) };

      const planResult = await mw.planEngine.execute(prefixedPlan);

      // Phase 3: Brain digests results — may replan
      for (let round = 0; round <= maxReplan; round++) {
        const digestText = await brainDigest(brain, body.goal, planResult, {
          replanRound: round, maxReplanRounds: maxReplan,
        });

        // Check if brain wants to replan
        const replanMatch = digestText.match(/```json\s*([\s\S]*?)```/);
        if (!replanMatch || round >= maxReplan) {
          finalResult = digestText;
          break;
        }

        // Brain wants more work — execute replan
        try {
          const replan = JSON.parse(replanMatch[1]) as ActionPlan;
          for (const step of replan.steps) {
            mw.buffer.submit({ id: `${goalId}_r${round}_${step.id}`, planId: goalId, worker: step.worker, task: step.task, label: step.label, caller: body.caller });
          }
          const prefixedReplan = { ...replan, steps: replan.steps.map(s => ({ ...s, id: `${goalId}_r${round}_${s.id}`, dependsOn: s.dependsOn.map(d => `${goalId}_r${round}_${d}`) })) };
          const replanResult = await mw.planEngine.execute(prefixedReplan);
          // Merge into planResult for next digest round
          planResult.steps.push(...replanResult.steps);
          planResult.digestContext += '\n\n--- Replan Round ' + (round + 1) + ' ---\n' + replanResult.digestContext;
        } catch {
          finalResult = digestText;
          break;
        }
      }

      return { goalId, status: 'completed', result: finalResult };
    })();

    // Track goal
    mw.plans.set(goalId, { plan: { goal: body.goal, steps: [] }, resultPromise: goalPromise as never });
    mw.evictOldPlans();

    // Callback on completion
    goalPromise.then(result => {
      (mw.plans.get(goalId) as Record<string, unknown>).result = result;
      setTimeout(() => mw.plans.delete(goalId), 3_600_000);
      if (body.callback) {
        sendCallback(body.callback, body.callbackFrom ?? 'middleware', {
          type: 'goal.completed', id: goalId, status: 'completed',
          result: typeof result === 'object' ? (result as Record<string,unknown>).result : result,
        });
      }
    }).catch(err => {
      setTimeout(() => mw.plans.delete(goalId), 3_600_000);
      if (body.callback) {
        sendCallback(body.callback, body.callbackFrom ?? 'middleware', {
          type: 'goal.failed', id: goalId, status: 'failed', error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    return c.json({ goalId, status: 'planning', goal: body.goal });
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
