import { type DisplayMode, displayModeOf, isOpenableLink } from '../../../../../src/mcp-apps/domain/app-requests.js';
import type { AppActResult, AppReadResult, AppToolResult } from '../../../../../src/shared/mcp-apps.js';

/**
 * The host side of the MCP Apps bridge (SEP-1865): JSON-RPC 2.0 over postMessage with one app's
 * frame. It answers `ui/initialize`, hands the app the tool's input and result, follows its size,
 * and forwards what the app asks of Beluga (tools/call, resources/read, ui/message,
 * ui/update-model-context: checked there), opens its http(s) links and switches it between inline
 * and fullscreen. Every request it doesn't offer is answered method-not-found. Messages from any
 * window but the app's own are ignored. Pure: the frame and React wire it up.
 */

export const PROTOCOL_VERSION = '2026-01-26';
/** The tallest an app is drawn in the chat (px); it scrolls inside past that. */
export const MAX_APP_HEIGHT = 720;
/** The least time between two links an app opens (ms): it can't open tabs in a loop. */
export const LINK_GAP_MS = 2_000;

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
/** Beluga didn't run it: refused, declined, off, or it could not run. */
const NOT_RUN = -32000;

export interface HostContext {
  readonly theme: 'light' | 'dark';
  readonly displayMode: DisplayMode;
  readonly availableDisplayModes?: readonly DisplayMode[];
  readonly containerDimensions: { readonly maxHeight: number; readonly width?: number };
  readonly locale: string;
  readonly platform: 'desktop';
}

/** MCP's CallToolResult, as `ui/notifications/tool-result` carries it. */
export interface ToolResultParams {
  readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

export interface BridgeInit {
  readonly hostContext: HostContext;
  readonly input: Readonly<Record<string, unknown>>;
  /** Absent while the tool runs (see setResult). */
  readonly result?: ToolResultParams | undefined;
}

export interface BridgeEffects {
  /** Post a message to the app's window. */
  post(message: object): void;
  /** The app asked for this height (already capped). */
  size(height: number): void;
  /** tools/call on the app's own server (apps.call). Absent: the app can't call tools. */
  call?(name: string, args: Readonly<Record<string, unknown>>): Promise<AppActResult<AppToolResult>>;
  /** resources/read on the app's own server (apps.read). */
  read?(uri: string): Promise<AppActResult<AppReadResult>>;
  /** ui/message: said in the chat as the app's, and asked of your Claude (apps.message). */
  message?(params: unknown): Promise<AppActResult<object>>;
  /** ui/update-model-context: for your Claude's next turn (apps.context). */
  context?(params: unknown): Promise<AppActResult<object>>;
  /** ui/open-link, an http(s) URL already checked: open it in the browser. */
  openLink?(url: string): void;
  /** ui/request-display-mode: draw the app this way now. */
  displayMode?(mode: DisplayMode): void;
  /** The clock (tests). */
  now?(): number;
}

const MODES: readonly DisplayMode[] = ['inline', 'fullscreen'];

interface RpcMessage {
  readonly jsonrpc: '2.0';
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: unknown;
}

export class AppBridge {
  private initialized = false;
  private result: ToolResultParams | undefined;
  private resultSent = false;
  private nextId = 1;
  private mode: DisplayMode;
  private lastLink = -Infinity;

  constructor(
    private readonly init: BridgeInit,
    private readonly fx: BridgeEffects,
  ) {
    this.result = init.result;
    this.mode = init.hostContext.displayMode;
  }

  /** A message event: `source` is who sent it, `frame` the app's own window. */
  receive(source: unknown, frame: unknown, data: unknown): void {
    if (!source || source !== frame || !isRpc(data) || !data.method) return;
    if (data.id === undefined) return this.notification(data.method, data.params);
    this.request(data.id, data.method, data.params);
  }

  /** The tool's result arrived (it was running when the app opened): sent once the app is ready. */
  setResult(result: ToolResultParams): void {
    this.result = result;
    this.sendResult();
  }

  /** The host changed the app's display mode by itself (Esc left fullscreen): the app is told. */
  setDisplayMode(mode: DisplayMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.fx.post({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { displayMode: mode } });
  }

  /** The app is going away: it may save what it holds. */
  teardown(): void {
    this.fx.post({ jsonrpc: '2.0', id: `teardown-${this.nextId++}`, method: 'ui/resource-teardown', params: {} });
  }

  private request(id: string | number, method: string, params: unknown): void {
    if (method === 'ui/initialize') {
      return this.fx.post({
        jsonrpc: '2.0',
        id,
        result: { protocolVersion: PROTOCOL_VERSION, hostInfo: { name: 'Beluga', version: '1' }, hostCapabilities: this.capabilities(), hostContext: this.hostContext() },
      });
    }
    if (method === 'ping') return this.fx.post({ jsonrpc: '2.0', id, result: {} });
    const p = asRecord(params);
    if (method === 'tools/call' && this.fx.call) {
      const args = p?.arguments ?? {};
      if (typeof p?.name !== 'string' || !p.name || !asRecord(args)) return this.error(id, INVALID_PARAMS, 'tools/call needs a tool name and an arguments object.');
      return this.answer(id, this.fx.call(p.name, args as Record<string, unknown>));
    }
    if (method === 'resources/read' && this.fx.read) {
      if (typeof p?.uri !== 'string' || !p.uri) return this.error(id, INVALID_PARAMS, 'resources/read needs a uri.');
      return this.answer(id, this.fx.read(p.uri));
    }
    if (method === 'ui/message' && this.fx.message) return this.answer(id, this.fx.message(params));
    if (method === 'ui/update-model-context' && this.fx.context) return this.answer(id, this.fx.context(params));
    if (method === 'ui/open-link' && this.fx.openLink) {
      if (!isOpenableLink(p?.url)) return this.error(id, INVALID_PARAMS, 'Only http and https links open.');
      const now = this.fx.now?.() ?? Date.now();
      if (now - this.lastLink < LINK_GAP_MS) return this.error(id, NOT_RUN, 'Links open one at a time. Try again in a moment.');
      this.lastLink = now;
      this.fx.openLink(p.url);
      return this.fx.post({ jsonrpc: '2.0', id, result: {} });
    }
    if (method === 'ui/request-display-mode' && this.fx.displayMode) return this.requestMode(id, p?.mode);
    this.error(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }

  /** What this host offers the app, as SEP-1865 names it. */
  private capabilities(): Record<string, object> {
    return {
      ...(this.fx.call ? { serverTools: {} } : {}),
      ...(this.fx.read ? { serverResources: {} } : {}),
      ...(this.fx.message ? { message: {} } : {}),
      ...(this.fx.context ? { updateModelContext: {} } : {}),
      ...(this.fx.openLink ? { openLinks: {} } : {}),
    };
  }

  private hostContext(): HostContext {
    return { ...this.init.hostContext, displayMode: this.mode, ...(this.fx.displayMode ? { availableDisplayModes: MODES } : {}) };
  }

  /** Answers with the mode it is in now, then tells the app its context changed (when it did). */
  private requestMode(id: string | number, asked: unknown): void {
    const mode = displayModeOf(asked);
    if (!mode) return this.error(id, INVALID_PARAMS, `Display modes here: ${MODES.join(', ')}.`);
    const changed = mode !== this.mode;
    this.mode = mode;
    if (changed) this.fx.displayMode!(mode);
    this.fx.post({ jsonrpc: '2.0', id, result: { mode } });
    if (changed) this.fx.post({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { displayMode: mode } });
  }

  private answer(id: string | number, pending: Promise<AppActResult<unknown>>): void {
    pending.then(
      (r) => (r.ok ? this.fx.post({ jsonrpc: '2.0', id, result: r.result }) : this.error(id, NOT_RUN, r.message)),
      (err: unknown) => this.error(id, NOT_RUN, err instanceof Error ? err.message : String(err)),
    );
  }

  private error(id: string | number, code: number, message: string): void {
    this.fx.post({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private notification(method: string, params: unknown): void {
    if (method === 'ui/notifications/initialized') {
      if (this.initialized) return;
      this.initialized = true;
      this.fx.post({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: this.init.input } });
      return this.sendResult();
    }
    if (method === 'ui/notifications/size-changed') {
      const height = (params as { height?: unknown } | undefined)?.height;
      if (typeof height === 'number' && Number.isFinite(height) && height > 0) this.fx.size(Math.min(Math.ceil(height), MAX_APP_HEIGHT));
    }
  }

  private sendResult(): void {
    if (!this.initialized || !this.result || this.resultSent) return;
    this.resultSent = true;
    this.fx.post({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: this.result });
  }
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function isRpc(data: unknown): data is RpcMessage {
  return Boolean(data) && typeof data === 'object' && (data as { jsonrpc?: unknown }).jsonrpc === '2.0';
}
