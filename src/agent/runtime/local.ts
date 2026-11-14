import type { AgentBackend, AgentRunInput, FollowUp, Steer, TerminalSink } from '../types.js';
import { CLAUDE_CAPABILITIES, claudeRuntime } from './claude/index.js';
import { createClaudeBackend } from './claude/runner.js';
import { askBtw } from './claude/btw.js';
import { endpointClaudeHome, prepareEndpointHome, type EndpointHome } from './endpoint-home.js';
import { tokensPerSecond } from '../../shared/local-endpoints.js';
import type { AgentRuntime } from './types.js';
import type { BtwRequest } from '../btw.js';

const GONE = "That local model isn't set up on this Mac any more. Pick another in Settings › Local models.";

/** The endpoint a picked model value names (core/local-endpoints.ts resolves it). */
export interface LocalTarget {
  readonly label: string;
  readonly baseUrl: string;
  readonly key?: string;
  readonly model: string;
}

/**
 * The variables that point Claude Code at an endpoint and keep it off Anthropic (BLG-449): every
 * request goes to `baseUrl`, every model alias (and sub-agents, and the small fast model) is the
 * endpoint's model, and Claude Code's own traffic (telemetry, error reports, updates) stays off.
 * The key is the endpoint's, never your Claude login: without one, a placeholder (Ollama takes any),
 * so your Anthropic sign-in never goes to someone else's server. Claude Code runs in a folder of
 * its own (`configDir`, see endpoint-home.ts): signed in to Claude, it would send that sign-in
 * over any of these variables.
 */
export function endpointEnv(t: LocalTarget, configDir: string = endpointClaudeHome()): Record<string, string> {
  const m = t.model;
  return {
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: t.baseUrl,
    ANTHROPIC_AUTH_TOKEN: t.key || 'ollama',
    ANTHROPIC_API_KEY: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    CLAUDE_CODE_USE_BEDROCK: '',
    CLAUDE_CODE_USE_VERTEX: '',
    ANTHROPIC_MODEL: m,
    ANTHROPIC_DEFAULT_OPUS_MODEL: m,
    ANTHROPIC_DEFAULT_SONNET_MODEL: m,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: m,
    ANTHROPIC_SMALL_FAST_MODEL: m,
    CLAUDE_CODE_SUBAGENT_MODEL: m,
    // No `tool_reference`/`tool_definition` blocks: only Anthropic's API takes them. DeepSeek answered
    // 422 "unknown variant `tool_definition`". They come from inline tools: on Claude, MCP tools that
    // arrive mid-run go as a system message of `tool_addition` blocks, kept in the conversation, so a
    // run switched to an endpoint and resumed sends them again. Claude Code leaves inline tools on for
    // a model it doesn't know and falls back only on Anthropic's own wording of the refusal. Tool
    // search is already off on a non-Anthropic URL unless ENABLE_TOOL_SEARCH is set, and the daemon's
    // env may set it. On an endpoint, both are off: every tool goes up front, in `tools`.
    ENABLE_TOOL_SEARCH: 'false',
    CLAUDE_CODE_INLINE_TOOLS: 'false',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_BUG_COMMAND: '1',
  };
}

/**
 * A local or bring-your-own model: Claude Code, the same harness and tools, pointed at an
 * Anthropic-compatible endpoint (Ollama first) through the run's env. Not a new agent: config on
 * the Claude runtime. A run's model is "<endpoint id>/<model>"; `resolve` finds the endpoint.
 * Side calls (naming a worktree…) stay with your default agent (router.ts).
 */
export function localRuntime(resolve: (value: string | undefined) => LocalTarget | undefined): AgentRuntime {
  return {
    id: 'local',
    label: 'Local model',
    // Claude Code does the gating, so every guarantee holds; the endpoint lists its own models.
    capabilities: { ...CLAUDE_CAPABILITIES, hasModelList: false },
    create: ({ executablePath, ...opts }) => {
      // No plan limits on your own endpoint: nothing it says goes into Claude's quota (no fake quota bar).
      const bridge = Object.assign(Object.create(opts.bridge) as typeof opts.bridge, { reportUsage: () => undefined });
      const claudePath = executablePath ? { claudePath: executablePath } : {};
      // The model is told its own name, not Claude's (run-instructions.ts).
      const claude = createClaudeBackend({ ...opts, ...claudePath, bridge, model: undefined, agentOf: (input) => ({ runtime: 'local', label: input.model ?? 'Local model' }) });
      return Object.assign(Object.create(claude) as AgentBackend, {
        run: (input: AgentRunInput) => {
          const value = input.model ?? input.place?.agent?.model;
          const target = resolve(value);
          if (!target) return Promise.reject(new Error(GONE));
          return claude.run(onEndpoint(input, target, (v) => resolve(v)));
        },
        // Its terminal (BLG-534): Claude Code on the endpoint, as its runs are.
        terminal: (input: AgentRunInput, sink: TerminalSink) => {
          const target = resolve(input.model ?? input.place?.agent?.model);
          if (!target) return Promise.reject(new Error(GONE));
          return claude.terminal!(onEndpoint(input, target, (v) => resolve(v)), sink);
        },
        // A side question forks the conversation on its own endpoint: a local conversation never goes to Anthropic.
        btw: (req: BtwRequest) => {
          const target = resolve(req.model);
          if (!target) return Promise.reject(new Error(GONE));
          return askBtw({ ...req, model: target.model }, { ...claudePath, env: endpointEnv(target) });
        },
      });
    },
    complete: (req) => claudeRuntime.complete(req),
  };
}

/**
 * A local run's usage (BLG-450): free (Claude Code prices it as if Anthropic served it, so the cost
 * goes), and how fast the endpoint wrote: the turn's new output tokens over the time since it began.
 * The SDK reports running totals per conversation, so the new part is what grew since the last one.
 */
export function usageMeter(now: () => number = Date.now): { begin: () => void; map: (json: string) => string } {
  let since = now();
  let last: { session?: string; output: number } | undefined;
  return {
    begin: () => {
      since = now();
    },
    map: (json) => {
      try {
        const u = JSON.parse(json) as { output?: number; session?: string };
        const output = typeof u.output === 'number' ? u.output : 0;
        const grew = last && last.session === u.session && output >= last.output ? output - last.output : output;
        const tps = tokensPerSecond(grew, now() - since);
        last = { ...(u.session ? { session: u.session } : {}), output };
        since = now();
        return JSON.stringify({ ...u, cost: 0, free: true, ...(tps ? { tps } : {}) });
      } catch {
        return json;
      }
    },
  };
}

/**
 * The run, on the endpoint: its env over yours, its model's own name, no effort (endpoints don't take it), free usage with its speed.
 * What of your Claude Code folder didn't come along (endpoint-home.ts) is said on the run, never left to guess.
 */
export function onEndpoint(input: AgentRunInput, target: LocalTarget, resolve: (value: string | undefined) => LocalTarget | undefined, meter = usageMeter(), home: EndpointHome = prepareEndpointHome()): AgentRunInput {
  if (home.missed.length) input.onEvent('progress', missedWords(home.missed));
  const onEvent = (to: AgentRunInput['onEvent']): AgentRunInput['onEvent'] => (kind, text) => to(kind, kind === 'usage' ? meter.map(text) : text);
  // A model picked mid-run on the same endpoint switches; one elsewhere waits for the next run.
  const mapFollowUp = (f: FollowUp): FollowUp => {
    meter.begin();
    const withEvents = { ...f, onEvent: onEvent(f.onEvent) };
    if (f.model === undefined) return withEvents;
    const next = resolve(f.model);
    const { model: _m, ...rest } = withEvents;
    return next && next.baseUrl === target.baseUrl ? { ...rest, model: next.model } : rest;
  };
  const { effort: _e, ...rest } = input;
  return {
    ...rest,
    model: target.model,
    onEvent: onEvent(input.onEvent),
    env: { ...input.env, ...endpointEnv(target, home.dir) },
    ...(input.onFollowUps ? { onFollowUps: (send) => input.onFollowUps!(send && ((f) => send(mapFollowUp(f)))) } : {}),
    ...(input.onSteer ? { onSteer: (steer) => input.onSteer!(steer && wrapSteer(steer, mapFollowUp)) } : {}),
  };
}

/** What the run says when part of your Claude Code folder couldn't come along to the endpoint. */
export function missedWords(missed: readonly string[]): string {
  return `This local model runs without some of your Claude Code setup (${missed.join(', ')}): it couldn't be brought along.`;
}

function wrapSteer(steer: Steer, map: (f: FollowUp) => FollowUp): Steer {
  return Object.assign((f: FollowUp) => steer(map(f)), {
    ...(steer.status ? { status: steer.status } : {}),
    ...(steer.interrupt ? { interrupt: (f: FollowUp, note: string) => steer.interrupt!(map(f), note) } : {}),
    ...(steer.force ? { force: (f: FollowUp, note: string) => steer.force!(map(f), note) } : {}),
  });
}
