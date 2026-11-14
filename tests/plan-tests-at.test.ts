import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Plans } from '../src/core/plans/plans.js';
import { checkTestsNote, taskTestsNote } from '../src/core/plans/prompt.js';
import { Store, initialState } from '../src/core/store.js';

/** When a plan runs its test suites: proof sized to the task, the full suites once per milestone or at the end. */

const me = { kind: 'beluga' } as const;

describe('when to run tests', () => {
  it('starts each milestone by default, can be set at creation, changes with a note, and is saved', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'klaud-plans-'));
    const plans = new Plans({ store: new Store(initialState('room')), dir, saveDelayMs: 0 });
    expect(plans.create({ projectId: 'p', home: 'ws:a' }, me).testsAt).toBe('milestone');
    const plan = plans.create({ projectId: 'p', home: 'ws:b', testsAt: 'end' }, me);
    expect(plan.testsAt).toBe('end');
    const back = plans.setTestsAt(plan.id, 'milestone', me);
    expect(back.testsAt).toBe('milestone');
    expect(back.activity.at(-1)?.text).toMatch(/once per milestone/);
    expect(plans.setTestsAt(plan.id, 'milestone', me)).toBe(back);
    plans.setTestsAt(plan.id, 'end', me);
    // Written now, not after a guessed 30 ms (macOS CI's runner was slower than that).
    plans.flush();
    const again = new Plans({ store: new Store(initialState('room')), dir });
    expect(again.get(plan.id)?.testsAt).toBe('end');
  });

  it('tells a task to run typecheck and only the tests it touched', () => {
    const note = taskTestsNote({ testsAt: 'milestone' });
    expect(note).toMatch(/write the tests this task needs/);
    expect(note).toMatch(/only typecheck and the unit-test files you added or changed/);
    expect(note).toMatch(/once per milestone, at its check/);
    expect(note).toMatch(/re-run once, alone/);
    expect(taskTestsNote({ testsAt: 'end' })).toMatch(/once, in its final step/);
  });

  it("runs the suites once at each milestone's check, on the combined work", () => {
    const note = checkTestsNote({ testsAt: 'milestone' }, false);
    expect(note).toMatch(/full unit suite and the e2e once for this milestone, on its combined work/);
    expect(note).toMatch(/npm run e2e/);
  });

  it("'only at the end' skips them at milestone checks and runs everything in the final step", () => {
    expect(checkTestsNote({ testsAt: 'end' }, false)).toMatch(/don't run them for this check/);
    expect(checkTestsNote({ testsAt: 'end' }, true)).toMatch(/final step: run every test now/);
  });
});
