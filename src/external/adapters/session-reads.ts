import { waitingNeeds } from '../../companion/needs-you.js';
import type { DomainState, LogItem } from '../../core/store.js';
import type { StepPage } from '../../shared/steps.js';
import { agentLabel } from '../../shared/agent-label.js';
import type { Workspace } from '../../workspaces/types.js';
import type { ChatItem, ChatRead, ChatRef, RuntimeRef, StepLine } from '../ports/chat-read.js';

/** The read port over a daemon's state, and its saved conversations. It changes nothing: no loading into the state, no screen. */

export interface SessionReadsDeps {
  readonly state: () => DomainState;
  readonly loadHistory: (workspaceId: string) => readonly LogItem[];
  readonly stepsFor: (channel: string, itemId: string) => StepPage;
  readonly runtimes: () => Promise<readonly RuntimeRef[]>;
}

const ROOM = 'room';
const WS_PREFIX = 'ws:';
const CONV_TOPIC = /^conv:(.+)$/;
const FINISHED: ReadonlySet<string> = new Set(['done', 'error', 'denied', 'interrupted']);

export function sessionReads(deps: SessionReadsDeps): ChatRead {
  const channelOf = (chatId: string): string => (isNetworkOrRoom(chatId) ? chatId : `${WS_PREFIX}${chatId}`);
  const logItems = (chatId: string): readonly LogItem[] => {
    const channel = channelOf(chatId);
    const live = deps.state().log.filter((l) => l.channel === channel);
    if (isNetworkOrRoom(chatId)) return live;
    const saved = deps.loadHistory(chatId);
    const liveById = new Map(live.map((l) => [l.id, l]));
    const known = new Set(saved.map((l) => l.id));
    return [...saved.map((l) => liveById.get(l.id) ?? l), ...live.filter((l) => !known.has(l.id))];
  };
  const networkItems = (chatId: string): readonly ChatItem[] => (deps.state().network.messages[chatId] ?? []).map((m) => ({ id: m.id, role: 'person' as const, author: m.mine ? 'you' : m.name, text: m.text, ts: m.ts }));

  return {
    projects: () => deps.state().projects.filter((p) => p.root && !p.error).map((p) => ({ id: p.id, name: p.name })),
    chats: () => [...workspaceChats(deps.state()), ...otherChats(deps.state())],
    history: (chatId) => (isNetwork(chatId) ? networkItems(chatId) : logItems(chatId).flatMap(itemOf)),
    steps: (chatId, itemId) => {
      const page = deps.stepsFor(channelOf(chatId), itemId);
      return page.missing ? undefined : page.steps.map(stepLine);
    },
    needs: () => waitingNeeds(deps.state()).map((n) => {
      const channel = CONV_TOPIC.exec(n.topic ?? '')?.[1];
      const chatId = channel?.startsWith(WS_PREFIX) ? channel.slice(WS_PREFIX.length) : channel;
      return { id: n.id, kind: n.kind, title: n.title, ...(n.from ? { from: n.from } : {}), ...(chatId ? { chatId } : {}), ...(n.askedAt ? { askedAt: n.askedAt } : {}) };
    }),
    runtimes: deps.runtimes,
  };
}

const isNetwork = (chatId: string): boolean => chatId.startsWith('dm:') || chatId.startsWith('group:');
const isNetworkOrRoom = (chatId: string): boolean => chatId === ROOM || isNetwork(chatId);

function workspaceChats(state: DomainState): ChatRef[] {
  return state.projects.flatMap((p) =>
    p.workspaces
      .filter((w) => w.kind !== 'main' && !w.pending)
      .map((w) => ({
        id: w.id,
        kind: 'project' as const,
        title: w.name,
        projectId: p.id,
        projectName: p.name,
        ...(w.branch ? { branch: w.branch } : {}),
        status: statusOf(state, w),
        ...lastOf(state, `${WS_PREFIX}${w.id}`),
        createdBy: w.startedByAgent?.name ?? w.handedFrom ?? 'you',
        ...(w.startedByAgent ? { startedById: w.startedByAgent.id } : {}),
        creationSource: w.startedByAgent ? ('mcp' as const) : w.importedSession || w.external ? ('external' as const) : w.handedFrom ? ('friend' as const) : ('beluga' as const),
      })),
  );
}

function otherChats(state: DomainState): ChatRef[] {
  const room: ChatRef = { id: ROOM, kind: 'group', title: state.room || 'Group chat', status: 'idle', ...lastOf(state, ROOM), createdBy: 'you', creationSource: 'beluga' };
  const names = new Map<string, { title: string; kind: 'dm' | 'group' }>([
    ...state.network.friends.map((f) => [`dm:${f.peerId}`, { title: f.name, kind: 'dm' as const }] as const),
    ...state.network.groups.map((g) => [`group:${g.id}`, { title: g.name, kind: 'group' as const }] as const),
  ]);
  const network = Object.entries(state.network.messages).flatMap(([id, messages]): ChatRef[] => {
    const known = names.get(id);
    if (!known) return [];
    const last = messages.at(-1);
    return [{ id, kind: known.kind, title: known.title, status: 'idle', ...(last ? { lastAt: last.ts } : {}), createdBy: known.title, creationSource: 'network' }];
  });
  return [room, ...network];
}

function statusOf(state: DomainState, w: Workspace): ChatRef['status'] {
  if (w.archived) return 'archived';
  const running = state.log.some((l) => l.channel === `${WS_PREFIX}${w.id}` && l.type === 'agent' && !FINISHED.has(l.status));
  return running ? 'running' : 'idle';
}

function lastOf(state: DomainState, channel: string): { lastAt?: number } {
  const last = state.log.filter((l) => l.channel === channel).at(-1);
  return last ? { lastAt: last.ts } : {};
}

function itemOf(item: LogItem): ChatItem[] {
  switch (item.type) {
    case 'chat':
      return [{ id: item.id, role: item.byAgent ? 'agent' : 'person', author: item.name, text: item.text, ts: item.ts }];
    case 'agent':
      return [{ id: item.id, role: 'agent', author: agentLabel(item.agent, item.ownerName, false), text: item.text, ts: item.ts, status: item.status, stepLines: item.steps }];
    case 'system':
      return [{ id: item.id, role: 'system', author: 'Beluga', text: item.text, ts: item.ts }];
    default:
      // A shell's command and output: not a message, and it may hold anything.
      return [];
  }
}

const stepLine = (s: StepPage['steps'][number]): StepLine => ({ title: s.label ?? s.title, ...(s.tool ? { tool: s.tool } : {}), status: s.status, startedAt: s.startedAt, ...(s.durationMs !== undefined ? { durationMs: s.durationMs } : {}) });
