# Scheduler ID-Clobber + Expired Rate-Limit Auto-Retry Gap

**Date**: 2026-05-15
**Severity**: P0 (caused 6+ cycles of phantom P0 noise)
**Status**: Root cause identified, fix pending

## Symptom

Task `task-1778459005838` surfaced as P0 phantom for 6 consecutive cycles. Every
grep against `memory/state/` for that ID only matched ledger self-references
(commitment-ledger / phantom-closures / ledger-resolutions) — never the actual
task-events.jsonl entry. Looked like a phantom. Was not.

## Root Cause

Two compounding bugs in the scheduler:

### Bug 1: delegate-summary slice cuts task IDs mid-token

**Correction (2026-05-15 cycle 9)**: not the stack-rank renderer.

Real location: `mini-agent/src/loop.ts:3409`

```ts
summary: `[delegate:${taskType}] ${del.prompt.slice(0, 80)}`
```

When `del.prompt` starts with a task-id-like token (`task-1778459005838-l ...`),
the 80-char slice lands mid-suffix and silently drops the trailing `-l`.
Line 3411 has the same pattern with `slice(0, 60)`.

Canonical task ID (`idx-del-1778478135918-n4o8`) is stored intact at line 3404
as `id:` — it's the *displayed summary* that fools grep falsifiers.

Consequence:
- `grep task-1778459005838 task-events.jsonl` returns nothing (real key is `-l` suffixed)
- Commitment falsifiers that reference the rendered summary substring can never resolve
- Operators (and Kuro) misclassify the task as phantom

Fix patch: `/tmp/kuro-scheduler-id-clobber-fix.patch` — adds
`truncatePreservingTaskId(text, max)` helper that detects leading
`task-\d+...` / `idx-...` / `del-...` tokens and never cuts inside them.

### Bug 2: expired rate-limit failure has no auto-retry

`task-events.jsonl` shows:
```
task.failed @ 2026-05-11T00:23:29.725Z
error="You've hit your limit · resets May 14, 8am"
```

Rate-limit reset deadline was 2026-05-14T08:00Z. As of 2026-05-15T16:48Z that
deadline has passed by 32 hours. The task is neither auto-retried nor marked
resolved → permanently parked at top of P0 queue → starves real work.

## Falsifier Already Verified

- `grep task-1778459005838 memory/state/*.jsonl` → 3 hits, all ledger self-refs ✓
- No task-events.jsonl hits for stripped ID ✓
- `task-1778459005838-l` exists in task-events.jsonl with rate-limit error ✓

## Repair Candidates

1. **Renderer fix**: preserve full task ID (including suffix) in stack-rank
   output. Find the slice/truncation that drops `-l` / `-j` / etc.
2. **Auto-retry path**: when `task.failed` carries a rate-limit error with a
   reset timestamp, scheduler should re-enqueue once `now > resetAt`. Today
   the failure is terminal.
3. **Operator escape hatch**: add a `mark-rate-limit-resolved` command so
   stuck rows can be drained without code changes.

## Resolution Entry

Already written to `memory/state/ledger-resolutions.jsonl` line 5.

## Next Cycle Trigger

If the same phantom resurfaces, do **not** re-diagnose. Open a PR against the
scheduler renderer (Bug 1) — that's the cheapest fix and breaks the
misdiagnosis loop for every future stuck task, not just this one.
