import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FileFrame, Mesh } from '../../net/mesh/mesh.js';
import type { ChatFile, ChatFileState, MessageView } from '../../net/mesh/views.js';
import { FileStore, kindOf } from './file-store.js';
import { FileServer, type FileLinks, Pull } from './file-transfer.js';
import { THIS_COMPUTER } from '../../shared/assistant.js';

/**
 * Files in chats: what you attach is taken into the file store and named in the message by its
 * checksum; everyone in the conversation pulls it straight from a Mac that has it (see
 * file-transfer.ts). Files up to AUTO_BYTES that a friend shares come by themselves; the rest
 * when you click Download. Screens see each file's state (`network.files`).
 *
 * Who may get a file from you: someone in a conversation where somebody else (you, or another
 * member) shared it. Saying you shared it yourself doesn't count, so knowing a checksum isn't
 * enough to get a file you were never sent.
 */

/** Files this size or smaller download on their own when they're shared with you. */
export const AUTO_BYTES = 50 * 1024 * 1024;
/** Files pulled at the same time (the rest wait their turn). */
const PARALLEL = 3;
/** How often progress reaches the screens. */
const PROGRESS_MS = 150;
/** The biggest picture a screen may ask for as data (to show it in the chat). */
export const MAX_PREVIEW = 16 * 1024 * 1024;

export interface ChatFilesOptions {
  readonly mesh: Mesh;
  /** Where the files are kept (normally ~/.beluga/chat-files). */
  readonly dir: string;
  /** File states changed (`null`: forget it). */
  readonly onState?: (patch: Readonly<Record<string, ChatFileState | null>>) => void;
  readonly autoBytes?: number;
}

interface Shared {
  /** conversation → the file as it was first named there, and everyone who shared it there. */
  readonly where: Map<string, { readonly file: ChatFile; readonly posters: Set<string> }>;
}

/** Files known at most (the oldest are forgotten first; their bytes stay). */
const MAX_SHARED = 20_000;

/** A file as it was first shared anywhere. */
const first = (s: Shared): ChatFile => s.where.values().next().value!.file;

export class ChatFiles {
  readonly store: FileStore;
  private readonly server: FileServer;
  private readonly links: FileLinks;
  private readonly shared = new Map<string, Shared>();
  private readonly pulls = new Map<string, Pull>();
  private readonly queue: Array<{ sha: string; conversation?: string }> = [];
  private readonly states = new Map<string, ChatFileState>();
  private patch: Record<string, ChatFileState | null> = {};
  private flushTimer: NodeJS.Timeout | undefined;
  private readonly off: () => void;
  private stopped = false;

  constructor(private readonly opts: ChatFilesOptions) {
    const { mesh } = opts;
    this.store = new FileStore(opts.dir);
    this.links = { send: (peerId, frame) => mesh.sendFile(peerId, frame), isLinked: (peerId) => mesh.isLinked(peerId) };
    this.server = new FileServer(this.links, (sha) => this.store.pathOf(sha), (peerId, sha) => this.mayHave(peerId, sha));
    for (const s of mesh.sharedFiles()) this.index(s.conversation, s.from, s.file);
    for (const [sha, s] of this.shared) {
      const at = this.store.pathOf(sha);
      if (at) this.setState(sha, { state: 'here', path: at, size: first(s).size });
    }
    this.flush();
    const onFile = (from: string, frame: FileFrame): void => this.onFrame(from, frame);
    const onMessage = (m: MessageView): void => this.onMessage(m);
    const onLink = (peerId: string): void => {
      for (const p of this.pulls.values()) p.linked(peerId);
    };
    mesh.on('file', onFile);
    mesh.on('message', onMessage);
    mesh.on('link', onLink);
    mesh.pullingFrom((peerId) => [...this.pulls.values()].some((p) => p.source === peerId));
    this.off = () => {
      mesh.off('file', onFile);
      mesh.off('message', onMessage);
      mesh.off('link', onLink);
      mesh.pullingFrom(() => false);
    };
  }

  /** Take files of yours in to share them: → what the message says about each. */
  async share(paths: readonly string[]): Promise<ChatFile[]> {
    const out: ChatFile[] = [];
    for (const p of paths) out.push(await this.store.add(p));
    for (const f of out) this.setState(f.sha, { state: 'here', path: this.store.pathOf(f.sha)!, size: f.size });
    this.flush();
    return out;
  }

  /** Pasted bytes (a picture from the clipboard) to share. */
  async shareData(name: string, data: Buffer): Promise<ChatFile> {
    const f = await this.store.addData(name, data);
    this.setState(f.sha, { state: 'here', path: this.store.pathOf(f.sha)!, size: f.size });
    this.flush();
    return f;
  }

  /** One part of pasted bytes; → the file once the last part is in. */
  async sharePart(name: string, data: Buffer, part: { id: string; last: boolean }): Promise<ChatFile | undefined> {
    const f = await this.store.addPart(name, data, part);
    if (!f) return undefined;
    this.setState(f.sha, { state: 'here', path: this.store.pathOf(f.sha)!, size: f.size });
    this.flush();
    return f;
  }

  /** Get a file shared in a conversation (now, or when its turn comes). */
  download(sha: string, conversation?: string): void {
    if (this.store.has(sha) || this.pulls.has(sha) || this.queue.some((q) => q.sha === sha)) return;
    const s = this.shared.get(sha);
    if (!s) throw new Error('That file wasn’t shared in any of your conversations');
    this.setState(sha, { state: 'coming', received: 0, size: (conversation ? s.where.get(conversation)?.file.size : undefined) ?? first(s).size });
    this.queue.push({ sha, ...(conversation ? { conversation } : {}) });
    this.flush();
    this.next();
  }

  cancel(sha: string): void {
    const at = this.queue.findIndex((q) => q.sha === sha);
    if (at >= 0) this.queue.splice(at, 1);
    this.pulls.get(sha)?.cancel('cancelled');
    if (at >= 0 || this.states.get(sha)?.state === 'failed') {
      this.setState(sha, null);
      this.flush();
    }
  }

  /** Where a file is on this Mac (it's here). */
  pathOf(sha: string): string {
    const at = this.store.pathOf(sha);
    if (!at) throw new Error(`That file isn’t on ${THIS_COMPUTER} yet`);
    return at;
  }

  /** A picture's bytes, for a screen to show. */
  async preview(sha: string): Promise<{ mime: string; b64: string }> {
    const at = this.pathOf(sha);
    const s = this.shared.get(sha);
    const stat = await fs.stat(at);
    if (stat.size > MAX_PREVIEW) throw new Error('Too big to preview');
    // Not posted yet (waiting in your message box): its type from its name.
    const mime = s ? first(s).mime : kindOf(at).mime;
    if (!mime?.startsWith('image/')) throw new Error('Not a picture');
    return { mime, b64: (await fs.readFile(at)).toString('base64') };
  }

  /** Put a copy where you chose (Save As…). */
  async saveTo(sha: string, target: string): Promise<string> {
    const dest = path.resolve(target);
    await fs.copyFile(this.pathOf(sha), dest);
    return dest;
  }

  /** What's known about a file (as it was first shared). */
  info(sha: string): ChatFile | undefined {
    const s = this.shared.get(sha);
    return s ? first(s) : undefined;
  }

  /** Wait (up to `ms`) for files to be here; → those that are. */
  async whenHere(shas: readonly string[], ms: number): Promise<string[]> {
    const end = Date.now() + ms;
    while (Date.now() < end && !this.stopped) {
      if (shas.every((sha) => this.store.has(sha) || this.states.get(sha)?.state === 'failed')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return shas.filter((sha) => this.store.has(sha));
  }

  stop(): void {
    this.stopped = true;
    this.off();
    for (const p of this.pulls.values()) p.cancel('Beluga stopped');
    clearTimeout(this.flushTimer);
  }

  // ---- inside

  private index(conversation: string, from: string, file: ChatFile): void {
    const known = this.shared.get(file.sha);
    if (!known) {
      if (this.shared.size >= MAX_SHARED) this.shared.delete(this.shared.keys().next().value!);
      this.shared.set(file.sha, { where: new Map([[conversation, { file, posters: new Set([from]) }]]) });
      return;
    }
    const at = known.where.get(conversation);
    if (at) at.posters.add(from);
    else known.where.set(conversation, { file, posters: new Set([from]) });
  }

  /** Did someone other than `peerId` share this file in a conversation you're both in now? */
  private mayHave(peerId: string, sha: string): boolean {
    const s = this.shared.get(sha);
    if (!s) return false;
    return [...s.where].some(([c, at]) => [...at.posters].some((p) => p !== peerId) && this.opts.mesh.shares(c, peerId));
  }

  private onMessage(m: MessageView): void {
    if (!m.files?.length) return;
    for (const f of m.files) this.index(m.conversation, m.from, f);
    // Only what friends share comes by itself (a stranger in a channel can't fill your disk).
    if (m.mine || !this.opts.mesh.isFriend(m.from)) return;
    const auto = this.opts.autoBytes ?? AUTO_BYTES;
    for (const f of m.files) if (f.size <= auto && !this.store.has(f.sha)) this.download(f.sha, m.conversation);
  }

  private onFrame(from: string, frame: FileFrame): void {
    if (frame.t === 'f_get') {
      void this.server.onGet(from, frame);
      return;
    }
    for (const p of this.pulls.values()) {
      if (p.rid !== frame.rid) continue;
      if (frame.t === 'f_data') p.onData(from, frame);
      else p.onError(from, frame);
      return;
    }
  }

  /** Who to ask for a file: whoever shared it (where you saw it first), then everyone else in those conversations. */
  private sourcesOf(sha: string, conversation?: string): string[] {
    const s = this.shared.get(sha);
    if (!s) return [];
    const me = this.opts.mesh.peerId;
    const order = conversation && s.where.has(conversation) ? [conversation, ...[...s.where.keys()].filter((c) => c !== conversation)] : [...s.where.keys()];
    const out: string[] = [];
    for (const c of order) {
      for (const p of [...s.where.get(c)!.posters, ...this.opts.mesh.peopleIn(c)]) if (p !== me && !out.includes(p) && this.opts.mesh.shares(c, p)) out.push(p);
    }
    return out;
  }

  private next(): void {
    while (!this.stopped && this.pulls.size < PARALLEL && this.queue.length) {
      const { sha, conversation } = this.queue.shift()!;
      void this.pull(sha, conversation);
    }
  }

  /** Pull one file (registered at once, so the PARALLEL limit and duplicate checks hold). */
  private async pull(sha: string, conversation?: string): Promise<void> {
    const s = this.shared.get(sha);
    if (!s || this.pulls.has(sha)) return;
    const named = (conversation && s.where.get(conversation)?.file) || first(s);
    const size = named.size;
    const part = this.store.partFor(sha);
    let lastProgress = 0;
    const pull = new Pull(this.links, { sha, size, sources: this.sourcesOf(sha, conversation) }, part, {
      progress: (received) => {
        this.setState(sha, { state: 'coming', received, size });
        const now = Date.now();
        if (now - lastProgress >= PROGRESS_MS) {
          lastProgress = now;
          this.flush();
        } else this.flushSoon();
      },
      waiting: (waiting) => {
        const was = this.states.get(sha);
        this.setState(sha, { state: 'coming', received: was?.received ?? 0, size, ...(waiting ? { error: 'Waiting for someone who has it to come online' } : {}) });
        this.flush();
      },
    });
    this.pulls.set(sha, pull);
    void pull.start();
    const error = await pull.done;
    this.pulls.delete(sha);
    if (error === 'cancelled') {
      await this.store.discard(sha);
      this.setState(sha, null);
    } else if (error) {
      await this.store.discard(sha);
      this.setState(sha, { state: 'failed', size, error: `Didn’t come: ${error}` });
    } else {
      const at = await this.store.finish(sha, named.name);
      this.setState(sha, at ? { state: 'here', path: at, size } : { state: 'failed', size, error: 'It came damaged (the checksum didn’t match)' });
    }
    this.flush();
    this.next();
  }

  private setState(sha: string, state: ChatFileState | null): void {
    if (state) this.states.set(sha, state);
    else this.states.delete(sha);
    this.patch[sha] = state;
  }

  private flushSoon(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, PROGRESS_MS);
    this.flushTimer.unref?.();
  }

  private flush(): void {
    if (!Object.keys(this.patch).length) return;
    const patch = this.patch;
    this.patch = {};
    this.opts.onState?.(patch);
  }
}
