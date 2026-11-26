import { describe, expect, it } from 'vitest';
import { resolveChat, resolveChatText, resolveChatWhenKnown } from '../src/core/chat-links/resolve.js';
import { type DomainState, initialState } from '../src/core/store.js';
import { ChatResolveResult, PhoneCalls } from '../src/companion/calls.js';
import { phoneMay } from '../src/companion/coverage.js';
import { assistantChannel } from '../src/shared/assistant.js';
import { formatChatRef } from '../src/shared/chat-ref.js';

const ME = 'me-me-me-me-me-me-me-me-me-me-me0';
const FRIEND = 'friend-friend-friend-friend-frie';

const ws = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, projectId: 'p1', projectRoot: '/p', path: `/p/${id}`, kind: 'worktree', createdAt: 0, ...extra });

const agentAt = (channel: string, status: string) => ({ type: 'agent', id: `a-${channel}`, channel, status, ts: 1 });

function stateWith(extra: Partial<Record<keyof DomainState, unknown>> = {}): DomainState {
  return {
    ...initialState('room'),
    selfId: ME,
    projectsLoaded: true,
    projects: [
      {
        id: 'p1',
        name: 'Beluga',
        root: '/p',
        workspaces: [
          ws('main1', 'main', { kind: 'main' }),
          ws('main2', 'main', { kind: 'main', movedTo: 'chat-1' }),
          ws('wt-1', 'add-auth'),
          ws('wt-2', 'old-work', { archived: true }),
          ws('chat-1', 'A chat', { kind: 'chat' }),
        ],
      },
    ],
    ...extra,
  } as unknown as DomainState;
}

const own = (channel: string) => ({ owner: ME, channel });

describe('resolveChat, your own worktrees and project chats', () => {
  it('finds an idle worktree', () => {
    expect(resolveChat(stateWith(), own('ws:wt-1'))).toEqual({
      ref: own('ws:wt-1'),
      title: 'add-auth',
      kind: 'worktree',
      state: 'idle',
      ownership: 'own',
      view: { kind: 'workspace', id: 'wt-1', tab: 'chat' },
    });
  });

  it('says a chat is a chat', () => {
    expect(resolveChat(stateWith(), own('ws:chat-1'))).toMatchObject({ title: 'A chat', kind: 'chat', state: 'idle' });
  });

  it.each(['queued', 'awaiting_approval', 'started', 'answered'])('says %s is working', (status) => {
    const state = stateWith({ log: [agentAt('ws:wt-1', status)] });
    expect(resolveChat(state, own('ws:wt-1')).state).toBe('working');
  });

  it('says a chat is working while a thread under it works, and idle when its threads are done', () => {
    const threads = (status: string) =>
      stateWith({
        projects: [{ id: 'p1', name: 'Beluga', root: '/p', workspaces: [ws('chat-1', 'A chat', { kind: 'chat' }), ws('t1', 'A thread', { kind: 'chat', thread: { parent: 'ws:chat-1', parentTitle: 'A chat', root: 'ws:chat-1', depth: 1, task: 't', startedAt: 1, owed: [] } }), ws('t2', 'Its thread', { kind: 'chat', thread: { parent: 'ws:t1', parentTitle: 'A thread', root: 'ws:chat-1', depth: 2, task: 't', startedAt: 1, owed: [] } })] }],
        log: [agentAt('ws:chat-1', 'done'), agentAt('ws:t1', 'done'), agentAt('ws:t2', status)],
      });
    expect(resolveChat(threads('started'), own('ws:chat-1')).state).toBe('working');
    expect(resolveChat(threads('done'), own('ws:chat-1')).state).toBe('idle');
  });

  it.each(['done', 'error', 'denied'])('says %s is idle', (status) => {
    const state = stateWith({ log: [agentAt('ws:wt-1', status)] });
    expect(resolveChat(state, own('ws:wt-1')).state).toBe('idle');
  });

  it('finds an archived worktree, with its title and a way to open it', () => {
    expect(resolveChat(stateWith(), own('ws:wt-2'))).toMatchObject({ title: 'old-work', state: 'archived', ownership: 'own', view: { kind: 'workspace', id: 'wt-2', tab: 'chat' } });
  });

  it('says archived even when the log looks busy', () => {
    const state = stateWith({ log: [agentAt('ws:wt-2', 'started')] });
    expect(resolveChat(state, own('ws:wt-2')).state).toBe('archived');
  });

  it('says a removed worktree is removed, with no title and nothing to open', () => {
    const got = resolveChat(stateWith(), own('ws:wt-gone'));
    expect(got).toMatchObject({ state: 'removed', ownership: 'own' });
    expect(got.title).toBeUndefined();
    expect(got.view).toBeUndefined();
  });

  it('shows the current name after a rename', () => {
    const before = stateWith();
    const project = before.projects[0]!;
    const after = { ...before, projects: [{ ...project, workspaces: project.workspaces.map((w) => (w.id === 'wt-1' ? { ...w, name: 'better-name' } : w)) }] } as DomainState;
    expect(resolveChat(after, own('ws:wt-1')).title).toBe('better-name');
  });

  it('opens the project for a main checkout, and the chat it moved to when it moved', () => {
    expect(resolveChat(stateWith(), own('ws:main1')).view).toEqual({ kind: 'project', id: 'p1' });
    expect(resolveChat(stateWith(), own('ws:main2'))).toMatchObject({ title: 'A chat', kind: 'chat', view: { kind: 'workspace', id: 'chat-1', tab: 'chat' } });
  });
});

describe('resolveChat, Your Mac', () => {
  const chats = (...ids: string[]) => ({ assistant: { chats: ids.map((id) => ({ id, channel: assistantChannel(id), createdAt: 0 })), active: ids[0] } });

  it('names a chat by its first line and opens that chat', () => {
    const channel = assistantChannel('a1b2');
    const log = [{ type: 'chat', channel, text: 'Clean my desktop', byAgent: false, ts: 1, id: 'x', from: ME }];
    expect(resolveChat(stateWith({ ...chats('a1b2'), log }), own(channel))).toMatchObject({ title: 'Clean my desktop', kind: 'assistant', state: 'idle', ownership: 'own', view: { kind: 'assistant', chat: 'a1b2' } });
  });

  it('says a deleted chat is removed, without falling back to the chat open now', () => {
    const got = resolveChat(stateWith(chats('a1b2')), own(assistantChannel('gone')));
    expect(got.state).toBe('removed');
    expect(got.view).toBeUndefined();
  });

  it('keeps Beluga’s own chats findable', () => {
    const channel = assistantChannel('auto1');
    const state = stateWith({ assistant: { chats: [{ id: 'auto1', channel, createdAt: 0, auto: true }], active: 'x' } });
    expect(resolveChat(state, own(channel)).state).toBe('idle');
  });

  it('knows the first chat before there are any', () => {
    expect(resolveChat(stateWith(), own('mac:assistant'))).toMatchObject({ state: 'idle', kind: 'assistant', view: { kind: 'assistant' } });
  });

  it('says the first chat is removed once it is deleted', () => {
    expect(resolveChat(stateWith(chats('a1b2')), own('mac:assistant')).state).toBe('removed');
  });

  it('says a chat is working', () => {
    const channel = assistantChannel('a1b2');
    expect(resolveChat(stateWith({ ...chats('a1b2'), log: [agentAt(channel, 'started')] }), own(channel)).state).toBe('working');
  });
});

describe('resolveChat, the Sentinel chat', () => {
  const sentinel = { enabled: true, chats: { chats: [{ id: 'a1', channel: 'sentinel-chat:a1', createdAt: 0 }], active: 'a1' } };

  it('finds a chat and opens it', () => {
    expect(resolveChat(stateWith({ sentinel }), own('sentinel-chat:a1'))).toMatchObject({ title: 'New chat', kind: 'sentinel', state: 'idle', view: { kind: 'sentinel_chat', chat: 'a1' } });
  });

  it('says a deleted chat is removed', () => {
    expect(resolveChat(stateWith({ sentinel }), own('sentinel-chat:gone')).state).toBe('removed');
  });

  it('knows the first chat before there are any', () => {
    expect(resolveChat(stateWith(), own('sentinel-chat:main'))).toMatchObject({ state: 'idle', view: { kind: 'sentinel_chat', chat: 'main' } });
  });
});

describe('resolveChat, other people’s chats', () => {
  const shared = { shared: [{ owner: FRIEND, id: 'wt-9', name: 'their-work', project: 'Their app', role: 'contribute', share: 's' }] };

  it('finds a worktree shared with you', () => {
    expect(resolveChat(stateWith(shared), { owner: FRIEND, channel: 'ws:wt-9' })).toMatchObject({ title: 'their-work', kind: 'worktree', state: 'idle', ownership: 'shared', view: { kind: 'shared', owner: FRIEND, id: 'wt-9', tab: 'chat' } });
  });

  it('says a shared worktree is working', () => {
    const state = stateWith({ ...shared, log: [agentAt('ws:wt-9', 'started')] });
    expect(resolveChat(state, { owner: FRIEND, channel: 'ws:wt-9' }).state).toBe('working');
  });

  it('tells nothing of a chat you cannot read', () => {
    const got = resolveChat(stateWith(), { owner: FRIEND, channel: 'ws:wt-9' });
    expect(got).toEqual({ ref: { owner: FRIEND, channel: 'ws:wt-9' }, kind: 'worktree', state: 'removed', ownership: 'unknown' });
  });

  it('does not take your own chat for someone else’s with the same channel', () => {
    const got = resolveChat(stateWith(), { owner: FRIEND, channel: 'ws:wt-1' });
    expect(got.ownership).toBe('unknown');
    expect(got.title).toBeUndefined();
    expect(got.view).toBeUndefined();
    expect(resolveChat(stateWith(), { owner: FRIEND, channel: 'mac:assistant' }).ownership).toBe('unknown');
  });

  it('does not take a worktree shared by one friend for another’s', () => {
    expect(resolveChat(stateWith(shared), { owner: 'someone-else-entirely-0000000000', channel: 'ws:wt-9' }).ownership).toBe('unknown');
  });
});

describe('resolveChatText, what the API answers', () => {
  const on = (extra: Partial<Record<keyof DomainState, unknown>> = {}) => stateWith(extra);
  const text = formatChatRef(own('ws:wt-1'))!;

  it('answers for a chat of yours', () => {
    expect(resolveChatText(on(), text)?.title).toBe('add-auth');
  });

  it('answers nothing for a malformed ref', () => {
    expect(resolveChatText(on(), 'nonsense')).toBeUndefined();
    expect(resolveChatText(on(), `${ME}/room`)).toBeUndefined();
  });
});

describe('before the first scan of the projects', () => {
  const on = {};
  const scanning = (extra: Partial<Record<keyof DomainState, unknown>> = {}) => stateWith({ ...on, projects: [], projectsLoaded: false, ...extra });
  const text = formatChatRef(own('ws:wt-1'))!;

  /** A store as resolveChatWhenKnown reads one: state that changes, and who to tell. */
  function storeOf(first: DomainState) {
    let state = first;
    const told = new Set<() => void>();
    return {
      getState: () => state,
      subscribe: (fn: () => void) => (told.add(fn), () => void told.delete(fn)),
      set: (next: DomainState) => ((state = next), told.forEach((fn) => fn())),
      listeners: () => told.size,
    };
  }

  it('does not call your worktree removed', () => {
    expect(resolveChat(scanning(), own('ws:wt-1'))).toEqual({ ref: own('ws:wt-1'), kind: 'worktree', state: 'loading', ownership: 'own' });
  });

  it('is sure of what the records already say', () => {
    expect(resolveChat(scanning(), own('mac:assistant')).state).toBe('idle');
  });

  it('says removed once the scan is done', () => {
    expect(resolveChat(stateWith(on), own('ws:wt-gone')).state).toBe('removed');
  });

  it('does not wait for someone else’s chat', () => {
    expect(resolveChat(scanning(), { owner: FRIEND, channel: 'ws:wt-1' }).ownership).toBe('unknown');
  });

  it('the API answers once the scan is done, with the chat', async () => {
    const store = storeOf(scanning());
    const answer = resolveChatWhenKnown(store, text);
    store.set(stateWith(on));
    expect((await answer)?.title).toBe('add-auth');
    expect(store.listeners()).toBe(0);
  });

  it('the API answers at once when nothing is loading', async () => {
    expect((await resolveChatWhenKnown(storeOf(stateWith(on)), text))?.title).toBe('add-auth');
  });

  it('the API stops waiting after a while, and says it is still loading', async () => {
    const store = storeOf(scanning());
    expect((await resolveChatWhenKnown(store, text, 5))?.state).toBe('loading');
    expect(store.listeners()).toBe(0);
  });
});

describe('what the phone gets', () => {
  const on = {};

  it('may call it, with a ref as text', () => {
    expect(phoneMay('chats.resolve')).toBe(true);
    expect(PhoneCalls['chats.resolve'].args.safeParse([formatChatRef(own('ws:wt-1'))]).success).toBe(true);
    expect(PhoneCalls['chats.resolve'].args.safeParse([]).success).toBe(false);
  });

  it.each([
    ['idle', own('ws:wt-1'), stateWith(on)],
    ['archived', own('ws:wt-2'), stateWith(on)],
    ['working', own('ws:wt-1'), stateWith({ ...on, log: [agentAt('ws:wt-1', 'started')] })],
    ['removed', own('ws:wt-gone'), stateWith(on)],
    ['loading', own('ws:wt-1'), stateWith({ ...on, projects: [], projectsLoaded: false })],
    ['removed', { owner: FRIEND, channel: 'ws:wt-1' }, stateWith(on)],
  ] as const)('reads a %s answer by its own schema', (expected, ref, state) => {
    const got = ChatResolveResult.parse(JSON.parse(JSON.stringify(resolveChat(state, ref))));
    expect(got?.state).toBe(expected);
  });

  it('reads chat links off as nothing', () => {
    expect(ChatResolveResult.parse(null)).toBeNull();
  });
});
