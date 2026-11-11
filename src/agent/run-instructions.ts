import type { AgentRef } from '../protocol.js';
import { buildGraphAppend } from './graph-prompt.js';
import { buildAskOnlyAppend, buildCommitAppend, buildKeepAppend, buildScratchAppend, buildShippedAppend, buildSystemAppend } from './prompt.js';
import { buildSyncMainAppend } from './sync-main.js';
import { buildTerminalAppend } from './terminal-prompt.js';
import type { AgentRunInput } from './types.js';
import { buildViewAppend } from './view-prompt.js';

/**
 * What Beluga adds to an agent's own instructions for one run: who it is in the room, graphs and
 * views, the task's brief, the scratch folder, a worktree's keep/commit rules, a main folder's
 * ask-only rules. Plain text: Claude appends it to its system prompt, Codex takes it as developer
 * instructions. `agent` words what differs to be true for its runtime (.env files, kept processes).
 */
export function runInstructions(input: AgentRunInput, ownerName: string, agent?: AgentRef): string {
  const place = input.place;
  const askOnly = place?.askOnly;
  const syncMain = askOnly ? place?.syncMain : undefined;
  const worktree = Boolean(input.env?.KLAUD_WORKTREE);
  return (
    buildSystemAppend(ownerName, agent) +
    buildGraphAppend(Boolean(input.terminal)) +
    buildViewAppend(Boolean(input.terminal)) +
    (input.taskBrief ?? '') +
    (input.planBrief ?? '') +
    (input.macBrief ?? '') +
    (input.sharedBrief ?? '') +
    (input.phoneBrief ?? '') +
    (input.terminal ? '' : (input.previewBrief ?? '')) +
    (input.sentinelBrief ?? '') +
    (input.dialogue?.brief ?? '') +
    (input.setup && !askOnly ? input.setup.brief : '') +
    (input.scratchDir ? buildScratchAppend(input.scratchDir) : '') +
    (worktree ? buildKeepAppend(agent) : '') +
    (worktree && !input.planBrief && !askOnly ? buildCommitAppend(place?.openPr) : '') +
    (place?.shipped && !askOnly ? buildShippedAppend(place.shipped) : '') +
    (askOnly ? (syncMain ? buildSyncMainAppend(askOnly.project, syncMain.branch, syncMain.upstream) : buildAskOnlyAppend(askOnly.project, Boolean(input.continueInWorktree), Boolean(input.board))) : '') +
    (input.terminal ? buildTerminalAppend() : '') +
    (input.env?.BELUGA_REMOTE_CLIENT ? buildRemoteClientAppend() : '')
  );
}

/**
 * A run your app started from another computer (BLG-803): the person isn't at this one. Their app
 * forwards this computer's servers to theirs at the same port, so localhost is the address to give.
 */
export function buildRemoteClientAppend(): string {
  return (
    '\n\nThe person you work for is on another computer (their laptop or phone), driving this one through Beluga; ' +
    "they can't see this computer's screen. Servers you start here are forwarded to them at the same port, so give " +
    'addresses as http://localhost:<port> (never this computer’s host name or IP). Do not open browsers, apps or windows ' +
    'on this computer (no `open`, `xdg-open` or browser launches): they would show here, where nobody is. A screenshot of ' +
    'this screen shows this computer, not theirs.'
  );
}
