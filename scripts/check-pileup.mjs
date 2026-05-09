#!/usr/bin/env node
/**
 * check-pileup.mjs — reference impl for mini-agent#456 Option 3
 *
 * Block kuro-agent from posting another comment on an issue when
 *   (a) the last `--threshold N` comments are all from kuro-agent, AND
 *   (b) no non-kuro-agent comment exists within `--window-hours H`.
 *
 * Exits 0 = ALLOW, 1 = BLOCK. JSON to stdout.
 *
 * Usage:
 *   node scripts/check-pileup.mjs --repo owner/name --issue N \
 *        [--threshold 3] [--window-hours 24] [--actor kuro-agent]
 */
import { execFileSync } from 'node:child_process';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  return process.argv[i + 1];
}

const repo = arg('--repo');
const issue = arg('--issue');
const threshold = Number(arg('--threshold', '3'));
const windowHours = Number(arg('--window-hours', '24'));
const actor = arg('--actor', 'kuro-agent');

if (!repo || !issue) {
  console.error('usage: --repo owner/name --issue N [--threshold 3] [--window-hours 24]');
  process.exit(2);
}

const raw = execFileSync('gh', ['issue', 'view', issue, '--repo', repo, '--json', 'comments'], {
  encoding: 'utf8',
});
const { comments } = JSON.parse(raw);

const now = Date.now();
const windowMs = windowHours * 3600 * 1000;
const recent = comments.filter(c => now - new Date(c.createdAt).getTime() <= windowMs);

const recentByActor = recent.filter(c => c.author?.login === actor);
const recentNonActor = recent.filter(c => c.author?.login !== actor);

// Block condition: enough actor comments AND zero non-actor in window
const block = recentByActor.length >= threshold && recentNonActor.length === 0;

const result = {
  decision: block ? 'BLOCK' : 'ALLOW',
  reason: block
    ? `${recentByActor.length} ${actor} comments in last ${windowHours}h with 0 external comments (threshold=${threshold})`
    : `actor=${recentByActor.length} non-actor=${recentNonActor.length} window=${windowHours}h threshold=${threshold}`,
  repo,
  issue: Number(issue),
  actor,
  threshold,
  windowHours,
  counts: { actor: recentByActor.length, nonActor: recentNonActor.length, total: recent.length },
};

process.stdout.write(JSON.stringify(result, null, 2) + '\n');
process.exit(block ? 1 : 0);
