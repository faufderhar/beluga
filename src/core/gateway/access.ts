import { z } from 'zod';
import { NEEDS, type Need, type TaskKind } from './protocol.js';
import { hhmm } from '../../shared/clock.js';
import { THIS_COMPUTER } from '../../shared/assistant.js';
import { knownOr } from '../../shared/known-or.js';

/**
 * Who may have their Claude do what on this Mac: per-capability settings by trust level, and
 * per-person rules. Browser-safe (zod only): the daemon decides with it, the Mac app shows it.
 *
 * How a request from a friend is decided, first match wins:
 *   1. you blocked them → declined;
 *   2. it needs a capability that is Off for their trust level → declined, saying which;
 *   3. a Decline or Ask rule of yours catches it → declined / you're asked
 *      (rules can always narrow what trust allows);
 *   4. you trust them (Trusted / Full trust) and every capability it needs is Allow → it runs
 *      (trust decides first: no rule needed);
 *   5. an Allow rule covers it → it runs (rules widen trust only where you'd otherwise be asked);
 *   6. otherwise you're asked (Approve once / Always / Decline).
 */

// ------------------------------------------------------------------ capabilities

/** The trust levels a capability is set for (blocked people get nothing). */
export const CAP_TRUST = ['ask', 'trusted', 'full'] as const;
export type CapTrust = (typeof CAP_TRUST)[number];
export const CAP_LEVELS = ['allow', 'ask', 'off'] as const;
export type CapLevel = (typeof CAP_LEVELS)[number];

const CapRow = z.object({ ask: z.enum(CAP_LEVELS), trusted: z.enum(CAP_LEVELS), full: z.enum(CAP_LEVELS) });
export type CapRow = z.infer<typeof CapRow>;

export const Capabilities = z.object({
  levels: z.object({ project: CapRow, shell: CapRow, files: CapRow, screen: CapRow, device: CapRow }),
  /** Folders friends' Claudes may read and write in (besides the task's own folder). */
  folders: z.array(z.string().min(1).max(4096)).max(20).default([]),
});
export type Capabilities = z.infer<typeof Capabilities>;

/** Sensible defaults: trusted friends get the everyday things, the screen asks, full trust gets all. */
export const DEFAULT_CAPABILITIES: Capabilities = {
  levels: {
    project: { ask: 'ask', trusted: 'allow', full: 'allow' },
    shell: { ask: 'ask', trusted: 'ask', full: 'allow' },
    files: { ask: 'ask', trusted: 'allow', full: 'allow' },
    // Asking is safe at every level: you see who wants your screen, and why, before anything is taken.
    screen: { ask: 'ask', trusted: 'ask', full: 'allow' },
    device: { ask: 'ask', trusted: 'allow', full: 'allow' },
  },
  folders: [],
};

/** Saved settings (or nothing) → complete capabilities (missing rows take the defaults). */
export function capabilitiesFrom(raw: unknown): Capabilities {
  const levels = { ...DEFAULT_CAPABILITIES.levels } as Record<Need, CapRow>;
  const given = (raw && typeof raw === 'object' ? (raw as { levels?: unknown }).levels : undefined) as Record<string, unknown> | undefined;
  for (const need of NEEDS) {
    const row = CapRow.safeParse(given?.[need]);
    if (row.success) levels[need] = row.data;
  }
  const folders = z.array(z.string().min(1).max(4096)).max(20).safeParse((raw as { folders?: unknown } | undefined)?.folders);
  return { levels: levels as Capabilities['levels'], folders: folders.success ? folders.data : [] };
}

/** Plain words for each capability (Settings, the request sheet, reasons sent back). */
export const CAP_INFO: Readonly<Record<Need, { label: string; detail: string; doing: string }>> = knownOr({
  shell: { label: 'Run commands', detail: `Commands in a terminal on ${THIS_COMPUTER}, with no input, stopped after a time limit.`, doing: 'run commands' },
  files: { label: 'Read and write files', detail: 'In the folders you choose below (and the task’s own folder). Secrets never.', doing: 'read or write files' },
  project: { label: 'Work in projects', detail: 'Your agent works in one of your projects (as for your own requests).', doing: 'work in your projects' },
  screen: { label: 'See the screen', detail: 'Screenshots of the main display or one app’s window, read-only.', doing: 'see the screen' },
  device: { label: 'Device info', detail: 'macOS version, Mac model, processor, memory, disk space, apps, network basics and battery. No secrets.', doing: 'read device information' },
}, (v) => ({ label: v, detail: '', doing: v }));

/** The order Settings lists them in. */
export const CAP_ORDER: readonly Need[] = ['shell', 'files', 'project', 'screen', 'device'];

export const CAP_LEVEL_INFO: Readonly<Record<CapLevel, string>> = knownOr({ allow: 'Allow', ask: 'Ask me', off: 'Off' }, (v) => v);

/** What one capability is for someone at this trust level. */
export const capFor = (caps: Capabilities, need: Need, trust: string): CapLevel => (trust === 'blocked' ? 'off' : (caps.levels[need][trust as CapTrust] ?? 'off'));

/** What your Beluga offers someone at this trust level (on your card: their Claude sees it). */
export const offersFor = (caps: Capabilities, trust: string): Need[] => (trust === 'blocked' ? [] : NEEDS.filter((n) => capFor(caps, n, trust) !== 'off'));

/** Whether someone sees your plan usage (BLG-597): every friend, only those you trust (Trusted, Full trust), or no one. Never anyone blocked. */
export function sharesUsageWith(share: 'trusted' | 'everyone' | 'off', trust: string): boolean {
  if (share === 'off' || trust === 'blocked') return false;
  return share === 'everyone' || trust === 'trusted' || trust === 'full';
}

// ------------------------------------------------------------------ rules

/** task: their Claude asks yours (with these needs). command: run one command. file: send one file. */
export const RULE_KINDS = ['task', 'command', 'file'] as const;
export type RuleKind = (typeof RULE_KINDS)[number];
export const RULE_DECISIONS = ['allow', 'ask', 'decline'] as const;
export type RuleDecision = (typeof RULE_DECISIONS)[number];

export const RuleId = z.string().regex(/^r_[\w-]{6,40}$/);

export const Rule = z.object({
  id: RuleId,
  peerId: z.string().regex(/^[\w-]{8,64}$/),
  peerName: z.string().max(64),
  kind: z.enum(RULE_KINDS),
  /** task: what the request may need. Allow covers requests needing no more than this; Ask and Decline catch any request needing one of these (all of that kind when empty). */
  needs: z.array(z.enum(NEEDS)).max(NEEDS.length).default([]),
  /** command: only this exact command (unset: any command). */
  command: z.string().min(1).max(8000).optional(),
  /** Only in this project (by name)… */
  project: z.string().min(1).max(80).optional(),
  /** …or only in this folder and what's inside it. */
  folder: z.string().min(1).max(4096).optional(),
  /** Gone after this (epoch ms); unset: never. */
  expiresAt: z.number().int().positive().optional(),
  decision: z.enum(RULE_DECISIONS),
  createdAt: z.number().int().min(0),
});
export type Rule = z.infer<typeof Rule>;

/** What's known about one request when it's decided. */
export interface RequestFacts {
  readonly peerId: string;
  readonly kind: RuleKind;
  readonly needs: readonly Need[];
  readonly project?: string;
  /** Where it would run or read (absolute, resolved). */
  readonly folder?: string;
  readonly command?: string;
}

export const ruleKindOf = (kind: TaskKind): RuleKind => (kind === 'run' ? 'command' : kind === 'file' ? 'file' : 'task');

/** The capabilities a request needs, whatever it says (a command needs the shell, a file needs files). */
export function capsNeeded(facts: Pick<RequestFacts, 'kind' | 'needs' | 'project'>): Need[] {
  const base: Need[] = facts.kind === 'command' ? ['shell'] : facts.kind === 'file' ? ['files'] : [...facts.needs];
  if (facts.project && facts.kind === 'task') base.push('project');
  return [...new Set(base)];
}

const trimSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p);
/** `target` is `root` or inside it (plain paths, no file system: both resolved already). */
export const within = (root: string, target: string): boolean => {
  const r = trimSlash(root);
  const t = trimSlash(target);
  return t === r || t.startsWith(r === '/' ? '/' : `${r}/`);
};

export const ruleExpired = (rule: Pick<Rule, 'expiresAt'>, now: number): boolean => rule.expiresAt !== undefined && rule.expiresAt <= now;

/** Does this rule apply to this request? */
export function ruleMatches(rule: Rule, facts: RequestFacts, now: number): boolean {
  if (rule.peerId !== facts.peerId || rule.kind !== facts.kind || ruleExpired(rule, now)) return false;
  if (rule.project !== undefined && rule.project !== facts.project) return false;
  if (rule.folder !== undefined && !(facts.folder && within(rule.folder, facts.folder))) return false;
  if (rule.kind === 'command' && rule.command !== undefined && rule.command.trim() !== (facts.command ?? '').trim()) return false;
  if (rule.kind !== 'task') return true;
  const needs = capsNeeded(facts);
  // Allow: nothing beyond what it lists. Ask / Decline: anything it lists (or everything).
  if (rule.decision === 'allow') return needs.every((n) => rule.needs.includes(n));
  return !rule.needs.length || needs.some((n) => rule.needs.includes(n));
}

export type Verdict = 'allow' | 'ask' | 'decline';

export interface AccessDecision {
  readonly verdict: Verdict;
  /** Which step decided it. */
  readonly by: 'self' | 'blocked' | 'capability' | 'rule' | 'trust' | 'default';
  /** The rule that decided it. */
  readonly rule?: Rule;
  /** Capabilities that made it decline (Off) or ask (Ask me). */
  readonly caps?: readonly Need[];
}

/** Decide a request (see the top of this file for the order). */
export function decideAccess(input: { trust: string; caps: Capabilities; rules: readonly Rule[]; facts: RequestFacts; now: number; self?: boolean }): AccessDecision {
  const { trust, caps, rules, facts, now } = input;
  if (input.self) return { verdict: 'allow', by: 'self' };
  if (trust === 'blocked') return { verdict: 'decline', by: 'blocked' };
  const needed = capsNeeded(facts);
  const off = needed.filter((n) => capFor(caps, n, trust) === 'off');
  if (off.length) return { verdict: 'decline', by: 'capability', caps: off };
  const matching = rules.filter((r) => ruleMatches(r, facts, now));
  const narrow = matching.find((r) => r.decision === 'decline') ?? matching.find((r) => r.decision === 'ask');
  if (narrow) return { verdict: narrow.decision === 'decline' ? 'decline' : 'ask', by: 'rule', rule: narrow };
  const asks = needed.filter((n) => capFor(caps, n, trust) === 'ask');
  if ((trust === 'trusted' || trust === 'full') && !asks.length) return { verdict: 'allow', by: 'trust' };
  const allow = matching.find((r) => r.decision === 'allow');
  if (allow) return { verdict: 'allow', by: 'rule', rule: allow };
  return { verdict: 'ask', by: 'default', ...(asks.length ? { caps: asks } : {}) };
}

/** Why a request was declined, in words for the person who sent it. */
export function declineReason(d: AccessDecision, owner: string): string {
  if (d.by === 'blocked') return `${owner} doesn't take requests from you`;
  if (d.by === 'capability') return `${owner}'s Beluga doesn't let you ${(d.caps ?? []).map((n) => CAP_INFO[n].doing).join(' or ')}`;
  if (d.by === 'rule') return `${owner} has a rule that declines requests like this one`;
  return `${owner} declined`;
}

// ------------------------------------------------------------------ "Always" from a request

export const EXPIRIES = ['never', 'day', 'week'] as const;
export type Expiry = (typeof EXPIRIES)[number];
export const EXPIRY_INFO: Readonly<Record<Expiry, string>> = knownOr({ never: 'Never expires', day: 'For 1 day', week: 'For 1 week' }, (v) => v);
const EXPIRY_MS: Readonly<Record<Expiry, number | undefined>> = { never: undefined, day: 86_400_000, week: 7 * 86_400_000 };

/** Your answer to a request: once, always (with the rule's scope), or no (with a reason). */
export const Decision = z.object({
  answer: z.enum(['yes', 'no', 'always']),
  /** Always: this project / folder only, or anywhere. */
  scope: z.enum(['this', 'any']).default('this'),
  /** Always, for a command: this exact command, or any. */
  command: z.enum(['this', 'any']).default('this'),
  expiry: z.enum(EXPIRIES).default('never'),
  reason: z.string().max(300).optional(),
});
export type Decision = z.infer<typeof Decision>;
export type DecisionInput = z.input<typeof Decision>;

/** The rule "Always" writes for a request: this person, this kind, these needs, the scope you chose. */
export function ruleFor(facts: RequestFacts, peerName: string, decision: Pick<Decision, 'scope' | 'command' | 'expiry'>, now: number, id: string): Rule {
  const expires = EXPIRY_MS[decision.expiry];
  const scoped = decision.scope === 'this';
  return {
    id,
    peerId: facts.peerId,
    peerName: peerName.slice(0, 64),
    kind: facts.kind,
    needs: facts.kind === 'task' ? capsNeeded(facts) : [],
    ...(scoped && facts.project ? { project: facts.project } : scoped && facts.folder && facts.kind !== 'task' ? { folder: facts.folder } : {}),
    ...(facts.kind === 'command' && decision.command === 'this' && facts.command ? { command: facts.command.trim() } : {}),
    ...(expires ? { expiresAt: now + expires } : {}),
    decision: 'allow',
    createdAt: now,
  };
}

// ------------------------------------------------------------------ words for screens

const KIND_WORDS: Readonly<Record<RuleKind, string>> = { task: 'Requests to your agent', command: 'Commands', file: `Files sent from ${THIS_COMPUTER}` };

/** "Requests to your Claude needing: run commands, see the screen · in landing". */
export function ruleLabel(rule: Rule): string {
  const parts: string[] = [];
  if (rule.kind === 'task') parts.push(rule.needs.length ? `${KIND_WORDS.task} ${rule.decision === 'allow' ? 'that need at most' : 'that need'}: ${rule.needs.map((n) => CAP_INFO[n].doing).join(', ')}` : rule.decision === 'allow' ? `${KIND_WORDS.task} that need nothing special` : `All ${KIND_WORDS.task.toLowerCase()}`);
  else if (rule.kind === 'command') parts.push(rule.command ? `The command \`${rule.command.length > 60 ? `${rule.command.slice(0, 59)}…` : rule.command}\`` : 'Any command');
  else parts.push(KIND_WORDS.file);
  parts.push(rule.project ? `in ${rule.project}` : rule.folder ? `in ${rule.folder}` : rule.kind === 'task' && rule.decision === 'allow' && !rule.needs.includes('project') ? 'in a scratch folder' : 'anywhere');
  return parts.join(' · ');
}

/** "until Oct 25, 14:30", "never expires", "expired". */
export function expiryLabel(rule: Pick<Rule, 'expiresAt'>, now = Date.now()): string {
  if (rule.expiresAt === undefined) return 'never expires';
  if (rule.expiresAt <= now) return 'expired';
  const d = new Date(rule.expiresAt);
  return `until ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${hhmm(rule.expiresAt)}`;
}

export const DECISION_INFO: Readonly<Record<RuleDecision, string>> = knownOr({ allow: 'Allow', ask: 'Ask me', decline: 'Decline' }, (v) => v);

/** How the scope of "Always" reads for this request (the sheet spells it out). */
export function scopeChoices(facts: Pick<RequestFacts, 'kind' | 'project' | 'folder'>): { this: string; any: string } | undefined {
  if (facts.kind === 'task') return facts.project ? { this: `Only in ${facts.project}`, any: 'In any project' } : undefined;
  return facts.project ? { this: `Only in ${facts.project}`, any: 'Anywhere' } : facts.folder ? { this: `Only in ${facts.folder}`, any: 'Anywhere' } : undefined;
}
