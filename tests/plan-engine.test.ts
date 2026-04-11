/**
 * Plan Engine — core DAG execution tests.
 * Run: npx tsx --test tests/plan-engine.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PlanEngine, type ActionPlan, type WorkerExecutor } from '../src/plan-engine.js';

// Mock worker: returns task string as result after a delay
function createMockExecutor(delay = 10): WorkerExecutor {
  return async (_worker: string, task: string | unknown[]) => {
    await new Promise(r => setTimeout(r, delay));
    const taskStr = typeof task === 'string' ? task : JSON.stringify(task);
    return `result: ${taskStr}`;
  };
}

describe('PlanEngine', () => {

  describe('validation', () => {
    it('rejects unknown workers', () => {
      const engine = new PlanEngine(createMockExecutor());
      const plan: ActionPlan = {
        goal: 'test', steps: [
          { id: 's1', worker: 'unknown-worker', task: 'do something', dependsOn: [] },
        ],
      };
      const errors = engine.validate(plan, new Set(['shell', 'analyst']));
      assert.ok(errors.length > 0);
    });

    it('detects dependency cycles', () => {
      const engine = new PlanEngine(createMockExecutor());
      const plan: ActionPlan = {
        goal: 'test', steps: [
          { id: 'a', worker: 'shell', task: 't', dependsOn: ['b'] },
          { id: 'b', worker: 'shell', task: 't', dependsOn: ['a'] },
        ],
      };
      const errors = engine.validate(plan, new Set(['shell']));
      assert.ok(errors.some(e => e.toLowerCase().includes('cycle')));
    });

    it('detects missing dependency references', () => {
      const engine = new PlanEngine(createMockExecutor());
      const plan: ActionPlan = {
        goal: 'test', steps: [
          { id: 's1', worker: 'shell', task: 't', dependsOn: ['nonexistent'] },
        ],
      };
      const errors = engine.validate(plan, new Set(['shell']));
      assert.ok(errors.length > 0);
    });

    it('passes valid plans', () => {
      const engine = new PlanEngine(createMockExecutor());
      const plan: ActionPlan = {
        goal: 'test', steps: [
          { id: 's1', worker: 'shell', task: 't', dependsOn: [] },
          { id: 's2', worker: 'analyst', task: 't', dependsOn: ['s1'] },
        ],
      };
      const errors = engine.validate(plan, new Set(['shell', 'analyst']));
      assert.equal(errors.length, 0);
    });
  });

  describe('execution', () => {
    it('executes single step', async () => {
      const engine = new PlanEngine(createMockExecutor());
      const plan: ActionPlan = {
        goal: 'test', steps: [
          { id: 's1', worker: 'shell', task: 'hello', dependsOn: [] },
        ],
      };
      const result = await engine.execute(plan);
      assert.equal(result.steps.length, 1);
      assert.equal(result.steps[0].status, 'completed');
      assert.ok(result.steps[0].output.includes('hello'));
    });

    it('executes parallel steps (wave 1)', async () => {
      const dispatched: string[] = [];
      const engine = new PlanEngine(createMockExecutor(30), {
        onEvent: (e) => { if (e.type === 'step.dispatched') dispatched.push(e.step.id); },
      });
      const plan: ActionPlan = {
        goal: 'test', steps: [
          { id: 'a', worker: 'shell', task: 'task-a', dependsOn: [] },
          { id: 'b', worker: 'shell', task: 'task-b', dependsOn: [] },
          { id: 'c', worker: 'shell', task: 'task-c', dependsOn: [] },
        ],
      };
      const result = await engine.execute(plan);
      assert.equal(result.steps.length, 3);
      assert.ok(result.steps.every(s => s.status === 'completed'));
      assert.equal(dispatched.length, 3);
    });

    it('respects dependencies (wave 2 waits for wave 1)', async () => {
      const order: string[] = [];
      const executor: WorkerExecutor = async (_w, task) => {
        const t = typeof task === 'string' ? task : '';
        order.push(t);
        await new Promise(r => setTimeout(r, 20));
        return `done: ${t}`;
      };
      const engine = new PlanEngine(executor);
      const plan: ActionPlan = {
        goal: 'test', steps: [
          { id: 's1', worker: 'shell', task: 'wave1', dependsOn: [] },
          { id: 's2', worker: 'shell', task: 'wave2', dependsOn: ['s1'] },
        ],
      };
      const result = await engine.execute(plan);
      assert.equal(result.steps.length, 2);
      assert.ok(result.steps.every(s => s.status === 'completed'));
      assert.equal(order[0], 'wave1');
      assert.equal(order[1], 'wave2');
    });

    it('resolves {{stepId.result}} templates', async () => {
      let capturedTask = '';
      const executor: WorkerExecutor = async (_w, task) => {
        const t = typeof task === 'string' ? task : '';
        capturedTask = t;
        return 'DATA-FROM-S1';
      };
      const engine = new PlanEngine(executor);
      const plan: ActionPlan = {
        goal: 'test', steps: [
          { id: 's1', worker: 'shell', task: 'fetch data', dependsOn: [] },
          { id: 's2', worker: 'analyst', task: 'Analyze: {{s1.result}}', dependsOn: ['s1'] },
        ],
      };
      await engine.execute(plan);
      assert.ok(capturedTask.includes('DATA-FROM-S1'));
    });

    it('skips dependent steps when dependency fails', async () => {
      const executor: WorkerExecutor = async (worker: string) => {
        if (worker === 'shell') throw new Error('intentional failure');
        return 'ok';
      };
      const engine = new PlanEngine(executor);
      const plan: ActionPlan = {
        goal: 'test', steps: [
          { id: 's1', worker: 'shell', task: 'will fail', dependsOn: [], timeoutSeconds: 5 },
          { id: 's2', worker: 'analyst', task: 'depends on s1', dependsOn: ['s1'], timeoutSeconds: 5 },
        ],
      };
      const result = await engine.execute(plan);
      const s1 = result.steps.find(s => s.id === 's1')!;
      const s2 = result.steps.find(s => s.id === 's2')!;
      assert.equal(s1.status, 'failed');
      assert.equal(s2.status, 'skipped');
    });

    it('emits plan.completed event', async () => {
      let planCompleted = false;
      const engine = new PlanEngine(createMockExecutor(10), {
        onEvent: (e) => { if (e.type === 'plan.completed') planCompleted = true; },
      });
      const plan: ActionPlan = {
        goal: 'test', steps: [
          { id: 's1', worker: 'shell', task: 't', dependsOn: [] },
        ],
      };
      await engine.execute(plan);
      assert.ok(planCompleted);
    });
  });
});
