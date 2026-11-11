import type { ClientStore } from '../client/client-store.js';
import type { Intent } from '../core/intents.js';
import type { PtyLink } from '../terminal/emulator.js';
import type { Args, Method } from './api.js';
import type { Result } from './handlers.js';

/**
 * How a screen talks to Beluga, whether Beluga runs in the same process (tests) or in
 * the daemon (several screens at once, the Mac app). Browser-safe.
 */
/** A phone's live screen as this screen sees it (BLG-173): frames in, status, and stop. */
export interface PhoneMirror {
  onFrame(listener: (f: { b64: string; mime: string; w: number; h: number }) => void): () => void;
  /** Live video pieces (when watched with `video`): H.264 Annex B, `w`×`h` of a `sw`×`sh` screen. */
  onVideo(listener: (p: PhoneVideoPiece) => void): () => void;
  /** What Claude does on the phone meanwhile (BLG-186), in the screen's pixels. */
  onTouch(listener: (t: PhoneTouchData) => void): () => void;
  onStatus(listener: (s: PhoneMirrorStatus) => void): () => void;
  close(): void;
}

export type { PhoneTouchData } from './protocol.js';
import type { PhoneTouchData } from './protocol.js';

export interface PhoneVideoPiece {
  readonly b64: string;
  readonly key: boolean;
  readonly ts: number;
  readonly w: number;
  readonly h: number;
  readonly sw: number;
  readonly sh: number;
}

/** How the mirror is doing; `video`: live video is waiting for "Start now" on the phone, or flowing. */
export interface PhoneMirrorStatus {
  readonly on: boolean;
  readonly route?: string;
  readonly error?: string;
  readonly video?: 'asking' | 'on';
  readonly note?: string;
}

export interface BelugaClient {
  /** Which kind of screen this is. */
  readonly kind: ClientKind;
  /** The shared state plus this screen's own (what it draws). */
  readonly store: ClientStore;
  /** Every API method, grouped: `client.api.workspaces.open(id, 'chat')`. */
  readonly api: ApiProxy;
  /** Call one API method by name. */
  call<M extends Method>(method: M, ...args: Args<M>): Promise<Result<M>>;
  /** What the core asks this screen to do beyond its state (the store already shows navigation, dialogs and toasts). */
  onIntent(listener: (intent: Intent) => void): () => void;
  /** Attach to a terminal program by key (bytes both ways). */
  attachTerminal(key: string): PtyLink;
  /** Watch a phone's screen live (BLG-173): frames in, until close(). */
  watchPhone(device: string, opts?: { fps?: number; max?: number; video?: boolean }): PhoneMirror;
  /** Folder this screen was started in (new stand-alone chats run here). */
  readonly launchDir: string;
  /** Detach (the core keeps running for other screens). */
  close(): void;
}

/**
 * The Mac app, a browser on the web port (set by the daemon, never claimed), a command run once
 * (`beluga web`), a test, or your own app driving this computer over its link (BLG-775, set by the
 * daemon for a device of yours, never claimed).
 */
export type ClientKind = 'mac' | 'web' | 'cli' | 'test' | 'machine';
/** What a screen may say it is in its hello. */
export type HelloKind = Exclude<ClientKind, 'web' | 'machine'>;

type Group<M> = M extends `${infer G}.${string}` ? G : never;
type NameIn<M, G extends string> = M extends `${G}.${infer N}` ? N : never;

/** The API as nested objects: `api.workspaces.open(...)` calls 'workspaces.open'. */
export type ApiProxy = {
  readonly [G in Group<Method>]: {
    readonly [N in NameIn<Method, G>]: `${G}.${N}` extends infer M extends Method ? (...args: Args<M>) => Promise<Result<M>> : never;
  };
};

export type Call = <M extends Method>(method: M, ...args: Args<M>) => Promise<Result<M>>;

/**
 * Calls whose failure the screen shows in place, so they raise no "Something went wrong" toast:
 * a picture in an answer whose file an agent has since deleted shows a placeholder, not an error.
 */
const QUIET_METHODS: ReadonlySet<Method> = new Set<Method>(['files.version', 'files.readImageFile']);

/** Whether a failed call should say so in a toast (the screen shows the rest itself). */
export const toastsFailure = (method: Method): boolean => !QUIET_METHODS.has(method);

/** Build the grouped API over a call function (calls are made lazily by name). */
export function apiProxy(call: (method: Method, args: readonly unknown[]) => Promise<unknown>): ApiProxy {
  const groups = new Map<string, Record<string, unknown>>();
  return new Proxy({} as ApiProxy, {
    get: (_target, group) => {
      if (typeof group !== 'string') return undefined;
      let methods = groups.get(group);
      if (!methods) {
        methods = new Proxy({} as Record<string, unknown>, {
          get: (_t, name) => (typeof name === 'string' ? (...args: unknown[]) => call(`${group}.${name}` as Method, args) : undefined),
        });
        groups.set(group, methods);
      }
      return methods;
    },
  });
}
