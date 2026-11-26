import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { IconButton, cx } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { phoneEntryPrefs, phoneExitPrefs } from '../lib/phone-layout.js';
import { getPrefs, setPrefs, usePrefs } from '../lib/prefs.js';
import { CenterPane, PanelPane } from '../machines/MachinePane.js';
import { FrameContext } from './frame.js';
import { DOCK_THEME } from './RightPanel.js';
import { Sidebar } from './Sidebar.js';
import { useWindowWidth } from './panel/ResizeHandle.js';
import s from './Shell.module.css';

const noop = (): void => undefined;

/**
 * iOS Safari lays the on-screen keyboard over the page (it ignores the viewport's
 * interactive-widget, which Android's Chrome follows): the frame follows the visual viewport
 * instead, so the message box sits on top of the keyboard rather than under it.
 */
function useKeyboardRoom(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const fit = (): void => root.style.setProperty('--phone-vh', `${Math.round(vv.height)}px`);
    fit();
    vv.addEventListener('resize', fit);
    return () => {
      vv.removeEventListener('resize', fit);
      root.style.removeProperty('--phone-vh');
    };
  }, []);
}

/** Patch the preferences only when the patch changes something. */
const patch = (next: Partial<ReturnType<typeof getPrefs>>): void => {
  if (Object.keys(next).length) setPrefs(next);
};

/** Which page is open, as a key: a new page (not a redraw of this one) closes the drawer and the sheet. */
const pageKey = (view: { kind: string; id?: unknown }): string => `${view.kind}:${String(view.id ?? '')}`;

/**
 * The window on a phone (BLG-6; lib/phone-layout.ts): one column. The page fills the screen; the
 * sidebar is a drawer over it (the toolbar's sidebar button opens it, the scrim or a picked row
 * closes it) and the panel (changes, files, info) a sheet over it with its own Close. Same
 * regions as the desktop frame (Workbench.tsx), so every page and tab is the one you know.
 */
export function PhoneFrame() {
  const prefs = usePrefs();
  const [panelOpen, setPanelOpen] = useState(false);
  const width = useWindowWidth();
  const page = useApp((st) => pageKey(st.view as { kind: string; id?: unknown }));

  // In: the page first. Out (a wider window): the sidebar is back where it was.
  useLayoutEffect(() => {
    patch(phoneEntryPrefs(getPrefs()));
    return () => patch(phoneExitPrefs(getPrefs()));
  }, []);

  // A row picked in the drawer (or a link anywhere) opens its page: the drawer and the sheet get out of the way.
  const shown = useRef(page);
  useEffect(() => {
    if (shown.current === page) return;
    shown.current = page;
    patch({ ...(getPrefs().sidebar ? { sidebar: false } : {}), ...(getPrefs().inspector ? { inspector: false } : {}) });
  }, [page]);

  const drawer = prefs.sidebar;
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPrefs({ sidebar: false });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer]);

  useKeyboardRoom();

  const shared = useMemo(() => ({ onPanelMin: noop, onCenterMin: noop, onPanelOpen: setPanelOpen, panelOpen, centerRoom: width }), [panelOpen, width]);

  return (
    <FrameContext.Provider value={shared}>
      <div className={cx(s.frame, s.phoneFrame, DOCK_THEME.className)} data-layout="phone">
        <div className={s.phoneCenter} data-region="center" inert={drawer || panelOpen}>
          <CenterPane />
        </div>
        <div className={cx(s.phoneSheet, panelOpen && s.phoneOpen)} role="dialog" aria-label="Changes, files and info" aria-modal={panelOpen} aria-hidden={!panelOpen} inert={!panelOpen}>
          <div className={s.phoneSheetBar}>
            <IconButton size="large" icon="x" label="Close the panel" onClick={() => setPrefs({ inspector: false })} />
          </div>
          <div className={s.phoneSheetBody}>
            <PanelPane onMinWidth={noop} />
          </div>
        </div>
        <div className={cx(s.phoneScrim, drawer && s.phoneOpen)} aria-hidden onClick={() => setPrefs({ sidebar: false })} />
        <div className={cx(s.phoneDrawer, drawer && s.phoneOpen)} aria-hidden={!drawer} inert={!drawer}>
          <Sidebar />
        </div>
      </div>
    </FrameContext.Provider>
  );
}
