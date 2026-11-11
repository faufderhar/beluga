import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type RunEnd, RunFailedError, classifyRun } from '../../../shared/run-failure.js';
import type { HttpServerConfig } from '../../tool-host.js';
import type { AcpHttpMcpServer, ConfigOption } from '../opencode/acp.js';
import { COPILOT_NOT_ALLOWED, COPILOT_SIGNED_OUT } from './status.js';

/** Claude's aliases and a Beluga default mean nothing to Copilot: those run on Copilot's own choice. */
const CLAUDE_ALIASES = /^(default|opus|sonnet|haiku|best|opusplan)(\[1m\])?$/i;

/** A model Copilot knows (`auto`, `gpt-5.3-codex`, `claude-haiku-4.5`), or undefined for its own (or Auto). */
export function copilotModel(model: string | undefined): string | undefined {
  if (!model || CLAUDE_ALIASES.test(model.trim()) || model.includes('[') || model.includes('/')) return undefined;
  return model.trim();
}

/** Beluga's tool suites as ACP's http MCP servers (Copilot turns a client's stdio servers down). */
export function httpServers(servers: Readonly<Record<string, HttpServerConfig>>): AcpHttpMcpServer[] {
  return Object.entries(servers).map(([name, s]) => ({ type: 'http', name, url: s.url, headers: Object.entries(s.headers).map(([k, value]) => ({ name: k, value })) }));
}

/** A session mode's value by its name (`plan`, `agent`): Copilot's are ACP's mode URIs (…/session-modes#plan). */
export function modeValue(options: readonly ConfigOption[], name: 'plan' | 'agent'): string | undefined {
  return options.find((o) => o.id === 'mode')?.options.find((o) => o.value === name || o.value.endsWith(`#${name}`))?.value;
}

/**
 * Beluga's instructions for a run, as one more of Copilot's instruction files: a folder of its own
 * named in COPILOT_CUSTOM_INSTRUCTIONS_DIRS (after yours), holding `beluga.instructions.md` for every
 * file (`applyTo: '**'`). Removed when the run ends.
 */
export function instructionsDir(text: string, env: Readonly<Record<string, string | undefined>>): { readonly env: Record<string, string>; readonly remove: () => void } {
  const dir = path.join(os.tmpdir(), `beluga-copilot-${randomUUID()}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, 'beluga.instructions.md'), `---\napplyTo: '**'\n---\n${text}\n`, { mode: 0o600 });
  const dirs = [env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS, dir].filter(Boolean).join(',');
  return { env: { COPILOT_CUSTOM_INSTRUCTIONS_DIRS: dirs }, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Copilot's words when your plan has run out (a limit, a quota, a 402/429). */
const COPILOT_LIMIT = /quota|rate.?limit|usage limit|exceeded|\b402\b|\b429\b/i;

/** The words for a run your plan won't serve: on Free, Copilot takes Auto only. */
export const notAllowedWords = (model: string | undefined): string =>
  `Your Copilot plan doesn’t include ${model && model !== 'auto' ? `the model ${model}` : 'this'}. Pick Auto in the model picker (Copilot Free takes only Auto), or check your plan at github.com/settings/copilot.`;

/** A failed Copilot run, told as Copilot's (not Claude Code's): a plan that won't serve it, a limit, a sign-in, or what it said. */
export function copilotFailure(end: RunEnd, model?: string): Error {
  const said = [end.error, end.result, ...(end.stderr ?? [])].filter(Boolean).join('\n');
  if (COPILOT_NOT_ALLOWED.test(said)) return new Error(notAllowedWords(model));
  if (COPILOT_LIMIT.test(said)) return new RunFailedError({ kind: 'usage_limit', detail: said.slice(0, 8000), runtime: 'copilot' });
  if (COPILOT_SIGNED_OUT.test(said)) return new RunFailedError({ kind: 'signed_out', detail: said.slice(0, 8000), runtime: 'copilot' });
  return new RunFailedError({ ...classifyRun(end), runtime: 'copilot' });
}
