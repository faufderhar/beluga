import { type CSSProperties, useLayoutEffect, useState } from 'react';
import { SIDE_DEFAULT, SIDE_MAX, SIDE_MIN, SPLIT_DEFAULT, SPLIT_MAX, SPLIT_MIN, clampShare, splitsSideways } from '../../lib/panel-model.js';
import { setPrefs, usePrefs } from '../../lib/prefs.js';
import type { ResizeHandleProps } from './ResizeHandle.js';

/**
 * A list with what you picked in it (Files' tree and a file, Changes' files and a diff, Scratch's
 * files and one of them), in the room the tab has: the preview under the list while the tab is
 * narrow (in the panel), beside it once there's room for both (the tab dragged beside the chat, a
 * wide panel). Each way keeps its own share, where you drag the line between them.
 */
export interface Split {
  /** For the box around the two. */
  readonly ref: (el: HTMLDivElement | null) => void;
  /** Side by side (else one above the other). */
  readonly side: boolean;
  /** For the list: its share of the box, while something is picked. */
  readonly listStyle: CSSProperties | undefined;
  /** For the line between them (a ResizeHandle; give it its label). */
  readonly handle: Pick<ResizeHandleProps, 'axis' | 'onMove' | 'onReset' | 'onStep'>;
}

export function useSplit(picked: boolean): Split {
  const prefs = usePrefs();
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!box) return;
    const read = (): void => setWidth(box.clientWidth);
    read();
    const watch = new ResizeObserver(read);
    watch.observe(box);
    return () => watch.disconnect();
  }, [box]);
  const side = splitsSideways(width);
  const [min, max, usual] = side ? [SIDE_MIN, SIDE_MAX, SIDE_DEFAULT] : [SPLIT_MIN, SPLIT_MAX, SPLIT_DEFAULT];
  const share = clampShare(side ? prefs.panelSplitSide : prefs.panelSplit, min, max);
  const keep = (v: number): void => setPrefs(side ? { panelSplitSide: clampShare(v, min, max) } : { panelSplit: clampShare(v, min, max) });
  return {
    ref: setBox,
    side,
    listStyle: picked ? { flex: `0 0 ${Math.round(share * 1000) / 10}%` } : undefined,
    handle: {
      axis: side ? 'x' : 'y',
      onMove: (pos) => {
        const r = box?.getBoundingClientRect();
        if (r) keep(side ? (pos - r.left) / r.width : (pos - r.top) / r.height);
      },
      onReset: () => keep(usual),
      // ← and ↑ give the list less room (the line moves that way).
      onStep: (dir) => keep(share - dir * 0.04),
    },
  };
}
