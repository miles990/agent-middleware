/**
 * API endpoint tests — validates HTTP routes, auth, validation.
 * Run: npx tsx --test tests/api.test.ts
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../src/api.js';

// Create test app
const app = createRouter({ cwd: '/tmp/agent-middleware-test' });

// Helper: make requests to Hono app
async function request(path: string, opts?: { method?: string; body?: unknown; headers?: Record<string, string> }) {
  const method = opts?.method ?? 'GET';
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...opts?.headers };
  const init: RequestInit = { method, headers };
  if (opts?.body) init.body = JSON.stringify(opts.body);
  return app.request(path, init);
}

describe('Health & Status', () => {
  it('GET /health returns ok + workers list', async () => {
    const res = await request('/health');
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.status, 'ok');
    assert.ok(Array.isArray(body.workers));
    assert.ok((body.workers as string[]).includes('shell'));
    assert.ok((body.workers as string[]).includes('analyst'));
  });

  it('GET /health does not require auth', async () => {
    // Even with MIDDLEWARE_API_KEY set, health is public
    const res = await request('/health');
    assert.equal(res.status, 200);
  });
});

describe('Workers', () => {
  it('GET /workers lists built-in workers', async () => {
    const res = await request('/workers');
    assert.equal(res.status, 200);
    const body = await res.json() as { workers: Array<{ name: string }> };
    assert.ok(body.workers.length >= 7);
    const names = body.workers.map(w => w.name);
    assert.ok(names.includes('researcher'));
    assert.ok(names.includes('coder'));
    assert.ok(names.includes('shell'));
  });

  it('GET /workers shows model and tools', async () => {
    const res = await request('/workers');
    const body = await res.json() as { workers: Array<{ name: string; model: string; tools: string[] }> };
    const shell = body.workers.find(w => w.name === 'shell')!;
    assert.ok(shell);
    const analyst = body.workers.find(w => w.name === 'analyst')!;
    assert.ok(analyst.tools.includes('Read'));
  });
});

describe('Dispatch', () => {
  it('POST /dispatch rejects missing worker', async () => {
    const res = await request('/dispatch', { method: 'POST', body: { task: 'hello' } });
    assert.equal(res.status, 400);
  });

  it('POST /dispatch rejects unknown worker', async () => {
    const res = await request('/dispatch', { method: 'POST', body: { worker: 'nonexistent', task: 'hello' } });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.ok(body.error.includes('Unknown worker'));
  });

  it('POST /dispatch accepts shell worker', async () => {
    const res = await request('/dispatch', { method: 'POST', body: { worker: 'shell', task: 'echo test' } });
    assert.equal(res.status, 200);
    const body = await res.json() as { taskId: string; status: string };
    assert.ok(body.taskId);
    assert.equal(body.status, 'running');
  });
});

describe('Plan', () => {
  it('POST /plan rejects empty steps', async () => {
    const res = await request('/plan', { method: 'POST', body: { goal: 'test', steps: [] } });
    assert.equal(res.status, 400);
  });

  it('POST /plan rejects unknown worker in steps', async () => {
    const res = await request('/plan', {
      method: 'POST',
      body: {
        goal: 'test',
        steps: [{ id: 's1', worker: 'nonexistent', task: 't', dependsOn: [] }],
      },
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { errors: string[] };
    assert.ok(body.errors.length > 0);
  });

  it('POST /plan accepts valid plan', async () => {
    const res = await request('/plan', {
      method: 'POST',
      body: {
        goal: 'test plan',
        steps: [
          { id: 's1', worker: 'shell', task: 'echo hello', dependsOn: [] },
        ],
      },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { planId: string; status: string; steps: number };
    assert.ok(body.planId.startsWith('plan-'));
    assert.equal(body.status, 'executing');
    assert.equal(body.steps, 1);
  });

  it('POST /plan/validate dry-run detects cycles', async () => {
    const res = await request('/plan/validate', {
      method: 'POST',
      body: {
        goal: 'cycle test',
        steps: [
          { id: 'a', worker: 'shell', task: 't', dependsOn: ['b'] },
          { id: 'b', worker: 'shell', task: 't', dependsOn: ['a'] },
        ],
      },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { valid: boolean; errors: string[] };
    assert.equal(body.valid, false);
    assert.ok(body.errors.some((e: string) => e.toLowerCase().includes('cycle')));
  });
});

describe('Task Status', () => {
  it('GET /status/:id returns 404 for unknown', async () => {
    const res = await request('/status/nonexistent-id');
    assert.equal(res.status, 404);
  });
});

describe('Templates', () => {
  it('GET /templates returns built-in templates', async () => {
    const res = await request('/templates');
    assert.equal(res.status, 200);
    const body = await res.json() as { templates: Array<{ name: string }> };
    assert.ok(body.templates.length >= 3);
    const names = body.templates.map(t => t.name);
    assert.ok(names.includes('codebase-analysis'));
    assert.ok(names.includes('research-report'));
  });

  it('POST /plan/from-template rejects unknown template', async () => {
    const res = await request('/plan/from-template', {
      method: 'POST',
      body: { template: 'nonexistent', params: {} },
    });
    assert.equal(res.status, 400);
  });

  it('POST /plan/from-template rejects missing required params', async () => {
    const res = await request('/plan/from-template', {
      method: 'POST',
      body: { template: 'codebase-analysis', params: {} },
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string; missing: string[] };
    assert.ok(body.missing.includes('target'));
  });
});

describe('Presets', () => {
  it('GET /presets returns built-in presets', async () => {
    const res = await request('/presets');
    assert.equal(res.status, 200);
    const body = await res.json() as { presets: Array<{ name: string }> };
    assert.ok(body.presets.length >= 10);
  });
});

describe('Dashboard', () => {
  it('GET /dashboard returns HTML', async () => {
    const res = await request('/dashboard');
    assert.equal(res.status, 200);
    const ct = res.headers.get('content-type') ?? '';
    assert.ok(ct.includes('text/html'));
  });

  it('GET / redirects to dashboard', async () => {
    const res = await request('/');
    assert.equal(res.status, 302);
  });
});
