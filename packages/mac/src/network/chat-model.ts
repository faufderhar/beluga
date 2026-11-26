import type { ChatFile, GroupView, LiveClaude, MessageView, NetworkState } from '../../../../src/net/mesh/views.js';
import { type SuggestContext, type Suggestion, chatMentions, friendMention, typedMention } from '../../../../src/ui/suggest.js';
import { MENTION, type MentionWorld } from '../chat/mentions.js';
import { agentName } from '../../../../src/shared/agent-label.js';
import { continues } from './net-model.js';
import { type TaskMention, matchTasks } from '../../../../src/shared/task-refs.js';
import type { Issue } from '../../../../src/core/board/model.js';
import { isOpen } from '../../../../src/core/board/model.js';
import type { TeamState } from '../../../../src/core/team/model.js';
import { sharedTasks } from '../../../../src/core/team/mentions.js';
import { yourComputer } from '../lib/os-words.js';

/**
 * What the chats say and decide, as plain functions (no React, no daemon): whose Claude a
 * message asks, file sizes and kinds, who's thinking, and the open chat tabs.
 */

/** Whose Claude the next message asks: yours, everyone's in the conversation, or one person's. */
export type Ask = { readonly kind: 'me' } | { readonly kind: 'all' } | { readonly kind: 'person'; readonly peerId: string; readonly name: string };

/** "Asking your Claude" (or, short for the button: "Your Claude"). */
export function askLabel(ask: Ask, short = false): string {
  if (ask.kind === 'me') return short ? 'Your agent' : 'Asking your agent';
  if (ask.kind === 'all') return short ? 'Everyone’s agent' : 'Asking everyone’s agent';
  return short ? `${ask.name}’s agent` : `Asking ${ask.name}’s agent`;
}

/** What the message tells the network: everyone, or these people's Claudes. */
export const askTo = (ask: Ask, me: string): 'all' | readonly string[] => (ask.kind === 'all' ? 'all' : ask.kind === 'me' ? [me] : [ask.peerId]);

// ---- @ and / in a channel's message box

/** Someone in the conversation (you, or another member). */
export interface Member {
  readonly peerId: string;
  readonly name: string;
}

/** How a person is written after @: "Mia Chen" → "MiaChen". */
export const handle = (name: string): string => friendMention(name).slice(1);

/** What / at the start of a channel's message box offers. */
type ChannelCommand = 'claude' | 'claudes' | 'files' | 'add-people';

/** One row of the @ / list: what it shows, the box's words after picking it, and (for /) what it does. */
export interface ChannelSuggestion extends Suggestion {
  readonly command?: ChannelCommand;
}

const COMMANDS: ReadonlyArray<{ name: ChannelCommand; hint: string; when?: 'others' | 'admin' }> = [
  { name: 'claude', hint: 'Your agent answers this message' },
  { name: 'claudes', hint: 'Everyone’s agent answers, each from their own computer', when: 'others' },
  { name: 'files', hint: `Send files from ${yourComputer()}…` },
  { name: 'add-people', hint: 'Add people to this channel…', when: 'admin' },
];

/** A project of yours, as "@" names it. */
export interface ProjectMention {
  readonly name: string;
  readonly id: string;
}

/** A name "@" takes whole (mentions.ts's MENTION): a project called "My App" can't be one. */
const MENTIONABLE = /^[\p{L}\p{N}_][\p{L}\p{N}_.:/+-]*$/u;
/** What "@" already means in a channel: an agent's word, never a project's. */
const TAKEN = /^claudes?(:|$)/i;

/** Your projects a friends' conversation can name: those "@" takes whole, none that reads as an agent or a person here. */
export function mentionableProjects(projects: readonly ProjectMention[], people: readonly Member[] = []): ProjectMention[] {
  const handles = new Set(people.map((p) => handle(p.name).toLowerCase()));
  return projects.filter((p) => MENTIONABLE.test(p.name) && !TAKEN.test(p.name) && !handles.has(p.name.toLowerCase()));
}

/**
 * What to list for the words in a channel's box: "/" at the start → the channel's commands;
 * "@…" → your Claude, each member's Claude, everyone's, the people themselves, your projects, then
 * the tasks of repositories you're teamed up on with them (`tasks`, BLG-263: you ask their Claude
 * about one here), then your chats and worktrees by a word of their title (`chats`: their chip
 * goes in the box, as a dropped row's does).
 */
export function channelSuggestions(
  text: string,
  ctx: { people: readonly Member[]; admin?: boolean; friends?: readonly Member[]; tasks?: readonly TaskMention[]; projects?: readonly ProjectMention[]; chats?: SuggestContext['chats'] },
): ChannelSuggestion[] {
  if (/^\/[\w-]*$/.test(text)) {
    const typed = text.slice(1).toLowerCase();
    const commands: ChannelSuggestion[] = COMMANDS.filter((c) => c.name.startsWith(typed) && (c.when !== 'others' || ctx.people.length > 0) && (c.when !== 'admin' || ctx.admin)).map((c) => ({ label: `/${c.name}`, hint: c.hint, value: '', enter: 'complete', command: c.name }));
    // /invite: a friend link on its own, or "/invite @ata" adds ata here (BLG-203). It's written out, then sent.
    return 'invite'.startsWith(typed) ? [...commands, { label: '/invite', hint: 'Add a friend, or @name to add them here', value: '/invite @', enter: 'complete' }] : commands;
  }
  const inviting = /^\/invite\s+@?([\p{L}\p{N}_.-]*)$/iu.exec(text);
  if (inviting) {
    const t = (inviting[1] ?? '').toLowerCase();
    return (ctx.friends ?? [])
      .filter((f) => handle(f.name) && handle(f.name).toLowerCase().startsWith(t) && !ctx.people.some((p) => p.peerId === f.peerId))
      .map((f) => ({ label: f.name, hint: `/invite @${handle(f.name)} · add ${f.name} here`, value: `/invite @${handle(f.name)}`, enter: 'complete' }));
  }
  const typed = typedMention(text);
  if (typed === undefined) return [];
  const before = text.slice(0, text.length - typed.length - 1);
  const options = [
    { label: 'Your agent', insert: '@claude', hint: `answers here, from ${yourComputer()}` },
    ...ctx.people.map((p) => ({ label: `${p.name}’s agent`, insert: `@claude:${handle(p.name)}`, hint: `answers from ${p.name}’s computer` })),
    ...(ctx.people.length ? [{ label: 'Everyone’s agent', insert: '@claudes', hint: 'each answers from their own computer' }] : []),
    ...ctx.people.filter((p) => handle(p.name)).map((p) => ({ label: p.name, insert: `@${handle(p.name)}`, hint: 'the person, not their agent' })),
    ...mentionableProjects(ctx.projects ?? [], ctx.people).map((p) => ({ label: p.name, insert: `@${p.name}`, hint: 'your project' })),
  ];
  const t = typed.toLowerCase();
  const named: ChannelSuggestion[] = options
    .filter((o) => o.insert.slice(1).toLowerCase().startsWith(t) || o.label.toLowerCase().startsWith(t))
    .map((o) => ({ label: o.label, hint: `${o.insert} · ${o.hint}`, value: `${before}${o.insert} `, enter: 'complete' }));
  const tasks: ChannelSuggestion[] = matchTasks(typed, ctx.tasks ?? []).map((task) => ({ label: `@${task.key}`, hint: task.title, value: `${before}@${task.key} `, enter: 'complete' }));
  return [...named, ...tasks, ...chatMentions(typed, before, ctx.chats)];
}

/**
 * A team task, from its menu, to a teammate (BLG-263): your chat with them, the words ready to
 * send. Their Claude ("@claude:ata @BLG-12 ") or them ("@BLG-12 "): never a task given to it.
 */
export function askAboutTask(key: string, name: string, claude: boolean): string {
  return claude ? `@claude:${handle(name)} @${key} ` : `@${key} `;
}

/** The tasks a chat with these people can name (BLG-263): the live ones of repositories you're teamed up on with them. */
export function channelTasks(issues: readonly Issue[], team: Pick<TeamState, 'teams'>, people: readonly Member[]): TaskMention[] {
  return sharedTasks(issues, team, people.map((p) => p.peerId)).map((i) => ({ key: i.key, title: i.title, status: i.status, open: isOpen(i.status) }));
}

/** Code (fenced or `inline`) isn't asking anyone. */
const withoutCode = (text: string): string => text.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');

/** Whose Claudes the words call: "@claude" → yours, "@claude:mia" → mia's, "@claudes" → everyone's. Plain "@mia" is the person. */
export function mentionedAsk(text: string, me: string, people: readonly Member[]): 'all' | readonly string[] | undefined {
  const to = new Set<string>();
  for (const m of withoutCode(text).matchAll(MENTION)) {
    const token = (m[2] ?? '').replace(/[.,;:!?)\]}"'”]+$/u, '').toLowerCase();
    if (token === 'claudes') return 'all';
    if (token === 'claude') to.add(me);
    const named = /^claude:(.+)$/.exec(token)?.[1];
    const peer = named ? people.find((p) => handle(p.name).toLowerCase() === named) : undefined;
    if (peer) to.add(peer.peerId);
  }
  return to.size ? [...to] : undefined;
}

/** The button's choice and the words' mentions together: everyone wins; otherwise each named Claude once. */
export function mergeAsk(a: 'all' | readonly string[] | undefined, b: 'all' | readonly string[] | undefined): 'all' | readonly string[] | undefined {
  if (a === 'all' || b === 'all') return 'all';
  if (!a?.length && !b?.length) return undefined;
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

/**
 * What "@…" in a channel's messages names, for the pills: its members (you too, for "@claude:you"),
 * the tasks you share with them, and your projects (a friend's "@beluga" is your copy of it, if you
 * have one by that name).
 */
export const channelWorld = (me: Member | undefined, people: readonly Member[], tasks?: readonly TaskMention[], projects: readonly ProjectMention[] = []): MentionWorld => ({
  friends: people,
  peers: me ? [me, ...people] : people,
  projects: mentionableProjects(projects, people),
  workspaces: [],
  ...(tasks?.length ? { tasks } : {}),
});

/** Under a message that asked: "Asked everyone’s Claude", "Asked bob’s Claude", "Asked your Claude". */
export function askedLine(m: Pick<MessageView, 'ask' | 'mine' | 'from'>, nameOf: (peerId: string) => string, me: string | undefined): string | undefined {
  const to = m.ask?.to;
  if (!to) return undefined;
  if (to === 'all') return 'Asked everyone’s agent';
  const names = to.map((p) => (p === me ? (m.mine ? 'their own' : 'your') : `${nameOf(p)}’s`));
  if (m.mine) return `Asked ${to.length === 1 && to[0] === me ? 'your' : names.join(' and ')} agent`;
  if (to.length === 1 && to[0] === m.from) return 'Asked their agent';
  return `Asked ${names.join(' and ')} agent`;
}

/** Who wrote it, as the chat shows it: "You", "bob", "Your Claude", "bob’s Claude". */
export function authorLabel(m: Pick<MessageView, 'mine' | 'name' | 'claude'>): string {
  if (m.claude) return m.mine ? `Your ${agentName(m.claude.agent)}` : `${m.name}’s ${agentName(m.claude.agent)}`;
  return m.mine ? 'You' : m.name;
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** "PDF", "ZIP", "PNG" (from the name), or "File". */
export function kindLabel(f: Pick<ChatFile, 'name'>): string {
  const ext = /\.([a-z0-9]{1,6})$/i.exec(f.name)?.[1];
  return ext ? ext.toUpperCase() : 'File';
}

/** Claudes answering in this conversation now (newest last), without stale ones. */
export function liveIn(state: Pick<NetworkState, 'live'>, conversation: string, now = Date.now(), ttl = 3 * 60_000): readonly LiveClaude[] {
  return (state.live?.[conversation] ?? []).filter((l) => now - l.since < ttl);
}

/** "bob’s Claude is answering…", "Your Claude and mia’s Claude are answering…". */
export function liveLine(live: readonly LiveClaude[], me: string | undefined): string {
  const names = [...new Set(live.map((l) => (l.peerId === me ? 'Your agent' : `${l.name}’s agent`)))];
  if (!names.length) return '';
  const list = names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${list} ${names.length === 1 ? 'is' : 'are'} answering…`;
}

// ---- runs of messages (BLG-210)

/** Where a message sits in its run: the first (its name above), the last (the avatar, the tail, the time). */
export interface RunPlace {
  readonly first: boolean;
  readonly last: boolean;
}

/**
 * Consecutive messages by the same person (or the same person's Claude) within a few minutes on the
 * same day make a run, as in a messaging app. A task's card stands on its own.
 */
export function runPlaces(messages: readonly MessageView[]): RunPlace[] {
  const joins = (a: MessageView | undefined, b: MessageView | undefined): boolean => Boolean(a && b && !a.task && !b.task && continues(a, b));
  return messages.map((m, i) => ({ first: !joins(messages[i - 1], m), last: !joins(m, messages[i + 1]) }));
}

// ---- chat tabs

/** The main channel's tab: always first, there even before the channel exists. */
export const MAIN_TAB = 'main';

/** Tabs to show: the main channel first, then the ones you opened (that still exist), and the one on screen. */
export function chatTabs(open: readonly string[], shown: string | undefined, state: Pick<NetworkState, 'main' | 'friends' | 'groups'>): string[] {
  const main = state.main ? `group:${state.main}` : undefined;
  const exists = (id: string): boolean => (id.startsWith('dm:') ? state.friends.some((f) => `dm:${f.peerId}` === id) : state.groups.some((g) => `group:${g.id}` === id));
  const list = [...open, ...(shown && !open.includes(shown) ? [shown] : [])].filter((id) => id !== main && id !== MAIN_TAB && exists(id));
  return [MAIN_TAB, ...new Set(list)];
}

/** Open a conversation's tab (at the end, if it isn't open already). */
export const openTab = (open: readonly string[], id: string): string[] => (open.includes(id) ? [...open] : [...open, id]);

/** Close a tab; → the tabs left and where to go if it was the one on screen (its neighbour, else the main channel). */
export function closeTab(open: readonly string[], id: string): { open: string[]; next: string } {
  const at = open.indexOf(id);
  const left = open.filter((t) => t !== id);
  return { open: left, next: left[Math.min(Math.max(at, 0), left.length - 1)] ?? MAIN_TAB };
}

/** Is this group the main channel (yours)? */
export const isMain = (state: Pick<NetworkState, 'main'>, g: Pick<GroupView, 'id'> | undefined): boolean => Boolean(g && state.main === g.id);

/** A channel's name as you see it: yours is "All Friends". */
export const channelName = (state: Pick<NetworkState, 'main'>, g: Pick<GroupView, 'id' | 'name'>): string => (isMain(state, g) ? 'All Friends' : g.name);
