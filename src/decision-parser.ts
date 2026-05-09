/**
 * decision-parser — extracts the `## Decision` block from Claude Code subprocess
 * responses so agent-middleware can wire its own commitment ledger.
 *
 * Ported from mini-agent/src/dispatcher.ts (extractDecisionBlock +
 * synthesizeDecisionFromProse). Issue #452: agent-middleware spawns Claude Code
 * but never parses Decision blocks, so falsifiers from middleware-driven Kuro
 * cycles silently no-op. This module is the parser half; ledger persistence
 * (writeCommitment + counterparty=self schema) is intentionally separated to
 * allow ledger-design call before wiring.
 *
 * Run tests: npx tsx --test tests/decision-parser.test.ts
 */

export interface DecisionBlock {
  serving?: string;
  chose?: string;
  falsifier?: string;
  ttl?: number;
}

/**
 * Extracts the `## Decision` block from an agent response.
 * Returns the parsed fields, or null when the block is absent / empty.
 * Soft extractor: never throws.
 */
export function extractDecisionBlock(response: string): DecisionBlock | null {
  const headerIdx = response.search(/^#{2,3}\s*Decision\b/im);
  if (headerIdx === -1) return null;

  const afterHeader = response.slice(headerIdx).replace(/^[^\n]+\n/, '');
  const nextSectionIdx = afterHeader.search(/\n##\s/m);
  const block = nextSectionIdx === -1 ? afterHeader : afterHeader.slice(0, nextSectionIdx);

  // Field-line prefix supports: optional bullet, optional **bold** label.
  const FIELD_PFX = String.raw`^[-*+]?\s*\d*\.?\s*\**\s*`;
  const FIELD_TAIL = String.raw`\**\s*:\s*(.+)$`;
  const buildRe = (name: string) => new RegExp(FIELD_PFX + name + FIELD_TAIL, 'im');
  const extractField = (re: RegExp): string | undefined => {
    const m = block.match(re);
    if (!m) return undefined;
    const v = m[1].trim();
    return v.length > 0 ? v : undefined;
  };

  const serving = extractField(buildRe('serving'));
  const chose = extractField(buildRe('chose'));
  const falsifier = extractField(buildRe('(?:falsifier|falsify)'));
  const ttlStr = block.match(new RegExp(FIELD_PFX + 'ttl' + String.raw`\**\s*:\s*(\d+)$`, 'im'))?.[1];
  const ttl = ttlStr ? Math.min(20, Math.max(1, parseInt(ttlStr, 10))) : undefined;

  if (!serving && !chose && !falsifier) return null;
  return { serving, chose, falsifier, ttl };
}

/**
 * Synthesizes a Decision block from prose containing `chose:` / `falsifier:`
 * lines without an explicit `## Decision` header. Returns null when synthesis
 * is unsafe (response too short, missing chose anchor, chose too short).
 *
 * Anchor: explicit `chose:` line. Without it we cannot reliably distinguish
 * a commitment from a status update — `verified X / shipped Y` prose alone
 * is too noisy.
 */
export function synthesizeDecisionFromProse(
  response: string,
): { chose: string; falsifier?: string; ttl: number } | null {
  if (response.length < 200) return null;

  const choseMatch = response.match(/^\s*[-*+]?\s*\**\s*chose\**\s*:\s*(.+)$/im);
  if (!choseMatch) return null;
  const chose = choseMatch[1].trim();
  if (chose.length < 8) return null;

  const falsifierMatch = response.match(
    /^\s*[-*+]?\s*\**\s*(?:falsifier|falsify)\**\s*:\s*(.+)$/im,
  );
  const falsifier = falsifierMatch ? falsifierMatch[1].trim() : undefined;

  const ttlMatch = response.match(/^\s*[-*+]?\s*\**\s*ttl\**\s*:\s*(\d+)$/im);
  const ttl = ttlMatch ? Math.min(20, Math.max(1, parseInt(ttlMatch[1], 10))) : 3;

  return { chose, falsifier, ttl };
}
