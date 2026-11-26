import * as Dialog from '@radix-ui/react-dialog';
import { type ReactNode, useRef } from 'react';
import { Icon, type IconName } from './Icon.js';
import { cx } from './ui.js';
import s from './alert.module.css';
import { primaryKey } from '../lib/shortcuts-model.js';

export interface AlertButton {
  readonly label: string;
  readonly onClick: () => void;
  /** Red: it destroys or discards something. */
  readonly destructive?: boolean;
  readonly disabled?: boolean;
}

/** A small table under the message (files and what changed in them…). */
export interface AlertTable {
  readonly caption?: string;
  readonly columns: readonly string[];
  readonly rows: ReadonlyArray<readonly ReactNode[]>;
}

export interface AlertProps {
  readonly title: string;
  readonly message?: ReactNode;
  readonly icon?: IconName;
  /** The icon's color: `danger` for deleting and discarding, `caution` for "are you sure". */
  readonly tone?: 'info' | 'caution' | 'danger';
  readonly table?: AlertTable;
  /** What Return does (the button on the right). */
  readonly confirm: AlertButton;
  /** A second way to go on, shown on the left (like "Don't Save"). */
  readonly alternative?: AlertButton;
  /** What Esc does. `false`: there's only the one button (an OK). */
  readonly cancel?: string | false;
  readonly onCancel: () => void;
  /** Below the message: a checkbox like "Also start a fresh conversation". */
  readonly children?: ReactNode;
}

/**
 * A macOS alert: an icon, a bold question, a sentence about what happens, then the buttons on
 * the right. Return presses the default button (blue, or red when it destroys something),
 * Esc and Cancel close it without doing anything.
 */
export function Alert({ title, message, icon = 'alert', tone = 'caution', table, confirm, alternative, cancel = 'Cancel', onCancel, children }: AlertProps) {
  const ok = useRef<HTMLButtonElement>(null);
  return (
    <Dialog.Root open onOpenChange={(v) => (v ? undefined : onCancel())}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content
          role="alertdialog"
          className={s.alert}
          onOpenAutoFocus={(e) => (e.preventDefault(), ok.current?.focus())}
          onKeyDown={(e) => {
            // Return is the default button, wherever the focus is (except another button or a field).
            if (e.key !== 'Enter' || primaryKey(e) || e.shiftKey) return;
            const el = e.target as HTMLElement;
            if (el.tagName === 'BUTTON' && el !== ok.current) return;
            if (el.tagName === 'TEXTAREA') return;
            e.preventDefault();
            if (!confirm.disabled) confirm.onClick();
          }}
        >
          <div className={s.body}>
            <span className={cx(s.icon, s[`icon_${tone}`])} aria-hidden="true">
              <Icon name={icon} size={22} />
            </span>
            <div className={s.text}>
              <Dialog.Title className={s.title}>{title}</Dialog.Title>
              {message ? (
                <Dialog.Description asChild>
                  <div className={cx(s.message, 'selectable')}>{message}</div>
                </Dialog.Description>
              ) : (
                <Dialog.Description className="visually-hidden">{title}</Dialog.Description>
              )}
              {table ? <AlertDetail table={table} /> : null}
              {children ? <div className={s.accessory}>{children}</div> : null}
            </div>
          </div>
          <div className={s.buttons}>
            {alternative ? (
              <button type="button" className={cx(s.button, alternative.destructive && s.destructiveText)} disabled={alternative.disabled} onClick={alternative.onClick}>
                {alternative.label}
              </button>
            ) : null}
            <span className={s.flex} />
            {cancel !== false ? (
              <button type="button" className={s.button} onClick={onCancel}>
                {cancel}
              </button>
            ) : null}
            <button ref={ok} type="button" className={cx(s.button, s.default, confirm.destructive && s.destructive)} disabled={confirm.disabled} onClick={confirm.onClick}>
              {confirm.label}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function AlertDetail({ table }: { table: AlertTable }) {
  return (
    <div className={s.detail}>
      {table.caption ? <div className={s.caption}>{table.caption}</div> : null}
      <table className={cx(s.table, 'selectable')}>
        <thead>
          <tr>
            {table.columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The small checkbox under an alert's message, or in a form (macOS style). */
export function Checkbox({ checked, onChange, label, detail, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; detail?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cx(s.check, disabled && s.checkOff)}>
      <input type="checkbox" className={s.box} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className={s.checkText}>
        <span>{label}</span>
        {detail ? <span className={s.checkDetail}>{detail}</span> : null}
      </span>
    </label>
  );
}
