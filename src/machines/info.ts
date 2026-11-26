import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import os from 'node:os';
import { z } from 'zod';
import { usagesOf } from '../agent/usage.js';
import { ownerMcpEntries } from '../agent/runtime/claude/owner-mcp.js';
import { runtimeStatuses } from '../agent/runtime/registry.js';
import { DeviceSetSync } from '../companion/protocol.js';
import { type DomainState, isRunning } from '../core/store.js';
import { Usage } from '../protocol.js';
import { git } from '../workspaces/git.js';
import { type KindFound, LINUX_DISTROS, MACHINE_KINDS, detectKind, realKindReaders } from './kind.js';
import { UPDATE_MODES, UpdateAnswer } from './versions.js';
import { MACHINE_ICONS, type MachineIcon } from '../shared/settings-schema.js';

/**
 * What a computer has free (BLG-778), as it says it to your app: its load per core, free memory and
 * disk, the agents it runs, which runtimes are signed in there (and their plan usage), whether gh
 * is, the MCP servers set up there (they're per computer), and its projects with their origin URLs
 * so a project can be matched across computers. Collected on the computer each time the app asks
 * (every 30 s while it's online); what's slow to learn (sign-ins, origins) is kept a few minutes.
 */

const GB = 1024 ** 3;
const round1 = (n: number): number => Math.round(n * 10) / 10;
/** Sign-ins and origins change rarely: asked again after this long. */
const SLOW_TTL_MS = 5 * 60_000;

/**
 * A list another computer sends, read whatever its Beluga's version: an entry this side can't read
 * (a newer state, a newer source) is left out, and past `max` the rest is, never the whole list —
 * one unknown value failed the whole sync, and the computer showed as offline.
 */
const listOf = <T extends z.ZodTypeAny>(item: T, max: number) =>
  z
    .array(z.unknown())
    .max(max * 4)
    .transform((xs) => xs.flatMap((x): z.output<T>[] => {
      const r = item.safeParse(x);
      return r.success ? [r.data] : [];
    }).slice(0, max));

export const RuntimeHealth = z.object({ id: z.string().max(32), state: z.enum(['ready', 'signed_out', 'missing']), usage: Usage.optional() });
export type RuntimeHealth = z.infer<typeof RuntimeHealth>;

export const MachineInfo = z.object({
  at: z.number().int().min(0),
  /** What kind of computer it is and, for a cloud server, its region (BLG-782, kind.ts). */
  // A kind or distribution this side doesn't know yet (a newer computer) is left out, never the whole info.
  kind: z.enum(MACHINE_KINDS).optional().catch(undefined),
  region: z.string().max(40).optional(),
  /** On Linux, which distribution and its version (kind.ts): its mark and "Ubuntu 24.04". */
  distro: z.enum(LINUX_DISTROS).optional().catch(undefined),
  distroVersion: z.string().max(16).optional(),
  /** Its Beluga and the app protocol it speaks (BLG-777). */
  version: z.string().max(40).optional(),
  ipc: z.number().int().min(0).optional(),
  /** Its name and icon as kept on it (BLG-780): every device shows these. */
  name: z.string().min(1).max(64).optional(),
  icon: z.enum(MACHINE_ICONS).optional().catch(undefined),
  cpus: z.number().int().min(1).max(4096),
  /** The 1-minute load average over the cores (1 = every core busy). */
  loadPerCore: z.number().min(0).max(1000),
  memory: z.object({ freeGB: z.number().min(0), totalGB: z.number().min(0) }),
  disk: z.object({ freeGB: z.number().min(0), totalGB: z.number().min(0) }).optional(),
  agentsRunning: z.number().int().min(0),
  runtimes: listOf(RuntimeHealth, 8),
  gh: z.enum(['signed_in', 'signed_out', 'missing']).catch('missing'),
  mcp: listOf(z.object({ name: z.string().max(100), from: z.enum(['user', 'project', 'plugin']) }), 64),
  projects: listOf(z.object({ name: z.string().max(200), origin: z.string().max(500).optional() }), 200),
  /** The worktrees with a run going there now (BLG-779), by project and name; `channel` is its conversation there. */
  work: listOf(z.object({ project: z.string().max(200), worktree: z.string().max(200), channel: z.string().max(300) }), 50).optional(),
});
export type MachineInfo = z.infer<typeof MachineInfo>;

/** The sync frame between your devices, with an app's ask for what a computer has free and its answer (additive). */
export const MachineSync = DeviceSetSync.extend({
  /** `net`: asked of your Always On only (BLG-796; an older computer reads no `net` and would drop the frame). */
  // What a newer computer asks that this one doesn't know is left out, never the whole sync.
  want: listOf(z.enum(['info', 'update', 'net']), 4).optional(),
  // Each part on its own: one this side can't read is left out, never the whole sync (the roster with it).
  info: MachineInfo.optional().catch(undefined),
  /** Update It (BLG-777): asked with how, answered with what the computer does. */
  update: z.object({ mode: z.enum(UPDATE_MODES) }).optional().catch(undefined),
  updated: UpdateAnswer.optional().catch(undefined),
  /** Rename it or pick its icon from your app (BLG-780): kept on the computer itself. */
  look: z.object({ name: z.string().trim().min(1).max(64).optional(), icon: z.enum(MACHINE_ICONS).optional().catch(undefined) }).optional().catch(undefined),
  /** Your settings, each with when and where it changed (BLG-805, sync.ts reads it: a part it can't read never holds up the rest). */
  settings: z.unknown().optional(),
  /** Your Always On's friends network as it is now (BLG-796), for your app to show while it doesn't run it: friends, groups, invitations. */
  net: z.object({ enabled: z.literal(true), friends: z.array(z.unknown()).max(5_000), groups: z.array(z.unknown()).max(5_000), invitations: z.array(z.unknown()).max(500), pendingJoins: z.array(z.unknown()).max(500) }).passthrough().optional(),
});
export type MachineSync = z.infer<typeof MachineSync>;

export interface InfoDeps {
  readonly os: Pick<typeof os, 'cpus' | 'loadavg' | 'freemem' | 'totalmem' | 'homedir'>;
  readonly state: () => DomainState;
  readonly disk: (dir: string) => Promise<{ freeGB: number; totalGB: number } | undefined>;
  readonly runtimes: () => Promise<ReadonlyArray<{ id: string; state: RuntimeHealth['state'] }>>;
  readonly gh: () => Promise<MachineInfo['gh']>;
  readonly mcp: (folders: readonly string[]) => ReadonlyArray<{ name: string; from: 'user' | 'project' | 'plugin' }>;
  readonly origin: (root: string) => Promise<string | undefined>;
  readonly now: () => number;
  /** What kind of computer this is, once known (worked out once at start). */
  readonly kind?: () => KindFound | undefined;
  /** This Beluga's version and app protocol. */
  readonly self?: { readonly version: string; readonly ipc: number };
  /** Its name and icon as kept on it. */
  readonly look?: () => { readonly name: string; readonly icon?: MachineIcon };
}

export async function collectInfo(deps: InfoDeps): Promise<MachineInfo> {
  const state = deps.state();
  const cpus = Math.max(1, deps.os.cpus().length);
  const projects = state.projects.slice(0, 200);
  const usages = usagesOf(state.self);
  const [disk, runtimes, gh, origins] = await Promise.all([
    deps.disk(deps.os.homedir()).catch(() => undefined),
    deps.runtimes().catch(() => []),
    deps.gh().catch((): MachineInfo['gh'] => 'missing'),
    Promise.all(projects.map((p) => deps.origin(p.root).catch(() => undefined))),
  ]);
  const seen = new Set<string>();
  const mcp = deps.mcp(projects.map((p) => p.root)).filter((s) => !seen.has(s.name) && seen.add(s.name));
  const kind = deps.kind?.();
  return {
    at: deps.now(),
    ...(kind ? { kind: kind.kind, ...(kind.region ? { region: kind.region } : {}), ...(kind.distro ? { distro: kind.distro, ...(kind.distroVersion ? { distroVersion: kind.distroVersion } : {}) } : {}) } : {}),
    ...(deps.self ? { version: deps.self.version.slice(0, 40), ipc: deps.self.ipc } : {}),
    ...lookOf(deps.look?.()),
    cpus,
    loadPerCore: Math.round(((deps.os.loadavg()[0] ?? 0) / cpus) * 100) / 100,
    memory: { freeGB: round1(deps.os.freemem() / GB), totalGB: round1(deps.os.totalmem() / GB) },
    ...(disk ? { disk } : {}),
    agentsRunning: state.log.filter((l) => l.type === 'agent' && isRunning(l.status)).length,
    runtimes: runtimes.slice(0, 8).map((r) => {
      const usage = usages.find((u) => u.agent.runtime === r.id);
      return { id: r.id, state: r.state, ...(usage ? { usage: { ...(usage.plan ? { plan: usage.plan } : {}), ...(usage.fiveHour ? { fiveHour: usage.fiveHour } : {}), ...(usage.week ? { week: usage.week } : {}), updatedAt: usage.updatedAt } } : {}) };
    }),
    gh,
    mcp: mcp.slice(0, 64).map((s) => ({ name: s.name.slice(0, 100), from: s.from })),
    projects: projects.map((p, i) => ({ name: p.name.slice(0, 200), ...(origins[i] ? { origin: origins[i]!.slice(0, 500) } : {}) })),
    work: runningWork(state),
  };
}

const lookOf = (look: { name: string; icon?: MachineIcon } | undefined): Pick<MachineInfo, 'name' | 'icon'> => (look ? { ...(look.name.trim() ? { name: look.name.trim().slice(0, 64) } : {}), ...(look.icon ? { icon: look.icon } : {}) } : {});

/** The worktrees whose conversation has a run going now. */
export function runningWork(state: Pick<DomainState, 'projects' | 'log'>): NonNullable<MachineInfo['work']> {
  const busy = new Set(state.log.flatMap((l) => (l.type === 'agent' && isRunning(l.status) ? [l.channel] : [])));
  return state.projects
    .flatMap((p) => p.workspaces.filter((w) => busy.has(`ws:${w.id}`)).map((w) => ({ project: p.name.slice(0, 200), worktree: w.name.slice(0, 200), channel: `ws:${w.id}` })))
    .slice(0, 50);
}

/** `fn`'s answer kept for `ms` (per key). */
function kept<T>(fn: (key: string) => Promise<T>, ms: number, now: () => number): (key: string) => Promise<T> {
  const cache = new Map<string, { at: number; value: Promise<T> }>();
  return (key) => {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ms) return hit.value;
    const value = fn(key);
    cache.set(key, { at: now(), value });
    value.catch(() => cache.delete(key));
    return value;
  };
}

/** `gh auth status`: signed in, signed out, or no gh at all. */
export function ghStatus(): Promise<MachineInfo['gh']> {
  return new Promise((resolve) => {
    execFile('gh', ['auth', 'status'], { timeout: 10_000 }, (err) => {
      if (!err) return resolve('signed_in');
      resolve((err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'signed_out');
    });
  });
}

/** The real readers, on this computer; `state` is the daemon's. */
export function realInfoDeps(state: () => DomainState, self?: { version: string; ipc: number }): InfoDeps {
  const now = Date.now;
  const runtimes = kept(() => runtimeStatuses().then((all) => all.map((r) => ({ id: r.id, state: r.state }))), SLOW_TTL_MS, now);
  const gh = kept(ghStatus, SLOW_TTL_MS, now);
  const origin = kept((root) => git(root, ['remote', 'get-url', 'origin'], 5_000).then((s) => s.trim() || undefined), SLOW_TTL_MS, now);
  // Once, in the background: it never holds up an answer (the metadata waits 300 ms at most).
  let kind: KindFound | undefined;
  void detectKind(realKindReaders).then((k) => (kind = k), () => undefined);
  return {
    ...(self ? { self } : {}),
    kind: () => kind,
    os,
    state,
    disk: async (dir) => {
      const s = await statfs(dir);
      return { freeGB: round1((s.bavail * s.bsize) / GB), totalGB: round1((s.blocks * s.bsize) / GB) };
    },
    runtimes: () => runtimes(''),
    gh: () => gh(''),
    mcp: (folders) => ownerMcpEntries(folders),
    origin,
    now,
  };
}
