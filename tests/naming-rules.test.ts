import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInstructions } from '../src/agent/run-instructions.js';
import type { AgentRunInput } from '../src/agent/types.js';
import { setProjectNaming } from '../src/core/naming-rules.js';
import { prefsFrom } from '../src/core/store.js';
import { PrefsPatch } from '../src/ipc/api.js';
import { type NamingRules, namingFor, patchRules } from '../src/shared/naming.js';
import { Settings } from '../src/shared/settings-schema.js';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { buildPrPrompt } from '../src/workspaces/pr.js';
import { resolveScripts } from '../src/workspaces/scripts.js';
import { WorkspaceStore } from '../src/workspaces/store.js';

/** Branch and pull request naming rules, globally and per project (BLG-1033). */

const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'beluga-naming-'));
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

describe('namingFor', () => {
  const project = (naming?: NamingRules) => ({ name: 'app', ...(naming ? { scripts: { naming } } : {}) });

  it('takes yours for the project, then beluga.json, then Settings, then the built-in', () => {
    const prefs = { branchPrefix: 'kayra/', prTitleRule: 'Imperative, under 70 characters', projectNaming: { app: { branchPrefix: 'me/' } } };
    expect(namingFor(prefs, project({ branchPrefix: 'feat/', prTitle: '[APP] summary' }))).toEqual({ branchPrefix: { value: 'me/', source: 'yours' }, prTitle: { value: '[APP] summary', source: 'team' } });
    expect(namingFor({ ...prefs, projectNaming: {} }, project({ branchPrefix: 'feat/' })).branchPrefix).toEqual({ value: 'feat/', source: 'team' });
    expect(namingFor(prefs, { name: 'other' })).toEqual({ branchPrefix: { value: 'kayra/', source: 'settings' }, prTitle: { value: 'Imperative, under 70 characters', source: 'settings' } });
    expect(namingFor({})).toEqual({ branchPrefix: { value: 'beluga/', source: 'default' } });
  });

  it('keeps an empty prefix as "no prefix", but an empty title rule is no rule', () => {
    expect(namingFor({ branchPrefix: 'kayra/', projectNaming: { app: { branchPrefix: '' } } }, project()).branchPrefix.value).toBe('');
    expect(namingFor({ prTitleRule: '   ' }, project()).prTitle).toBeUndefined();
  });
});

describe('patchRules', () => {
  it('sets, clears and keeps each rule; none left is undefined', () => {
    expect(patchRules({ branchPrefix: 'a/' }, { prTitle: 'x' })).toEqual({ branchPrefix: 'a/', prTitle: 'x' });
    expect(patchRules({ branchPrefix: 'a/', prTitle: 'x' }, { prTitle: null })).toEqual({ branchPrefix: 'a/' });
    expect(patchRules({ branchPrefix: 'a/' }, { branchPrefix: null })).toBeUndefined();
    expect(patchRules(undefined, { prTitle: '  ' })).toBeUndefined();
  });
});

describe('settings', () => {
  it('reads saved rules, drops a bad project rule, and checks a patch', () => {
    const saved = Settings.parse({ prTitleRule: 'feat: summary', projectNaming: { app: { branchPrefix: 'feat/' }, bad: { branchPrefix: '../x' } } });
    expect(prefsFrom(saved)).toMatchObject({ prTitleRule: 'feat: summary', projectNaming: { app: { branchPrefix: 'feat/' }, bad: {} } });
    expect(PrefsPatch.safeParse({ prTitleRule: null }).success).toBe(true);
    expect(PrefsPatch.safeParse({ prTitleRule: 'x'.repeat(301) }).success).toBe(false);
    expect(PrefsPatch.safeParse({ projectNaming: { app: { branchPrefix: 'a b' } } }).success).toBe(false);
  });
});

describe('beluga.json naming', () => {
  it('is read with the scripts, and a bad one never costs the scripts', () => {
    const root = tmp();
    writeFileSync(path.join(root, 'beluga.json'), JSON.stringify({ scripts: { setup: 'npm ci' }, naming: { branchPrefix: 'feat/', prTitle: 'type(scope): summary' } }));
    expect(resolveScripts(root)).toMatchObject({ setup: { command: 'npm ci' }, naming: { branchPrefix: 'feat/', prTitle: 'type(scope): summary' } });
    writeFileSync(path.join(root, 'beluga.json'), JSON.stringify({ scripts: { setup: 'npm ci' }, naming: { branchPrefix: '//' } }));
    const bad = resolveScripts(root);
    expect(bad.setup?.command).toBe('npm ci');
    expect(bad.naming).toBeUndefined();
  });

  it('saving for the team writes the file and drops your own rules for the project', () => {
    const root = tmp();
    writeFileSync(path.join(root, 'beluga.json'), JSON.stringify({ scripts: { run: 'npm run dev' } }));
    let yours: Record<string, NamingRules> = { app: { prTitle: 'mine' }, other: { branchPrefix: 'o/' } };
    const deps = () => ({ project: { name: 'app', root }, yours, setYours: (all: Readonly<Record<string, NamingRules>>) => void (yours = { ...all }) });
    expect(setProjectNaming(deps(), { branchPrefix: 'feat/' }, true)).toBe('beluga.json');
    expect(JSON.parse(readFileSync(path.join(root, 'beluga.json'), 'utf8'))).toEqual({ scripts: { run: 'npm run dev' }, naming: { branchPrefix: 'feat/', prTitle: 'mine' } });
    expect(yours).toEqual({ other: { branchPrefix: 'o/' } });
    expect(setProjectNaming(deps(), { prTitle: 'just me' })).toBe('yours');
    expect(yours.app).toEqual({ prTitle: 'just me' });
    setProjectNaming(deps(), { prTitle: null });
    expect(yours.app).toBeUndefined();
  });
});

describe('pull request title rule', () => {
  it('goes in the PR prompt, after the project guidelines', () => {
    const prompt = buildPrPrompt({ branch: 'b', base: 'origin/main', project: 'app', projectPrompt: 'Link the issue.', titleRule: 'feat(scope): summary' }, 'T');
    expect(prompt).toBe('T\n\nProject guidelines for pull requests (from the project\'s beluga.json):\nLink the issue.\n\nPull request title rule (follow it; it wins over any other title advice): feat(scope): summary');
    expect(buildPrPrompt({ branch: 'b', base: 'origin/main', project: 'app' }, 'T')).toBe('T');
  });

  it("is in a worktree run's instructions, so a PR opened from chat follows it", () => {
    const input = (place: object) => ({ prompt: 'hi', requesterName: 'kay', viaAgent: false, context: [], scope: 'full', env: { KLAUD_WORKTREE: '/wt' }, place: { cwd: '/wt', additionalDirectories: [], autoEdit: true, onSession: () => undefined, ...place } }) as unknown as AgentRunInput;
    expect(runInstructions(input({ prTitleRule: '[APP] summary' }), 'kay')).toContain('Pull request title rule (follow it; it wins over any other title advice): [APP] summary');
    expect(runInstructions(input({}), 'kay')).not.toContain('Pull request title rule');
  });
});

describe('a project of its own prefix', () => {
  it('names new worktree branches in that project only', async () => {
    const base = tmp();
    const code = path.join(base, 'code');
    for (const name of ['app', 'site']) {
      const root = path.join(code, name);
      mkdirSync(root, { recursive: true });
      sh(root, 'init', '-q', '-b', 'main');
      sh(root, 'config', 'user.email', 't@t');
      sh(root, 'config', 'user.name', 'Tess');
      writeFileSync(path.join(root, 'a.txt'), 'a\n');
      sh(root, 'add', '.');
      sh(root, 'commit', '-qm', 'init');
    }
    writeFileSync(path.join(code, 'app', 'beluga.json'), JSON.stringify({ naming: { branchPrefix: 'feat/' } }));
    const store = new WorkspaceStore(path.join(base, 'home'));
    store.saveConfig({ roots: [code], projects: [], hidden: [] });
    const mgr = new WorkspaceManager(store);
    await mgr.refresh();
    mgr.branchPrefix = (root) => namingFor({ branchPrefix: 'kayra/' }, mgr.list.find((p) => p.root === root)).branchPrefix.value;
    const app = mgr.list.find((p) => p.name === 'app')!;
    const site = mgr.list.find((p) => p.name === 'site')!;
    expect((await mgr.createWorktree(app.id, 'Fix login')).branch).toBe('feat/fix-login');
    expect((await mgr.createWorktree(site.id, 'Fix login')).branch).toBe('kayra/fix-login');
  });
});
