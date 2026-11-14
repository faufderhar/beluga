import { useState } from 'react';
import type { ExampleInfo, InheritedVar } from '@beluga/core/env-vars.js';
import { type EnvVar, parseEnvText } from '@beluga/shared/env-vars.js';
import { Icon } from '../components/Icon.js';
import { Button, Tip, cx } from '../components/ui.js';
import { useApi } from '../lib/beluga.js';
import e from './env-settings.module.css';

/** Paste KEY=value lines (a .env, an export block) to add them all at once. */
export function ImportBox({ onImport, onClose }: { onImport: (vars: EnvVar[]) => void; onClose: () => void }) {
  const [text, setText] = useState('');
  const parsed = parseEnvText(text);
  return (
    <div className={e.importBox}>
      <textarea className={e.importText} aria-label="KEY=value lines" autoFocus spellCheck={false} placeholder={'API_URL=https://api.example.com\nexport TOKEN="…"'} value={text} onChange={(ev) => setText(ev.target.value)} />
      <div className={e.importBar}>
        <span className={e.muted}>{text.trim() ? `${parsed.vars.length} variable${parsed.vars.length === 1 ? '' : 's'}${parsed.skipped.length ? ` · ${parsed.skipped.length} line${parsed.skipped.length === 1 ? '' : 's'} skipped` : ''}` : 'Lines like KEY=value. # comments and export are fine.'}</span>
        <span className={e.flex} />
        <Button size="small" variant="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button size="small" variant="primary" disabled={!parsed.vars.length} onClick={() => onImport(parsed.vars)}>
          Add {parsed.vars.length || ''}
        </Button>
      </div>
    </div>
  );
}

/** What a tag says about where a lent row comes from. */
export function tagOf(from: string): string {
  if (from.startsWith('.env')) return '.env';
  if (from === 'Everywhere') return 'yours';
  if (from === 'this worktree') return 'here';
  return 'project';
}

function tipOf(item: InheritedVar, needed: boolean): string {
  if (needed) return `${item.from} lists ${item.key}, and nothing sets it. Type a value to set it here.`;
  if (item.from.startsWith('.env')) return `From the main folder’s ${item.from}. Type over it to change it here; the file stays as it is.`;
  if (item.from === 'Everywhere') return 'One of yours, for every project. Type over it to change it here only.';
  return `From ${item.from}’s variables. Type over it to change it in this worktree only.`;
}

/**
 * A row lent from below (the .env, yours, the project's) or one .env.example asks for that
 * nothing sets: its name fixed and greyed, and typing in its value sets it here.
 */
export function Lent({ item, needed, hidden, canToggle, onToggle, onType, onCopy }: { item: InheritedVar; needed: boolean; hidden: boolean; canToggle: boolean; onToggle: () => void; onType: (value: string, caret: number | null) => void; onCopy: (value: string) => void }) {
  const { key, value } = item;
  return (
    <div className={cx(e.row, e.lent)}>
      <input className={cx(e.key, e.fixedKey)} aria-label="Name" value={key} readOnly tabIndex={-1} />
      <span className={e.valueCell}>
        <input
          className={cx(e.value, hidden && value && e.masked)}
          aria-label={needed ? `Value of ${key} (asked for by ${item.from})` : `Value of ${key} (from ${item.from}; typing sets it here)`}
          value={value}
          placeholder={needed ? 'needed, not set' : ''}
          spellCheck={false}
          autoComplete="off"
          onChange={(ev) => onType(ev.target.value, ev.target.selectionStart)}
        />
        {value ? (
          <Tip label={`Copy ${key}`}>
            <button type="button" className={e.copy} aria-label={`Copy ${key}`} onClick={() => onCopy(value)}>
              <Icon name="copy" size={11} />
            </button>
          </Tip>
        ) : null}
      </span>
      <button type="button" className={cx(e.eye, !hidden && e.eyeOn)} aria-label={hidden ? `Show ${key}` : `Hide ${key}`} aria-pressed={!hidden} disabled={!canToggle || !value} onClick={onToggle}>
        <Icon name="eye" size={13} />
      </button>
      <Tip label={tipOf(item, needed)}>
        <span className={cx(e.sourceTag, needed && e.neededTag)}>{needed ? 'needed' : tagOf(item.from)}</span>
      </Tip>
    </div>
  );
}

/**
 * Under a project's list: names set here or in its .env that its .env.example doesn't list, and
 * Add to .env.example (a placeholder each, never the value: the file is committed). With no
 * template yet, Create .env.example.
 */
export function ExampleNote({ projectId, example, onDone, onError }: { projectId: string; example: ExampleInfo; onDone: (n: number) => void; onError: (text: string) => void }) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  if (!example.unlisted.length) return null;
  const file = example.file ?? '.env.example';
  const names = example.unlisted.slice(0, 4).join(', ') + (example.unlisted.length > 4 ? ` and ${example.unlisted.length - 4} more` : '');
  const go = (): void => {
    setBusy(true);
    api.env.addToExample(projectId).then(
      (added) => {
        setBusy(false);
        onDone(added.length);
      },
      (err: unknown) => {
        setBusy(false);
        onError(err instanceof Error ? err.message : String(err));
      },
    );
  };
  return (
    <div className={e.exampleNote}>
      <Icon name="file" size={12} className={e.sourceIcon} />
      <span className={e.sourceText}>
        {example.file ? (
          <>
            <code>{file}</code> doesn’t list {names}
          </>
        ) : (
          <>No .env.example yet, so a new teammate doesn’t know what to set</>
        )}
      </span>
      <Tip label={`Adds each name with a placeholder that says what goes there (sk_live_…, a URL’s host), never the value. In the main folder: commit it.`}>
        <Button size="small" variant="quiet" disabled={busy} onClick={go}>
          {example.file ? `Add to ${file}` : 'Create .env.example'}
        </Button>
      </Tip>
    </div>
  );
}
