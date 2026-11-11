import { type AgentRef, CLAUDE_AGENT, defaultAgentOf, type MessageVia } from '../../protocol.js';
import { usagesOf } from '../../agent/usage.js';
import { randomBytes } from 'node:crypto';
import type { AgentBackend } from '../../agent/types.js';
import { type NoticeEvent, presenceQuiet } from '../notify.js';
import { type Action, type Store, peerName } from '../store.js';
import { type TrustLevel, defaultTrust, isExternalRequester, trustOf } from '../trust.js';
import { type Capabilities, Decision, type DecisionInput, type Rule, offersFor, sharesUsageWith } from './access.js';
import { type Outgoing, TaskBook } from './book.js';
import type { SystemPort } from './device.js';
import { type GatewayState, type PeerCard, type TaskFile, type TaskView, isFinal } from './model.js';
import { type DialogueEnvelope, type Expects, type GatewayMsg, MAX_QUESTIONS, MAX_REQUEST_SUMMARY, type Need, type PeerCardMsg, type TaskKind, type TaskQuestion, type TaskResult, type TaskUpdate } from './protocol.js';
import { describeForClaude, oneLine, questionPrompt, resumePrompt } from './result.js';
import { RuleBook, type RuleInput } from './rule-book.js';
import { validate } from './schema.js';
import { type ApproveOpts, type Pending, type ServeContext, type ServeShell, TaskServer, defaultScratch } from './serve.js';
import { isSecretPath } from '../shares.js';
import { FileFetcher, mergeFiles, wantedFiles } from './transfer.js';
import { Courier, type MeshPort, type RoomPort, type Via } from './transport.js';
import { type Feature, cannotTake, featureForTask, shortVersion } from '../../net/mesh/features.js';

/**
 * The gateway: tasks between Claudes. Your Claude (or you) asks a friend's Claude to do
 * something, or runs one command on their Mac; their Beluga decides by their trust in you,
 * their Claude does the work and the result comes back to you only. If your Claude's turn
 * ended before the result arrived, a new turn starts in the same conversation with it, so the
 * work carries on (and can go on to ask the next person).
 *
 * Works over the Beluga network (friends, mesh links, store-and-forward) and over today's rooms
 * (people in the same room). Tasks are kept in ~/.beluga/tasks/ on both sides.
 */

export interface GatewayDeps {
  readonly store: Store;
  readonly selfId: () => string;
  readonly selfName: () => string;
  /** ~/.beluga/tasks (null: memory only). */
  readonly dir: string | null;
  /** Where scratch folders go when `dir` is null. */
  readonly scratch?: string;
  readonly agent: () => AgentBackend | undefined;
  /** Whether this Mac runs that agent now (a friend asked for one your card lists, BLG-503). Unset: only your default. */
  readonly runs?: (agent: AgentRef) => boolean;
  /** Ask you (today's approval cards, linked to the task they're about), with a way to take the question back. */
  readonly approve: (kind: 'request' | 'tool', title: string, detail: string, peer: string, task?: string, opts?: ApproveOpts) => Pending;
  /** ~/.beluga/rules.json (null or missing: rules stay in memory). */
  readonly rulesFile?: string | null;
  /** Your capability settings (what friends' Claudes may do here), and saving them. */
  readonly loadCaps?: () => unknown;
  readonly saveCaps?: (caps: Capabilities) => void;
  /** The screen and device info (tests pass a pretend one). */
  readonly system?: SystemPort;
  readonly questionWaitMs?: number;
  /** How long a friend's task may run here in all (default 20 minutes; tests make it short). */
  readonly runLimitMs?: number;
  /** Where a friend's command runs when it names no folder (PeerRun's default). */
  readonly runFolder?: (from: string) => Promise<string | undefined>;
  /** How long a piece of a big file may take to come (tests make it short). */
  readonly chunkTimeoutMs?: number;
  /** Commands friends' tasks run here (PeerRun's gates: full trust runs, others ask, secrets never). */
  readonly serveShell?: ServeShell;
  /** Start a new turn of your Claude in a conversation, with this prompt (resume). */
  readonly resume: (channel: string, prompt: string, via?: { readonly id: string; readonly name: string }) => void;
  readonly projectRoot: (name: string) => string | undefined;
  /** A project's task board for a friend's request there (BLG-701). */
  readonly board?: ServeContext['board'];
  /** Your projects friends may name. */
  readonly projects: () => readonly string[];
  /** Your "Ask me for…" note, and saving it. */
  readonly loadNote: () => string;
  readonly saveNote: (note: string) => void;
  /** Friends your Claude may ask without checking with you (Always), and saving them. */
  readonly loadAskFreely?: () => readonly string[];
  readonly saveAskFreely?: (peers: readonly string[]) => void;
  readonly notify?: (e: NoticeEvent) => void;
  readonly room?: () => RoomPort | undefined;
  /** How long a "Ask Alice's Claude?" card waits for you (default 10 minutes). */
  readonly confirmTimeoutMs?: number;
  readonly now?: () => number;
}

/** What your Claude (or you) asks for. */
export interface AskInput {
  /** A name (friend or someone in the room) or a peer id. */
  readonly person: string;
  readonly ask: string;
  /** A few words for their notification; the full ask is behind See more. */
  readonly summary?: string;
  readonly kind?: TaskKind;
  /** file: the file on their Mac. */
  readonly path?: string;
  readonly needs?: readonly Need[];
  readonly project?: string;
  readonly expects?: Expects;
  readonly deadlineSec?: number;
  readonly command?: string;
  readonly cwd?: string;
  readonly timeoutSec?: number;
  readonly by: 'agent' | 'person';
  /** An external agent asked, itself or through a run. */
  readonly via?: MessageVia;
  /** That agent's level is full: your "ask them freely" answers hold for it too. */
  readonly viaFull?: boolean;
  /** The conversation your Claude asks from (its answer continues there). */
  readonly conversation?: string;
  /** The friend's Claude's chat answer this request comes from (its message id). */
  readonly answer?: string;
  /** A turn of a chaired dialogue (core/dialogues): only the chair sets it, never an agent's tools. */
  readonly dialogue?: DialogueEnvelope;
  /** ask: which of their agents (their card lists it), BLG-503. Unset: their default. */
  readonly agent?: AgentRef;
}

/** What the gateway tells core/dialogues (see GatewayDeps.dialogues). */
export interface GatewayDialogues {
  /** A friend's dialogue turn arrived (received task with its envelope), or ended here (its result is on it). */
  turn(task: TaskView): void;
  /** The other side stopped a dialogue. */
  stopped(from: string, fromName: string, dialogue: string, why: string): void;
  /** Stopped on this side: its next turns are declined. */
  isStopped(dialogue: string): boolean;
}

/** Someone your Claude could ask, as who_can shows them. */
export interface Candidate {
  readonly name: string;
  readonly peerId: string;
  readonly via: 'friend' | 'room' | 'friend+room';
  readonly online: boolean;
  readonly status?: string;
  /** Your trust in them. */
  readonly your_trust: TrustLevel;
  /** Their trust in you, as they told you (unknown until their Beluga says). */
  readonly their_trust?: TrustLevel;
  /** You'll be asked before your Claude contacts them. */
  readonly asks_you_first: boolean;
  readonly claude: boolean;
  readonly offers: readonly Need[];
  readonly projects: readonly string[];
  readonly ask_me_for?: string;
  /** Offers what you asked about (when you named a need). */
  readonly fits?: boolean;
  /** Their Beluga's version, as it said (unknown for Macs from before that). */
  readonly beluga?: string;
  /** Your Macs can't link until someone updates Beluga: who. */
  readonly needs_update?: 'them' | 'you';
}

/** A gateway mesh: the port, and a way to hear its frames and new links (see launch.ts). */
export interface MeshNode extends MeshPort {
  listen(handlers: { readonly frame: (from: string, payload: unknown) => void; readonly link: (peerId: string) => void; readonly leaving?: () => Promise<unknown> }): () => void;
}

const TICK_MS = 10_000;
/** A request you sent that reached their Mac and then heard nothing for this long: it failed. */
const SILENT_MS = 24 * 3600_000;
/** Just back (this Mac woke or started, or they came online): what waited for you gets this long to arrive first. */
const BACK_GRACE_MS = 10 * 60_000;
/** Ticks this far apart: the Mac slept in between. */
const SLEPT_MS = 6 * TICK_MS;
const DEFAULT_CONFIRM_MS = 10 * 60_000;
const MAX_STEPS = 12;
/** Requests one conversation's Claude may send the same person in a while (BLG-427: no asking on and on). */
const MAX_AGENT_ASKS = 3;
const AGENT_ASKS_WINDOW_MS = 10 * 60_000;

const taskId = (): string => `t_${randomBytes(9).toString('base64url')}`;
const isAgentFinal = (status: string): boolean => status === 'done' || status === 'error' || status === 'denied';

export class Gateway {
  private dialogues: GatewayDialogues | undefined;
  readonly book: TaskBook;
  readonly rules: RuleBook;
  private readonly courier: Courier;
  private readonly server: TaskServer;
  private readonly fetcher: FileFetcher;
  /** Tasks whose open question waits for your Claude's current run there to end. */
  private readonly toAsk = new Set<string>();
  /** Questions already handed to your Claude (so the same one doesn't start two turns). */
  private readonly toldQuestion = new Map<string, string>();
  private mesh: MeshNode | undefined;
  private readonly meshOff: Array<() => void> = [];
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly confirmTimers = new Map<string, NodeJS.Timeout>();
  /** Finished tasks whose result waits for your Claude's current run there to end. */
  private readonly toResume = new Set<string>();
  /** Results a wait_for picked up (it hands them to your Claude, so no new turn starts for them). */
  private readonly claimed = new Set<string>();
  private readonly told = new Map<string, string>();
  /** When each person was last heard from or linked (the silence check waits a little after). */
  private readonly seenAt = new Map<string, number>();
  /** Requests that ended on this Mac without their answer (expired, or silence): your Claude hears so. */
  private readonly endedHere = new Set<string>();
  /** When this Mac last started or woke up (on the gateway's clock), and the last tick (real time). */
  private wokeAt: number;
  private lastTickAt = Date.now();
  private readonly ticker: NodeJS.Timeout;
  private readonly offStore: Array<() => void> = [];
  private cardsQueued = false;
  private stopped = false;
  /** Past the start (tasks marked as ended then were already over: nobody is told again). */
  private ready = false;

  constructor(private readonly deps: GatewayDeps) {
    this.book = new TaskBook(deps.dir);
    this.rules = new RuleBook({
      file: deps.rulesFile ?? null,
      loadCaps: deps.loadCaps ?? (() => undefined),
      saveCaps: deps.saveCaps ?? (() => undefined),
      onChange: (rules, capabilities) => {
        deps.store.dispatch({ type: 'gw_rules', rules });
        deps.store.dispatch({ type: 'gw_caps', capabilities });
        // What you offer people may have changed: tell them.
        this.told.clear();
        this.queueCards();
      },
      now: () => this.now(),
      onProblem: (title, body) => deps.notify?.({ kind: 'problems', title, body }),
    });
    this.wokeAt = this.now();
    this.courier = new Courier(this.book, { mesh: () => this.mesh, room: () => deps.room?.() }, (o) => this.onDelivered(o));
    this.server = new TaskServer({
      book: this.book,
      courier: this.courier,
      isMe: (id) => id === deps.selfId() || id === this.mesh?.peerId,
      selfName: deps.selfName,
      trustFor: (id) => this.trustFor(id),
      nameOf: (id) => this.nameOf(id),
      put: (t) => this.put(t),
      agent: deps.agent,
      approve: deps.approve,
      access: { decide: (facts, trust) => this.rules.decide(facts, trust), remember: (facts, name, d) => this.rules.remember(facts, name, d), capabilities: () => this.rules.capabilities() },
      ...(deps.serveShell ? { serveShell: deps.serveShell } : {}),
      projectRoot: deps.projectRoot,
      ...(deps.board ? { board: deps.board } : {}),
      // The label is the agent that runs it (BLG-503): Settings' model is Claude's, never another agent's.
      agentRef: () => {
        const st = deps.store.getState();
        const ref = defaultAgentOf(st.self);
        return st.prefs.model && !ref.model && ref.runtime === CLAUDE_AGENT.runtime ? { ...ref, model: st.prefs.model } : ref;
      },
      agents: () => deps.store.getState().self?.agents ?? [],
      ...(deps.runs ? { runs: deps.runs } : {}),
      model: () => {
        const prefs = deps.store.getState().prefs;
        return { ...(prefs.model ? { model: prefs.model } : {}), ...(prefs.effort ? { effort: prefs.effort } : {}) };
      },
      // Requests that run without asking still say so (silently on Do Not Disturb or while you appear offline).
      notify: (title, body) => deps.notify?.({ kind: 'people', tag: 'task', title, body, ...(presenceQuiet(deps.store.getState()) ? { quiet: true } : {}) }),
      scratch: deps.scratch ?? defaultScratch(),
      now: () => this.now(),
      ...(deps.system ? { system: deps.system } : {}),
      ...(deps.questionWaitMs ? { questionWaitMs: deps.questionWaitMs } : {}),
      ...(deps.runLimitMs ? { runLimitMs: deps.runLimitMs } : {}),
      ...(deps.runFolder ? { runFolder: deps.runFolder } : {}),
      dialogues: { turn: (t) => this.dialogues?.turn(t), stopped: (...a) => this.dialogues?.stopped(...a), isStopped: (id) => this.dialogues?.isStopped(id) ?? false },
      chatOf: (from, chat) => {
        const mesh = this.mesh;
        if (!mesh?.isFriend(from)) return undefined;
        return chat && mesh.shares?.(chat, from) ? chat : `dm:${from}`;
      },
    });
    this.fetcher = new FileFetcher({
      send: (to, msg) => this.courier.send(to, msg, false),
      target: async (taskId, name) => this.book.claimPath(taskId, name, deps.scratch ?? defaultScratch()),
      now: () => this.now(),
      ...(deps.chunkTimeoutMs ? { chunkTimeoutMs: deps.chunkTimeoutMs } : {}),
    });
    // Tasks that were waiting on the other side when Beluga quit are still there: keep waiting.
    // Received ones that were running here stopped with it.
    for (const t of this.book.all()) {
      // And the friend who asked hears it, or their copy would wait on "working" for good.
      if (t.direction === 'received' && !isFinal(t.state)) this.server.sendResult(this.put({ ...t, state: 'failed', result: { status: 'failed', summary: 'Beluga quit before it finished', files: [], log: t.steps }, endedAt: this.now(), updatedAt: this.now() }), { status: 'failed', summary: 'Beluga quit before it finished', files: [], log: t.steps });
      if (t.direction === 'sent' && t.state === 'confirm') this.put({ ...t, state: 'cancelled', result: { status: 'cancelled', summary: 'Not sent (Beluga quit before you answered)', files: [], log: [] }, endedAt: this.now(), updatedAt: this.now() });
    }
    deps.store.dispatch({ type: 'gw_init', state: this.view() });
    // Results whose big files were still coming when Beluga quit: carry on fetching them.
    for (const [id, result] of Object.entries(this.book.pending())) {
      const task = this.book.get(id);
      if (task && !isFinal(task.state)) setImmediate(() => void this.receiveFiles(task, result));
      else this.book.setPending(id, undefined);
    }
    this.offStore.push(deps.store.onAction((a) => this.onAction(a)));
    this.offStore.push(deps.store.subscribe(() => this.queueCards()));
    this.ticker = setInterval(() => this.tick(), TICK_MS);
    this.ticker.unref();
    this.ready = true;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.ticker);
    for (const t of this.confirmTimers.values()) clearTimeout(t);
    for (const off of this.offStore) off();
    this.detachMesh();
    this.server.stop();
    this.fetcher.stop();
    for (const ws of this.waiters.values()) for (const w of ws) w();
    this.deps.store.dispatch({ type: 'gw_off' });
  }

  // ------------------------------------------------------------------ transports

  /** The Beluga network came up: tasks go over friends' links too. */
  attachMesh(mesh: MeshNode): void {
    this.detachMesh();
    this.mesh = mesh;
    const off = mesh.listen({
      frame: (from, payload) => this.onFrame(from, 'mesh', payload),
      leaving: () => this.courier.mailAll(),
      link: (peerId) => {
        this.seenAt.set(peerId, this.now());
        this.courier.flush(peerId, true);
        this.told.delete(peerId);
        this.queueCards();
      },
    });
    this.meshOff.push(off);
    this.courier.flush(undefined, true);
    this.queueCards();
  }

  /** People came into (or left) the room: send what waits for them. */
  roomChanged(): void {
    this.courier.flush();
    this.queueCards();
  }

  detachMesh(): void {
    for (const off of this.meshOff.splice(0)) off();
    this.mesh = undefined;
  }

  /** A frame from someone in the room. */
  onRoomFrame(from: string, frame: unknown): void {
    this.onFrame(from, 'room', frame);
  }

  private onFrame(from: string, via: Via, raw: unknown): void {
    if (this.stopped || from === this.deps.selfId() || from === this.mesh?.peerId) return;
    // Over the network only friends get through; in a room, anyone in it (guests never reach here).
    if (via === 'mesh' && !this.mesh?.isFriend(from)) return;
    this.seenAt.set(from, this.now());
    const msg = this.courier.receive(from, via, raw);
    if (msg) this.onMessage(from, msg);
  }

  private onMessage(from: string, msg: GatewayMsg): void {
    switch (msg.t) {
      case 'task_request':
        void this.server.onRequest(from, msg);
        return;
      case 'task_cancel':
        if (msg.dialogue) this.onDialogueStop(from, msg.id, msg.dialogue);
        this.server.onCancel(from, msg);
        return;
      case 'task_update':
        this.onUpdate(from, msg);
        return;
      case 'task_result':
        this.onResult(from, msg);
        return;
      case 'card':
        this.onCard(from, msg);
        return;
      case 'task_question':
        this.onQuestion(from, msg);
        return;
      case 'task_answer':
        this.server.onAnswer(from, msg);
        return;
      case 'file_get':
        void this.server.onFileGet(from, msg);
        return;
      case 'file_chunk':
        this.fetcher.onChunk(from, msg);
        return;
    }
  }

  // ------------------------------------------------------------------ asking

  /** Ask someone's Claude (or run a command on their Mac). Returns the task at once. */
  /** Which external agent sent a task. */
  sentBy(id: string): string | undefined {
    const task = this.book.get(id);
    return task?.direction === 'sent' ? task.viaId : undefined;
  }

  /** A file task that came back with a secret its owner approved: for you, not for an agent. */
  holdsSecret(id: string): boolean {
    return Boolean(this.book.get(id)?.result?.secret);
  }

  ask(input: AskInput): TaskView {
    const peer = this.resolve(input.person);
    const kind = input.kind ?? 'ask';
    if (kind === 'run' && !input.command) throw new Error('Say which command to run');
    if (kind === 'file' && !input.path?.trim()) throw new Error('Say which file (its full path on their Mac)');
    const ask = (input.ask || input.command || (input.path ? `Send me ${input.path}` : '')).trim();
    if (!ask) throw new Error('Say what to ask');
    if (input.expects && input.expects !== 'files' && validateSchema(input.expects)) throw new Error(`The expects schema isn't usable: ${validateSchema(input.expects)}`);
    // Their Mac said what it takes: one that can't take this hears so now, not after a week of waiting.
    const unable = this.cannotTake(peer, kind) ?? (kind === 'file' && isSecretPath(input.path?.trim() ?? '') ? this.cannotTake(peer, kind, 'task.secret') : undefined);
    if (unable) throw new Error(unable);
    if (input.via && kind === 'file' && isSecretPath(input.path?.trim() ?? '')) throw new Error('That file holds secrets. An external agent never gets one.');
    // Your Claude asking the same person's Claude again and again from one conversation: it stops and tells you instead.
    // (Commands and files are one step each, asked about on their side: not counted.)
    // A declared dialogue (BLG-468) is one unit: its own turn cap governs it, counted here once per
    // turn, and its asks don't count toward the limit for undeclared ones.
    if (input.dialogue) {
      if (kind !== 'ask') throw new Error('A dialogue turn is an ask');
      if (this.trustFor(peer.peerId) === 'blocked') throw new Error(`You blocked ${peer.name}`);
      const turn = input.dialogue.turn;
      const sent = this.book.all().filter((t) => t.direction === 'sent' && t.dialogue?.id === input.dialogue!.id);
      // A turn sent again (the chair resumed after a restart): the copy still running on their Mac is
      // stopped, so they never run one turn twice, and the turn counts once.
      for (const t of sent) if (t.dialogue?.turn === turn && !isFinal(t.state)) this.cancel(t.id);
      const turns = new Set(sent.map((t) => t.dialogue?.turn).filter((n) => n !== turn)).size;
      if (turn > input.dialogue.cap || turns >= input.dialogue.cap) throw new Error(`This dialogue already had its ${input.dialogue.cap} turns: continue it to go on`);
    } else if (input.by === 'agent' && kind === 'ask') {
      const since = this.now() - AGENT_ASKS_WINDOW_MS;
      const recent = this.book.all().filter((t) => t.direction === 'sent' && t.by === 'agent' && t.kind === 'ask' && !t.dialogue && t.peerId === peer.peerId && t.conversation === input.conversation && t.createdAt >= since).length;
      if (recent >= MAX_AGENT_ASKS) throw new Error(`You already sent ${peer.name} ${recent} requests from this conversation in the last ${AGENT_ASKS_WINDOW_MS / 60_000} minutes. Don't ask again: stop, and tell your user what you have so far and what's still missing, so they can decide.`);
    }
    const level = this.trustFor(peer.peerId);
    // Your Claude asks first, unless you trust them or said Always for them (asking them, not what they may do here).
    // A dialogue's turns: you said yes when you started it.
    // You said it of your own agent: another agent gets it only at level full.
    const freely = this.freely().includes(peer.peerId) && (!input.via || input.viaFull === true);
    const confirm = input.by === 'agent' && !input.dialogue && level !== 'trusted' && level !== 'full' && !freely;
    const now = this.now();
    const task = this.put({
      id: taskId(),
      direction: 'sent',
      peerId: peer.peerId,
      peerName: peer.name,
      kind,
      ask,
      ...(input.summary?.trim() ? { summary: oneLine(input.summary, MAX_REQUEST_SUMMARY) } : {}),
      needs: [...new Set(input.needs ?? (kind === 'run' ? ['shell'] : kind === 'file' ? ['files'] : []))] as Need[],
      by: input.by,
      ...(input.via ? { via: input.via.name, viaId: input.via.id } : {}),
      state: confirm ? 'confirm' : 'sent',
      ...(input.by === 'person' ? { confirmed: true } : {}),
      steps: [],
      createdAt: now,
      updatedAt: now,
      ...(input.project ? { project: input.project } : {}),
      ...(input.expects ? { expects: input.expects } : {}),
      ...(input.deadlineSec ? { deadline: now + input.deadlineSec * 1000 } : {}),
      ...(input.command ? { command: input.command } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.timeoutSec ? { timeoutSec: input.timeoutSec } : {}),
      ...(input.path ? { path: input.path.trim() } : {}),
      ...(input.conversation ? { conversation: input.conversation } : {}),
      ...(input.answer ? { answer: input.answer } : {}),
      ...(input.dialogue ? { dialogue: input.dialogue, confirmed: true } : {}),
      ...(input.agent && kind === 'ask' ? { onAgent: input.agent } : {}),
    });
    if (confirm) {
      this.deps.notify?.({ kind: 'needsYou', tag: 'approval', title: `${input.via ? oneLine(input.via.name) : 'Your agent'} wants to ask ${peer.name}${kind === 'run' ? `’s Mac to run a command` : kind === 'file' ? '’s Mac for a file' : '’s agent'}`, body: oneLine(input.summary?.trim() || ask, 140), need: `confirm:${task.id}`, ...(input.conversation ? { channel: input.conversation } : {}) });
      const timer = setTimeout(() => this.confirm(task.id, false, undefined, 'Not sent: nobody answered in time'), this.deps.confirmTimeoutMs ?? DEFAULT_CONFIRM_MS);
      timer.unref();
      this.confirmTimers.set(task.id, timer);
    } else this.transmit(task);
    return this.book.get(task.id) ?? task;
  }

  /**
   * A dialogue stopped on this side (BLG-468): its turn in flight with them stops (sent: cancelled;
   * received: halted), and their side hears so it ends there too, between turns as well. They hear
   * of the stop before the halted turn's result: read first, that result would end it there as a
   * failed turn instead (frames to one person arrive in order, but not always in one read).
   */
  stopDialogue(peerId: string, dialogue: string, why: string): void {
    const tasks = this.book.all().filter((t) => t.peerId === peerId && t.dialogue?.id === dialogue).sort((a, b) => a.createdAt - b.createdAt);
    const last = tasks.at(-1);
    if (last) this.courier.send(peerId, { t: 'task_cancel', id: last.id, dialogue: { id: dialogue, why: oneLine(why, 300) }, ts: this.now() }, true);
    for (const t of tasks) {
      if (isFinal(t.state)) continue;
      if (t.direction === 'sent') this.cancel(t.id);
      else this.server.stopTask(t.id);
    }
  }

  private onDialogueStop(from: string, taskId: string, d: { readonly id: string; readonly why: string }): void {
    // Only someone this dialogue was with: the task it names is theirs and carries it.
    const task = this.book.get(taskId);
    if (!task || task.peerId !== from || task.dialogue?.id !== d.id) return;
    this.dialogues?.stopped(from, this.nameOf(from), d.id, d.why);
  }

  /**
   * Chaired dialogues (core/dialogues, BLG-468), plugged in once both are up: a friend's dialogue
   * turn came in or ended here (this side's thread shows it), one was stopped on the other side,
   * and whether one was stopped here (its next turns are declined).
   */
  useDialogues(port: GatewayDialogues | undefined): void {
    this.dialogues = port;
  }

  /** Your answer on the "Ask Alice's Claude?" card: send it (maybe reworded; `always`: and don't ask about them again), or not now. */
  confirm(id: string, yes: boolean, edited?: string, why?: string, always = false): TaskView {
    const task = this.need(id);
    if (task.direction !== 'sent' || task.state !== 'confirm') throw new Error('That request is not waiting for you');
    if (yes && always) this.setAskFreely(task.peerId, true);
    clearTimeout(this.confirmTimers.get(id));
    this.confirmTimers.delete(id);
    if (!yes) return this.finishLocal(task, 'cancelled', why ?? `Not sent: ${this.deps.selfName()} said not now`);
    const ask = edited?.trim() ? edited.trim().slice(0, 16_000) : task.ask;
    const sent = this.put({ ...task, ask, state: 'sent', confirmed: true, updatedAt: this.now() });
    this.transmit(sent);
    return this.book.get(id) ?? sent;
  }

  /** Cancel a task you sent (or stop one a friend sent you). */
  cancel(id: string): TaskView {
    const task = this.need(id);
    if (isFinal(task.state)) return task;
    if (task.direction === 'received') {
      this.server.stopTask(id);
      return this.book.get(id) ?? task;
    }
    if (task.state === 'confirm') return this.confirm(id, false, undefined, 'Cancelled before it was sent');
    const request = this.book.waiting(task.peerId).find((o) => 'm' in o.frame && o.frame.m.t === 'task_request' && o.frame.m.id === id);
    if (request) this.book.dropTask(id);
    // Still in the outbox but handed over: it may have reached them (its ack not back yet), so they're
    // told too (a cancel for a task they never got is ignored).
    const unsent = request !== undefined && !request.sentAt;
    if (!unsent) this.courier.send(task.peerId, { t: 'task_cancel', id, ts: this.now() }, true);
    return this.finishLocal(task, 'cancelled', unsent ? 'Cancelled before it reached them' : 'Cancelled by you');
  }

  /**
   * Remove a task you sent from your lists (the phone's Remove): one still going is cancelled first,
   * so the friend's Mac hears it too. Its saved pictures and files stay where they were saved.
   */
  forget(id: string): void {
    const task = this.need(id);
    if (task.direction !== 'sent') throw new Error('Only a request you sent can be removed');
    if (!isFinal(task.state)) this.cancel(id);
    this.book.remove(id);
    this.deps.store.dispatch({ type: 'gw_forget', id });
  }

  get(id: string): TaskView | undefined {
    return this.book.get(id);
  }

  /** Wait until the task has a result, or `timeoutMs` passes; `onChange` hears every step. */
  wait(id: string, timeoutMs: number, onChange?: (task: TaskView) => void): Promise<TaskView> {
    const first = this.need(id);
    if (isFinal(first.state)) return Promise.resolve(first);
    return new Promise((resolve) => {
      const set = this.waiters.get(id) ?? new Set();
      this.waiters.set(id, set);
      const done = (): void => {
        clearTimeout(timer);
        set.delete(check);
        if (!set.size) this.waiters.delete(id);
        resolve(this.book.get(id) ?? first);
      };
      const asked = first.question?.qid;
      const check = (): void => {
        const t = this.book.get(id);
        if (!t) return done();
        onChange?.(t);
        if (isFinal(t.state)) this.claimed.add(id);
        // A new question from their Claude: the one waiting gets it (and answers it).
        const question = t.question && t.question.qid !== asked;
        if (question) this.toldQuestion.set(id, t.question!.qid);
        if (isFinal(t.state) || question || this.stopped) done();
      };
      const timer = setTimeout(done, Math.max(0, timeoutMs));
      timer.unref?.();
      set.add(check);
    });
  }

  /** The result as your Claude reads it (and it's then counted as given to it). */
  describe(id: string): string {
    const task = this.need(id);
    if (task.result) this.markDelivered(task);
    if (task.question) this.toldQuestion.set(id, task.question.qid);
    return describeForClaude(this.book.get(id) ?? task);
  }

  /**
   * Answer the question their Claude asked about your task (your Claude, from what it knows,
   * or you on the card): one answer per question in order, or skip (it goes on as it sees fit).
   */
  answer(id: string, answers: readonly string[] | 'skip', by: 'agent' | 'person'): TaskView {
    const task = this.need(id);
    const q = task.question;
    if (task.direction !== 'sent' || !q || isFinal(task.state)) throw new Error(`Task ${id} has no question waiting for an answer`);
    const skip = answers === 'skip';
    if (!skip && !answers.some((a) => a.trim())) throw new Error('Give an answer (or skip)');
    // Your Claude's answer tells them something: if you never saw this task, you see the answer first.
    if (by === 'agent' && !skip && !task.confirmed) {
      this.deps.notify?.({ kind: 'needsYou', tag: 'question', title: `Your agent wants to answer ${task.peerName}'s agent`, body: oneLine(answers.join(' · '), 140), need: `gwq:${task.id}`, ...(task.conversation ? { channel: task.conversation } : {}) });
      return this.put({ ...task, answerDraft: { qid: q.qid, answers: answers.map((a) => a.slice(0, 4000)) }, updatedAt: this.now() });
    }
    const record = skip ? undefined : Object.fromEntries(q.questions.map((item, i) => [item.question, (answers[i] ?? '').trim().slice(0, 4000)]).filter(([, a]) => a));
    this.courier.send(task.peerId, { t: 'task_answer', id, qid: q.qid, ...(record ? { answers: record } : { skip: true }), ts: this.now() }, true);
    this.toAsk.delete(id);
    const who = by === 'agent' ? 'Your agent' : 'You';
    const { question: _done, answerDraft: _draft, ...rest } = task;
    return this.put({ ...rest, steps: [...task.steps, skip ? `${who} let them decide` : `${who} answered: ${oneLine(Object.values(record ?? {}).join(' · '), 120)}`].slice(-MAX_STEPS), updatedAt: this.now() });
  }

  // ------------------------------------------------------------------ approvals and rules

  /** Your answer to a request waiting on you (the request sheet, a notification, the menu bar). */
  decide(id: string, input: DecisionInput): TaskView {
    const task = this.need(id);
    if (task.direction !== 'received' || task.state !== 'awaiting_approval') throw new Error('That request is not waiting for you');
    if (!this.server.decide(id, Decision.parse(input))) throw new Error('That request is not waiting for you');
    return this.book.get(id) ?? task;
  }

  saveRule(input: RuleInput): Rule {
    return this.rules.save(input);
  }

  removeRule(id: string): void {
    if (!this.rules.remove(id)) throw new Error('That rule is gone');
  }

  setCapabilities(patch: { levels?: Partial<Capabilities['levels']>; folders?: readonly string[] }): Capabilities {
    return this.rules.setCapabilities(patch);
  }

  // ------------------------------------------------------------------ people

  /** Everyone your Claude could ask: friends and people in the room, with what they offer. */
  whoCan(need?: Need): Candidate[] {
    const state = this.deps.store.getState();
    const self = this.deps.selfId();
    const friends = state.network.enabled ? state.network.friends : [];
    const inRoom = state.peers.filter((p) => p.peerId !== self && !p.guest);
    const ids = [...new Set([...friends.map((f) => f.peerId), ...inRoom.map((p) => p.peerId)])];
    return ids.map((id) => {
      const friend = friends.find((f) => f.peerId === id);
      const room = inRoom.find((p) => p.peerId === id);
      const card = state.gateway.cards[id];
      const yours = this.trustFor(id);
      const theirs = card?.trust ?? state.granted[id]?.level;
      const offers = card?.offers ?? (room?.agent ? ['project', 'shell', 'files'] : []);
      const said = friend ? [friend.presence.emoji, friend.presence.note].filter(Boolean).join(' ') : '';
      const status = friend ? `${friend.presence.state}${said ? ` · ${said}` : ''}` : undefined;
      return {
        name: friend?.name ?? room?.name ?? 'someone',
        peerId: id,
        via: friend && room ? 'friend+room' : friend ? 'friend' : 'room',
        online: Boolean(friend?.online || room),
        ...(status ? { status } : {}),
        your_trust: yours,
        ...(theirs ? { their_trust: theirs } : {}),
        asks_you_first: yours !== 'trusted' && yours !== 'full',
        claude: card?.claude ?? Boolean(room?.agent),
        offers,
        projects: card?.projects ?? room?.projects ?? [],
        ...(card?.note ? { ask_me_for: card.note } : {}),
        ...(need ? { fits: offers.includes(need) && theirs !== 'blocked' } : {}),
        ...(friend?.beluga ? { beluga: shortVersion(friend.beluga.version) } : {}),
        ...(friend?.update ? { needs_update: friend.update } : {}),
      } satisfies Candidate;
    });
  }

  /** Friends your Claude asks without checking with you first (loaded once, then kept here). */
  private freelyList?: readonly string[];
  private freely(): readonly string[] {
    this.freelyList ??= this.deps.loadAskFreely?.() ?? [];
    return this.freelyList;
  }

  /** Let your Claude ask this friend without the card (Always), or take that back. */
  setAskFreely(peerId: string, on: boolean): void {
    const now = this.freely().filter((p) => p !== peerId);
    const next = on ? [...now, peerId] : now;
    this.freelyList = next;
    this.deps.saveAskFreely?.(next);
    this.deps.store.dispatch({ type: 'gw_freely', peers: next });
  }

  /** Your "Ask me for…" note (what other Claudes see on your card). */
  setNote(note: string): void {
    const clean = note.replace(/\s+/g, ' ').trim().slice(0, 280);
    this.deps.saveNote(clean);
    this.deps.store.dispatch({ type: 'gw_note', note: clean });
    this.told.clear();
    this.queueCards();
  }

  // ------------------------------------------------------------------ inside

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private need(id: string): TaskView {
    const task = this.book.get(id);
    if (!task) throw new Error(`No task ${id}`);
    return task;
  }

  private view(): GatewayState {
    return { enabled: true, tasks: this.book.all(), cards: this.book.allCards(), note: this.deps.loadNote(), rules: this.rules.rules(), capabilities: this.rules.capabilities(), askFreely: this.freely() };
  }

  /** Save a task, show it, and wake whoever waits on it. */
  private put(task: TaskView): TaskView {
    const before = this.book.get(task.id);
    this.book.put(task);
    if (this.ready && before && !isFinal(before.state)) this.ranHere(task);
    this.deps.store.dispatch({ type: 'gw_task', task });
    for (const w of [...(this.waiters.get(task.id) ?? [])]) w();
    return task;
  }

  /** A friend's task that ran here just ended (not one you stopped or they cancelled): you hear how it went, pointing at its chat. */
  private ranHere(task: TaskView): void {
    if (task.direction !== 'received' || !task.startedAt || (task.state !== 'done' && task.state !== 'failed')) return;
    const what = task.kind === 'run' ? `${task.peerName}'s command on your Mac` : task.kind === 'file' ? `Sending a file to ${task.peerName}` : `Your agent's work for ${task.peerName}`;
    this.deps.notify?.({
      kind: 'people',
      tag: 'task',
      title: `${what} ${task.state === 'done' ? (task.kind === 'file' ? 'is done' : 'finished') : 'failed'}`,
      body: oneLine((task.result?.summary ?? task.ask).replace(/[*_`#>]/g, ''), 140),
      ...(task.chat ? { channel: task.chat } : {}),
      ...(presenceQuiet(this.deps.store.getState()) ? { quiet: true } : {}),
    });
  }

  /** Your trust in someone: chosen in the room, remembered from before, or your default. */
  trustFor(peerId: string): TrustLevel {
    if (peerId === this.deps.selfId()) return 'full';
    return trustOf(this.deps.store.getState(), peerId);
  }

  /** Who you are to this person: your network address's id for friends (the same as in rooms, except in the demo). */
  private idFor(peerId: string): string {
    return this.mesh?.isFriend(peerId) ? this.mesh.peerId : this.deps.selfId();
  }

  nameOf(peerId: string): string {
    const state = this.deps.store.getState();
    const friend = state.network.friends.find((f) => f.peerId === peerId)?.name;
    if (friend) return friend;
    if (state.peers.some((p) => p.peerId === peerId)) return peerName(state, peerId);
    return this.mesh?.nameFor(peerId) ?? this.book.all().find((t) => t.peerId === peerId)?.peerName ?? peerId.slice(0, 6);
  }

  /** Someone by name (friends first, then the room) or by peer id. */
  private resolve(person: string): { peerId: string; name: string } {
    const wanted = person.trim().replace(/^@/, '').toLowerCase();
    const people = this.whoCan();
    const hit = people.find((p) => p.peerId === person.trim()) ?? people.find((p) => p.name.toLowerCase() === wanted && p.via !== 'room') ?? people.find((p) => p.name.toLowerCase() === wanted);
    if (!hit) throw new Error(`Nobody called "${person}" among your friends or the people in this room. Call who_can to see who's there.`);
    if (!this.courier.knows(hit.peerId)) throw new Error(`${hit.name} can't be reached`);
    return { peerId: hit.peerId, name: hit.name };
  }

  /**
   * Why a friend's Beluga can't take a request of this kind, from what it said on its last link.
   * Only for requests that go over the network: someone in the room takes them there.
   */
  private cannotTake(peer: { peerId: string; name: string }, kind: TaskKind, feature: Feature = featureForTask(kind)): string | undefined {
    const state = this.deps.store.getState();
    if (state.peers.some((p) => p.peerId === peer.peerId)) return undefined;
    const info = this.mesh?.belugaOf?.(peer.peerId) ?? state.network.friends.find((f) => f.peerId === peer.peerId)?.beluga;
    return cannotTake(peer.name, info, feature, this.mesh?.isLinked(peer.peerId) ?? false);
  }

  /**
   * Where both of you see a task's card (BLG-208): the channel it was asked from, when they're in it
   * too, else your DM with them. Only between friends (the network carries the card).
   */
  private chatFor(task: TaskView): string | undefined {
    const mesh = this.mesh;
    if (!mesh?.post || !mesh.isFriend(task.peerId)) return undefined;
    const from = task.conversation;
    if (from?.startsWith('group:') && mesh.shares?.(from, task.peerId)) return from;
    return `dm:${task.peerId}`;
  }

  /** Post the task's card into that chat: newer Macs draw it from their task book; older ones read the words. */
  private postCard(task: TaskView): TaskView {
    const chat = task.chat ?? this.chatFor(task);
    if (!chat || task.chat) return task;
    const me = this.deps.selfName();
    const who = task.by === 'agent' ? `${me}'s agent` : me;
    const what =
      task.kind === 'run'
        ? `asked to run \`${oneLine(task.command ?? '', 80)}\` on ${task.peerName}'s Mac`
        : task.kind === 'file'
          ? `asked ${task.peerName}'s Mac for ${(task.path ?? '').split(/[\\/]/).pop() || 'a file'}`
          : `asked ${task.peerName}'s agent: ${oneLine(task.summary?.trim() || task.ask, 140)}`;
    try {
      this.mesh?.post?.(chat, `${who} ${what}`, { task: { id: task.id, role: 'request' } });
    } catch {
      // The chat isn't there (the friend just went): the task goes on without its card.
      return task;
    }
    return this.put({ ...task, chat });
  }

  private transmit(given: TaskView): void {
    const task = this.postCard(given);
    const sentNow = this.courier.send(
      task.peerId,
      {
        t: 'task_request',
        id: task.id,
        from: this.idFor(task.peerId),
        to: task.peerId,
        kind: task.kind,
        ask: task.ask,
        ...(task.summary ? { summary: task.summary } : {}),
        needs: [...task.needs],
        by: task.by,
        ...(task.via && task.viaId ? { via: { id: task.viaId, name: task.via, creationSource: 'mcp' as const } } : {}),
        ts: this.now(),
        ...(task.project ? { project: task.project } : {}),
        ...(task.expects ? { expects: task.expects } : {}),
        ...(task.deadline ? { deadline: task.deadline } : {}),
        ...(task.command ? { command: task.command } : {}),
        ...(task.cwd ? { cwd: task.cwd } : {}),
        ...(task.timeoutSec ? { timeoutSec: task.timeoutSec } : {}),
        ...(task.path ? { path: task.path } : {}),
        ...(task.chat?.startsWith('group:') ? { chat: task.chat } : {}),
        ...(task.dialogue ? { dialogue: task.dialogue } : {}),
        ...(task.onAgent ? { agent: task.onAgent } : {}),
      },
      true,
    );
    if (!sentNow) this.put({ ...task, steps: [...task.steps, `${task.peerName} is offline: it goes out when they're back`].slice(-MAX_STEPS), updatedAt: this.now() });
  }

  private finishLocal(task: TaskView, status: 'cancelled' | 'failed', summary: string): TaskView {
    return this.put({ ...task, state: status, result: { status, summary, files: [], log: task.steps }, endedAt: this.now(), updatedAt: this.now(), delivered: task.delivered ?? false });
  }

  /** It ended here without their answer: nothing of it goes out later, and whoever asked hears so (like a result). */
  private failHere(task: TaskView, summary: string): void {
    this.book.dropTask(task.id);
    const done = this.finishLocal(task, 'failed', summary);
    this.endedHere.add(done.id);
    this.announce(done);
    this.settle(done);
  }

  /** Their Mac acknowledged your request: it's there (the silence check counts from now). */
  private onDelivered(o: Outgoing): void {
    if (o.frame.m.t !== 'task_request') return;
    const task = this.book.get(o.frame.m.id);
    if (!task || task.direction !== 'sent' || isFinal(task.state)) return;
    const step = `Reached ${task.peerName}'s Mac`;
    if (!task.steps.includes(step)) this.put({ ...task, steps: [...task.steps, step].slice(-MAX_STEPS), updatedAt: this.now() });
  }

  private onUpdate(from: string, msg: TaskUpdate): void {
    const task = this.book.get(msg.id);
    if (!task || task.direction !== 'sent' || task.peerId !== from || isFinal(task.state) || task.state === 'confirm' || this.book.pending()[task.id]) return;
    this.put({ ...task, state: msg.state, ...(msg.step ? { steps: [...task.steps, msg.step].slice(-MAX_STEPS) } : {}), ...(msg.state === 'working' && !task.startedAt ? { startedAt: this.now() } : {}), updatedAt: this.now() });
  }

  private onResult(from: string, msg: TaskResult): void {
    const task = this.book.get(msg.id);
    // Only the person it was sent to answers it, once.
    if (!task || task.direction !== 'sent' || task.peerId !== from || isFinal(task.state) || task.state === 'confirm' || this.book.pending()[task.id]) return;
    if (msg.files.some((f) => f.ref && !f.b64)) {
      void this.receiveFiles(task, msg);
      return;
    }
    try {
      this.complete(task, msg, this.book.saveFiles(task.id, msg.files, this.deps.scratch ?? defaultScratch()));
    } catch (err) {
      this.cantKeep(task.id, err);
    }
  }

  /** What came back couldn't be kept here (the disk said no): the task ends, saying why. */
  private cantKeep(id: string, err: unknown): void {
    this.book.setPending(id, undefined);
    const current = this.book.get(id);
    if (!current || isFinal(current.state)) return;
    const { incoming: _i, ...rest } = current;
    const done = this.finishLocal(rest, 'failed', `${current.peerName} answered, but what came back couldn't be saved on this Mac: ${err instanceof Error ? err.message : String(err)}`);
    this.announce(done);
    this.settle(done);
  }

  /** The result's big files come in pieces first; then it's complete (files that didn't come are listed). */
  private async receiveFiles(task: TaskView, msg: TaskResult): Promise<void> {
    try {
      await this.fetchFiles(task, msg);
    } catch (err) {
      this.cantKeep(task.id, err);
    }
  }

  private async fetchFiles(task: TaskView, msg: TaskResult): Promise<void> {
    this.book.setPending(task.id, msg);
    const base = this.deps.scratch ?? defaultScratch();
    const inline = this.book.saveFiles(task.id, msg.files.filter((f) => !f.ref || f.b64), base);
    const wanted = wantedFiles(msg.files);
    const total = wanted.reduce((n, f) => n + f.size, 0);
    const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`;
    this.put({ ...task, state: 'working', incoming: { received: 0, total }, steps: [...task.steps, `Receiving ${wanted.length} file${wanted.length === 1 ? '' : 's'} (${mb(total)})`].slice(-MAX_STEPS), updatedAt: this.now() });
    let shown = 0;
    const fetched = await this.fetcher.fetchAll(task.peerId, task.id, wanted, (received) => {
      // Progress at most every 5%: it's in the shared state.
      if (received - shown < total / 20 && received < total) return;
      shown = received;
      const t = this.book.get(task.id);
      if (t && !isFinal(t.state)) this.put({ ...t, incoming: { received, total }, updatedAt: this.now() });
    });
    if (this.stopped) return;
    this.book.setPending(task.id, undefined);
    const current = this.book.get(task.id);
    if (!current || isFinal(current.state)) return;
    const files = mergeFiles(msg.files, inline, wanted, fetched);
    const missed = fetched.filter((f) => f.error).map((f) => `${f.name} didn't arrive: ${f.error}`);
    const { incoming: _i, ...rest } = current;
    this.complete(rest, msg, files, missed);
  }

  /** Their Claude asks something about your task: your Claude first (it knows the context), else you. */
  private onQuestion(from: string, msg: TaskQuestion): void {
    const task = this.book.get(msg.id);
    if (!task || task.direction !== 'sent' || task.peerId !== from || isFinal(task.state) || task.state === 'confirm') return;
    // Each question once (a replay of an answered one is nothing new), and only a few per task.
    const asked = task.asked ?? [];
    if (asked.includes(msg.qid)) return;
    if (asked.length >= MAX_QUESTIONS) {
      this.courier.send(from, { t: 'task_answer', id: task.id, qid: msg.qid, skip: true, ts: this.now() }, true);
      return;
    }
    const { answerDraft: _old, ...plainTask } = task;
    const next = this.put({
      ...plainTask,
      asked: [...asked, msg.qid],
      question: { qid: msg.qid, questions: msg.questions, askedAt: this.now() },
      steps: [...task.steps, `${task.peerName}'s agent asks: ${oneLine(msg.questions[0]!.question, 120)}`].slice(-MAX_STEPS),
      updatedAt: this.now(),
    });
    // A wait_for that was waiting already took it (see wait).
    if (this.toldQuestion.get(next.id) === msg.qid) return;
    if (next.by === 'agent' && next.conversation && !next.dialogue) {
      // An external agent reads it with wait_for or check: no turn of your agent starts for it.
      if (isExternalRequester(next.conversation)) return;
      if (this.busy(next.conversation)) this.toAsk.add(next.id);
      else this.askClaude(next);
      return;
    }
    this.deps.notify?.({ kind: 'needsYou', tag: 'question', title: `${next.peerName}'s agent has a question`, body: oneLine(msg.questions[0]!.question, 140), need: `gwq:${next.id}`, ...(next.conversation ? { channel: next.conversation } : {}) });
  }

  /** Start a turn of your Claude with the question (once per question). */
  private askClaude(task: TaskView): void {
    const current = this.book.get(task.id);
    if (!current?.question || !current.conversation || isFinal(current.state)) return;
    if (this.toldQuestion.get(current.id) === current.question.qid) return;
    this.toldQuestion.set(current.id, current.question.qid);
    this.deps.resume(current.conversation, questionPrompt(current), viaOf(current));
  }

  private complete(task: TaskView, msg: TaskResult, files: readonly TaskFile[], missed: readonly string[] = []): void {
    const checked = task.expects && task.expects !== 'files' && msg.status === 'done' ? (msg.data === undefined ? ['No structured data came back'] : validate(msg.data, task.expects)) : task.expects === 'files' && msg.status === 'done' && !files.some((f) => f.path) ? ['No files came back'] : [];
    const problems = [...checked, ...missed];
    const { question: _q, incoming: _in, answerDraft: _d, ...plain } = task;
    this.toAsk.delete(task.id);
    const done = this.put({
      ...plain,
      state: msg.status,
      result: {
        status: msg.status,
        summary: msg.summary,
        files,
        log: msg.log,
        ...(msg.data !== undefined ? { data: msg.data } : {}),
        ...(task.expects && msg.status === 'done' ? { valid: checked.length === 0 } : {}),
        ...(problems.length ? { problems } : {}),
        ...(task.kind === 'file' && msg.secret ? { secret: msg.secret } : {}),
        ...(task.kind === 'ask' && msg.agent ? { agent: msg.agent } : {}),
      },
      endedAt: this.now(),
      updatedAt: this.now(),
    });
    this.announce(done);
    this.settle(done);
  }

  private announce(task: TaskView): void {
    // Your Claude asked from a conversation: it hands the answer on there (one place, not two). A dialogue's chair posts its turns.
    if ((task.by === 'agent' && task.conversation) || task.dialogue) return;
    const who = task.kind === 'run' ? `Your command on ${task.peerName}'s Mac` : task.kind === 'file' ? `Your file request to ${task.peerName}'s Mac` : `${task.peerName}'s agent`;
    const verb = task.state === 'done' ? (task.kind === 'run' ? 'finished' : 'replied') : task.state === 'declined' ? 'was declined' : task.state === 'cancelled' ? 'was cancelled' : 'failed';
    this.deps.notify?.({ kind: task.state === 'done' ? 'done' : 'problems', title: `${who} ${verb}`, body: oneLine((task.result?.summary ?? task.ask).replace(/[*_`#>]/g, ''), 140), ...(task.conversation ? { channel: task.conversation } : {}) });
  }

  private markDelivered(task: TaskView): void {
    this.toResume.delete(task.id);
    this.claimed.delete(task.id);
    if (!task.delivered) this.put({ ...task, delivered: true });
  }

  /** A result arrived: whoever waits for it gets it; else your Claude continues with it. */
  private settle(task: TaskView): void {
    // A dialogue's turn: the chair is waiting for it (core/dialogues), no conversation resumes.
    if (task.by !== 'agent' || !task.conversation || task.delivered || task.dialogue) return;
    // A wait_for is waiting: it hands the result to Claude (see describe).
    if (this.claimed.has(task.id) || this.waiters.get(task.id)?.size) return;
    // An external agent asked: it reads the result with wait_for or check. No turn of your agent starts for it.
    if (isExternalRequester(task.conversation)) return;
    if (this.busy(task.conversation)) {
      this.toResume.add(task.id);
      return;
    }
    this.resume(task);
  }

  private resume(task: TaskView): void {
    const current = this.book.get(task.id) ?? task;
    if (current.delivered || !current.conversation) return;
    this.markDelivered(current);
    this.deps.resume(current.conversation, resumePrompt(current, this.endedHere.delete(current.id)), viaOf(current));
  }

  /** Your Claude is working (or about to) in this conversation. */
  private busy(channel: string): boolean {
    const self = this.deps.selfId();
    return this.deps.store.getState().log.some((l) => l.type === 'agent' && l.channel === channel && l.owner === self && !isAgentFinal(l.status));
  }

  private onAction(action: Action): void {
    // A run of yours ended: results (and questions) it didn't pick up start the next turn.
    if (action.type !== 'agent_event' || action.owner !== this.deps.selfId() || !isAgentFinal(action.event) || (!this.toResume.size && !this.toAsk.size)) return;
    setImmediate(() => {
      for (const id of [...this.toAsk]) {
        const task = this.book.get(id);
        if (!task?.question || !task.conversation) {
          this.toAsk.delete(id);
          continue;
        }
        if (task.conversation === (action.channel ?? 'room') && !this.busy(task.conversation)) {
          this.toAsk.delete(id);
          this.askClaude(task);
        }
      }
      for (const id of [...this.toResume]) {
        const task = this.book.get(id);
        if (!task?.conversation) {
          this.toResume.delete(id);
          continue;
        }
        if (task.conversation === (action.channel ?? 'room') && !this.busy(task.conversation)) {
          this.toResume.delete(id);
          if (this.claimed.has(id) || this.waiters.get(id)?.size) continue;
          this.resume(task);
        }
      }
    });
  }

  private onCard(from: string, msg: PeerCardMsg): void {
    const card: PeerCard = { trust: msg.trust, offers: msg.offers, projects: msg.projects, claude: msg.claude, at: this.now(), ...(msg.note ? { note: msg.note } : {}), ...(msg.usages?.length ? { usages: msg.usages } : {}) };
    this.book.putCard(from, card);
    this.deps.store.dispatch({ type: 'gw_card', peerId: from, card });
  }

  /** Tell everyone reachable what you offer them (when it changed, or they just came online). */
  private queueCards(): void {
    if (this.cardsQueued || this.stopped) return;
    this.cardsQueued = true;
    setImmediate(() => {
      this.cardsQueued = false;
      if (!this.stopped) this.tellCards();
    });
  }

  private tellCards(): void {
    const state = this.deps.store.getState();
    const self = this.deps.selfId();
    const people = new Set([...(state.network.enabled ? state.network.friends.filter((f) => f.online).map((f) => f.peerId) : []), ...state.peers.filter((p) => p.peerId !== self && !p.guest).map((p) => p.peerId)]);
    for (const id of [...this.told.keys()]) if (!people.has(id)) this.told.delete(id);
    const note = state.gateway.note;
    const projects = this.deps.projects().slice(0, 60);
    const claude = Boolean(this.deps.agent());
    // Your plan usage, for those you share it with (Settings › Friends; BLG-597).
    const usages = usagesOf(state.peers.find((p) => p.peerId === self) ?? state.self).slice(0, 8);
    for (const id of people) {
      if (!this.courier.reach(id)) continue;
      const trust = this.trustFor(id);
      const offers = offersFor(this.rules.capabilities(), trust);
      const shared = usages.length && sharesUsageWith(state.prefs.shareUsage, trust) ? { usages: [...usages] } : {};
      const card: PeerCardMsg = { t: 'card', trust, offers, projects: offers.includes('project') ? [...projects] : [], claude, ...(note ? { note } : {}), ...shared };
      const key = JSON.stringify(card);
      if (this.told.get(id) === key) continue;
      if (this.courier.send(id, card, false)) this.told.set(id, key);
    }
  }

  private tick(): void {
    if (this.stopped) return;
    const now = this.now();
    // Ticks far apart: this Mac slept, and what came for it meanwhile is still on its way.
    const real = Date.now();
    if (real - this.lastTickAt > SLEPT_MS) this.wokeAt = now;
    this.lastTickAt = real;
    for (const gone of this.book.expire(now)) {
      if (!('m' in gone.frame) || gone.frame.m.t !== 'task_request') continue;
      const task = this.book.get(gone.frame.m.id);
      if (task && !isFinal(task.state)) this.failHere(task, `${task.peerName} didn't come online in time`);
    }
    // It reached their Mac, then silence: a friend's Mac that lost it (an older Beluga that quit
    // mid-task) never answers, so after a day without news it stops showing as running here. One
    // still waiting to reach them has the outbox's week instead (their laptop is closed: BLG-705),
    // and just after either of you is back, what waited gets its chance to arrive first.
    for (const t of this.book.all()) {
      if (t.direction !== 'sent' || t.state === 'confirm' || isFinal(t.state) || this.book.pending()[t.id] || this.book.undelivered(t.id)) continue;
      if (now - t.updatedAt > SILENT_MS && now - Math.max(this.wokeAt, this.seenAt.get(t.peerId) ?? 0) >= BACK_GRACE_MS) this.failHere(t, `No word from ${t.peerName} in a day`);
    }
    this.courier.flush();
    this.queueCards();
  }
}

/** Why a schema can't be used (undefined: it can). */
function validateSchema(schema: Readonly<Record<string, unknown>>): string | undefined {
  try {
    if ((JSON.stringify(schema) ?? '').length > 8_000) return 'too large';
    validate(null, schema);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** The external agent that sent a task: its answer goes on at that agent's level, not yours. */
const viaOf = (task: TaskView): { readonly id: string; readonly name: string } | undefined => (task.viaId ? { id: task.viaId, name: task.via ?? 'An external agent' } : undefined);
