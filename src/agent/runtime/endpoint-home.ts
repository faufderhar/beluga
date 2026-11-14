import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claudeHome } from '../../core/claude-code/launch.js';
import { belugaHome } from '../../core/home.js';

/**
 * Claude Code's folder for runs on a bring-your-own endpoint (DeepSeek, BigModel, Ollama…).
 *
 * Signed in to Claude, Claude Code sends that sign-in to whatever ANTHROPIC_BASE_URL says, over
 * ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY or an apiKeyHelper (2.1.x): the endpoint answered 401 and
 * had your token. Here Claude Code finds no sign-in: its sign-in is kept per folder (the Keychain
 * on a Mac, .credentials.json elsewhere), so the endpoint's key is the only one it has.
 *
 * Everything else is yours, linked from ~/.claude: skills, plugins, agents and commands, and
 * `projects`, so the conversations land where Beluga reads and resumes them. Your settings come as
 * a cleaned copy (see SETTINGS): no key helper or key variable in them reaches the endpoint, and
 * what a run changes in them never changes yours. Rebuilt on each run, so what you add to ~/.claude
 * shows up; a link to something gone goes. Its .claude.json here is its own, never yours (see OWN).
 */

/** What never comes along: your Claude sign-in. */
const KEPT_OUT = new Set(['.credentials.json']);
/**
 * What Claude Code keeps here on its own, never linked to yours: its .claude.json can hold an API
 * key (`primaryApiKey`) it would send to the endpoint. A link to yours is taken out.
 */
const OWN = new Set(['.claude.json']);
/** Settings files: copied, cleaned of every way to a key, never linked. */
const SETTINGS = /^settings(\.[\w-]+)?\.json$/;
/** Settings that run a helper for a key or credentials: the endpoint would get what they print. */
const KEY_HELPERS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport'] as const;
/** Settings `env` variables that carry a key or choose where requests go: the endpoint's own win. */
const ROUTING_ENV = /^(ANTHROPIC_|CLAUDE_CODE_(OAUTH|USE_|SKIP_)|CLAUDE_CONFIG_DIR$)/;

/** The folder, and what of yours didn't make it in (empty when everything did). */
export interface EndpointHome {
  readonly dir: string;
  readonly missed: readonly string[];
}

export function prepareEndpointHome(from: string = claudeHome(), into: string = path.join(belugaHome(), 'claude-endpoint')): EndpointHome {
  try {
    mkdirSync(into, { recursive: true, mode: 0o700 });
    const yours = existsSync(from) ? readdirSync(from).filter((name) => !KEPT_OUT.has(name) && !OWN.has(name)) : [];
    clearStale(from, into, new Set(yours));
    const missed = yours.filter((name) => !bringIn(path.join(from, name), path.join(into, name), SETTINGS.test(name)));
    return { dir: into, missed };
  } catch {
    // The run still goes, on a folder without your settings: never on your sign-in.
    return { dir: into, missed: ['your Claude Code folder'] };
  }
}

/** The folder alone, for a caller that has nowhere to say what's missing. */
export function endpointClaudeHome(from?: string, into?: string): string {
  return prepareEndpointHome(from, into).dir;
}

/** Your settings, without any way to a key and without the variables that point requests elsewhere. */
export function cleanSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const kept = Object.fromEntries(Object.entries(settings).filter(([key]) => !(KEY_HELPERS as readonly string[]).includes(key)));
  const env = settings.env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return kept;
  return { ...kept, env: Object.fromEntries(Object.entries(env).filter(([name]) => !ROUTING_ENV.test(name))) };
}

/** Links that point somewhere else, or at something gone, go (and a sign-in that got in somehow). */
function clearStale(from: string, into: string, wanted: ReadonlySet<string>): void {
  for (const name of readdirSync(into)) {
    const here = path.join(into, name);
    try {
      if (KEPT_OUT.has(name)) rmSync(here, { force: true, recursive: true });
      else if (isLink(here) && (!wanted.has(name) || SETTINGS.test(name) || readlinkSync(here) !== path.join(from, name))) rmSync(here, { force: true });
    } catch {
      // Left as it is: the next run tries again.
    }
  }
}

/** One thing of yours into the folder; false when it couldn't come along. */
function bringIn(there: string, here: string, settings: boolean): boolean {
  try {
    if (settings) return copyCleaned(there, here);
    const folder = statSync(there).isDirectory();
    // A file of yours that Claude Code rewrote here (a new file, not through the link) is yours again.
    if (!folder && !isLink(here) && existsSync(here) && statSync(here).isFile()) rmSync(here, { force: true });
    if (isLink(here) || existsSync(here)) return true;
    try {
      // A junction for a folder needs no rights on Windows; a file there may need copying instead.
      symlinkSync(there, here, folder ? 'junction' : 'file');
    } catch (err) {
      if (folder) throw err;
      copyFileSync(there, here);
    }
    return true;
  } catch {
    return false;
  }
}

/** Your settings file, cleaned, written fresh over whatever a run left there. */
function copyCleaned(there: string, here: string): boolean {
  const parsed: unknown = JSON.parse(readFileSync(there, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const text = `${JSON.stringify(cleanSettings(parsed as Record<string, unknown>), null, 2)}\n`;
  if (existsSync(here) && readFileSync(here, 'utf8') === text) return true;
  writeFileSync(here, text, { mode: 0o600 });
  return true;
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
