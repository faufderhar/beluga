import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { EnvVars } from '../src/core/env-vars.js';
import { Store, initialState } from '../src/core/store.js';
import { placeholderFor, syncExample } from '../src/shared/env-example.js';
import { applyEnvChanges } from '../src/workspaces/env.js';
import type { Project } from '../src/workspaces/types.js';

describe('.env.example placeholders (BLG-925)', () => {
  it('keeps what says what goes there, never the secret itself', () => {
    expect(placeholderFor('STRIPE_SECRET_KEY', 'sk_live_51Habc123XYZdefGHI456')).toBe('sk_live_…');
    expect(placeholderFor('STRIPE_WEBHOOK_SECRET', 'whsec_9f8e7d6c5b4a3f2e1d0c')).toBe('whsec_…');
    expect(placeholderFor('POSTHOG_KEY', 'phc_AbCdEf1234567890GhIjKl')).toBe('phc_…');
    expect(placeholderFor('GITHUB_TOKEN', 'ghp_1234567890abcdefABCDEF1234567890')).toBe('ghp_…');
    expect(placeholderFor('ANTHROPIC_API_KEY', 'sk-ant-api03-AbC123dEf456GhI789')).toBe('sk-ant-…');
    expect(placeholderFor('SLACK_BOT_TOKEN', 'xoxb-1234-5678-abcdefABCDEF')).toBe('xoxb-…');
    // An unknown service's token keeps its short prefix when the rest is random.
    expect(placeholderFor('RATEL_KEY', 'rtk_live_Q2w3E4r5T6y7U8i9O0p1')).toBe('rtk_live_…');
    expect(placeholderFor('SUPABASE_ANON_KEY', `eyJ${'a'.repeat(60)}`)).toBe('eyJ…');
  });

  it('keeps plain values, and only the scheme and host of a URL', () => {
    expect(placeholderFor('PORT', '3000')).toBe('3000');
    expect(placeholderFor('NODE_ENV', 'development')).toBe('development');
    expect(placeholderFor('DEBUG', 'true')).toBe('true');
    expect(placeholderFor('API_URL', 'http://localhost:4000/v1')).toBe('http://localhost:4000/v1');
    expect(placeholderFor('DATABASE_URL', 'postgres://admin:hunter2@db.internal.example.com:5432/app')).toBe('postgres://USER:PASSWORD@db.internal.example.com:5432/…');
    expect(placeholderFor('DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/app')).toBe('postgres://USER:PASSWORD@localhost:5432/app');
    expect(placeholderFor('SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co')).toBe('https://your-project.supabase.co');
    expect(placeholderFor('SLACK_WEBHOOK', 'https://hooks.slack.com/services/T000/B000/XXXX')).toBe('https://hooks.slack.com/…');
    expect(placeholderFor('FROM_EMAIL', 'kayra@example.org')).toBe('you@example.com');
  });

  it('never keeps a plain-looking value under a secret name, nor a password prefix', () => {
    expect(placeholderFor('ADMIN_PIN', '1234')).toBe('your-admin-pin');
    expect(placeholderFor('DB_PASSWORD', 'true')).toBe('your-db-password');
    expect(placeholderFor('DB_PASSWORD', 'mydog_Rex1987abcdefghij')).toBe('your-db-password');
    expect(placeholderFor('SITE_NAME', 'Beluga Labs')).toBe('your-site-name');
    expect(placeholderFor('EMPTY', '')).toBe('');
  });

  it('adds new names after the last line and takes out removed ones, keeping comments and hand-written examples', () => {
    const text = '# Stripe\nSTRIPE_KEY=sk_test_your_key_here\nOLD=1\n';
    const out = syncExample(text, [{ key: 'STRIPE_KEY', value: 'sk_live_realrealreal12345' }, { key: 'PORT', value: '3000' }], ['OLD', 'NOT_THERE']);
    expect(out.text).toBe('# Stripe\nSTRIPE_KEY=sk_test_your_key_here\nPORT=3000\n');
    expect(out.added).toEqual(['PORT']);
    expect(out.removed).toEqual(['OLD']);
    expect(syncExample(out.text, [{ key: 'PORT', value: '1' }])).toEqual({ text: out.text, added: [], removed: [] });
  });
});

describe('applyEnvChanges with removed keys', () => {
  it('takes removed keys out of the main file only when asked', () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-envback-')));
    const wt = path.join(dir, 'wt');
    const main = path.join(dir, 'main');
    mkdirSync(wt);
    mkdirSync(main);
    writeFileSync(path.join(wt, '.env'), 'A=2\n');
    const change = { file: '.env', added: [], changed: ['A'], removed: ['B'], binary: false };
    writeFileSync(path.join(main, '.env'), '# keep\nA=1\nB=old\n');
    applyEnvChanges(wt, main, [change]);
    expect(readFileSync(path.join(main, '.env'), 'utf8')).toBe('# keep\nA=2\nB=old\n');
    applyEnvChanges(wt, main, [change], { removed: true });
    expect(readFileSync(path.join(main, '.env'), 'utf8')).toBe('# keep\nA=2\n');
  });
});

describe('worktree variables (BLG-924)', () => {
  let dir: string;
  let root: string;
  let wt: string;
  let env: EnvVars;
  let store: Store;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-envwt-')));
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

  it('win over the project, its .env and yours, in the worktree only', () => {
    writeFileSync(path.join(root, '.env'), 'API=dotenv\nDB=dotenv\n');
    env.set(undefined, [{ key: 'API', value: 'yours' }]);
    env.set('p1', [{ key: 'DB', value: 'project' }]);
    env.setWorktree('w1', [{ key: 'DB', value: 'worktree' }]);
    expect(env.envFor({ workspaceId: 'w1' })).toEqual({ API: 'dotenv', DB: 'worktree' });
    expect(env.envFor({ dir: path.join(wt, 'src') })).toEqual({ API: 'dotenv', DB: 'worktree' });
    expect(env.envFor({ dir: root })).toEqual({ API: 'dotenv', DB: 'project' });
    expect(env.viewEnv(wt).vars.DB).toBe('worktree');
    expect(store.getState().envKeys.worktrees).toEqual({ w1: ['DB'] });
    // The editor sees what it gets from below, each name from the layer that wins.
    const scope = env.worktree('w1');
    expect(scope.vars).toEqual([{ key: 'DB', value: 'worktree' }]);
    expect(scope.inherited).toEqual([
      { key: 'API', value: 'dotenv', from: '.env' },
      { key: 'DB', value: 'project', from: 'app' },
    ]);
  });

  it('carry to the project before the worktree goes, and are dropped when it is deleted', () => {
    env.set('p1', [{ key: 'A', value: 'project' }]);
    env.setWorktree('w1', [{ key: 'A', value: 'worktree' }, { key: 'B', value: 'new' }]);
    expect(env.carryWorktree('w1')).toBe(2);
    expect(env.get('p1').vars).toEqual([{ key: 'A', value: 'worktree' }, { key: 'B', value: 'new' }]);
    expect(env.worktree('w1').vars).toEqual([]);
    env.setWorktree('w1', [{ key: 'C', value: '1' }]);
    env.forgetWorktree('w1');
    expect(store.getState().envKeys.worktrees).toEqual({});
    expect(() => env.setWorktree('nope', [])).toThrow('That worktree is gone');
  });

  it('a worktree’s added and removed .env keys reach its own .env.example, not the main folder’s', () => {
    writeFileSync(path.join(wt, '.env'), 'A=1\nOLD=x\n');
    writeFileSync(path.join(wt, '.env.example'), 'A=\nOLD=\n');
    writeFileSync(path.join(root, '.env.example'), 'A=\nOLD=\n');
    // The first look only notes its names.
    expect(env.syncWorktreeExample('w1')).toBeUndefined();
    writeFileSync(path.join(wt, '.env'), 'A=1\nSTRIPE_KEY=sk_live_abcdefgh12345678\n');
    expect(env.syncWorktreeExample('w1')).toEqual({ file: '.env.example', added: ['STRIPE_KEY'], removed: ['OLD'] });
    expect(readFileSync(path.join(wt, '.env.example'), 'utf8')).toBe('A=\nSTRIPE_KEY=sk_live_…\n');
    expect(readFileSync(path.join(root, '.env.example'), 'utf8')).toBe('A=\nOLD=\n');
    // Keys the main folder brought in are only noted; a hand edit after isn't undone.
    writeFileSync(path.join(wt, '.env'), 'A=1\nSTRIPE_KEY=sk_live_abcdefgh12345678\nFROM_MAIN=1\n');
    expect(env.syncWorktreeExample('w1', true)).toBeUndefined();
    expect(env.syncWorktreeExample('w1')).toBeUndefined();
    // Switched off for the project: nothing written.
    env.setExampleSync('p1', false);
    writeFileSync(path.join(wt, '.env'), 'A=1\n');
    expect(env.syncWorktreeExample('w1')).toBeUndefined();
    expect(env.get('p1').exampleSync).toBe(false);
  });

  it('a new worktree’s first look catches its .env.example up with its .env, only adding', () => {
    writeFileSync(path.join(wt, '.env'), 'PORT=3000\nSTRIPE_KEY=sk_live_abcdefgh12345678\n');
    writeFileSync(path.join(wt, '.env.example'), '# Ports\nPORT=\nLISTED_ELSEWHERE=\n');
    expect(env.syncWorktreeExample('w1')).toEqual({ file: '.env.example', added: ['STRIPE_KEY'], removed: [], caughtUp: true });
    expect(readFileSync(path.join(wt, '.env.example'), 'utf8')).toBe('# Ports\nPORT=\nLISTED_ELSEWHERE=\nSTRIPE_KEY=sk_live_…\n');
    // The main folder is never written.
    expect(() => readFileSync(path.join(root, '.env.example'), 'utf8')).toThrow();
    // Caught up: the next look has nothing to do.
    expect(env.syncWorktreeExample('w1')).toBeUndefined();
  });

  it('makes a worktree’s .env.example when there’s none, and leaves it when switched off', () => {
    writeFileSync(path.join(wt, '.env'), 'NODE_ENV=development\nAPI_TOKEN=abc123abc123abc123\n');
    env.setExampleSync('p1', false);
    expect(env.syncWorktreeExample('w1')).toBeUndefined();
    expect(() => readFileSync(path.join(wt, '.env.example'), 'utf8')).toThrow();
    env.setExampleSync('p1', true);
    writeFileSync(path.join(wt, '.env'), 'NODE_ENV=development\nAPI_TOKEN=abc123abc123abc123\nNEW_URL=https://x.example.com/a\n');
    // Noted while off: only what was added since reaches the new file.
    expect(env.syncWorktreeExample('w1')).toEqual({ file: '.env.example', added: ['NEW_URL'], removed: [] });
    expect(readFileSync(path.join(wt, '.env.example'), 'utf8')).toBe('NEW_URL=https://x.example.com/…\n');
  });

  it('a first look with no .env.example and no .env writes nothing', () => {
    expect(env.syncWorktreeExample('w1')).toBeUndefined();
    expect(() => readFileSync(path.join(wt, '.env.example'), 'utf8')).toThrow();
  });

  it('says what .env.example asks for that isn’t set, and adds what it doesn’t list with placeholders', () => {
    writeFileSync(path.join(root, '.env'), 'PORT=3000\nSTRIPE_KEY=sk_live_abcdefgh12345678\n');
    writeFileSync(path.join(root, '.env.example'), '# needed\nPORT=\nRESEND_KEY=\n');
    env.set('p1', [{ key: 'OWN_TOKEN', value: 'secret-value' }]);
    expect(env.get('p1').example).toEqual({ file: '.env.example', keys: ['PORT', 'RESEND_KEY'], missing: ['RESEND_KEY'], unlisted: ['STRIPE_KEY', 'OWN_TOKEN'] });
    expect(env.overview('p1')).toMatchObject({ own: 1, dotenv: 2, dotenvOn: true, everywhere: 0, worktrees: [] });
    expect(env.addToExample('p1')).toEqual(['STRIPE_KEY', 'OWN_TOKEN']);
    const text = readFileSync(path.join(root, '.env.example'), 'utf8');
    expect(text).toBe('# needed\nPORT=\nRESEND_KEY=\nSTRIPE_KEY=sk_live_…\nOWN_TOKEN=your-own-token\n');
    expect(text).not.toContain('secret-value');
    expect(env.addToExample('p1')).toEqual([]);
  });

  it('makes a .env.example when the project has none', () => {
    writeFileSync(path.join(root, '.env'), 'NODE_ENV=development\n');
    expect(env.get('p1').example).toEqual({ keys: [], missing: [], unlisted: ['NODE_ENV'] });
    expect(env.addToExample('p1')).toEqual(['NODE_ENV']);
    expect(readFileSync(path.join(root, '.env.example'), 'utf8')).toBe('NODE_ENV=development\n');
  });
});
