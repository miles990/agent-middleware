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

### One-line install (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/miles990/agent-middleware/main/install.sh | bash
```

Clones to `~/.agent-middleware`, installs dependencies, launches an interactive
setup wizard (port, brain/critic models, auto-update, boot-start), starts with
pm2. Cross-platform: macOS / Linux / WSL.

### From a local checkout

```bash
git clone https://github.com/miles990/agent-middleware.git
cd agent-middleware
pnpm install
pnpm run setup   # interactive wizard — configures and starts via pm2
```

### Development mode (no pm2)

```bash
pnpm install
pnpm dev         # http://localhost:3200 (tsx, hot execution)
```

## Managing the daemon

After `pnpm run setup`, middleware runs under pm2:

```bash
pm2 status                       # all services at a glance
pm2 logs agent-middleware        # follow logs
pm2 logs agent-middleware --lines 100
pm2 restart agent-middleware     # restart
pm2 reload agent-middleware      # zero-downtime reload
pm2 stop agent-middleware        # stop
pm2 describe agent-middleware    # detailed info
pm2 monit                        # live CPU/memory dashboard
```

**Deploying code changes** (git push → local update):

```bash
pnpm run deploy                  # git pull + install + build + reload
```

Or enable **auto-update** via the setup wizard — `pm2-auto-pull` checks git
every 5 minutes and reloads on new commits, zero intervention required.

**Boot-time auto-start** (Mac launchd / Linux systemd / Windows Task Scheduler)
is configured by the wizard when you opt in — `pm2 startup` generates the
platform-native init command for you to run once with sudo.

Re-run the wizard any time to reconfigure:

```bash
pnpm run setup
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

## Forge (Worktree Isolation)

For workers that mutate git state (primarily `coder`), middleware exposes
worktree allocation via `/forge/*` endpoints. It shells out to an external
`forge-lite.sh` script (e.g. mini-agent's) — configure via env:

```bash
export FORGE_LITE_PATH=/path/to/forge-lite.sh
```

Without `FORGE_LITE_PATH` set, all `/forge/*` routes return
`503 { error: "forge_not_configured" }`. Other endpoints unaffected — middleware
stays pure-infra by default.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/forge/allocate` | POST | Claim a slot, return `{ slot_id, worktree_path, branch }` |
| `/forge/release/:slot_id` | POST | Release in-use slot (idempotent) |
| `/forge/list` | GET | All slots + state (free / busy / abandoned) |
| `/forge/info/:slot_id` | GET | Single-slot detail |
| `/forge/cleanup` | POST | Reclaim abandoned slots (dead PIDs) |

Example:

```bash
curl -X POST http://localhost:3200/forge/allocate \
  -H "Content-Type: application/json" \
  -H "X-Caller-Pid: $$" \
  -d '{"purpose":"coder: refactor X"}'
# → { "slot_id": "forge-1", "worktree_path": "...", "branch": "forge/slot-1-...", ... }
```

## License

MIT
