import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type IncomingMessage, type Server, createServer } from 'node:http';
import type { AttrValue, OtlpLog } from './otlp.js';
import { event, pseudonym } from './otlp.js';
import type { TurnCall, TurnHook } from './turn.js';

/**
 * Claude Code's own telemetry (code.claude.com/docs/en/monitoring-usage), caught on this computer:
 * Claude runs Beluga starts export to a receiver here (127.0.0.1, a token of its own), never
 * anywhere else. From it come each model request (model, tokens, cost, how long), for the turn's
 * spans, the hooks that ran and what decided each tool call, for the turn's events, and its other
 * events and counters (tools, permission decisions, compactions, MCP
 * connections, lines changed, commits, pull requests) as `ratel.beluga.claude_code.*` records.
 *
 * Only the fields listed in KEEP survive: Claude Code always adds your email, organization and
 * account ids, and those, prompts, answers, commands, paths and error messages never leave.
 * Claude Code's prompt and tool-detail logging is never turned on. Someone who already sends Claude
 * Code's telemetry somewhere of their own keeps that: nothing is changed for them.
 */

/** Fields kept from Claude Code's events and counters (all others dropped). */
const KEEP = new Set([
  'model', 'query_source', 'speed', 'effort', 'duration_ms', 'cost_usd', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens',
  'cache_creation_5m_tokens', 'cache_creation_1h_tokens', 'status_code', 'attempt', 'tool_name', 'success', 'error_type', 'decision', 'decision_type', 'decision_source',
  'source', 'tool_source', 'permission_mode', 'classifier_verdict', 'from_mode', 'to_mode', 'trigger', 'status', 'transport_type', 'server_scope', 'is_plugin',
  'mcp_server_scope', 'tool_input_size_bytes', 'tool_result_size_bytes', 'start_type', 'type', 'language', 'auth_method', 'error_category', 'error_name', 'error_code',
  'command_source', 'prompt_length', 'response_length', 'has_category', 'has_explanation', 'app.version', 'server_fallback_hop',
]);
/** Events not forwarded: the requests become spans; prompts, answers and raw bodies are text. */
const NOT_FORWARDED = new Set(['api_request', 'user_prompt', 'assistant_response', 'api_request_body', 'api_response_body', 'managed_settings_resolved']);
/** How Claude Code says the model itself called a skill (anything else: you did, with a slash command). */
const SKILL_BY_MODEL = 'nested-skill';
/** A user who set up Claude Code's telemetry themselves: theirs wins. */
export const THEIRS = [
  'CLAUDE_CODE_ENABLE_TELEMETRY', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT', 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_EXPORTER_OTLP_LOGS_HEADERS', 'OTEL_EXPORTER_OTLP_METRICS_HEADERS', 'OTEL_LOGS_EXPORTER', 'OTEL_METRICS_EXPORTER', 'OTEL_TRACES_EXPORTER',
];

/** Claude Code's own settings (its `env` is where people usually turn its telemetry on). */
const claudeSettingsFile = (env: NodeJS.ProcessEnv): string => path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');

/** The variables Claude Code's settings.json sets (read again only when the file changed). */
function settingsEnv(file: string, cache: { stamp?: string; env?: Record<string, unknown> }): Record<string, unknown> {
  let stamp = '';
  try {
    const st = statSync(file);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    return {};
  }
  if (cache.stamp !== stamp) {
    cache.stamp = stamp;
    try {
      const env = (JSON.parse(readFileSync(file, 'utf8')) as { env?: unknown }).env;
      cache.env = env && typeof env === 'object' ? (env as Record<string, unknown>) : {};
    } catch {
      cache.env = {};
    }
  }
  return cache.env ?? {};
}

const MAX_BODY = 4 * 1024 * 1024;
const KEEP_CALLS_MS = 15 * 60_000;
const MAX_CALLS_PER_SESSION = 2_000;
const MAX_REFUSED_PER_SESSION = 500;
const MAX_LINKS_PER_SESSION = 5_000;
const MAX_SKILLS_PER_SESSION = 500;
const MAX_HOOKS_PER_SESSION = 2_000;
/** The scope Claude Code's events come under. */
const CLAUDE_SCOPE = /^com\.anthropic\.claude_code\b/;

/** How a tool call was refused: someone (or a rule) said no, or the user interrupted. */
export type Refusal = 'denied' | 'aborted';

/** What ties a tool call to the model request that asked for it and to the sub-agent that made it. Never sent. */
export interface ToolLink {
  readonly requestId?: string;
  readonly agentId?: string;
  /** Whether Claude Code let it run, and what decided ("config", "hook", "user_temporary"…). These two are sent. */
  readonly decision?: 'allow' | 'deny';
  readonly decisionSource?: string;
}

type Json = Record<string, unknown>;

/** An OTLP attribute's value, flattened (lists and maps left out). */
function plain(v: unknown): AttrValue {
  const o = (v ?? {}) as Json;
  if (typeof o.stringValue === 'string') return o.stringValue.slice(0, 200);
  if (o.intValue !== undefined) return Number(o.intValue);
  if (typeof o.doubleValue === 'number') return o.doubleValue;
  if (typeof o.boolValue === 'boolean') return o.boolValue;
  return undefined;
}

const attrMap = (list: unknown): Map<string, AttrValue> => new Map(((list as Array<{ key?: string; value?: unknown }>) ?? []).flatMap((a) => (a.key ? [[a.key, plain(a.value)] as const] : [])));

/** A field of that name when the value is text, else nothing. */
const text = <K extends string>(key: K, v: AttrValue): { [P in K]?: string } => (typeof v === 'string' && v ? ({ [key]: v } as { [P in K]?: string }) : {});
const short = (v: AttrValue): AttrValue => (typeof v === 'string' ? v.slice(0, 80) : undefined);
const num = (v: AttrValue): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : 0);
const msOf = (nano: unknown, fallback: number): number => {
  const s = typeof nano === 'string' || typeof nano === 'number' ? String(nano) : '';
  return /^\d{13,}$/.test(s) ? Number(BigInt(s) / 1_000_000n) : fallback;
};

export interface ClaudeOtelDeps {
  /** Forward one record (dropped by the caller at levels that don't send). */
  readonly emit: (record: OtlpLog) => void;
  /** This install's id, to pseudonymize session ids. */
  readonly installId: () => string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}

export class ClaudeOtel {
  private server?: Server;
  private port?: number;
  private readonly token = randomBytes(16).toString('hex');
  private readonly calls = new Map<string, TurnCall[]>();
  private readonly refused = new Map<string, { readonly at: number; readonly tools: Map<string, Refusal> }>();
  private readonly links = new Map<string, { at: number; readonly tools: Map<string, ToolLink> }>();
  private readonly skills = new Map<string, Array<{ readonly at: number; readonly source: string }>>();
  private readonly hooks = new Map<string, TurnHook[]>();
  private readonly settingsCache: { stamp?: string; env?: Record<string, unknown> } = {};

  constructor(private readonly deps: ClaudeOtelDeps) {}

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => void this.receive(req).then((code) => res.writeHead(code).end(), () => res.writeHead(400).end()));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    server.unref();
    const addr = server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : undefined;
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
    this.port = undefined;
    this.calls.clear();
    this.refused.clear();
    this.links.clear();
    this.skills.clear();
    this.hooks.clear();
  }

  /** What a Claude run's process gets, or nothing (not listening, or the user sends Claude Code's telemetry elsewhere). */
  env(): Readonly<Record<string, string>> | undefined {
    const env = this.deps.env ?? process.env;
    if (!this.port || THEIRS.some((k) => env[k])) return undefined;
    // Set up in Claude Code's own settings: theirs too, left alone.
    const settings = settingsEnv(claudeSettingsFile(env), this.settingsCache);
    if (THEIRS.some((k) => settings[k] !== undefined && settings[k] !== '')) return undefined;
    return {
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${this.port}`,
      OTEL_EXPORTER_OTLP_HEADERS: `authorization=Bearer ${this.token}`,
      OTEL_LOGS_EXPORT_INTERVAL: '1000',
      // Kept here only to tie a request to its turn; never sent.
      OTEL_METRICS_INCLUDE_SESSION_ID: 'true',
      OTEL_METRICS_INCLUDE_ACCOUNT_UUID: 'false',
      OTEL_METRICS_INCLUDE_VERSION: 'true',
    };
  }

  /** The model requests of a session in a window (taken: each is used once). */
  callsFor(session: string, from: number, to: number): TurnCall[] {
    const list = this.calls.get(session);
    if (!list) return [];
    const mine = list.filter((c) => c.at >= from && c.at <= to);
    const rest = list.filter((c) => c.at < from || c.at > to);
    if (rest.length) this.calls.set(session, rest);
    else this.calls.delete(session);
    return mine;
  }

  /** The tool calls of a session that were refused, by tool call id (taken: each is used once). Never sent by id. */
  refusedFor(session: string): ReadonlyMap<string, Refusal> {
    const mine = this.refused.get(session)?.tools ?? new Map<string, Refusal>();
    this.refused.delete(session);
    return mine;
  }

  /**
   * Which request asked for each of these tool calls, and which sub-agent made it, by tool call id
   * (taken: each is used once). Only the ids asked for: another turn's calls stay for that turn.
   */
  linksFor(session: string, ids: Iterable<string>): ReadonlyMap<string, ToolLink> {
    const kept = this.links.get(session)?.tools;
    const mine = new Map<string, ToolLink>();
    if (!kept) return mine;
    for (const id of ids) {
      const link = kept.get(id);
      if (link) mine.set(id, link);
      kept.delete(id);
    }
    if (!kept.size) this.links.delete(session);
    return mine;
  }

  /** Where each skill the model called in a window lives ("projectSettings", "userSettings", "plugin"…), in order (taken). */
  skillsFor(session: string, from: number, to: number): string[] {
    const list = this.skills.get(session) ?? [];
    const rest = list.filter((s) => s.at < from || s.at > to);
    if (rest.length) this.skills.set(session, rest);
    else this.skills.delete(session);
    return list.filter((s) => s.at >= from && s.at <= to).map((s) => s.source);
  }

  /** The hooks that ran in a session in a window, in order (taken: each is used once). */
  hooksFor(session: string, from: number, to: number): TurnHook[] {
    const list = this.hooks.get(session) ?? [];
    const rest = list.filter((h) => h.at < from || h.at > to);
    if (rest.length) this.hooks.set(session, rest);
    else this.hooks.delete(session);
    return list.filter((h) => h.at >= from && h.at <= to);
  }

  /** Read one export. → the status to answer. Exposed for tests. */
  async receive(req: IncomingMessage): Promise<number> {
    if (req.method !== 'POST') return 405;
    if (req.headers.authorization !== `Bearer ${this.token}`) return 401;
    const body = await readBody(req);
    if (body === undefined) return 413;
    let json: Json;
    try {
      json = JSON.parse(body) as Json;
    } catch {
      return 400;
    }
    if (req.url?.startsWith('/v1/logs')) this.logs(json);
    else if (req.url?.startsWith('/v1/metrics')) this.metrics(json);
    return 200;
  }

  logs(json: Json): void {
    const now = this.deps.now?.() ?? Date.now();
    for (const rl of (json.resourceLogs as Json[]) ?? []) {
      for (const sl of (rl.scopeLogs as Json[]) ?? []) {
        const scope = String((sl.scope as Json | undefined)?.name ?? '');
        for (const r of (sl.logRecords as Json[]) ?? []) {
          const a = attrMap(r.attributes);
          // Only Claude Code's own events: anything else that found this port is dropped.
          const name = eventName(a.get('event.name'), plain(r.body), scope);
          if (!name) continue;
          const at = msOf(r.timeUnixNano, msOf(r.observedTimeUnixNano, now));
          const session = typeof a.get('session.id') === 'string' ? (a.get('session.id') as string) : undefined;
          if ((name === 'api_request' || name === 'api_error') && session) this.call(session, at, name, a);
          if (name === 'tool_decision' && session) this.decision(session, at, a);
          if ((name === 'tool_decision' || name === 'tool_result') && session) this.link(session, at, a);
          if (name === 'skill_activated' && session) this.skill(session, at, a);
          if (name === 'hook_execution_complete' && session) this.hook(session, at, a);
          if (NOT_FORWARDED.has(name)) continue;
          this.deps.emit(event(`claude_code.${name}`, at, this.kept(a, session)));
        }
      }
    }
    this.prune(now);
  }

  metrics(json: Json): void {
    const now = this.deps.now?.() ?? Date.now();
    for (const rm of (json.resourceMetrics as Json[]) ?? []) {
      for (const sm of (rm.scopeMetrics as Json[]) ?? []) {
        for (const m of (sm.metrics as Json[]) ?? []) {
          const raw = String(m.name ?? '');
          if (!/^claude_code\.[a-z_.]{1,60}$/.test(raw)) continue;
          const name = raw.slice('claude_code.'.length);
          const data = ((m.sum as Json)?.dataPoints ?? (m.gauge as Json)?.dataPoints ?? []) as Json[];
          for (const p of data) {
            const a = attrMap(p.attributes);
            const value = p.asDouble !== undefined ? Number(p.asDouble) : Number(p.asInt ?? 0);
            if (!name || !Number.isFinite(value)) continue;
            const session = typeof a.get('session.id') === 'string' ? (a.get('session.id') as string) : undefined;
            this.deps.emit(event('claude_code.metric', msOf(p.timeUnixNano, now), { metric: name, value, ...this.kept(a, session) }));
          }
        }
      }
    }
  }

  private call(session: string, at: number, name: string, a: Map<string, AttrValue>): void {
    const model = a.get('model');
    const source = a.get('query_source');
    const call: TurnCall = {
      ...(typeof model === 'string' ? { model } : {}),
      ...(typeof source === 'string' ? { source } : {}),
      ...text('requestId', a.get('request_id')),
      ...text('agentId', a.get('agent_id')),
      ...text('agentName', a.get('agent.name')),
      at,
      durationMs: num(a.get('duration_ms')),
      usage: { input: num(a.get('input_tokens')), output: num(a.get('output_tokens')), cacheRead: num(a.get('cache_read_tokens')), cacheWrite: num(a.get('cache_creation_tokens')), cost: num(a.get('cost_usd')) },
      ...(name === 'api_error' ? { error: `http_${num(a.get('status_code')) || 'error'}` } : {}),
    };
    const list = this.calls.get(session) ?? [];
    list.push(call);
    if (list.length > MAX_CALLS_PER_SESSION) list.shift();
    this.calls.set(session, list);
  }

  /** A refused tool call, kept by its id until its turn asks (the id itself never leaves). */
  private decision(session: string, at: number, a: Map<string, AttrValue>): void {
    const id = a.get('tool_use_id');
    if (a.get('decision') !== 'reject' || typeof id !== 'string') return;
    const tools = this.refused.get(session)?.tools ?? new Map<string, Refusal>();
    tools.set(id, a.get('source') === 'user_abort' ? 'aborted' : 'denied');
    if (tools.size > MAX_REFUSED_PER_SESSION) tools.delete(tools.keys().next().value!);
    this.refused.set(session, { at, tools });
  }

  /** A tool call's request and sub-agent, kept by its id until its turn asks. */
  private link(session: string, at: number, a: Map<string, AttrValue>): void {
    const id = a.get('tool_use_id');
    if (typeof id !== 'string') return;
    const tools = this.links.get(session)?.tools ?? new Map<string, ToolLink>();
    const decided = a.get('decision');
    const decision = decided === 'accept' ? { decision: 'allow' as const } : decided === 'reject' ? { decision: 'deny' as const } : {};
    const source = a.get('source');
    tools.set(id, { ...tools.get(id), ...text('requestId', a.get('request_id')), ...text('agentId', a.get('agent_id')), ...decision, ...(decided !== undefined && typeof source === 'string' && source ? { decisionSource: source.slice(0, 40) } : {}) });
    if (tools.size > MAX_LINKS_PER_SESSION) tools.delete(tools.keys().next().value!);
    this.links.set(session, { at, tools });
  }

  /** A skill the model called: where it lives (its name here is Claude Code's stand-in, so the step's own is used). */
  private skill(session: string, at: number, a: Map<string, AttrValue>): void {
    const source = a.get('skill.source');
    if (a.get('invocation_trigger') !== SKILL_BY_MODEL || typeof source !== 'string') return;
    const list = this.skills.get(session) ?? [];
    list.push({ at, source: source.slice(0, 40) });
    if (list.length > MAX_SKILLS_PER_SESSION) list.shift();
    this.skills.set(session, list);
  }

  /** The hooks of one event, done: how long they took together, and the worst way one of them ended. */
  private hook(session: string, at: number, a: Map<string, AttrValue>): void {
    const event = a.get('hook_event');
    if (typeof event !== 'string' || !event) return;
    const outcome = num(a.get('num_blocking')) > 0 ? 'blocked' : num(a.get('num_non_blocking_error')) > 0 ? 'error' : num(a.get('num_cancelled')) > 0 ? 'cancelled' : 'success';
    const list = this.hooks.get(session) ?? [];
    list.push({ at, event: event.slice(0, 40), ...text('name', short(a.get('hook_name'))), ...text('source', short(a.get('hook_source'))), durationMs: num(a.get('total_duration_ms')), outcome, count: num(a.get('num_hooks')) || 1 });
    if (list.length > MAX_HOOKS_PER_SESSION) list.shift();
    this.hooks.set(session, list);
  }

  /** Only the listed fields, and the session as an id that can't be traced back. */
  private kept(a: Map<string, AttrValue>, session: string | undefined): Record<string, AttrValue> {
    const out: Record<string, AttrValue> = {};
    for (const [k, v] of a) if (KEEP.has(k) && v !== undefined) out[k.replace(/\./g, '_')] = v;
    if (session) out.conversation = pseudonym(this.deps.installId(), session);
    return out;
  }

  private prune(now: number): void {
    for (const [s, list] of this.calls) {
      const fresh = list.filter((c) => now - c.at < KEEP_CALLS_MS);
      if (fresh.length) this.calls.set(s, fresh);
      else this.calls.delete(s);
    }
    for (const [s, r] of this.refused) if (now - r.at >= KEEP_CALLS_MS) this.refused.delete(s);
    for (const [s, l] of this.links) if (now - l.at >= KEEP_CALLS_MS) this.links.delete(s);
    for (const [s, list] of this.hooks) {
      const fresh = list.filter((h) => now - h.at < KEEP_CALLS_MS);
      if (fresh.length) this.hooks.set(s, fresh);
      else this.hooks.delete(s);
    }
    for (const [s, list] of this.skills) {
      const fresh = list.filter((k) => now - k.at < KEEP_CALLS_MS);
      if (fresh.length) this.skills.set(s, fresh);
      else this.skills.delete(s);
    }
  }
}

/**
 * A log record's event, without its `claude_code.` prefix, or nothing when it isn't Claude Code's.
 * Claude Code puts the bare name in `event.name` ("api_request") and the full one in the body
 * ("claude_code.api_request"), under its own scope. A full name in `event.name` is read too.
 */
function eventName(attr: AttrValue, body: AttrValue, scope: string): string | undefined {
  const full = (v: AttrValue): string | undefined => (typeof v === 'string' ? /^claude_code\.([a-z_]{1,60})$/.exec(v)?.[1] : undefined);
  const named = full(attr);
  if (named) return named;
  const inBody = full(body);
  if (typeof attr !== 'string') return inBody;
  if (!/^[a-z_]{1,60}$/.test(attr)) return undefined;
  return inBody === attr || (body === undefined && CLAUDE_SCOPE.test(scope)) ? attr : undefined;
}

function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        resolve(undefined);
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
