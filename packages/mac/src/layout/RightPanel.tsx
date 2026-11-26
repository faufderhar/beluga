import { type DockviewApi, type DockviewGroupPanel, DockviewReact, type DockviewTheme, type IDockviewHeaderActionsProps, type IDockviewPanelHeaderProps, type IDockviewPanelProps, type SerializedDockview, positionToDirection } from 'dockview-react';
import { type FunctionComponent, createContext, memo, Suspense, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { View } from '@beluga/core/store.js';
import { shareNameOf } from '@beluga/shared/share-names.js';
import { runId, setupId } from '@beluga/shared/terminal-keys.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { Icon, type IconName } from '../components/Icon.js';
import { ActionsContext, type ActionItem } from '../components/SpecMenu.js';
import { IconButton, Segmented, cx } from '../components/ui.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { ViewBoundary, lazyView } from '../lib/lazy-view.js';
import { type DockPlace, filesWsOf, focusFor, groupTab, recentTabs, resetPanelLayout, setDock, setDockOpen, setPanelTab, setPhoneTab, showPanelTab, tabPicked, tabShowing, tabsOf, usePanelRuntime, useWorkspaceTabBridge } from '../lib/panel.js';
import { DEFAULT_LAYOUT, DOCK_HEAD, DRAWER_MAX, DRAWER_MIN, type DockTab, MAIN, PANEL_LABELS, PANES_DEFAULT, type PanelTab, SPLIT_MAX, SPLIT_MIN, centerKey, centerSlots, clampShare, homeGroup, layoutKey, panelFits, placeInCenter, rememberLayout, slotOf, slotsFor, startGroups, terminalUnderChat, usableLayout, viewsOf } from '../lib/panel-model.js';
import { getPrefs, setPrefs, usePrefs } from '../lib/prefs.js';
import { useMaking } from '../lib/making.js';
import { Inspector } from './Inspector.js';
import { ChangesTab } from './panel/ChangesTab.js';
import { FilesTab } from './panel/FilesTab.js';
import { TerminalPane } from './panel/TerminalPane.js';
import { HistoryTab } from './panel/HistoryTab.js';
import { type ScratchOf, ScratchTab, useScratchNewest } from './panel/ScratchTab.js';
import { BackgroundTab, useBackgroundRunning } from './panel/BackgroundTab.js';
import { FrameContext } from './frame.js';
import s from './panel/panel.module.css';
import { shortcutKeys } from '../lib/shortcuts.js';

/** Your Mac's scratch folder (one, whichever of its chats is open). */
const MAC_SCRATCH: ScratchOf = { assistant: true };

const PhonePanel = lazyView('phone/PhonePanel', () => import('../phone/PhoneView.js').then((m) => m.PhonePanel), false);

const ICONS: Record<PanelTab, IconName> = {
  changes: 'diff',
  files: 'folder',
  terminal: 'terminal',
  info: 'inspector',
  history: 'clock',
  scratch: 'pulse',
  background: 'play',
  phone: 'phone',
};
const SLIDE_MS = 200;
/** A drag of a divider is saved once it stops, not at every step. */
const SAVE_MS = 250;
/** No group gets narrower or (unfolded) shorter than this (Info and a file's preview still read well). */
const GROUP_MIN_W = 260;
const GROUP_MIN_H = 96;
/** The chat's group: room for the message box and its controls, less only when the window has no more to give. */
const CHAT_MIN_W = 460;
const CHAT_FLOOR_W = 340;
/** Room kept free at a strip's end, so a tab can still be dropped there. */
const TAB_SLACK = 16;

/**
 * Tabs that don't all fit show their icon only: first the ones you're not on, then all of them
 * (their name stays for VoiceOver and the tooltip). Instead of Dockview's overflow list, which hid
 * a tab behind a menu as soon as a strip got narrow.
 */
function fitTabs(group: DockviewGroupPanel): void {
  const el = group.element;
  const header = el.querySelector<HTMLElement>(':scope > .dv-tabs-and-actions-container');
  if (!header || header.hidden || !header.clientWidth) return;
  const tabs = [...header.querySelectorAll<HTMLElement>('.dv-tab')];
  const actions = header.querySelector<HTMLElement>('.dv-right-actions-container')?.offsetWidth ?? 0;
  const room = header.clientWidth - actions - TAB_SLACK;
  const need = (): number => tabs.reduce((sum, tab) => sum + tab.offsetWidth, 0);
  for (const level of ['none', 'others', 'all'] as const) {
    el.dataset.compact = level;
    if (level === 'all' || need() <= room) return;
  }
}

/** Beluga's look for Dockview (styles/dock.css gives its colours from Beluga's own). */
export const DOCK_THEME: DockviewTheme = { name: 'beluga', className: 'dockview-theme-beluga', dndOverlayMounting: 'relative', dndPanelOverlay: 'content', dndTabIndicator: 'line' };

/** What a tab's label carries: the number of changed files, a running Run, something waiting on you. */
type Badges = Partial<Record<PanelTab, { count?: number; tone?: 'ok' | 'error' | 'warn' | 'accent' }>>;

function useBadges(): Badges {
  const view = useApp((st) => st.view);
  const projects = useApp((st) => st.projects);
  const terminals = useApp((st) => st.terminals);
  const exits = useApp((st) => st.termExits);
  const waiting = useApp((st) => st.approvals.length + st.questions.length);
  const ws = view.kind === 'workspace' ? findWorkspace(projects, view.id) : undefined;
  const changed = ws?.status?.changed ?? 0;
  // What shows depends on the dock's groups: drawn again when they change.
  usePanelRuntime((r) => r.groups);
  // A Claude edit shows on the Changes tab (accent) until you look; it never switches tabs by itself.
  const seen = useRef(new Map<string, number>());
  const prefs = usePrefs();
  const looking = ws && tabShowing({ view, projects }, 'changes', prefs);
  if (ws && (looking || !seen.current.has(ws.id))) seen.current.set(ws.id, changed);
  const fresh = ws ? changed > 0 && changed !== seen.current.get(ws.id) : false;
  const running = (k: string): boolean => k in terminals && !(k in exits);
  const failed = ws ? [runId(ws.id), setupId(ws.id)].some((k) => (exits[k] ?? 0) !== 0) : false;
  const background = useBackgroundRunning(ws);
  // Claude is acting on the phone right now: a dot on the Phone tab, whatever you're looking at.
  const phoneBusy = useApp((st) => st.companion.devices.some((d) => d.control?.busy === true));
  // Something Claude saved to Scratch since you last looked: a dot until you do.
  // (Beside Your Mac's chat, its own folder: BLG-704.)
  const mac = view.kind === 'assistant';
  const newest = useScratchNewest(ws ? { wsId: ws.id } : mac ? MAC_SCRATCH : undefined);
  const scratchSeen = useRef(new Map<string, number>());
  const scratchKey = ws?.id ?? (mac ? 'mac' : undefined);
  const lookingScratch = scratchKey && tabShowing({ view, projects }, 'scratch', prefs);
  if (scratchKey && newest !== undefined && (lookingScratch || !scratchSeen.current.has(scratchKey))) scratchSeen.current.set(scratchKey, newest);
  const freshScratch = scratchKey && newest !== undefined ? newest > (scratchSeen.current.get(scratchKey) ?? newest) : false;
  return {
    ...(phoneBusy ? { phone: { tone: 'accent' as const } } : {}),
    ...(freshScratch ? { scratch: { tone: 'accent' as const } } : {}),
    ...(background ? { background: { tone: 'ok' as const } } : {}),
    ...(changed
      ? {
          changes: {
            count: changed,
            ...(fresh ? { tone: 'accent' as const } : {}),
          },
        }
      : {}),
    ...(ws && (running(runId(ws.id)) || running(setupId(ws.id))) ? { terminal: { tone: 'ok' as const } } : failed ? { terminal: { tone: 'error' as const } } : {}),
    ...(waiting ? { info: { tone: 'warn' as const } } : {}),
  };
}

/** What a dock's tabs and bodies (drawn by Dockview, inside this tree) need from it. */
interface DockShared {
  /** Which dock: the center's (the chat and what's beside it) or the right panel's. */
  readonly place: DockPlace;
  readonly badges: Badges;
  /** The panel has slid in: its tabs' content can be drawn. */
  readonly settled: boolean;
  /** The panel's groups under the top one are folded to their tabs. */
  readonly folded: boolean;
  /** Counts up when a group moves to or from the top row (its look and what folds follow). */
  readonly tick: number;
}
const DockContext = createContext<DockShared>({ place: 'panel', badges: {}, settled: true, folded: false, tick: 0 });

/** In the panel, a group in the top row leads (its tabs continue the toolbar); one under another is a dock that folds. */
const isLead = (group: DockviewGroupPanel): boolean => group.element.dataset.lead !== 'false';
const slotsOfGroup = (group: DockviewGroupPanel): DockTab[] => group.panels.map((p) => p.id as DockTab);
const hasMain = (group: DockviewGroupPanel): boolean => group.panels.some((p) => p.id === MAIN);

/** The two docks, while they're on screen, and where the window is (for a tab carried from one to the other). */
const docks: Partial<Record<DockPlace, DockviewApi>> = {};
const savers: Partial<Record<DockPlace, () => void>> = {};
let at: { key: string; view: View } | undefined;

/** Its group shows this tab right now (Dockview says). */
function useTabVisible(api: IDockviewPanelProps['api']): boolean {
  const [visible, setVisible] = useState(api.isVisible);
  useEffect(() => {
    setVisible(api.isVisible);
    const off = api.onDidVisibilityChange((e) => setVisible(e.isVisible));
    return () => off.dispose();
  }, [api]);
  return visible;
}

/** The tab a place in the dock stands for here: Changes' place is History on a project's page. */
function useTabOf(slot: PanelTab): PanelTab | undefined {
  const view = useApp((st) => st.view);
  const projects = useApp((st) => st.projects);
  usePanelRuntime((r) => r.phone);
  usePrefs();
  return groupTab({ view, projects }, [slot]);
}

type Where = NonNullable<Parameters<DockviewApi['addPanel']>[0]['position']>;

const addTab = (api: DockviewApi, slot: PanelTab, where: Where | undefined, more: { inactive?: boolean; initialHeight?: number } = {}): void => {
  api.addPanel({
    id: slot,
    component: 'tab',
    title: PANEL_LABELS[slot],
    // The terminal's box is never taken out of the page: moved to another group, it keeps its screen.
    renderer: slot === 'terminal' ? 'always' : 'onlyWhenVisible',
    ...(where ? { position: where } : {}),
    ...more,
  });
};

/**
 * Carry a tab to the other dock: beside the chat, or back to the panel. `where` is where it was
 * dropped; without one it goes where that dock puts a tab that joins (fitDock).
 */
export function carryTab(slot: PanelTab, to: DockPlace, where?: Where): void {
  if (!at) return;
  const from = docks[to === 'center' ? 'panel' : 'center'];
  const dst = docks[to];
  const moved = from?.getPanel(slot);
  if (moved) from!.removePanel(moved);
  if (dst && where && !dst.getPanel(slot)) addTab(dst, slot, where);
  const prefs = getPrefs();
  // The terminal's place is one choice for every view (Settings › Terminal); the others' is kept per set of tabs.
  if (slot === 'terminal') setPrefs({ termIn: to === 'center' ? 'drawer' : 'panel', drawer: true, ...(to === 'panel' ? { inspector: true } : {}) });
  else setPrefs({ centerTabs: placeInCenter(prefs.centerTabs, at.key, slot, to === 'center'), ...(to === 'panel' ? { inspector: true } : {}) });
  // It shows where it landed (Changes' place on the view it had).
  setPanelTab(at.view, groupTab({ view: at.view, projects: [] }, [slot]) ?? slot);
  savers.center?.();
  savers.panel?.();
}

/** The chat's own tab, when something shares its group: the conversation, or the page that's open. */
const CHATS: ReadonlySet<View['kind']> = new Set(['room', 'assistant', 'draft', 'draft_worktree', 'workspace', 'shared', 'conversation']);
function MainHead() {
  const kind = useApp((st) => st.view.kind);
  const label = CHATS.has(kind) ? 'Chat' : 'Page';
  return (
    <div className={s.tabIn} data-tab={MAIN} title={`${label} · tabs dragged here from the panel sit beside it`}>
      <Icon name={label === 'Chat' ? 'chat' : 'fileText'} size={13} />
      <span className={s.tabName}>
        <span>{label}</span>
      </span>
    </div>
  );
}

/**
 * A tab in a group's strip: its icon and name, and what it carries (changed files, something running).
 * Every strip's tabs are flat editor tabs (styles/dock.css: Dockview's Light shape in Beluga's colours), the same in the panel's top row, the docks under it and beside the chat.
 * Drag it along the strip, onto another group, to an edge to split there, or beside the chat; right-click to move it.
 */
function SlotHead({ api, containerApi }: IDockviewPanelHeaderProps) {
  const slot = api.id as PanelTab;
  const { place, badges, folded } = useContext(DockContext);
  const view = useApp((st) => st.view);
  const projects = useApp((st) => st.projects);
  // Changes' place is History where there are no changes to show (a project's page).
  const named: PanelTab = slot === 'changes' && !tabsOf({ view, projects }).includes('changes') ? 'history' : slot;
  const label = PANEL_LABELS[named];
  const b = badges[slot] ?? (slot === 'changes' ? badges.history : undefined);
  const items = (): ActionItem[] => {
    const group = api.group;
    const alone = group.panels.length < 2;
    const split: ActionItem = { label: 'Split to the Right', icon: 'panelRight', disabled: alone, onSelect: () => api.moveTo({ group, position: 'right' }) };
    const reset: ActionItem = { label: 'Reset Panel Layout', separate: true, onSelect: resetPanelLayout };
    if (place === 'center') return [{ label: 'Move to the Panel', icon: 'panelRight', onSelect: () => carryTab(slot, 'panel') }, split, reset];
    const others = containerApi.groups.filter((g) => g !== group);
    const below = others.filter((g) => !isLead(g)).sort((a, z) => z.element.getBoundingClientRect().top - a.element.getBoundingClientRect().top)[0];
    const above = others.find((g) => isLead(g));
    return [
      isLead(group)
        ? { label: 'Move to Bottom', icon: 'panelBottom', disabled: alone && !below, onSelect: () => api.moveTo(below ? { group: below } : { group, position: 'bottom' }) }
        : { label: 'Move to Top', icon: 'panelRight', disabled: alone && !above, onSelect: () => api.moveTo(above ? { group: above } : { group, position: 'top' }) },
      split,
      { label: 'Move Beside the Chat', icon: 'sidebar', onSelect: () => carryTab(slot, 'center') },
      reset,
    ];
  };
  return (
    <ActionsContext items={items}>
      <div
        className={s.tabIn}
        data-tab={slot}
        title={`${label}${shortcutKeys(`panel-${named}`) ? ` (${shortcutKeys(`panel-${named}`)})` : ''} · drag it to another group, an edge, or beside the chat; right-click to move it`}
        onClick={() => {
          // A folded dock opens from any of its tabs (the one it already shows, too).
          if (place === 'panel' && folded && !isLead(api.group)) setDockOpen(true);
        }}
      >
        <Icon name={ICONS[named]} size={13} />
        <span className={s.tabName}>
          <span>{label}</span>
        </span>
        {b?.count ? <span className={cx(s.count, b.tone === 'accent' && s.countFresh)}>{b.count > 99 ? '99+' : b.count}</span> : b?.tone ? <span className={cx(s.tabDot, s[`tabDot_${b.tone}`])} /> : null}
      </div>
    </ActionsContext>
  );
}

function TabHead(props: IDockviewPanelHeaderProps) {
  return props.api.id === MAIN ? <MainHead /> : <SlotHead {...props} />;
}

/** At the end of a dock's strip (a group under another one, in the panel): fold it to its tabs, or open it again. */
function GroupActions({ group }: IDockviewHeaderActionsProps) {
  const { place, folded } = useContext(DockContext);
  if (place !== 'panel' || isLead(group)) return null;
  return <IconButton icon={folded ? 'chevronUp' : 'chevronDown'} label={folded ? 'Show the terminal dock' : 'Hide the terminal dock'} keys={shortcutKeys('toggle-dock')} className={s.paneToggle} onClick={() => setDockOpen(folded)} />;
}

/** Changes' second view, switched at its top: what changed, or the branch's History. */
function ViewSwitch({ views, tab }: { views: readonly PanelTab[]; tab: PanelTab }) {
  const view = useApp((st) => st.view);
  if (views.length < 2) return null;
  return (
    <div className={s.views}>
      <Segmented
        size="small"
        radio
        label={`${PANEL_LABELS[views[0]!]} views`}
        value={tab}
        onChange={(v) => setPanelTab(view, v)}
        options={views.map((v) => ({
          value: v,
          label: PANEL_LABELS[v],
          keys: shortcutKeys(`panel-${v}`),
        }))}
      />
    </div>
  );
}

/**
 * A tab's place in a dock: Changes' view switch, and the tab's content while it shows. The
 * terminal stays as it is once it has shown (hidden behind another tab, or moved to another
 * group, it keeps its screen); the rest are drawn when you look at them.
 */
function TabBody({ api }: IDockviewPanelProps) {
  const slot = api.id as PanelTab;
  const { place, settled, folded } = useContext(DockContext);
  const view = useApp((st) => st.view);
  const projects = useApp((st) => st.projects);
  const tab = useTabOf(slot);
  const visible = useTabVisible(api);
  const wsId = view.kind === 'workspace' ? view.id : undefined;
  // On a project's page, Files is its main folder.
  const mainId = useApp((st) => (view.kind === 'project' ? filesWsOf(st) : undefined));
  const making = useMaking();
  const docked = place === 'panel' && !isLead(api.group);
  // Under the chat with a group to itself, the terminal is put away with ⌘J (its group hides; its box, kept in the page, must too).
  const away = usePrefs().drawer === false && slot === 'terminal' && place === 'center' && api.group.panels.length === 1;
  const showing = visible && !(folded && docked) && !away;
  const [shown, setShown] = useState(showing);
  useEffect(() => {
    if (showing) setShown(true);
  }, [showing]);
  if (!tab) return null;
  const keep = slot === 'terminal' && shown;
  // Under the chat with a group to itself, the terminal has a ✕ (as its drawer had).
  const alone = slot === 'terminal' && place === 'center' && api.group.panels.length === 1;
  return (
    <div className={s.body} data-panel-body={slot} data-panel-dock={docked} data-away={away} hidden={!showing}>
      {showing ? <ViewSwitch views={viewsOf(tab, tabsOf({ view, projects }))} tab={tab} /> : null}
      {/* A worktree being made has no folder yet: its tabs fill in once it's there. And while the
          panel slides in, the tab waits: drawing a file's preview or a long diff then stalled the slide. */}
      {making || !settled ? (
        <div className={s.loading} />
      ) : showing || keep ? (
        <ViewBoundary at={`${wsId}:${tab}`}>
          <Suspense fallback={<div className={s.loading} />}>
            <Body tab={tab} wsId={wsId} under={place === 'center'} {...(alone ? { onClose: putAway } : {})} {...(view.kind === 'project' ? { projectId: view.id, mainId } : {})} {...(view.kind === 'shared' ? { sharedWs: { id: view.id, owner: view.owner } } : {})} {...(view.kind === 'assistant' ? { mac: true } : {})} />
          </Suspense>
        </ViewBoundary>
      ) : null}
    </div>
  );
}

const putAway = (): void => setPrefs({ drawer: false });

/** The tab's content. Memoized: the panel re-renders as the conversation streams; its tabs only when their own data changes. */
const Body = memo(function Body({ tab, wsId, projectId, mainId, sharedWs, mac, under, onClose }: { tab: PanelTab; wsId: string | undefined; projectId?: string; mainId?: string | undefined; sharedWs?: { id: string; owner: string }; mac?: boolean; under?: boolean; onClose?: () => void }) {
  switch (tab) {
    case 'changes':
      return wsId ? <ChangesTab key={wsId} wsId={wsId} /> : null;
    case 'files':
      return wsId ? <FilesTab key={wsId} wsId={wsId} /> : mainId ? <FilesTab key={mainId} wsId={mainId} project /> : null;
    case 'terminal':
      return <TerminalPane where={under ? 'drawer' : 'panel'} {...(onClose ? { onClose } : {})} />;
    case 'info':
      return (
        <div className={s.info}>
          <Inspector />
        </div>
      );
    case 'scratch':
      return wsId ? <ScratchTab key={wsId} of={{ wsId }} /> : sharedWs ? <ScratchTab key={sharedWs.id} of={{ wsId: sharedWs.id, owner: sharedWs.owner }} /> : mac ? <ScratchTab key="mac" of={MAC_SCRATCH} /> : null;
    case 'background':
      return wsId ? <BackgroundTab key={wsId} wsId={wsId} /> : null;
    case 'history': {
      const target = wsId ?? projectId;
      return target ? <HistoryTab key={target} target={target} /> : null;
    }
    case 'phone':
      return <PhonePanel />;
  }
});

/** The Phone tab is there while an Android phone is paired (BLG-186). */
function usePhoneTabBridge(): void {
  const paired = useApp((st) => st.companion.devices.some((d) => d.platform !== 'ios'));
  useEffect(() => setPhoneTab(paired), [paired]);
}

/**
 * Opening a file yourself (a link in the chat, Open File in a diff) shows it in the Files tab.
 * Not while a file is open full size: a link in it opens the next page right there.
 */
function useFileFollow(): void {
  const { client } = useBeluga();
  const opened = useApp((st) => (st.viewer && !st.viewer.by ? `${st.viewer.owner}\n${st.viewer.share}\n${st.viewer.path}` : ''));
  const first = useRef(true);
  useEffect(() => {
    if (first.current) return void (first.current = false);
    const state = client.store.getState();
    const v = state.view;
    if (!opened || v.kind !== 'workspace' || focusFor(v.id)) return;
    const [owner, share] = opened.split('\n');
    if (owner === state.selfId && share === shareNameOf(v.id)) showPanelTab(state, 'files');
  }, [opened]);
}

/** What keeps the panel in step with the window, whether it shows or not (the workbench runs it once). */
export function usePanelBridges(): void {
  const { client } = useBeluga();
  useWorkspaceTabBridge(client);
  usePhoneTabBridge();
  useFileFollow();
}

/** This view's tabs, and which of them sit beside the chat instead of in the panel. */
function useDockTabs(): { tabs: PanelTab[]; key: string; central: PanelTab[]; inPanel: PanelTab[] } {
  const prefs = usePrefs();
  const view = useApp((st) => st.view);
  const projects = useApp((st) => st.projects);
  usePanelRuntime((r) => r.phone);
  const tabs = tabsOf({ view, projects });
  const key = layoutKey(tabs);
  // The terminal is under the chat where you keep it there, and wherever the panel has no Terminal tab (⌘J opens one all the same).
  const under = terminalUnderChat(prefs.termIn, tabs, view);
  const all = slotsFor(under && !tabs.includes('terminal') ? [...tabs, 'terminal'] : tabs);
  const central = all.filter((t) => (t === 'terminal' ? under : centerSlots(prefs.centerTabs, key, all).includes(t)));
  return { tabs, key, central, inPanel: all.filter((t) => !central.includes(t)) };
}

/** The panel shows: you have it open, this view has one (not a plan's page: its chat is its right side), and not all its tabs are beside the chat. */
export function usePanelOpen(): boolean {
  const prefs = usePrefs();
  const view = useApp((st) => st.view);
  const { inPanel } = useDockTabs();
  return prefs.inspector && panelFits(view) && inPanel.length > 0;
}

/** The panel's dock as it starts: what Claude made on top, what runs in a group below it. */
function startDock(api: DockviewApi, slots: readonly PanelTab[]): void {
  const prefs = getPrefs();
  const { top, bottom } = startGroups(slots, prefs.panelLayout);
  top.forEach((slot, i) => addTab(api, slot, i ? { referencePanel: top[0]!, direction: 'within' } : undefined, { inactive: i > 0 }));
  const share = 1 - clampShare(prefs.paneSplit, SPLIT_MIN, SPLIT_MAX);
  bottom.forEach((slot, i) => addTab(api, slot, i ? { referencePanel: bottom[0]!, direction: 'within' } : { referencePanel: top[0]!, direction: 'below' }, i ? { inactive: true } : api.height > 0 ? { initialHeight: Math.round(api.height * share) } : {}));
}

/**
 * A dock holds exactly its tabs: the others leave, a new one joins. In the panel, beside the tabs
 * it starts with; in the center, beside the tabs already there, else in a group right of the chat.
 * The center always has the chat.
 */
function fitDock(api: DockviewApi, place: DockPlace, slots: readonly PanelTab[]): void {
  const start = getPrefs().panelLayout;
  // The chat's box is never taken out of the page either: beside whatever you put there, it keeps its place in the conversation.
  if (place === 'center' && !api.getPanel(MAIN)) api.addPanel({ id: MAIN, component: 'main', title: 'Chat', renderer: 'always' });
  for (const panel of [...api.panels]) if (panel.id !== MAIN && !slots.includes(panel.id as PanelTab)) api.removePanel(panel);
  for (const slot of slots) {
    if (api.getPanel(slot)) continue;
    if (place === 'center') {
      // The terminal goes under the chat, across the center (where its drawer was); the rest beside it.
      const prefs = getPrefs();
      const height = api.height > 0 ? { initialHeight: Math.round(api.height * clampShare(prefs.drawerSize, DRAWER_MIN, DRAWER_MAX)) } : {};
      const beside = api.groups.find((g) => !hasMain(g) && !g.panels.some((p) => p.id === 'terminal'));
      if (slot === 'terminal') addTab(api, slot, { direction: 'below' }, height);
      else addTab(api, slot, beside ? { referenceGroup: beside, direction: 'within' } : { referencePanel: MAIN, direction: 'right' });
      continue;
    }
    const groups = api.groups.map((g) => slotsOfGroup(g) as PanelTab[]);
    const home = api.groups[homeGroup(slot, groups, start)];
    // In its usual place among the tabs it starts beside (Changes first, Info after Scratch).
    const order = [...start.top, ...start.bottom];
    const index = home ? (slotsOfGroup(home) as PanelTab[]).filter((t) => order.indexOf(t) < order.indexOf(slot)).length : 0;
    if (home) addTab(api, slot, { referenceGroup: home, direction: 'within', index }, { inactive: true });
    else addTab(api, slot, api.groups.length ? { direction: DEFAULT_LAYOUT.bottom.includes(slot) ? 'below' : 'above' } : undefined);
  }
}

/**
 * A dock: tabs in groups you arrange (drag a tab onto another group, or to an edge to split there;
 * drag the dividers). There are two: the right panel's, and the center's, where the chat is a tab
 * and a tab dragged over from the panel sits beside it. Views with the same tabs share one
 * arrangement, kept in the window's preferences; each place remembers which tabs it showed.
 */
function TabDock({ place, settled = true, onMinWidth, main }: { place: DockPlace; settled?: boolean; onMinWidth?: (px: number) => void; main?: FunctionComponent<IDockviewPanelProps> }) {
  const { client } = useBeluga();
  const prefs = usePrefs();
  const view = useApp((st) => st.view);
  const reset = usePanelRuntime((r) => r.reset);
  const { key, central, inPanel } = useDockTabs();
  const slots = place === 'center' ? central : inPanel;
  const saveKey = place === 'center' ? centerKey(key) : key;
  at = { key, view };
  const badges = useBadges();
  const root = useRef<HTMLDivElement>(null);
  const [api, setApi] = useState<DockviewApi>();
  const [tick, setTick] = useState(0);
  /** Changing the dock ourselves (not you): nothing to remember from it. */
  const applying = useRef(0);
  const live = useRef({ key: saveKey, reset, heights: new Map<string, number>(), leads: '', save: undefined as ReturnType<typeof setTimeout> | undefined });
  const folded = place === 'panel' && !prefs.bottomOpen;
  const components = useMemo(() => ({ tab: TabBody, ...(main ? { main } : {}) }), [main]);
  // The most the center can be given (the window, less the sidebar and the narrowest panel): the chat's minimum gives way to it.
  const { centerRoom } = useContext(FrameContext);
  const room = useRef(centerRoom);
  room.current = centerRoom;

  const ours = (run: () => void): void => {
    applying.current++;
    try {
      run();
    } finally {
      applying.current--;
    }
  };

  /** Which groups lead and which are docks, told to their styles, to what folds, and to lib/panel. */
  const mark = (dock: DockviewApi): void => {
    const box = root.current?.getBoundingClientRect();
    if (!box?.height) return;
    // Beside the chat: the groups that share its width (not the terminal under it).
    const beside = place === 'center' ? dock.groups.filter((g) => !hasMain(g) && !(g.panels.length === 1 && g.panels[0]!.id === 'terminal')).length : 0;
    const chatMin = Math.max(CHAT_FLOOR_W, Math.min(CHAT_MIN_W, room.current - beside * GROUP_MIN_W));
    for (const group of dock.groups) {
      // Dockview names each group a region after its tab: the tab's content is the region here (the Terminal, a file's preview), and its strip the tab list.
      group.element.removeAttribute('role');
      if (place === 'center') {
        group.element.dataset.strip = 'dock';
        group.model.tabsListElement.setAttribute('aria-label', 'Center');
        // The chat alone has no strip: it's the center, as ever.
        const alone = group.panels.length === 1 && hasMain(group);
        if (group.header.hidden !== alone) group.header.hidden = alone;
        // The chat keeps room for its message box; what's beside it, room to read.
        const min = String(hasMain(group) ? chatMin : GROUP_MIN_W);
        if (group.element.dataset.minWidth !== min) {
          group.element.dataset.minWidth = min;
          group.api.setConstraints({ minimumWidth: Number(min), minimumHeight: GROUP_MIN_H });
        }
        fitTabs(group);
        continue;
      }
      const lead = group.element.getBoundingClientRect().top - box.top < 2;
      group.element.dataset.lead = String(lead);
      group.element.dataset.strip = lead ? 'lead' : 'dock';
      group.model.tabsListElement.setAttribute('aria-label', lead ? 'Panel' : 'Panel bottom');
      // The top row's empty strip moves the window, as the toolbar beside it does.
      const strip = group.element.querySelector('.dv-void-container');
      if (lead) strip?.setAttribute('data-tauri-drag-region', '');
      else strip?.removeAttribute('data-tauri-drag-region');
      fitTabs(group);
    }
    const docked = place === 'panel' ? dock.groups.filter((g) => !isLead(g)) : [];
    setDock(place, dock.groups.map(slotsOfGroup), docked.flatMap((g) => slotsOfGroup(g) as PanelTab[]));
    onMinWidth?.(dock.minimumWidth);
    const leads = dock.groups.map((g) => `${g.id}:${isLead(g)}:${slotsOfGroup(g).join('+')}`).join();
    if (leads !== live.current.leads) {
      live.current.leads = leads;
      setTick((n) => n + 1);
    }
  };

  /** Folded, a dock is as tall as its tabs; unfolded, as tall as it was. */
  const fold = (dock: DockviewApi, fold: boolean): void => {
    const { heights } = live.current;
    for (const group of dock.groups) {
      if (fold && !isLead(group)) {
        if (!heights.has(group.id)) heights.set(group.id, group.api.height);
        // As tall as its strip (the toolbar's height, from the styles).
        const strip = group.element.querySelector<HTMLElement>('.dv-tabs-and-actions-container')?.offsetHeight || DOCK_HEAD;
        group.api.setConstraints({ minimumWidth: GROUP_MIN_W, minimumHeight: strip, maximumHeight: strip });
        continue;
      }
      group.api.setConstraints({ minimumWidth: GROUP_MIN_W, minimumHeight: GROUP_MIN_H, maximumHeight: Number.MAX_SAFE_INTEGER });
      const was = heights.get(group.id);
      if (was === undefined) continue;
      heights.delete(group.id);
      // Saved while folded, its own height is its tabs': it opens to its usual share instead.
      group.api.setSize({ height: was > DOCK_HEAD * 2 ? was : Math.round(dock.height * (1 - PANES_DEFAULT)) });
    }
  };

  /** Each group shows the tab you showed last here; Changes' place is named for what it holds. */
  const show = (dock: DockviewApi): void =>
    ours(() => {
      const now = client.store.getState();
      for (const group of dock.groups) {
        const want = groupTab(now, slotsOfGroup(group));
        const panel = want ? dock.getPanel(slotOf(want)) : undefined;
        if (panel && group.activePanel !== panel) panel.api.setActive();
      }
      const changes = dock.getPanel('changes');
      const title = PANEL_LABELS[tabsOf(now).includes('changes') ? 'changes' : 'history'];
      if (changes && changes.title !== title) changes.api.setTitle(title);
    });

  /** You picked a tab in the dock (a click, a drop): it's what this place shows from now on. */
  const note = (dock: DockviewApi): void => {
    if (applying.current) return;
    const now = client.store.getState();
    for (const group of dock.groups) {
      const active = group.activePanel?.id as DockTab | undefined;
      const shown = groupTab(now, slotsOfGroup(group));
      if (!active || (shown && slotOf(shown) === active)) continue;
      setPanelTab(now.view, groupTab(now, [active]) ?? active);
    }
  };

  const save = (dock: DockviewApi, at: string): void => {
    clearTimeout(live.current.save);
    live.current.save = undefined;
    // Folded, the docks' heights are their tabs': the arrangement from before the fold stays saved.
    if (!dock.panels.length || (place === 'panel' && !getPrefs().bottomOpen && dock.groups.some((g) => !isLead(g)))) return;
    setPrefs({ dockLayouts: rememberLayout(getPrefs().dockLayouts, at, dock.toJSON()) });
  };

  // This view's tabs, arranged as you left them (or as the dock starts).
  useLayoutEffect(() => {
    if (!api) return;
    const was = live.current;
    const again = was.reset !== reset;
    // Somewhere with other tabs: what you arranged where you were is kept first.
    if (was.key !== saveKey && !again && was.save) save(api, was.key);
    clearTimeout(was.save);
    live.current = { ...was, key: saveKey, reset, save: undefined, heights: new Map() };
    ours(() => {
      const saved = again ? undefined : getPrefs().dockLayouts[saveKey];
      let loaded = false;
      if (usableLayout(saved)) {
        try {
          // What's already there stays as it is (the chat, the terminal): only its place changes.
          api.fromJSON(saved as SerializedDockview, { reuseExistingPanels: true });
          loaded = true;
        } catch {
          api.clear();
        }
      }
      if (!loaded && place === 'panel' && (again || !api.panels.length)) {
        api.clear();
        startDock(api, slots);
      }
      fitDock(api, place, slots);
      mark(api);
      if (place === 'panel') fold(api, !getPrefs().bottomOpen);
    });
    show(api);
  }, [api, saveKey, reset]);

  // A tab carried to or from the other dock (or one that came or went: a phone paired, Scratch turned off).
  const held = slots.join();
  useLayoutEffect(() => {
    if (!api) return;
    ours(() => {
      fitDock(api, place, slots);
      mark(api);
    });
  }, [api, held]);

  // The tabs each group shows follow what's remembered here (another workspace, a tab shown from elsewhere, the first change).
  const recent = recentTabs(view, prefs).join();
  const changed = useApp((st) => (view.kind === 'workspace' ? (findWorkspace(st.projects, view.id)?.status?.changed ?? 0) + (findWorkspace(st.projects, view.id)?.status?.ahead ?? 0) > 0 : false));
  useLayoutEffect(() => {
    if (api) show(api);
  }, [api, saveKey, held, recent, changed, view.kind === 'workspace' ? view.id : view.kind]);

  useLayoutEffect(() => {
    if (!api || place !== 'panel') return;
    ours(() => fold(api, folded));
  }, [api, folded, tick]);

  // Under the chat, the terminal with a group to itself is put away and brought back (⌘J, its ✕): what its drawer did.
  useLayoutEffect(() => {
    const group = place === 'center' ? api?.getPanel('terminal')?.group : undefined;
    if (!group) return;
    const visible = group.panels.length > 1 || prefs.drawer;
    if (group.api.isVisible !== visible) ours(() => group.api.setVisible(visible));
  }, [api, prefs.drawer, held, tick, saveKey]);

  // What you do in the dock: remembered, and saved once it settles.
  useEffect(() => {
    if (!api) return;
    docks[place] = api;
    const other = (): DockviewApi | undefined => docks[place === 'center' ? 'panel' : 'center'];
    /** A tab dragged over from the other dock (never the chat itself). */
    const fromOther = (data: { viewId: string; panelId: string | null } | undefined): PanelTab | undefined => (data?.panelId && data.panelId !== MAIN && data.viewId === other()?.id ? (data.panelId as PanelTab) : undefined);
    // What you arranged (a divider dragged, a tab dropped) is saved once it settles; what the dock
    // does by itself (another view's tabs, a fold) isn't an arrangement of yours.
    const touched = (): void => {
      if (applying.current) return;
      clearTimeout(live.current.save);
      live.current.save = setTimeout(() => save(api, live.current.key), SAVE_MS);
    };
    savers[place] = () => save(api, live.current.key);
    const offs = [
      api.onDidLayoutChange(() => mark(api)),
      api.onDidActivePanelChange((e) => {
        // The tab you're on keeps its name in a tight strip: the others make room for it.
        if (e.panel?.group) fitTabs(e.panel.group);
        if (e.origin !== 'user') return;
        tabPicked();
        note(api);
      }),
      // A tab dropped somewhere else shows there.
      api.onDidMovePanel(() => {
        note(api);
        touched();
      }),
      api.onDidAddGroup((group) => {
        if (place === 'center') group.api.setConstraints({ minimumWidth: GROUP_MIN_W, minimumHeight: GROUP_MIN_H });
        requestAnimationFrame(() => mark(api));
      }),
      // A tab from the other dock can land here: beside the chat, or back in the panel.
      api.onUnhandledDragOver((e) => {
        if (fromOther(e.getData())) e.accept();
      }),
      api.onDidDrop((e) => {
        const slot = fromOther(e.getData());
        if (!slot) return;
        const direction = positionToDirection(e.position);
        const where: Where | undefined = e.group ? { referenceGroup: e.group, direction, ...(e.index !== undefined ? { index: e.index } : {}) } : direction === 'within' ? undefined : { direction };
        carryTab(slot, place, where ?? (place === 'center' ? { referencePanel: MAIN, direction: 'right' } : undefined));
      }),
    ];
    const frame = requestAnimationFrame(() => mark(api));
    const el = root.current;
    const sash = (e: Event): void => {
      if (e.target instanceof Element && e.target.closest('.dv-sash')) window.addEventListener('pointerup', touched, { once: true, capture: true });
    };
    el?.addEventListener('pointerdown', sash, true);
    el?.addEventListener('drop', touched, true);
    el?.addEventListener('dragend', touched, true);
    // Quit, reload or close the window right after arranging something: it's saved first, not lost with the wait.
    const flush = (): void => {
      if (live.current.save) save(api, live.current.key);
    };
    const hidden = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', hidden);
    // A narrower or wider dock (the window, a divider): its tabs fit again.
    const resized = new ResizeObserver(() => {
      for (const group of api.groups) fitTabs(group);
    });
    if (el) resized.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      resized.disconnect();
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', hidden);
      el?.removeEventListener('pointerdown', sash, true);
      el?.removeEventListener('drop', touched, true);
      el?.removeEventListener('dragend', touched, true);
      window.removeEventListener('pointerup', touched, true);
      for (const off of offs) off.dispose();
      if (live.current.save) save(api, live.current.key);
      if (docks[place] === api) delete docks[place];
      delete savers[place];
      setDock(place, []);
    };
  }, [api]);

  // A window with less room for the center: the chat's minimum gives way.
  useLayoutEffect(() => {
    if (api && place === 'center') mark(api);
  }, [api, centerRoom]);

  const shared = useMemo<DockShared>(() => ({ place, badges, settled, folded, tick }), [place, JSON.stringify(badges), settled, folded, tick]);
  // A badge came or went (a count, a dot): the tabs fit again.
  useLayoutEffect(() => {
    if (api) for (const group of api.groups) fitTabs(group);
  }, [api, shared]);
  return (
    <DockContext.Provider value={shared}>
      {/* Dockview's own announcements are off: it changes tabs for every view you open (not you), so VoiceOver heard "Terminal opened" at each one. */}
      <div ref={root} className={cx(s.dockRoot, place === 'center' && s.centerDock)} data-dock={place} data-folded={folded}>
        <DockviewReact className={s.dockview} theme={DOCK_THEME} components={components} defaultTabComponent={TabHead} rightHeaderActionsComponent={GroupActions} disableFloatingGroups disableTabsOverflowList announcements={false} onReady={(e) => setApi(e.api)} />
      </div>
    </DockContext.Provider>
  );
}

/**
 * The center's dock: the chat (or the page that's open) is its one tab, drawn by `main`, with no
 * strip while it's alone. A tab dragged over from the panel sits beside it, in the same group or split off.
 */
export function CenterDock({ main, onMinWidth }: { main: FunctionComponent<IDockviewPanelProps>; onMinWidth?: (px: number) => void }) {
  return <TabDock place="center" main={main} onMinWidth={onMinWidth} />;
}

/**
 * The right side of the window: a dock of tabs (Changes, Files, Scratch, Info on top; Terminal and
 * Background in a dock below, to start with) that you arrange as you like. It shows and hides
 * with ⌥⌘0, is as wide as you drag it (the workbench's divider), and each workspace remembers its tabs.
 */
export function RightPanel({ onMinWidth }: { onMinWidth: (px: number) => void }) {
  const open = usePanelOpen();
  const { onPanelOpen } = useContext(FrameContext);
  // The frame gives the panel its room (or takes it back) when this says so.
  useLayoutEffect(() => onPanelOpen(open), [open]);
  // The tabs' content is drawn once the panel has slid in (open at launch: at once).
  const [settled, setSettled] = useState(open);
  useEffect(() => {
    if (!open) return setSettled(false);
    const reduce = document.documentElement.dataset.motion === 'reduce' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const t = setTimeout(() => setSettled(true), reduce ? 0 : SLIDE_MS);
    return () => clearTimeout(t);
  }, [open]);
  return (
    <aside className={s.panel} aria-label="Panel" aria-hidden={!open} inert={!open}>
      {open ? (
        <div className={cx(s.inner, settled && s.settled)}>
          <TabDock place="panel" settled={settled} onMinWidth={onMinWidth} />
        </div>
      ) : null}
    </aside>
  );
}
