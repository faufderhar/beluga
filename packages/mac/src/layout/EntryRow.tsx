import { type ReactNode, forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppState } from '@beluga/core/store.js';
import { Icon } from '../components/Icon.js';
import { type ActionItem, ActionsContext } from '../components/SpecMenu.js';
import { Avatar } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import { iconOf } from '../sentinel/sentinel-model.js';
import { IDLE_SIGNAL, type Signal, type UnreadEntry, planSignal, workspaceSignal } from './attention-model.js';
import { SignalMark, nameClass, signalClass } from './signal-marks.js';
import { hereOf, openEntry } from './entry-open.js';
import { ExtrasName, Row, type RowExtras } from './sidebar-parts.js';
import { WorkspaceWithAgents } from './SubAgents.js';
import { WorkspaceRow } from './workspace-row.js';
import { PlanRow } from './plan-row.js';
import m from './signal.module.css';

/** One conversation in a sidebar list, and opening it from there: the seam the Unread section and the categories share. */

/** A conversation with no row of its own elsewhere in the sidebar. */
type PlainEntry = Exclude<UnreadEntry, { readonly kind: 'workspace' | 'plan' }>;

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

type EntryRowProps = {
  e: UnreadEntry;
  list: Pick<EntryList, 'here' | 'ownerName'> & { readonly open: (e: never, at: number) => void };
  at: number;
  /** Before the row's own marks at its right edge: the list's tools and words. */
  trailing?: ReactNode;
  /** Bold for something other than news (a snooze that ended). */
  bold?: boolean;
  /** With the threads it started under it, as in the Chats section (the categories). */
  threads?: boolean;
  /** The category it is in, marked on the row (`data-category`). */
  category?: string;
  /** The right-click menu of a row with none of its own (a sentinel's chat); a chat's and a plan's row bring theirs. */
  menu?: () => readonly ActionItem[];
};

/**
 * A conversation in a list: a chat's and a plan's are the very rows a project's list draws, with the
 * list's extras added (so a drag, a rename or a menu works the same in both). The rest (a DM, a group,
 * a friend's chat, a sentinel's) have no row elsewhere to be: they get a plain one.
 */
export function EntryRow({ e, list, at, trailing, bold, threads, category, menu }: EntryRowProps) {
  const where = whereOf(e, list.ownerName);
  const { open } = list;
  // The same object while what it says is the same, so the row's memo skips it (KLD-48): `e` and `open` keep their identity (useEntryList).
  const extras = useMemo<RowExtras>(
    () => ({
      // With what's waiting, so it reads (and is found) apart from the same conversation further down.
      label: `${e.name} · ${e.signal.tip || 'read'}`,
      where,
      trailing,
      ...(bold ? { bold } : {}),
      open: () => open(e as never, at),
      ...(category ? { data: { 'data-category': category } } : {}),
    }),
    [e, where, trailing, bold, open, at, category],
  );
  if (e.kind === 'workspace') return threads ? <WorkspaceWithAgents ws={e.ws} indent={0} threadsOnly extras={extras} /> : <WorkspaceRow ws={e.ws} indent={0} extras={extras} />;
  if (e.kind === 'plan') return <PlanRow plan={e.plan} indent={0} extras={extras} />;
  const row = <PlainEntryRow e={e} selected={e.channel === list.here} extras={extras} />;
  return menu ? <ActionsContext items={menu}>{row}</ActionsContext> : row;
}

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
  // Each entry the same object while it reads the same, so its row isn't drawn again when another one changes.
  const sameEntries = useSameByChannel<E>();
  const sameStay = useSameByChannel<E>();
  const shown = useMemo(() => sameEntries(entries), [sameEntries, entries]);
  const stayed = useMemo(() => (stay ? sameStay([stay])[0] : undefined), [sameStay, stay]);
  // Leaving it lets it go.
  useEffect(() => {
    if (!kept) return;
    if (here === kept.entry.channel) {
      if (!kept.arrived) setKept({ ...kept, arrived: true });
    } else if (kept.arrived) setKept(undefined);
  }, [here, kept]);
  const open = useCallback(
    (e: E, at: number): void => {
      setKept({ entry: e, at, arrived: e.channel === here });
      openEntry(e, actions.run, client);
    },
    [here, actions, client],
  );
  return { here, entries: shown, ...(stayed && kept ? { kept: { entry: stayed, at: kept.at } } : {}), ownerName: (id) => owners[id] ?? 'Shared', open };
}

/** Entries as they were last time, by channel, while they read the same (sameEntry): fresh ones only for what changed. */
function useSameByChannel<E extends UnreadEntry>(): (next: readonly E[]) => readonly E[] {
  const last = useRef(new Map<string, E>());
  return useCallback((next: readonly E[]) => {
    const out = next.map((e) => {
      const was = last.current.get(e.channel);
      return was && sameEntry(was, e) ? was : e;
    });
    last.current = new Map(out.map((e) => [e.channel, e]));
    return out;
  }, []);
}

/**
 * The same entry for its row: every field the same, but its project only by id and name (all a row
 * reads of it). The project carries all its workspaces, so a change to one would redraw them all.
 */
function sameEntry(a: UnreadEntry, b: UnreadEntry): boolean {
  const x = a as unknown as Record<string, unknown>;
  const y = b as unknown as Record<string, unknown>;
  const keys = Object.keys(x);
  if (keys.length !== Object.keys(y).length) return false;
  return keys.every((k) => (k === 'project' ? sameProject(x[k], y[k]) : sameDeep(x[k], y[k])));
}

const sameProject = (a: unknown, b: unknown): boolean => {
  const x = a as { readonly id: string; readonly name: string } | undefined;
  const y = b as { readonly id: string; readonly name: string } | undefined;
  return x === y || (!!x && !!y && x.id === y.id && x.name === y.name);
};

/** The row of a conversation that has no row of its own elsewhere. It passes its ref on, so a right-click menu wrapped around it can attach. */
const PlainEntryRow = forwardRef<HTMLDivElement, { e: PlainEntry; selected: boolean; extras: RowExtras }>(function PlainEntryRow({ e, selected, extras, ...rest }, ref) {
  return (
    <Row
      ref={ref}
      {...rest}
      {...extras.data}
      selected={selected}
      className={signalClass(e.signal, selected)}
      data-signal-row={e.signal.level}
      aria-label={extras.label}
      icon={
        <span className={m.unreadIcon}>
          <EntryIcon e={e} />
        </span>
      }
      label={<ExtrasName name={e.name} extras={extras} className={nameClass(e.signal)} />}
      detail={`${extras.where} › ${e.name}${e.signal.tip ? `: ${e.signal.tip}` : ''}`}
      onClick={extras.open}
      trailing={
        <>
          {extras.trailing}
          <SignalMark signal={e.signal} />
        </>
      }
    />
  );
});

function EntryIcon({ e }: { e: PlainEntry }) {
  switch (e.kind) {
    case 'shared':
      return <Avatar name={e.name} id={e.owner} size={16} />;
    case 'dm':
      return <Avatar name={e.name} id={e.peerId} size={16} />;
    case 'group':
      return <Icon name="people" size={14} />;
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
