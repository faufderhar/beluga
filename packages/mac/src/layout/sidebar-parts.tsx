import { type CSSProperties, type HTMLAttributes, type KeyboardEvent, type MouseEvent, type ReactNode, forwardRef } from 'react';
import { Icon } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import { setPrefs, usePrefs } from '../lib/prefs.js';
import { type RowColor, colorVars } from '../lib/row-colors.js';
import s from './Sidebar.module.css';
import m from './signal.module.css';

/** The sidebar's building blocks: a foldable section and a row (used by Sidebar and the friends' sections). */

/** `count`: how many rows it holds. `keep`: what still shows while it's folded (the chat you're in). */
export function Section({ id, title, children, action, count, keep }: { id: string; title: string; children: ReactNode; action?: ReactNode; count?: number; keep?: ReactNode }) {
  const prefs = usePrefs();
  const folded = prefs.folded.includes(id);
  return (
    <section className={s.section}>
      <div className={s.sectionHead}>
        <button type="button" className={s.sectionTitle} onClick={() => setPrefs({ folded: folded ? prefs.folded.filter((f) => f !== id) : [...prefs.folded, id] })} aria-expanded={!folded}>
          {title}
          {count === undefined ? null : <span className={s.sectionCount}>{count}</span>}
          <Icon name={folded ? 'chevronRight' : 'chevronDown'} size={10} className={s.sectionChevron} />
        </button>
        <span className={s.sectionAction}>{action}</span>
      </div>
      {folded ? keep : children}
    </section>
  );
}

export type RowProps = Omit<HTMLAttributes<HTMLDivElement>, 'onClick'> & {
  icon?: ReactNode;
  label: ReactNode;
  selected?: boolean;
  onClick?: (event: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>) => void;
  onDoubleClick?: () => void;
  trailing?: ReactNode;
  detail?: string;
  tone?: string;
  indent?: number;
  className?: string;
  /** A colour you gave it (lib/row-colors.ts): a soft stripe at its edge and its icon in that colour. Unset: plain, as ever. */
  color?: RowColor | undefined;
};

/**
 * What a list of conversations (the categories, Unread) adds to a chat's or plan's own row. The row
 * stays the one a project's list draws: these only add to it, so it does there all it does here.
 */
export interface RowExtras {
  /** Its name with what waits ("add-auth · Needs you"): apart from the same row further down. */
  readonly label: string;
  /** Where it lives, quietly after its name: the project, "Chats". */
  readonly where: string;
  /** Before the row's own marks at its right edge: the list's tools and words. */
  readonly trailing?: ReactNode;
  /** Its name bold for something other than news (a snooze that ended). */
  readonly bold?: boolean;
  /** A click on it: the list opens it, and keeps it in place while you're in it. */
  readonly open: () => void;
  /** The list's own marks on the row (`data-category`). */
  readonly data?: Readonly<Record<`data-${string}`, string>>;
}

/**
 * A sidebar row. It passes its ref and other props through, so a right-click menu (or a
 * tooltip) wrapped around it can attach.
 */
export const Row = forwardRef<HTMLDivElement, RowProps>(function Row({ icon, label, selected, onClick, trailing, detail, tone, indent = 0, className, onDoubleClick, style, onKeyDown, color, ...rest }, ref) {
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      {...rest}
      className={cx(s.row, selected && s.selected, className)}
      data-row-color={color}
      style={{ paddingLeft: 8 + indent * 14, ...(color ? (colorVars(color) as CSSProperties) : {}), ...style }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        // Only the row itself: Enter on a button inside it presses that button.
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClick?.(e);
        }
      }}
      title={detail}
    >
      {color ? <span className={s.colorStripe} aria-hidden="true" /> : null}
      {icon ? <span className={cx(s.rowIcon, tone)}>{icon}</span> : null}
      <span className={s.rowLabel}>{label}</span>
      {trailing ? <span className={s.trailing}>{trailing}</span> : null}
    </div>
  );
});

/** A row's name, and what a list adds to it: bold when the list says so, and where it lives after it (drawn from the attribute: a hint for the eye, the tooltip says it). */
export function ExtrasName({ name, extras, className }: { name: ReactNode; extras: RowExtras | undefined; className?: string | undefined }) {
  return (
    <>
      <span className={cx(className, extras?.bold && m.unreadName)}>{name}</span>
      {extras ? <span className={m.where} data-where={extras.where} aria-hidden="true" /> : null}
    </>
  );
}
