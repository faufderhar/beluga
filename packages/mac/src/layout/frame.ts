import { createContext } from 'react';

/** What the frame's regions (drawn by Dockview's Gridview, inside the workbench's tree) need from it: see Workbench.tsx. */
export interface Frame {
  /** The dock in the panel needs at least this much room (its groups side by side). */
  readonly onPanelMin: (px: number) => void;
  /** And the center's dock (the chat, and what you put beside it). */
  readonly onCenterMin: (px: number) => void;
  /**
   * The panel shows or not. It says so itself: on a page of one of your computers it's drawn with
   * that computer's state (machines/MachinePane.tsx), which the frame around it doesn't have.
   */
  readonly onPanelOpen: (open: boolean) => void;
  readonly panelOpen: boolean;
  /** The most the center can be given: the window, less the sidebar and (open) the narrowest panel. */
  readonly centerRoom: number;
}
export const FrameContext = createContext<Frame>({ onPanelMin: () => undefined, onCenterMin: () => undefined, onPanelOpen: () => undefined, panelOpen: false, centerRoom: Number.MAX_SAFE_INTEGER });
