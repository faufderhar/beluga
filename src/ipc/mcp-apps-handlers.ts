import type { Session } from '../core/session.js';
import { McpAppHost } from '../mcp-apps/adapters/app-host.js';
import { McpAppFrames } from '../mcp-apps/frames.js';
import { type AppActDeps, AppAlways, callAppTool, readAppResource } from '../mcp-apps/call-tool.js';
import { appContextsOf } from '../mcp-apps/contexts.js';
import { getApp } from '../mcp-apps/get-app.js';
import { type AppTalkDeps, postAppMessage, setAppContext } from '../mcp-apps/talk.js';
import { FRAME_ANCESTORS } from '../preview/server.js';
import type { Args, Method } from './api.js';

/** What each `apps.*` method does (see mcp-apps-api.ts). */

type AppsMethod = Extract<Method, `apps.${string}`>;
type AppsHandlers = { readonly [M in AppsMethod]: (s: Session, ...args: Args<M>) => unknown };

/** The app host and its pages, made the first time an app is drawn. */
let frames: McpAppFrames | undefined;

/** Per session, until Beluga quits: what you said Always to (tools and messages, per server and tool), and the messages that wait for you. */
interface AppAnswers {
  readonly tools: AppAlways;
  readonly messages: AppAlways;
  readonly waiting: Set<string>;
}
const answers = new WeakMap<Session, AppAnswers>();

function answersOf(s: Session): AppAnswers {
  let a = answers.get(s);
  if (!a) answers.set(s, (a = { tools: new AppAlways(), messages: new AppAlways(), waiting: new Set() }));
  return a;
}

const projectRoots = (s: Session): string[] => s.store.getState().projects.map((p) => p.root);

/** What an app acts through: your Claude Code, and your Allow / Allow Always / Decline. */
function actDeps(s: Session): AppActDeps {
  const backend = s.backend;
  const missing = (): Promise<never> => Promise.reject(new Error('Your agent can’t run MCP App tools here.'));
  return {
    step: (c, i, st) => s.host.stepFor(c, i, st),
    server: {
      tools: (server) => (backend?.mcpAppTools ? backend.mcpAppTools(projectRoots(s), server) : missing()),
      call: (server, tool, args) => (backend?.mcpAppCall ? backend.mcpAppCall(projectRoots(s), server, tool, args) : missing()),
      read: (server, uri) => (backend?.mcpAppRead ? backend.mcpAppRead(projectRoots(s), server, uri) : missing()),
    },
    ask: (server, tool, channel) => s.host.ask('tool', `The ${server} app wants to run ${tool} (Always: this tool of ${server}, until Beluga quits)`, `An MCP App in your chat asked to call ${tool} on its server, ${server}.`, undefined, channel),
    always: answersOf(s).tools,
  };
}

/** What an app talks back through: your chat with your Claude, and the next turn's context. */
function talkDeps(s: Session): AppTalkDeps {
  return {
    step: (c, i, st) => s.host.stepFor(c, i, st),
    post: (text, channel, app) => s.askFromApp(text, channel, app),
    busy: (channel) => s.host.runningIn(channel),
    ask: (server, tool, channel, text) =>
      s.host.ask('tool', `The ${server} app wants to send a message for you, and start a turn (Always: messages from ${tool}, until Beluga quits)`, text, undefined, channel),
    always: answersOf(s).messages,
    waiting: answersOf(s).waiting,
    contexts: appContextsOf(s),
  };
}

export const MCP_APPS_HANDLERS = {
  'apps.get': (s, channel, itemId, stepId) =>
    getApp(
      {
        step: (c, i, st) => s.host.stepFor(c, i, st),
        frame: (server, uri) => {
          const read = s.backend?.mcpReadUiResource;
          if (!read) return Promise.reject(new Error('Your agent can’t read MCP App views here.'));
          frames ??= new McpAppFrames(new McpAppHost(), FRAME_ANCESTORS);
          return frames.frame(server, uri, (sv, u) => read.call(s.backend, projectRoots(s), sv, u));
        },
      },
      channel,
      itemId,
      stepId,
    ),
  'apps.call': (s, channel, itemId, stepId, tool, args) => callAppTool(actDeps(s), { channel, itemId, stepId }, tool, args),
  'apps.read': (s, channel, itemId, stepId, uri) => readAppResource(actDeps(s), { channel, itemId, stepId }, uri),
  'apps.message': (s, channel, itemId, stepId, params) => postAppMessage(talkDeps(s), { channel, itemId, stepId }, params),
  'apps.context': (s, channel, itemId, stepId, params) => setAppContext(talkDeps(s), { channel, itemId, stepId }, params),
} satisfies AppsHandlers;
