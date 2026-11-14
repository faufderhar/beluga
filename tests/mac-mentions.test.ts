import { describe, expect, it } from 'vitest';
import { chatsToMention } from '../src/core/chat-links/resolve.js';
import { parseInput } from '../src/core/mentions.js';
import type { DomainState } from '../src/core/store.js';
import type { FsEntry, PeerInfo } from '../src/protocol.js';
import { chatLinksToMentions, chatMention, parseChatRef, withChatWords } from '../src/shared/chat-ref.js';
import { linkMentions, parseMentionHref, resolveMention, splitMentions, type MentionWorld } from '../packages/mac/src/chat/mentions.js';
import { mentionDir, suggest, typedMention } from '../src/ui/suggest.js';

/** "@mia", "@bob-api", "@add-auth", "@src/", "@src/auth.ts": pills when they name someone or something. */

const entry = (name: string, dir: boolean): FsEntry => ({ name, dir, size: 0 }) as FsEntry;
const tree: Record<string, FsEntry[]> = { '': [entry('src', true), entry('README.md', false), entry('.env', false)], src: [entry('auth.ts', false), entry('routes', true)] };
const world: MentionWorld = {
  friends: [{ name: 'mia', peerId: 'mia-peer-0001' }, { name: 'Zoë Ray', peerId: 'zoe-peer-0001' }],
  peers: [{ name: 'bob', peerId: 'bob-peer-0001' }],
  projects: [{ name: 'bob-api', id: 'p1' }],
  workspaces: [{ label: '@add-auth', id: 'w1' }],
  entries: (dir) => tree[dir],
};

describe('what a mention names', () => {
  it('friends, Claudes, projects, worktrees, folders and files; anything else is just text', () => {
    expect(resolveMention('mia', world)).toEqual({ kind: 'friend', label: 'mia', id: 'mia-peer-0001' });
    expect(resolveMention('ZoëRay', world)).toEqual({ kind: 'friend', label: 'Zoë Ray', id: 'zoe-peer-0001' });
    expect(resolveMention('claude:bob', world)).toEqual({ kind: 'claude', label: 'bob’s agent', id: 'bob-peer-0001' });
    expect(resolveMention('bob-api', world)).toEqual({ kind: 'project', label: 'bob-api', id: 'p1' });
    expect(resolveMention('add-auth', world)).toEqual({ kind: 'workspace', label: 'add-auth', id: 'w1' });
    expect(resolveMention('src/', world)).toEqual({ kind: 'folder', label: 'src/', path: 'src/' });
    expect(resolveMention('src/auth.ts', world)).toEqual({ kind: 'file', label: 'src/auth.ts', path: 'src/auth.ts' });
    expect(resolveMention('README.md', world)).toMatchObject({ kind: 'file' });
    for (const nothing of ['nobody', 'src/missing.ts', 'README.md/', '../etc/passwd', '/etc/hosts']) expect(resolveMention(nothing, world)).toBeUndefined();
  });

  it('cuts a message into text and pills, leaving punctuation and e-mail addresses alone', () => {
    expect(splitMentions('hey @mia, check @src/auth.ts! mail me@mia.dev', world)).toEqual([
      { text: 'hey ' },
      { raw: '@mia', ref: { kind: 'friend', label: 'mia', id: 'mia-peer-0001' } },
      { text: ', check ' },
      { raw: '@src/auth.ts', ref: { kind: 'file', label: 'src/auth.ts', path: 'src/auth.ts' } },
      { text: '! mail me@mia.dev' },
    ]);
  });

  it('becomes a link the message draws as a pill; code stays code', () => {
    const md = linkMentions('@mia look at @bob-api\n```\n@mia in code\n```\nand `@mia` inline', world);
    const [first, ...rest] = md.split('\n');
    expect(first).toMatch(/^\[@mia\]\(beluga-mention:[^)]+\) look at \[@bob-api\]\(beluga-mention:[^)]+\)$/);
    expect(rest).toEqual(['```', '@mia in code', '```', 'and `@mia` inline']);
    const href = /\((beluga-mention:[^)]+)\)/.exec(first!)![1]!;
    expect(parseMentionHref(href)).toEqual({ kind: 'friend', label: 'mia', id: 'mia-peer-0001' });
    expect(parseMentionHref('beluga-mention:%7Bnope')).toBeUndefined();
  });
});

describe('a chat in the words', () => {
  const ref = 'peer-owner-0001/ws:wt-login';

  it('is one piece, title and all, that keeps the text as written', () => {
    expect(splitMentions(`read @Fix the login (chat: ${ref}), and @mia`, world)).toEqual([
      { text: 'read ' },
      { raw: `@Fix the login (chat: ${ref})`, ref: { kind: 'chat', label: 'Fix the login', id: ref } },
      { text: ', and ' },
      { raw: '@mia', ref: { kind: 'friend', label: 'mia', id: 'mia-peer-0001' } },
    ]);
    // A mention before it doesn't swallow the words up to it.
    expect(splitMentions(`@mia see @Fix (chat: ${ref})`, world).map((p) => ('ref' in p ? p.ref.kind : 'text'))).toEqual(['friend', 'text', 'chat']);
  });

  it('stays words for a malformed ref, and for the room', () => {
    for (const bad of ['nope', 'peer-owner-0001/room', 'peer-owner-0001/dm:bob']) expect(splitMentions(`@Fix (chat: ${bad})`, world)).toEqual([{ text: `@Fix (chat: ${bad})` }]);
  });

  it('becomes a mention link that names the chat', () => {
    const href = /\((beluga-mention:[^)]+)\)/.exec(linkMentions(`@Fix (it) (chat: ${ref}) ok @Fix login (chat: ${ref})`, world))![1]!;
    expect(parseMentionHref(href)).toEqual({ kind: 'chat', label: 'Fix login', id: ref });
  });

  it('is written from a title that cannot break it', () => {
    expect(chatMention('Fix (the) @login\nnow', parseChatRef(ref)!)).toBe(`@Fix the login now (chat: ${ref})`);
    expect(chatMention('  ()  ', parseChatRef(ref)!)).toBe(`@Chat (chat: ${ref})`);
    expect(chatMention('Fix', { owner: 'x', channel: 'room' })).toBeUndefined();
  });

  it('a pasted link becomes one; other links and links in Markdown stay', () => {
    const link = `beluga://chat/peer-owner-0001/${encodeURIComponent('ws:wt-login')}`;
    const titleOf = (): string => 'Fix login';
    expect(chatLinksToMentions(link, titleOf)).toBe(`@Fix login (chat: ${ref}) `);
    expect(chatLinksToMentions(`see ${link}, and ${link}.`, titleOf)).toBe(`see @Fix login (chat: ${ref}), and @Fix login (chat: ${ref}).`);
    for (const stays of [`[x](${link})`, `x${link}`, 'beluga://chat/peer-owner-0001/room', 'https://example.com', 'no link']) expect(chatLinksToMentions(stays, titleOf)).toBeUndefined();
  });

  it('goes in a draft apart from the words around it', () => {
    expect(withChatWords('', 0, '@A')).toEqual({ text: '@A ', caret: 3 });
    expect(withChatWords('see', 3, '@A')).toEqual({ text: 'see @A ', caret: 7 });
    expect(withChatWords('see ', 4, '@A')).toEqual({ text: 'see @A ', caret: 7 });
    expect(withChatWords('see this', 3, '@A')).toEqual({ text: 'see @A this', caret: 6 });
    expect(withChatWords('see this', 0, '@A')).toEqual({ text: '@A see this', caret: 3 });
  });

  it('at the start of a message is no person to ask', () => {
    const peers = [{ peerId: 'me', name: 'me', agent: true, shares: [] }, { peerId: 'b', name: 'Fix', agent: true, shares: [] }] as unknown as PeerInfo[];
    expect(parseInput(`@Fix the login (chat: ${ref}) what happened?`, 'me', peers)).toMatchObject({ kind: 'chat', text: `@Fix the login (chat: ${ref}) what happened?` });
    expect(parseInput(`@Fix (chat: ${ref}) what happened?`, 'me', peers)).toMatchObject({ kind: 'chat' });
    expect(parseInput(`@claude @Fix the login (chat: ${ref}) what happened?`, 'me', peers)).toMatchObject({ kind: 'agent', prompt: `@Fix the login (chat: ${ref}) what happened?`, unknown: [] });
    expect(parseInput('@Fix what happened?', 'me', peers)).toMatchObject({ kind: 'agent', prompt: 'what happened?' });
  });
});

describe('offering chats', () => {
  const ctx = {
    peers: [],
    selfId: 'me',
    chats: [
      { title: 'Fix the login', ref: 'peer-owner-0001/ws:wt-login', hint: 'Worktree' },
      { title: 'Dark mode', ref: 'peer-other-0001/ws:wt-dark', hint: 'Shared' },
    ],
  };

  it('finds a chat by a word of its title, and fills in the reference', () => {
    expect(suggest('see @log', ctx)).toEqual([{ label: '@Fix the login', hint: 'Worktree', value: 'see @Fix the login (chat: peer-owner-0001/ws:wt-login) ', enter: 'complete', kind: 'chat' }]);
    expect(suggest('@dark-mo', ctx).map((s) => s.label)).toEqual(['@Dark mode']);
    expect(suggest('@checkout-ev', { ...ctx, chats: [{ title: 'checkout-events', ref: 'peer-owner-0001/ws:wt-c', hint: 'Worktree' }] }).map((s) => s.label)).toEqual(['@checkout-events']);
    expect(suggest('@zzz', ctx)).toEqual([]);
  });

  it('offers none for a lone @ or inside a path', () => {
    expect(suggest('@', ctx).filter((s) => s.kind === 'chat')).toEqual([]);
    expect(suggest('@login/', ctx)).toEqual([]);
  });

  it('lists your chats and shared ones, not the one you are in, a main folder, an archived chat or a bad address', () => {
    const state = {
      selfId: 'peer-self-00001',
      projectsLoaded: true,
      log: [],
      projects: [{ workspaces: [
        { id: 'wt-a', name: 'Worktree A', kind: 'worktree' },
        { id: 'wt-b', name: 'Worktree B', kind: 'worktree' },
        { id: 'wt-c', name: 'Archived', kind: 'worktree', archived: true },
        { id: 'main', name: 'main', kind: 'main' },
      ] }],
      assistant: { chats: [] },
      sentinel: {},
      shared: [{ owner: 'peer-mia-000001', id: 'wt-m', name: 'Theirs' }],
    } as unknown as DomainState;
    expect(chatsToMention(state, 'ws:wt-a').map((c) => [c.title, c.ref, c.kind, c.ownership])).toEqual([
      ['Worktree B', 'peer-self-00001/ws:wt-b', 'worktree', 'own'],
      ['Theirs', 'peer-mia-000001/ws:wt-m', 'worktree', 'shared'],
    ]);
  });
});

describe('typing a mention', () => {
  const ctx = { peers: [], selfId: 'me', friends: [{ name: 'mia', online: true }], projects: [{ name: 'bob-api' }], entries: (dir: string) => tree[dir] };
  it('knows what is being typed and which folder to list', () => {
    expect(typedMention('ask @src/au')).toBe('src/au');
    expect(typedMention('no mention')).toBeUndefined();
    expect(mentionDir('look at @src/au')).toBe('src');
    expect(mentionDir('@RE')).toBe('');
    expect(mentionDir('@claude:bob')).toBeUndefined();
    expect(mentionDir('@../x')).toBeUndefined();
  });

  it('offers friends, projects, and the worktree’s files and folders (no hidden ones)', () => {
    expect(suggest('@b', ctx).map((s) => s.label)).toEqual(['@bob-api']);
    expect(suggest('@R', ctx).map((s) => s.label)).toEqual(['@README.md']);
    expect(suggest('@s', ctx).map((s) => [s.label, s.value])).toEqual([['@src/', '@src/']]);
    expect(suggest('see @src/', ctx).map((s) => [s.label, s.value])).toEqual([
      ['@src/auth.ts', 'see @src/auth.ts '],
      ['@src/routes/', 'see @src/routes/'],
    ]);
    expect(suggest('@.e', ctx)).toEqual([]);
  });
});
