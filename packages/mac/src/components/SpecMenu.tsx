import * as Context from '@radix-ui/react-context-menu';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { type ComponentPropsWithoutRef, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { type MenuKind, menuSpec } from '@beluga/ui/menus.js';
import { useActions } from '../lib/actions.js';
import { useBeluga } from '../lib/beluga.js';
import { Icon, type IconName } from './Icon.js';
import { guiHint } from '../lib/gui-copy.js';
import { ContextRoot } from './ContextRoot.js';
import { type NativeRow, nativeContext, nativeDropdown } from '../lib/native-menu.js';
import s from './SpecMenu.module.css';

/**
 * A menu built from its shared spec (projectMenu, personMenu…): the spec's options, ids and
 * actions when picked. "Close" isn't needed here.
 */
function useItems(menu: MenuKind, hide?: (id: string) => boolean) {
  const { client } = useBeluga();
  const spec = menuSpec(client.store.getState(), menu);
  return (spec?.options ?? []).map((o, index) => ({ ...o, index })).filter((o) => o.id !== 'close' && !hide?.(o.id));
}

/**
 * Closing a menu leaves the focus alone (like macOS menus), so what an item opens (a name
 * field in the sidebar, a sheet) keeps it instead of the row the menu came from.
 */
const keepFocus = (e: Event): void => e.preventDefault();

/**
 * A menu is portaled out of the DOM, but React still bubbles its clicks to what it came from:
 * choosing from a row's ⋯ would also click the row (open the project's home). It stops here.
 */
const stayInMenu = (e: MouseEvent): void => e.stopPropagation();

/** A hint that is a shortcut (⌘J) sits at the right like a menu bar's; a description is a tooltip. */
const isKeys = (hint: string | undefined): hint is string => !!hint && (/^[⌘⌥⇧⌃↩⌫]+.{0,3}$/.test(hint) || /^((Ctrl|Alt|Shift|Win|Super)\+)+.{1,5}$/.test(hint));

/**
 * How close a menu may come to the window's edges. The top keeps clear of the title bar,
 * where the traffic lights would draw over the first rows (52 is --titlebar-h).
 */
const EDGES = { top: 52, right: 8, bottom: 8, left: 8 } as const;

/** Whether a menu's rows leave room for an icon in front, so every row starts at the same place. */
const hasIcons = (items: readonly ActionItem[]): boolean => items.some((it) => it.icon || it.mark || it.checked !== undefined);

const isDanger = (id: string): boolean => /delete|remove|leave|revoke|stop|hide/.test(id);

/** A spec menu's rows as the web menu groups them: its own, this window's extras, the dangerous ones last. */
function useSpecRows(menu: MenuKind, extra: readonly ActionItem[] = [], hide?: (id: string) => boolean): () => readonly NativeRow[] {
  const actions = useActions();
  const { client } = useBeluga();
  return () => {
    const spec = menuSpec(client.store.getState(), menu);
    const items = (spec?.options ?? []).map((o, index) => ({ ...o, index })).filter((o) => o.id !== 'close' && !hide?.(o.id));
    const row = (o: (typeof items)[number]): NativeRow => {
      const hint = guiHint(o.hint);
      // A hint that isn't a shortcut is the web menu's tooltip: a native menu has none, so it goes.
      return { label: o.label, ...(isKeys(hint) ? { keys: hint } : {}), danger: isDanger(o.id), onSelect: () => actions.pick(menu, o.index) };
    };
    const groups = [items.filter((o) => !isDanger(o.id)).map(row), extra, items.filter((o) => isDanger(o.id)).map(row)].filter((g) => g.length);
    return groups.flatMap((g, gi) => g.map((r, i) => (gi > 0 && i === 0 ? { ...r, separate: true } : r)));
  };
}

function Items({ menu, Item, Separator, extra = [], hide, kit }: { menu: MenuKind; Item: typeof Dropdown.Item; Separator: typeof Dropdown.Separator; extra?: readonly ActionItem[]; hide?: (id: string) => boolean; kit: SubKit }) {
  const actions = useActions();
  const items = useItems(menu, hide);
  // The extras' icons set the column the names start in; the spec's own rows line up with it.
  const icons = hasIcons(extra);
  // The spec's own actions first, then this window's extras (groups, icon), the dangerous ones last.
  const row = (o: (typeof items)[number]) => (
    <Item key={o.id} className={`${s.item} ${isDanger(o.id) ? s.danger : ''}`} onSelect={() => actions.pick(menu, o.index)} title={isKeys(guiHint(o.hint)) ? undefined : guiHint(o.hint)}>
      <span className={s.line}>
        {icons ? <span className={s.icon} aria-hidden="true" /> : null}
        <span className={s.label}>{o.label}</span>
        {isKeys(guiHint(o.hint)) ? <span className={s.keys}>{guiHint(o.hint)}</span> : null}
      </span>
    </Item>
  );
  const safe = items.filter((o) => !isDanger(o.id));
  const danger = items.filter((o) => isDanger(o.id));
  return (
    <>
      {safe.map(row)}
      {extra.length && safe.length ? <Separator className={s.separator} /> : null}
      <ActionRows items={extra} Item={Item} Separator={Separator} kit={kit} />
      {danger.length && (safe.length || extra.length) ? <Separator className={s.separator} /> : null}
      {danger.map(row)}
    </>
  );
}

type Side = 'top' | 'right' | 'bottom' | 'left';
/** The room a menu keeps from its button and from the window's edge. */
const OFFSET = 4;
const EDGE = 8;

/**
 * Where a dropdown opens so it shows whole, never scrolled: below its button when it fits there,
 * else above, else beside it (left or right, whichever has more room), where it slides up or down
 * to fit the window.
 */
export function fitSide(button: Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>, height: number, view: { readonly width: number; readonly height: number }): Side {
  const room = OFFSET + EDGE;
  if (height <= view.height - button.bottom - room) return 'bottom';
  if (height <= button.top - room) return 'top';
  return button.left >= view.width - button.right ? 'left' : 'right';
}

/** A dropdown's content that opens on the side it fits on (fitSide), measured as it opens. */
export function FitContent({ children, ...props }: ComponentPropsWithoutRef<typeof Dropdown.Content>) {
  const ref = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState<Side>('bottom');
  useLayoutEffect(() => {
    // Radix ties the button to its menu by id once both are in the page: measured as it opens,
    // and again on the next frames until they are (before the menu is placed, so it never jumps).
    let frame = 0;
    let tries = 0;
    const measure = (): void => {
      const el = ref.current;
      const button = el?.id ? document.querySelector(`[aria-controls="${CSS.escape(el.id)}"]`) : null;
      if (!el || !button) {
        if (tries++ < 5) frame = requestAnimationFrame(measure);
        return;
      }
      setSide(fitSide(button.getBoundingClientRect(), el.scrollHeight, { width: window.innerWidth, height: window.innerHeight }));
    };
    measure();
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <Dropdown.Content side={side} sideOffset={OFFSET} collisionPadding={EDGES} sticky="always" {...props} ref={ref}>
      {children}
    </Dropdown.Content>
  );
}

/** A dropdown from a button (the ⋯ on a project). Built when opened, so it's always current. */
export function SpecDropdown({ menu, children, align = 'start', extra, hide }: { menu: MenuKind; children: ReactNode; align?: 'start' | 'end'; extra?: readonly ActionItem[]; hide?: (id: string) => boolean }) {
  const rows = useSpecRows(menu, extra, hide);
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild {...nativeDropdown(rows)}>{children}</Dropdown.Trigger>
      <Dropdown.Portal>
        <FitContent className={s.menu} onClick={stayInMenu} onCloseAutoFocus={keepFocus} align={align}>
          <Items menu={menu} Item={Dropdown.Item} Separator={Dropdown.Separator} kit={DROPDOWN_SUB} {...(extra ? { extra } : {})} {...(hide ? { hide } : {})} />
        </FitContent>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/** A right-click menu on anything (a project row, a person). */
export function SpecContext({ menu, children, extra, hide }: { menu: MenuKind | undefined; children: ReactNode; extra?: readonly ActionItem[]; hide?: (id: string) => boolean }) {
  if (!menu) return <>{children}</>;
  return <SpecContextOf menu={menu} {...(extra ? { extra } : {})} {...(hide ? { hide } : {})}>{children}</SpecContextOf>;
}

function SpecContextOf({ menu, children, extra, hide }: { menu: MenuKind; children: ReactNode; extra?: readonly ActionItem[]; hide?: (id: string) => boolean }) {
  const rows = useSpecRows(menu, extra, hide);
  return (
    <ContextRoot>
      <Context.Trigger asChild onContextMenu={nativeContext(rows)}>{children}</Context.Trigger>
      <Context.Portal>
        <Context.Content className={s.menu} onClick={stayInMenu} onCloseAutoFocus={keepFocus} collisionPadding={EDGES} sticky="always">
          <Items menu={menu} Item={Context.Item as unknown as typeof Dropdown.Item} Separator={Context.Separator as unknown as typeof Dropdown.Separator} kit={CONTEXT_SUB} {...(extra ? { extra } : {})} {...(hide ? { hide } : {})} />
        </Context.Content>
      </Context.Portal>
    </ContextRoot>
  );
}

/** A plain menu of actions (not from a spec): the workspace's ⋯ and its right-click menu. */
export interface ActionItem {
  readonly label: string;
  readonly hint?: string;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  /** Its shortcut, shown on the right like a Mac menu (⇧⌘C). */
  readonly keys?: string;
  readonly icon?: IconName;
  /** Drawn where the icon goes, instead of one of the app's icons (a computer's own mark). */
  readonly mark?: ReactNode;
  /** Starts a new group (a line above it). */
  readonly separate?: boolean;
  /** A checkmark in front (the group a project is in); with `toggle`, whether its switch is on. */
  readonly checked?: boolean;
  /** An on/off setting, not a choice (Full Autopilot): a switch on the right shows `checked`, and picking it keeps the menu open. */
  readonly toggle?: boolean;
  /** Picking it keeps the menu open, so the change shows where it was made (a choice in a submenu: Builder ▸). */
  readonly stay?: boolean;
  /** A colour dot before the name (a choice of colours: a tile's tint). */
  readonly swatch?: string;
  /** A submenu ("Move to Group ▸"): picking the row itself does nothing. */
  readonly submenu?: readonly ActionItem[];
  readonly onSelect: () => void;
}

/** The submenu parts of one kind of menu (dropdown or right-click). */
interface SubKit {
  readonly Sub: typeof Dropdown.Sub;
  readonly SubTrigger: typeof Dropdown.SubTrigger;
  readonly SubContent: typeof Dropdown.SubContent;
  readonly Portal: typeof Dropdown.Portal;
}
const DROPDOWN_SUB: SubKit = { Sub: Dropdown.Sub, SubTrigger: Dropdown.SubTrigger, SubContent: Dropdown.SubContent, Portal: Dropdown.Portal };
const CONTEXT_SUB = { Sub: Context.Sub, SubTrigger: Context.SubTrigger, SubContent: Context.SubContent, Portal: Context.Portal } as unknown as SubKit;

type AnyItem = typeof Dropdown.Item;
type AnySeparator = typeof Dropdown.Separator;

/** The rows of an action menu: a line between groups and before the first dangerous one. */
function ActionRows({ items, Item, Separator, kit = DROPDOWN_SUB }: { items: readonly ActionItem[]; Item: AnyItem; Separator: AnySeparator; kit?: SubKit }) {
  const icons = hasIcons(items);
  return (
    <>
      {items.map((it, i) => (
        <div key={`${it.label}:${i}`}>
          {i > 0 && (it.separate || (it.danger && !items[i - 1]!.danger)) ? <Separator className={s.separator} /> : null}
          {it.submenu ? (
            <kit.Sub>
              <kit.SubTrigger className={s.item} disabled={it.disabled}>
                <span className={s.line}>
                  {icons ? <span className={s.icon} aria-hidden="true">{it.mark ?? (it.icon ? <Icon name={it.icon} size={13} /> : it.checked ? <Icon name="check" size={12} /> : null)}</span> : null}
                  <span className={s.label}>{it.label}</span>
                  {/* The submenu that holds the pick (the agent whose model is in use) is checked too. */}
                  {it.checked && (it.icon || it.mark) ? <Icon name="check" size={12} className={s.trailingCheck} /> : null}
                  <Icon name="chevronRight" size={10} className={s.subArrow} />
                </span>
                {it.hint ? <span className={`${s.hint} ${icons ? s.hintIndent : ''}`}>{it.hint}</span> : null}
              </kit.SubTrigger>
              <kit.Portal>
                <kit.SubContent className={s.menu} sideOffset={2} alignOffset={-5} collisionPadding={EDGES} sticky="always">
                  <ActionRows items={it.submenu} Item={Item} Separator={Separator} kit={kit} />
                </kit.SubContent>
              </kit.Portal>
            </kit.Sub>
          ) : (
          <Item
            className={`${s.item} ${it.danger ? s.danger : ''}`}
            disabled={it.disabled}
            // A switch flips in place, and a choice that stays shows on its row: the menu stays open so you see it change.
            onSelect={
              it.toggle || it.stay
                ? (e: Event) => {
                    e.preventDefault();
                    it.onSelect();
                  }
                : it.onSelect
            }
            data-checked={it.checked || undefined}
            {...(it.toggle ? { role: 'menuitemcheckbox', 'aria-checked': Boolean(it.checked) } : {})}
          >
            <span className={s.line}>
              {/* A row with its own icon keeps it (a choice of icons); the check then goes after the name. */}
              {icons ? <span className={s.icon} aria-hidden="true">{it.mark ?? (it.icon ? <Icon name={it.icon} size={13} /> : it.checked && !it.toggle ? <Icon name="check" size={12} /> : null)}</span> : null}
              {it.swatch ? <span className={s.swatch} style={{ background: it.swatch }} aria-hidden="true" /> : null}
              <span className={s.label}>{it.label}</span>
              {it.toggle ? <span className={`${s.toggle} ${it.checked ? s.toggleOn : ''}`} aria-hidden="true" /> : null}
              {it.checked && !it.toggle && (it.icon || it.mark) ? <Icon name="check" size={12} className={s.trailingCheck} /> : null}
              {it.keys ? <kbd className={s.keys}>{it.keys}</kbd> : null}
            </span>
            {it.hint ? <span className={`${s.hint} ${icons ? s.hintIndent : ''}`}>{it.hint}</span> : null}
          </Item>
          )}
        </div>
      ))}
    </>
  );
}

/**
 * A right-click menu of actions. `items` may be a function: it's called when the menu opens
 * (so it can look at what's selected right then).
 */
export function ActionsContext({ items, children }: { items: readonly ActionItem[] | (() => readonly ActionItem[]); children: ReactNode }) {
  return (
    <ContextRoot>
      <Context.Trigger asChild onContextMenu={nativeContext(() => (typeof items === 'function' ? items() : items))}>{children}</Context.Trigger>
      <Context.Portal>
        <Context.Content className={s.menu} onClick={stayInMenu} onCloseAutoFocus={keepFocus} collisionPadding={EDGES} sticky="always">
          <LazyRows items={items} />
        </Context.Content>
      </Context.Portal>
    </ContextRoot>
  );
}

function LazyRows({ items }: { items: readonly ActionItem[] | (() => readonly ActionItem[]) }) {
  const list = typeof items === 'function' ? items() : items;
  if (!list.length) return <Context.Item className={s.item} disabled><span className={s.label}>Nothing to do here</span></Context.Item>;
  return <ActionRows items={list} Item={Context.Item as unknown as AnyItem} Separator={Context.Separator as unknown as AnySeparator} kit={CONTEXT_SUB} />;
}

export function ActionsDropdown({ items, children, align = 'end' }: { items: readonly ActionItem[]; children: ReactNode; align?: 'start' | 'end' }) {
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild {...nativeDropdown(() => items)}>{children}</Dropdown.Trigger>
      <Dropdown.Portal>
        <FitContent className={s.menu} onClick={stayInMenu} onCloseAutoFocus={keepFocus} align={align}>
          <ActionRows items={items} Item={Dropdown.Item} Separator={Dropdown.Separator} />
        </FitContent>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
