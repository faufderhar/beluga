import { describe, expect, it } from 'vitest';
import { type MyReposDeps, listMyRepos, parseMyRepos } from '../src/workspaces/github-repos.js';

const ROWS = [
  { full_name: 'kay/app', clone_url: 'https://github.com/kay/app.git', ssh_url: 'git@github.com:kay/app.git', private: true, pushed_at: '2026-11-09T10:00:00Z', description: '  The app  ' },
  { full_name: 'acme/site', clone_url: 'https://github.com/acme/site.git', ssh_url: 'git@github.com:acme/site.git', private: false, pushed_at: null, description: null },
  { full_name: 'broken' },
  'nonsense',
];

const deps = (over: Partial<MyReposDeps> = {}): MyReposDeps & { calls: string[][] } => {
  const calls: string[][] = [];
  return {
    calls,
    state: async () => 'ok',
    gh: async (args) => {
      calls.push([...args]);
      if (args[0] === 'config') return 'https\n';
      return JSON.stringify(ROWS);
    },
    origins: async () => [],
    ...over,
  };
};

describe('your GitHub repositories', () => {
  it('reads GitHub’s rows in Beluga’s words, leaving out what isn’t a repository', () => {
    expect(parseMyRepos(JSON.stringify(ROWS), 'https')).toEqual([
      { fullName: 'kay/app', description: 'The app', private: true, pushedAt: Date.parse('2026-11-09T10:00:00Z'), url: 'https://github.com/kay/app.git' },
      { fullName: 'acme/site', private: false, pushedAt: 0, url: 'https://github.com/acme/site.git' },
    ]);
    expect(parseMyRepos('not json', 'https')).toEqual([]);
    expect(parseMyRepos('{"message":"Bad credentials"}', 'https')).toEqual([]);
  });

  it('clones over ssh when gh is set to it', async () => {
    const d = deps({ gh: async (args) => (args[0] === 'config' ? 'ssh\n' : JSON.stringify(ROWS)) });
    const got = await listMyRepos(d);
    expect(got.repos.map((r) => r.url)).toEqual(['git@github.com:kay/app.git', 'git@github.com:acme/site.git']);
  });

  it('asks for yours, your collaborations and your organizations’, most recently pushed first', async () => {
    const d = deps();
    await listMyRepos(d);
    const api = d.calls.find((c) => c[0] === 'api');
    expect(api?.[1]).toMatch(/^user\/repos\?/);
    expect(api?.[1]).toContain('sort=pushed');
    expect(api?.[1]).toContain('affiliation=owner,collaborator,organization_member');
  });

  it('marks the ones a project here already is, however its origin is written', async () => {
    const got = await listMyRepos(deps({ origins: async () => ['git@github.com:kay/app.git'] }));
    expect(got.repos.find((r) => r.fullName === 'kay/app')?.here).toBe(true);
    expect(got.repos.find((r) => r.fullName === 'acme/site')?.here).toBeUndefined();
  });

  it('has nothing to list without gh or signed out, and never calls GitHub then', async () => {
    for (const gh of ['missing', 'logged_out'] as const) {
      const d = deps({ state: async () => gh });
      expect(await listMyRepos(d)).toEqual({ gh, repos: [] });
      expect(d.calls).toEqual([]);
    }
  });

  it('falls back to https when gh’s protocol can’t be read, and passes GitHub’s error on', async () => {
    const got = await listMyRepos(deps({ gh: async (args) => (args[0] === 'config' ? Promise.reject(new Error('no config')) : JSON.stringify(ROWS)) }));
    expect(got.repos[0]?.url).toBe('https://github.com/kay/app.git');
    await expect(listMyRepos(deps({ gh: async () => Promise.reject(new Error('HTTP 401: Bad credentials')) }))).rejects.toThrow(/Bad credentials/);
  });
});
