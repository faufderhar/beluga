/**
 * MCP Apps (SEP-1865): what a tool's `_meta` and a `ui://` resource's `_meta.ui` declare. Pure.
 * Everything here comes from a third-party server: unknown shapes are dropped, never trusted.
 */

export type Audience = 'model' | 'app';

/** A tool that has an app: the `ui://` resource to draw, and who may call the tool. */
export interface ToolUi {
  readonly resourceUri: string;
  readonly visibility: readonly Audience[];
}

/** The domains an app may reach (each a plain https or wss origin, maybe with a `*.` subdomain). */
export interface AppCspDomains {
  readonly connectDomains: readonly string[];
  readonly resourceDomains: readonly string[];
  readonly frameDomains: readonly string[];
  readonly baseUriDomains: readonly string[];
}

/** What a `ui://` resource asks of its host. */
export interface ResourceUi {
  readonly csp: AppCspDomains;
  readonly prefersBorder?: boolean;
  /** Browser permissions it asks for (camera, microphone…), by name. Not granted yet. */
  readonly permissions: readonly string[];
}

const URI_MAX = 2048;
const DOMAINS_MAX = 32;
const AUDIENCES: readonly Audience[] = ['model', 'app'];
/** https://host or wss://host, an optional `*.` first label and an optional port. No path, no spaces. */
const DOMAIN = /^(https|wss):\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/i;

/** The app a tool declares, from `ui.resourceUri`, the legacy `ui/resourceUri` or ChatGPT's `openai/outputTemplate`. */
export function toolUiOf(meta: unknown): ToolUi | undefined {
  const m = asRecord(meta);
  if (!m) return undefined;
  const ui = asRecord(m.ui);
  const resourceUri = [ui?.resourceUri, m['ui/resourceUri'], m['openai/outputTemplate']].find(isUiUri);
  if (!resourceUri) return undefined;
  return { resourceUri, visibility: toolVisibility(m) };
}

/**
 * Who may call a tool: the audiences its `_meta.ui.visibility` lists. No `ui` declared: both
 * (SEP-1865's default). A listed visibility is taken as is, so `[]` (Claude Code's answer for a
 * `ui` that failed its checks) is neither.
 */
export function toolVisibility(meta: unknown): readonly Audience[] {
  const ui = asRecord(asRecord(meta)?.ui);
  if (!ui || !Array.isArray(ui.visibility)) return AUDIENCES;
  const listed = ui.visibility as unknown[];
  return AUDIENCES.filter((a) => listed.includes(a));
}

/** What a resource's `_meta.ui` asks for; nothing declared means no network at all. */
export function resourceUiOf(meta: unknown): ResourceUi {
  const ui = asRecord(asRecord(meta)?.ui);
  const csp = asRecord(ui?.csp);
  const permissions = Object.keys(asRecord(ui?.permissions) ?? {}).filter((k) => /^[a-z][a-zA-Z-]{0,40}$/.test(k));
  return {
    csp: { connectDomains: domains(csp?.connectDomains), resourceDomains: domains(csp?.resourceDomains), frameDomains: domains(csp?.frameDomains), baseUriDomains: domains(csp?.baseUriDomains) },
    ...(typeof ui?.prefersBorder === 'boolean' ? { prefersBorder: ui.prefersBorder } : {}),
    permissions,
  };
}

function isUiUri(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('ui://') && v.length <= URI_MAX;
}

function domains(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((d): d is string => typeof d === 'string' && DOMAIN.test(d)).slice(0, DOMAINS_MAX);
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
