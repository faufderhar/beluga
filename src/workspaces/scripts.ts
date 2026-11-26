import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { belugaEnvBoth } from '../core/beluga-env.js';
import { NamingRules } from '../shared/naming.js';

/** Commands a project runs in its workspaces: `setup` once per new worktree, `run` on demand. */
export interface ProjectScripts {
  readonly setup?: string;
  readonly run?: string;
  /** Yours only: this project needs no setup (learned when nothing fit), so new worktrees skip it. */
  readonly skipSetup?: boolean;
  /** Claude already worked out this project's commands (it does that once, for its first new worktree). */
  readonly looked?: boolean;
  /** Which of your commands Claude worked out (setting one yourself takes it off). */
  readonly byClaude?: ReadonlyArray<'setup' | 'run'>;
}

/** The project's own file: beluga.json, or klaud.json from before the rename (read, and kept up to date, where it's the one there). */
export const PROJECT_FILES = ['beluga.json', 'klaud.json'] as const;
export type ProjectFileName = (typeof PROJECT_FILES)[number];

export type ScriptSource = 'yours' | 'claude' | ProjectFileName | 'conductor.json' | 'detected';

export interface ResolvedScripts {
  readonly setup?: { readonly command: string; readonly source: ScriptSource };
  readonly run?: { readonly command: string; readonly source: ScriptSource };
  /** Extra pull request instructions for this project (beluga.json "prPrompt"). */
  readonly prPrompt?: string;
  /** The team's naming rules (beluga.json "naming": branchPrefix, prTitle; BLG-1033). */
  readonly naming?: NamingRules;
}

const Command = z.string().trim().min(1).max(2000);

/** `beluga.json` at the project root, committed so the whole team shares it. */
export const ProjectFile = z.object({
  scripts: z.object({ setup: Command.optional(), run: Command.optional() }).partial().default({}),
  prPrompt: z.string().max(8000).optional(),
  // A bad rule is dropped, never the whole file (its scripts still count).
  naming: NamingRules.optional().catch(undefined),
});
export type ProjectFile = z.infer<typeof ProjectFile>;

const ConductorFile = z.object({ scripts: z.object({ setup: Command.optional(), run: Command.optional() }).partial().default({}) });

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Which of the project's own files it has: beluga.json, else an older klaud.json, else (to make) beluga.json. */
export const projectFileName = (root: string): ProjectFileName => PROJECT_FILES.find((name) => existsSync(path.join(root, name))) ?? PROJECT_FILES[0];

/** The project's own beluga.json or klaud.json (or Conductor's conductor.json, which uses the same idea). */
export function readProjectFile(root: string): { file?: ProjectFile; name: ProjectFileName; conductor?: ProjectScripts } {
  const name = projectFileName(root);
  const own = ProjectFile.safeParse(readJson(path.join(root, name)));
  const conductor = ConductorFile.safeParse(readJson(path.join(root, 'conductor.json')));
  return { file: own.success ? own.data : undefined, name, conductor: conductor.success ? conductor.data.scripts : undefined };
}

const LOCKFILES: ReadonlyArray<readonly [string, string]> = [
  ['pnpm-lock.yaml', 'pnpm install'],
  ['yarn.lock', 'yarn install'],
  ['bun.lockb', 'bun install'],
  ['bun.lock', 'bun install'],
  ['package-lock.json', 'npm install'],
  ['uv.lock', 'uv sync'],
  ['poetry.lock', 'poetry install'],
  ['Gemfile.lock', 'bundle install'],
  ['composer.lock', 'composer install'],
];

const MAKEFILES = ['GNUmakefile', 'makefile', 'Makefile'];
const JUSTFILES = ['justfile', 'Justfile', '.justfile'];
// Not `install`: in many Makefiles that copies the program into the system.
const SETUP_TARGETS = ['setup', 'bootstrap', 'deps'];
const RUN_TARGETS = ['dev', 'run', 'start', 'serve'];

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** The targets a Makefile (or the recipes a justfile) names at the start of a line, e.g. `dev:`. */
export function toolTargets(root: string): { make: Set<string>; just: Set<string> } {
  const names = (files: readonly string[], line: RegExp): Set<string> => {
    const text = files.map((f) => readText(path.join(root, f))).find((t) => t !== undefined) ?? '';
    return new Set([...text.matchAll(line)].map((m) => m[1]!));
  };
  return {
    // `name:` but not `name := value`; several on one line (`run dev:`) count too.
    make: new Set([...names(MAKEFILES, /^([A-Za-z][\w.-]*(?:[ \t]+[A-Za-z][\w.-]*)*)[ \t]*:(?!=)/gm)].flatMap((t) => t.split(/[ \t]+/))),
    // `name:` or `name arg='x':`, maybe quiet (`@name:`), not `name := value`.
    just: names(JUSTFILES, /^@?([A-Za-z_][\w-]*)(?:[ \t]+[^:\n]*)?[ \t]*:(?!=)/gm),
  };
}

/** The project's own tooling for something (a Makefile's `make dev`, a justfile's `just setup`), which knows better than a guess. */
function toolCommand(root: string, targets: readonly string[]): string | undefined {
  const { make, just } = toolTargets(root);
  for (const t of targets) if (make.has(t)) return `make ${t}`;
  for (const t of targets) if (just.has(t)) return `just ${t}`;
  return undefined;
}

/** A sensible setup command from the files in the project (its Makefile's `setup`, else e.g. package-lock.json → npm install, plus each nested package of its own). */
export function detectSetup(root: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const tool = toolCommand(root, SETUP_TARGETS);
  if (tool) return tool;
  const own = installIn(root);
  if (own && !existsSync(path.join(root, 'package.json'))) return own;
  const nested = nestedPackages(root).map((dir) => `(cd ${dir} && ${installIn(path.join(root, dir))})`);
  const all = [...(own ? [own] : []), ...nested];
  if (all.length) return all.join(' && ');
  // Windows: its Python is `python`, and a venv keeps its programs in Scripts\ (commands run in Git Bash there).
  if (existsSync(path.join(root, 'requirements.txt'))) return platform === 'win32' ? 'python -m venv .venv && .venv/Scripts/pip install -r requirements.txt' : 'python3 -m venv .venv && .venv/bin/pip install -r requirements.txt';
  return undefined;
}

/** The install a folder's own lockfile (or bare package.json) asks for. */
function installIn(dir: string): string | undefined {
  for (const [file, command] of LOCKFILES) if (existsSync(path.join(dir, file))) return command;
  return existsSync(path.join(dir, 'package.json')) ? 'npm install' : undefined;
}

/** Where monorepos keep their packages, one level down. */
const PACKAGE_DIRS = ['packages', 'apps', 'services', 'libs'];

/**
 * JavaScript packages under packages/, apps/… that install on their own: their own lockfile, and
 * not part of the root's workspaces (npm/yarn "workspaces", pnpm-workspace.yaml) nor already
 * installed by the root's own install scripts. A root `npm install` leaves these empty.
 */
export function nestedPackages(root: string): string[] {
  if (existsSync(path.join(root, 'pnpm-workspace.yaml'))) return [];
  const pkg = readJson(path.join(root, 'package.json')) as { workspaces?: unknown; scripts?: Record<string, unknown> } | undefined;
  if (pkg?.workspaces) return [];
  const hooks = ['preinstall', 'install', 'postinstall', 'prepare'].map((s) => pkg?.scripts?.[s]).filter((s): s is string => typeof s === 'string').join('\n');
  return PACKAGE_DIRS.flatMap((parent) => {
    let names: string[];
    try {
      names = readdirSync(path.join(root, parent), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort();
    } catch {
      return [];
    }
    return names
      .map((name) => `${parent}/${name}`)
      .filter((dir) => existsSync(path.join(root, dir, 'package.json')) && JS_LOCKS.some(([file]) => existsSync(path.join(root, dir, file))) && !hooks.includes(dir));
  });
}

const JS_LOCKS: ReadonlyArray<readonly [string, string]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
];
/** A plain package-manager install (`yarn`, `npm ci`, `pnpm install --frozen-lockfile`…), nothing chained. */
const JS_INSTALL = /^(npm|yarn|pnpm|bun)(?:\s+(?:install|i|ci)\b[^;&|]*)?$/;

export type SetupCheck = { readonly kind: 'ok' } | { readonly kind: 'skip'; readonly reason: string } | { readonly kind: 'swap'; readonly command: string; readonly reason: string };

/**
 * Does a setup command fit the folder it's about to run in? A JavaScript install in a folder
 * without package.json has nothing to do (skip); one for the wrong package manager (`yarn` where
 * there's only a pnpm-lock.yaml) becomes the right one (swap). Anything else runs as written.
 */
export function checkSetup(dir: string, command: string): SetupCheck {
  const tool = JS_INSTALL.exec(command.trim())?.[1];
  if (!tool) return { kind: 'ok' };
  if (!existsSync(path.join(dir, 'package.json'))) return { kind: 'skip', reason: `there's no package.json, so \`${command.trim()}\` has nothing to install` };
  const owner = JS_LOCKS.find(([file]) => existsSync(path.join(dir, file)))?.[1];
  if (!owner || owner === tool) return { kind: 'ok' };
  const lock = JS_LOCKS.find(([, t]) => t === owner)![0];
  return { kind: 'swap', command: `${owner} install`, reason: `it uses ${owner} (${lock}), not ${tool}` };
}

/** The usual way to start the project (its Makefile's `dev` or `run`, else package.json "dev" or "start"). */
export function detectRun(root: string): string | undefined {
  const tool = toolCommand(root, RUN_TARGETS);
  if (tool) return tool;
  const pkg = readJson(path.join(root, 'package.json')) as { scripts?: Record<string, unknown> } | undefined;
  const runner = existsSync(path.join(root, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(path.join(root, 'yarn.lock')) ? 'yarn' : existsSync(path.join(root, 'bun.lockb')) || existsSync(path.join(root, 'bun.lock')) ? 'bun' : 'npm';
  for (const name of ['dev', 'start']) {
    if (typeof pkg?.scripts?.[name] === 'string') return runner === 'npm' ? `npm run ${name}` : `${runner} ${name}`;
  }
  if (existsSync(path.join(root, 'Cargo.toml'))) return 'cargo run';
  if (existsSync(path.join(root, 'go.mod'))) return 'go run .';
  return undefined;
}

/**
 * The scripts that apply to a project, in order of preference: what you set in Beluga (or Claude
 * worked out for you), then beluga.json (or klaud.json), then conductor.json, then a guess from its files.
 */
export function resolveScripts(root: string, yours: ProjectScripts = {}): ResolvedScripts {
  const { file, name, conductor } = readProjectFile(root);
  const pick = (key: 'setup' | 'run', detect: (r: string) => string | undefined) => {
    if (yours[key]) return { command: yours[key]!, source: yours.byClaude?.includes(key) ? ('claude' as const) : ('yours' as const) };
    if (file?.scripts[key]) return { command: file.scripts[key]!, source: name };
    if (conductor?.[key]) return { command: conductor[key]!, source: 'conductor.json' as const };
    const guess = detect(root);
    return guess ? { command: guess, source: 'detected' as const } : undefined;
  };
  const setup = yours.skipSetup && !yours.setup ? undefined : pick('setup', detectSetup);
  const run = pick('run', detectRun);
  return { ...(setup ? { setup } : {}), ...(run ? { run } : {}), ...(file?.prPrompt ? { prPrompt: file.prPrompt } : {}), ...(file?.naming && Object.keys(file.naming).length ? { naming: file.naming } : {}) };
}

/** Write the scripts into the project's beluga.json (or its older klaud.json) so teammates get them too (keeps other fields). */
export function saveProjectFile(root: string, scripts: ProjectScripts): ProjectFileName {
  const name = projectFileName(root);
  const file = path.join(root, name);
  const current = (readJson(file) as Record<string, unknown> | undefined) ?? {};
  const merged = { ...current, scripts: { ...((current.scripts as object | undefined) ?? {}), ...scripts } };
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
  return name;
}

/** Write the team's naming rules into the project's beluga.json (keeps other fields); none left: the key goes. */
export function saveProjectNaming(root: string, naming: NamingRules | undefined): ProjectFileName {
  const name = projectFileName(root);
  const file = path.join(root, name);
  const { naming: _old, ...rest } = (readJson(file) as Record<string, unknown> | undefined) ?? {};
  writeFileSync(file, `${JSON.stringify(naming ? { ...rest, naming } : rest, null, 2)}\n`);
  return name;
}

/** Environment for scripts, matching what Conductor provides so existing scripts work (and KLAUD_*, from before the rename). */
export function scriptEnv(ws: { path: string; name: string; projectRoot: string; branch?: string }): Record<string, string> {
  return {
    ...belugaEnvBoth('WORKSPACE_PATH', ws.path),
    ...belugaEnvBoth('WORKSPACE_NAME', ws.name),
    ...belugaEnvBoth('ROOT_PATH', ws.projectRoot),
    ...(ws.branch ? belugaEnvBoth('BRANCH', ws.branch) : {}),
    CONDUCTOR_WORKSPACE_PATH: ws.path,
    CONDUCTOR_WORKSPACE_NAME: ws.name,
    CONDUCTOR_ROOT_PATH: ws.projectRoot,
  };
}
