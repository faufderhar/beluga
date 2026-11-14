import { useEffect, useRef, useState } from 'react';
import { overviewNews } from '@beluga/ui/workspace-models.js';
import { macTabs } from '../lib/go.js';
import { newShares } from '@beluga/core/store.js';
import { usageFor } from '@beluga/agent/usage.js';
import { windowsOf } from '@beluga/ui/usage-cards.js';
import { myRuntime } from '../chat/ModelPicker.js';
import { Icon } from '../components/Icon.js';
import { Badge, IconButton, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { inApp } from '../lib/boot.js';
import { useApi, useApp, useBeluga } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import { setPrefs, usePrefs } from '../lib/prefs.js';
import { RoomStatus } from '../dialogs/native/RoomPopover.js';
import { PhoneMark } from '../phone/Phone.js';
import { ChatsMenu } from './ChatsMenu.js';
import { Projects, ProjectsAddMenu } from './ProjectTree.js';
import { SharedProjects } from './SharedProjects.js';
import { useChatDrag } from './chat-drag.js';
import { WorkspaceWithAgents } from './SubAgents.js';
import { threadNesting } from '../threads/threads-model.js';
import { ChatSelectionCount, SidebarChatSelection } from './chat-selection-view.js';
import { UnreadSection } from './UnreadSection.js';
import { CategorySections } from './CategorySections.js';
import { SnoozeCustomSheet } from './row-triage-actions.js';
import { Row, Section } from './sidebar-parts.js';
import { SidebarSearch } from './SidebarSearch.js';
import { ActivityRow } from '../claude-code/Live.js';
import { FriendsSection, GroupsSection } from '../network/NetworkSidebar.js';
import { RequestsNav } from '../gateway/RequestsNav.js';
import { WorkNav } from '../work/WorkNav.js';
import { SentinelNav } from '../sentinel/SentinelNav.js';
import { AssistantNav } from './AssistantNav.js';
import { LaterRows, laterOf, notLater, useLater } from './later-rows.js';
import { footerStatus } from '../views/room/connection-model.js';
import { WorktreesNav } from '../views/worktrees/WorktreesNav.js';
import { SelfBar } from '../network/StatusMenu.js';
import { UpdatePill } from '../components/UpdatePill.js';
import s from './Sidebar.module.css';
import { shortcutKeys } from '../lib/shortcuts.js';
import { CallPill } from '../call/CallLayer.js';
import { AppMenu } from './AppMenu.js';

/**
 * The sidebar's top: Overview, then Work, Sentinel and Files. The rest are a click away without a row of their
 * own: Search in the toolbar (⇧⌘F), Usage as an icon above, the terminal in the right panel (⌘J),
 * folders friends share under Files (projects they share are in Projects); Activity and Requests show up only while there's something
 * in them. Everything is also in ⌘K and the Go menu (⌘1…7). The room's group chat is no place
 * here (BLG-871): it's the first of Channels while someone else is in the room.
 */

export { workspaceItems } from './workspace-row.js';

/**
 * Folders dragged from Finder onto the sidebar become projects (a git project, or a folder of
 * them). The Add Projects sheet takes drops itself while it's open.
 */
function useFolderDrop(): { ref: React.RefObject<HTMLElement | null>; over: boolean } {
  const api = useApi();
  const { ui } = useBeluga();
  const ref = useRef<HTMLElement>(null);
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (!inApp()) return;
    let off: (() => void) | undefined;
    let alive = true;
    const inside = (x: number, y: number): boolean => {
      const r = ref.current?.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      return !!r && x / scale >= r.left && x / scale <= r.right && y / scale >= r.top && y / scale <= r.bottom;
    };
    void import('@tauri-apps/api/webview').then(async ({ getCurrentWebview }) => {
      const un = await getCurrentWebview().onDragDropEvent((e) => {
        if (ui.get().addProject) return setOver(false);
        const p = e.payload;
        if (p.type === 'leave') return setOver(false);
        const here = inside(p.position.x, p.position.y);
        if (p.type === 'drop') {
          setOver(false);
          if (here) for (const path of p.paths) void api.projects.add(path);
        } else setOver(here);
      });
      if (alive) off = un;
      else un();
    });
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  return { ref, over };
}

export function Sidebar() {
  const actions = useActions();
  const drop = useFolderDrop();
  // A chat's row picked up: what's carried, and the chat that would take it.
  const chatDrag = useChatDrag();
  // Only what the sidebar itself shows: drawn again when that changes, not on every streamed event (KLD-48).
  const { tabs, liveChats, view, badges, categories } = useApp((state) => {
    const news = overviewNews(state);
    const fresh = newShares(state);
    const badges: Partial<Record<string, { count: number; urgent?: boolean }>> = {
      files: { count: fresh },
      overview: { count: state.view.kind === 'overview' ? 0 : news.count, urgent: news.urgent },
    };
    return {
      tabs: macTabs(state),
      liveChats: state.projects.find((p) => !p.root)?.workspaces.filter((w) => !w.archived) ?? [],
      view: state.view,
      badges,
      categories: state.prefs.chatCategories,
    };
  }, sameDeep);
  const later = useLater();
  // A child thread sits under its parent's row (SubAgents.tsx); put off till later, it is in Later.
  const { nested } = useApp(threadNesting);
  const overview = tabs.find((t) => t.kind === 'overview');
  const files = tabs.find((t) => t.kind === 'files');
  return (
    <SidebarChatSelection>
    {chatDrag}
    <nav ref={drop.ref} className={cx(s.sidebar, drop.over && s.dropping)} aria-label="Sidebar">
      <div className={s.titlebar} data-tauri-drag-region>
        {/* The traffic lights' place; in a browser, which has no menu bar, the menu bar's button (Settings and the rest). */}
        {inApp() ? (
          <span className={s.trafficSpace} data-tauri-drag-region />
        ) : (
          <span className={s.appMenu}>
            <AppMenu />
          </span>
        )}
        <UsageButton />
        <IconButton icon="sidebar" label="Hide sidebar" keys={shortcutKeys('toggle-sidebar')} onClick={() => setPrefs({ sidebar: false })} />
      </div>
      <SidebarSearch>
      <div className={s.scroll}>
        <section className={s.section}>
          <AssistantNav />
          <Row
            icon={<Icon name="grid" size={14} />}
            label={overview?.label ?? 'Overview'}
            detail={overview?.hint}
            selected={view.kind === 'overview'}
            onClick={() => actions.run({ type: 'view', view: { kind: 'overview' } })}
            trailing={badges.overview?.count ? <Badge count={badges.overview.count} urgent={badges.overview.urgent} /> : null}
          />
          {/* Work (Tasks, GitHub's issues and Plans in one row, BLG-197), then Sentinel and its Dashboard. */}
          <WorkNav />
          <SentinelNav />
          {/* Files: folders friends share with you (over the network), and the room's (BLG-205). */}
          <Row
            icon={<Icon name="folder" size={14} />}
            label="Files"
            detail={files?.hint ?? 'Folders friends share with you'}
            selected={view.kind === 'files'}
            onClick={() => actions.run({ type: 'view', view: { kind: 'files' } })}
            trailing={badges.files?.count ? <Badge count={badges.files.count} /> : null}
          />
          <ActivityRow whenLive />
          <RequestsNav whenAny />
        </section>

        {categories ? (
          <CategorySections />
        ) : (
          <>
            <UnreadSection />

            <Section
              id="chats"
              title="Chats"
              action={
                <>
                  <ChatsMenu />
                  <IconButton icon="plus" label="New chat (not tied to a project)" onClick={() => actions.run({ type: 'new_chat', projectId: 'chats' })} />
                </>
              }
            >
              {liveChats.filter((w) => !nested.has(w.id) && notLater(later, w)).map((w) => (
                <WorkspaceWithAgents key={w.id} ws={w} indent={0} threadsOnly />
              ))}
              {/* Put off till later (Remind Me Later): folded at the bottom. */}
              <LaterRows list={laterOf(later, liveChats)} indent={0} foldKey="later:chats" />
              {liveChats.length ? null : <Row className={s.hintRow} icon={<Icon name="plus" size={13} />} label="Talk to your agent about anything" onClick={() => actions.run({ type: 'new_chat', projectId: 'chats' })} />}
            </Section>
          </>
        )}

        <Section id="projects" title="Projects" action={<ProjectsAddMenu />}>
          <Projects />
          {/* Housekeeping for every project's worktrees: after the projects, out of the daily places above. */}
          <WorktreesNav />
        </Section>

        {/* What friends shared with you: a section each, "Ata's conversations", apart from your own. */}
        <SharedProjects />

        <FriendsSection />
        <GroupsSection />
      </div>
      </SidebarSearch>
      {/* Remind Me Later ▸ Custom…, from any row's menu, with the categories on or off. */}
      <SnoozeCustomSheet />
      {/* Below the lists, so the rows being Shift-clicked stay where they are as it opens. */}
      <ChatSelectionCount />
      {/* The call you're in, while you look at something else (BLG-706). */}
      <CallPill />
      <UpdatePill />
      <SidebarFooter />
      <SelfBar />
    </nav>
    </SidebarChatSelection>
  );
}

/**
 * Usage as an icon above the sidebar: how much of your agent's plan you've used (BLG-507: your
 * default agent's, Codex's when it's Codex: its week, else its tightest window), and the Usage page.
 */
function UsageButton() {
  const actions = useActions();
  const week = useApp((st) => {
    const u = usageFor(st.self, myRuntime(st.prefs));
    if (u?.week) return u.week.pct;
    const windows = windowsOf(u);
    return windows.length ? Math.max(...windows.map((w) => w.pct)) : undefined;
  });
  const selected = useApp((st) => st.view.kind === 'usage');
  return (
    <span className={s.usage} data-level={week === undefined ? undefined : week >= 90 ? 'high' : week >= 70 ? 'mid' : 'low'}>
      <IconButton icon="gauge" label="Usage" keys={shortcutKeys('go-usage')} active={selected} onClick={() => actions.run({ type: 'view', view: { kind: 'usage' } })} />
    </span>
  );
}

function SidebarFooter() {
  const status = useApp((st) => st.status);
  const people = useApp((st) => st.peers.length);
  const room = useApp((st) => st.room);
  const ready = useApp((st) => st.hosting?.phase === 'ready');
  const reconnecting = useApp((st) => st.connection?.state === 'reconnecting');
  const { label, tone } = footerStatus({ status, room, people, ready, reconnecting });
  return (
    <div className={s.footer}>
      <RoomStatus label={label} tone={tone} />
      <PhoneMark />
      <button type="button" className={s.invite} onClick={() => document.dispatchEvent(new CustomEvent('beluga:invite'))}>
        Invite
      </button>
    </div>
  );
}
