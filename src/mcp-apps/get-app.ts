import type { McpAppView } from '../shared/mcp-apps.js';
import type { StepRecord } from '../shared/steps.js';

/**
 * `apps.get`: the app of one step of your Claude's work: the frame to draw it in, with the tool
 * call's input and result, or why there is none.
 */

export interface GetAppDeps {
  readonly step: (channel: string, itemId: string, stepId: string) => StepRecord | undefined;
  /** The frame for a server's `ui://` resource (read and served the first time). */
  readonly frame: (server: string, resourceUri: string) => Promise<{ readonly url: string; readonly prefersBorder?: boolean }>;
}

export async function getApp(deps: GetAppDeps, channel: string, itemId: string, stepId: string): Promise<McpAppView> {
  const step = deps.step(channel, itemId, stepId);
  const app = step?.app;
  if (!step || !app) return { ok: false, reason: 'missing', message: 'This step has no app on this computer.' };
  let frame: Awaited<ReturnType<GetAppDeps['frame']>>;
  try {
    frame = await deps.frame(app.server, app.resourceUri);
  } catch (err) {
    return { ok: false, reason: 'unavailable', message: err instanceof Error ? err.message : String(err) };
  }
  return {
    ok: true,
    url: frame.url,
    server: app.server,
    tool: app.tool,
    resourceUri: app.resourceUri,
    input: step.input ?? {},
    ...resultOf(step),
    ...(frame.prefersBorder !== undefined ? { prefersBorder: frame.prefersBorder } : {}),
  };
}

function resultOf(step: StepRecord): Pick<Extract<McpAppView, { ok: true }>, 'result'> {
  if (step.status === 'running') return {};
  const structuredContent = step.app?.structuredContent;
  return {
    result: {
      ...(step.output !== undefined ? { text: step.output } : {}),
      ...(structuredContent !== undefined ? { structuredContent } : {}),
      ...(step.isError ? { isError: true } : {}),
    },
  };
}
