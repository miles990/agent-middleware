/**
 * Middleware HTTP API — agent-agnostic, any caller can use.
 *
 * POST /dispatch     — single task
 * POST /plan         — action plan (DAG)
 * GET  /status/:id   — task status
 * GET  /plan/:id     — plan status + all steps
 * GET  /pool         — worker pool status
 * GET  /events       — SSE event stream
 * DELETE /task/:id   — cancel task
 * GET  /health       — health check
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { PlanEngine, parsePlan, type ActionPlan } from './plan-engine.js';
import { ResultBuffer, type TaskEvent } from './result-buffer.js';
import { WORKERS, getWorkerNames } from './workers.js';
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

  // Create per-worker LLM providers
  const workerProviders = new Map<string, LLMProvider>();
  for (const [name, def] of Object.entries(WORKERS)) {
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

  // Worker executor — routes to correct backend
  const executeWorker = async (worker: string, task: string, timeoutMs: number): Promise<string> => {
    const def = WORKERS[worker];
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
          const output = execSync(task, { cwd, timeout: timeoutMs, encoding: 'utf-8', maxBuffer: 1024 * 1024 });
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

  return { buffer, planEngine, executeWorker, workerProviders, plans, planCounter };
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

  // POST /dispatch — single task
  app.post('/dispatch', async (c) => {
    const body = await c.req.json<{ worker: string; task: string; timeout?: number; caller?: string }>();
    if (!body.worker || !body.task) return c.json({ error: 'worker and task required' }, 400);
    if (!WORKERS[body.worker]) return c.json({ error: `Unknown worker: ${body.worker}` }, 400);

    const def = WORKERS[body.worker];
    const timeoutMs = (body.timeout ?? def.defaultTimeoutSeconds) * 1000;
    const taskId = mw.buffer.submit({ worker: body.worker, task: body.task, caller: body.caller });
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

  return app;
}
