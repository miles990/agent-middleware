/**
 * Issue #12 step 2 — provider budget-hold fallback dispatch.
 *
 * Strategy: register a logic worker whose logicFn throws a Claude-shaped
 * "Reached maximum budget ($5)" error, with `fallbackWorker` pointing at the
 * built-in `shell` worker. Dispatch in wait mode and verify:
 *   1. response is `{ status: 'completed' }` (fallback succeeded)
 *   2. result is the shell stdout
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

    // Register a custom logic worker that simulates Claude's budget-hold error.
    const failingWorker = `failing-budget-${Date.now()}`;
    const reg = await req('/workers', {
      method: 'POST',
      body: {
        name: failingWorker,
        backend: 'logic',
        logicFn: 'throw new Error("Reached maximum budget ($5) for this session")',
        fallbackWorker: 'shell',
      },
    });
    assert.equal(reg.status, 200, `worker registration: ${await reg.text()}`);

    // Dispatch in wait mode — task is what shell will execute on fallback.
    const dispatchRes = await req('/dispatch?wait=true', {
      method: 'POST',
      body: { worker: failingWorker, task: 'echo fallback-ok' },
    });
    const dispatchBody = await dispatchRes.json() as { taskId: string; status: string; result?: string };

    // Convergence assertion 1: fallback succeeded → completed status, shell stdout in result.
    assert.equal(dispatchRes.status, 200, `dispatch should 200, got ${dispatchRes.status}: ${JSON.stringify(dispatchBody)}`);
    assert.equal(dispatchBody.status, 'completed', `expected completed via fallback, got ${dispatchBody.status}`);
    assert.ok(dispatchBody.taskId, 'taskId required');
    assert.ok((dispatchBody.result ?? '').includes('fallback-ok'), `result should contain shell stdout, got: ${dispatchBody.result}`);

    // Convergence assertion 2: metadata captures both budgetHold + providerFallback.
    const statusRes = await req(`/status/${dispatchBody.taskId}`);
    const statusBody = await statusRes.json() as { status: string; metadata?: Record<string, unknown> };
    assert.equal(statusBody.status, 'completed');
    const meta = statusBody.metadata ?? {};
    assert.equal(meta.budgetHold, true, 'metadata.budgetHold should be tagged (step 1 invariant)');
    assert.ok(meta.providerFallback, 'metadata.providerFallback must be present (step 2 falsifier)');
    const pf = meta.providerFallback as { from: string; to: string; ok: boolean; attemptedAt: string };
    assert.equal(pf.from, failingWorker);
    assert.equal(pf.to, 'shell');
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
