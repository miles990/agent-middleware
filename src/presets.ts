/**
 * Worker Presets — templates for quick worker creation.
 *
 * Built-in presets provide sensible defaults. Users/agents can create custom presets.
 * Presets are persisted to presets.json.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface WorkerPreset {
  /** Preset name (e.g. 'research', 'code', 'review') */
  name: string;
  /** Human description of when to use this preset */
  description: string;
  /** Default tools */
  tools: string[];
  /** Default model */
  model: string;
  /** Default vendor */
  vendor: string;
  /** Default backend */
  backend: string;
  /** Default timeout in seconds */
  timeout: number;
  /** Default max turns */
  maxTurns: number;
  /** Whether this is a built-in preset (cannot delete) */
  builtin?: boolean;
}

// =============================================================================
// Built-in Presets
// =============================================================================

const BUILTIN_PRESETS: WorkerPreset[] = [
  {
    name: 'research',
    description: 'Web research, reading docs, gathering information',
    tools: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Bash'],
    model: 'sonnet', vendor: 'anthropic', backend: 'sdk',
    timeout: 1800, maxTurns: 10, builtin: true,
  },
  {
    name: 'code',
    description: 'Writing, editing, refactoring code',
    tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
    model: 'sonnet', vendor: 'anthropic', backend: 'sdk',
    timeout: 1800, maxTurns: 15, builtin: true,
  },
  {
    name: 'review',
    description: 'Code review, document review, fact checking',
    tools: ['Read', 'Grep', 'Glob'],
    model: 'haiku', vendor: 'anthropic', backend: 'sdk',
    timeout: 1800, maxTurns: 5, builtin: true,
  },
  {
    name: 'shell',
    description: 'Direct shell command execution (zero LLM)',
    tools: ['Bash', 'Read'],
    model: 'haiku', vendor: 'anthropic', backend: 'shell',
    timeout: 1800, maxTurns: 3, builtin: true,
  },
  {
    name: 'creative',
    description: 'Writing, brainstorming, content creation',
    tools: ['Read', 'Write', 'WebFetch'],
    model: 'sonnet', vendor: 'anthropic', backend: 'sdk',
    timeout: 1800, maxTurns: 10, builtin: true,
  },
  {
    name: 'analysis',
    description: 'Data analysis, comparison, structured reports',
    tools: ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch'],
    model: 'sonnet', vendor: 'anthropic', backend: 'sdk',
    timeout: 1800, maxTurns: 8, builtin: true,
  },
  {
    name: 'translation',
    description: 'Translate text between languages',
    tools: ['Read', 'Write'],
    model: 'haiku', vendor: 'anthropic', backend: 'sdk',
    timeout: 1800, maxTurns: 3, builtin: true,
  },
  {
    name: 'fast',
    description: 'Quick, cheap tasks — classification, extraction, formatting',
    tools: ['Read'],
    model: 'haiku', vendor: 'anthropic', backend: 'sdk',
    timeout: 1800, maxTurns: 3, builtin: true,
  },
  {
    name: 'deep',
    description: 'Complex reasoning — architecture design, strategic analysis',
    tools: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Bash', 'Agent'],
    model: 'opus', vendor: 'anthropic', backend: 'sdk',
    timeout: 1800, maxTurns: 20, builtin: true,
  },
  {
    name: 'cloud-agent',
    description: 'Anthropic Managed Agent — cloud sandbox with web search + code execution. No local tools.',
    tools: [],
    model: 'claude-sonnet-4-6', vendor: 'anthropic-managed', backend: 'sdk',
    timeout: 1800, maxTurns: 10, builtin: true,
  },
  {
    name: 'webhook',
    description: 'HTTP API call — GET/POST any endpoint, extract result from response',
    tools: [],
    model: '', vendor: '', backend: 'webhook',
    timeout: 1800, maxTurns: 1, builtin: true,
  },
  {
    name: 'logic',
    description: 'Pure JS function — deterministic transform, zero LLM cost',
    tools: [],
    model: '', vendor: '', backend: 'logic',
    timeout: 1800, maxTurns: 1, builtin: true,
  },
];

// =============================================================================
// Preset Manager
// =============================================================================

export class PresetManager {
  private presets = new Map<string, WorkerPreset>();
  private persistPath: string;

  constructor(cwd: string) {
    this.persistPath = path.join(cwd, 'presets.json');

    // Load built-in presets
    for (const p of BUILTIN_PRESETS) {
      this.presets.set(p.name, p);
    }

    // Load custom presets from disk
    try {
      const raw = fs.readFileSync(this.persistPath, 'utf-8');
      const custom = JSON.parse(raw) as WorkerPreset[];
      for (const p of custom) {
        this.presets.set(p.name, { ...p, builtin: false });
      }
    } catch { /* no saved presets — normal on first run */ }
  }

  /** Get a preset by name */
  get(name: string): WorkerPreset | undefined {
    return this.presets.get(name);
  }

  /** List all presets */
  list(): WorkerPreset[] {
    return [...this.presets.values()];
  }

  /** Create or update a custom preset */
  set(preset: Omit<WorkerPreset, 'builtin'>): void {
    const existing = this.presets.get(preset.name);
    if (existing?.builtin) {
      throw new Error(`Cannot overwrite built-in preset: ${preset.name}`);
    }
    this.presets.set(preset.name, { ...preset, builtin: false });
    this.persist();
  }

  /** Delete a custom preset */
  delete(name: string): boolean {
    const existing = this.presets.get(name);
    if (!existing) return false;
    if (existing.builtin) throw new Error(`Cannot delete built-in preset: ${name}`);
    this.presets.delete(name);
    this.persist();
    return true;
  }

  /** Apply preset defaults to partial worker config (explicit values override) */
  apply(presetName: string, overrides: Partial<WorkerPreset>): WorkerPreset {
    const preset = this.presets.get(presetName);
    if (!preset) throw new Error(`Unknown preset: ${presetName}`);
    return {
      ...preset,
      ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)),
      builtin: false,
    } as WorkerPreset;
  }

  private persist(): void {
    try {
      const custom = [...this.presets.values()].filter(p => !p.builtin);
      fs.writeFileSync(this.persistPath, JSON.stringify(custom, null, 2), 'utf-8');
    } catch { /* fail-open */ }
  }
}
