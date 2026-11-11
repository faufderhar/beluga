import type { z } from 'zod';
import { isSecretPath } from '../../../core/shares.js';
import { isExternalRequester } from '../../../core/trust.js';
import { API, type Method } from '../../../ipc/api.js';
import { reachesProject, type Grant } from '../../domain/grant.js';
import type { ExternalTool } from '../../domain/tools.js';
import type { ChatRead } from '../../ports/chat-read.js';
import type { MethodCalls } from '../../ports/methods.js';
import type { ExternalToolDef, Resolved } from '../mcp-tools.js';
import { DATA_NOTICE, chatInScope, scrubbed, untrusted } from './read.js';

/**
 * A tool for one API method. Its row says everything: the method, a name for each argument (the
 * schema comes from the API, so the method's own limits hold), what it acts on, and what its card says.
 * The class is in TOOL_ACCESS. What comes back is data: scrubbed, bounded, marked.
 */

const RESULT_MAX = 60_000;
const WS_PREFIX = 'ws:';

export type Scope =
  /** Nothing to check against the grant. Its class must ask below full (tests/external-methods). */
  | { readonly on: 'none' }
  /** The Beluga network: it needs grant.chats to say so. */
  | { readonly on: 'network'; readonly area: 'dms' | 'groups' | 'either' }
  | { readonly on: 'conversation'; readonly arg: string }
  /** It shows nothing of yours: a list that ships with Beluga. */
  | { readonly on: 'nothing_private' }
  | { readonly on: 'plan_pause_only'; readonly arg: string; readonly paused: string }
  | { readonly on: 'chat' | 'channel' | 'project' | 'project_or_chat' | 'request' | 'task' | 'plan' | 'plan_not_its_own' | 'sentinel' | 'board' | 'dashboard' | 'project_if_named'; readonly arg: string }
  /** A channel inside an object argument. */
  | { readonly on: 'channel_in'; readonly arg: string; readonly field: string }
  /** Its own rule, for a target these do not describe. */
  | { readonly on: 'custom'; readonly resolve: (args: Record<string, unknown>, grant: Grant) => Resolved };

export interface MethodRow {
  readonly name: ExternalTool;
  readonly method: Method;
  readonly description: string;
  /** A name for each argument, in the method's order. */
  readonly params: readonly string[];
  readonly scope: Scope;
  /** It changes something: a chat this agent didn't start asks at level ask. */
  readonly writes?: boolean;
  /** What its card says after the agent's name ("set {peer} to {level} trust"). */
  readonly wants?: string;
}

/** The tuple's items: a row's params must name each of them. */
export const methodArgs = (method: Method): readonly z.ZodType[] => (API[method].args as unknown as { def: { items: readonly z.ZodType[] } }).def.items;

export function methodTools(rows: readonly MethodRow[], reads: ChatRead, calls: MethodCalls, startedBy: (chatId: string) => string | undefined): ExternalToolDef[] {
  const chatTarget = (id: unknown, grant: Grant, writes: boolean): Resolved => {
    const chat = reads.chats().find((c) => c.id === id);
    if (!chat) return { denial: 'not_found', message: 'No such chat.' };
    if (writes && chat.kind !== 'project') return { denial: 'not_sendable', message: 'This chat is not one an agent can work in.' };
    return { target: `chat:${chat.id}`, inScope: chatInScope(chat, grant), ...(writes && startedBy(chat.id) !== grant.id ? { foreign: true } : {}) };
  };
  const projectTarget = (name: unknown, grant: Grant): Resolved | undefined => {
    const project = reads.projects().find((p) => p.id === name || p.name === name);
    return project && { target: `project:${project.id}`, inScope: reachesProject(grant, project.id) };
  };
  /** One in no project is the grant's only when it reaches everything. */
  const ownedTarget = (kind: string, id: string, projects: readonly string[] | undefined, grant: Grant): Resolved => {
    if (!projects) return { denial: 'not_found', message: `No such ${kind}.` };
    return { target: `${kind}:${id}`, inScope: projects.length ? projects.every((p) => reachesProject(grant, p)) : grant.projects === 'all' };
  };
  const channelTarget = (channel: unknown, grant: Grant, writes: boolean): Resolved => (typeof channel === 'string' && channel.startsWith(WS_PREFIX) ? chatTarget(channel.slice(WS_PREFIX.length), grant, writes) : { denial: 'not_found', message: 'No such chat.' });

  const target = (row: MethodRow, args: Record<string, unknown>, grant: Grant): Resolved => {
    const { scope } = row;
    const writes = row.writes === true;
    switch (scope.on) {
      case 'network':
        return { target: '', inScope: scope.area === 'dms' ? grant.chats.dms : scope.area === 'groups' ? grant.chats.groups : grant.chats.dms || grant.chats.groups };
      case 'conversation': {
        const id = String(args[scope.arg]);
        return { target: id.startsWith('dm:') ? 'dm' : 'group', inScope: id.startsWith('dm:') ? grant.chats.dms : grant.chats.groups };
      }
      case 'none':
      case 'nothing_private':
        return { target: '', inScope: true };
      case 'task':
      case 'plan':
      case 'sentinel':
      case 'board': {
        const id = String(args[scope.arg]);
        return ownedTarget(scope.on, id, calls.projectsOf(scope.on, id), grant);
      }
      case 'plan_pause_only': {
        if (args[scope.paused] === false) return { denial: 'needs_person', message: 'Only a person resumes a plan.' };
        const id = String(args[scope.arg]);
        return ownedTarget('plan', id, calls.projectsOf('plan', id), grant);
      }
      case 'plan_not_its_own': {
        const id = String(args[scope.arg]);
        if (calls.changedPlan(id, grant.id)) return { denial: 'capability_denied', message: 'This agent changed this plan, and a checker stays separate. A person passes it.' };
        return ownedTarget('plan', id, calls.projectsOf('plan', id), grant);
      }
      case 'dashboard':
        return calls.dashboardExists(String(args[scope.arg])) ? { target: `dashboard:${String(args[scope.arg])}`, inScope: true } : { denial: 'not_found', message: 'No such dashboard.' };
      case 'project_if_named':
        // Everywhere, with none named: only a grant that reaches everything.
        return args[scope.arg] === undefined ? { target: '', inScope: grant.projects === 'all' } : (projectTarget(args[scope.arg], grant) ?? { denial: 'not_found', message: 'No such project.' });
      case 'custom':
        return scope.resolve(args, grant);
      case 'chat':
        return chatTarget(args[scope.arg], grant, writes);
      case 'channel':
        return channelTarget(args[scope.arg], grant, writes);
      case 'channel_in':
        return channelTarget((args[scope.arg] as Record<string, unknown>)[scope.field], grant, writes);
      case 'project':
        return projectTarget(args[scope.arg], grant) ?? { denial: 'not_found', message: 'No such project.' };
      case 'project_or_chat':
        return projectTarget(args[scope.arg], grant) ?? chatTarget(args[scope.arg], grant, writes);
      case 'request':
        return channelTarget(calls.channelOfRequest(String(args[scope.arg])), grant, writes);
    }
  };

  return rows.map((row) => {
    const items = methodArgs(row.method);
    const idParam = row.scope.on === 'project' || row.scope.on === 'project_or_chat' || row.scope.on === 'project_if_named' ? row.scope.arg : undefined;
    if (items.length !== row.params.length) throw new Error(`${row.name}: ${row.method} takes ${items.length} arguments, and its row names ${row.params.length}.`);
    return {
      name: row.name,
      description: row.description,
      inputSchema: Object.fromEntries(row.params.map((param, i) => [param, items[i]!])),
      resolve: (args, grant) => {
        // What a tool reads or writes by name: a secret stays out, whatever the method does with it.
        // A grant is no person: no tool sets trust on it, or names it anywhere.
        if (Object.values(args).some((v) => typeof v === 'string' && isExternalRequester(v))) return { denial: 'capability_denied', message: 'An agent never changes a grant.' };
        if ([args.file, args.target, args.path, ...(Array.isArray(args.paths) ? args.paths : [])].some((p) => typeof p === 'string' && isSecretPath(p))) return { denial: 'capability_denied', message: 'That file holds secrets.' };
        const resolved = target(row, args, grant);
        return 'denial' in resolved || !row.wants ? resolved : { ...resolved, wants: fill(row.wants, args, calls) };
      },
      run: async (args) => {
        // A project goes by its name or id here, and always by its id to the method.
        const values = row.params.map((param) => (param === idParam ? (reads.projects().find((p) => p.name === args[param])?.id ?? args[param]) : args[param]));
        while (values.length && values.at(-1) === undefined) values.pop();
        const result = await calls.call(row.method, values);
        return result === undefined ? { done: true } : { notice: DATA_NOTICE, result: untrusted(typeof result === 'string' ? result : JSON.stringify(withoutSecrets(result)), RESULT_MAX) };
      },
    };
  });
}

/**
 * What a method gave, before it goes out as text: a scrub on one line of JSON would miss a line start,
 * so each string gets it here. A secret file in a commit keeps its name and loses its diff.
 */
function withoutSecrets(value: unknown): unknown {
  if (typeof value === 'string') return scrubbed(value);
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (value === null || typeof value !== 'object') return value;
  const held = value as Record<string, unknown>;
  const secret = typeof held.path === 'string' && isSecretPath(held.path);
  return Object.fromEntries(Object.entries(held).filter(([key]) => !(secret && key === 'diff')).map(([key, v]) => [key, withoutSecrets(v)]));
}

/** A card's words with the arguments in: one line, short, scrubbed. A cut says so, and the card's detail has the whole. */
function fill(words: string, args: Record<string, unknown>, calls: MethodCalls): string {
  return words.replace(/\{(\w+)\}/g, (_all, param: string) => {
    const value = args[param];
    const text = value === undefined ? '(none)' : param === 'peer' ? calls.personName(String(value)) : typeof value === 'string' ? value : JSON.stringify(value);
    const words = untrusted(text.replace(/\s+/g, ' '), 120);
    return words.truncated ? `${words.text}…` : words.text;
  });
}
