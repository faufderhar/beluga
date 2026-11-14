import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { quoteInBox } from '../chat/message-menu.js';
import { useActions } from '../lib/actions.js';
import { useMyAgentName } from '../lib/agent-words.js';
import { useBeluga } from '../lib/beluga.js';
import { copyText } from '../lib/copy.js';
import { placeBar, skipsBar, worthABar, type Box, type Placement } from '../lib/selection-bar.js';
import { Icon, type IconName } from './Icon.js';
import s from './SelectionBar.module.css';

/**
 * Select text anywhere you read (an answer, a file, a diff, the room) and a small bar pops up
 * beside it: Copy, Quote, Ask your agent. No right-click needed (BLG-917). One per window.
 */

interface Picked {
  readonly text: string;
  readonly box: Box;
  readonly x: number;
}

interface BarAction {
  readonly label: string;
  readonly icon: IconName;
  readonly title?: string;
  readonly run: (text: string) => void;
}

/** Views whose box talks to your agent, so a quote there is already a question to it. */
const AGENT_VIEWS = new Set(['assistant', 'workspace', 'shared', 'draft', 'draft_worktree']);

/** What's selected now, if the bar belongs there. */
function readSelection(x: number): Picked | undefined {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return undefined;
  const text = sel.toString();
  if (!worthABar(text)) return undefined;
  const element = (node: Node | null): Element | null => (node instanceof Element ? node : (node?.parentElement ?? null));
  if (skipsBar(element(sel.anchorNode)) || skipsBar(element(sel.focusNode))) return undefined;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (!rect.width && !rect.height) return undefined;
  return { text, box: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, x };
}

/** The box you'd quote into is on screen. */
const composerShown = (): boolean => document.querySelector('[data-composer]:not([disabled])') != null;

function useBarActions(): () => readonly BarAction[] {
  const { client, ui } = useBeluga();
  const actions = useActions();
  const agent = useMyAgentName();
  return () => {
    const state = client.store.getState();
    const view = state.view;
    const say = (text: string, level: 'success' | 'error' = 'success'): void => client.store.dispatch({ type: 'toast', text, level });
    const copy: BarAction = {
      label: 'Copy',
      icon: 'copy',
      title: 'Copy the selection (⌘C)',
      run: (text) => void copyText(text).then(() => say('Copied the selection'), () => say("Couldn't copy", 'error')),
    };
    // A worktree on another tab (its diff, a file): back to its chat first, then quote there.
    const toChat = (): boolean => {
      if (composerShown()) return true;
      if (view.kind === 'workspace') actions.run({ type: 'open_ws', id: view.id, tab: 'chat' });
      else if (view.kind === 'shared') actions.run({ type: 'open_shared', owner: view.owner, id: view.id, tab: 'chat' });
      else return false;
      return true;
    };
    const quote = (prefix = '') => (text: string): void => {
      if (composerShown()) quoteInBox(ui, text.trim(), prefix);
      else if (toChat()) setTimeout(() => quoteInBox(ui, text.trim(), prefix), 60);
    };
    const canQuote = composerShown() || view.kind === 'workspace' || view.kind === 'shared';
    if (!canQuote) return [copy];
    // In a group room only a mention reaches your agent; quoting alone is a reply to the room.
    const group = view.kind === 'room' && state.peers.length > 1;
    const ask: BarAction = { label: `Ask ${agent}`, icon: 'claude', title: `Ask ${agent} about the selection`, run: quote(group ? '@claude ' : '') };
    const reply: BarAction = { label: 'Quote', icon: 'chat', title: 'Quote the selection in your reply', run: quote() };
    if (group) return [copy, reply, ask];
    if (view.kind === 'room' || AGENT_VIEWS.has(view.kind)) return [copy, ask];
    return [copy, reply];
  };
}

export function SelectionBar() {
  const [picked, setPicked] = useState<Picked | undefined>();
  const [place, setPlace] = useState<Placement | undefined>();
  const [items, setItems] = useState<readonly BarAction[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  const build = useBarActions();
  const buildRef = useRef(build);
  buildRef.current = build;

  useEffect(() => {
    let frame = 0;
    const hide = (): void => {
      cancelAnimationFrame(frame);
      setPicked(undefined);
    };
    const inBar = (e: Event): boolean => e.target instanceof Node && ref.current?.contains(e.target) === true;
    const onDown = (e: MouseEvent): void => {
      if (!inBar(e)) hide();
    };
    const onUp = (e: MouseEvent): void => {
      if (e.button !== 0 || inBar(e)) return;
      cancelAnimationFrame(frame);
      // The selection settles after mouseup (a double-click's word, a Shift+click's range).
      frame = requestAnimationFrame(() => {
        const next = readSelection(e.clientX);
        if (next) setItems(buildRef.current());
        setPicked(next);
      });
    };
    const onSelection = (): void => {
      if (window.getSelection()?.isCollapsed !== false) hide();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' || !(e.metaKey || e.ctrlKey || ['Shift', 'Alt', 'Meta', 'Control'].includes(e.key))) hide();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('selectionchange', onSelection);
    document.addEventListener('keydown', onKey, true);
    // It would float away from the text it's for.
    window.addEventListener('scroll', hide, { capture: true, passive: true });
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('selectionchange', onSelection);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', hide, { capture: true });
      window.removeEventListener('resize', hide);
      window.removeEventListener('blur', hide);
    };
  }, []);

  // Measured once drawn (hidden), then placed beside the selection.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!picked || !el) {
      setPlace(undefined);
      return;
    }
    const { width, height } = el.getBoundingClientRect();
    setPlace(placeBar(picked.box, picked.x, { width, height }, { width: window.innerWidth, height: window.innerHeight }));
  }, [picked]);

  if (!picked) return null;
  // Pressing a button mustn't clear the selection it acts on.
  const keep = (e: ReactMouseEvent): void => e.preventDefault();
  const pick = (action: BarAction): void => {
    action.run(picked.text);
    setPicked(undefined);
  };
  return (
    <div
      ref={ref}
      className={`${s.bar} ${place?.below ? s.below : ''}`}
      role="toolbar"
      aria-label="Selected text"
      style={place ? { left: place.left, top: place.top } : { left: 0, top: 0, visibility: 'hidden' }}
      onMouseDown={keep}
    >
      {items.map((a) => (
        <button key={a.label} type="button" className={s.button} title={a.title} onClick={() => pick(a)}>
          <Icon name={a.icon} size={13} />
          <span>{a.label}</span>
        </button>
      ))}
    </div>
  );
}
