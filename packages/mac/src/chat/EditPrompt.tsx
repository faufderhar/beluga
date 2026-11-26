import { useLayoutEffect, useRef, useState } from 'react';
import { Button, Segmented, Tip, cx } from '../components/ui.js';
import { toast, useBeluga } from '../lib/beluga.js';
import { usePrefs } from '../lib/prefs.js';
import { chordLabel } from '../lib/shortcuts-model.js';
import s from './edit-prompt.module.css';

type Mode = 'here' | 'fork';

/** The choice you made last time, so a second edit starts there. */
let lastMode: Mode = 'here';

/**
 * A message you sent, open to edit in place (BLG-385). Sending asks where the edit goes: Rewind
 * Here (this conversation goes back to just before the message: what came after leaves the chat,
 * Claude forgets it, a worktree's files are as they were then) or New Fork (a new worktree or chat
 * from that point; this one stays as it is). One box, the choice in its bar, one ↩.
 */
export function EditPrompt({ wsId, lineId, text, worktree, onClose }: { wsId: string; lineId: string; text: string; worktree: boolean; onClose: () => void }) {
  const { client } = useBeluga();
  const prefs = usePrefs();
  const [draft, setDraft] = useState(text);
  const [mode, setMode] = useState<Mode>(lastMode);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  // Grows with what's written, the cursor at the end to start with.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);
  useLayoutEffect(() => {
    const el = box.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const send = async (): Promise<void> => {
    if (busy || !draft.trim()) return;
    lastMode = mode;
    setBusy(true);
    try {
      const went = await client.api.workspaces.editPrompt(wsId, lineId, draft, mode);
      if (went) onClose();
    } catch (err) {
      toast(client, err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      return onClose();
    }
    if (e.key !== 'Enter') return;
    const modKey = e.metaKey || e.ctrlKey;
    if (!(prefs.sendWith === 'enter' ? !e.shiftKey && !modKey : modKey)) return;
    e.preventDefault();
    void send();
  };
  const note =
    mode === 'here'
      ? worktree
        ? 'What came after this goes, and the files go back to how they were then.'
        : 'What came after this goes, and your agent forgets it.'
      : worktree
        ? 'Goes on in a new worktree from this point. This one stays as it is.'
        : 'Goes on in a new chat from this point. This one stays as it is.';
  const keys = prefs.sendWith === 'enter' ? '↩' : chordLabel('Cmd+Enter');
  return (
    <div className={cx(s.edit, busy && s.busy)} data-edit-prompt="">
      <textarea
        ref={box}
        className={cx(s.input, 'selectable')}
        aria-label="Edit your message"
        value={draft}
        rows={1}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        disabled={busy}
        spellCheck
      />
      <div className={s.bar}>
        <Segmented<Mode> size="small"
          label="Where the edit goes"
          value={mode}
          onChange={(m) => {
            setMode(m);
            box.current?.focus();
          }}
          options={[
            { value: 'here', label: 'Rewind Here', icon: 'back', hint: worktree ? 'This conversation goes back to this message, and its files too' : 'This conversation goes back to this message' },
            { value: 'fork', label: 'New Fork', icon: 'branch', hint: worktree ? 'A new worktree from this point, files as they were then' : 'A new chat from this point' },
          ]}
        />
        <span className={s.note}>{note}</span>
        <span className={s.actions}>
          <Tip label="Keep the message as it was" keys="esc">
            <Button size="small" variant="quiet" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
          </Tip>
          <Tip label={mode === 'here' ? 'Rewind and send' : 'Fork and send'} keys={keys}>
            <Button size="small" variant="primary" icon="send" onClick={() => void send()} disabled={busy || !draft.trim()}>
              {mode === 'here' ? 'Rewind' : 'Fork'}
            </Button>
          </Tip>
        </span>
      </div>
    </div>
  );
}
