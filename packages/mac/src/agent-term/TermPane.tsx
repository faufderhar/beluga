import type { SearchAddon } from '@xterm/addon-search';
import type { Terminal } from '@xterm/xterm';
import { useEffect, useMemo, useRef, useState } from 'react';
import { findIssue } from '@beluga/core/board/model.js';
import { isTermBusy } from '@beluga/shared/terminal-keys.js';
import { Icon } from '../components/Icon.js';
import { Button, IconButton, cx } from '../components/ui.js';
import { useApi, useApp, useBeluga } from '../lib/beluga.js';
import { Xterm } from '../views/Xterm.js';
import { usePrefs } from '../lib/prefs.js';
import { importedTheme } from '../lib/terminal-look.js';
import { attachTermLinks } from './term-links.js';
import { type TermAction, type TermKey, termKeyFor, termKeysOf } from '../lib/term-keys.js';
import { belugaHas, setTerminalChords } from '../lib/shortcuts.js';
import { chordLabel } from '../lib/shortcuts-model.js';

/** The last visual token in a terminal, from the bottom up. */
function newestOnScreen(t: Terminal): number | undefined {
  const b = t.buffer.active;
  for (let y = b.length - 1; y >= 0; y--) {
    const text = b.getLine(y)?.translateToString(true) ?? '';
    const last = [...text.matchAll(/\[\[visual:(\d{1,6})\]\]/g)].pop();
    if (last) return Number(last[1]);
  }
  return undefined;
}

/** The first key for an action, as a tooltip shows it. */
const keyFor = (keys: readonly TermKey[], action: TermAction): string | undefined => {
  const k = keys.find((x) => x.action === action);
  return k ? chordLabel(k.chord) : undefined;
};
import s from './agent-term.module.css';

/** What a pane is: the agent's own terminal on the conversation, or a shell beside it. */
export type PaneKind = 'agent' | 'shell';

export interface TermPaneProps {
  readonly wsId: string;
  readonly termKey: string;
  readonly kind: PaneKind;
  /** The workspace's folder (a shell starts there). */
  readonly cwd: string;
  /** Several panes: each can be closed (a shell) and shows which one has the keyboard. */
  readonly split: boolean;
  readonly focusOnMount: boolean;
  readonly onSplit: (dir: 'right' | 'down') => void;
  readonly onClose?: () => void;
  /** A key the view runs (tabs, panes, the newest visual): the terminal's own are run here. */
  readonly onAction: (action: TermAction, termKey: string) => void;
  /** The program named itself (vim, htop… set the terminal's title). */
  readonly onTitle?: (title: string) => void;
  readonly openVisual: (n: number) => void;
  readonly openTask: (key: string) => void;
  readonly openImage: (path: string) => void;
  /** ⌘↩: the newest visual the terminal showed. */
  readonly openNewest: () => void;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/^Error: /, '');

/** How soon the agent's terminal tries again after a turn in the chat kept it from opening (BLG-553). */
const BUSY_RETRY_MS = 1500;

/** Find in the terminal (⌘F): as you type, Return for the next, ⇧Return the one before. */
function FindBar({ search, onClose }: { readonly search: SearchAddon; readonly onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [count, setCount] = useState<{ index: number; total: number } | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    const off = search.onDidChangeResults((r) => setCount(r.resultCount ? { index: r.resultIndex, total: r.resultCount } : { index: -1, total: 0 }));
    return () => {
      off.dispose();
      search.clearDecorations();
    };
  }, [search]);
  const opts = { decorations: { matchBackground: '#6b7fb455', activeMatchBackground: '#e3a64a88', matchOverviewRuler: '#6b7fb4', activeMatchColorOverviewRuler: '#e3a64a' } };
  const go = (back: boolean, q = query): void => {
    if (!q) return void search.clearDecorations();
    if (back) search.findPrevious(q, opts);
    else search.findNext(q, { ...opts, incremental: false });
  };
  return (
    <div className={s.find} data-term-find="">
      <Icon name="search" size={12} />
      <input
        ref={input}
        className={s.findInput}
        value={query}
        placeholder="Find in terminal"
        aria-label="Find in terminal"
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value);
          if (e.target.value) search.findNext(e.target.value, { ...opts, incremental: true });
          else {
            search.clearDecorations();
            setCount(undefined);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            go(e.shiftKey);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className={s.findCount}>{count ? (count.total ? `${count.index + 1} of ${count.total}` : 'None') : ''}</span>
      <IconButton size="small" icon="chevronUp" label="Previous" onClick={() => go(true)} />
      <IconButton size="small" icon="chevronDown" label="Next" onClick={() => go(false)} />
      <IconButton size="small" icon="x" label="Close" keys="Esc" onClick={onClose} />
    </div>
  );
}

/**
 * One terminal in the terminal view: the agent's own (Claude Code's or Codex's terminal app on
 * this conversation, its visuals and tasks as links) or a shell. Its keys are the terminal's
 * (lib/term-keys.ts: yours from Ghostty or iTerm2 over iTerm2's and Ghostty's own), and while it
 * has the keyboard they win over Beluga's shortcuts (Settings › Terminal can turn that off).
 */
export function TermPane({ wsId, termKey, kind, cwd, split, focusOnMount, onSplit, onClose, onAction, onTitle, openVisual, openTask, openImage, openNewest }: TermPaneProps) {
  const api = useApi();
  const { client } = useBeluga();
  const [error, setError] = useState<string | undefined>(undefined);
  const [gen, setGen] = useState(0);
  const [starting, setStarting] = useState(false);
  // A turn in the chat kept the agent's terminal from opening: it tries again in a moment (BLG-553).
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState<SearchAddon | undefined>(undefined);
  const [finding, setFinding] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | undefined>(undefined);
  const lastSize = useRef<{ cols: number; rows: number } | undefined>(undefined);
  const exited = useApp((st) => (termKey in st.termExits ? st.termExits[termKey] : undefined));
  const ended = exited !== undefined;
  const driving = useApp((st) => st.agentTerms[wsId]);
  const label = useApp((st) => st.agentTerms[wsId]?.label ?? (st.projects.flatMap((p) => p.workspaces).find((w) => w.id === wsId)?.agent?.label ?? 'Your agent'));
  const visuals = useApp((st) => st.termVisuals[wsId]);
  // Links take the terminal's own colours (a theme's blue, its background), else Beluga's pastel.
  const prefs = usePrefs();
  const theme = importedTheme(prefs);
  // The terminal's keys: Beluga's terminal keys with yours over them (BLG-537).
  const keys = useMemo(() => termKeysOf(prefs.termKeys?.keys, prefs.termKeys?.from), [prefs.termKeys]);
  const claimed = useMemo(() => keys.filter((k) => prefs.termKeysFirst || !belugaHas(k.chord)), [keys, prefs.termKeysFirst]);
  const chipVars = { '--chip-accent': theme?.['blue'] ?? '#a99ad9', ...(theme?.['background'] ? { '--chip-bg': theme['background'] } : {}), ...(theme?.['foreground'] ? { '--chip-fg': theme['foreground'] } : {}) } as React.CSSProperties;
  // What the links read (the latest, without remaking the terminal).
  const linkOpts = useRef({ visuals, openVisual, openTask, openImage, openNewest, onAction, onTitle, claimed });
  linkOpts.current = { visuals, openVisual, openTask, openImage, openNewest, onAction, onTitle, claimed };
  const refreshLinks = useRef<(() => void) | undefined>(undefined);
  useEffect(() => refreshLinks.current?.(), [visuals]);

  /** Start its program; the terminal attaches once it's there (the agent's takes a moment). */
  const start = (size: { cols: number; rows: number }): Promise<unknown> => {
    lastSize.current = size;
    setError(undefined);
    const opening = kind === 'shell' ? api.terminals.global(termKey, cwd, size) : api.agentTerm.open(wsId, size);
    return opening.then(() => setBusy(false), fail);
  };
  /** Why it didn't start: shown, unless a turn in the chat is only finishing first (then it waits). */
  const fail = (err: unknown): void => {
    const why = message(err);
    if (kind === 'agent' && isTermBusy(why)) {
      setError(undefined);
      setBusy(true);
      return;
    }
    setBusy(false);
    setError(why);
  };
  /** Start it again after it ended or couldn't start, then show it. */
  const again = async (): Promise<void> => {
    setStarting(true);
    setError(undefined);
    try {
      const size = lastSize.current ?? (term.current ? { cols: term.current.cols, rows: term.current.rows } : undefined);
      if (kind === 'shell') await api.terminals.global(termKey, cwd, size);
      else await api.agentTerm.open(wsId, size);
      setBusy(false);
      setGen((g) => g + 1);
    } catch (err) {
      fail(err);
    } finally {
      setStarting(false);
    }
  };

  useEffect(() => {
    if (!busy || starting) return;
    const retry = setTimeout(() => void again(), BUSY_RETRY_MS);
    return () => clearTimeout(retry);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per wait; again reads the latest size
  }, [busy, starting]);

  // The menu's Find (⌘F, ⌘G) while this terminal has the keyboard.
  useEffect(() => {
    const mine = (): boolean => Boolean(root.current?.contains(document.activeElement));
    const find = (): void => {
      if (mine()) setFinding(true);
    };
    document.addEventListener('beluga:find', find);
    return () => document.removeEventListener('beluga:find', find);
  }, []);

  // While this terminal has the keyboard, the menu bar lets go of the keys it takes (⌘T, ⌘W, ⌘1…).
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const inside = (): void => setTerminalChords(linkOpts.current.claimed.map((k) => k.chord));
    const outside = (e: FocusEvent): void => {
      if (!el.contains(e.relatedTarget as Node | null)) setTerminalChords(undefined);
    };
    el.addEventListener('focusin', inside);
    el.addEventListener('focusout', outside);
    if (el.contains(document.activeElement)) inside();
    return () => {
      el.removeEventListener('focusin', inside);
      el.removeEventListener('focusout', outside);
      if (el.contains(document.activeElement)) setTerminalChords(undefined);
    };
  }, [claimed]);

  /** A key the terminal takes: its own actions here, the view's (tabs, panes) there. */
  const onKey = (e: KeyboardEvent): boolean => {
    const hit = termKeyFor(linkOpts.current.claimed, e);
    if (!hit) return false;
    const t = term.current;
    const a = hit.action;
    if (a.startsWith('text:')) t?.input(a.slice(5), true);
    else if (a === 'find') setFinding(true);
    else if (a === 'clear') t?.clear();
    else if (a === 'select_all') t?.selectAll();
    else if (a === 'copy') void navigator.clipboard?.writeText(t?.getSelection() ?? '').catch(() => undefined);
    else if (a === 'paste') void navigator.clipboard?.readText().then((text) => t?.paste(text)).catch(() => undefined);
    else if (a === 'split_right' || a === 'split_down') onSplit(a === 'split_right' ? 'right' : 'down');
    else if (a === 'newest_visual') {
      // The newest link the terminal shows (else the newest it ever showed).
      const n = t ? newestOnScreen(t) : undefined;
      if (n !== undefined) linkOpts.current.openVisual(n);
      else linkOpts.current.openNewest();
    }
    else linkOpts.current.onAction(a, termKey);
    return true;
  };

  const extend = (t: Terminal, tools: { search: SearchAddon }): (() => void) => {
    term.current = t;
    setSearch(tools.search);
    if (focusOnMount) t.focus();
    const titled = t.onTitleChange((title) => linkOpts.current.onTitle?.(title));
    if (kind !== 'agent')
      return () => {
        titled.dispose();
        term.current = undefined;
      };
    const links = attachTermLinks(t, () => ({
      visual: (n) => linkOpts.current.visuals?.find((v) => v.n === n),
      openVisual: (n) => linkOpts.current.openVisual(n),
      hasTask: (key) => Boolean(findIssue(client.store.getState().board, key)),
      openTask: (key) => linkOpts.current.openTask(key),
      openImage: (path) => linkOpts.current.openImage(path),
    }));
    refreshLinks.current = links.refresh;
    return () => {
      refreshLinks.current = undefined;
      titled.dispose();
      links.dispose();
      term.current = undefined;
    };
  };

  return (
    <div ref={root} className={cx(s.pane, split && s.paneSplit)} style={chipVars} data-pane={kind} data-term-key={termKey}>
      <Xterm key={`${termKey}:${gen}`} termKey={termKey} start={start} focus={focusOnMount} extend={extend} onKey={onKey} settleMs={140} fromBottom={kind === 'agent'} />
      {finding && search ? (
        <FindBar
          search={search}
          onClose={() => {
            setFinding(false);
            term.current?.focus();
          }}
        />
      ) : null}
      <div className={s.paneTools}>
        <IconButton size="small" icon="panelRight" label="Split Right" keys={keyFor(keys, 'split_right')} onClick={() => onSplit('right')} />
        <IconButton size="small" icon="panelBottom" label="Split Down" keys={keyFor(keys, 'split_down')} onClick={() => onSplit('down')} />
        {onClose ? <IconButton size="small" icon="x" label="Close This Shell" onClick={onClose} /> : null}
      </div>
      {busy && !error ? (
        <div className={s.over} role="status" data-term-busy="">
          <Icon name="terminal" size={18} />
          <p className={s.overTitle}>{label} is finishing a turn in the chat</p>
          <p className={s.overDetail}>The terminal opens here as soon as it’s done.</p>
        </div>
      ) : error || (ended && !driving && kind === 'agent') || (ended && kind === 'shell') ? (
        <div className={s.over} role="status">
          <Icon name={error ? 'alert' : 'terminal'} size={18} />
          <p className={s.overTitle}>{error ? (kind === 'agent' ? `${label} couldn’t start here` : 'The shell couldn’t start') : kind === 'agent' ? `${label}’s terminal ended` : 'The shell ended'}</p>
          {error ? <p className={s.overDetail}>{error}</p> : kind === 'agent' ? <p className={s.overDetail}>The conversation is the chat’s again. Start it here to go on in the terminal.</p> : null}
          <Button size="small" variant="primary" icon="play" disabled={starting} onClick={() => void again()}>
            {error ? 'Try Again' : 'Start Again'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
