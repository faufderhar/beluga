import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeProjectDir } from '../src/agent/runtime/claude/claude-sessions.js';
import { MacAssistant } from '../src/core/assistant/assistant.js';
import { attachAssistant } from '../src/core/assistant/registry.js';
import { pretendSystem } from '../src/core/gateway/demo-system.js';
import { isSecretPath } from '../src/core/shares.js';
import { Store, channelOf, initialState } from '../src/core/store.js';
import { reconcileScreen, reduceScreen, initialScreen } from '../src/client/screen.js';
import { RefTable } from '../src/companion/files.js';
import { macViewFor } from '../src/companion/open-on-mac.js';
import { HomeView, isMacTopic } from '../src/companion/protocol.js';
import { type ViewContext, conversations, homeView, phoneChannel, viewOf, workView } from '../src/companion/views.js';
import { ASSISTANT_HANDLERS } from '../src/ipc/assistant-handlers.js';
import { Body } from '../src/protocol.js';
import { ASSISTANT_CHANNEL, assistantChannel, assistantChatOf, assistantChatTitle, isAssistant } from '../src/shared/assistant.js';
import { sentinelChatTitle } from '../src/core/sentinel/model.js';
import { noticeTarget } from '../src/ui/notice-models.js';
import { waitFor } from './helpers.js';

/**
 * Your Mac's chats as tabs (BLG-102): several conversations at once, one open (kept across
 * restarts), each deletable for good (its history gone from disk too, no archive); the single chat
 * from before moves into the first tab with nothing lost; the phone talks to the open one.
 */

const ME = 'me';
const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'beluga-chats-'));

function make(dir = tmp(), claudeDir = tmp()) {
  const store = new Store(initialState('room', 'auto'));
  store.dispatch({ type: 'identity', selfId: ME, isHost: true, home: '/Users/k' });
  const a = new MacAssistant({ store, dir, selfId: () => ME, system: pretendSystem(), claudeDir });
  return { a, store, dir, claudeDir };
}

const say = (store: Store, channel: string, id: string, text: string): void => store.dispatch({ type: 'chat', id, from: ME, text, ts: 1, byAgent: false, channel });
const ids = (store: Store, channel: string): string[] => store.getState().log.filter((l) => l.channel === channel).map((l) => l.id);
const json = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));

afterEach(() => vi.unstubAllEnvs());

describe('channels', () => {
  it('the first chat keeps mac:assistant; the others are mac:assistant:<id>', () => {
    expect(assistantChannel('main')).toBe(ASSISTANT_CHANNEL);
    expect(assistantChannel('ab12')).toBe('mac:assistant:ab12');
    expect(assistantChatOf('mac:assistant')).toBe('main');
    expect(assistantChatOf('mac:assistant:ab12')).toBe('ab12');
    expect(assistantChatOf('mac:assistant:main')).toBeUndefined();
    expect(assistantChatOf('mac:assistant:../x')).toBeUndefined();
    expect(isAssistant('ws:abc')).toBe(false);
    expect(isMacTopic('conv:mac:assistant:ab12')).toBe(true);
    expect(isMacTopic('conv:ws:ab12')).toBe(false);
  });

  it('their messages are valid bodies (else they never reach Claude)', () => {
    const parsed = (b: object) => (Body.parse(b) as { channel?: string }).channel;
    expect(parsed({ kind: 'chat', text: 'hi', channel: 'mac:assistant:ab12' })).toBe('mac:assistant:ab12');
    expect(() => Body.parse({ kind: 'chat', text: 'hi', channel: 'mac:assistant:AB/1' })).toThrow();
  });

  it('a tab is named by the first thing you wrote in it', () => {
    const log = [
      { channel: 'mac:assistant:x', type: 'chat', byAgent: false, text: '\nWhat is using my CPU right now, and why so much?' },
      { channel: 'mac:assistant:x', type: 'chat', byAgent: false, text: 'later' },
    ];
    expect(assistantChatTitle('mac:assistant:x', log)).toBe('What is using my CPU right…');
    expect(assistantChatTitle('mac:assistant:y', log)).toBe('New chat');
  });

  it('a chat named in that first message shows by its title, never its ref', () => {
    const ref = 'IERRFia7jBz-zl_PX1AkHS3Ps7hgXnoM/ws:wt-9d87882a-26a';
    const log = [{ channel: 'mac:assistant:x', type: 'chat', byAgent: false, text: `see @refunds (chat: ${ref})` }];
    expect(assistantChatTitle('mac:assistant:x', log)).toBe('see @refunds');
    expect(sentinelChatTitle('mac:assistant:x', log)).toBe('see @refunds');
  });
});

describe('Your Mac’s chats', () => {
  it('moves the one chat from before into the first tab, nothing lost', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ sessionId: 'old-sess' }));
    writeFileSync(path.join(dir, 'history.json'), JSON.stringify([{ id: 'old1', type: 'chat', channel: ASSISTANT_CHANNEL, from: ME, name: 'me', text: 'hello from before', ts: 1, byAgent: false }]));
    const { a, store } = make(dir);
    expect(existsSync(path.join(dir, 'state.json'))).toBe(false);
    expect(existsSync(path.join(dir, 'history.json'))).toBe(false);
    expect(json(path.join(dir, 'chats', 'main', 'state.json'))).toEqual({ sessionId: 'old-sess' });
    expect(json(path.join(dir, 'chats.json'))).toMatchObject({ chats: [{ id: 'main' }], active: 'main' });
    expect(ids(store, ASSISTANT_CHANNEL)).toEqual(['old1']);
    expect(a.place(ASSISTANT_CHANNEL).resume).toBe('old-sess');
    expect(store.getState().assistant).toMatchObject({ chats: [{ id: 'main', channel: ASSISTANT_CHANNEL }], active: 'main' });
    a.stop();
    // Again: nothing moves twice, nothing is lost.
    const again = make(dir);
    expect(ids(again.store, ASSISTANT_CHANNEL)).toEqual(['old1']);
    again.a.stop();
  });

  it('a fresh Mac starts with one empty chat', () => {
    const { a, store, dir } = make();
    expect(store.getState().assistant.chats.map((c) => c.id)).toEqual(['main']);
    expect(existsSync(path.join(dir, 'chats', 'main'))).toBe(true);
    a.stop();
  });

  it('creates chats as new tabs, each its own conversation and session, open at once', async () => {
    const { a, store, dir } = make();
    const second = a.newChat();
    expect(second).toMatch(/^[a-z0-9]{1,24}$/);
    expect(store.getState().assistant.active).toBe(second);
    expect(store.getState().assistant.chats.map((c) => c.id)).toEqual(['main', second]);
    const ch2 = assistantChannel(second);
    say(store, ASSISTANT_CHANNEL, 'm1', 'first chat');
    say(store, ch2, 's1', 'second chat');
    a.place(ASSISTANT_CHANNEL).onSession('sess-main');
    a.place(ch2).onSession('sess-2');
    expect(a.place(ASSISTANT_CHANNEL).resume).toBe('sess-main');
    expect(a.place(ch2).resume).toBe('sess-2');
    expect(a.forRun(ch2, ME)?.place.resume).toBe('sess-2');
    expect(a.forRun(ch2, 'bob')).toBeUndefined();
    await waitFor(() => existsSync(path.join(dir, 'chats', second, 'history.json')) && existsSync(path.join(dir, 'chats', 'main', 'history.json')));
    a.stop();
  });

  it('switches between them, and keeps the chats, their histories and the open tab across restarts', async () => {
    const { a, store, dir } = make();
    const b = a.newChat();
    const c = a.newChat();
    say(store, assistantChannel(b), 'b1', 'in b');
    say(store, assistantChannel(c), 'c1', 'in c');
    a.openChat(b);
    expect(store.getState().assistant.active).toBe(b);
    expect(() => a.openChat('nope')).toThrow(/deleted/);
    await waitFor(() => existsSync(path.join(dir, 'chats', c, 'history.json')));
    a.stop();
    const again = make(dir);
    expect(again.store.getState().assistant).toMatchObject({ chats: [{ id: 'main' }, { id: b }, { id: c }], active: b });
    expect(ids(again.store, assistantChannel(b))).toEqual(['b1']);
    expect(ids(again.store, assistantChannel(c))).toEqual(['c1']);
    again.a.stop();
  });

  it('deletes a chat for good: its messages, its folder and its Claude transcript; the tab beside it opens', async () => {
    const { a, store, dir, claudeDir } = make();
    const b = a.newChat();
    const c = a.newChat();
    const chB = assistantChannel(b);
    say(store, chB, 'b1', 'secret plans');
    a.place(chB).onSession('sess-b');
    await waitFor(() => existsSync(path.join(dir, 'chats', b, 'history.json')));
    const transcripts = path.join(claudeDir, 'projects', encodeProjectDir(path.resolve(a.workDir)));
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(path.join(transcripts, 'sess-b.jsonl'), '{}\n');
    writeFileSync(path.join(transcripts, 'sess-other.jsonl'), '{}\n');
    a.openChat(b);
    await a.deleteChat(b);
    expect(ids(store, chB)).toEqual([]);
    expect(existsSync(path.join(dir, 'chats', b))).toBe(false);
    expect(existsSync(path.join(transcripts, 'sess-b.jsonl'))).toBe(false);
    expect(existsSync(path.join(transcripts, 'sess-other.jsonl'))).toBe(true);
    expect(store.getState().assistant.chats.map((x) => x.id)).toEqual(['main', c]);
    expect(store.getState().assistant.active).toBe(c);
    // Nothing of it comes back: not later, not after a restart.
    a.forRun(chB, ME);
    await new Promise((r) => setTimeout(r, 500));
    expect(existsSync(path.join(dir, 'chats', b))).toBe(false);
    a.stop();
    const again = make(dir);
    expect(again.store.getState().assistant.chats.map((x) => x.id)).toEqual(['main', c]);
    expect(ids(again.store, chB)).toEqual([]);
    again.a.stop();
  });

  it('deleting the last chat starts over: a fresh empty one in its place, with no archive', async () => {
    const { a, store, dir } = make();
    say(store, ASSISTANT_CHANNEL, 'm1', 'hello');
    a.place().onSession('sess-1');
    await waitFor(() => existsSync(path.join(dir, 'chats', 'main', 'history.json')));
    await a.deleteChat('main');
    expect(store.getState().assistant).toMatchObject({ chats: [{ id: 'main' }], active: 'main' });
    expect(ids(store, ASSISTANT_CHANNEL)).toEqual([]);
    expect(a.place().resume).toBeUndefined();
    expect(existsSync(path.join(dir, 'chats', 'main', 'history.json'))).toBe(false);
    expect(existsSync(path.join(dir, 'chats', 'main', 'state.json'))).toBe(false);
    a.stop();
  });

  it('a message to the first chat after it was deleted (an older phone) brings it back as a tab', async () => {
    const { a, store } = make();
    const b = a.newChat();
    await a.deleteChat('main');
    expect(store.getState().assistant.chats.map((x) => x.id)).toEqual([b]);
    expect(a.forRun(ASSISTANT_CHANNEL, ME)).toBeDefined();
    expect(store.getState().assistant.chats.map((x) => x.id)).toEqual(['main', b]);
    expect(a.forRun('mac:assistant:zzz', ME)).toBeUndefined();
    a.stop();
  });

  it('its files stay secret to the phone, in their new places too', () => {
    vi.stubEnv('BELUGA_HOME', '/Users/k/.beluga');
    expect(isSecretPath('/Users/k/.beluga/assistant/chats.json')).toBe(true);
    expect(isSecretPath('/Users/k/.beluga/assistant/chats/main/history.json')).toBe(true);
    expect(isSecretPath('/Users/k/.beluga/assistant/chats/ab12/state.json')).toBe(true);
  });

  it('deleting through the API stops its run first', async () => {
    const { a, store } = make();
    const b = a.newChat();
    const ch = assistantChannel(b);
    store.dispatch({ type: 'agent_event', owner: ME, requestId: 'r1', requester: ME, event: 'started', text: '', ts: 2, channel: ch, itemId: 'i1' });
    const stopped: string[] = [];
    const forgot: string[] = [];
    const session = { store, host: { stopRun: (c: string) => void stopped.push(c), forgetContext: (c: string) => void forgot.push(c) } };
    attachAssistant(session, a);
    await ASSISTANT_HANDLERS['assistant.deleteChat'](session as never, b);
    expect(stopped).toEqual([ch]);
    expect(forgot).toEqual([ch]);
    expect(store.getState().assistant.chats.map((x) => x.id)).toEqual(['main']);
    a.stop();
  });
});

describe('the Mac’s screen', () => {
  const two = () => {
    const { a, store } = make();
    const b = a.newChat();
    return { a, store, b };
  };

  it('Your Mac opens the open tab; a tab names its channel', () => {
    const { a, store, b } = two();
    const s = reduceScreen(initialScreen, { type: 'view', view: { kind: 'assistant' } }, store.getState());
    expect(s.view).toEqual({ kind: 'assistant', chat: b });
    expect(channelOf(s.view)).toBe(`mac:assistant:${b}`);
    expect(channelOf({ kind: 'assistant', chat: 'main' })).toBe(ASSISTANT_CHANNEL);
    // A chat that's gone goes to the open one.
    expect(reduceScreen(initialScreen, { type: 'view', view: { kind: 'assistant', chat: 'gone1' } }, store.getState()).view).toEqual({ kind: 'assistant', chat: b });
    a.stop();
  });

  it('follows the open tab when it changes (a new chat, a deleted one)', async () => {
    const { a, store, b } = two();
    let screen = reduceScreen(initialScreen, { type: 'view', view: { kind: 'assistant', chat: b } }, store.getState());
    let prev = store.getState();
    const c = a.newChat();
    screen = reconcileScreen(prev, store.getState(), screen);
    expect(screen.view).toEqual({ kind: 'assistant', chat: c });
    prev = store.getState();
    await a.deleteChat(c);
    screen = reconcileScreen(prev, store.getState(), screen);
    expect(screen.view).toEqual({ kind: 'assistant', chat: b });
    a.stop();
  });

  it('a notification from a chat opens that chat', () => {
    const { a, store, b } = two();
    expect(noticeTarget(store.getState(), `mac:assistant:${b}`)).toEqual({ kind: 'assistant', chat: b });
    expect(noticeTarget(store.getState(), ASSISTANT_CHANNEL)).toEqual({ kind: 'assistant', chat: 'main' });
    a.stop();
  });
});

describe('the phone', () => {
  const ctx = (): ViewContext => ({ refs: new RefTable(() => 'ref00001'), mac: { name: 'Mac', version: '1' }, outputs: () => [] });

  it('Ask your Mac is the open tab; every chat is a conversation named by its tab; none is a project', () => {
    const { a, store } = make();
    const b = a.newChat();
    say(store, ASSISTANT_CHANNEL, 'm1', 'Screenshot please');
    say(store, assistantChannel(b), 'b1', 'What is running?');
    const s = store.getState();
    const home = homeView(s, ctx());
    expect(HomeView.safeParse(home).success).toBe(true);
    expect(home.assistant).toMatchObject({ topic: `conv:mac:assistant:${b}`, title: 'Your Mac · What is running?' });
    expect(conversations(s).filter((c) => isAssistant(c.channel)).map((c) => c.title)).toEqual(['Your Mac · Screenshot please', 'Your Mac · What is running?']);
    expect(workView(s, ctx()).projects).toEqual([]);
    expect(viewOf(s, ctx(), `conv:mac:assistant:${b}`)).toMatchObject({ canSend: true, title: 'Your Mac · What is running?' });
    a.openChat('main');
    expect(homeView(store.getState(), ctx()).assistant?.topic).toBe('conv:mac:assistant');
    a.stop();
  });

  it('one chat reads as plain Your Mac, as before', () => {
    const { a, store } = make();
    expect(homeView(store.getState(), ctx()).assistant).toMatchObject({ topic: 'conv:mac:assistant', title: 'Your Mac' });
    a.stop();
  });

  it('an older phone’s Your Mac reaches the open chat once the first is deleted', async () => {
    const { a, store } = make();
    const b = a.newChat();
    say(store, assistantChannel(b), 'b1', 'still here');
    expect(phoneChannel(store.getState(), ASSISTANT_CHANNEL)).toBe(ASSISTANT_CHANNEL);
    await a.deleteChat('main');
    const s = store.getState();
    expect(phoneChannel(s, ASSISTANT_CHANNEL)).toBe(assistantChannel(b));
    expect(viewOf(s, ctx(), 'conv:mac:assistant')).toMatchObject({ canSend: true, turns: [expect.objectContaining({ id: 'b1' })] });
    expect(macViewFor(s, { topic: 'conv:mac:assistant' })).toEqual({ kind: 'assistant' });
    expect(macViewFor(s, { topic: `conv:mac:assistant:${b}` })).toEqual({ kind: 'assistant', chat: b });
    expect(macViewFor(s, { topic: 'conv:mac:assistant:gone1' })).toBeUndefined();
    a.stop();
  });
});
