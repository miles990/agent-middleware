/**
 * ACP Gateway — Session Pool + CLI Registry
 *
 * Manages warm CLI sessions (Claude Code, Kiro, Codex, Gemini) via ACP JSON-RPC over stdio.
 * Any worker with backend='acp' routes through here.
 *
 * Architecture:
 *   Gateway
 *   ├── CLI Registry (available backends + health)
 *   ├── Session Pool (per-backend warm sessions)
 *   └── Dispatch (acquire → send task → collect result → release)
 */

import { spawn, execSync as execSyncImported, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

// =============================================================================
// Types
// =============================================================================

export interface CLIBackend {
  /** Unique name (e.g. 'claude', 'kiro', 'codex', 'gemini') */
  name: string;
  /** CLI command to spawn */
  command: string;
  /** Args for ACP mode */
  args: string[];
  /** Extra env vars */
  env?: Record<string, string>;
  /** Max concurrent sessions */
  maxSessions: number;
  /** Working directory */
  cwd?: string;
  /** Health check: try to spawn and verify ACP handshake */
  healthy?: boolean;
}

export interface ACPSession {
  id: string;
  backend: string;
  process: ChildProcess;
  status: 'idle' | 'busy' | 'dead';
  createdAt: Date;
  lastActivityAt: Date;
  taskCount: number;
}

export interface GatewayStats {
  backends: Array<{
    name: string;
    command: string;
    healthy: boolean;
    sessions: { total: number; idle: number; busy: number; dead: number };
  }>;
  totalDispatched: number;
}

// =============================================================================
// ACP JSON-RPC Protocol
// =============================================================================

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// =============================================================================
// Session Pool
// =============================================================================

class SessionPool {
  private sessions = new Map<string, ACPSession>();
  private backend: CLIBackend;

  constructor(backend: CLIBackend) {
    this.backend = backend;
  }

  /** Get or create an idle session */
  async acquire(): Promise<ACPSession> {
    // Find idle session
    for (const session of this.sessions.values()) {
      if (session.status === 'idle') {
        session.status = 'busy';
        session.lastActivityAt = new Date();
        return session;
      }
    }

    // No idle session — spawn new if under limit
    const activeCount = [...this.sessions.values()].filter(s => s.status !== 'dead').length;
    if (activeCount >= this.backend.maxSessions) {
      throw new Error(`Session pool full for ${this.backend.name} (${activeCount}/${this.backend.maxSessions})`);
    }

    return this.spawn();
  }

  /** Release session back to pool */
  release(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && session.status === 'busy') {
      session.status = 'idle';
      session.lastActivityAt = new Date();
    }
  }

  /** Mark session as dead */
  markDead(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = 'dead';
      try { session.process.kill(); } catch { /* already dead */ }
    }
  }

  /** Spawn a new ACP session */
  private async spawn(): Promise<ACPSession> {
    const id = `acp-${this.backend.name}-${randomBytes(4).toString('hex')}`;

    const env = { ...process.env, ...this.backend.env };
    const child = spawn(this.backend.command, this.backend.args, {
      cwd: this.backend.cwd ?? process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const session: ACPSession = {
      id,
      backend: this.backend.name,
      process: child,
      status: 'busy',
      createdAt: new Date(),
      lastActivityAt: new Date(),
      taskCount: 0,
    };

    child.on('exit', () => {
      session.status = 'dead';
    });

    child.on('error', () => {
      session.status = 'dead';
    });

    this.sessions.set(id, session);
    return session;
  }

  /** Clean up dead/stale sessions */
  cleanup(maxIdleMs: number = 300_000): number {
    let cleaned = 0;
    for (const [id, session] of this.sessions) {
      if (session.status === 'dead') {
        this.sessions.delete(id);
        cleaned++;
      } else if (session.status === 'idle') {
        const idleMs = Date.now() - session.lastActivityAt.getTime();
        if (idleMs > maxIdleMs) {
          try { session.process.kill(); } catch { /* ok */ }
          this.sessions.delete(id);
          cleaned++;
        }
      }
    }
    return cleaned;
  }

  /** Get pool stats */
  stats(): { total: number; idle: number; busy: number; dead: number } {
    const sessions = [...this.sessions.values()];
    return {
      total: sessions.length,
      idle: sessions.filter(s => s.status === 'idle').length,
      busy: sessions.filter(s => s.status === 'busy').length,
      dead: sessions.filter(s => s.status === 'dead').length,
    };
  }

  /** Shut down all sessions */
  shutdown(): void {
    for (const session of this.sessions.values()) {
      try { session.process.kill(); } catch { /* ok */ }
    }
    this.sessions.clear();
  }
}

// =============================================================================
// ACP Gateway
// =============================================================================

/** Circuit breaker state per backend */
interface CircuitState {
  failures: number;
  lastFailure: Date | null;
  state: 'closed' | 'open' | 'half-open';
  openedAt: Date | null;
}

const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_RESET_MS = 60_000; // 1 min cooldown

export class ACPGateway extends EventEmitter {
  private registry = new Map<string, CLIBackend>();
  private pools = new Map<string, SessionPool>();
  private circuits = new Map<string, CircuitState>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private totalDispatched = 0;

  constructor() {
    super();
  }

  private getCircuit(name: string): CircuitState {
    if (!this.circuits.has(name)) {
      this.circuits.set(name, { failures: 0, lastFailure: null, state: 'closed', openedAt: null });
    }
    return this.circuits.get(name)!;
  }

  private recordSuccess(name: string): void {
    const c = this.getCircuit(name);
    c.failures = 0;
    c.state = 'closed';
  }

  private recordFailure(name: string): void {
    const c = this.getCircuit(name);
    c.failures++;
    c.lastFailure = new Date();
    if (c.failures >= CIRCUIT_FAILURE_THRESHOLD) {
      c.state = 'open';
      c.openedAt = new Date();
      this.emit('circuit.open', name);
    }
  }

  private isCircuitOpen(name: string): boolean {
    const c = this.getCircuit(name);
    if (c.state !== 'open') return false;
    // Check if cooldown expired → half-open (allow one attempt)
    if (c.openedAt && Date.now() - c.openedAt.getTime() > CIRCUIT_RESET_MS) {
      c.state = 'half-open';
      return false;
    }
    return true;
  }

  /** Register a CLI backend */
  register(backend: CLIBackend): void {
    backend.healthy = true;
    this.registry.set(backend.name, backend);
    this.pools.set(backend.name, new SessionPool(backend));
    this.emit('backend.registered', backend.name);
  }

  /** Unregister a CLI backend */
  unregister(name: string): void {
    const pool = this.pools.get(name);
    if (pool) pool.shutdown();
    this.pools.delete(name);
    this.registry.delete(name);
    this.emit('backend.unregistered', name);
  }

  /** List registered backends */
  listBackends(): CLIBackend[] {
    return [...this.registry.values()];
  }

  /** Start periodic cleanup + health check */
  start(cleanupIntervalMs: number = 60_000): void {
    this.cleanupTimer = setInterval(() => {
      for (const [name, pool] of this.pools) {
        const cleaned = pool.cleanup();
        if (cleaned > 0) this.emit('pool.cleanup', { backend: name, cleaned });
        // Health check: mark backend unhealthy if all sessions dead
        const stats = pool.stats();
        const backend = this.registry.get(name);
        if (backend) {
          backend.healthy = stats.dead < stats.total || stats.total === 0;
        }
      }
    }, cleanupIntervalMs);
  }

  /** Stop gateway */
  stop(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    for (const pool of this.pools.values()) {
      pool.shutdown();
    }
  }

  /**
   * Dispatch a task to a backend via ACP.
   * Acquires session → sends prompt via stdin → collects stdout → releases.
   */
  async dispatch(backendName: string, task: string, timeoutMs: number = 120_000): Promise<string> {
    // Circuit breaker check
    if (this.isCircuitOpen(backendName)) {
      throw new Error(`Circuit breaker OPEN for ${backendName} — ${CIRCUIT_FAILURE_THRESHOLD} consecutive failures. Retry after ${CIRCUIT_RESET_MS / 1000}s cooldown.`);
    }

    const pool = this.pools.get(backendName);
    if (!pool) throw new Error(`Unknown ACP backend: ${backendName}`);

    const backend = this.registry.get(backendName)!;
    let session: ACPSession;

    try {
      session = await pool.acquire();
    } catch (err) {
      this.recordFailure(backendName);
      throw new Error(`Failed to acquire ${backendName} session: ${err instanceof Error ? err.message : err}`);
    }

    this.totalDispatched++;
    session.taskCount++;
    this.emit('task.dispatched', { backend: backendName, sessionId: session.id });

    try {
      const result = await this.sendTask(session, task, timeoutMs);
      pool.release(session.id);
      this.recordSuccess(backendName);
      this.emit('task.completed', { backend: backendName, sessionId: session.id });
      return result;
    } catch (err) {
      pool.markDead(session.id);
      this.recordFailure(backendName);
      this.emit('task.failed', { backend: backendName, sessionId: session.id, error: err });
      throw err;
    }
  }

  /** Send task to session via stdin, collect result from stdout */
  private sendTask(session: ACPSession, task: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const { process: proc } = session;
      if (!proc.stdin || !proc.stdout) {
        reject(new Error('Session has no stdin/stdout'));
        return;
      }

      let output = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`ACP task timeout after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      const onData = (chunk: Buffer) => {
        output += chunk.toString('utf-8');

        // ACP JSON-RPC: look for complete response
        // Simple heuristic: if output contains a result message, we're done
        const lines = output.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as JsonRpcResponse;
            if (msg.jsonrpc === '2.0' && msg.id !== undefined) {
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                proc.stdout!.removeListener('data', onData);
                if (msg.error) {
                  reject(new Error(`ACP error: ${msg.error.message}`));
                } else {
                  resolve(typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result));
                }
              }
              return;
            }
          } catch { /* not JSON yet, accumulate more */ }
        }
      };

      proc.stdout.on('data', onData);

      proc.on('exit', (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          // If process exited, return whatever output we collected
          if (output.trim()) {
            resolve(output.trim());
          } else {
            reject(new Error(`ACP session exited with code ${code}`));
          }
        }
      });

      // Send task as JSON-RPC request
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'execute',
        params: { prompt: task },
      };

      try {
        proc.stdin.write(JSON.stringify(request) + '\n');
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`Failed to write to ACP session: ${err instanceof Error ? err.message : err}`));
        }
      }
    });
  }

  /** Get gateway stats including circuit breaker state */
  getStats(): GatewayStats {
    const backends = [...this.registry.entries()].map(([name, backend]) => {
      const circuit = this.getCircuit(name);
      return {
        name,
        command: backend.command,
        healthy: backend.healthy ?? false,
        sessions: this.pools.get(name)?.stats() ?? { total: 0, idle: 0, busy: 0, dead: 0 },
        circuit: { state: circuit.state, failures: circuit.failures },
      };
    });
    return { backends, totalDispatched: this.totalDispatched };
  }
}

// =============================================================================
// Default Backends
// =============================================================================

export const DEFAULT_BACKENDS: CLIBackend[] = [
  {
    name: 'claude',
    command: 'claude',
    args: ['-p', '--dangerously-skip-permissions', '--output-format', 'stream-json'],
    maxSessions: 3,
  },
  {
    name: 'kiro',
    command: 'kiro-cli',
    args: ['acp', '--trust-all-tools'],
    maxSessions: 2,
  },
  {
    name: 'codex',
    command: 'codex',
    args: ['exec', '--dangerously-bypass-approvals-and-sandbox', '--json'],
    maxSessions: 2,
  },
];

/** Create gateway with default backends (only registers those whose CLI exists) */
export function createGateway(): ACPGateway {
  const gateway = new ACPGateway();

  for (const backend of DEFAULT_BACKENDS) {
    // Check if CLI exists before registering
    try {
      execSyncImported(`which ${backend.command}`, { stdio: 'ignore' });
      gateway.register(backend);
    } catch {
      // CLI not installed — skip
    }
  }

  gateway.start();
  return gateway;
}
