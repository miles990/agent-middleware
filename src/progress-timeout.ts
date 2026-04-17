/**
 * Progress-based timeout utilities.
 *
 * Two-tier timeout model (per Alex 2026-04-17 "worker 正常運作就不 timeout"):
 *   - progressMs: max time with no observable activity (stall detector)
 *   - hardMs: absolute wall-clock upper bound (escape hatch)
 *
 * A worker is "alive" if it produces ANY observable signal (stdout/stderr
 * write, SDK message, ACP message, etc.) within progressMs. AI brain estimates
 * only hardMs (generous safety margin); progressMs is worker-level config.
 */

import { spawn, type ChildProcess } from 'node:child_process';

export interface ProgressTimeoutOptions {
  progressMs: number;
  hardMs: number;
  /** Called when progress cap hit (N ms since last activity). */
  onStalled?: (idleMs: number) => void;
  /** Called when hard cap hit. */
  onHardTimeout?: () => void;
}

/**
 * Wrap an async operation with dual timeout tracking.
 * Caller gets an AbortSignal (cancel target) + markActive() (call on activity).
 *
 *   const result = await withProgressTimeout(async (signal, markActive) => {
 *     child.stdout.on('data', markActive);
 *     child.stderr.on('data', markActive);
 *     signal.addEventListener('abort', () => child.kill());
 *     return await waitForChild(child);
 *   }, { progressMs: 60_000, hardMs: 600_000 });
 */
export async function withProgressTimeout<T>(
  run: (signal: AbortSignal, markActive: () => void) => Promise<T>,
  opts: ProgressTimeoutOptions,
): Promise<T> {
  const ac = new AbortController();
  let lastActivity = Date.now();
  const markActive = () => { lastActivity = Date.now(); };

  const checkIntervalMs = Math.max(1_000, Math.min(5_000, Math.floor(opts.progressMs / 4)));
  const progressCheck = setInterval(() => {
    const idle = Date.now() - lastActivity;
    if (idle > opts.progressMs) {
      opts.onStalled?.(idle);
      ac.abort(new Error(`stalled: no activity for ${idle}ms (progress cap ${opts.progressMs}ms)`));
    }
  }, checkIntervalMs);

  const hardTimer = setTimeout(() => {
    opts.onHardTimeout?.();
    ac.abort(new Error(`wall-clock timeout after ${opts.hardMs}ms`));
  }, opts.hardMs);

  try {
    return await run(ac.signal, markActive);
  } finally {
    clearInterval(progressCheck);
    clearTimeout(hardTimer);
  }
}

/**
 * Execute a shell command with progress-based timeout.
 * Replaces execSync which blocks event loop and has only wall-clock timeout.
 *
 * Returns stdout string. Throws Error on non-zero exit OR timeout.
 */
export async function execShellWithProgress(
  command: string,
  opts: {
    cwd: string;
    env?: Record<string, string>;
    stdin?: string;
    progressMs: number;
    hardMs: number;
    maxBuffer?: number;
  },
): Promise<string> {
  const maxBuffer = opts.maxBuffer ?? 4 * 1024 * 1024;

  return withProgressTimeout(
    (signal, markActive) => new Promise<string>((resolve, reject) => {
      const child: ChildProcess = spawn('/bin/bash', ['-c', command], {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutSize = 0;
      let stderrSize = 0;
      let settled = false;

      const done = (err: Error | null, stdout = '') => {
        if (settled) return;
        settled = true;
        try { child.kill(); } catch { /* noop */ }
        if (err) reject(err);
        else resolve(stdout);
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        markActive();
        if (stdoutSize + chunk.length <= maxBuffer) {
          stdoutChunks.push(chunk);
          stdoutSize += chunk.length;
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        markActive();
        if (stderrSize + chunk.length <= maxBuffer) {
          stderrChunks.push(chunk);
          stderrSize += chunk.length;
        }
      });

      child.on('error', (err) => done(err));

      child.on('close', (code, sig) => {
        const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');
        if (code === 0) {
          done(null, stdout);
        } else {
          const msg = `Command exited ${code ?? sig ?? 'unknown'}: ${stderr.slice(0, 500) || stdout.slice(0, 200)}`;
          const e = Object.assign(new Error(msg), { status: code, signal: sig, stdout, stderr });
          done(e);
        }
      });

      // Abort wiring — kill on timeout
      signal.addEventListener('abort', () => {
        if (settled) return;
        const reason = signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'aborted'));
        try { child.kill('SIGTERM'); } catch { /* noop */ }
        // SIGKILL if still alive after 3s
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, 3_000).unref();
        done(reason);
      });

      // Optional stdin
      if (opts.stdin !== undefined && child.stdin) {
        child.stdin.write(opts.stdin);
        child.stdin.end();
      }
    }),
    {
      progressMs: opts.progressMs,
      hardMs: opts.hardMs,
    },
  );
}
