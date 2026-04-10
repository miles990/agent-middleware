/**
 * Agent Middleware MCP Server — Official MCP SDK compliance
 *
 * Uses McpServer (high-level API) with:
 * - Progress notifications for long-running tasks
 * - Logging capability
 * - 13 tools (dispatch, plan, validate, status, result, workers, create/delete worker,
 *   presets, create/delete preset, gateway, templates)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const MIDDLEWARE_URL = process.env.MIDDLEWARE_URL ?? 'http://localhost:3100';

async function mwFetch(path: string, opts?: RequestInit): Promise<unknown> {
  const res = await fetch(`${MIDDLEWARE_URL}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...opts?.headers },
  });
  return res.json();
}

const server = new McpServer(
  { name: 'agent-middleware', version: '0.2.0' },
  { capabilities: { logging: {}, tools: {} } },
);

// ─── Dispatch ───
server.tool(
  'middleware_dispatch',
  'Dispatch a task to a worker. Returns taskId — poll with middleware_result or use wait=true.',
  { worker: z.string().describe('Worker: researcher, coder, reviewer, shell, analyst, explorer, or custom'),
    task: z.string().describe('Task description'),
    timeout: z.number().optional().describe('Timeout seconds (default: worker-specific)') },
  async ({ worker, task, timeout }) => {
    const result = await mwFetch('/dispatch', {
      method: 'POST', body: JSON.stringify({ worker, task, timeout, caller: 'mcp' }),
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── Plan ───
server.tool(
  'middleware_plan',
  'Submit a DAG action plan for parallel execution. Steps run in dependency waves.',
  { goal: z.string().describe('What this plan achieves (human-readable)'),
    acceptance: z.string().optional().describe('Acceptance criteria — how to verify goal is achieved'),
    steps: z.array(z.object({
      id: z.string(), worker: z.string(), task: z.string(),
      label: z.string().optional(), dependsOn: z.array(z.string()).default([]),
      retry: z.object({ maxRetries: z.number(), backoffMs: z.number().optional(), onExhausted: z.enum(['skip', 'fail']) }).optional(),
      verifyCommand: z.string().optional(),
    })).describe('DAG steps with dependencies') },
  async ({ goal, acceptance, steps }) => {
    const result = await mwFetch('/plan', {
      method: 'POST', body: JSON.stringify({ goal, acceptance, steps, caller: 'mcp' }),
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── Plan Validate (dry-run) ───
server.tool(
  'middleware_plan_validate',
  'Validate a plan without executing it. Catches cycles, unknown workers, invalid deps.',
  { goal: z.string(), steps: z.array(z.object({
    id: z.string(), worker: z.string(), task: z.string(), dependsOn: z.array(z.string()).default([]),
  })) },
  async ({ goal, steps }) => {
    const result = await mwFetch('/plan/validate', {
      method: 'POST', body: JSON.stringify({ goal, steps }),
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── Status ───
server.tool(
  'middleware_status',
  'Check status of a task or plan.',
  { id: z.string().describe('Task ID (task-xxx) or Plan ID (plan-xxx)') },
  async ({ id }) => {
    const path = id.startsWith('plan-') ? `/plan/${id}` : `/status/${id}`;
    const result = await mwFetch(path);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── Result with progress polling ───
server.tool(
  'middleware_result',
  'Get task result. wait=true polls until complete (max 120s) with progress notifications.',
  { id: z.string().describe('Task ID'),
    wait: z.boolean().optional().describe('Poll until complete (max 120s)') },
  async ({ id, wait }, extra) => {
    if (wait) {
      const start = Date.now();
      let lastStatus = '';
      while (Date.now() - start < 120_000) {
        const task = await mwFetch(`/status/${id}`) as Record<string, unknown>;
        // Send progress notification
        if (task.status !== lastStatus) {
          lastStatus = task.status as string;
          try {
            await extra.sendNotification({
              method: 'notifications/progress',
              params: { progressToken: id, progress: lastStatus === 'completed' ? 1 : 0, total: 1, message: `Status: ${lastStatus}` },
            });
          } catch { /* client may not support progress */ }
        }
        if (task.status === 'completed' || task.status === 'failed' || task.status === 'timeout') {
          return { content: [{ type: 'text' as const, text: JSON.stringify(task, null, 2) }] };
        }
        await new Promise(r => setTimeout(r, 3000));
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'timeout', id }) }] };
    }
    const result = await mwFetch(`/status/${id}`);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── Workers ───
server.tool(
  'middleware_workers',
  'List all available workers with capabilities, backends, and models.',
  {},
  async () => {
    const result = await mwFetch('/workers');
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── Create Worker ───
server.tool(
  'middleware_create_worker',
  `Create a custom worker. Simple: just name+description+prompt. Or use preset (research/code/review/shell/creative/analysis/translation/fast/deep/webhook/logic).`,
  { name: z.string().describe('Worker name (kebab-case)'),
    description: z.string().describe('When to use this worker'),
    prompt: z.string().describe('Worker identity/instructions'),
    preset: z.string().optional().describe('Preset: research, code, review, shell, etc.'),
    tools: z.array(z.string()).optional(), model: z.string().optional(),
    backend: z.string().optional(), vendor: z.string().optional(),
    timeout: z.number().optional(), maxTurns: z.number().optional(),
    webhookUrl: z.string().optional(), webhookMethod: z.string().optional(),
    logicFn: z.string().optional() },
  async (args) => {
    let preset: Record<string, unknown> = {};
    if (args.preset) {
      try {
        const presets = await mwFetch('/presets') as { presets: Array<Record<string, unknown>> };
        const match = presets.presets?.find(p => p.name === args.preset);
        if (match) preset = match;
      } catch { /* no preset */ }
    }
    const result = await mwFetch('/workers', {
      method: 'POST', body: JSON.stringify({
        name: args.name, description: args.description, prompt: args.prompt,
        tools: args.tools ?? preset.tools ?? ['Read', 'Grep', 'Glob', 'Bash'],
        model: args.model ?? preset.model ?? 'sonnet',
        backend: args.backend ?? preset.backend ?? 'sdk',
        vendor: args.vendor ?? 'anthropic',
        timeout: args.timeout ?? preset.timeout ?? 120,
        maxTurns: args.maxTurns ?? preset.maxTurns ?? 10,
        ...(args.webhookUrl ? { webhook: { url: args.webhookUrl, method: args.webhookMethod ?? 'GET' } } : {}),
        ...(args.logicFn ? { logicFn: args.logicFn } : {}),
      }),
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── Delete Worker ───
server.tool(
  'middleware_delete_worker',
  'Delete a custom worker (cannot delete built-in workers).',
  { name: z.string() },
  async ({ name }) => {
    const result = await mwFetch(`/workers/${name}`, { method: 'DELETE' });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── Presets ───
server.tool(
  'middleware_presets',
  'List available worker presets (templates for quick worker creation).',
  {},
  async () => {
    const result = await mwFetch('/presets');
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── Create Preset ───
server.tool(
  'middleware_create_preset',
  'Create a custom worker preset.',
  { name: z.string(), description: z.string(),
    tools: z.array(z.string()).optional(), model: z.string().optional(),
    vendor: z.string().optional(), backend: z.string().optional(),
    timeout: z.number().optional(), maxTurns: z.number().optional() },
  async (args) => {
    const result = await mwFetch('/presets', { method: 'POST', body: JSON.stringify(args) });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── Delete Preset ───
server.tool(
  'middleware_delete_preset',
  'Delete a custom preset.',
  { name: z.string() },
  async ({ name }) => {
    const result = await mwFetch(`/presets/${name}`, { method: 'DELETE' });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── Gateway ───
server.tool(
  'middleware_gateway',
  'ACP gateway status — CLI backends, session pools, circuit breakers.',
  {},
  async () => {
    const result = await mwFetch('/gateway');
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── Templates ───
server.tool(
  'middleware_templates',
  'List available plan templates for common tasks (codebase-analysis, deploy, etc.).',
  {},
  async () => {
    const result = await mwFetch('/templates');
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── Start ───
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mcp] Agent Middleware MCP server v0.2.0 running (stdio)');
}

main().catch(console.error);
