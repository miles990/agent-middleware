# Agent Middleware

AI-native task orchestration. Any agent plans, middleware executes.

```
Agent → Plan (DAG) → Middleware → Workers (AI / API / Shell / Logic) → Results
```

## Features

- **DAG Plan Engine** — Streaming dispatch, step-level retry, convergence loops
- **7 Backends** — AI (Agent SDK), ACP (CLI pool), Shell, Webhook, Logic, Middleware (federation), Custom
- **5 AI Vendors** — Anthropic, Anthropic Managed, OpenAI, Google, Local
- **11 MCP Tools** — Agent-friendly, any AI can dispatch tasks as tool calls
- **Dashboard** — DAG visualization, click-to-detail, real-time SSE
- **Worker CRUD** — Create custom workers via API/MCP, with presets
- **Multimodal** — Pass-through content (text, media, stream, ref)

## Quick Start

```bash
pnpm install
pnpm dev        # http://localhost:3100
```

## For AI Agents

See [llms.txt](./llms.txt) for the complete agent-friendly guide.

**MCP config:**
```json
{ "mcpServers": { "middleware": { "command": "node", "args": ["dist/mcp-server.js"] } } }
```

**Dispatch a task:**
```bash
curl -X POST http://localhost:3100/dispatch \
  -H "Content-Type: application/json" \
  -d '{"worker":"researcher","task":"Summarize https://example.com"}'
```

**Submit a plan:**
```bash
curl -X POST http://localhost:3100/plan \
  -H "Content-Type: application/json" \
  -d '{"goal":"Analyze code quality","steps":[...]}'
```

## Architecture

```
┌────────────────────────────────────────────────┐
│  Callers: Any agent / human / service           │
└──────────────────┬─────────────────────────────┘
                   │ HTTP / MCP / SSE
┌──────────────────▼─────────────────────────────┐
│  Agent Middleware                                │
│  Plan Engine (DAG) → Worker Executor            │
│  ├─ sdk (AI)    ├─ webhook (API)  ├─ shell     │
│  ├─ acp (CLI)   ├─ logic (JS fn)  ├─ middleware│
│  Result Buffer → SSE Events → Dashboard        │
└────────────────────────────────────────────────┘
```

## License

MIT
