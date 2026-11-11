import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { asActingAgent } from '../../core/acting-agent.js';
import { decide, type Denial, type OperationClass, ToolRefusal } from '../domain/decide.js';
import type { Grant } from '../domain/grant.js';
import { boundedText, CARD_ANSWER_KEEP_MS, CARD_WAIT_MS, LIMITS, WAITING_INSTRUCTIONS } from '../domain/limits.js';
import { type ExternalTool, TOOL_ACCESS } from '../domain/tools.js';
import type { AuditLog } from '../ports/audit-log.js';
import { scrubbed } from './tools/read.js';

/**
 * Every external tool goes through this wrapper, so each gets the same rules: the grant decides,
 * the owner sees a card when it says ask, and each decision goes in the audit log. What the audit
 * log gets is chosen here: the tool's name from the registry, the agent's from the grant, a target
 * only from an id the tool resolved, a summary from those words. Nothing a client wrote.
 */

/** What a call acts on, once its arguments are checked against what exists. */
export type Resolved =
  /** `target`: the resolved id ("chat:abc"), empty when it touches no one thing. */
  | { readonly target: string; readonly inScope: boolean; /** A chat this agent didn't start: at level ask, each call has a card with no Always. */ readonly foreign?: boolean; /** A setting of yours wants a card here, at every level. */ readonly mustAsk?: boolean; /** What its card shows, when the target alone doesn't say. */ readonly detail?: string; /** What the card says the agent wants, in plain words. */ readonly wants?: string }
  | { readonly denial: Denial; readonly message: string };

/** A result with more than data in it, like a picture. */
export class ToolContent {
  constructor(readonly content: CallToolResult['content']) {}
}

export interface ExternalToolDef {
  /** A registered name: its class comes from TOOL_ACCESS. */
  readonly name: ExternalTool;
  readonly description: string;
  readonly inputSchema: z.ZodRawShape;
  /** Says what it touches. Runs after the level allowed the class, before any card. */
  resolve(args: Record<string, unknown>, grant: Grant): Resolved;
  /** Its result as plain data. Throw for a failure the client may read. */
  run(args: Record<string, unknown>, grant: Grant): unknown;
  /** The audit target of a call that made what it acts on: only its result has the id. */
  auditTarget?(result: unknown, args: Record<string, unknown>): string | undefined;
  /** What the audit log hashes in place of the arguments, and a note for its summary: for what must not leave a trace. */
  auditArgs?(args: Record<string, unknown>): unknown;
  auditNote?(args: Record<string, unknown>): string;
  /** It only passes the call on (beluga_call): the tool it names, for its `tool` and `arguments`. That tool's rules apply, and no others. */
  handsOver?(args: Record<string, unknown>): ExternalToolDef | undefined;
}

export type AskAnswer = 'yes' | 'no' | 'always';

/** Who a card is for: the agent, and the chat it holds up when the call names one. */
export interface CardFor {
  readonly agentId: string;
  readonly agent: string;
  readonly chatId?: string;
}

/** The owner's card for this call. `once`: no Always on it. `signal`: it stops being asked, and the card goes as a no. */
export type AskOwner = (title: string, detail: string, once: boolean, card?: CardFor, signal?: AbortSignal) => Promise<AskAnswer>;

export interface ToolDeps {
  readonly audit: AuditLog;
  readonly ask: AskOwner;
  readonly now: () => number;
  /** Tools the owner said Always to: `${grant id} ${tool}`, for this daemon's life. */
  readonly always: Set<string>;
  /** Whether this grant can still act: not revoked, expired or blocked. Read last, right before a tool runs. */
  readonly live: (grantId: string) => boolean;
  /** Cards still open or answered, by grant, tool and arguments: a call again finds its own. */
  readonly cards: Map<string, HeldCard>;
  /** Default CARD_WAIT_MS. */
  readonly cardWaitMs?: number;
  /** Default CARD_ANSWER_KEEP_MS. */
  readonly cardKeepMs?: number;
  /** A call of this grant was refused, for this reason. */
  readonly denied?: (grant: Grant, denial: Denial) => void;
}

/** One card, whether or not a call is waiting on it now. */
export interface HeldCard {
  readonly answer: Promise<AskAnswer>;
  /** A call took its answer: one answer goes to one call. */
  taken: boolean;
  /** Which calls it stands for: the agent, the tool and the target. Empty: this card stands only for itself. */
  readonly slot: string;
  /** The person answered. */
  answered: boolean;
  /** A newer call took its place. */
  replaced: boolean;
  /** Closes it, as a no. */
  readonly drop: () => void;
}

/** A person's Stop or a revoke: this agent's held answers and open cards end, so a retry asks again. */
export function dropHeldCards(cards: Map<string, HeldCard>, agentId: string): void {
  for (const [key, held] of cards) {
    if (!key.startsWith(`${agentId} `)) continue;
    held.drop();
    cards.delete(key);
  }
}

const CHAT_TARGET = 'chat:';
const CARD_ARGS_MAX = 2000;
const DISCOVERY_INSTRUCTIONS = 'This list has the chat tools. Beluga has many more: use beluga_find to find one and its input schema, then beluga_call with its name and arguments.';
const WAITING = "The owner must answer a card in Beluga. Nothing ran. Tell your user, then call this tool again with the same arguments.";

/** One request's MCP server, with this grant's tools behind the wrapper. */
export function mcpServerForGrant(grant: Grant, tools: readonly ExternalToolDef[], deps: ToolDeps): McpServer {
  const discovers = tools.some((def) => def.handsOver);
  const server = new McpServer({ name: 'beluga', version: '1' }, { instructions: discovers ? `${DISCOVERY_INSTRUCTIONS} ${WAITING_INSTRUCTIONS}` : WAITING_INSTRUCTIONS });
  for (const def of tools) {
    server.registerTool(def.name, { description: def.description, inputSchema: def.inputSchema }, (args: Record<string, unknown>) => callTool(def, args, grant, deps));
  }
  return server;
}

export async function callTool(def: ExternalToolDef, args: Record<string, unknown>, grant: Grant, deps: ToolDeps): Promise<CallToolResult> {
  return def.handsOver ? handOver(def, args, grant, deps) : gatedCall(def, args, grant, deps);
}

/**
 * beluga_call: the named tool, under its own name. It has no gate of its own, so the card and the
 * audit log never name it for a call that reached a tool. Only a name that is no tool's stays its own.
 */
function handOver(def: ExternalToolDef, args: Record<string, unknown>, grant: Grant, deps: ToolDeps): Promise<CallToolResult> | CallToolResult {
  const refuse = (tool: string, operation: OperationClass, denial: Denial, message: string): CallToolResult => {
    deps.audit.append({ agent: grant.name, agentId: grant.id, tool, class: operation, target: '', decision: 'deny', decidedBy: 'rule', result: denial, durationMs: 0, args: {}, summary: `${tool} (${operation})` });
    deps.denied?.(grant, denial);
    return errorResult(denial, message);
  };
  const known = def.handsOver!(args);
  const named = known?.handsOver ? undefined : known;
  if (!named) {
    // A blocked agent learns nothing about what exists: a name that is no tool's gets the same answer as one that is.
    const byLevel = decide({ operation: TOOL_ACCESS[def.name], level: grant.level, inScope: true });
    return byLevel.outcome === 'deny' ? refuse(def.name, TOOL_ACCESS[def.name], byLevel.denial, `This agent's level doesn't allow ${def.name}.`) : refuse(def.name, TOOL_ACCESS[def.name], 'not_found', 'No such tool. Use beluga_find.');
  }
  const inner = (args.arguments ?? {}) as Record<string, unknown>;
  // The level before the arguments, as a direct call: a tool it may not use says only that.
  if (decide({ operation: TOOL_ACCESS[named.name], level: grant.level, inScope: true }).outcome === 'deny') return gatedCall(named, inner, grant, deps);
  const parsed = z.object(named.inputSchema).safeParse(inner);
  if (!parsed.success) return refuse(named.name, TOOL_ACCESS[named.name], 'invalid_request', `Those arguments don't fit ${named.name}: ${parsed.error.issues[0]?.path.join('.') || 'arguments'}: ${parsed.error.issues[0]?.message ?? 'invalid'}.`);
  return gatedCall(named, parsed.data, grant, deps);
}

async function gatedCall(def: ExternalToolDef, args: Record<string, unknown>, grant: Grant, deps: ToolDeps): Promise<CallToolResult> {
  const started = deps.now();
  const operation: OperationClass = TOOL_ACCESS[def.name];
  const record = (target: string, decision: 'allow' | 'ask' | 'ask-once' | 'deny', decidedBy: 'rule' | 'person', result: 'ok' | 'error' | Denial): void =>
    deps.audit.append({ agent: grant.name, agentId: grant.id, tool: def.name, class: operation, target, decision, decidedBy, result, durationMs: deps.now() - started, args: def.auditArgs?.(args) ?? args, summary: `${def.name} (${operation})${def.auditNote ? `: ${def.auditNote(args)}` : ''}` });
  const refuse = (target: string, denial: Denial, message: string, decidedBy: 'rule' | 'person' = 'rule', decision: 'ask' | 'ask-once' | 'deny' = 'deny'): CallToolResult => {
    record(target, decision, decidedBy, denial);
    deps.denied?.(grant, denial);
    return errorResult(denial, message);
  };

  // The level first: a blocked agent learns nothing about what exists.
  const byLevel = decide({ operation, level: grant.level, inScope: true });
  if (byLevel.outcome === 'deny') return refuse('', byLevel.denial, `This agent's level doesn't allow ${def.name}.`);

  const resolved = safeResolve(def, args, grant);
  if ('denial' in resolved) return refuse('', resolved.denial, resolved.message);
  const { target } = resolved;
  const decided = decide({ operation, level: grant.level, inScope: resolved.inScope });
  if (decided.outcome === 'deny') return refuse(target, decided.denial, 'That is outside the projects this agent was given.');
  const decision = (resolved.foreign && grant.level === 'ask') || resolved.mustAsk ? { outcome: 'ask-once' as const } : decided;

  let decidedBy: 'rule' | 'person' = 'rule';
  const key = `${grant.id} ${def.name}`;
  if (decision.outcome !== 'allow' && !(decision.outcome === 'ask' && deps.always.has(key))) {
    const once = decision.outcome === 'ask-once';
    const ask = (signal: AbortSignal): Promise<AskAnswer> => deps.ask(`${grant.name} wants to ${resolved.wants ?? `use ${def.name}`}`, resolved.detail ?? cardDetail(target, args), once, { agentId: grant.id, agent: grant.name, ...(target.startsWith(CHAT_TARGET) ? { chatId: target.slice(CHAT_TARGET.length) } : {}) }, signal).catch(() => 'no' as const);
    const answer = await cardAnswer(`${grant.id} ${def.name} ${argumentsKey(args)}`, target ? `${grant.id} ${def.name} ${target}` : '', ask, deps);
    if (answer === 'waiting') return refuse(target, 'waiting_for_owner', WAITING, 'rule', decision.outcome);
    // No person's no: it doesn't count toward a suspension.
    if (answer === 'replaced') return refuse(target, 'invalid_request', 'A newer call took the place of this card. Nothing ran.', 'rule', decision.outcome);
    decidedBy = 'person';
    // A revoke closes its open cards: that no is the grant's end, not a person's word.
    if (answer === 'no' && !deps.live(grant.id)) return refuse(target, 'grant_gone', "This agent's grant has ended.", 'person', decision.outcome);
    if (answer === 'no') return refuse(target, 'declined', 'The owner declined this, or did not answer in time.', 'person', decision.outcome);
    if (answer === 'always' && !once) deps.always.add(key);
  }

  // A card can wait for minutes: what the grant was when the call came in no longer counts.
  if (!deps.live(grant.id)) return refuse(target, 'grant_gone', "This agent's grant has ended.", decidedBy, decision.outcome === 'allow' ? 'deny' : decision.outcome);

  try {
    const value = await asActingAgent({ id: grant.id, name: grant.name }, () => def.run(args, grant));
    record(def.auditTarget?.(value, args) ?? target, decision.outcome, decidedBy, 'ok');
    return value instanceof ToolContent ? { content: value.content } : { content: [{ type: 'text', text: boundedText(JSON.stringify(value), LIMITS[grant.route].responseChars) }] };
  } catch (err) {
    if (err instanceof ToolRefusal) return refuse(target, err.denial, err.message, decidedBy, decision.outcome === 'allow' ? 'deny' : decision.outcome);
    record(target, decision.outcome, decidedBy, 'error');
    return errorResult('invalid_request', err instanceof Error ? err.message : 'It failed.');
  }
}

/**
 * The owner's answer to this call's card, or 'waiting' when none came in time. A client gives up long
 * before a card ends, and a tool must not run for a client that left: so the card stays open, and only
 * a call that is here takes its answer. One answer goes to one call.
 */
async function cardAnswer(key: string, slot: string, ask: (signal: AbortSignal) => Promise<AskAnswer>, deps: ToolDeps): Promise<AskAnswer | 'waiting' | 'replaced'> {
  const held = deps.cards.get(key) ?? openCard(key, slot, ask, deps);
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'waiting'>((resolve) => {
    timer = setTimeout(() => resolve('waiting'), deps.cardWaitMs ?? CARD_WAIT_MS);
  });
  const answer = await Promise.race([held.answer, timedOut]);
  clearTimeout(timer);
  if (held.replaced) return 'replaced';
  if (answer === 'waiting' || held.taken) return 'waiting';
  held.taken = true;
  if (deps.cards.get(key) === held) deps.cards.delete(key);
  return answer;
}

function openCard(key: string, slot: string, ask: (signal: AbortSignal) => Promise<AskAnswer>, deps: ToolDeps): HeldCard {
  // A retry with other arguments: the person answers the newest, not a pile of them. One already answered stays for its own retry.
  if (slot) {
    for (const [other, old] of deps.cards) {
      if (old.slot !== slot || old.answered) continue;
      old.replaced = true;
      old.drop();
      deps.cards.delete(other);
    }
  }
  const closing = new AbortController();
  const closed = new Promise<AskAnswer>((resolve) => closing.signal.addEventListener('abort', () => resolve('no'), { once: true }));
  const held: HeldCard = { answer: Promise.race([ask(closing.signal), closed]), taken: false, slot, answered: false, replaced: false, drop: () => closing.abort() };
  deps.cards.set(key, held);
  void held.answer.then(() => {
    held.answered = true;
    setTimeout(() => {
      if (deps.cards.get(key) === held) deps.cards.delete(key);
    }, deps.cardKeepMs ?? CARD_ANSWER_KEEP_MS).unref?.();
  });
  return held;
}

/** What a person approves: the target, and the arguments as they will run. Scrubbed, and a cut says so. */
function cardDetail(target: string, args: Record<string, unknown>): string {
  const place = target ? `On ${target}` : 'An external agent is asking.';
  const given = Object.keys(args).length ? scrubbed(JSON.stringify(args, null, 1)) : '';
  if (!given) return place;
  return `${place}\n${given.length > CARD_ARGS_MAX ? `${given.slice(0, CARD_ARGS_MAX)}\n… (cut: ${given.length} characters in all)` : given}`;
}

const argumentsKey = (args: Record<string, unknown>): string => createHash('sha256').update(JSON.stringify(args)).digest('hex');

function safeResolve(def: ExternalToolDef, args: Record<string, unknown>, grant: Grant): Resolved {
  try {
    return def.resolve(args, grant);
  } catch {
    return { denial: 'invalid_request', message: 'Those arguments could not be read.' };
  }
}

const errorResult = (denial: Denial, message: string): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify({ error: denial, message }) }], isError: true });
