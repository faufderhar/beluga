import { useEffect, useState } from 'react';
import type { ViewerState } from '@beluga/core/store.js';
import type { FormatterInfo } from '@beluga/core/workspace-files.js';
import { Alert } from '../../components/Alert.js';
import { Button, IconButton, Tip, cx } from '../../components/ui.js';
import { useBeluga } from '../../lib/beluga.js';
import { chordLabel } from '../../lib/shortcuts-model.js';
import { type EditSession, editSession, isDirty, markSaved, setDraft, startEditing, stopEditing, textToSave, updateSession, useEditSession } from './edit-store.js';
import { hasText } from './reader-model.js';
import r from './reader.module.css';

/**
 * Edit, Format and Save for a file you're reading: in the header of the panel's preview and of the
 * file across the center. Files open read-only; Edit (always in sight, never a setting) makes this
 * one editable until Done. ⌘S saves; leaving with changes not saved asks first.
 */

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/^Error:\s*/, '');

/** Whether the project's Prettier formats this file (asked once per file while the window is open). */
const formatters = new Map<string, Promise<FormatterInfo>>();

function useFormatter(wsId: string, path: string, enabled: boolean): FormatterInfo | undefined {
  const { client } = useBeluga();
  const [info, setInfo] = useState<{ key: string; info: FormatterInfo }>();
  const key = `${wsId}\0${path}`;
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let p = formatters.get(key);
    if (!p) {
      p = client.api.files.formatter(wsId, path).catch((err: unknown): FormatterInfo => ({ available: false, reason: errorText(err) }));
      formatters.set(key, p);
    }
    void p.then((i) => alive && setInfo({ key, info: i }));
    return () => {
      alive = false;
    };
  }, [key, enabled]);
  return info?.key === key ? info.info : undefined;
}

/** A file of yours that can be edited here: text, read whole. */
export const canEdit = (viewer: ViewerState, selfId: string | undefined): boolean => viewer.owner === selfId && !viewer.loading && !viewer.truncated && hasText(viewer);

export function EditTools({ viewer, wsId, selfId, compact = false }: { viewer: ViewerState; wsId: string; selfId: string | undefined; compact?: boolean }) {
  const { client } = useBeluga();
  const session = useEditSession(viewer);
  const editable = canEdit(viewer, selfId);
  const formatter = useFormatter(wsId, viewer.path, editable || Boolean(session));
  const [asking, setAsking] = useState<'discard' | 'conflict'>();
  const dirty = isDirty(session);
  const toast = (text: string, level: 'error' | 'info' | 'success' = 'error'): void => client.store.dispatch({ type: 'toast', text, level });

  const save = async (force = false): Promise<void> => {
    const now = editSession(viewer);
    if (!now || now.busy) return;
    updateSession(now.key, { busy: 'saving' });
    try {
      const text = textToSave(now);
      const res = await client.api.files.save(wsId, now.path, text, { expect: await now.baseHash, ...(force ? { force: true } : {}) });
      if (res.ok) markSaved(now.key, text, res.hash);
      else {
        updateSession(now.key, { busy: undefined, conflict: true });
        setAsking('conflict');
      }
    } catch (err) {
      updateSession(now.key, { busy: undefined, error: errorText(err) });
      toast(`Couldn’t save ${now.path}: ${errorText(err)}`);
    }
  };

  const format = async (): Promise<void> => {
    if (!formatter?.available) return;
    const now = editSession(viewer) ?? startEditing(viewer, wsId, viewer.content);
    if (now.busy) return;
    updateSession(now.key, { busy: 'formatting' });
    try {
      const out = await client.api.files.format(wsId, now.path, now.draft);
      const latest = editSession(viewer);
      if (!latest) return;
      updateSession(latest.key, { busy: undefined });
      // You kept typing while it ran: keep what you typed.
      if (latest.draft !== now.draft) return toast('The file changed while Prettier ran; format it again', 'info');
      if (out.replace(/\r\n/g, '\n') === now.draft) return toast('Already formatted', 'info');
      setDraft(latest.key, out);
    } catch (err) {
      updateSession(now.key, { busy: undefined });
      toast(errorText(err));
    }
  };

  const done = (): void => {
    if (!session) return;
    if (isDirty(session)) setAsking('discard');
    else stopEditing(session.key);
  };

  // ⌘S saves the file you're editing, wherever the keyboard is in the window.
  useEffect(() => {
    if (!session) return;
    const onKey = (e: KeyboardEvent): void => {
      // ⌘S only (⌃⌘S is the app's own shortcut).
      if (e.metaKey === e.ctrlKey || e.shiftKey || e.altKey || e.key.toLowerCase() !== 's') return;
      e.preventDefault();
      void save();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session?.key]);

  if (!session && !editable) return null;

  const formatLabel = !formatter ? 'Format with Prettier' : formatter.available ? `Format with Prettier${formatter.version ? ` ${formatter.version}` : ''}` : (formatter.reason ?? 'Prettier isn’t available');
  const formatBtn = <IconButton size="small" icon="wand" label={formatLabel} aria-disabled={!formatter?.available || Boolean(session?.busy)} className={cx(!formatter?.available && r.toolOff)} onClick={() => void format()} />;

  return (
    <>
      {session ? (
        <span className={r.editState} role="status">
          {session.busy === 'saving' ? (
            'Saving…'
          ) : session.busy === 'formatting' ? (
            'Formatting…'
          ) : dirty ? (
            <>
              <span className={r.dirtyDot} aria-hidden="true" title="Not saved" />
              {compact ? <span className="visually-hidden">Edited</span> : 'Not saved'}
            </>
          ) : (
            'Editing'
          )}
        </span>
      ) : null}
      {/* The panel is narrow: there, Format comes with Edit. */}
      {session || !compact ? formatBtn : null}
      {session ? (
        <>
          <Tip label="Save" keys={chordLabel('Cmd+S')}>
            <Button size="small" variant={dirty ? 'primary' : 'quiet'} disabled={!dirty || Boolean(session.busy)} onClick={() => void save()}>
              Save
            </Button>
          </Tip>
          <Tip label="Stop editing (back to read-only)">
            <Button size="small" variant="quiet" onClick={done}>
              Done
            </Button>
          </Tip>
        </>
      ) : (
        <Tip label="Edit this file (it opens read-only)">
          <Button size="small" variant="quiet" icon="pencil" className={r.editButton} onClick={() => startEditing(viewer, wsId, viewer.content)}>
            Edit
          </Button>
        </Tip>
      )}
      {asking === 'discard' && session ? (
        <Alert
          title={`Discard your changes to ${viewer.path.split('/').pop()}?`}
          message="What you typed and didn’t save will be lost."
          tone="danger"
          confirm={{ label: 'Discard', destructive: true, onClick: () => (setAsking(undefined), stopEditing(session.key)) }}
          alternative={{ label: 'Save', onClick: () => (setAsking(undefined), void save().then(() => !isDirty(editSession(viewer)) && stopEditing(session.key))) }}
          onCancel={() => setAsking(undefined)}
        />
      ) : null}
      {asking === 'conflict' && session ? <ConflictAlert session={session} onCancel={() => setAsking(undefined)} onOverwrite={() => (setAsking(undefined), void save(true))} /> : null}
    </>
  );
}

function ConflictAlert({ session, onCancel, onOverwrite }: { session: EditSession; onCancel: () => void; onOverwrite: () => void }) {
  return (
    <Alert
      title={`${session.path.split('/').pop()} changed since you started editing`}
      message="Someone (or an agent) saved it in the meantime. Saving yours replaces their changes."
      tone="caution"
      confirm={{ label: 'Save Anyway', destructive: true, onClick: onOverwrite }}
      onCancel={onCancel}
    />
  );
}
