import { z } from 'zod';

/**
 * Your ACP agents (Settings › Agent › ACP agents on the Mac): the ones you added (Antigravity, other
 * built-in ones, ones from the ACP Registry, commands of yours), the built-in ones you could add,
 * the Registry searched, one installed, one added or removed. Browser-safe: zod only.
 */

const runtimeId = z.string().regex(/^[a-z][\w-]{0,31}$/);
const arg = z.string().max(1024);

export const ACP_API = {
  // Your ACP agents → { agents: AcpAgentView[] }: each with where it came from and whether its CLI is here.
  'acp.agents': { args: z.tuple([]) },
  // The built-in ACP agents you haven't added → { agents: AcpAgentView[] }: each with whether its CLI is here and how to install it.
  'acp.catalog': { args: z.tuple([]) },
  // Add a built-in ACP agent whose CLI is here → { ok, id } | { ok: false, error }.
  'acp.add': { args: z.tuple([runtimeId]) },
  // Add a command of yours as an agent (its name, command, ACP arguments, variables) → { ok, id } | { ok: false, error }.
  'acp.addCommand': { args: z.tuple([z.object({ label: z.string().min(1).max(64), command: z.string().min(1).max(1024), args: z.array(arg).max(32).optional(), env: z.record(z.string().max(128), z.string().max(4096)).optional() }).strict()]) },
  // Remove one of your ACP agents (and what Beluga downloaded for it) → whether it was one.
  'acp.remove': { args: z.tuple([runtimeId]) },
  // The ACP Registry's agents whose name has every word of the query ('' for all) → RegistryHit[].
  'acp.search': { args: z.tuple([z.string().max(200)]) },
  // Install one from the Registry, at its version, and add it (you pressed Install) → { ok, runtime, version } | { ok: false, error }.
  'acp.install': { args: z.tuple([z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/)]) },
} as const;
