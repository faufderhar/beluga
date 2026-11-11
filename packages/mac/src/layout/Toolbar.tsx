import { agentLabel } from '@beluga/shared/agent-label.js';
import { agentMark } from '@beluga/shared/agent-marks.js';
import { planForHome } from '@beluga/core/plans/model.js';
import { ASSISTANT_TITLE, THIS_COMPUTER } from '@beluga/shared/assistant.js';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { agentOfWorktree, agentTitle, isAgentWorktree } from '../claude-code/subagents-model.js';
import { activityOf, findWorkspace, stateOf } from '@beluga/ui/workspace-models.js';
import { describePr } from '@beluga/shared/format.js';
import { Icon } from '../components/Icon.js';
import { useContinueOn } from '../machines/continue-on.js';
import { ActionsDropdown } from '../components/SpecMenu.js';
import { Button, Dot, IconButton, Segmented, Tip, cx } from '../components/ui.js';
import { ConvoSwitch, SWITCH_ICONS_W, SWITCH_W } from '../agent-term/ConvoSwitch.js';
import { terminalCapable } from '../lib/convo-mode.js';
import { useActions } from '../lib/actions.js';
import { AtHome, toast, useApp, useBeluga } from '../lib/beluga.js';
import { MachineTag } from '../machines/MachineTag.js';
import { sameDeep, sameFields } from '../lib/stable.js';
import type { AppState } from '@beluga/core/store.js';
import { type ToolAction, isPrStep, shortOf, toolbarActions } from './toolbar-actions.js';
import { type BranchFold, BranchControl, BranchPill, pillHidden, shortLabel } from './BranchControl.js';
import { isPlanAction, runPlanAction } from '../lib/plan-task.js';
import { askBeforeWork } from '../lib/work-confirm.js';
import { getPrefs, setPrefs, usePrefs } from '../lib/prefs.js';
import { togglePanel } from '../lib/panel.js';
import { navBack, navForward, useNavAbility } from '../lib/nav.js';
import { panelFits } from '../lib/panel-model.js';
import { mod } from '../lib/system.js';
import { NotificationBell } from './NotificationCenter.js';
import { ContinueButton } from '../chat/AskBanner.js';
import { useConversationHeader } from '../network/ConversationHeader.js';
import { ContextNote } from '../chat/ContextMeter.js';
import { PeopleHere } from './PeopleHere.js';
import { ForkToMacButton } from '../dialogs/native/ForkToMacSheet.js';
import { PrivateMark, shareWithTeamItems } from '../team/Team.js';
import { copyLinkItems } from './worktree-link.js';
import s from './Toolbar.module.css';
import { shortcutKeys } from '../lib/shortcuts.js';
import { sentinelSubtitle } from '../sentinel/sentinel-model.js';
import { CallButton } from '../call/CallStrip.js';
import { AppMenu } from './AppMenu.js';

/** Room the title keeps, and the window buttons on the right (search, bell, panel). */
const TITLE_MIN = 210;
const RIGHT_FIXED = 3 * 30 + 16;
/** Back and forward, before the title. */
const NAV_W = 2 * 30;
const FOLDS: BranchFold[] = ['none', 'pill', 'all'];

const TITLES: Partial<Record<string, string>> = { overview: 'Overview', search: 'Search', usage: 'Usage', terminal: 'Terminal', files: 'Files', draft: 'New chat', draft_worktree: 'New worktree', claude_code: 'Activity', requests: 'Requests', tasks: 'Tasks', worktrees: 'Worktrees' };

/** How wide the toolbar is (buttons that don't fit move under ⋯). */
function useToolbarWidth(): [React.RefObject<HTMLElement | null>, number] {
  const ref = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(1000);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e?.contentRect.width ?? 1000));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Search every conversation, from any view (⇧⌘F; ⌘F finds in what's open). */
function SearchButton() {
  const actions = useActions();
  const on = useApp((st) => st.view.kind === 'search');
  return <IconButton icon="search" label="Search" keys={shortcutKeys('find')} active={on} onClick={() => actions.run({ type: 'view', view: { kind: 'search' } })} />;
}

/** Back and forward between pages, with what was open on each (⌘[ ⌘]; off with nowhere to go). */
function NavButtons() {
  const can = useNavAbility();
  return (
    <span className={s.nav} role="group" aria-label="Back and forward">
      <IconButton icon="back" label="Go back" keys={shortcutKeys('nav-back')} disabled={!can.back} onClick={() => void navBack()} />
      <IconButton icon="forward" label="Go forward" keys={shortcutKeys('nav-forward')} disabled={!can.forward} onClick={() => void navForward()} />
    </span>
  );
}

function Shell({ title, subtitle, center, right, headerRef }: { title: ReactNode; subtitle?: ReactNode; center?: ReactNode; right?: ReactNode; headerRef: React.RefObject<HTMLElement | null> }) {
  const prefs = usePrefs();
  const view = useApp((st) => st.view);
  // A plan's page has no panel: its chat is its right side (the plan's header shows and hides it, ⌥⌘0 too).
  // Nor do the pages that have the whole window (Tasks, a task, Sentinel): there the button isn't shown.
  const fits = panelFits(view);
  // Only what every view needs: search, what's new, the panel. The terminal (⌘J) is a panel tab,
  // and everything you can do is ⌘K and the menu bar.
  return (
    <header ref={headerRef} className={cx(s.toolbar, !prefs.sidebar && s.noSidebar)} data-tauri-drag-region>
      {prefs.sidebar ? null : (
        <span className={s.lead}>
          {/* The sidebar's menu-bar button (a browser's), beside it while the sidebar is hidden. */}
          <AppMenu />
          <IconButton icon="sidebar" label="Show sidebar" keys={shortcutKeys('toggle-sidebar')} onClick={() => setPrefs({ sidebar: true })} />
        </span>
      )}
      <NavButtons />
      <div className={s.titles} data-tauri-drag-region>
        <div className={s.title}>
          <MachineTag />
          {title}
        </div>
        {subtitle ? <div className={s.subtitle}>{subtitle}</div> : null}
      </div>
      <div className={s.center} data-tauri-drag-region>
        {center}
      </div>
      <div className={s.right}>
        {/* Whatever still doesn't fit is cut here, never the window buttons: the panel's toggle always shows where there's a panel. */}
        {right ? <div className={s.extra}>{right}</div> : null}
        {/* The window's own wherever you are: this Mac's search and one bell (BLG-790 brings every computer's). */}
        <AtHome>
          <SearchButton />
          <NotificationBell />
        </AtHome>
        {/* No panel here, no button for it: a button that can only say so is nothing to click. */}
        {fits ? (
          <IconButton
            icon="panelRight"
            label={prefs.inspector ? 'Hide the panel' : 'Show the panel: changes, files, terminal, info'}
            keys={shortcutKeys('toggle-inspector')}
            active={prefs.inspector}
            onClick={() => togglePanel(view)}
          />
        ) : null}
      </div>
    </header>
  );
}

/**
 * What the toolbar reads from the shared state: the slices it shows, and for a worktree its state
 * line and buttons worked out here, so a streamed step redraws the bar only when what it shows changes.
 */
function toolbarPick(full: AppState) {
  const view = full.view;
  const ws = view.kind === 'workspace' ? findWorkspace(full.projects, view.id) : undefined;
  const agent = ws ? isAgentWorktree(ws) : false;
  const act = ws && !agent ? activityOf(full.log, `ws:${ws.id}`) : undefined;
  return {
    view,
    ws,
    sub: ws && agent ? agentOfWorktree(full.claudeCode.sessions, ws) : undefined,
    made: ws && !agent ? { st: stateOf(full, ws, 0), tools: toolbarActions(full, ws), live: Boolean(act?.running || act?.awaiting) } : undefined,
    projects: full.projects,
    prs: full.prs,
    plans: full.plans,
    shared: full.shared,
    peers: full.peers,
    friends: full.network.friends,
    room: full.room,
    sentinel: full.sentinel,
    board: full.board,
    team: full.team,
    members: full.members,
  };
}

/** The slices the same objects, and what was worked out from them the same plain data. */
function sameToolbar(a: ReturnType<typeof toolbarPick>, b: ReturnType<typeof toolbarPick>): boolean {
  const { sub: sa, made: ma, ...ra } = a;
  const { sub: sb, made: mb, ...rb } = b;
  return sameFields(ra, rb) && sameDeep(sa, sb) && sameDeep(ma, mb);
}

export function Toolbar() {
  const [headerRef, width] = useToolbarWidth();
  const actions = useActions();
  const beluga = useBeluga();
  const { client } = beluga;
  const state = useApp(toolbarPick, sameToolbar);
  const view = state.view;
  // Continue On ▸ another computer of yours (BLG-808).
  const continueItem = useContinueOn(view.kind === 'workspace' ? state.ws : undefined);

  if (view.kind === 'workspace') {
    const ws = state.ws;
    if (!ws) return <Shell headerRef={headerRef} title="Workspace" />;
    const project = state.projects.find((p) => p.id === ws.projectId);
    // A sub-agent's own worktree is the agent: its name, no worktree actions (it's Claude's, not yours).
    if (isAgentWorktree(ws) || !state.made) {
      const sub = state.sub;
      return (
        <Shell
          headerRef={headerRef}
          title={
            <>
              {project?.root ? <span className={s.crumb}>{project.name}</span> : null}
              <span className={s.name}>{sub ? agentTitle(sub.agent) : 'Sub-agent'}</span>
            </>
          }
          subtitle={<span className={s.meta}>Sub-agent · its own worktree{ws.branch ? ` · ${ws.branch}` : ''}</span>}
        />
      );
    }
    const { st } = state.made;
    const { branch, primary, icons, more } = state.made.tools;
    // A narrow window: the icons that don't fit move under ⋯ first, then the branch pill (beside the
    // name) keeps only its icon and number, then its step and the everyday action only their icons (words in their tips).
    const pillW = (fold: BranchFold): number => (branch && !pillHidden(branch, fold) ? (fold === 'none' ? branch.label.length * 5.8 + 34 : 30) + (branch.pr ? 24 : 0) : 0);
    const stepW = (fold: BranchFold): number => (branch?.steps[0] ? (fold === 'all' ? shortLabel(branch.steps[0]).length * 7.4 + 42 : branch.steps[0].label.length * 7.4 + 42) + 34 : 0);
    const primaryW = (fold: BranchFold): number => (primary ? (fold === 'all' ? shortOf(primary).length * 7.4 + 48 : primary.label.length * 7.4 + 48) : 0);
    // The Chat · Terminal · Both switch (BLG-534): with its words while there's room, then its icons.
    const switchW = getPrefs().termView && terminalCapable(client.store.getState(), ws.id) ? (width >= 1180 ? SWITCH_W : SWITCH_ICONS_W) : 0;
    const fixedAt = (fold: BranchFold): number => TITLE_MIN + NAV_W + RIGHT_FIXED + switchW + pillW(fold) + stepW(fold) + primaryW(fold) + 34;
    const fold = FOLDS.find((f) => fixedAt(f) <= width) ?? 'all';
    const fit = Math.max(0, Math.min(icons.length, Math.floor((width - fixedAt(fold)) / 30)));
    // Icons that don't fit lead ⋯ as a section of their own.
    const overflow = [...(fit < icons.length ? [icons.slice(fit)] : []), ...more];
    const menu = overflow.flatMap((section, k) => section.map((a, i) => ({ a, separate: k > 0 && i === 0 })));
    // A team project's conversation is yours alone until you share it (core/team, BLG-226).
    const teamItems = shareWithTeamItems(state, client, ws.id, project?.id);
    // Copy Link, to mention it in another chat (BLG-878).
    const linkItems = copyLinkItems(ws, client);
    const run = (a: ToolAction): void => {
      if (a.disabled) return toast(client, a.hint, 'info');
      if (isPrStep(a.action)) return askBeforeWork(ws.id, a.action);
      if (isPlanAction(a.action)) return runPlanAction(client.store.getState(), ws.id, a.action, actions.run);
      actions.run({ type: 'ws', id: ws.id, action: a.action });
    };
    const pr = state.prs[ws.id];
    // Where the branch stands (Merged, Conflicts, its PR) is said once, by the branch pill beside the
    // name: the subtitle keeps to what Claude is doing, or what needs you.
    const live = !branch || state.made.live;
    return (
      <Shell
        headerRef={headerRef}
        title={
          <>
            {project?.root ? <span className={s.crumb}>{project.name}</span> : null}
            <span className={s.name}>{ws.name}</span>
            {branch ? (
              <span className={s.branchPill}>
                <BranchPill wsId={ws.id} branch={branch} fold={fold} />
              </span>
            ) : null}
          </>
        }
        subtitle={
          <>
            {live ? (
              <span className={cx(s.meta, s.metaState, s[`tone_${st.tone}`])}>
                <Dot tone={st.tone === 'claude' ? (ws.kind === 'worktree' ? 'worktree' : 'claude') : st.tone === 'muted' ? 'muted' : st.tone} live={st.tone === 'claude'} />
                {st.label}
              </span>
            ) : null}
            {/* Never cut: past 70% it's worth seeing (the branch and the rest give way). */}
            <ContextNote channel={`ws:${ws.id}`} className={s.meta} />
            {ws.branch ? (
              <span className={cx(s.meta, s.metaBranch)} title={ws.branch}>
                <Icon name="branch" size={11} />
                <span className={s.ellipsis}>{ws.branch}</span>
              </span>
            ) : ws.kind === 'chat' ? (
              <span className={s.meta}>{ws.askOnly ? (planForHome(state.plans, `ws:${ws.id}`) ? 'The plan’s conversation · main folder' : 'Questions only · main folder') : 'Agent chat'}</span>
            ) : null}
            {pr && !branch ? (
              <span className={cx(s.meta, s.metaPr, pr.state === 'MERGED' && s.metaMerged)} title={describePr(pr)} data-pr-state={pr.state}>
                <Icon name={pr.state === 'MERGED' ? 'merge' : 'pr'} size={11} />
                <span className={s.ellipsis}>{pr.state === 'MERGED' ? `PR #${pr.number}` : describePr(pr)}</span>
              </span>
            ) : null}
          </>
        }
        center={switchW ? <ConvoSwitch wsId={ws.id} iconOnly={switchW === SWITCH_ICONS_W} /> : undefined}
        right={
          <>
            {/* Friends you shared it with over the network, each with how they're doing (or that only you see it). */}
            <PrivateMark wsId={ws.id} projectId={project?.id} />
            <PeopleHere wsId={ws.id} />
            {branch ? <BranchControl wsId={ws.id} branch={branch} fold={fold} /> : null}
            {/* A main folder is questions only: what it needs next is a worktree to work in. */}
            {ws.askOnly && !planForHome(state.plans, `ws:${ws.id}`) ? (
              <span className={s.primaryWrap}>
                <ContinueButton wsId={ws.id} className={s.primary} />
              </span>
            ) : primary ? (
              <Tip label={fold === 'all' ? `${primary.label}: ${primary.hint}` : primary.hint} keys={primary.keys}>
                <span className={s.primaryWrap}>
                  <Button variant={primary.action === 'merge' ? 'merge' : 'primary'} icon={primary.icon} aria-label={fold === 'all' ? primary.label : undefined} className={cx(s.primary, primary.tone === 'error' && s.primaryError)} aria-disabled={primary.disabled} data-tool={primary.action} data-tool-ws={ws.id} onClick={() => run(primary)}>
                    {fold === 'all' ? shortOf(primary) : primary.label}
                  </Button>
                </span>
              </Tip>
            ) : null}
            <span className={s.tools} role="group" aria-label="Workspace actions">
              {icons.slice(0, fit).map((a) => (
                <IconButton key={a.id} icon={a.icon} label={a.disabled ? `${a.label}: ${a.hint}` : (a.tip ?? `${a.label} · ${a.hint}`)} keys={a.keys} aria-disabled={a.disabled} data-tool={a.action} data-tool-ws={ws.id} className={cx(a.disabled && s.off, a.tone === 'error' && s.toolError)} onClick={() => run(a)} />
              ))}
              {overflow.length || teamItems.length || continueItem || linkItems.length ? (
                <ActionsDropdown items={[...menu.map(({ a, separate }) => ({ label: a.label, icon: a.icon, hint: a.disabled ? a.hint : undefined, keys: a.keys, disabled: a.disabled, danger: a.danger, separate, onSelect: () => requestAnimationFrame(() => run(a)) })), ...teamItems, ...(continueItem ? [continueItem] : []), ...linkItems]}>
                  <IconButton icon="more" label="More for this workspace" data-tool="more" data-tool-ws={ws.id} />
                </ActionsDropdown>
              ) : null}
            </span>
            <span className={s.divider} />
          </>
        }
      />
    );
  }

  if (view.kind === 'shared') {
    const w = state.shared.find((x) => x.id === view.id);
    const ui = beluga.ui;
    const owner = state.peers.find((p) => p.peerId === view.owner)?.name ?? state.friends.find((f) => f.peerId === view.owner)?.name ?? 'Someone';
    return (
      <Shell
        headerRef={headerRef}
        title={w?.name ?? 'Shared workspace'}
        // Whose machine and which agent runs there: the owner's (BLG-448), never yours.
        subtitle={
          <span className={s.meta}>
            {`${owner}'s ${w?.project ?? 'project'} ·`}
            <Icon name={agentMark(w?.agent)} size={11} />
            {`${agentLabel(w?.agent, owner, false, { model: true })} on their computer · ${w?.role === 'contribute' ? 'you can work here' : 'you’re following along'}`}
          </span>
        }
        center={
          <Segmented
            label="Views"
            value={view.tab === 'terminal' ? 'files' : view.tab}
            onChange={(tab) => actions.run({ type: 'open_shared', owner: view.owner, id: view.id, tab })}
            options={[
              { value: 'chat', label: 'Chat', icon: 'chat' },
              { value: 'files', label: 'Files', icon: 'folder', hint: 'Browse and search the files' },
              { value: 'diff', label: 'Diff', icon: 'diff' },
            ]}
          />
        }
        right={
          <>
            <ForkToMacButton owner={view.owner} wsId={view.id} />
            <PeopleHere wsId={view.id} />
            <IconButton icon="people" label={`About ${w?.name ?? 'this workspace'}: who's here, leave`} onClick={() => ui.openMenu({ kind: 'shared', owner: view.owner, id: view.id })} />
          </>
        }
      />
    );
  }

  if (view.kind === 'conversation') return <ConversationBar id={view.id} headerRef={headerRef} />;

  if (view.kind === 'assistant') {
    return <Shell headerRef={headerRef} title={<span className={s.name}>{ASSISTANT_TITLE}</span>} subtitle={<span className={s.meta}>Your agent for {THIS_COMPUTER} as a whole · the open chat is the one on your phone</span>} />;
  }

  if (view.kind === 'room') {
    // The room's group chat (BLG-871: no page while you're alone), and its call (BLG-716) while there's someone to call.
    const solo = state.peers.length <= 1;
    return <Shell headerRef={headerRef} title={state.room || 'Group chat'} subtitle={<span className={s.meta}>{solo ? 'Everyone else has left the room' : `${state.peers.length} people · everyone’s agent can join in`}</span>} right={solo ? undefined : <CallButton id="room" label="the Room" />} />;
  }

  if (view.kind === 'draft' || view.kind === 'draft_worktree') {
    const project = state.projects.find((p) => p.id === view.projectId && p.root);
    const worktree = view.kind === 'draft_worktree';
    return (
      <Shell
        headerRef={headerRef}
        title={
          <>
            {project ? <span className={s.crumb}>{project.name}</span> : null}
            <span className={s.name}>{worktree ? 'New Worktree' : 'New Chat'}</span>
          </>
        }
        subtitle={<span className={s.meta}>{worktree ? 'Its own branch and folder; your agent starts on your task right away' : project ? `Your agent works in ${project.name}’s main folder` : 'Nothing is created until you send the first message'}</span>}
      />
    );
  }

  // Sentinel is one page (BLG-300): its list, its board and its chat say Sentinel, with how it's doing.
  if (view.kind === 'sentinel' || view.kind === 'dashboard' || (view.kind === 'sentinel_chat' && !view.about)) {
    return <Shell headerRef={headerRef} title={<span className={s.name}>Sentinel</span>} subtitle={<span className={s.meta}>{sentinelSubtitle(state.sentinel)}</span>} />;
  }

  if (view.kind === 'sentinel_page' || view.kind === 'sentinel_run' || view.kind === 'sentinel_chat') {
    const run = view.kind === 'sentinel_run' ? state.sentinel.runs.find((r) => r.id === view.runId) : undefined;
    const item = state.sentinel.items.find((x) => x.id === (view.kind === 'sentinel_page' ? view.id : view.kind === 'sentinel_chat' ? view.about : run?.sentinelId));
    const project = item?.projectId ? state.projects.find((p) => p.id === item.projectId) : undefined;
    return (
      <Shell
        headerRef={headerRef}
        title={
          <>
            <span className={s.crumb}>{project?.name ?? (item ? ASSISTANT_TITLE : 'Sentinel')}</span>
            <span className={s.name}>{view.kind === 'sentinel_run' ? `${item?.name ?? 'Sentinel'} · Run` : (item?.name ?? 'Sentinel')}</span>
          </>
        }
      />
    );
  }

  if (view.kind === 'tasks') {
    // One project's tasks (its name is the switcher at the top of the view).
    return <Shell headerRef={headerRef} title={<span className={s.name}>Tasks</span>} />;
  }

  if (view.kind === 'plans') return <Shell headerRef={headerRef} title={<span className={s.name}>Plans</span>} />;

  if (view.kind === 'issues') return <Shell headerRef={headerRef} title={<span className={s.name}>Issues</span>} subtitle={<span className={s.meta}>From GitHub · your agent investigates, fixes, or writes them up as tasks</span>} />;

  if (view.kind === 'pulls') return <Shell headerRef={headerRef} title={<span className={s.name}>Pull Requests</span>} subtitle={<span className={s.meta}>From GitHub · anyone’s open pull requests, each one a worktree away</span>} />;

  if (view.kind === 'actions') return <Shell headerRef={headerRef} title={<span className={s.name}>Actions</span>} subtitle={<span className={s.meta}>From GitHub · runs as they go, and each workflow as a graph</span>} />;

  if (view.kind === 'gh_run') {
    const project = state.projects.find((p) => p.id === view.projectId);
    return (
      <Shell
        headerRef={headerRef}
        title={
          <>
            <span className={s.crumb}>{project?.name ?? 'Actions'}</span>
            <span className={s.name}>Workflow Run</span>
          </>
        }
      />
    );
  }

  if (view.kind === 'gh_issue') {
    const project = state.projects.find((p) => p.id === view.projectId);
    return (
      <Shell
        headerRef={headerRef}
        title={
          <>
            <span className={s.crumb}>{project?.name ?? 'Issues'}</span>
            <span className={s.name}>Issue #{view.number}</span>
          </>
        }
      />
    );
  }

  if (view.kind === 'plan') {
    const plan = state.plans.plans.find((x) => x.id === view.id);
    const project = plan ? state.projects.find((p) => p.id === plan.projectId) : undefined;
    // Where it runs: its project, and the branch its work comes together on (the panel's Info used to say).
    const branch = plan?.branch ?? (plan?.home.startsWith('ws:') ? findWorkspace(state.projects, plan.home.slice(3))?.branch : undefined) ?? project?.base;
    return (
      <Shell
        headerRef={headerRef}
        title={
          <>
            <span className={s.crumb}>{project?.name ?? 'Plans'}</span>
            <span className={s.name}>Plan</span>
          </>
        }
        {...(branch ? { subtitle: branch } : {})}
      />
    );
  }

  if (view.kind === 'task') {
    const issue = state.board.issues.find((i) => i.id === view.id);
    const project = issue ? state.projects.find((p) => p.id === issue.projectId) : undefined;
    return (
      <Shell
        headerRef={headerRef}
        title={
          <>
            <span className={s.crumb}>{project?.name ?? 'Tasks'}</span>
            <span className={s.name}>{issue?.key ?? 'Task'}</span>
          </>
        }
        subtitle={issue ? <span className={s.meta}>{issue.title}</span> : undefined}
      />
    );
  }

  if (view.kind === 'project') {
    const project = state.projects.find((p) => p.id === view.id);
    if (view.page === 'history') {
      return (
        <Shell
          headerRef={headerRef}
          title={
            <>
              {project ? <span className={s.crumb}>{project.name}</span> : null}
              <span className={s.name}>History</span>
            </>
          }
          subtitle={<span className={s.meta}>Who committed what, and when · every branch</span>}
        />
      );
    }
    return <Shell headerRef={headerRef} title={project?.name ?? 'Project'} subtitle={<span className={s.meta}>Work happens in worktrees · the main folder is for questions</span>} />;
  }

  return <Shell headerRef={headerRef} title={TITLES[view.kind] ?? 'Beluga'} />;
}

/** A conversation with friends or a group: who it's with, their status, the group's people. */
function ConversationBar({ id, headerRef }: { id: string; headerRef: React.RefObject<HTMLElement | null> }) {
  const parts = useConversationHeader(id);
  return <Shell headerRef={headerRef} title={parts.title} subtitle={parts.subtitle} right={parts.right} />;
}
