/**
 * ResultBuffer.pushToolUse tests — issue #1 (cross-agent observability).
 * Run: npx tsx --test tests/result-buffer-tooluse.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ResultBuffer } from '../src/result-buffer.js';

describe('ResultBuffer.pushToolUse', () => {
  it('appends tool_use events to TaskRecord.metadata.toolUseSummary', () => {
    const buf = new ResultBuffer();
    const id = buf.submit({ worker: 'agent-brain', task: 'demo' });
    buf.start(id);
    buf.pushToolUse(id, { name: 'Read', target: '/tmp/foo.ts', id: 'tu_1', ts: 1000 });
    buf.pushToolUse(id, { name: 'Bash', target: 'ls -la', id: 'tu_2', ts: 1010 });

    const rec = buf.get(id);
    assert.ok(rec, 'task exists');
    const meta = rec!.metadata as Record<string, unknown>;
    assert.equal(meta.toolUseCount, 2);
    const arr = meta.toolUseSummary as Array<{ name: string; target?: string }>;
    assert.equal(arr.length, 2);
    assert.equal(arr[0].name, 'Read');
    assert.equal(arr[0].target, '/tmp/foo.ts');
    assert.equal(arr[1].name, 'Bash');
  });

  it('updates ok-status in place when matching tool_use_id arrives', () => {
    const buf = new ResultBuffer();
    const id = buf.submit({ worker: 'agent-brain', task: 'demo' });
    buf.start(id);
    // Initial tool_use (pending)
    buf.pushToolUse(id, { name: 'Edit', target: 'src/x.ts', id: 'tu_42', ts: 1000 });
    // Matching tool_result (ok=true)
    buf.pushToolUse(id, { name: 'Edit', target: 'src/x.ts', id: 'tu_42', ok: true, ts: 1100 });

    const rec = buf.get(id);
    const meta = rec!.metadata as Record<string, unknown>;
    const arr = meta.toolUseSummary as Array<{ id?: string; ok?: boolean; ts: number }>;
    assert.equal(arr.length, 1, 'no duplicate entry');
    assert.equal(arr[0].ok, true);
    assert.equal(arr[0].ts, 1100, 'updated timestamp');
    assert.equal(meta.toolUseCount, 1);
  });

  it('caps history at 200 entries to bound memory', () => {
    const buf = new ResultBuffer();
    const id = buf.submit({ worker: 'agent-brain', task: 'demo' });
    buf.start(id);
    for (let i = 0; i < 250; i++) {
      buf.pushToolUse(id, { name: 'Read', target: `/tmp/${i}`, id: `tu_${i}`, ts: i });
    }
    const rec = buf.get(id);
    const arr = (rec!.metadata as Record<string, unknown>).toolUseSummary as Array<{ target: string }>;
    assert.equal(arr.length, 200);
    // Oldest 50 evicted; first remaining should be index 50
    assert.equal(arr[0].target, '/tmp/50');
    assert.equal(arr[199].target, '/tmp/249');
  });

  it('is a no-op for unknown task ids (no throw)', () => {
    const buf = new ResultBuffer();
    assert.doesNotThrow(() => {
      buf.pushToolUse('nonexistent', { name: 'Read', ts: 0 });
    });
  });

  it('preserves pre-existing metadata fields (additive)', () => {
    const buf = new ResultBuffer();
    const id = buf.submit({
      worker: 'agent-brain',
      task: 'demo',
      metadata: { cwd: '/workspace', timeoutMs: 60000 },
    });
    buf.start(id);
    buf.pushToolUse(id, { name: 'Read', target: '/foo', ts: 0 });
    const rec = buf.get(id);
    const meta = rec!.metadata as Record<string, unknown>;
    assert.equal(meta.cwd, '/workspace');
    assert.equal(meta.timeoutMs, 60000);
    assert.equal(meta.toolUseCount, 1);
  });
});
