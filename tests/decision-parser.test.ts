/**
 * decision-parser tests — port verifier for issue #452.
 * Mirrors the behavioural envelope of mini-agent's extractDecisionBlock /
 * synthesizeDecisionFromProse so middleware can hook the same parser.
 *
 * Run: npx tsx --test tests/decision-parser.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractDecisionBlock, synthesizeDecisionFromProse } from '../src/decision-parser.js';

describe('extractDecisionBlock', () => {
  it('returns null when no Decision header', () => {
    assert.equal(extractDecisionBlock('## Summary\nfoo'), null);
  });

  it('parses a canonical block with all four fields', () => {
    const r = extractDecisionBlock([
      '## Decision',
      'serving: ledger writes resume',
      'chose: port parser into middleware',
      'falsifier: grep:/abs/x "y" >=1',
      'ttl: 4',
      '## Next',
      'something else',
    ].join('\n'));
    assert.deepEqual(r, {
      serving: 'ledger writes resume',
      chose: 'port parser into middleware',
      falsifier: 'grep:/abs/x "y" >=1',
      ttl: 4,
    });
  });

  it('tolerates bullet + **bold** label combos', () => {
    const r = extractDecisionBlock([
      '## Decision',
      '- **serving**: convergence',
      '- **chose**: ship the patch',
      '- **falsifier**: file_exists:/a',
      '- **ttl**: 5',
    ].join('\n'));
    assert.equal(r?.chose, 'ship the patch');
    assert.equal(r?.ttl, 5);
  });

  it('clamps ttl into 1..20', () => {
    const high = extractDecisionBlock('## Decision\nchose: x\nttl: 999');
    assert.equal(high?.ttl, 20);
    const low = extractDecisionBlock('## Decision\nchose: x\nttl: 0');
    assert.equal(low?.ttl, 1);
  });

  it('returns null when block has no extractable fields', () => {
    const r = extractDecisionBlock('### Decision\n\nthis is just prose\nno fields here');
    assert.equal(r, null);
  });

  it('stops at the next ## section', () => {
    const r = extractDecisionBlock([
      '## Decision',
      'chose: A',
      '## Notes',
      'chose: B',
    ].join('\n'));
    assert.equal(r?.chose, 'A');
  });

  it('accepts ### Decision (h3) header', () => {
    const r = extractDecisionBlock('### Decision\nchose: x');
    assert.equal(r?.chose, 'x');
  });
});

describe('synthesizeDecisionFromProse', () => {
  const padding = 'x'.repeat(220);

  it('returns null when response shorter than 200 chars', () => {
    assert.equal(synthesizeDecisionFromProse('chose: short'), null);
  });

  it('returns null when no chose anchor', () => {
    assert.equal(synthesizeDecisionFromProse('verified X shipped Y\n' + padding), null);
  });

  it('returns null when chose value is too short', () => {
    assert.equal(synthesizeDecisionFromProse('chose: x\n' + padding), null);
  });

  it('synthesizes minimal block from chose-only prose', () => {
    const r = synthesizeDecisionFromProse('chose: do a verifiable thing\n' + padding);
    assert.equal(r?.chose, 'do a verifiable thing');
    assert.equal(r?.ttl, 3);
    assert.equal(r?.falsifier, undefined);
  });

  it('extracts falsifier and ttl when present', () => {
    const r = synthesizeDecisionFromProse(
      'chose: ship parser port\nfalsifier: grep:/x "y" >=1\nttl: 4\n' + padding,
    );
    assert.equal(r?.falsifier, 'grep:/x "y" >=1');
    assert.equal(r?.ttl, 4);
  });
});

describe('extractDecisionBlock — edge cases', () => {
  it('handles CRLF line endings (edge case: LLM outputs with mixed newlines)', () => {
    const r = extractDecisionBlock(
      '## Decision\r\nchose: ship the patch\r\nfalsifier: file_exists:/a\r\nttl: 4\r\n',
    );
    assert.equal(r?.chose, 'ship the patch');
    assert.equal(r?.falsifier, 'file_exists:/a');
    assert.equal(r?.ttl, 4);
  });

  it('returns null for empty input (edge case: malformed/zero-length response)', () => {
    assert.equal(extractDecisionBlock(''), null);
  });

  it('parses block at end of response with no trailing newline (edge case: truncated stream)', () => {
    const r = extractDecisionBlock('preamble\n## Decision\nchose: tail-anchored');
    assert.equal(r?.chose, 'tail-anchored');
  });

  it('skips field with empty value (edge case: malformed `chose: `)', () => {
    const r = extractDecisionBlock('## Decision\nserving: real value\nchose:   \nfalsifier: file_exists:/a');
    assert.equal(r?.chose, undefined);
    assert.equal(r?.serving, 'real value');
    assert.equal(r?.falsifier, 'file_exists:/a');
  });
});
