import { baseName } from '@beluga/shared/os-path.js';
import { Fragment, memo, useEffect, useMemo, useRef } from 'react';
import type { Project } from '@beluga/workspaces/types.js';
import { worktreeOrigin } from '@beluga/workspaces/origin.js';
import { isPlanOwned, planConversations, planOfPlace } from '@beluga/core/plans/owner.js';
import type { UiAction } from '@beluga/ui/workspace-models.js';
import { setOverviewView } from '../views/overview/use-overview-prefs.js';
import { Icon } from '../components/Icon.js';
import { ActionsContext, ActionsDropdown, SpecContext, SpecDropdown, type ActionItem } from '../components/SpecMenu.js';
import { ProjectIcon } from '../components/ProjectIcon.js';
import { EarningsPill } from '../components/EarningsPill.js';
import { earningsMenuItem } from '../lib/earnings.js';
import { Badge, Dot, IconButton, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { inApp, webServed } from '../lib/boot.js';
import { newEmptyGroup, useGroupEdit } from '../lib/group-edit.js';
import { useApi, useApp, useBeluga, useUi } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import { openProjectHome } from '../lib/project-home.js';
import { openSheet } from '../lib/sheets.js';
import { getPrefs, setPrefs, usePrefs } from '../lib/prefs.js';
import { pickImage, reloadProjectIcon } from '../lib/projects.js';
import { showUndo } from '../lib/undo-toast.js';
import { useArrangeDrag } from './arrange-drag.js';
import { GroupHeader, NewGroupRow, groupItems, isGroupOption, moveItems, moveKey } from './ProjectGroups.js';
import { type Entry, type Place, type Target, keyOfEntry, stepOf, useArrange, useLayout } from './project-layout.js';
import { OutsideWorktrees } from './OtherWorktrees.js';
import { ProjectAgents, WorkspaceWithAgents, useAgentOrigins, useCcSessions } from './SubAgents.js';
import { hasRowsInside } from './project-rows.js';
import { threadNesting } from '../threads/threads-model.js';
import { type Tally, groupTally, groupWorking, projectPlans, projectTally, projectWorking, tallyTip } from './attention-model.js';
import { TallyMark } from './signal-marks.js';
import { Row } from './sidebar-parts.js';
import { WorkspaceRow } from './workspace-row.js';
import { RemoteProjects, RemoteWorkRows } from '../machines/RemoteRows.js';
import { useRemoteSources } from '../machines/use-remote.js';
import { remoteWorkIn } from '../machines/remote-work.js';
import { PlanRow } from './plan-row.js';
import { LaterRows, laterOf, notLater, useLater } from './later-rows.js';
import { useGitHubMenuItems } from '../views/project/GitHubRow.js';
import { TeamBadge, useTeamMenuItems } from '../team/Team.js';
import side from './Sidebar.module.css';
import s from './project-groups.module.css';
import { shortcutKeys } from '../lib/shortcuts.js';

/**
 * The sidebar's Projects, arranged the way you like: drag projects and groups to reorder them,
 * drop a project on a group (or between its projects) to put it there, or out to the top level.
 * Projects and the groups you make fold; a folded project still shows the item you are in.
 */

type Arrange = (item: Target, place: Place) => void;

/** Spec options the sidebar does its own way (groups as a submenu; Hide with Undo, not an alert). */
const ownWay = (id: string): boolean => isGroupOption(id) || id === 'p-hide';

/** A folder hovered while you drag a project into it opens after a moment (spring-loaded, as in Finder). */
const SPRING_MS = 700;

/** Hide a project, with Undo (it comes back where it was). */
function useHide(): (p: Project) => void {
  const api = useApi();
  const { client } = useBeluga();
  return (p) => {
    void api.workspaces.hideProject(p.id).then(() => {
      // The core's note says how to bring it back from the terminal; here Undo does.
      const note = client.store.getState().toast;
      if (note?.text.startsWith('Project hidden')) client.store.dispatch({ type: 'toast_clear', id: note.id });
      showUndo(`Hidden ${p.name}`, () => void api.workspaces.showProject(p.root));
    });
  };
}

/** "Change Icon…" for a project, and going back to the one it ships. */
function useIconItems(p: Project): readonly ActionItem[] {
  const api = useApi();
  const { client } = useBeluga();
  const change = async (image: string | undefined): Promise<void> => {
    try {
      await api.projects.setIcon(p.id, image);
      reloadProjectIcon(p.id);
    } catch (err) {
      client.store.dispatch({ type: 'toast', text: err instanceof Error ? err.message : String(err), level: 'error' });
    }
  };
  return [
    {
      label: 'Change Icon…',
      separate: true,
      onSelect: () => {
        void pickImage(`An icon for ${p.name}`).then((image) => (image ? change(image) : undefined));
      },
      disabled: !inApp() && !webServed(),
    },
    { label: 'Use the Project’s Own Icon', onSelect: () => void change(undefined) },
  ];
}

/** The Overview, narrowed to a project's archived work (or the archived chats). */
export function showArchivedOf(run: (a: UiAction) => void, projectId: string): void {
  setOverviewView({ filter: 'archived', project: projectId });
  run({ type: 'view', view: { kind: 'overview' } });
}

/**
 * Fold or unfold a project; with Option, every project (as Finder's Option-click does).
 * Projects start folded; the ones you unfold stay unfolded (kept on this Mac). Folding keeps
 * the item you're in visible under it until you go somewhere else.
 */
function useProjectFold(projectId: string): { folded: boolean; toggle: (all: boolean) => void; peek: () => void } {
  const { ui } = useBeluga();
  const open = usePrefs().openProjects.includes(projectId);
  const peeked = useUi((u) => u.peek === projectId);
  const folded = !open && !peeked;
  const projects = useApp((st) => st.projects);
  const view = useApp((st) => st.view);
  const planHere = useApp(({ view: v, plans }) => v.kind === 'plan' && plans.plans.some((x) => x.id === v.id && x.projectId === projectId));
  const project = projects.find((x) => x.id === projectId);
  const setOpen = (on: boolean, ids = [projectId]): void => {
    const rest = getPrefs().openProjects.filter((k) => !ids.includes(k));
    setPrefs({ openProjects: on ? [...rest, ...ids] : rest });
  };
  const toggle = (all: boolean): void => {
    // Folding or unfolding by hand: it stays the way you put it.
    if (ui.get().peek === projectId) ui.patch({ peek: undefined });
    setOpen(folded, all ? projects.filter((x) => x.root).map((x) => x.id) : undefined);
  };
  // Clicking the project's row: it unfolds (only until you go somewhere else, unless you open what's in it).
  const peek = (): void => {
    if (folded) ui.patch({ peek: projectId });
  };
  const at = view.kind === 'workspace' ? `ws:${view.id}` : view.kind === 'project' ? `project:${view.id}` : view.kind === 'plan' ? `plan:${view.id}` : view.kind;
  useEffect(() => {
    if (!peeked) return;
    if (at === `project:${projectId}`) return;
    ui.patch({ peek: undefined });
    // You opened one of its worktrees, chats or plans: it stays open. Anywhere else: it folds again.
    const inside = (at.startsWith('ws:') && project?.workspaces.some((w) => `ws:${w.id}` === at)) || planHere;
    if (inside) setOpen(true);
  }, [at, peeked]);
  return { folded, toggle, peek };
}

/**
 * A project and its worktrees and chats (folded: only the one you're in). `depth` 1: inside a group.
 * It reads only what it draws from the store (and is memo'd), so an open menu on it isn't rebuilt
 * on every unrelated change.
 */
const ProjectBlock = memo(function ProjectBlock({ p, depth, entries, arrange }: { p: Project; depth: 0 | 1; entries: readonly Entry[]; arrange: Arrange }) {
  const actions = useActions();
  const { client } = useBeluga();
  const view = useApp((st) => st.view);
  // Only the plans and the board (not the whole state): an open menu here isn't rebuilt on every change.
  const plansState = useApp((st) => st.plans);
  const board = useApp((st) => st.board);
  const state = useMemo(() => ({ plans: plansState, board }), [plansState, board]);
  const putOff = useLater();
  const earning = useApp((st) => Boolean(st.earnings[p.root] || st.revenuecat[p.root]));
  const busy = useApp((st) => projectWorking(st, p));
  // What's inside: how many conversations have news, and whether one needs you (folded, it's how you notice).
  const tallyKey = useApp((st) => {
    const t = projectTally(st, p);
    return `${t.unread}:${t.needs}:${t.working ? 1 : 0}`;
  });
  const inside = useMemo((): Tally => {
    const [unread, needs, working] = tallyKey.split(':').map(Number);
    return { unread: unread ?? 0, needs: needs ?? 0, working: working === 1 };
  }, [tallyKey]);
  const fold = useProjectFold(p.id);
  const here = view.kind === 'workspace' ? view.id : undefined;
  const onHome = view.kind === 'project' && view.id === p.id;
  const hide = useHide();
  const iconItems = useIconItems(p);
  const insideTip = tallyTip(inside);
  const live = p.workspaces.filter((w) => !w.archived);
  // Not the main checkout (work happens in worktrees); questions asked in its folder stay, as chats.
  // A plan is one row: its conversation and its tasks' worktrees stay off the tree (they're reached
  // from the plan). A finished plan's conversation shows only while you're in it.
  const plans = projectPlans(state, p);
  const planHomes = new Set(plansState.plans.map((x) => x.home));
  // A plan you asked to show its tasks' chats: they sit under its row (its home is the plan's page).
  const showTasks = usePrefs().planTaskChats;
  const taskChats = (planId: string) => (showTasks.includes(planId) ? live.filter((w) => !planHomes.has(`ws:${w.id}`) && planConversations(state, planId).includes(w.id)) : []);
  // A child thread sits under its parent's row (SubAgents.tsx), not here.
  const { nested } = useApp(threadNesting);
  const mine = live.filter((w) => w.kind !== 'main' && worktreeOrigin(w) === 'beluga' && !isPlanOwned(state, w.id) && (!planHomes.has(`ws:${w.id}`) || w.id === here) && !nested.has(w.id) && notLater(putOff, w));
  // Put off till later (Remind Me Later): folded at the bottom, back in place once it reminds you. A child thread too: back under its parent then.
  const later = laterOf(putOff, live.filter((w) => w.kind !== 'main' && !isPlanOwned(state, w.id) && !planHomes.has(`ws:${w.id}`)));
  const inPlan = planOfPlace(plansState, board, view);
  // You're in this project: on its home page, in one of its worktrees or chats, or in one of its plans.
  const current = onHome || (here !== undefined && p.workspaces.some((w) => w.id === here)) || plans.some((x) => x.id === inPlan);
  const main = live.find((w) => w.kind === 'main');
  const archived = p.workspaces.filter((w) => w.archived);
  const item: Target = { project: p.id };
  const githubItems = useGitHubMenuItems(p.id, Boolean(p.root));
  // Friends on the same GitHub repository you teamed up with (core/team).
  const teamItems = useTeamMenuItems(p.id);
  // Archived work stays out of the sidebar: the Overview's Archived list has it.
  const showArchivedItem: ActionItem[] = archived.length ? [{ label: `Show Archived (${archived.length})`, onSelect: () => showArchivedOf(actions.run, p.id) }] : [];
  // Everything about its worktrees (archiving, restoring, cleaning up those made outside Beluga) is on the Worktrees page.
  const cleanUpItem: ActionItem[] = p.workspaces.some((w) => w.kind === 'worktree') ? [{ label: 'Manage Worktrees…', onSelect: () => actions.run({ type: 'view', view: { kind: 'worktrees', projectId: p.id } }) }] : [];
  // Share with friends over the network (nobody hosts): it shows in their Projects with your avatar.
  const shareItem: ActionItem[] = p.root ? [{ label: 'Share with…', icon: 'people', separate: true, onSelect: () => openSheet({ kind: 'share_project', projectId: p.id }) }] : [];
  // A conversation had with Claude Code outside Beluga, continued in a new worktree (BLG-321).
  const importItem: ActionItem[] = p.root ? [{ label: 'Import from Claude Code…', icon: 'claude', onSelect: () => openSheet({ kind: 'import_conversation', projectId: p.id }) }] : [];
  // Its variables and its main folder's .env, without going through Settings (BLG-369).
  const envItem: ActionItem[] = p.root ? [{ label: 'Environment…', icon: 'lock', onSelect: () => openSheet({ kind: 'project_env', projectId: p.id }) }] : [];
  const extra: ActionItem[] = [...shareItem, ...teamItems, ...importItem, ...envItem, ...showArchivedItem, ...cleanUpItem, ...moveItems(entries, item, arrange), ...groupItems(p, entries, arrange), earningsMenuItem(p, earning), ...githubItems, ...iconItems, { label: 'Hide Project', danger: true, separate: true, onSelect: () => hide(p) }, { label: 'Delete Project…', danger: true, onSelect: () => openSheet({ kind: 'delete_project', projectId: p.id }) }];
  const kids = depth + 2;
  // Nothing to unfold: no arrow (its place kept, so the icons stay in line).
  const sessions = useCcSessions();
  const origins = useAgentOrigins();
  const remote = useRemoteSources();
  const elsewhere = useMemo(() => remoteWorkIn(p.name, remote).length > 0, [p.name, remote]);
  const foldable = useMemo(() => plans.length > 0 || elsewhere || hasRowsInside(p, sessions, origins), [plans.length, elsewhere, p, sessions, origins]);
  return (
    <div data-chats-folded={fold.folded || undefined}>
      <SpecContext menu={{ kind: 'project', id: p.id }} extra={extra} hide={ownWay}>
        <Row
          data-drag={`project:${p.id}`}
          indent={depth}
          selected={onHome}
          className={cx(side.projectRow, current && side.currentProject)}
          data-current={current || undefined}
          aria-expanded={foldable ? !fold.folded : undefined}
          aria-label={p.name}
          icon={
            <span className={s.projectIcon}>
              {foldable ? (
                <button
                  type="button"
                  className={s.foldButton}
                  aria-label={fold.folded ? `Show what's in ${p.name}` : `Fold ${p.name}`}
                  title={fold.folded ? 'Show (Option-click: every project)' : 'Fold (Option-click: every project)'}
                  onClick={(e) => (e.stopPropagation(), fold.toggle(e.altKey))}
                >
                  <Icon name="chevronRight" size={9} className={cx(s.disclosure, !fold.folded && s.disclosureOpen)} />
                </button>
              ) : (
                <span className={s.foldButton} aria-hidden="true" />
              )}
              <ProjectIcon id={p.id} name={p.name} size={16} />
            </span>
          }
          label={p.name}
          detail={insideTip ? `${p.name}: ${insideTip}` : p.root}
          onClick={() => {
            openProjectHome(actions.run, client.store.getState(), p.id);
            fold.peek();
          }}
          onKeyDown={(e) => {
            // ← folds, → unfolds (as in Finder's lists).
            if (foldable && e.target === e.currentTarget && !e.metaKey && !e.ctrlKey && ((e.key === 'ArrowLeft' && !fold.folded) || (e.key === 'ArrowRight' && fold.folded))) {
              e.preventDefault();
              fold.toggle(e.altKey);
              return;
            }
            const dir = moveKey(e);
            if (!dir || e.target !== e.currentTarget) return;
            e.preventDefault();
            const place = stepOf(entries, item, dir);
            if (place) arrange(item, place);
          }}
          trailing={
            <>
              <TeamBadge projectId={p.id} />
              <EarningsPill root={p.root} projectId={p.id} celebrate />
              <span className={side.hoverTools}>
                <IconButton icon="branch" label={`New worktree in ${p.name}`} onClick={(e) => (e.stopPropagation(), actions.run({ type: 'new_worktree', projectId: p.id }))} />
                <IconButton icon="plus" label={`New chat in ${p.name}`} onClick={(e) => (e.stopPropagation(), actions.run({ type: 'new_chat', projectId: p.id }))} />
                <SpecDropdown menu={{ kind: 'project', id: p.id }} align="end" extra={extra} hide={ownWay}>
                  <IconButton icon="more" label={`More for ${p.name}`} onClick={(e) => e.stopPropagation()} />
                </SpecDropdown>
                {/* Claude at work inside, beside what needs you or what's new (never hidden by them). */}
                {busy ? (
                  <span className={side.status} data-busy>
                    <Dot tone="claude" live />
                  </span>
                ) : null}
                <TallyMark tally={inside} folded={fold.folded} />
              </span>
            </>
          }
        />
      </SpecContext>
      {fold.folded ? (
        // Folded: only the item you're in stays (its plan, when it's part of one), until you go elsewhere.
        <>
          {plans.filter((x) => x.id === inPlan).map((x) => <PlanRow key={x.id} plan={x} indent={kids} />)}
          {live.filter((w) => w.id === here && w.kind !== 'main' && !isPlanOwned(state, w.id)).map((w) => <WorkspaceRow key={w.id} ws={w} indent={kids} />)}
          <RemoteWorkRows name={p.name} indent={kids} onlyHere />
        </>
      ) : (
        <>
          {plans.map((x) => (
            <Fragment key={x.id}>
              <PlanRow plan={x} indent={kids} />
              {taskChats(x.id).map((w) => (
                <WorkspaceWithAgents key={w.id} ws={w} indent={kids + 1} />
              ))}
            </Fragment>
          ))}
          {mine.map((w) => (
            <WorkspaceWithAgents key={w.id} ws={w} indent={kids} />
          ))}
          {/* Worktrees made outside Beluga: after Beluga's own, most recent first, each with where it is. */}
          <OutsideWorktrees p={p} indent={kids} />
          {/* The same project's worktrees and chats on your computers, each with its computer (BLG-785). */}
          <RemoteWorkRows name={p.name} indent={kids} />
          {/* Sub-agents the main folder's conversations started (Claude's helpers, none of your worktrees or chats): behind one row. */}
          {main ? <ProjectAgents p={p} ws={main} indent={kids} /> : null}
          <LaterRows list={later} indent={kids} foldKey={`later:${p.id}`} />
        </>
      )}
    </div>
  );
});

/** Projects you hid, folded at the bottom: each with Show. */
function HiddenProjects() {
  const actions = useActions();
  const api = useApi();
  const hidden = useApp((st) => st.hiddenProjects);
  const open = useUi((u) => u.collapsed.includes('hidden-projects'));
  if (!hidden.length) return null;
  return (
    <div className={s.hidden}>
      <Row
        className={side.fold}
        aria-expanded={open}
        icon={
          <span className={s.groupIcon}>
            <Icon name="chevronRight" size={9} className={cx(s.disclosure, open && s.disclosureOpen)} />
            <Icon name="eyeOff" size={14} className={s.folder} />
          </span>
        }
        label="Hidden Projects"
        trailing={<span className={s.count}>{hidden.length}</span>}
        onClick={() => actions.run({ type: 'toggle_fold', key: 'hidden-projects' })}
      />
      {open
        ? hidden.map((root) => {
            const name = baseName(root) || root;
            return (
              <Row
                key={root}
                indent={1}
                className={s.hiddenRow}
                icon={
                  <span className={s.projectIcon}>
                    <ProjectIcon id={`path:${root}`} name={name} size={16} />
                  </span>
                }
                label={name}
                detail={root}
                trailing={
                  <button type="button" className={s.show} aria-label={`Show ${name}`} onClick={() => void api.workspaces.showProject(root)}>
                    Show
                  </button>
                }
              />
            );
          })
        : null}
    </div>
  );
}

/** The + on the Projects heading: add projects, or make a group. */
export function ProjectsAddMenu() {
  const actions = useActions();
  const { ui } = useBeluga();
  const items: ActionItem[] = [
    { label: 'Add Projects…', keys: shortcutKeys('add-project'), onSelect: () => actions.run({ type: 'add_project' }) },
    { label: 'New Project…', onSelect: () => ui.patch({ addProject: 'new' }) },
    { label: 'Clone from Git…', onSelect: () => ui.patch({ addProject: 'clone' }) },
    { label: 'New Group', onSelect: () => newEmptyGroup() },
  ];
  return (
    <ActionsDropdown items={items}>
      <IconButton icon="plus" label="Add a project, start one, clone one, or make a group" />
    </ActionsDropdown>
  );
}

/** Opens a folded group you hold a project over for a moment. */
function useSpringLoad(group: string | undefined, folded: boolean): void {
  const actions = useActions();
  useEffect(() => {
    if (!group || !folded) return;
    const t = setTimeout(() => actions.run({ type: 'toggle_group', name: group }), SPRING_MS);
    return () => clearTimeout(t);
  }, [group, folded]);
}

export function Projects() {
  const actions = useActions();
  const names = useApp((st) => st.projects.map((p) => p.name).join('\n'));
  const localNames = useMemo(() => new Set(names.split('\n')), [names]);
  const { ui } = useBeluga();
  const { entries } = useLayout();
  const arrange = useArrange();
  const tree = useRef<HTMLDivElement>(null);
  const collapsed = useUi((u) => u.collapsed);
  // Each group's pulse and counts, not the whole state: the tree isn't drawn again on every streamed event (KLD-48).
  const groups = useApp((st) => Object.fromEntries(entries.flatMap((e) => (e.kind === 'group' ? [[e.name, { busy: groupWorking(st, e.projects), tally: groupTally(st, e.projects) }]] : []))), sameDeep);
  const { creating } = useGroupEdit();
  const { dragging, onPointerDown } = useArrangeDrag(tree, entries, arrange, s.ghost ?? '');
  const hover = dragging?.hover;
  const lifted = dragging ? ('project' in dragging.item ? `project:${dragging.item.project}` : `group:${dragging.item.group}`) : undefined;
  const intoGroup = hover?.kind === 'into' ? (hover.place.into ?? undefined) : undefined;
  useSpringLoad(intoGroup, intoGroup !== undefined && collapsed.includes(`group:${intoGroup}`));
  // A new group's row shows where the group will be: where its project is (after that project's group), else last.
  const newAt = !creating
    ? -1
    : creating.projectId
      ? (() => {
          const top = entries.findIndex((e) => e.kind === 'project' && e.project.id === creating.projectId);
          if (top >= 0) return top;
          const home = entries.findIndex((e) => e.kind === 'group' && e.projects.some((p) => p.id === creating.projectId));
          return home >= 0 ? home + 1 : entries.length;
        })()
      : entries.length;
  const treeItems: ActionItem[] = [
    { label: 'New Group', onSelect: () => newEmptyGroup() },
    { label: 'Add Projects…', onSelect: () => actions.run({ type: 'add_project' }) },
    { label: 'New Project…', onSelect: () => ui.patch({ addProject: 'new' }) },
  ];
  return (
    <>
      <ActionsContext items={treeItems}>
        <div ref={tree} className={cx(s.tree, dragging && s.dragging)} onPointerDown={onPointerDown} data-arrange-tree>
          {entries.map((e, i) => {
            const key = keyOfEntry(e);
            return (
              <Fragment key={key}>
                {newAt === i ? <NewGroupRow /> : null}
                {e.kind === 'project' ? (
                  <div data-slot={key} className={cx(s.block, lifted === key && s.lifted)}>
                    <ProjectBlock p={e.project} depth={0} entries={entries} arrange={arrange} />
                  </div>
                ) : (
                  <div data-slot={key} className={cx(s.block, lifted === key && s.lifted)} role="group" aria-label={e.name}>
                    <GroupHeader
                      name={e.name}
                      count={e.projects.length}
                      open={!collapsed.includes(`group:${e.name}`)}
                      busy={groups[e.name]?.busy ?? false}
                      tally={groups[e.name]?.tally ?? { unread: 0, needs: 0, working: false }}
                      dropOn={intoGroup === e.name}
                      menu={moveItems(entries, { group: e.name }, arrange)}
                      onToggle={() => actions.run({ type: 'toggle_group', name: e.name })}
                      onMove={(dir) => {
                        const place = stepOf(entries, { group: e.name }, dir);
                        if (place) arrange({ group: e.name }, place);
                      }}
                    />
                    {collapsed.includes(`group:${e.name}`)
                      ? null
                      : e.projects.map((p) => (
                          <div key={p.id} data-slot={`project:${p.id}`} className={cx(s.block, lifted === `project:${p.id}` && s.lifted)}>
                            <ProjectBlock p={p} depth={1} entries={entries} arrange={arrange} />
                          </div>
                        ))}
                  </div>
                )}
              </Fragment>
            );
          })}
          {newAt === entries.length ? <NewGroupRow /> : null}
          {hover?.kind === 'line' ? <div className={s.insertion} style={{ top: hover.y, left: hover.depth ? 32 : 18 }} aria-hidden="true" /> : null}
          {entries.length || creating ? null : <Row className={side.hintRow} icon={<Icon name="plus" size={13} />} label="Add a project…" onClick={() => actions.run({ type: 'add_project' })} />}
        </div>
      </ActionsContext>
      {/* Your computers' projects this Mac doesn't have (BLG-785). */}
      <RemoteProjects local={localNames} />
      <HiddenProjects />
    </>
  );
}
