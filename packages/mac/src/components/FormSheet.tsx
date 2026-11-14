import * as Dialog from '@radix-ui/react-dialog';
import { type ReactNode, type Ref, type TextareaHTMLAttributes, type InputHTMLAttributes, useId, useState } from 'react';
import { pickFolders } from '../lib/projects.js';
import { copyText } from '../lib/copy.js';
import { canPickFolders } from '../lib/boot.js';
import { useMachine } from '../lib/beluga.js';
import { Icon, type IconName } from './Icon.js';
import { Select, type SelectEntry } from './Select.js';
import { cx } from './ui.js';
import s from './form.module.css';
import { primaryKey } from '../lib/shortcuts-model.js';

export { Checkbox } from './Alert.js';

export interface FormSheetProps {
  readonly title: string;
  /** One or two short sentences under the title: what this does. */
  readonly intro?: ReactNode;
  readonly icon?: IconName;
  /** The default button (Return). */
  readonly submitLabel: string;
  /** Run it. Return an error to show it and keep the sheet open. */
  readonly onSubmit: () => void | string | Promise<void | string>;
  readonly onCancel: () => void;
  /** Turn the default button off (until the form makes sense). */
  readonly canSubmit?: boolean;
  /** Red default button: it removes something. */
  readonly destructive?: boolean;
  /** Left of the buttons: a link-like button, a note… */
  readonly footer?: ReactNode;
  readonly width?: number;
  /** Most of the window's height, its content filling it (a document's preview). */
  readonly tall?: boolean;
  /**
   * The head and buttons stay put and a long list scrolls inside: the child marked `data-sheet-scroll`
   * takes the room left and scrolls (the sheet itself never does).
   */
  readonly scrolls?: boolean;
  /** No default button at all, only Done (a sheet that acts as you click inside it). */
  readonly cancelLabel?: string;
  readonly hideSubmit?: boolean;
  readonly children?: ReactNode;
}

/**
 * A Mac sheet with a form: the title, a short intro, labelled fields, then Cancel and the default
 * button on the right. Return in a field (⌘Return in a text area) presses the default button.
 */
export function FormSheet({ title, intro, icon, submitLabel, onSubmit, onCancel, canSubmit = true, destructive, footer, width = 520, tall, scrolls, cancelLabel = 'Cancel', hideSubmit, children }: FormSheetProps) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async (): Promise<void> => {
    if (!canSubmit || busy) return;
    setBusy(true);
    try {
      const problem = await onSubmit();
      if (problem) setError(problem);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog.Root open onOpenChange={(v) => (v ? undefined : onCancel())}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content
          className={cx(s.sheet, tall && s.tall, scrolls && s.scrolls)}
          style={{ width: `min(${width}px, calc(100vw - 48px))` }}
          aria-describedby={undefined}
          // Escape in a field with its suggestions open (New Task's "@") closes them, not the sheet.
          onEscapeKeyDown={(e) => {
            if (document.activeElement?.getAttribute('aria-expanded') === 'true' && document.activeElement.getAttribute('aria-haspopup') === 'listbox') e.preventDefault();
          }}
          onOpenAutoFocus={(e) => {
            // The first field gets the focus (not the close button).
            const root = e.currentTarget as HTMLElement | null;
            const first = root?.querySelector<HTMLElement>('[data-autofocus]') ?? root?.querySelector<HTMLElement>('input:not([type=checkbox]), textarea, [data-select-trigger]');
            if (first) {
              e.preventDefault();
              first.focus();
              if (first instanceof HTMLInputElement) first.select();
            } else if (scrolls && root) {
              // Its list still loading: the sheet itself, not the first tab (whose tip would pop up over it).
              e.preventDefault();
              root.focus();
            }
          }}
        >
          <form
            className={s.form}
            onSubmit={(e) => {
              e.preventDefault();
              if (!hideSubmit) void submit();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && primaryKey(e) && !hideSubmit) {
                e.preventDefault();
                void submit();
              }
            }}
          >
            <div className={s.head}>
              {icon ? (
                <span className={s.icon} aria-hidden="true">
                  <Icon name={icon} size={18} />
                </span>
              ) : null}
              <div className={s.headText}>
                <Dialog.Title className={s.title}>{title}</Dialog.Title>
                {intro ? <div className={s.intro}>{intro}</div> : null}
              </div>
            </div>
            {children ? <div className={s.fields}>{children}</div> : null}
            {error ? (
              <div className={s.error} role="alert">
                <Icon name="alert" size={13} />
                {error}
              </div>
            ) : null}
            <div className={s.buttons}>
              {footer ? <div className={s.footer}>{footer}</div> : <span className={s.flex} />}
              <button type="button" className={s.button} onClick={onCancel}>
                {hideSubmit ? (cancelLabel === 'Cancel' ? 'Done' : cancelLabel) : cancelLabel}
              </button>
              {hideSubmit ? null : (
                <button type="submit" className={cx(s.button, s.default, destructive && s.destructive)} disabled={!canSubmit || busy}>
                  {submitLabel}
                </button>
              )}
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** One row of a form: the label on the left, the control, then a hint (or what's wrong) under it. */
export function Field({ label, hint, error, children, htmlFor, aside }: { label: string; hint?: ReactNode; error?: string; children: ReactNode; htmlFor?: string; aside?: ReactNode }) {
  return (
    <div className={s.field}>
      <label className={s.label} htmlFor={htmlFor}>
        {label}
      </label>
      <div className={s.control}>
        <div className={s.controlRow}>
          {children}
          {aside}
        </div>
        {error ? <div className={s.fieldError}>{error}</div> : hint ? <div className={s.hint}>{hint}</div> : null}
      </div>
    </div>
  );
}

type TextProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> & { readonly value: string; readonly onChange: (v: string) => void; readonly mono?: boolean; readonly invalid?: boolean };

export function TextInput({ value, onChange, mono, invalid, className, ...rest }: TextProps) {
  return <input {...rest} className={cx(s.input, mono && s.mono, invalid && s.invalid, className)} value={value} spellCheck={mono ? false : rest.spellCheck} autoComplete="off" onChange={(e) => onChange(e.target.value)} />;
}

type AreaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value'> & { readonly value: string; readonly onChange: (v: string) => void; readonly mono?: boolean; readonly ref?: Ref<HTMLTextAreaElement> };

export function TextArea({ value, onChange, mono, className, rows = 4, ...rest }: AreaProps) {
  return <textarea {...rest} rows={rows} className={cx(s.input, s.area, mono && s.mono, className)} value={value} onChange={(e) => onChange(e.target.value)} />;
}

/** A pop-up button (NSPopUpButton): Beluga's own Select, at least as wide as a field's start. */
export function Popup<T extends string>({ value, options, onChange, label, id }: { value: T; options: ReadonlyArray<SelectEntry<T>>; onChange: (v: T) => void; label?: string; id?: string }) {
  return <Select id={id} className={s.popup} value={value} options={options} label={label ?? ''} onChange={onChange} />;
}

/** A folder path you can type, or choose with the Open panel. */
export function FolderInput({ value, onChange, title = 'Choose a folder', placeholder = '~/code/app' }: { value: string; onChange: (v: string) => void; title?: string; placeholder?: string }) {
  const id = useId();
  // On a computer's page, its folders (BLG-793).
  const machine = useMachine();
  return (
    <div className={s.folder}>
      <TextInput id={id} value={value} onChange={onChange} mono placeholder={placeholder} aria-label="Folder" />
      {canPickFolders() ? (
        <button
          type="button"
          className={s.button}
          onClick={() =>
            void pickFolders(title, { machine }).then((p) => {
              if (p?.[0]) onChange(p[0]);
            })
          }
        >
          Choose…
        </button>
      ) : null}
    </div>
  );
}

/** A tag saying where a value comes from ("beluga.json", "your settings"). */
export function SourceTag({ children, tone }: { children: ReactNode; tone?: 'team' | 'mine' | 'guess' }) {
  return <span className={cx(s.tag, tone && s[`tag_${tone}`])}>{children}</span>;
}

/** A command to type in Terminal, with a Copy button. */
export function CommandLine({ command, onCopy = (c) => void copyText(c) }: { command: string; onCopy?: (command: string) => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={s.commandLine}>
      <code className="selectable">{command}</code>
      <button
        type="button"
        className={s.copy}
        aria-label={`Copy ${command}`}
        onClick={() => {
          onCopy(command);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} size={12} />
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export interface PickRow<T extends string> {
  readonly value: T;
  readonly name: ReactNode;
  readonly detail?: ReactNode;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
}

/** A list to pick one thing from (a person, a template). Double-click picks and goes on. */
export function PickList<T extends string>({ rows, value, onChange, onChoose, label }: { rows: ReadonlyArray<PickRow<T>>; value: T | undefined; onChange: (v: T) => void; onChoose?: (v: T) => void; label: string }) {
  const move = (delta: number): void => {
    const at = rows.findIndex((r) => r.value === value);
    const next = rows[Math.max(0, Math.min(rows.length - 1, at + delta))];
    if (next) onChange(next.value);
  };
  return (
    <div
      className={s.list}
      role="listbox"
      aria-label={label}
      tabIndex={0}
      data-autofocus
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          move(e.key === 'ArrowDown' ? 1 : -1);
        }
      }}
    >
      {rows.map((r) => (
        <button
          key={r.value}
          type="button"
          role="option"
          tabIndex={-1}
          aria-selected={r.value === value}
          className={cx(s.row, r.value === value && s.rowOn)}
          onClick={() => onChange(r.value)}
          onDoubleClick={() => onChoose?.(r.value)}
        >
          {r.leading}
          <span className={s.rowText}>
            <span className={s.rowName}>{r.name}</span>
            {r.detail ? <span className={s.rowDetail}>{r.detail}</span> : null}
          </span>
          {r.trailing}
        </button>
      ))}
    </div>
  );
}

export const formStyles = s;
