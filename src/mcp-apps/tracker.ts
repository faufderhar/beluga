import type { StepApp } from '../shared/mcp-apps.js';
import type { StepRecord } from '../shared/steps.js';
import { appsSupported } from './domain/capabilities.js';
import { boundStructured } from './domain/result.js';
import { splitMcpToolName } from './domain/tool-name.js';
import { toolUiOf } from './domain/ui-meta.js';
import type { CatalogServer, McpToolCatalog } from './ports/tool-catalog.js';

/**
 * Follows a run's SDK messages beside the StepRecorder and puts on each step of a UI tool what its
 * app needs (shared/mcp-apps.ts): the server, the `ui://` resource and the result's structured
 * content. The lookup of a tool's `_meta` is async: a step recorded before it came back is sent
 * again, with its app, through `emit`. It records apps only while the turn's `system/init` says
 * Claude Code has both MCP Apps capabilities (domain/capabilities.ts): without them the chat looks
 * as it did before MCP Apps.
 */

type AppPlace = Omit<StepApp, 'structuredContent'>;

interface Block {
  readonly type?: string;
  readonly id?: string;
  readonly name?: string;
  readonly tool_use_id?: string;
}

/** The parts of an SDK message the tracker reads. */
export interface TrackedMessage {
  readonly type: string;
  readonly subtype?: string;
  /** On `system/init`: what this Claude Code can do. */
  readonly capabilities?: unknown;
  readonly message?: { readonly content?: unknown };
  readonly tool_use_result?: unknown;
}

export class McpAppTracker {
  /** Steps whose tool has an app. */
  private readonly apps = new Map<string, AppPlace>();
  private readonly structured = new Map<string, unknown>();
  /** The newest record of each MCP tool step whose lookup is still out. */
  private readonly waiting = new Map<string, StepRecord | undefined>();
  /** Tools listed again once already (a server that connected after the first list). */
  private readonly askedAgain = new Set<string>();
  /** The servers and their tools, kept for the run (a failed list is asked again next time). */
  private catalog?: Promise<readonly CatalogServer[]>;
  /** The turn's system/init listed both MCP Apps capabilities. */
  private supported = false;

  constructor(
    private readonly source: McpToolCatalog,
    private readonly emit: (record: StepRecord) => void,
  ) {}

  observe(msg: TrackedMessage): void {
    if (msg.type === 'system' && msg.subtype === 'init') {
      this.supported = appsSupported(msg.capabilities);
      return;
    }
    if (!this.supported) return;
    const blocks = blocksOf(msg.message?.content);
    if (msg.type === 'assistant') {
      for (const b of blocks) if (b.type === 'tool_use' && b.id && b.name?.startsWith('mcp__')) this.lookUp(b.id, b.name);
      return;
    }
    if (msg.type !== 'user' || msg.tool_use_result === undefined) return;
    // tool_use_result belongs to the message's one tool result.
    const results = blocks.filter((b) => b.type === 'tool_result' && b.tool_use_id);
    if (results.length !== 1) return;
    const value = boundStructured(msg.tool_use_result);
    if (value !== undefined) this.structured.set(results[0]!.tool_use_id!, value);
  }

  /** The record with its app, if its tool has one. */
  decorate(record: StepRecord): StepRecord {
    if (this.waiting.has(record.id)) this.waiting.set(record.id, record);
    const app = this.apps.get(record.id);
    if (!app) return record;
    const structuredContent = this.structured.get(record.id);
    return { ...record, app: { ...app, ...(structuredContent !== undefined ? { structuredContent } : {}) } };
  }

  private lookUp(id: string, name: string): void {
    this.waiting.set(id, undefined);
    void this.find(name)
      .catch(() => undefined)
      .then((app) => {
        const latest = this.waiting.get(id);
        this.waiting.delete(id);
        if (!app) return;
        this.apps.set(id, app);
        if (latest) this.emit(this.decorate(latest));
      });
  }

  /** The app of a tool. A tool the list lacks (its server connected later) lists the servers again, once per tool. */
  private async find(name: string): Promise<AppPlace | undefined> {
    const hit = lookIn(await this.servers(), name);
    if (hit.listed || this.askedAgain.has(name)) return hit.app;
    this.askedAgain.add(name);
    this.catalog = undefined;
    return lookIn(await this.servers(), name).app;
  }

  private servers(): Promise<readonly CatalogServer[]> {
    if (this.catalog) return this.catalog;
    const list = this.source.servers();
    this.catalog = list;
    list.catch(() => this.catalog === list && (this.catalog = undefined));
    return list;
  }
}

/** Whether the list has the tool, and its app when it has one. */
function lookIn(servers: readonly CatalogServer[], name: string): { readonly listed: boolean; readonly app?: AppPlace } {
  const split = splitMcpToolName(name, servers.map((s) => s.name));
  if (!split) return { listed: false };
  const tool = servers.find((s) => s.name === split.server)?.tools?.find((t) => t.name === split.tool);
  if (!tool) return { listed: false };
  const ui = toolUiOf(tool._meta);
  return { listed: true, ...(ui ? { app: { server: split.server, tool: split.tool, resourceUri: ui.resourceUri } } : {}) };
}

function blocksOf(content: unknown): Block[] {
  return Array.isArray(content) ? (content as Block[]).filter((b) => b && typeof b === 'object') : [];
}
