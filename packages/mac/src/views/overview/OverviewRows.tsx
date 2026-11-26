import type { KeyboardEvent, MouseEvent } from 'react';
import { activityOf, stateOf } from '@beluga/ui/workspace-models.js';
import { describePr, formatBytes } from '@beluga/shared/format.js';
import { Icon } from '../../components/Icon.js';
import { type ActionItem, ActionsContext, ActionsDropdown } from '../../components/SpecMenu.js';
import { Button, Dot, IconButton, Tip, cx } from '../../components/ui.js';
import { useActions } from '../../lib/actions.js';
import { useApp, useBeluga } from '../../lib/beluga.js';
import { sameDeep } from '../../lib/stable.js';
import { workspaceItems } from '../../layout/workspace-row.js';
import type { OverviewItem } from './overview-model.js';
import s from '../overview.module.css';
import { revealLabel } from '../../lib/os-words.js';
import { chordLabel, primaryKey } from '../../lib/shortcuts-model.js';

const ago = (ts: number, now: number): string => {
  const m = Math.round((now - ts) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};

/** What every row shares: it's focusable (one at a time, the arrow keys move it), and clicking selects it. */
interface RowBase {
  readonly item: OverviewItem;
  readonly selected: boolean;
  readonly onSelect: (id: string) => void;
  /** Return (or a click): open it. */
  readonly onOpen: (item: OverviewItem) => void;
  /** One of the rows picked to delete together (⌘-click, Shift-click, ⌘A). */
  readonly picked: boolean;
  /** ⌘-click or Shift-click: pick it (true when the click was taken for that, so it doesn't open). */
  readonly onPick: (item: OverviewItem, how: 'toggle' | 'range') => boolean;
  /** While it's picked, its right-click menu is the picked rows' (Delete them, Deselect). */
  readonly pickedItems: () => readonly ActionItem[];
}

/** How a click picks: ⌘ (Ctrl elsewhere) adds or takes away one, Shift a range; a plain click opens. */
const pickHow = (e: MouseEvent): 'toggle' | 'range' | undefined => (e.shiftKey ? 'range' : primaryKey(e) ? 'toggle' : undefined);

const rowProps = ({ item, selected, onSelect, onOpen, picked, onPick }: RowBase, label: string) => ({
  role: 'listitem',
  tabIndex: selected ? 0 : -1,
  'data-row': item.ws.id,
  'data-picked': picked ? ('true' as const) : undefined,
  'aria-label': picked ? `${label}, selected` : label,
  'aria-current': selected ? ('true' as const) : undefined,
  onFocus: () => onSelect(item.ws.id),
  // Shift-click picks a range: no text selection across the rows.
  onMouseDown: (e: MouseEvent) => {
    if (e.shiftKey) e.preventDefault();
  },
  onClick: (e: MouseEvent) => {
    // A button inside the row does its own thing.
    if ((e.target as HTMLElement).closest('button')) return;
    const how = pickHow(e);
    if (how && onPick(item, how)) return;
    onOpen(item);
  },
  onKeyDown: (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      onOpen(item);
    }
  },
});

/** A live plan: one row (its tasks are inside it), with what the plan as a whole waits on. */
function PlanItemRow(props: RowBase & { now: number }) {
  const { item, now } = props;
  const plan = item.plan!;
  const act = useApp((st) => activityOf(st.log, `ws:${item.ws.id}`));
  const tone = item.needs ? 'warn' : item.rank === 2 ? 'claude' : 'muted';
  const items: ActionItem[] = [{ label: 'Open Plan', icon: 'chevronRight', onSelect: () => props.onOpen(item) }];
  return (
    <ActionsContext items={items}>
      <div {...rowProps(props, `${plan.title}, plan${plan.tip ? `, ${plan.tip}` : ''}`)} className={cx(s.row, props.picked && s.picked)} data-plan-item={plan.plan.id}>
        <span className={s.kind}>
          <Icon name="flag" size={14} />
        </span>
        <span className={s.name}>
          {plan.title}
          {plan.unread ? <span className={s.unread}>{plan.unread} new</span> : null}
        </span>
        <span className={s.branch}>plan</span>
        <span className={cx(s.state, s[`tone_${tone}`])}>
          <Dot tone={tone === 'claude' ? 'plan' : tone} live={item.rank === 2} />
          {plan.tip || 'Plan'}
        </span>
        <span className={s.extra} title={item.last}>
          {item.last ?? ''}
        </span>
        <span className={s.when}>{act.lastTs ? ago(act.lastTs, now) : ''}</span>
      </div>
    </ActionsContext>
  );
}

/** A live worktree or chat: as the Overview always showed it (state, PR, context, when). A plan's is the plan's row. */
export function ActiveRow(props: RowBase & { now: number }) {
  return props.item.plan ? <PlanItemRow {...props} /> : <WorkspaceItemRow {...props} />;
}

const sameRow = <T,>(a: T, b: T): boolean => sameDeep(a, b, 2);

function WorkspaceItemRow(props: RowBase & { now: number }) {
  const { item, now } = props;
  const w = item.ws;
  const actions = useActions();
  const { client } = useBeluga();
  // What the row shows, worked out from the shared state: drawn again only when part of it changes.
  const { st, running, lastTs, unread, pr, ctx } = useApp((full) => {
    const act = activityOf(full.log, `ws:${w.id}`);
    return { st: stateOf(full, w, 0), running: act.running, lastTs: act.lastTs, unread: full.unread[`ws:${w.id}`] ?? 0, pr: full.prs[w.id], ctx: full.context[`ws:${w.id}`] };
  }, sameRow);
  return (
    <ActionsContext items={() => (props.picked ? props.pickedItems() : workspaceItems(client.store.getState(), w, actions.run, client))}>
      <div {...rowProps(props, `${w.name}, ${st.label}`)} className={cx(s.row, props.picked && s.picked)}>
        <span className={s.kind}>
          <Icon name={w.kind === 'chat' ? 'chat' : w.kind === 'main' ? 'folder' : 'branch'} size={14} />
        </span>
        <span className={s.name}>
          {w.name}
          {unread ? <span className={s.unread}>{unread} new</span> : null}
        </span>
        <span className={s.branch}>{w.branch ?? (w.kind === 'chat' ? 'chat' : '')}</span>
        <span className={cx(s.state, s[`tone_${st.tone}`])}>
          <Dot tone={running && w.kind === 'worktree' ? 'worktree' : st.tone} live={running} />
          {st.label}
        </span>
        <span className={s.extra} title={item.last}>
          {pr ? describePr(pr) : ''}
          {ctx ? `${pr ? ' · ' : ''}${Math.round((ctx.used / ctx.window) * 100)}% context` : ''}
          {!pr && !ctx && item.last ? item.last : ''}
        </span>
        <span className={s.when}>{lastTs ? ago(lastTs, now) : item.size !== undefined ? formatBytes(item.size) : ''}</span>
      </div>
    </ActionsContext>
  );
}

export interface ArchivedActions {
  readonly restore: (item: OverviewItem) => void;
  readonly read: (item: OverviewItem) => void;
  readonly finder: (item: OverviewItem) => void;
  readonly remove: (item: OverviewItem) => void;
  /** The one being restored right now (its button says so). */
  readonly restoring: string | undefined;
}

/** The archived row's menu: right-click, or its ⋯ button. */
export function archivedItems(item: OverviewItem, act: ArchivedActions): ActionItem[] {
  return [
    { label: 'Restore', icon: 'refresh', hint: item.ws.kind === 'worktree' ? (item.ws.archive ? 'Bring the worktree back as it was' : 'Make the worktree again from its branch') : 'Show it in the sidebar again', onSelect: () => act.restore(item) },
    { label: 'Read Conversation', icon: 'eye', keys: 'Space', onSelect: () => act.read(item) },
    ...(item.project.root ? [{ label: revealLabel('Project'), icon: 'folder' as const, onSelect: () => act.finder(item) }] : []),
    { label: 'Delete Permanently…', danger: true, keys: chordLabel('Cmd+Backspace'), onSelect: () => act.remove(item) },
  ];
}

/**
 * An archived worktree or chat, quiet: its folder is gone (a chat keeps its own), its branch
 * and conversation are kept. Hover (or select) for Restore, Read and ⋯; right-click for all.
 */
export function ArchivedRow(props: RowBase & { act: ArchivedActions }) {
  const { item, act } = props;
  const w = item.ws;
  const worktree = w.kind === 'worktree';
  const busy = act.restoring === w.id;
  // Archived smartly: everything of yours is kept, and it says what it freed.
  const smart = w.archive;
  const kept = smart ? (smart.freedBytes ? `Freed ${formatBytes(smart.freedBytes)}` : 'Everything kept') : worktree && w.branch ? 'Branch kept' : 'Conversation kept';
  const keptLong = smart
    ? `Everything of yours is kept: uncommitted work, new files and ignored files (${formatBytes(smart.keptBytes)} compressed). ${smart.freedBytes ? `Dependencies, builds and caches (${formatBytes(smart.freedBytes)}) were cleared; restoring makes them again${smart.remake.length ? ` (${smart.remake.join(', ')})` : ''}.` : ''}`
    : worktree && w.branch
      ? `The folder was removed. Branch ${w.branch} and the conversation are kept.`
      : 'The conversation is kept.';
  const items = archivedItems(item, act);
  return (
    <ActionsContext items={() => (props.picked ? props.pickedItems() : items)}>
      <div {...rowProps(props, `${w.name}, archived`)} className={cx(s.row, s.archived, props.picked && s.picked)}>
        <span className={s.kind}>
          <Icon name="archive" size={14} />
        </span>
        <span className={s.name}>{w.name}</span>
        <span className={s.branch}>{w.branch ?? (w.kind === 'chat' ? 'chat' : '')}</span>
        <span className={cx(s.state, s.tone_muted)}>
          <Dot tone="muted" />
          Archived
        </span>
        <span className={s.extra} title={keptLong}>
          {kept}
        </span>
        <span className={s.when}>{smart ? formatBytes(smart.keptBytes) : item.size !== undefined ? formatBytes(item.size) : ''}</span>
        <span className={cx(s.hoverActions, busy && s.hoverBusy)}>
          <Tip label={worktree ? (smart ? 'Bring the worktree back as it was, and open it' : 'Make the worktree again from its branch, and open it') : 'Show it in the sidebar again, and open it'}>
            <Button size="small" variant="plain" disabled={busy} onClick={() => act.restore(item)}>
              {busy ? 'Restoring…' : 'Restore'}
            </Button>
          </Tip>
          <IconButton size="small" icon="eye" label="Read Conversation" keys="Space" onClick={() => act.read(item)} />
          <ActionsDropdown items={items}>
            <button type="button" className={s.more} aria-label={`More for ${w.name}`}>
              <Icon name="more" size={14} />
            </button>
          </ActionsDropdown>
        </span>
      </div>
    </ActionsContext>
  );
}
