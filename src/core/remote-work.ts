import { randomUUID } from 'node:crypto';
import { promises as fs, rmSync } from 'node:fs';
import os from 'node:os';
import { tilde } from './paths.js';
import path from 'node:path';
import { type BodyInput, type BodyOf, type HandoffReason, defaultAgentOf, MAX_DOWNLOAD_BYTES, wsWireName } from '../protocol.js';
import { agentLabel, agentName } from '../shared/agent-label.js';
import { git } from '../workspaces/git.js';
import { cannotTake } from '../net/mesh/features.js';
import { belugaHome } from '../workspaces/store.js';
import { formatBytes } from '../workspaces/disk.js';
import { type Requester, downloadFile, fetchBytes, safeFileName, uniquePath } from './downloads.js';
import type { NoticeEvent } from './notify.js';
import { type ShareService, isSecretPath } from './shares.js';
import { type LogItem, type Store, clean, peerName } from './store.js';
import { trustOf } from './trust.js';
import type { WorkspaceController } from './workspace-controller.js';
import type { WorkspaceSharing } from './workspace-sharing.js';
import type { Workspace } from '../workspaces/types.js';
import type { Intent } from './intents.js';
import { type HandoffNoteMode, MAX_NOTE_CHARS, continuePrompt, fallbackNote, handoffNotePrompt, noteFile, saveHandoffNote } from './handoff-note.js';

export { continuePrompt, handoffNotePrompt } from './handoff-note.js';

export interface RemoteWorkDeps {
  readonly store: Store;
  readonly selfId: () => string;
  readonly send: (body: BodyInput, opts: { to: string }) => boolean;
  /** Request/response over the room (used for file chunks). */
  readonly request: Requester;
  readonly shares: ShareService;
  readonly controller?: WorkspaceController;
  readonly sharing: WorkspaceSharing;
  /** Ask the owner (you) to approve something for `peer`. */
  readonly approve: (title: string, detail: string, peer: string) => Promise<boolean>;
  /** Run your Claude with text from someone else; their trust level decides what it may do. */
  readonly runOnBehalf: (from: string, channel: string, prompt: string) => void;
  /** Run your Claude for someone else, in one of your workspaces. */
  readonly runFor: (from: string, channel: string, prompt: string, plan: boolean) => void;
  /** Ask your own Claude in a conversation and wait for its answer. */
  readonly askAndWait: (prompt: string, channel: string, timeoutMs: number) => Promise<string>;
  readonly askOwnClaude: (prompt: string, channel: string) => void;
  readonly nameTask: (prompt: string) => Promise<string>;
  readonly notify: (event: NoticeEvent) => void;
  readonly toast: (text: string, level?: 'info' | 'success' | 'warn' | 'error') => void;
  /** Ask the screen to go somewhere, open a dialog or close a tab (see core/intents.ts). */
  readonly intend: (intent: Intent) => void;
  readonly onWorktreeCreated?: (ws: Workspace) => void;
  /** Where downloads land (default ~/Downloads/Beluga). */
  readonly downloadDir?: string;
  /** How long a request waits for the other person (default 6 minutes: approvals take time). */
  readonly waitMs?: number;
  /** How long "do you have this repository?" waits before a handoff goes ahead anyway (default 8 seconds). */
  readonly checkWaitMs?: number;
}

type Waiter = { peer: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

const OUTBOX_TTL_MS = 15 * 60_000;
const NO_REMOTE = 'This project has no origin remote, so the other computer could not find the same repository';
/** A handoff's branch waits longer: a friend outside the room may be offline when it's offered (BLG-341). */
const HANDOFF_TTL_MS = 60 * 60_000;
const AUTO_ACCEPT_BYTES = 50 * 1024 * 1024;
const AUTO_ACCEPT_PER_10_MIN = 10;

/** Files waiting to be fetched by someone. Private to you; old ones are swept, yours removed on quit. */
export const outboxDir = (): string => path.join(belugaHome(), 'outbox');

const mine = new Set<string>();
process.once('exit', () => {
  for (const dir of mine) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Already gone.
    }
  }
});

/** Remove outbox copies older than their lifetime (e.g. left by a Beluga that crashed). */
export async function sweepOutbox(now = Date.now()): Promise<number> {
  const entries = await fs.readdir(outboxDir()).catch(() => [] as string[]);
  let removed = 0;
  for (const name of entries) {
    const dir = path.join(outboxDir(), name);
    const stat = await fs.stat(dir).catch(() => undefined);
    if (stat && now - stat.mtimeMs > OUTBOX_TTL_MS) {
      await fs.rm(dir, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}
const NOTE_TIMEOUT_MS = 5 * 60_000;
/** Nobody approves the check before a handoff, so its answer comes quickly or not at all (an older Beluga). */
const CHECK_WAIT_MS = 8_000;

/** What a handoff is about, to say why it didn't go through. */
export interface HandoffWhat {
  /** Who it was handed to. */
  readonly who: string;
  readonly project: string;
  readonly remote: string;
}

/** An older Beluga only sends its error's words: read the reason back out of them. */
function legacyReason(error = ''): HandoffReason {
  if (/don't have that repository/i.test(error)) return 'no_repo';
  if (/turned off work from friends/i.test(error)) return 'off';
  if (/branch name is not allowed/i.test(error)) return 'bad_branch';
  if (!error.trim() || /^declined$/i.test(error.trim())) return 'declined';
  return 'failed';
}

/** Why a handoff didn't (or can't) go through, in words for the one handing off (BLG-614). */
export function handoffProblem(reason: HandoffReason | undefined, error: string | undefined, what: HandoffWhat): string {
  const { who, project } = what;
  switch (reason ?? legacyReason(error)) {
    case 'no_repo':
      return `${who} doesn't have ${project || 'this repository'} on their Mac. Ask them to clone ${what.remote || 'it'} and add it to Beluga, then hand it off again`;
    case 'off':
      return `${who} has turned off work from friends (Settings › Workspaces › Friends may start work here)`;
    case 'bad_branch':
      return `${who}'s Beluga didn't accept this branch's name. Rename the branch, then hand it off again`;
    case 'declined':
      return `${who} said no to taking it over`;
    default:
      return `${who}'s Beluga couldn't set it up${error?.trim() ? `: ${error.trim()}` : ''}`;
  }
}

/** A branch or ref name that's safe to hand to git (never an option, no traversal). */
export const safeRef = (name: string): boolean => /^(?!-)[\w][\w./-]{0,199}$/.test(name) && !name.includes('..') && !name.includes('//') && !name.endsWith('/') && !name.endsWith('.lock');

/** "~/Desktop/a.pdf" → absolute, on this computer. */
export function expandPath(p: string, home = os.homedir()): string {
  const trimmed = p.trim();
  if (trimmed === '~') return home;
  if (/^~[\\/]/.test(trimmed)) return path.join(home, trimmed.slice(2));
  return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.join(home, trimmed);
}

/**
 * Working on each other's computers: start a worktree on a friend's machine, hand a
 * workspace over to them, and move files between computers (for you or your Claudes).
 * Whoever owns the computer approves, unless they fully trust you.
 */
export class RemoteWork {
  private readonly waiters = new Map<string, Waiter>();
  /** Workspaces you asked friends to start, opened as soon as they're shared with you. */
  private readonly opening = new Set<string>();
  /** Handoffs you offered (hid → your workspace and who gets it). */
  private readonly handoffs = new Map<string, { wsId: string; to: string; project: string; remote: string; share?: string }>();
  /** People your Claude is waiting on: files they send are saved without asking. */
  private readonly expecting = new Map<string, number>();
  private readonly received = new Map<string, number[]>();
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: RemoteWorkDeps) {
    this.unsubscribe = deps.store.subscribe(() => this.openRequested());
    void sweepOutbox();
  }

  stop(): void {
    this.unsubscribe();
    for (const w of this.waiters.values()) {
      clearTimeout(w.timer);
      w.reject(new Error('Session closed'));
    }
    this.waiters.clear();
  }

  private get state() {
    return this.deps.store.getState();
  }

  private name(peerId: string): string {
    return peerName(this.state, peerId);
  }

  /** "bob (#a1b2c3)": names can be copied, the key-derived id can't. Used where you approve things. */
  /** "your Claude" (or your Codex…): the agent that does the work here. */
  private yours(capital = false): string {
    return agentLabel(defaultAgentOf(this.deps.store.getState().self), undefined, true, { capital });
  }

  private who(peerId: string): string {
    return `${this.name(peerId)} (#${peerId.slice(0, 6)})`;
  }

  private wait<T>(id: string, peer: string, ms = this.deps.waitMs ?? 6 * 60_000): Promise<T> {
    const answer = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`${this.name(peer)} did not answer in time`));
      }, ms);
      timer.unref?.();
      this.waiters.set(id, { peer, resolve: resolve as (v: unknown) => void, reject, timer });
    });
    // Callers always await it; this only keeps an abandoned wait from crashing the process.
    answer.catch(() => undefined);
    return answer;
  }

  private cancelWait(id: string): void {
    const w = this.waiters.get(id);
    if (!w) return;
    clearTimeout(w.timer);
    this.waiters.delete(id);
  }

  private settle(from: string, id: string, value: unknown): void {
    const w = this.waiters.get(id);
    if (!w || w.peer !== from) return;
    clearTimeout(w.timer);
    this.waiters.delete(id);
    w.resolve(value);
  }

  /** Your Claude is working with someone (asked their Claude): accept what they send back. */
  expectFrom(peerId: string, ms = 30 * 60_000): void {
    this.expecting.set(peerId, Date.now() + ms);
  }

  private expected(peerId: string): boolean {
    return (this.expecting.get(peerId) ?? 0) > Date.now();
  }

  /** At most a few files per person per 10 minutes arrive without asking. */
  private withinQuota(peerId: string): boolean {
    const now = Date.now();
    const recent = (this.received.get(peerId) ?? []).filter((t) => now - t < 10 * 60_000);
    if (recent.length >= AUTO_ACCEPT_PER_10_MIN) return false;
    this.received.set(peerId, [...recent, now]);
    return true;
  }

  /** May this person start work here? Asks you unless you fully trust them. */
  private async allowed(from: string, title: string, detail: string): Promise<boolean> {
    const level = trustOf(this.state, from);
    if (level === 'blocked') return false;
    if (level === 'full') return true;
    return this.deps.approve(title, detail, from);
  }

  // ------------------------------------------------------------ outbox

  /** Copy one file into a private, one-person share (so nothing else in its folder is exposed). */
  private async offerFile(abs: string, to: string): Promise<{ share: string; path: string; name: string; size: number }> {
    const real = await fs.realpath(abs).catch(() => abs);
    if (isSecretPath(abs) || isSecretPath(real)) throw new Error('That file holds secrets, so Beluga never sends it');
    const stat = await fs.stat(real).catch(() => undefined);
    if (!stat?.isFile()) throw new Error(`${abs} is not a file`);
    if (stat.size > MAX_DOWNLOAD_BYTES) throw new Error(`${path.basename(abs)} is larger than ${formatBytes(MAX_DOWNLOAD_BYTES)}`);
    const id = randomUUID().slice(0, 12);
    const dir = path.join(outboxDir(), id);
    const name = safeFileName(path.basename(abs));
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    mine.add(dir);
    await fs.copyFile(real, path.join(dir, name));
    await fs.chmod(path.join(dir, name), 0o600);
    const share = `out-${id}`;
    this.deps.shares.upsert({ name: share, root: dir, writable: false, private: true, allowed: [to] });
    setTimeout(() => {
      this.deps.shares.remove(share);
      void fs.rm(dir, { recursive: true, force: true });
    }, OUTBOX_TTL_MS).unref?.();
    return { share, path: name, name, size: stat.size };
  }

  // --------------------------------------------------------- files: ask for one

  /**
   * Get a file from anywhere on a friend's computer (they approve unless they fully trust you).
   * Saved to `saveTo` (a folder) or ~/Downloads/Beluga/<friend>/. Returns where it was saved.
   */
  async getFile(peerId: string, remotePath: string, saveTo?: string, why = ''): Promise<string> {
    const reqId = randomUUID();
    const answer = this.wait<BodyOf<'file_request_result'>>(reqId, peerId);
    if (!this.deps.send({ kind: 'file_request', reqId, path: remotePath, why: why.slice(0, 500) }, { to: peerId })) {
      this.cancelWait(reqId);
      throw new Error('Not connected');
    }
    const res = await answer;
    if (!res.ok || !res.share || !res.path) throw new Error(res.error ?? 'They declined');
    const from = this.name(peerId);
    if (!saveTo) return downloadFile({ owner: peerId, share: res.share, path: res.path }, from, this.deps.request, this.deps.store, this.deps.downloadDir);
    const bytes = await fetchBytes({ owner: peerId, share: res.share, path: res.path }, this.deps.request, MAX_DOWNLOAD_BYTES);
    const dir = expandPath(saveTo);
    await fs.mkdir(dir, { recursive: true });
    const target = await uniquePath(dir, safeFileName(res.name ?? res.path));
    await fs.writeFile(target, bytes);
    this.deps.toast(`Saved ${path.basename(target)} from ${from}`, 'success');
    return target;
  }

  async onFileRequest(from: string, body: BodyOf<'file_request'>): Promise<void> {
    const reply = (r: Omit<BodyOf<'file_request_result'>, 'kind' | 'reqId' | 'ok'> & { ok: boolean }) => this.deps.send({ kind: 'file_request_result', reqId: body.reqId, ...r }, { to: from });
    try {
      await this.serveFileRequest(from, body, reply);
    } catch (err) {
      reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async serveFileRequest(from: string, body: BodyOf<'file_request'>, reply: (r: Omit<BodyOf<'file_request_result'>, 'kind' | 'reqId' | 'ok'> & { ok: boolean }) => void): Promise<void> {
    const unavailable = 'That file is not available';
    if (trustOf(this.state, from) === 'blocked') return void reply({ ok: false, error: `${this.state.self?.name ?? 'The owner'} declined` });
    const asked = expandPath(body.path);
    // Follow links first, so a harmless-looking name can't point at a secret.
    const abs = await fs.realpath(asked).catch(() => asked);
    if (isSecretPath(asked) || isSecretPath(abs)) return void reply({ ok: false, error: `${unavailable}: it holds secrets, so Beluga never sends it` });
    // Whether a file exists is only revealed once you said yes (or fully trust them).
    const ok = await this.allowed(from, `${this.who(from)} wants a file from your computer`, `${tilde(asked)}${body.why ? `\n${clean(body.why)}` : ''}`);
    if (!ok) return void reply({ ok: false, error: `${this.state.self?.name ?? 'The owner'} declined` });
    const stat = await fs.stat(abs).catch(() => undefined);
    if (!stat?.isFile()) return void reply({ ok: false, error: `There is no file at ${body.path}` });
    const who = this.name(from);
    const offer = await this.offerFile(abs, from);
    reply({ ok: true, ...offer });
    this.deps.toast(`Sending ${offer.name} to ${who}`, 'success');
  }

  onFileRequestResult(from: string, body: BodyOf<'file_request_result'>): void {
    this.settle(from, body.reqId, body);
  }

  // ---------------------------------------------------------- files: send one

  /** Send a file from this computer to someone (they save it; automatically if they trust you). */
  async sendFile(peerId: string, localPath: string, note = ''): Promise<string> {
    const trimmed = localPath.trim();
    if (!path.isAbsolute(trimmed) && !/^~[\\/]/.test(trimmed)) throw new Error(process.platform === 'win32' ? 'Use a full path (C:\\… or ~\\…)' : 'Use a full path (/… or ~/…)');
    const offer = await this.offerFile(expandPath(trimmed), peerId);
    if (!this.deps.send({ kind: 'file_offer', fid: randomUUID(), ...offer, note: note.slice(0, 1000) }, { to: peerId })) throw new Error('Not connected');
    return `Offered ${offer.name} (${formatBytes(offer.size)}) to ${this.name(peerId)}. It downloads on their side.`;
  }

  async onFileOffer(from: string, body: BodyOf<'file_offer'>): Promise<void> {
    const who = this.name(from);
    const level = trustOf(this.state, from);
    if (level === 'blocked') return;
    // Saved without asking only from people you trust (or are working with), and not too much at once.
    const auto = (level === 'trusted' || level === 'full' || this.expected(from)) && body.size <= AUTO_ACCEPT_BYTES && this.withinQuota(from);
    const ok = auto || (await this.deps.approve(`${this.who(from)} sends you a file`, `${clean(body.name)} (${formatBytes(body.size)})${body.note ? `\n${clean(body.note)}` : ''}`, from));
    if (!ok) return;
    try {
      const saved = await downloadFile({ owner: from, share: body.share, path: body.path }, who, this.deps.request, this.deps.store, this.deps.downloadDir);
      this.deps.notify({ kind: 'people', title: `${who} sent you ${path.basename(saved)}`, body: tilde(saved) });
    } catch (err) {
      this.deps.toast(`Couldn't get ${clean(body.name)} from ${who}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  // ----------------------------------------------- worktrees on a friend's computer

  /** Ask a friend to start a worktree for a task in one of their projects; their Claude does it. */
  async requestWorktree(peerId: string, project: string, task: string, plan = false): Promise<void> {
    const reqId = randomUUID();
    const answer = this.wait<BodyOf<'ws_request_result'>>(reqId, peerId);
    if (!this.deps.send({ kind: 'ws_request', reqId, project, task, plan }, { to: peerId })) {
      this.cancelWait(reqId);
      return this.deps.toast('Not connected', 'error');
    }
    this.deps.toast(`Asked ${this.name(peerId)} to start a worktree in ${project}. Waiting for them…`);
    try {
      const res = await answer;
      if (!res.ok || !res.wsId) {
        this.deps.toast(`${this.name(peerId)} didn't start it: ${res.error ?? 'declined'}`, 'warn');
        return;
      }
      this.deps.store.dispatch({ type: 'chat', id: randomUUID(), from: this.deps.selfId(), text: task, ts: Date.now(), byAgent: false, channel: `ws:${res.wsId}` });
      this.opening.add(res.wsId);
      this.openRequested();
    } catch (err) {
      this.deps.toast(err instanceof Error ? err.message : String(err), 'warn');
    }
  }

  private openRequested(): void {
    if (!this.opening.size) return;
    for (const w of this.state.shared) {
      if (!this.opening.has(w.id)) continue;
      this.opening.delete(w.id);
      this.deps.intend({ type: 'navigate', view: { kind: 'shared', owner: w.owner, id: w.id, tab: 'chat' } });
      this.deps.toast(`${w.name} is running on ${this.name(w.owner)}'s computer. You're in it together`, 'success');
    }
  }

  async onWsRequest(from: string, body: BodyOf<'ws_request'>): Promise<void> {
    const reply = (ok: boolean, extra: { wsId?: string; error?: string } = {}) => this.deps.send({ kind: 'ws_request_result', reqId: body.reqId, ok, ...extra }, { to: from });
    try {
      await this.startRequested(from, body, reply);
    } catch (err) {
      reply(false, { error: (err instanceof Error ? err.message : String(err)).slice(0, 400) });
    }
  }

  private async startRequested(from: string, body: BodyOf<'ws_request'>, reply: (ok: boolean, extra?: { wsId?: string; error?: string }) => void): Promise<void> {
    const ctl = this.deps.controller;
    if (!ctl || this.state.prefs.friendWorktrees === 'off') return void reply(false, { error: 'they turned off work from friends' });
    const project = ctl.manager.list.find((p) => p.root && p.name === body.project);
    if (!project) return void reply(false, { error: `there is no project called ${body.project} here` });
    const who = this.name(from);
    const ok = await this.allowed(from, `${this.who(from)} wants to start a worktree in ${project.name} on your computer`, `${clean(body.task)}\n\n${this.yours(true)} does it on this computer, with what ${who} is allowed to do here. You can follow along and stop it any time.`);
    if (!ok) return void reply(false, { error: 'declined' });
    const name = await this.deps.nameTask(body.task);
    const ws = await ctl.newWorktree(project.id, name);
    if (!ws) return void reply(false, { error: "the worktree couldn't be created" });
    this.deps.sharing.invite(ws.id, from, 'contribute');
    reply(true, { wsId: ws.id });
    const channel = `ws:${ws.id}`;
    this.deps.store.dispatch({ type: 'chat', id: randomUUID(), from, text: clean(body.task), ts: Date.now(), byAgent: false, channel });
    this.deps.runFor(from, channel, body.task, body.plan);
  }

  onWsRequestResult(from: string, body: BodyOf<'ws_request_result'>): void {
    this.settle(from, body.reqId, body);
  }

  // ---------------------------------------------------------------- handoff

  /** Hand a worktree to someone: their Claude continues it on their computer. */
  async handoff(wsId: string, peerId: string): Promise<boolean> {
    const ctl = this.deps.controller;
    const ws = ctl?.manager.find(wsId);
    const to = this.name(peerId);
    if (!ctl || !ws || ws.kind !== 'worktree' || !ws.branch) {
      this.deps.toast('Only worktrees can be handed off', 'warn');
      return false;
    }
    const why = this.cannotHandOff(peerId);
    if (why) {
      this.deps.toast(why, 'warn');
      return false;
    }
    const remote = await ctl.manager.remoteOf(ws.projectId);
    if (!remote) {
      this.deps.toast(NO_REMOTE, 'warn');
      return false;
    }
    const channel = `ws:${wsId}`;
    const project = ctl.manager.list.find((p) => p.id === ws.projectId);
    // Before a note is written or anything is committed or sent: can they take it at all (BLG-614)?
    const checked = await this.checkHandoff(peerId, remote);
    if (checked && !checked.ok) {
      const problem = handoffProblem(checked.reason, undefined, { who: to, project: project?.name ?? '', remote });
      this.deps.store.dispatch({ type: 'system', text: `Not handed off: ${problem}.`, channel, level: 'warn' });
      this.deps.toast(problem, 'warn');
      return false;
    }
    ctl.open(wsId);
    const note = await this.writeNote(ws, to, 'takeover');
    try {
      await ctl.manager.commitAll(wsId, `WIP: hand off to ${to}`);
    } catch (err) {
      // A hook or signing setup refused: hand over what's committed, and say so.
      this.deps.toast(`Couldn't commit the uncommitted changes (${err instanceof Error ? err.message.split('\n')[0] : String(err)}). Only committed work goes to ${to}`, 'warn');
    }
    const fresh = ctl.manager.find(wsId) ?? ws;
    const hid = randomUUID();
    let bundle: { share: string; path: string; size: number } | undefined;
    if ((fresh.status?.ahead ?? 0) > 0 || (await this.hasCommits(fresh))) {
      try {
        bundle = await this.makeBundle(fresh, hid, peerId);
      } catch (err) {
        this.deps.toast(`Couldn't pack the branch: ${err instanceof Error ? err.message : String(err)}`, 'error');
        return false;
      }
    }
    const history = this.state.log
      .filter((l) => l.channel === channel && (l.type === 'chat' || (l.type === 'agent' && l.status === 'done')))
      .slice(-60)
      .map((l) => (l.type === 'chat' ? { from: l.name, text: l.text.slice(0, 8000), ts: l.ts, byAgent: l.byAgent } : { from: l.type === 'agent' ? agentLabel(l.agent, l.ownerName, false) : '', text: l.type === 'agent' ? l.text.slice(0, 8000) : '', ts: l.ts, byAgent: true }));
    this.handoffs.set(hid, { wsId, to: peerId, project: project?.name ?? '', remote, share: bundle?.share });
    const sent = this.deps.send(
      { kind: 'ws_handoff', hid, ws: { name: wsWireName(ws.name), project: project?.name ?? '', branch: ws.branch, base: ws.base ?? project?.base ?? 'origin/main' }, remote, note: note.slice(0, MAX_NOTE_CHARS), history, ...(bundle ? { bundle } : {}) },
      { to: peerId },
    );
    if (!sent) {
      this.deps.toast('Not connected', 'error');
      return false;
    }
    this.deps.store.dispatch({ type: 'system', text: `Offered ${ws.name} to ${to}. Waiting for them to accept…`, channel });
    return true;
  }

  /**
   * Share with a handoff note (BLG-967): your agent writes where the work stands for `peerId` (or for
   * whoever joins), shown in the chat and kept as HANDOFF.md in its Scratch, which they can open.
   * Works for a chat as well as a worktree. Returns the file's path from the workspace's folder.
   */
  async handoffNote(wsId: string, peerId?: string): Promise<string | undefined> {
    const ws = this.deps.controller?.manager.find(wsId);
    if (!ws) {
      this.deps.toast('That workspace is gone', 'warn');
      return undefined;
    }
    const to = peerId ? this.name(peerId) : undefined;
    const note = await this.writeNote(ws, to, 'share');
    const forWhom = to ?? 'whoever joins';
    const saved = await saveHandoffNote(ws.path, noteFile(note, { title: ws.name, from: this.state.self?.name ?? 'you', to: forWhom, at: Date.now() }));
    if (saved) this.deps.store.dispatch({ type: 'system', text: `Handoff note for ${forWhom} saved as ${saved}.`, channel: `ws:${wsId}` });
    else this.deps.toast("The handoff note is in the chat, but it couldn't be saved as a file", 'warn');
    return saved;
  }

  /** Your agent writes the handoff note in the workspace's chat (for `to`, or whoever joins); a plain one when it doesn't answer. */
  private async writeNote(ws: Workspace, to: string | undefined, mode: HandoffNoteMode): Promise<string> {
    this.deps.toast(`${agentName(defaultAgentOf(this.state.self))} is writing a handoff note for ${to ?? 'whoever joins'}…`);
    let note = '';
    try {
      note = (await this.deps.askAndWait(handoffNotePrompt(to ?? 'Someone new', mode), `ws:${ws.id}`, NOTE_TIMEOUT_MS)).trim();
    } catch {
      note = '';
    }
    return note || fallbackNote(this.state.self?.name ?? 'a friend');
  }

  /**
   * Can this worktree go to them? Asked when Share's Take it over is picked, before anything is written or
   * sent: who they are, and whether their Mac has the same repository (BLG-614). `ok` when their
   * Beluga doesn't answer (older, or offline): the handoff then goes as it always did.
   */
  async canHandOff(wsId: string, peerId: string): Promise<{ ok: boolean; why?: string }> {
    const ctl = this.deps.controller;
    const ws = ctl?.manager.find(wsId);
    if (!ctl || !ws || ws.kind !== 'worktree' || !ws.branch) return { ok: false, why: 'Only worktrees can be handed off' };
    const why = this.cannotHandOff(peerId);
    if (why) return { ok: false, why };
    const remote = await ctl.manager.remoteOf(ws.projectId);
    if (!remote) return { ok: false, why: NO_REMOTE };
    const checked = await this.checkHandoff(peerId, remote);
    if (!checked || checked.ok) return { ok: true };
    const project = ctl.manager.list.find((p) => p.id === ws.projectId);
    return { ok: false, why: handoffProblem(checked.reason, undefined, { who: this.name(peerId), project: project?.name ?? '', remote }) };
  }

  /** Ask their Beluga whether it could take a handoff of `remote`; undefined when it doesn't answer. */
  private async checkHandoff(peerId: string, remote: string): Promise<{ ok: boolean; reason?: HandoffReason } | undefined> {
    const reqId = randomUUID();
    const answer = this.wait<BodyOf<'ws_handoff_check_result'>>(reqId, peerId, this.deps.checkWaitMs ?? CHECK_WAIT_MS);
    if (!this.deps.send({ kind: 'ws_handoff_check', reqId, remote }, { to: peerId })) {
      this.cancelWait(reqId);
      return undefined;
    }
    try {
      const res = await answer;
      return { ok: res.ok, ...(res.reason ? { reason: res.reason } : {}) };
    } catch {
      return undefined;
    }
  }

  /** Could you take a handoff of this repository? Says only yes or why not; nothing is approved or started. */
  async onHandoffCheck(from: string, body: BodyOf<'ws_handoff_check'>): Promise<void> {
    const reply = (ok: boolean, reason?: HandoffReason) => this.deps.send({ kind: 'ws_handoff_check_result', reqId: body.reqId, ok, ...(reason ? { reason } : {}) }, { to: from });
    if (trustOf(this.state, from) === 'blocked') return void reply(false, 'declined');
    const ctl = this.deps.controller;
    if (!ctl || this.state.prefs.friendWorktrees === 'off') return void reply(false, 'off');
    const project = await ctl.manager.projectForRemote(body.remote).catch(() => undefined);
    reply(Boolean(project), project ? undefined : 'no_repo');
  }

  onHandoffCheckResult(from: string, body: BodyOf<'ws_handoff_check_result'>): void {
    this.settle(from, body.reqId, body);
  }

  /** Why a handoff can't reach them: someone in your room always can; a friend outside it over the network (BLG-341). */
  private cannotHandOff(peerId: string): string | undefined {
    if (this.state.peers.some((p) => p.peerId === peerId)) return undefined;
    const friend = this.state.network.friends.find((f) => f.peerId === peerId);
    if (!friend) return `${this.name(peerId)} isn't in your room or your friends`;
    if (!this.deps.sharing.friends) return 'Handing off to a friend outside your room needs the Beluga network: turn it on in Settings › Network';
    return cannotTake(friend.name, friend.beluga, 'share.handoff', friend.online);
  }

  private async hasCommits(ws: Workspace): Promise<boolean> {
    const out = await git(ws.path, ['rev-list', '--count', `${ws.base ?? 'origin/main'}..HEAD`]).catch(() => '0');
    return Number(out.trim()) > 0;
  }

  /** Pack the branch's own commits (on top of its base) into a git bundle shared only with `to`. */
  private async makeBundle(ws: Workspace, hid: string, to: string): Promise<{ share: string; path: string; size: number }> {
    const dir = path.join(outboxDir(), `handoff-${hid.slice(0, 12)}`);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    mine.add(dir);
    const file = path.join(dir, 'branch.bundle');
    await git(ws.path, ['bundle', 'create', file, ws.branch!, `^${ws.base ?? 'origin/main'}`]);
    const size = (await fs.stat(file)).size;
    if (size > MAX_DOWNLOAD_BYTES) throw new Error('the branch is too large to send');
    const share = `handoff-${hid.slice(0, 12)}`;
    this.deps.shares.upsert({ name: share, root: dir, writable: false, private: true, allowed: [to] });
    setTimeout(() => {
      this.deps.shares.remove(share);
      void fs.rm(dir, { recursive: true, force: true });
    }, HANDOFF_TTL_MS).unref?.();
    return { share, path: 'branch.bundle', size };
  }

  async onHandoff(from: string, body: BodyOf<'ws_handoff'>): Promise<void> {
    // The words stay for an older Beluga that only reads them; a newer one says it from `reason`.
    const reply = (ok: boolean, reason?: HandoffReason, error?: string) =>
      this.deps.send({ kind: 'ws_handoff_result', hid: body.hid, ok, ...(reason ? { reason } : {}), ...(error ? { error } : {}) }, { to: from });
    const ctl = this.deps.controller;
    const who = this.name(from);
    if (!ctl || this.state.prefs.friendWorktrees === 'off') return void reply(false, 'off', 'they turned off work from friends');
    if (!safeRef(body.ws.branch) || !safeRef(body.ws.base) || !/^[\w-]{1,64}$/.test(body.hid)) return void reply(false, 'bad_branch', 'that branch name is not allowed');
    // Without the repository there's nothing to approve: say so, to you and to them, before asking.
    const project = await ctl.manager.projectForRemote(body.remote);
    if (!project) {
      const what = clean(body.ws.project) || 'that repository';
      this.deps.notify({ kind: 'people', title: `${who} wanted to hand you ${clean(body.ws.name)}`, body: `You don't have ${what} here. Clone ${clean(body.remote)} and add it to Beluga, then ask ${who} to hand it off again` });
      this.deps.toast(`${who} wanted to hand you ${clean(body.ws.name)}, but you don't have ${what} here. Clone ${clean(body.remote)}, then ask them again`, 'warn');
      return void reply(false, 'no_repo', `${this.state.self?.name ?? 'they'} don't have that repository cloned`);
    }
    const note = clean(body.note);
    const ok = await this.allowed(
      from,
      `${this.who(from)} wants to hand ${clean(body.ws.name)} (${clean(body.ws.project)}) over to you`,
      `You get their branch, the chat so far and this handoff note, in a new worktree. ${this.yours(true)} continues it, with what ${who} is allowed to do here.\n\n${note.slice(0, 3000)}${note.length > 3000 ? `\n… (${note.length - 3000} more characters)` : ''}`,
    );
    if (!ok) return void reply(false, 'declined', 'declined');
    let branch: string | undefined;
    try {
      branch = await ctl.manager.freeBranchName(project.root, body.ws.name);
      if (body.bundle) {
        const bytes = await fetchBytes({ owner: from, share: body.bundle.share, path: body.bundle.path }, this.deps.request, MAX_DOWNLOAD_BYTES);
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beluga-handoff-'));
        const tmp = path.join(tmpDir, 'branch.bundle');
        await fs.writeFile(tmp, bytes, { mode: 0o600 });
        try {
          await git(project.root, ['fetch', '--no-tags', '--', tmp, `refs/heads/${body.ws.branch}:refs/heads/${branch}`]);
        } finally {
          await fs.rm(tmpDir, { recursive: true, force: true });
        }
      } else {
        await git(project.root, ['branch', '--no-track', branch, body.ws.base]);
      }
      // Their branch is their code: your .env files and the setup script only come in if you fully trust them.
      const full = trustOf(this.state, from) === 'full';
      const ws = await ctl.manager.createWorktreeOn(project.id, body.ws.name, branch, { handedFrom: who }, { copyEnv: full });
      const channel = `ws:${ws.id}`;
      const now = Date.now();
      const items: LogItem[] = [
        ...body.history.map((h, i): LogItem => ({ id: `ho-${body.hid}-${i}`, type: 'system', channel, text: `(from ${who}'s chat) ${clean(h.from)}: ${clean(h.text)}`, ts: h.ts, level: 'info' })),
        { id: `ho-${body.hid}-note`, type: 'system', channel, text: `Handed over by ${who}. Their note:\n${note}`, ts: now, level: 'info' },
        ...(full ? [] : [{ id: `ho-${body.hid}-setup`, type: 'system' as const, channel, text: `Setup didn't run and your .env files weren't copied, because this branch came from ${who}. Look it over, then use Terminal → Run setup.`, ts: now, level: 'warn' as const }]),
      ];
      ctl.manager.saveHistory(ws.id, items);
      await saveHandoffNote(ws.path, noteFile(note, { title: ws.name, from: who, to: this.state.self?.name ?? 'you', at: now }));
      await ctl.refresh();
      ctl.open(ws.id);
      if (full) this.deps.onWorktreeCreated?.(ws);
      // They follow along: through the room you're both in, or over the network for a friend outside it.
      if (!this.state.peers.some((p) => p.peerId === from) && this.deps.sharing.friends) this.deps.sharing.shareWithFriend({ peerId: from, workspaceId: ws.id, projectId: project.id, role: 'view' });
      else this.deps.sharing.invite(ws.id, from, 'view');
      reply(true);
      // The note is their text: Claude reads it with what they're allowed to do here, and asks you the rest.
      this.deps.runOnBehalf(from, channel, continuePrompt(who, note));
      this.deps.notify({ kind: 'people', title: `You took over ${ws.name} from ${who}`, body: `${this.yours(true)} is picking it up`, channel });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Don't leave a half-made branch behind.
      if (branch && !ctl.manager.list.some((p) => p.workspaces.some((w) => w.branch === branch))) await git(project.root, ['branch', '-D', branch]).catch(() => undefined);
      this.deps.toast(`Couldn't take over ${clean(body.ws.name)}: ${message}`, 'error');
      reply(false, 'failed', message.slice(0, 400));
    }
  }

  onHandoffResult(from: string, body: BodyOf<'ws_handoff_result'>): void {
    const offer = this.handoffs.get(body.hid);
    if (!offer || offer.to !== from) return;
    this.handoffs.delete(body.hid);
    const who = this.name(from);
    const channel = `ws:${offer.wsId}`;
    if (!body.ok) {
      const problem = handoffProblem(body.reason, clean(body.error ?? ''), { who, project: offer.project, remote: offer.remote });
      this.deps.store.dispatch({ type: 'system', text: `Not handed off: ${problem}.`, channel, level: 'warn' });
      this.deps.toast(problem, 'warn');
      if (offer.share) this.deps.shares.remove(offer.share);
      return;
    }
    this.deps.controller?.manager.markHandedOff(offer.wsId, who);
    void this.deps.controller?.refresh();
    this.deps.store.dispatch({ type: 'system', text: `${who} took this over. Their agent continues on their computer; it's in Projects so you can follow along. Archive this one when you like.`, channel });
    this.deps.notify({ kind: 'people', title: `${who} took over the workspace`, body: 'Follow along in Projects', channel });
  }
}
