import { PassThrough, type Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { ACP_LIMITS, type AcpLimits, AcpWatch } from './watch.js';

/** One message this big, or a line still without its end at this size: the agent is broken, not slow. */
export const ACP_MAX_LINE = 16 * 1024 * 1024;

/**
 * A line an agent printed on stdout that is its sign-in, not ACP: a link to open, said with
 * "sign in", "log in" or "authenticate". It waits there for a browser nobody opens.
 */
export function signInLine(line: string): boolean {
  return /\bhttps?:\/\/\S+/i.test(line) && /\b(sign[ -]?in|log[ -]?in|authenticat|authori[sz]e)/i.test(line);
}

export interface AcpWireOptions {
  readonly label: string;
  /** Not signed in, as its fix says it (spec.signInFix). */
  readonly signInFix?: string;
  readonly limits?: Partial<AcpLimits>;
  /** How often it looks (tests: sooner). */
  readonly every?: number;
  readonly now?: () => number;
  /** Ends the agent's process: called once, with why. */
  readonly end: (why: string) => void;
}

/** Between an agent's stdio and the JSON-RPC: what the RPC reads and writes, why it ended, and its notes. */
export interface AcpWire {
  /** What the RPC reads: the agent's lines, each whole. */
  readonly fromAgent: Readable;
  /** What the RPC writes: to the agent's stdin. */
  readonly toAgent: Writable;
  /** Why it ended, when something here knows: the first reason, kept. */
  cause(): string | undefined;
  /** Says why it ended, unless a reason is there already. */
  note(why: string): void;
  /** Its notes for the chat (a turn gone quiet). */
  onNotice(fn: (note: string) => void): void;
  /** Stops looking (the process is gone). */
  stop(): void;
}

/**
 * Frames the agent's output by bytes itself, with a decoder that keeps a character split between
 * two reads whole, so a long history of any language arrives line by line, as sent. Its last line
 * comes through at the end even without a newline. Lines that aren't JSON (a stray log) go on to
 * the RPC, which ignores them, unless one is its sign-in: then the run ends, said as "not signed
 * in", and the link is never repeated. The RPC is held back while it's behind (no line dropped);
 * every frame each way is shown to the watch, which ends a stuck run with why.
 */
export function acpWire(stdout: Readable, stdin: Writable, opts: AcpWireOptions): AcpWire {
  const now = opts.now ?? Date.now;
  const watch = new AcpWatch(opts.label, now(), { ...ACP_LIMITS, ...opts.limits });
  const listeners: Array<(note: string) => void> = [];
  const fromAgent = new PassThrough();
  const decoder = new StringDecoder('utf8');
  let partial = '';
  let why: string | undefined;
  let ended = false;
  const note = (reason: string): void => void (why ??= reason);
  const end = (reason: string): void => {
    note(reason);
    if (ended) return;
    ended = true;
    timer && clearInterval(timer);
    opts.end(why!);
  };

  const line = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.length > ACP_MAX_LINE) return end(`${opts.label} sent a message over ${ACP_MAX_LINE / 1024 / 1024} MB.`);
    let frame: unknown;
    try {
      frame = JSON.parse(trimmed);
    } catch {
      if (signInLine(trimmed)) return end(`${opts.label} is not signed in: it asked to sign in in a browser.${opts.signInFix ? ` ${opts.signInFix}.` : ''}`);
    }
    if (frame && typeof frame === 'object') watch.got(frame as Record<string, unknown>, now());
    if (!fromAgent.write(`${trimmed}\n`)) {
      stdout.pause();
      fromAgent.once('drain', () => stdout.resume());
    }
  };
  const take = (text: string): void => {
    partial += text;
    let at: number;
    while (!ended && (at = partial.indexOf('\n')) !== -1) {
      const one = partial.slice(0, at);
      partial = partial.slice(at + 1);
      line(one);
    }
    if (partial.length > ACP_MAX_LINE) end(`${opts.label} sent a message over ${ACP_MAX_LINE / 1024 / 1024} MB.`);
  };
  stdout.on('data', (chunk: Buffer | string) => {
    if (!ended) take(typeof chunk === 'string' ? chunk : decoder.write(chunk));
  });
  stdout.once('end', () => {
    if (!ended) {
      take(decoder.end());
      if (partial) line(partial);
      partial = '';
    }
    fromAgent.end();
  });
  stdout.once('error', () => fromAgent.end());
  stdin.on('error', () => note(`${opts.label} stopped reading what Beluga sent.`));

  let held = '';
  const toAgent = new Writable({
    write(chunk: Buffer | string, _enc, done) {
      held += String(chunk);
      let at: number;
      while ((at = held.indexOf('\n')) !== -1) {
        const one = held.slice(0, at);
        held = held.slice(at + 1);
        try {
          watch.sent(JSON.parse(one) as Record<string, unknown>, now());
        } catch {
          /* not a frame: the agent reads it as it is */
        }
      }
      if (stdin.destroyed || !stdin.writable) return done();
      // A pipe the agent closed is said by its error (above) and by the RPC closing, not thrown here.
      stdin.write(chunk, () => done());
    },
    final(done) {
      if (!stdin.destroyed) stdin.end();
      done();
    },
  });

  let timer: NodeJS.Timeout | undefined = setInterval(() => {
    const verdict = watch.tick(now());
    if (verdict.notice) for (const fn of listeners) fn(verdict.notice);
    if (verdict.end) end(verdict.end);
  }, opts.every ?? 1_000);
  timer.unref();

  return {
    fromAgent,
    toAgent,
    cause: () => why,
    note,
    onNotice: (fn) => void listeners.push(fn),
    // Only the looking stops: what it printed before it exited still comes through.
    stop: () => {
      timer && clearInterval(timer);
      timer = undefined;
    },
  };
}
