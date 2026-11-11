import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLAUDE_CAPABILITIES } from '../src/agent/runtime/claude/index.js';
import { CODEX_CAPABILITIES } from '../src/agent/runtime/codex/index.js';
import { OPENCODE_CAPABILITIES } from '../src/agent/runtime/opencode/index.js';
import { GROK_CAPABILITIES } from '../src/agent/runtime/grok/index.js';
import { COPILOT_CAPABILITIES } from '../src/agent/runtime/copilot/index.js';
import type { RuntimeCapabilities } from '../src/agent/runtime/types.js';
import { COMMANDS } from '../src/core/commands.js';
import { METHODS } from '../src/ipc/api.js';
import { RUNTIME_FALLBACKS, RUNTIME_MISSING } from '../src/shared/runtime-fallbacks.js';

/**
 * Every way into klaud is listed in docs/parity.md with where each client shows it, so a feature
 * can't land in one client and be forgotten in the other.
 */
const doc = readFileSync('docs/parity.md', 'utf8');
const listed = (id: string): boolean => doc.includes(`\`${id}\``);

const uiActions = (): string[] => {
  const src = readFileSync('src/ui/workspace-models.ts', 'utf8');
  const block = src.slice(src.indexOf('export type UiAction ='), src.indexOf('export interface Model'));
  return [...new Set([...block.matchAll(/type: '([a-z_]+)'/g)].map((m) => m[1]!))];
};

const menuKinds = (): string[] =>
  [...new Set(['menus.ts', 'work-menus.ts', 'invite-menus.ts'].flatMap((f) => [...readFileSync(`src/ui/${f}`, 'utf8').matchAll(/kind: '([a-z_]+)'/g)].map((m) => m[1]!)))];

describe('docs/parity.md', () => {
  it('lists every slash command', () => {
    expect(COMMANDS.map((c) => `/${c.name}`).filter((c) => !listed(c))).toEqual([]);
  });

  it('lists every UI action', () => {
    expect(uiActions().filter((a) => !listed(a))).toEqual([]);
  });

  it('lists every menu', () => {
    expect(menuKinds().filter((k) => !listed(k))).toEqual([]);
  });

  it('lists every API method', () => {
    expect(METHODS.filter((m) => !listed(m))).toEqual([]);
  });
});

/** The "Agent runs, per runtime" table: its header and rows as cells. */
const runtimeTable = (): { header: string[]; rows: string[][]; text: string } => {
  const start = doc.indexOf('## Agent runs, per runtime');
  const text = doc.slice(start, doc.indexOf('\n## ', start + 1));
  const lines = text.split('\n').filter((l) => l.startsWith('|'));
  const cells = (l: string): string[] => l.slice(1, l.endsWith('|') ? -1 : undefined).split(' | ').map((c) => c.trim());
  return { header: cells(lines[0]!), rows: lines.slice(2).map(cells), text };
};

/** Where screens and the core say a fallback: every `fallbackFor(…, 'id')` outside the table itself. */
const shownFallbacks = (): Set<string> => {
  // No shell: Windows' cmd.exe would hand git the quotes, and it would match nothing.
  const files = execFileSync('git', ['ls-files', 'src/*.ts', 'packages/mac/src/*.ts', 'packages/mac/src/*.tsx', 'packages/companion/app/*.tsx'], { encoding: 'utf8' }).split('\n').filter((f) => f && f !== 'src/shared/runtime-fallbacks.ts');
  return new Set(files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/fallbackFor\([^;]*?'([a-z_]+)'\)/g)].map((m) => m[1]!)));
};

describe('docs/parity.md, per runtime', () => {
  const { header, rows, text } = runtimeTable();
  /** Each runtime beside Claude: its column and what it can do. */
  const RUNTIMES: ReadonlyArray<{ readonly id: string; readonly column: number; readonly caps: RuntimeCapabilities }> = [
    { id: 'codex', column: 3, caps: CODEX_CAPABILITIES },
    { id: 'opencode', column: 4, caps: OPENCODE_CAPABILITIES },
    { id: 'copilot', column: 5, caps: COPILOT_CAPABILITIES },
    { id: 'grok', column: 6, caps: GROK_CAPABILITIES },
  ];

  it('has a column for Claude, Codex, OpenCode, Copilot and Grok Build', () => {
    expect(header).toEqual(['What', 'Ways in', 'Claude', 'Codex', 'OpenCode', 'Copilot', 'Grok Build']);
    expect(rows.length).toBeGreaterThan(10);
  });

  it('leaves no cell blank: each is pass, a fallback or n/a', () => {
    const bad = rows.flatMap((r) => [2, 3, 4, 5, 6].filter((i) => r.length !== 7 || !/^(pass|fallback|n\/a)\b/.test(r[i] ?? '')).map((i) => `${r[0]} › ${header[i]}: "${r[i] ?? ''}"`));
    expect(bad).toEqual([]);
  });

  for (const rt of RUNTIMES) {
    const fallbacks = Object.keys(RUNTIME_FALLBACKS[rt.id] ?? {});

    it(`names a fallback for every ${rt.id} row that is one, and only the ones the code has`, () => {
      const named = rows.filter((r) => r[rt.column]!.startsWith('fallback')).map((r) => /`fallback:([a-z_]+)`/.exec(r[rt.column]!)?.[1] ?? `(none in "${r[0]}")`);
      expect(named.filter((id) => !fallbacks.includes(id))).toEqual([]);
      expect(fallbacks.filter((id) => !named.includes(id))).toEqual([]);
    });

    it(`names every feature ${rt.id} lacks, and only those`, () => {
      const named = rows.flatMap((r) => [...r[rt.column]!.matchAll(/`missing:([a-z_]+)`/g)].map((m) => m[1]!));
      expect([...named].sort()).toEqual([...(RUNTIME_MISSING[rt.id] ?? [])].sort());
    });

    it(`shows every ${rt.id} fallback somewhere (greyed with its reason, or the reason beside the control)`, () => {
      const shown = shownFallbacks();
      expect(fallbacks.filter((id) => !shown.has(id))).toEqual([]);
    });

    it(`accounts for every capability ${rt.id} lacks, and every fallback stands for one it does lack`, () => {
      const caps = rt.caps as unknown as Record<string, unknown>;
      const lacking = Object.keys(caps).filter((k) => caps[k] === false && k !== 'hasSandbox');
      expect(lacking.filter((k) => !text.includes(`\`${k}\``))).toEqual([]);
      const claimed = Object.values(RUNTIME_FALLBACKS[rt.id] ?? {}).flatMap((f) => (f?.capability ? [f.capability] : []));
      expect(claimed.filter((k) => caps[k] === (CLAUDE_CAPABILITIES as unknown as Record<string, unknown>)[k])).toEqual([]);
    });
  }

  it('says how every conformance scenario does on each runtime, live runs included (BLG-462)', () => {
    const start = doc.indexOf('## Runtime conformance');
    const lines = doc.slice(start, doc.indexOf('\n## ', start + 1)).split('\n').filter((l) => l.startsWith('|')).slice(2);
    expect(lines.length).toBeGreaterThan(8);
    const bad = lines.flatMap((l) => l.slice(1, -1).split(' | ').slice(1).map((c) => c.trim()).filter((c) => !/^(pass|waived|fallback|n\/a)\b/.test(c)).map((c) => `${l.split(' | ')[0]}: "${c}"`));
    expect(bad).toEqual([]);
  });

  it('covers the ways in that reach an agent run', () => {
    const agentRuns = ['/model', '/handoff', '/stop', '/plan', '/compact', '/fork', '/usage', 'host.stopRun', 'host.steerNow', 'host.answerApproval', 'questions.answer', 'session.compact', 'workspaces.fork', 'workspaces.editPrompt', 'workbench.setAgent', 'claudeCode.skills', 'claudeCode.mcpServers', 'agent.steps', 'gateway.decide'];
    expect(agentRuns.filter((id) => !text.includes(`\`${id}\``))).toEqual([]);
  });
});
