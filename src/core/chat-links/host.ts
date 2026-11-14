import { randomUUID } from 'node:crypto';
import { explainChatMentions } from '../../agent/prompt.js';
import type { ChatTools } from '../../agent/types.js';
import { type AgentRef, type BodyInput, type BodyOf, CLAUDE_AGENT, type ChatOrigin } from '../../protocol.js';
import { type ChatRef, isAddressableChannel, parseChatRef } from '../../shared/chat-ref.js';
import { oneLine } from '../gateway/model.js';
import type { Store } from '../store.js';
import { peerSendAccess } from './access.js';
import { chatMessageAsker, chatMessagePrompt, withoutSkillMentions } from './message-prompt.js';
import { permissionRank } from './permission.js';
import { type SourceReaders, originSeenBy, originSeenByAll } from './private-title.js';
import { resolveChat } from './resolve.js';
import { ChatSendService, type ChatSendDeps, refusalText } from './service.js';
import { chatToolsOf } from './transcript.js';

/**
 * Chat links in the agent host (BLG-308): the one seam between core/agent-host.ts and the
 * chat-links feature. The host asks it what a request keeps, which chain a run is in, what a run
 * reads and gets, and what a card shows; the host's lanes stay the host's (deliver, cancelChain).
 */

/**
 * The chain of one run. It is an object of its own so that the run's tools read their own run's
 * chain, and a run left behind never reads the chain of the run after it.
 */
export interface RunChain {
  chainId: string;
  hop: number;
}

/** A message from another chat, as its card shows it. */
export interface FromChat {
  readonly origin: ChatOrigin;
  readonly text: string;
}

export interface HostChatLinksDeps {
  readonly store: Store;
  readonly selfId: () => string;
  readonly sharing: {
    recipients(channel: string): string[];
    canSee(from: string, channel: string): boolean;
    canPost(from: string, channel: string): boolean;
  };
  readonly agentRef?: (channel?: string) => AgentRef;
  readonly terminalDriving?: (channel: string) => boolean;
  /** Where a chat of yours runs, for how far its run can act (see permission.ts). */
  readonly placeOf: (channel: string) => { readonly askOnly?: unknown; readonly autoEdit?: boolean } | undefined;
  /** Load a chat's saved conversation. */
  readonly load: (channel: string) => void;
  /** How many messages from chats wait at this chat. */
  readonly queuedFromChats: (channel: string) => number;
  /** Put a message from another of your chats in its chat (the host's lanes). */
  readonly deliver: ChatSendDeps['deliver'];
  /** Send to one person. False: it did not go. */
  readonly send: (body: BodyInput, to: string) => boolean;
  readonly askChain: ChatSendDeps['askChain'];
  readonly cancelChain: ChatSendDeps['cancelChain'];
  /** Refuse a request: its card says why. */
  readonly deny: (requestId: string, from: string, text: string, channel: string) => void;
  /** Your trust in a person, as for any request of theirs. */
  readonly authorize: (from: string, body: BodyOf<'agent_request'>) => Promise<boolean>;
}

/** A run's chat tools after its chat became shared, or chat links went off (see readsChats). */
const NOT_ANY_MORE = 'chat_shared: this chat is shared with other people now, or chat links are off, so its agent cannot read or message other chats. Tell your user.';

/** A peer's chat title on your approval card: theirs to write, so one short line. */
const CARD_TITLE_CHARS = 60;

export class HostChatLinks {
  /** Messages agents send between chats (see service.ts). */
  readonly sends: ChatSendService;
  /** Messages from other chats whose card doesn't know yet where they came from (see cardOf). */
  private readonly cards = new Map<string, FromChat>();

  constructor(private readonly deps: HostChatLinksDeps) {
    this.sends = new ChatSendService({
      store: deps.store,
      selfId: deps.selfId,
      queuedFromChats: deps.queuedFromChats,
      deliver: deps.deliver,
      deliverTo: (owner, body) => deps.send(body, owner),
      permissionRank: (channel) => this.permissionRank(channel),
      agentIn: (channel) => this.agentIn(channel),
      terminalDriving: (channel) => deps.terminalDriving?.(channel) ?? false,
      load: deps.load,
      system: (channel, text, level) => deps.store.dispatch({ type: 'system', channel, level, text }),
      askChain: deps.askChain,
      cancelChain: deps.cancelChain,
    });
  }

  /**
   * A request as it arrives. A chain comes from this computer's own sends, or from a peer's chat
   * into one shared with them (admitPeer checks it). A chain without an origin is only yours: your
   * agent sent it on (see chainOf).
   */
  received(from: string, request: BodyOf<'agent_request'>): BodyOf<'agent_request'> {
    const { origin, chain, ...rest } = request;
    const keep = origin && (from === this.self || request.channel !== 'room');
    const keepChain = chain && from === this.self;
    return { ...rest, ...(keep ? { origin } : {}), ...(keepChain ? { chain } : {}) };
  }

  /**
   * A message from another chat sets the chain from its origin, and one your agent sent on (a plan's
   * message to a task) keeps its chain. A message from a person starts a new one.
   */
  chainOf(body: BodyOf<'agent_request'>): RunChain {
    if (body.origin) return { chainId: body.origin.chainId, hop: body.origin.hop };
    return body.chain ? { chainId: body.chain.chainId, hop: body.chain.hop } : { chainId: randomUUID(), hop: 0 };
  }

  /** A run's own address (the prompt teaches the chat chip with it). */
  linkOf(channel: string): { chatLink?: ChatRef } {
    return { chatLink: { owner: this.self, channel } };
  }

  /** Other chats for this run to find, read and message; undefined when it may not. `external`: an external agent asked for it (see agentOf). */
  toolsFor(run: { readonly from: string; readonly external: boolean; readonly channel: string; readonly chain: () => RunChain; readonly signal: AbortSignal }): ChatTools | undefined {
    if (!this.readsChats(run.from, run.external, run.channel)) return undefined;
    const chain = (): RunChain => ({ ...run.chain() });
    const tools = chatToolsOf({ state: () => this.deps.store.getState(), requester: run.from, chain, load: this.deps.load, messages: this.sends.forRun({ channel: run.channel, requester: run.from, chain, signal: run.signal }) });
    // The rule at the run's start holds at each call: a chat shared since then reads and sends nothing.
    const still = (): void => {
      if (!this.readsChats(run.from, run.external, run.channel)) throw new Error(NOT_ANY_MORE);
    };
    return {
      chain: tools.chain,
      send: async (ref, text, opts) => (still(), tools.send(ref, text, opts)),
      wait: async (id, timeoutSec) => (still(), tools.wait(id, timeoutSec)),
      list: (opts) => (still(), tools.list(opts)),
      read: (ref, opts) => (still(), tools.read(ref, opts)),
    };
  }

  /** The words a run reads for a message from another chat: Beluga's words first, its own in a fence (see message-prompt.ts). */
  said(body: BodyOf<'agent_request'>): string {
    return body.origin ? chatMessagePrompt(this.originShown(body.origin, body.channel), body.prompt) : body.prompt;
  }

  /** A chat the words name: a note on how to read it, only for a run that has the tools (BLG-143). */
  explained(from: string, external: boolean, channel: string, text: string): string {
    return this.readsChats(from, external, channel) ? explainChatMentions(text) : text;
  }

  /** What was added to a message from another chat names no skill either (a task's title, the carried chat). */
  finished(body: BodyOf<'agent_request'>, whole: string): string {
    return body.origin ? withoutSkillMentions(whole) : whole;
  }

  /** The name on the prompt's "Request from" line for a message from another chat; undefined for a person's. */
  askerOf(body: BodyOf<'agent_request'>): string | undefined {
    return body.origin ? chatMessageAsker(this.originShown(body.origin, body.channel)) : undefined;
  }

  /** Who asks on your approval card: a message from their chat says which chat sent it, in one line at most. */
  approvalAsker(body: BodyOf<'agent_request'>, name: string): string | undefined {
    return body.origin ? `${name}'s agent, from ${oneLine(body.origin.title, CARD_TITLE_CHARS) || 'a chat'},` : undefined;
  }

  /** A message from another of your chats, taken into its chat: its card is to say so (see cardOf). */
  noteCard(body: BodyOf<'agent_request'>): void {
    if (body.origin) this.cards.set(body.requestId, { origin: body.origin, text: body.prompt });
  }

  /** Its first event says it came from another chat: from then on, its card knows. Taken once. */
  cardOf(requestId: string): FromChat | undefined {
    const card = this.cards.get(requestId);
    this.cards.delete(requestId);
    return card;
  }

  /** The card as `to` sees it: a private chat's title only to those who can read that chat (BLG-305). */
  cardFor(card: FromChat, to: string): FromChat {
    return { ...card, origin: originSeenBy(card.origin, to, this.readers) };
  }

  /** A message from another chat that waited and will never run: its sender hears why. */
  lost(body: BodyOf<'agent_request'>, why: string): void {
    if (body.origin) this.sends.lost(body.requestId, why);
  }

  /**
   * A message from another person's chat into one of yours (BLG-151). Who they are in the chat
   * decides first (access.ts): a chat not shared with them is not_found at any trust. Then the
   * limits, counted here (a peer's hop is a claim). Then your trust in them, as for any request.
   * Each answer goes back to them as an event. Undefined: refused.
   */
  async admitPeer(from: string, body: BodyOf<'agent_request'>, origin: ChatOrigin): Promise<BodyOf<'agent_request'> | undefined> {
    const state = this.deps.store.getState();
    const sharing = this.deps.sharing;
    const target = parseChatRef(`${this.self}/${body.channel}`);
    const chat = target && resolveChat(state, target);
    const exists = chat?.ownership === 'own' && chat.state !== 'removed' && chat.state !== 'loading' && chat.view?.kind === 'workspace';
    const role = !exists ? undefined : sharing.canPost(from, body.channel) ? 'contribute' : sharing.canSee(from, body.channel) ? 'view' : undefined;
    const access = peerSendAccess({ channel: body.channel, exists, ...(role ? { role } : {}) });
    if (!access.allow) {
      const text = refusalText(access.code);
      // A chat they can't see gets no card: the answer goes to them alone, the same as for no chat.
      if (access.code === 'not_found') this.deps.send({ kind: 'agent_event', requestId: body.requestId, requester: from, event: 'denied', text, channel: body.channel, agent: this.agentIn('room') }, from);
      else this.deps.deny(body.requestId, from, text, body.channel);
      return undefined;
    }
    const deny = (text: string): undefined => void this.deps.deny(body.requestId, from, text, body.channel);
    if (parseChatRef(origin.ref)?.owner !== from) return deny(refusalText('source_not_addressable'));
    if (chat?.state === 'archived') return deny(refusalText('chat_archived'));
    // As for a plain request into a shared workspace: deny refuses everyone.
    if (state.policy === 'deny') return deny('Request declined by the machine owner.');
    // The limits are checked now and counted only once you said yes: a declined send uses none.
    const limit = this.sends.admitFromPeer(from, origin, body.channel, this.deps.queuedFromChats(body.channel), { count: false });
    if (!limit.allow) return deny(limit.text);
    // Your chat's plan mode holds, whatever the peer's request says.
    const admitted: BodyOf<'agent_request'> = { ...body, plan: state.planMode[body.channel] === true, origin: { ...origin, hop: limit.hop } };
    if (!(await this.deps.authorize(from, admitted))) return deny('Request declined by the machine owner.');
    const counted = this.sends.admitFromPeer(from, origin, body.channel, this.deps.queuedFromChats(body.channel));
    if (!counted.allow) return deny(counted.text);
    // The hop as counted: the chain may have moved on while you decided.
    const run: BodyOf<'agent_request'> = { ...admitted, origin: { ...origin, hop: counted.hop } };
    this.cards.set(body.requestId, { origin: run.origin!, text: body.prompt });
    return run;
  }

  private get self(): string {
    return this.deps.selfId();
  }

  private agentIn(channel: string): AgentRef {
    return this.deps.agentRef?.(channel) ?? CLAUDE_AGENT;
  }

  /** May this person's run find and read other chats? */
  private readsChats(from: string, external: boolean, channel: string): boolean {
    // Not in a place other people see (the room, friends' chats, a worktree you share): their words could ask it to quote your chats there.
    // Not an external agent's run: the tools reach every chat of yours, outside its grant.
    return from === this.self && !external && isAddressableChannel(channel) && this.deps.sharing.recipients(channel).length === 0;
  }

  /** How far a chat's run can act on its own, your launch flags included (permission.ts). */
  private permissionRank(channel: string): number {
    const state = this.deps.store.getState();
    return permissionRank({ planMode: state.planMode[channel] === true, place: this.deps.placeOf(channel), runtime: this.agentIn(channel).runtime, flags: { claude: state.prefs.claudeArgs, codex: state.prefs.codexArgs } });
  }

  /** Who reads which of your chats, for a private chat's title (private-title.ts). */
  private get readers(): SourceReaders {
    return { selfId: this.self, canSee: (peer, channel) => this.deps.sharing.canSee(peer, channel) };
  }

  /** The origin as the run reads it: in a chat you share, everyone there sees what the run says. */
  private originShown(origin: ChatOrigin, channel: string): ChatOrigin {
    return originSeenByAll(origin, this.deps.sharing.recipients(channel), this.readers);
  }
}
