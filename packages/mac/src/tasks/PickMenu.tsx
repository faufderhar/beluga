import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { type NativeRow, nativeDropdown } from '../lib/native-menu.js';
import { FitContent } from '../components/SpecMenu.js';
import { type ReactNode, useMemo, useState } from 'react';
import { Icon, type IconName } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import m from '../components/SpecMenu.module.css';
import t from './tasks.module.css';

/**
 * A pop-up menu that picks a value: each choice with its own mark (a status ring, priority bars,
 * someone's avatar), a checkmark on what's chosen, a number key for the first nine, and a
 * filter field when the list is long, and actions under the choices ("New Label…").
 */

export interface Pick<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly mark?: ReactNode;
  readonly hint?: string;
  readonly section?: string;
}

export interface PickMenuProps<T extends string> {
  readonly label: string;
  readonly choices: readonly Pick<T>[];
  /** What's chosen (several: a checkmark on each, and the menu stays open). */
  readonly chosen: readonly T[];
  readonly onPick: (value: T) => void;
  readonly children: ReactNode;
  /** Pick several (labels): the menu stays open as you tick them. */
  readonly multiple?: boolean;
  /** A filter field (on by default past 8 choices). */
  readonly search?: boolean;
  /** Typing a new value offers "Create …". */
  readonly onCreate?: (text: string) => void;
  /** Under the choices, after a line ("New Label…"): each closes the menu. */
  readonly actions?: ReadonlyArray<{ readonly label: string; readonly icon: IconName; readonly onSelect: () => void }>;
  readonly align?: 'start' | 'end';
  readonly placeholder?: string;
}

export function PickMenu<T extends string>({ label, choices, chosen, onPick, children, multiple, search, onCreate, actions, align = 'start', placeholder }: PickMenuProps<T>) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const searchable = search ?? (choices.length > 8 || Boolean(onCreate));
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => (q ? choices.filter((c) => c.label.toLowerCase().includes(q) || c.hint?.toLowerCase().includes(q)) : choices), [choices, q]);
  const exact = choices.some((c) => c.label.toLowerCase() === q);
  // A plain pick (no field, one choice) is the Mac's own menu in the app (lib/native-menu.ts); one
  // with a field or several ticks keeps this menu, which stays open as you type or tick.
  const rows = (): NativeRow[] => [
    ...choices.map((c, i): NativeRow => ({
      label: c.label,
      ...(c.hint ? { hint: c.hint } : {}),
      ...(c.mark ? { mark: c.mark } : {}),
      ...(chosen.includes(c.value) ? { checked: true } : {}),
      ...(c.section && c.section !== choices[i - 1]?.section ? { header: c.section } : {}),
      onSelect: () => onPick(c.value),
    })),
    ...(actions ?? []).map((a, i): NativeRow => ({ label: a.label, icon: a.icon, ...(i === 0 ? { separate: true } : {}), onSelect: a.onSelect })),
  ];
  return (
    <Dropdown.Root
      modal={false}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <Dropdown.Trigger asChild {...(searchable || multiple ? {} : nativeDropdown(rows, undefined, () => setOpen(true)))}>
        {children}
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <FitContent
          className={cx(m.menu, t.pickMenu)}
          align={align}
          onCloseAutoFocus={(e) => e.preventDefault()}
          aria-label={label}
          onKeyDown={(e) => {
            // 1–9 pick the first nine (like Linear's menus).
            const n = Number(e.key);
            if (searchable || !Number.isInteger(n) || n < 1 || n > 9 || e.metaKey || e.ctrlKey) return;
            const c = shown[n - 1];
            if (!c) return;
            e.preventDefault();
            onPick(c.value);
            if (!multiple) setOpen(false);
          }}
        >
          {searchable ? (
            <div className={t.pickSearch}>
              <Icon name="search" size={12} />
              <input
                autoFocus
                value={query}
                placeholder={placeholder ?? (onCreate ? 'Find or create…' : 'Find…')}
                onChange={(e) => setQuery(e.target.value)}
                // Typing goes to the field, not the menu's type-ahead.
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && onCreate && q && !exact) {
                    e.preventDefault();
                    onCreate(query.trim());
                    setQuery('');
                  } else if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Escape' && e.key !== 'Tab') e.stopPropagation();
                }}
                aria-label={`Find ${label.toLowerCase()}`}
              />
            </div>
          ) : null}
          {shown.map((c, i) => {
            const on = chosen.includes(c.value);
            const section = c.section && c.section !== shown[i - 1]?.section ? c.section : undefined;
            return (
              <div key={c.value}>
                {section ? <Dropdown.Label className={t.pickSection}>{section}</Dropdown.Label> : null}
                <Dropdown.Item
                  className={m.item}
                  onSelect={(e) => {
                    if (multiple) e.preventDefault();
                    onPick(c.value);
                  }}
                  data-checked={on || undefined}
                >
                  <span className={m.line}>
                    {c.mark ? <span className={t.pickMark}>{c.mark}</span> : null}
                    <span className={m.label}>{c.label}</span>
                    {on ? <Icon name="check" size={12} className={t.pickCheck} /> : null}
                    {!searchable && i < 9 ? <kbd className={m.keys}>{i + 1}</kbd> : null}
                  </span>
                  {c.hint ? <span className={cx(m.hint, c.mark ? m.hintIndent : undefined)}>{c.hint}</span> : null}
                </Dropdown.Item>
              </div>
            );
          })}
          {onCreate && q && !exact ? (
            <Dropdown.Item
              className={m.item}
              onSelect={(e) => {
                if (multiple) e.preventDefault();
                onCreate(query.trim());
                setQuery('');
              }}
            >
              <span className={m.line}>
                <span className={t.pickMark}>
                  <Icon name="plus" size={12} />
                </span>
                <span className={m.label}>Create “{query.trim()}”</span>
              </span>
            </Dropdown.Item>
          ) : null}
          {!shown.length && !(onCreate && q) ? <div className={t.pickEmpty}>Nothing matches</div> : null}
          {actions?.length ? <Dropdown.Separator className={m.separator} /> : null}
          {actions?.map((a) => (
            <Dropdown.Item key={a.label} className={m.item} onSelect={a.onSelect}>
              <span className={m.line}>
                <span className={t.pickMark}>
                  <Icon name={a.icon} size={12} />
                </span>
                <span className={m.label}>{a.label}</span>
              </span>
            </Dropdown.Item>
          ))}
        </FitContent>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
