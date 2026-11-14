import type { AppActResult, AppStepRef } from '../shared/mcp-apps.js';
import type { AppAlways, AskAnswer } from './call-tool.js';
import type { AppContexts } from './contexts.js';
import { messageTextOf, modelContextOf } from './domain/app-requests.js';
import { type StepAppDeps, appOnStep } from './step-app.js';

/**
 * `apps.message` and `apps.context`: an app talks back (SEP-1865 ui/message,
 * ui/update-model-context). A message speaks for you, so it asks you first (Allow / Allow Always /
 * Decline) and is refused while your Claude works in that chat or while the app's last one waits for
 * you: an app can't queue turn after turn. Allowed, it goes into the app's own chat as yours, marked
 * as sent by the app, and starts a turn. A context waits for your Claude's next turn there, as data.
 */

export interface AppTalkDeps extends StepAppDeps {
  /** Say it in that chat, marked as the app's (`app`: its tool), and ask your Claude. False: it couldn't go. */
  readonly post: (text: string, channel: string, app: string) => boolean;
  /** Your Claude works in that chat now. */
  readonly busy: (channel: string) => boolean;
  /** Allow / Allow Always / Decline for a message, showing its words. */
  readonly ask: (server: string, tool: string, channel: string, text: string) => Promise<AskAnswer>;
  /** The apps you said Always to for messages, per server and tool. */
  readonly always: AppAlways;
  /** App instances whose message waits for your answer now. */
  readonly waiting: Set<string>;
  readonly contexts: AppContexts;
}

type Empty = Record<string, never>;

export async function postAppMessage(deps: AppTalkDeps, ref: AppStepRef, params: unknown): Promise<AppActResult<Empty>> {
  const app = appOnStep(deps, ref);
  if (!app.ok) return app;
  const text = messageTextOf(params);
  if (!text) return { ok: false, reason: 'refused', message: 'ui/message needs a user message with text.' };
  const { server, tool } = app.result;
  if (deps.busy(ref.channel)) return { ok: false, reason: 'refused', message: 'Your agent is working in this chat. Send it again when its turn ends.' };
  const instance = `${ref.channel}\n${ref.itemId}\n${ref.stepId}`;
  const pending = deps.waiting;
  if (pending.has(instance)) return { ok: false, reason: 'refused', message: 'This app’s last message still waits for your answer.' };
  if (!deps.always.has(server, tool)) {
    pending.add(instance);
    let answer: AskAnswer;
    try {
      answer = await deps.ask(server, tool, ref.channel, text);
    } finally {
      pending.delete(instance);
    }
    if (answer === 'no') return { ok: false, reason: 'declined', message: 'You declined the message.' };
    if (answer === 'always') deps.always.add(server, tool);
  }
  return deps.post(text, ref.channel, tool) ? { ok: true, result: {} } : { ok: false, reason: 'failed', message: 'The message could not be sent in this chat.' };
}

export function setAppContext(deps: AppTalkDeps, ref: AppStepRef, params: unknown): AppActResult<Empty> {
  const app = appOnStep(deps, ref);
  if (!app.ok) return app;
  // One instance per step: an app drawn on another step keeps its own.
  deps.contexts.set(ref.channel, `${ref.itemId}\n${ref.stepId}`, `${app.result.server} · ${app.result.tool}`, modelContextOf(params));
  return { ok: true, result: {} };
}
