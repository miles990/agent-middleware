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

  it('POST /dispatch rejects relative cwd', async () => {
    const res = await request('/dispatch', { method: 'POST', body: { worker: 'shell', task: 'echo x', cwd: 'relative/path' } });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.ok(body.error.includes('absolute'));
  });

  it('POST /dispatch rejects nonexistent cwd', async () => {
    const res = await request('/dispatch', { method: 'POST', body: { worker: 'shell', task: 'echo x', cwd: '/tmp/does-not-exist-9f8e7d' } });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.ok(body.error.includes('does not exist'));
  });

  it('POST /dispatch rejects cwd that is a file not directory', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmpFile = path.join(os.tmpdir(), `mw-cwd-file-${Date.now()}`);
    fs.writeFileSync(tmpFile, 'x');
    try {
      const res = await request('/dispatch', { method: 'POST', body: { worker: 'shell', task: 'echo x', cwd: tmpFile } });
      assert.equal(res.status, 400);
      const body = await res.json() as { error: string };
      assert.ok(body.error.includes('not a directory'));
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('POST /dispatch executes shell in caller-supplied cwd (wait mode)', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-cwd-ok-'));
    const marker = path.join(tmpDir, 'marker.txt');
    fs.writeFileSync(marker, 'hello-from-cwd');
    try {
      const res = await request('/dispatch?wait=true', { method: 'POST', body: { worker: 'shell', task: 'cat marker.txt', cwd: tmpDir } });
      assert.equal(res.status, 200);
      const body = await res.json() as { status: string; result: string };
      assert.equal(body.status, 'completed');
      assert.ok(body.result.includes('hello-from-cwd'), `expected result to include marker content, got: ${body.result}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Plan cwd validation', () => {
  it('POST /plan rejects step with invalid cwd', async () => {
    const res = await request('/plan', {
      method: 'POST',
      body: {
        goal: 'test',
        steps: [{ id: 's1', worker: 'shell', task: 'echo x', dependsOn: [], cwd: '/tmp/does-not-exist-8e7d6c' }],
      },
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string; errors: Array<{ stepId: string; error: string }> };
    assert.equal(body.error, 'cwd_validation_failed');
    assert.equal(body.errors[0].stepId, 's1');
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

describe('Commitments Ledger', () => {
  it('POST /commit rejects missing source', async () => {
    const res = await request('/commit', { method: 'POST', body: { text: 'do x', parsed: { action: 'do x' } } });
    assert.equal(res.status, 400);
  });

  it('POST /commit rejects invalid channel', async () => {
    const res = await request('/commit', {
      method: 'POST',
      body: { source: { channel: 'bogus' }, text: 'do x', parsed: { action: 'do x' } },
    });
    assert.equal(res.status, 400);
  });

  it('POST /commit creates active commitment', async () => {
    const res = await request('/commit', {
      method: 'POST',
      body: {
        source: { channel: 'room', message_id: 'm-1' },
        text: '我會在下 cycle 寫 §5',
        parsed: { action: '寫 §5 schema', deadline: '下 cycle', to: '@CC' },
      },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { id: string; status: string; created_at: string };
    assert.ok(body.id.startsWith('cmt-'));
    assert.equal(body.status, 'active');
    assert.ok(body.created_at);
  });

  it('GET /commits filters by status', async () => {
    const res = await request('/commits?status=active');
    assert.equal(res.status, 200);
    const body = await res.json() as { count: number; items: Array<{ status: string }> };
    assert.ok(body.count >= 1);
    for (const c of body.items) assert.equal(c.status, 'active');
  });

  it('PATCH /commit/:id transitions to fulfilled with resolution', async () => {
    const create = await request('/commit', {
      method: 'POST',
      body: {
        source: { channel: 'inner' },
        text: 'commit X',
        parsed: { action: 'X' },
      },
    });
    const { id } = await create.json() as { id: string };
    const patch = await request(`/commit/${id}`, {
      method: 'PATCH',
      body: { status: 'fulfilled', resolution: { kind: 'commit', evidence: 'cf2b96f' } },
    });
    assert.equal(patch.status, 200);
    const updated = await patch.json() as { status: string; resolution: { kind: string; evidence: string }; resolved_at: string };
    assert.equal(updated.status, 'fulfilled');
    assert.equal(updated.resolution.kind, 'commit');
    assert.equal(updated.resolution.evidence, 'cf2b96f');
    assert.ok(updated.resolved_at);
  });

  it('GET /commit/:id returns commitment', async () => {
    const create = await request('/commit', {
      method: 'POST',
      body: { source: { channel: 'inner' }, text: 'get-by-id', parsed: { action: 'g' } },
    });
    const { id } = await create.json() as { id: string };
    const res = await request(`/commit/${id}`);
    assert.equal(res.status, 200);
    const body = await res.json() as { id: string; text: string };
    assert.equal(body.id, id);
    assert.equal(body.text, 'get-by-id');
  });

  it('GET /commit/:id returns 404 for unknown', async () => {
    const res = await request('/commit/nonexistent');
    assert.equal(res.status, 404);
  });

  it('PATCH /commit/:id returns 404 for unknown', async () => {
    const res = await request('/commit/nonexistent', { method: 'PATCH', body: { status: 'cancelled' } });
    assert.equal(res.status, 404);
  });

  it('POST /commit accepts owner + acceptance', async () => {
    const res = await request('/commit', {
      method: 'POST',
      body: {
        owner: 'kuro',
        source: { channel: 'inner', cycle_id: 'c-100' },
        text: 'ship X',
        parsed: { action: 'X' },
        acceptance: 'tests pass + diff merged',
      },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { id: string; owner: string; acceptance: string };
    assert.equal(body.owner, 'kuro');
    assert.equal(body.acceptance, 'tests pass + diff merged');
  });

  it('POST /commit rejects empty owner string', async () => {
    const res = await request('/commit', {
      method: 'POST',
      body: { owner: '', source: { channel: 'inner' }, text: 'x', parsed: { action: 'x' } },
    });
    assert.equal(res.status, 400);
  });

  it('POST /commit accepts arbitrary owner string (generic infra)', async () => {
    const res = await request('/commit', {
      method: 'POST',
      body: { owner: 'akari', source: { channel: 'inner' }, text: 'x', parsed: { action: 'x' } },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { owner: string };
    assert.equal(body.owner, 'akari');
  });

  it('GET /commits filters by owner', async () => {
    const res = await request('/commits?owner=kuro');
    assert.equal(res.status, 200);
    const body = await res.json() as { count: number; items: Array<{ owner: string }> };
    assert.ok(body.count >= 1);
    for (const c of body.items) assert.equal(c.owner, 'kuro');
  });

  it('GET /commits/stale finds aged active commitments', async () => {
    const res = await request('/commits/stale?older_than_seconds=0');
    assert.equal(res.status, 200);
    const body = await res.json() as { count: number; older_than_seconds: number };
    assert.ok(body.count >= 1);
    assert.equal(body.older_than_seconds, 0);
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
