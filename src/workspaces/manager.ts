import { type MergePreview, mergePreview } from './merge-preview.js';
import { createHash, randomUUID } from 'node:crypto';
import { systemOpen } from '../core/os-open.js';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { findProjects, isMainCheckout } from './discovery.js';
import * as g from './git.js';
import * as sync from './sync.js';
import { type EnvChange, applyEnvChanges, copyEnvFiles, envChanges, envChangesAsync, envHashes, envSnapshot, followMainEnv, followMainEnvAsync } from './env.js';
import { WorkspaceStore } from './store.js';
import { migrateMainConversations } from './main-migration.js';
import { stopTestProcesses } from './test-procs.js';
import { applySnapshot, dropSnapshots, snapshotBase } from './snapshots.js';
import { type ArchiveManifest, type ArchivePhase, type ArchivePreview, archiveWorktree, dropArchive, freeSpace, planArchive, previewOf, readManifest, restoreWorktree, sweepPartialArchives } from './archive.js';
import { worktreeOrigin } from './origin.js';
import { deleteFolderInBackground, removeWorktreeKeepingBranch, sweepSetAside } from './others.js';
import { moveToTrash } from './trash.js';
import { dropFolderSessions, dropSession, pathVariants, sessionFoldersUnder } from '../agent/runtime/claude/claude-sessions.js';
import { dropCodexSessions } from '../agent/runtime/codex/codex-sessions.js';
import { dropOpenCodeFolder, dropOpenCodeSession } from '../agent/runtime/opencode/sessions.js';
import { dropGrokSession } from '../agent/runtime/grok/sessions.js';
import { foldSessionCache } from '../shared/context-usage.js';
import { dropCopilotFolder, dropCopilotSession } from '../agent/runtime/copilot/sessions.js';
import { addDay, dayKey, tokensOf } from './usage-days.js';
import type { AgentRef } from '../protocol.js';
import type { DeletePlan, MergeWait, Project, ProjectGroup, PullHead, ProjectSync, ProjectsConfig, RenameResult, Workspace, WorkspaceRecord, WorkspaceUsage } from './types.js';
import type { ForkOf } from './github.js';
import type { Effort } from '../shared/settings-schema.js';
import { ArrangeError, type Item, type Layout, MAX_GROUP_NAME, arrangedOrder, groupKey, groupOfKey, isGroupKey, keyOf, move, settle } from './arrange.js';

/** A project (by id) or a group (by name), for arranging the sidebar. */
export type ArrangeTarget = { readonly project: string } | { readonly group: string };
import { type ProjectScripts, type ResolvedScripts, resolveScripts, saveProjectFile } from './scripts.js';
import { PROJECT_DIR, sentFolder } from '../shared/scratch-dir.js';
import { dropSent } from './scratch.js';
import { BRANCH_PREFIX_DEFAULT } from '../shared/settings-schema.js';
import { envRecord, parseEnvText } from '../shared/env-vars.js';
import type { ThreadRecord } from '../shared/threads.js';

export const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'workspace';

/** A pull request's worktree name: pr-<n> and the first whole words of its title ("pr-51-decode-emails-safely"). */
export function pullName(pull: { readonly number: number; readonly title?: string | undefined }): string {
  let name = `pr-${pull.number}`;
  for (const word of pull.title ? slug(pull.title).split('-') : []) {
    if (name.length + word.length + 1 > 28) break;
    name += `-${word}`;
  }
  return name;
}

/**
 * Canonical path: resolves symlinks (macOS /var → /private/var) and, via the native call,
 * the on-disk letter case, so ~/projects and ~/Projects on a case-insensitive disk are one folder.
 */
export const real = (p: string): string => {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};

/** Whether git still has `dir` as one of `repo`'s worktrees (when it can't tell, assume it does). */
async function isWorktreeOf(repo: string, dir: string): Promise<boolean> {
  const list = await g.listWorktrees(repo).catch(() => undefined);
  return !list || list.some((w) => real(w.path) === real(dir));
}

export const projectId = (root: string): string => createHash('sha1').update(real(root)).digest('hex').slice(0, 10);
const pathId = (p: string): string => `wt-${createHash('sha1').update(real(p)).digest('hex').slice(0, 10)}`;
/** New workspaces get a fresh id, so a reused name never inherits an old record or history. */
const freshId = (): string => `wt-${randomUUID().slice(0, 12)}`;

/** The session a fork goes on from: `session` when one was given (null: none, Claude starts fresh), else a branch of the source's. */
/** A fork keeps the source's agent, and its session stays filed under the runtime that made it. */
const forkSessionOf = (source: Workspace, session: string | null | undefined): Pick<WorkspaceRecord, 'sessionId' | 'forkFromSession' | 'sessionRuntime' | 'agent' | 'model'> => ({
  ...(source.agent ? { agent: source.agent } : {}),
  ...(source.model ? { model: source.model } : {}),
  ...(source.sessionRuntime ? { sessionRuntime: source.sessionRuntime } : {}),
  ...(session === undefined ? (source.sessionId ? { forkFromSession: source.sessionId } : {}) : session ? { sessionId: session } : {}),
});
/** A record's agent and model from one AgentRef (its model kept as the workspace's model, as setAgent does). */
/** Heads of a worktree's pull requests that merged (BLG-831, BLG-833): GitHub keeps them, so what's in them isn't pushed nowhere. */
const shippedOf = (ws: Pick<WorkspaceRecord, 'mergedHead' | 'prShipped'>): string[] => [...new Set([ws.mergedHead, ws.prShipped?.head].filter((h): h is string => Boolean(h)))];

const agentFields = (agent: AgentRef | undefined): Pick<WorkspaceRecord, 'agent' | 'model'> => {
  if (!agent) return {};
  const { model, ...ref } = agent;
  return { agent: ref, ...(model ? { model } : {}) };
};
export const mainId = (root: string): string => `${projectId(root)}:main`;

/** Chats that don't belong to any project live in this pseudo-project. */
export const CHATS_PROJECT = 'chats';
/** Beluga's own branches: beluga/<name> by default (klaud/<name> from before the rename still count as its own). */
export const BRANCH_PREFIX = BRANCH_PREFIX_DEFAULT;
export const LEGACY_BRANCH_PREFIX = 'klaud/';

/**
 * A branch Beluga made for a worktree named `name`: under a folder-like prefix of its own (yours, beluga/,
 * klaud/), else exactly the prefix and the worktree's name (-2, -3…), so a branch of yours is never renamed.
 */
export function isOwnBranch(branch: string, name: string, prefix: string): boolean {
  if ([prefix, BRANCH_PREFIX, LEGACY_BRANCH_PREFIX].some((p) => p.endsWith('/') && branch.startsWith(p))) return true;
  const rest = branch.startsWith(prefix) ? branch.slice(prefix.length) : undefined;
  return rest === name || (rest?.startsWith(`${name}-`) === true && /^\d+$/.test(rest.slice(name.length + 1)));
}

export class WorkspaceError extends Error {}

/**
 * Owns projects and their workspaces on this computer: discovery, worktree
 * lifecycle (create, fork, archive, delete), review, merge, and chat history.
 */
export class WorkspaceManager {
  private records: WorkspaceRecord[];
  private config: ProjectsConfig;
  private projects: Project[] = [];
  /** The refresh running now, and the one queued behind it (every call made meanwhile shares it). */
  private refreshing?: Promise<readonly Project[]>;
  private followUp?: Promise<readonly Project[]>;
  private archivesSwept = false;
  private sessionsSwept = false;
  /** One folder's status refresh in flight, per folder: the next waits for it (see refreshWorkspace). */
  private readonly folderRefreshes = new Map<string, Promise<boolean>>();
  /** Fetching state per project root (in flight, the last failure), shown with the default branch. */
  private fetchState = new Map<string, Pick<ProjectSync, 'fetching' | 'fetchError'>>();
  /** What each project's origin was forked from (by root), as gh last said. */
  private forks = new Map<string, ForkOf>();
  /** A remote's default branch learned while fetching, for repos without origin/HEAD (by root). */
  private remoteDefaults = new Map<string, string>();

  /** What new branches start with (Settings › Workspaces; the session points this at your choice). */
  branchPrefix: () => string = () => BRANCH_PREFIX;

  constructor(readonly store: WorkspaceStore = new WorkspaceStore()) {
    // No standing main conversation (BLG-70): one from before becomes a chat in its project, once.
    this.records = migrateMainConversations(store, store.loadRecords()).records;
    this.config = store.loadConfig();
  }

  get list(): readonly Project[] {
    return this.projects;
  }

  get settings(): ProjectsConfig {
    return this.config;
  }

  find(id: string): Workspace | undefined {
    for (const p of this.projects) {
      const ws = p.workspaces.find((w) => w.id === id);
      if (ws) return ws;
    }
    return undefined;
  }

  private require(id: string): Workspace {
    const ws = this.find(id);
    if (!ws) throw new WorkspaceError('That workspace no longer exists');
    return ws;
  }

  private projectOf(ws: Workspace): Project {
    const p = this.projects.find((x) => x.id === ws.projectId);
    if (!p) throw new WorkspaceError('Project not found');
    return p;
  }

  private saveRecord(record: WorkspaceRecord): void {
    this.records = [...this.records.filter((r) => r.id !== record.id), record];
    this.store.saveRecords(this.records);
  }

  private patchRecord(id: string, patch: Partial<WorkspaceRecord>): void {
    const existing = this.records.find((r) => r.id === id);
    const ws = this.find(id);
    const base: WorkspaceRecord | undefined = existing ?? (ws ? stripLive(ws) : undefined);
    if (!base) return;
    this.saveRecord({ ...base, ...patch });
    // Reflect the change immediately, without waiting for the next refresh.
    this.projects = this.projects.map((p) => ({ ...p, workspaces: p.workspaces.map((w) => (w.id === id ? { ...w, ...patch } : w)) }));
  }

  // ---------------------------------------------------------------- projects

  addProject(dir: string): string {
    const root = path.resolve(dir);
    if (!existsSync(root)) throw new WorkspaceError(`${root} isn’t there anymore`);
    if (!isMainCheckout(root)) throw new WorkspaceError(`${root} is not a git project (no .git folder)`);
    const removed = this.config.removed?.filter((r) => real(r) !== real(root));
    const hidden = this.config.hidden.filter((h) => real(h) !== real(root));
    this.config = { ...this.config, projects: [...new Set([...this.config.projects, root])], hidden, ...(removed ? { removed } : {}) };
    this.store.saveConfig(this.config);
    return projectId(root);
  }

  /** Watch a folder of projects: new ones in it show up, and ones you removed from it come back. */
  addFolder(dir: string): number {
    const root = path.resolve(dir);
    if (!existsSync(root)) throw new WorkspaceError(`${root} doesn't exist`);
    const inside = real(root) + path.sep;
    const removed = this.config.removed?.filter((r) => !real(r).startsWith(inside));
    this.config = { ...this.config, roots: [...new Set([...this.config.roots, root])], ...(removed ? { removed } : {}) };
    this.store.saveConfig(this.config);
    return findProjects([root]).length;
  }

  /** Whether a project's (real) root is one the config lists and shows. */
  private wanted(root: string): boolean {
    const is = (r: string): boolean => real(r) === root;
    if (!existsSync(root) || this.config.hidden.some(is) || this.config.removed?.some(is)) return false;
    return this.config.projects.some(is) || findProjects(this.config.roots).some(is);
  }

  /**
   * A project just added, read from git now and listed, without waiting for a full refresh of
   * every project (that follows). Undefined: it isn't one the config shows anymore.
   */
  async loadAdded(dir: string): Promise<Project | undefined> {
    const root = real(dir);
    if (!this.wanted(root)) return undefined;
    const project = await this.loadProject(root);
    if (!this.wanted(root)) return undefined;
    const repos = [...this.projects.filter((p) => p.root && p.id !== project.id), project].sort((a, b) => a.name.localeCompare(b.name));
    this.projects = [...this.projects.filter((p) => !p.root), ...repos];
    return project;
  }

  get groups(): readonly ProjectGroup[] {
    return this.config.groups ?? [];
  }

  /** Projects that show, alphabetically (the arrangement's starting point). */
  private shownRoots(): string[] {
    return this.projects.filter((p) => p.root).map((p) => p.root);
  }

  private layout(): Layout {
    return { groups: this.config.groups ?? [], ...(this.config.order ? { order: this.config.order } : {}) };
  }

  private saveLayout(layout: Required<Layout>): void {
    this.config = { ...this.config, order: layout.order, groups: layout.groups };
    this.store.saveConfig(this.config);
  }

  /** Projects (Chats first) and groups in the order you arranged them, and the top level's keys. */
  arrangement(): { projects: readonly Project[]; groups: readonly ProjectGroup[]; order: readonly string[] } {
    const repos = this.projects.filter((p) => p.root);
    const { projects, groups, order } = arrangedOrder(this.layout(), repos);
    return { projects: [...this.projects.filter((p) => !p.root), ...projects], groups, order };
  }

  private rootOf(id: string): string {
    const project = this.projects.find((p) => p.id === id && p.root);
    if (!project) throw new WorkspaceError('Project not found');
    return project.root;
  }

  /** A project (by id) or a group, as the arrangement knows it (by root or name). */
  private itemOf(item: ArrangeTarget): Item {
    return 'project' in item ? { project: this.rootOf(item.project) } : { group: item.group };
  }

  /**
   * Move a project into a group or to the top level, or a group among the top level, before
   * another item (or at the end). Unknown projects, groups or places are refused.
   */
  arrange(item: ArrangeTarget, place: { into?: string | null; before?: ArrangeTarget | null } = {}): void {
    try {
      const before = place.before ? this.itemOf(place.before) : null;
      this.saveLayout(move(this.layout(), this.shownRoots(), this.itemOf(item), { into: place.into ?? null, before }, new Set(this.config.hidden)));
    } catch (err) {
      throw err instanceof ArrangeError ? new WorkspaceError(err.message) : err;
    }
  }

  /**
   * A new, empty group (it stays until you delete it), before an item or at the end. With a
   * project, that project moves in, and the group takes its place.
   */
  newGroup(name: string, opts: { before?: ArrangeTarget | null; project?: string } = {}): string {
    const clean = name.trim().slice(0, MAX_GROUP_NAME);
    if (!clean) throw new WorkspaceError('A group needs a name');
    if (this.groups.some((g) => g.name === clean)) throw new WorkspaceError(`There’s already a group called "${clean}"`);
    const roots = this.shownRoots();
    const start = settle(this.layout(), roots, new Set(this.config.hidden));
    const root = opts.project ? this.rootOf(opts.project) : undefined;
    const home = root ? start.groups.find((g) => g.projects.includes(root)) : undefined;
    // Where it goes: before what you said; else where its project is (after that project's group); else last.
    const before = opts.before ? keyOf(this.itemOf(opts.before)) : root && !home ? root : undefined;
    const after = !opts.before && home ? groupKey(home.name) : undefined;
    const at = before !== undefined ? start.order.indexOf(before) : after !== undefined ? start.order.indexOf(after) + 1 : start.order.length;
    if (at < 0) throw new WorkspaceError('It can’t go there');
    const key = groupKey(clean);
    let layout: Required<Layout> = { order: [...start.order.slice(0, at), key, ...start.order.slice(at)], groups: [...start.groups, { name: clean, projects: [] }] };
    if (root) layout = move(layout, roots, { project: root }, { into: clean }, new Set(this.config.hidden));
    this.saveLayout(layout);
    return clean;
  }

  /** Put a project in a group (creating it), or take it out with `group` undefined. */
  setGroup(projectId: string, group: string | undefined): void {
    const project = this.projects.find((p) => p.id === projectId);
    if (!project) throw new WorkspaceError('Project not found');
    const name = group?.trim().slice(0, MAX_GROUP_NAME);
    const left = (this.config.groups ?? []).find((g) => g.projects.includes(project.root));
    const others = (this.config.groups ?? []).map((g) => ({ ...g, projects: g.projects.filter((r) => r !== project.root) }));
    const groups = name
      ? others.some((g) => g.name === name)
        ? others.map((g) => (g.name === name ? { ...g, projects: [...g.projects, project.root] } : g))
        : [...others, { name, projects: [project.root] }]
      : others;
    // The group it left goes when that leaves it empty (empty groups you made yourself stay).
    const kept = groups.filter((g) => !(g.name === left?.name && g.name !== name && g.projects.length === 0));
    const order = this.config.order ? this.orderAfterSetGroup(this.config.order, project.root, left?.name, name, kept) : undefined;
    this.config = { ...this.config, groups: kept, ...(order ? { order } : {}) };
    this.store.saveConfig(this.config);
  }

  /** Once arranged: a project taken out of its group lands right after it; a group that went, goes. */
  private orderAfterSetGroup(order: readonly string[], root: string, left: string | undefined, into: string | undefined, groups: readonly ProjectGroup[]): string[] {
    const names = new Set(groups.map((g) => g.name));
    const live = (k: string): boolean => k !== root && (!isGroupKey(k) || names.has(groupOfKey(k)));
    if (into) {
      const base = order.filter(live);
      return names.has(into) && !base.includes(groupKey(into)) ? [...base, groupKey(into)] : base;
    }
    // Right after the group it left (in the group's place, if that went).
    const at = left ? order.indexOf(groupKey(left)) : -1;
    if (at < 0) return [...order.filter(live), root];
    return [...order.slice(0, at + 1).filter(live), root, ...order.slice(at + 1).filter(live)];
  }

  /** Rename a group (into another one's name: the two become one). It keeps its place. */
  renameGroup(from: string, to: string): void {
    const name = to.trim().slice(0, MAX_GROUP_NAME);
    const list = this.config.groups ?? [];
    const group = list.find((g) => g.name === from);
    if (!group) throw new WorkspaceError(`No group called "${from}"`);
    if (!name) throw new WorkspaceError('A group needs a name');
    if (name === from) return;
    const into = list.find((g) => g.name === name);
    const groups = into
      ? list.filter((g) => g.name !== from).map((g) => (g.name === name ? { ...g, projects: [...new Set([...g.projects, ...group.projects])] } : g))
      : list.map((g) => (g.name === from ? { ...g, name } : g));
    const order = this.config.order?.flatMap((k) => (k !== groupKey(from) ? [k] : into ? [] : [groupKey(name)]));
    this.config = { ...this.config, groups, ...(order ? { order } : {}) };
    this.store.saveConfig(this.config);
  }

  /** Remove a group: its projects stay, back in the plain project list (where the group was). */
  ungroup(name: string): void {
    const group = (this.config.groups ?? []).find((g) => g.name === name);
    const order = this.config.order?.flatMap((k) => (k === groupKey(name) ? [...(group?.projects ?? [])] : [k]));
    this.config = { ...this.config, groups: (this.config.groups ?? []).filter((g) => g.name !== name), ...(order ? { order } : {}) };
    this.store.saveConfig(this.config);
  }

  /** Projects you hid that are still on disk (their roots), to show again. */
  get hiddenProjects(): readonly string[] {
    const shown = new Set(this.shownRoots());
    return [...new Set(this.config.hidden)].filter((r) => !shown.has(r) && existsSync(r) && isMainCheckout(r)).sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  }

  /** Show a hidden project again: it comes back where it was (its group, its place). */
  showProject(root: string): void {
    if (!this.config.hidden.includes(root)) throw new WorkspaceError('That project isn’t hidden');
    this.addProject(root);
  }

  hideProject(id: string): void {
    const project = this.projects.find((p) => p.id === id);
    if (!project) return;
    this.config = {
      ...this.config,
      projects: this.config.projects.filter((p) => p !== project.root),
      hidden: [...new Set([...this.config.hidden, project.root])],
    };
    this.store.saveConfig(this.config);
  }

  /**
   * Remove a project from Beluga (Delete Project): Beluga's own worktrees of it are archived first
   * (losslessly, restorable if you add it back), then it leaves the project list, the hidden
   * ones, its group and the sidebar's order. One a scanned root would find again is kept out.
   * The folder itself stays unless `trash`: then it goes to the Trash (never deleted outright).
   */
  async removeProject(id: string, opts: { trash?: boolean; toTrash?: (dir: string) => Promise<void>; onPhase?: (wsId: string, phase?: ArchivePhase) => void } = {}): Promise<{ root: string; archived: number; trashed: boolean }> {
    const project = this.projects.find((p) => p.id === id && p.root);
    if (!project) throw new WorkspaceError('Project not found');
    const root = project.root;
    let archived = 0;
    for (const w of project.workspaces.filter((x) => x.kind === 'worktree' && !x.archived && worktreeOrigin(x) === 'beluga')) {
      try {
        await this.archive(w.id, opts.onPhase ? (phase) => opts.onPhase!(w.id, phase) : undefined);
      } finally {
        opts.onPhase?.(w.id);
      }
      archived++;
    }
    // The config may hold it as added (/var/…) or resolved (/private/var/…): either is this project.
    const other = (r: string): boolean => real(r) !== real(root);
    const scanned = findProjects(this.config.roots).some((r) => !other(r));
    const groups = this.config.groups?.map((g) => ({ ...g, projects: g.projects.filter(other) }));
    const order = this.config.order?.filter((k) => isGroupKey(k) || other(k));
    this.config = {
      ...this.config,
      projects: this.config.projects.filter(other),
      hidden: this.config.hidden.filter(other),
      ...(groups ? { groups } : {}),
      ...(order ? { order } : {}),
      ...(scanned && !opts.trash ? { removed: [...new Set([...(this.config.removed ?? []), root])] } : {}),
    };
    this.store.saveConfig(this.config);
    let trashed = false;
    if (opts.trash) {
      await (opts.toTrash ?? moveToTrash)(root);
      trashed = true;
    }
    await this.refresh();
    return { root, archived, trashed };
  }

  /**
   * Re-scan projects and worktrees and refresh git status for every workspace. Single-flight: a call
   * while one runs waits for one more after it (what's running may have read things before the
   * call's change), and every call meanwhile shares that one.
   */
  refresh(): Promise<readonly Project[]> {
    if (!this.refreshing) return this.startRefresh();
    this.followUp ??= this.refreshing
      .catch(() => undefined)
      .then(() => {
        this.followUp = undefined;
        return this.startRefresh();
      });
    return this.followUp;
  }

  private startRefresh(): Promise<readonly Project[]> {
    const run: Promise<readonly Project[]> = this.scan()
      .then((projects) => {
        // Worktree folders an earlier background delete couldn't finish sit next to the ones still here.
        void sweepSetAside(new Set(projects.flatMap((p) => p.workspaces.filter((w) => w.kind === 'worktree').map((w) => path.dirname(w.path)))));
        // Archives cut short by a quit (their worktree is still there): once a run, before any new archive starts.
        if (!this.archivesSwept) {
          this.archivesSwept = true;
          void sweepSetAside([this.store.archivesDir]).then(() => sweepPartialArchives(this.store.archivesDir));
        }
        if (!this.sessionsSwept) {
          this.sessionsSwept = true;
          void this.sweepLeftoverSessions().catch(() => undefined);
        }
        return projects;
      })
      .finally(() => {
      if (this.refreshing === run) this.refreshing = undefined;
    });
    this.refreshing = run;
    return run;
  }

  /**
   * Refresh one folder's git status (a run there ended), not every project's → whether it changed.
   * Waits for a full refresh in flight first, so that one's older reading never lands after this;
   * and for this folder's previous one, so two run endings there both land, the later reading last.
   */
  refreshWorkspace(dir: string): Promise<boolean> {
    const key = real(dir);
    const before = this.folderRefreshes.get(key);
    const run = (before ? before.catch(() => false) : Promise.resolve(false)).then(() => this.refreshFolder(key));
    this.folderRefreshes.set(key, run);
    const forget = (): void => {
      if (this.folderRefreshes.get(key) === run) this.folderRefreshes.delete(key);
    };
    run.then(forget, forget);
    return run;
  }

  private async refreshFolder(key: string): Promise<boolean> {
    if (this.refreshing) await (this.followUp ?? this.refreshing).catch(() => undefined);
    const find = (): Workspace | undefined => this.projects.flatMap((p) => p.workspaces).find((w) => !w.archived && w.kind !== 'chat' && real(w.path) === key);
    const read = find();
    if (!read) return false;
    const status = await g.status(read.path, read.kind === 'main' ? undefined : read.base, shippedOf(read)).catch(() => undefined);
    if (this.refreshing) return false; // a full refresh started meanwhile: it has the newer reading
    // As it is now (a full refresh may have replaced it meanwhile), not as it was before git ran.
    const ws = find();
    if (!ws || ws.id !== read.id) return false;
    // Claude may have switched branches there (detached shows as "HEAD": keep what's known).
    const branch = status?.branch && status.branch !== 'HEAD' ? status.branch : ws.branch;
    if (isDeepStrictEqual(status, ws.status) && branch === ws.branch) return false;
    const next: Workspace = { ...ws, status, ...(branch ? { branch } : {}) };
    this.projects = this.projects.map((p) => (p.workspaces.includes(ws) ? { ...p, workspaces: p.workspaces.map((w) => (w === ws ? next : w)) } : p));
    return true;
  }

  private async scan(): Promise<readonly Project[]> {
    const roots = [...new Set([...findProjects(this.config.roots), ...this.config.projects].map(real))].filter(
      (r) => !this.config.hidden.includes(r) && !this.config.removed?.includes(r) && existsSync(r),
    );
    const read = await Promise.all(roots.map((root) => this.loadProject(root)));
    // Projects added while this ran (it read the config before them) stay until the next scan finds them.
    const scanned = new Set(roots);
    const loaded = [...read, ...this.projects.filter((p) => p.root && !scanned.has(p.root) && this.wanted(p.root))];
    // Same-named projects (e.g. two clones) get their parent folder added so you can tell them apart.
    const counts = new Map<string, number>();
    for (const p of loaded) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
    const named = loaded
      .map((p) => ((counts.get(p.name) ?? 0) > 1 ? { ...p, name: `${p.name} (${path.basename(path.dirname(p.root))})` } : p))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.projects = this.withAdopted([this.chatsProject(new Set(roots)), ...named]);
    return this.projects;
  }

  /** Stand-alone Claude chats, always listed first. */
  private chatsProject(roots: ReadonlySet<string> = new Set()): Project {
    const workspaces = this.records
      .filter((r) => r.projectRoot === '')
      // A chat started in a project's main folder is questions only, like any run there.
      .map((r): Workspace => ({ ...r, projectId: CHATS_PROJECT, external: false, ...(roots.has(real(r.path)) || r.thread?.readOnly ? { askOnly: true } : {}) }))
      .sort(order);
    return { id: CHATS_PROJECT, name: 'Chats', root: '', base: '', workspaces };
  }

  private async loadProject(root: string): Promise<Project> {
    const id = projectId(root);
    const name = path.basename(root);
    try {
      const base = await this.baseOf(root);
      const trees = await g.listWorktrees(root);
      const records = this.records.filter((r) => r.projectRoot === root);
      const workspaces: Workspace[] = [];
      const bases = real(this.basesDir) + path.sep;
      for (const tree of trees) {
        // Hidden worktrees (combining branches for a task's start) aren't the project's.
        if (real(tree.path).startsWith(bases) || tree.path.startsWith(this.basesDir + path.sep)) continue;
        const isMain = real(tree.path) === real(root);
        const rec = isMain ? records.find((r) => r.kind === 'main') : records.find((r) => r.kind === 'worktree' && real(r.path) === real(tree.path));
        const record: WorkspaceRecord = rec ?? {
          id: isMain ? mainId(root) : pathId(tree.path),
          projectRoot: root,
          name: isMain ? 'main' : path.basename(tree.path),
          path: tree.path,
          kind: isMain ? 'main' : 'worktree',
          createdAt: 0,
        };
        workspaces.push({ ...record, branch: tree.branch ?? record.branch, base: record.base ?? base, projectId: id, external: !rec && !isMain, ...(isMain ? { askOnly: true } : {}) });
      }
      for (const rec of records) {
        // Chats in the main folder (every project chat, so far) are questions only: work happens in worktrees.
        if (rec.kind === 'chat') workspaces.push({ ...rec, projectId: id, external: false, ...(real(rec.path) === real(root) || rec.thread?.readOnly ? { askOnly: true } : {}) });
        else if (rec.archived && rec.kind === 'worktree') workspaces.push({ ...rec, projectId: id, external: false });
      }
      const withStatus = await Promise.all(
        workspaces.map(async (w) => (w.archived || w.kind === 'chat' ? w : { ...w, status: await g.status(w.path, w.kind === 'main' ? undefined : w.base, shippedOf(w)).catch(() => undefined) })),
      );
      // The main checkout's status (just read) says what it's on and how much is uncommitted.
      const mainStatus = withStatus.find((w) => w.kind === 'main')?.status;
      const known = mainStatus ? { current: mainStatus.branch && mainStatus.branch !== 'HEAD' ? mainStatus.branch : undefined, dirty: mainStatus.changed } : undefined;
      const line = await sync.defaultBranch(root, base, known).catch(() => undefined);
      const syncInfo: ProjectSync | undefined = line ? { ...line, ...this.fetchState.get(root) } : undefined;
      // Git was read meanwhile: a record changed since (an agent picked, a session remembered, a rename)
      // is taken as it is now, never put back as it was when this read began.
      const current = (w: Workspace): Workspace => {
        const now = this.records.find((r) => r.id === w.id);
        if (!now || now === records.find((r) => r.id === w.id)) return w;
        const branch = w.kind === 'worktree' || w.kind === 'main' ? (trees.find((t) => real(t.path) === real(w.path))?.branch ?? now.branch) : now.branch;
        return { ...now, ...(branch ? { branch } : {}), base: now.base ?? base, projectId: id, external: false, ...(w.askOnly ? { askOnly: true } : {}), ...(w.status ? { status: w.status } : {}) };
      };
      const fork = this.forks.get(root);
      return { id, name, root, base, workspaces: withStatus.map(current).sort(order), scripts: resolveScripts(root, this.config.scripts?.[root]), ...(syncInfo ? { sync: syncInfo } : {}), ...(fork ? { fork } : {}) };
    } catch (err) {
      return { id, name, root, base: 'HEAD', workspaces: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** origin's default branch ("origin/main"), or the one learned from the remote when origin/HEAD isn't set. */
  async baseOf(root: string): Promise<string> {
    const learned = this.remoteDefaults.get(root);
    if (learned && (await g.isCommit(root, `origin/${learned}`))) return `origin/${learned}`;
    return g.defaultBase(root);
  }

  /** The project for an id, with a folder (not the Chats pseudo-project). */
  repoProject(projectId: string): Project {
    const project = this.projects.find((p) => p.id === projectId && p.root);
    if (!project) throw new WorkspaceError('Project not found');
    return project;
  }

  /** Where hidden worktrees go (combining branches for a task's start): never listed as a project's worktrees. */
  get basesDir(): string {
    return path.join(this.store.workspacesDir, '.bases');
  }

  /**
   * A task that builds on several unmerged branches starts from them all: what it needs of them
   * (none already in another, nor in the default branch), combined into `beluga/<key>-base` in a
   * hidden worktree. One left: that branch itself. A conflict is left there to fix (run again after).
   */
  async combineBase(projectId: string, key: string, branches: readonly string[], into?: string): Promise<g.CombineResult> {
    const project = this.repoProject(projectId);
    // In a plan: what's already in the plan's branch isn't needed again.
    const main = into ?? (await this.baseOf(project.root));
    const needed = await g.neededBranches(project.root, branches, main);
    const name = `${slug(key)}-base`;
    if (needed.length < 2) return { ok: true, branch: needed[0] ?? main };
    const dir = path.join(this.basesDir, `${slug(project.name)}-${project.id.slice(0, 4)}`, name);
    mkdirSync(path.dirname(dir), { recursive: true });
    return g.combineBranches(project.root, dir, `${this.branchPrefix()}${name}`, needed);
  }

  // ------------------------------------------------------------- a plan's branch

  /** A plan's branch: made from the latest default branch unless it's there (here, or on origin) → whether it was made. */
  async planBranch(projectId: string, branch: string): Promise<{ made: boolean }> {
    const { root } = this.repoProject(projectId);
    if (!/^plan\/[\w.-]+$/.test(branch)) throw new WorkspaceError(`“${branch}” isn’t a plan branch name`);
    if (await g.isCommit(root, `refs/heads/${branch}`)) return { made: false };
    if (await g.hasRemote(root)) await g.tryGit(root, ['fetch', 'origin', '--prune']);
    if (await g.isCommit(root, `refs/remotes/origin/${branch}`)) {
      await g.git(root, ['branch', '--track', branch, `origin/${branch}`]);
      return { made: false };
    }
    await g.git(root, ['branch', '--no-track', branch, await this.baseOf(root)]);
    return { made: true };
  }

  /**
   * Merge task branches (--no-ff) into a plan's branch, those already in it skipped: in a hidden
   * worktree, or where the branch is checked out already (kept there; it must be clean). A conflict
   * is left there to fix (run again after).
   */
  async mergeIntoPlan(projectId: string, branch: string, branches: readonly string[]): Promise<g.CombineResult> {
    const project = this.repoProject(projectId);
    const hidden = path.join(this.basesDir, `${slug(project.name)}-${project.id.slice(0, 4)}`, slug(branch));
    const out = (await g.listWorktrees(project.root)).find((w) => w.branch === branch && real(w.path) !== real(hidden));
    if (out) {
      const dirty = (await g.git(out.path, ['status', '--porcelain', '--untracked-files=no'])).split('\n').filter(Boolean);
      const merging = await g.tryGit(out.path, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
      if (dirty.length && !merging) throw new WorkspaceError(`${branch} is checked out in ${out.path} with uncommitted changes: commit them, and the merge goes on`);
      return g.combineBranches(project.root, out.path, branch, branches, { keep: true });
    }
    mkdirSync(path.dirname(hidden), { recursive: true });
    return g.combineBranches(project.root, hidden, branch, branches);
  }

  /** The default branch as GitHub has it now ("origin/main", fetched first), else the local one. */
  async latestBase(projectId: string): Promise<string> {
    const { root } = this.repoProject(projectId);
    if (await g.hasRemote(root)) await g.tryGit(root, ['fetch', 'origin', '--prune']);
    return this.baseOf(root);
  }

  /** Whether a branch is already in the project's default branch. */
  async inDefaultBranch(projectId: string, branch: string): Promise<boolean> {
    const { root } = this.repoProject(projectId);
    return g.isAncestor(root, branch, await this.baseOf(root));
  }

  /** Delete a branch whose work is merged into `into` (git refuses one that isn't, or that's checked out). */
  async dropBranch(projectId: string, branch: string, into: string): Promise<void> {
    await g.deleteMergedBranch(this.repoProject(projectId).root, branch, into);
  }

  /** Merge a branch into the main folder, which must be on the default branch. */
  async mergeBranchIntoMain(projectId: string, branch: string): Promise<g.MergeResult> {
    const { root } = this.repoProject(projectId);
    const base = await this.baseOf(root);
    const target = base.startsWith('origin/') ? base.slice('origin/'.length) : base === 'HEAD' ? undefined : base;
    const res = await g.mergeInto(root, branch, target);
    await this.refresh();
    return res;
  }

  /** The default branch's name, without the remote ("main"). */
  async defaultBranchName(projectId: string): Promise<string> {
    const base = await this.baseOf(this.repoProject(projectId).root);
    return base.replace(/^origin\//, '');
  }

  /** Record what a project's origin was forked from (undefined: not a fork), shown right away. */
  setFork(projectId: string, fork: ForkOf | undefined): void {
    const project = this.projects.find((p) => p.id === projectId && p.root);
    if (!project) return;
    if (fork) this.forks.set(project.root, fork);
    else this.forks.delete(project.root);
    this.projects = this.projects.map((p) => {
      if (p !== project) return p;
      const { fork: _f, ...rest } = p;
      return fork ? { ...rest, fork } : rest;
    });
  }

  /** Mark a project as fetching (or record how its last fetch went), shown right away. */
  setFetchState(projectId: string, state: Pick<ProjectSync, 'fetching' | 'fetchError'>): void {
    const project = this.projects.find((p) => p.id === projectId && p.root);
    if (!project) return;
    this.fetchState.set(project.root, state);
    this.projects = this.projects.map((p) => {
      if (p !== project || !p.sync) return p;
      const { fetching: _f, fetchError: _e, ...line } = p.sync;
      return { ...p, sync: { ...line, ...state } };
    });
  }

  /** A remote's default branch, learned while fetching (used when origin/HEAD isn't set). */
  learnRemoteDefault(projectId: string, branch: string): void {
    const project = this.projects.find((p) => p.id === projectId && p.root);
    if (project && /^[\w./-]+$/.test(branch)) this.remoteDefaults.set(project.root, branch);
  }

  /**
   * The folder whose history to show for a project or workspace id: a worktree's own folder,
   * else the project's main folder.
   */
  historyDir(id: string): string {
    const project = this.projects.find((p) => p.id === id && p.root);
    if (project) return project.root;
    const ws = this.find(id);
    if (!ws) throw new WorkspaceError('That project or workspace no longer exists');
    if (ws.kind === 'worktree' && !ws.archived && existsSync(ws.path)) return ws.path;
    if (ws.projectRoot) return ws.projectRoot;
    throw new WorkspaceError('A chat outside a project has no history');
  }

  /** A new worktree on a new beluga/<name> branch starting at `startPoint` (a commit), compared with `base`. */
  async createWorktreeAt(projectId: string, name: string, startPoint: string, base?: string): Promise<Workspace> {
    const project = this.repoProject(projectId);
    if (!(await g.isCommit(project.root, startPoint))) throw new WorkspaceError(`There’s no commit ${startPoint.slice(0, 12)} here`);
    const s = slug(name);
    const dir = this.freeDir(project, s);
    const branch = await this.freeBranch(project.root, `${this.branchPrefix()}${s}`);
    await g.git(project.root, ['worktree', 'add', '-b', branch, dir, startPoint]);
    await g.excludeProjectDir(dir);
    await copyEnvFiles(project.root, dir);
    const record: WorkspaceRecord = { id: freshId(), projectRoot: project.root, name: s, path: dir, kind: 'worktree', branch, base: base ?? project.base, createdAt: Date.now(), envSnapshot: await envSnapshot(dir) };
    this.saveRecord(record);
    await this.refresh();
    return this.require(record.id);
  }

  /**
   * "Move my changes to a new worktree": a worktree from the main folder's current commit gets
   * its uncommitted changes (stash, apply there), so the main folder is clean; then the default
   * branch fast-forwards. If the changes can't land in the worktree, they go back and nothing moves.
   */
  async moveChangesToWorktree(projectId: string, name = 'changes-from-main'): Promise<{ ws: Workspace; outcome: sync.UpdateOutcome }> {
    const project = this.repoProject(projectId);
    const operation = await sync.operationIn(project.root);
    if (operation) throw new WorkspaceError(`A ${operation} is in progress in the main folder. Finish or abort it first.`);
    const head = (await g.git(project.root, ['rev-parse', 'HEAD'])).trim();
    const ws = await this.createWorktreeAt(projectId, name, head);
    try {
      await this.carryChanges(project.root, ws, `moving to the worktree ${ws.name}`);
    } catch (err) {
      // Nothing moved: the new worktree (and its branch) go again.
      if (this.find(ws.id)) await this.remove(ws.id).catch(() => undefined);
      throw err;
    }
    const outcome = await sync.updateDefault(project.root, project.base);
    await this.refresh();
    return { ws: this.find(ws.id) ?? ws, outcome };
  }

  /**
   * The main folder is on another branch with uncommitted work: that branch and its changes move
   * to a worktree of their own, and the main folder goes back to the default branch.
   */
  async moveBranchToWorktree(projectId: string): Promise<{ ws: Workspace; branch: string }> {
    const project = this.repoProject(projectId);
    const line = await sync.defaultBranch(project.root, project.base);
    if (line.onDefault) throw new WorkspaceError(`The main folder is already on ${line.branch}`);
    if (line.operation) throw new WorkspaceError(`A ${line.operation} is in progress in the main folder. Finish or abort it first.`);
    const head = (await g.git(project.root, ['rev-parse', 'HEAD'])).trim();
    const stash = await sync.stashPush(project.root, `moving ${line.current ?? 'the detached HEAD'} to a worktree`);
    const switched = await sync.switchToDefault(project.root, project.base);
    if (switched.kind !== 'switched') {
      const back = stash ? (await sync.stashApply(project.root, stash.sha)).ok : true;
      if (stash && back) await sync.stashDrop(project.root, stash.sha);
      const why = switched.kind === 'dirty' ? `${switched.files.join(', ')} would be overwritten` : switched.message;
      throw new WorkspaceError(`Couldn’t switch to ${line.branch}: ${why}${stash && !back ? `. Your changes are safe in the stash “${stash.message}”.` : ''}`);
    }
    let ws: Workspace;
    try {
      ws = line.current ? await this.createWorktreeOn(projectId, line.current, line.current) : await this.createWorktreeAt(projectId, 'detached-work', head);
    } catch (err) {
      const kept = stash ? ` Your uncommitted changes are kept in the stash “${stash.message}”.` : '';
      throw new WorkspaceError(`The main folder is on ${line.branch} now, but the worktree for ${line.current ?? 'your work'} couldn’t be made: ${err instanceof Error ? err.message : String(err)}.${kept}`);
    }
    if (stash) {
      const applied = await sync.stashApply(ws.path, stash.sha);
      if (!applied.ok) throw new WorkspaceError(`${ws.name} is ready, but your changes conflicted there (${applied.conflicts.join(', ') || applied.message}). They’re kept in the stash “${stash.message}”.`);
      await sync.stashDrop(ws.path, stash.sha);
    }
    await this.refresh();
    return { ws: this.find(ws.id) ?? ws, branch: line.branch };
  }

  /** Move the main folder's uncommitted changes into `ws` (same commit), or put them back and remove `ws`. */
  private async carryChanges(root: string, ws: Workspace, label: string): Promise<void> {
    const stash = await sync.stashPush(root, label);
    if (!stash) return;
    const applied = await sync.stashApply(ws.path, stash.sha);
    if (applied.ok) return sync.stashDrop(root, stash.sha);
    // Back where they were; the new worktree goes (its branch has nothing of its own).
    const back = await sync.stashApply(root, stash.sha);
    if (back.ok) await sync.stashDrop(root, stash.sha);
    await this.remove(ws.id).catch(() => undefined);
    throw new WorkspaceError(`Couldn’t move the changes: ${applied.message}${back.ok ? '. They’re back in the main folder.' : ` They’re kept in the stash “${stash.message}”.`}`);
  }

  // -------------------------------------------------------------- workspaces

  /**
   * New worktree on a fresh branch from the latest origin default branch, or from `base` (any
   * branch of the project). The worktree remembers what it branched from, so what it's ahead by,
   * its review and its merge compare against that.
   */
  /** An id for a worktree about to be made (its row shows under it while it's made: see core/optimistic.ts). */
  newWorktreeId(): string {
    return freshId();
  }

  /** `opts.id`: the id it gets (from newWorktreeId), else a fresh one. */
  /** `opts.agent`: the agent it runs (unset: your default). */
  async createWorktree(projectIdOrRoot: string, name: string, base?: string, opts: { readonly id?: string; readonly agent?: AgentRef; readonly thread?: ThreadRecord } = {}): Promise<Workspace> {
    const project = this.projects.find((p) => p.id === projectIdOrRoot || p.root === projectIdOrRoot);
    if (!project) throw new WorkspaceError('Project not found');
    if (base !== undefined && !(await g.isCommit(project.root, base))) throw new WorkspaceError(`There's no branch called ${base}`);
    const from = base ?? project.base;
    const s = slug(name);
    const dir = this.freeDir(project, s);
    const branch = await this.freeBranch(project.root, `${this.branchPrefix()}${s}`);
    await g.addWorktree(project.root, dir, branch, from);
    await g.excludeProjectDir(dir);
    await copyEnvFiles(project.root, dir);
    const record: WorkspaceRecord = { id: opts.id && !this.records.some((r) => r.id === opts.id) ? opts.id : freshId(), projectRoot: project.root, name: s, path: dir, kind: 'worktree', branch, base: from, createdAt: Date.now(), envSnapshot: await envSnapshot(dir), ...agentFields(opts.agent), ...(opts.thread ? { thread: opts.thread } : {}) };
    this.saveRecord(record);
    const status = await g.status(dir, from).catch(() => undefined);
    return this.adopt(project, { ...record, projectId: project.id, external: false, ...(status ? { status } : {}) });
  }

  /**
   * A worktree on a pull request's own branch (BLG-633). One from this repository gets its
   * branch, fetched from origin and tracking it, so a push there updates the pull request (a
   * local branch of that name is used as it is, moved up to origin's when it can be); one from a
   * fork gets its branch's name (pr-<n> when that's taken here) from GitHub's pull ref, which
   * `git pull` keeps current. Named pr-<n> and the first words of its title.
   * It's compared with the branch the pull request merges into.
   */
  async createPullWorktree(projectId: string, pull: PullHead, opts: { readonly id?: string } = {}): Promise<Workspace> {
    const project = this.repoProject(projectId);
    const root = project.root;
    if (!(await g.hasRemote(root))) throw new WorkspaceError('This project has no origin to fetch the pull request from');
    await g.tryGit(root, ['fetch', 'origin', '--prune']);
    const s = pullName(pull);
    const dir = this.freeDir(project, s);
    let branch: string;
    if (!pull.fork && pull.branch) {
      branch = pull.branch;
      if (!(await g.isCommit(root, `refs/remotes/origin/${branch}`))) throw new WorkspaceError(`${branch} isn’t on origin (it may have been deleted, or the fetch failed)`);
      if (await g.isCommit(root, `refs/heads/${branch}`)) {
        const out = (await g.listWorktrees(root)).find((w) => w.branch === branch);
        if (out) throw new WorkspaceError(`${branch} is already checked out in ${out.path}`);
        await g.git(root, ['worktree', 'add', dir, branch]);
        // Your own commits on it stay; otherwise it catches up with the pull request.
        await g.tryGit(dir, ['merge', '--ff-only', `origin/${branch}`]);
      } else {
        await g.git(root, ['worktree', 'add', '--track', '-b', branch, dir, `origin/${branch}`]);
      }
    } else {
      const named = pull.branch && !pull.branch.startsWith('-') && !(await g.isCommit(root, `refs/heads/${pull.branch}`));
      branch = named ? pull.branch : await this.freeBranch(root, `pr-${pull.number}`);
      // Its head is kept too (BLG-746): GitHub has these commits, so they never read as pushed nowhere.
      await g.git(root, ['fetch', 'origin', `+refs/pull/${pull.number}/head:refs/heads/${branch}`, `+refs/pull/${pull.number}/head:${g.pullHeadRef(pull.number)}`]).catch((err: unknown) => {
        throw new WorkspaceError(`Couldn’t fetch pull request #${pull.number} from origin: ${err instanceof Error ? err.message : String(err)}`);
      });
      await g.git(root, ['worktree', 'add', dir, branch]);
      // `git pull` there brings the pull request's new commits.
      await g.git(root, ['config', `branch.${branch}.remote`, 'origin']);
      await g.git(root, ['config', `branch.${branch}.merge`, `refs/pull/${pull.number}/head`]);
    }
    await g.excludeProjectDir(dir);
    await copyEnvFiles(root, dir);
    const base = pull.base && (await g.isCommit(root, `refs/remotes/origin/${pull.base}`)) ? `origin/${pull.base}` : project.base;
    const record: WorkspaceRecord = { id: opts.id && !this.records.some((r) => r.id === opts.id) ? opts.id : freshId(), projectRoot: root, name: s, path: dir, kind: 'worktree', branch, base, createdAt: Date.now(), envSnapshot: await envSnapshot(dir) };
    this.saveRecord(record);
    const status = await g.status(dir, base).catch(() => undefined);
    return this.adopt(project, { ...record, projectId: project.id, external: false, ...(status ? { status } : {}) });
  }

  /**
   * A workspace just made, listed at once: no re-scan of every project on the way to its first
   * message (that took seconds with many projects, BLG-531). The next full refresh lists it as it
   * finds it; one that began before it was made keeps it here until then.
   */
  private adopt(project: Project, ws: Workspace): Workspace {
    this.adopted.set(ws.id, ws);
    this.projects = this.projects.map((p) => (p.id === project.id ? { ...p, workspaces: [...p.workspaces.filter((w) => w.id !== ws.id), ws].sort(order) } : p));
    return ws;
  }

  /** Workspaces listed by `adopt` that a full refresh hasn't found yet, by id. */
  private readonly adopted = new Map<string, Workspace>();

  /** A scan's projects, with what was made while it ran (it read the disk before them). */
  private withAdopted(projects: Project[]): Project[] {
    if (!this.adopted.size) return projects;
    const found = new Set(projects.flatMap((p) => p.workspaces.map((w) => w.id)));
    const kept = new Set(this.records.map((r) => r.id));
    // Found by now, or deleted meanwhile: nothing to keep.
    for (const id of this.adopted.keys()) if (found.has(id) || !kept.has(id)) this.adopted.delete(id);
    if (!this.adopted.size) return projects;
    return projects.map((p) => {
      // Its record as it is now (renamed, a session remembered since).
      const add = [...this.adopted.values()].filter((w) => w.projectId === p.id).map((w) => ({ ...w, ...this.records.find((r) => r.id === w.id) }));
      return add.length ? { ...p, workspaces: [...p.workspaces, ...add].sort(order) } : p;
    });
  }

  /** The branches a new worktree can start from, the project's default base first. */
  async branches(projectId: string): Promise<{ base: string; branches: string[] }> {
    const project = this.projects.find((p) => p.id === projectId);
    if (!project?.root) throw new WorkspaceError('Project not found');
    const all = await g.listBranches(project.root);
    return { base: project.base, branches: [project.base, ...all.filter((b) => b !== project.base)] };
  }

  /** A folder for a new worktree that no live or archived workspace uses (adds -2, -3…). */
  private freeDir(project: Project, name: string): string {
    const parent = path.join(this.store.workspacesDir, `${slug(project.name)}-${project.id.slice(0, 4)}`);
    mkdirSync(parent, { recursive: true });
    const base = real(parent);
    for (let i = 1; ; i++) {
      const dir = path.join(base, i === 1 ? name : `${name}-${i}`);
      if (!existsSync(dir) && !this.records.some((r) => real(r.path) === dir)) return dir;
    }
  }

  /** `mine`: the branch being renamed, free for itself (renaming foo-2 back to foo-2 keeps it). */
  private async freeBranch(repo: string, wanted: string, mine?: string): Promise<string> {
    for (let i = 1; ; i++) {
      const name = i === 1 ? wanted : `${wanted}-${i}`;
      if (name === mine) return name;
      try {
        await g.git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
      } catch {
        return name;
      }
    }
  }

  /** A conversation with Claude in the project's main folder, no worktree needed. */
  private get chatsDir(): string {
    return path.join(this.store.workspacesDir, '..', 'chats');
  }

  /** `opts`: a thread's chat (core/threads): its record, and the folder it reads (a project chat's own: the main folder). */
  async createChat(projectIdOrRoot: string, title: string, inDir?: string, opts: { readonly dir?: string; readonly thread?: ThreadRecord } = {}): Promise<Workspace> {
    if (projectIdOrRoot === CHATS_PROJECT) return this.createStandaloneChat(title, opts.dir ?? inDir, opts.thread);
    const project = this.projects.find((p) => p.id === projectIdOrRoot || (p.root !== '' && p.root === projectIdOrRoot));
    if (!project) throw new WorkspaceError('Project not found');
    const record: WorkspaceRecord = { id: `chat-${randomUUID().slice(0, 8)}`, projectRoot: project.root, name: title.trim().slice(0, 40) || 'chat', path: opts.dir ?? project.root, kind: 'chat', createdAt: Date.now(), ...(opts.thread ? { thread: opts.thread } : {}) };
    this.saveRecord(record);
    // Questions only, like every chat in a project's main folder (see loadProject).
    return this.adopt(project, { ...record, projectId: project.id, external: false, askOnly: true });
  }

  /** A Claude chat with no project: its own scratch folder for anything Claude makes. */
  async createStandaloneChat(title: string, inDir?: string, thread?: ThreadRecord): Promise<Workspace> {
    const id = `chat-${randomUUID().slice(0, 8)}`;
    // Runs in the folder you give it (e.g. where you started Beluga), or its own scratch folder.
    const dir = inDir || path.join(this.chatsDir, id);
    mkdirSync(dir, { recursive: true });
    const record: WorkspaceRecord = { id, projectRoot: '', name: title.trim().slice(0, 40) || 'chat', path: real(dir), kind: 'chat', createdAt: Date.now(), ...(thread ? { thread } : {}) };
    this.saveRecord(record);
    const chats = this.projects.find((p) => p.id === CHATS_PROJECT);
    if (!chats) {
      await this.refresh();
      return this.require(record.id);
    }
    // Started in a project's main folder: questions only (see chatsProject).
    const askOnly = thread?.readOnly || this.projects.some((p) => p.root && real(p.root) === record.path);
    return this.adopt(chats, { ...record, projectId: CHATS_PROJECT, external: false, ...(askOnly ? { askOnly: true } : {}) });
  }

  /**
   * Copy a workspace into a new worktree that starts from its current state, with its conversation.
   * `at`: from an earlier snapshot of it instead (see snapshots.ts), with `session` (Claude's, cut to
   * there; null: none) and `history` (the conversation up to there) in place of the whole of them.
   */
  async fork(id: string, name: string, opts: { base?: string; at?: string; session?: string | null; history?: readonly unknown[] } = {}): Promise<Workspace> {
    const source = this.require(id);
    const project = this.projectOf(source);
    const s = slug(name);
    const dir = this.freeDir(project, s);
    // `opts.base`: start from there (e.g. the latest origin) instead of the source's own commits.
    const from = opts.at ? await snapshotBase(source.path, opts.at) : (opts.base ?? (source.kind === 'chat' ? project.base : (source.branch ?? 'HEAD')));
    const branch = await this.freeBranch(project.root, `${this.branchPrefix()}${s}`);
    await g.addWorktree(project.root, dir, branch, from);
    await g.excludeProjectDir(dir);
    if (opts.at) await applySnapshot(dir, opts.at);
    await copyEnvFiles(source.kind === 'chat' ? project.root : source.path, dir);
    const record: WorkspaceRecord = {
      id: freshId(),
      projectRoot: project.root,
      name: s,
      path: dir,
      kind: 'worktree',
      branch,
      base: opts.base ?? source.base ?? project.base,
      createdAt: Date.now(),
      forkedFrom: source.id,
      ...forkSessionOf(source, opts.session),
      envSnapshot: await envSnapshot(dir),
    };
    this.saveRecord(record);
    if (opts.history) this.store.saveHistory(record.id, opts.history);
    else if (existsSync(this.store.historyFile(source.id))) copyFileSync(this.store.historyFile(source.id), this.store.historyFile(record.id));
    await this.refresh();
    return this.require(record.id);
  }

  /**
   * A new chat beside a chat (BLG-385): in the same project (or its own scratch folder), with
   * `history` as its conversation and `session` as Claude's (null: Claude starts fresh).
   */
  async forkChat(id: string, name: string, opts: { session: string | null; history: readonly unknown[] }): Promise<Workspace> {
    const source = this.require(id);
    if (source.kind !== 'chat') throw new WorkspaceError('Only a chat forks into a chat');
    const standalone = source.projectRoot === '';
    const chatId = `chat-${randomUUID().slice(0, 8)}`;
    // A chat with its own scratch folder gets one of its own; one in a folder you chose stays there.
    const own = standalone && real(source.path).startsWith(real(this.chatsDir) + path.sep);
    const dir = own ? path.join(this.chatsDir, chatId) : source.path;
    if (own) mkdirSync(dir, { recursive: true });
    const record: WorkspaceRecord = { id: chatId, projectRoot: source.projectRoot, name: slug(name).slice(0, 40) || 'chat', path: own ? real(dir) : dir, kind: 'chat', createdAt: Date.now(), forkedFrom: source.id, ...forkSessionOf(source, opts.session) };
    this.saveRecord(record);
    this.store.saveHistory(record.id, opts.history);
    await this.refresh();
    return this.require(record.id);
  }

  /** Go on from `sessionId` (a copy of Claude's session, cut to an earlier message), or start fresh (null). */
  rewindSession(id: string, sessionId: string | null): void {
    this.patchRecord(id, { sessionId: sessionId ?? undefined, forkFromSession: undefined, ...(sessionId ? {} : { sessionRuntime: undefined }) });
  }

  /**
   * Turn a chat in a project's main folder into a worktree, in place: a new branch from the latest
   * origin (or `opts.base`) and its own folder, while the conversation keeps its id, its history
   * and Claude's session. Returns the folder it ran in until now (its session is filed there).
   */
  async chatToWorktree(id: string, name: string, opts: { base?: string } = {}): Promise<{ ws: Workspace; was: string }> {
    const source = this.require(id);
    if (source.kind !== 'chat' || !source.projectRoot) throw new WorkspaceError('Only a chat in a project can become a worktree');
    const project = this.projectOf(source);
    const s = slug(name);
    const dir = this.freeDir(project, s);
    const from = opts.base ?? project.base;
    const branch = await this.freeBranch(project.root, `${this.branchPrefix()}${s}`);
    await g.addWorktree(project.root, dir, branch, from);
    await g.excludeProjectDir(dir);
    await copyEnvFiles(project.root, dir);
    this.patchRecord(id, { name: s, path: dir, kind: 'worktree', branch, base: from, envSnapshot: await envSnapshot(dir) });
    await this.refresh();
    return { ws: this.require(id), was: source.path };
  }

  /**
   * Archive smartly: everything of yours in the worktree is kept (uncommitted changes, new files,
   * .env and other ignored files of yours), dependencies, builds and caches are thrown away, and
   * the folder goes. Its branch and conversation stay; `restore` brings it all back.
   */
  async archive(id: string, onPhase?: (phase: ArchivePhase) => void): Promise<ArchiveManifest | undefined> {
    const ws = this.require(id);
    if (ws.kind === 'main') throw new WorkspaceError("The main folder can't be archived");
    let manifest: ArchiveManifest | undefined;
    // Its test runs (an e2e's daemon, vite, browser) go first: nothing keeps running for a folder that's gone.
    if (ws.kind === 'worktree') await stopTestProcesses(ws.path, { leaving: true }).catch(() => 0);
    if (ws.kind === 'worktree') {
      // Deleted by hand already: nothing to keep; forget it in git.
      if (!existsSync(ws.path)) await g.git(ws.projectRoot, ['worktree', 'prune']).catch(() => undefined);
      else manifest = await archiveWorktree({ repo: ws.projectRoot, dir: ws.path, id, archivesDir: this.store.archivesDir, ...(onPhase ? { onPhase } : {}) });
    }
    this.patchRecord(id, { archived: true, ...(manifest ? { archive: { freedBytes: manifest.freedBytes, keptBytes: manifest.keptBytes, remake: manifest.remake, at: manifest.archivedAt } } : {}) });
    await this.refresh();
    return manifest;
  }

  /** What archiving (or freeing space in) a worktree would throw away and keep. */
  async archivePlan(id: string): Promise<ArchivePreview | undefined> {
    const ws = this.require(id);
    if (ws.kind !== 'worktree' || ws.archived || !existsSync(ws.path)) return undefined;
    return previewOf(await planArchive(ws.path));
  }

  /**
   * What deleting a worktree would lose that archiving keeps (BLG-617): its branch's commits that are
   * on neither its base nor any remote. Undefined: nothing to warn about (not ours, no branch, all pushed).
   * `mergedHeads`: heads of its pull requests GitHub says merged; with its own prShipped, what's in
   * them shipped (BLG-831), so only commits made after count.
   */
  async deletePlan(id: string, mergedHeads: readonly string[] = []): Promise<DeletePlan | undefined> {
    const ws = this.require(id);
    // Another tool's worktree keeps its branch when deleted (see remove): nothing of it is lost.
    if (ws.kind !== 'worktree' || !ws.branch || ws.external || !real(ws.path).startsWith(real(this.store.workspacesDir) + path.sep)) return undefined;
    const into = ws.base ?? (await this.baseOf(ws.projectRoot));
    const shipped = [...new Set([...mergedHeads, ...shippedOf(ws)])];
    let lost = await g.unpushedCommits(ws.projectRoot, ws.branch, into, shipped);
    // Checked against the remote before warning (BLG-746): merged on GitHub a minute ago reads as merged.
    if (lost.count) {
      await g.catchUpForDelete(ws.projectRoot, ws.branch, into);
      lost = await g.unpushedCommits(ws.projectRoot, ws.branch, into, shipped);
    }
    return lost.count ? { branch: ws.branch, into, unpushed: lost.count, subjects: lost.subjects } : undefined;
  }

  /** Throw away a worktree's dependencies, builds and caches (it stays; they're made again by its setup). */
  async freeSpace(id: string): Promise<{ bytes: number; remake: readonly string[] }> {
    const ws = this.require(id);
    if (ws.kind !== 'worktree' || ws.archived || !existsSync(ws.path)) throw new WorkspaceError('Only a worktree that’s there can be cleaned');
    const freed = await freeSpace(ws.path);
    return { bytes: freed.bytes, remake: freed.remake };
  }

  /** Bring an archived worktree back: as it was when archived smartly, else from its branch. */
  async restore(id: string): Promise<ArchiveManifest | undefined> {
    const ws = this.require(id);
    if (!ws.archived) return undefined;
    let manifest: ArchiveManifest | undefined;
    if (ws.kind === 'worktree' && readManifest(this.store.archivesDir, id)) {
      manifest = await restoreWorktree({ repo: ws.projectRoot, dir: ws.path, id, archivesDir: this.store.archivesDir });
    } else if (ws.kind === 'worktree' && ws.branch) {
      mkdirSync(path.dirname(ws.path), { recursive: true });
      await g.git(ws.projectRoot, ['worktree', 'add', ws.path, ws.branch]);
    }
    // Back from its branch alone (or an archive from before env files were kept): the main folder's env files again.
    if (ws.kind === 'worktree') await copyEnvFiles(ws.projectRoot, ws.path);
    this.patchRecord(id, { archived: false, archive: undefined });
    await this.refresh();
    return manifest;
  }

  /**
   * Claude Code's sessions for worktrees of ours deleted before Delete took them too (BLG-532): ones
   * whose folder is gone and that no workspace still names (an archived one's stay, for Restore).
   * Once a run. → how many folders' sessions went.
   */
  async sweepLeftoverSessions(): Promise<number> {
    // An unreadable workspaces.json reads as none: then every archived worktree's would look left over.
    if (!this.records.length) return 0;
    const base = real(this.store.workspacesDir);
    const named = new Set(this.records.flatMap((r) => (r.path ? pathVariants(r.path) : [])));
    let dropped = 0;
    for (const cwd of await sessionFoldersUnder(base)) {
      // The worktree it ran in: <project>/<name> under the workspaces folder (Claude may have run in a sub-folder).
      const parts = path.relative(base, real(cwd)).split(path.sep);
      if (parts.length < 2 || parts[0] === '..') continue;
      const folder = path.join(base, parts[0]!, parts[1]!);
      if (existsSync(folder) || pathVariants(folder).some((v) => named.has(v))) continue;
      await dropFolderSessions(cwd).catch(() => 0);
      dropped++;
    }
    return dropped;
  }

  /** Permanently delete: worktree folder, its branch, and its conversation. */
  async remove(id: string): Promise<void> {
    const ws = this.require(id);
    if (ws.kind === 'main') throw new WorkspaceError("The main folder can't be deleted from Beluga");
    // Only ever delete Beluga's own scratch folders, never a folder you started a chat in.
    const scratch = ws.projectRoot === '' && real(ws.path).startsWith(real(this.chatsDir) + path.sep);
    // Claude Code's sessions for a folder of ours that's gone for good (BLG-532): another tool's folder keeps its own.
    // Resolved while the folder is still there, so it's filed under the same spelling Claude Code used.
    const sessionsDir = real(ws.path);
    const ours = scratch || (ws.kind === 'worktree' && !ws.external && sessionsDir.startsWith(real(this.store.workspacesDir) + path.sep));
    if (ws.kind === 'worktree') {
      // Made by another tool (Conductor, Claude Code), even if you've talked in it here: never force-remove it
      // (its uncommitted work isn't ours to discard) and keep its branch.
      const foreign = ws.external || !sessionsDir.startsWith(real(this.store.workspacesDir) + path.sep);
      if (!ws.archived) await stopTestProcesses(ws.path, { leaving: true }).catch(() => 0);
      // Set aside and deleted in the background: a big folder deleted in place froze the Mac (see removeWorktreeKeepingBranch).
      if (!ws.archived && existsSync(ws.path) && (await isWorktreeOf(ws.projectRoot, ws.path))) await removeWorktreeKeepingBranch(ws.projectRoot, ws.path, !foreign);
      else if (!ws.archived) {
        // Git already let the folder go (an earlier delete stopped halfway): `worktree remove` would only say
        // "is not a working tree", so take what's left away here. Another tool's folder only when it's empty.
        if (existsSync(ws.path) && (!foreign || !readdirSync(ws.path).length)) await deleteFolderInBackground(ws.path).catch(() => rmSync(ws.path, { recursive: true, force: true }));
        // Folder deleted by hand: forget it in git too, or the branch stays "checked out" and the worktree comes back.
        await g.git(ws.projectRoot, ['worktree', 'prune']).catch(() => undefined);
      }
      if (ws.branch && !foreign) await g.deleteBranch(ws.projectRoot, ws.branch).catch(() => undefined);
    }
    rmSync(this.store.historyFile(id), { force: true });
    if (ws.kind === 'worktree' && existsSync(ws.projectRoot)) await dropSnapshots(ws.projectRoot, id).catch(() => undefined);
    if (ws.archived) await dropArchive(ws.projectRoot, this.store.archivesDir, id).catch(() => undefined);
    if (scratch) rmSync(ws.path, { recursive: true, force: true });
    // A chat in a folder that stays (yours, or a worktree it was forked in): only what you sent it goes.
    else if (ws.kind === 'chat' && existsSync(ws.path)) await dropSent(ws.path, sentFolder(`ws:${ws.id}`, false)).catch(() => undefined);
    if (ours) {
      // Claude Code's (your own Claude and local models alike), Codex's, OpenCode's, Grok Build's and Copilot's, whichever agent ran there.
      for (const dir of new Set([sessionsDir, path.resolve(ws.path)])) await dropFolderSessions(dir).catch(() => 0);
      await dropCodexSessions({ dir: sessionsDir }).catch(() => 0);
      if (ws.sessionRuntime === 'opencode') {
        if (ws.sessionId) await dropOpenCodeSession(ws.sessionId).catch(() => false);
        await dropOpenCodeFolder(sessionsDir, ws.kind === 'worktree' ? ws.projectRoot : sessionsDir).catch(() => 0);
      }
      if (ws.sessionRuntime === 'grok' && ws.sessionId) await dropGrokSession(ws.sessionId).catch(() => false);
      if (ws.sessionRuntime === 'copilot') await dropCopilotFolder(sessionsDir).catch(() => 0);
    } else if (ws.kind === 'chat' && this.ownSession(ws)) {
      if (ws.sessionRuntime === 'codex') await dropCodexSessions({ threadId: ws.sessionId! }).catch(() => 0);
      else if (ws.sessionRuntime === 'opencode') await dropOpenCodeSession(ws.sessionId!).catch(() => false);
      else if (ws.sessionRuntime === 'grok') await dropGrokSession(ws.sessionId!).catch(() => false);
      else if (ws.sessionRuntime === 'copilot') await dropCopilotSession(ws.sessionId!).catch(() => false);
      else await dropSession(sessionsDir, ws.sessionId!).catch(() => undefined);
    }
    this.records = this.records.filter((r) => r.id !== id);
    this.store.saveRecords(this.records);
    await this.refresh();
  }

  /**
   * A chat's Claude Code session that's its alone: not one brought in from outside Beluga, and
   * not one another workspace resumes or branches from.
   */
  private ownSession(ws: WorkspaceRecord): boolean {
    const id = ws.sessionId;
    if (!id || id === ws.importedSession) return false;
    return !this.records.some((r) => r.id !== ws.id && (r.sessionId === id || r.forkFromSession === id || r.importedSession === id));
  }

  /**
   * Remove the worktrees Claude Code sub-agents left behind that have no uncommitted
   * changes. Their branches stay, so nothing committed is lost; anything with
   * uncommitted work is kept.
   */
  async cleanAgentWorktrees(projectId: string): Promise<{ removed: number; kept: number }> {
    const project = this.list.find((p) => p.id === projectId);
    if (!project) throw new WorkspaceError('That project is gone');
    let removed = 0;
    let kept = 0;
    for (const ws of project.workspaces.filter((w) => !w.archived && worktreeOrigin(w) === 'agent')) {
      if (ws.status?.changed !== 0) {
        kept++;
        continue;
      }
      try {
        await removeWorktreeKeepingBranch(project.root, ws.path, false);
        removed++;
      } catch {
        kept++;
      }
    }
    await this.refresh();
    return { removed, kept };
  }

  /** Pick the model for one workspace's conversation (undefined: your default). */
  /** Carry on after a merged PR: PR `number` and older are done (see Workbench.continueAfterMerge). */
  setPrDone(id: string, number: number, shipped?: { readonly url?: string; readonly into: string; readonly head?: string }): void {
    this.require(id);
    this.patchRecord(id, { prDone: number, ...(shipped ? { prShipped: { number, ...shipped } } : {}) });
  }

  /** Its chat shows PR `number` merged now (see Workbench.sayMerged). */
  setMergeSaid(id: string, number: number): void {
    this.require(id);
    this.patchRecord(id, { mergeSaid: number });
  }

  /** GitHub says its PR merged at `head` (BLG-833) → whether that's news (its status counts again then). */
  setMergedHead(id: string, head: string): boolean {
    if (this.require(id).mergedHead === head) return false;
    this.patchRecord(id, { mergedHead: head });
    return true;
  }

  /** Merge When Ready is waiting on this worktree's PR (undefined: not anymore). See Workbench.mergeWhenReady. */
  setMergeWait(id: string, wait: MergeWait | undefined): void {
    this.require(id);
    this.patchRecord(id, { mergeWhenReady: wait });
  }

  /** An old Remind Me Later (before BLG-770): undefined clears it, once it's carried into triage.json. */
  setRemindAt(id: string, at: number | undefined): void {
    this.require(id);
    this.patchRecord(id, { remindAt: at });
  }

  setModel(id: string, model: string | undefined): void {
    this.require(id);
    this.patchRecord(id, { model: model || undefined });
  }

  /**
   * Pick the agent for one workspace (undefined: your default). Its model, when it names one, is
   * the workspace's model. The stored session stays filed under its runtime: a different runtime
   * starts its own conversation (see session-carry.ts resumeFor).
   */
  setAgent(id: string, agent: AgentRef | undefined): void {
    this.require(id);
    // Another agent's model may not take the effort picked for the last one: Settings' again.
    this.patchRecord(id, { agent: undefined, model: undefined, effort: undefined, ...agentFields(agent) });
  }

  /** An external agent started this chat. */
  setStartedBy(id: string, agent: { readonly id: string; readonly name: string }): void {
    this.require(id);
    this.patchRecord(id, { startedByAgent: agent });
  }

  /** After a quiet switch, the agent it came from (BLG-592); undefined once its recent conversation went along. */
  setCarry(id: string, from: string | undefined): void {
    this.require(id);
    this.patchRecord(id, { carryFrom: from });
  }

  /** A chat's thread record (core/threads), saved at once: a result must survive a restart. */
  setThread(id: string, thread: ThreadRecord): void {
    this.require(id);
    this.patchRecord(id, { thread });
  }

  /** Pick the thinking effort for one workspace's conversation (undefined: Settings'). */
  setEffort(id: string, effort: Effort | undefined): void {
    this.require(id);
    this.patchRecord(id, { effort });
  }

  /**
   * Add one run's usage. The SDK reports running totals per conversation, so only the part
   * beyond the last total we saw for the same conversation is new.
   */
  addUsage(id: string, run: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; session?: string; free?: boolean; tps?: number }, now = Date.now()): WorkspaceUsage | undefined {
    const ws = this.find(id);
    if (!ws) return undefined;
    const prev = ws.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, runs: 0 };
    const last = prev.last;
    // Same conversation and nothing went down: these are running totals, so only the growth is new.
    const continues = run.session !== undefined && run.session === prev.lastSession && last !== undefined && run.input >= last.input && run.output >= last.output && run.cacheRead >= last.cacheRead && run.cacheWrite >= last.cacheWrite && run.cost >= last.cost;
    const delta = (k: 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'cost'): number => (continues && last ? run[k] - last[k] : run[k]);
    // This session's cache counts, for the hit rate. Lifetime totals and cost stay as they were.
    const session = foldSessionCache(prev, run, continues);
    const next: WorkspaceUsage = {
      input: prev.input + delta('input'),
      output: prev.output + delta('output'),
      cacheRead: prev.cacheRead + delta('cacheRead'),
      cacheWrite: prev.cacheWrite + delta('cacheWrite'),
      cost: prev.cost + delta('cost'),
      runs: prev.runs + 1,
      // A local run says how fast it was (the last speed stays when a turn is too short to tell).
      ...(run.free ? { local: { ...((run.tps ?? prev.local?.tps) ? { tps: run.tps ?? prev.local?.tps } : {}) } } : {}),
      ...(run.session ? { lastSession: run.session, last: { input: run.input, output: run.output, cacheRead: run.cacheRead, cacheWrite: run.cacheWrite, cost: run.cost } } : {}),
      ...(session ? { session } : {}),
      // Per day too, for the Usage screen's chart and "this week". Days saved before cache reads were counted keep that older total.
      days: addDay(prev.days, dayKey(now), { tokens: tokensOf({ input: delta('input'), output: delta('output'), cacheRead: delta('cacheRead'), cacheWrite: delta('cacheWrite') }), cost: delta('cost') }),
      lastAt: now,
    };
    this.patchRecord(id, { usage: next });
    return next;
  }

  /** Remember what a conversation was started for (e.g. Claude updating main). */
  markPurpose(id: string, purpose: 'sync_main'): void {
    this.patchRecord(id, { purpose });
  }

  markHandedOff(id: string, to: string): void {
    this.patchRecord(id, { handedTo: to });
  }

  /** Continued on another computer of yours (BLG-808): said on it, in the Archive. */
  markContinuedOn(id: string, to: string): void {
    this.patchRecord(id, { continuedOn: to });
  }

  // ---------------------------------------------------------------- scripts

  /** The setup / run commands for a project (yours, then beluga.json, then a guess). */
  scripts(projectId: string): ResolvedScripts {
    const project = this.projects.find((p) => p.id === projectId);
    if (!project?.root) return {};
    return resolveScripts(project.root, this.config.scripts?.[project.root]);
  }

  /** The commands (and what was learned) you have for a project, without the project's own files or guesses. */
  yourScripts(projectId: string): ProjectScripts {
    const project = this.projects.find((p) => p.id === projectId);
    return (project?.root && this.config.scripts?.[project.root]) || {};
  }

  /** Set a project's commands just for you, or in its beluga.json so the whole team gets them. */
  setScripts(projectId: string, scripts: ProjectScripts, opts: { inRepo?: boolean } = {}): void {
    const project = this.projects.find((p) => p.id === projectId);
    if (!project?.root) throw new WorkspaceError('Project not found');
    if (opts.inRepo) {
      saveProjectFile(project.root, scripts);
      return;
    }
    const current = this.config.scripts?.[project.root] ?? {};
    const merged = Object.fromEntries(Object.entries({ ...current, ...scripts }).filter(([, v]) => v)) as ProjectScripts;
    this.config = { ...this.config, scripts: { ...(this.config.scripts ?? {}), [project.root]: merged } };
    this.store.saveConfig(this.config);
  }

  /** Whether you allowed this exact command (from the project's own files) to run by itself. */
  isScriptApproved(projectId: string, command: string): boolean {
    const project = this.projects.find((p) => p.id === projectId);
    return Boolean(project?.root && this.config.approvedScripts?.[project.root]?.includes(commandHash(command)));
  }

  approveScript(projectId: string, command: string): void {
    const project = this.projects.find((p) => p.id === projectId);
    if (!project?.root) return;
    const list = this.config.approvedScripts?.[project.root] ?? [];
    this.config = { ...this.config, approvedScripts: { ...(this.config.approvedScripts ?? {}), [project.root]: [...new Set([...list, commandHash(command)])].slice(-20) } };
    this.store.saveConfig(this.config);
  }

  // ---------------------------------------------------------------- handoff

  /** The project whose origin points at the same repository as `remote` (any URL style). */
  async projectForRemote(remote: string): Promise<Project | undefined> {
    const want = normalizeRemote(remote);
    for (const p of this.projects.filter((x) => x.root)) {
      const url = await g.git(p.root, ['remote', 'get-url', 'origin']).then((s) => s.trim(), () => '');
      if (url && normalizeRemote(url) === want) return p;
    }
    return undefined;
  }

  async remoteOf(projectId: string): Promise<string | undefined> {
    const project = this.projects.find((p) => p.id === projectId);
    if (!project?.root) return undefined;
    return g.git(project.root, ['remote', 'get-url', 'origin']).then((s) => s.trim() || undefined, () => undefined);
  }

  /** A new worktree on an existing branch (e.g. one fetched from a friend's handoff). */
  async createWorktreeOn(projectId: string, name: string, branch: string, extra: Partial<WorkspaceRecord> = {}, opts: { copyEnv?: boolean } = {}): Promise<Workspace> {
    const project = this.projects.find((p) => p.id === projectId);
    if (!project) throw new WorkspaceError('Project not found');
    const dir = this.freeDir(project, slug(name));
    await g.git(project.root, ['worktree', 'add', dir, branch]);
    await g.excludeProjectDir(dir);
    if (opts.copyEnv !== false) await copyEnvFiles(project.root, dir);
    const record: WorkspaceRecord = { id: freshId(), projectRoot: project.root, name: slug(name), path: dir, kind: 'worktree', branch, base: project.base, createdAt: Date.now(), envSnapshot: await envSnapshot(dir), ...extra };
    this.saveRecord(record);
    await this.refresh();
    return this.require(record.id);
  }

  /** A free local branch name like beluga/<name>, beluga/<name>-2… */
  freeBranchName(projectRoot: string, name: string): Promise<string> {
    return this.freeBranch(projectRoot, `${this.branchPrefix()}${slug(name)}`);
  }

  forgetSession(id: string): void {
    this.patchRecord(id, { sessionId: undefined, forkFromSession: undefined, sessionRuntime: undefined });
  }

  rename(id: string, name: string, opts: { readonly automatic?: boolean } = {}): void {
    const ws = this.require(id);
    if (opts.automatic && ws.nameSetByUser) return;
    const clean = opts.automatic ? name.trim().slice(0, 40) || ws.name : name.trim();
    if (!clean || clean.length > 200) throw new WorkspaceError('A workspace name must contain 1 to 200 characters');
    this.patchRecord(id, { name: clean, ...(opts.automatic ? {} : { nameSetByUser: true }) });
  }

  /**
   * Give a just-made worktree its proper name (it was created under a quick one while a model
   * named it): the label and its own branch (beluga/…, or your prefix), unless the branch was pushed. The folder stays.
   */
  async renameWorktree(id: string, name: string): Promise<void> {
    const ws = this.require(id);
    const s = slug(name);
    // You named it meanwhile: yours stays.
    if (ws.kind !== 'worktree' || ws.nameSetByUser || !s || s === ws.name) return;
    const prefix = this.branchPrefix();
    const branch = ws.branch && isOwnBranch(ws.branch, ws.name, prefix) && !(await this.onRemote(ws.path, ws.branch)) ? await this.freeBranch(ws.path, `${prefix}${s}`) : undefined;
    if (branch) await g.git(ws.path, ['branch', '-m', ws.branch!, branch]);
    this.patchRecord(id, { name: s, ...(branch ? { branch } : {}) });
    await this.refresh();
  }

  /**
   * You renamed a workspace. A worktree's branch takes the name too: beluga/<name> (or your prefix)
   * for one Beluga made, the same folder for one of yours (feature/<name>), or exactly what you typed
   * when it has a / in it. A branch already on a remote keeps its name (its pull request follows it),
   * and the folder stays where it is (sessions and terminals run in it).
   */
  async renameByUser(id: string, typed: string): Promise<RenameResult> {
    const ws = this.require(id);
    if (ws.kind !== 'worktree') {
      this.rename(id, typed);
      return { name: this.require(id).name };
    }
    const text = typed.trim();
    const exact = text.includes('/') ? await this.validBranch(ws.path, text) : undefined;
    const label = exact ? exact.slice(exact.lastIndexOf('/') + 1) : text;
    if (!/[a-z0-9]/i.test(label)) throw new WorkspaceError('A worktree needs a name with a letter or a digit in it');
    const s = slug(label);
    const old = ws.branch;
    const kept = !old ? undefined : (await this.onRemote(ws.path, old)) ? ('pushed' as const) : undefined;
    let branch = old;
    if (old && !kept) {
      const prefix = this.branchPrefix();
      const wanted = exact ?? (isOwnBranch(old, ws.name, prefix) ? `${prefix}${s}` : `${old.slice(0, old.lastIndexOf('/') + 1)}${s}`);
      branch = exact ? await this.takenOrFree(ws.path, exact, old) : await this.freeBranch(ws.path, wanted, old);
      if (branch !== old) await g.git(ws.path, ['branch', '-m', old, branch]);
    }
    this.patchRecord(id, { name: s, nameSetByUser: true, ...(branch ? { branch } : {}) });
    await this.refresh();
    return { name: s, ...(branch ? { branch } : {}), ...(kept ? { branchKept: kept } : {}) };
  }

  /** Is this branch on a remote already (a remote branch of the same name)? Its upstream alone says nothing: a new worktree's is origin/main. */
  private async onRemote(repo: string, branch: string): Promise<boolean> {
    return Boolean((await g.tryGit(repo, ['for-each-ref', '--count=1', `refs/remotes/*/${branch}`]))?.trim());
  }

  /** The branch name you typed, as git accepts it, or why not. */
  private async validBranch(repo: string, name: string): Promise<string> {
    const ok = (await g.tryGit(repo, ['check-ref-format', '--branch', name]))?.trim();
    if (!ok || ok !== name) throw new WorkspaceError(`“${name}” can’t be a branch name`);
    return ok;
  }

  /** An exact branch name you asked for: refused when another branch has it already. */
  private async takenOrFree(repo: string, wanted: string, mine: string): Promise<string> {
    if (wanted === mine || (await this.freeBranch(repo, wanted, mine)) === wanted) return wanted;
    throw new WorkspaceError(`A branch named ${wanted} is there already`);
  }

  /** `runtime`: the one that made `sessionId` (unset: Claude). */
  rememberSession(id: string, sessionId: string, runtime?: string): void {
    this.patchRecord(id, { sessionId, forkFromSession: undefined, sessionRuntime: runtime && runtime !== 'claude' ? runtime : undefined });
  }

  // ---------------------------------------------------------- review & merge

  async review(id: string): Promise<g.Review> {
    const ws = this.require(id);
    return g.review(ws.path, ws.base ?? this.projectOf(ws).base);
  }

  async fileDiff(id: string, file: string): Promise<string> {
    const ws = this.require(id);
    return g.fileDiff(ws.path, ws.base ?? this.projectOf(ws).base, file);
  }

  async commitAll(id: string, message: string): Promise<boolean> {
    const done = await g.commitAll(this.require(id).path, message);
    await this.refresh();
    return done;
  }

  /** Merge a worktree's branch into the project's main checkout. */
  async merge(id: string): Promise<g.MergeResult> {
    const ws = this.require(id);
    if (ws.kind !== 'worktree' || !ws.branch) throw new WorkspaceError('Only worktrees can be merged');
    if ((ws.status?.changed ?? 0) > 0) throw new WorkspaceError(`${ws.name} has uncommitted changes. Commit them first.`);
    const result = await g.mergeInto(ws.projectRoot, ws.branch, this.mergeTarget(ws));
    await this.refresh();
    return result;
  }

  /** The branch a worktree merges into: its base, without the remote (undefined: whatever main is on). */
  private mergeTarget(ws: Workspace): string | undefined {
    const base = ws.base ?? this.projectOf(ws).base;
    return base.startsWith('origin/') ? base.slice('origin/'.length) : base === 'HEAD' ? undefined : base;
  }

  /** What merging this worktree would do (see merge-preview.ts). */
  async mergePreview(id: string): Promise<MergePreview> {
    const ws = this.require(id);
    if (ws.kind !== 'worktree' || !ws.branch) throw new WorkspaceError('Only worktrees can be merged');
    const into = this.mergeTarget(ws);
    return mergePreview({ folder: ws.projectRoot, from: ws.branch, ...(into ? { into } : {}), uncommitted: ws.status?.changed ?? 0 });
  }

  // --------------------------------------------------------------- env files

  /**
   * Env keys/files changed in a worktree compared with the main folder (key names only). Files you
   * kept in the worktree are left out, unless `withKept` (archiving or deleting it lists them all).
   */
  envChanges(id: string, withKept = false): EnvChange[] {
    const ws = this.require(id);
    if (ws.kind !== 'worktree' || ws.archived || !existsSync(ws.path)) return [];
    return envChanges(ws.path, ws.projectRoot, ws.envSnapshot, withKept ? {} : ws.envKept);
  }

  /** envChanges without blocking the daemon (the checks that run on their own). `files`: the worktree's env files, just listed. */
  async envChangesAsync(id: string, files?: readonly string[]): Promise<EnvChange[]> {
    const ws = this.require(id);
    if (ws.kind !== 'worktree' || ws.archived || !existsSync(ws.path)) return [];
    return envChangesAsync(ws.path, ws.projectRoot, ws.envSnapshot, ws.envKept, files);
  }

  /** Copy a worktree's env changes back into the main folder; they're in step again, so nothing is asked. */
  applyEnvBack(id: string): number {
    const ws = this.require(id);
    const changes = this.envChanges(id, true);
    applyEnvChanges(ws.path, ws.projectRoot, changes);
    const files = changes.map((c) => c.file);
    this.patchRecord(id, { envSnapshot: { ...ws.envSnapshot, ...envHashes(ws.path, files) }, envKept: dropKeys(ws.envKept, files) });
    return changes.length;
  }

  /**
   * Only the keys a worktree added that the main folder's file doesn't have at all (BLG-369): what
   * the code there needs to run, so the next worktree has it too. Changed and removed ones stay
   * for you to decide. Files you kept in the worktree are left alone. → the keys added, by file.
   */
  applyNewEnvKeys(id: string, changes?: readonly EnvChange[]): { file: string; keys: string[] }[] {
    const ws = this.require(id);
    const fresh = (changes ?? this.envChanges(id)).filter((c) => !c.binary && c.added.length && existsSync(path.join(ws.projectRoot, c.file)));
    if (!fresh.length) return [];
    applyEnvChanges(ws.path, ws.projectRoot, fresh.map((c) => ({ ...c, changed: [], removed: [] })));
    // A file with nothing but new keys is in step now: it follows the main folder's again.
    const whole = fresh.filter((c) => !c.changed.length && !c.removed.length).map((c) => c.file);
    if (whole.length) this.patchRecord(id, { envSnapshot: { ...ws.envSnapshot, ...envHashes(ws.path, whole) } });
    return fresh.map((c) => ({ file: c.file, keys: [...c.added] }));
  }

  /** The values of the keys a worktree added or changed in its .env-style files (for Save in Beluga). */
  envValues(id: string): Record<string, string> {
    const ws = this.require(id);
    const out: Record<string, string> = {};
    for (const c of this.envChanges(id, true)) {
      if (c.binary) continue;
      const vars = envRecord(parseEnvText(readFileSync(path.join(ws.path, c.file), 'utf8')).vars);
      for (const key of [...c.added, ...c.changed]) if (key in vars) out[key] = vars[key]!;
    }
    return out;
  }

  /** Keep a worktree's env changes there only: not asked about again until they change again. */
  keepEnvHere(id: string): number {
    const ws = this.require(id);
    const files = this.envChanges(id).map((c) => c.file);
    if (files.length) this.patchRecord(id, { envKept: { ...ws.envKept, ...envHashes(ws.path, files) } });
    return files.length;
  }

  /** Bring the main folder's env changes into a worktree's untouched copies → the files updated. */
  followMainEnv(id: string, mainFiles?: readonly string[]): string[] {
    const ws = this.find(id);
    if (!ws || ws.kind !== 'worktree' || ws.archived || ws.external || !existsSync(ws.path) || !existsSync(ws.projectRoot)) return [];
    const { updated, snapshot } = followMainEnv(ws.path, ws.projectRoot, ws.envSnapshot, mainFiles);
    if (!isDeepStrictEqual(snapshot, ws.envSnapshot ?? {})) this.patchRecord(id, { envSnapshot: snapshot });
    return updated;
  }

  /** followMainEnv without blocking the daemon, with the main folder's env files as just listed. */
  async followMainEnvAsync(id: string, mainFiles: readonly string[]): Promise<string[]> {
    const ws = this.find(id);
    if (!ws || ws.kind !== 'worktree' || ws.archived || ws.external || !existsSync(ws.path) || !existsSync(ws.projectRoot)) return [];
    const before = ws.envSnapshot ?? {};
    const { updated, snapshot } = await followMainEnvAsync(ws.path, ws.projectRoot, before, mainFiles);
    if (isDeepStrictEqual(snapshot, before)) return updated;
    // Only what this changed, onto the record as it is now (a keep or a copy back may have landed meanwhile).
    const now = (this.find(id) ?? this.records.find((r) => r.id === id))?.envSnapshot ?? {};
    const changed = Object.fromEntries(Object.entries(snapshot).filter(([rel, h]) => before[rel] !== h));
    this.patchRecord(id, { envSnapshot: { ...now, ...changed } });
    return updated;
  }

  // ------------------------------------------------------------------ misc

  contextDir(id: string): string {
    const ws = this.require(id);
    return path.join(ws.path, PROJECT_DIR);
  }

  openInFinder(id: string): void {
    const ws = this.require(id);
    systemOpen(ws.path);
  }

  loadHistory<T>(id: string): T[] {
    return this.store.loadHistory<T>(id);
  }

  saveHistory(id: string, items: readonly unknown[]): void {
    this.store.saveHistory(id, items);
  }

  saveHistoryAsync(id: string, items: readonly unknown[], current?: () => boolean): Promise<void> {
    return this.store.saveHistoryAsync(id, items, current);
  }
}

const commandHash = (command: string): string => createHash('sha256').update(command.trim()).digest('hex').slice(0, 16);

/** github.com/kay/api for https://github.com/kay/api.git, git@github.com:kay/api, ssh://git@github.com:22/kay/api… */
export function normalizeRemote(url: string): string {
  const raw = url.trim();
  const scp = /^[^@/\s]+@([^:/\s]+):(?!\/)(.+)$/.exec(raw);
  const hostPath = scp
    ? `${scp[1]}/${scp[2]}`
    : raw
        .replace(/^[a-z+]+:\/\//i, '')
        .replace(/^[^@/]+@/, '')
        .replace(/^([^/:]+):\d+(?=\/)/, '$1');
  return hostPath.replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();
}

function stripLive(ws: Workspace): WorkspaceRecord {
  const { projectId: _p, external: _e, status: _s, askOnly: _a, ...record } = ws;
  return record;
}

const KIND_ORDER = { main: 0, worktree: 1, chat: 2 } as const;
const order = (a: Workspace, b: Workspace): number =>
  Number(a.archived ?? false) - Number(b.archived ?? false) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.createdAt - a.createdAt || a.name.localeCompare(b.name);

/** A record without these keys (undefined when nothing's left). */
function dropKeys(record: Readonly<Record<string, string>> | undefined, keys: readonly string[]): Record<string, string> | undefined {
  if (!record) return undefined;
  const out = Object.fromEntries(Object.entries(record).filter(([k]) => !keys.includes(k)));
  return Object.keys(out).length ? out : undefined;
}
