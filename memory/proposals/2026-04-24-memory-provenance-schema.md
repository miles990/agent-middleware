# N0 — memory-provenance.jsonl schema (draft)

**Status**: draft v0.1 for claude-code review
**Author**: kuro
**Date**: 2026-04-24
**Phase**: 1 MVP (per Alex's 拍板 phased decision)
**Convention basis**: mirrors `mini-agent/memory/state/decision-provenance.jsonl`
**Review ask**: fields sufficient? enums adequate? any name collisions with existing middleware conventions?

---

## Why this exists

Every write into memory (HEARTBEAT task, inner-note, topic doc, KG node, conversation log, commitment) currently leaves no trail of **why** it was written, **what evidence** backed it, or **which subsystem** pulled the trigger. Post-hoc we cannot distinguish:

- a memory grounded in terminal-leaf evidence (e.g. bash probe output, grep hit, jq confirmation)
- a memory derived from another memory (derivation chain)
- a memory that is pure self-reflection with no external grounding
- a memory that is unsupported (hallucinated or ghost-commit)

This is the same problem `decision-provenance.jsonl` solves for **decisions**. This file solves it for **memory writes**.

## File format

- Path: `memory/state/memory-provenance.jsonl` (per-repo; agent-middleware and mini-agent each hold their own)
- Format: newline-delimited JSON, append-only, never mutated
- Writer: any subsystem that commits a memory entry MUST append one record per write
- Rotation: none in MVP (revisit when file >100MB)

## Schema

```jsonc
{
  "id":               "mp-<ts>-<rand6>",          // this provenance record's own id
  "ts":               "2026-04-24T08:35:12.003Z", // ISO-8601 UTC (matches decision-provenance)
  "cycle":            46,                          // kuro's cycle counter at write time (nullable if unknown)
  "subsystem":        "addTask",                   // who wrote the memory (see enum below)
  "memory_action":    "write",                     // write | update | supersede | delete | archive
  "memory_kind":      "heartbeat_task",            // what kind of memory (see enum below)
  "memory_entry_ref": "HEARTBEAT.md#L47",          // pointer to the entry just written (path+anchor, kg://node-id, jsonl#line, etc.)
  "evidence_kind":    "primary_observation",       // how is this memory grounded (see enum below)
  "evidence_ref":     "bash://pid-93594:exit0",    // pointer to the evidence (null if evidence_kind=unsupported or self_reflection)
  "reason":           "commitment kept: N0 schema drafted per claude-code 2026-04-24 phased MVP",
  "inputs": {                                      // triggering context, free-form object (mirrors decision-provenance.inputs)
    "trigger":        "direct-message (queued)",
    "mode":           "task",
    "commitment_id":  "cl-2-1777018886628",
    "falsifier":      "claude-code rejects schema as non-mirroring"
  }
}
```

### Enum: `subsystem`

Start narrow. Add entries only when a real writer lands:

- `addTask` — HEARTBEAT.md `<kuro:task>` path (memory.ts)
- `kuro-tag-handler` — `<kuro:reflection>`, `<kuro:learn>`, etc.
- `cycle-closer` — end-of-cycle summary writer
- `reflection-engine` — inner-notes.md appender
- `kg-publish` — knowledge graph node/edge writer
- `topic-writer` — memory/topics/*.md producer
- `conversation-logger` — memory/conversations/*.jsonl appender
- `commitment-ledger` — commitments.jsonl writer
- `delegation-result-sink` — results.jsonl → memory integration
- `manual` — Alex or Kuro direct edit (no programmatic writer)

### Enum: `memory_action`

- `write` — new entry
- `update` — in-place modification (rare; most memory is append-only)
- `supersede` — new entry replaces an older one; MUST include `inputs.superseded_id`
- `archive` — entry moved to archived section (HEARTBEAT archive comments, for example)
- `delete` — hard removal (rare; MUST include `reason` with policy citation)

### Enum: `memory_kind`

Mirrors the physical layout of memory/:

- `heartbeat_task` — HEARTBEAT.md Active Tasks line
- `heartbeat_decision` — HEARTBEAT.md Active Decisions section
- `inner_note` — inner-notes.md entry
- `topic_doc` — memory/topics/*.md file
- `report_doc` — memory/reports/*.md file
- `proposal_doc` — memory/proposals/*.md file (this file qualifies)
- `spec_doc` — memory/spec-selfreview/*.md
- `kg_node` — knowledge-nexus node (add_knowledge)
- `kg_edge` — knowledge-nexus edge (assert_edge)
- `conversation` — memory/conversations/*.jsonl line
- `commitment` — commitments.jsonl entry
- `delegation_result` — results.jsonl entry consumed into memory
- `soul_update` — SOUL.md / soul-core edit
- `task_queue` — task-queue.jsonl entry
- `activity_journal` — activity-journal.jsonl entry
- `other` — escape hatch; MUST include `inputs.kind_note` explaining

### Enum: `evidence_kind`

This is the **core new signal** Phase 1 adds. Ordered roughly by epistemic weight:

- `primary_observation` — direct terminal-leaf evidence (bash output, jq hit, grep confirmation, file content read THIS cycle)
- `delegation_result` — background worker/agent returned structured result (results.jsonl line, task completion payload)
- `external_doc` — web fetch, library docs, KG query result from authoritative source
- `prior_memory` — derived from another memory entry (MUST set `evidence_ref` to that entry's id/path)
- `decision_record` — grounded in a `decision-provenance.jsonl` line (MUST set `evidence_ref`)
- `self_reflection` — introspection with no external witness (OK for inner-notes, NOT OK for topic/report docs)
- `alex_directive` — Alex said so in conversation (MUST set `evidence_ref` to conversation line)
- `unsupported` — explicitly acknowledged ghost/speculation (MUST set `reason` to explain why written anyway)

### Enum: `evidence_ref` format

Free-form URI-ish string. Recommended schemes:

- `bash://pid-<N>:exit<code>` or `bash://cmd-<hash>:<output-digest>`
- `file://path/to/file.ts#L123-L140`
- `jsonl://path/to/file.jsonl#line<N>`
- `kg://node-<uuid>` or `kg://edge-<uuid>`
- `url://<https-url>` (for external_doc)
- `mem://<memory_entry_ref>` (for prior_memory)
- `dp://<decision-provenance-id>` (for decision_record; assumes decision-provenance entries gain ids in a future phase)
- `conv://path#line<N>` (for alex_directive)
- `null` (only for self_reflection or unsupported)

---

## Invariants (Phase 1 minimum)

1. **Append-only**. Never rewrite an existing line. Corrections use `memory_action=supersede` with `inputs.superseded_id`.
2. **Every memory write gets one record**. No silent writes. If a subsystem writes memory without appending here, that is a bug.
3. **Evidence honesty**. If `evidence_kind=self_reflection` or `unsupported`, downstream readers SHOULD weight lower. Don't dress up ghost commits as `primary_observation`.
4. **memory_entry_ref must resolve at write time**. If the target location doesn't exist yet (because the memory hasn't landed), delay the provenance write until it does. No forward-references.

## Non-goals (Phase 1)

- Signing / cryptographic integrity — flat file, trust-the-filesystem
- Cross-repo correlation — agent-middleware and mini-agent each have their own file; joining is a Phase 2 concern
- Automatic enforcement — no gate that blocks writes lacking provenance. This phase is observation-only; we measure coverage before enforcing.
- Retention / rotation policy — defer until file size becomes a problem

## Coverage gate (Phase 1 exit criterion)

Phase 1 is done when ≥90% of new memory writes during a 48h window carry a matching provenance record. Measured by diffing `git log --stat memory/` against `wc -l memory/state/memory-provenance.jsonl`.

## Open questions for claude-code review

1. **`cycle` field nullability** — when is it legitimately null? Only for subsystems running outside a cycle context (e.g. cron-triggered writers)? Or always required?
2. **`memory_entry_ref` for JSONL appenders** — resolving `#line<N>` means reading wc -l before each write. Acceptable overhead or should we use offset-at-write-time instead?
3. **Should `inputs` be strictly typed per subsystem** (like decision-provenance's inputs-per-subsystem convention) or stay free-form in MVP?
4. **Naming collision check** — does middleware already have a `provenance` namespace that would conflict? (I did not find one in a quick grep; please verify.)
5. **Decision-provenance ids** — current decision-provenance.jsonl has no `id` field. For `evidence_kind=decision_record` to work as designed, decision-provenance needs an id. Add in the same PR, or separate?

## Worked examples

### Example 1: writing a HEARTBEAT task after a commitment is kept

```json
{"id":"mp-2026-04-24T08:35:12Z-a3b7c1","ts":"2026-04-24T08:35:12.003Z","cycle":46,"subsystem":"addTask","memory_action":"write","memory_kind":"heartbeat_task","memory_entry_ref":"HEARTBEAT.md#L47","evidence_kind":"primary_observation","evidence_ref":"bash://cmd-7f2a:exit0","reason":"pipeline bg run verified 10/10 enriched","inputs":{"trigger":"continuation","commitment_id":"cl-3-1777018886628","falsifier":"pending-llm-pass string reappears in artifacts/*.json"}}
```

### Example 2: writing an inner-note with no external witness

```json
{"id":"mp-2026-04-24T08:40:02Z-d4e9f1","ts":"2026-04-24T08:40:02.114Z","cycle":46,"subsystem":"reflection-engine","memory_action":"write","memory_kind":"inner_note","memory_entry_ref":"memory/inner-notes.md#L2031","evidence_kind":"self_reflection","evidence_ref":null,"reason":"pattern noticed across 3 cycles: restraint chain broken by real action","inputs":{"trigger":"cycle-close","pattern_cycles":[35,41,46]}}
```

### Example 3: superseding a refuted task

```json
{"id":"mp-2026-04-24T09:02:18Z-b8c3e4","ts":"2026-04-24T09:02:18.550Z","cycle":47,"subsystem":"cycle-closer","memory_action":"supersede","memory_kind":"heartbeat_task","memory_entry_ref":"HEARTBEAT.md#L55","evidence_kind":"delegation_result","evidence_ref":"jsonl://results.jsonl#line1204","reason":"dual-script bug theory FALSIFIED per hn-trend-three-state-falsified.md","inputs":{"trigger":"delegation-complete","superseded_id":"mp-2026-04-23T01:46:00Z-xxxxxx","report_ref":"memory/reports/2026-04-23-hn-trend-three-state-falsified.md"}}
```

### Example 4: ghost commit (unsupported) acknowledged as such

```json
{"id":"mp-2026-04-24T10:15:00Z-ff0011","ts":"2026-04-24T10:15:00.000Z","cycle":47,"subsystem":"addTask","memory_action":"write","memory_kind":"heartbeat_task","memory_entry_ref":"HEARTBEAT.md#L91","evidence_kind":"unsupported","evidence_ref":null,"reason":"speculative reminder to revisit X; no evidence yet, but marking for future cycle","inputs":{"trigger":"kuro-tag-handler","speculation":true,"expires_cycle":52}}
```

---

## Next up (N1, not this doc)

Once N0 lands, N1 adds three fields to the in-memory `MemoryEntry` type (`mini-agent/src/types.ts:118`):

```ts
export interface MemoryEntry {
  content: string;
  source: string;
  date: string;
  // N1 additions:
  memory_kind?: MemoryKind;          // enum per N0
  evidence_kind?: EvidenceKind;      // enum per N0
  evidence_ref?: string | null;      // per N0 format
}
```

Plus export of the two enums from a new `src/memory-provenance.ts` module that also houses the JSONL appender. But that's N1's problem.

---

## Review checklist for claude-code

- [ ] Schema fields cover the four provenance questions (when/who/what/why+grounding)?
- [ ] Enums start narrow enough to avoid bikeshedding but open enough via `other`?
- [ ] JSONL append-only semantics compatible with middleware's existing file-based writers?
- [ ] Naming (`memory-provenance.jsonl`) doesn't collide with anything you have in-flight?
- [ ] Open questions 1-5 above resolved or flagged?
