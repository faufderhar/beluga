import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canHold, decide, LEVELS, OPERATION_CLASSES, type Denial, type Level, type OperationClass, type Outcome } from '../src/external/domain/decide.js';
import { EXTERNAL_TOOLS, TOOL_ACCESS, type ToolAccess } from '../src/external/domain/tools.js';

/** The table from the plan, written out again by hand: a change to one copy fails here. */
const EXPECTED: Readonly<Record<OperationClass, readonly [blocked: Outcome, ask: Outcome, trusted: Outcome, full: Outcome]>> = {
  read: ['deny', 'ask', 'allow', 'allow'],
  stop_own: ['deny', 'allow', 'allow', 'allow'],
  launch_or_send: ['deny', 'ask', 'allow', 'allow'],
  file_inside: ['deny', 'ask', 'allow', 'allow'],
  file_outside_or_shell: ['deny', 'ask', 'ask', 'allow'],
  writes_code: ['deny', 'ask-once', 'ask-once', 'allow'],
  state_write: ['deny', 'ask', 'ask', 'allow'],
  reach_people: ['deny', 'ask', 'ask', 'allow'],
  destructive: ['deny', 'ask-once', 'ask-once', 'ask-once'],
  gated: ['deny', 'ask-once', 'ask-once', 'ask-once'],
  secret_file: ['deny', 'deny', 'deny', 'deny'],
  human_only: ['deny', 'deny', 'deny', 'deny'],
};

const LEVEL_COLUMN: Readonly<Record<Level, 0 | 1 | 2 | 3>> = { blocked: 0, ask: 1, trusted: 2, full: 3 };

const cases = OPERATION_CLASSES.flatMap((operation) => LEVELS.map((level) => ({ operation, level, want: EXPECTED[operation][LEVEL_COLUMN[level]] })));

describe('decide', () => {
  it.each(cases)('$operation at $level is $want, on any route', ({ operation, level, want }) => {
    expect(decide({ operation, level, inScope: true }).outcome).toBe(want);
  });

  it('at full, delete and merge still ask once, and secret files and human-only work stay refused', () => {
    expect(decide({ operation: 'destructive', level: 'full', inScope: true })).toEqual({ outcome: 'ask-once' });
    expect(decide({ operation: 'secret_file', level: 'full', inScope: true })).toEqual({ outcome: 'deny', denial: 'capability_denied' });
    expect(decide({ operation: 'human_only', level: 'full', inScope: true })).toEqual({ outcome: 'deny', denial: 'needs_person' });
  });

  const denied = (operation: OperationClass, level: Level, inScope = true): Denial | undefined => {
    const d = decide({ operation, level, inScope });
    return d.outcome === 'deny' ? d.denial : undefined;
  };

  it('types each denial', () => {
    expect(denied('read', 'blocked')).toBe('level_denied');
    expect(denied('secret_file', 'full')).toBe('capability_denied');
    expect(denied('human_only', 'full')).toBe('needs_person');
    expect(denied('read', 'full', false)).toBe('project_denied');
  });

  it('refuses work outside the grant at each level, even for what full allows', () => {
    for (const operation of OPERATION_CLASSES) {
      for (const level of LEVELS) expect(decide({ operation, level, inScope: false }).outcome).toBe('deny');
    }
  });

  it('tells a blocked agent nothing about the scope', () => {
    expect(denied('read', 'blocked', false)).toBe('level_denied');
  });
});

describe('canHold', () => {
  it('a remote grant holds full only by an explicit choice', () => {
    expect(LEVELS.filter((level) => canHold('remote', level))).toEqual(['blocked', 'ask', 'trusted']);
    expect(LEVELS.filter((level) => canHold('remote', level, false))).toEqual(['blocked', 'ask', 'trusted']);
    expect(LEVELS.filter((level) => canHold('remote', level, true))).toEqual(LEVELS);
    expect(LEVELS.filter((level) => canHold('local', level))).toEqual(LEVELS);
  });
});

describe('tool classes', () => {
  it('gives each tool a class that decide knows', () => {
    for (const tool of EXTERNAL_TOOLS) expect(OPERATION_CLASSES).toContain(TOOL_ACCESS[tool]);
  });

  it('fails typecheck for a tool without a class, or a class no tool may have', () => {
    // These lines hold only under `npm run typecheck`: an unused @ts-expect-error is an error there.
    // @ts-expect-error b has no class
    const missing: ToolAccess<'a' | 'b'> = { a: 'read' };
    // @ts-expect-error human-only work is never exposed as a tool
    const humanOnly: ToolAccess<'a'> = { a: 'human_only' };
    // @ts-expect-error a tool that reads secrets does not exist
    const secret: ToolAccess<'a'> = { a: 'secret_file' };
    // @ts-expect-error not a class
    const unknownClass: ToolAccess<'a'> = { a: 'admin' };
    expect([missing, humanOnly, secret, unknownClass]).toHaveLength(4);
  });
});

describe('the domain', () => {
  it('does no I/O', () => {
    const dir = path.resolve('src/external/domain');
    for (const file of readdirSync(dir)) {
      expect(readFileSync(path.join(dir, file), 'utf8'), file).not.toMatch(/from\s+['"](node:|fs|path|os|child_process|net|http)/);
    }
  });
});

describe('docs/security.md', () => {
  it('shows the decision table as the code decides it', () => {
    const doc = readFileSync(new URL('../docs/security.md', import.meta.url), 'utf8');
    const table = /<!-- external-decision-table -->\n([\s\S]*?)<!-- \/external-decision-table -->/.exec(doc)![1]!;
    const rows = table.trim().split('\n').slice(2).map((line) => line.split('|').slice(2, 6).map((c) => c.trim()));
    const want = OPERATION_CLASSES.map((operation) => (['blocked', 'ask', 'trusted', 'full'] as const).map((level) => decide({ operation, level, inScope: true }).outcome));
    expect(rows).toEqual(want);
  });
});
