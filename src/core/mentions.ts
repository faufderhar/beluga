import { type AgentRef, CLAUDE_AGENT, defaultAgentOf, type PeerInfo } from '../protocol.js';
import { KNOWN_RUNTIMES } from '../shared/agent-runtimes.js';
import { chatMentionsIn } from '../shared/chat-ref.js';
import { worktreeOrigin } from '../workspaces/origin.js';
import type { Project } from '../workspaces/types.js';

/** Who a leading mention asks: a person, and which of their agents. */
export interface MentionTarget {
  readonly peerId: string;
  readonly agent: AgentRef;
  /**
   * The words named this agent ("@codex", "@bob:codex", BLG-520): the ask carries it, so their Mac
   * runs that one. Unset: "@bob", "@agents" and the old "@claude…" forms, answered by their default.
   */
  readonly named?: true;
}

/** What parseInput knows besides the room. */
export interface ParseOptions {
  /** Whether your Mac runs an agent of this runtime now ("@codex": your Codex, even when your card doesn't list it). */
  readonly runs?: (runtime: string) => boolean;
}

export type ParsedInput =
  | { readonly kind: 'empty' }
  | { readonly kind: 'command'; readonly name: string; readonly args: readonly string[] }
  | { readonly kind: 'chat'; readonly text: string }
  | {
      readonly kind: 'agent';
      readonly text: string;
      readonly prompt: string;
      /** The people asked, each once (the peer ids of `to`). */
      readonly targets: readonly string[];
      /** Each person asked and the agent that answers for them. */
      readonly to: readonly MentionTarget[];
      /** Names that match nobody here. */
      readonly unknown: readonly string[];
      /** Lines to show the sender: a suggestion for a name, a fallback, an alias that hid a person. */
      readonly notes: readonly string[];
    };

/** "@word" or "@word:word" (a person and one of their agents, or an old "@claude:bob"). */
const MENTION = /^@([\w.-]+)(?::([\w.-]+))?$/;
/** "@BLG-24": a task on the board, not a person. */
const TASK_KEY = /^[a-z][a-z0-9]*-\d+$/i;
const ALIASES = new Set(['claude', 'claudes', 'agents']);
/** "@codex", "@local": your own agent of that runtime ("@claude" is the old alias for yours, above). */
const RUNTIME_WORDS = new Set(KNOWN_RUNTIMES.map((r) => r.id).filter((id) => id !== CLAUDE_AGENT.runtime));

/**
 * Turn a line typed in the prompt into an action.
 *   /cmd args         -> command (":cmd" also works; "//text" sends "/text")
 *   @bob fix it       -> bob's default agent (runs on bob's machine, on bob's subscription)
 *   @bob:codex hi     -> bob's Codex
 *   @agents review    -> every person's default agent in the room
 *   @codex hi         -> your Codex (any runtime word: yours, when nobody here has that name; BLG-520)
 *   @claude, @claude:bob, @claudes -> your Claude, bob's Claude, every Claude (kept forever)
 *   anything else     -> group chat
 * "@claude" and the others are aliases first: a person named "claude" is "@claude:claude".
 */
export function parseInput(raw: string, selfId: string, peers: readonly PeerInfo[], opts: ParseOptions = {}): ParsedInput {
  const text = raw.trim();
  if (!text) return { kind: 'empty' };
  if (text.startsWith('//')) return { kind: 'chat', text: text.slice(1) };
  if (text.startsWith(':') || text.startsWith('/')) {
    const [name = '', ...args] = text.slice(1).trim().split(/\s+/);
    return { kind: 'command', name: name.toLowerCase(), args };
  }

  const byName = (name: string) => peers.find((p) => p.name.toLowerCase() === name.toLowerCase());
  const tokens = text.split(/\s+/);
  const to: MentionTarget[] = [];
  const unknown: string[] = [];
  const notes: string[] = [];
  const note = (line: string) => {
    if (!notes.includes(line)) notes.push(line);
  };
  const ask = (peerId: string, agent: AgentRef, named = false) => {
    if (!to.some((t) => t.peerId === peerId)) to.push({ peerId, agent, ...(named ? { named: true as const } : {}) });
  };
  const self = peers.find((p) => p.peerId === selfId);
  const missing = (name: string) => {
    unknown.push(name);
    const close = suggest(name, peers.map((p) => p.name));
    note(close ? `Nobody named "${name}" is here. Did you mean @${close}?` : `Nobody named "${name}" is here`);
  };
  /** Someone's agent for `runtime` (their default when not named), with a note when it falls back. */
  const agentOf = (peer: PeerInfo | undefined, runtime?: string): AgentRef => {
    const who = peer && peer.peerId !== selfId ? peer.name : 'You';
    const published = peer?.defaultAgent ?? peer?.agents?.[0];
    const runs = peer?.agents?.length ? peer.agents : [defaultAgentOf(peer)];
    if (runtime) {
      const hit = runs.find((a) => a.runtime === runtime.toLowerCase());
      if (hit) return hit;
      // Your own: any agent your Mac runs, listed on your card or not.
      const known = KNOWN_RUNTIMES.find((r) => r.id === runtime.toLowerCase());
      if (known && (!peer || peer.peerId === selfId) && opts.runs?.(known.id)) return { runtime: known.id, label: known.label };
      if (runtime.toLowerCase() === 'claude' && !peer?.agents?.length) return CLAUDE_AGENT;
      note(`${who} ${who === 'You' ? "don't" : "doesn't"} run ${runtime}, so ${who === 'You' ? 'your' : 'their'} ${defaultAgentOf(peer).label} will answer`);
      return defaultAgentOf(peer);
    }
    if (!published && peer && peer.peerId !== selfId) note(`${peer.name} hasn't chosen a default agent, so their Claude will answer`);
    return published ?? CLAUDE_AGENT;
  };
  const hidden = (alias: string, use: string) => {
    if (byName(alias)) note(`"@${alias}" means ${use}. To ask the person named ${alias}, write @${alias}:${alias}`);
  };

  let i = 0;
  for (; i < tokens.length; i++) {
    const match = MENTION.exec(tokens[i] ?? '');
    if (!match) break;
    // "@Fix the login (chat: …)" names a chat, nobody to ask (a person called Fix included).
    if (chatMentionsIn(tokens.slice(i).join(' '))[0]?.start === 0) break;
    const root = match[1]!;
    const second = match[2];
    const lower = root.toLowerCase();
    if (!second && TASK_KEY.test(root) && !byName(root)) break;
    if (!second && lower === 'claudes') {
      for (const p of peers.filter((p) => p.agent)) ask(p.peerId, agentOf(p, 'claude'));
      hidden('claudes', 'every Claude here');
    } else if (!second && lower === 'agents') {
      for (const p of peers.filter((p) => p.agent)) ask(p.peerId, agentOf(p));
      hidden('agents', "everyone's default agent");
    } else if (!second && lower === 'claude') {
      ask(selfId, agentOf(self, 'claude'));
      hidden('claude', 'your own Claude');
    } else if (second && lower === 'claude') {
      // The old "@claude:bob": bob's Claude.
      const peer = byName(second);
      if (peer) ask(peer.peerId, agentOf(peer, 'claude'));
      else missing(second);
    } else {
      const peer = byName(root);
      if (!peer && !second && RUNTIME_WORDS.has(lower)) {
        // "@codex": your own Codex (a person named codex would have been found first).
        ask(selfId, agentOf(self, lower), true);
      } else if (!peer) {
        if (i === 0 && !second) break; // "@zed" alone could be anyone: it stays chat, said once below
        missing(root);
      } else if (!peer.agent && peer.peerId !== selfId) {
        note(`${peer.name} has no agent on right now`);
      } else ask(peer.peerId, agentOf(peer, second), Boolean(second));
    }
  }
  if (i === 0 && chatMentionsIn(text)[0]?.start === 0) return { kind: 'chat', text };
  if (i === 0) {
    // "@zed hi" where nobody is zed: still chat, but say so instead of dropping it silently.
    const first = MENTION.exec(tokens[0] ?? '');
    const root = first?.[1];
    if (root && !ALIASES.has(root.toLowerCase()) && !TASK_KEY.test(root) && tokens.length > 1) {
      missing(root);
      return { kind: 'agent', text, prompt: tokens.slice(1).join(' '), targets: [], to: [], unknown, notes };
    }
    return { kind: 'chat', text };
  }
  const prompt = tokens.slice(i).join(' ');
  if (!prompt) return { kind: 'chat', text };
  return { kind: 'agent', text, prompt, targets: to.map((t) => t.peerId), to, unknown, notes };
}

/** The name here closest to a mistyped one ("bbo" -> "bob"), when one is close enough. */
function suggest(name: string, names: readonly string[]): string | undefined {
  const want = name.toLowerCase();
  let best: { name: string; d: number } | undefined;
  for (const n of names) {
    const lower = n.toLowerCase();
    const d = lower.startsWith(want) || want.startsWith(lower) ? 1 : distance(want, lower);
    if (d <= Math.max(1, Math.floor(want.length / 3)) && (!best || d < best.d)) best = { name: n, d };
  }
  return best?.name;
}

/** Edits between two names, a swapped pair ("bbo") counting as one. */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

/** Parse `peer:share/path/to/file` used by `:open`. */
export function parseLocation(
  spec: string,
  peers: readonly PeerInfo[],
): { owner: string; share: string; path: string } | undefined {
  const m = /^([\w.-]+):([\w.-]+)(?:\/(.*))?$/.exec(spec);
  if (!m) return undefined;
  const peer = peers.find((p) => p.name.toLowerCase() === m[1]?.toLowerCase());
  if (!peer || !peer.shares.some((s) => s.name === m[2])) return undefined;
  return { owner: peer.peerId, share: m[2] as string, path: m[3] ?? '' };
}

/** A workspace you can message from the main chat with "@name". */
export interface WorkspaceMention {
  readonly label: string;
  readonly id: string;
  readonly hint: string;
}

/**
 * "@add-auth" for every live workspace (worktrees, chats, main folders) on this computer.
 * Names used twice get their project in front: "@api/add-auth".
 */
export function workspaceMentions(projects: readonly Project[]): WorkspaceMention[] {
  const all = projects.flatMap((p) => p.workspaces.filter((w) => !w.archived && w.kind !== 'main' && worktreeOrigin(w) !== 'agent').map((w) => ({ p, w })));
  const slug = (s: string) => s.toLowerCase().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
  const counts = new Map<string, number>();
  for (const { w } of all) counts.set(slug(w.name), (counts.get(slug(w.name)) ?? 0) + 1);
  return all.map(({ p, w }) => {
    const name = slug(w.name);
    const label = (counts.get(name) ?? 0) > 1 && p.root ? `@${slug(p.name)}/${name}` : `@${name}`;
    const where = p.root ? `${p.name} · ${w.kind === 'chat' ? 'chat' : 'worktree'}` : 'chat';
    return { label, id: w.id, hint: `message the agent in ${where}` };
  });
}

/** "@add-auth fix the test" → the workspace and the message, when it names one of yours. */
export function parseWorkspaceMention(raw: string, mentions: readonly WorkspaceMention[]): { id: string; label: string; prompt: string } | undefined {
  const m = /^(@[\w./-]+)\s+([\s\S]+)$/.exec(raw.trim());
  if (!m) return undefined;
  const hit = mentions.find((x) => x.label.toLowerCase() === m[1]!.toLowerCase());
  return hit ? { id: hit.id, label: hit.label, prompt: m[2]!.trim() } : undefined;
}
