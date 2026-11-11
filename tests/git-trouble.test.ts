import { describe, expect, it, vi } from 'vitest';
import { type GitSetup, classifyGitError, explainGitTrouble, httpsRemoteOf, isSshRemote, troubleLine } from '../src/shared/git-trouble.js';
import { findTool, toolCommand } from '../src/workspaces/pr.js';
import { Store, initialState } from '../src/core/store.js';
import type { PullRequest } from '../src/core/work-store.js';
import type { WorkspaceController } from '../src/core/workspace-controller.js';
import { Workbench } from '../src/core/workbench.js';

/**
 * BLG-213: Create PR with an SSH remote said "fatal: Could not read from remote repository." and
 * nothing else. What git and gh say when the way to GitHub is the problem, as plain words and fixes.
 */

const SSH_DENIED = 'git@github.com: Permission denied (publickey).\r\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.';

describe('classifyGitError', () => {
  const cases: Array<[string, ReturnType<typeof classifyGitError>]> = [
    [SSH_DENIED, 'ssh_denied'],
    ['fatal: Could not read from remote repository.', 'ssh_denied'],
    ['sign_and_send_pubkey: signing failed for ED25519 "/Users/a/.ssh/id_ed25519" from agent: agent refused operation', 'ssh_denied'],
    ['Host key verification failed.\nfatal: Could not read from remote repository.', 'host_key'],
    ['@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @', 'host_key'],
    ['ERROR: Repository not found.\nfatal: Could not read from remote repository.', 'no_access'],
    ["remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found", 'no_access'],
    ["remote: Permission to o/r.git denied to someone.\nfatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403", 'no_access'],
    ["fatal: Authentication failed for 'https://github.com/o/r.git/'", 'https_auth'],
    ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", 'https_auth'],
    ["remote: Support for password authentication was removed on August 13, 2021.\nfatal: Authentication failed for 'https://github.com/o/r.git/'", 'https_auth'],
    ['spawn gh ENOENT', 'gh_missing'],
    ['The GitHub CLI (gh) isn’t installed', 'gh_missing'],
    ['To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.', 'gh_logged_out'],
    ['You are not logged into any GitHub hosts. To log in, run: gh auth login', 'gh_logged_out'],
    ['HTTP 401: Bad credentials (https://api.github.com/graphql)', 'gh_logged_out'],
    ["fatal: 'origin' does not appear to be a git repository\nfatal: Could not read from remote repository.", 'no_remote'],
    ['fatal: No configured push destination.', 'no_remote'],
    ['none of the git remotes configured for this repository point to a known GitHub host', 'no_remote'],
    ['ssh: Could not resolve hostname github.com: nodename nor servname provided, or not known\nfatal: Could not read from remote repository.', 'offline'],
    ['ssh: connect to host github.com port 22: Operation timed out\nfatal: Could not read from remote repository.', 'offline'],
    ["fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com", 'offline'],
    ['error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com', 'offline'],
    // Not trouble reaching GitHub: left to the other explanations.
    ['! [rejected]        feat -> feat (non-fast-forward)', undefined],
    ['X Pull request #42 is not mergeable: the merge commit cannot be cleanly created.', undefined],
    ['GraphQL: At least 1 approving review is required by reviewers with write access.', undefined],
  ];
  it.each(cases)('%s → %s', (text, kind) => expect(classifyGitError(text)).toBe(kind));
});

describe('SSH remotes', () => {
  it('turns GitHub SSH addresses into HTTPS ones', () => {
    expect(httpsRemoteOf('git@github.com:me/app.git')).toBe('https://github.com/me/app.git');
    expect(httpsRemoteOf('git@github.com:me/app')).toBe('https://github.com/me/app.git');
    expect(httpsRemoteOf('ssh://git@github.com/me/app.git')).toBe('https://github.com/me/app.git');
    expect(httpsRemoteOf('ssh://git@ssh.github.com:443/me/app.git')).toBe('https://github.com/me/app.git');
    expect(httpsRemoteOf('git@ghe.corp.com:team/app.git')).toBe('https://ghe.corp.com/team/app.git');
  });
  it('leaves host aliases and HTTPS remotes alone', () => {
    expect(httpsRemoteOf('git@github-work:me/app.git')).toBeUndefined();
    expect(httpsRemoteOf('https://github.com/me/app.git')).toBeUndefined();
    expect(httpsRemoteOf(undefined)).toBeUndefined();
    expect(isSshRemote('https://github.com/me/app.git')).toBe(false);
    expect(isSshRemote('git@github.com:me/app.git')).toBe(true);
  });
});

describe('explainGitTrouble', () => {
  const ssh = 'git@github.com:me/app.git';
  const ids = (raw: string, setup: GitSetup): string[] => explainGitTrouble(raw, setup)!.fixes.map((f) => f.id);

  it("SSH key refused, gh logged in: push over HTTPS this once (the remote isn't changed without asking)", () => {
    const t = explainGitTrouble(SSH_DENIED, { gh: 'ok', remote: ssh })!;
    expect(t.title).toBe('GitHub didn’t accept this Mac’s SSH key');
    expect(t.fixes[0]).toMatchObject({ id: 'push_https', label: 'Push over HTTPS' });
    expect(t.fixes.map((f) => f.id)).toEqual(['push_https', 'use_https', 'add_ssh_key', 'link', 'retry']);
    expect(t.fixes.find((f) => f.id === 'use_https')?.detail).toContain('https://github.com/me/app.git');
    expect(t.fixes.find((f) => f.id === 'add_ssh_key')?.command).toMatch(/gh auth refresh .*admin:public_key.*gh ssh-key add ~\/\.ssh\/id_ed25519\.pub/);
    expect(t.raw).toContain('Permission denied (publickey)');
  });

  it('SSH key refused, gh logged out: log in first (then HTTPS)', () => {
    const t = explainGitTrouble(SSH_DENIED, { gh: 'logged_out', remote: ssh })!;
    expect(t.fixes[0]).toMatchObject({ id: 'gh_login', command: 'gh auth login --web --git-protocol https --hostname github.com' });
    expect(t.fixes[0]!.detail).toMatch(/HTTPS/);
  });

  it('SSH key refused, no gh: install it with Homebrew when there is one, else the download page', () => {
    const brew = explainGitTrouble(SSH_DENIED, { gh: 'missing', brew: '/opt/homebrew/bin', remote: ssh })!;
    expect(brew.fixes[0]).toMatchObject({ id: 'install_gh', command: '/opt/homebrew/bin/brew install gh && /opt/homebrew/bin/gh auth login --web --git-protocol https --hostname github.com' });
    const none = explainGitTrouble(SSH_DENIED, { gh: 'missing', remote: ssh })!;
    expect(none.fixes[0]).toMatchObject({ id: 'link', url: 'https://cli.github.com' });
    // The SSH guide once, not twice.
    expect(brew.fixes.map((f) => f.label)).toEqual(['Install GitHub CLI', 'GitHub’s SSH Guide', 'Try Again']);
    expect(explainGitTrouble(SSH_DENIED, { gh: 'unknown', remote: ssh })!.fixes.filter((f) => f.id === 'link')).toHaveLength(1);
  });

  it('a host alias has no HTTPS route to offer: the SSH key is the fix', () => {
    expect(ids(SSH_DENIED, { gh: 'ok', remote: 'git@github-work:me/app.git' })).toEqual(['add_ssh_key', 'link', 'retry']);
  });

  it('host key: check the fingerprint in the terminal, or HTTPS', () => {
    const t = explainGitTrouble('Host key verification failed.', { gh: 'ok', remote: ssh })!;
    expect(t.kind).toBe('host_key');
    expect(t.fixes.map((f) => f.id)).toEqual(['push_https', 'use_https', 'check_host', 'link', 'retry']);
    expect(t.fixes.find((f) => f.id === 'check_host')?.command).toBe('ssh -T git@github.com');
  });

  it('not found while logged out: log in; while logged in: another account', () => {
    expect(ids('ERROR: Repository not found.', { gh: 'logged_out', remote: 'https://github.com/o/r.git' })[0]).toBe('gh_login');
    const t = explainGitTrouble('ERROR: Repository not found.', { gh: 'ok', remote: 'https://github.com/o/r.git' })!;
    expect(t.title).toBe('Your GitHub account can’t see this repository');
    expect(t.fixes[0]).toMatchObject({ id: 'gh_login', label: 'Log In With Another Account' });
  });

  it('HTTPS login missing: push with gh’s login, or set gh up first', () => {
    const raw = "fatal: could not read Username for 'https://github.com': terminal prompts disabled";
    expect(ids(raw, { gh: 'ok', remote: 'https://github.com/o/r.git' })).toEqual(['push_https', 'gh_login', 'retry']);
    expect(ids(raw, { gh: 'logged_out' })[0]).toBe('gh_login');
  });

  it('gh missing or logged out, no remote, offline', () => {
    expect(explainGitTrouble('spawn gh ENOENT', { gh: 'missing', brew: '/usr/local/bin' })!.fixes[0]!.id).toBe('install_gh');
    expect(explainGitTrouble('To get started with GitHub CLI, please run:  gh auth login', { gh: 'logged_out', ghCommand: '/opt/homebrew/bin/gh' })!.fixes[0]!.command).toBe('/opt/homebrew/bin/gh auth login --web --git-protocol https --hostname github.com');
    expect(explainGitTrouble('fatal: No configured push destination.')!.title).toBe('This project isn’t on GitHub yet');
    const off = explainGitTrouble('ssh: connect to host github.com port 22: Operation timed out', { gh: 'ok', remote: ssh })!;
    expect(off.fixes.map((f) => f.id)).toEqual(['retry', 'push_https']);
    expect(troubleLine(off)).toBe('Couldn’t reach GitHub. See how to fix it in Beluga on your Mac.');
    expect(troubleLine(explainGitTrouble('Could not resolve host: github.com')!)).toBe('Couldn’t reach GitHub. Try again in a moment.');
  });

  it('https helper broken: add an SSH key (Beluga goes over SSH by itself then), or GitHub’s guide', () => {
    const raw = "git-remote-https: symbol lookup error: /lib/x86_64-linux-gnu/libcurl.so.4: undefined symbol: nghttp2_option_set_no_rfc9113_leading_and_trailing_ws_validation\nfatal: remote helper 'https' aborted session";
    expect(classifyGitError(raw)).toBe('https_broken');
    const https = 'https://github.com/me/app.git';
    expect(explainGitTrouble(raw, { gh: 'ok', remote: https })!.fixes.map((f) => f.id)).toEqual(['add_ssh_key', 'link', 'retry']);
    expect(explainGitTrouble(raw, { gh: 'logged_out', remote: https })!.fixes.map((f) => f.id)).toEqual(['link', 'retry']);
    expect(explainGitTrouble(raw, { gh: 'ok', remote: https })!.title).toBe('git can’t use https on this computer');
  });

  it('every fix has a label and a line; links have a page and terminal steps a command', () => {
    const raws = [SSH_DENIED, 'Host key verification failed.', 'Repository not found', 'Authentication failed for x', "fatal: remote helper 'https' aborted session", 'spawn gh ENOENT', 'gh auth login', 'No such remote', 'Could not resolve host'];
    const setups: GitSetup[] = [{ gh: 'ok', remote: ssh }, { gh: 'logged_out', remote: ssh }, { gh: 'missing', brew: '/opt/homebrew/bin' }, { gh: 'missing' }, { gh: 'unknown' }];
    for (const raw of raws)
      for (const setup of setups) {
        const t = explainGitTrouble(raw, setup)!;
        expect(t.fixes.length).toBeGreaterThan(0);
        for (const f of t.fixes) {
          expect(f.label && f.detail).toBeTruthy();
          if (f.id === 'link') expect(f.url).toMatch(/^https:\/\//);
          if (['install_gh', 'gh_login', 'add_ssh_key', 'check_host'].includes(f.id)) expect(f.command).toBeTruthy();
        }
      }
  });
});

describe('finding gh from a Mac app (a minimal PATH)', () => {
  const has = (files: string[]) => (f: string) => files.includes(f);
  // Not on Windows: Homebrew is a Mac's.
  it.skipIf(process.platform === 'win32')('looks in Homebrew’s folders when PATH has no gh', () => {
    expect(findTool('gh', '/usr/bin:/bin', has(['/opt/homebrew/bin/gh']))).toBe('/opt/homebrew/bin/gh');
    expect(findTool('gh', '/usr/bin:/bin', has(['/usr/local/bin/gh']))).toBe('/usr/local/bin/gh');
    expect(findTool('gh', '/usr/bin:/bin', has([]))).toBeUndefined();
  });
  // Not on Windows: Homebrew is a Mac's.
  it.skipIf(process.platform === 'win32')('runs it by name when PATH has it, by full path when only Homebrew has it', () => {
    expect(toolCommand('gh', '/opt/homebrew/bin:/usr/bin', has(['/opt/homebrew/bin/gh']))).toBe('gh');
    expect(toolCommand('gh', '/usr/bin:/bin', has(['/opt/homebrew/bin/gh']))).toBe('/opt/homebrew/bin/gh');
    expect(toolCommand('gh', '/usr/bin:/bin', has([]))).toBe('gh');
  });
});

describe('Create PR when the SSH key is refused (Workbench)', () => {
  const pr = (more: Partial<PullRequest> = {}): PullRequest => ({ number: 9, url: 'https://github.com/me/app/pull/9', state: 'OPEN', title: 'Add auth', draft: false, checks: 'none', ...more });
  const make = () => {
    const store = new Store(initialState('t', 'ask'));
    const ws = { id: 'auth', name: 'auth', kind: 'worktree', branch: 'beluga/add-auth', base: 'origin/main', path: '/code/auth', projectId: 'p1', status: { changed: 0, ahead: 1, behind: 0 } };
    const manager = { list: [{ id: 'p1', workspaces: [ws] }], find: (id: string) => (id === ws.id ? ws : undefined), commitAll: vi.fn() };
    const calls: Array<{ https?: boolean }> = [];
    const toasts: string[] = [];
    const useHttpsRemote = vi.fn(async () => ({ from: 'git@github.com:me/app.git', to: 'https://github.com/me/app.git' }));
    const wb = new Workbench({
      store,
      controller: { manager, refresh: async () => undefined, open: () => undefined } as unknown as WorkspaceController,
      notify: () => undefined,
      toast: (t) => void toasts.push(t),
      intend: () => undefined,
      askClaude: () => undefined,
      setPrefs: () => undefined,
      remoteRef: () => undefined,
      gitSetup: async () => ({ gh: 'ok', remote: 'git@github.com:me/app.git' }),
      useHttpsRemote,
      createPr: async (_dir, p) => {
        calls.push(p);
        if (!p.https) throw Object.assign(new Error('git@github.com: Permission denied (publickey).'), { raw: SSH_DENIED });
        return pr();
      },
    });
    store.dispatch({ type: 'gh', ok: true });
    return { wb, calls, toasts, useHttpsRemote };
  };

  it('says what happened in plain words, with the fixes, instead of git’s line', async () => {
    const { wb, toasts } = make();
    const out = await wb.quickPr('auth');
    expect(out.ok).toBe(false);
    expect(out.trouble?.kind).toBe('ssh_denied');
    expect(out.trouble?.fixes[0]?.id).toBe('push_https');
    expect(out.message).toBe('GitHub didn’t accept this Mac’s SSH key. See how to fix it in Beluga on your Mac.');
    expect(toasts.at(-1)).toBe('GitHub didn’t accept this Mac’s SSH key');
  });

  it('Push over HTTPS opens it with gh’s login, origin untouched', async () => {
    const { wb, calls, useHttpsRemote } = make();
    await wb.quickPr('auth');
    expect(await wb.gitFix('auth', 'push_https', 'pr')).toMatchObject({ ok: true, message: 'Opened PR #9: Add auth' });
    expect(calls.at(-1)?.https).toBe(true);
    expect(useHttpsRemote).not.toHaveBeenCalled();
  });

  it('Always Use HTTPS switches origin (after the Mac asked), then opens it', async () => {
    const { wb, useHttpsRemote, toasts } = make();
    await wb.gitFix('auth', 'use_https', 'pr');
    expect(useHttpsRemote).toHaveBeenCalledWith('/code/auth');
    expect(toasts).toContain('origin is https://github.com/me/app.git now (it was git@github.com:me/app.git)');
  });
});
