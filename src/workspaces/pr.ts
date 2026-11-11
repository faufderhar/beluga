import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PrCheck, PullRequest } from '../core/work-store.js';
import { belugaHome } from './store.js';
import { belugaEnv } from '../core/beluga-env.js';
import { type GitSetup, type GitTroubleKind, classifyGitError, httpsRemoteOf } from '../shared/git-trouble.js';
import { rememberSshRoute, sshArgsFor, withSshRoutes } from './ssh-routes.js';
import { type GitHubRepo, PR_TARGET_KEY, ghRepoEnv, gitCommonDir, originRepo, originRepoEnv, prTargetOf, pullOfBranch, repoSlug } from './github.js';
export { describePr } from '../shared/format.js';

/**
 * What Claude does when you click PR. Edit it in Settings → Claude → Pull request
 * instructions (saved to ~/.beluga/prompts/pull-request.md). {{branch}}, {{base}},
 * {{baseBranch}} and {{project}} are filled in.
 */
export const DEFAULT_PR_PROMPT = `Open a pull request for the work in this workspace.

1. Look at everything that changed compared to {{base}} (git log {{base}}..HEAD and git diff {{base}}).
2. If there are uncommitted changes that belong to this work, commit them with a clear conventional-commit
   message. Never commit secrets, .env files or unrelated changes.
3. Push {{branch}} to origin (set the upstream). If git rejects it as non-fast-forward because the
   branch's last pull request was already merged and GitHub's copy is exactly that pull request's head
   (gh pr view {{branch}} --json state,headRefOid), push with --force-with-lease={{branch}}:<that sha>.
   Never force-push otherwise: say what's on GitHub that isn't here instead.
4. Write the pull request so a reviewer understands it in 30 seconds:
   - Title: short and imperative, under 70 characters (for example "Add session auth to the payments API").
   - Description, short and easy to read:
     ## What
     2 to 4 bullets on what changed.
     ## Why
     One or two sentences on the problem it solves.
     ## How to test
     The commands or steps to check it.
     Mention anything risky, unfinished or worth a closer look.
5. Create it with: gh pr create --base {{baseBranch}} --head {{branch}} --title "<title>" --body-file <file>
   (write the body to a temporary file first). If an open pull request for {{branch}} already exists,
   push the new commits and update its title and description with gh pr edit instead.
6. Reply with the pull request URL and a one-paragraph explanation of the change.`;

export const prPromptFile = (): string => path.join(belugaHome(), 'prompts', 'pull-request.md');

/** Your customized instructions, if you saved any. */
export function customPrPrompt(file = prPromptFile()): string | undefined {
  try {
    const text = readFileSync(file, 'utf8').trim();
    return text && text !== DEFAULT_PR_PROMPT.trim() ? text : undefined;
  } catch {
    return undefined;
  }
}

/** Make sure the file exists (with the built-in text) so it can be opened in an editor. */
export function ensurePrPromptFile(file = prPromptFile()): string {
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${DEFAULT_PR_PROMPT}\n`);
  }
  return file;
}

export function resetPrPrompt(file = prPromptFile()): void {
  rmSync(file, { force: true });
}

export interface PrContext {
  readonly branch: string;
  readonly base: string;
  readonly project: string;
  /** Project-specific additions from beluga.json. */
  readonly projectPrompt?: string;
  /** What you typed for this one PR ("/pr mention the migration"). */
  readonly extra?: string;
}

/** The full prompt Claude gets for one PR. */
export function buildPrPrompt(ctx: PrContext, template = customPrPrompt() ?? DEFAULT_PR_PROMPT): string {
  const baseBranch = ctx.base.replace(/^origin\//, '');
  const filled = template.replaceAll('{{branch}}', ctx.branch).replaceAll('{{baseBranch}}', baseBranch).replaceAll('{{base}}', ctx.base).replaceAll('{{project}}', ctx.project);
  const project = ctx.projectPrompt?.trim() ? `\n\nProject guidelines for pull requests (from the project's beluga.json):\n${ctx.projectPrompt.trim()}` : '';
  const extra = ctx.extra?.trim() ? `\n\nFor this pull request, also: ${ctx.extra.trim()}` : '';
  return `${filled}${project}${extra}`;
}

/** Ask Claude to fix the failing checks on a PR. */
/**
 * GitHub says the PR conflicts with its base: Claude brings the base in, resolves, and pushes. A PR
 * on a fork's original (`original`) conflicts with the original's branch, fetched from there.
 */
export const resolvePrConflictsPrompt = (pr: PullRequest, base: string, original?: { readonly url: string; readonly branch: string }): string =>
  [
    `Pull request #${pr.number} (${pr.url}) has merge conflicts with ${original ? `${original.url.replace(/^https:\/\/[^/]+\//, '')}'s ${original.branch}` : base}, so GitHub can't merge it. Resolve them on this branch:`,
    original
      ? `1. Commit anything uncommitted first. Then \`git fetch ${original.url}.git ${original.branch}\` (no new remote) and \`git merge FETCH_HEAD\` (a merge, not a rebase: never rewrite what's pushed).`
      : `1. Commit anything uncommitted first. Then \`git fetch origin\` and \`git merge origin/${base}\` (a merge, not a rebase: never rewrite what's pushed).`,
    "2. For each conflicted file, read both sides and the commits behind them, and keep both intents; don't just pick one side. Remove every conflict marker.",
    '3. Run the typecheck and the tests that cover what changed, and fix what the merge broke.',
    `4. Commit the merge and \`git push\` (never force-push). Then say in a few lines which files conflicted and how you resolved each.`,
  ].join('\n');

/** After its PR merged, you carry on here but the branch has newer commits: Claude catches it up with the base. */
export const catchUpPrompt = (pr: PullRequest, base: string): string =>
  [
    `Pull request #${pr.number} was merged into ${base}, and this branch has carried on since. Bring it up to date so the next pull request only has the new work:`,
    `\`git fetch origin\`, then \`git merge origin/${base}\`. Resolve any conflicts keeping both intents, run the tests that cover what changed, and commit the merge. Don't push or open a pull request.`,
    'Then say in one or two lines what is on this branch now that is not in the base yet.',
  ].join('\n');

export const fixChecksPrompt = (pr: PullRequest): string =>
  `The checks on pull request #${pr.number} (${pr.url}) are failing. Use gh pr checks ${pr.number} and gh run view --log-failed to find out why, fix it, run the tests, commit and push. Then say what was wrong.`;

// Never wait on a username prompt nobody can answer (the daemon has no terminal): fail and say so.
const QUIET_ENV = { GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };

const run = (cmd: string, args: readonly string[], cwd: string, timeoutMs = 20_000, extraEnv: Readonly<Record<string, string>> = {}): Promise<string> =>
  new Promise((resolve, reject) => {
    // git that reaches a remote goes over SSH where https was found not to work (ssh-routes.ts).
    execFile(cmd, cmd === 'git' ? [...withSshRoutes(args)] : [...args], { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...extraEnv, ...QUIET_ENV } }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout)));
  });

/** Where Homebrew puts programs: a Mac app started from the Dock gets a PATH without them. */
export const HOMEBREW_BINS = ['/opt/homebrew/bin', '/usr/local/bin'] as const;

/** How a system lists PATH's folders: ";" between them on Windows, ":" elsewhere. */
const pathDirs = (pathEnv: string, platform: NodeJS.Platform): string[] => pathEnv.split(platform === 'win32' ? ';' : ':').filter(Boolean);

/**
 * The first `name` on `pathEnv` or in Homebrew's folders, as a full path (undefined: none). On
 * Windows a program is found with the endings PATHEXT lists (gh.exe for "gh"), as cmd finds it.
 */
export function findTool(name: string, pathEnv = process.env.PATH ?? '', exists: (file: string) => boolean = existsSync, platform: NodeJS.Platform = process.platform, pathExt = process.env.PATHEXT): string | undefined {
  const win = platform === 'win32';
  const join = win ? path.win32.join : path.posix.join;
  const dirs = [...pathDirs(pathEnv, platform), ...(win ? [] : HOMEBREW_BINS)];
  const endings = win && !/\.\w+$/.test(name) ? (pathExt || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase()) : [''];
  for (const dir of [...new Set(dirs)]) {
    for (const ending of endings) {
      const file = join(dir, `${name}${ending}`);
      if (exists(file)) return file;
    }
  }
  return undefined;
}

/** How to run `name`: by its name when it's on PATH, else its full path in Homebrew's folders (else the name, which fails with ENOENT). */
export function toolCommand(name: string, pathEnv = process.env.PATH ?? '', exists: (file: string) => boolean = existsSync, platform: NodeJS.Platform = process.platform): string {
  const found = findTool(name, pathEnv, exists, platform);
  if (!found) return name;
  const win = platform === 'win32';
  // Windows writes PATH's folders with a trailing "\\" or in any letter case: the same folder.
  const same = (dir: string): string => (win ? dir.replace(/[\\/]+$/, '').toLowerCase() : dir);
  const dir = same((win ? path.win32 : path.posix).dirname(found));
  return pathDirs(pathEnv, platform).some((d) => same(d) === dir) ? name : found;
}

/** The GitHub CLI to run: BELUGA_GH (the Mac app's end-to-end tests point it at a stand-in), else gh on PATH or in Homebrew's folders. */
const gh = (): string => belugaEnv('GH') || toolCommand('gh');

/** Run the GitHub CLI in `dir`, on origin's repository (a fork's own, not the original: see ghRepoEnv) → what it printed. Throws gh's error. */
export const runGh = (args: readonly string[], dir: string, timeoutMs = 30_000): Promise<string> => run(gh(), args, dir, timeoutMs, ghRepoEnv(dir));

export type GhState = 'ok' | 'logged_out' | 'missing';
let ghReady: Promise<GhState> | undefined;
/** The GitHub CLI: installed and logged in, installed but logged out, or missing (checked once; forgetGh asks again). */
export function ghState(): Promise<GhState> {
  ghReady ??= run(gh(), ['auth', 'status'], process.cwd(), 8000).then(
    (): GhState => 'ok',
    (err: unknown): GhState => (/ENOENT/.test(err instanceof Error ? err.message : String(err)) ? 'missing' : 'logged_out'),
  );
  return ghReady;
}

/** Whether the GitHub CLI is installed and signed in (checked once). */
export const hasGh = (): Promise<boolean> => ghState().then((s) => s === 'ok');

/** Ask about gh again next time (it was just installed or logged in to). */
export function forgetGh(): void {
  ghReady = undefined;
}

/** What Beluga knows about this Mac's way to GitHub from `dir`: gh, Homebrew, the origin remote (for explainGitTrouble). */
export async function gitSetup(dir: string): Promise<GitSetup> {
  const [state, remote] = await Promise.all([ghState(), run('git', ['remote', 'get-url', 'origin'], dir, 5000).then((u) => u.trim() || undefined, () => undefined)]);
  const brew = findTool('brew');
  const ghCommand = gh();
  return {
    gh: state,
    ...(brew ? { brew: path.dirname(brew) } : {}),
    // The terminal's own PATH usually has it; a full path when it's only in Homebrew's folder.
    ...(ghCommand !== 'gh' ? { ghCommand } : {}),
    ...(remote ? { remote } : {}),
  };
}

/** git's options that make one command use gh's GitHub login (nothing is saved). */
const ghCredentials = (): string[] => ['-c', 'credential.helper=', '-c', `credential.helper=!"${gh()}" auth git-credential`];

/**
 * Switch a project's origin to HTTPS for good, with gh's login for it in that repository only
 * (asked first, on the Mac). Returns the URL it had, so it can be changed back.
 */
export async function useHttpsRemote(dir: string): Promise<{ from: string; to: string }> {
  const from = (await run('git', ['remote', 'get-url', 'origin'], dir, 5000)).trim();
  const to = httpsRemoteOf(from);
  if (!to) throw new Error(`origin isn’t an SSH address Beluga can turn into HTTPS (${from})`);
  await run('git', ['remote', 'set-url', 'origin', to], dir, 5000);
  const key = `credential.${new URL(to).origin}.helper`;
  // An empty helper first: only gh's answers for this host here (a stale keychain password won't be tried first).
  await run('git', ['config', '--local', '--replace-all', key, ''], dir, 5000);
  await run('git', ['config', '--local', '--add', key, `!"${gh()}" auth git-credential`], dir, 5000);
  return { from, to };
}

/** One entry of gh's statusCheckRollup: a CheckRun (Actions job) or a StatusContext (commit status). */
interface GhCheck {
  readonly __typename?: string;
  readonly name?: string;
  readonly context?: string;
  readonly workflowName?: string;
  readonly status?: string;
  readonly conclusion?: string;
  readonly state?: string;
  readonly detailsUrl?: string;
  readonly targetUrl?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

/** Fold gh's statusCheckRollup into one word. */
export function checksState(checks: readonly GhCheck[] | undefined): PullRequest['checks'] {
  if (!checks?.length) return 'none';
  const states = checks.map((c) => (c.conclusion || c.state || c.status || '').toUpperCase());
  if (states.some((s) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(s))) return 'failing';
  if (states.some((s) => ['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING', 'REQUESTED', 'EXPECTED', ''].includes(s))) return 'pending';
  return 'passing';
}

/** At most this many checks are kept per PR (a matrix build can have hundreds). */
const MAX_CHECKS = 100;
/** GitHub's "not set" time for a check that hasn't started or finished. */
const time = (t: string | undefined): string | undefined => (t && !t.startsWith('0001-') ? t : undefined);

/** Each check in gh's statusCheckRollup, the same shape for Actions jobs and commit statuses. */
export function parseChecks(checks: readonly GhCheck[] | undefined): PrCheck[] {
  return (checks ?? []).slice(0, MAX_CHECKS).map((c): PrCheck => {
    const status = (c.status ?? '').toUpperCase();
    const commit = (c.state ?? '').toUpperCase();
    const isStatus = c.__typename === 'StatusContext' || (!c.status && Boolean(c.state));
    const state: PrCheck['state'] = isStatus
      ? commit === 'PENDING' ? 'in_progress' : commit === 'EXPECTED' || !commit ? 'queued' : 'completed'
      : status === 'COMPLETED' || (!status && c.conclusion) ? 'completed' : status === 'IN_PROGRESS' ? 'in_progress' : 'queued';
    const conclusion = state !== 'completed' ? undefined : isStatus ? commit.toLowerCase() : (c.conclusion ?? '').toLowerCase() || undefined;
    const url = c.detailsUrl || c.targetUrl;
    const startedAt = time(c.startedAt);
    const completedAt = state === 'completed' ? time(c.completedAt) : undefined;
    return {
      name: c.name || c.context || 'check',
      ...(c.workflowName ? { workflow: c.workflowName } : {}),
      state,
      ...(conclusion ? { conclusion } : {}),
      ...(url ? { url } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(completedAt ? { completedAt } : {}),
    };
  });
}

interface GhPr {
  number?: number;
  url?: string;
  state?: string;
  title?: string;
  isDraft?: boolean;
  statusCheckRollup?: GhCheck[];
  reviewDecision?: string;
  headRefName?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  autoMergeRequest?: unknown;
  headRefOid?: string;
  mergedAt?: string;
}

function toPr(raw: GhPr): PullRequest | undefined {
  if (typeof raw.number !== 'number' || typeof raw.url !== 'string') return undefined;
  const state = raw.state === 'MERGED' || raw.state === 'CLOSED' ? raw.state : 'OPEN';
  const review = raw.reviewDecision === 'APPROVED' || raw.reviewDecision === 'CHANGES_REQUESTED' || raw.reviewDecision === 'REVIEW_REQUIRED' ? raw.reviewDecision : undefined;
  const checkRuns = parseChecks(raw.statusCheckRollup);
  const open = state === 'OPEN';
  const mergedAt = state === 'MERGED' && typeof raw.mergedAt === 'string' ? Date.parse(raw.mergedAt) : NaN;
  return {
    number: raw.number,
    url: raw.url,
    state,
    title: raw.title ?? '',
    draft: Boolean(raw.isDraft),
    checks: checksState(raw.statusCheckRollup),
    ...(checkRuns.length ? { checkRuns } : {}),
    ...(review ? { review } : {}),
    ...(open && raw.mergeable === 'CONFLICTING' ? { conflicts: true } : {}),
    ...(open && raw.autoMergeRequest ? { autoMerge: true } : {}),
    ...(typeof raw.headRefOid === 'string' && raw.headRefOid ? { head: raw.headRefOid } : {}),
    ...(Number.isFinite(mergedAt) ? { mergedAt } : {}),
    ...(open && raw.mergeStateStatus === 'BEHIND' ? { mergeState: 'behind' as const } : open && raw.mergeStateStatus === 'BLOCKED' ? { mergeState: 'blocked' as const } : {}),
  };
}

/** Parse `gh pr view --json …` output. */
export function parsePr(json: string): PullRequest | undefined {
  try {
    return toPr(JSON.parse(json) as GhPr);
  } catch {
    return undefined;
  }
}

/**
 * Parse `gh pr list --state all --json …` output into each branch's PR: its open one, or else
 * the newest. Undefined when gh's answer isn't a list.
 */
export function parsePrList(json: string): Map<string, PullRequest> | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!Array.isArray(raw)) return undefined;
  const out = new Map<string, PullRequest>();
  for (const item of raw as GhPr[]) {
    const pr = item && typeof item.headRefName === 'string' ? toPr(item) : undefined;
    if (!pr) continue;
    const had = out.get(item.headRefName!);
    const open = (p: PullRequest): number => (p.state === 'OPEN' ? 1 : 0);
    if (!had || open(pr) > open(had) || (open(pr) === open(had) && pr.number > had.number)) out.set(item.headRefName!, pr);
  }
  return out;
}

const PR_FIELDS = 'number,url,state,title,isDraft,statusCheckRollup,reviewDecision,mergeable,mergeStateStatus,autoMergeRequest,headRefOid,mergedAt';
/** How many PRs one `gh pr list` asks for. */
export const PR_LIST_LIMIT = 60;

/**
 * Push a worktree's branch for its pull request. A branch whose last PR was squash-merged and that
 * carried on from the base (Beluga moves it there after a merge) no longer follows GitHub's copy,
 * so git refuses (non-fast-forward). When GitHub's copy is exactly that merged PR's head, nothing
 * there is new: it's replaced, with a lease on that very commit so anything pushed since is never
 * lost. Any other refusal says git's reason, not its first line ("To https://github.com/…").
 */
export async function pushForPr(dir: string, head: string, opts: { readonly https?: boolean } = {}): Promise<'pushed' | 'replaced'> {
  return opts.https ? pushOnce(dir, head, opts) : orOverSsh(dir, (pre) => pushOnce(dir, head, { pre }));
}

/** What says https couldn't get in, where SSH may: no login, a broken https helper, or the "not found" GitHub tells a private repository's visitor without one. */
const SSH_MAY_HELP: ReadonlySet<GitTroubleKind> = new Set(['https_auth', 'https_broken', 'no_access']);

/**
 * `attempt`, and when it fails because https can't get into an https origin on GitHub, GitLab or
 * Bitbucket, once more over SSH (someone who only uses SSH keys): when that works, every command
 * that reaches origin goes over SSH from then on (ssh-routes.ts). SSH failing too throws the first
 * failure, whose words (and card) are about https.
 */
async function orOverSsh<T>(dir: string, attempt: (pre: readonly string[]) => Promise<T>, remote = 'origin'): Promise<T> {
  try {
    return await attempt([]);
  } catch (err) {
    const raw = err instanceof PushError ? err.raw : err instanceof Error ? err.message : String(err);
    const kind = classifyGitError(raw);
    if (!kind || !SSH_MAY_HELP.has(kind)) throw err;
    const url = (await run('git', ['remote', 'get-url', remote], dir, 5000).catch(() => '')).trim();
    const ssh = sshArgsFor(url);
    if (!ssh) throw err;
    const out = await attempt(ssh).catch(() => {
      throw err;
    });
    rememberSshRoute(url, kind === 'https_broken');
    return out;
  }
}

async function pushOnce(dir: string, head: string, opts: { readonly https?: boolean; readonly pre?: readonly string[] }): Promise<'pushed' | 'replaced'> {
  // Over HTTPS with gh's login, this once (the SSH key isn't working): to origin's HTTPS address, origin itself unchanged.
  const url = opts.https ? httpsRemoteOf((await run('git', ['remote', 'get-url', 'origin'], dir, 5000)).trim()) : undefined;
  if (opts.https && !url) throw new Error('origin isn’t an SSH address Beluga can push to over HTTPS');
  const to = url ?? 'origin';
  const pre = url ? ghCredentials() : [...(opts.pre ?? [])];
  const push = (...args: string[]): Promise<string> => run('git', [...pre, 'push', ...(url ? [] : ['-u']), ...args, to, `${head}:${head}`], dir, 120_000);
  // Pushed to a URL, git doesn't move origin/<head> or set the upstream: do it, so the branch reads as pushed.
  const track = async (): Promise<void> => {
    if (!url) return;
    const sha = (await run('git', ['rev-parse', head], dir, 5000).catch(() => '')).trim();
    if (sha) await run('git', ['update-ref', `refs/remotes/origin/${head}`, sha], dir, 5000).catch(() => undefined);
    await run('git', ['branch', `--set-upstream-to=origin/${head}`, head], dir, 5000).catch(() => undefined);
  };
  try {
    await push();
    await track();
    return 'pushed';
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    if (!/non-fast-forward|\[rejected\]|fetch first/.test(why)) throw new PushError(pushWhy(why), why);
    const remote = (await run('git', [...pre, 'ls-remote', to, `refs/heads/${head}`], dir, 30_000).catch(() => '')).trim().split(/\s+/)[0];
    const last = await mergedHead(dir, head);
    if (!remote || !last || last !== remote) throw new Error(`GitHub has commits on ${head} that this worktree doesn’t: bring them in first (git pull), or check who pushed there`);
    await push(`--force-with-lease=${head}:${remote}`).catch((again: unknown) => {
      const raw = again instanceof Error ? again.message : String(again);
      throw new PushError(pushWhy(raw), raw);
    });
    await track();
    return 'replaced';
  }
}

export type BaseMergeResult = { readonly ok: true; readonly how: 'fast_forward' | 'merge_commit'; readonly sha: string } | { readonly ok: false; readonly reason: 'conflict'; readonly files: readonly string[] } | { readonly ok: false; readonly reason: 'moved' };

/**
 * Merge a worktree's branch straight into origin's `base`, with no pull request: the latest
 * origin/<base> is fetched, then fast-forwarded to `head` when it can be, or else a merge commit
 * (origin/<base> first, `head` second) is made with `git merge-tree`, so no checkout, not even the
 * main folder's, changes. Then it's pushed, never forced: someone pushing to `base` in between
 * ('moved') or a conflict leaves GitHub as it was.
 */
export async function mergeToBase(dir: string, head: string, base: string, opts: { readonly https?: boolean } = {}): Promise<BaseMergeResult> {
  return opts.https ? mergeToBaseOnce(dir, head, base, opts) : orOverSsh(dir, (pre) => mergeToBaseOnce(dir, head, base, { pre }));
}

async function mergeToBaseOnce(dir: string, head: string, base: string, opts: { readonly https?: boolean; readonly pre?: readonly string[] }): Promise<BaseMergeResult> {
  const url = opts.https ? httpsRemoteOf((await run('git', ['remote', 'get-url', 'origin'], dir, 5000)).trim()) : undefined;
  if (opts.https && !url) throw new Error('origin isn’t an SSH address Beluga can push to over HTTPS');
  const to = url ?? 'origin';
  const pre = url ? ghCredentials() : [...(opts.pre ?? [])];
  const tracking = `refs/remotes/origin/${base}`;
  try {
    await run('git', [...pre, 'fetch', to, `+refs/heads/${base}:${tracking}`], dir, 120_000);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new PushError(pushWhy(raw), raw);
  }
  const theirs = (await run('git', ['rev-parse', tracking], dir, 5000)).trim();
  const ours = (await run('git', ['rev-parse', head], dir, 5000)).trim();
  const ancestor = await run('git', ['merge-base', '--is-ancestor', theirs, ours], dir, 10_000).then(
    () => true,
    () => false,
  );
  let sha = ours;
  if (!ancestor) {
    const tree = await gitOut(['merge-tree', '--write-tree', '--name-only', '--no-messages', theirs, ours], dir);
    const [oid, ...files] = tree.stdout.split('\n').filter(Boolean);
    if (tree.code === 1) return { ok: false, reason: 'conflict', files };
    if (tree.code !== 0 || !oid) throw new Error(tree.stderr.trim() || 'git merge-tree failed');
    sha = (await run('git', ['commit-tree', oid, '-p', theirs, '-p', ours, '-m', `Merge branch '${head}' into ${base}`], dir, 10_000)).trim();
  }
  try {
    await run('git', [...pre, 'push', to, `${sha}:refs/heads/${base}`], dir, 120_000);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    if (/non-fast-forward|\[rejected\]|fetch first/.test(raw)) return { ok: false, reason: 'moved' };
    throw new PushError(pushWhy(raw), raw);
  }
  // So the branch reads as landed straight away, before the next fetch.
  await run('git', ['update-ref', tracking, sha], dir, 5000).catch(() => undefined);
  return { ok: true, how: ancestor ? 'fast_forward' : 'merge_commit', sha };
}

/** Run git and keep its exit code and both outputs (merge-tree says "conflicts" with exit 1 on stdout). */
const gitOut = (args: readonly string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile('git', [...args], { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...QUIET_ENV } }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr }));
  });

/** A failed push: git's reason in a line, and all it said (to tell SSH or login trouble from the rest). */
export class PushError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
  }
}

/** The head commit of the branch's last pull request, if it was merged (gh's newest PR for the branch). */
async function mergedHead(dir: string, head: string): Promise<string | undefined> {
  const out = await runGh(['pr', 'view', prOfBranch(dir, head), '--json', 'state,headRefOid'], dir, 20_000).catch(() => undefined);
  if (!out) return undefined;
  try {
    const pr = JSON.parse(out) as { state?: string; headRefOid?: string };
    return pr.state === 'MERGED' && typeof pr.headRefOid === 'string' ? pr.headRefOid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Why `git push` failed, in a line: the refusal ("! [rejected] … (non-fast-forward)") or the error
 * ("fatal: …", "error: …", "remote: …"), never "To https://…" or a hint.
 */
export function pushWhy(stderr: string): string {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  const refused = lines.find((l) => /^!\s*\[(remote )?rejected\]/.test(l));
  if (refused && /non-fast-forward|fetch first/.test(refused)) return 'GitHub’s copy of the branch has commits this worktree doesn’t (non-fast-forward)';
  const line = refused ?? lines.find((l) => /^(fatal|error|remote):/i.test(l) && !/failed to push some refs/.test(l)) ?? lines.find((l) => !/^(To |hint:)/.test(l)) ?? lines[0];
  return (line ?? 'git push failed').replace(/^!\s*/, '').slice(0, 300);
}

/**
 * How gh names a branch's pull request: the branch, or "owner:branch" when it went to a fork's
 * original (a PR from another repository is only found by its owner too).
 */
export function prHead(dir: string, branch: string): string {
  const origin = prTargetOf(dir, branch) ? originRepo(dir) : undefined;
  return origin ? `${origin.owner}:${branch}` : branch;
}

/** What `gh pr view` is given for a branch's pull request: its number when the branch follows one (a fork's), else prHead. */
function prOfBranch(dir: string, branch: string): string {
  return String(pullOfBranch(dir, branch) ?? prHead(dir, branch));
}

/**
 * Send the branch's pull request to `to` (a fork's original) from now on, or back to origin
 * (undefined): kept in the branch's git config, where every gh call about it looks (ghRepoEnv).
 */
export async function setPrTarget(dir: string, branch: string, to: Pick<GitHubRepo, 'host' | 'owner' | 'repo'> | undefined): Promise<void> {
  const key = `branch.${branch}.${PR_TARGET_KEY}`;
  if (to) await run('git', ['config', '--local', key, repoSlug(to)], dir, 5000);
  else if (prTargetOf(dir, branch)) await run('git', ['config', '--local', '--unset-all', key], dir, 5000);
}

/** The pull request for a branch, if there is one. Throws when gh couldn't tell (offline, rate limit…). */
export async function findPr(dir: string, branch: string): Promise<PullRequest | undefined> {
  if (!(await hasGh())) return undefined;
  try {
    return parsePr(await runGh(['pr', 'view', prOfBranch(dir, branch), '--json', PR_FIELDS], dir, 20_000));
  } catch (err) {
    if (err instanceof Error && /no pull requests? found/i.test(err.message)) return undefined;
    throw err;
  }
}

/**
 * The repository's recent pull requests (any state) by branch, in one call: cheaper than one
 * `gh pr view` per worktree. Throws when gh couldn't tell.
 */
export async function listPrs(dir: string): Promise<{ prs: Map<string, PullRequest>; full: boolean }> {
  if (!(await hasGh())) return { prs: new Map(), full: false };
  // Origin's, whatever the branch checked out in `dir` sends its own PR to (a PR on the original is looked up by itself).
  const out = await run(gh(), ['pr', 'list', '--state', 'all', '--limit', String(PR_LIST_LIMIT), '--json', `${PR_FIELDS},headRefName`], dir, 30_000, originRepoEnv(dir));
  const prs = parsePrList(out);
  if (!prs) throw new Error('gh pr list gave something unexpected');
  // A full page may have left out an older PR: those branches are looked up one by one.
  const count = (JSON.parse(out) as unknown[]).length;
  return { prs, full: count >= PR_LIST_LIMIT };
}

export type MergeMethod = 'squash' | 'merge' | 'rebase';

export interface MergeOptions {
  readonly method: MergeMethod;
  /** Merge once the required checks and reviews pass (GitHub's auto-merge), not now. */
  readonly auto?: boolean;
  /** Delete the branch on GitHub once merged (the worktree keeps its local branch). */
  readonly deleteBranch?: boolean;
  /** Merge now even though checks or reviews haven't passed (`gh pr merge --admin`: needs admin rights on the repository). */
  readonly admin?: boolean;
  /** Merge only if the pull request's head is still this commit (`gh pr merge --match-head-commit`): what was checked and reviewed. */
  readonly matchHead?: string;
}

/** Why GitHub said no to a merge. */
export type MergeProblem = 'conflicts' | 'reviews' | 'checks' | 'blocked' | 'auto_off' | 'method' | 'draft' | 'closed' | 'permission' | 'other';

const METHOD_NAME: Record<MergeMethod, string> = { squash: 'Squash merging', merge: 'Merge commits', rebase: 'Rebase merging' };

/** gh's error from `gh pr merge`, as what went wrong and what to do about it. */
export function explainMergeError(error: string, method: MergeMethod = 'squash'): { reason: MergeProblem; message: string } {
  const text = error.trim();
  const say = (reason: MergeProblem, message: string) => ({ reason, message });
  // --match-head-commit (BLG-840): the PR's head moved since Beluga looked, so GitHub merged nothing.
  if (/head branch was modified|head (commit|sha|ref).*(match|changed|modified)/i.test(text)) return say('other', 'The pull request changed on GitHub since Beluga looked (a new push), so nothing merged. Look at it again, then merge.');
  if (/conflict|cannot be cleanly created|mergeable state is dirty/i.test(text)) return say('conflicts', 'This branch conflicts with the base branch. Solve the conflict (or ask Claude to), push, then merge.');
  if (/auto.?merge.*(not allowed|disabled|not enabled|isn.t enabled)|enablePullRequestAutoMerge|auto merge is not allowed/i.test(text)) return say('auto_off', "Auto-merge is off for this repository. Turn on “Allow auto-merge” in its GitHub settings, or merge once the checks pass.");
  if (/draft/i.test(text)) return say('draft', 'This pull request is still a draft. Mark it ready for review on GitHub first.');
  if (/approv|review(s)? (is |are )?required|changes requested|review_required/i.test(text)) return say('reviews', 'GitHub needs an approving review before this can merge. Ask for one, or use “Merge When Checks Pass” to merge once it’s approved.');
  if (/status check|checks? (are |is )?(failing|pending|expected|in progress)|required check/i.test(text)) return say('checks', 'Required checks haven’t passed yet. Wait for them, or use “Merge When Checks Pass”.');
  if (/base branch policy|protected branch|branch protection|repository rule|not mergeable/i.test(text)) return say('blocked', 'The branch’s rules don’t allow merging yet (a review or checks are still needed). Use “Merge When Checks Pass” to merge once they’re met.');
  if (/not allowed|disabled|is not permitted/i.test(text) && /merge|squash|rebase/i.test(text)) return say('method', `${METHOD_NAME[method]} isn’t allowed on this repository. Pick another way to merge from the menu.`);
  if (/already (been )?merged|is closed|was closed|not open/i.test(text)) return say('closed', 'This pull request isn’t open anymore.');
  if (/permission|not authorized|forbidden|HTTP 403|must have (write|admin|push)/i.test(text)) return say('permission', 'Your GitHub account can’t merge into this repository.');
  return say('other', `GitHub didn’t merge it: ${text.split('\n').find((l) => l.trim())?.trim() ?? 'no reason given'}`);
}

/** Merge a pull request on GitHub (`gh pr merge`), or ask GitHub to once its requirements pass (`auto`), or now past them (`admin`). Throws gh's error. */
export async function mergePr(dir: string, number: number, opts: MergeOptions): Promise<void> {
  await runGh(mergeArgs(number, opts), dir, 60_000);
}

/** `gh pr merge`'s arguments. */
export function mergeArgs(number: number, opts: MergeOptions): string[] {
  return ['pr', 'merge', String(number), `--${opts.method}`, ...(opts.admin ? ['--admin'] : opts.auto ? ['--auto'] : []), ...(opts.matchHead ? ['--match-head-commit', opts.matchHead] : [])];
}

/** Turn off GitHub's auto-merge on a pull request (`gh pr merge --disable-auto`). Throws gh's error. */
export async function disableAutoMerge(dir: string, number: number): Promise<void> {
  await runGh(['pr', 'merge', String(number), '--disable-auto'], dir, 60_000);
}

/** A PR's one-click steps on GitHub: merge its base in (`gh pr update-branch`), or mark a draft ready for review. */
/** Run a workflow run's failed jobs again on the same commit (`gh run rerun <id> --failed`, see branch-state's failedRunIds). Throws gh's error. */
export async function rerunFailed(dir: string, runId: number): Promise<void> {
  await runGh(['run', 'rerun', String(runId), '--failed'], dir, 30_000);
}

export type PrStepKind = 'update_branch' | 'ready';

/** Take one of those steps. Throws gh's error. */
export async function prStep(dir: string, number: number, step: PrStepKind): Promise<void> {
  await runGh(step === 'ready' ? ['pr', 'ready', String(number)] : ['pr', 'update-branch', String(number)], dir, 60_000);
}

/**
 * Delete a merged branch on GitHub. Not gh's --delete-branch: that also deletes the local branch
 * and checks out the base, which a worktree can't (the base is checked out in the main folder).
 */
export async function deleteRemoteBranch(dir: string, branch: string, remote = 'origin'): Promise<void> {
  await orOverSsh(dir, (pre) => run('git', [...pre, 'push', remote, '--delete', branch], dir, 30_000), remote);
}

/**
 * What this computer last knew the branch to be on origin (its remote-tracking ref), read straight
 * from the repository without running git. It changes when the branch is pushed (or fetched after
 * someone else pushed): the moment a PR is worth looking at again.
 */
export function remoteRef(dir: string, branch: string, remote = 'origin'): string | undefined {
  const read = (file: string): string | undefined => {
    try {
      return readFileSync(file, 'utf8').trim() || undefined;
    } catch {
      return undefined;
    }
  };
  const common = gitCommonDir(dir);
  const name = `refs/remotes/${remote}/${branch}`;
  const loose = read(path.join(common, ...name.split('/')));
  if (loose) return loose;
  // `git gc` / `git pack-refs` moves refs into packed-refs: "<sha> <ref>" lines (^ lines peel tags).
  for (const line of read(path.join(common, 'packed-refs'))?.split('\n') ?? []) {
    const [sha, ref] = line.trim().split(' ');
    if (ref === name && sha && /^[0-9a-f]{40,64}$/.test(sha)) return sha;
  }
  return undefined;
}

/** "beluga/fix-login-redirect" → "Fix login redirect". */
export function titleOfBranch(branch: string): string {
  const words = (branch.split('/').pop() ?? branch).replace(/[-_]+/g, ' ').trim();
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : branch;
}

/**
 * A pull request's title and description without Claude, from the branch's commits (newest first,
 * as `git log` gives them): one commit is its subject, several are the branch's name with each listed.
 */
export function prFromCommits(branch: string, subjects: readonly string[]): { title: string; body: string } {
  const list = subjects.map((s) => s.trim()).filter(Boolean);
  if (list.length === 1) return { title: list[0]!, body: '' };
  return { title: titleOfBranch(branch), body: list.length ? list.reverse().map((s) => `- ${s}`).join('\n') : '' };
}

/** The subjects of the commits on HEAD that aren't in `base`, newest first. */
export async function commitSubjects(dir: string, base: string): Promise<string[]> {
  const out = await run('git', ['log', '--format=%s', `${base}..HEAD`], dir);
  return out.split('\n').filter((l) => l.trim());
}

/**
 * How many commits on HEAD the branch on origin doesn't have (what a merge on GitHub would leave
 * behind). 0 when git can't tell, so a hiccup never stands in the way of a merge.
 */
export async function unpushedCommits(dir: string, branch: string, remote = 'origin'): Promise<number> {
  try {
    return Number((await run('git', ['rev-list', '--count', `refs/remotes/${remote}/${branch}..HEAD`], dir)).trim()) || 0;
  } catch {
    return 0;
  }
}

/**
 * Whether a pull request's head (GitHub's headRefOid) holds every commit HEAD has (BLG-840): `carries`
 * true when it's HEAD or HEAD is in it (Update Branch merged the base in on GitHub), false when HEAD
 * has commits it doesn't, undefined when that head isn't a commit here (pushed from elsewhere) or
 * git can't tell. `head`: HEAD's commit.
 */
export async function headCarries(dir: string, prHead: string | undefined): Promise<{ readonly head?: string; readonly carries?: boolean }> {
  const head = (await run('git', ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], dir, 5000).catch(() => '')).trim() || undefined;
  if (!head || !prHead || !/^[0-9a-f]{7,64}$/i.test(prHead)) return head ? { head } : {};
  if (head === prHead) return { head, carries: true };
  const known = await run('git', ['cat-file', '-e', `${prHead}^{commit}`], dir, 5000).then(() => true, () => false);
  if (!known) return { head };
  const carries = await run('git', ['merge-base', '--is-ancestor', head, prHead], dir, 15_000).then(() => true, () => false);
  return { head, carries };
}

/**
 * Push `head` and open a pull request for it into `base` (a plan's branch → main) → the pull
 * request. `to`: into a fork's original instead (pushed to the fork, opened there as owner:branch);
 * without it the branch's PR goes to origin again.
 */
export async function createPr(dir: string, pr: { readonly base: string; readonly head: string; readonly title: string; readonly body: string; readonly draft?: boolean; readonly https?: boolean; readonly to?: Pick<GitHubRepo, 'host' | 'owner' | 'repo'> }): Promise<PullRequest> {
  const state = await ghState();
  if (state === 'missing') throw new Error('The GitHub CLI (gh) isn’t installed');
  if (state === 'logged_out') throw new Error('The GitHub CLI isn’t logged in: gh auth login');
  if (pr.to && !originRepo(dir)) throw new Error('origin isn’t on GitHub, so there’s no fork to open it from');
  await pushForPr(dir, pr.head, pr.https ? { https: true } : {});
  await setPrTarget(dir, pr.head, pr.to);
  const existing = await findPr(dir, pr.head).catch(() => undefined);
  if (existing?.state === 'OPEN') return existing;
  await runGh(['pr', 'create', '--base', pr.base, '--head', prHead(dir, pr.head), '--title', pr.title, '--body', pr.body, ...(pr.draft ? ['--draft'] : [])], dir, 60_000);
  const made = await findPr(dir, pr.head);
  if (!made) throw new Error('GitHub didn’t show the new pull request');
  return made;
}
