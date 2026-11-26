import { z } from 'zod';
import type { Intent } from '../core/intents.js';
import type { Action, DomainState } from '../core/store.js';
import { decode, encode } from '../shared/codec.js';

/**
 * How screens talk to the beluga daemon on this computer: one WebSocket on 127.0.0.1, a token
 * from $BELUGA_HOME/daemon.json, then a snapshot of the shared state followed by the stream of
 * actions that change it (every client replays them with the same reducer). Browser-safe.
 */
export const IPC_VERSION = 1;

/** Capabilities a screen may offer: things only it can do (its clipboard, its notifications…). */
/** `raise`: bring the window to the front (the Mac app; Open on your Mac from the phone). */
export const CAPS = ['copyText', 'notify', 'openExternal', 'zoom', 'readClipboardImage', 'raise'] as const;
export type Cap = (typeof CAPS)[number];

/**
 * What one of your computers may ask your app to do while you drive it (BLG-776): tell you
 * something, copy, come to the front, read a pasted image, and open a web page (http or https
 * only: never a file, an app's own scheme or anything else on your Mac).
 */
export const COMPUTER_CAPS: readonly Cap[] = ['notify', 'copyText', 'raise', 'readClipboardImage', 'openExternal'];

/** A link a computer may have your app open: an absolute http(s) URL. */
export function webUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const id = z.string().min(1).max(200);
const term = z.string().min(1).max(200);

/** Screen → daemon. */
export const ClientFrame = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    token: z.string().min(16).max(200),
    ipc: z.number().int(),
    kind: z.enum(['mac', 'cli', 'test']),
    version: z.string().max(40),
    launchDir: z.string().max(4096).optional(),
    // A newer screen offers caps this daemon doesn't know: those are left out, never the whole hello
    // (it was dropped, and the screen only saw "the daemon did not answer").
    caps: z
      .array(z.string().max(40))
      .max(32)
      .default([])
      .transform((caps) => caps.filter((c): c is Cap => (CAPS as readonly string[]).includes(c))),
  }),
  z.object({ t: z.literal('call'), id, method: z.string().max(100), args: z.array(z.unknown()).max(20) }),
  z.object({
    t: z.literal('attention'),
    attention: z.object({ shown: z.array(z.string().max(200)).max(50), visible: z.array(z.string().max(200)).max(50), files: z.boolean(), front: z.boolean().optional() }),
  }),
  z.object({ t: z.literal('cap_result'), id, ok: z.boolean(), value: z.unknown().optional(), error: z.string().max(2000).optional() }),
  // `flow` (BLG-963): this screen answers with `term_ack` as it draws, and the program waits while it's far behind.
  z.object({ t: z.literal('term_attach'), term, flow: z.boolean().optional() }),
  z.object({ t: z.literal('term_ack'), term, chars: z.number().int().min(0).max(1_000_000_000) }),
  z.object({ t: z.literal('term_detach'), term }),
  z.object({ t: z.literal('term_input'), term, data: z.string().max(1_000_000), reply: z.boolean().optional() }),
  z.object({ t: z.literal('term_resize'), term, cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(500) }),
  // Watch a phone's screen live (BLG-173): the daemon streams `phone_frame`s until unwatch or close;
  // with `video` (this screen decodes H.264, BLG-184), `phone_video` pieces once the phone streams.
  z.object({ t: z.literal('phone_watch'), device: id, fps: z.number().int().min(1).max(30).optional(), max: z.number().int().min(240).max(2000).optional(), video: z.boolean().optional() }),
  z.object({ t: z.literal('phone_unwatch'), device: id }),
  z.object({ t: z.literal('resync') }),
  z.object({ t: z.literal('ping') }),
]);
export type ClientFrame = z.input<typeof ClientFrame>;

/** Daemon → screen (trusted: the daemon is this computer's own Beluga). */
export type DaemonFrame =
  | { readonly t: 'welcome'; readonly clientId: string; readonly version: string; readonly ipc: number; readonly snapshot: DomainState; readonly seq: number; readonly clients: number }
  | { readonly t: 'snapshot'; readonly snapshot: DomainState; readonly seq: number }
  | { readonly t: 'action'; readonly seq: number; readonly action: Action }
  | { readonly t: 'result'; readonly id: string; readonly ok: boolean; readonly value?: unknown; readonly error?: string }
  | { readonly t: 'intent'; readonly intent: Intent }
  | { readonly t: 'cap_call'; readonly id: string; readonly cap: Cap; readonly args: readonly unknown[] }
  | { readonly t: 'term_data'; readonly term: string; readonly data: string }
  | { readonly t: 'term_status'; readonly term: string; readonly running: boolean; readonly exited?: { readonly code: number | null; readonly signal?: number } }
  // A live frame of a phone's screen (BLG-173): a base64 image of `mime`, and the device's logical size.
  | { readonly t: 'phone_frame'; readonly device: string; readonly b64: string; readonly mime: string; readonly w: number; readonly h: number }
  // A piece of the phone's screen as live video (BLG-184): H.264 Annex B, `w`×`h` of a `sw`×`sh` screen.
  | { readonly t: 'phone_video'; readonly device: string; readonly b64: string; readonly key: boolean; readonly ts: number; readonly w: number; readonly h: number; readonly sw: number; readonly sh: number }
  // Something Claude just did on the phone (BLG-186): where a tap landed, a swipe's path, a key; never what was typed.
  | { readonly t: 'phone_touch'; readonly device: string; readonly touch: PhoneTouchData }
  // How the mirror is doing: streaming (with its route, and whether video is asked for or flowing), or stopped with a reason.
  | { readonly t: 'phone_mirror'; readonly device: string; readonly on: boolean; readonly route?: string; readonly error?: string; readonly video?: 'asking' | 'on'; readonly note?: string }
  | { readonly t: 'clients'; readonly count: number }
  | { readonly t: 'pong' }
  // `update` (BLG-775): which side to update when a computer and your app speak different versions.
  | { readonly t: 'bye'; readonly reason: string; readonly update?: 'computer' | 'app' };

/** A touch as the mirror draws it (src/companion/phone-control.ts PhoneTouch). */
export interface PhoneTouchData {
  readonly op: 'tap' | 'long_press' | 'swipe' | 'type' | 'key' | 'scroll' | 'open';
  readonly x?: number;
  readonly y?: number;
  readonly x2?: number;
  readonly y2?: number;
  readonly what?: string;
}

export const encodeFrame = (frame: ClientFrame | DaemonFrame): string => encode(frame);

/** Parse a frame from a screen; undefined when it isn't one. */
export function parseClientFrame(text: string): z.output<typeof ClientFrame> | undefined {
  let raw: unknown;
  try {
    raw = decode(text);
  } catch {
    return undefined;
  }
  const parsed = ClientFrame.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export const parseDaemonFrame = (text: string): DaemonFrame => decode(text) as DaemonFrame;

/** What $BELUGA_HOME/daemon.json says about the running daemon. */
export const DaemonInfo = z.object({
  pid: z.number().int().min(2),
  port: z.number().int().min(1).max(65535),
  token: z.string().min(16),
  version: z.string(),
  ipc: z.number().int(),
  room: z.string(),
  /** Which room it's in: 'host', 'demo', or a fingerprint of the invite it joined with. */
  roomKey: z.string().default('host'),
  startedAt: z.number(),
  keepAlive: z.boolean().optional(),
  /** Where its workspaces' records and saved conversations are (history/<id>.json): the demo's own folder, else $KLAUD_HOME. */
  workspaces: z.string().optional(),
});
export type DaemonInfo = z.infer<typeof DaemonInfo>;
