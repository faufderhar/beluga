import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ASK_ONLY_REASON, decideTool, denyReason, planFileOf } from '../src/agent/policy.js';
import { NO_PLAN_TEXT, claudePlansDir, planText } from '../src/agent/runtime/claude/plan-text.js';

/** #607: a plan proposed from a main folder. Claude Code writes it to its plan folder, and the card shows that plan. */

let root: string;
let plans: string;
let repo: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'plan-file-'));
  plans = path.join(root, 'claude', 'plans');
  repo = path.join(root, 'repo');
  mkdirSync(plans, { recursive: true });
  mkdirSync(repo);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const mainFolder = () => ({ cwd: repo, roots: [repo], autoEdit: false, askOnly: true, scope: 'full' as const, plans });

describe('the plan file in a main folder (ask-only)', () => {
  it("lets Claude Code write and edit its plan in its plan folder", () => {
    const file = path.join(plans, 'brave-otter.md');
    expect(decideTool('Write', { file_path: file, content: '# Plan' }, mainFolder())).toBe('allow');
    expect(decideTool('Edit', { file_path: file, old_string: 'a', new_string: 'b' }, mainFolder())).toBe('allow');
    expect(planFileOf('Write', { file_path: file }, mainFolder())).toBe(file);
  });

  it('still keeps the main folder read-only', () => {
    expect(decideTool('Write', { file_path: path.join(repo, 'PLAN.md') }, mainFolder())).toBe('deny');
    expect(denyReason('Write', { file_path: path.join(repo, 'PLAN.md') }, mainFolder())).toBe(ASK_ONLY_REASON);
  });

  it('allows only Markdown right where the plan folder really is', () => {
    expect(decideTool('Write', { file_path: path.join(plans, 'run.sh') }, mainFolder())).toBe('deny');
    expect(decideTool('Write', { file_path: path.join(plans, '..', 'settings.json') }, mainFolder())).toBe('deny');
    expect(decideTool('Write', { file_path: path.join(plans, '..', 'CLAUDE.md') }, mainFolder())).toBe('deny');
    // A link in the plan folder to another file is that file.
    const elsewhere = path.join(root, 'notes.md');
    writeFileSync(elsewhere, 'x');
    symlinkSync(elsewhere, path.join(plans, 'link.md'));
    expect(decideTool('Write', { file_path: path.join(plans, 'link.md') }, mainFolder())).toBe('deny');
  });

  it("isn't for someone else's run: it could rewrite a plan of yours", () => {
    const file = path.join(plans, 'brave-otter.md');
    expect(decideTool('Write', { file_path: file }, { ...mainFolder(), scope: 'folder' as const })).toBe('deny');
    expect(decideTool('Write', { file_path: file }, { ...mainFolder(), askOnly: false, scope: 'folder' as const })).toBe('deny');
  });

  it('without a plan folder, nothing changes', () => {
    const { plans: _, ...noPlans } = mainFolder();
    expect(decideTool('Write', { file_path: path.join(plans, 'a.md') }, noPlans)).toBe('deny');
  });

  it("doesn't need anyone's yes in a worktree either", () => {
    const worktree = { cwd: repo, roots: [repo], autoEdit: true, scope: 'full' as const, plans };
    expect(decideTool('Write', { file_path: path.join(plans, 'a.md') }, worktree)).toBe('allow');
    expect(decideTool('Write', { file_path: path.join(root, 'elsewhere.md') }, worktree)).toBe('ask');
  });
});

describe('the plan the card shows', () => {
  it("is ExitPlanMode's plan when it brings one", () => {
    expect(planText({ plan: '# Do it\n\n1. Step' }, plans)).toBe('# Do it\n\n1. Step');
  });

  it('is read from the plan file when no plan text arrives', () => {
    const file = path.join(plans, 'brave-otter.md');
    writeFileSync(file, '# The real plan\n\n1. First\n2. Second\n');
    expect(planText({}, plans, file)).toBe('# The real plan\n\n1. First\n2. Second');
    expect(planText({ plan: '  ' }, plans, file)).toBe('# The real plan\n\n1. First\n2. Second');
  });

  it('never reads a file the tool input names, or one outside the plan folder', () => {
    const other = path.join(plans, 'someone-elses.md');
    writeFileSync(other, 'another plan');
    expect(planText({ planFilePath: other }, plans)).toBeUndefined();
    const notes = path.join(repo, 'notes.md');
    writeFileSync(notes, 'not a plan');
    expect(planText({}, plans, notes)).toBeUndefined();
  });

  it('is nothing when there is no plan anywhere, and the card says so instead of showing a chat line', () => {
    expect(planText({}, plans, path.join(plans, 'never-written.md'))).toBeUndefined();
    expect(NO_PLAN_TEXT).toMatch(/plan didn't come through/);
  });

  it("follows Claude Code's config folder", () => {
    expect(claudePlansDir({ CLAUDE_CONFIG_DIR: '/cfg' })).toBe(path.join('/cfg', 'plans'));
    expect(claudePlansDir({})).toMatch(/\.claude[\\/]plans$/);
  });
});
