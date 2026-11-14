import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { isOwnImageFile } from '../core/attachments.js';
import { isDotenvPath, isReceivedTaskFile, isSecretPath, realOf } from '../core/shares.js';
import { expandHome } from '../core/home-path.js';
import { isReadOnlyCommand } from './read-only.js';
import { SourceSchema } from '../shared/view-spec.js';
import { type ScriptPlan, planScript } from '../core/views/scripts.js';
import { SYNC_MAIN_REASON, type SyncScope, isSyncMainCommand } from './sync-main.js';

/** Read-only tools and the input field that names their target path. */
const READ_TOOLS: Readonly<Record<string, string>> = {
  Read: 'file_path',
  Glob: 'path',
  Grep: 'path',
  LS: 'path',
  NotebookRead: 'notebook_path',
};

/** File-editing tools and the input field that names the file they change. */
const WRITE_TOOLS: Readonly<Record<string, string>> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

/** Tools that only touch the chat, plan, or go through the remote owner's own checks. */
const ALWAYS_OK = new Set([
  'TodoWrite',
  'ToolSearch',
  // A skill only loads its instructions; every tool it then uses is gated as usual.
  'Skill',
  // continue_in_worktree is only offered in main folders, and decides who must confirm itself.
  ...['send_chat', 'list_peers', 'list_peer_files', 'read_peer_file', 'write_report', 'continue_in_worktree'].map((n) => `mcp__beluga__${n}`),
  // set_project_setup: only your own worktree runs have it, and what it sets asks you before it first runs by itself.
  'mcp__beluga__set_project_setup',
  // end_dialogue: only a chaired dialogue's turn has it (core/dialogues); it only ends that dialogue.
  'mcp__beluga__end_dialogue',
  // The gateway's look-and-wait tools (core/gateway); ask_person and run_on ask, and the gateway checks trust itself.
  ...['who_can', 'wait_for', 'check', 'cancel', 'answer_question'].map((n) => `mcp__beluga__${n}`),
  // The task board: your own runs, and a friend's you trust (BLG-701: only its repo's board, and a
  // Trusted friend's changes ask you, see boardAsks); each change is in the task's activity.
  // task_start refuses a friend's run (core/board/work.ts): it starts a worktree on this Mac.
  ...['task_define', 'task_get', 'task_list', 'task_create', 'task_start', 'board_create', 'task_update', 'task_brief_edit', 'task_note', 'task_relate', 'task_attach_proof'].map((n) => `mcp__beluga_board__${n}`),
  // Sentinels (core/sentinel): only your own runs have them; a new one starts paused until you turn it on,
  // and a change to what one can do pauses it. sentinel_remove and sentinel_delete_runs aren't here: deleting asks you.
  // sentinel_test and sentinel_try_source only read: a database read-only, a file, an address without your
  // variables; a command (or an address carrying a $VAR) waits for your yes.
  ...['sentinel_stop', 'sentinel_list', 'sentinel_get', 'sentinel_create', 'sentinel_update', 'sentinel_run', 'sentinel_test', 'sentinel_try_source', 'sentinel_pause', 'sentinel_runs'].map((n) => `mcp__beluga_sentinel__${n}`),
  // Dashboards and numbers (core/sentinel, §10): only your own runs have them; they arrange your
  // dashboards' tiles and read the numbers (a tile removed takes nothing kept with it).
  // dashboard_remove isn't here: deleting a dashboard asks you.
  ...['sentinel_measure', 'dashboard_list', 'dashboard_create', 'dashboard_update', 'dashboard_add_tile', 'dashboard_update_tile', 'dashboard_move_tile', 'dashboard_remove_tile', 'metric_list', 'metric_read'].map((n) => `mcp__beluga_dashboard__${n}`),
  // Other chats (core/chat-links): only your own runs have them. core/chat-links/access.ts decides each read and send,
  // and guard.ts limits sends. A message approves nothing in the chat that reads it.
  ...['list_chats', 'read_chat', 'send_to_chat', 'wait_for_chat'].map((n) => `mcp__beluga_chats__${n}`),
  // A plan's tools: only its home conversation has them (core/plans); changes to an approved plan wait for you.
  ...['plan_get', 'plan_write', 'plan_update', 'plan_gate', 'plan_review', 'plan_start_task', 'plan_message_task', 'plan_stop_task', 'plan_pause'].map((n) => `mcp__beluga_plan__${n}`),
  // Child threads (core/threads): only your own runs have them, with the flag on. They start and follow your own chats, under limits; no tool archives or deletes one.
  ...['thread_start', 'thread_status', 'thread_message', 'thread_stop'].map((n) => `mcp__beluga_threads__${n}`),
  // A friend's task only has these when its owner allowed them for that request (core/gateway/serve.ts).
  ...['screenshot', 'device_info'].map((n) => `mcp__beluga_task__${n}`),
  // "Your Mac": only its own conversation has these, in your own runs (core/assistant). They look at
  // this Mac or start work you asked for (a worktree, a task, a plan), the way the board's tools do,
  // or archive a worktree you asked to (lossless; one with Claude still working waits for your yes).
  ...['screenshot', 'device_info', 'list_work', 'start_worktree', 'start_task', 'start_plan', 'archive_worktree'].map((n) => `mcp__beluga_mac__${n}`),
  // Your phone (BLG-150): looking at it never asks (like the Mac's screenshot). Acting on it falls
  // to 'ask', then the owner-approval gate honours the phone's own setting (Off · Ask · Use · Full).
  ...['phone_status', 'phone_screenshot', 'phone_screen', 'phone_apps', 'phone_info', 'phone_pull', 'phone_notifications', 'phone_macro_list'].map((n) => `mcp__beluga_phone__${n}`),
  // Your MCP servers: only your own runs have these. A sign-in only opens its page in your browser: you finish it there.
  ...['mcp_servers', 'mcp_sign_in'].map((n) => `mcp__beluga_mcp__${n}`),
]);

/** The board tools that only look. */
const BOARD_LOOKS = new Set(['mcp__beluga_board__task_get', 'mcp__beluga_board__task_list']);
const asksForBoard = (toolName: string, asks: 'writes' | 'all'): boolean => toolName.startsWith('mcp__beluga_board__') && (asks === 'all' || !BOARD_LOOKS.has(toolName));

/**
 * Tools that delete something of yours for good (a sentinel, a dashboard, docs/sentinel.md §12):
 * your own Claude asks you first even when it otherwise never asks (Approvals › Never), once, with
 * no Always. The card reaches the phone as any approval does.
 */
export const ALWAYS_ASK_YOU: ReadonlySet<string> = new Set(['mcp__beluga_sentinel__sentinel_remove', 'mcp__beluga_sentinel__sentinel_delete_runs', 'mcp__beluga_dashboard__dashboard_remove']);

/**
 * Shell commands that mention credential stores are refused outright. A name counts when it isn't
 * part of a longer word, so shell punctuation around it (`cat .env|base64`, `(cat .env)`) still matches.
 * A project's .env asks you instead, when it's your own Claude (see Decision 'secret'); its
 * templates (.env.example…) hold no secrets and are just files.
 */
const DOTENV_IN_COMMAND = /(?<![\w.-])\.env(?!\.(?:example|sample|template|dist|defaults)(?![\w-]))(\.[\w-]+)?(?![\w-])/;
const CREDENTIAL_IN_COMMAND = /(?<![\w.-])(id_(rsa|ed25519|ecdsa|dsa)|\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.npmrc|\.netrc|\.git-credentials|credentials(\.json)?)(?![\w-])/;
export const SECRET_IN_COMMAND = new RegExp(`${DOTENV_IN_COMMAND.source}|${CREDENTIAL_IN_COMMAND.source}`);
/**
 * Beluga's private files by name, right under its home folder (daemon.json holds the token to the
 * whole API). Only there: a project's .beluga holds reports and scratch, and worktrees live under
 * ~/.beluga/workspaces. In any case, as the Mac's file system ignores it. Not a fence: see docs/security.md.
 */
const BELUGA_FILE_IN_COMMAND = /(?<![\w.-])\.(beluga|klaude?)[\\/]+(\.[\\/]+)*(daemon|identity|env|devices|web-sessions|cli-grant)\.json(?![\w-])/i;

const mentions = (re: RegExp, command: string): boolean => re.test(command) || re.test(command.replace(/['"\\]/g, ''));
const mentionsCredential = (command: string): boolean => mentions(CREDENTIAL_IN_COMMAND, command) || mentions(BELUGA_FILE_IN_COMMAND, command);
/** True when a shell command touches secrets, also through quoting tricks like `".e"nv` or `\.env`. */
export const mentionsSecret = (command: string): boolean => mentions(DOTENV_IN_COMMAND, command) || mentionsCredential(command);
/** The only secret a shell command touches is a .env file. */
export const mentionsOnlyDotenv = (command: string): boolean => mentions(DOTENV_IN_COMMAND, command) && !mentionsCredential(command);

/** 'secret': your own Claude wants a .env file; you're asked even when nothing else asks (see AgentRunInput.canUseSecret). */
export type Decision = 'allow' | 'deny' | 'ask' | 'secret';

export interface PolicyContext {
  readonly cwd: string;
  readonly roots: readonly string[];
  /** The primary share was marked :rw, so edits inside it don't need approval. */
  readonly autoEdit: boolean;
  /** 'folder': reading outside the shared folders asks the owner; 'full': it just runs. */
  readonly scope?: 'folder' | 'full';
  /**
   * A project's main folder: questions only. Nothing may change there (work happens in
   * worktrees): edits are denied, and shell commands that aren't clearly read-only too.
   */
  readonly askOnly?: boolean;
  /**
   * With askOnly, for one run: Claude is bringing main up to date, so git syncing (and editing
   * files with conflict markers) is allowed too; nothing else changes (see sync-main.ts).
   */
  readonly syncMain?: SyncScope;
  /**
   * With askOnly: a hidden worktree where the plan's Claude fixes a conflict combining the
   * branches a task starts from. Files there may be edited (nothing else changes).
   */
  readonly fixup?: string;
  /** With autoEdit: other worktrees this run works in too (an epic across repos), edited like `cwd`. */
  readonly alsoEdit?: readonly string[];
  /** A guest invited into one project asked: they never reach the room through your Claude. */
  readonly guest?: boolean;
  /** Your own Claude, on your own computer: a .env file asks you (Decision 'secret') instead of being refused. */
  readonly dotenv?: boolean;
  /** A friend's run with the board (BLG-701): its changes ('writes') or every board tool ('all') ask you first. */
  readonly boardAsks?: 'writes' | 'all';
  /**
   * Your own run: you asked, on this computer (never a friend's, a guest's or an external agent's).
   * It may Read an image you attached (an answer to its question links one: core/attachments.ts
   * withImagePaths), though Beluga's own folder stays secret otherwise.
   */
  readonly yourRun?: boolean;
}

/** `yourRun` for a run's policy: only you asked (a friend's run has no canUseSecret; an external agent's is asOwner). */
export const isYourRun = (input: { readonly canUseSecret?: unknown; readonly guest?: boolean; readonly asOwner?: boolean }): boolean => Boolean(input.canUseSecret) && !input.guest && !input.asOwner;

/**
 * `target` is `root` or inside it. Windows paths match without regard to letter case, as Windows
 * does (C:\Code\App and c:\code\app are one folder); a Mac and Linux compare them as they are.
 */
export const insideFolder = (root: string, target: string, platform: NodeJS.Platform = process.platform): boolean => {
  const win = platform === 'win32';
  const sep = win ? '\\' : '/';
  const r = win ? root.toLowerCase() : root;
  const t = win ? target.toLowerCase() : target;
  return t === r || t.startsWith(r + sep);
};
const inside = (root: string, target: string): boolean => insideFolder(root, target);
/** Inside a folder where it really is (links followed), so a link in a shared folder can't reach past it (BLG-414). */
const within = (root: string, target: string): boolean => inside(realOf(path.resolve(root)), realOf(target));
/** A secret by its name or by where it really is (a harmless-looking link to a key is still the key). */
const secretAt = (target: string): boolean => isSecretPath(target) || isSecretPath(realOf(target));
const resolveTarget = (cwd: string, raw: unknown): string => path.resolve(cwd, typeof raw === 'string' && raw ? raw : '.');

/**
 * Files that make something run later, as you: git hooks and config, Claude Code's settings and MCP
 * servers, editor tasks, direnv, npm scripts, make, shell start-up files, login items, CI (BLG-413).
 * Changing one from someone else's request asks you every time, so "may edit files" never quietly
 * becomes "may run commands".
 */
const CODE_DIRS = new Set(['.git', '.githooks', '.husky', '.claude', '.vscode', '.idea', '.devcontainer']);
const CODE_FILES = /^(\.mcp\.json|\.envrc|package\.json|makefile|gnumakefile|justfile|\.pre-commit-config\.ya?ml|\.zshrc|\.zshenv|\.zprofile|\.zlogin|\.bashrc|\.bash_profile|\.profile|.+\.command)$/;
const CODE_PATHS = /(^|\/)(library\/launch(agents|daemons)|\.github\/workflows)(\/|$)/;
const runsCodeAt = (p: string): boolean => {
  const segments = p.split(/[\\/]/).filter(Boolean).map((s) => s.toLowerCase());
  return segments.some((s) => CODE_DIRS.has(s)) || CODE_FILES.test(segments.at(-1) ?? '') || CODE_PATHS.test(segments.join('/'));
};
export const runsCode = (p: string): boolean => runsCodeAt(p) || runsCodeAt(realOf(path.resolve(p)));

/** This edit changes a file that runs code (see runsCode): its approval is once, never Always. */
export function writesCode(toolName: string, input: Record<string, unknown>, cwd: string): boolean {
  const field = WRITE_TOOLS[toolName];
  const raw = field === undefined ? undefined : input[field];
  return typeof raw === 'string' && raw !== '' && (runsCodeAt(raw) || runsCode(path.resolve(cwd, raw)));
}

/** Directory searches: they read files they find, not only the path the arguments name. */
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'LS']);
/** How many entries a directory search is walked before it stops (node_modules and .git are skipped). */
const MAX_SEARCH_SCAN = 20_000;
/**
 * One tool call judges its folder up to four times (the hook and canUseTool, each narrowing then
 * deciding): a walk is kept this long, so a folder is walked once per call, not four times.
 */
const SEARCH_SCAN_TTL_MS = 2_000;
/** Folders kept at once: a few searches in flight, never a growing map. */
const SEARCH_SCAN_KEEP = 16;
/**
 * Names a broad directory search must leave out, the same files Codex denies (codex/sandbox.ts).
 * One ripgrep glob: a basename anywhere, or a directory and everything in it.
 */
const SEARCH_SECRET_GLOBS = [
  '.env*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.keystore',
  '*.jks',
  'id_rsa*',
  'id_ed25519*',
  'id_ecdsa*',
  'id_dsa*',
  '.npmrc',
  '.netrc',
  '.pypirc',
  '.git-credentials',
  '.pgpass',
  'credentials',
  'credentials.json',
  '.credentials',
  '.credentials.json',
  '.zsh_history',
  '.zshhistory',
  '.bash_history',
  '.bashhistory',
  '.sh_history',
  '.shhistory',
  '.python_history',
  '.pythonhistory',
  '.node_repl_history',
  '.psql_history',
  '.mysql_history',
  '.lesshst_history',
  '.lesshsthistory',
  '.ssh',
  '.ssh/**',
  '.aws',
  '.aws/**',
  '.gnupg',
  '.gnupg/**',
  '.kube',
  '.kube/**',
  '.docker',
  '.docker/**',
  '.azure',
  '.azure/**',
  '.gcloud',
  '.gcloud/**',
  '.config/gh',
  '.config/gh/**',
  '.config/hub',
  '.config/hub/**',
  '.config/gcloud',
  '.config/gcloud/**',
  '.config/op',
  '.config/op/**',
  '.config/1password',
  '.config/1password/**',
  '.config/doctl',
  '.config/doctl/**',
  'library/keychains',
  'library/keychains/**',
  '.claude/.credentials',
  '.claude/.credentials*',
];
/** Sample names those globs match, so a narrow search (only TypeScript files) is left as it is. */
const SEARCH_SECRET_SAMPLES = ['.env', '.env.local', 'credentials.json', 'id_ed25519', 'k.pem', 'k.key', '.npmrc', '.ssh'];

interface SearchHit {
  readonly rel: string;
  readonly kind: 'hard' | 'dotenv';
}

const secretKindAt = (p: string): SearchHit['kind'] | undefined => {
  if (!isSecretPath(p)) return undefined;
  return isDotenvPath(p) ? 'dotenv' : 'hard';
};

/** A file's own name, or where a link really points (a harmless name for a key is still the key). */
function hitKind(abs: string, link: boolean): SearchHit['kind'] | undefined {
  const named = secretKindAt(abs);
  if (named === 'hard' || !link) return named;
  const real = realOf(abs);
  if (real === abs) return named;
  const linked = secretKindAt(real);
  if (linked === 'hard') return 'hard';
  return linked ?? named;
}

interface SearchScan {
  readonly hits: readonly SearchHit[];
  /** Stopped at {@link MAX_SEARCH_SCAN}: there may be credential files it didn't get to. */
  readonly truncated: boolean;
}

const scans = new Map<string, { readonly at: number; readonly scan: SearchScan | undefined }>();
let scanLimit = MAX_SEARCH_SCAN;

/** Tests: a walk cut off after `n` entries (not 20,000 files on disk). Returns the undo. */
export function limitSearchScanForTest(n: number): () => void {
  const before = scanLimit;
  scanLimit = n;
  scans.clear();
  return () => {
    scanLimit = before;
    scans.clear();
  };
}

/**
 * {@link walkSearch}, kept for {@link SEARCH_SCAN_TTL_MS} per folder (the newest
 * {@link SEARCH_SCAN_KEEP} folders). `now` is passed in by tests.
 */
export function scanSearch(root: string, now: number = Date.now()): SearchScan | undefined {
  const kept = scans.get(root);
  if (kept && now >= kept.at && now - kept.at < SEARCH_SCAN_TTL_MS) return kept.scan;
  const scan = walkSearch(root);
  scans.delete(root);
  scans.set(root, { at: now, scan });
  for (const [key, entry] of scans) {
    if (scans.size <= SEARCH_SCAN_KEEP && now - entry.at < SEARCH_SCAN_TTL_MS) break;
    scans.delete(key);
  }
  return scan;
}

/**
 * Credential files under a directory a search would walk. Stops after {@link MAX_SEARCH_SCAN}
 * entries (a whole checkout still searches; named secrets are excluded either way). Symlink
 * directories are not descended: ripgrep doesn't follow them unless asked.
 */
function walkSearch(root: string): SearchScan | undefined {
  try {
    if (!statSync(root).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const stack = [root];
  let n = 0;
  while (stack.length) {
    const dir = stack.pop()!;
    const realDir = realOf(dir);
    if (seen.has(realDir)) continue;
    seen.add(realDir);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      if (++n > scanLimit) return { hits, truncated: true };
      const abs = path.join(dir, ent.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      const kind = hitKind(abs, ent.isSymbolicLink());
      if (kind) {
        hits.push({ rel, kind });
        continue;
      }
      if (!ent.isSymbolicLink() && ent.isDirectory()) stack.push(abs);
    }
  }
  return { hits, truncated: false };
}

/** Ripgrep brace expansion, one level deep, so one exclusion of several names is one glob per name. */
function braceExpand(pattern: string): string[] {
  const start = pattern.indexOf('{');
  const end = start < 0 ? -1 : pattern.indexOf('}', start);
  if (start < 0 || end < 0) return [pattern];
  const prefix = pattern.slice(0, start);
  const suffix = pattern.slice(end + 1);
  return pattern
    .slice(start + 1, end)
    .split(',')
    .flatMap((part) => braceExpand(prefix + part + suffix));
}

/** A character copied from a glob into a regex has to be literal. */
const REGEX_LITERAL = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']);

/** One ripgrep glob (no braces) against a relative path. No slash: the file's name. Two stars cross directories. */
function globMatches(glob: string, rel: string): boolean {
  const g = glob.split('\\').join('/');
  const target = g.includes('/') ? rel : (rel.split('/').pop() ?? rel);
  let re = '^';
  let i = 0;
  while (i < g.length) {
    if (g.startsWith('**' + '/', i)) {
      re += '(?:' + '.*' + '/)?';
      i += 3;
      continue;
    }
    if (g.startsWith('**', i)) {
      re += '.*';
      i += 2;
      continue;
    }
    const c = g[i]!;
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += REGEX_LITERAL.has(c) ? '\\' + c : c;
    i += 1;
  }
  return new RegExp(re + '$', 'i').test(target);
}

/** Whether this one glob (an exclusion when it starts with `!`) keeps `rel` in the search. */
function globSelects(spec: string, rel: string): boolean {
  const negated = spec.startsWith('!');
  const matched = braceExpand(negated ? spec.slice(1) : spec).some((alt) => globMatches(alt, rel));
  return negated ? !matched : matched;
}

/** The glob that chooses files: Grep's `glob`, Glob's `pattern`. LS has none. */
function searchSpec(toolName: string, input: Record<string, unknown>): string | undefined {
  const raw = toolName === 'Grep' ? input.glob : toolName === 'Glob' ? input.pattern : undefined;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

/** A directory search reads `rel` when it has no glob, or a glob that matches every file. */
function searchSelects(toolName: string, input: Record<string, unknown>, rel: string): boolean {
  if (toolName === 'LS') return true;
  const spec = searchSpec(toolName, input);
  if (!spec) return true;
  return globSelects(spec, rel);
}

/**
 * A glob that could pick a credential file somewhere in the tree: an exclusion that doesn't leave
 * them out, or a pattern whose file-name part fits one (`src/**` does, `src/**\/*.ts` doesn't).
 */
function specMaySelectSecret(spec: string): boolean {
  if (SEARCH_SECRET_SAMPLES.some((name) => globSelects(spec, name))) return true;
  if (spec.startsWith('!')) return false;
  return braceExpand(spec).some((alt) => {
    const name = alt.split(/[\\/]/).pop() || alt;
    return SEARCH_SECRET_SAMPLES.some((sample) => globMatches(name, sample));
  });
}

/** The search could open a credential file: no glob of its own, or one that could pick one. */
const searchIsBroad = (toolName: string, input: Record<string, unknown>): boolean => {
  const spec = searchSpec(toolName, input);
  return !spec || specMaySelectSecret(spec);
};

interface OpenedSecrets {
  readonly hard: boolean;
  readonly dotenv: boolean;
  /** The walk stopped before the end and the search's own glob could still pick a credential file. */
  readonly unsure: boolean;
}

/** Credential files this directory search would actually open. */
function openedSecrets(toolName: string, input: Record<string, unknown>, ctx: PolicyContext): OpenedSecrets | undefined {
  if (!SEARCH_TOOLS.has(toolName)) return undefined;
  const field = READ_TOOLS[toolName];
  if (!field) return undefined;
  const scan = scanSearch(resolveTarget(ctx.cwd, input[field]));
  if (!scan) return undefined;
  let hard = false;
  let dotenv = false;
  for (const hit of scan.hits) {
    if (!searchSelects(toolName, input, hit.rel)) continue;
    if (hit.kind === 'hard') hard = true;
    else dotenv = true;
  }
  // No glob of its own: confineSearch narrows it (that glob leaves every named secret out).
  const unsure = scan.truncated && searchSpec(toolName, input) !== undefined && searchIsBroad(toolName, input);
  return hard || dotenv || unsure ? { hard, dotenv, unsure } : undefined;
}

/** Glob patterns that already list the whole tree, so the exclusion glob can stand in for them. */
const WHOLE_TREE_PATTERNS = new Set(['**', '**/*']);

/**
 * A relative path that cannot be put inside one `{a,b}` glob: glob syntax, or white space (a glob
 * may be split on it, so "my secret.pem" would become two names that leave nothing out).
 */
const UNSAFE_GLOB_CHAR = /[\s*?[\]{},!\\]/;
const unsafeGlob = (rel: string): boolean => UNSAFE_GLOB_CHAR.test(rel);

/**
 * One negated ripgrep glob that leaves every credential file out and still returns the rest.
 * Undefined when a discovered name won't fit in that glob.
 */
function exclusionGlob(extra: readonly string[]): string | undefined {
  if (extra.some(unsafeGlob)) return undefined;
  const alts = [...new Set([...SEARCH_SECRET_GLOBS, ...extra])];
  const glob = `!**/{${alts.join(',')}}`;
  return glob.length > 30_000 ? undefined : glob;
}

/**
 * The same Grep or Glob with credential files left out, so the search can run and not open them.
 * Undefined when the search already skips them, when it isn't a directory, or when it can't be
 * said safely (LS, a name that breaks the glob): decideTool then denies.
 */
export function confineSearch(toolName: string, input: Record<string, unknown>, ctx: PolicyContext): Record<string, unknown> | undefined {
  if (toolName !== 'Grep' && toolName !== 'Glob') return undefined;
  const field = READ_TOOLS[toolName];
  if (!field) return undefined;
  const scan = scanSearch(resolveTarget(ctx.cwd, input[field]));
  if (!scan) return undefined;
  const opened = scan.hits.filter((hit) => searchSelects(toolName, input, hit.rel));
  if (!opened.length && !(scan.truncated && searchIsBroad(toolName, input))) return undefined;
  // The exclusion takes the place of Grep's glob or Glob's pattern: a caller's own one would be lost
  // and the search widened, so that search isn't narrowed (decideTool then turns it down, or asks
  // when the walk stopped before finding one).
  if (toolName === 'Grep' ? typeof input.glob === 'string' && input.glob.trim() !== '' : !WHOLE_TREE_PATTERNS.has(String(input.pattern ?? '').trim())) return undefined;
  const glob = exclusionGlob(opened.map((hit) => hit.rel));
  if (!glob) return undefined;
  if (toolName === 'Grep') return input.glob === glob ? undefined : { ...input, glob };
  return input.pattern === glob ? undefined : { ...input, pattern: glob };
}

/**
 * Decide whether a tool call can run without asking the machine owner.
 * This runs as a PreToolUse hook, so it applies even to tools Claude Code would
 * auto-approve on its own (e.g. "read-only" shell commands).
 *  - credential files (by path or in a shell command) are always denied
 *  - a directory search that would open one is too, including a link whose name hides it
 *  - except a .env file for your own Claude: that asks you ('secret'), and is never sent anywhere
 *  - read-only tools inside the shared folders are allowed; outside them the owner is asked
 *  - edits inside a :rw share are allowed
 *  - everything else (Bash, web, other edits, reads outside shares, ask_agent) asks the owner
 */
export function decideTool(toolName: string, input: Record<string, unknown>, ctx: PolicyContext): Decision {
  const opened = openedSecrets(toolName, input, ctx);
  const decision = decideToolPlain(toolName, input, ctx, opened);
  if (decision === 'deny' || !ctx.dotenv || !touchesDotenv(toolName, input, ctx, opened)) return decision;
  return 'secret';
}

/** A file tool on a .env file, a shell command whose only secret is one, or a directory search that would open one and nothing harder. */
function touchesDotenv(toolName: string, input: Record<string, unknown>, ctx: PolicyContext, opened: OpenedSecrets | undefined): boolean {
  if (toolName === 'Bash') return typeof input.command === 'string' && mentionsOnlyDotenv(input.command);
  const field = READ_TOOLS[toolName] ?? WRITE_TOOLS[toolName];
  if (field !== undefined && isDotenvPath(resolveTarget(ctx.cwd, input[field]))) return true;
  if (READ_TOOLS[toolName] !== undefined && namesOf(toolName, input).some(isDotenvPath)) return true;
  return Boolean(opened?.dotenv && !opened.hard);
}

/**
 * The file names a search is limited to (Glob's pattern, Grep's glob), each alternative of a
 * `{a,b}` on its own and with its wildcards out, so `.env*` names .env and `*.pem` a key.
 * A glob that is only an exclusion (`!…`) names nothing to read: it leaves those files out.
 */
const namesOf = (toolName: string, input: Record<string, unknown>): string[] =>
  [toolName === 'Glob' && typeof input.pattern === 'string' && input.pattern.trim().startsWith('!') ? undefined : input.pattern, typeof input.glob === 'string' && input.glob.trim().startsWith('!') ? undefined : input.glob]
    .filter((v): v is string => typeof v === 'string')
    .flatMap((g) => [g, ...g.split(/[{},]/).map((part) => part.split(/[\\/]/).at(-1)?.replace(/[*?[\]!]/g, '') ?? '')])
    .filter(Boolean);

function decideToolPlain(toolName: string, input: Record<string, unknown>, ctx: PolicyContext, opened: OpenedSecrets | undefined): Decision {
  // Your own Claude's .env: judged as any file there, then it asks you (decideTool).
  const dotenv = ctx.dotenv === true && touchesDotenv(toolName, input, ctx, opened);
  if (ctx.askOnly && changesMain(toolName, input, ctx)) return 'deny';
  if (ctx.guest && toolName.startsWith('mcp__beluga__')) return 'deny';
  if (ctx.boardAsks && asksForBoard(toolName, ctx.boardAsks)) return 'ask';
  if (ALWAYS_OK.has(toolName)) return 'allow';
  // Sending a file reads it: same rules as Read (secrets never leave; outside shared folders asks).
  if (toolName === 'mcp__beluga__send_file') {
    const raw = typeof input.path === 'string' ? expandHome(input.path) : '';
    // Only full paths: the same file is checked here and read when it's sent.
    if (!path.isAbsolute(raw)) return 'deny';
    const target = path.resolve(raw);
    if (secretAt(target)) return 'deny';
    if (ctx.roots.some((r) => within(r, target))) return 'allow';
    return ctx.scope === 'full' ? 'allow' : 'ask';
  }
  // Commands on a friend's computer: their Beluga decides; secrets are refused on both ends.
  if (toolName === 'mcp__beluga__run_on_peer' || toolName === 'mcp__beluga__run_on') return typeof input.command === 'string' && mentionsSecret(input.command) ? 'deny' : 'ask';
  if (toolName === 'Bash') return typeof input.command === 'string' && mentionsSecret(input.command) && !dotenv ? 'deny' : 'ask';
  if (toolName === 'mcp__beluga_view__show') return decideShow(input, ctx);
  const readField = READ_TOOLS[toolName];
  if (readField) {
    const target = resolveTarget(ctx.cwd, input[readField]);
    // An image you attached, read by your own run: one file right in the attachments folder, where it really is.
    if (toolName === 'Read' && ctx.yourRun && isOwnImageFile(target)) return 'allow';
    // A secret a friend approved sending you (BLG-209) is your user's file now: your own Claude may read it, once you say so.
    if (ctx.dotenv && isReceivedTaskFile(target) && !namesOf(toolName, input).some(isSecretPath)) return 'ask';
    const real = realOf(target);
    if (!dotenv && (isSecretPath(target) || isSecretPath(real) || namesOf(toolName, input).some(isSecretPath))) return 'deny';
    if ([target, real, ...namesOf(toolName, input)].some((n) => isSecretPath(n) && !isDotenvPath(n))) return 'deny';
    // A directory Grep, Glob or LS opens credential files it finds, not only the path it was given.
    if (opened?.hard || (opened?.dotenv && !ctx.dotenv)) return 'deny';
    // A folder too big to walk to the end, searched with a glob that could still pick a key: someone decides.
    if (opened?.unsure) return 'ask';
    if (ctx.roots.some((r) => within(r, target))) return 'allow';
    // Outside the shared folders the owner decides (or it just runs, with full trust).
    return ctx.scope === 'full' ? 'allow' : 'ask';
  }
  const writeField = WRITE_TOOLS[toolName];
  if (writeField) {
    const target = resolveTarget(ctx.cwd, input[writeField]);
    if (secretAt(target) && !dotenv) return 'deny';
    const others = ctx.scope !== 'full';
    if (others && !ctx.roots.some((r) => within(r, target))) return 'deny';
    // Someone else's request: a file that makes code run later (a git hook, npm scripts…) asks you.
    if (others && runsCode(target)) return 'ask';
    if (ctx.autoEdit && [ctx.cwd, ...(ctx.alsoEdit ?? [])].some((d) => within(d, target))) return 'allow';
    if (ctx.fixup && within(ctx.fixup, target)) return 'allow';
    return 'ask';
  }
  return 'ask';
}

/**
 * Showing a view runs its source once: a command asks like Bash; a file, folder or SQLite file is
 * read like Read; a web address runs (asking when it would send one of your variables along).
 */
function decideShow(input: Record<string, unknown>, ctx: PolicyContext): Decision {
  const view = input.view && typeof input.view === 'object' ? (input.view as Record<string, unknown>) : {};
  if (view.source === undefined) return 'allow';
  // A script Claude wrote for the view runs like a command it wrote.
  const script = scriptIn(view.source, ctx.cwd);
  if (script) return mentionsSecret(script.code) ? 'deny' : ctx.askOnly ? 'deny' : 'ask';
  const parsed = SourceSchema.safeParse(view.source);
  if (!parsed.success) return 'allow'; // the tool says what's wrong; nothing runs
  const source = parsed.data;
  if (source.kind === 'command') return mentionsSecret(source.command) ? 'deny' : ctx.askOnly && !isReadOnlyCommand(source.command) ? 'deny' : 'ask';
  if (source.kind === 'http') return Object.values(source.headers ?? {}).some((v) => /\$\{?[A-Za-z_]/.test(v)) ? 'ask' : 'allow';
  if (source.kind === 'postgres') return 'allow';
  const target = resolveTarget(ctx.cwd, expandHome(source.path));
  if (secretAt(target)) return 'deny';
  if (ctx.roots.some((r) => within(r, target))) return 'allow';
  return ctx.scope === 'full' ? 'allow' : 'ask';
}

const scriptIn = (source: unknown, cwd: string): ScriptPlan | undefined => {
  try {
    return planScript(source, cwd);
  } catch {
    return undefined; // the tool says what's wrong; nothing runs
  }
};

/** In a main folder (ask-only): would this tool change something there? */
function changesMain(toolName: string, input: Record<string, unknown>, ctx: PolicyContext): boolean {
  const writeField = WRITE_TOOLS[toolName];
  if (writeField) {
    const target = resolveTarget(ctx.cwd, input[writeField]);
    return !(ctx.fixup && inside(path.resolve(ctx.fixup), target)) && !ctx.syncMain?.conflicted?.(target);
  }
  if (toolName === 'Bash') return !(typeof input.command === 'string' && (isReadOnlyCommand(input.command) || (ctx.syncMain !== undefined && isSyncMainCommand(input.command, ctx.syncMain))));
  // A view whose command could change something (so the refusal says why, not "credential files").
  if (toolName === 'mcp__beluga_view__show') {
    const view = input.view && typeof input.view === 'object' ? (input.view as Record<string, unknown>) : {};
    if (scriptIn(view.source, ctx.cwd)) return true;
    const source = SourceSchema.safeParse(view.source);
    return source.success && source.data.kind === 'command' && !mentionsSecret(source.data.command) && !isReadOnlyCommand(source.data.command);
  }
  // A file fetched from a friend may not land in the main folder.
  // Where it really is (links followed), and on Windows whatever the letter case (BLG-628).
  if (toolName === 'mcp__beluga__get_peer_file') return typeof input.save_to === 'string' && within(ctx.cwd, resolveTarget(ctx.cwd, expandHome(input.save_to)));
  return false;
}

export const DENY_REASON = 'Beluga blocked this: credential files are off-limits, and this request may only use the shared folders.';

/** The owner said no to a .env file: what Claude can do instead. */
export const SECRET_DECLINED =
  "The machine owner didn't allow this .env file. Don't try another way to read it. If you need a value from it, ask them in chat: " +
  'they can add it in Settings › Environment (your commands and database views get it without you seeing it).';

/** Why an ask-only run can't do it, and what to do instead. */
export const ASK_ONLY_REASON =
  "Beluga blocked this: you're in the project's main folder, which is read-only (questions only; work happens in worktrees). " +
  "Don't try another way to change it here. If a change is wanted, call mcp__beluga__continue_in_worktree with the task.";

/** A write outside the folders this request may change (not a credential file): say so, and what to do (BLG-348). */
export const OUTSIDE_REASON =
  'Beluga blocked this: that file is outside the shared folders this request may write to. ' +
  "Don't try another way to write it. Write inside the working folder (or the scratch folder), or ask the machine owner in chat to save it where they want it.";

/** The reason to give Claude for a denied tool call. */
export function denyReason(toolName: string, input: Record<string, unknown>, ctx: PolicyContext): string {
  if (ctx.askOnly && changesMain(toolName, input, ctx)) return ctx.syncMain ? SYNC_MAIN_REASON : ASK_ONLY_REASON;
  const writeField = WRITE_TOOLS[toolName];
  if (writeField) {
    const target = resolveTarget(ctx.cwd, input[writeField]);
    if (!secretAt(target) && ctx.scope !== 'full' && !ctx.roots.some((r) => within(r, target))) return OUTSIDE_REASON;
  }
  return DENY_REASON;
}
