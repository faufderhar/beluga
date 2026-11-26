import { acpAgents } from '../agent/runtime/acp/agents.js';
import { builtinAcpAgent } from '../agent/runtime/acp/catalog.js';
import { findAcpCommand } from '../agent/runtime/acp/connection.js';
import { type AcpAgentEntry, installCommandOf, specOf } from '../agent/runtime/acp/entry.js';
import { AcpRegistry } from '../agent/runtime/acp/registry.js';
import { forgetAcpStatus } from '../agent/runtime/acp/status.js';
import type { Session } from '../core/session.js';
import type { Args, Method } from './api.js';

/** What each `acp.*` method does (see acp-api.ts). */

type AcpMethod = Extract<Method, `acp.${string}`>;
type AcpHandlers = { readonly [M in AcpMethod]: (s: Session, ...args: Args<M>) => unknown };

/** One ACP agent as Settings lists it. */
export interface AcpAgentView {
  readonly id: string;
  readonly label: string;
  readonly source: 'builtin' | 'registry' | 'local';
  /** Its command line, as it starts. */
  readonly command: string;
  readonly args: readonly string[];
  readonly version?: string;
  readonly website?: string;
  readonly description?: string;
  /** Its CLI is on this computer (a package runs through npx or uvx: those). */
  readonly installed: boolean;
  /** How to install it, in words, and the command to copy, when it isn't here. */
  readonly install?: string;
  readonly installCommand?: string;
}

/** The demo's ACP agents (its scripted Antigravity): running beside its own agent, so listed as yours, without writing your list. */
const besideAgents = (s: Session): AcpAgentEntry[] => s.besideRuntimes().flatMap((id) => (!acpAgents.has(id) && builtinAcpAgent(id) ? [builtinAcpAgent(id)!] : []));

let registry: AcpRegistry | undefined;
const theRegistry = (): AcpRegistry => (registry ??= new AcpRegistry(acpAgents));

const view = (a: AcpAgentEntry): AcpAgentView => {
  const installed = Boolean(findAcpCommand(specOf(a)));
  const copy = installCommandOf(a);
  return {
    id: a.id,
    label: a.label,
    source: a.source,
    command: a.command,
    args: a.args,
    ...(a.version ? { version: a.version } : {}),
    ...(a.website ? { website: a.website } : {}),
    ...(a.description ? { description: a.description } : {}),
    installed,
    ...(!installed && a.install ? { install: a.install } : {}),
    ...(!installed && copy ? { installCommand: copy } : {}),
  };
};

/** The pickers, Settings and onboarding learn what changed: every runtime asked again. */
const changed = (s: Session): void => {
  forgetAcpStatus();
  void s.workbench?.checkAgents().catch(() => undefined);
};

export const ACP_HANDLERS = {
  'acp.agents': (s) => ({ agents: [...acpAgents.list().map(view), ...besideAgents(s).map((a) => ({ ...view(a), installed: true }))] }),
  'acp.catalog': (s) => ({ agents: acpAgents.available().filter((a) => !besideAgents(s).some((b) => b.id === a.id)).map(view) }),
  'acp.add': (s, id) => {
    const entry = acpAgents.available().find((a) => a.id === id);
    if (!entry) return acpAgents.has(id) ? { ok: true as const, id } : { ok: false as const, error: 'Beluga doesn’t know that agent.' };
    // Only one whose CLI is here: the screens offer Copy Install Command for the others.
    if (!findAcpCommand(specOf(entry))) return { ok: false as const, error: `${entry.label} isn’t installed on this computer yet.${entry.install ? ` ${entry.install}.` : ''}` };
    const done = acpAgents.add(id);
    if (done.ok) changed(s);
    return done;
  },
  'acp.addCommand': (s, input) => {
    const done = acpAgents.addCommand(input);
    if (done.ok) changed(s);
    return done;
  },
  'acp.remove': async (s, id) => {
    const isRegistry = acpAgents.get(id)?.source === 'registry';
    const done = isRegistry ? await theRegistry().uninstall(id) : acpAgents.remove(id);
    if (done) changed(s);
    return done;
  },
  'acp.search': (_s, query) => theRegistry().search(query),
  'acp.install': async (s, id) => {
    const done = await theRegistry().install(id);
    if (done.ok) changed(s);
    return done;
  },
} satisfies AcpHandlers;
