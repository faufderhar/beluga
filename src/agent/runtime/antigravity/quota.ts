import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NamedUsageWindow } from '../../../protocol.js';
import type { UsageUpdate } from '../../usage.js';
import { toMs } from '../claude/usage.js';
import type { SessionResponse } from '../opencode/acp.js';
import { type AgyConnect, agyLogDir, spawnAgy } from './connection.js';
import { dropAgySession } from './sessions.js';

/** One model as Antigravity's language server lists it (GetUserStatus › cascadeModelConfigData). */
interface AgyModelConfig {
  readonly label?: string;
  readonly modelId?: string;
  /** Absent: this model has no quota of its own. Its `remainingFraction` is left out when it's 0 (protobuf's JSON). */
  readonly quotaInfo?: { readonly remainingFraction?: number; readonly resetTime?: string };
}

/** What `GetUserStatus` says (only the parts read here). */
export interface AgyUserStatus {
  readonly userTier?: { readonly name?: string };
  readonly planStatus?: { readonly planInfo?: { readonly planName?: string } };
  readonly cascadeModelConfigData?: { readonly clientModelConfigs?: readonly AgyModelConfig[] };
}

/** A family's name by its model ids' first word: the Orchestrators are Gemini's. */
const FAMILIES: Readonly<Record<string, string>> = { gemini: 'Gemini', claude: 'Claude', gpt: 'GPT-OSS' };

function familyOf(m: AgyModelConfig): string | undefined {
  const head = m.modelId?.split('-')[0]?.toLowerCase();
  if (head && FAMILIES[head]) return FAMILIES[head];
  const word = m.label?.trim().split(/\s+/)[0];
  return word ? word.slice(0, 32) : undefined;
}

/** At most this many families (a provider's named windows). */
const MAX_FAMILIES = 6;

/**
 * Antigravity's quota as a usage update: one window per model family (Gemini, Claude, GPT-OSS), its
 * tightest model's share used and when that resets; the tier ("Google AI Ultra") as the plan.
 * Its quotas are pools a family shares (every Gemini model says the same), refilled every five hours.
 * Undefined when no model has a quota (signed out, or a plan without them).
 */
export function fromUserStatus(status: AgyUserStatus | undefined): UsageUpdate | undefined {
  const families = new Map<string, { remaining: number; resetsAt?: number }>();
  for (const m of status?.cascadeModelConfigData?.clientModelConfigs ?? []) {
    const q = m.quotaInfo;
    const name = familyOf(m);
    if (!q || !name) continue;
    const remaining = typeof q.remainingFraction === 'number' && Number.isFinite(q.remainingFraction) ? Math.max(0, Math.min(1, q.remainingFraction)) : 0;
    const prev = families.get(name);
    if (prev && prev.remaining <= remaining) continue;
    if (!prev && families.size >= MAX_FAMILIES) continue;
    const resetsAt = toMs(q.resetTime);
    families.set(name, { remaining, ...(resetsAt ? { resetsAt } : {}) });
  }
  if (!families.size) return undefined;
  const windows: NamedUsageWindow[] = [...families].map(([label, f]) => ({ label, pct: Math.round((1 - f.remaining) * 100), ...(f.resetsAt ? { resetsAt: f.resetsAt } : {}) }));
  const plan = planOf(status);
  return { windows, ...(plan ? { plan: plan.slice(0, 32) } : {}) };
}

/** One of a group's limits, as `RetrieveUserQuotaSummary` says it. */
interface AgyQuotaBucket {
  readonly bucketId?: string;
  /** `5h` or `weekly`. */
  readonly window?: string;
  /** Left out when it's 0 (protobuf's JSON): used up. */
  readonly remainingFraction?: number;
  readonly resetTime?: string;
}

/** What `RetrieveUserQuotaSummary` says: each group of models (Gemini's; Claude's and GPT's), with its own 5-hour and weekly limits. */
export interface AgyQuotaSummary {
  readonly groups?: ReadonlyArray<{ readonly displayName?: string; readonly buckets?: readonly AgyQuotaBucket[] }>;
}

/** Its windows by the names Claude's have, so they read (and translate) the same: 5-hour first, then the week. */
const WINDOWS: ReadonlyArray<readonly [string, string]> = [
  ['5h', '5-hour'],
  ['weekly', 'Weekly'],
];

/** At most this many groups: two windows each, within a provider's six. */
const MAX_GROUPS = 3;

const usedPct = (remaining: number | undefined): number => Math.round((1 - (typeof remaining === 'number' && Number.isFinite(remaining) ? Math.max(0, Math.min(1, remaining)) : 0)) * 100);

/**
 * Antigravity's quota as its own quota panel shows it: per group of models (its own names, "Gemini
 * Models", "Claude and GPT models"), the 5-hour limit and the weekly one, each with when it refills;
 * the tier ("Google AI Ultra") as the plan. Undefined when it names no limit (an older CLI: then
 * `fromUserStatus` reads one per model family).
 */
export function fromQuotaSummary(summary: AgyQuotaSummary | undefined, status?: AgyUserStatus): UsageUpdate | undefined {
  const windows: NamedUsageWindow[] = [];
  for (const g of (summary?.groups ?? []).slice(0, MAX_GROUPS)) {
    const group = g.displayName?.trim().slice(0, 40);
    if (!group) continue;
    for (const [id, label] of WINDOWS) {
      const b = g.buckets?.find((x) => x.window === id);
      if (!b) continue;
      const resetsAt = toMs(b.resetTime);
      windows.push({ label, group, pct: usedPct(b.remainingFraction), ...(resetsAt ? { resetsAt } : {}) });
    }
  }
  if (!windows.length) return undefined;
  const plan = planOf(status);
  return { windows, ...(plan ? { plan: plan.slice(0, 32) } : {}) };
}

/** Its tier as the card's plan, without the maker's name the card already implies ("Google AI Ultra" → "AI Ultra"). */
export function planOf(status: AgyUserStatus | undefined): string | undefined {
  const name = (status?.userTier?.name ?? status?.planStatus?.planInfo?.planName)?.trim().replace(/^Google\s+/i, '');
  return name || undefined;
}

/** The HTTP port an `agy acp` process's language server listens on, from its log's words. */
export function portFromLog(log: string): number | undefined {
  const m = /listening on random port at (\d+) for HTTP\b/.exec(log);
  const port = m ? Number(m[1]) : NaN;
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined;
}

export interface QuotaDeps {
  readonly bin?: string;
  readonly connect?: AgyConnect;
  /** Where `agy acp` writes its logs (`acp-server-<time>-<pid>.log`). */
  readonly logDir?: string;
  readonly fetch?: typeof fetch;
  /** Drops the conversation it opened to look (tests: a fake). */
  readonly drop?: (sessionId: string) => Promise<unknown>;
}

const SESSION_TIMEOUT_MS = 60_000;
const PORT_WAIT_MS = 5_000;
const FETCH_TIMEOUT_MS = 10_000;

/** The language server's port, once its log says it (it starts with the first session). */
async function waitForPort(dir: string, pid: number): Promise<number | undefined> {
  const until = Date.now() + PORT_WAIT_MS;
  for (;;) {
    const name = (await fs.readdir(dir).catch(() => [] as string[])).find((n) => n.endsWith(`-${pid}.log`));
    const port = name ? portFromLog(await fs.readFile(path.join(dir, name), 'utf8').catch(() => '')) : undefined;
    if (port || Date.now() > until) return port;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * What's left of your Antigravity quota now. ACP doesn't say it, so this starts `agy acp`, opens a
 * conversation (no message is sent: nothing of your quota is used), and asks its own language
 * server on localhost (`RetrieveUserQuotaSummary` for the limits, `GetUserStatus` for the tier),
 * as Antigravity's own quota panel does. The conversation
 * is dropped after. Undefined when it can't say (not installed, signed out, an older CLI).
 */
export async function readAgyQuota(deps: QuotaDeps = {}): Promise<UsageUpdate | undefined> {
  const cwd = os.tmpdir();
  // A look: its log (where the port was read) goes once it has stopped.
  const conn = await (deps.connect ?? spawnAgy)({ cwd, look: true, ...(deps.bin ? { bin: deps.bin } : {}) }).catch(() => undefined);
  if (!conn) return undefined;
  let opened: string | undefined;
  try {
    const s = await conn.rpc.request<SessionResponse>('session/new', { cwd, mcpServers: [] }, SESSION_TIMEOUT_MS);
    opened = s.sessionId;
    const port = await waitForPort(deps.logDir ?? agyLogDir(), conn.proc.pid);
    if (!port) return undefined;
    const ask = async <T>(method: string): Promise<T | undefined> => {
      const res = await (deps.fetch ?? fetch)(`http://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
        body: '{}',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      return res.ok ? ((await res.json()) as T) : undefined;
    };
    // Its tier, and its limits as its own quota panel shows them; an older CLI has only one per model.
    const [status, summary] = await Promise.all([ask<{ userStatus?: AgyUserStatus }>('GetUserStatus').catch(() => undefined), ask<{ response?: AgyQuotaSummary }>('RetrieveUserQuotaSummary').catch(() => undefined)]);
    return fromQuotaSummary(summary?.response, status?.userStatus) ?? fromUserStatus(status?.userStatus);
  } catch {
    return undefined;
  } finally {
    await conn.proc.kill();
    // Dropped once Antigravity has stopped, or it would write it back as it exits.
    const drop = deps.drop ?? (deps.connect ? undefined : dropAgySession);
    if (opened && drop) await drop(opened).catch(() => false);
  }
}
