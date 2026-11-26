import { type AppState, shownChannel } from '@beluga/core/store.js';
import { planOf } from '@beluga/core/plans/owner.js';
import type { useActions } from '../lib/actions.js';
import type { useBeluga } from '../lib/beluga.js';
import { openDm, openGroup } from '../network/use-net.js';
import { chatPlaceOf } from '../sentinel/sentinel-model.js';
import type { UnreadEntry } from './attention-model.js';

/** Opening a conversation from a sidebar list, and where you are as one: apart from the rows, so a row's menu can use them. */

/** Where you are, as a channel: a plan counts as one place (its page, its conversation and its tasks' worktrees). */
export function hereOf(state: AppState): string | undefined {
  const inPlan = state.view.kind === 'plan' ? state.view.id : state.view.kind === 'workspace' ? planOf(state, state.view.id)?.id : undefined;
  return inPlan ? `plan:${inPlan}` : shownChannel(state.view);
}

export function openEntry(e: UnreadEntry, run: ReturnType<typeof useActions>['run'], client: ReturnType<typeof useBeluga>['client']): void {
  if (e.kind === 'workspace') run({ type: 'open_ws', id: e.ws.id });
  // The plan, with its conversation; at the task that waits on you, so answering is one click on.
  else if (e.kind === 'plan') run({ type: 'view', view: { kind: 'plan', id: e.plan.id, ...(e.at?.task ? { task: e.at.task } : {}) } });
  // The run's chat, where it waits on you.
  else if (e.kind === 'sentinel') {
    const place = chatPlaceOf(e.at);
    if (place?.kind === 'workspace') run({ type: 'open_ws', id: place.id, tab: 'chat' });
    else if (place) run({ type: 'view', view: { kind: 'assistant', ...(place.chat ? { chat: place.chat } : {}) } });
    else run({ type: 'view', view: { kind: 'sentinel_run', runId: e.runId } });
  } else if (e.kind === 'shared') run({ type: 'open_shared', owner: e.owner, id: e.id, tab: 'chat' });
  else if (e.kind === 'dm') openDm(client, e.peerId);
  else openGroup(client, e.groupId);
}
