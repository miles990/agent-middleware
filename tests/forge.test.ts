/**
 * Forge worktree endpoint tests (W7).
 *
 * Covers 503 when FORGE_LITE_PATH unset, happy-path round-trips against a
 * mock bash script that emits deterministic output matching forge-lite.sh,
 * and error branches (404, 503 no_free_slot).
 *
 * Run: npx tsx --test tests/forge.test.ts
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRouter } from '../src/api.js';

const MOCK_STATE_FILE = path.join(os.tmpdir(), `forge-mock-state-${process.pid}.json`);

function writeMockScript(): string {
  const scriptPath = path.join(os.tmpdir(), `forge-mock-${process.pid}-${Date.now()}.sh`);
  const body = `#!/bin/bash
# Mock forge-lite.sh — reads/writes state JSON at $MOCK_STATE_FILE.
STATE='${MOCK_STATE_FILE}'
CMD="$1"; shift || true

read_state() {
  if [ -f "$STATE" ]; then cat "$STATE"; else echo '{"slots":[{"slot":1,"state":"free"},{"slot":2,"state":"free"},{"slot":3,"state":"free"}]}'; fi
}

write_state() {
  echo "$1" > "$STATE"
}

case "$CMD" in
  status)
    state=$(read_state)
    # Expect raw json in state file; decorate with totals.
    node -e "
      const s = JSON.parse(process.argv[1]);
      const slots = s.slots.map(x => ({
        slot: x.slot,
        state: x.state,
        branch: x.branch || '',
        pid: x.pid || '',
        age_s: x.age_s || 0,
        files: x.files || '',
        cached: x.cached === true,
        path: x.path || ('/tmp/mock-forge-'+x.slot),
      }));
      const busy = slots.filter(s=>s.state==='busy').length;
      const abandoned = slots.filter(s=>s.state==='abandoned').length;
      const free = slots.length - busy - abandoned;
      process.stdout.write(JSON.stringify({total:slots.length,busy,free,slots}));
    " "$state"
    ;;
  create)
    purpose="$1"; shift || true
    json_mode=false
    caller_pid=0
    while [ $# -gt 0 ]; do
      case "$1" in
        --json) json_mode=true; shift ;;
        --caller-pid) caller_pid="$2"; shift 2 ;;
        --files) shift 2 ;;
        --no-install) shift ;;
        *) shift ;;
      esac
    done
    state=$(read_state)
    new_state=$(node -e "
      const s = JSON.parse(process.argv[1]);
      const purpose = process.argv[2];
      const pid = process.argv[3];
      const free = s.slots.find(x => x.state === 'free');
      if (!free) { process.stderr.write('no_free_slot'); process.exit(1); }
      free.state = 'busy';
      free.branch = 'feature/' + purpose;
      free.pid = String(pid);
      free.path = '/tmp/mock-forge-' + free.slot;
      free.age_s = 0;
      free._allocated = free.slot;
      process.stdout.write(JSON.stringify(s));
    " "$state" "$purpose" "$caller_pid")
    if [ -z "$new_state" ]; then
      echo "no free slot" >&2
      exit 1
    fi
    write_state "$new_state"
    allocated=$(echo "$new_state" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const s=JSON.parse(d);const a=s.slots.find(x=>x._allocated);process.stdout.write(JSON.stringify({path:a.path,branch:a.branch,slot:a.slot}))})")
    if [ "$json_mode" = true ]; then
      echo "$allocated"
    else
      echo "$allocated" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{process.stdout.write(JSON.parse(d).path)})"
    fi
    ;;
  cleanup)
    target_path="$1"
    state=$(read_state)
    new_state=$(node -e "
      const s = JSON.parse(process.argv[1]);
      const p = process.argv[2];
      const slot = s.slots.find(x => x.path === p);
      if (slot) {
        slot.state = 'free';
        slot.branch = '';
        slot.pid = '';
        slot.age_s = 0;
        delete slot._allocated;
      }
      process.stdout.write(JSON.stringify(s));
    " "$state" "$target_path")
    write_state "$new_state"
    echo "[cleanup] Released" >&2
    ;;
  *)
    echo "unknown command: $CMD" >&2
    exit 1
    ;;
esac
`;
  fs.writeFileSync(scriptPath, body, { mode: 0o755 });
  return scriptPath;
}

function resetMockState(custom?: unknown): void {
  if (custom !== undefined) {
    fs.writeFileSync(MOCK_STATE_FILE, JSON.stringify(custom));
  } else if (fs.existsSync(MOCK_STATE_FILE)) {
    fs.unlinkSync(MOCK_STATE_FILE);
  }
}

async function request(app: ReturnType<typeof createRouter>, p: string, opts?: { method?: string; body?: unknown; headers?: Record<string, string> }) {
  const method = opts?.method ?? 'GET';
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...opts?.headers };
  const init: RequestInit = { method, headers };
  if (opts?.body) init.body = JSON.stringify(opts.body);
  return app.request(p, init);
}

describe('Forge endpoints — FORGE_LITE_PATH unset', () => {
  let app: ReturnType<typeof createRouter>;
  const savedPath = process.env.FORGE_LITE_PATH;

  before(() => {
    delete process.env.FORGE_LITE_PATH;
    app = createRouter({ cwd: os.tmpdir() });
  });

  after(() => {
    if (savedPath !== undefined) process.env.FORGE_LITE_PATH = savedPath;
  });

  it('GET /forge/list returns 503 forge_not_configured', async () => {
    const res = await request(app, '/forge/list');
    assert.equal(res.status, 503);
    const body = await res.json() as { error: string };
    assert.equal(body.error, 'forge_not_configured');
  });

  it('GET /forge/info/:slot_id returns 503 forge_not_configured', async () => {
    const res = await request(app, '/forge/info/forge-1');
    assert.equal(res.status, 503);
    const body = await res.json() as { error: string };
    assert.equal(body.error, 'forge_not_configured');
  });

  it('POST /forge/allocate returns 503 forge_not_configured', async () => {
    const res = await request(app, '/forge/allocate', { method: 'POST', body: { purpose: 'test' } });
    assert.equal(res.status, 503);
    const body = await res.json() as { error: string };
    assert.equal(body.error, 'forge_not_configured');
  });

  it('POST /forge/release/:slot_id returns 503 forge_not_configured', async () => {
    const res = await request(app, '/forge/release/forge-1', { method: 'POST' });
    assert.equal(res.status, 503);
    const body = await res.json() as { error: string };
    assert.equal(body.error, 'forge_not_configured');
  });

  it('POST /forge/cleanup returns 503 forge_not_configured', async () => {
    const res = await request(app, '/forge/cleanup', { method: 'POST' });
    assert.equal(res.status, 503);
    const body = await res.json() as { error: string };
    assert.equal(body.error, 'forge_not_configured');
  });
});

describe('Forge endpoints — with mock forge-lite.sh', () => {
  let app: ReturnType<typeof createRouter>;
  let mockPath: string;
  const savedPath = process.env.FORGE_LITE_PATH;

  before(() => {
    mockPath = writeMockScript();
    process.env.FORGE_LITE_PATH = mockPath;
    app = createRouter({ cwd: os.tmpdir() });
  });

  after(() => {
    if (savedPath !== undefined) process.env.FORGE_LITE_PATH = savedPath;
    else delete process.env.FORGE_LITE_PATH;
    try { fs.unlinkSync(mockPath); } catch { /* ignore */ }
    try { fs.unlinkSync(MOCK_STATE_FILE); } catch { /* ignore */ }
  });

  beforeEach(() => {
    resetMockState();
  });

  it('GET /forge/list returns slot info from status --json', async () => {
    const res = await request(app, '/forge/list');
    assert.equal(res.status, 200);
    const body = await res.json() as { total: number; free: number; busy: number; slots: Array<{ slot_id: string; state: string }> };
    assert.equal(body.total, 3);
    assert.equal(body.free, 3);
    assert.equal(body.busy, 0);
    assert.equal(body.slots.length, 3);
    assert.equal(body.slots[0]!.slot_id, 'forge-1');
    assert.equal(body.slots[0]!.state, 'free');
  });

  it('POST /forge/allocate claims a slot and returns path + branch', async () => {
    const res = await request(app, '/forge/allocate', {
      method: 'POST',
      body: { purpose: 'coder-refactor' },
      headers: { 'X-Caller-Pid': '4242' },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { slot_id: string; slot: number; worktree_path: string; branch: string; pid: number };
    assert.equal(body.slot_id, 'forge-1');
    assert.equal(body.slot, 1);
    assert.equal(body.worktree_path, '/tmp/mock-forge-1');
    assert.equal(body.branch, 'feature/coder-refactor');
    assert.equal(body.pid, 4242);
  });

  it('POST /forge/allocate rejects missing purpose', async () => {
    const res = await request(app, '/forge/allocate', { method: 'POST', body: {} });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.ok(body.error.includes('purpose'));
  });

  it('POST /forge/allocate returns 503 no_free_slot when all busy', async () => {
    resetMockState({
      slots: [
        { slot: 1, state: 'busy', branch: 'feature/a', pid: '1', path: '/tmp/mock-forge-1' },
        { slot: 2, state: 'busy', branch: 'feature/b', pid: '2', path: '/tmp/mock-forge-2' },
        { slot: 3, state: 'busy', branch: 'feature/c', pid: '3', path: '/tmp/mock-forge-3' },
      ],
    });
    const res = await request(app, '/forge/allocate', { method: 'POST', body: { purpose: 'x' } });
    assert.equal(res.status, 503);
    const body = await res.json() as { error: string; in_use: string[] };
    assert.equal(body.error, 'no_free_slot');
    assert.ok(Array.isArray(body.in_use));
    assert.equal(body.in_use.length, 3);
  });

  it('GET /forge/info/:slot_id returns slot detail', async () => {
    resetMockState({
      slots: [
        { slot: 1, state: 'busy', branch: 'feature/x', pid: '99', path: '/tmp/mock-forge-1', age_s: 10 },
        { slot: 2, state: 'free' },
        { slot: 3, state: 'free' },
      ],
    });
    const res = await request(app, '/forge/info/forge-1');
    assert.equal(res.status, 200);
    const body = await res.json() as { slot_id: string; state: string; branch: string; pid: string };
    assert.equal(body.slot_id, 'forge-1');
    assert.equal(body.state, 'busy');
    assert.equal(body.branch, 'feature/x');
    assert.equal(body.pid, '99');
  });

  it('GET /forge/info/:slot_id returns 404 for unknown slot', async () => {
    const res = await request(app, '/forge/info/forge-99');
    assert.equal(res.status, 404);
    const body = await res.json() as { error: string };
    assert.equal(body.error, 'not_found');
  });

  it('GET /forge/info/:slot_id returns 400 for malformed slot_id', async () => {
    const res = await request(app, '/forge/info/not-a-slot');
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.equal(body.error, 'invalid_slot_id');
  });

  it('POST /forge/release/:slot_id releases in-use slot', async () => {
    const alloc = await request(app, '/forge/allocate', { method: 'POST', body: { purpose: 'rel-test' } });
    assert.equal(alloc.status, 200);
    const { slot_id } = await alloc.json() as { slot_id: string };

    const res = await request(app, `/forge/release/${slot_id}`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json() as { released: boolean; slot_id: string };
    assert.equal(body.released, true);
    assert.equal(body.slot_id, slot_id);

    const check = await request(app, `/forge/info/${slot_id}`);
    const info = await check.json() as { state: string };
    assert.equal(info.state, 'free');
  });

  it('POST /forge/release/:slot_id is idempotent for free slot', async () => {
    const res = await request(app, '/forge/release/forge-2', { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json() as { released: boolean; slot_id: string };
    assert.equal(body.released, false);
    assert.equal(body.slot_id, 'forge-2');
  });

  it('POST /forge/release/:slot_id returns 404 for unknown slot', async () => {
    const res = await request(app, '/forge/release/forge-99', { method: 'POST' });
    assert.equal(res.status, 404);
    const body = await res.json() as { error: string };
    assert.equal(body.error, 'not_found');
  });

  it('POST /forge/cleanup reclaims abandoned slots', async () => {
    resetMockState({
      slots: [
        { slot: 1, state: 'busy', branch: 'feature/live', pid: '1', path: '/tmp/mock-forge-1' },
        { slot: 2, state: 'abandoned', branch: 'feature/dead', pid: '99999', path: '/tmp/mock-forge-2' },
        { slot: 3, state: 'free' },
      ],
    });
    const res = await request(app, '/forge/cleanup', { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json() as { reclaimed: string[]; still_alive: string[] };
    assert.deepEqual(body.reclaimed, ['forge-2']);
    assert.deepEqual(body.still_alive, ['forge-1']);
  });

  it('POST /forge/cleanup with nothing to reclaim returns empty list', async () => {
    const res = await request(app, '/forge/cleanup', { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json() as { reclaimed: string[]; still_alive: string[] };
    assert.deepEqual(body.reclaimed, []);
    assert.deepEqual(body.still_alive, []);
  });

  it('full round-trip: allocate → list shows busy → release → list shows free', async () => {
    const a1 = await request(app, '/forge/allocate', { method: 'POST', body: { purpose: 'rt' } });
    const { slot_id } = await a1.json() as { slot_id: string };

    const l1 = await request(app, '/forge/list');
    const lb1 = await l1.json() as { busy: number; free: number };
    assert.equal(lb1.busy, 1);
    assert.equal(lb1.free, 2);

    await request(app, `/forge/release/${slot_id}`, { method: 'POST' });

    const l2 = await request(app, '/forge/list');
    const lb2 = await l2.json() as { busy: number; free: number };
    assert.equal(lb2.busy, 0);
    assert.equal(lb2.free, 3);
  });
});
