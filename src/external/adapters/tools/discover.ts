import { z } from 'zod';
import { decide } from '../../domain/decide.js';
import { bm25Ranking, type ToolRanking } from '../../domain/tool-search.js';
import { TOOL_ACCESS } from '../../domain/tools.js';
import type { ExternalToolDef } from '../mcp-tools.js';

/**
 * A client lists few tools and reaches the others by name: each listed tool's description goes into
 * its context, and most of Beluga is not needed in most chats. beluga_call hands over to the named
 * tool (mcp-tools.ts), so its class, card, audit record and limits are that tool's own.
 */

const FIND_DEFAULT = 8;
const FIND_MAX = 20;
const NAME_MAX = 100;
const QUERY_MAX = 200;

/** What a client lists: the tools given here, then find and call. `others` stay reachable through those two. */
export function withDiscovery(listed: readonly ExternalToolDef[], others: readonly ExternalToolDef[]): ExternalToolDef[] {
  const reachable = new Map([...listed, ...others].map((def) => [def.name as string, def]));
  const hidden = new Map(others.map((def) => [def.name as string, def]));
  let bm25: ToolRanking | undefined;
  // Made at the first search, a few milliseconds: a Beluga that no agent uses never builds it.
  const rank = async (query: string): Promise<readonly string[]> => (bm25 ??= bm25Ranking(others.map((def) => ({ name: def.name, description: def.description, inputSchema: schemaOf(def) }))))(query);
  return [
    ...listed,
    {
      name: 'beluga_find',
      description: 'Find a tool that is not in this list: tasks, plans, sentinels, git, pull requests, CI, files, terminals, the phone, friends, settings and more. It returns matches with their input schema. Call a match with beluga_call.',
      inputSchema: { query: z.string().min(1).max(QUERY_MAX).describe('Words to look for in tool names and descriptions.'), limit: z.number().int().min(1).max(FIND_MAX).optional() },
      resolve: () => ({ target: '', inScope: true }),
      run: async (args, grant) => {
        const hits = await rank(String(args.query));
        // The catalog only ranks: what the level denies goes here, before anything comes back.
        const allowed = hits.flatMap((id) => hidden.get(id) ?? []).filter((def) => decide({ operation: TOOL_ACCESS[def.name], level: grant.level, inScope: true }).outcome !== 'deny');
        return { tools: allowed.slice(0, (args.limit as number | undefined) ?? FIND_DEFAULT).map((def) => ({ name: def.name, description: def.description, inputSchema: schemaOf(def) })) };
      },
    },
    {
      name: 'beluga_call',
      description: 'Call a tool that beluga_find found, by its name. Its own rules apply: it may need a card from the owner. arguments must match its input schema.',
      inputSchema: { tool: z.string().min(1).max(NAME_MAX), arguments: z.record(z.string(), z.unknown()).optional() },
      resolve: () => ({ target: '', inScope: true }),
      run: () => {
        throw new Error('beluga_call hands over to the tool it names.');
      },
      handsOver: (args) => reachable.get(String(args.tool)),
    },
  ];
}

function schemaOf(def: ExternalToolDef): unknown {
  const { $schema: _schema, ...schema } = z.toJSONSchema(z.object(def.inputSchema), { io: 'input', unrepresentable: 'any' });
  return schema;
}
