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
import type { LLMProvider } from './llm-provider.js';
import { execSync } from 'node:child_process';

// =============================================================================
// Middleware Instance
// =============================================================================

export interface MiddlewareConfig {
  cwd?: string;
}

export function createMiddleware(config?: MiddlewareConfig) {
  const cwd = config?.cwd ?? process.cwd();
  const buffer = new ResultBuffer();
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
    if (def.backend === 'sdk') {
      workerProviders.set(name, createSdkProvider({
        model: def.agent.model ?? 'sonnet',
        cwd,
        allowedTools: def.agent.tools as string[] | undefined,
        maxTurns: def.agent.maxTurns,
        maxBudgetUsd: 5,
      }));
    }
  }

  // Worker executor — routes to correct backend (built-in + custom), supports multimodal
  const executeWorker = async (worker: string, task: string | import('./llm-provider.js').ContentBlock[], timeoutMs: number): Promise<string> => {
    const def = allWorkers()[worker];
    if (!def) throw new Error(`Unknown worker: ${worker}`);

    switch (def.backend) {
      case 'sdk': {
        const provider = workerProviders.get(worker);
        if (!provider) throw new Error(`No SDK provider for worker: ${worker}`);
        return Promise.race([
          provider.think(task, def.agent.prompt ?? ''),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Worker ${worker} timeout after ${timeoutMs}ms`)), timeoutMs),
          ),
        ]);
      }
      case 'shell': {
        try {
          const shellCmd = typeof task === 'string' ? task : task.filter(b => b.type === 'text').map(b => (b as {text:string}).text).join('\n');
          const output = execSync(shellCmd, { cwd, timeout: timeoutMs, encoding: 'utf-8', maxBuffer: 1024 * 1024 });
          return output;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`Shell error: ${msg.slice(0, 500)}`);
        }
      }
      case 'acp': {
        // TODO: implement ACP session pool dispatch
        throw new Error(`ACP backend not yet implemented for worker: ${worker}`);
      }
      default:
        throw new Error(`Unknown backend: ${def.backend}`);
    }
  };

  // Plan engine with event callbacks
  const planEngine = new PlanEngine(executeWorker, {
    onStepComplete: (step, wave) => {
      buffer.complete(step.id, step.output);
    },
  });

  // Track plans
  const plans = new Map<string, { plan: ActionPlan; resultPromise: Promise<import('./plan-engine.js').PlanResult> }>();
  let planCounter = 0;

  return { buffer, planEngine, executeWorker, workerProviders, customWorkers, persistCustomWorkers, plans, planCounter };
}

// =============================================================================
// Hono Router
// =============================================================================

export function createRouter(config?: MiddlewareConfig): Hono {
  const mw = createMiddleware(config);
  const app = new Hono();

  // Health
  app.get('/health', (c) => c.json({
    status: 'ok',
    service: 'agent-middleware',
    workers: getWorkerNames(),
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
    }>();
    if (!body.worker || !body.task) return c.json({ error: 'worker and task required' }, 400);

    const allW = { ...WORKERS, ...Object.fromEntries(mw.customWorkers) };
    if (!allW[body.worker]) return c.json({ error: `Unknown worker: ${body.worker}` }, 400);

    const def = allW[body.worker];
    const timeoutMs = (body.timeout ?? def.defaultTimeoutSeconds) * 1000;
    const taskDesc = typeof body.task === 'string' ? body.task : `[multimodal: ${body.task.length} blocks]`;
    const taskId = mw.buffer.submit({ worker: body.worker, task: taskDesc, caller: body.caller });
    mw.buffer.start(taskId);

    // Fire and forget — caller polls /status/:id
    mw.executeWorker(body.worker, body.task, timeoutMs)
      .then(result => mw.buffer.complete(taskId, result))
      .catch(err => mw.buffer.fail(taskId, err instanceof Error ? err.message : String(err)));

    return c.json({ taskId, status: 'running' });
  });

  // POST /plan — submit action plan
  app.post('/plan', async (c) => {
    const body = await c.req.json<ActionPlan & { caller?: string }>();
    const plan: ActionPlan = { goal: body.goal, steps: body.steps };

    // Validate
    const errors = mw.planEngine.validate(plan, new Set(getWorkerNames()));
    if (errors.length > 0) return c.json({ error: 'validation_failed', errors }, 400);

    const planId = `plan-${Date.now()}-${(mw.planCounter++).toString(36)}`;

    // Submit all steps to buffer
    for (const step of plan.steps) {
      mw.buffer.submit({ id: step.id, planId, worker: step.worker, task: step.task, caller: body.caller });
    }

    // Execute in background
    const resultPromise = mw.planEngine.execute(plan);
    mw.plans.set(planId, { plan, resultPromise });

    // Cleanup after completion
    resultPromise.then(result => {
      for (const step of result.steps) {
        if (step.status !== 'completed') {
          mw.buffer.fail(step.id, step.output);
        }
      }
    }).catch(() => {});

    return c.json({ planId, status: 'executing', steps: plan.steps.length });
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

    return c.json({
      planId,
      goal: entry.plan.goal,
      totalSteps: entry.plan.steps.length,
      completed, failed, running,
      pending: entry.plan.steps.length - completed - failed - running,
      steps,
    });
  });

  // DELETE /task/:id — cancel
  app.delete('/task/:id', (c) => {
    const ok = mw.buffer.cancel(c.req.param('id'));
    return ok ? c.json({ ok: true }) : c.json({ error: 'cannot cancel' }, 400);
  });

  // GET /pool — worker pool status
  app.get('/pool', (c) => {
    const pool = Object.entries(WORKERS).map(([name, def]) => ({
      name,
      backend: def.backend,
      model: def.agent.model,
      timeout: def.defaultTimeoutSeconds,
    }));
    return c.json({ workers: pool });
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

  // GET /workers — list all workers (built-in + custom)
  app.get('/workers', (c) => {
    const all = Object.entries(WORKERS).map(([name, def]) => ({
      name,
      backend: def.backend,
      model: def.agent.model,
      description: def.agent.description,
      prompt: def.agent.prompt,
      tools: def.agent.tools,
      maxTurns: def.agent.maxTurns,
      timeout: def.defaultTimeoutSeconds,
      builtin: true,
    }));
    // Add custom workers from runtime
    for (const [name, def] of mw.customWorkers) {
      all.push({
        name,
        backend: def.backend,
        model: def.agent.model,
        description: def.agent.description,
        prompt: def.agent.prompt,
        tools: def.agent.tools,
        maxTurns: def.agent.maxTurns,
        timeout: def.defaultTimeoutSeconds,
        builtin: false,
      });
    }
    return c.json({ workers: all });
  });

  // POST /workers — add a custom worker
  app.post('/workers', async (c) => {
    const body = await c.req.json<{
      name: string; backend?: string; model?: string;
      description?: string; prompt?: string; tools?: string[];
      maxTurns?: number; timeout?: number;
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
      defaultTimeoutSeconds: body.timeout ?? 120,
    };

    mw.customWorkers.set(body.name, def);
    // Also register SDK provider if sdk backend
    if (def.backend === 'sdk') {
      mw.workerProviders.set(body.name, createSdkProvider({
        model: def.agent.model ?? 'sonnet',
        cwd: config?.cwd ?? process.cwd(),
        allowedTools: def.agent.tools as string[] | undefined,
        maxTurns: def.agent.maxTurns,
        maxBudgetUsd: 5,
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
    };

    mw.customWorkers.set(name, updated);
    if (updated.backend === 'sdk') {
      mw.workerProviders.set(name, createSdkProvider({
        model: updated.agent.model ?? 'sonnet',
        cwd: config?.cwd ?? process.cwd(),
        allowedTools: updated.agent.tools as string[] | undefined,
        maxTurns: updated.agent.maxTurns,
        maxBudgetUsd: 5,
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

  // ─── Dashboard ───
  app.get('/dashboard', (c) => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf-8');
    return c.html(html);
  });
  // Redirect root to dashboard
  app.get('/', (c) => c.redirect('/dashboard'));

  return app;
}
