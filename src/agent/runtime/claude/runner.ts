import { readFileSync } from 'node:fs';
import path from 'node:path';
import { query, type Options, type Query } from '@anthropic-ai/claude-agent-sdk';
import { MAX_ATTACHMENT_BYTES, linkedImages, mediaTypeOf, withImagePaths } from '../../../core/attachments.js';
import { buildPrompt, summarizeTool } from '../../prompt.js';
import { runInstructions } from '../../run-instructions.js';
import { SECRET_DECLINED, confineSearch, decideTool, denyReason, isYourRun } from '../../policy.js';
import { baseEnv } from '../../../core/peer-run.js';
import { gateTool } from '../../tool-gate.js';
import { syncProbes } from '../../sync-main.js';
import { fromRateLimitEvent, fromUsageResponse, toMs } from './usage.js';
import { type RunEnd, type RunFailure, RunFailedError, classifyRun } from '../../../shared/run-failure.js';
import { SubAgentTracker, withAgentScratch } from './subagents.js';
import { type RecorderMessage, StepRecorder } from '../../step-recorder.js';
import { type TrackedMessage, McpAppTracker } from '../../../mcp-apps/tracker.js';
import { type ContextMessage, ContextReport, breakdownReader, isCompactCommand } from '../../context-report.js';
import { compactEnv } from '../../../shared/context-usage.js';
import { claudeShellSetup, zshCompatEnv } from './zsh-compat.js';
import { progressCount } from '../../../shared/progress-count.js';
import { resultText } from '../../../shared/steps.js';
import { BackgroundAgents, type PromptContent, PromptQueue, TurnRouter, startedPrompt } from './live-run.js';
import { sideCalls } from '../../side-calls.js';
import { claudeComplete } from './complete.js';
import { askBtw } from './btw.js';
import { claudeTerminal } from './terminal.js';
import { claudeLaunch } from './launch-args.js';
import { chromeGate, isChromeTool } from '../../chrome.js';
import { ViewShelf } from '../../view-tools.js';
import { runToolSuites } from '../../run-tools.js';
import { sdkServers } from './sdk-mount.js';
import { ownerMcpServers } from './owner-mcp.js';
import { McpConnect, claudeMcpSession } from './mcp-connect.js';
import type { AgentBackend, AgentRunInput, FollowUp, LiveStatus, RoomBridge, RunProcess, Steer } from '../../types.js';
import { keepLines, trackedSpawn } from './claude-process.js';
import { keptBashInput } from '../../../workspaces/test-procs.js';
import { SCRATCH_DIR } from '../../../shared/scratch-dir.js';
import { type AgentRef, CLAUDE_AGENT, type ClaudeAnswer, ClaudeQuestion, type Usage } from '../../../protocol.js';
import { claudeCodeReady, claudeExecutable } from '../../claude-code.js';
import { claudeHome } from '../../../core/claude-code/launch.js';
import { belugaHome } from '../../../core/home.js';
import { expandCommand, mayBeCommand, skillOptions } from './skill-plugins.js';
import { BACKGROUND_LIMIT_MS, INTERRUPT_TIMEOUT_MS } from '../types.js';

const USAGE_TIMEOUT_MS = 20_000;

/**
 * A friend's or a guest's Claude run must not inherit the daemon's environment (API tokens,
 * cloud credentials). Your own runs do, and so does a dialogue or a compaction: those have no
 * friend marker. A guest never does, even if another flag is set.
 */
export function inheritsDaemonEnv(input: Pick<AgentRunInput, 'guest' | 'ownerMcp' | 'dialogue' | 'vetTool' | 'viaAgent' | 'channel'>): boolean {
  if (input.guest) return false;
  if (input.ownerMcp || input.dialogue) return true;
  if (input.vetTool || input.viaAgent || input.channel) return false;
  return true;
}

/** Env names that carry a credential. Matched on the name, never the value. */
const SECRET_ENV = /PASSWORD|PASSWD|SECRET|PRIVATE_KEY|SERVICE_ROLE_KEY|API_KEY|TOKEN|CREDENTIAL|_KEY/i;

/** What a friend's shell is given, on top of baseEnv (see core/peer-run.ts). */
const SCRUBBED_SHELL = { CI: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1', TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat' };

/**
 * Claude Code's own settings the owner may keep in the environment: where its config lives, which
 * endpoint or cloud it talks to, how it gets through a proxy. None is a credential, so a friend's run
 * keeps them and can still start. A proxy address with a password in it (user:pass@host) stays out,
 * and so do the keys and tokens (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN): a friend's run signs in
 * the way Claude Code does without them.
 */
const CLAUDE_CONFIG_ENV = ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION', 'AWS_REGION', 'CLAUDE_CODE_GIT_BASH_PATH', 'NODE_EXTRA_CA_CERTS', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];
const claudeConfigEnv = (env: NodeJS.ProcessEnv): Record<string, string> =>
  Object.fromEntries(CLAUDE_CONFIG_ENV.flatMap((name) => {
    const value = env[name];
    return value && !/:\/\/[^/\s]*@/.test(value) ? [[name, value]] : [];
  }));

const safeRunEnv = (extra: Readonly<Record<string, string>> | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries(extra ?? {}).filter(([name]) => name && !SECRET_ENV.test(name)));

/**
 * The environment Claude Code is launched with. Undefined: don't set one, so your own run (or a
 * compaction) inherits the daemon's. A friend or a guest always gets an explicit scrubbed one,
 * plus the non-secret variables the run already adds (a worktree tag, the compact threshold).
 */
export function claudeLaunchEnv(input: Pick<AgentRunInput, 'guest' | 'ownerMcp' | 'dialogue' | 'vetTool' | 'viaAgent' | 'channel' | 'env' | 'autoCompactAt'>, env: NodeJS.ProcessEnv = process.env): Record<string, string> | undefined {
  const compact = compactEnv(Boolean(input.autoCompactAt), input.autoCompactAt ?? 0);
  if (inheritsDaemonEnv(input)) {
    if ((input.env && Object.keys(input.env).length) || input.autoCompactAt) return { ...env, ...input.env, ...compact } as Record<string, string>;
    return undefined;
  }
  return { ...baseEnv(env), ...claudeConfigEnv(env), ...SCRUBBED_SHELL, ...compact, ...safeRunEnv(input.env) };
}

/**
 * The launch environment with zsh-compat.sh's CLAUDE_ENV_FILE in (zsh-compat.ts): on top of the
 * scrubbed one a friend's run gets, or of the daemon's own when the run inherits it. Nothing to add
 * (Windows, or your own CLAUDE_ENV_FILE): the launch environment as it was.
 */
export function withZshCompat(launchEnv: Readonly<Record<string, string>> | undefined, compat: Readonly<Record<string, string>>, env: NodeJS.ProcessEnv = process.env): Record<string, string> | undefined {
  if (!Object.keys(compat).length) return launchEnv;
  return { ...(launchEnv ?? env), ...compat } as Record<string, string>;
}

/**
 * How Claude Code signs in from the environment alone: a friend's or guest's scrubbed run gets none
 * of these, so it signs in only the way Claude Code does without them (its own login on this Mac).
 */
const ENV_SIGN_IN = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_PROFILE', 'GOOGLE_APPLICATION_CREDENTIALS'];
/** Claude's own words when its sign-in didn't work (beyond a plain "Not logged in"). */
const SIGN_IN_FAILED = /authenticat|credential|api key|x-api-key|unauthori[sz]ed|\b401\b|\/login/i;

/**
 * A failure that is the scrubbed environment's doing says so: the owner signs Claude Code in with a
 * variable (ANTHROPIC_API_KEY) that a friend's run isn't given, so "isn't signed in on this Mac"
 * would be wrong (their own runs work).
 */
export function withSignInHint(failure: RunFailure, launchEnv: Readonly<Record<string, string>> | undefined, inherits: boolean, env: NodeJS.ProcessEnv = process.env): RunFailure {
  if (inherits || !launchEnv) return failure;
  if (failure.kind !== 'signed_out' && !(failure.kind === 'api' && SIGN_IN_FAILED.test(failure.detail))) return failure;
  const dropped = ENV_SIGN_IN.find((name) => env[name] && !launchEnv[name]);
  return dropped ? { ...failure, envSignIn: dropped } : failure;
}

/**
 * How long a run stays open after answering for a command or watch the main conversation left
 * running (no agents): long enough for the full tests or a build to end and wake Claude, short
 * enough that a server it left up doesn't hold the run for hours.
 */
const SHELL_LIMIT_MS = 45 * 60_000;
/**
 * Agents all done and Claude between turns for this long: end the run. Claude normally reports
 * on finished agents (and the run ends after that answer); this covers it not doing so. Not
 * instant, because an agent can resume right after its shell finishes.
 */
const QUIET_MS = 15_000;
/** Claude Code's last stderr lines kept for a failed run's details. */
const STDERR_KEEP = 40;

/**
 * Which settings files a run loads. Your own runs get your Claude Code as you set it up: your
 * user settings (~/.claude/settings.json: hooks, permission rules, plugins) and your skills and
 * commands. A project's .claude/ settings are never loaded, for anyone: it sits in the folder a
 * friend with :rw access may write to, so they could plant hooks or permission rules there (its
 * skills and commands come in alone, see skill-plugins.ts). A friend's or a guest's run loads nothing of yours.
 */
export function ownerSettings(input: Pick<AgentRunInput, 'ownerMcp' | 'guest'>): { settingSources: Array<'user'>; skills?: 'all' } {
  return input.ownerMcp && !input.guest ? { settingSources: ['user'], skills: 'all' } : { settingSources: [] };
}

/** MCP Apps follow your MCP servers: a run that loads them (yours, or Full trust; never a guest's) keeps apps on its steps. */
export function tracksMcpApps(input: Pick<AgentRunInput, 'ownerMcp' | 'guest'>): boolean {
  return Boolean(input.ownerMcp && !input.guest);
}

export interface ClaudeBackendOptions {
  readonly cwd: string;
  /** Let the agent edit files in cwd without asking (share was marked :rw). */
  readonly autoEdit: boolean;
  readonly additionalDirectories: readonly string[];
  readonly bridge: RoomBridge;
  readonly model?: string;
  readonly claudePath?: string;
  /** Who the agent is told it is, when not the place's agent (a local model: its own name). */
  readonly agentOf?: (input: AgentRunInput) => AgentRef | undefined;
  /** Your MCP servers' sign-in (a fake one in tests); by default Claude Code's own. */
  readonly mcp?: McpConnect;
  /** Your saved variables for Settings' MCP check in a folder (RuntimeOptions.ownEnv). */
  readonly ownEnv?: (cwd: string) => Readonly<Record<string, string>>;
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
/** Tools that talk to the person instead of touching anything: answered through askUser, not approvals. */
const INTERACTIVE = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** Claude's AskUserQuestion input → our question card (unknown shapes are dropped safely). */
/** Claude Code retrying the API, in a few words for the working line (40 characters at most). */
export function retryWords(status: number | null, attempt: number, max: number, noResponse = false): string {
  const why = noResponse || status === null ? 'No answer from Claude' : status === 429 ? 'Rate limited' : status >= 500 ? 'Claude is busy' : `API error ${status}`;
  return `${why}, retry ${attempt} of ${max}`;
}

export function toQuestion(input: Record<string, unknown>): ClaudeQuestion | undefined {
  const parsed = ClaudeQuestion.safeParse({ kind: 'question', questions: input.questions });
  return parsed.success ? parsed.data : undefined;
}

/** Tokens and cost of a run, summed over every model it used (sub-agents included). */
export function usageOf(modelUsage: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>, cost: number, session: string) {
  const all = Object.values(modelUsage);
  const sum = (pick: (u: (typeof all)[number]) => number): number => all.reduce((n, u) => n + (pick(u) || 0), 0);
  return { input: sum((u) => u.inputTokens), output: sum((u) => u.outputTokens), cacheRead: sum((u) => u.cacheReadInputTokens), cacheWrite: sum((u) => u.cacheCreationInputTokens), cost, session };
}

/** Claude Code's name for a model, without its "(recommended)": the picker says "Default", not "Default (recommended)". */
const plainModelName = (name: string): string => name.replace(/\s*\(recommended\)\s*$/i, '') || name;

/** Friendly rows for the model picker from Claude Code's own list. */
export function toModelChoices(models: ReadonlyArray<{ value: string; displayName: string; description: string; supportedEffortLevels?: readonly string[] }>) {
  return models.map((m) => ({ value: m.value === 'default' ? '' : m.value, label: plainModelName(m.displayName), description: m.description, ...(m.supportedEffortLevels ? { efforts: m.supportedEffortLevels } : {}) }));
}

/**
 * A prompt with images pasted into it: the text and each image as content blocks, so Claude
 * actually sees them. Without images, the plain text.
 */
export function imageContent(text: string, files: readonly string[]): PromptContent {
  const images = files.flatMap((file) => {
    try {
      const data = readFileSync(file);
      return data.length <= MAX_ATTACHMENT_BYTES ? [{ type: 'image' as const, source: { type: 'base64' as const, media_type: mediaTypeOf(file), data: data.toString('base64') } }] : [];
    } catch {
      return [];
    }
  });
  if (!images.length) return text;
  const note = `\n\n(${images.length === 1 ? 'The image linked above is' : 'The images linked above are'} attached to this message, in order.)`;
  return [{ type: 'text', text: text + note }, ...images];
}

/** The text of the tool results in a message from Claude Code (what its commands printed). */
function toolOutput(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && typeof b === 'object' && 'type' in b && b.type === 'tool_result' && 'content' in b ? resultText(b.content) : '')).join('\n');
}

/**
 * Ask Claude Code to send Claude's thinking as readable summaries (current models send it empty
 * unless asked), so screens can show it. Only the display changes: how much Claude thinks stays
 * the session's own. Older Claude Code without this control just ignores it.
 */
function showThinking(q: unknown): void {
  const set = (q as { setMaxThinkingTokens?: (max: number | null, display?: 'summarized') => Promise<void> }).setMaxThinkingTokens;
  if (typeof set !== 'function') return;
  try {
    void set.call(q, null, 'summarized').catch(() => undefined);
  } catch {
    // Not supported here: thinking shows as hidden.
  }
}

/**
 * A sign-in just connected `name`: ask this running Claude Code to load it now, so its tools are there
 * in this turn. If it can't (an older Claude Code, a query already ending), the next turn loads it.
 */
function reconnect(q: Query, name: string): void {
  const again = (q as { reconnectMcpServer?: (name: string) => Promise<void> }).reconnectMcpServer;
  if (typeof again !== 'function') return;
  try {
    void again.call(q, name).catch(() => undefined);
  } catch {
    // Not supported here: the next turn loads the server.
  }
}

/**
 * Runs turns through the Claude Agent SDK, which drives the local Claude Code
 * install and therefore uses the owner's own login/subscription. One session
 * is kept per room so the agent remembers the conversation.
 */
export function createClaudeBackend(opts: ClaudeBackendOptions): AgentBackend {
  let sessionId: string | undefined;
  // Settings' MCP list reads your saved variables as your runs do (#442).
  const mcp = opts.mcp ?? new McpConnect(claudeMcpSession(opts.claudePath), opts.ownEnv ? { ownEnv: opts.ownEnv } : {});
  // Every Claude Code query running now with your servers: a sign-in that connects reaches each of them.
  const live = new Set<Query>();
  mcp.onSignedIn((name) => {
    for (const q of live) reconnect(q, name);
  });

  return {
    async run(input: AgentRunInput): Promise<string> {
      // The Mac app downloads Claude Code on first launch (BLG-384): a run that comes first waits for it.
      await claudeCodeReady(({ got, total }) => input.onEvent('progress', `Getting Claude Code ready, one time: ${total ? `${Math.round((got / total) * 100)}%` : `${Math.round(got / 1e6)} MB`}`)).catch((err: unknown) => {
        throw new Error(`Couldn’t get Claude Code ready (${err instanceof Error ? err.message : String(err)}). Send your message again to try once more.`);
      });
      const abortController = new AbortController();
      // Several conversations run at once: this run's room tools post to its own.
      const bridge = input.channel && opts.bridge.inChannel ? opts.bridge.inChannel(input.channel) : opts.bridge;
      // Stopped while Claude Code was getting ready: an aborted signal never fires again (BLG-402).
      if (input.signal.aborted) throw new Error('aborted');
      input.signal.addEventListener('abort', () => abortController.abort(), { once: true });
      // A workspace brings its own folder and conversation; otherwise use the room's.
      const place = input.place;
      const cwd = place?.cwd ?? opts.cwd;
      const extraDirs = place ? place.additionalDirectories : opts.additionalDirectories;
      // A project's main folder is questions only: nothing there changes (see policy.ts).
      const askOnly = place?.askOnly;
      const autoEdit = !askOnly && (place?.autoEdit ?? opts.autoEdit);
      const remember = (id: string): void => (place ? place.onSession(id) : void (sessionId = id));
      const subagents = new SubAgentTracker(cwd);
      // Views Claude shows (mcp__beluga_view__show) go into its answers where it puts their tokens.
      const shelf = new ViewShelf();
      const scratchRoot = input.scratchDir ? path.resolve(cwd, input.scratchDir) : undefined;
      const syncMain = askOnly ? place?.syncMain : undefined;
      // A hidden worktree to fix a conflict in (a plan's head Claude, in its main-folder conversation).
      const fixup = place?.fixup;
      const policy = { cwd, roots: [cwd, ...extraDirs, ...(fixup ? [fixup] : [])], autoEdit, scope: input.scope, guest: input.guest, boardAsks: input.boardAsks, dotenv: Boolean(input.canUseSecret) && !input.guest, yourRun: isYourRun(input), askOnly: Boolean(askOnly), ...(syncMain ? { syncMain: syncProbes(cwd, syncMain) } : {}), ...(fixup ? { fixup } : {}), ...(place?.alsoEdit?.length ? { alsoEdit: place.alsoEdit } : {}) };
      // How the run ends, when it fails: Claude Code's stderr, a limit that said no, an API error.
      const stderr: string[] = [];
      const keepStderr = (data: string): void => keepLines(stderr, data, STDERR_KEEP);
      // Claude Code's process, so a run that won't end can be told dead and killed (see AgentRunInput.onProcess).
      // The SDK reads no stderr from a process we spawn: ours feeds the same lines a crash is told by.
      let proc: RunProcess | undefined;
      const tracked = input.onProcess
        ? trackedSpawn((p) => {
            proc = p;
            input.onProcess?.(p);
          }, keepStderr)
        : undefined;
      const verdict = (permissionDecision: 'allow' | 'deny', reason: string) => ({
        hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision, permissionDecisionReason: reason },
      });
      let rejectedUntil: number | undefined;
      let apiError: string | undefined;
      let failedResult: string | undefined;
      // Your own runs get your skills and custom commands (never a friend's or a guest's: see skill-plugins.ts).
      const own = Boolean(input.ownerMcp && !input.guest);
      const home = claudeHome();
      const skills = await skillOptions(own, cwd, home, path.join(belugaHome(), 'claude-plugins'));
      /** A message as Claude gets it: a custom command (`/fruit apples`) filled in first, on your own runs. */
      const content = (msg: Pick<FollowUp, 'prompt' | 'requesterName' | 'viaAgent' | 'context'>): PromptContent | Promise<PromptContent> => {
        const build = (prompt: string): PromptContent => imageContent(buildPrompt({ ...msg, prompt }), linkedImages(msg.prompt));
        return own && mayBeCommand(msg.prompt) ? expandCommand(msg.prompt, cwd, home).then(build) : build(msg.prompt);
      };
      // Your `claude` flags (Settings › Agents): how it asks, in the SDK's words; the rest as they are.
      const launch = claudeLaunch(input.launchArgs?.claude ?? [], { plan: Boolean(input.plan), autoEdit, chrome: Boolean(input.chrome) });
      // Claude in Chrome: as usual on a run you typed; any other asks you once before it first uses it (agent/chrome.ts).
      const chrome = chromeGate(input.chrome);
      // Set, this replaces Claude Code's whole environment. A friend or a guest gets a scrubbed one
      // (never the daemon's tokens); your own run inherits unless it already passes variables.
      // zsh-compat.sh makes Claude Code's zsh take the bash it writes (zsh-compat.ts); the prompt says what's left.
      const baseLaunchEnv = claudeLaunchEnv(input);
      const compat = zshCompatEnv(baseLaunchEnv ?? process.env);
      const launchEnv = withZshCompat(baseLaunchEnv, compat);
      const failure = (end: RunEnd): RunFailedError => new RunFailedError(withSignInHint(classifyRun(end), launchEnv, inheritsDaemonEnv(input)));
      const options: Options = {
        cwd,
        additionalDirectories: [...extraDirs, ...(fixup ? [fixup] : [])],
        resume: place ? place.resume : sessionId,
        ...(place?.forkSession && place.resume ? { forkSession: true } : {}),
        abortController,
        ...(input.maxTurns ? { maxTurns: input.maxTurns } : {}),
        permissionMode: launch.permissionMode,
        ...(launch.allowDangerouslySkipPermissions ? { allowDangerouslySkipPermissions: true } : {}),
        ...(Object.keys(launch.extraArgs).length ? { extraArgs: launch.extraArgs } : {}),
        // Your own MCP servers first, so a name of Beluga's always means Beluga's.
        mcpServers: { ...(input.ownerMcp && !input.guest ? ownerMcpServers(cwd, { ...process.env, ...input.env }) : {}), ...sdkServers(runToolSuites(input, bridge, shelf, cwd)) },
        // The hook runs before Claude Code's own permission logic, even for commands it would
        // auto-approve, so the machine owner stays in control of every risky action.
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async (hookInput) => {
                  if (hookInput.hook_event_name !== 'PreToolUse') return {};
                  if (INTERACTIVE.has(hookInput.tool_name)) return {}; // answered in canUseTool
                  const toolInput = (hookInput.tool_input ?? {}) as Record<string, unknown>;
                  const veto = input.vetTool?.(hookInput.tool_name, toolInput);
                  if (veto) return verdict('deny', veto);
                  if (isChromeTool(hookInput.tool_name)) {
                    const said = await chrome(hookInput.tool_name, toolInput);
                    if (said.kind === 'deny') return verdict('deny', said.reason);
                    if (said.kind === 'allow') return verdict('allow', 'Approved by the machine owner.');
                  }
                  // A directory search is narrowed so it never opens a credential file, then judged on that.
                  const confined = confineSearch(hookInput.tool_name, toolInput, policy);
                  const judged = confined ?? toolInput;
                  const decision = decideTool(hookInput.tool_name, judged, policy);
                  if (decision === 'deny') return verdict('deny', denyReason(hookInput.tool_name, judged, policy));
                  // A sub-agent is told where its own scratch folder is, so what it makes shows on its page.
                  const scratched = scratchRoot ? withAgentScratch(hookInput.tool_name, judged, hookInput.tool_use_id, scratchRoot) : undefined;
                  // In a worktree, what's kept on purpose is made to outlive the turn (see workspaces/test-procs.ts).
                  const keptLog = path.join(cwd, SCRATCH_DIR, `kept-${hookInput.tool_use_id.slice(-8)}.log`);
                  const kept = input.env?.KLAUD_WORKTREE ? keptBashInput(hookInput.tool_name, scratched ?? judged, keptLog, compat.CLAUDE_ENV_FILE) : undefined;
                  const patched = kept ?? scratched ?? confined;
                  const allow = (reason: string) => (patched ? { hookSpecificOutput: { ...verdict('allow', reason).hookSpecificOutput, updatedInput: patched } } : verdict('allow', reason));
                  if (decision === 'allow' && !input.asksFirst?.(hookInput.tool_name)) return patched ? allow('Allowed by Beluga.') : {};
                  if (decision === 'secret') return (await input.canUseSecret?.(hookInput.tool_name, toolInput)) ? allow('Approved by the machine owner.') : verdict('deny', SECRET_DECLINED);
                  return (await input.canUseTool(hookInput.tool_name, toolInput)) ? allow('Approved by the machine owner.') : verdict('deny', 'The machine owner declined this action.');
                },
              ],
            },
          ],
          // The summary Claude keeps when it compacts, for the divider in the chat.
          PostCompact: [
            {
              hooks: [
                async (hookInput) => {
                  if (hookInput.hook_event_name === 'PostCompact') report.summary(hookInput.compact_summary);
                  return {};
                },
              ],
            },
          ],
        },
        systemPrompt: { type: 'preset', preset: 'claude_code', append: runInstructions(input, opts.bridge.selfName(), opts.agentOf?.(input) ?? input.place?.agent, claudeShellSetup(baseLaunchEnv ?? process.env, compat)) },
        ...ownerSettings(input),
        ...skills,
        ...((input.model ?? opts.model) ? { model: input.model ?? opts.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        // Claude Code's own auto-compact follows Beluga's threshold (see shared/context-usage.ts), and zsh-compat.sh.
        ...(launchEnv ? { env: launchEnv } : {}),
        ...claudeExecutable(opts.claudePath),
        // Its last words, so a crash says why (see shared/run-failure.ts): read by our own spawn when there is one.
        ...(tracked ? { spawnClaudeCodeProcess: tracked.spawn } : { stderr: keepStderr }),
        canUseTool: async (toolName, toolInput) => {
          if (toolName === 'AskUserQuestion') return answerQuestion(toolInput);
          if (toolName === 'ExitPlanMode') return reviewPlan(toolInput);
          // The same gate the stdio tool server asks (agent/tool-gate.ts). A directory search is narrowed first.
          const confined = confineSearch(toolName, toolInput, policy);
          const judged = confined ?? toolInput;
          const denied = await gateTool(toolName, judged, input, policy);
          return denied ? { behavior: 'deny', message: denied } : { behavior: 'allow', updatedInput: judged };
        },
      };

      let lastText = '';
      const ask = async (question: ClaudeQuestion): Promise<ClaudeAnswer> => (input.askUser ? input.askUser(question) : { kind: 'skip' });
      const answerQuestion = async (toolInput: Record<string, unknown>) => {
        const question = toQuestion(toolInput);
        const answer = question ? await ask(question) : ({ kind: 'skip' } as const);
        if (answer.kind === 'answers') return { behavior: 'allow' as const, updatedInput: { ...toolInput, answers: Object.fromEntries(Object.entries(answer.answers).map(([q, a]) => [q, withImagePaths(a)])) } };
        return { behavior: 'deny' as const, message: 'The user skipped this question. Continue with your best judgment and say what you assumed.' };
      };
      let askedToDefine = false;
      const reviewPlan = async (toolInput: Record<string, unknown>) => {
        // The plan is for a task: Claude defines it (in its own words) before the plan comes to you. Asked once.
        if (input.planTask?.needsDefinition() && !askedToDefine) {
          askedToDefine = true;
          return { behavior: 'deny' as const, message: 'Before asking for approval, call mcp__beluga_board__task_define with the task this plan is for (title, goal in your own words, context, acceptance criteria, decisions, open questions, estimate, priority). Then call ExitPlanMode again.' };
        }
        const plan = typeof toolInput.plan === 'string' && toolInput.plan.trim() ? toolInput.plan : lastText || '(Claude proposed a plan)';
        const answer = await ask({ kind: 'plan', plan: plan.slice(0, 60_000) });
        if (answer.kind === 'plan' && answer.approve) {
          input.planTask?.approved();
          // Approved: leave plan mode so Claude can do the work.
          await q.setPermissionMode(claudeLaunch(input.launchArgs?.claude ?? [], { plan: false, autoEdit }).permissionMode).catch(() => undefined);
          return { behavior: 'allow' as const, updatedInput: toolInput };
        }
        const feedback = answer.kind === 'plan' && answer.feedback ? `The user wants changes to the plan: ${withImagePaths(answer.feedback)}` : 'The user did not approve the plan yet. Ask what they would like to change.';
        return { behavior: 'deny' as const, message: feedback };
      };

      // The context meter, live: what Claude saw on each response, compactions and their summaries.
      const report = new ContextReport((kind, text) => input.onEvent(kind, text), input.model ?? opts.model);
      // Streaming input keeps Claude Code alive after it answers while background agents still
      // work: a one-shot prompt would cut them off 10 minutes later, rejecting their next step.
      const prompts = new PromptQueue();
      prompts.push(isCompactCommand(input.prompt) ? input.prompt.trim() : content(input), { uuid: input.promptId });
      const background = new BackgroundAgents();
      const turns = new TurnRouter({ onEvent: input.onEvent, ...(input.onStep ? { onStep: input.onStep } : {}), ...(input.onAnswered ? { onDone: input.onAnswered } : {}) });
      // Steps in detail go to the request whose turn it is (a follow-up's turn: the follow-up).
      let stepTo = input.onStep;
      // MCP Apps: a UI tool's step carries its app (when this Claude Code can host them); the tools' _meta comes from this session.
      const apps = tracksMcpApps(input) ? new McpAppTracker({ servers: () => q.mcpServerStatus() }, (record) => stepTo?.(record)) : undefined;
      const recorder = new StepRecorder({ cwd, emit: (record) => stepTo?.(apps ? apps.decorate(record) : record) });
      recorder.begin();
      let limit: NodeJS.Timeout | undefined;
      let quiet: NodeJS.Timeout | undefined;
      const finish = (): void => {
        if (prompts.closed) return;
        clearTimeout(limit);
        clearTimeout(quiet);
        if (limit) input.onFollowUps?.(undefined); // only if follow-ups were offered
        input.onSteer?.(undefined);
        turns.failPending('Claude finished before getting to this message');
        prompts.close();
      };
      /** The model the session runs on, so a message picked for another one switches it first. */
      let model = input.model ?? opts.model;
      /** A message into the live session. `steer`: Claude works on a turn, and takes it in at its next step. */
      const deliver = (followUp: FollowUp, steer: boolean): string | false => {
        if (prompts.closed) return false;
        // Another model was picked for the conversation meanwhile: Claude Code switches before the
        // message reaches it (the control request goes down the same pipe, ahead of the prompt).
        if (followUp.model !== undefined && (followUp.model || undefined) !== model) {
          model = followUp.model || undefined;
          void q.setModel(model).catch(() => undefined);
          report.switched(model);
        }
        // Between turns it starts one now: thinking before its first step counts from here.
        if (turns.between) recorder.begin();
        const uuid = prompts.push(content(followUp), { steer: steer && !turns.between, uuid: followUp.promptId });
        if (uuid === false) return false;
        turns.queue(followUp, uuid, steer && !turns.between);
        return uuid;
      };
      const send = (followUp: FollowUp): boolean => deliver(followUp, false) !== false;
      // What Claude is doing now, for a steer to judge whether it reads a message soon (see Steer.status).
      const tools = new Map<string, { label: string; since: number }>();
      /** Sub-agents launched this step and not back yet (not in `tools`: they show as sub-agents, not steps). */
      const launches = new Set<string>();
      let lastEventAt = Date.now();
      /** Claude's last word in the main conversation was thinking. */
      let thinking = false;
      const status = (): LiveStatus => {
        const tool = [...tools.values()].sort((a, b) => a.since - b.since)[0];
        return { ...(tool ? { tool } : {}), lastEventAt, between: turns.between, ...(thinking ? { thinking } : {}), ...(proc ? { alive: proc.alive() } : {}) };
      };
      /** Set while a turn is being interrupted: what that turn ends with, and the run stays open for the next. */
      let interrupting: string | undefined;
      /** The message an interrupt is for: its own turn, never folded into the interrupted one. */
      let interruptFor: string | undefined;
      /** After an answer: end the run, or keep it open (taking follow-ups) while agents work. */
      const settle = (): void => {
        if (interrupting === undefined && !background.busy && !turns.waiting) return finish();
        if (limit) return;
        limit = setTimeout(finish, background.agents || interrupting !== undefined || turns.waiting ? BACKGROUND_LIMIT_MS : SHELL_LIMIT_MS);
        limit.unref();
        input.onFollowUps?.(send);
      };
      const done = (): boolean => turns.between && !background.busy && !turns.waiting;
      const watchQuiet = (): void => {
        clearTimeout(quiet);
        if (!limit || !done()) return;
        quiet = setTimeout(() => done() && finish(), QUIET_MS);
        quiet.unref();
      };
      abortController.signal.addEventListener('abort', finish, { once: true });
      /** Stop the running tool and turn, then answer `followUp` in the next turn (see Steer.interrupt). */
      const interrupt = async (followUp: FollowUp, note: string): Promise<boolean> => {
        if (prompts.closed || turns.between || interrupting !== undefined) return false;
        interrupting = note;
        try {
          let timer: NodeJS.Timeout | undefined;
          const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('interrupt timed out')), INTERRUPT_TIMEOUT_MS)));
          await Promise.race([q.interrupt(), late]).finally(() => clearTimeout(timer));
        } catch {
          interrupting = undefined;
          if (turns.between) settle();
          return false;
        }
        const sent = deliver(followUp, false);
        // The interrupted turn may have ended already (its result kept the run open for this).
        if (turns.between) interrupting = undefined;
        else if (sent) interruptFor = sent;
        if (!sent) settle();
        return sent !== false;
      };
      /** Messages steered into a running turn, by the prompt id they went in with (see force). */
      const steered = new WeakMap<FollowUp, string>();
      /** The message Send now stops the turn for: never taken as answered by the turn it stopped. */
      let forced: { uuid: string; followUp: FollowUp } | undefined;
      const steerIn = (followUp: FollowUp): boolean => {
        const between = turns.between;
        const uuid = deliver(followUp, true);
        if (uuid !== false && !between) steered.set(followUp, uuid);
        return uuid !== false;
      };
      /**
       * Send now (see Steer.force): the message is in Claude Code's queue already; a plain interrupt
       * keeps it there (its still_queued), so it runs as the next turn, its own (unless the
       * interrupted turn's result says it took it in after all).
       */
      const force = async (followUp: FollowUp, note: string): Promise<boolean> => {
        const uuid = steered.get(followUp);
        if (!uuid || prompts.closed || turns.between || interrupting !== undefined || !turns.unsteer(uuid)) return false;
        interrupting = note;
        forced = { uuid, followUp };
        try {
          let timer: NodeJS.Timeout | undefined;
          const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('interrupt timed out')), INTERRUPT_TIMEOUT_MS)));
          await Promise.race([q.interrupt(), late]).finally(() => clearTimeout(timer));
        } catch {
          interrupting = undefined;
          forced = undefined;
          turns.resteer(uuid);
          if (turns.between) settle();
          return false;
        }
        // The interrupted turn ended already (its result kept the run open: the message waits).
        if (turns.between) interrupting = undefined;
        return true;
      };
      /**
       * Take back (see Steer.cancel): not handed to Claude Code yet, it never goes; in its queue,
       * cancel_async_message drops it there. Being read (folded in, or Send now's): too late.
       */
      const cancel = async (followUp: FollowUp): Promise<boolean> => {
        const uuid = steered.get(followUp);
        if (!uuid || prompts.closed || forced?.uuid === uuid) return false;
        if (!prompts.remove(uuid)) {
          const drop = (q as unknown as { cancelAsyncMessage?: (uuid: string) => Promise<boolean> }).cancelAsyncMessage;
          if (!drop) throw new Error('this Claude Code can’t take a message back');
          if (!(await drop.call(q, uuid))) return false;
        }
        steered.delete(followUp);
        turns.drop(uuid);
        return true;
      };
      input.onSteer?.(Object.assign(steerIn, { status, interrupt, force, cancel }) satisfies Steer);

      const ends = () => ({ stderr, ...(rejectedUntil !== undefined ? { rejectedUntil } : {}), ...(apiError ? { apiError } : {}) });
      const q = query({ prompt: prompts, options });
      // Only runs that have your MCP servers (never a friend's or a guest's) reload one you signed in to.
      if (input.ownerMcp && !input.guest) live.add(q);
      showThinking(q);
      let failed = true;
      try {
        for await (const msg of q) {
          lastEventAt = Date.now();
          background.observe(msg as Parameters<BackgroundAgents['observe']>[0]);
          watchQuiet();
          if (msg.type === 'system' && msg.subtype === 'init') remember(msg.session_id);
          // Claude Code retrying the API (busy, a limit, no network): said on the working line, not a silent "Starting" (BLG-403).
          if (msg.type === 'system' && msg.subtype === 'api_retry') input.onEvent('progress', retryWords(msg.error_status, msg.attempt, msg.max_retries, Boolean(msg.no_response)));
          if (msg.type === 'rate_limit_event') {
            const update = fromRateLimitEvent(msg.rate_limit_info);
            if (update) opts.bridge.reportUsage(update, CLAUDE_AGENT);
            if (msg.rate_limit_info.status === 'rejected') rejectedUntil = toMs(msg.rate_limit_info.resetsAt) ?? 0;
          }
          if (msg.type === 'assistant' && msg.error) apiError = msg.error;
          if (msg.type === 'assistant') {
            for (const e of subagents.assistant(msg.parent_tool_use_id, msg.message.content)) input.onEvent('sub', JSON.stringify(e));
          }
          report.observe(msg as ContextMessage);
          if (msg.type === 'system' && 'task_id' in msg) {
            for (const e of subagents.task(msg as Parameters<SubAgentTracker['task']>[0])) input.onEvent('sub', JSON.stringify(e));
          }
          const route = msg.type === 'assistant' && msg.parent_tool_use_id === null ? turns.current() : undefined;
          if (route) stepTo = route.onStep;
          // A message steered in, read now (not only once the turn ends).
          if (route && msg.type === 'assistant' && msg.user_message_uuids?.length) turns.read(msg.user_message_uuids);
          // Claude Code took it off its queue into the running turn (between turns, read ignores it: it's a turn of its own).
          const started = startedPrompt(msg);
          if (started) turns.read([started]);
          apps?.observe(msg as TrackedMessage);
          recorder.observe(msg as RecorderMessage);
          if (msg.type === 'user' && msg.parent_tool_use_id === null) {
            for (const e of subagents.user(msg.message.content as never)) input.onEvent('sub', JSON.stringify(e));
            // A command's output that says how far it got (a test run polled in the background): its card shows "137/215".
            const count = progressCount(toolOutput(msg.message.content));
            if (count) turns.current().onEvent('progress', count);
            const content = msg.message.content;
            const returned = Array.isArray(content) && content.some((block) => block.type === 'tool_result');
            if (Array.isArray(content))
              for (const block of content)
                if (block.type === 'tool_result') {
                  tools.delete(block.tool_use_id);
                  launches.delete(block.tool_use_id);
                }
            // Every tool and sub-agent of its step came back: Claude thinks about what's next (an empty progress says so; older peers ignore it).
            if (returned && !count && !tools.size && !launches.size) turns.current().onEvent('progress', '');
          }
          if (msg.type === 'result' || (msg.type === 'user' && msg.parent_tool_use_id === null)) thinking = false;
          if (msg.type === 'assistant' && msg.parent_tool_use_id === null) {
            const last = msg.message.content.at(-1)?.type;
            thinking = last === 'thinking' || last === 'redacted_thinking';
            for (const block of msg.message.content) {
              if (block.type === 'text' && block.text.trim()) {
                lastText = block.text.trim();
                route?.onEvent('text', shelf.expand(lastText));
              }
              if (block.type === 'tool_use' && subagents.isLaunch(block)) launches.add(block.id);
              if (block.type === 'tool_use' && !subagents.isLaunch(block)) {
                const toolInput = (block.input ?? {}) as Record<string, unknown>;
                const label = summarizeTool(block.name, toolInput, cwd);
                tools.set(block.id, { label: block.name === 'Bash' && typeof toolInput.command === 'string' ? (toolInput.command.split('\n')[0] ?? '').slice(0, 80) : label, since: Date.now() });
                route?.onEvent('tool', label);
                if (WRITE_TOOLS.has(block.name) && typeof toolInput.file_path === 'string') {
                  input.onFileTouched(toolInput.file_path);
                }
              }
            }
          }
          if (msg.type === 'result') {
            remember(msg.session_id);
            await report.result(msg.modelUsage, breakdownReader(q));
            const turn = turns.current();
            turn.onEvent('usage', JSON.stringify(usageOf(msg.modelUsage ?? {}, msg.total_cost_usd ?? 0, msg.session_id)));
            // A turn that ended on an API error (a usage limit, an outage) is a failure, whatever its subtype.
            const ok = msg.subtype === 'success' && !msg.is_error;
            if (!ok) failedResult = msg.subtype === 'success' ? msg.result : [`Agent stopped: ${msg.subtype.replace(/_/g, ' ')}`, ...(msg.errors ?? [])].join('\n');
            const stopped = ok ? '' : failure({ result: failedResult, ...ends() }).message;
            // The prompts this turn took in: a message steered in mid-turn is answered by it.
            const took = msg.user_message_uuids ?? (msg.user_message_uuid ? [msg.user_message_uuid] : undefined);
            tools.clear();
            launches.clear();
            const note = interrupting;
            if (note !== undefined) {
              // Interrupted for a message: the turn ends saying so, and the message's turn comes next.
              const said = msg.subtype === 'success' && msg.result ? `${shelf.finish(msg.result)}\n\n${note}` : note;
              turn.onEvent('text', note);
              // Its result can come after the message was sent and list it: the message still gets its own turn.
              const own = interruptFor;
              const now = forced;
              forced = undefined;
              turns.end(true, said, took?.filter((uuid) => uuid !== own && uuid !== now?.uuid));
              // Send now: Claude Code took the message in before it stopped, so it starts no turn for
              // it (it said nothing more and the run went quiet). Sent again, it's answered next.
              if (now && took?.includes(now.uuid) && turns.drop(now.uuid)) deliver(now.followUp, false);
              if (turns.waiting) {
                interrupting = undefined;
                interruptFor = undefined;
              }
            }
            // A later turn failing (e.g. reporting a finished agent) doesn't throw away answers already given.
            else if (!turns.end(ok, ok ? shelf.finish((msg as { result: string }).result) : stopped, took) && !turns.answers.length) throw failure({ result: failedResult, ...ends() });
            settle();
          }
        }
        failed = false;
      } catch (err) {
        if (err instanceof RunFailedError || abortController.signal.aborted) throw err;
        // Done, and let go: Claude Code exits 1 when its last turn was one that was stopped (Send now,
        // a steer's interrupt). Every turn has been answered by then, so that's no crash.
        if (prompts.closed) failed = false;
        // Claude Code itself failed ("process exited with code 1"): say how, in words.
        else throw failure({ error: err instanceof Error ? err.message : String(err), ...(failedResult ? { result: failedResult } : {}), ...ends() });
      } finally {
        live.delete(q);
        recorder.finish(failed || abortController.signal.aborted);
        finish();
      }
      return turns.answers.join('\n\n');
    },

    // Side calls (naming, drafting, chat answers…) through the same one-shot call any runtime offers.
    // Claude Code's own terminal app on a conversation (BLG-534).
    terminal: (input, sink) => claudeTerminal(input, sink, { bridge: opts.bridge, ...(opts.claudePath ? { claudePath: opts.claudePath } : {}), ...(opts.model ? { model: opts.model } : {}), ...(opts.agentOf ? { agentOf: opts.agentOf } : {}) }),
    ...sideCalls((req) => claudeComplete(req, opts.claudePath), opts.cwd, opts.model),
    btw: (req) => askBtw(req, { ...(opts.claudePath ? { claudePath: opts.claudePath } : {}) }),

    // Your MCP servers (BLG-251): the room's folder first, where Claude Code starts, then your projects'.
    mcpServers: (projects) => mcp.list([opts.cwd, ...projects]),
    mcpSignIn: (projects, name) => mcp.signIn([opts.cwd, ...projects], name),
    mcpSignedIn: (name) => mcp.signedIn(name),
    mcpReadUiResource: (projects, server, uri) => mcp.readUiResource([opts.cwd, ...projects], server, uri),
    mcpAppTools: (projects, server) => mcp.appTools([opts.cwd, ...projects], server),
    mcpAppCall: (projects, server, tool, args) => mcp.appCall([opts.cwd, ...projects], server, tool, args),
    mcpAppRead: (projects, server, uri) => mcp.appRead([opts.cwd, ...projects], server, uri),
    mcpSigningIn: (name) => mcp.signingIn(name),

    /** Ask Claude Code which models it offers (no prompt is sent). */
    async listModels() {
      const idle = (async function* () {
        await new Promise(() => undefined);
      })() as AsyncIterable<never>;
      const q = query({ prompt: idle, options: { cwd: opts.cwd, settingSources: [], ...claudeExecutable(opts.claudePath) } });
      try {
        const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), USAGE_TIMEOUT_MS).unref());
        const models = await Promise.race([q.supportedModels(), timeout]);
        return models?.length ? toModelChoices(models) : undefined;
      } catch {
        return undefined;
      } finally {
        q.close();
      }
    },

    /**
     * Read plan usage without sending a prompt: open a session whose input never
     * yields, ask for /usage data, then close it. Uses an experimental SDK call,
     * so it is feature-detected and failures are ignored.
     */
    async refreshUsage(): Promise<Usage | undefined> {
      const idle = (async function* () {
        await new Promise(() => undefined);
      })() as AsyncIterable<never>;
      const q = query({
        prompt: idle,
        options: { cwd: opts.cwd, settingSources: [], ...claudeExecutable(opts.claudePath) },
      });
      const getUsage = (q as unknown as Record<string, unknown>).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      try {
        if (typeof getUsage !== 'function') return undefined;
        const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), USAGE_TIMEOUT_MS).unref());
        const res = await Promise.race([getUsage.call(q, { skipBehaviors: true }), timeout]);
        return res ? fromUsageResponse(res as Parameters<typeof fromUsageResponse>[0]) : undefined;
      } catch {
        return undefined;
      } finally {
        q.close();
      }
    },
  };
}
