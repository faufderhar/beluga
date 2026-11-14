import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { roleOf } from '../companion/device-crypto.js';
import { deviceId } from '../companion/devices.js';
import type { DeviceCert } from '../companion/protocol.js';
import type { SwappableIdentity } from '../core/identity.js';
import { type Identity, identityFromPem, identityPem, saveIdentity } from '../net/crypto.js';
import { STANDBY_IDENTITY, identityOrOneOff, readIdentityFile, standbyIdentity } from './identity-load.js';
import { StandInChanges, applyChanges, beginStandIn, changesSince, endStandIn } from './standin-settings.js';
import { rmSync } from 'node:fs';
import type { MessageSocket } from '../net/transport.js';
import type { Settings } from '../shared/settings-schema.js';
import { type AoEnd, type AoFrame, IDENTITY_FILE, STANDBY, Staging, carriedFrom, dropReplicas, dropStaged, installReplica, installStaged, keepOnlyReplica, latestReplica, networkFiles, parseAo, sendParts, stagedEnd, wipeNetwork } from './always-on-bundle.js';
import { readAlwaysOn, whereabouts, writeAlwaysOn } from './always-on-state.js';
import type { MachineRecord } from './book.js';
import type { Machines } from './machines.js';

/**
 * Make Always On (BLG-796): one computer of yours becomes you on the network. Your identity,
 * friends network and the settings that are you to friends move there over your own end-to-end
 * device link, after one confirmation in Settings › Your Computers; the install that gave them stops
 * running the network, keeps a stand-in key of its own, and shows the network through the link.
 * Make This Mac Always On brings it back the same way; another computer goes through this one.
 *
 * Never two of you, never none, along the way. The handover has two steps:
 *  1. The giver stops its network and sends everything (always-on-bundle.ts). The taker stages it,
 *     checks every file and that the identity is the one its device set belongs to, says ready.
 *  2. The giver notes where you are now, lets go of the identity (its files wiped) and says commit;
 *     the taker installs what it staged, becomes you and starts the network.
 * A link that drops before step 2 changes nothing: the giver starts its network again. One that drops
 * after it leaves the staging on the taker, and the commit is said again until it lands.
 *
 * Every device certificate stays valid (the same identity signed it), and each install keeps its own
 * companion address (pinned before the identity changes), so phones and computers reach it as before.
 */

const STEP_MS = 120_000;
const RETRY_MS = 60_000;
/** This Mac's own copy of your identity once it made a computer your Always On (BLG-799): to stand in while that one is down for long, and for rooms here (BLG-846). It never leaves this Mac. */
export { STANDBY_IDENTITY };

export interface AlwaysOnView {
  /** This install is you on the network. */
  readonly here: boolean;
  /** Where you are otherwise: the device's id and name. */
  readonly id?: string;
  readonly name?: string;
  readonly since?: number;
  /** A handover is under way: what it does now. */
  readonly busy?: string;
  /** A handover whose last step hasn't been heard back yet (it's asked again by itself). */
  readonly pending?: boolean;
  /** This install stands in for your Always On while it's down (BLG-799): it hands back once it answers. */
  readonly standIn?: { readonly id: string; readonly name: string; readonly since?: number };
}

/** This daemon's friends network, as a handover turns it off and on (core/network.ts NetworkSwitch). */
export interface AlwaysOnNetwork {
  set(on: boolean): Promise<void>;
  rename(name: string): void;
}

export interface AlwaysOnOptions {
  /** ~/.beluga. */
  readonly dir: string;
  readonly machines: Machines;
  readonly you: SwappableIdentity;
  readonly network: () => AlwaysOnNetwork | undefined;
  readonly settings: { load(): Settings; save(patch: Partial<Settings>): void };
  /** Keep this install's companion address as it is now, whoever it becomes (companion/host.ts). */
  readonly pinAddress: (current: SwappableIdentity['identity']) => void;
  /** The phones paired on this install (their device keys). */
  readonly phones: () => readonly string[];
  /** The network was handed over: the view this install shows changed. */
  readonly onChange?: () => void;
  /** Settings that are you to friends were just written here (taking your network, or standing in): the running parts read them again (BLG-848). */
  readonly settingsChanged?: () => void;
  /** The demo: its computers (demo.ts), with the Mac mini as your Always On. */
  readonly demo?: { readonly start: { id: string; name: string }; readonly name: (id: string) => string | undefined };
  readonly stepMs?: number;
  readonly retryMs?: number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

/** Frames off a link as they come; `next` waits for one (undefined: closed or too slow). */
function reader(socket: MessageSocket): { next(ms: number): Promise<AoFrame | undefined> } {
  const queue: AoFrame[] = [];
  const waiting: Array<(f: AoFrame | undefined) => void> = [];
  let closed = false;
  socket.on('message', (text) => {
    const frame = parseAo(text) ?? { t: 'ao-no' as const, reason: 'That answer made no sense' };
    const w = waiting.shift();
    if (w) w(frame);
    else queue.push(frame);
  });
  socket.once('close', () => {
    closed = true;
    for (const w of waiting.splice(0)) w(undefined);
  });
  return {
    next: (ms) => {
      const queued = queue.shift();
      if (queued || closed) return Promise.resolve(queued);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const i = waiting.indexOf(done);
          if (i >= 0) waiting.splice(i, 1);
          resolve(undefined);
        }, ms);
        timer.unref?.();
        const done = (f: AoFrame | undefined): void => {
          clearTimeout(timer);
          resolve(f);
        };
        waiting.push(done);
      });
    },
  };
}

const send = (socket: MessageSocket, frame: AoFrame): void => {
  if (socket.isOpen) socket.send(JSON.stringify(frame));
};
const newStage = (): string => randomBytes(16).toString('hex');
const words = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class AlwaysOn {
  private busy?: string;
  private turn: Promise<unknown> = Promise.resolve();
  private retry?: NodeJS.Timeout;
  private demoAt?: { id: string; name: string } | undefined;
  private stopped = false;

  constructor(private readonly opts: AlwaysOnOptions) {
    this.demoAt = opts.demo?.start;
  }

  /** A handover this install gave and hasn't heard the end of: say commit again (now, and every minute until it lands). */
  start(): void {
    if (readAlwaysOn(this.opts.dir)?.pending) void this.finishPending();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
  }

  /** The device that is you on the network, if it isn't this install. */
  at(): string | undefined {
    if (this.opts.demo) return this.demoAt?.id;
    const w = whereabouts(this.opts.dir);
    return w.here ? undefined : w.id;
  }

  view(): AlwaysOnView {
    const busy = this.busy ? { busy: this.busy } : {};
    if (this.opts.demo) return this.demoAt ? { here: false, ...this.demoAt, ...busy } : { here: true, ...busy };
    const w = whereabouts(this.opts.dir);
    const pending = readAlwaysOn(this.opts.dir)?.pending ? { pending: true } : {};
    return w.here ? { here: true, ...(w.since ? { since: w.since } : {}), ...(w.standIn ? { standIn: { ...w.standIn, ...(w.since ? { since: w.since } : {}) } } : {}), ...busy } : { here: false, id: w.id, name: w.name, since: w.since, ...busy, ...pending };
  }

  /**
   * Make Always On: `target` ('here', or one of your computers by id) becomes you on the network.
   * Asked once (Settings said what moves); one handover at a time.
   */
  make(target: string): Promise<AlwaysOnView> {
    const next = this.turn.then(() => this.move(target));
    this.turn = next.catch(() => undefined);
    return next;
  }

  private async move(target: string): Promise<AlwaysOnView> {
    if (this.opts.demo) return this.demoMove(target);
    const { machines } = this.opts;
    const from = this.at();
    if ((target === 'here' && from === undefined) || target === from) return this.view();
    const record = (id: string): MachineRecord => {
      const r = machines.book.get(id);
      if (!r || !machines.drives(r)) throw new Error('That computer isn’t one of yours here');
      return r;
    };
    // Checked before anything moves: a computer that isn't yours stops it here.
    const to = target === 'here' ? undefined : record(target);
    if (from === undefined && !machines.set.holdsIdentity) throw new Error('This Beluga doesn’t hold your identity, so it can’t hand it on');
    try {
      // From another computer: back here first (not started when it goes on at once).
      if (from !== undefined) await this.bringBack(record(from), { start: to === undefined });
      if (to) await this.handTo(to);
    } finally {
      this.busy = undefined;
      this.opts.onChange?.();
    }
    // Your network as your Always On has it, shown here now rather than at the next poll.
    if (to) void machines.poll().catch(() => undefined);
    return this.view();
  }

  private demoMove(target: string): AlwaysOnView {
    const name = target === 'here' ? undefined : this.opts.demo?.name(target);
    if (target !== 'here' && !name) throw new Error('That computer isn’t one of yours here');
    this.demoAt = name ? { id: target, name } : undefined;
    this.opts.onChange?.();
    return this.view();
  }

  // ---- this install gives

  /** Hand your identity and network to computer `r` (this install holds them); `merge`: a stand-in handing back (BLG-799). */
  private async handTo(r: MachineRecord, how: { merge?: boolean } = {}): Promise<void> {
    const { machines, dir, you } = this.opts;
    const id = deviceId(r.cert);
    const stage = newStage();
    this.busy = how.merge ? `Handing you back to ${r.name}…` : `Moving you to ${r.name}…`;
    this.opts.onChange?.();
    const socket = await machines.openLink(r);
    const rd = reader(socket);
    const sw = this.opts.network();
    try {
      send(socket, { t: 'always-on', op: 'take', stage, from: machines.hereName().slice(0, 64), ...(how.merge ? { merge: true } : {}) });
      // Off before the first byte leaves: nothing arrives here that the copy wouldn't have.
      await sw?.set(false);
      this.sendBundle(socket, stage, { merge: how.merge === true });
      const ready = await rd.next(this.opts.stepMs ?? STEP_MS);
      if (ready?.t !== 'ao-ready' || ready.stage !== stage) throw new Error(ready?.t === 'ao-no' ? ready.reason : `${r.name} didn’t take it: nothing moved.`);
    } catch (err) {
      socket.close(1000);
      await this.restartNetwork();
      throw err;
    }
    // This Mac keeps its own copy, to stand in with while the Always On is down for long (BLG-799).
    saveIdentity(path.join(dir, STANDBY_IDENTITY), you.current());
    this.letGo({ id, name: r.name }, stage);
    endStandIn(dir);
    send(socket, { t: 'ao-commit', stage });
    const done = await rd.next(this.opts.stepMs ?? STEP_MS);
    socket.close(1000);
    if (done?.t === 'ao-done') this.settled();
    else this.later();
    this.opts.log?.(`always-on: you are on ${r.name} now`);
  }

  /** Everything that moves, on the link: the files, then the end with your identity (a replica's leaves it out). */
  private sendBundle(socket: MessageSocket, stage: string, how: { replica?: boolean; merge?: boolean } = {}): void {
    const { dir, machines, you } = this.opts;
    const files = sendParts(dir, (part) => send(socket, part));
    const carried = carriedFrom(this.opts.settings.load());
    // Handing back, only what changed while this one stood in: the Always On keeps the rest as it has it (BLG-848).
    const settings = how.merge ? { settings: {}, changes: changesSince(dir, carried, this.now()) } : { settings: carried };
    const end: AoEnd = { t: 'ao-end', stage, identity: how.replica ? '' : identityPem(you.current()), owner: you.current().peerId, files, ...settings, devset: machines.set.syncFrame(), ...(how.replica ? { replica: true } : {}) };
    send(socket, end);
  }

  /** The point of no return on the giving side: where you are is noted, the identity and network files go, a stand-in key stays. */
  private letGo(at: { id: string; name: string }, stage: string | undefined): void {
    const { dir, machines, you } = this.opts;
    writeAlwaysOn(dir, { v: 1, at, since: this.now(), ...(stage ? { pending: { id: at.id, stage } } : {}) });
    machines.set.release(this.opts.phones());
    this.opts.pinAddress(you.identity);
    // identity.json holding a stand-in key (this Mac standing in) stays: it's what this Mac goes back to.
    const onDisk = readIdentityFile(path.join(dir, IDENTITY_FILE));
    wipeNetwork(dir, { keepIdentity: onDisk !== undefined && onDisk.peerId !== you.current().peerId });
    // A stand-in key kept there but broken mustn't stop the handover halfway: a one-off, as at start.
    you.swap(identityOrOneOff(path.join(dir, IDENTITY_FILE), (m) => this.opts.log?.(`always-on: ${m}`)));
  }

  private settled(): void {
    const state = readAlwaysOn(this.opts.dir);
    if (state?.pending) writeAlwaysOn(this.opts.dir, { v: 1, at: state.at, since: state.since });
    clearTimeout(this.retry);
  }

  private later(): void {
    if (this.stopped) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.finishPending(), this.opts.retryMs ?? RETRY_MS);
    this.retry.unref?.();
  }

  /** Say commit again for a handover whose last step wasn't heard back. */
  async finishPending(): Promise<boolean> {
    const pending = readAlwaysOn(this.opts.dir)?.pending;
    if (!pending || this.stopped) return true;
    const r = this.opts.machines.book.get(pending.id);
    if (!r) return true;
    try {
      const socket = await this.opts.machines.openLink(r);
      const rd = reader(socket);
      send(socket, { t: 'always-on', op: 'commit', stage: pending.stage });
      const done = await rd.next(this.opts.stepMs ?? STEP_MS);
      socket.close(1000);
      if (done?.t === 'ao-done') {
        this.settled();
        this.opts.onChange?.();
        return true;
      }
    } catch (err) {
      this.opts.log?.(`always-on: couldn't reach ${r.name} to finish moving you: ${words(err)}`);
    }
    this.later();
    return false;
  }

  /** The network back on as it was (a handover that didn't happen). */
  private async restartNetwork(): Promise<void> {
    const on = this.opts.settings.load().network === true;
    await this.opts.network()?.set(on).catch((err: unknown) => this.opts.log?.(`always-on: the network didn't start again: ${words(err)}`));
  }

  // ---- this install takes

  /** Take your identity back from computer `r`: it gives, this install becomes you. */
  private async bringBack(r: MachineRecord, how: { start: boolean }): Promise<void> {
    const { machines } = this.opts;
    const stage = newStage();
    this.busy = `Moving you back from ${r.name}…`;
    this.opts.onChange?.();
    const socket = await machines.openLink(r);
    const rd = reader(socket);
    send(socket, { t: 'always-on', op: 'give', stage });
    const staged = await this.receive(socket, rd, stage);
    if (staged) {
      send(socket, { t: 'ao-no', reason: staged });
      socket.close(1000);
      throw new Error(staged);
    }
    send(socket, { t: 'ao-ready', stage, peerId: machines.set.owner().peerId });
    const commit = await rd.next(this.opts.stepMs ?? STEP_MS);
    // The commit lost on the way: what it says now decides (it let go, or it kept it).
    const gave = commit?.t === 'ao-commit' && commit.stage === stage ? true : await this.letGoThere(r);
    if (!gave) {
      socket.close(1000);
      dropStaged(this.opts.dir);
      throw new Error(`${r.name} kept your network: nothing moved.`);
    }
    await this.install(stage, how);
    send(socket, { t: 'ao-done', peerId: machines.set.owner().peerId });
    socket.close(1000);
    this.opts.log?.(`always-on: you are on ${machines.hereName()} again`);
  }

  /** Whether `r` let go of your identity (asked over a fresh link). */
  private async letGoThere(r: MachineRecord): Promise<boolean> {
    try {
      const socket = await this.opts.machines.openLink(r);
      const rd = reader(socket);
      send(socket, { t: 'always-on', op: 'status' });
      const status = await rd.next(this.opts.stepMs ?? STEP_MS);
      socket.close(1000);
      return status?.t === 'ao-status' && !status.here;
    } catch {
      return false;
    }
  }

  /** Stage a bundle off the link and check it; returns why not, or undefined when it's whole and yours. */
  private async receive(socket: MessageSocket, rd: ReturnType<typeof reader>, stage: string, folder?: string): Promise<string | undefined> {
    const staging = new Staging(this.opts.dir, stage, folder);
    const fail = (why: string): string => {
      if (folder) rmSync(path.join(this.opts.dir, folder, stage), { recursive: true, force: true });
      else dropStaged(this.opts.dir);
      return why;
    };
    for (;;) {
      const f = await rd.next(this.opts.stepMs ?? STEP_MS);
      if (!f) return fail('The link dropped before everything arrived: nothing moved.');
      if (f.t === 'ao-no') return fail(f.reason);
      if (f.t === 'ao-end') {
        const why = staging.finish(f) ?? (folder ? this.ownersReplica(f) : this.yours(f));
        return why ? fail(why) : undefined;
      }
      if (f.t !== 'ao-part') return fail('That handover went wrong: nothing moved.');
      staging.part(f);
    }
  }

  /** A replica is of your own network: the same owner as this install's set. */
  private ownersReplica(end: AoEnd): string | undefined {
    return end.replica && end.owner === this.opts.machines.set.owner().peerId ? undefined : 'That replica isn’t of your network';
  }

  /** The identity that came is the one this install's device set belongs to (nobody else's). */
  private yours(end: AoEnd): string | undefined {
    try {
      const identity = identityFromPem(end.identity);
      const owner = this.opts.machines.set.owner().peerId;
      if (identity.peerId !== end.owner || identity.peerId !== owner) return 'That identity isn’t the one this computer belongs to: nothing moved.';
      return undefined;
    } catch {
      return 'That identity didn’t read: nothing moved.';
    }
  }

  /** Become you: the staged network in place, your identity kept and taken, the network started (unless it goes on at once). */
  private async install(stage: string, how: { start: boolean; merge?: boolean }): Promise<void> {
    const { dir, machines, you } = this.opts;
    const end = stagedEnd(dir, stage);
    if (!end) throw new Error('Nothing is staged for that handover');
    const identity = identityFromPem(end.identity);
    this.opts.pinAddress(you.identity);
    machines.set.takeOver(end.devset, this.opts.phones());
    saveIdentity(path.join(dir, IDENTITY_FILE), identity);
    installStaged(dir, stage, { merge: how.merge === true });
    const changes = how.merge ? StandInChanges.safeParse(end.changes) : undefined;
    this.opts.settings.save({ ...(how.merge ? (changes?.success ? applyChanges(this.opts.settings.load(), changes.data) : {}) : end.settings), network: true });
    this.opts.settingsChanged?.();
    writeAlwaysOn(dir, { v: 1, at: 'here', since: this.now() });
    // You're here now: a standby copy and replicas have nothing left to stand in for.
    rmSync(path.join(dir, STANDBY_IDENTITY), { force: true });
    dropReplicas(dir);
    you.swap(identity);
    const sw = this.opts.network();
    if (!sw) return;
    if (end.settings.name) sw.rename(end.settings.name);
    if (how.start) await sw.set(true).catch((err: unknown) => this.opts.log?.(`always-on: the network didn't start here: ${words(err)}`));
  }

  // ---- an app of yours asks this computer (Machines.accept routes the link here)

  serve(socket: MessageSocket, cert: DeviceCert, helloText: string): void {
    const hello = parseAo(helloText);
    const rd = reader(socket);
    if (hello?.t !== 'always-on' || roleOf(cert) !== 'app') return socket.close(4001, 'Only an app of yours moves your network');
    const answer = (): Promise<void> => {
      switch (hello.op) {
        case 'status':
          send(socket, { t: 'ao-status', here: this.at() === undefined && this.opts.machines.set.holdsIdentity, ...(hello.stage ? { staged: stagedEnd(this.opts.dir, hello.stage) !== undefined } : {}) });
          socket.close(1000);
          return Promise.resolve();
        case 'take':
          return this.take(socket, rd, hello.stage, hello.merge === true);
        case 'replica':
          return this.sendReplica(socket, rd, hello.stage);
        case 'commit':
          return this.commitLater(socket, hello.stage);
        case 'give':
          return this.give(socket, rd, cert, hello.stage);
      }
    };
    const run = this.turn.then(answer);
    this.turn = run.catch((err: unknown) => {
      this.opts.log?.(`always-on: ${words(err)}`);
      send(socket, { t: 'ao-no', reason: words(err) });
      socket.close(1000);
    });
  }

  /** An app of yours hands your network to this computer. */
  private async take(socket: MessageSocket, rd: ReturnType<typeof reader>, stage: string | undefined, merge: boolean): Promise<void> {
    if (!stage) return void socket.close(4001, 'No handover named');
    if (this.holding() && !merge) {
      send(socket, { t: 'ao-no', reason: `${this.opts.machines.hereName()} already is you on the network.` });
      return void socket.close(1000);
    }
    this.busy = 'Taking your network…';
    try {
      // Your app stood in while this one was away, and is newer: never two of you, so this one's network stops first (BLG-799).
      if (merge) await this.opts.network()?.set(false);
      const why = await this.receive(socket, rd, stage);
      if (why) {
        send(socket, { t: 'ao-no', reason: why });
        return void socket.close(1000);
      }
      send(socket, { t: 'ao-ready', stage, peerId: this.opts.machines.set.owner().peerId });
      const commit = await rd.next(this.opts.stepMs ?? STEP_MS);
      // No commit on this link: the staging waits for one said again.
      if (commit?.t !== 'ao-commit' || commit.stage !== stage) {
        socket.close(1000);
        if (merge) await this.restartNetwork();
        return;
      }
      await this.install(stage, { start: true, merge });
      send(socket, { t: 'ao-done', peerId: this.opts.machines.set.owner().peerId });
      socket.close(1000);
      this.opts.log?.('always-on: this computer is you on the network now');
    } finally {
      this.busy = undefined;
      this.opts.onChange?.();
    }
  }

  /** A commit said again: install what's staged, or say done when it already was. */
  private async commitLater(socket: MessageSocket, stage: string | undefined): Promise<void> {
    if (stage && stagedEnd(this.opts.dir, stage)) await this.install(stage, { start: true });
    const holds = this.opts.machines.set.holdsIdentity && this.at() === undefined;
    send(socket, holds ? { t: 'ao-done', peerId: this.opts.machines.set.owner().peerId } : { t: 'ao-no', reason: 'Nothing is staged for that handover' });
    socket.close(1000);
    this.opts.onChange?.();
  }

  /** An app of yours takes your network back from this computer. */
  private async give(socket: MessageSocket, rd: ReturnType<typeof reader>, cert: DeviceCert, stage: string | undefined): Promise<void> {
    const { machines } = this.opts;
    if (!stage) return void socket.close(4001, 'No handover named');
    if (!machines.set.holdsIdentity || this.at() !== undefined) {
      send(socket, { t: 'ao-no', reason: `${machines.hereName()} isn’t you on the network.` });
      return void socket.close(1000);
    }
    this.busy = `Moving you to ${cert.name}…`;
    try {
      await this.opts.network()?.set(false);
      this.sendBundle(socket, stage);
      const ready = await rd.next(this.opts.stepMs ?? STEP_MS);
      if (ready?.t !== 'ao-ready' || ready.stage !== stage) {
        socket.close(1000);
        return void (await this.restartNetwork());
      }
      this.letGo({ id: deviceId(cert), name: cert.name }, undefined);
      send(socket, { t: 'ao-commit', stage });
      await rd.next(this.opts.stepMs ?? STEP_MS);
      socket.close(1000);
      this.opts.log?.(`always-on: you are on ${cert.name} now`);
    } finally {
      this.busy = undefined;
      this.opts.onChange?.();
    }
  }

  // ---- never two of you, never none (BLG-799, lease.ts decides when)

  /** This install has taken part in an Always On: it keeps where you are in always-on.json. */
  involved(): boolean {
    return readAlwaysOn(this.opts.dir) !== undefined;
  }

  /** This install is you on the network now. */
  holding(): boolean {
    return this.at() === undefined && this.opts.machines.set.holdsIdentity;
  }

  /** Who this install stands in for, while it does. */
  standingIn(): { id: string; name: string } | undefined {
    const w = whereabouts(this.opts.dir);
    return w.here ? w.standIn : undefined;
  }

  /**
   * Your identity as the lease is read and written with: the one this install holds, or, while your
   * Always On is elsewhere, this install's standby (this Mac's own copy, or a computer that stood down).
   */
  leaseIdentity(): Identity | undefined {
    if (this.holding()) return this.opts.you.current();
    const owner = this.opts.machines.set.owner().peerId;
    return standbyIdentity(this.opts.dir, owner) ?? readIdentityFile(path.join(this.opts.dir, IDENTITY_FILE), owner);
  }

  /** This install could stand in now: your Always On is elsewhere, and it has your identity and a network to run. */
  canStandIn(): boolean {
    return this.at() !== undefined && this.leaseIdentity() !== undefined && (latestReplica(this.opts.dir) !== undefined || networkFiles(this.opts.dir).length > 0);
  }

  /**
   * Your Always On has been down for long: this install becomes you, from the last replica it has
   * (this Mac), or its own files (a computer that stood down), and says so.
   */
  standIn(): Promise<void> {
    const next = this.turn.then(async () => {
      const at = whereabouts(this.opts.dir);
      const identity = this.leaseIdentity();
      if (at.here || !identity) return;
      const replica = latestReplica(this.opts.dir);
      if (replica) installReplica(this.opts.dir, replica);
      // On the Always On's newest trust levels, Ask Me For and policy, as its replica carried them (BLG-848).
      const carried = replica ? stagedEnd(this.opts.dir, replica, STANDBY)?.settings : undefined;
      if (carried) beginStandIn(this.opts.dir, carried, (patch) => this.opts.settings.save(patch), this.now());
      if (carried) this.opts.settingsChanged?.();
      this.opts.pinAddress(this.opts.you.identity);
      writeAlwaysOn(this.opts.dir, { v: 1, at: 'here', since: this.now(), ...(replica ? { standIn: { id: at.id, name: at.name } } : {}) });
      this.opts.you.swap(identity);
      await this.opts.network()?.set(true).catch((err: unknown) => this.opts.log?.(`always-on: couldn't stand in: ${words(err)}`));
      this.opts.log?.(replica ? `always-on: standing in for ${at.name} while it's down` : 'always-on: you are here again');
      this.opts.onChange?.();
    });
    this.turn = next.catch(() => undefined);
    return next;
  }

  /**
   * Another install of yours holds a newer lease: this one stops being you. A stand-in hands back
   * what came meanwhile; anything else just stops, keeping its files for when it's given back.
   */
  standDown(holder: { id: string; name: string }): Promise<void> {
    if (this.standingIn()?.id === holder.id) return this.handBack();
    const next = this.turn.then(async () => {
      if (!this.holding()) return;
      await this.opts.network()?.set(false);
      writeAlwaysOn(this.opts.dir, { v: 1, at: holder, since: this.now() });
      this.opts.log?.(`always-on: ${holder.name} is you on the network now; this one stopped`);
      this.opts.onChange?.();
    });
    this.turn = next.catch(() => undefined);
    return next;
  }

  /** Your Always On answers again: what this stand-in got meanwhile goes back to it, merged. */
  handBack(): Promise<void> {
    const next = this.turn.then(async () => {
      const standIn = this.standingIn();
      const r = standIn ? this.opts.machines.book.get(standIn.id) : undefined;
      if (!standIn || !r) return;
      try {
        await this.handTo(r, { merge: true });
      } finally {
        this.busy = undefined;
        this.opts.onChange?.();
      }
    });
    this.turn = next.catch(() => undefined);
    return next;
  }

  /** Keep this Mac's replica of your network fresh (asked of your Always On every few minutes while it answers). */
  refreshStandby(): Promise<boolean> {
    const next = this.turn.then(async () => {
      const id = this.at();
      const r = id ? this.opts.machines.book.get(id) : undefined;
      if (!r || !this.opts.machines.drives(r) || !this.leaseIdentity()) return false;
      const stage = newStage();
      const socket = await this.opts.machines.openLink(r);
      const rd = reader(socket);
      send(socket, { t: 'always-on', op: 'replica', stage });
      const why = await this.receive(socket, rd, stage, STANDBY);
      send(socket, why ? { t: 'ao-no', reason: why } : { t: 'ao-done', peerId: this.opts.machines.set.owner().peerId });
      socket.close(1000);
      if (why) {
        this.opts.log?.(`always-on: no fresh replica from ${r.name}: ${why}`);
        return false;
      }
      keepOnlyReplica(this.opts.dir, stage);
      return true;
    });
    this.turn = next.catch(() => undefined);
    return next.catch(() => false);
  }

  /** On your Always On: your app asks for a replica of your network (never your identity). */
  private async sendReplica(socket: MessageSocket, rd: ReturnType<typeof reader>, stage: string | undefined): Promise<void> {
    if (!stage || !this.holding()) {
      send(socket, { t: 'ao-no', reason: `${this.opts.machines.hereName()} isn’t you on the network.` });
      return void socket.close(1000);
    }
    this.sendBundle(socket, stage, { replica: true });
    await rd.next(this.opts.stepMs ?? STEP_MS);
    socket.close(1000);
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }
}

// ---- the API's way in (machine-handlers.ts)

const all = new WeakMap<object, AlwaysOn>();
export const attachAlwaysOn = (session: object, a: AlwaysOn): void => void all.set(session, a);
export const detachAlwaysOn = (session: object): void => void all.delete(session);
export const alwaysOnOf = (session: object): AlwaysOn | undefined => all.get(session);
export function needAlwaysOn(session: object): AlwaysOn {
  const a = all.get(session);
  if (!a) throw new Error('Always On needs the Beluga daemon running.');
  return a;
}
