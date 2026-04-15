/**
 * forge-client — thin wrapper around mini-agent's forge-lite.sh.
 *
 * Middleware shells out to forge-lite.sh for worktree isolation. This module
 * keeps parsing logic in one place so route handlers stay small.
 *
 * If FORGE_LITE_PATH env var is unset, every call throws ForgeNotConfigured.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

export class ForgeError extends Error {
  code: string;
  stderr?: string;
  exitCode?: number;
  constructor(code: string, message: string, opts?: { stderr?: string; exitCode?: number }) {
    super(message);
    this.name = 'ForgeError';
    this.code = code;
    this.stderr = opts?.stderr;
    this.exitCode = opts?.exitCode;
  }
}

export interface AllocateOpts {
  purpose: string;
  callerPid?: number;
  files?: string;
  noInstall?: boolean;
}

export interface AllocateResult {
  slot_id: string;
  slot: number;
  worktree_path: string;
  branch: string;
  pid: number;
}

export type SlotState = 'free' | 'busy' | 'abandoned';

export interface SlotInfo {
  slot_id: string;
  slot: number;
  state: SlotState;
  path: string;
  branch: string;
  pid: string;
  age_s: number;
  files: string;
  cached: boolean;
}

export interface ListResult {
  total: number;
  busy: number;
  free: number;
  slots: SlotInfo[];
  crash_state?: string;
}

export interface CleanupResult {
  reclaimed: string[];
  still_alive: string[];
}

export interface ReleaseResult {
  released: boolean;
  slot_id: string;
}

function scriptPath(): string {
  const p = process.env.FORGE_LITE_PATH;
  if (!p) {
    throw new ForgeError('FORGE_NOT_CONFIGURED', 'FORGE_LITE_PATH env var is not set');
  }
  return p;
}

async function runForge(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const path = scriptPath();
  try {
    const { stdout, stderr } = await pExecFile('bash', [path, ...args], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
    });
    return { stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    throw new ForgeError('FORGE_EXEC_FAILED', e.message ?? 'forge-lite exec failed', {
      stderr: e.stderr,
      exitCode: typeof e.code === 'number' ? e.code : undefined,
    });
  }
}

function slotIdToNumber(slotId: string): number {
  const m = /^(?:forge-|slot-)?(\d+)$/.exec(slotId);
  if (!m) throw new ForgeError('INVALID_SLOT_ID', `invalid slot_id: ${slotId}`);
  return Number.parseInt(m[1]!, 10);
}

function slotNumberToId(n: number): string {
  return `forge-${n}`;
}

export async function list(): Promise<ListResult> {
  const { stdout } = await runForge(['status', '--json']);
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new ForgeError('FORGE_PARSE_FAILED', 'status --json returned empty output');
  }
  let raw: {
    total: number;
    busy: number;
    free: number;
    slots: Array<{
      slot: number;
      state: string;
      branch: string;
      pid: string;
      age_s: number;
      files: string;
      cached: boolean;
      path: string;
    }>;
    crash_state?: string;
  };
  try {
    raw = JSON.parse(trimmed);
  } catch (err) {
    throw new ForgeError('FORGE_PARSE_FAILED', `cannot parse status JSON: ${(err as Error).message}`);
  }
  const slots: SlotInfo[] = raw.slots.map((s) => ({
    slot_id: slotNumberToId(s.slot),
    slot: s.slot,
    state: (s.state === 'busy' || s.state === 'abandoned' ? s.state : 'free') as SlotState,
    path: s.path,
    branch: s.branch,
    pid: s.pid,
    age_s: s.age_s,
    files: s.files,
    cached: s.cached,
  }));
  return {
    total: raw.total,
    busy: raw.busy,
    free: raw.free,
    slots,
    crash_state: raw.crash_state,
  };
}

export async function info(slotId: string): Promise<SlotInfo> {
  const n = slotIdToNumber(slotId);
  const listing = await list();
  const found = listing.slots.find((s) => s.slot === n);
  if (!found) {
    throw new ForgeError('NOT_FOUND', `slot not found: ${slotId}`);
  }
  return found;
}

export async function allocate(opts: AllocateOpts): Promise<AllocateResult> {
  const before = await list();
  if (before.free <= 0) {
    throw new ForgeError('NO_FREE_SLOT', 'no free slot available', {
      stderr: JSON.stringify(before.slots.filter((s) => s.state === 'busy').map((s) => s.slot_id)),
    });
  }

  const args = ['create', opts.purpose, '--json'];
  if (opts.files) args.push('--files', opts.files);
  if (typeof opts.callerPid === 'number') args.push('--caller-pid', String(opts.callerPid));
  if (opts.noInstall) args.push('--no-install');

  const { stdout } = await runForge(args);
  const lastLine = stdout.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop();
  if (!lastLine) {
    throw new ForgeError('FORGE_PARSE_FAILED', `create did not emit JSON: ${stdout.slice(0, 500)}`);
  }
  let parsed: { path: string; branch: string; slot: number };
  try {
    parsed = JSON.parse(lastLine);
  } catch (err) {
    throw new ForgeError('FORGE_PARSE_FAILED', `cannot parse create JSON: ${(err as Error).message}`);
  }
  return {
    slot_id: slotNumberToId(parsed.slot),
    slot: parsed.slot,
    worktree_path: parsed.path,
    branch: parsed.branch,
    pid: opts.callerPid ?? 0,
  };
}

export async function release(slotId: string): Promise<ReleaseResult> {
  const target = await info(slotId);
  if (target.state === 'free') {
    return { released: false, slot_id: slotId };
  }
  await runForge(['cleanup', target.path]);
  return { released: true, slot_id: slotId };
}

export async function cleanup(): Promise<CleanupResult> {
  const before = await list();
  const abandoned = before.slots.filter((s) => s.state === 'abandoned');
  const stillAlive = before.slots.filter((s) => s.state === 'busy').map((s) => s.slot_id);
  const reclaimed: string[] = [];
  for (const slot of abandoned) {
    try {
      await runForge(['cleanup', slot.path]);
      reclaimed.push(slot.slot_id);
    } catch {
      // best-effort — keep going through remaining slots
    }
  }
  return { reclaimed, still_alive: stillAlive };
}

export function isConfigured(): boolean {
  return Boolean(process.env.FORGE_LITE_PATH);
}
