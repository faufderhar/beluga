import * as Context from '@radix-ui/react-context-menu';
import { type ReactNode, useRef, useState } from 'react';
import { ContextRoot } from '../components/ContextRoot.js';
import { Icon } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import { useApi } from '../lib/beluga.js';
import m from '../components/SpecMenu.module.css';
import s from './terminal.module.css';

export interface TerminalTabProps {
  readonly termKey: string;
  readonly label: string;
  readonly on: boolean;
  /** The status dot (and an exit note) before / after the name. */
  readonly before?: ReactNode;
  readonly after?: ReactNode;
  /** The tab's look (the Terminal tab's or the dock's). */
  readonly className: string | undefined;
  readonly onClassName: string | undefined;
  readonly onPick: () => void;
  /** Shells you can close from their tab. */
  readonly onClose?: () => void;
  /** Only shells are named; setup and run say what they are. */
  readonly renamable?: boolean;
}

/** Typing a terminal's new name in its tab: Return saves, Escape cancels, empty goes back to Shell N. */
function NameField({ label, onDone }: { label: string; onDone: (name: string | undefined) => void }) {
  const [text, setText] = useState(label);
  // Return (or Escape) ends it; the blur that follows mustn't end it again.
  const ended = useRef(false);
  const end = (name: string | undefined): void => {
    if (ended.current) return;
    ended.current = true;
    onDone(name);
  };
  return (
    <input
      className={s.rename}
      aria-label="Terminal name"
      value={text}
      autoFocus
      spellCheck={false}
      maxLength={40}
      size={Math.max(6, text.length + 1)}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setText(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') end(text);
        if (e.key === 'Escape') end(undefined);
      }}
      onBlur={() => end(text)}
    />
  );
}

/** One terminal's tab: click to show it, double-click (or right-click › Rename…) to name it for every screen. */
export function TerminalTab({ termKey, label, on, before, after, className, onClassName, onPick, onClose, renamable = true }: TerminalTabProps) {
  const api = useApi();
  const [editing, setEditing] = useState(false);
  const done = (name: string | undefined): void => {
    setEditing(false);
    if (name !== undefined && name.trim() !== label) void api.terminals.rename(termKey, name);
  };
  const tab = (
    <span
      className={cx(className, on && onClassName)}
      role="tab"
      aria-selected={on}
      tabIndex={0}
      title={renamable && !editing ? 'Double-click to rename' : undefined}
      onClick={onPick}
      onDoubleClick={() => renamable && setEditing(true)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') (e.preventDefault(), onPick());
        if (e.key === 'F2' && renamable) (e.preventDefault(), setEditing(true));
      }}
    >
      {before}
      {editing ? <NameField label={label} onDone={done} /> : label}
      {after}
      {onClose && !editing ? (
        <button type="button" className={s.closeTab} aria-label={`Close ${label}`} onClick={(e) => (e.stopPropagation(), onClose())}>
          <Icon name="x" size={9} />
        </button>
      ) : null}
    </span>
  );
  if (!renamable && !onClose) return tab;
  return (
    <ContextRoot>
      <Context.Trigger asChild>{tab}</Context.Trigger>
      <Context.Portal>
        {/* Focus stays with the name field Rename… opens, instead of going back to the tab. */}
        <Context.Content className={m.menu} style={{ minWidth: 160 }} onCloseAutoFocus={(e) => e.preventDefault()}>
          {renamable ? (
            <Context.Item className={m.item} onSelect={() => setEditing(true)}>
              <span className={m.label}>Rename…</span>
            </Context.Item>
          ) : null}
          {onClose ? (
            <Context.Item className={cx(m.item, m.danger)} onSelect={onClose}>
              <span className={m.label}>Close</span>
            </Context.Item>
          ) : null}
        </Context.Content>
      </Context.Portal>
    </ContextRoot>
  );
}
