/**
 * Agent Middleware MCP Server
 *
 * Exposes middleware capabilities as MCP tools — any agent (Kuro, Akari, Claude Code)
 * can dispatch tasks, submit plans, and check results as native tool calls.
 *
 * Usage:
 *   claude --mcp-config middleware-mcp.json
 *   # or in Agent SDK options.mcpServers
 *
 * Tools:
 *   middleware_dispatch  — dispatch a task to a worker
 *   middleware_plan      — submit a DAG action plan
 *   middleware_status    — check task/plan status
 *   middleware_result    — get task result
 *   middleware_workers   — list available workers
 *   middleware_gateway   — ACP gateway status
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const MIDDLEWARE_URL = process.env.MIDDLEWARE_URL ?? 'http://localhost:3100';

async function mwFetch(path: string, opts?: RequestInit): Promise<unknown> {
  const res = await fetch(`${MIDDLEWARE_URL}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...opts?.headers },
  });
  return res.json();
}

const server = new Server(
  { name: 'agent-middleware', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

// ─── List Tools ───
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'middleware_dispatch',
      description: 'Dispatch a task to a middleware worker. Workers: researcher (read URLs, search web), coder (write/edit code), reviewer (code review), shell (run commands), analyst (data analysis), explorer (explore codebase). Returns taskId — poll with middleware_result.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          worker: { type: 'string', description: 'Worker name: researcher, coder, reviewer, shell, analyst, explorer, or any custom worker' },
          task: { type: 'string', description: 'Task description — be specific about what you need' },
          timeout: { type: 'number', description: 'Timeout in seconds (default: worker-specific)' },
        },
        required: ['worker', 'task'],
      },
    },
    {
      name: 'middleware_plan',
      description: 'Submit an action plan (DAG) for parallel execution. Steps run in dependency waves — independent steps execute simultaneously. Returns planId.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          goal: { type: 'string', description: 'What this plan achieves' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Unique step ID' },
                worker: { type: 'string', description: 'Worker to use' },
                task: { type: 'string', description: 'Task for this step' },
                dependsOn: { type: 'array', items: { type: 'string' }, description: 'Step IDs that must complete first (empty = no deps)' },
              },
              required: ['id', 'worker', 'task'],
            },
            description: 'Steps with dependency graph',
          },
        },
        required: ['goal', 'steps'],
      },
    },
    {
      name: 'middleware_status',
      description: 'Check status of a task or plan. Returns current status, result if completed, duration.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: { type: 'string', description: 'Task ID (task-xxx) or Plan ID (plan-xxx)' },
        },
        required: ['id'],
      },
    },
    {
      name: 'middleware_result',
      description: 'Get the result of a completed task. Returns the worker output text.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: { type: 'string', description: 'Task ID' },
          wait: { type: 'boolean', description: 'If true, poll until task completes (max 120s)' },
        },
        required: ['id'],
      },
    },
    {
      name: 'middleware_workers',
      description: 'List all available workers with their capabilities, backends, and models.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'middleware_create_worker',
      description: 'Create a new custom worker. Use when no existing worker fits your task — design one on the fly. The worker is immediately available for dispatch. Persisted across restarts.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Worker name (lowercase, no spaces). e.g. translator, diagram-maker, data-cleaner' },
          description: { type: 'string', description: 'When to use this worker — other agents see this to decide when to dispatch' },
          prompt: { type: 'string', description: 'Worker identity/instructions. e.g. "You are a Japanese translator. Translate accurately, preserve tone."' },
          tools: { type: 'array', items: { type: 'string' }, description: 'Tools the worker can use. e.g. ["Read", "Write", "Bash", "WebFetch"]' },
          model: { type: 'string', description: 'Model: "sonnet" (balanced), "opus" (deep), "haiku" (fast+cheap). Default: sonnet' },
          backend: { type: 'string', description: 'Backend: "sdk" (default), "acp" (cross-CLI), "shell" (direct bash)' },
          timeout: { type: 'number', description: 'Default timeout in seconds. Default: 120' },
        },
        required: ['name', 'description', 'prompt'],
      },
    },
    {
      name: 'middleware_delete_worker',
      description: 'Delete a custom worker (cannot delete built-in workers).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Worker name to delete' },
        },
        required: ['name'],
      },
    },
    {
      name: 'middleware_gateway',
      description: 'Get ACP gateway status — registered CLI backends, session pool stats, dispatch count.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
  ],
}));

// ─── Call Tool ───
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'middleware_dispatch': {
        const result = await mwFetch('/dispatch', {
          method: 'POST',
          body: JSON.stringify({
            worker: (args as Record<string, unknown>).worker,
            task: (args as Record<string, unknown>).task,
            timeout: (args as Record<string, unknown>).timeout,
            caller: 'mcp',
          }),
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'middleware_plan': {
        const result = await mwFetch('/plan', {
          method: 'POST',
          body: JSON.stringify({
            goal: (args as Record<string, unknown>).goal,
            steps: ((args as Record<string, unknown>).steps as Array<Record<string, unknown>>).map(s => ({
              ...s,
              dependsOn: s.dependsOn ?? [],
            })),
            caller: 'mcp',
          }),
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'middleware_status': {
        const id = (args as Record<string, unknown>).id as string;
        const path = id.startsWith('plan-') ? `/plan/${id}` : `/status/${id}`;
        const result = await mwFetch(path);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'middleware_result': {
        const id = (args as Record<string, unknown>).id as string;
        const shouldWait = (args as Record<string, unknown>).wait as boolean;

        if (shouldWait) {
          // Poll until completed (max 120s)
          const start = Date.now();
          while (Date.now() - start < 120_000) {
            const task = await mwFetch(`/status/${id}`) as Record<string, unknown>;
            if (task.status === 'completed' || task.status === 'failed' || task.status === 'timeout') {
              return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
            }
            await new Promise(r => setTimeout(r, 3000));
          }
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'timeout waiting for result', id }) }] };
        }

        const result = await mwFetch(`/status/${id}`);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'middleware_workers': {
        const result = await mwFetch('/workers');
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'middleware_create_worker': {
        const a = args as Record<string, unknown>;
        const result = await mwFetch('/workers', {
          method: 'POST',
          body: JSON.stringify({
            name: a.name,
            description: a.description,
            prompt: a.prompt,
            tools: a.tools ?? ['Read', 'Grep', 'Glob', 'Bash'],
            model: a.model ?? 'sonnet',
            backend: a.backend ?? 'sdk',
            timeout: a.timeout ?? 120,
          }),
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'middleware_delete_worker': {
        const name = (args as Record<string, unknown>).name as string;
        const result = await mwFetch(`/workers/${name}`, { method: 'DELETE' });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'middleware_gateway': {
        const result = await mwFetch('/gateway');
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
  }
});

// ─── Start ───
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mcp] Agent Middleware MCP server running on stdio');
}

main().catch(console.error);
