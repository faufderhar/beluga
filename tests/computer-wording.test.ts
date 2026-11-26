import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComputerKind } from '../src/shared/assistant.js';
import type { Project, Workspace } from '../src/workspaces/types.js';

/**
 * Beluga runs on macOS, Windows and Linux (#526, BLG-961): a screen names the computer it runs on
 * ("this PC", "your computer", File Explorer), never "this Mac" on Windows. The words come from
 * src/shared/assistant.ts in the daemon and packages/mac/src/lib/os-words.ts in the app. A line
 * about a Mac only (its permissions, AppleScript, launchd) says so with the marker
 * `computer-wording: mac` on it or the line above; a whole Mac-only file is in FILES.
 */

const repo = path.resolve(__dirname, '..');

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** The module as the daemon on that kind of computer loads it. */
async function on<T>(kind: ComputerKind, load: () => Promise<T>): Promise<T> {
  vi.stubEnv('BELUGA_COMPUTER', kind);
  vi.resetModules();
  return load();
}

const ws: Workspace = { id: 'w1', projectRoot: '/r', projectId: 'p1', name: 'w', path: '/r/w', kind: 'worktree', createdAt: 0, branch: 'feat/x', base: 'main', external: false, status: { changed: 0, ahead: 2, behind: 0 } };
const project: Project = { id: 'p1', name: 'app', root: '/r', base: 'main', workspaces: [ws] };

describe('the merge tooltip names the computer it runs on (#526)', () => {
  it.each([
    ['mac', 'Shows what would merge into main on this Mac and checks it first'],
    ['windows', 'Shows what would merge into main on this PC and checks it first'],
    ['linux', 'Shows what would merge into main on this computer and checks it first'],
  ] as const)('on %s', async (kind, hint) => {
    const { branchState } = await on(kind, () => import('../src/core/branch-state.js'));
    const merge = branchState({ projects: [project], gh: false, prs: {}, conflicts: {} }, ws)?.steps.find((s) => s.id === 'merge');
    expect(merge?.hint).toBe(hint);
  });
});

describe('the daemon’s words for the computer', () => {
  it.each([
    ['mac', 'this Mac', 'your Mac', 'the Mac', 'Finder'],
    ['windows', 'this PC', 'your PC', 'the PC', 'File Explorer'],
    ['linux', 'this computer', 'your computer', 'the computer', 'Files'],
  ] as const)('on %s', async (kind, thisOne, yours, the, files) => {
    const words = await on(kind, () => import('../src/shared/assistant.js'));
    expect([words.THIS_COMPUTER, words.YOUR_COMPUTER, words.THE_COMPUTER, words.FILE_MANAGER]).toEqual([thisOne, yours, the, files]);
  });

  it('errors and Allow cards a Windows user reads say this PC', async () => {
    const { checkDrop } = await on('windows', () => import('../src/machines/uploads.js'));
    const verdict = await checkDrop('relative.txt');
    expect(verdict).toMatchObject({ verdict: 'refuse', reason: 'not a file on this PC' });
    const { approvalTitle } = await on('windows', () => import('../src/core/gateway/model.js'));
    expect(approvalTitle({ peerName: 'Mia', by: 'person', ask: '', kind: 'run', command: 'ls' } as never)).toBe('Mia wants to run on your PC: ls');
  });
});

/** Mac words a person reads ("Mac mini" and the Mac App Store name things; 'finder' is an action's id). */
const MAC_WORDS = /\b([Tt]his|[Yy]our|[Tt]he|a|own|my) Mac(?! mini| App Store)\b|\bMac app\b|\bBeluga for Mac\b|\bFinder\b|\bSystem Settings\b/;
const MARKER = 'computer-wording: mac';

/** Files only a Mac (or an agent, not a screen) reads. */
const FILES: readonly string[] = [
  // The words themselves.
  'src/shared/assistant.ts',
  'packages/mac/src/lib/os-words.ts',
  // macOS permissions: Notifications, Accessibility, Screen Recording, AppleScript (shown only on a Mac).
  'packages/mac/src/lib/sounds/access-model.ts',
  'packages/mac/src/onboarding/access-copy.ts',
  'packages/mac/src/onboarding/AccessSteps.tsx',
  'src/core/gateway/device.ts',
  'src/workspaces/trash.ts',
  'src/workspaces/regenerable.ts',
  // Prompts and tool descriptions for agents, not screens.
  'src/core/assistant/assistant.ts',
  'src/core/plans/prompt.ts',
  'src/core/chat/claude-prompt.ts',
  'src/core/sentinel/prompt.ts',
  'src/core/sentinel/tool-draft.ts',
  'src/core/gateway/result.ts',
  'src/core/gateway/demo.ts',
];

/** A line of code (not a comment) with a Mac's word in a string or JSX text. */
function offenders(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (name === 'node_modules' || name.startsWith('.')) continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith('.generated.ts')) check(p);
    }
  };
  const check = (file: string): void => {
    const rel = path.relative(repo, file).split(path.sep).join('/');
    if (FILES.includes(rel)) return;
    const lines = readFileSync(file, 'utf8').split('\n');
    let comment = false;
    lines.forEach((raw, i) => {
      const s = raw.trim();
      if (comment) {
        if (s.includes('*/')) comment = false;
        return;
      }
      if (s.startsWith('/*')) {
        if (!s.includes('*/')) comment = true;
        return;
      }
      if (s.startsWith('//') || s.startsWith('*')) return;
      if (raw.includes(MARKER) || lines[i - 1]?.includes(MARKER)) return;
      const code = raw.replace(/\s\/\/\s.*$/, '').replace(/\{\/\*.*?\*\/\}/g, '').replace(/\/\*\*?.*?\*\//g, '');
      if (MAC_WORDS.test(code)) out.push(`${rel}:${i + 1}: ${s.slice(0, 160)}`);
    });
  };
  walk(root);
  return out;
}

describe('screens don’t say "this Mac" on a PC', () => {
  it('the desktop app', () => {
    expect(offenders(path.join(repo, 'packages/mac/src'))).toEqual([]);
  });

  it('the shared models the screens import', () => {
    expect([...offenders(path.join(repo, 'src/ui')), ...offenders(path.join(repo, 'src/shared'))]).toEqual([]);
  });

  it('what the daemon tells the screens', () => {
    expect(['core', 'ipc', 'machines', 'net', 'daemon', 'workspaces', 'external', 'agent/runtime'].flatMap((d) => offenders(path.join(repo, 'src', d)))).toEqual([]);
  });
});
