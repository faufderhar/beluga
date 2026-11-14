import { type ReactNode, forwardRef, useEffect, useState } from 'react';
import { type AppState, shownChannel } from '@beluga/core/store.js';
import { planOf } from '@beluga/core/plans/owner.js';
import { Icon } from '../components/Icon.js';
import { ProjectIcon } from '../components/ProjectIcon.js';
import { Avatar, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import { openDm, openGroup } from '../network/use-net.js';
import { chatPlaceOf, iconOf } from '../sentinel/sentinel-model.js';
import { IDLE_SIGNAL, type Signal, type UnreadEntry, planSignal, workspaceSignal } from './attention-model.js';
import { SignalMark, nameClass, signalClass } from './signal-marks.js';
import { Row, type RowProps } from './sidebar-parts.js';
import type { WorkspaceRowActions } from './workspace-row.js';
import m from './signal.module.css';

/** One conversation in a sidebar list, and opening it from there: the seam the Unread section and the categories share. */

/** A list's rows, and the one you opened from it, which stays while you're in it. */
export interface EntryList<E extends UnreadEntry = UnreadEntry> {
  /** Where you are, as an entry's channel. */
  readonly here: string | undefined;
  readonly entries: readonly E[];
  /** The one you opened, gone from the list, as it is now (read, it's plain); `at`: the place it had. */
  readonly kept?: { readonly entry: E; readonly at: number };
  readonly ownerName: (id: string) => string;
  readonly open: (e: E, at: number) => void;
}

type EntryRowProps = Omit<RowProps, 'icon' | 'label' | 'selected' | 'onClick' | 'detail' | 'trailing' | 'className'> & {
  e: UnreadEntry;
  list: Pick<EntryList, 'here' | 'ownerName'> & { readonly open: (e: never, at: number) => void };
  at: number;
  trailing?: ReactNode;
  /** Bold for something other than news (a snooze that ended). */
  nameBold?: string | undefined;
  /** A workspace's: what its row does in a project's list too (Rename…, shift-click picking). */
  workspace?: WorkspaceRowActions | undefined;
};

/** It passes its ref and other props to its Row, so a right-click menu wrapped around it can attach. */
export const EntryRow = forwardRef<HTMLDivElement, EntryRowProps>(function EntryRow({ e, list, at, trailing, nameBold, workspace, ...rest }, ref) {
  const selected = e.channel === list.here;
  const where = whereOf(e, list.ownerName);
  const name = <span className={nameBold ?? nameClass(e.signal)}>{e.name}</span>;
  return (
    <Row
      ref={ref}
      {...rest}
      {...workspace?.props}
      selected={selected || Boolean(workspace?.inSelection)}
      color={workspace?.color}
      className={cx(signalClass(e.signal, selected), workspace?.className)}
      data-signal-row={e.signal.level}
      // With what's waiting, so it reads (and is found) apart from the same conversation further down.
      aria-label={`${e.name} · ${e.signal.tip || 'read'}`}
      icon={
        <span className={m.unreadIcon}>
          <EntryIcon e={e} />
        </span>
      }
      label={
        <>
          {workspace ? workspace.label(name) : name}
          {/* Drawn from the attribute: a hint for the eye, not more text to find (the tooltip says it). */}
          <span className={m.where} data-where={where} aria-hidden="true" />
        </>
      }
      detail={`${where} › ${e.name}${e.signal.tip ? `: ${e.signal.tip}` : ''}`}
      onClick={(event) => {
        if (!workspace?.pick(event)) list.open(e as never, at);
      }}
      trailing={trailing ?? <SignalMark signal={e.signal} />}
    />
  );
});

/** A list of `entriesOf(state)` you can open. The one you open stays in place, so the list doesn't jump under you. */
export function useEntryList<E extends UnreadEntry>(entriesOf: (state: AppState) => readonly E[]): EntryList<E> {
  const actions = useActions();
  const { client } = useBeluga();
  // The one you opened from here, and whether you've got there yet (opening it takes a moment).
  const [kept, setKept] = useState<{ entry: E; at: number; arrived: boolean } | undefined>();
  // Only what the list shows (not the whole state): drawn again when that changes, not on every streamed event (KLD-48).
  const { here, entries, stay, owners } = useApp((state) => {
    const entries = entriesOf(state);
    const place = hereOf(state);
    // In a sentinel run's chat that needs you: that's its entry.
    const here = place?.startsWith('plan:') ? place : (sentinelHere(entries, place) ?? place);
    const keep = kept && kept.entry.channel === here && !entries.some((e) => e.channel === here) ? kept.entry : undefined;
    return { here, entries, stay: keep ? { ...keep, signal: nowOf(state, keep) } : undefined, owners: Object.fromEntries(state.peers.map((p) => [p.peerId, p.name])) };
  }, sameDeep);
  // Leaving it lets it go.
  useEffect(() => {
    if (!kept) return;
    if (here === kept.entry.channel) {
      if (!kept.arrived) setKept({ ...kept, arrived: true });
    } else if (kept.arrived) setKept(undefined);
  }, [here, kept]);
  const open = (e: E, at: number): void => {
    setKept({ entry: e, at, arrived: e.channel === here });
    openEntry(e, actions.run, client);
  };
  return { here, entries, ...(stay && kept ? { kept: { entry: stay, at: kept.at } } : {}), ownerName: (id) => owners[id] ?? 'Shared', open };
}

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

function EntryIcon({ e }: { e: UnreadEntry }) {
  switch (e.kind) {
    case 'workspace':
      return e.project ? <ProjectIcon id={e.project.id} name={e.project.name} size={16} /> : <Icon name="chat" size={14} />;
    case 'shared':
      return <Avatar name={e.name} id={e.owner} size={16} />;
    case 'dm':
      return <Avatar name={e.name} id={e.peerId} size={16} />;
    case 'group':
      return <Icon name="people" size={14} />;
    case 'plan':
      return <Icon name="flag" size={14} />;
    case 'sentinel':
      return <Icon name={iconOf(e.sentinel.icon)} size={14} />;
  }
}

/** Where it lives, after its name: the project, "Chats", or whose it is. */
function whereOf(e: UnreadEntry, ownerName: (id: string) => string): string {
  switch (e.kind) {
    case 'workspace':
      return e.project?.name ?? 'Chats';
    case 'shared':
      return ownerName(e.owner);
    case 'dm':
      return 'Message';
    case 'group':
      return 'Group';
    case 'plan':
      return e.project?.name ?? 'Plan';
    case 'sentinel':
      return 'Sentinel';
  }
}

/** A row kept while you're in it: as it is now (read, it's plain). */
function nowOf(state: AppState, e: UnreadEntry): Signal {
  if (e.kind === 'workspace') return workspaceSignal(state, e.ws);
  if (e.kind === 'plan') return planSignal(state, e.plan);
  return IDLE_SIGNAL;
}

/** Where a sentinel run's conversation opens (its chat), and the channel you're in as that entry's. */
function sentinelHere(entries: readonly UnreadEntry[], channel: string | undefined): string | undefined {
  const e = entries.find((x) => x.kind === 'sentinel' && channel !== undefined && x.channels.includes(channel));
  return e?.channel;
}
