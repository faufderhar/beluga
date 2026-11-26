import { useLayoutEffect, useRef, useState } from 'react';
import type { Issue } from '@beluga/core/board/model.js';
import { Checkbox } from '../components/Alert.js';
import { Icon, type IconName } from '../components/Icon.js';
import { Segmented, Tip, cx } from '../components/ui.js';
import { usePrefs } from '../lib/prefs.js';
import { chordLabel } from '../lib/shortcuts-model.js';
import { useIssueActions } from './use-issues.js';
import h from '../views/project-home.module.css';
import d from '../chat/draft.module.css';
import s from './issues.module.css';

/**
 * Handing an issue to Claude, the way a project's home starts work: pick what Claude does
 * (Investigate, Fix It, Make a Task), say anything it should know if you like, and go. One box,
 * one button, and a line that says what happens; Make a Task can look at the code first.
 */

type Way = 'investigate' | 'fix' | 'task';

interface WayInfo {
  readonly label: string;
  readonly icon: IconName;
  readonly hint: string;
  readonly placeholder: string;
  /** What happens, in the box's bar. */
  readonly what: (n: number) => string;
  readonly whatIcon: IconName;
  readonly go: string;
}

const WAYS: Readonly<Record<Way, WayInfo>> = {
  investigate: {
    label: 'Investigate',
    icon: 'search',
    hint: 'The agent finds out why it happens and reproduces it; nothing is fixed yet',
    placeholder: 'Anything to look at first? “It only fails behind the proxy”',
    what: () => 'In a new worktree: why it happens, and a reproduction. Nothing is fixed yet.',
    whatIcon: 'branch',
    go: 'Investigate',
  },
  fix: {
    label: 'Fix It',
    icon: 'wrench',
    hint: 'The agent fixes it and opens a pull request that closes the issue',
    placeholder: 'Anything the fix should do or avoid? “Keep the public API as it is”',
    what: (n) => `In a new worktree, with a pull request that closes #${n}.`,
    whatIcon: 'pr',
    go: 'Fix It',
  },
  task: {
    label: 'Make a Task',
    icon: 'task',
    hint: 'On the board, written up by the agent, for later',
    placeholder: 'Anything to add to the task?',
    what: () => 'On the board as Ready, written up by the agent.',
    whatIcon: 'task',
    go: 'Make Task',
  },
};

export function IssueComposer({ projectId, number, task }: { projectId: string; number: number; task?: Issue }) {
  const a = useIssueActions();
  const prefs = usePrefs();
  const ways: readonly Way[] = task ? ['investigate', 'fix'] : ['investigate', 'fix', 'task'];
  const [way, setWay] = useState<Way>('investigate');
  const [note, setNote] = useState('');
  const [look, setLook] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const shown = ways.includes(way) ? way : 'investigate';
  const info = WAYS[shown];
  // Claude still writing the task (Make a Task): working on it waits for its words, so not yet.
  const writing = Boolean(task?.drafting);
  const ready = !busy && !writing;
  const sendKeys = prefs.sendWith === 'enter' ? '↩' : chordLabel('Cmd+Enter');

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 44), 8 * 20 + 20)}px`;
  }, [note]);

  const go = async (): Promise<void> => {
    if (!ready) return;
    setBusy(true);
    const done = shown === 'investigate' ? await a.investigate(projectId, number, note) : shown === 'fix' ? await a.fix(projectId, number, note) : await a.toTask(projectId, number, look, note);
    setBusy(false);
    if (done) setNote('');
  };

  return (
    <section className={cx(h.composer, s.composer)} aria-label={`Hand #${number} to your agent`}>
      <div className={h.composerHead}>
        <h2 className={cx(h.prompt, s.composerPrompt)}>{task ? `${task.key} is on the board. What should your agent do?` : 'What should your agent do?'}</h2>
        <Segmented<Way> size="small"
          label="What the agent does"
          value={shown}
          onChange={(w) => {
            setWay(w);
            box.current?.focus();
          }}
          options={ways.map((w) => ({ value: w, label: WAYS[w].label, icon: WAYS[w].icon, hint: WAYS[w].hint }))}
        />
      </div>
      <div className={cx(h.box, busy && h.busy)}>
        <textarea
          ref={box}
          className={cx(h.input, s.composerInput, 'selectable')}
          aria-label="Anything the agent should know (optional)"
          placeholder={info.placeholder}
          value={note}
          rows={2}
          spellCheck
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.key !== 'Enter') return;
            const modKey = e.metaKey || e.ctrlKey;
            if (prefs.sendWith === 'enter' ? e.shiftKey || modKey : !modKey) return;
            e.preventDefault();
            void go();
          }}
        />
        <div className={h.bar}>
          <span className={h.note}>
            <Icon name={writing ? 'pencil' : info.whatIcon} size={12} />
            {writing ? `The agent is still writing ${task!.key} up; then it can start.` : info.what(number)}
          </span>
          <span className={h.flex} />
          {shown === 'task' ? (
            <span className={s.composerCheck}>
              <Checkbox checked={look} onChange={setLook} label="Look at the code first" />
            </span>
          ) : null}
          <Tip label={shown === 'task' && look ? 'The agent reads the code first (read-only), then writes the task with where it is and the likely cause' : info.hint} keys={sendKeys}>
            <button type="button" className={cx(d.create, ready && d.createReady)} aria-disabled={!ready} onClick={() => void go()} data-testid="issue-go">
              <Icon name={info.icon} size={12} />
              {busy ? 'Starting…' : info.go}
              <span className={d.createKey}>{sendKeys}</span>
            </button>
          </Tip>
        </div>
      </div>
    </section>
  );
}
