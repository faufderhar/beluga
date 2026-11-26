import { describe, expect, it } from 'vitest';
import { PRIORITY_INFO, STATUS_INFO, isOpen } from '../src/core/board/model.js';
import { LABEL_COLOR_INFO } from '../src/core/board/labels.js';
import { CAP_INFO, CAP_LEVEL_INFO, DECISION_INFO, EXPIRY_INFO } from '../src/core/gateway/access.js';
import { AUTONOMY_INFO, TESTS_AT_INFO } from '../src/core/plans/model.js';
import { TILE_INFO } from '../src/core/sentinel/dashboard-model.js';
import { ACCESS_INFO, KEEP_CHATS_INFO, RUN_STATE_INFO, STEP_INFO, TRIGGER_INFO } from '../src/core/sentinel/model.js';
import { GRANT_INFO, TRUST_INFO } from '../src/core/trust.js';
import { CAN_INFO } from '../src/shared/invites.js';
import { knownOr } from '../src/shared/known-or.js';
import { STATUS_INFO as GRAPH_STATUS_INFO } from '../src/shared/render/graph-model.js';

/**
 * Several Beluga versions in one cluster: a newer computer, team board or friend sends a value of a
 * kind this version doesn't know (a sentinel step, a status, a trust level), and `TABLE[value].label`
 * threw and took a screen down. Every table of what a value means answers for one it doesn't have.
 */

const NEWER = 'from_a_newer_beluga';

describe('knownOr', () => {
  const table = knownOr<'a' | 'b', { label: string; n: number }>({ a: { label: 'A', n: 1 }, b: { label: 'B', n: 2 } }, (v) => ({ label: v, n: 0 }));

  it('answers what it has as before, and a value it doesn’t have with its fallback, the same each time', () => {
    expect(table.a).toEqual({ label: 'A', n: 1 });
    expect((table as Record<string, { label: string }>)[NEWER]).toEqual({ label: NEWER, n: 0 });
    expect((table as Record<string, unknown>)[NEWER]).toBe((table as Record<string, unknown>)[NEWER]);
  });

  it('is iterated, compared and asked `in` as the plain table', () => {
    expect(Object.keys(table)).toEqual(['a', 'b']);
    expect(Object.entries(table).map(([k, v]) => `${k}${v.n}`)).toEqual(['a1', 'b2']);
    expect(table).toEqual({ a: { label: 'A', n: 1 }, b: { label: 'B', n: 2 } });
    expect(NEWER in table).toBe(false);
    expect(Object.hasOwn(table, 'a')).toBe(true);
    expect(JSON.stringify(table)).toBe('{"a":{"label":"A","n":1},"b":{"label":"B","n":2}}');
  });

  it('leaves what libraries probe objects for undefined', () => {
    const t = table as unknown as Record<string | symbol, unknown>;
    for (const k of ['asymmetricMatch', '@@__IMMUTABLE_ITERABLE__@@', '$$typeof', 'toJSON', 'nodeType', Symbol.iterator]) expect(t[k]).toBeUndefined();
    expect(typeof t.hasOwnProperty).toBe('function');
  });
});

describe('every table a value from another computer is looked up in', () => {
  const tables: Record<string, unknown> = { STATUS_INFO, PRIORITY_INFO, LABEL_COLOR_INFO, CAP_INFO, CAP_LEVEL_INFO, DECISION_INFO, EXPIRY_INFO, AUTONOMY_INFO, TESTS_AT_INFO, TILE_INFO, ACCESS_INFO, KEEP_CHATS_INFO, RUN_STATE_INFO, STEP_INFO, TRIGGER_INFO, GRANT_INFO, TRUST_INFO, CAN_INFO, GRAPH_STATUS_INFO };

  it.each(Object.keys(tables))('%s answers a newer value, named by it', (name) => {
    const entry = (tables[name] as Record<string, unknown>)[NEWER];
    expect(entry).toBeDefined();
    expect(typeof entry === 'string' ? entry : (entry as { label?: string; short?: string }).label ?? (entry as { short?: string }).short).toBe(NEWER);
  });

  it('what decides something takes the safest choice', () => {
    // A step it doesn't know needs the most access, so it's never run with less than it might need.
    expect((STEP_INFO as Record<string, { needs: string }>)[NEWER]!.needs).toBe('ship');
    // A task in a status it doesn't know is still open: shown, never dropped as done.
    expect(isOpen(NEWER as never)).toBe(true);
    // Sorted after every priority it knows.
    expect((PRIORITY_INFO as Record<string, { rank: number }>)[NEWER]!.rank).toBeGreaterThanOrEqual(Math.max(...Object.values(PRIORITY_INFO).map((p) => p.rank)));
  });
});
