import { randomUUID } from 'node:crypto';
import { ClientStore } from '../client/client-store.js';
import { runAsClient } from '../core/client-context.js';
import type { Intent } from '../core/intents.js';
import type { Session } from '../core/session.js';
import type { ScreenState } from '../core/store.js';
import { type PtyLink, localLink } from '../terminal/emulator.js';
import { type Args, type Method, isMethod, parseArgs } from './api.js';
import { type ApiProxy, type ClientKind, type BelugaClient, type PhoneMirror, apiProxy, toastsFailure } from './client.js';
import { HANDLERS, type Handlers, type Result } from './handlers.js';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A link to a terminal that isn't there (closed, or never started): no output, already ended. */
export const deadLink = (): PtyLink => ({
  write: () => undefined,
  resize: () => undefined,
  onData: () => () => undefined,
  onExit: () => () => undefined,
  running: false,
  exited: { code: null },
});

export interface InProcessOptions {
  readonly kind?: ClientKind;
  readonly id?: string;
  readonly launchDir?: string;
  readonly screen?: ScreenState;
}

/** A screen attached to a core running in the same process (tests). */
export class InProcessClient implements BelugaClient {
  readonly id: string;
  readonly kind: ClientKind;
  readonly store: ClientStore;
  readonly api: ApiProxy;
  readonly launchDir: string;
  private readonly intentListeners = new Set<(intent: Intent) => void>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly session: Session,
    opts: InProcessOptions = {},
  ) {
    this.id = opts.id ?? randomUUID();
    this.kind = opts.kind ?? 'test';
    this.launchDir = opts.launchDir ?? session.launchDir;
    this.store = new ClientStore(session.store, (attention) => session.attend(this.id, attention), opts.screen);
    this.api = apiProxy((method, args) => this.invoke(method, args));
    this.unsubscribe = session.intents.subscribe((intent, target) => {
      if (target !== undefined && target !== this.id) return;
      this.store.applyIntent(intent);
      for (const l of [...this.intentListeners]) l(intent);
    });
  }

  call<M extends Method>(method: M, ...args: Args<M>): Promise<Result<M>> {
    return this.invoke(method, args) as Promise<Result<M>>;
  }

  private invoke(method: Method, raw: readonly unknown[]): Promise<unknown> {
    let promise: Promise<unknown>;
    try {
      if (!isMethod(method)) throw new Error(`Unknown method ${method}`);
      const args = parseArgs(method, raw);
      const handler = HANDLERS[method] as (s: Session, ...a: unknown[]) => unknown;
      promise = Promise.resolve(runAsClient(this.id, () => handler(this.session, ...(args as unknown[]))));
    } catch (err) {
      promise = Promise.reject(err);
    }
    // A failure shows on this screen; callers that wait for the result still get the error.
    if (toastsFailure(method)) promise.catch((err: unknown) => this.store.dispatch({ type: 'toast', text: `Something went wrong: ${errorText(err)}`.slice(0, 200), level: 'error' }));
    return promise;
  }

  onIntent(listener: (intent: Intent) => void): () => void {
    this.intentListeners.add(listener);
    return () => void this.intentListeners.delete(listener);
  }

  attachTerminal(key: string): PtyLink {
    const pty = this.session.workbench?.terminals?.get(key);
    return pty ? localLink(pty) : deadLink();
  }

  watchPhone(): PhoneMirror {
    // The in-process client (terminal UI, tests) has no phone mirror.
    return { onFrame: () => () => {}, onVideo: () => () => {}, onTouch: () => () => {}, onStatus: () => () => {}, close: () => {} };
  }

  close(): void {
    this.unsubscribe();
    this.session.detach(this.id);
    this.store.close();
  }
}

export type { Handlers };
