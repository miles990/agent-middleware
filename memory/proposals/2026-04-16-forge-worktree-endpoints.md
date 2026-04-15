# W7 · Forge Worktree Endpoints

> **Status**: draft · author: claude-code · peer-review: kuro
> **Parent**: middleware-as-organ v2-final §6.3 (forge lifecycle split)
> **Depends on**: W1 (cwd per-node injection) ✅, W3 (commitments ledger) ✅

## Motivation

Middleware workers that mutate git state (primarily `coder`, potentially `create`) need
isolated worktrees so concurrent writes don't stomp each other's trees. Today
`scripts/forge-lite.sh` provides this for mini-agent's delegation layer; middleware
workers have no such primitive. Without it, parallel `coder` dispatches corrupt shared
state or serialize behind a coarse lock.

Kuro's §6.3 split assigns: **mini-agent allocates slot** (sync, pre-dispatch) →
**middleware owns status / recover / watchdog**. This proposal implements the
middleware half so the split is real instead of aspirational.

## Non-Goals

- Not replacing `forge-lite.sh` — middleware shells out to it, keeping one source
  of truth for sandbox rules
- Not Docker/VM sandboxing — worktree is a git-level isolation, kernel sandbox
  (macOS `sandbox-exec` / Linux Landlock) stays orthogonal
- Not auto-merge — merge decisions stay with caller (mini-agent / operator)

## Surface

5 endpoints. All JSON. Auth via existing `authMiddleware`.

| id | method | path | purpose |
|----|--------|------|---------|
| F1 | POST | `/forge/allocate` | claim a free slot, return worktree path + branch |
| F2 | POST | `/forge/release/:slot_id` | release slot (caller done, no merge) |
| F3 | GET  | `/forge/list` | list all slots + state (free / in-use / abandoned) |
| F4 | GET  | `/forge/info/:slot_id` | single-slot detail incl. pid, branch, dirty-tree |
| F5 | POST | `/forge/cleanup` | reclaim dead-PID slots, return reclaimed ids |

### F1 · POST /forge/allocate

```json
// request
{ "repo_path": "/abs/path/to/repo", "purpose": "coder: refactor X", "ttl_sec": 3600 }

// response (200)
{ "slot_id": "forge-1", "worktree_path": "/abs/path/.forge-1", "branch": "forge/slot-1-1776xxx", "pid": 12345 }

// response (503 — no free slot)
{ "error": "no_free_slot", "in_use": [...] }
```

- `pid` = caller's pid (passed via `X-Caller-Pid` header, fallback to 0)
- `ttl_sec` optional, server-side watchdog reclaims after TTL even if pid alive

### F2 · POST /forge/release/:slot_id

```json
// response (200)
{ "released": true, "slot_id": "forge-1" }

// response (404 / 409)
{ "error": "not_in_use" | "not_found" }
```

- Idempotent. Releasing an already-free slot returns 200 with `released: false`.

### F3 · GET /forge/list

```json
{ "total": 3, "free": 1, "slots": [
  { "slot_id": "forge-1", "state": "in_use", "pid": 12345, "branch": "...", "purpose": "...", "created_at": "...", "age_sec": 42 },
  { "slot_id": "forge-2", "state": "abandoned", "pid": 99999, "last_heartbeat": "..." },
  { "slot_id": "forge-3", "state": "free" }
] }
```

### F4 · GET /forge/info/:slot_id

Same shape as list entry + extra: `dirty_tree: bool`, `ahead_behind: {ahead: n, behind: n}`.

### F5 · POST /forge/cleanup

```json
// response
{ "reclaimed": ["forge-2"], "still_alive": ["forge-1"] }
```

Called on demand or by internal watchdog cron.

## Implementation

### Shell-out boundary

Middleware **shells out** to `forge-lite.sh` via a thin TypeScript wrapper. This
preserves `forge-lite.sh` as single source of truth for:
- slot allocation semantics (`.forge-in-use` marker, PID-death detection)
- kernel sandbox config (macOS sandbox-exec profile, Linux Landlock rules)
- worktree filesystem layout

Wrapper: `src/forge-client.ts`, exports `allocate/release/list/info/cleanup`.
Uses `execFile('bash', [FORGE_LITE_PATH, 'create', ...])`.

### Config

```
FORGE_LITE_PATH=/Users/user/Workspace/mini-agent/scripts/forge-lite.sh  (required)
FORGE_DEFAULT_TTL_SEC=3600                                              (optional, default 1h)
```

If `FORGE_LITE_PATH` unset → all 5 endpoints return `503 { error: "forge_not_configured" }`.
This keeps middleware pure-infra when running without a mini-agent-style sandbox dependency.

### Concurrency

`forge-lite.sh` already handles concurrent `create` via filesystem-level marker files.
Middleware wrapper inherits this — no additional locking needed server-side.

### State sync with commitments ledger (optional, Phase 2)

When a `coder` worker dispatch uses a forge slot, middleware **could** emit a
commitment with `source.channel='delegate'`, `linked_task_id=<dispatch taskId>`,
`acceptance=<caller purpose>`. Slot release → PATCH commitment to fulfilled.

Not in MVP (keep F1-F5 standalone). Defer to a follow-on node if needed.

## DAG Plan

| id | action | executor | dependsOn | acceptance |
|----|--------|----------|-----------|------------|
| F-a | scaffold `src/forge-client.ts` (execFile wrapper, 5 fns) | claude-code | - | 5 fns exported, no-op smoke passes (FORGE_LITE_PATH unset → throws `forge_not_configured`) |
| F-b | add 5 routes in `src/api.ts` (`/forge/*`) + auth wiring | claude-code | F-a | `curl GET /forge/list` returns 503 without config; 200 + JSON with config |
| F-c | test `tests/forge.test.ts` (mock forge-lite.sh via tmp script) | claude-code | F-b | all 5 endpoints round-trip tested, error paths covered |
| F-d | dashboard tile: forge status (3 slots, occupancy, last cleanup) | kuro | F-c | dashboard shows live slot state, refresh every 5s |
| F-e | mini-agent side: `delegation.ts` `commitment` bridge learns to call `/forge/allocate` for `code` workers instead of calling `forge-lite.sh` directly | kuro | F-c | one `code` delegate spawns via middleware-allocated slot, verified via `/forge/list` |
| F-f | docs: update agent-middleware README with forge section + env vars | claude-code | F-b | README explains when to set `FORGE_LITE_PATH`, shows example flow |

**Parallelism**: F-a/F-b/F-c are one lane (me). F-d/F-e (Kuro's lane) start after F-c.
F-f can run anytime after F-b.

## Convergence Conditions (for the whole proposal)

1. A middleware `coder` dispatch can acquire an isolated worktree without the
   caller knowing about `forge-lite.sh` internals
2. Concurrent `coder` dispatches never share a worktree, never stomp each other
3. Dead-caller slots get reclaimed automatically (watchdog + `/forge/cleanup`)
4. Graceful degradation: middleware without `FORGE_LITE_PATH` still starts and
   serves all other endpoints; forge-specific routes return 503 with clear error

## Open Questions

1. **Kernel sandbox ownership**: when middleware shells out to `forge-lite.sh create`,
   the sandbox is on the **shell child**, not on the middleware worker that later
   runs in that worktree. Is that correct? Do we need the middleware worker
   subprocess to re-enter sandbox? → initial answer: forge-lite's sandbox scopes
   the fs area; worker processes in that dir inherit scoped writes. Confirm with
   smoke test.
2. **Cross-repo forge**: F1 takes `repo_path`. Does middleware support workers
   operating on multiple repos? Today yes (cwd per-node). Forge adds
   worktrees-per-repo. Cleanup needs per-repo scan.
3. **Watchdog cadence**: cron every N seconds, or on-demand via `/forge/cleanup`?
   Start with on-demand + document; add cron if slot starvation observed.

## Rollback

- L1: `git revert` the api.ts / forge-client.ts commits
- L2: unset `FORGE_LITE_PATH` env — all routes 503, rest of middleware unaffected
- L3: keep the endpoints; mini-agent delegation falls back to direct shell call
