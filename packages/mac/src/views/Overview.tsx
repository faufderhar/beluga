import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { Project } from '@beluga/workspaces/types.js';
import { Icon } from '../components/Icon.js';
import { ProjectIcon } from '../components/ProjectIcon.js';
import { SpecContext } from '../components/SpecMenu.js';
import { Button, Empty, EmptyActions } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { toast, useApp, useBeluga } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import { EarningsCard } from './EarningsCard.js';
import { ConversationPeek, DeleteArchivedAlert } from './overview/ConversationPeek.js';
import type { ThreadChildren } from '@beluga/shared/threads.js';
import { FilterBar } from './overview/FilterBar.js';
import { ActiveRow, type ArchivedActions, ArchivedRow } from './overview/OverviewRows.js';
import { DeleteManyAlert } from './overview/DeleteManyAlert.js';
import { NO_PICK, type OverviewPick, keepShown, pickAll, pickable, pickedWords, rangePick, togglePick } from './overview/overview-selection.js';
import type { ActionItem } from '../components/SpecMenu.js';
import { batchCalls } from '../lib/thread-family.js';
import { type OverviewGroup, type OverviewItem, emptyText, filterCounts, groupItems, inFilter, narrow, narrowThere, overviewItems, rowOrder, stepRow } from './overview/overview-model.js';
import { RemoteList } from '../machines/RemoteList.js';
import { useRemoteAttention } from '../machines/remote-attention.js';
import { useOverviewPrefs } from './overview/use-overview-prefs.js';
import s from './overview.module.css';
import { chordLabel, primaryKey } from '../lib/shortcuts-model.js';
import { openFolderThere } from '../lib/remote-open.js';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const sameRows = (a: readonly OverviewItem[], b: readonly OverviewItem[]): boolean => sameDeep(a, b, 3);

/** What the rows share for picking several to delete together. */
interface Picking {
  readonly ids: ReadonlySet<string>;
  readonly onPick: (item: OverviewItem, how: 'toggle' | 'range') => boolean;
  readonly items: () => readonly ActionItem[];
}

/**
 * Every worktree and chat at a glance, archived ones too, grouped by project: what needs you
 * comes first. Narrow it by segment, project and search (⌘F); ↑↓ move, Return opens, Space
 * reads an archived conversation, ⌘⌫ deletes one (after asking). ⌘-click, Shift-click and ⌘A
 * pick several rows, live or archived, to delete together (⌘⌫ or the bar's Delete, asked once).
 */
export function OverviewView() {
  const actions = useActions();
  const { client } = useBeluga();
  const api = client.api;
  // The rows as they read: drawn again when one of them changes, not on every streamed step.
  const all = useApp(overviewItems, sameRows);
  const [prefs, setPrefs] = useOverviewPrefs();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string>();
  const [peek, setPeek] = useState<string>();
  const [deleting, setDeleting] = useState<string>();
  const [restoring, setRestoring] = useState<string>();
  const [pick, setPick] = useState<OverviewPick>(NO_PICK);
  const [deletingMany, setDeletingMany] = useState<readonly string[]>();
  const [removing, setRemoving] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const projects = useMemo(() => [...new Map(all.map((i) => [i.project.id, i.project])).values()], [all]);
  // A project that's gone (removed, hidden) means all of them again.
  const project = projects.find((p) => p.id === prefs.project);
  const narrowed = narrow(all, project?.id, search);
  // Every computer's too (BLG-843): what needs you there, from the same source as the bell, tagged.
  const remote = useRemoteAttention();
  const there = useMemo(() => remote.flatMap((r) => narrowThere(r.needs, project?.name, search).map((item) => ({ machine: r.machine, item: { id: item.id, title: item.title, sub: `${item.project} · ${item.why}`, page: item.page }, offline: false }))), [remote, project?.name, search]);
  const here = filterCounts(narrowed);
  const counts = { ...here, needs: here.needs + there.length };
  const groups = groupItems(
    narrowed.filter((i) => inFilter(i, prefs.filter)),
    prefs.sort,
  );
  const order = rowOrder(groups);
  const current = selected && order.includes(selected) ? selected : order[0];
  const find = (id: string | undefined): OverviewItem | undefined => (id ? all.find((i) => i.ws.id === id) : undefined);
  const peekItem = find(peek);
  const deleteItem = find(deleting);
  // What can be picked (not a plan, nor another tool's worktree); rows filtered, searched or deleted away are no longer picked.
  const can = new Set(groups.flatMap((g) => [...g.active, ...g.archived]).filter(pickable).map((i) => i.ws.id));
  const picked = keepShown(pick, order);
  const pickedIds = new Set(picked.ids);
  const pickedItems = picked.ids.flatMap((id) => find(id) ?? []);
  const deleteManyItems = (deletingMany ?? []).flatMap((id) => find(id) ?? []);

  // ⌘F: the search field (the Find menu item is off here, so the key comes to the window).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (!primaryKey(e) || e.shiftKey || e.altKey || (e.metaKey && e.ctrlKey) || e.key.toLowerCase() !== 'f') return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  const focusRow = (id: string | undefined): void => {
    if (!id) return;
    setSelected(id);
    listRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`)?.focus();
  };

  const act: ArchivedActions = {
    restoring,
    restore: (item) => {
      setPeek(undefined);
      setRestoring(item.ws.id);
      // The core opens it once it's back (and says so if it couldn't).
      api.workspaces
        .restore(item.ws.id)
        .catch((err: unknown) => toast(client, `Couldn’t restore ${item.ws.name}: ${errorText(err)}`, 'error'))
        .finally(() => setRestoring(undefined));
    },
    read: (item) => setPeek(item.ws.id),
    finder: (item) => void openFolderThere(client, item.project.root).catch((err: unknown) => toast(client, `Couldn’t open the folder: ${errorText(err)}`, 'error')),
    remove: (item) => setDeleting(item.ws.id),
  };
  const open = (item: OverviewItem): void => {
    // A plain click is about that one row: the others aren't picked any more.
    setPick((p) => (p.ids.length ? NO_PICK : p));
    if (item.archived) act.read(item);
    else if (item.plan) actions.run({ type: 'view', view: { kind: 'plan', id: item.plan.plan.id } });
    else actions.run({ type: 'open_ws', id: item.ws.id });
  };
  const remove = (item: OverviewItem, children?: ThreadChildren): void => {
    setDeleting(undefined);
    setPeek(undefined);
    (children ? api.workspaces.remove(item.ws.id, { children }) : api.workspaces.remove(item.ws.id)).catch((err: unknown) => toast(client, `Couldn’t delete ${item.ws.name}: ${errorText(err)}`, 'error'));
  };

  /**
   * Delete the picked rows: asked all at once (Beluga does the disk work behind them), quietly,
   * then one message for the lot. What's still there afterwards failed: it stays picked, named.
   */
  const removeMany = async (items: readonly OverviewItem[], children?: ThreadChildren): Promise<void> => {
    setDeletingMany(undefined);
    setRemoving(true);
    try {
      const calls = new Set(batchCalls(client.store.getState(), items.map((i) => i.ws.id), children));
      const why = new Map<string, string>();
      await Promise.all(
        items
          .filter((i) => calls.has(i.ws.id))
          .map((i) => api.workspaces.remove(i.ws.id, { quiet: true, ...(children ? { children } : {}) }).catch((err: unknown) => void why.set(i.ws.id, errorText(err)))),
      );
      // Remove reports no result: what's still listed didn't go.
      const left = new Set(client.store.getState().projects.flatMap((p) => p.workspaces.map((w) => w.id)));
      const failed = items.filter((i) => left.has(i.ws.id));
      if (failed.length) {
        setPick({ ids: failed.map((i) => i.ws.id) });
        toast(client, `Couldn’t delete ${failed.length === items.length ? (items.length === 1 ? 'it' : 'any of them') : pickedWords(failed)}: ${failed.map((i) => `${i.ws.name}${why.has(i.ws.id) ? ` (${why.get(i.ws.id)})` : ''}`).join(', ')}`, 'error');
      } else {
        setPick(NO_PICK);
        toast(client, `Deleted ${pickedWords(items)}.`, 'success');
      }
    } finally {
      setRemoving(false);
    }
  };
  const askDeleteMany = (): void => {
    if (picked.ids.length && !removing) setDeletingMany(picked.ids);
  };
  const picking: Picking = {
    ids: pickedIds,
    onPick: (item, how) => {
      const id = item.ws.id;
      setPick((p) => (how === 'range' ? rangePick(keepShown(p, order), order, can, id, current) : togglePick(keepShown(p, order), order, can, id)));
      setSelected(id);
      return true;
    },
    items: () => [
      { label: `Delete ${pickedWords(pickedItems)}…`, icon: 'x', danger: true, keys: chordLabel('Cmd+Backspace'), disabled: removing, onSelect: askDeleteMany },
      { label: 'Deselect All', icon: 'x', keys: 'Esc', onSelect: () => setPick(NO_PICK) },
    ],
  };

  const onListKey = (e: KeyboardEvent): void => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-row]');
    const item = find(row?.dataset.row);
    if (e.key.toLowerCase() === 'a' && primaryKey(e) && !e.shiftKey && !e.altKey && row) {
      e.preventDefault();
      setPick(pickAll(order, can));
      return;
    }
    if (e.key === 'Escape' && picked.ids.length) {
      e.preventDefault();
      setPick(NO_PICK);
      return;
    }
    if (e.key === 'Backspace' && primaryKey(e) && picked.ids.length) {
      e.preventDefault();
      askDeleteMany();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      if (!row) return;
      e.preventDefault();
      // ↑ on the first row goes back up to the search.
      if (e.key === 'ArrowUp' && order[0] === row.dataset.row) return searchRef.current?.focus();
      focusRow(stepRow(order, row.dataset.row, e.key));
    } else if (e.key === ' ' && item?.archived && e.target === row) {
      e.preventDefault();
      act.read(item);
    } else if (e.key === 'Backspace' && primaryKey(e) && item?.archived) {
      e.preventDefault();
      act.remove(item);
    }
  };

  if (!all.length) return <NothingYet />;
  const searching = search.trim().length > 0;
  return (
    <div className={s.pane}>
      <FilterBar
        filter={prefs.filter}
        counts={counts}
        onFilter={(filter) => setPrefs({ filter })}
        search={search}
        onSearch={setSearch}
        searchRef={searchRef}
        onLeaveSearch={() => (order.length ? focusRow(current) : searchRef.current?.blur())}
        sort={prefs.sort}
        onSort={(sort) => setPrefs({ sort })}
        projects={projects}
        project={project}
        onProject={(id) => setPrefs({ project: id })}
      />
      {!searching && !project && (prefs.filter === 'all' || prefs.filter === 'active') ? <EarningsCard /> : null}
      <div ref={listRef} onKeyDown={onListKey}>
        {prefs.filter === 'needs' && there.length ? <RemoteList title="Needs you on your computers" rows={there} /> : null}
        {groups.length || (prefs.filter === 'needs' && there.length) ? (
          groups.map((g) => <Group key={g.project.id} group={g} filter={prefs.filter} current={current} onSelect={setSelected} onOpen={open} act={act} picking={picking} />)
        ) : (
          <NothingHere
            search={searching ? search.trim() : undefined}
            filter={prefs.filter}
            project={project}
            onClearSearch={() => setSearch('')}
            onAllProjects={() => setPrefs({ project: undefined })}
            onShowAll={() => setPrefs({ filter: 'all' })}
            othersHere={counts.all > 0}
          />
        )}
      </div>
      {picked.ids.length ? (
        <footer className={s.bar} role="toolbar" aria-label="Selected workspaces">
          <span className={s.barText}>
            {pickedWords(pickedItems)} selected{removing ? ' · Deleting…' : ''}
          </span>
          <Button size="small" variant="quiet" onClick={() => setPick(NO_PICK)} disabled={removing}>
            Deselect
          </Button>
          <Button size="small" variant="danger" icon="x" onClick={askDeleteMany} disabled={removing}>
            Delete…
          </Button>
        </footer>
      ) : null}
      {deleteManyItems.length ? <DeleteManyAlert items={deleteManyItems} onCancel={() => setDeletingMany(undefined)} onDelete={(children) => void removeMany(deleteManyItems, children)} /> : null}
      {peekItem ? <ConversationPeek item={peekItem} onClose={() => setPeek(undefined)} onRestore={() => act.restore(peekItem)} onDelete={() => act.remove(peekItem)} /> : null}
      {deleteItem ? <DeleteArchivedAlert item={deleteItem} onCancel={() => setDeleting(undefined)} onDelete={(children) => remove(deleteItem, children)} /> : null}
    </div>
  );
}

const projectName = (p: Project): string => (p.root ? p.name : 'Chats');

/** One project: its icon, name and count, its live rows, then its archived ones under a quiet heading. */
function Group({ group, filter, current, onSelect, onOpen, act, picking }: { group: OverviewGroup; filter: string; current: string | undefined; onSelect: (id: string) => void; onOpen: (i: OverviewItem) => void; act: ArchivedActions; picking: Picking }) {
  const actions = useActions();
  const { project: p, active, archived } = group;
  const now = Date.now();
  const name = projectName(p);
  const title = (
    <h2 className={s.groupTitle}>
      <span className={s.groupIcon}>{p.root ? <ProjectIcon id={p.id} name={p.name} size={18} /> : <Icon name="chat" size={15} />}</span>
      {name}
      <span className={s.count}>{active.length + archived.length}</span>
      <span className={s.groupActions}>
        <Button size="small" variant="quiet" icon={p.root ? 'branch' : 'plus'} onClick={() => actions.run(p.root ? { type: 'new_worktree', projectId: p.id } : { type: 'new_chat', projectId: 'chats' })}>
          {p.root ? 'New Worktree' : 'New Chat'}
        </Button>
      </span>
    </h2>
  );
  return (
    <section className={s.group} aria-label={name}>
      {p.root ? <SpecContext menu={{ kind: 'project', id: p.id }}>{title}</SpecContext> : title}
      {active.length ? (
        <div className={s.table} role="list" aria-label={`${name}: workspaces`}>
          {active.map((i) => (
            <ActiveRow key={i.ws.id} item={i} now={now} selected={i.ws.id === current} onSelect={onSelect} onOpen={onOpen} picked={picking.ids.has(i.ws.id)} onPick={picking.onPick} pickedItems={picking.items} />
          ))}
        </div>
      ) : null}
      {archived.length ? (
        <>
          {filter !== 'archived' ? (
            <h3 className={s.subhead}>
              <Icon name="archive" size={12} />
              Archived
              <span className={s.count}>{archived.length}</span>
            </h3>
          ) : null}
          <div className={s.table} role="list" aria-label={`${name}: archived`}>
            {archived.map((i) => (
              <ArchivedRow key={i.ws.id} item={i} selected={i.ws.id === current} onSelect={onSelect} onOpen={onOpen} act={act} picked={picking.ids.has(i.ws.id)} onPick={picking.onPick} pickedItems={picking.items} />
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

/** Nothing matches: say why, and offer the way back. */
function NothingHere({ search, filter, project, othersHere, onClearSearch, onAllProjects, onShowAll }: { search: string | undefined; filter: Parameters<typeof emptyText>[0]; project: Project | undefined; othersHere: boolean; onClearSearch: () => void; onAllProjects: () => void; onShowAll: () => void }) {
  if (search) {
    return (
      <Empty
        icon="search"
        title={`No results for “${search}”`}
        detail={`Nothing${project ? ` in ${projectName(project)}` : ''} has that in its name, branch or last message${filter === 'all' ? '' : ' here'}.`}
        action={
          <EmptyActions>
            <Button size="small" onClick={onClearSearch}>Clear Search</Button>
            {filter !== 'all' && othersHere ? <Button size="small" variant="quiet" onClick={onShowAll}>Show All</Button> : null}
            {project ? <Button size="small" variant="quiet" onClick={onAllProjects}>All Projects</Button> : null}
          </EmptyActions>
        }
      />
    );
  }
  const text = emptyText(filter, project ? projectName(project) : undefined);
  const icon = filter === 'archived' ? 'archive' : filter === 'needs' ? 'check' : filter === 'ready' ? 'merge' : 'grid';
  return (
    <Empty
      icon={icon}
      title={text.title}
      detail={text.detail}
      action={project ? <EmptyActions><Button size="small" onClick={onAllProjects}>Show All Projects</Button></EmptyActions> : undefined}
    />
  );
}

/** No workspaces at all: what this is, and the one action that fills it. */
function NothingYet() {
  const actions = useActions();
  const project = useApp((st) => st.projects.find((p) => p.root));
  return (
    <Empty
      icon="grid"
      title="No workspaces yet"
      detail={project ? `Start a worktree in ${project.name}: its own branch, with your agent on your task.` : 'Add your projects, then give your agent a task in a worktree of its own.'}
      action={
        <EmptyActions>
          {project ? (
            <Button size="small" variant="primary" icon="branch" onClick={() => actions.run({ type: 'new_worktree', projectId: project.id })}>
              New Worktree
            </Button>
          ) : (
            <Button size="small" variant="primary" icon="plus" onClick={() => actions.run({ type: 'add_project' })}>
              Add Projects…
            </Button>
          )}
          <Button size="small" icon="chat" onClick={() => actions.run({ type: 'new_chat', projectId: 'chats' })}>
            New Chat
          </Button>
        </EmptyActions>
      }
    />
  );
}
