import { type GridviewApi, type GridviewPanelApi, GridviewReact, type IGridviewPanelProps, LayoutPriority, Orientation } from 'dockview-react';
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cx } from '../components/ui.js';
import { CENTER_FLOOR, PANEL_DEFAULT, PANEL_MIN, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, clampPanelWidth } from '../lib/panel-model.js';
import { getPrefs, setPrefs, usePrefs } from '../lib/prefs.js';
import { usePhoneLayout } from '../lib/phone-layout.js';
import { FrameContext } from './frame.js';
import { PhoneFrame } from './PhoneFrame.js';
import { CenterPane, PanelPane } from '../machines/MachinePane.js';
import { DOCK_THEME } from './RightPanel.js';
import { Sidebar } from './Sidebar.js';
import { ResizeHandle, useWindowWidth } from './panel/ResizeHandle.js';
import s from './Shell.module.css';

const STEP = 24;
/** What the glass panes' gaps and the dividers take from the center's room. */
const ROOM_SLACK = 24;

function SidebarRegion({ api }: IGridviewPanelProps) {
  const prefs = usePrefs();
  if (!prefs.sidebar) return null;
  return (
    <div className={s.region}>
      <Sidebar />
      <ResizeHandle
        axis="x"
        label="Resize the sidebar"
        className={cx(s.edgeKeys, s.edgeRight)}
        onMove={() => undefined}
        onReset={() => setPrefs({ sidebarWidth: SIDEBAR_DEFAULT })}
        // The handle is the sidebar's right edge: → widens it.
        onStep={(dir) => setPrefs({ sidebarWidth: Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, api.width - dir * STEP)) })}
      />
    </div>
  );
}

function CenterRegion() {
  return (
    <div className={s.region} data-region="center">
      {/* This Mac's center, or a page on one of your computers drawn with its client (BLG-784). */}
      <CenterPane />
    </div>
  );
}

function PanelRegion({ api }: IGridviewPanelProps) {
  const { onPanelMin, panelOpen: open } = useContext(FrameContext);
  const prefs = usePrefs();
  const sidebarWidth = prefs.sidebar ? prefs.sidebarWidth : 0;
  return (
    <div className={s.region}>
      {open ? (
        <ResizeHandle
          axis="x"
          label="Resize the panel"
          className={cx(s.edgeKeys, s.edgeLeft)}
          onMove={() => undefined}
          onReset={() => setPrefs({ panelWidth: PANEL_DEFAULT })}
          onStep={(dir) => setPrefs({ panelWidth: clampPanelWidth(api.width + dir * STEP, window.innerWidth, sidebarWidth) })}
        />
      ) : null}
      <PanelPane onMinWidth={onPanelMin} />
    </div>
  );
}

const REGIONS = { sidebar: SidebarRegion, center: CenterRegion, panel: PanelRegion };

const regionApi = (frame: GridviewApi, id: keyof typeof REGIONS): GridviewPanelApi | undefined => frame.getPanel(id)?.api as GridviewPanelApi | undefined;

/** The window's frame: the desktop's three regions, or one column on a phone-wide window (BLG-6). */
export function Workbench() {
  return usePhoneLayout() ? <PhoneFrame /> : <DesktopFrame />;
}

/**
 * The desktop frame (Dockview's Gridview, as VS Code's workbench is laid out): the sidebar, the
 * center and the right panel, side by side with a divider to drag between them. The sidebar and the
 * panel keep the width you give them and show or hide in one step; the center takes the rest.
 * Inside the panel is a dock of its own (RightPanel).
 */
function DesktopFrame() {
  const prefs = usePrefs();
  const [panelOpen, setPanelOpen] = useState(false);
  const windowWidth = useWindowWidth();
  const [frame, setFrame] = useState<GridviewApi>();
  const [panelMin, setPanelMin] = useState(PANEL_MIN);
  const [centerMin, setCenterMin] = useState(CENTER_FLOOR);
  const root = useRef<HTMLDivElement>(null);
  const sidebarWidth = prefs.sidebar ? prefs.sidebarWidth : 0;
  // The panel never covers the center's room (nor gets narrower than the groups in its dock).
  const panelFloor = Math.max(PANEL_MIN, panelMin);
  const panelMax = Math.max(panelFloor, clampPanelWidth(Number.MAX_SAFE_INTEGER, windowWidth, sidebarWidth));
  const panelWidth = Math.min(panelMax, Math.max(panelFloor, prefs.panelWidth));

  useLayoutEffect(() => {
    if (!frame) return;
    const sidebar = regionApi(frame, 'sidebar');
    if (!sidebar) return;
    if (sidebar.isVisible !== prefs.sidebar) sidebar.setVisible(prefs.sidebar);
    if (prefs.sidebar && sidebar.width !== prefs.sidebarWidth) sidebar.setSize({ width: prefs.sidebarWidth });
  }, [frame, prefs.sidebar, prefs.sidebarWidth]);

  useLayoutEffect(() => {
    if (!frame) return;
    const panel = regionApi(frame, 'panel');
    if (!panel) return;
    panel.setConstraints({ minimumWidth: panelFloor, maximumWidth: panelMax });
    if (panel.isVisible !== panelOpen) panel.setVisible(panelOpen);
    if (panelOpen && panel.width !== panelWidth) panel.setSize({ width: panelWidth });
  }, [frame, panelOpen, panelWidth, panelFloor, panelMax]);

  // The center never gets narrower than the groups in its dock (the chat, and what's beside it),
  // nor asks for more than the window has (its dock's groups give way first: centerRoom).
  const centerRoom = Math.max(CENTER_FLOOR, windowWidth - sidebarWidth - (panelOpen ? PANEL_MIN : 0) - ROOM_SLACK);
  const centerFloor = Math.min(centerRoom, Math.max(CENTER_FLOOR, centerMin));
  useLayoutEffect(() => {
    if (frame) regionApi(frame, 'center')?.setConstraints({ minimumWidth: centerFloor });
  }, [frame, centerFloor]);
  const shared = useMemo(() => ({ onPanelMin: setPanelMin, onCenterMin: setCenterMin, onPanelOpen: setPanelOpen, panelOpen, centerRoom }), [panelOpen, centerRoom]);

  // A divider you dragged: the width is kept when you let go (a window that got narrower changes nothing you chose).
  useEffect(() => {
    const el = root.current;
    if (!frame || !el) return;
    // Only the frame's own dividers (the dock inside the panel has its own).
    const ownSash = (target: EventTarget | null): number => {
      const sash = target instanceof Element ? target.closest('.dv-sash') : null;
      const own = [...el.querySelectorAll('.dv-sash')].filter((x) => !x.closest('.dv-dockview'));
      return sash ? own.indexOf(sash) : -1;
    };
    let dragging = false;
    const keep = (): void => {
      const now = getPrefs();
      const sidebar = regionApi(frame, 'sidebar');
      const panel = regionApi(frame, 'panel');
      const next = {
        ...(sidebar?.isVisible && sidebar.width !== now.sidebarWidth ? { sidebarWidth: Math.round(sidebar.width) } : {}),
        ...(panel?.isVisible && panel.width !== now.panelWidth ? { panelWidth: Math.round(panel.width) } : {}),
      };
      if (Object.keys(next).length) setPrefs(next);
    };
    const down = (e: PointerEvent): void => {
      dragging = ownSash(e.target) >= 0;
      if (dragging) document.documentElement.dataset.resizing = 'x';
    };
    const up = (): void => {
      if (!dragging) return;
      dragging = false;
      delete document.documentElement.dataset.resizing;
      keep();
    };
    // Double-click a divider: that side goes back to its usual width. Which side is where it is
    // (left of the center's middle: the sidebar's), whichever regions show.
    const twice = (e: MouseEvent): void => {
      if (ownSash(e.target) < 0) return;
      const center = el.querySelector('[data-region="center"]')?.getBoundingClientRect();
      const sidebarSash = center ? e.clientX < center.left + center.width / 2 : false;
      setPrefs(sidebarSash ? { sidebarWidth: SIDEBAR_DEFAULT } : { panelWidth: PANEL_DEFAULT });
    };
    el.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    el.addEventListener('dblclick', twice, true);
    return () => {
      el.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      el.removeEventListener('dblclick', twice, true);
      delete document.documentElement.dataset.resizing;
    };
  }, [frame]);

  return (
    <FrameContext.Provider value={shared}>
      <div ref={root} className={cx(s.frame, DOCK_THEME.className)}>
        <GridviewReact
          className={s.grid}
          orientation={Orientation.HORIZONTAL}
          // The center takes what a wider or narrower window gives: the sides keep their width.
          proportionalLayout={false}
          hideBorders
          components={REGIONS}
          onReady={({ api }) => {
            const now = getPrefs();
            api.addPanel({ id: 'center', component: 'center', minimumWidth: CENTER_FLOOR, priority: LayoutPriority.High });
            api.addPanel({ id: 'sidebar', component: 'sidebar', position: { referencePanel: 'center', direction: 'left' }, size: now.sidebarWidth, minimumWidth: SIDEBAR_MIN, maximumWidth: SIDEBAR_MAX, priority: LayoutPriority.Low });
            api.addPanel({ id: 'panel', component: 'panel', position: { referencePanel: 'center', direction: 'right' }, size: now.panelWidth, minimumWidth: PANEL_MIN, priority: LayoutPriority.Low });
            setFrame(api);
          }}
        />
      </div>
    </FrameContext.Provider>
  );
}
