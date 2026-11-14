/**
 * One chat's address: `<owner>/<channel>`. Channels repeat between computers (everyone has a
 * `mac:assistant`), so the owner says whose it is: the peer id of the computer that holds the chat
 * (from ~/.beluga/identity.json, the same after every restart). As a link it is
 * `beluga://chat/<owner>/<encoded channel>`. The room, friends' chats and drafts have no address.
 * Browser-safe and pure: the screens, the phone's views and the daemon all read it.
 */

export interface ChatRef {
  /** The peer id of the computer that holds the chat. */
  readonly owner: string;
  /** Its channel: `ws:<id>`, `mac:assistant[:<id>]` or `sentinel-chat:<id>`. */
  readonly channel: string;
}

export const CHAT_LINK_PREFIX = 'beluga://chat/';
const OWNER = /^[\w-]{8,64}$/;
// The kinds of src/protocol.ts's Channel that belong to one computer.
const ADDRESSABLE = /^(ws:[\w:.-]{1,80}|mac:assistant(:[a-z0-9]{1,24})?|sentinel-chat:[a-z0-9]{1,24})$/;

export const isAddressableChannel = (channel: string): boolean => ADDRESSABLE.test(channel);

/** The ref as text, or undefined when it can't be one (a bad owner, the room, a friends' chat, a draft). */
export function formatChatRef(ref: ChatRef): string | undefined {
  return isChatRef(ref) ? `${ref.owner}/${ref.channel}` : undefined;
}

export function parseChatRef(text: string): ChatRef | undefined {
  const slash = text.indexOf('/');
  if (slash < 0) return undefined;
  const ref = { owner: text.slice(0, slash), channel: text.slice(slash + 1) };
  return isChatRef(ref) ? ref : undefined;
}

/** The ref as a link, or undefined when it can't be one. */
export function chatLink(ref: ChatRef): string | undefined {
  return isChatRef(ref) ? `${CHAT_LINK_PREFIX}${ref.owner}/${encodeURIComponent(ref.channel)}` : undefined;
}

/** The ref a link names; undefined for any other link, or a malformed one. */
export function chatLinkOf(url: string): ChatRef | undefined {
  if (!url.startsWith(CHAT_LINK_PREFIX)) return undefined;
  const parts = url.slice(CHAT_LINK_PREFIX.length).split('/');
  if (parts.length !== 2) return undefined;
  try {
    const ref = { owner: parts[0]!, channel: decodeURIComponent(parts[1]!) };
    return isChatRef(ref) ? ref : undefined;
  } catch {
    return undefined;
  }
}

/** What a chat's chip shows and whether it opens, from what chats.resolve says of it now. Never a saved title. */
export function chatChipOf(chat: { readonly title?: string | undefined; readonly state: string; readonly ownership: string }): { readonly label: string; readonly opens: boolean } {
  if (chat.ownership === 'unknown') return { label: 'Private chat', opens: false };
  if (chat.state === 'removed') return { label: 'Chat removed', opens: false };
  if (chat.state === 'loading') return { label: 'Chat', opens: false };
  return { label: chat.title ?? 'Chat', opens: true };
}

/**
 * What opening a chat's link does, from what chats.resolve says of it (null: a bad ref, or chat
 * links off): open it, say why not, or nothing at all.
 */
export function chatLinkAnswer(chat: { readonly state: string; readonly ownership: string } | null | undefined): { readonly opens: boolean; readonly say?: string } {
  if (!chat) return { opens: false };
  if (chat.ownership === 'unknown') return { opens: false, say: 'This chat is on another computer.' };
  if (chat.state === 'removed') return { opens: false, say: 'This chat was removed.' };
  if (chat.state === 'loading') return { opens: false };
  return { opens: true };
}

/**
 * A chat named in a message's words: "@Title (chat: <ref>)", the same shape as "@BLG-24 (task: …)".
 * The title is what the words read as; a chip always shows the chat's title of now.
 */
const CHAT_MENTION = /(^|[\s({"'“])@([^\n@()]{1,100}?) \(chat: ([^\s()]+)\)/gu;
/** A chat's link standing on its own in text (as CHAT_MENTION's lead: not in a word, a URL or a Markdown link). */
const CHAT_LINK_IN_TEXT = /(?<![^\s({"'“])(?<!\]\()beluga:\/\/chat\/[\w-]+\/[^\s)\]}"'”>,;]+/g;
const CHAT_TITLE_LENGTH = 60;

export interface ChatMention {
  readonly start: number;
  readonly end: number;
  readonly raw: string;
  readonly title: string;
  /** The ref as text. */
  readonly ref: string;
}

/** The words for a chat, or undefined when it has no address. The title loses what would end the mention early. */
export function chatMention(title: string, ref: ChatRef): string | undefined {
  const text = formatChatRef(ref);
  if (!text) return undefined;
  const clean = title.replace(/[@()\s]+/g, ' ').trim().slice(0, CHAT_TITLE_LENGTH).trim();
  return `@${clean || 'Chat'} (chat: ${text})`;
}

/** A draft with chat words put in at `caret`, standing apart from what's around them. */
export function withChatWords(text: string, caret: number, words: string): { readonly text: string; readonly caret: number } {
  const before = text.slice(0, caret);
  const after = text.slice(caret);
  const upTo = `${before}${before && !/\s$/.test(before) ? ' ' : ''}${words}${/^\s/.test(after) ? '' : ' '}`;
  return { text: `${upTo}${after}`, caret: upTo.length };
}

/** Each chat the words name, in order. A ref that isn't a chat's stays words. */
export function chatMentionsIn(text: string): ChatMention[] {
  return [...text.matchAll(CHAT_MENTION)].flatMap((m) => {
    if (!parseChatRef(m[3]!)) return [];
    const start = m.index + m[1]!.length;
    const raw = m[0].slice(m[1]!.length);
    return [{ start, end: start + raw.length, raw, title: m[2]!, ref: m[3]! }];
  });
}

/**
 * Markdown with each chat it names as the chat's inline code (`chat:<ref>`), which the screens draw
 * as the chat's chip: a mention ("@Title (chat: <ref>)") and a bare ref ("<owner>/<channel>", also
 * with `chat:` in front) standing on its own. The punctuation after a bare ref stays words. Fenced
 * and inline code, links, URLs and anything that isn't a chat's ref are left as they are.
 */
export function codeChatRefs(markdown: string): string {
  if (!markdown.includes('/')) return markdown;
  let fenced = false;
  return markdown
    .split('\n')
    .map((line) => {
      const fence = /^\s*(```|~~~)/.test(line);
      if (fence) fenced = !fenced;
      return fence || fenced ? line : line.replace(REF_PIECE, codeOne);
    })
    .join('\n');
}

/** The words with each chat mention as its title only ("@Title"): where chat links are off, so no chip. */
export function chatMentionsAsTitles(text: string): string {
  let out = '';
  let last = 0;
  for (const c of chatMentionsIn(text)) {
    out += `${text.slice(last, c.start)}@${c.title}`;
    last = c.end;
  }
  return out + text.slice(last);
}

/** Pasted words with each chat link as a mention; undefined when no link is one. */
export function chatLinksToMentions(text: string, titleOf: (ref: ChatRef) => string): string | undefined {
  let changed = false;
  const words = text.replace(CHAT_LINK_IN_TEXT, (found) => {
    const link = found.replace(/[.!?:]+$/, '');
    const ref = chatLinkOf(link);
    const mention = ref && chatMention(titleOf(ref), ref);
    if (!mention) return found;
    changed = true;
    return `${mention}${found.slice(link.length)}`;
  });
  if (!changed) return undefined;
  return words.endsWith(')') ? `${words} ` : words;
}

const isChatRef = (ref: ChatRef): boolean => OWNER.test(ref.owner) && isAddressableChannel(ref.channel);

/**
 * In one line: inline code, a link or a URL (each left as it is), a mention (lead, title, ref), or a
 * bare ref (lead, ref). A bare ref takes all it can, so a longer path is never cut down to one.
 */
const REF_PIECE = new RegExp(
  [
    String.raw`(\`+)[^\`]*?\1`,
    String.raw`!?\[[^\]]*\]\([^)]*\)`,
    String.raw`<[^>\s]+>`,
    String.raw`[a-z][\w+.-]*:\/\/\S+`,
    String.raw`(^|[\s({"'“])@([^\n@()]{1,100}?) \(chat: ([^\s()]+)\)`,
    String.raw`(^|[\s({"'“])(?:chat:)?([\w-]{8,64}\/[\w:.-]+)(?![\w:.\/-])`,
  ].join('|'),
  'g',
);

function codeOne(whole: string, _ticks: string | undefined, mentionLead: string | undefined, _title: string | undefined, mentioned: string | undefined, bareLead: string | undefined, bare: string | undefined): string {
  if (mentioned !== undefined) return parseChatRef(mentioned) ? `${mentionLead}\`chat:${mentioned}\`` : whole;
  if (bare === undefined) return whole;
  const ref = bare.replace(/[.:-]+$/, '');
  return parseChatRef(ref) ? `${bareLead}\`chat:${ref}\`${bare.slice(ref.length)}` : whole;
}
