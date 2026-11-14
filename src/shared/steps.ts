import type { StepApp } from './mcp-apps.js';
import { humanizeTool } from './step-titles.js';

/**
 * What Claude did, step by step, in detail: each tool call (what it ran, what came back) and
 * each stretch of thinking. Screens show the light list (`StepSummary`) and fetch one step's
 * details (`StepRecord`) when it's opened. Everything here is bounded and has secrets redacted
 * before it's kept, so a huge command output or a token in a command never sits in memory or
 * on disk in full. Browser-safe: no Node imports (the Mac app uses the types and helpers).
 */

export type StepKind = 'tool' | 'thinking';
export type StepStatus = 'running' | 'done' | 'error';

/** One step as a list draws it. */
export interface StepSummary {
  /** The tool call's id (tool_use id), or `think-<n>` for thinking. */
  readonly id: string;
  readonly kind: StepKind;
  /** The tool's name ("Bash", "Read", "mcp__beluga__send_chat"). */
  readonly tool?: string;
  /** The one-line text the chat already shows ("Bash npm test", "Thought for 12s"). */
  readonly title: string;
  /** The step in words, once done ("Ran npm test", "Asked bob's Claude: …"); see shared/step-titles.ts. */
  readonly label?: string;
  /** The same while it's the step Claude is on ("Running npm test"). */
  readonly doing?: string;
  /** Someone else involved (their name, for their avatar). */
  readonly person?: string;
  /** A task between Claudes (Beluga's gateway) this step is about. */
  readonly task?: string;
  /** Claude waits on someone here (the waiting row). */
  readonly wait?: boolean;
  readonly status: StepStatus;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
  /** Thinking whose words Claude didn't show (redacted, or not sent). */
  readonly hidden?: boolean;
  /** A sub-agent's step: the id of the tool call that started that sub-agent. */
  readonly parent?: string;
  /** Its tool has an MCP App (shared/mcp-apps.ts): `apps.get` gives its frame. */
  readonly hasApp?: true;
}

/** One step with what's worth opening it for. */
export interface StepRecord extends StepSummary {
  /** The tool's input (bounded, secrets redacted). */
  readonly input?: Readonly<Record<string, unknown>>;
  /** What came back (bounded: its start and end, with a marker in between). */
  readonly output?: string;
  readonly isError?: boolean;
  /** Something was cut to fit (the input, the output or the thinking). */
  readonly truncated?: boolean;
  /** Thinking: what Claude thought (bounded). */
  readonly text?: string;
  /** What its MCP App needs (only with Settings › Experimental › MCP Apps on). */
  readonly app?: StepApp;
}

/** The steps of one run, light, as `agent.steps` returns them. */
export interface StepPage {
  readonly steps: readonly StepSummary[];
  /** Grows with every change (send it back as `after` to hear only about changes). */
  readonly version: number;
  /** Nothing changed since `after`: `steps` is empty, keep yours. */
  readonly unchanged?: boolean;
  /** No details on this computer (someone else's Claude, or from before Beluga kept them). */
  readonly missing?: boolean;
}

/** Output kept: this much from the start and this much from the end. */
export const OUTPUT_HEAD = 12_000;
export const OUTPUT_TAIL = 8_000;
/** Thinking kept per stretch. */
export const THINKING_MAX = 8_000;
/** One string in a tool's input (a file's content, an edit's old text). */
export const INPUT_STRING_MAX = 16_000;
/** A whole input, as JSON. */
export const INPUT_TOTAL_MAX = 48_000;

const kb = (n: number): string => (n >= 10_240 ? `${Math.round(n / 1024)} KB` : `${(n / 1024).toFixed(1)} KB`);

/** A text cut to its start and end when long, with a line saying how much is left out. */
/** A tool call's words as record fields (see shared/step-titles.ts). */
export function wordsOf(tool: string, input: Readonly<Record<string, unknown>>, cwd?: string): Pick<StepSummary, 'label' | 'doing' | 'person' | 'task' | 'wait'> {
  const h = humanizeTool(tool, input, cwd);
  return { label: redactSecrets(h.done), doing: redactSecrets(h.doing), ...(h.person ? { person: h.person } : {}), ...(h.task ? { task: h.task } : {}), ...(h.wait ? { wait: true } : {}) };
}

export function boundText(text: string, head = OUTPUT_HEAD, tail = OUTPUT_TAIL): { text: string; truncated: boolean } {
  if (text.length <= head + tail) return { text, truncated: false };
  const cut = text.length - head - tail;
  return { text: `${text.slice(0, head)}\n… ${kb(cut)} not shown …\n${text.slice(text.length - tail)}`, truncated: true };
}

/** Tokens and keys that look like secrets, wherever they appear. */
const SECRET_TOKENS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:sk|rk|pk|whsec)_(?:live|test)_[A-Za-z0-9]{10,}/g,
  // RevenueCat V2 secret keys have no live/test infix, so the Stripe pattern misses them.
  /\bsk_[A-Za-z0-9_-]{16,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];
/** FOO_TOKEN=… / export API_KEY="…" (environment-style names, in capitals). */
const SECRET_ASSIGN = /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?))(\s*=\s*)("[^"]*"|'[^']*'|[^\s;&|]+)/g;
/** password: …, "api_key": "…", token=… */
const SECRET_FIELD = /(["']?\b(?:password|passwd|secret|client_secret|token|access_token|refresh_token|api[_-]?key)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&|}]+)/gi;
const SECRET_HEADER = /\b(authorization:\s*(?:bearer|basic|token)?\s*|x-api-key:\s*|--(?:password|token|api-key|secret)[= ])("[^"]*"|'[^']*'|[^\s'"]+)/gi;
export const REDACTED = '[redacted]';

/** The text with anything that looks like a secret replaced by [redacted]. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_TOKENS) out = out.replace(re, REDACTED);
  return out
    .replace(SECRET_ASSIGN, (_m, key: string, eq: string) => `${key}${eq}${REDACTED}`)
    .replace(SECRET_FIELD, (m, key: string, value: string) => (value === REDACTED || /^["']?\[redacted\]/.test(value) ? m : `${key}${REDACTED}`))
    .replace(SECRET_HEADER, (_m, key: string) => `${key}${REDACTED}`);
}

/** Input keys whose values are secrets whatever they look like. */
export const SECRET_KEY = /(password|passwd|secret|token|api[_-]?key|authorization|cookie|credential)/i;

/** A tool's input, safe to keep and show: secrets redacted, long strings cut, the whole kept small. */
export function boundInput(input: Readonly<Record<string, unknown>>): { input: Record<string, unknown>; truncated: boolean } {
  let truncated = false;
  const walk = (v: unknown, max: number, depth: number, key?: string): unknown => {
    if (typeof v === 'string') {
      if (key && SECRET_KEY.test(key) && v) return REDACTED;
      const b = boundText(redactSecrets(v), Math.floor(max * 0.75), Math.floor(max * 0.25));
      if (b.truncated) truncated = true;
      return b.text;
    }
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v;
    if (depth > 6) {
      truncated = true;
      return '…';
    }
    if (Array.isArray(v)) {
      if (v.length > 200) truncated = true;
      return v.slice(0, 200).map((x) => walk(x, max, depth + 1));
    }
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).slice(0, 100).map(([k, x]) => [k, walk(x, max, depth + 1, k)]));
    return undefined;
  };
  let out = walk(input, INPUT_STRING_MAX, 0) as Record<string, unknown>;
  // Still too big as a whole (many long strings): cut every string harder.
  if (JSON.stringify(out).length > INPUT_TOTAL_MAX) {
    truncated = true;
    out = walk(input, 2_000, 0) as Record<string, unknown>;
  }
  if (JSON.stringify(out).length > INPUT_TOTAL_MAX) out = { note: `${Object.keys(input).join(', ')} (too large to keep)` };
  return { input: out, truncated };
}

/** A tool result's content (a string, or text blocks) as text; images become a note. */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content === undefined || content === null ? '' : JSON.stringify(content);
  return content
    .map((b: unknown) => {
      const block = b as { type?: string; text?: unknown };
      if (block?.type === 'text' && typeof block.text === 'string') return block.text;
      if (block?.type === 'image') return '[image]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Which family a tool belongs to (its icon, and how its details are shown). */
export type ToolFamily = 'bash' | 'read' | 'edit' | 'search' | 'web' | 'agent' | 'message' | 'mcp' | 'todo' | 'other';

export function toolFamily(name = ''): ToolFamily {
  if (/^(Bash|BashOutput|KillShell|KillBash)$/.test(name)) return 'bash';
  if (/^(Read|NotebookRead)$/.test(name)) return 'read';
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(name)) return 'edit';
  if (/^(Grep|Glob|LS)$/.test(name)) return 'search';
  if (/^(WebFetch|WebSearch)$/.test(name)) return 'web';
  if (/^(Task|Agent)$/.test(name)) return 'agent';
  if (name === 'SendMessage') return 'message';
  if (name === 'TodoWrite') return 'todo';
  if (name.startsWith('mcp__')) return 'mcp';
  return 'other';
}

/** "Thought for 12s", "Thought briefly", or that Claude kept it to itself. */
export function thinkingTitle(durationMs: number | undefined, hidden: boolean): string {
  if (hidden) return 'Thinking (hidden by the agent)';
  if (durationMs === undefined) return 'Thought';
  const s = Math.round(durationMs / 1000);
  if (s < 1) return 'Thought briefly';
  return s < 60 ? `Thought for ${s}s` : `Thought for ${Math.floor(s / 60)}m ${s % 60}s`;
}

/** The light part of a record. */
/** A message sent to another chat: its words also say how it was delivered, from the receipt. */
function sentLabel(r: StepRecord, label: string): string {
  if (!r.tool?.endsWith('__send_to_chat') || r.isError || !r.output) return label;
  const delivery = /"delivery":\s*"(\w+)"/.exec(r.output)?.[1];
  return delivery ? `${label} · ${delivery}` : label;
}

export function summaryOf(r: StepRecord): StepSummary {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    status: r.status,
    startedAt: r.startedAt,
    ...(r.tool ? { tool: r.tool } : {}),
    ...(r.label ? { label: sentLabel(r, r.label) } : {}),
    ...(r.doing ? { doing: r.doing } : {}),
    ...(r.person ? { person: r.person } : {}),
    ...(r.task ? { task: r.task } : {}),
    ...(r.wait ? { wait: true } : {}),
    ...(r.endedAt !== undefined ? { endedAt: r.endedAt } : {}),
    ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
    ...(r.hidden ? { hidden: true } : {}),
    ...(r.parent ? { parent: r.parent } : {}),
    ...(r.app ? { hasApp: true as const } : {}),
  };
}

/** Rough size of a record in memory or on disk (characters). */
export function sizeOf(r: StepRecord): number {
  return (r.output?.length ?? 0) + (r.text?.length ?? 0) + (r.input ? JSON.stringify(r.input).length : 0) + (r.app?.structuredContent !== undefined ? JSON.stringify(r.app.structuredContent).length : 0) + r.title.length + 120;
}

/** A thinking block's text: readable, or hidden (redacted, or sent without its words). */
export function thinkingOf(block: { type?: string; thinking?: unknown }): { text: string; hidden: boolean; truncated: boolean } {
  const raw = block.type === 'thinking' && typeof block.thinking === 'string' ? block.thinking.trim() : '';
  if (!raw) return { text: '', hidden: true, truncated: false };
  const b = boundText(redactSecrets(raw), THINKING_MAX, 0);
  return { text: b.text, hidden: false, truncated: b.truncated };
}
