import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { belugaHome } from '../../../core/home.js';
import { writeJson } from '../../../workspaces/store.js';
import { BUILTIN_ACP_AGENTS, builtinAcpAgent } from './catalog.js';
import { type AcpAgentEntry, RUNTIME_ID, acpRuntimeId, entryProblem } from './entry.js';

/**
 * Your ACP agents, kept in ~/.beluga/acp-agents.json (0600): the built-in ones you added (by id),
 * ones installed from the ACP Registry (registry.ts) and commands of yours (whole). Only these are
 * in the agent pickers; none is there until you add it. Antigravity is one of the built-in ones:
 * a Mac that ran it before your list existed gets it added once (migrate).
 */

/** Ids the fixed runtimes own: no ACP agent may take one. */
const RESERVED = new Set(['claude', 'codex', 'opencode', 'copilot', 'local', 'fake']);

const Whole = z.object({
  id: z.string().regex(RUNTIME_ID),
  label: z.string().min(1).max(64),
  command: z.string().min(1).max(1024),
  args: z.array(z.string().max(1024)).max(32),
  env: z.record(z.string(), z.string().max(4096)).optional(),
  source: z.enum(['registry', 'local']),
  registryId: z.string().max(128).optional(),
  version: z.string().max(128).optional(),
  website: z.string().max(512).optional(),
  description: z.string().max(1000).optional(),
  install: z.string().max(500).optional(),
});
const Builtin = z.object({ id: z.string().regex(RUNTIME_ID), source: z.literal('builtin') });

const File = z.object({
  added: z.array(z.union([Builtin, Whole])).max(100).default([]),
  /** Set once the first list was made (migrate ran): Antigravity isn't added back after you remove it. */
  migrated: z.boolean().optional(),
});
type AgentsFile = z.infer<typeof File>;

export type AddResult = { readonly ok: true; readonly id: string } | { readonly ok: false; readonly error: string };

export const acpAgentsFile = (home: string = belugaHome()): string => path.join(home, 'acp-agents.json');

export class AcpAgents {
  constructor(private readonly deps: { readonly file?: string } = {}) {}

  private get file(): string {
    return this.deps.file ?? acpAgentsFile();
  }

  private read(): AgentsFile & { readonly exists: boolean } {
    try {
      return { ...File.parse(JSON.parse(readFileSync(this.file, 'utf8'))), exists: true };
    } catch {
      return { added: [], exists: false };
    }
  }

  private write(next: AgentsFile): void {
    writeJson(this.file, { added: next.added, ...(next.migrated ? { migrated: true } : {}) });
  }

  /** Your ACP agents, in the order you added them (a built-in one as its catalog entry). */
  list(): AcpAgentEntry[] {
    return this.read().added.flatMap((a) => (a.source === 'builtin' ? (builtinAcpAgent(a.id) ? [builtinAcpAgent(a.id)!] : []) : [{ ...a } as AcpAgentEntry]));
  }

  /** One of yours by its runtime id; undefined for one you haven't added. */
  get(id: string): AcpAgentEntry | undefined {
    return this.list().find((a) => a.id === id);
  }

  /** Whether an agent is one of yours. */
  has(id: string): boolean {
    return this.read().added.some((a) => a.id === id);
  }

  /** The built-in agents you haven't added. */
  available(): AcpAgentEntry[] {
    const ids = new Set(this.read().added.map((a) => a.id));
    return BUILTIN_ACP_AGENTS.filter((b) => !ids.has(b.id));
  }

  /** Add a built-in agent by its id. */
  add(id: string): AddResult {
    if (!builtinAcpAgent(id)) return { ok: false, error: 'Beluga doesn’t know that agent.' };
    const file = this.read();
    if (!file.added.some((a) => a.id === id)) this.write({ ...file, added: [...file.added, { id, source: 'builtin' }] });
    return { ok: true, id };
  }

  /** Add (or replace) a whole agent: a Registry install or a command of yours. Refused, with why, when it can't be. */
  addWhole(entry: Omit<AcpAgentEntry, 'source'> & { readonly source: 'registry' | 'local' }): AddResult {
    const problem = entryProblem(entry);
    if (problem) return { ok: false, error: problem };
    // A built-in agent installed from the ACP Registry takes its built-in id, whole (its program is in Beluga's folder, not on PATH); a command of yours never does.
    if (RESERVED.has(entry.id) || (entry.source === 'local' && builtinAcpAgent(entry.id))) return { ok: false, error: `“${entry.id}” is taken by one of Beluga’s own agents.` };
    const parsed = Whole.safeParse({ ...entry });
    if (!parsed.success) return { ok: false, error: 'That agent can’t be added as it is.' };
    const file = this.read();
    this.write({ ...file, added: [...file.added.filter((a) => a.id !== entry.id), parsed.data] });
    return { ok: true, id: entry.id };
  }

  /** A command of yours as an agent: its id from its name (`acp-<name>`). */
  addCommand(input: { readonly label: string; readonly command: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>> }): AddResult {
    return this.addWhole({ id: acpRuntimeId(input.label), label: input.label.trim(), command: input.command.trim(), args: [...(input.args ?? [])], ...(input.env && Object.keys(input.env).length ? { env: { ...input.env } } : {}), source: 'local' });
  }

  /** Remove one of yours; false when it wasn't. */
  remove(id: string): boolean {
    const file = this.read();
    if (!file.added.some((a) => a.id === id)) return false;
    this.write({ ...file, added: file.added.filter((a) => a.id !== id) });
    return true;
  }

  /**
   * Once, when your list is first made: a Mac that ran Antigravity before (`usedAntigravity`: it's
   * your agent, a project's, or a conversation's) keeps it, added for you. Never again after that,
   * so one you removed stays removed. True when it added Antigravity.
   */
  migrate(usedAntigravity: () => boolean): boolean {
    const file = this.read();
    if (file.migrated) return false;
    const add = usedAntigravity() && !file.added.some((a) => a.id === 'antigravity');
    this.write({ added: add ? [...file.added, { id: 'antigravity', source: 'builtin' }] : file.added, migrated: true });
    return add;
  }
}

/** This computer's ACP agents (one per daemon). */
export const acpAgents = new AcpAgents();
