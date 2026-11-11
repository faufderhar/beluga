import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { belugaEnv } from '../core/beluga-env.js';
import { belugaHome } from '../core/home.js';
import { externalPort, externalUrl } from '../external/adapters/config-file.js';
import type { Grant } from '../external/domain/grant.js';
import { callDaemon, callDaemonWithin } from './daemon-call.js';

/**
 * `beluga chat …`: scripts on this computer use the same tools as any external agent. It holds a
 * named local grant, made after you say yes on the Mac, and never the daemon's token: its work is
 * labeled and logged like any other agent's.
 */

export const CHAT_USAGE = `Usage: beluga chat <command>
  start <project|.> <message>   start a chat in a project (. is the one this folder is in)
             --worktree <base>  in a new worktree from that branch or ref
  send <id> <message|->         send a message (- reads it from stdin); it never interrupts a run
             --wait             wait for the reply and print it
             --json             print JSON
  show <id>                     print a chat (--json too)
  list                          list the chats it reaches (--json too)

With --wait it exits 1 when the run fails or stops, and 2 when the run waits for an answer in the app.
The first use asks you on the Mac for a grant, named Beluga CLI.
`;

const GRANT_NAME = 'Beluga CLI';
const LEVEL = 'trusted';
/** A card on the Mac waits 5 minutes before it's declined. */
const CARD_WAIT_MS = 5 * 60_000 + 10_000;
const WAIT_STEP_MS = 60_000;
const PAGE = 200;
const EXIT_OK = 0;
const EXIT_RUN_ENDED_BADLY = 1;
const EXIT_NEEDS_ANSWER = 2;

/** One tool call. A refusal throws with its words. */
export type CallTool = (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface ChatDeps {
  /** A session with the listener, under a grant that holds `project` when it is given. */
  connect(project?: string): Promise<{ readonly call: CallTool; readonly close: () => Promise<void> }>;
  readonly stdin: () => Promise<string>;
  /** The project this folder is in. */
  readonly hereProject: () => string;
}

export async function runChat(args: readonly string[], out: (text: string) => void = (t) => void process.stdout.write(t), deps: ChatDeps = realDeps()): Promise<number> {
  const [command, ...rest] = args;
  switch (command) {
    case 'start':
      return start(rest, out, deps);
    case 'send':
      return send(rest, out, deps);
    case 'show':
      return show(rest, out, deps);
    case 'list':
      return list(rest, out, deps);
    default:
      out(CHAT_USAGE);
      return command === undefined || command === '--help' ? EXIT_OK : 1;
  }
}

/** How a run's end becomes an exit code. */
export function exitCodeOf(wait: Record<string, unknown>): number {
  if (wait.hasPendingQuestion || wait.pendingApproval) return EXIT_NEEDS_ANSWER;
  return wait.status === 'failed' || wait.status === 'cancelled' || wait.status === 'interrupted' ? EXIT_RUN_ENDED_BADLY : EXIT_OK;
}

async function start(args: readonly string[], out: (text: string) => void, deps: ChatDeps): Promise<number> {
  const { values, positionals } = parseArgs({ args: [...args], allowPositionals: true, options: { worktree: { type: 'string' }, json: { type: 'boolean' } } });
  const [where, ...words] = positionals;
  const message = words.join(' ');
  if (!where || !message) throw new Error('Say the project and the message: beluga chat start <project|.> <message>');
  const project = where === '.' ? deps.hereProject() : where;
  return withSession(deps, project, async (call) => {
    const receipt = await call('beluga_chat_launch', { project, message, workspaceStrategy: values.worktree ? 'worktree' : 'root', ...(values.worktree ? { baseRef: values.worktree } : {}) });
    out(values.json ? `${JSON.stringify(receipt)}\n` : `${String(receipt.chatId)}\n`);
    return EXIT_OK;
  });
}

async function send(args: readonly string[], out: (text: string) => void, deps: ChatDeps): Promise<number> {
  const { values, positionals } = parseArgs({ args: [...args], allowPositionals: true, options: { wait: { type: 'boolean' }, json: { type: 'boolean' } } });
  const [chat, ...words] = positionals;
  const typed = words.join(' ');
  if (!chat || !typed) throw new Error('Say the chat and the message: beluga chat send <id> <message|->');
  const message = typed === '-' ? await deps.stdin() : typed;
  return withSession(deps, undefined, async (call) => {
    const receipt = await call('beluga_chat_send', { chat, message, mode: 'auto' });
    if (!values.wait) {
      out(values.json ? `${JSON.stringify(receipt)}\n` : `${String(receipt.delivery)}\n`);
      return EXIT_OK;
    }
    const ended = await waitForEnd(call, chat, receipt.runId as string | undefined);
    out(values.json ? `${JSON.stringify(ended)}\n` : reply(ended));
    return exitCodeOf(ended);
  });
}

async function show(args: readonly string[], out: (text: string) => void, deps: ChatDeps): Promise<number> {
  const { values, positionals } = parseArgs({ args: [...args], allowPositionals: true, options: { json: { type: 'boolean' } } });
  const chat = positionals[0];
  if (!chat) throw new Error('Which chat? See `beluga chat list`.');
  return withSession(deps, undefined, async (call) => {
    const messages: Array<Record<string, unknown>> = [];
    for (let after = 0, more = true; more; ) {
      const page = await call('beluga_chat_read', { chat, afterPosition: after, limit: PAGE });
      messages.push(...(page.messages as Array<Record<string, unknown>>));
      after = page.nextPosition as number;
      more = page.hasMore === true;
    }
    out(values.json ? `${JSON.stringify({ chat, messages })}\n` : messages.map((m) => `${textOf(m.author)}: ${textOf(m.text)}\n`).join(''));
    return EXIT_OK;
  });
}

async function list(args: readonly string[], out: (text: string) => void, deps: ChatDeps): Promise<number> {
  const { values } = parseArgs({ args: [...args], options: { json: { type: 'boolean' } } });
  return withSession(deps, undefined, async (call) => {
    const found = await call('beluga_chat_list', { limit: PAGE });
    const chats = found.chats as Array<Record<string, unknown>>;
    out(values.json ? `${JSON.stringify(found)}\n` : chats.map((c) => `${String(c.id)}  ${String(c.status)}  ${textOf(c.title)}\n`).join('') || 'No chats.\n');
    return EXIT_OK;
  });
}

async function withSession(deps: ChatDeps, project: string | undefined, work: (call: CallTool) => Promise<number>): Promise<number> {
  const session = await deps.connect(project);
  try {
    return await work(session.call);
  } finally {
    await session.close();
  }
}

/** A step of the wait timing out says nothing: the run goes on, and so does this. */
async function waitForEnd(call: CallTool, chat: string, runId: string | undefined): Promise<Record<string, unknown>> {
  for (;;) {
    const now = await call('beluga_chat_wait', { chat, timeoutMs: WAIT_STEP_MS, ...(runId ? { runId } : {}) });
    if (!now.timedOut) return now;
  }
}

function reply(wait: Record<string, unknown>): string {
  if (wait.pendingApproval) return 'The run waits for your approval in Beluga.\n';
  if (wait.hasPendingQuestion) return 'The run waits for your answer in Beluga.\n';
  const text = textOf(wait.text);
  return `${text || `The run ended: ${String(wait.status)}`}\n`;
}

/** Tools mark what people wrote as data, with its text inside. */
function textOf(field: unknown): string {
  return typeof field === 'string' ? field : typeof (field as { text?: unknown } | undefined)?.text === 'string' ? (field as { text: string }).text : '';
}

// ------------------------------------------------------------------ the real grant and connection

interface HeldGrant {
  readonly id: string;
  readonly token: string;
  readonly projects: readonly string[];
}

export const chatGrantPath = (): string => path.join(belugaHome(), 'cli-grant.json');

function realDeps(): ChatDeps {
  return {
    connect,
    stdin: async () => {
      let text = '';
      for await (const chunk of process.stdin) text += String(chunk);
      return text;
    },
    hereProject,
  };
}

async function connect(project?: string): Promise<{ readonly call: CallTool; readonly close: () => Promise<void> }> {
  const held = readGrant();
  const usable = held && (!project || held.projects.includes(project)) ? held : await askForGrant(held, project ?? hereProject());
  try {
    return await open(usable);
  } catch (err) {
    if (!isUnauthorized(err)) throw err;
    // It was revoked or it expired: you are asked again.
    rmSync(chatGrantPath(), { force: true });
    return open(await askForGrant(undefined, project ?? hereProject()));
  }
}

async function open(grant: HeldGrant): Promise<{ readonly call: CallTool; readonly close: () => Promise<void> }> {
  const client = new Client({ name: GRANT_NAME, version: '1' });
  const url = belugaEnv('MCP_URL') ?? externalUrl(externalPort());
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${grant.token}` } } })).catch((err: unknown) => {
    if (isUnauthorized(err)) throw err;
    throw new Error('Beluga is not listening for agents. Run: beluga mcp on');
  });
  return {
    call: async (name, args) => {
      const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text?: string }>; isError?: boolean };
      const value = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
      if (result.isError) throw new Error(typeof value.message === 'string' ? value.message : 'Beluga refused this.');
      return value;
    },
    close: () => client.close(),
  };
}

/** A new grant, with the projects of the one it replaces. It asks you on the Mac. */
async function askForGrant(held: HeldGrant | undefined, project: string): Promise<HeldGrant> {
  const projects = [...new Set([...(held?.projects ?? []), project])];
  const made = (await callDaemonWithin(CARD_WAIT_MS, 'external.localToken', GRANT_NAME, { level: LEVEL, projects })) as { grant: Grant; token: string };
  const grant: HeldGrant = { id: made.grant.id, token: made.token, projects };
  writeGrant(grant);
  if (held) await callDaemon('external.revoke', held.id).catch(() => undefined);
  return grant;
}

function readGrant(): HeldGrant | undefined {
  try {
    const held = JSON.parse(readFileSync(chatGrantPath(), 'utf8')) as HeldGrant;
    return typeof held.token === 'string' && typeof held.id === 'string' && Array.isArray(held.projects) ? held : undefined;
  } catch {
    return undefined;
  }
}

function writeGrant(grant: HeldGrant): void {
  const file = chatGrantPath();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(grant), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

const isUnauthorized = (err: unknown): boolean => /\b401\b|unauthorized/i.test(err instanceof Error ? err.message : String(err));

/** The repo's main folder names the project, also from one of its worktrees. */
function hereProject(): string {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return path.basename(path.dirname(common));
  } catch {
    return path.basename(process.cwd());
  }
}
