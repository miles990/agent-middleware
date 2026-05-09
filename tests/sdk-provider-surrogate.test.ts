/**
 * sanitizeUnpairedSurrogates — defends Anthropic API JSON boundary against
 * lone UTF-16 surrogates that yield HTTP 400 "no low surrogate in string".
 *
 * Reproduces the failure pattern observed in results.jsonl
 * (task-1778314085124-cc et al, 30× agent-brain failures at char 46K-56K).
 *
 * Run: npx tsx --test tests/sdk-provider-surrogate.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeUnpairedSurrogates } from '../src/sdk-provider.js';

describe('sanitizeUnpairedSurrogates', () => {
  it('passes plain ASCII through unchanged', () => {
    assert.equal(sanitizeUnpairedSurrogates('hello world'), 'hello world');
  });

  it('passes paired surrogates (valid emoji) through unchanged', () => {
    // 😀 = U+1F600, encoded as paired surrogates D83D DE00
    const emoji = '\uD83D\uDE00';
    assert.equal(sanitizeUnpairedSurrogates(`hi ${emoji}!`), `hi ${emoji}!`);
  });

  it('passes BMP CJK characters through unchanged', () => {
    // CJK characters live in BMP, no surrogate pairs involved
    assert.equal(sanitizeUnpairedSurrogates('你好世界'), '你好世界');
  });

  it('replaces a lone high surrogate with U+FFFD', () => {
    const broken = 'before\uD83Dafter';
    const fixed = sanitizeUnpairedSurrogates(broken);
    assert.equal(fixed, 'before\uFFFDafter');
  });

  it('replaces a lone low surrogate with U+FFFD', () => {
    const broken = 'before\uDE00after';
    const fixed = sanitizeUnpairedSurrogates(broken);
    assert.equal(fixed, 'before\uFFFDafter');
  });

  it('replaces a high surrogate at end-of-string', () => {
    const broken = 'tail-\uD83D';
    assert.equal(sanitizeUnpairedSurrogates(broken), 'tail-\uFFFD');
  });

  it('replaces a low surrogate at start-of-string', () => {
    const broken = '\uDE00-head';
    assert.equal(sanitizeUnpairedSurrogates(broken), '\uFFFD-head');
  });

  it('preserves valid pair adjacent to a lone surrogate', () => {
    // Valid 😀 pair followed by lone high surrogate
    const broken = '\uD83D\uDE00\uD83D end';
    assert.equal(sanitizeUnpairedSurrogates(broken), '\uD83D\uDE00\uFFFD end');
  });

  it('produces JSON-safe output (the actual failure mode)', () => {
    // The original failure: JSON.stringify happily emits lone surrogates,
    // but Anthropic's parser rejects them. After sanitize, JSON.stringify
    // followed by JSON.parse must round-trip cleanly.
    const broken = `prompt body... ${'\uD83D'} ...trailing`;
    const cleaned = sanitizeUnpairedSurrogates(broken);
    const roundTripped = JSON.parse(JSON.stringify(cleaned));
    assert.equal(roundTripped, cleaned);
    // Crucially the cleaned string contains no unpaired surrogates
    assert.match(cleaned, /\uFFFD/);
    assert.doesNotMatch(cleaned, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    assert.doesNotMatch(cleaned, /(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});
