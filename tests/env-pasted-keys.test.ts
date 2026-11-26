import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { EnvVars } from '../src/core/env-vars.js';
import { Store, initialState } from '../src/core/store.js';
import { buildChatVarsAppend } from '../src/agent/prompt.js';
import type { Project } from '../src/workspaces/types.js';

// Keys pasted into a chat, kept as its own variables (BLG-965).
// Fake keys, put together when the test runs: a whole one in the source would stop GitHub's push protection.
const fake = (prefix: string, body: string): string => `${prefix}${body}`;
const OPENAI = fake('sk-proj-', 'Q7vR2mT9kLp4XwZ8nB3cD6fG1hJ5sA0eY4uI7oP2qW9rT6yU3iO8pA1sD5fG7hJ2kL4zX6c');
const BILLING = fake('bk_live_', '9Fq2Lm7RzX4cV1nB8tY3wK6pJ0dH5sGa');
const BILLING_NEW = fake('bk_live_', '3Hw8Kd1PzQ6vN9mC2xR7tY4bL0fJ5gSe');

describe('keys pasted into a chat', () => {
  let dir: string;
  let root: string;
  let wt: string;
  let env: EnvVars;
  let store: Store;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-pasted-')));
    root = path.join(dir, 'app');
    wt = path.join(dir, 'wt');
    mkdirSync(root);
    mkdirSync(wt);
    const project: Project = {
      id: 'p1',
      name: 'app',
      root,
      base: 'origin/main',
      workspaces: [
        { id: 'm', projectId: 'p1', path: root, name: 'main', kind: 'main', projectRoot: root } as never,
        { id: 'w1', projectId: 'p1', path: wt, name: 'feature', kind: 'worktree', projectRoot: root, external: false } as never,
      ],
    };
    store = new Store(initialState('t'));
    store.dispatch({ type: 'projects', projects: [project] });
    env = new EnvVars({ store, file: path.join(dir, 'env.json') });
  });

  it('are named the way the project names its keys', () => {
    writeFileSync(path.join(root, '.env'), `BILLING_KEY=${BILLING}\n`);
    writeFileSync(path.join(wt, '.env.example'), 'OPENAI_KEY=sk-proj-…\n');
    const found = env.pastedKeys({ workspaceId: 'w1' }, `here: ${OPENAI} and ${BILLING_NEW}`);
    expect(found.map((k) => [k.name, k.why, k.replaces ?? false])).toEqual([
      ['OPENAI_KEY', 'format', false],
      ['BILLING_KEY', 'like-yours', true],
    ]);
    // One you have already: its name, nothing replaced.
    expect(env.pastedKeys({ workspaceId: 'w1' }, BILLING)).toMatchObject([{ name: 'BILLING_KEY', why: 'yours' }]);
    // Plain text costs nothing.
    expect(env.pastedKeys({ workspaceId: 'w1' }, 'just a sentence')).toEqual([]);
  });

  it('are kept as the chat’s own variables: its runs get them, and the worktree’s .env.example lists the name', () => {
    writeFileSync(path.join(wt, '.env.example'), 'PORT=3000\n');
    env.setWorktree('w1', [{ key: 'OTHER', value: 'kept' }]);
    expect(env.keepPasted({ workspaceId: 'w1' }, [{ key: 'OPENAI_API_KEY', value: OPENAI }])).toEqual({ example: '.env.example' });
    expect(env.envFor({ workspaceId: 'w1' }, { claude: true })).toMatchObject({ OPENAI_API_KEY: OPENAI, OTHER: 'kept' });
    expect(store.getState().envKeys.worktrees?.w1).toEqual(['OTHER', 'OPENAI_API_KEY']);
    const example = readFileSync(path.join(wt, '.env.example'), 'utf8');
    expect(example).toBe('PORT=3000\nOPENAI_API_KEY=sk-proj-…\n');
    expect(example).not.toContain(OPENAI.slice(12));
    // Masked out of anything this computer sends.
    expect(env.secretValues()).toContain(OPENAI);
    // Merging or archiving carries them to the project.
    expect(env.carryWorktree('w1')).toBe(2);
    expect(env.get('p1').vars.map((v) => v.key)).toEqual(['OTHER', 'OPENAI_API_KEY']);
  });

  it('no template, no file made; the main folder is never touched', () => {
    env.keepPasted({ workspaceId: 'm' }, [{ key: 'OPENAI_API_KEY', value: OPENAI }]);
    expect(env.keepPasted({ workspaceId: 'w1' }, [{ key: 'OPENAI_API_KEY', value: OPENAI }])).toEqual({});
    expect(() => readFileSync(path.join(wt, '.env.example'))).toThrow();
    expect(() => readFileSync(path.join(root, '.env.example'))).toThrow();
    expect(env.envFor({ workspaceId: 'm' }, { claude: true }).OPENAI_API_KEY).toBe(OPENAI);
  });

  it('a new chat with no workspace yet: the project’s; with no project, yours everywhere', () => {
    env.keepPasted({ projectId: 'p1' }, [{ key: 'OPENAI_API_KEY', value: OPENAI }]);
    expect(env.get('p1').vars).toEqual([{ key: 'OPENAI_API_KEY', value: OPENAI }]);
    env.keepPasted({}, [{ key: 'OPENAI_API_KEY', value: OPENAI }]);
    expect(env.get().vars).toEqual([{ key: 'OPENAI_API_KEY', value: OPENAI }]);
    expect(() => env.keepPasted({ projectId: 'gone' }, [{ key: 'A', value: 'b' }])).toThrow('That project is gone');
  });

  it('a new chat in Chats (no folder, so no project): yours everywhere', () => {
    const chats: Project = { id: 'chats', name: 'Chats', root: '', base: '', workspaces: [] };
    store.dispatch({ type: 'projects', projects: [chats, ...store.getState().projects] });
    env.keepPasted({ projectId: 'chats' }, [{ key: 'AW_API_KEY', value: OPENAI }]);
    expect(env.get().vars).toEqual([{ key: 'AW_API_KEY', value: OPENAI }]);
    expect(env.envFor({ projectId: 'p1' }, { claude: true }).AW_API_KEY).toBe(OPENAI);
  });

  it('a worktree being made gets them before it exists, and loses them if it isn’t made', () => {
    env.presetWorktree('wt-0123456789ab', [{ key: 'OPENAI_API_KEY', value: OPENAI }]);
    expect(store.getState().envKeys.worktrees?.['wt-0123456789ab']).toEqual(['OPENAI_API_KEY']);
    env.forgetWorktree('wt-0123456789ab');
    expect(store.getState().envKeys.worktrees?.['wt-0123456789ab']).toBeUndefined();
    expect(() => env.presetWorktree('wt-0123456789ab', [{ key: '1BAD', value: 'x' }])).toThrow();
    // An id that's a workspace already isn't one being made: nothing added to it.
    expect(env.presetWorktree('w1', [{ key: 'OPENAI_API_KEY', value: OPENAI }])).toBe(false);
    expect(env.worktree('w1').vars).toEqual([]);
  });

  it('Claude is told their names, never their values', () => {
    const brief = buildChatVarsAppend(['OPENAI_API_KEY']);
    expect(brief).toContain('$OPENAI_API_KEY');
    expect(brief).toContain('Never print');
    expect(buildChatVarsAppend([])).toBe('');
  });

  // BLG-977: a key with no format we know.
  const RATEL = fake('rtl_', 'k6RdVk9lLghguXqcpxATMBfV00FPbQPV');
  const RATEL_KEPT = fake('rtl_', 'Q3wE8rT1yU6iO9pA2sD5fG7hJ4kL0zXc');

  const withRatel = (): void => {
    const ratelRoot = path.join(dir, 'ratel');
    mkdirSync(ratelRoot);
    const ratel: Project = { id: 'p2', name: 'Ratel', root: ratelRoot, base: 'origin/main', workspaces: [{ id: 'r', projectId: 'p2', path: ratelRoot, name: 'main', kind: 'main', projectRoot: ratelRoot } as never] };
    store.dispatch({ type: 'projects', projects: [...store.getState().projects, ratel] });
    env.set('p2', [{ key: 'RATEL_API_KEY', value: RATEL_KEPT }]);
  };

  it('alone, a key nobody lists is maybe one, named after its prefix', () => {
    expect(env.pastedKeys({ workspaceId: 'w1' }, RATEL)).toMatchObject([{ value: RATEL, name: 'RTL_API_KEY', why: 'maybe' }]);
  });

  it('shaped like a key another project keeps: that key’s name, and where it is', () => {
    withRatel();
    expect(env.pastedKeys({ workspaceId: 'w1' }, `use ${RATEL}`)).toMatchObject([{ value: RATEL, name: 'RATEL_API_KEY', why: 'like-yours', fromPlace: 'Ratel' }]);
    // In Ratel itself it's simply like yours.
    expect(env.pastedKeys({ projectId: 'p2' }, RATEL)[0]).not.toHaveProperty('fromPlace');
  });

  it('Not a Key: that prefix is never asked about again, until Undo', () => {
    env.notAKey('rtl_', true);
    expect(env.pastedKeys({ workspaceId: 'w1' }, RATEL)).toEqual([]);
    expect(JSON.parse(readFileSync(path.join(dir, 'env.json'), 'utf8')).notKeys).toEqual(['rtl_']);
    env.notAKey('rtl_', false);
    expect(env.pastedKeys({ workspaceId: 'w1' }, RATEL)).toHaveLength(1);
    expect(() => env.notAKey('no spaces please', true)).toThrow();
  });

  it('Not a Key never hides a key like one you keep', () => {
    withRatel();
    env.notAKey('rtl_', true);
    expect(env.pastedKeys({ workspaceId: 'w1' }, RATEL)).toMatchObject([{ name: 'RATEL_API_KEY', why: 'like-yours' }]);
  });
});
