/**
 * What a Beluga can do, said in every link's `hello` with its version (docs/agent-to-agent.md), so
 * a friend's Mac knows before it asks and can say "Ata's Beluga 1.1 can't take file requests yet"
 * at once, instead of a request waiting for an answer that never comes. Macs from before this send
 * neither: nothing is known about them, and requests go as they always did.
 *
 * Names only ever get added; a feature that changes shape gets a new name.
 */
export const FEATURE_NAMES = {
  'chat.files': 'chat files',
  'chat.claude': 'Claude in chats',
  'task.ask': 'requests to their Claude',
  'task.run': 'commands',
  'task.file': 'file requests',
  'task.question': "their Claude's questions",
  /** A file request for a secret gets its own approval (BLG-209); before, a secret was declined at once. */
  'task.secret': 'secrets',
  'share.project': 'shared projects',
  'share.folder': 'shared folders',
  /** Sends a friend a bundle of a project shared whole, when they can't clone it (core/friend-share/copy.ts). */
  'share.copy': 'project copies',
  /** Sends a shared worktree's earlier conversation a page at a time (core/friend-share). */
  'share.history': 'whole conversations',
  /** Takes a conversation's long messages whole (a graph, a long answer), not cut at 4,000 characters (BLG-622). */
  'share.history.long': 'long messages in conversations',
  /** Packs a shared worktree (its changes, Scratch, conversation) for a friend's own fork of it (core/friend-share/fork.ts). */
  'share.fork': 'forks of worktrees',
  /** Takes a worktree handed over by a friend outside the room: its note, branch bundle and chat (core/friend-share, BLG-341). */
  'share.handoff': 'handoffs',
  /** Team boards (core/team): friends on the same GitHub repo find each other and keep one board. */
  'team.board': 'team boards',
  /** Plan drafts shared with teammates to review (core/team). */
  'team.plans': 'shared plans',
  /** A teamed project's About This Project, for Claude writing its tasks (core/team, BLG-298). */
  'team.context': 'project context',
  /** Knocks on a teammate's worktree, let in as a viewer or an editor (core/team/knock.ts, BLG-416). */
  'team.knock': 'knocks on worktrees',
  /** Profile pictures, sent once per change and kept by the Macs that see them (net/mesh/avatars.ts). */
  'profile.avatar': 'profile pictures',
  /** Calls in a conversation: voice, screen sharing and pointing at it (core/calls, BLG-706). */
  'call.voice': 'calls',
  /** Friends swap their prompt characters, merged PRs and agent time a day for the leaderboard (core/leaderboard, BLG-904). */
  'stats.board': 'the leaderboard',
} as const;

export type Feature = keyof typeof FEATURE_NAMES;

/** What a Mac takes while it shares projects and folders with friends (core/friend-share). */
export const SHARE_FEATURES: readonly Feature[] = ['share.project', 'share.folder', 'share.copy', 'share.history', 'share.history.long', 'share.fork', 'share.handoff'];

/** What a Mac takes while its team boards run (core/team). */
export const TEAM_FEATURES: readonly Feature[] = ['team.board', 'team.plans', 'team.context', 'team.knock'];

/** What the network itself always does. */
export const MESH_FEATURES: readonly Feature[] = ['chat.files', 'chat.claude', 'profile.avatar', 'call.voice', 'stats.board'];

/** What a Mac takes while its gateway listens (core/gateway). */
export const TASK_FEATURES: readonly Feature[] = ['task.ask', 'task.run', 'task.file', 'task.question', 'task.secret'];

/** What a friend's Beluga said about itself on its last link. */
export interface BelugaInfo {
  readonly version: string;
  readonly can: readonly string[];
}

/** The feature a request of this kind needs from the friend's Mac. */
export function featureForTask(kind: 'ask' | 'run' | 'file'): Feature {
  return kind === 'run' ? 'task.run' : kind === 'file' ? 'task.file' : 'task.ask';
}

/**
 * Why their Beluga can't take this, or undefined when it can (or nothing is known: older Macs say
 * nothing, and are asked as before). `linked`: connected now. A Mac stops taking requests as it
 * quits, so that only counts while it's there; a version too old for it counts while it's away too
 * (the request would wait for nothing).
 */
export function cannotTake(name: string, info: BelugaInfo | undefined, feature: Feature, linked = true): string | undefined {
  if (!info || info.can.includes(feature)) return undefined;
  const what = FEATURE_NAMES[feature];
  // No task features at all: their Beluga runs, but its requests side isn't on.
  if (feature.startsWith('task.') && !info.can.some((f) => f.startsWith('task.')))
    return !linked ? undefined : `${name}'s Beluga isn't taking requests right now (it's open, but not the Mac app). Ask ${name} to open Beluga for Mac.`;
  // Their Beluga declines every secret at once: say so before asking.
  if (feature === 'task.secret') return `${name}'s Beluga ${shortVersion(info.version)} can't send secrets ${name} approves yet. Ask ${name} to update Beluga.`;
  // Shared things are opened on their Mac, not taken as requests.
  const verb = feature.startsWith('share.') || feature.startsWith('team.') ? 'open' : 'take';
  return `${name}'s Beluga ${shortVersion(info.version)} can't ${verb} ${what} yet. Ask ${name} to update Beluga.`;
}

/** "0.6.2+mac.1.2.0" → "1.2.0" (the Mac app's version is the one people know). */
export function shortVersion(version: string): string {
  const mac = /\+mac\.([\w.-]+)$/.exec(version);
  return mac ? mac[1]! : version;
}
