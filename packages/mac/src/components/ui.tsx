import * as Tooltip from '@radix-ui/react-tooltip';
import { type ButtonHTMLAttributes, type ReactNode, forwardRef } from 'react';
import type { AgentRef } from '@beluga/protocol.js';
import { agentMark, runtimeMark } from '../../../../src/shared/agent-marks.js';
import { useAvatarUrl } from '../lib/avatars.js';
import { DotMatrix } from './DotMatrix.js';
import { Icon, type IconName } from './Icon.js';
import s from './ui.module.css';

const cx = (...c: Array<string | false | undefined | null>): string => c.filter(Boolean).join(' ');
export { cx };

/**
 * A control's size (docs/mac-controls.md): regular in a window's content, small inside dense
 * content (rows, cards, panels), large for a screen's one main action and the window's toolbar.
 */
export type ControlSize = 'small' | 'regular' | 'large';
const SIZE_CLASS = { small: s.small, regular: undefined, large: s.large } as const;
const ICON_SIZE = { small: 12, regular: 14, large: 16 } as const;

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: 'plain' | 'primary' | 'quiet' | 'danger' | 'merge';
  readonly size?: ControlSize;
  readonly icon?: IconName;
  readonly tone?: 'error' | 'ok' | 'info';
};

/** A push button. `quiet`: toolbar style, no fill until hovered. */
export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button({ variant = 'plain', size = 'regular', icon, tone, className, children, ...rest }, ref) {
  return (
    <button ref={ref} type="button" className={cx(s.button, s[variant], SIZE_CLASS[size], tone && s[`tone_${tone}`], className)} {...rest}>
      {icon ? <Icon name={icon} size={ICON_SIZE[size]} /> : null}
      {children ? <span>{children}</span> : null}
    </button>
  );
});

/** A hint shown on hover (and on keyboard focus), with an optional shortcut. */
export function Tip({ label, keys, side = 'bottom', children }: { label: ReactNode; keys?: string; side?: 'top' | 'bottom' | 'left' | 'right'; children: ReactNode }) {
  return (
    <Tooltip.Root delayDuration={450}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side={side} sideOffset={6} className={s.tip}>
          {label}
          {keys ? <kbd className={s.tipKeys}>{keys}</kbd> : null}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/**
 * A square icon button with its tooltip. `size` (docs/mac-controls.md): large (28 × 28) in the
 * window's toolbar, small (20 × 20) in panels and the dock, regular (22 × 22) in content. Without
 * one it keeps the 28 × 26 it had before the scale, until its screen moves onto it.
 */
const ICON_BUTTON = { small: s.iconSmall, regular: s.iconRegular, large: s.iconLarge } as const;
const ICON_IN_BUTTON = { small: 13, regular: 14, large: 16 } as const;
export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { readonly icon: IconName; readonly label: string; readonly keys?: string; readonly active?: boolean; readonly badge?: number; readonly size?: ControlSize }>(
  function IconButton({ icon, label, keys, active, badge, size, className, ...rest }, ref) {
    return (
      <Tip label={label} keys={keys}>
        <button ref={ref} type="button" aria-label={label} aria-pressed={active} className={cx(s.iconButton, size && ICON_BUTTON[size], active && s.iconActive, className)} {...rest}>
          <Icon name={icon} {...(size ? { size: ICON_IN_BUTTON[size] } : {})} />
          {badge ? <span className={s.iconBadge}>{badge > 99 ? '99+' : badge}</span> : null}
        </button>
      </Tip>
    );
  },
);

/**
 * A row of mutually exclusive choices (like NSSegmentedControl). `iconOnly` (a narrow window):
 * just the icons, each named in its tooltip.
 */
/** `radio`: a choice of how to show one thing (a radio group), not tabs of their own. */
/** `count`: a number after the label, in a quieter tone (`data-count`, so a narrow toolbar can drop it). */
export function Segmented<T extends string>({ value, options, onChange, label, iconOnly, radio, size = 'regular' }: { value: T; options: ReadonlyArray<{ value: T; label: string; hint?: string; icon?: IconName; keys?: string; count?: number }>; onChange: (v: T) => void; label: string; iconOnly?: boolean; radio?: boolean; size?: ControlSize }) {
  return (
    <div className={cx(s.segmented, size === 'small' && s.segmentedSmall, size === 'large' && s.segmentedLarge)} role={radio ? 'radiogroup' : 'tablist'} aria-label={label}>
      {options.map((o) => {
        const bare = iconOnly && o.icon;
        return (
          <Tip key={o.value} label={bare ? `${o.label}${o.hint ? ` · ${o.hint}` : ''}` : (o.hint ?? o.label)} {...(o.keys ? { keys: o.keys } : {})}>
            <button type="button" role={radio ? 'radio' : 'tab'} aria-label={bare ? o.label : o.count ? `${o.label} ${o.count}` : undefined} {...(radio ? { 'aria-checked': o.value === value } : { 'aria-selected': o.value === value })} className={cx(s.segment, o.value === value && s.segmentOn, bare && s.segmentIcon)} onClick={() => onChange(o.value)}>
              {o.icon ? <Icon name={o.icon} size={size === 'small' ? 12 : 13} /> : null}
              {bare ? null : o.label}
              {bare || !o.count ? null : (
                <span className={s.segmentCount} data-count="">
                  {o.count}
                </span>
              )}
            </button>
          </Tip>
        );
      })}
    </div>
  );
}

/** A small count (unread, waiting). `urgent` uses the accent. */
export function Badge({ count, urgent }: { count: number; urgent?: boolean }) {
  if (!count) return null;
  return <span className={cx(s.badge, urgent && s.badgeUrgent)}>{count > 99 ? '99+' : count}</span>;
}

/**
 * A status dot. `live` pulses softly (Claude is working). `subagent`: one of Claude's sub-agents, in
 * its own color. `worktree` and `plan`: the bigger work, each in its color with the orbiting loader.
 */
export function Dot({ tone, live }: { tone: 'ok' | 'warn' | 'error' | 'info' | 'claude' | 'subagent' | 'worktree' | 'plan' | 'muted'; live?: boolean }) {
  // At work: the dot matrix, in the dot's color (no pulsing ring).
  if (live) return <DotMatrix className={s[`live_${tone}`]} size={13} pattern={tone === 'worktree' || tone === 'plan' ? 'orbit' : 'petals'} />;
  return <span className={cx(s.dot, s[`dot_${tone}`])} aria-hidden="true" />;
}

const PEOPLE = ['#5b8def', '#3fa776', '#a46ed0', '#d39a2c', '#2fa4a0', '#7f72e6', '#b98a5e', '#5f9ad6'];
/** A steady color per person (FNV-1a over their id). */
export const personColor = (id: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  return PEOPLE[h % PEOPLE.length]!;
};

/** Ids that are no one's Claude in particular (a Claude Code session outside Beluga): Claude's own color. */
const NOBODY = new Set(['claude-code']);

/**
 * Someone's Claude, in its owner's color (so a conversation with several people's Claudes reads
 * as who's who): the mark's tint, and the color of its name. `undefined` keeps Claude's own color.
 */
export const claudeColor = (owner: string | undefined): string | undefined => (owner && !NOBODY.has(owner) ? personColor(owner) : undefined);

/**
 * A person's profile picture (lib/avatars.ts), or their initial in their color until there is one;
 * their agent gets its runtime's mark (Claude Code, Codex, a local model), tinted the same.
 * `agent`: the agent (or its runtime id); `claude`: an agent whose runtime isn't known (Claude's mark).
 */
export function Avatar({ name, id, claude, agent, size = 22, picture: given }: { name: string; id: string; claude?: boolean; agent?: Pick<AgentRef, 'runtime'> | string | undefined; size?: number; picture?: string | undefined }) {
  const isAgent = Boolean(claude) || agent !== undefined;
  // `picture`: handed over already (a window without the app's store, like the sharer's overlay).
  const fetched = useAvatarUrl(id, isAgent || given !== undefined);
  const picture = given ?? fetched;
  const tint = isAgent ? claudeColor(id) : undefined;
  if (picture) return <img className={cx(s.avatar, s.avatarPicture)} src={picture} width={size} height={size} alt="" draggable={false} aria-hidden="true" />;
  return (
    <span
      className={cx(s.avatar, isAgent && s.avatarClaude)}
      style={{ width: size, height: size, fontSize: size * 0.46, ...(isAgent ? (tint ? { background: `color-mix(in srgb, ${tint} 20%, transparent)`, color: tint } : {}) : { background: personColor(id) }) }}
      aria-hidden="true"
    >
      {isAgent ? <Icon name={typeof agent === 'string' ? runtimeMark(agent) : agentMark(agent)} size={size * 0.6} /> : (name[0] ?? '?').toUpperCase()}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className={s.kbd}>{children}</kbd>;
}

/** What to do when there's nothing here yet: one line saying what this is, and the action that fills it. */
export function Empty({ icon, mark, title, detail, action }: { icon: IconName; mark?: ReactNode; title: string; detail?: string; action?: ReactNode }) {
  return (
    <div className={s.empty}>
      {mark ?? <Icon name={icon} size={22} />}
      <div className={s.emptyTitle}>{title}</div>
      {detail ? <div className={s.emptyDetail}>{detail}</div> : null}
      {action}
    </div>
  );
}

/** The one to three buttons under an empty state (the first is the default). */
export function EmptyActions({ children }: { children: ReactNode }) {
  return <div className={s.emptyActions}>{children}</div>;
}

/** Claude is thinking: three soft dots. */
export function Working() {
  return (
    <span className={s.working} aria-label="working">
      <i />
      <i />
      <i />
    </span>
  );
}
