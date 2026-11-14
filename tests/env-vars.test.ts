import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { EnvVars, loadEnvFile } from '../src/core/env-vars.js';
import { Session } from '../src/core/session.js';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState } from '../src/core/store.js';
import type { Project } from '../src/workspaces/types.js';
import { HANDLERS } from '../src/ipc/handlers.js';
import { deriveKeys, generateSecret } from '../src/net/crypto.js';
import { startHub, type Hub } from '../src/net/hub.js';
import { PeerClient } from '../src/net/peer-client.js';
import { envKeyProblem, envProblems, importEnv, mergeEnv, parseEnvText } from '../src/shared/env-vars.js';
import { waitFor } from './helpers.js';

describe('environment variables: names and pasted text', () => {
  it('accepts names a shell accepts, and says what is wrong with others', () => {
    for (const ok of ['A', 'API_KEY', '_x', 'a1_B2']) expect(envKeyProblem(ok)).toBeUndefined();
    expect(envKeyProblem('')).toBe('Give it a name');
    expect(envKeyProblem('1ABC')).toBe("Names can't start with a digit");
    for (const bad of ['MY-KEY', 'A B', 'a.b', 'ÄPI', 'X=']) expect(envKeyProblem(bad)).toBe('Use letters, digits and _ only');
  });

  it('flags bad names and names used twice, skipping empty rows', () => {
    const problems = envProblems([
      { key: 'A', value: '1' },
      { key: '', value: '' },
      { key: 'A', value: '2' },
      { key: 'bad-name', value: 'x' },
      { key: '', value: 'orphan' },
    ]);
    expect([...problems]).toEqual([
      [2, 'A is already set above'],
      [3, 'Use letters, digits and _ only'],
      [4, 'Give it a name'],
    ]);
  });

  it('reads a pasted block or a .env file', () => {
    const { vars, skipped } = parseEnvText(['# comment', '', 'export TOKEN=abc123', 'QUOTED="two words\\nnext"', "SINGLE='keep $HOME'", 'SPACED = value # note', 'EMPTY=', 'not a line', '9BAD=x', 'TOKEN=override'].join('\n'));
    expect(vars).toEqual([
      { key: 'TOKEN', value: 'override' },
      { key: 'QUOTED', value: 'two words\nnext' },
      { key: 'SINGLE', value: 'keep $HOME' },
      { key: 'SPACED', value: 'value' },
      { key: 'EMPTY', value: '' },
    ]);
    expect(skipped).toEqual(['not a line', '9BAD=x']);
  });

  it('merges layers so later ones win, and imports over existing rows in place', () => {
    expect(mergeEnv({ A: '1', B: '1' }, undefined, { B: '2' }, { C: '3' })).toEqual({ A: '1', B: '2', C: '3' });
    expect(importEnv([{ key: 'A', value: '1' }, { key: '', value: '' }, { key: 'B', value: '1' }], [{ key: 'B', value: '2' }, { key: 'C', value: '3' }])).toEqual([
      { key: 'A', value: '1' },
      { key: 'B', value: '2' },
      { key: 'C', value: '3' },
    ]);
  });
});

describe('EnvVars (kept by the core)', () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-env-')));
  });

  const project = (root: string, wsPath: string): Project => ({ id: 'p1', name: 'app', root, base: 'origin/main', workspaces: [{ id: 'w1', projectId: 'p1', path: wsPath, name: 'feature', kind: 'worktree', projectRoot: root, external: false } as never] });

  it('saves yours to a file only you can read, and tells screens the names only', () => {
    const store = new Store(initialState('t'));
    const file = path.join(dir, 'env.json');
    const env = new EnvVars({ store, file });
    env.set(undefined, [{ key: 'API_TOKEN', value: 'sk-secret-1' }, { key: '', value: '' }]);
    // Windows has no Unix modes: the user profile's own ACL keeps it private there.
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadEnvFile(file).global).toEqual({ API_TOKEN: 'sk-secret-1' });
    expect(env.get().vars).toEqual([{ key: 'API_TOKEN', value: 'sk-secret-1' }]);
    expect(store.getState().envKeys.global).toEqual(['API_TOKEN']);
    expect(JSON.stringify(store.getState())).not.toContain('sk-secret-1');
    // A new EnvVars (klaud started again) reads them back.
    expect(new EnvVars({ store, file }).envFor()).toEqual({ API_TOKEN: 'sk-secret-1' });
  });

  it('reads env.json again when it changed on disk, so the next run uses it without a restart (BLG-302)', async () => {
    const store = new Store(initialState('t'));
    const file = path.join(dir, 'env.json');
    let told = 0;
    const env = new EnvVars({ store, file, onChange: () => told++ });
    env.set(undefined, [{ key: 'DATABASE_URL', value: 'postgres://old' }]);
    told = 0;
    // Edited by hand (or by another Beluga) while this one runs.
    writeFileSync(file, JSON.stringify({ global: { DATABASE_URL: 'postgres://new', DATABASE_POOLER_URL: 'postgres://pooler' } }));
    const later = new Date(Date.now() + 5000);
    (await import('node:fs')).utimesSync(file, later, later);
    expect(env.viewEnv().vars).toEqual({ DATABASE_URL: 'postgres://new', DATABASE_POOLER_URL: 'postgres://pooler' });
    expect(env.envFor()).toMatchObject({ DATABASE_URL: 'postgres://new' });
    expect(store.getState().envKeys.global).toEqual(['DATABASE_URL', 'DATABASE_POOLER_URL']);
    await Promise.resolve();
    expect(told).toBe(1);
    // A file that doesn't read (half-written, a typo) keeps the last good variables, and isn't overwritten by them.
    writeFileSync(file, '{ "global": { "DATABASE_URL": ');
    const later2 = new Date(Date.now() + 10_000);
    (await import('node:fs')).utimesSync(file, later2, later2);
    expect(env.envFor()).toMatchObject({ DATABASE_URL: 'postgres://new' });
    expect(readFileSync(file, 'utf8')).toBe('{ "global": { "DATABASE_URL": ');
  });

  it('refuses a bad name or a name used twice, keeping what was there', () => {
    const store = new Store(initialState('t'));
    const env = new EnvVars({ store, file: path.join(dir, 'env.json') });
    env.set(undefined, [{ key: 'A', value: '1' }]);
    expect(() => env.set(undefined, [{ key: 'A', value: '1' }, { key: 'A', value: '2' }])).toThrow('A is already set above');
    expect(() => env.set(undefined, [{ key: 'BAD-NAME', value: '1' }])).toThrow('Use letters, digits and _ only');
    expect(env.envFor()).toEqual({ A: '1' });
  });

  it("layers yours, the project's .env (on by default) and the project's own", () => {
    const root = path.join(dir, 'app');
    const wt = path.join(dir, 'wt');
    mkdirSync(root);
    mkdirSync(wt);
    writeFileSync(path.join(root, '.env'), 'FROM_DOTENV=root\nSHARED=dotenv\n');
    writeFileSync(path.join(wt, '.env'), 'FROM_DOTENV=worktree\n');
    const store = new Store(initialState('t'));
    store.dispatch({ type: 'projects', projects: [project(root, wt)] });
    const env = new EnvVars({ store, file: path.join(dir, 'env.json') });
    env.set(undefined, [{ key: 'SHARED', value: 'yours' }, { key: 'ONLY_YOURS', value: '1' }]);
    // Nothing set for the project: its .env loads on its own, the worktree's copy over the main folder's.
    expect(env.envFor({ workspaceId: 'w1' })).toEqual({ SHARED: 'dotenv', ONLY_YOURS: '1', FROM_DOTENV: 'worktree' });
    expect(env.envFor({ dir: path.join(root, 'src') })).toEqual({ SHARED: 'dotenv', ONLY_YOURS: '1', FROM_DOTENV: 'root' });
    expect(env.envFor({ dir: os.homedir() })).toEqual({ SHARED: 'yours', ONLY_YOURS: '1' });
    // One set in Beluga wins over the .env.
    env.set('p1', [{ key: 'SHARED', value: 'project' }]);
    expect(env.envFor({ workspaceId: 'w1' })).toEqual({ SHARED: 'project', ONLY_YOURS: '1', FROM_DOTENV: 'worktree' });
    expect(env.get('p1')).toMatchObject({
      vars: [{ key: 'SHARED', value: 'project' }],
      dotenv: true,
      dotenvKeys: ['FROM_DOTENV', 'SHARED'],
      dotenvVars: [{ key: 'FROM_DOTENV', value: 'root' }, { key: 'SHARED', value: 'dotenv' }],
      dotenvFiles: ['.env'],
      claudeDotenv: false,
      newKeysBack: true,
    });
    expect(env.get().overridden).toEqual({ SHARED: ['app’s variables'] });
    expect(store.getState().envKeys.projects[root]).toEqual({ keys: ['SHARED'], dotenv: true });

    // Switched off: only yours and the project's own; database views still read it (it goes only to psql).
    env.set('p1', [{ key: 'SHARED', value: 'project' }], false);
    expect(env.envFor({ workspaceId: 'w1' })).toEqual({ SHARED: 'project', ONLY_YOURS: '1' });
    expect(env.viewEnv(wt)).toMatchObject({ vars: { SHARED: 'project', ONLY_YOURS: '1', FROM_DOTENV: 'worktree' }, where: expect.stringContaining('app’s variables') });
    expect(loadEnvFile(path.join(dir, 'env.json')).projects[root]?.dotenv).toBe(false);
    // Back on is the default again: nothing kept for it.
    env.set('p1', [], true);
    expect(loadEnvFile(path.join(dir, 'env.json')).projects[root]).toBeUndefined();
    expect(env.envFor({ workspaceId: 'w1' })).toEqual({ SHARED: 'dotenv', ONLY_YOURS: '1', FROM_DOTENV: 'worktree' });
  });

  it('reads .env.local over .env, and copies them into Beluga on request (BLG-369)', () => {
    const root = path.join(dir, 'app');
    mkdirSync(root);
    writeFileSync(path.join(root, '.env'), 'A=1\nB=1\n');
    writeFileSync(path.join(root, '.env.local'), 'B=local\nC=3\n');
    const store = new Store(initialState('t'));
    store.dispatch({ type: 'projects', projects: [project(root, root)] });
    const env = new EnvVars({ store, file: path.join(dir, 'env.json') });
    expect(env.get('p1').dotenvFiles).toEqual(['.env', '.env.local']);
    expect(env.envFor({ projectId: 'p1' })).toEqual({ A: '1', B: 'local', C: '3' });
    env.set('p1', [{ key: 'A', value: 'mine' }]);
    // Yours stays; the rest come in.
    expect(env.importDotenv('p1')).toBe(2);
    expect(env.get('p1').vars).toEqual([{ key: 'A', value: 'mine' }, { key: 'B', value: 'local' }, { key: 'C', value: '3' }]);
    expect(env.importDotenv('p1')).toBe(0);
  });

  it("saves a worktree's values over the project's own, and remembers whether new keys go back on their own", () => {
    const root = path.join(dir, 'app');
    mkdirSync(root);
    const store = new Store(initialState('t'));
    store.dispatch({ type: 'projects', projects: [project(root, root)] });
    const file = path.join(dir, 'env.json');
    const env = new EnvVars({ store, file });
    env.set('p1', [{ key: 'A', value: '1' }, { key: 'B', value: '1' }]);
    expect(env.merge('p1', { B: '2', C: '3' })).toBe(2);
    expect(env.get('p1').vars).toEqual([{ key: 'A', value: '1' }, { key: 'B', value: '2' }, { key: 'C', value: '3' }]);
    expect(env.newKeysBack('p1')).toBe(true);
    expect(env.get('p1').newKeysBack).toBe(true);
    env.setNewKeysBack('p1', false);
    expect(new EnvVars({ store, file }).newKeysBack('p1')).toBe(false);
    env.setNewKeysBack('p1', true);
    expect(loadEnvFile(file).projects[root]).not.toHaveProperty('newKeysBack');
  });

  it("gives your own Claude the .env only where it may read .env files, or you switched it on yourself", () => {
    const root = path.join(dir, 'app');
    mkdirSync(root);
    writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
    const store = new Store(initialState('t'));
    store.dispatch({ type: 'projects', projects: [project(root, root)] });
    const file = path.join(dir, 'env.json');
    const env = new EnvVars({ store, file });
    env.set('p1', [{ key: 'MINE', value: '1' }]);
    expect(env.envFor({ projectId: 'p1' })).toEqual({ SECRET: '1', MINE: '1' });
    expect(env.envFor({ projectId: 'p1' }, { claude: true })).toEqual({ MINE: '1' });
    env.setClaudeDotenv('p1', true);
    expect(env.envFor({ projectId: 'p1' }, { claude: true })).toEqual({ SECRET: '1', MINE: '1' });
    env.setClaudeDotenv('p1', false);
    // A file from before the default: false was "never switched on" (on now), true was switched on (Claude too).
    writeFileSync(file, JSON.stringify({ global: {}, projects: { [root]: { vars: {}, dotenv: true } } }));
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    expect(env.envFor({ projectId: 'p1' }, { claude: true })).toEqual({ SECRET: '1' });
    writeFileSync(file, JSON.stringify({ global: {}, projects: { [root]: { vars: { X: '1' }, dotenv: false } } }));
    const later2 = new Date(Date.now() + 10_000);
    utimesSync(file, later2, later2);
    expect(env.envFor({ projectId: 'p1' })).toEqual({ SECRET: '1', X: '1' });
    expect(env.envFor({ projectId: 'p1' }, { claude: true })).toEqual({ X: '1' });
  });

  it('remembers where your Claude may read .env files without asking', () => {
    const root = path.join(dir, 'app');
    const wt = path.join(dir, 'wt');
    mkdirSync(root);
    mkdirSync(wt);
    const store = new Store(initialState('t'));
    store.dispatch({ type: 'projects', projects: [project(root, wt)] });
    const file = path.join(dir, 'env.json');
    const env = new EnvVars({ store, file });
    const access = env.dotenvAccess;
    expect(access.allowed(wt)).toBe(false);
    expect(access.project(wt)).toBe('app');
    expect(access.project(os.homedir())).toBeUndefined();
    access.allow(wt, 'project');
    expect(access.allowed(path.join(root, 'src'))).toBe(true);
    expect(access.allowed(os.homedir())).toBe(false);
    // Kept with the project's variables, and survives a restart.
    env.set('p1', [{ key: 'A', value: '1' }]);
    expect(new EnvVars({ store, file }).get('p1').claudeDotenv).toBe(true);
    env.setClaudeDotenv('p1', false);
    expect(access.allowed(wt)).toBe(false);
    access.allow(os.homedir(), 'everywhere');
    expect(access.allowed(os.homedir())).toBe(true);
    expect(env.get().claudeDotenv).toBe(true);
  });

  it('sets and removes one at a time (/env)', () => {
    const store = new Store(initialState('t'));
    const env = new EnvVars({ store, file: path.join(dir, 'env.json') });
    env.setOne(undefined, 'A', '1');
    env.setOne(undefined, 'B', '2');
    env.setOne(undefined, 'A', undefined);
    expect(env.envFor()).toEqual({ B: '2' });
  });
});

describe('environment variables never leave this computer', () => {
  const keys = deriveKeys(generateSecret());
  let hub: Hub;
  const sessions: Session[] = [];
  const home = process.env.BELUGA_HOME;

  beforeEach(() => {
    process.env.BELUGA_HOME = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-env-home-')));
  });
  afterEach(async () => {
    for (const s of sessions.splice(0)) await s.stop();
    await hub?.close();
    process.env.BELUGA_HOME = home;
  });

  function peer(name: string) {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), `klaud-${name}-`)));
    const store = new Store(initialState('test', 'auto'));
    const client = new PeerClient({ url: `ws://127.0.0.1:${hub.port}`, keys, profile: { name, shares: [], agent: true }, reconnect: false });
    const runs: AgentRunInput[] = [];
    const session = new Session({
      client,
      store,
      shares: new ShareService([]),
      agentCwd: root,
      zoom: async () => ({ ok: true, message: '' }),
      copy: async () => undefined,
      createAgent: (): AgentBackend => ({ run: async (input) => (runs.push(input), 'done') }),
    });
    session.start();
    sessions.push(session);
    return { session, client, store, runs };
  }

  it('goes to your own Claude only, and into nothing sent to the room or a friend', async () => {
    hub = await startHub({ keys });
    const kay = peer('kay');
    const bob = peer('bob');
    await waitFor(() => kay.store.getState().peers.length === 2 && bob.store.getState().peers.length === 2, 4000);
    const sent: unknown[] = [];
    const send = kay.client.send.bind(kay.client);
    vi.spyOn(kay.client, 'send').mockImplementation((body, opts) => (sent.push(body), send(body, opts)));
    const bobSaw: unknown[] = [];
    bob.store.onAction((a) => void bobSaw.push(a));
    const kaySaw: unknown[] = [];
    kay.store.onAction((a) => void kaySaw.push(a));

    await HANDLERS['env.set'](kay.session, undefined, [{ key: 'STRIPE_KEY', value: 'sk_live_TOPSECRET' }], undefined);
    expect(readFileSync(path.join(process.env.BELUGA_HOME!, 'env.json'), 'utf8')).toContain('sk_live_TOPSECRET');

    kay.session.askOwnClaude('deploy it', 'room');
    await waitFor(() => kay.runs.length === 1, 4000);
    expect(kay.runs[0]!.env).toEqual({ STRIPE_KEY: 'sk_live_TOPSECRET' });

    // A friend's request runs without your variables.
    bob.session.submit('@claude:kay print the env');
    await waitFor(() => kay.runs.length === 2, 4000);
    expect(kay.runs[1]!.requesterName).toBe('bob');
    expect(kay.runs[1]!.env).toBeUndefined();
    await waitFor(() => bob.store.getState().log.some((l) => l.type === 'agent' && l.status === 'done'), 4000);

    const everything = JSON.stringify([sent, bobSaw, kaySaw, kay.store.getState(), bob.store.getState()]);
    expect(everything).not.toContain('sk_live_TOPSECRET');
    expect(kay.store.getState().envKeys.global).toEqual(['STRIPE_KEY']);
  });
});
