/**
 * When a push or a GitHub step fails because of how this Mac reaches GitHub (an SSH key GitHub
 * doesn't know, the GitHub CLI missing or logged out, no network…), what it means in plain words
 * and what can fix it (BLG-213). Pure and browser-safe: the daemon classifies, the Mac shows the
 * card, the phone shows the sentence.
 */

/** What went wrong, from git's or gh's own words. */
export type GitTroubleKind =
  /** SSH: GitHub didn't accept this Mac's key ("Permission denied (publickey)", "Could not read from remote repository"). */
  | 'ssh_denied'
  /** SSH: this Mac hasn't met GitHub's server yet, or its fingerprint changed. */
  | 'host_key'
  /** GitHub says the repository isn't there: your account can't see it, or you aren't logged in. */
  | 'no_access'
  /** HTTPS: git has no login for GitHub (or an old password). */
  | 'https_auth'
  /** HTTPS: git's https helper itself fails on this computer (mismatched libcurl and its libraries), whatever the login. */
  | 'https_broken'
  /** The GitHub CLI (gh) isn't installed. */
  | 'gh_missing'
  /** The GitHub CLI is installed but not logged in. */
  | 'gh_logged_out'
  /** The project has no GitHub remote to push to. */
  | 'no_remote'
  /** GitHub couldn't be reached at all. */
  | 'offline';

/**
 * A fix the card offers. `push_https`: this one push over HTTPS with gh's login (the remote stays
 * as it is). `use_https`: switch the project's origin to HTTPS for good (asked first). `install_gh`,
 * `gh_login`, `add_ssh_key`, `check_host`: run in Beluga's terminal, so you see it. `retry`: try again.
 * `link`: a page that explains it.
 */
export type GitFixId = 'push_https' | 'use_https' | 'install_gh' | 'gh_login' | 'add_ssh_key' | 'check_host' | 'retry' | 'link';

export interface GitFix {
  readonly id: GitFixId;
  readonly label: string;
  /** One line under it: what it does. */
  readonly detail: string;
  /** `link`: the page. */
  readonly url?: string;
  /** What it types in the terminal, shown as it is. */
  readonly command?: string;
}

export interface GitTrouble {
  readonly kind: GitTroubleKind;
  /** A short, plain title ("GitHub didn’t accept this Mac’s SSH key"). */
  readonly title: string;
  /** What it means, in a sentence or two. */
  readonly explain: string;
  /** The first is the main action; the rest go behind •••. */
  readonly fixes: readonly GitFix[];
  /** git's or gh's own words, for Details. */
  readonly raw: string;
}

/** What Beluga knows about this Mac's GitHub setup, to pick the fixes that can work. */
export interface GitSetup {
  /** The GitHub CLI: missing, installed but logged out, logged in, or not known. */
  readonly gh: 'ok' | 'logged_out' | 'missing' | 'unknown';
  /** Homebrew is here (so gh can be installed in one step); its bin folder. */
  readonly brew?: string;
  /** The gh to type in the terminal (its full path when it isn't on the usual PATH). */
  readonly ghCommand?: string;
  /** The origin remote's URL. */
  readonly remote?: string;
}

const GH_CLI_URL = 'https://cli.github.com';
const SSH_DOCS = 'https://docs.github.com/en/authentication/connecting-to-github-with-ssh/adding-a-new-ssh-key-to-your-github-account';
const HOST_KEYS_URL = 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints';
const ACCESS_DOCS = 'https://docs.github.com/en/repositories/creating-and-managing-repositories/troubleshooting-cloning-errors#error-repository-not-found';
const REMOTE_DOCS = 'https://docs.github.com/en/get-started/getting-started-with-git/managing-remote-repositories';

/**
 * git-remote-https crashed or couldn't load: libcurl and its libraries don't match (an AppImage's
 * LD_LIBRARY_PATH, a half-done upgrade). git then only says "remote helper 'https' aborted session".
 */
export const HTTPS_BROKEN = /remote helper '?https?'? aborted session|symbol lookup error|undefined symbol: \w*(nghttp2|curl)|(libcurl|libnghttp2)[\w.-]*: (cannot open|version)|git-remote-https: error while loading/i;

/** In the order they're checked: a message can match several (SSH ends every refusal with "Could not read from remote repository"). */
const PATTERNS: ReadonlyArray<readonly [GitTroubleKind, RegExp]> = [
  ['https_broken', HTTPS_BROKEN],
  ['gh_missing', /spawn \S*\bgh ENOENT|gh: command not found|command not found: gh|GitHub CLI \(gh\) isn.t installed/i],
  ['gh_logged_out', /gh auth login|To get started with GitHub CLI, please run|not logged in(to)? (to )?any (GitHub )?hosts?|You are not logged into any GitHub hosts|token .*(is )?(invalid|expired)|HTTP 401|Bad credentials/i],
  ['no_remote', /'[^']*' does not appear to be a git repository|No such remote|No configured push destination|no git remotes found|none of the git remotes configured for this repository point to a known GitHub host/i],
  ['offline', /Could not resolve host|Could not resolve hostname|Network is unreachable|Operation timed out|Connection timed out|Connection refused|ssh: connect to host \S+ port \d+|Failed to connect to|error connecting to (api\.)?github\.com|dial tcp|no such host|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN/i],
  ['host_key', /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|authenticity of host .* can.t be established|No ED25519 host key is known|host key for \S+ has changed/i],
  ['no_access', /Repository not found|Permission to \S+ denied to|HTTP 404|requested URL returned error: 40[34]|Could not resolve to a Repository/i],
  ['https_auth', /Authentication failed for|could not read (Username|Password)|terminal prompts disabled|Invalid username or (password|token)|Support for password authentication was removed|HTTP Basic: Access denied|returned error: 401/i],
  ['ssh_denied', /Permission denied \((publickey|keyboard-interactive)|sign_and_send_pubkey|no mutual signature|Load key .*: (invalid format|bad permissions)|Could not read from remote repository|git@[^:\s]+: Permission denied/i],
];

/** Which kind of trouble git's or gh's words are, or undefined when it's something else (a conflict, a rule…). */
export function classifyGitError(text: string): GitTroubleKind | undefined {
  return PATTERNS.find(([, re]) => re.test(text))?.[0];
}

/** An SSH remote ("git@github.com:me/app.git", "ssh://git@github.com/me/app"). */
export function isSshRemote(url: string | undefined): boolean {
  if (!url) return false;
  return /^ssh:\/\//i.test(url) || /^[\w.-]+@[\w.-]+:/.test(url);
}

/**
 * The HTTPS address of an SSH remote on GitHub (or GitHub Enterprise): "git@github.com:me/app.git"
 * → "https://github.com/me/app.git". Undefined for a host alias from ~/.ssh/config ("github-work"),
 * whose real host Beluga can't know, and for remotes that are already HTTPS.
 */
export function httpsRemoteOf(url: string | undefined): string | undefined {
  if (!url || !isSshRemote(url)) return undefined;
  const m = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(url) ?? /^[^@]+@([^:]+):\/?(.+)$/.exec(url);
  if (!m) return undefined;
  const host = m[1]!.toLowerCase() === 'ssh.github.com' ? 'github.com' : m[1]!.toLowerCase();
  if (!host.includes('.')) return undefined;
  const repo = m[2]!.replace(/\/+$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo.replace(/\.git$/, ''))) return undefined;
  return `https://${host}/${repo.endsWith('.git') ? repo : `${repo}.git`}`;
}

/** An https address on a host everyone reaches over SSH as git@host (GitHub, GitLab, Bitbucket). */
const SSH_HOST = /^https?:\/\/(?:[^@/\s]+@)?(github\.com|gitlab\.com|bitbucket\.org)\/(.*)$/i;

/**
 * The SSH address of an https remote on GitHub, GitLab or Bitbucket, with the https prefix it
 * stands for: "https://github.com/me/app.git" → git@github.com:me/app.git, and the prefixes for the
 * whole host ("https://github.com/" → "git@github.com:"). Undefined for any other address.
 */
export function sshRemoteOf(url: string | undefined): { readonly url: string; readonly host: { readonly https: string; readonly ssh: string } } | undefined {
  const m = url ? SSH_HOST.exec(url.trim()) : null;
  if (!m) return undefined;
  const https = url!.trim().slice(0, url!.trim().length - m[2]!.length);
  const ssh = `git@${m[1]!.toLowerCase()}:`;
  return { url: `${ssh}${m[2]}`, host: { https, ssh } };
}

/** The host of a remote ("github.com"), for the sentences. */
export function remoteHost(url: string | undefined): string {
  if (!url) return 'github.com';
  const m = /^[a-z]+:\/\/(?:[^@/]+@)?([^/:]+)/i.exec(url) ?? /^[^@]+@([^:]+):/.exec(url);
  return m?.[1]?.toLowerCase() ?? 'github.com';
}

/** Where a key lives, for the SSH fix. */
const SSH_KEY = '~/.ssh/id_ed25519';

/** The fixes that set gh up, when it isn't (install it, or log in): undefined once it's logged in. */
function ghSetupFix(setup: GitSetup, then: string): GitFix | undefined {
  const gh = setup.ghCommand ?? 'gh';
  if (setup.gh === 'missing') {
    if (setup.brew) {
      const brew = `${setup.brew}/brew`;
      return { id: 'install_gh', label: 'Install GitHub CLI', detail: `Installs GitHub’s own tool with Homebrew, then opens github.com so you can log in. ${then}`, command: `${brew} install gh && ${setup.brew}/gh auth login --web --git-protocol https --hostname ${remoteHost(setup.remote)}` };
    }
    return { id: 'link', label: 'Get GitHub CLI', detail: 'Download GitHub’s own tool, open it once, then try again.', url: GH_CLI_URL };
  }
  if (setup.gh === 'logged_out') return { id: 'gh_login', label: 'Log In to GitHub', detail: `Opens github.com in your browser to log in. ${then}`, command: `${gh} auth login --web --git-protocol https --hostname ${remoteHost(setup.remote)}` };
  return undefined;
}

const retry: GitFix = { id: 'retry', label: 'Try Again', detail: 'Run it again as it is.' };

/**
 * git's or gh's error as a card: a plain title, what it means, and the fixes that can work with
 * this Mac's setup (the first is the main action). Undefined when it isn't trouble reaching GitHub.
 */
export function explainGitTrouble(raw: string, setup: GitSetup = { gh: 'unknown' }): GitTrouble | undefined {
  const kind = classifyGitError(raw);
  if (!kind) return undefined;
  const ssh = isSshRemote(setup.remote);
  const https = httpsRemoteOf(setup.remote);
  const host = remoteHost(setup.remote);
  const gh = setup.ghCommand ?? 'gh';
  const pushHttps: GitFix | undefined = ssh && https ? { id: 'push_https', label: 'Push over HTTPS', detail: `Pushes this once with your GitHub CLI login instead of SSH. Your remote stays as it is.` } : undefined;
  const useHttps: GitFix | undefined = ssh && https ? { id: 'use_https', label: 'Always Use HTTPS for This Project…', detail: `Changes origin to ${https} (asks first). You can change it back any time.` } : undefined;
  const thenHttps = 'Then Beluga pushes over HTTPS with that login.';
  const thenRetry = 'Then Beluga tries again.';
  const addSshKey: GitFix = { id: 'add_ssh_key', label: 'Add an SSH Key to GitHub', detail: `Makes a key on this Mac if there isn’t one (${SSH_KEY}: it asks for an optional passphrase) and adds it to your GitHub account, in the terminal.`, command: `${gh} auth refresh --hostname ${host} --scopes admin:public_key && { [ -f ${SSH_KEY}.pub ] || ssh-keygen -t ed25519 -f ${SSH_KEY}; } && ${gh} ssh-key add ${SSH_KEY}.pub --title "Beluga on $(scutil --get ComputerName 2>/dev/null || hostname)"` };
  const sshGuide: GitFix = { id: 'link', label: 'GitHub’s SSH Guide', detail: 'Making a key and adding it to your account.', url: SSH_DOCS };
  // Each fix once (two routes can land on the same page).
  const out = (title: string, explain: string, fixes: ReadonlyArray<GitFix | undefined>): GitTrouble => ({ kind, title, explain, fixes: fixes.filter((f, i, all): f is GitFix => Boolean(f) && all.findIndex((g) => g && (g.id === 'link' ? g.url === f!.url : g.id === f!.id)) === i), raw: raw.trim() });

  switch (kind) {
    case 'ssh_denied':
    case 'host_key': {
      const hostKey = kind === 'host_key';
      const title = hostKey ? `This Mac hasn’t met ${host} over SSH yet` : `${host === 'github.com' ? 'GitHub' : host} didn’t accept this Mac’s SSH key`;
      const explain = hostKey
        ? `Your project talks to ${host} over SSH, and SSH wants you to confirm it’s really ${host} the first time (or its fingerprint changed). The easiest way around it is HTTPS with your GitHub login.`
        : `Your project pushes over SSH, which needs a key on this Mac that your GitHub account knows. There isn’t one yet (or SSH can’t reach it). The easiest way around it is HTTPS with your GitHub login.`;
      const sshFix: GitFix = hostKey
        ? { id: 'check_host', label: `Check ${host}’s Fingerprint`, detail: `Connects once in the terminal so you can compare the fingerprint with GitHub’s list and accept it.`, command: `ssh -T git@${host}` }
        : setup.gh === 'ok'
          ? addSshKey
          : { id: 'link', label: 'How SSH Keys Work', detail: 'GitHub’s guide to making a key and adding it to your account.', url: SSH_DOCS };
      const docs: GitFix = hostKey ? { id: 'link', label: 'GitHub’s Fingerprints', detail: 'The fingerprints to compare with.', url: HOST_KEYS_URL } : sshGuide;
      // gh logged in: HTTPS works right away. Otherwise gh comes first (and HTTPS after it).
      const setupGh = ghSetupFix(setup, pushHttps ? thenHttps : thenRetry);
      return out(title, explain, setupGh ? [setupGh, ...(hostKey ? [sshFix] : []), docs, retry] : [pushHttps ?? sshFix, useHttps, ...(pushHttps ? [sshFix] : []), docs, retry]);
    }
    case 'no_access': {
      const setupGh = ghSetupFix(setup, thenRetry);
      if (setupGh) return out('GitHub can’t find this repository for you', `GitHub says the repository isn’t there, which is what it says when you aren’t logged in, or your account can’t see it. Log in with the account that has access.`, [setupGh, pushHttps, { id: 'link', label: 'Why GitHub Says “Not Found”', detail: 'GitHub’s guide to this error.', url: ACCESS_DOCS }, retry]);
      return out('Your GitHub account can’t see this repository', `GitHub says the repository isn’t there for the account you’re logged in with. Ask its owner to add you, or log in with the account that has access.`, [
        ssh ? pushHttps : undefined,
        { id: 'gh_login', label: 'Log In With Another Account', detail: `Opens github.com in your browser to log in. ${thenRetry}`, command: `${gh} auth login --web --git-protocol https --hostname ${host}` },
        { id: 'link', label: 'Why GitHub Says “Not Found”', detail: 'GitHub’s guide to this error.', url: ACCESS_DOCS },
        retry,
      ]);
    }
    case 'https_auth': {
      const setupGh = ghSetupFix(setup, thenRetry);
      return out(`git isn’t logged in to ${host === 'github.com' ? 'GitHub' : host}`, `Your project pushes over HTTPS, and git has no GitHub login on this Mac (or an old password, which GitHub stopped taking). Your GitHub CLI login can do it.`, [
        setupGh ?? { id: 'push_https', label: 'Push With Your GitHub Login', detail: 'Pushes with your GitHub CLI login. Nothing else changes.' },
        setupGh ? undefined : { id: 'gh_login', label: 'Log In Again', detail: `Opens github.com in your browser to log in. ${thenRetry}`, command: `${gh} auth login --web --git-protocol https --hostname ${host}` },
        retry,
      ]);
    }
    case 'https_broken': {
      // Beluga already tried SSH (workspaces/ssh-routes.ts): it didn't get in, or there's no SSH address for this host.
      const account = host === 'github.com' ? 'GitHub' : host;
      return out(`git can’t use https on this computer`, `git’s https helper fails here (its libraries don’t match: updating git usually fixes it), and Beluga couldn’t get in over SSH instead. With an SSH key your ${account} account knows, Beluga goes over SSH by itself.`, [
        setup.gh === 'ok' && host === 'github.com' ? addSshKey : sshGuide,
        sshGuide,
        retry,
      ]);
    }
    case 'gh_missing':
      return out('The GitHub CLI isn’t on this Mac', 'Beluga opens pull requests and merges with GitHub’s own command-line tool (gh). It takes a minute to set up, once.', [ghSetupFix({ ...setup, gh: 'missing' }, thenRetry), setup.brew ? { id: 'link', label: 'About GitHub CLI', detail: 'GitHub’s page for it.', url: GH_CLI_URL } : undefined, retry]);
    case 'gh_logged_out':
      return out('The GitHub CLI isn’t logged in', 'Beluga opens pull requests and merges with GitHub’s own command-line tool, and it needs your GitHub login (once).', [ghSetupFix({ ...setup, gh: setup.gh === 'missing' ? 'missing' : 'logged_out' }, thenRetry), retry]);
    case 'no_remote':
      return out('This project isn’t on GitHub yet', 'There’s no GitHub repository to push to: the project has no “origin” remote. Add one (or publish the project on GitHub), then try again.', [{ id: 'link', label: 'How Remotes Work', detail: 'GitHub’s guide to adding a remote.', url: REMOTE_DOCS }, retry]);
    case 'offline':
      return out(`Couldn’t reach ${host === 'github.com' ? 'GitHub' : host}`, ssh ? 'This Mac couldn’t connect. Check your internet connection. Some networks also block SSH: HTTPS usually still works there.' : 'This Mac couldn’t connect. Check your internet connection, then try again.', [retry, setup.gh === 'ok' ? pushHttps : undefined]);
  }
}

/** The card in one line, for a toast or the phone: "GitHub didn’t accept this Mac’s SSH key. Fix it on your Mac." */
export const troubleLine = (t: GitTrouble): string => `${t.title}. ${t.fixes.length > 1 || t.fixes[0]?.id !== 'retry' ? 'See how to fix it in Beluga on your Mac' : 'Try again in a moment'}.`;
