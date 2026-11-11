import { talkReadOnly } from '../../agent/dialogue-tools.js';
import { type AgentRef, CLAUDE_AGENT } from '../../protocol.js';
import { fallbackFor } from '../../shared/runtime-fallbacks.js';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentBackend, AgentPlace, BoardTools, TaskTools } from '../../agent/types.js';
import { mentionsSecret, writesCode } from '../../agent/policy.js';
import type { ClaudeAnswer, ClaudeQuestion } from '../../protocol.js';
import { isNeverSent, isSecretPath, secretKindOf } from '../shares.js';
import type { TrustLevel } from '../trust.js';
import { type AccessDecision, CAP_INFO, type Capabilities, Decision, type RequestFacts, type Rule, capFor, declineReason, ruleKindOf } from './access.js';
import type { TaskBook } from './book.js';
import { type SystemPort, captureScreen, describeDevice, deviceInfo, realSystem } from './device.js';
import { type TaskOutcome, type TaskView, approvalTitle, isFinal, requestGist, secretLabel, secretNoun } from './model.js';
import { type FileGet, MAX_FILES, MAX_QUESTIONS, type Need, type ResultStatus, type TaskAnswer, type TaskCancel, type TaskRequest } from './protocol.js';
import { oneLine, parseAnswer, readResultFiles, taskPrompt } from './result.js';
import { FileOffers } from './transfer.js';
import type { Courier } from './transport.js';

/**
 * The receiving side of the gateway: a friend's Claude asks yours, runs a command here, or asks
 * for a file. Your rules and capability settings decide first (access.ts): declined, let in at
 * once (you trust them, or a rule of yours covers it), or you're asked: the request sheet,
 * notification or menu-bar item says "Kayra's Claude wants to: …" with Approve once / Always
 * (a rule for requests like this one) / Decline. Then your Claude works on it in the project it
 * names (or a fresh scratch folder) with the tools you allowed (the screen, device info); its
 * steps go back as updates, its questions go back to the requester, and its final answer goes
 * back as the result, with screenshots and files (big ones fetched in pieces), to them only.
 */

export type Answer = 'yes' | 'no' | 'always';

/** How an approval is asked: `once` offers only Allow once / Decline (a secret: nothing covers it next time). */
export interface ApproveOpts {
  readonly once?: boolean;
  /** The chat the request is in (its card is there, BLG-207): the approval and its notification point at it. */
  readonly conversation?: string;
}

/** A question for you (an approval card) that can be withdrawn. */
export interface Pending {
  readonly answer: Promise<Answer>;
  readonly withdraw: () => void;
}

/** A command a task asks to run here, and what came of it (see PeerRun.serveTask). */
export interface ShellAsk {
  readonly command: string;
  readonly cwd?: string;
  readonly project?: string;
  readonly timeoutSec: number;
  readonly why: string;
}
export interface ShellReply {
  readonly ok: boolean;
  readonly exitCode?: number;
  readonly output?: string;
  readonly truncated?: boolean;
  readonly timedOut?: boolean;
  readonly cwd?: string;
  readonly ms?: number;
  readonly error?: string;
}
/** `approved`: the gateway already decided (rules, capabilities, your answer); PeerRun still checks secrets and limits. */
export type ServeShell = (from: string, ask: ShellAsk, hooks: { onAsking: () => void; onStarted: (cwd: string) => void; approved?: boolean }) => Promise<ShellReply>;

/** Rules and capabilities, as the server uses them (see rule-book.ts). */
export interface AccessPort {
  decide(facts: RequestFacts, trust: TrustLevel): AccessDecision;
  remember(facts: RequestFacts, peerName: string, decision: Pick<Decision, 'scope' | 'command' | 'expiry'>): Rule;
  capabilities(): Capabilities;
}

export interface ServeContext {
  readonly book: TaskBook;
  readonly courier: Courier;
  /** One of your ids (in rooms, and on the network). */
  readonly isMe: (peerId: string) => boolean;
  readonly selfName: () => string;
  readonly trustFor: (peerId: string) => TrustLevel;
  readonly nameOf: (peerId: string) => string;
  readonly put: (task: TaskView) => TaskView;
  readonly agent: () => AgentBackend | undefined;
  /** Ask you; `task` links the card to the request it's about (the sheet and notifications find it). `once`: only Allow once / Decline (a secret). */
  readonly approve: (kind: 'request' | 'tool', title: string, detail: string, peer: string, task?: string, opts?: ApproveOpts) => Pending;
  readonly access: AccessPort;
  readonly serveShell?: ServeShell;
  readonly projectRoot: (name: string) => string | undefined;
  /** A project's task board for a friend's request there (BLG-701): its tools, and what Claude is told. */
  readonly board?: (project: string, friend: { readonly id: string; readonly name: string }) => { readonly tools?: BoardTools; readonly brief?: string } | undefined;
  readonly model: () => { model?: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' };
  /** The agent that answers friends' asks here: your default, with your default model (you choose it, never the asker). */
  readonly agentRef?: () => AgentRef;
  /** The agents your card lists (an asker may pick one of those, BLG-503). */
  readonly agents?: () => readonly AgentRef[];
  /** Whether this Mac can run that agent now (its runtime is here). Unset: only your default. */
  readonly runs?: (agent: AgentRef) => boolean;
  readonly notify: (title: string, body: string) => void;
  /** Where scratch folders go when the book has no folder. */
  readonly scratch: string;
  readonly now: () => number;
  /** The screen and device info (tests pass a pretend one). */
  readonly system?: SystemPort;
  readonly home?: string;
  /** Where a command from this person runs when it names no folder (PeerRun's choice: your shared folder, home with full trust). */
  readonly runFolder?: (from: string) => Promise<string | undefined>;
  /** How long a question waits for the requester's answer (default 15 minutes). */
  readonly questionWaitMs?: number;
  /** How long a friend's task may run in all (default 20 minutes; sooner if its deadline is). */
  readonly runLimitMs?: number;
  /** Chaired dialogues (BLG-468): a turn came in or ended, and whether one was stopped here. */
  readonly dialogues?: import('./gateway.js').GatewayDialogues;
  /** The chat its card is in here (BLG-208): the channel it names if you're both in it, else your DM with them (friends only). */
  readonly chatOf?: (from: string, chat: string | undefined) => string | undefined;
}

/** Received tasks one person may have open here at once. */
const MAX_OPEN_PER_PERSON = 5;
/** Friends' tasks your Claude works on at the same time. */
const MAX_RUNNING = 2;
const MAX_STEPS = 12;
const STEP_EVERY_MS = 400;
/** Screenshots one task may take, with the screenshot tool or a command (BLG-427). */
const MAX_SCREENSHOTS = 4;
const QUESTION_WAIT_MS = 15 * 60_000;
/** A friend's task stops after this many turns, or this long, whichever comes first (BLG-427). */
export const MAX_TURNS = 50;
export const RUN_LIMIT_MS = 20 * 60_000;
/** Times one task may ask you to approve a step, and declines in a row that stop it (BLG-427). */
export const MAX_TOOL_ASKS = 8;
export const MAX_DECLINES = 2;

const NEED_WORDS: Readonly<Record<Need, string>> = { project: 'work in a project', shell: 'run commands', files: 'read or write files', screen: 'see the screen', device: 'read device information' };

/** The capability a tool of a friend's task uses (checked on every call). */
const TOOL_NEEDS: Readonly<Record<string, Need>> = { Bash: 'shell', Write: 'files', Edit: 'files', MultiEdit: 'files', NotebookEdit: 'files' };

/** A command that takes a screenshot (macOS's screencapture, the Linux tools, a script grabbing the screen). */
const SCREENSHOT_COMMAND = /(?:^|[\s;&|(`/])(?:screencapture|gnome-screenshot|scrot|grim|maim|spectacle|xwd)(?=$|[\s;&|)`])|\bimport\s+-window\b|\bImageGrab\b|\bpyautogui\.screenshot\b|\bCG(?:Display|WindowList)CreateImage\b/;
export const takesScreenshot = (tool: string, input: Record<string, unknown>): boolean => tool === 'Bash' && typeof input.command === 'string' && SCREENSHOT_COMMAND.test(input.command);

/** Every capability a tool call uses: a command that takes a screenshot needs the screen too. */
const toolNeeds = (tool: string, input: Record<string, unknown>): Need[] => {
  const need = TOOL_NEEDS[tool];
  if (!need) return [];
  return takesScreenshot(tool, input) ? [need, 'screen'] : [need];
};

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The agent a friend's ask runs on here (BLG-503): the one they asked for when your card lists it
 * (same runtime, and model when they named one) and it runs here, with your own pick of its model;
 * else your default, with a note saying so.
 */
export function agentForAsk(asked: AgentRef | undefined, mine: AgentRef, listed: readonly AgentRef[], runs?: (agent: AgentRef) => boolean): { readonly agent: AgentRef; readonly note?: string } {
  if (!asked || (asked.runtime === mine.runtime && (!asked.model || asked.model === mine.model))) return { agent: mine };
  const found = listed.find((a) => a.runtime === asked.runtime && (!asked.model || a.model === asked.model)) ?? listed.find((a) => a.runtime === asked.runtime);
  if (found && (runs?.(found) ?? false)) return { agent: found };
  return { agent: mine, note: `${asked.label} isn’t set up here, so ${mine.label} does it` };
}

/**
 * A friend's task picked for an agent that doesn't take them (OpenCode: shared/runtime-fallbacks.ts
 * `friends`): handed to one that does and runs here (Claude first), the card saying why. None
 * here: as it was (the run says it can't).
 */
export function agentForFriend(picked: { readonly agent: AgentRef; readonly note?: string }, listed: readonly AgentRef[], runs?: (agent: AgentRef) => boolean): { readonly agent: AgentRef; readonly note?: string } {
  const why = fallbackFor(picked.agent.runtime, 'friends');
  if (!why) return picked;
  const other = [CLAUDE_AGENT, ...listed].find((a) => !fallbackFor(a.runtime, 'friends') && (runs?.(a) ?? false));
  return other ? { agent: other, note: why } : picked;
}
const SKIP: ClaudeAnswer = { kind: 'skip' };

type QuestionWaiter = { readonly task: string; readonly from: string; readonly resolve: (a: ClaudeAnswer) => void };

export class TaskServer {
  private readonly queue: Array<{ task: TaskView; req: TaskRequest; facts: RequestFacts }> = [];
  private running = 0;
  private readonly controllers = new Map<string, AbortController>();
  private readonly approvals = new Map<string, () => void>();
  /** Answers given on the request sheet (with the scope of "Always"), by task. */
  private readonly deciders = new Map<string, (d: Decision) => void>();
  /** "person:tool" pairs you said Always to (until Beluga quits). */
  private readonly alwaysTools = new Set<string>();
  /** Screenshots a task took (they go back with its result). */
  private readonly artifacts = new Map<string, string[]>();
  private readonly questions = new Map<string, QuestionWaiter>();
  private readonly asked = new Map<string, number>();
  /** Screenshots a task took, the tool's and its commands' (at most MAX_SCREENSHOTS). */
  private readonly shots = new Map<string, number>();
  /** Steps a task asked you to approve, and your declines in a row. */
  private readonly toolAsks = new Map<string, { asked: number; declined: number }>();
  /** The agent each ask ran on (its result names it). */
  private readonly ranOn = new Map<string, AgentRef>();
  readonly offers: FileOffers;

  constructor(private readonly ctx: ServeContext) {
    this.offers = new FileOffers(ctx.now);
  }

  /** Stop everything (Beluga quits): runs end, approvals are withdrawn. */
  stop(): void {
    for (const c of this.controllers.values()) c.abort();
    for (const w of this.approvals.values()) w();
    for (const q of this.questions.values()) q.resolve(SKIP);
    this.offers.drop();
  }

  private get system(): SystemPort {
    return this.ctx.system ?? realSystem;
  }

  private get home(): string {
    return this.ctx.home ?? os.homedir();
  }

  async onRequest(from: string, req: TaskRequest): Promise<void> {
    const { ctx } = this;
    if (req.from !== from || !ctx.isMe(req.to)) return;
    const known = ctx.book.get(req.id);
    if (known) {
      // Asked again (our result went missing): say it again; anything else is a replay.
      if (known.direction === 'received' && known.peerId === from && known.result) this.sendResult(known, known.result);
      return;
    }
    const level = ctx.trustFor(from);
    const name = ctx.nameOf(from);
    const me = ctx.selfName();
    const now = ctx.now();
    // Blocked people get their answer, and nothing of theirs is kept here.
    if (level === 'blocked') return this.declineUnkept(from, req.id, `${me} doesn't take requests from you`);
    const chat = ctx.chatOf?.(from, req.chat);
    const task = ctx.put({
      ...(chat ? { chat } : {}),
      id: req.id,
      direction: 'received',
      peerId: from,
      peerName: name,
      kind: req.kind,
      ask: req.ask,
      ...(req.summary?.trim() ? { summary: oneLine(req.summary, 140) } : {}),
      needs: req.needs,
      by: req.by,
      ...(req.via ? { via: req.via.name } : {}),
      state: 'queued',
      steps: [],
      createdAt: now,
      updatedAt: now,
      ...(req.project ? { project: req.project } : {}),
      ...(req.expects ? { expects: req.expects } : {}),
      ...(req.deadline ? { deadline: req.deadline } : {}),
      ...(req.command ? { command: req.command } : {}),
      ...(req.cwd ? { cwd: req.cwd } : {}),
      ...(req.timeoutSec ? { timeoutSec: req.timeoutSec } : {}),
      ...(req.path ? { path: req.path } : {}),
      ...(req.dialogue && req.kind === 'ask' ? { dialogue: req.dialogue } : {}),
    });
    if (task.dialogue) {
      // A dialogue you stopped here takes no more turns; one going on shows in your thread too.
      if (ctx.dialogues?.isStopped(task.dialogue.id)) return this.finish(task, 'declined', `${me} stopped this dialogue`);
      ctx.dialogues?.turn(task);
    }
    try {
      await this.admit(task, req, level);
    } catch (err) {
      // Whatever went wrong here, the requester hears it (nothing is left waiting).
      if (!this.isOver(task.id)) this.finish(this.current(task), 'failed', `${me}'s Beluga couldn't take it: ${errorText(err)}`);
    }
  }

  /** Decide a request that's now on the book, ask you if need be, and start it. */
  private async admit(task: TaskView, req: TaskRequest, level: TrustLevel): Promise<void> {
    const { ctx } = this;
    const name = task.peerName;
    const me = ctx.selfName();
    const now = ctx.now();
    const from = task.peerId;
    if (req.deadline && req.deadline < now) return this.finish(task, 'failed', 'Its deadline passed before it could start');
    // Their others still open (this one is on the book already): at most MAX_OPEN_PER_PERSON with it.
    const open = ctx.book.all().filter((t) => t.direction === 'received' && t.peerId === from && t.id !== task.id && !isFinal(t.state)).length;
    if (open >= MAX_OPEN_PER_PERSON) return this.finish(task, 'declined', `Too many of your requests are already waiting on ${me}'s Mac; try again when they're done`);
    if (req.kind === 'run' && !req.command) return this.finish(task, 'failed', 'It named no command to run');
    // Secrets stay off-limits at every trust level: refused before anyone is asked.
    if (req.kind === 'run' && mentionsSecret(req.command ?? '')) return this.finish(task, 'failed', 'Beluga never runs commands that touch secrets (.env files, keys, credentials)');
    if (req.kind === 'file' && !req.path) return this.finish(task, 'failed', 'It named no file');
    const facts = await this.factsFor(from, req);
    // It may have been stopped (or cancelled) meanwhile.
    if (this.isOver(task.id)) return;
    // Beluga's own private files and the keychains never go, whoever approves (the read checks again, links followed).
    const file = req.kind === 'file' ? this.expand(req.path ?? '') : '';
    const really = req.kind === 'file' && facts.folder ? path.join(facts.folder, path.basename(file)) : file;
    if (req.kind === 'file' && (isNeverSent(file) || isNeverSent(really))) return this.finish(task, 'declined', `${path.basename(file)}: not allowed (Beluga never sends its own private files or your keychains)`);
    // Any other secret file is asked about on its own, every time (BLG-209).
    const kind = req.kind === 'file' ? (secretKindOf(file) ?? secretKindOf(really)) : undefined;
    const secret = kind ? { kind, label: secretLabel(kind, path.basename(file)) } : undefined;
    if (secret) this.update(task.id, { secret });
    if (facts.folder && req.kind !== 'ask') this.update(task.id, this.folderOf(facts));
    // Decided before anything about your projects is said, and a project that isn't there reads
    // like one they can't have: nobody learns your project names by asking.
    const decided = ctx.access.decide(facts, level);
    if (decided.verdict === 'decline') return this.finish(this.current(task), 'declined', declineReason(decided, me));
    if (req.kind !== 'file' && req.project && !ctx.projectRoot(req.project)) return this.finish(task, 'declined', `That isn't available on ${me}'s Mac`);
    let allowedBy: string;
    // You said yes to this very request, having seen its path: that one file may come from anywhere,
    // not only the folders you share. A rule doesn't reach that far (its folder could be your home).
    // A secret is always asked about: trust, rules and Always never cover it.
    const youChose = decided.verdict === 'ask' || Boolean(secret);
    if (secret) {
      const answer = await this.ask(this.current(task), 'request', approvalTitle(this.current(task)), this.secretDetail(req, name, secret.label), { once: true });
      if (this.isOver(task.id)) return;
      if (answer.answer === 'no') return this.finish(this.current(task), 'declined', `${me} declined${answer.reason?.trim() ? `: ${answer.reason.trim()}` : ''}`);
      // Beluga's screens offer no "Always" for it; one that comes anyway counts once and writes nothing.
      allowedBy = `you approved sending ${secretNoun(secret.label)}, this once`;
    } else if (decided.verdict === 'ask') {
      const answer = await this.ask(task, 'request', approvalTitle(task), this.detail(req, name, decided));
      if (this.isOver(task.id)) return;
      if (answer.answer === 'no') return this.finish(this.current(task), 'declined', `${me} declined${answer.reason?.trim() ? `: ${answer.reason.trim()}` : ''}`);
      if (answer.answer === 'always') {
        try {
          ctx.access.remember(facts, name, answer);
        } catch (err) {
          return this.finish(this.current(task), 'failed', `${me} said yes, but the rule couldn't be saved, so it didn't run: ${errorText(err)}`);
        }
        allowedBy = 'you approved it and made a rule for requests like it';
      } else allowedBy = 'you approved it';
    } else {
      allowedBy = decided.by === 'rule' ? 'a rule of yours allows it' : 'you trust them';
      const what = req.kind === 'run' ? `run \`${oneLine(req.command ?? '', 60)}\` on your Mac` : req.kind === 'file' ? `get ${path.basename(req.path ?? '')} from your Mac` : `ask your agent to: ${requestGist(req, 80)}`;
      ctx.notify(`${name}${req.by === 'agent' ? "'s agent" : ''}${req.via ? ` (via ${oneLine(req.via.name)})` : ''} wants to ${what}`, `It runs without asking: ${allowedBy}`);
    }
    if (this.isOver(task.id)) return;
    this.update(task.id, { allowedBy });
    if (req.kind === 'run') return this.runCommand(this.current(task), req);
    if (req.kind === 'file') return this.sendFile(this.current(task), req, facts, youChose, secret?.label);
    this.queue.push({ task: this.current(task), req, facts });
    if (this.running >= MAX_RUNNING) this.update(task.id, { state: 'queued' }, 'Waiting for your agent to finish another request');
    void this.pump();
  }

  /** Decline without keeping anything (a blocked person): the answer only, not queued for later. */
  private declineUnkept(to: string, id: string, summary: string): void {
    try {
      this.ctx.courier.send(to, { t: 'task_result', id, status: 'declined', summary, files: [], log: [], ts: this.ctx.now() }, false);
    } catch {
      // Not reachable: they ask again.
    }
  }

  onCancel(from: string, msg: TaskCancel): void {
    const task = this.ctx.book.get(msg.id);
    if (!task || task.direction !== 'received' || task.peerId !== from || isFinal(task.state)) return;
    this.halt(task, `${task.peerName} cancelled it`);
  }

  /** The requester answered a question their task's Claude asked. */
  onAnswer(from: string, msg: TaskAnswer): void {
    const w = this.questions.get(msg.qid);
    if (!w || w.from !== from || w.task !== msg.id) return;
    this.questions.delete(msg.qid);
    w.resolve(msg.skip || !msg.answers ? SKIP : { kind: 'answers', answers: msg.answers });
  }

  /** The requester fetches a piece of a big file of a result. */
  async onFileGet(from: string, msg: FileGet): Promise<void> {
    this.ctx.courier.send(from, await this.offers.chunk(from, msg), false);
  }

  /** You stop a friend's task on your Mac. */
  stopTask(id: string): boolean {
    const task = this.ctx.book.get(id);
    if (!task || task.direction !== 'received' || isFinal(task.state)) return false;
    this.halt(task, `${this.ctx.selfName()} stopped it`);
    return true;
  }

  /**
   * Your answer on the request sheet (or a notification, the menu bar): once, always (with the
   * scope and expiry of the rule it writes), or no (with a reason). False if it isn't waiting.
   */
  decide(id: string, decision: Decision): boolean {
    const resolve = this.deciders.get(id);
    if (!resolve) return false;
    resolve(decision);
    // Take the approval card back (its own answer no longer counts).
    this.approvals.get(id)?.();
    return true;
  }

  /** What's known about a request, to decide it: where it would run or read, resolved. */
  private async factsFor(from: string, req: TaskRequest): Promise<RequestFacts> {
    const base = { peerId: from, kind: ruleKindOf(req.kind), needs: req.needs, ...(req.project ? { project: req.project } : {}), ...(req.command ? { command: req.command } : {}) };
    const raw = req.kind === 'file' ? req.path : req.project ? this.ctx.projectRoot(req.project) : req.kind === 'run' ? (req.cwd ?? (await this.ctx.runFolder?.(from)) ?? this.home) : req.cwd;
    if (!raw) return base;
    const abs = path.resolve(raw === '~' ? this.home : raw.startsWith('~/') ? path.join(this.home, raw.slice(2)) : raw);
    const real = await fs.realpath(abs).catch(() => abs);
    return { ...base, folder: req.kind === 'file' ? path.dirname(real) : real };
  }

  /** What the sheet shows of where it would run (and the scope "Always" would write). */
  private folderOf(facts: RequestFacts): Partial<TaskView> {
    return facts.folder ? { folder: facts.folder } : {};
  }

  /** End a task now: cancelled (by you or them), or stopped by a limit (failed, declined). */
  private halt(task: TaskView, why: string, status: ResultStatus = 'cancelled'): void {
    this.approvals.get(task.id)?.();
    const queued = this.queue.findIndex((q) => q.task.id === task.id);
    if (queued >= 0) this.queue.splice(queued, 1);
    for (const [qid, q] of this.questions) if (q.task === task.id) (this.questions.delete(qid), q.resolve(SKIP));
    this.finish(this.current(task), status, why);
    this.controllers.get(task.id)?.abort();
    this.offers.drop(task.id);
  }

  private detail(req: TaskRequest, name: string, decided: AccessDecision): string {
    const where = req.kind === 'file' ? `from ${req.path}` : req.project ? `in your project ${req.project}` : req.kind === 'run' ? `in ${req.cwd ?? 'your shared folder'}` : 'in a new scratch folder (~/.beluga/tasks/work)';
    const needs = req.needs.length ? req.needs.map((n) => NEED_WORDS[n]).join(', ') : 'nothing special';
    const back = req.kind === 'run' ? 'the output' : req.kind === 'file' ? 'the file' : req.expects === 'files' ? 'files' : req.expects ? 'structured data (JSON)' : 'a summary';
    const why = decided.by === 'rule' ? ' · a rule of yours says to ask' : decided.caps?.length ? ` · you asked to be asked before friends’ agents ${decided.caps.map((n) => NEED_WORDS[n]).join(' or ')}` : '';
    return [
      req.kind === 'run' ? `$ ${req.command ?? ''}${req.ask !== req.command ? `\nwhy: ${req.ask.slice(0, 500)}` : ''}` : req.ask.slice(0, 2000),
      '',
      `Needs: ${needs} · runs ${where} · sends back ${back}${req.deadline ? ` · by ${new Date(req.deadline).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}${why}`,
      `Always = allow requests like this from ${name} (same kind and needs${req.project ? `, in ${req.project}` : ''}); it becomes a rule you can change in Settings › People & access`,
    ].join('\n');
  }

  /** What a secret's approval says: where it is, why, and that nothing covers it next time. */
  private secretDetail(req: TaskRequest, name: string, label: string): string {
    return [
      `${req.path ?? ''}${req.ask && !req.ask.startsWith('Send me ') ? `\nwhy: ${req.ask.slice(0, 500)}` : ''}`,
      '',
      `This is a secret (${secretNoun(label)}). If you allow it, Beluga sends this one file to ${name}, and ${name}'s agent is told you approved it.`,
      "You're asked each time: trust, your rules and Always never cover a secret.",
    ].join('\n');
  }

  /** A path as it names a place here (`~` is your home). */
  private expand(p: string): string {
    return path.resolve(p === '~' ? this.home : p.startsWith('~/') ? path.join(this.home, p.slice(2)) : p);
  }

  private async ask(task: TaskView, kind: 'request' | 'tool', title: string, detail: string, opts: ApproveOpts = {}): Promise<Decision> {
    this.update(task.id, { state: 'awaiting_approval' }, kind === 'tool' ? title : undefined);
    const chat = this.current(task).chat;
    const pending = this.ctx.approve(kind, title, detail, task.peerId, kind === 'request' ? task.id : undefined, { ...opts, ...(chat ? { conversation: chat } : {}) });
    this.approvals.set(task.id, pending.withdraw);
    let fromSheet!: (d: Decision) => void;
    const sheet = new Promise<Decision>((resolve) => (fromSheet = resolve));
    if (kind === 'request') this.deciders.set(task.id, fromSheet);
    try {
      return await Promise.race([pending.answer.then((answer) => Decision.parse({ answer })), sheet]);
    } finally {
      this.approvals.delete(task.id);
      this.deciders.delete(task.id);
    }
  }

  private async pump(): Promise<void> {
    while (this.running < MAX_RUNNING && this.queue.length) {
      const next = this.queue.shift()!;
      if (this.isOver(next.task.id)) continue;
      this.running++;
      void this.runAsk(this.current(next.task), next.req).finally(() => {
        this.running--;
        void this.pump();
      });
    }
  }

  /** The place a task runs: the project it names, else a fresh scratch folder; plus your chosen folders when it may touch files. */
  private place(task: TaskView, req: TaskRequest): { place: AgentPlace; where: string; folders: string[] } {
    const caps = this.ctx.access.capabilities();
    const folders = req.needs.includes('files') && capFor(caps, 'files', this.ctx.trustFor(task.peerId)) !== 'off' ? caps.folders.filter((f) => !isSecretPath(f)) : [];
    const root = req.project ? this.ctx.projectRoot(req.project) : undefined;
    if (root) return { place: { cwd: root, additionalDirectories: folders, autoEdit: false, onSession: () => undefined }, where: `in ${req.project}`, folders };
    const dir = this.ctx.book.workDir(task.id, this.ctx.scratch);
    return { place: { cwd: dir, additionalDirectories: folders, autoEdit: true, onSession: () => undefined }, where: 'in a scratch folder', folders };
  }

  /** The tools a task gets for what it needed and was let in for: the screen, device info. */
  private toolsFor(task: TaskView, req: TaskRequest): TaskTools {
    const tools: { screenshot?: TaskTools['screenshot']; deviceInfo?: TaskTools['deviceInfo'] } = {};
    if (req.needs.includes('screen')) {
      tools.screenshot = async (app) => {
        const tooMany = this.shotLimit(task.id);
        if (tooMany) throw new Error(tooMany);
        this.shots.set(task.id, (this.shots.get(task.id) ?? 0) + 1);
        const dir = path.join(this.ctx.book.workDir(task.id, this.ctx.scratch), 'screens');
        const shot = await captureScreen(this.system, dir, app ? { app } : {});
        this.artifacts.set(task.id, [...(this.artifacts.get(task.id) ?? []), shot.file]);
        this.keepStep(task.id, `Took a screenshot of ${shot.of}`);
        const image = shot.view ? { data: (await fs.readFile(shot.view)).toString('base64'), mimeType: shot.view.endsWith('.png') ? 'image/png' : 'image/jpeg' } : undefined;
        return { text: `Screenshot of ${shot.of} (${Math.round(shot.bytes / 1024)} KB). It goes back to ${task.peerName} with your answer.`, ...(image ? { image } : {}) };
      };
    }
    if (req.needs.includes('device')) {
      tools.deviceInfo = async () => {
        const info = await deviceInfo(this.system);
        this.keepStep(task.id, 'Read the device information');
        return `${describeDevice(info)}\n\nAs JSON:\n${JSON.stringify(info, null, 2)}`;
      };
    }
    return tools;
  }

  private async runAsk(task: TaskView, req: TaskRequest): Promise<void> {
    const { ctx } = this;
    const agent = ctx.agent();
    if (!agent) return this.finish(task, 'failed', `${ctx.selfName()}'s agent isn't running`);
    const found = this.place(task, req);
    const { where, folders } = found;
    // On the agent its card says (your default), or the one they asked for when it runs here (BLG-503).
    // One that can't take a friend's task (OpenCode) hands it on (BLG-686).
    const picked = ctx.agentRef ? agentForFriend(agentForAsk(req.agent, ctx.agentRef(), ctx.agents?.() ?? [], ctx.runs), ctx.agents?.() ?? [], ctx.runs) : undefined;
    if (picked) this.ranOn.set(task.id, picked.agent);
    // A talk (or cross-reference) dialogue's turn changes nothing, on any agent: no edits, even in a scratch folder.
    const withAgent = picked ? { ...found.place, agent: picked.agent } : found.place;
    const place = task.dialogue && task.dialogue.mode !== 'work' ? { ...withAgent, autoEdit: false } : withAgent;
    // Settings' model is Claude's: another agent takes its own pick, or its default.
    const settings = ctx.model();
    const model = picked ? (picked.agent.model ?? (picked.agent.runtime === 'claude' ? settings.model : undefined)) : settings.model;
    const runModel = { ...(model ? { model } : {}), ...(settings.effort ? { effort: settings.effort } : {}) };
    const trust = ctx.trustFor(task.peerId);
    const full = trust === 'full';
    const tools = this.toolsFor(task, req);
    // Working in one of your projects, a friend you trust gets its board too (BLG-701): Full trust
    // freely, Trusted with each change asking you (a talk dialogue only looks: none).
    const board = req.project && found.where !== 'in a scratch folder' && (full || trust === 'trusted') && !(task.dialogue && task.dialogue.mode !== 'work') ? ctx.board?.(req.project, { id: task.peerId, name: task.peerName }) : undefined;
    const toolNames = [...(tools.screenshot ? ['screenshot'] : []), ...(tools.deviceInfo ? ['device_info'] : [])];
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    this.update(task.id, { state: 'working', startedAt: ctx.now(), where }, picked?.note);
    let lastSent = 0;
    let held: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    const step = (text: string): void => {
      // Steps are kept here at once; the other side hears at most a few a second.
      this.keepStep(task.id, text);
      held = text;
      const wait = STEP_EVERY_MS - (ctx.now() - lastSent);
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        lastSent = ctx.now();
        if (held && !this.isOver(task.id)) this.sendUpdate(task.id, 'working', held);
      }, Math.max(0, wait));
      timer.unref?.();
    };
    // A friend's task never runs on and on: 20 minutes in all, or until its deadline if that's sooner.
    const limitMs = ctx.runLimitMs ?? RUN_LIMIT_MS;
    const byDeadline = req.deadline !== undefined && req.deadline - ctx.now() < limitMs;
    const limit = setTimeout(
      () => {
        const took = limitMs >= 60_000 ? `${Math.round(limitMs / 60_000)} minutes` : `${Math.round(limitMs / 1000)} seconds`;
        if (!this.isOver(task.id)) this.halt(task, byDeadline ? 'Stopped: its deadline passed' : `Stopped after ${took}`, 'failed');
      },
      Math.max(0, byDeadline ? req.deadline! - ctx.now() : limitMs),
    );
    limit.unref?.();
    try {
      const final = await agent.run({
        prompt: taskPrompt(req, ctx.selfName(), where, { tools: toolNames, folders }),
        requesterName: task.peerName,
        viaAgent: req.by === 'agent',
        context: [],
        place,
        // None of your conversations is this task's: what its Claude posts goes to the group chat.
        channel: 'room',
        scope: full ? 'full' : 'folder',
        signal: controller.signal,
        onEvent: (kind, text) => {
          if (kind === 'tool' && text) step(text.slice(0, 300));
        },
        onFileTouched: () => undefined,
        // A talk (or cross-reference) dialogue's turn only looks, here too; then their limits as for any task.
        vetTool: (tool, input) => (task.dialogue && task.dialogue.mode !== 'work' ? talkReadOnly(tool, input) : undefined) ?? this.vetTool(this.current(task), tool, input),
        canUseTool: (tool, input) => this.authorizeTool(task, tool, input, full, place.cwd),
        askUser: (question) => this.askRequester(task, question, controller.signal),
        ...(toolNames.length ? { taskTools: tools } : {}),
        ...(board?.tools ? { board: board.tools, ...(board.brief ? { taskBrief: board.brief } : {}), ...(full ? {} : { boardAsks: 'writes' as const }) } : {}),
        ...runModel,
        maxTurns: MAX_TURNS,
      });
      clearTimeout(timer);
      if (controller.signal.aborted || this.isOver(task.id)) return;
      const parsed = parseAnswer(final || '(done)', req.expects);
      const shots = this.artifacts.get(task.id) ?? [];
      const wanted = [...shots, ...parsed.files.filter((f) => !shots.includes(f))].slice(0, MAX_FILES);
      const roots = [place.cwd, ...folders, ...(shots.length ? [path.dirname(shots[0]!)] : [])];
      const { files, skipped } = await readResultFiles(wanted, { roots, anywhere: full, home: this.home, offer: (file) => this.offers.offer(task.id, task.peerId, file) });
      const problems = [...parsed.problems, ...skipped.map((s) => `file not sent: ${s}`)];
      this.finish(this.current(task), 'done', parsed.summary, {
        ...(parsed.data !== undefined ? { data: parsed.data } : {}),
        files,
        ...(problems.length ? { problems } : {}),
      });
    } catch (err) {
      clearTimeout(timer);
      if (this.isOver(task.id)) return;
      const why = controller.signal.aborted ? 'Stopped' : /max.turns/i.test(errorText(err)) ? `Stopped after ${MAX_TURNS} turns` : errorText(err);
      this.finish(this.current(task), 'failed', why);
    } finally {
      clearTimeout(limit);
      this.controllers.delete(task.id);
      this.artifacts.delete(task.id);
      this.asked.delete(task.id);
      this.shots.delete(task.id);
      this.toolAsks.delete(task.id);
    }
  }

  /**
   * Your Claude, working on their task, asks something: it goes back to the requester (their
   * Claude answers first, from what it knows, else they do). No answer in time: it goes on.
   */
  private async askRequester(task: TaskView, question: ClaudeQuestion, signal: AbortSignal): Promise<ClaudeAnswer> {
    if (question.kind !== 'question' || this.isOver(task.id)) return SKIP;
    const count = this.asked.get(task.id) ?? 0;
    if (count >= MAX_QUESTIONS) return SKIP;
    this.asked.set(task.id, count + 1);
    const qid = `q_${randomBytes(9).toString('base64url')}`;
    const questions = question.questions.map((q) => ({ question: q.question, header: q.header, options: q.options, multiSelect: q.multiSelect }));
    try {
      this.ctx.courier.send(task.peerId, { t: 'task_question', id: task.id, qid, questions, ts: this.ctx.now() }, true);
    } catch {
      return SKIP;
    }
    this.update(task.id, {}, `Asked ${task.peerName}: ${oneLine(questions[0]!.question, 140)}`);
    const answer = await new Promise<ClaudeAnswer>((resolve) => {
      const timer = setTimeout(() => {
        this.questions.delete(qid);
        resolve(SKIP);
      }, this.ctx.questionWaitMs ?? QUESTION_WAIT_MS);
      timer.unref?.();
      const done = (a: ClaudeAnswer): void => {
        clearTimeout(timer);
        resolve(a);
      };
      this.questions.set(qid, { task: task.id, from: task.peerId, resolve: done });
      signal.addEventListener('abort', () => (this.questions.delete(qid), done(SKIP)), { once: true });
    });
    if (!this.isOver(task.id)) this.update(task.id, {}, answer.kind === 'answers' ? `${task.peerName} answered` : `No answer from ${task.peerName}: going on`);
    return answer;
  }

  /** A tool's call, as the capability it uses, decided like a request (none: the tool needs no capability). */
  private toolAccess(task: TaskView, tool: string, input: Record<string, unknown>): { needs: Need[]; decided: AccessDecision } | undefined {
    const needs = toolNeeds(tool, input);
    if (!needs.length) return undefined;
    const facts: RequestFacts = { peerId: task.peerId, kind: 'task', needs, ...(task.project ? { project: task.project } : {}) };
    return { needs, decided: this.ctx.access.decide(facts, this.ctx.trustFor(task.peerId)) };
  }

  /** Why one more screenshot can't be taken (undefined: it can). */
  private shotLimit(id: string): string | undefined {
    return (this.shots.get(id) ?? 0) >= MAX_SCREENSHOTS ? `At most ${MAX_SCREENSHOTS} screenshots per request. Don't take more; answer with what you have.` : undefined;
  }

  /** Checked before every tool call of a friend's task: a capability that is Off, or a Decline rule, holds even with full trust. */
  private vetTool(task: TaskView, tool: string, input: Record<string, unknown>): string | undefined {
    // A command that takes a screenshot is the screen: only for a request let in to see it, and it counts toward the cap.
    if (takesScreenshot(tool, input)) {
      if (!task.needs.includes('screen')) return `This request wasn't let in to see ${this.ctx.selfName()}'s screen. Don't try another way; say so in your answer.`;
      const tooMany = this.shotLimit(task.id);
      if (tooMany) return tooMany;
    }
    const access = this.toolAccess(task, tool, input);
    if (access?.decided.verdict !== 'decline') return undefined;
    const off = access.decided.caps?.length ? access.decided.caps : access.needs;
    return `${this.ctx.selfName()} doesn't let friends' agents ${off.map((n) => CAP_INFO[n].doing).join(' or ')} here${access.decided.by === 'rule' ? ' (a rule for this person)' : ''}. Don't try another way; say so in your answer.`;
  }

  private async authorizeTool(task: TaskView, tool: string, input: Record<string, unknown>, full: boolean, cwd: string): Promise<boolean> {
    const ok = await this.allowTool(task, tool, input, full, cwd);
    // A screenshot by command, let through: it counts like the screenshot tool's.
    if (ok && takesScreenshot(tool, input)) {
      if (this.shotLimit(task.id)) return false;
      this.shots.set(task.id, (this.shots.get(task.id) ?? 0) + 1);
      this.keepStep(task.id, 'Took a screenshot with a command');
    }
    return ok;
  }

  private async allowTool(task: TaskView, tool: string, input: Record<string, unknown>, full: boolean, cwd: string): Promise<boolean> {
    const access = this.toolAccess(task, tool, input);
    if (access?.decided.verdict === 'decline') return false;
    if (full) return true;
    // Commands are allowed for this person (their trust level's setting, or a rule): no need to ask.
    if (tool === 'Bash' && access?.decided.verdict === 'allow') return true;
    // A file that runs code later (a git hook, npm scripts…; BLG-413): asked each time, once.
    if (writesCode(tool, input, cwd)) {
      const file = String(input.file_path ?? input.notebook_path);
      return (await this.askTool(task, `Your agent (working on ${task.peerName}'s request) wants to change ${path.basename(file)}, a file that can run commands on your Mac`, file, { once: true })) !== 'no';
    }
    const scope = `${task.peerId}:${tool}`;
    if (this.alwaysTools.has(scope)) return true;
    const detail = typeof input.command === 'string' ? input.command : JSON.stringify(input).slice(0, 2000);
    const answer = await this.askTool(task, `Your agent (working on ${task.peerName}'s request) wants to use ${tool.replace(/^mcp__beluga__/, '')}`, detail);
    if (answer === 'always') this.alwaysTools.add(scope);
    return answer !== 'no';
  }

  /**
   * Ask you to approve one step of a friend's task. A task that keeps asking stops (BLG-427):
   * after MAX_TOOL_ASKS approvals, or when you decline MAX_DECLINES in a row; the requester hears why.
   */
  private async askTool(task: TaskView, title: string, detail: string, opts: ApproveOpts = {}): Promise<Decision['answer']> {
    const me = this.ctx.selfName();
    const count = this.toolAsks.get(task.id) ?? { asked: 0, declined: 0 };
    if (count.asked >= MAX_TOOL_ASKS) {
      this.halt(task, `Stopped: it needed ${me}'s approval more than ${MAX_TOOL_ASKS} times. Ask for less at once, or ask ${me} to allow it`, 'failed');
      return 'no';
    }
    count.asked++;
    this.toolAsks.set(task.id, count);
    const answer = await this.ask(task, 'tool', title, detail, opts);
    if (this.isOver(task.id)) return 'no';
    count.declined = answer.answer === 'no' ? count.declined + 1 : 0;
    if (count.declined >= MAX_DECLINES) {
      this.halt(task, `Stopped: ${me} declined ${MAX_DECLINES} of its steps in a row${answer.reason?.trim() ? ` (${answer.reason.trim()})` : ''}`, 'declined');
      return 'no';
    }
    this.update(task.id, { state: 'working' });
    return answer.answer;
  }

  private async runCommand(task: TaskView, req: TaskRequest): Promise<void> {
    const { ctx } = this;
    if (!ctx.serveShell || !req.command) return this.finish(task, 'failed', `${ctx.selfName()}'s Beluga can't run commands for others here`);
    try {
      const reply = await ctx.serveShell(
        task.peerId,
        { command: req.command, timeoutSec: req.timeoutSec ?? 120, why: req.ask === req.command ? '' : oneLine(req.ask, 500), ...(req.cwd ? { cwd: req.cwd } : {}), ...(req.project ? { project: req.project } : {}) },
        {
          approved: true,
          onAsking: () => this.update(task.id, { state: 'awaiting_approval' }),
          onStarted: (cwd) => {
            this.update(task.id, { state: 'working', startedAt: ctx.now(), where: cwd }, `$ ${oneLine(req.command ?? '', 200)}`);
          },
        },
      );
      if (this.isOver(task.id)) return;
      if (!reply.ok) return this.finish(this.current(task), /declin|blocked/i.test(reply.error ?? '') ? 'declined' : 'failed', reply.error ?? 'It did not run');
      const head = reply.timedOut ? 'Stopped: it ran out of time' : `Exit code ${reply.exitCode ?? '?'}`;
      this.finish(this.current(task), 'done', `${head} on ${ctx.selfName()}'s Mac, in ${reply.cwd ?? 'their folder'}.${reply.truncated ? ' The output was long; this is its end.' : ''}\n\n${reply.output || '(no output)'}`, {
        data: { exitCode: reply.exitCode ?? null, output: reply.output ?? '', cwd: reply.cwd ?? null, timedOut: Boolean(reply.timedOut), truncated: Boolean(reply.truncated), ms: reply.ms ?? null },
      });
    } catch (err) {
      if (!this.isOver(task.id)) this.finish(this.current(task), 'failed', errorText(err));
    }
  }

  /** One file, sent by Beluga itself: from the folders you chose (anywhere with full trust); a secret only the time you approve it. */
  private async sendFile(task: TaskView, req: TaskRequest, facts: RequestFacts, youChose: boolean, secret?: string): Promise<void> {
    try {
      await this.readAndSend(task, req, facts, youChose, secret);
    } catch (err) {
      if (!this.isOver(task.id)) this.finish(this.current(task), 'failed', `${this.ctx.selfName()}'s Beluga couldn't read it: ${errorText(err)}`);
    }
  }

  private async readAndSend(task: TaskView, req: TaskRequest, facts: RequestFacts, youChose: boolean, secret?: string): Promise<void> {
    const { ctx } = this;
    const me = ctx.selfName();
    const full = ctx.trustFor(task.peerId) === 'full' || youChose;
    const folders = ctx.access.capabilities().folders;
    if (!full && !folders.length) return this.finish(task, 'declined', `${me} hasn't chosen any folders friends may take files from`);
    const name = path.basename(req.path ?? '');
    this.update(task.id, { state: 'working', startedAt: ctx.now(), where: facts.folder ?? '' }, `Reading ${name}`);
    const { files, skipped } = await readResultFiles([req.path ?? ''], { roots: folders, anywhere: full, home: this.home, offer: (file) => this.offers.offer(task.id, task.peerId, file), ...(secret ? { secretApproved: true } : {}) });
    if (this.isOver(task.id)) return;
    const file = files[0];
    if (!file?.b64 && !file?.ref) {
      const why = skipped[0] ?? `${name} (not found)`;
      return this.finish(this.current(task), /not allowed|outside/.test(why) ? 'declined' : 'failed', `${me}'s Beluga didn't send it: ${why}`);
    }
    const size = `${file.name} (${Math.max(1, Math.round(file.size / 1024))} KB) from ${me}'s Mac`;
    if (secret) return this.finish(this.current(task), 'done', `${size}: a secret (${secretNoun(secret)}) that ${me} approved sending you.`, { files: [file], secret: secretNoun(secret) });
    this.finish(this.current(task), 'done', `${size}.`, { files: [file] });
  }

  // ---- state

  private current(task: TaskView): TaskView {
    return this.ctx.book.get(task.id) ?? task;
  }

  private isOver(id: string): boolean {
    const t = this.ctx.book.get(id);
    return !t || isFinal(t.state);
  }

  private keepStep(id: string, step: string): void {
    const t = this.ctx.book.get(id);
    if (!t || isFinal(t.state)) return;
    this.ctx.put({ ...t, steps: [...t.steps, step].slice(-MAX_STEPS), updatedAt: this.ctx.now() });
  }

  private update(id: string, change: Partial<TaskView>, step?: string): void {
    const t = this.ctx.book.get(id);
    if (!t || isFinal(t.state)) return;
    const next = this.ctx.put({ ...t, ...change, ...(step ? { steps: [...t.steps, step].slice(-MAX_STEPS) } : {}), updatedAt: this.ctx.now() });
    if (next.state === 'queued' || next.state === 'awaiting_approval' || next.state === 'working') this.sendUpdate(id, next.state, step);
  }

  private sendUpdate(id: string, state: 'queued' | 'awaiting_approval' | 'working', step?: string): void {
    const t = this.ctx.book.get(id);
    if (!t) return;
    this.ctx.courier.send(t.peerId, { t: 'task_update', id, state, ...(step ? { step: step.slice(0, 300) } : {}), ts: this.ctx.now() }, false);
  }

  /** The end: kept here, and the result goes back to the requester (waiting in the outbox if they're offline). */
  private finish(task: TaskView, status: ResultStatus, summary: string, extra: { data?: unknown; files?: ReadonlyArray<{ name: string; size: number; b64?: string; ref?: string; sha256?: string; image?: boolean }>; problems?: readonly string[]; secret?: string } = {}): void {
    const t = this.current(task);
    if (isFinal(t.state)) return;
    const files = extra.files ?? [];
    const result: TaskOutcome = {
      status,
      summary,
      ...(t.kind === 'ask' && this.ctx.agentRef ? { agent: this.ranOn.get(t.id) ?? this.ctx.agentRef() } : {}),
      // What's offered for fetching stays known (the result may have to be sent again); inline bytes don't.
      files: files.map((f) => ({ name: f.name, size: f.size, ...(f.image ? { image: true } : {}), ...(f.ref ? { ref: f.ref } : {}), ...(f.sha256 ? { sha256: f.sha256 } : {}) })),
      log: t.steps,
      ...(extra.data !== undefined ? { data: extra.data } : {}),
      ...(extra.problems?.length ? { problems: extra.problems } : {}),
      ...(extra.secret ? { secret: extra.secret } : {}),
    };
    this.ranOn.delete(t.id);
    const done = this.ctx.put({ ...t, state: status, result, endedAt: this.ctx.now(), updatedAt: this.ctx.now() });
    this.sendResult(done, result, files);
    if (done.dialogue) this.ctx.dialogues?.turn(done);
  }

  /** Tell the friend who asked how their task ended (also: one that ended when Beluga quit). */
  sendResult(task: TaskView, result: TaskOutcome, files: ReadonlyArray<{ name: string; size: number; b64?: string; ref?: string; sha256?: string; image?: boolean }> = result.files): void {
    try {
      this.ctx.courier.send(
        task.peerId,
        {
          t: 'task_result',
          id: task.id,
          status: result.status,
          summary: result.summary,
          files: files.map((f) => ({ name: path.basename(f.name), size: f.size, ...(f.b64 ? { b64: f.b64 } : {}), ...(f.ref ? { ref: f.ref } : {}), ...(f.sha256 ? { sha256: f.sha256 } : {}), ...(f.image ? { image: true } : {}) })),
          log: result.log.slice(-60),
          ts: this.ctx.now(),
          ...(result.data !== undefined ? { data: result.data } : {}),
          ...(result.secret ? { secret: result.secret } : {}),
          ...(result.agent ? { agent: result.agent } : {}),
        },
        true,
      );
    } catch {
      // The outbox is full: the requester asks again (or the task shows as unanswered there).
    }
  }
}

export const defaultScratch = (): string => path.join(os.tmpdir(), 'beluga-tasks');
