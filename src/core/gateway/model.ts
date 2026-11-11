import type { AgentRef, ProviderUsage } from '../../protocol.js';
import { type Capabilities, DEFAULT_CAPABILITIES, type Rule } from './access.js';
import type { DialogueEnvelope, Expects, LiveState, Need, ResultStatus, TaskKind, TaskQuestionItem } from './protocol.js';

/**
 * Tasks between Claudes in the shared state (the Mac app draws them): what you sent and what
 * reached you, where each one is, and its result. No file bytes and nothing secret: files are
 * paths on this Mac. Browser-safe: the Mac app runs it.
 */

/**
 * Where a task is. `confirm`: your Claude wants to ask someone you don't trust yet, and waits
 * for you (Ask / Not now). `sent`: it left (or waits in your outbox). Then the other side's
 * states, then a result.
 */
export type TaskState = 'confirm' | 'sent' | LiveState | ResultStatus;

export const FINAL_STATES: readonly TaskState[] = ['done', 'declined', 'failed', 'cancelled'];
export const isFinal = (state: TaskState): state is ResultStatus => FINAL_STATES.includes(state);

export interface TaskFile {
  readonly name: string;
  readonly size: number;
  /** Where it was saved on this Mac (missing: it was too big to come with the result, or didn't arrive). */
  readonly path?: string;
  /** A picture (a screenshot): screens show it. */
  readonly image?: boolean;
  /** Received (yours to send): offered to be fetched in pieces under this id (kept so the result can be sent again). */
  readonly ref?: string;
  readonly sha256?: string;
}

/** A question the friend's Claude asked while working on your task (waiting for an answer). */
export interface TaskQuestionView {
  readonly qid: string;
  readonly questions: readonly TaskQuestionItem[];
  readonly askedAt: number;
}

export interface TaskOutcome {
  readonly status: ResultStatus;
  readonly summary: string;
  readonly data?: unknown;
  readonly files: readonly TaskFile[];
  readonly log: readonly string[];
  /** The data matches what was asked for (`expects`); problems say how it doesn't. */
  readonly valid?: boolean;
  readonly problems?: readonly string[];
  /** The file is a secret its owner approved sending, that one time ("private SSH key id_ed25519"). */
  readonly secret?: string;
  /** An ask: the agent that answered on their Mac (their pick, never the asker's; BLG-448). */
  readonly agent?: AgentRef;
}

/** What kind of secret a file is (core/shares.ts secretKindOf decides). */
export type SecretKind = 'ssh-key' | 'dotenv' | 'cloud' | 'token' | 'secret';

/** A secret, in the words its approval says: "your private SSH key id_ed25519". */
export function secretLabel(kind: SecretKind, name: string): string {
  switch (kind) {
    case 'ssh-key':
      return /^id_(rsa|ed25519|ecdsa|dsa)$/i.test(name) ? `your private SSH key ${name}` : `${name} from your SSH folder`;
    case 'dotenv':
      return `your .env file ${name}`;
    case 'cloud':
      return `your cloud credentials ${name}`;
    case 'token':
      return `your token file ${name}`;
    default:
      return /\.(pem|key|p12|pfx|keystore|jks)$/i.test(name) ? `your private key ${name}` : `your secret file ${name}`;
  }
}

/** The label as the requester says it ("private SSH key id_ed25519"): without "your". */
export const secretNoun = (label: string): string => label.replace(/^your /, '');

export interface TaskView {
  readonly id: string;
  /** sent: from you (or your Claude) to them. received: from them to you. */
  readonly direction: 'sent' | 'received';
  /** The other person. */
  readonly peerId: string;
  readonly peerName: string;
  readonly kind: TaskKind;
  readonly ask: string;
  /** The few words the requester's Claude chose for notifications (the full ask is `ask`). */
  readonly summary?: string;
  readonly needs: readonly Need[];
  readonly project?: string;
  readonly expects?: Expects;
  readonly deadline?: number;
  readonly command?: string;
  readonly cwd?: string;
  readonly timeoutSec?: number;
  /** file: the file asked for. */
  readonly path?: string;
  readonly by: 'agent' | 'person';
  /** An external agent asked through the sender's Beluga: its name, and (sent) its id. */
  readonly via?: string;
  readonly viaId?: string;
  /** Sent: the conversation your Claude asked from (its answer continues there). */
  readonly conversation?: string;
  /** The chat both people see its card in (BLG-208): your DM with them (`dm:<peerId>`), or the channel it was asked from. */
  readonly chat?: string;
  /** Sent: the friend's Claude's chat answer it came from (its message id): its card stays under that answer (BLG-353). */
  readonly answer?: string;
  /** A turn of a chaired dialogue (BLG-468): the chair waits for it, and nothing resumes a conversation with it. */
  readonly dialogue?: DialogueEnvelope;
  /** Sent: which of their agents it asks for (BLG-503); their Mac says so when another one does it. */
  readonly onAgent?: AgentRef;
  readonly state: TaskState;
  /** The latest steps (short lines). */
  readonly steps: readonly string[];
  readonly result?: TaskOutcome;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  /** Sent: the result was given to your Claude (it waited for it, or a new turn started with it). */
  readonly delivered?: boolean;
  /** Received: where it ran here ("landing", "a scratch folder"). */
  readonly where?: string;
  /** Sent: their Claude asks something and waits (your Claude answers first, else you). */
  readonly question?: TaskQuestionView;
  /** Sent: big files of the result still coming (bytes so far of the total). */
  readonly incoming?: { readonly received: number; readonly total: number };
  /** Received (a command or a file): the folder it would run or read in, resolved. */
  readonly folder?: string;
  /** Received: how it was let in ("you trust them", "your rule", "you approved it"). */
  readonly allowedBy?: string;
  /** A file request for a secret: you're asked each time (Allow once / Decline; trust, rules and Always never cover it). */
  readonly secret?: { readonly kind: SecretKind; readonly label: string };
  /** Sent: you saw it before it left (you asked yourself, or said Ask on "Ask Alice's Claude?"). */
  readonly confirmed?: boolean;
  /** Sent: the questions their Claude asked so far (by id: each is taken once, a few at most). */
  readonly asked?: readonly string[];
  /** Sent: your Claude's answer to their question, waiting for you to send it (you hadn't seen the task). */
  readonly answerDraft?: { readonly qid: string; readonly answers: readonly string[] };
}

/** What someone's Beluga offers you (their card), as they told you. */
export interface PeerCard {
  readonly note?: string;
  /** How much they trust you. */
  readonly trust: 'blocked' | 'ask' | 'trusted' | 'full';
  readonly offers: readonly Need[];
  readonly projects: readonly string[];
  readonly claude: boolean;
  /** Their plan usage, per provider, when they share it with you (BLG-597). */
  readonly usages?: readonly ProviderUsage[];
  readonly at: number;
}

export interface GatewayState {
  readonly enabled: boolean;
  /** Newest last, at most KEEP_TASKS. */
  readonly tasks: readonly TaskView[];
  /** By peer id. */
  readonly cards: Readonly<Record<string, PeerCard>>;
  /** Your own "Ask me for…" note. */
  readonly note: string;
  /** Your rules for people's requests (see access.ts). */
  readonly rules: readonly Rule[];
  /** What friends' Claudes may do here, by trust level. */
  readonly capabilities: Capabilities;
  /** Friends your Claude asks without the "Ask X's Claude?" card (you said Always), by peer id. */
  readonly askFreely?: readonly string[];
}

export interface GatewaySlice {
  readonly gateway: GatewayState;
}

export const KEEP_TASKS = 200;

export const NO_GATEWAY: GatewayState = { enabled: false, tasks: [], cards: {}, note: '', rules: [], capabilities: DEFAULT_CAPABILITIES };
export const initialGateway: GatewaySlice = { gateway: NO_GATEWAY };

export type GatewayAction =
  /** Everything at once (on start). */
  | { type: 'gw_init'; state: GatewayState }
  /** One task changed (same id: replaced). */
  | { type: 'gw_task'; task: TaskView }
  /** One task forgotten (Remove). */
  | { type: 'gw_forget'; id: string }
  | { type: 'gw_card'; peerId: string; card: PeerCard }
  | { type: 'gw_note'; note: string }
  | { type: 'gw_rules'; rules: readonly Rule[] }
  | { type: 'gw_caps'; capabilities: Capabilities }
  | { type: 'gw_freely'; peers: readonly string[] }
  | { type: 'gw_off' };

function withTask(list: readonly TaskView[], task: TaskView): readonly TaskView[] {
  const at = list.findIndex((t) => t.id === task.id);
  if (at >= 0) return list.map((t, i) => (i === at ? task : t));
  return [...list, task].slice(-KEEP_TASKS);
}

export function reduceGateway(state: GatewaySlice, action: GatewayAction): GatewaySlice {
  switch (action.type) {
    case 'gw_init':
      return { gateway: action.state };
    case 'gw_task':
      return { gateway: { ...state.gateway, tasks: withTask(state.gateway.tasks, action.task) } };
    case 'gw_forget':
      return { gateway: { ...state.gateway, tasks: state.gateway.tasks.filter((t) => t.id !== action.id) } };
    case 'gw_card':
      return { gateway: { ...state.gateway, cards: { ...state.gateway.cards, [action.peerId]: action.card } } };
    case 'gw_note':
      return { gateway: { ...state.gateway, note: action.note } };
    case 'gw_rules':
      return { gateway: { ...state.gateway, rules: action.rules } };
    case 'gw_caps':
      return { gateway: { ...state.gateway, capabilities: action.capabilities } };
    case 'gw_freely':
      return { gateway: { ...state.gateway, askFreely: action.peers } };
    case 'gw_off':
      return { gateway: NO_GATEWAY };
    default:
      return state;
  }
}

// ---- for screens

/** One line of an ask, for titles ("Kayra's Claude wants to: …"). */
export const oneLine = (text: string, max = 120): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** The approval card's title for a request that reached you (screens find the card by it). */
export const approvalTitle = (t: Pick<TaskView, 'peerName' | 'by' | 'ask'> & Partial<Pick<TaskView, 'kind' | 'command' | 'path' | 'summary' | 'secret' | 'via'>>): string => {
  const who = `${t.peerName}${t.by === 'agent' ? "'s agent" : ''}${t.via ? ` (via ${oneLine(t.via)})` : ''}`;
  if (t.kind === 'file' && t.secret) return `${who} wants ${t.secret.label}`;
  if (t.kind === 'run' && t.command) return `${who} wants to run on your Mac: ${oneLine(t.command)}`;
  if (t.kind === 'file' && t.path) return `${who} wants a file from your Mac: ${oneLine(t.path)}`;
  return `${who} wants to: ${requestGist(t)}`;
};

/** The few words a request is shown by: the summary its sender chose, else the start of the ask. */
export const requestGist = (t: Pick<TaskView, 'ask'> & Partial<Pick<TaskView, 'summary'>>, max = 120): string => oneLine(t.summary?.trim() || t.ask, max);

/** Tasks shown in a conversation (sent from it), oldest first. */
export const tasksIn = (state: GatewaySlice, channel: string): readonly TaskView[] => state.gateway.tasks.filter((t) => t.direction === 'sent' && t.conversation === channel);

/** "bob's Claude", or "bob's Mac" for a command or a file. */
export const targetLabel = (t: Pick<TaskView, 'peerName' | 'kind'>): string => (t.kind === 'ask' ? `${t.peerName}’s agent` : `${t.peerName}’s Mac`);

/** A received request waiting for your answer. */
export const awaitingYou = (t: Pick<TaskView, 'direction' | 'state'>): boolean => t.direction === 'received' && t.state === 'awaiting_approval';

/** Your rules for one person, newest first. */
export const rulesFor = (state: GatewaySlice, peerId: string): readonly Rule[] => state.gateway.rules.filter((r) => r.peerId === peerId).slice().reverse();

/** Plain words for where a task is, from the point of view of the one looking. */
export function stateLabel(t: TaskView): string {
  const them = t.peerName;
  if (t.direction === 'received') {
    switch (t.state) {
      case 'queued':
        return 'Queued';
      case 'awaiting_approval':
        return 'Waiting for you to approve';
      case 'working':
        return t.kind === 'run' ? 'Running' : t.kind === 'file' ? 'Sending the file' : 'Your agent is working';
      case 'done':
        return 'Done';
      case 'declined':
        return 'Declined';
      case 'failed':
        return 'Failed';
      case 'cancelled':
        return `${them} cancelled it`;
      default:
        return 'Received';
    }
  }
  switch (t.state) {
    case 'confirm':
      return 'Waiting for you';
    case 'sent':
      return `Sent · waiting for ${them}`;
    case 'queued':
      return `In ${them}’s queue`;
    case 'awaiting_approval':
      return `Waiting for ${them} to approve`;
    case 'working':
      if (t.question) return `${them}’s agent has a question`;
      if (t.incoming) return `Receiving files from ${them}`;
      return t.kind === 'run' ? `Running on ${them}’s Mac` : t.kind === 'file' ? `Getting the file from ${them}’s Mac` : `${them}’s agent is working`;
    case 'done':
      return 'Done';
    case 'declined':
      return `${them} declined`;
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
  }
}

/** A tone for the state (screens color the dot and label by it). */
export function stateTone(t: TaskView): 'claude' | 'ok' | 'warn' | 'error' | 'muted' {
  switch (t.state) {
    case 'done':
      return t.result?.valid === false ? 'warn' : 'ok';
    case 'declined':
    case 'confirm':
    case 'awaiting_approval':
      return 'warn';
    case 'working':
      return t.question ? 'warn' : 'claude';
    case 'failed':
      return 'error';
    case 'cancelled':
      return 'muted';
    default:
      return 'claude';
  }
}
