/**
 * CI Trigger (T22) — DAG step triggers GitHub Actions workflow and waits for result.
 *
 * Per brain-only-kuro-v2 Phase F T22. Bridges agent DAG and CI/CD infra.
 * Uses local `gh` CLI for auth (keyring token, no API key needed).
 *
 * Input (JSON task string):
 *   {
 *     workflow: string,         // workflow ID or filename (e.g. "deploy.yml")
 *     ref?: string,             // branch/tag (default: main)
 *     inputs?: Record<string,string>,  // workflow_dispatch inputs
 *     repo?: string,            // owner/repo (default: auto-detect from cwd)
 *     poll_timeout_sec?: number,   // max wait (default 1200 = 20 min)
 *     poll_interval_sec?: number,  // poll frequency (default 10)
 *   }
 *
 * Output (JSON string):
 *   {
 *     ok: boolean,
 *     run_id?: number,
 *     status?: "queued"|"in_progress"|"completed",
 *     conclusion?: "success"|"failure"|"cancelled"|...,
 *     html_url?: string,
 *     elapsed_sec?: number,
 *     error?: string,
 *   }
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface CiTriggerInput {
  workflow: string;
  ref?: string;
  inputs?: Record<string, string>;
  repo?: string;
  poll_timeout_sec?: number;
  poll_interval_sec?: number;
}

export interface CiTriggerResult {
  ok: boolean;
  run_id?: number;
  status?: string;
  conclusion?: string;
  html_url?: string;
  elapsed_sec?: number;
  error?: string;
}

function parseInput(raw: string): CiTriggerInput | { error: string } {
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch (e) {
    return { error: `invalid JSON input: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!obj || typeof obj !== 'object') return { error: 'input must be JSON object' };
  const o = obj as Record<string, unknown>;
  if (typeof o.workflow !== 'string' || !o.workflow.trim()) {
    return { error: 'workflow required (string: ID or filename)' };
  }
  const input: CiTriggerInput = { workflow: o.workflow };
  if (typeof o.ref === 'string') input.ref = o.ref;
  if (typeof o.repo === 'string') input.repo = o.repo;
  if (o.inputs && typeof o.inputs === 'object') {
    input.inputs = o.inputs as Record<string, string>;
  }
  if (typeof o.poll_timeout_sec === 'number') input.poll_timeout_sec = o.poll_timeout_sec;
  if (typeof o.poll_interval_sec === 'number') input.poll_interval_sec = o.poll_interval_sec;
  return input;
}

async function runGh(args: string[], timeoutMs = 30_000): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync('gh', args, { timeout: timeoutMs, maxBuffer: 10_000_000 });
  return { stdout, stderr };
}

export async function triggerAndWait(rawInput: string): Promise<string> {
  const start = Date.now();
  const parsed = parseInput(rawInput);
  if ('error' in parsed) {
    return JSON.stringify({ ok: false, error: parsed.error } satisfies CiTriggerResult);
  }

  const { workflow, ref = 'main', inputs, repo, poll_timeout_sec = 1200, poll_interval_sec = 10 } = parsed;
  const repoArgs = repo ? ['--repo', repo] : [];

  // Step 1: trigger workflow_dispatch via gh CLI
  const triggerArgs = ['workflow', 'run', workflow, '--ref', ref, ...repoArgs];
  for (const [k, v] of Object.entries(inputs ?? {})) {
    triggerArgs.push('-f', `${k}=${v}`);
  }
  try {
    await runGh(triggerArgs);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return JSON.stringify({
      ok: false,
      error: `gh workflow run failed: ${msg.slice(0, 300)}`,
      elapsed_sec: Math.round((Date.now() - start) / 1000),
    } satisfies CiTriggerResult);
  }

  // Step 2: find the newly triggered run — GitHub doesn't return run_id from dispatch.
  // Give it 3s to appear, then query latest run for this workflow + ref.
  await new Promise(r => setTimeout(r, 3_000));
  let runId: number | null = null;
  let runUrl: string | null = null;
  for (let i = 0; i < 5 && runId == null; i++) {
    try {
      const { stdout } = await runGh([
        'run', 'list',
        '--workflow', workflow,
        '--branch', ref,
        '--limit', '1',
        '--json', 'databaseId,status,url,createdAt',
        ...repoArgs,
      ]);
      const runs = JSON.parse(stdout) as Array<{ databaseId: number; status: string; url: string; createdAt: string }>;
      if (runs.length > 0) {
        const createdTs = new Date(runs[0].createdAt).getTime();
        // Only trust it if created within last 60s — avoid picking stale runs
        if (Date.now() - createdTs < 60_000) {
          runId = runs[0].databaseId;
          runUrl = runs[0].url;
        }
      }
    } catch { /* retry */ }
    if (runId == null) await new Promise(r => setTimeout(r, 3_000));
  }

  if (runId == null) {
    return JSON.stringify({
      ok: false,
      error: 'could not find triggered run_id after 5 attempts',
      elapsed_sec: Math.round((Date.now() - start) / 1000),
    } satisfies CiTriggerResult);
  }

  // Step 3: poll run status until completed or timeout
  const pollDeadline = Date.now() + poll_timeout_sec * 1000;
  let status: string = 'queued';
  let conclusion: string | undefined;

  while (Date.now() < pollDeadline) {
    try {
      const { stdout } = await runGh([
        'run', 'view', String(runId),
        '--json', 'status,conclusion',
        ...repoArgs,
      ]);
      const info = JSON.parse(stdout) as { status: string; conclusion: string | null };
      status = info.status;
      conclusion = info.conclusion ?? undefined;
      if (status === 'completed') break;
    } catch { /* ignore transient poll failures */ }
    await new Promise(r => setTimeout(r, poll_interval_sec * 1000));
  }

  const elapsed_sec = Math.round((Date.now() - start) / 1000);
  const result: CiTriggerResult = {
    ok: status === 'completed' && conclusion === 'success',
    run_id: runId,
    status,
    conclusion,
    html_url: runUrl ?? undefined,
    elapsed_sec,
  };
  if (!result.ok && status !== 'completed') {
    result.error = `poll timeout after ${elapsed_sec}s (last status=${status})`;
  }
  return JSON.stringify(result);
}
