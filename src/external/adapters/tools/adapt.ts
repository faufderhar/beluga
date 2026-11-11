import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import type { ToolSuite } from '../../../agent/tool-kit.js';
import type { Grant } from '../../domain/grant.js';
import type { ExternalTool } from '../../domain/tools.js';
import { type ExternalToolDef, type Resolved, ToolContent } from '../mcp-tools.js';
import { DATA_NOTICE, untrusted } from './read.js';

/** Tools your own agent has, as definitions an external agent can call. */

const RESULT_MAX = 60_000;

export type AnyDef = ToolSuite['tools'][number];
type Args = Record<string, unknown>;
export type Run = (def: AnyDef, args: Args, grant: Grant) => unknown;

export interface Adapted {
  readonly name: ExternalTool;
  readonly resolve: (args: Args, grant: Grant) => Resolved;
  /** Fields of the tool's input that an external agent must name, or may not use. */
  readonly shape?: z.ZodRawShape;
  readonly drop?: readonly string[];
  readonly extra?: string;
}

/** The chosen definitions, with their targets. A definition that isn't there is a failure at start, never a tool missing silently. */
export function adapt(defs: readonly AnyDef[], run: Run, adapted: readonly Adapted[]): ExternalToolDef[] {
  return adapted.map((a) => {
    const def = defs.find((d) => d.name === a.name);
    if (!def) throw new Error(`There is no tool ${a.name}.`);
    const inputSchema = Object.fromEntries(Object.entries({ ...def.inputSchema, ...a.shape }).filter(([field]) => !a.drop?.includes(field))) as z.ZodRawShape;
    return { name: a.name, description: def.description + (a.extra ?? ''), inputSchema, resolve: a.resolve, run: (args: Args, grant: Grant) => run(def, args, grant) };
  });
}

/** A tool's text as data: scrubbed, bounded, and marked as what people and agents wrote. A picture goes with it. */
export async function call(defs: readonly AnyDef[], name: string, args: Args): Promise<unknown> {
  const def = defs.find((d) => d.name === name);
  if (!def) throw new Error(`${name} is not available here.`);
  const result = await def.handler(args as never, undefined);
  const text = result.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n');
  if (result.isError) throw new Error(untrusted(text, RESULT_MAX).text);
  const data = { notice: DATA_NOTICE, result: untrusted(text, RESULT_MAX) };
  const pictures = result.content.filter((c) => c.type === 'image');
  return pictures.length ? new ToolContent([{ type: 'text', text: JSON.stringify(data) }, ...pictures]) : data;
}

/** Through links too: a link inside a project can point anywhere. */
export function isInside(file: string, dir: string): boolean {
  try {
    const relative = path.relative(realpathSync(dir), realpathSync(file));
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}
