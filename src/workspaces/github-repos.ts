import os from 'node:os';
import { sameRepo } from '../shared/repo-key.js';
import { type GhState, forgetGh, ghState, runGh } from './pr.js';

/**
 * Your own GitHub repositories, for the Clone tab: the ones you own, collaborate on or reach
 * through an organization, most recently pushed first. Read through the GitHub CLI with the
 * sign-in it already has; Beluga never asks for one of its own.
 */

/** One repository you can clone. */
export interface MyRepo {
  /** owner/name */
  readonly fullName: string;
  readonly description?: string;
  readonly private: boolean;
  /** When it was last pushed to (ms), 0 if GitHub didn't say. */
  readonly pushedAt: number;
  /** The address to clone, in gh's protocol (ssh or https). */
  readonly url: string;
  /** A project of this repository is on this computer already. */
  readonly here?: boolean;
}

export interface MyRepos {
  /** ok: signed in (repos below); logged_out or missing: no list, the sheet says how to get one. */
  readonly gh: GhState;
  readonly repos: readonly MyRepo[];
}

/** How many repositories one look reads (the most recently pushed). */
export const MY_REPOS_PAGE = 100;

export type GitProtocol = 'ssh' | 'https';

/** `gh api user/repos` → the repositories, in Beluga's words; nonsense rows are left out. */
export function parseMyRepos(json: string, protocol: GitProtocol): MyRepo[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r): MyRepo[] => {
    if (!r || typeof r !== 'object') return [];
    const o = r as Record<string, unknown>;
    const fullName = typeof o.full_name === 'string' ? o.full_name : undefined;
    const https = typeof o.clone_url === 'string' ? o.clone_url : undefined;
    const ssh = typeof o.ssh_url === 'string' ? o.ssh_url : undefined;
    const url = protocol === 'ssh' ? (ssh ?? https) : (https ?? ssh);
    if (!fullName || !url) return [];
    const description = typeof o.description === 'string' && o.description.trim() ? o.description.trim().slice(0, 300) : undefined;
    return [
      {
        fullName,
        ...(description ? { description } : {}),
        private: o.private === true,
        pushedAt: typeof o.pushed_at === 'string' ? Date.parse(o.pushed_at) || 0 : 0,
        url,
      },
    ];
  });
}

/** What listMyRepos reads with: the real gh, or a test's stand-ins. */
export interface MyReposDeps {
  readonly state: () => Promise<GhState>;
  readonly gh: (args: readonly string[]) => Promise<string>;
  /** The origins of the projects on this computer, to mark repositories you have already. */
  readonly origins: () => Promise<readonly string[]>;
}

const realDeps = (origins: () => Promise<readonly string[]>): MyReposDeps => ({
  state: async () => {
    const st = await ghState();
    // Signed in since? The next look asks gh again instead of remembering "signed out".
    if (st !== 'ok') forgetGh();
    return st;
  },
  gh: (args) => runGh(args, os.homedir(), 20_000),
  origins,
});

/** Your repositories through gh (none when it's missing or signed out). Throws gh's error when GitHub can't be reached. */
export async function listMyRepos(deps: MyReposDeps): Promise<MyRepos> {
  const gh = await deps.state();
  if (gh !== 'ok') return { gh, repos: [] };
  const [json, protocol, origins] = await Promise.all([
    deps.gh(['api', `user/repos?per_page=${MY_REPOS_PAGE}&sort=pushed&affiliation=owner,collaborator,organization_member`]),
    deps.gh(['config', 'get', 'git_protocol']).then(
      (p): GitProtocol => (p.trim() === 'ssh' ? 'ssh' : 'https'),
      (): GitProtocol => 'https',
    ),
    deps.origins().catch((): readonly string[] => []),
  ]);
  const repos = parseMyRepos(json, protocol).map((r) => (origins.some((o) => sameRepo(o, r.url)) ? { ...r, here: true } : r));
  return { gh, repos };
}

/** listMyRepos on this computer's gh. */
export const listMyReposHere = (origins: () => Promise<readonly string[]>): Promise<MyRepos> => listMyRepos(realDeps(origins));
