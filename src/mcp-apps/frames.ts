import { appCsp } from './domain/csp.js';
import { resourceUiOf } from './domain/ui-meta.js';

/**
 * The frames of MCP Apps: each server's `ui://` resource read once, served by the app host with
 * the CSP its `_meta.ui.csp` asks for, and kept (a failed read is tried again next time).
 */

export interface AppPageHost {
  /** Serve a page with its CSP → its frame URL. */
  add(html: string, csp: string): Promise<string>;
}

export type ReadUiResource = (server: string, uri: string) => Promise<{ readonly html: string; readonly meta?: Record<string, unknown> }>;

export interface AppFrame {
  readonly url: string;
  readonly prefersBorder?: boolean;
}

/** Resources kept (the oldest go). */
const MAX_FRAMES = 100;

export class McpAppFrames {
  private readonly frames = new Map<string, Promise<AppFrame>>();

  /** `frameAncestors`: who may frame an app (the Beluga window). */
  constructor(
    private readonly host: AppPageHost,
    private readonly frameAncestors: string,
  ) {}

  frame(server: string, uri: string, read: ReadUiResource): Promise<AppFrame> {
    const key = `${server}\n${uri}`;
    let frame = this.frames.get(key);
    if (!frame) {
      frame = this.open(server, uri, read);
      this.frames.set(key, frame);
      frame.catch(() => this.frames.get(key) === frame && this.frames.delete(key));
      while (this.frames.size > MAX_FRAMES) this.frames.delete(this.frames.keys().next().value!);
    }
    return frame;
  }

  private async open(server: string, uri: string, read: ReadUiResource): Promise<AppFrame> {
    const { html, meta } = await read(server, uri);
    const ui = resourceUiOf(meta);
    const url = await this.host.add(html, appCsp(ui.csp, this.frameAncestors));
    return { url, ...(ui.prefersBorder !== undefined ? { prefersBorder: ui.prefersBorder } : {}) };
  }
}
