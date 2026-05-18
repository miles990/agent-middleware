# callClaude Error Bucket Audit (2026-05-18)

**Cycle**: 03bbc29a heartbeat continuation; convergence "advance one step" met.

## TL;DR
- `RATE_LIMIT:generic::callClaude` P1 (lastSeen 5/11) auto-cleans on 5/19 (strict `<` in feedback-loops.ts:615). No action needed; do **not** chat Alex about it again.
- `TIMEOUT:real_timeout::callClaude` is a noisy bucket: counts **attempt-failures**, not **cycle-failures**. Today's burst (5/18 05:04-05:50) had 10 bucket events but only 1 needed >1 retry. Retry path is healthy.
- Underlying cause: 90s `TIMEOUT_MS` in `agent.ts:696` (deliberate fail-fast, 2026-04-17 incident). First attempt at ~32K-char prompts hits the wall during Claude burst windows; retry with ~28K-char minimal succeeds.

## Audit artifact
`/tmp/kuro-callclaude-bucket-audit.txt` (64 lines, full forensics)

## Recommended next cycle (in order of effort)

1. **(1 LoC, safe)** `src/feedback-loops.ts:615` change `<` to `<=`. Cleans stale buckets exactly at the 7-day mark instead of 8th day. Falsifier: `RATE_LIMIT:generic::callClaude` disappears from error-patterns.json after first deploy + cycle on 2026-05-18.

2. **(small refactor)** Split bucket counter into `attempt_failures` (raw, for telemetry) and `cycle_failures` (only after all 3 retries exhausted, for recurring-errors panel). Stops `real_timeout` from looking like a fire when retry recovers.

3. **(probe)** Add `KURO_PREEMPT_MINIMAL_THRESHOLD` env: if rolling 5-min `real_timeout` count >= 3, switch to minimal prompt on attempt 1. Saves ~90s/event during bursts.

## Falsifier-graded evidence
- file_exists:/tmp/kuro-callclaude-bucket-audit.txt
- file_exists:/Users/user/Workspace/agent-middleware/memory/notes/callclaude-bucket-audit-2026-05-18.md
