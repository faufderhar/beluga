import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FETCH_EVERY_DEFAULT, fetchEveryMinutes, fetchEveryWords } from '../src/shared/background-fetch.js';
import { Settings } from '../src/shared/settings-schema.js';
import { PrefsPatch } from '../src/ipc/api.js';

/**
 * Beluga's own fetches of each project (#479): every 15 minutes unless you choose otherwise in
 * Settings › Workspaces, slower, or never (a vault that asks for your SSH key each time it's used
 * then stays quiet). Fetch and Update main still fetch when you click them.
 */

const fetched: string[] = [];
vi.mock('../src/workspaces/sync.js', async (original) => ({
  ...(await original<typeof import('../src/workspaces/sync.js')>()),
  fetchRemote: vi.fn(async (root: string) => {
    fetched.push(root);
    return { ok: true };
  }),
}));

const { MainSync, STALE_FETCH_MS, staleAfterMs } = await import('../src/core/main-sync.js');

const MIN = 60_000;
/** A real-looking clock (time 0 would read as "fetched just now"). */
const T0 = Date.UTC(2026, 10, 12);
const project = { id: 'p1', root: '/code/app', base: 'origin/main', sync: { upstream: 'origin/main', remote: 'origin' } };

function make(opts: { every?: () => number; saving?: () => boolean } = {}) {
  let now = T0;
  const sync = new MainSync({
    manager: {
      list: [project],
      repoProject: () => project,
      setFetchState: () => undefined,
      learnRemoteDefault: () => undefined,
      remoteOf: async () => undefined,
    } as never,
    refresh: async () => undefined,
    publish: () => undefined,
    toast: () => undefined,
    newChat: async () => undefined,
    newWorktree: async () => undefined,
    armSync: () => undefined,
    askClaude: () => undefined,
    open: () => undefined,
    ghHosts: () => [],
    now: () => now,
    ...(opts.every ? { fetchEvery: opts.every } : {}),
    ...(opts.saving ? { saving: opts.saving } : {}),
  });
  return { sync, at: (minutes: number) => void (now = T0 + minutes * MIN) };
}

beforeEach(() => {
  fetched.length = 0;
});

describe('background fetches (#479)', () => {
  it('fetch every 15 minutes by default, as before', async () => {
    const { sync, at } = make();
    await sync.backgroundPass();
    expect(fetched).toHaveLength(1);
    at(10);
    await sync.backgroundPass();
    expect(fetched).toHaveLength(1);
    at(15);
    await sync.backgroundPass();
    expect(fetched).toHaveLength(2);
  });

  it('turned off: never fetch on their own, and opening a project doesn’t either; Fetch still does', async () => {
    const { sync, at } = make({ every: () => 0 });
    for (const m of [0, 15, 60, 24 * 60]) {
      at(m);
      await sync.backgroundPass();
      expect(await sync.fetchIfStale(project.id)).toBeUndefined();
    }
    expect(fetched).toEqual([]);
    expect(await sync.fetch(project.id)).toEqual({ ok: true });
    expect(fetched).toEqual([project.root]);
  });

  it('follow a slower pace, and opening a project fetches less often with it', async () => {
    const { sync, at } = make({ every: () => 60 });
    await sync.backgroundPass();
    expect(fetched).toHaveLength(1);
    at(20);
    await sync.backgroundPass();
    expect(await sync.fetchIfStale(project.id)).toBeUndefined();
    expect(fetched).toHaveLength(1);
    at(31);
    expect(await sync.fetchIfStale(project.id)).toEqual({ ok: true });
    expect(fetched).toHaveLength(2);
    at(91);
    await sync.backgroundPass();
    expect(fetched).toHaveLength(3);
  });

  it('a new choice applies at the next look, with no restart', async () => {
    let every = 0;
    const { sync } = make({ every: () => every });
    await sync.backgroundPass();
    expect(fetched).toEqual([]);
    every = 15;
    await sync.backgroundPass();
    expect(fetched).toHaveLength(1);
  });

  it('Low Power mode makes them four times rarer', async () => {
    const { sync, at } = make({ every: () => 15, saving: () => true });
    await sync.backgroundPass();
    at(30);
    await sync.backgroundPass();
    expect(fetched).toHaveLength(1);
    at(60);
    await sync.backgroundPass();
    expect(fetched).toHaveLength(2);
  });

  it('opening a project: two minutes at the default pace or faster, half the pace when slower', () => {
    expect(staleAfterMs(5)).toBe(STALE_FETCH_MS);
    expect(staleAfterMs(15)).toBe(STALE_FETCH_MS);
    expect(staleAfterMs(60)).toBe(30 * MIN);
    expect(staleAfterMs(240)).toBe(120 * MIN);
  });
});

describe('the Fetch in the background setting', () => {
  it('reads every 15 minutes when unset or unusable, and keeps 0 and paces in range', () => {
    expect(Settings.parse({}).fetchEvery).toBe(FETCH_EVERY_DEFAULT);
    expect(Settings.parse({ fetchEvery: 0 }).fetchEvery).toBe(0);
    expect(Settings.parse({ fetchEvery: 60 }).fetchEvery).toBe(60);
    for (const bad of [3, -1, 1.5, 100_000, 'often', null]) expect(Settings.parse({ fetchEvery: bad }).fetchEvery).toBe(FETCH_EVERY_DEFAULT);
    expect(fetchEveryMinutes(undefined)).toBe(FETCH_EVERY_DEFAULT);
  });

  it('a settings change takes never or 5 minutes to a day', () => {
    for (const ok of [0, 5, 15, 240, 1440]) expect(PrefsPatch.safeParse({ fetchEvery: ok }).success).toBe(true);
    for (const bad of [1, 4, 1441, 7.5]) expect(PrefsPatch.safeParse({ fetchEvery: bad }).success).toBe(false);
  });

  it('says each pace in words', () => {
    expect([0, 5, 15, 60, 240].map(fetchEveryWords)).toEqual(['Never', 'Every 5 minutes', 'Every 15 minutes', 'Every hour', 'Every 4 hours']);
  });
});
