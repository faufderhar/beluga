import type { AppState } from '@beluga/core/store.js';
import type { Workspace } from '@beluga/workspaces/types.js';
import { findWorkspace, stateOf } from '@beluga/ui/workspace-models.js';
import { type SharedWithPerson, sharedWithWords, worktreeSharedWith } from '@beluga/ui/worktree-share.js';
import { notOnPr, notOnPrLabel } from '@beluga/core/branch-state.js';
import { Icon, type IconName } from '../components/Icon.js';
import { ActionsContext, type ActionItem } from '../components/SpecMenu.js';
import { cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { openSheet } from '../lib/sheets.js';
import { type ReactNode, memo, useEffect, useRef, useState } from 'react';
import { toast, useApp, useBeluga } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import { workspaceSignal } from './attention-model.js';
import { DotMark, LaterMark, SignalMark, nameClass, signalClass } from './signal-marks.js';
import { inSections, isPrStep, toolbarActions } from './toolbar-actions.js';
import { askBeforeWork } from '../lib/work-confirm.js';
import { chatLinkItems } from '../lib/chat-links.js';
import { isPlanAction, runPlanAction } from '../lib/plan-task.js';
import { Row } from './sidebar-parts.js';
import type { RowColor } from '../lib/row-colors.js';
import { triageItems } from './row-triage-actions.js';
import { copyLinkItems } from './worktree-link.js';
import { outsideLocation } from './outside-model.js';
import { useChatSelection } from './chat-selection-view.js';
import { isAgentWorktree } from '../claude-code/subagents-model.js';
import { HarnessMark } from '../threads/HarnessMark.js';
import { FamilyEnd, FamilyMark } from '../threads/FamilyRow.js';
import { threadFamilyRow } from '../threads/threads-model.js';
import { useNow } from '../chat/Items.js';
import { useWorkspaceColor } from './row-color-view.js';
import s from './Sidebar.module.css';
import o from './other-worktrees.module.css';

/**
 * What a workspace's right-click menu offers: its toolbar's actions, named and drawn the same
 * (the shortcuts show for the workspace you're in, where they work).
 */
export function workspaceItems(state: AppState, ws: Workspace, run: ReturnType<typeof useActions>['run'], client: ReturnType<typeof useBeluga>['client'], rename?: () => void, regenerate?: { readonly run: () => void; readonly pending: boolean }, color?: ActionItem): ActionItem[] {
  const { primary, icons, more } = toolbarActions(state, ws);
  const here = state.view.kind === 'workspace' && state.view.id === ws.id;
  const sections = inSections([...(primary ? [primary] : []), ...icons, ...more.flat()]);
  return [
    { label: 'Open', icon: 'chevronRight', onSelect: () => run({ type: 'open_ws', id: ws.id }) },
    // Remind Me Later (and, with the categories on, Settle and the rest).
    ...triageItems(state, `ws:${ws.id}`, run, client),
    ...(renamable(ws) && rename ? [{ label: 'Rename…', icon: 'pencil' as const, onSelect: rename }] : []),
    ...(ws.kind === 'main' ? [] : chatLinkItems(state, client, `ws:${ws.id}`)),
    ...(ws.kind === 'chat' && regenerate ? [{ label: regenerate.pending ? 'Regenerating title…' : 'Regenerate title', icon: 'refresh' as const, disabled: regenerate.pending, onSelect: regenerate.run }] : []),
    // Its colour in the sidebar (a project's, unless it has its own).
    ...(color ? [color] : []),
    // Variables for this worktree alone, over its project's (BLG-924).
    ...(ws.kind === 'worktree' && !ws.archived && !isAgentWorktree(ws) ? [{ label: 'Environment…', icon: 'lock' as const, onSelect: () => openSheet({ kind: 'worktree_env', workspaceId: ws.id }) }] : []),
    // Its link, to mention it in another chat (BLG-878).
    ...copyLinkItems(ws, client).map((item) => ({ ...item, separate: false })),
    ...sections.flatMap((section) =>
      section.map((a, i) => ({
        label: a.label,
        icon: a.icon,
        ...(a.disabled ? { hint: a.hint, disabled: true } : {}),
        ...(here && a.keys ? { keys: a.keys } : {}),
        ...(a.danger ? { danger: true } : {}),
        ...(i === 0 ? { separate: true } : {}),
        onSelect: () => (isPrStep(a.action) ? askBeforeWork(ws.id, a.action) : isPlanAction(a.action) ? runPlanAction(state, ws.id, a.action, run) : run({ type: 'ws', id: ws.id, action: a.action })),
      })),
    ),
  ];
}

/** Chats, and worktrees of yours (a sub-agent's is Claude's): a worktree's branch takes the new name too. */
const renamable = (ws: Workspace): boolean => ws.kind === 'chat' || (ws.kind === 'worktree' && !isAgentWorktree(ws));

/** Rename it, then say what happened to its branch when it isn't what you'd expect. */
function renameWorkspace(client: ReturnType<typeof useBeluga>['client'], ws: Workspace, name: string): void {
  const what = ws.kind === 'worktree' ? 'worktree' : 'chat';
  client.api.workspaces.rename(ws.id, name).then(
    (done) => {
      if (done?.branchKept === 'pushed') toast(client, `Renamed. The branch stays ${done.branch}: it’s pushed already, and its pull request follows that name.`, 'info');
    },
    (err: unknown) => toast(client, err instanceof Error ? err.message : `Cannot rename the ${what}`, 'error'),
  );
}

/** What archiving is doing now, in words. */
const ARCHIVING: Record<NonNullable<AppState['archiving'][string]>, string> = {
  saving: 'Archiving: saving everything of yours',
  compressing: 'Archiving: compressing your ignored files',
  removing: 'Archiving: removing the folder',
};

/** A row's sub-agents and child threads, folded under it or not (SubAgents.tsx): the arrow in its gutter turns them. */
export interface WorkspaceFold {
  readonly open: boolean;
  readonly count: number;
  readonly running: number;
  /** What it holds, for the arrow's name: "sub-agents", "threads". */
  readonly noun: string;
  /** "2 sub-agents · 1 running". */
  readonly summary: string;
  readonly toggle: () => void;
}

/**
 * A chat or worktree in the sidebar. What it waits on sits at the row's right edge: a hand
 * when it needs you (the row faintly tinted), a count and a bold name when Claude finished or
 * someone wrote while you were elsewhere, Claude's pulse while it works; otherwise its git state.
 */
export const WorkspaceRow = memo(function WorkspaceRow({ ws, indent, fold, inFamily }: { ws: Workspace; indent: number; fold?: WorkspaceFold; inFamily?: boolean }) {
  const actions = useActions();
  const { client } = useBeluga();
  const row = useWorkspaceRowActions(ws);
  // Only what the row shows: another conversation streaming doesn't draw it again (KLD-48).
  const { selected, st, signal, where, archiving, gap } = useApp(
    (state) => ({
      selected: state.view.kind === 'workspace' && state.view.id === ws.id,
      st: stateOf(state, ws, 0),
      signal: workspaceSignal(state, ws),
      // Made outside Beluga: where it is, quietly after its name (the full path in the tooltip).
      where: outsideLocation(state, ws),
      // Being archived: how far along (it leaves the sidebar when done).
      archiving: state.archiving[ws.id],
      // Commits its open PR doesn't have yet (BLG-840): a chip, since merging now would leave them out.
      gap: ws.kind === 'worktree' && !ws.archived ? notOnPr(state.prs[ws.id], ws) : undefined,
    }),
    sameDeep,
  );
  // A child thread in its parent's fold: the row a native sub-agent has too (threads/FamilyRow.tsx).
  const family = useApp((state) => (inFamily && ws.thread ? threadFamilyRow(state, ws) : undefined), sameDeep);
  const now = useNow(family?.state === 'running');
  // Shared with someone (a friend, or someone from your room): a small green dot on its icon says so.
  const shared = useApp((state) => (ws.kind === 'main' ? [] : worktreeSharedWith(state, ws.id)), sameDeep);
  const icon: IconName = ws.kind === 'chat' ? 'chat' : ws.kind === 'main' ? 'folder' : 'branch';
  const mark = <HarnessMark ws={ws} />;
  const kindIcon = family ? <FamilyMark row={family} /> : <SharedIcon icon={icon} people={shared} />;
  // Being made: its page opens here (the core has nothing to open yet), with nothing to do on it until it's there.
  if (ws.pending) {
    return (
      <Row
        indent={indent}
        selected={selected}
        className={s.pendingRow}
        aria-label={ws.name}
        aria-busy
        icon={<Icon name={icon} size={14} />}
        label={ws.name}
        detail={ws.forkedFrom ? `${ws.name}: forking ${findWorkspace(client.store.getState().projects, ws.forkedFrom)?.name ?? 'its parent'}…` : `${ws.name}: making the worktree from ${ws.base ?? 'the latest origin'}…`}
        onClick={() => client.store.dispatch({ type: 'view', view: { kind: 'workspace', id: ws.id, tab: 'chat' } })}
        trailing={
          <>
            <span className={s.making} role="progressbar" aria-label="Making the worktree" />
            {mark}
          </>
        }
      />
    );
  }
  // Idle: its git state (uncommitted changes, ready to merge) as before.
  // Put off till later: a quiet clock instead (what waits there shows when it reminds you).
  const quiet = signal.remindAt ? <LaterMark /> : st.tone === 'warn' || st.tone === 'info' || st.tone === 'error' ? <DotMark tone={st.tone} /> : null;
  return (
    <ActionsContext items={row.items}>
      <Row
        indent={indent}
        {...row.props}
        selected={row.inSelection || selected}
        color={row.color}
        className={cx(signalClass(signal, selected), row.className)}
        data-signal-row={signal.level}
        data-kind={ws.kind}
        data-chat-row={ws.kind === 'main' ? undefined : `ws:${ws.id}`}
        // Named for itself alone (so it's found by name whatever it waits on); the tooltip says the rest.
        aria-label={ws.name}
        aria-expanded={fold ? fold.open : undefined}
        icon={
          fold ? (
            <span className={s.foldIcon}>
              <button
                type="button"
                className={s.agentFold}
                aria-label={fold.open ? `Fold the ${fold.noun} of ${ws.name}` : `Show the ${fold.noun} of ${ws.name}`}
                title={fold.open ? `Fold away ${fold.summary}` : `Show ${fold.summary}`}
                onClick={(e) => (e.stopPropagation(), fold.toggle())}
              >
                <Icon name="chevronRight" size={9} className={cx(s.agentDisclosure, fold.open && s.agentDisclosureOpen)} />
              </button>
              {kindIcon}
            </span>
          ) : (
            kindIcon
          )
        }
        onKeyDown={(e) => {
          // ← folds its sub-agents, → shows them (as in Finder's lists).
          if (!fold || e.target !== e.currentTarget || e.metaKey || e.ctrlKey) return;
          if ((e.key === 'ArrowLeft' && fold.open) || (e.key === 'ArrowRight' && !fold.open)) {
            e.preventDefault();
            fold.toggle();
          }
        }}
        label={row.label(
          <>
            <span className={cx(ws.external && s.external, nameClass(signal))}>{ws.name}</span>
            {where ? <span className={o.where}>{where.folder}</span> : null}
          </>,
        )}
        detail={archiving ? `${ws.name}: ${ARCHIVING[archiving]}` : `${ws.name}: ${signal.tip || st.label}${fold ? ` · ${fold.summary}` : ''}${where ? `\n${where.path}` : ''}`}
        onClick={(event) => {
          if (!row.pick(event)) actions.run({ type: 'open_ws', id: ws.id });
        }}
        trailing={
          archiving ? (
            <>
              <span className={s.archiving} data-archiving={archiving}>Archiving…</span>
              {mark}
            </>
          ) : (
            <>
              {ws.startedByAgent ? (
                <span className={s.agentCount} title={`Started by ${ws.startedByAgent.name}, an external agent`} data-driven-by={ws.startedByAgent.id}>
                  <Icon name="plug" size={11} />
                </span>
              ) : null}
              {/* Folded away: how many, quietly (and that one is at work, when the row says nothing else). */}
              {fold && !fold.open ? (
                <span className={s.agentCount} title={fold.summary}>
                  <Icon name="bot" size={11} />
                  {fold.count}
                </span>
              ) : null}
              {gap ? (
                <span className={s.notOnPr} title={notOnPrLabel(gap)} aria-label={notOnPrLabel(gap)} data-not-on-pr={gap.count}>
                  <Icon name="up" size={10} />
                  {gap.count}
                </span>
              ) : null}
              {family ? (
                <FamilyEnd row={family} now={now} />
              ) : (
                <>
                  <SignalMark signal={signal} fallback={gap ? null : quiet} working={ws.kind === 'worktree' ? 'worktree' : 'claude'} />
                  {mark}
                </>
              )}
            </>
          )
        }
      />
    </ActionsContext>
  );
});

/** A row's kind icon, with a small green dot at its corner when it's shared with someone (who, on hover). */
function SharedIcon({ icon, people }: { readonly icon: IconName; readonly people: readonly SharedWithPerson[] }) {
  if (!people.length) return <Icon name={icon} size={14} />;
  const words = sharedWithWords(people);
  return (
    <span className={s.sharedIcon} title={words} data-shared={people.length}>
      <Icon name={icon} size={14} />
      <span className={s.sharedDot} role="img" aria-label={words} />
    </span>
  );
}

/** What a workspace's row does wherever the sidebar draws it (a project's list, the categories): the same menu, Rename…, Regenerate title and shift-click picking. */
export interface WorkspaceRowActions {
  /** One of the chats picked with shift-click. */
  readonly inSelection: boolean;
  /** For its Row: what the shift-click picking finds it by, and whether it's picked. */
  readonly props: { readonly 'data-chat-id'?: string; readonly 'data-chat-selected'?: true; readonly 'aria-pressed'?: boolean };
  /** For its Row, picked: drawn with the others picked next to it as one box. */
  readonly className: string | undefined;
  /** Its right-click menu: the picked chats' when it's one of them. */
  readonly items: () => readonly ActionItem[];
  /** Its name, or the field that edits it while you rename it. */
  readonly label: (name: ReactNode) => ReactNode;
  /** A click on its row: true when shift-click picking took it, so it doesn't open. */
  readonly pick: (event: { readonly shiftKey: boolean; preventDefault: () => void }) => boolean;
  /** The colour you gave it, or its project (unset: plain). */
  readonly color: RowColor | undefined;
}

/** The row behavior every workspace row shares. Without a workspace (a DM, a plan), it has none. */
export function useWorkspaceRowActions(ws: Workspace): WorkspaceRowActions;
export function useWorkspaceRowActions(ws: Workspace | undefined): WorkspaceRowActions | undefined;
export function useWorkspaceRowActions(ws: Workspace | undefined): WorkspaceRowActions | undefined {
  const actions = useActions();
  const { client } = useBeluga();
  const [renaming, setRenaming] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const selection = useChatSelection();
  const color = useWorkspaceColor(ws);
  if (!ws) return undefined;
  const chat = ws.kind === 'chat';
  const inSelection = chat && Boolean(selection?.ids.includes(ws.id));
  const regenerateTitle = async (): Promise<void> => {
    if (regenerating) return;
    setRegenerating(true);
    try {
      await client.api.workspaces.regenerateTitle(ws.id);
      toast(client, 'Chat title regenerated', 'success');
    } catch (err) {
      toast(client, err instanceof Error ? err.message : 'Cannot regenerate the chat title', 'error');
    } finally {
      setRegenerating(false);
    }
  };
  return {
    inSelection,
    color: color.color,
    props: chat ? { 'data-chat-id': ws.id, ...(inSelection ? { 'data-chat-selected': true as const } : {}), 'aria-pressed': inSelection } : {},
    className: inSelection ? s.chatSelected : undefined,
    items: () => (inSelection && selection ? selection.items() : workspaceItems(client.store.getState(), ws, actions.run, client, () => setRenaming(true), { run: () => void regenerateTitle(), pending: regenerating }, color.item)),
    label: (name) =>
      renaming ? (
        <WorkspaceNameField
          initial={ws.name}
          kind={ws.kind === 'worktree' ? 'worktree' : 'chat'}
          onDone={(next) => {
            setRenaming(false);
            if (next !== undefined && next !== ws.name) renameWorkspace(client, ws, next);
          }}
        />
      ) : (
        name
      ),
    pick: (event) => {
      if (!chat || !selection?.click(ws.id, event.shiftKey)) return false;
      event.preventDefault();
      return true;
    },
  };
}

/**
 * Edit the name. Enter or clicking away saves it (as in Finder); Escape, or an empty name, cancels it.
 * A worktree's branch follows (type feature/login for exactly that branch).
 */
function WorkspaceNameField({ initial, kind, onDone }: { initial: string; kind: 'chat' | 'worktree'; onDone: (name: string | undefined) => void }) {
  const [name, setName] = useState(initial);
  const box = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const finish = (value: string | undefined): void => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  useEffect(() => {
    const timer = setTimeout(() => {
      box.current?.focus();
      box.current?.select();
    }, 30);
    return () => clearTimeout(timer);
  }, []);
  return (
    <input
      ref={box}
      className={s.renameField}
      aria-label={kind === 'worktree' ? 'Worktree name' : 'Chat name'}
      title={kind === 'worktree' ? 'Its branch takes the name too. Type a / for an exact branch, like feature/login.' : undefined}
      aria-invalid={!name.trim()}
      value={name}
      maxLength={200}
      spellCheck={false}
      onChange={(e) => setName(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => finish(name.trim() || undefined)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          if (name.trim()) finish(name.trim());
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(undefined);
        }
      }}
    />
  );
}
