/**
 * Environment variables you set for your shells, setup and run commands, and your Claude:
 * your own (everywhere) and per project (over yours). A project's main folder .env (and
 * .env.local) loads by default under its own, so you rarely set anything by hand (BLG-369). They're kept in ~/.beluga/env.json,
 * readable only by you, and never leave this computer: screens get their names, and the
 * values only when one asks (Settings), never in the shared state or anything sent to the room.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ENV_KEY, type EnvKeys, type EnvVar, MAX_ENV_VALUE, MAX_ENV_VARS, envProblems, envRecord, importEnv, mergeEnv, parseEnvText } from '../shared/env-vars.js';
import { DEFAULT_EXAMPLE_FILE, EXAMPLE_FILES, exampleKeys, syncExample } from '../shared/env-example.js';
import { ENDPOINT_ID, endpointIdFor } from '../shared/local-endpoints.js';
import type { Project, Workspace } from '../workspaces/types.js';
import { belugaHome } from './home.js';
import type { Store } from './store.js';

/** One local or bring-your-own endpoint (see shared/local-endpoints.ts). */
export const Endpoint = z.object({
  id: z.string().regex(ENDPOINT_ID),
  label: z.string().min(1).max(40),
  baseUrl: z.string().url().max(500).refine((u) => /^https?:\/\//.test(u), 'Use an http:// or https:// address'),
  key: z.string().max(4000).optional(),
  models: z.array(z.string().min(1).max(40)).max(20).default([]),
});
export type Endpoint = z.infer<typeof Endpoint>;
const MAX_ENDPOINTS = 12;

const Vars = z.record(z.string().regex(ENV_KEY), z.string().max(MAX_ENV_VALUE));

/** What env.json holds. */
export const EnvFile = z.object({
  global: Vars.default({}),
  /** Your own Claude reads and changes .env files without asking, in every project. */
  claudeDotenv: z.boolean().default(false),
  /**
   * By project folder. `dotenv`: load the main folder's .env (unset: yes; true: you switched it on
   * yourself, before it was the default, so your Claude gets it too). `claudeDotenv`: your own Claude
   * reads and changes its .env files without asking.
   */
  projects: z.record(z.string(), z.object({ vars: Vars.default({}), dotenv: z.boolean().optional(), claudeDotenv: z.boolean().default(false), newKeysBack: z.boolean().optional(), exampleSync: z.boolean().optional() })).default({}),
  /**
   * By worktree id (BLG-924): its own variables, over the project's, and the names its .env files
   * had when last looked at (`base`), so a key it adds or removes reaches its .env.example (BLG-925).
   * Archiving keeps them (restoring brings them back); deleting drops them unless carried to the project.
   */
  worktrees: z.record(z.string(), z.object({ vars: Vars.default({}), base: z.array(z.string().regex(ENV_KEY)).max(MAX_ENV_VARS * 2).optional() })).default({}),
  /**
   * Anthropic-compatible endpoints your Claude Code can run against (BLG-449): kept here with your
   * other secrets, never published. Screens get them without the key (local-endpoints.ts).
   */
  endpoints: z.array(Endpoint).max(MAX_ENDPOINTS).default([]),
  /** 2: `dotenv` unset means on. Files without it said false for "never switched on". */
  v: z.number().optional(),
});
export type EnvFile = z.infer<typeof EnvFile>;

const EMPTY: EnvFile = { global: {}, claudeDotenv: false, projects: {}, worktrees: {}, endpoints: [], v: 2 };

/** A file from before .env loaded by default: its "off" was only never switched on, so it's the default now. */
function upgrade(file: EnvFile): EnvFile {
  if (file.v === 2) return file;
  const projects = Object.fromEntries(Object.entries(file.projects).map(([root, p]) => [root, p.dotenv === false ? { vars: p.vars, claudeDotenv: p.claudeDotenv } : p]));
  return { ...file, projects, v: 2 };
}

/** Whether a project loads its main folder's .env. */
const loadsDotenv = (p: { dotenv?: boolean } | undefined): boolean => p?.dotenv !== false;

/** The .env files read from a folder, later ones winning (as Next.js, Vite and the like read them). */
export const DOTENV_FILES = ['.env', '.env.local'] as const;
/** A .env bigger than this isn't read. */
const MAX_DOTENV_BYTES = 256 * 1024;

export const envPath = (): string => path.join(belugaHome(), 'env.json');

export function loadEnvFile(file: string = envPath()): EnvFile {
  return readEnvFile(file) ?? EMPTY;
}

/** env.json as it is: none there is empty; one that doesn't read (half-written, mistyped by hand) is undefined. */
function readEnvFile(file: string): EnvFile | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return EMPTY;
  }
  try {
    const parsed = EnvFile.safeParse(JSON.parse(text));
    return parsed.success ? upgrade(parsed.data) : undefined;
  } catch {
    return undefined;
  }
}

/** When env.json last changed (its time and size), or none. */
function stampOf(file: string): string {
  try {
    const st = statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'none';
  }
}

/** Save atomically, readable only by you. */
export function saveEnvFile(data: EnvFile, file: string = envPath()): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** The variables in one file (none when it isn't there, or it's too big). */
function readOne(file: string): Record<string, string> {
  try {
    if (statSync(file).size > MAX_DOTENV_BYTES) return {};
    return envRecord(parseEnvText(readFileSync(file, 'utf8')).vars);
  } catch {
    return {};
  }
}

/** The variables in a folder's .env and .env.local (.env.local wins). */
export function readDotenv(dir: string): Record<string, string> {
  return mergeEnv(...DOTENV_FILES.map((f) => readOne(path.join(dir, f))));
}

/** Which of the .env files a folder has. */
const dotenvFilesIn = (dir: string): string[] => DOTENV_FILES.filter((f) => {
  try {
    return statSync(path.join(dir, f)).isFile();
  } catch {
    return false;
  }
});

/** A folder's template (.env.example or the like): its name and text, or none. */
function readExample(dir: string): { file: string; text: string } | undefined {
  for (const file of EXAMPLE_FILES) {
    try {
      const at = path.join(dir, file);
      if (statSync(at).size > MAX_DOTENV_BYTES) return undefined;
      return { file, text: readFileSync(at, 'utf8') };
    } catch {
      // not this one
    }
  }
  return undefined;
}

/** What a template lists against what's set: `set` everything that runs there gets, `files` what its .env files and the project set. */
function exampleInfo(dir: string, set: ReadonlySet<string>, files: readonly string[]): ExampleInfo {
  const found = readExample(dir);
  const keys = found ? exampleKeys(found.text) : [];
  const listed = new Set(keys);
  return {
    ...(found ? { file: found.file } : {}),
    keys,
    missing: keys.filter((k) => !set.has(k)),
    unlisted: [...new Set(files)].filter((k) => !listed.has(k)),
  };
}

/** One place's variables, for the Settings editor. */
export interface EnvScope {
  readonly vars: readonly EnvVar[];
  /** A key a worktree adds goes into the main folder's .env on its own (projects only; on unless switched off). */
  readonly newKeysBack?: boolean;
  /** Load the main folder's .env (projects only; on unless you switched it off). */
  readonly dotenv: boolean;
  /** Names in the project's .env right now (shown so you know what it adds). */
  readonly dotenvKeys: readonly string[];
  /** The main folder's .env variables, with their values, for the editor beside the project's own (projects only). */
  readonly dotenvVars?: readonly EnvVar[];
  /** The .env files they come from (".env", ".env.local"). */
  readonly dotenvFiles?: readonly string[];
  /** Your own Claude reads .env files here without asking (no project: in every project). */
  readonly claudeDotenv: boolean;
  /** Yours only: names a project's variables or its .env win over, and which (so an edit here isn't a surprise). */
  readonly overridden?: Readonly<Record<string, readonly string[]>>;
  /**
   * What comes from below, for the editor to show greyed (BLG-926): for a project, your variables;
   * for a worktree, yours, the .env files and the project's. Each with where it's from; later ones win.
   */
  readonly inherited?: readonly InheritedVar[];
  /** The .env.example beside them (projects and worktrees): what it lists that isn't set, and what's set that it doesn't list. */
  readonly example?: ExampleInfo;
  /** Keys a worktree adds to or removes from its .env reach its .env.example (projects only; on unless switched off). */
  readonly exampleSync?: boolean;
}

/** A variable set further down, and where. */
export interface InheritedVar {
  readonly key: string;
  readonly value: string;
  /** 'Everywhere', '.env', or the project's name. */
  readonly from: string;
}

/** A folder's template against what's set there (names only). */
export interface ExampleInfo {
  /** The template there (".env.example"), or none yet. */
  readonly file?: string;
  readonly keys: readonly string[];
  /** Listed in it, set nowhere: what the code there may need. */
  readonly missing: readonly string[];
  /** In the .env files or the project's variables, but not listed in it. */
  readonly unlisted: readonly string[];
}

/** A worktree's own variables, over everything below. */
export interface WorktreeEnvScope extends EnvScope {
  readonly name: string;
  readonly projectId: string;
  readonly projectName: string;
}

/** A project's environment in names and counts, for its page and the phone (never a value). */
export interface EnvOverview {
  readonly own: number;
  readonly dotenv: number;
  readonly dotenvOn: boolean;
  readonly dotenvFiles: readonly string[];
  readonly everywhere: number;
  readonly example?: ExampleInfo;
  /** Worktrees keep .env.example in step on their own (on unless switched off): what it doesn't list needs nothing from you. */
  readonly exampleSync?: boolean;
  /** Its worktrees with variables of their own. */
  readonly worktrees: readonly { readonly id: string; readonly name: string; readonly keys: readonly string[] }[];
}

/** Whether your own Claude may read a folder's .env files without asking you (see agent-host.ts). */
export interface DotenvAccess {
  readonly allowed: (dir?: string) => boolean;
  /** The project's name, when the folder is in one of yours ("Always for <project>"). */
  readonly project: (dir?: string) => string | undefined;
  /** You said always: for this folder's project, or everywhere. */
  readonly allow: (dir: string | undefined, scope: 'project' | 'everywhere') => void;
}

/** Where something runs: a workspace, a project, or just a folder. */
export interface EnvPlace {
  readonly workspaceId?: string;
  readonly projectId?: string;
  readonly dir?: string;
}

export interface EnvVarsDeps {
  readonly store: Store;
  readonly file?: string;
  /** Your variables changed: terminals already running still have the old ones (see Workbench.envChanged). */
  readonly onChange?: () => void;
}

const inside = (dir: string, root: string): boolean => dir === root || dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

export class EnvVars {
  private kept: EnvFile;
  /** env.json's time and size when it was read or written here. */
  private stamp: string;
  /** Told when the variables change (your secrets on your other computers follow them, machines/sync.ts). */
  private readonly watchers = new Set<() => void>();

  constructor(private readonly deps: EnvVarsDeps) {
    this.stamp = stampOf(this.file);
    this.kept = loadEnvFile(this.file);
    this.publish();
  }

  private get file(): string {
    return this.deps.file ?? envPath();
  }

  /**
   * The variables, read again when env.json changed on disk (edited by hand, or by another Beluga),
   * so a run uses them at once without a restart (BLG-302). A file that doesn't read keeps the last good ones.
   */
  private get data(): EnvFile {
    const now = stampOf(this.file);
    if (now !== this.stamp) {
      this.stamp = now;
      const fresh = readEnvFile(this.file);
      if (fresh) {
        this.kept = fresh;
        this.publish();
        // Told after this read: the terminals' check reads the variables again.
        queueMicrotask(() => this.deps.onChange?.());
      }
    }
    return this.kept;
  }

  private set data(next: EnvFile) {
    this.kept = next;
  }

  /** Write the variables, and remember the file as written (it isn't read back as a change). */
  private save(): void {
    saveEnvFile(this.kept, this.deps.file);
    this.stamp = stampOf(this.file);
  }

  private get projects(): readonly Project[] {
    return this.deps.store.getState().projects.filter((p) => p.root);
  }

  private project(id: string | undefined): Project | undefined {
    return id ? this.projects.find((p) => p.id === id) : undefined;
  }

  /** Tell screens the names (never the values). */
  private publish(): void {
    const projects = Object.fromEntries(Object.entries(this.kept.projects).map(([root, p]) => [root, { keys: Object.keys(p.vars), dotenv: loadsDotenv(p) }]));
    const worktrees = Object.fromEntries(Object.entries(this.kept.worktrees).filter(([, w]) => Object.keys(w.vars).length).map(([id, w]) => [id, Object.keys(w.vars)]));
    const keys: EnvKeys = { global: Object.keys(this.kept.global), projects, worktrees };
    this.deps.store.dispatch({ type: 'env_keys', keys });
    for (const w of [...this.watchers]) w();
  }

  /** Follow changes to the variables (set here, or env.json changed on disk). */
  watch(listener: () => void): () => void {
    this.watchers.add(listener);
    return () => void this.watchers.delete(listener);
  }

  /** Your own variables (no project), as they are now: names and values (only for your other computers' sync). */
  globals(): Readonly<Record<string, string>> {
    return { ...this.data.global };
  }

  /** Your variables (no project), or a project's. */
  get(projectId?: string): EnvScope {
    if (!projectId) return { vars: toRows(this.data.global), dotenv: false, dotenvKeys: [], claudeDotenv: this.data.claudeDotenv, overridden: this.overridden() };
    const project = this.project(projectId);
    const saved = project ? this.data.projects[project.root] : undefined;
    const dotenvVars = project ? readDotenv(project.root) : {};
    const own = saved?.vars ?? {};
    const fileKeys = [...(loadsDotenv(saved) ? Object.keys(dotenvVars) : []), ...Object.keys(own)];
    const set = new Set([...Object.keys(this.data.global), ...fileKeys]);
    return {
      vars: toRows(own),
      dotenv: loadsDotenv(saved),
      dotenvKeys: Object.keys(dotenvVars),
      dotenvVars: toRows(dotenvVars),
      dotenvFiles: project ? dotenvFilesIn(project.root) : [],
      claudeDotenv: saved?.claudeDotenv ?? false,
      newKeysBack: saved?.newKeysBack !== false,
      exampleSync: saved?.exampleSync !== false,
      inherited: toRows(this.data.global).map((v) => ({ ...v, from: 'Everywhere' })),
      ...(project ? { example: exampleInfo(project.root, set, fileKeys) } : {}),
    };
  }

  /** The workspace (and its project) by id, a worktree or a main folder's. */
  private workspace(id: string): { project: Project; ws: Workspace } | undefined {
    for (const project of this.projects) {
      const ws = project.workspaces.find((w) => w.id === id);
      if (ws) return { project, ws };
    }
    return undefined;
  }

  /**
   * What runs in a place gets, layer by layer, later ones winning: yours, the .env files (the main
   * folder's, then the workspace's own copy), the project's, then the worktree's (BLG-924).
   */
  private layers(project: Project | undefined, dir: string | undefined, wsId: string | undefined, dotenvToo: boolean): { from: string; vars: Record<string, string> }[] {
    const own = project ? this.data.projects[project.root] : undefined;
    const dotenv = project && dotenvToo && loadsDotenv(own) ? { ...readDotenv(project.root), ...(dir && dir !== project.root ? readDotenv(dir) : {}) } : {};
    return [
      { from: 'Everywhere', vars: { ...this.data.global } },
      { from: '.env', vars: dotenv },
      { from: project?.name ?? 'the project', vars: { ...(own?.vars ?? {}) } },
      { from: 'this worktree', vars: { ...(wsId ? this.data.worktrees[wsId]?.vars : undefined) } },
    ];
  }

  /** A worktree's own variables, with what it gets from below (BLG-924). */
  worktree(id: string): WorktreeEnvScope {
    const found = this.workspace(id);
    if (!found) throw new Error('That worktree is gone');
    const { project, ws } = found;
    const saved = this.data.projects[project.root];
    const below = this.layers(project, ws.path, undefined, true).slice(0, 3);
    // Each name once, from the layer that wins.
    const winning = new Map<string, InheritedVar>();
    for (const layer of below) for (const [key, value] of Object.entries(layer.vars)) winning.set(key, { key, value, from: layer.from });
    const own = this.data.worktrees[id]?.vars ?? {};
    const fileKeys = [...Object.keys(below[1]!.vars), ...Object.keys(below[2]!.vars), ...Object.keys(own)];
    const set = new Set([...winning.keys(), ...Object.keys(own)]);
    const dotenvVars = readDotenv(ws.path);
    return {
      name: ws.name,
      projectId: project.id,
      projectName: project.name,
      vars: toRows(own),
      dotenv: loadsDotenv(saved),
      dotenvKeys: Object.keys(dotenvVars),
      dotenvFiles: dotenvFilesIn(ws.path),
      claudeDotenv: saved?.claudeDotenv ?? false,
      inherited: [...winning.values()],
      example: exampleInfo(ws.path, set, fileKeys),
    };
  }

  /** Replace a worktree's own variables (rows as in set). */
  setWorktree(id: string, rows: readonly EnvVar[]): void {
    if (!this.workspace(id)) throw new Error('That worktree is gone');
    const vars = checkedVars(rows);
    const before = this.data.worktrees[id];
    this.data = { ...this.data, worktrees: withWorktree(this.data.worktrees, id, { ...before, vars }) };
    this.save();
    this.publish();
    this.deps.onChange?.();
  }

  /**
   * Carry a worktree's own variables to its project (same name: the worktree's wins) and drop them
   * there: before it's archived or deleted, so the project keeps what it worked out. → how many.
   */
  carryWorktree(id: string): number {
    const found = this.workspace(id);
    const vars = this.data.worktrees[id]?.vars ?? {};
    if (!found || !Object.keys(vars).length) return 0;
    const n = this.merge(found.project.id, vars);
    this.data = { ...this.data, worktrees: withWorktree(this.data.worktrees, id, { ...this.data.worktrees[id], vars: {} }) };
    this.save();
    this.publish();
    return n;
  }

  /** A deleted worktree's variables go with it. */
  forgetWorktree(id: string): void {
    if (!(id in this.data.worktrees)) return;
    const { [id]: _gone, ...rest } = this.data.worktrees;
    this.data = { ...this.data, worktrees: rest };
    this.save();
    this.publish();
  }

  /** A project's environment in names and counts (its page, the phone): never a value. */
  overview(projectId: string): EnvOverview {
    const project = this.project(projectId);
    if (!project) throw new Error('That project is gone');
    const scope = this.get(projectId);
    const worktrees = project.workspaces
      .filter((w) => !w.archived && Object.keys(this.data.worktrees[w.id]?.vars ?? {}).length)
      .map((w) => ({ id: w.id, name: w.name, keys: Object.keys(this.data.worktrees[w.id]!.vars) }));
    return {
      own: scope.vars.length,
      dotenv: scope.dotenvKeys.length,
      dotenvOn: scope.dotenv,
      dotenvFiles: scope.dotenvFiles ?? [],
      everywhere: Object.keys(this.data.global).length,
      ...(scope.example ? { example: scope.example } : {}),
      exampleSync: scope.exampleSync !== false,
      worktrees,
    };
  }

  /**
   * List in the main folder's .env.example what its .env files and the project's variables set and
   * it doesn't (a placeholder each, never the value; the file is made when there's none). → the names added.
   */
  addToExample(projectId: string): string[] {
    const project = this.project(projectId);
    if (!project) throw new Error('That project is gone');
    const found = readExample(project.root);
    const values = mergeEnv(readDotenv(project.root), this.data.projects[project.root]?.vars);
    const { text, added } = syncExample(found?.text ?? '', toRows(values));
    if (added.length) writeFileSync(path.join(project.root, found?.file ?? DEFAULT_EXAMPLE_FILE), text);
    return [...added];
  }

  /** Whether a worktree's added and removed keys reach its .env.example (by project id; on by default). */
  setExampleSync(projectId: string, on: boolean): void {
    const project = this.project(projectId);
    if (!project) throw new Error('That project is gone');
    this.data = { ...this.data, projects: this.withProject(project.root, { exampleSync: on }) };
    this.save();
  }

  /**
   * A worktree's .env.example kept in step with its .env files (BLG-925), in the worktree, so the
   * change ships with its work and the main folder is never touched (nor pushed by itself):
   * - the first look catches it up: every name the .env files have that it doesn't list is added
   *   (made when there's none), so a template that drifted is mended by the next worktree's work;
   * - after that, keys the worktree adds or removes itself are added or taken out;
   * - `noteOnly` just notes the names (keys the main folder's .env brought in later aren't this
   *   worktree's to list: the worktree that added them lists them).
   * → what changed there, and whether it was the first look's catch-up.
   */
  syncWorktreeExample(id: string, noteOnly = false): { file: string; added: readonly string[]; removed: readonly string[]; caughtUp?: boolean } | undefined {
    const found = this.workspace(id);
    if (!found || found.ws.kind !== 'worktree') return undefined;
    const { project, ws } = found;
    const values = readDotenv(ws.path);
    const now = Object.keys(values);
    const before = this.data.worktrees[id];
    const base = before?.base;
    const note = (): void => {
      if (base && base.length === now.length && base.every((k, i) => k === now[i])) return;
      this.data = { ...this.data, worktrees: withWorktree(this.data.worktrees, id, { vars: {}, ...before, base: now }) };
      this.save();
    };
    if (noteOnly || this.data.projects[project.root]?.exampleSync === false) {
      note();
      return undefined;
    }
    const template = readExample(ws.path);
    const has = new Set(now);
    const had = new Set(base ?? []);
    const added = now.filter((k) => !base || !had.has(k)).map((key) => ({ key, value: values[key] ?? '' }));
    // The catch-up only adds: a name the code reads may be set elsewhere (the project's, yours).
    const removed = base ? base.filter((k) => !has.has(k)) : [];
    const result = syncExample(template?.text ?? '', added, removed);
    const file = template?.file ?? DEFAULT_EXAMPLE_FILE;
    const changed = result.added.length > 0 || result.removed.length > 0;
    if (changed) writeFileSync(path.join(ws.path, file), result.text);
    note();
    return changed ? { file, added: result.added, removed: result.removed, ...(base ? {} : { caughtUp: true }) } : undefined;
  }

  /** Let your own Claude read .env files without asking (or ask again): in a project, or with none, everywhere. */
  setClaudeDotenv(projectId: string | undefined, on: boolean): void {
    if (!projectId) this.data = { ...this.data, claudeDotenv: on };
    else {
      const project = this.project(projectId);
      if (!project) throw new Error('That project is gone');
      this.data = { ...this.data, projects: this.withProject(project.root, { claudeDotenv: on }) };
    }
    this.save();
  }

  /** The projects with one changed (and dropped when there's nothing left to keep). */
  private withProject(root: string, change: Partial<EnvFile['projects'][string]>): EnvFile['projects'] {
    const { [root]: before, ...others } = this.data.projects;
    const next: EnvFile['projects'][string] = { vars: {}, claudeDotenv: false, ...before, ...change };
    // Back on (the default): nothing to keep for it.
    if (next.dotenv === undefined || ('dotenv' in change && change.dotenv === undefined)) delete next.dotenv;
    if (next.newKeysBack !== false) delete next.newKeysBack;
    if (next.exampleSync !== false) delete next.exampleSync;
    return Object.keys(next.vars).length || next.dotenv !== undefined || next.claudeDotenv || next.newKeysBack === false || next.exampleSync === false ? { ...others, [root]: next } : others;
  }

  readonly dotenvAccess: DotenvAccess = {
    allowed: (dir) => this.data.claudeDotenv || Boolean(dir && this.data.projects[this.placeOf({ dir }).project?.root ?? '']?.claudeDotenv),
    project: (dir) => (dir ? this.placeOf({ dir }).project?.name : undefined),
    allow: (dir, scope) => {
      const project = dir ? this.placeOf({ dir }).project : undefined;
      if (scope === 'everywhere') this.data = { ...this.data, claudeDotenv: true };
      else if (project) this.data = { ...this.data, projects: this.withProject(project.root, { claudeDotenv: true }) };
      else return;
      this.save();
    },
  };

  /**
   * Replace your variables (no project) or a project's, and whether it loads its .env (switched
   * off is kept; on is the default again, so it isn't). Rows without a name are skipped; a bad
   * name or one used twice refuses the whole change.
   */
  set(projectId: string | undefined, rows: readonly EnvVar[], dotenv?: boolean): void {
    const vars = checkedVars(rows);
    if (!projectId) {
      this.data = { ...this.data, global: vars };
    } else {
      const project = this.project(projectId);
      if (!project) throw new Error('That project is gone');
      const before = this.data.projects[project.root]?.dotenv;
      // Switching it back on keeps a "true" you set before it was the default (it gives your Claude the .env too).
      const nextDotenv = dotenv === undefined ? before : dotenv ? (before === true ? true : undefined) : false;
      this.data = { ...this.data, projects: this.withProject(project.root, { vars, dotenv: nextDotenv }) };
    }
    this.save();
    this.publish();
    this.deps.onChange?.();
  }

  /**
   * Copy the main folder's .env values into the project's own (BLG-369), so they're kept in Beluga
   * even if the file goes. A value you set here already stays. → how many were added.
   */
  importDotenv(projectId: string): number {
    const project = this.project(projectId);
    if (!project) throw new Error('That project is gone');
    const own = this.get(projectId).vars;
    const known = new Set(own.map((v) => v.key));
    const incoming = toRows(readDotenv(project.root)).filter((v) => !known.has(v.key));
    if (!incoming.length) return 0;
    this.set(projectId, [...own, ...incoming]);
    return incoming.length;
  }

  /** Whether keys a worktree adds go into the project's main .env on its own (by project id; on by default). */
  newKeysBack(projectId: string): boolean {
    const project = this.project(projectId);
    return project ? this.data.projects[project.root]?.newKeysBack !== false : false;
  }

  setNewKeysBack(projectId: string, on: boolean): void {
    const project = this.project(projectId);
    if (!project) throw new Error('That project is gone');
    this.data = { ...this.data, projects: this.withProject(project.root, { newKeysBack: on }) };
    this.save();
  }

  /**
   * Every secret value this computer's Beluga knows: your variables, each project's saved ones and
   * its main folder's .env files, and the endpoints' keys. Only for masking them out of text on this
   * computer before it's sent (src/telemetry/mask.ts); never shown, never sent.
   */
  secretValues(): string[] {
    const data = this.data;
    const dotenvs = this.projects.flatMap((p) => {
      try {
        return Object.values(readDotenv(p.root));
      } catch {
        return [];
      }
    });
    return [...Object.values(data.global), ...Object.values(data.projects).flatMap((p) => Object.values(p.vars)), ...dotenvs, ...data.endpoints.flatMap((e) => (e.key ? [e.key] : []))];
  }

  /** Your endpoints, keys and all: for runs on this Mac only (never a screen: see local-endpoints.ts). */
  endpoints(): readonly Endpoint[] {
    return this.data.endpoints;
  }

  /**
   * Add or change an endpoint. `key`: undefined keeps the one it has, '' removes it. A new one
   * (no id) gets an id from its label. → its id.
   */
  saveEndpoint(change: { readonly id?: string; readonly label: string; readonly baseUrl: string; readonly key?: string; readonly models?: readonly string[] }): string {
    const list = this.data.endpoints;
    const before = change.id ? list.find((e) => e.id === change.id) : undefined;
    if (change.id && !before) throw new Error('That endpoint is gone');
    const id = before?.id ?? endpointIdFor(change.label, list.map((e) => e.id));
    const key = change.key === undefined ? before?.key : change.key || undefined;
    const models = [...new Set((change.models ?? before?.models ?? []).map((m) => m.trim()).filter(Boolean))];
    const parsed = Endpoint.safeParse({ id, label: change.label.trim(), baseUrl: change.baseUrl.trim().replace(/\/+$/, ''), ...(key ? { key } : {}), models });
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'That endpoint doesn’t look right');
    if (!before && list.length >= MAX_ENDPOINTS) throw new Error(`Up to ${MAX_ENDPOINTS} endpoints`);
    this.data = { ...this.data, endpoints: before ? list.map((e) => (e.id === id ? parsed.data : e)) : [...list, parsed.data] };
    this.save();
    return id;
  }

  removeEndpoint(id: string): void {
    this.data = { ...this.data, endpoints: this.data.endpoints.filter((e) => e.id !== id) };
    this.save();
  }

  /** Set these in a project's own variables (same name: replaced), e.g. a worktree's .env changes (Save in Beluga). → how many. */
  merge(projectId: string, vars: Readonly<Record<string, string>>): number {
    const incoming = toRows(vars);
    if (incoming.length) this.set(projectId, importEnv(this.get(projectId).vars, incoming));
    return incoming.length;
  }

  /** Set (or with an empty value, remove) one of your variables, or one of a project's. */
  setOne(projectId: string | undefined, key: string, value: string | undefined): void {
    const rows = this.get(projectId).vars.filter((r) => r.key !== key);
    this.set(projectId, value === undefined ? rows : [...rows, { key, value }]);
  }

  /** The project something runs in: the workspace's, the one named, or the one whose folder holds `dir`. */
  private placeOf(where: EnvPlace): { project?: Project; dir?: string; wsId?: string } {
    const projects = this.projects;
    if (where.workspaceId) {
      const found = this.workspace(where.workspaceId);
      if (found) return { project: found.project, dir: found.ws.path, wsId: found.ws.id };
    }
    const named = this.project(where.projectId);
    if (named) return { project: named, dir: where.dir ?? named.root, ...worktreeAt(named, where.dir) };
    const dir = where.dir ? path.resolve(where.dir) : undefined;
    if (!dir) return {};
    const project = projects.find((p) => inside(dir, p.root) || p.workspaces.some((w) => inside(dir, w.path)));
    return { project, dir, ...(project ? worktreeAt(project, dir) : {}) };
  }

  /**
   * The variables for something starting there: yours, then the project's .env (unless you
   * switched it off; the workspace's own copy over the main folder's), then the project's own.
   * For your own Claude (`claude`) the .env counts only where it may read .env files without
   * asking (or you switched it on yourself before it was the default): loading it by default
   * mustn't hand Claude what it would otherwise ask you for.
   */
  envFor(where: EnvPlace = {}, opts: { readonly claude?: boolean } = {}): Record<string, string> {
    const { project, dir, wsId } = this.placeOf(where);
    const own = project ? this.data.projects[project.root] : undefined;
    const allowed = !opts.claude || own?.dotenv === true || this.data.claudeDotenv || Boolean(own?.claudeDotenv);
    return mergeEnv(...this.layers(project, dir, wsId, allowed).map((l) => l.vars));
  }

  /**
   * The variables a database view there can use: as envFor, but the project's .env always counts.
   * They go only to the database's own tools on this Mac (psql), never to Claude or the room.
   */
  /** viewEnv for one of your projects (by id), or with none just yours. */
  viewEnvOf(projectId?: string): { vars: Record<string, string>; where: string } {
    const project = this.project(projectId);
    if (projectId && !project) throw new Error('That project is gone');
    return project ? this.viewEnv(project.root) : { vars: { ...this.data.global }, where: 'your variables (Settings › Environment)' };
  }

  viewEnv(dir?: string): { vars: Record<string, string>; where: string } {
    const { project, dir: at, wsId } = this.placeOf({ dir });
    const own = project ? this.data.projects[project.root] : undefined;
    const dotenv = { ...(project ? readDotenv(project.root) : {}), ...(at && at !== project?.root ? readDotenv(at) : {}) };
    const where = project ? `your variables, ${project.name}’s variables (its Environment) and its .env` : 'your variables (Settings › Environment); this folder isn’t in one of your projects';
    return { vars: mergeEnv(this.data.global, dotenv, own?.vars, wsId ? this.data.worktrees[wsId]?.vars : undefined), where };
  }

  /**
   * Your variables that something else wins over, by name: a project's own variables, or its
   * .env when it's loaded. Changing yours there changes nothing (Settings says so).
   */
  private overridden(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const p of this.projects) {
      const own = this.data.projects[p.root];
      if (!own) continue;
      const dotenv = loadsDotenv(own) ? Object.keys(readDotenv(p.root)) : [];
      for (const key of Object.keys(this.data.global)) {
        const by = key in own.vars ? `${p.name}’s variables` : dotenv.includes(key) ? `${p.name}’s .env` : undefined;
        if (by) (out[key] ??= []).push(by);
      }
    }
    return out;
  }
}

const toRows = (vars: Readonly<Record<string, string>>): EnvVar[] => Object.entries(vars).map(([key, value]) => ({ key, value }));

/** Rows as a name → value record, or why not: rows without a name are skipped; a bad name or one used twice refuses them all. */
function checkedVars(rows: readonly EnvVar[]): Record<string, string> {
  const filled = rows.filter((r) => r.key || r.value);
  const problem = [...envProblems(filled).values()][0];
  if (problem) throw new Error(problem);
  if (filled.length > MAX_ENV_VARS) throw new Error(`Up to ${MAX_ENV_VARS} variables`);
  return envRecord(filled);
}

type WorktreeEntry = EnvFile['worktrees'][string];

/** The worktrees with one changed (dropped when there's nothing left to keep). */
function withWorktree(all: EnvFile['worktrees'], id: string, next: Partial<WorktreeEntry>): EnvFile['worktrees'] {
  const { [id]: _before, ...others } = all;
  const entry: WorktreeEntry = { vars: next.vars ?? {}, ...(next.base ? { base: next.base } : {}) };
  return Object.keys(entry.vars).length || entry.base ? { ...others, [id]: entry } : others;
}

/** The worktree (not the main folder) whose folder holds `dir`, the deepest one. */
function worktreeAt(project: Project, dir: string | undefined): { wsId?: string } {
  if (!dir) return {};
  const at = path.resolve(dir);
  const ws = project.workspaces.filter((w) => w.kind === 'worktree' && !w.archived && inside(at, w.path)).sort((a, b) => b.path.length - a.path.length)[0];
  return ws ? { wsId: ws.id } : {};
}
