/**
 * Commitments ledger — cross-cycle "I will do X" promises survive cycle transitions.
 *
 * Schema source of truth: mini-agent proposal §5 (2026-04-15-middleware-as-organ.md).
 * Append-only JSONL on disk; in-memory map for queries; latest record wins per id.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type CommitmentChannel = 'room' | 'inner' | 'delegate' | 'user-prompt';
export type CommitmentStatus = 'active' | 'fulfilled' | 'superseded' | 'cancelled';
export type CommitmentResolutionKind = 'commit' | 'chat' | 'task-close' | 'supersede' | 'cancel';
export type CommitmentOwner = string;
const OWNER_MAX = 64;

export interface CommitmentSource {
  channel: CommitmentChannel;
  message_id?: string;
  cycle_id?: string;
}

export interface CommitmentParsed {
  action: string;
  deadline?: string;
  to?: string;
}

export interface CommitmentResolution {
  kind: CommitmentResolutionKind;
  evidence: string;
}

export interface Commitment {
  id: string;
  created_at: string;
  owner?: CommitmentOwner;
  source: CommitmentSource;
  text: string;
  parsed: CommitmentParsed;
  acceptance?: string;
  status: CommitmentStatus;
  linked_task_id?: string;
  linked_dag_id?: string;
  resolved_at?: string;
  resolution?: CommitmentResolution;
}

export interface CommitmentInput {
  owner?: CommitmentOwner;
  source: CommitmentSource;
  text: string;
  parsed: CommitmentParsed;
  acceptance?: string;
  linked_task_id?: string;
  linked_dag_id?: string;
}

export interface CommitmentPatch {
  status?: CommitmentStatus;
  linked_task_id?: string;
  linked_dag_id?: string;
  resolution?: CommitmentResolution;
}

const TEXT_MAX = 500;

let counter = 0;
function newId(): string {
  counter = (counter + 1) % 10000;
  return `cmt-${Date.now()}-${counter.toString().padStart(4, '0')}`;
}

export function validateInput(input: unknown): { ok: true; value: CommitmentInput } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: 'body must be object' };
  const i = input as Record<string, unknown>;
  if (!i.source || typeof i.source !== 'object') return { ok: false, error: 'source required' };
  const src = i.source as Record<string, unknown>;
  const channels: CommitmentChannel[] = ['room', 'inner', 'delegate', 'user-prompt'];
  if (!channels.includes(src.channel as CommitmentChannel)) return { ok: false, error: `source.channel must be one of: ${channels.join(',')}` };
  if (typeof i.text !== 'string' || !i.text) return { ok: false, error: 'text required (non-empty string)' };
  if (!i.parsed || typeof i.parsed !== 'object') return { ok: false, error: 'parsed required' };
  const p = i.parsed as Record<string, unknown>;
  if (typeof p.action !== 'string' || !p.action) return { ok: false, error: 'parsed.action required' };
  if (i.owner !== undefined) {
    if (typeof i.owner !== 'string' || !i.owner) return { ok: false, error: 'owner must be non-empty string' };
    if (i.owner.length > OWNER_MAX) return { ok: false, error: `owner exceeds max length ${OWNER_MAX}` };
  }
  if (i.acceptance !== undefined && typeof i.acceptance !== 'string') {
    return { ok: false, error: 'acceptance must be string' };
  }
  return {
    ok: true,
    value: {
      owner: i.owner as CommitmentOwner | undefined,
      source: {
        channel: src.channel as CommitmentChannel,
        message_id: typeof src.message_id === 'string' ? src.message_id : undefined,
        cycle_id: typeof src.cycle_id === 'string' ? src.cycle_id : undefined,
      },
      text: (i.text as string).slice(0, TEXT_MAX),
      parsed: {
        action: p.action as string,
        deadline: typeof p.deadline === 'string' ? p.deadline : undefined,
        to: typeof p.to === 'string' ? p.to : undefined,
      },
      acceptance: typeof i.acceptance === 'string' ? i.acceptance : undefined,
      linked_task_id: typeof i.linked_task_id === 'string' ? i.linked_task_id : undefined,
      linked_dag_id: typeof i.linked_dag_id === 'string' ? i.linked_dag_id : undefined,
    },
  };
}

export function createCommitment(input: CommitmentInput): Commitment {
  return {
    id: newId(),
    created_at: new Date().toISOString(),
    owner: input.owner,
    source: input.source,
    text: input.text,
    parsed: input.parsed,
    acceptance: input.acceptance,
    status: 'active',
    linked_task_id: input.linked_task_id,
    linked_dag_id: input.linked_dag_id,
  };
}

export function applyPatch(c: Commitment, patch: CommitmentPatch): Commitment {
  const next: Commitment = { ...c };
  if (patch.status) next.status = patch.status;
  if (patch.linked_task_id !== undefined) next.linked_task_id = patch.linked_task_id;
  if (patch.linked_dag_id !== undefined) next.linked_dag_id = patch.linked_dag_id;
  if (patch.resolution) {
    next.resolution = patch.resolution;
    next.resolved_at = new Date().toISOString();
  } else if (patch.status && patch.status !== 'active' && !next.resolved_at) {
    next.resolved_at = new Date().toISOString();
  }
  return next;
}

export interface CommitmentStore {
  create(input: CommitmentInput): Commitment;
  patch(id: string, p: CommitmentPatch): Commitment | null;
  get(id: string): Commitment | undefined;
  query(filter: { status?: CommitmentStatus; channel?: CommitmentChannel; owner?: CommitmentOwner }): Commitment[];
  stale(opts: { older_than_seconds: number; status?: CommitmentStatus }): Commitment[];
  all(): Commitment[];
}

export function openStore(cwd: string): CommitmentStore {
  const file = path.join(cwd, 'commitments.jsonl');
  const map = new Map<string, Commitment>();

  // Replay JSONL — latest line per id wins
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const c = JSON.parse(line) as Commitment;
        if (c?.id) map.set(c.id, c);
      } catch { /* skip malformed */ }
    }
  } catch { /* file not yet created */ }

  const persist = (c: Commitment) => {
    try { fs.appendFileSync(file, JSON.stringify(c) + '\n'); } catch { /* fail-open */ }
  };

  return {
    create(input) {
      const c = createCommitment(input);
      map.set(c.id, c);
      persist(c);
      return c;
    },
    patch(id, p) {
      const cur = map.get(id);
      if (!cur) return null;
      const next = applyPatch(cur, p);
      map.set(id, next);
      persist(next);
      return next;
    },
    get(id) { return map.get(id); },
    query(filter) {
      const out: Commitment[] = [];
      for (const c of map.values()) {
        if (filter.status && c.status !== filter.status) continue;
        if (filter.channel && c.source.channel !== filter.channel) continue;
        if (filter.owner && c.owner !== filter.owner) continue;
        out.push(c);
      }
      return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
    },
    stale(opts) {
      const cutoffMs = Date.now() - opts.older_than_seconds * 1000;
      const targetStatus = opts.status ?? 'active';
      return this.query({ status: targetStatus }).filter(c => Date.parse(c.created_at) < cutoffMs);
    },
    all() {
      return [...map.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
    },
  };
}
