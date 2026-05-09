/**
 * Issue #12 step 2 — provider budget-hold fallback dispatch.
 *
 * Strategy: register a logic worker whose logicFn throws a Claude-shaped
 * "Reached maximum budget ($5)" error, with `fallbackWorker` pointing at a
 * second logic worker that returns success synchronously. Pure-logic test
 * fixtures avoid filesystem/spawn dependencies in CI. Dispatch in wait mode
 * and verify:
 *   1. response is `{ status: 'completed' }` (fallback succeeded)
 *   2. result is the fallback worker's output
 *   3. GET /status/:id surfaces metadata.providerFallback {from,to,ok:true}
 *   4. metadata.budgetHold is also tagged (step 1 still works)
 *
 * Run: npx tsx --test tests/dispatch-fallback.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter, _clearBudgetHoldState } from '../src/api.js';

const app = createRouter({ cwd: '/tmp/agent-middleware-test-fallback' });

async function req(path: string, opts?: { method?: string; body?: unknown }) {
  const init: RequestInit = {
    method: opts?.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
  };
  if (opts?.body) init.body = JSON.stringify(opts.body);
  return app.request(path, init);
}

describe('Issue #12 step 2 — fallback dispatch on budget-hold', () => {
  it('falls back to alternate worker when primary throws budget-hold', async () => {
    _clearBudgetHoldState();

    // Register a logic-backed fallback worker that succeeds synchronously.
    const fallbackWorker = `fallback-ok-${Date.now()}`;
    const fbReg = await req('/workers', {
      method: 'POST',
      body: {
        name: fallbackWorker,
        backend: 'logic',
        logicFn: 'return "fallback-ok:" + (typeof input === "string" ? input : JSON.stringify(input))',
      },
    });
    assert.equal(fbReg.status, 200, `fallback worker registration: ${await fbReg.text()}`);

    // Register the primary worker that simulates Claude's budget-hold error.
    const failingWorker = `failing-budget-${Date.now()}`;
    const reg = await req('/workers', {
      method: 'POST',
      body: {
        name: failingWorker,
        backend: 'logic',
        logicFn: 'throw new Error("Reached maximum budget ($5) for this session")',
        fallbackWorker,
      },
    });
    assert.equal(reg.status, 200, `worker registration: ${await reg.text()}`);

    // Dispatch in wait mode.
    const dispatchRes = await req('/dispatch?wait=true', {
      method: 'POST',
      body: { worker: failingWorker, task: 'task-input' },
    });
    const dispatchBody = await dispatchRes.json() as { taskId: string; status: string; result?: string };

    // Convergence assertion 1: fallback succeeded → completed status, fallback output in result.
    assert.equal(dispatchRes.status, 200, `dispatch should 200, got ${dispatchRes.status}: ${JSON.stringify(dispatchBody)}`);
    assert.equal(dispatchBody.status, 'completed', `expected completed via fallback, got ${dispatchBody.status}`);
    assert.ok(dispatchBody.taskId, 'taskId required');
    assert.ok((dispatchBody.result ?? '').includes('fallback-ok'), `result should contain fallback output, got: ${dispatchBody.result}`);

    // Convergence assertion 2: metadata captures both budgetHold + providerFallback.
    const statusRes = await req(`/status/${dispatchBody.taskId}`);
    const statusBody = await statusRes.json() as { status: string; metadata?: Record<string, unknown> };
    assert.equal(statusBody.status, 'completed');
    const meta = statusBody.metadata ?? {};
    assert.equal(meta.budgetHold, true, 'metadata.budgetHold should be tagged (step 1 invariant)');
    assert.ok(meta.providerFallback, 'metadata.providerFallback must be present (step 2 falsifier)');
    const pf = meta.providerFallback as { from: string; to: string; ok: boolean; attemptedAt: string };
    assert.equal(pf.from, failingWorker);
    assert.equal(pf.to, fallbackWorker);
    assert.equal(pf.ok, true);
    assert.ok(pf.attemptedAt, 'attemptedAt timestamp required');
  });

  it('records ok:false when fallback worker also fails', async () => {
    _clearBudgetHoldState();

    const failingWorker = `failing-both-${Date.now()}`;
    const fallbackFailWorker = `fallback-fail-${Date.now()}`;

    // Fallback worker also throws (non-budget error, simulates downstream failure).
    await req('/workers', {
      method: 'POST',
      body: {
        name: fallbackFailWorker,
        backend: 'logic',
        logicFn: 'throw new Error("downstream provider unreachable")',
      },
    });
    await req('/workers', {
      method: 'POST',
      body: {
        name: failingWorker,
        backend: 'logic',
        logicFn: 'throw new Error("Reached maximum budget ($5) for this session")',
        fallbackWorker: fallbackFailWorker,
      },
    });

    const dispatchRes = await req('/dispatch?wait=true', {
      method: 'POST',
      body: { worker: failingWorker, task: 'unused' },
    });
    const dispatchBody = await dispatchRes.json() as { taskId: string; status: string; error?: string };

    // Original error should propagate (not the fallback's error).
    assert.equal(dispatchBody.status, 'failed');
    assert.ok((dispatchBody.error ?? '').match(/Reached maximum budget/i), `original budget-hold error should propagate, got: ${dispatchBody.error}`);

    const statusRes = await req(`/status/${dispatchBody.taskId}`);
    const statusBody = await statusRes.json() as { metadata?: Record<string, unknown> };
    const meta = statusBody.metadata ?? {};
    const pf = meta.providerFallback as { ok: boolean; error?: string } | undefined;
    assert.ok(pf, 'providerFallback must still be recorded on fallback failure');
    assert.equal(pf!.ok, false);
    assert.ok((pf!.error ?? '').match(/downstream provider unreachable/), 'fallback error should be captured in metadata');
  });

  it('emits task.fallback to events.jsonl for persistent observability (AC #3)', async () => {
    _clearBudgetHoldState();

    // Use a unique cwd so events.jsonl is isolated from prior test runs.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const isolatedCwd = `/tmp/agent-middleware-test-fallback-events-${Date.now()}`;
    fs.mkdirSync(isolatedCwd, { recursive: true });
    const { createRouter } = await import('../src/api.js');
    const isolatedApp = createRouter({ cwd: isolatedCwd });

    const fbWorker = `fallback-evt-ok-${Date.now()}`;
    await isolatedApp.request('/workers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: fbWorker, backend: 'logic', logicFn: 'return "fb-result"' }),
    });
    const failWorker = `failing-evt-${Date.now()}`;
    await isolatedApp.request('/workers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: failWorker,
        backend: 'logic',
        logicFn: 'throw new Error("Reached maximum budget ($5)")',
        fallbackWorker: fbWorker,
      }),
    });
    const dispatchRes = await isolatedApp.request('/dispatch?wait=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worker: failWorker, task: 'evt-test' }),
    });
    const dispatchBody = await dispatchRes.json() as { taskId: string; status: string };
    assert.equal(dispatchBody.status, 'completed');

    // Convergence: events.jsonl must contain a task.fallback row for this taskId.
    const eventsPath = path.join(isolatedCwd, 'events.jsonl');
    assert.ok(fs.existsSync(eventsPath), 'events.jsonl must exist after dispatch');
    const lines = fs.readFileSync(eventsPath, 'utf-8').split('\n').filter(Boolean);
    const fallbackEvents = lines
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e): e is Record<string, unknown> => e !== null && e.type === 'task.fallback' && e.taskId === dispatchBody.taskId);
    assert.equal(fallbackEvents.length, 1, `expected 1 task.fallback event for ${dispatchBody.taskId}, got ${fallbackEvents.length}`);
    const evt = fallbackEvents[0];
    assert.equal(evt.severity, 'anomaly', 'fallback severity must be anomaly');
    assert.equal(evt.fallbackFrom, failWorker);
    assert.equal(evt.fallbackTo, fbWorker);
    assert.equal(evt.fallbackOk, true);
  });

  it('skips fallback when fallbackWorker references unknown worker', async () => {
    _clearBudgetHoldState();

    const failingWorker = `failing-unknown-${Date.now()}`;
    await req('/workers', {
      method: 'POST',
      body: {
        name: failingWorker,
        backend: 'logic',
        logicFn: 'throw new Error("Reached maximum budget ($5) for this session")',
        fallbackWorker: 'nonexistent-worker-xyz',
      },
    });

    const dispatchRes = await req('/dispatch?wait=true', {
      method: 'POST',
      body: { worker: failingWorker, task: 'unused' },
    });
    const dispatchBody = await dispatchRes.json() as { taskId: string; status: string };
    assert.equal(dispatchBody.status, 'failed');

    const statusRes = await req(`/status/${dispatchBody.taskId}`);
    const statusBody = await statusRes.json() as { metadata?: Record<string, unknown> };
    const meta = statusBody.metadata ?? {};
    assert.equal(meta.budgetHold, true, 'budgetHold tag should still fire even if fallback skipped');
    assert.equal(meta.providerFallback, undefined, 'providerFallback should NOT be recorded for unknown fallback');
  });
});
