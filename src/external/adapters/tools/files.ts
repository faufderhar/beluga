import path from 'node:path';
import { z } from 'zod';
import { writesCode } from '../../../agent/policy.js';
import { FileGateError, cleanRel, findByName, gate, listFolder, readPage } from '../../../companion/worktree-files.js';
import { formatWithPrettier, formatterFor, searchContents, writeWorkspaceFile } from '../../../core/workspace-files.js';
import { isSecretPath } from '../../../core/shares.js';
import { reachesProject, type Grant } from '../../domain/grant.js';
import type { ChatRead } from '../../ports/chat-read.js';
import type { FilesPort } from '../../ports/files.js';
import type { MethodCalls } from '../../ports/methods.js';
import type { ExternalToolDef, Resolved } from '../mcp-tools.js';
import { DATA_NOTICE, chatInScope, untrusted } from './read.js';

/**
 * Files and terminals with no run in between. A file tool works as the phone's file gate does
 * (companion/worktree-files.ts): only inside a folder the grant reaches, links followed and checked
 * again, secrets refused by name and by where they lead. A save to a file that runs code later asks
 * as writes_code does. A terminal is a shell: it opens with one card below full, and what is typed
 * goes in the audit log as a length, never as text.
 */

const TEXT_MAX = 2_000_000;
const RESULT_MAX = 60_000;
const QUERY_MAX = 1000;
const REL_MAX = 4096;
const INPUT_MAX = 16_000;
const TERMS_KEPT = 200;
const SECRET = 'That file holds secrets.';

const where = z.string().min(1).max(300).describe('A chat id, or a project id or name.');
const rel = z.string().max(REL_MAX).describe('A path inside its folder.');

export function fileTools(reads: ChatRead, port: FilesPort, calls: MethodCalls): ExternalToolDef[] {
  /** The terminals each agent opened, and the chat each one is in: it reaches only those. */
  const opened = new Map<string, { readonly grantId: string; readonly chat: string }>();
  const idOf = (name: unknown): string => reads.projects().find((p) => p.id === name || p.name === name)?.id ?? String(name);
  const folderTarget = (name: unknown, grant: Grant): Resolved => {
    const id = idOf(name);
    if (reads.projects().some((p) => p.id === id)) return { target: `project:${id}`, inScope: reachesProject(grant, id) };
    const chat = reads.chats().find((c) => c.id === id && c.kind === 'project');
    return chat ? { target: `chat:${chat.id}`, inScope: chatInScope(chat, grant) } : { denial: 'not_found', message: 'No such chat or project.' };
  };
  const rootOf = (name: unknown) => {
    const folder = port.folder(idOf(name));
    if (!folder) throw new Error('That folder is not on this Mac any more.');
    return folder;
  };
  /** The grant, then the gate: a refusal says why, and comes before any card. */
  const gatedFile = (args: Record<string, unknown>, grant: Grant): Resolved => {
    const target = folderTarget(args.where, grant);
    if ('denial' in target || !target.inScope) return target;
    try {
      const folder = port.folder(idOf(args.where));
      if (!folder) return { denial: 'not_found', message: 'That folder is not on this Mac any more.' };
      gate(folder.root, String(args.path ?? ''));
      return target;
    } catch (err) {
      return refusal(err);
    }
  };
  /** A file to change: gone since it was listed is the write's to say, and one that runs code later asks below full. */
  const gatedSave = (args: Record<string, unknown>, grant: Grant): Resolved => {
    const target = folderTarget(args.where, grant);
    if ('denial' in target || !target.inScope) return target;
    const file = String(args.path);
    try {
      const folder = port.folder(idOf(args.where));
      if (!folder) return { denial: 'not_found', message: 'That folder is not on this Mac any more.' };
      const parts = cleanRel(file);
      if (!parts.length) return { denial: 'invalid_request', message: 'Name a file.' };
      gate(folder.root, parts.slice(0, -1).join('/'));
      try {
        gate(folder.root, file);
      } catch (err) {
        if (!(err instanceof FileGateError) || !/isn.t there/.test(err.message)) throw err;
      }
      const code = grant.level !== 'full' && writesCode('Write', { file_path: file }, folder.root);
      return { ...target, ...(code ? { mustAsk: true, wants: `change ${path.basename(file)}, a file that can run commands on your Mac` } : {}) };
    } catch (err) {
      return refusal(err);
    }
  };
  const terminalTarget = (args: Record<string, unknown>, grant: Grant): Resolved => {
    const known = opened.get(String(args.terminal));
    if (!known || known.grantId !== grant.id) return { denial: 'not_found', message: 'No such terminal from this agent. Use terminal_open.' };
    const chat = reads.chats().find((c) => c.id === known.chat);
    return chat ? { target: `chat:${chat.id}`, inScope: chatInScope(chat, grant) } : { denial: 'not_found', message: 'No such chat.' };
  };
  const data = (value: unknown) => ({ notice: DATA_NOTICE, result: untrusted(typeof value === 'string' ? value : JSON.stringify(value), RESULT_MAX) });
  const gateErrors = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (err) {
      throw err instanceof FileGateError ? new Error(err.message) : err;
    }
  };

  return [
    {
      name: 'file_list',
      description: 'List a folder in a chat\'s or a project\'s folder. Secret files and links that lead out are not listed.',
      inputSchema: { where, path: rel.optional() },
      resolve: gatedFile,
      run: (args) => gateErrors(async () => data(await listFolder(rootOf(args.where).root, String(args.path ?? '')))),
    },
    {
      name: 'file_read',
      description: 'Read a page of a file in a chat\'s or a project\'s folder. A secret file, or a link that leads out, is refused. Page with offset.',
      inputSchema: { where, path: rel, offset: z.number().int().min(0).optional() },
      resolve: gatedFile,
      run: (args) => gateErrors(async () => data(await readPage(rootOf(args.where).root, String(args.path), args.offset as number | undefined))),
    },
    {
      name: 'file_find',
      description: 'Find files by name in a chat\'s or a project\'s folder. Secret files are not found.',
      inputSchema: { where, query: z.string().min(1).max(QUERY_MAX) },
      resolve: (args, grant) => folderTarget(args.where, grant),
      run: (args) => gateErrors(async () => data(await findByName(rootOf(args.where).root, String(args.query)))),
    },
    {
      name: 'file_search',
      description: 'Find lines with a query in a chat\'s or a project\'s files, by file. A secret file is left out of what comes back.',
      inputSchema: { where, query: z.string().min(1).max(QUERY_MAX), regex: z.boolean().optional(), caseSensitive: z.boolean().optional(), wholeWord: z.boolean().optional() },
      resolve: (args, grant) => folderTarget(args.where, grant),
      run: async (args) => {
        const found = await searchContents(rootOf(args.where).root, String(args.query), { regex: args.regex === true, caseSensitive: args.caseSensitive === true, wholeWord: args.wholeWord === true }, new AbortController().signal);
        // The count too: what a secret file matched must not tell an agent what is in it.
        const files = found.files.filter((f) => !isSecretPath(f.path));
        return data({ ...found, files, count: files.reduce((n, f) => n + f.matches.length, 0) });
      },
    },
    {
      name: 'file_save',
      description: 'Change a file that exists in a chat\'s or a project\'s folder. Give expect, the hash of the text you started from, to catch a change in between. A secret file is refused. Below full, a file that runs code later (package.json, a git hook) asks once.',
      inputSchema: { where, path: rel, content: z.string().max(TEXT_MAX), expect: z.string().regex(/^[0-9a-f]{64}$/).optional(), force: z.boolean().optional() },
      resolve: gatedSave,
      run: (args) => writeWorkspaceFile(rootOf(args.where).root, String(args.path), String(args.content), { ...(args.expect ? { expect: String(args.expect) } : {}), ...(args.force === true ? { force: true } : {}) }),
    },
    {
      name: 'file_formatter',
      description: 'Say whether the project\'s Prettier can format a file.',
      inputSchema: { where, path: rel },
      resolve: gatedFile,
      run: (args) => {
        const { root, more } = rootOf(args.where);
        return formatterFor(root, String(args.path), [...more]);
      },
    },
    {
      name: 'file_format',
      description: 'The text as the project\'s Prettier lays it out. Nothing is saved.',
      inputSchema: { where, path: rel, content: z.string().max(TEXT_MAX) },
      resolve: gatedFile,
      run: async (args) => {
        const { root, more } = rootOf(args.where);
        return data(await formatWithPrettier(root, String(args.path), String(args.content), [...more]));
      },
    },
    {
      name: 'terminal_open',
      description: 'Open a shell in a chat\'s folder, or the one that is open there. It is a shell: below full a person is asked one time. The result has its terminal id.',
      inputSchema: { chat: z.string().max(300), cols: z.number().int().min(1).max(1000).optional(), rows: z.number().int().min(1).max(500).optional() },
      resolve: (args, grant) => {
        const chat = reads.chats().find((c) => c.id === args.chat && c.kind === 'project');
        if (!chat) return { denial: 'not_found', message: 'No such chat.' };
        return { target: `chat:${chat.id}`, inScope: chatInScope(chat, grant), ...(grant.level === 'full' ? {} : { mustAsk: true, wants: 'open a shell, and it can type anything there' }) };
      },
      run: async (args, grant) => {
        const size = args.cols && args.rows ? [{ cols: args.cols, rows: args.rows }] : [];
        const key = await calls.call('terminals.shell', [args.chat, ...size]);
        if (typeof key !== 'string') throw new Error('Beluga could not open a shell there.');
        opened.set(key, { grantId: grant.id, chat: String(args.chat) });
        if (opened.size > TERMS_KEPT) opened.delete(opened.keys().next().value!);
        return { terminal: key };
      },
    },
    {
      name: 'terminal_input',
      description: 'Type into a terminal that this agent opened. End a line with \\n. Beluga logs how many characters, never the text.',
      inputSchema: { terminal: z.string().max(200), text: z.string().min(1).max(INPUT_MAX) },
      resolve: terminalTarget,
      run: (args) => {
        const pty = port.terminal(String(args.terminal));
        if (!pty) throw new Error('That terminal has ended.');
        pty.write(String(args.text));
        return { typed: String(args.text).length };
      },
      auditArgs: (args) => ({ terminal: args.terminal, length: String(args.text).length }),
      auditNote: (args) => `typed ${String(args.text).length} characters`,
    },
    {
      name: 'terminal_read',
      description: 'What a terminal that this agent opened wrote lately.',
      inputSchema: { terminal: z.string().max(200) },
      resolve: terminalTarget,
      run: (args) => {
        const pty = port.terminal(String(args.terminal));
        if (!pty) throw new Error('That terminal has ended.');
        return data(pty.backlog());
      },
    },
    {
      name: 'terminal_restart',
      description: 'Start a terminal that this agent opened again.',
      inputSchema: { terminal: z.string().max(200) },
      resolve: terminalTarget,
      run: async (args) => ({ terminal: await calls.call('terminals.restart', [args.terminal]) }),
    },
    {
      name: 'terminal_rename',
      description: 'Rename a terminal that this agent opened.',
      inputSchema: { terminal: z.string().max(200), name: z.string().max(200) },
      resolve: terminalTarget,
      run: async (args) => {
        await calls.call('terminals.rename', [args.terminal, args.name]);
        return { renamed: true };
      },
    },
    {
      name: 'terminal_close',
      description: 'End a terminal that this agent opened. It ends for each screen.',
      inputSchema: { terminal: z.string().max(200) },
      resolve: terminalTarget,
      run: async (args) => {
        await calls.call('terminals.close', [args.terminal]);
        opened.delete(String(args.terminal));
        return { closed: true };
      },
    },
  ];
}

function refusal(err: unknown): Resolved {
  if (!(err instanceof FileGateError)) return { denial: 'invalid_request', message: 'That path could not be read.' };
  return /secret/i.test(err.message) ? { denial: 'capability_denied', message: SECRET } : { denial: 'project_denied', message: err.message };
}
