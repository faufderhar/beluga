/**
 * Claude in Chrome (Claude Code's `--chrome`): Claude drives your own Chrome, signed in to
 * everything you are. Every Claude run gets it; who asked decides how it may use it:
 *  - a run you typed yourself: as Claude Code always does (Beluga's usual rules, nothing extra);
 *  - any other run (a Sentinel firing, a friend, an external agent, a thread or a plan's step):
 *    you're asked before its first Chrome step, once per request, with no Always.
 * A guest's run never gets it.
 */

/** Claude Code's name for its Claude in Chrome server's tools. */
export const CHROME_TOOL_PREFIX = 'mcp__claude-in-chrome__';

export const isChromeTool = (toolName: string): boolean => toolName.startsWith(CHROME_TOOL_PREFIX);

/** What a run may do with your Chrome. Unset on a run: no Chrome at all. */
export interface ChromeAccess {
  /** Set: a run you didn't type, which asks you (true: allowed) before it first uses Chrome. Unset: as usual. */
  readonly ask?: (toolName: string, input: Record<string, unknown>) => Promise<boolean>;
}

/** What the gate says about one Chrome step: run it, refuse it (why), or leave it to the usual rules. */
export type ChromeVerdict = { readonly kind: 'allow' } | { readonly kind: 'deny'; readonly reason: string } | { readonly kind: 'usual' };

export const CHROME_OFF = 'Claude in Chrome isn’t available in this run. Don’t try another way to reach the browser.';
export const CHROME_DECLINED = 'The machine owner declined letting you use their Chrome for this request. Don’t use Chrome again in this request; carry on without it and say what you couldn’t do.';

/** Your `claude` flags turned it off for every run (Settings › Agents › Launch flags). */
export const chromeOffByFlags = (claudeArgs: readonly string[] | undefined): boolean => Boolean(claudeArgs?.includes('--no-chrome'));

/**
 * One run's gate. Asked runs ask once: the answer covers the rest of the request (steps asked at
 * the same moment share the one card), and a No refuses every later Chrome step without asking again.
 */
export function chromeGate(access: ChromeAccess | undefined): (toolName: string, input: Record<string, unknown>) => Promise<ChromeVerdict> {
  let answer: Promise<boolean> | undefined;
  return async (toolName, input) => {
    if (!access) return { kind: 'deny', reason: CHROME_OFF };
    if (!access.ask) return { kind: 'usual' };
    const ask = access.ask;
    answer ??= ask(toolName, input).catch(() => false);
    return (await answer) ? { kind: 'allow' } : { kind: 'deny', reason: CHROME_DECLINED };
  };
}

const short = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** A Chrome step in a few words, for its card ("open github.com/pulls"). */
export function chromeStep(toolName: string, input: Record<string, unknown>): string {
  const name = toolName.slice(CHROME_TOOL_PREFIX.length);
  const url = typeof input.url === 'string' ? input.url.replace(/^https?:\/\//, '') : undefined;
  if (name === 'navigate') return url ? `open ${short(url, 80)}` : 'open a page';
  if (name === 'javascript_tool') return 'run JavaScript on a page';
  if (name === 'computer') return 'click, type and take screenshots on a page';
  if (name === 'read_page' || name === 'get_page_text' || name === 'find') return 'read a page';
  if (name === 'form_input') return 'fill in a form';
  if (name === 'read_console_messages' || name === 'read_network_requests') return 'read a page’s console and network';
  if (name.startsWith('tabs_')) return 'look at and open tabs';
  if (name === 'gif_creator') return 'record a GIF of a page';
  return name.replace(/_/g, ' ');
}

/** The card a run that asks shows you: who it works for, and what it wants first. */
export function chromeCard(who: string, toolName: string, input: Record<string, unknown>): { title: string; detail: string } {
  const title = `${who} wants to use your Chrome: ${chromeStep(toolName, input)}`;
  const detail = `Allow lets it use Chrome, where you're signed in, for the rest of this request. You'll be asked again next time.\n\n${short(JSON.stringify(input), 1500)}`;
  return { title, detail };
}
