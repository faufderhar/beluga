import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CcTaskOutput } from '@beluga/core/claude-code/model.js';
import { formatBytes } from '@beluga/shared/format.js';
import { Icon } from '../components/Icon.js';
import { Dot, Empty, IconButton, cx } from '../components/ui.js';
import { copyText } from '../lib/copy.js';
import { openWithDefaultApp, revealInFinder } from '../lib/files.js';
import { useApi, useBeluga } from '../lib/beluga.js';
import { type TaskItem, taskLabel } from './background-model.js';
import s from './background.module.css';
import { everyWhileShown } from '../lib/window-active.js';
import { oneAtATime } from '../lib/one-at-a-time.js';
import { revealLabel } from '../lib/os-words.js';
import { useRevealFileLabel } from '../lib/remote-open.js';

/**
 * Background commands and watches Claude or its agents started (a dev server, the full tests, a
 * build): each with who started it and how it's doing, and the one you pick followed live, its
 * output scrolling as it comes (it stays put once you scroll up).
 */

const POLL_MS = 1000;

/** Re-render every few seconds, so "Running · 3m" stays true. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  // Resting only while the page can't be seen; on time again the moment it can.
  useEffect(() => everyWhileShown(() => setNow(Date.now()), 5000), []);
  return now;
}

/** The end of a task's output, looked at again every second while it runs (and the window is in front). */
function useTaskOutput(item: TaskItem): CcTaskOutput | null | undefined {
  const api = useApi();
  const [out, setOut] = useState<CcTaskOutput | null>();
  const running = item.task.status === 'running';
  // A different task: start over (the same one ending keeps what's on screen).
  useEffect(() => setOut(undefined), [item.sessionId, item.task.agentId, item.task.id]);
  useEffect(() => {
    let alive = true;
    let sig = '';
    const look = oneAtATime(() => {
      if (document.visibilityState !== 'visible') return;
      return api.claudeCode.taskOutput(item.sessionId, item.task.agentId, item.task.id).then(
        (res) => {
          if (!alive) return;
          const key = res ? `${res.file}:${res.size}:${res.mtime}` : 'none';
          if (key === sig) return;
          sig = key;
          setOut(res ?? null);
        },
        () => alive && sig === '' && setOut(null),
      );
    });
    look();
    // While it runs: every second while the page can be seen, and at once when it can again.
    const stop = running ? everyWhileShown(look, POLL_MS) : undefined;
    // Picked while the window was behind another: look once it's in front.
    if (!running) document.addEventListener('visibilitychange', look);
    return () => {
      alive = false;
      stop?.();
      document.removeEventListener('visibilitychange', look);
    };
  }, [item.sessionId, item.task.agentId, item.task.id, running]);
  return out;
}

function Mark({ item }: { item: TaskItem }) {
  const t = item.task;
  if (t.status === 'running') return <Dot tone="claude" live />;
  return <Icon name={t.status === 'failed' ? 'x' : t.status === 'finished' ? 'check' : t.status === 'stopped' ? 'stop' : 'clock'} size={11} className={cx(s.mark, t.status === 'failed' && s.markFailed, t.status === 'finished' && s.markDone)} />;
}

function Output({ item, now }: { item: TaskItem; now: number }) {
  const { client } = useBeluga();
  // On a computer's page the log is downloaded instead (BLG-852).
  const revealLog = useRevealFileLabel('Log');
  const out = useTaskOutput(item);
  const body = useRef<HTMLPreElement>(null);
  const atEnd = useRef(true);
  const t = item.task;
  const { label, tone } = taskLabel(t, now);
  // Following the end while you're there; once you scroll up, it stays where you are.
  useLayoutEffect(() => {
    const el = body.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [out?.text]);
  return (
    <section className={s.output} aria-label={`Output of ${t.description}`}>
      <div className={s.outputHead}>
        <span className={s.outputTitle} title={t.description}>
          {t.description}
        </span>
        <span className={cx(s.state, s[`tone_${tone}`])}>{label}</span>
        <span className={s.flex} />
        <IconButton size="small" icon="copy" label="Copy Command" onClick={() => void copyText(t.command)} />
        {out?.file ? <IconButton size="small" icon="external" label="Open Log With Its App" onClick={() => void openWithDefaultApp(client, out.file)} /> : null}
        {out?.file ? <IconButton size="small" icon="folder" label={revealLog} onClick={() => void revealInFinder(client, out.file)} /> : null}
      </div>
      <div className={cx(s.command, 'selectable')} title={t.command}>
        <span className={s.prompt}>$</span> {t.command}
      </div>
      {t.summary && t.status !== 'running' ? <div className={s.summary}>{t.summary}</div> : null}
      {out === undefined ? (
        <div className={s.dimPad}>Reading its output…</div>
      ) : out === null || !out.text.trim() ? (
        <div className={s.dimPad}>{t.status === 'running' ? 'Nothing written yet. It shows here as it comes.' : 'It wrote nothing.'}</div>
      ) : (
        <pre
          ref={body}
          className={cx(s.text, 'selectable')}
          tabIndex={0}
          aria-live={t.status === 'running' ? 'polite' : undefined}
          onScroll={(e) => {
            const el = e.currentTarget;
            atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {out.truncated ? <span className={s.cut}>… only the last {formatBytes(64 * 1024)} of {formatBytes(out.size)} shown{'\n'}</span> : null}
          {out.text}
        </pre>
      )}
    </section>
  );
}

/** The list and the one you follow: side by side (`split`, a page) or one above the other (`stack`, the panel). */
export function BackgroundTasks({ items, layout, empty }: { items: readonly TaskItem[]; layout: 'split' | 'stack'; empty: string }) {
  const now = useNow();
  const [picked, setPicked] = useState<string>();
  const key = (it: TaskItem): string => `${it.sessionId}/${it.task.id}`;
  const item = items.find((it) => key(it) === picked) ?? items[0];
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = item ? items.indexOf(item) : -1;
    const next = items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) setPicked(key(next));
  };
  if (!items.length) {
    return (
      <div className={s.empty}>
        <Empty icon="play" title="No background commands" detail={empty} />
      </div>
    );
  }
  const running = items.filter((it) => it.task.status === 'running').length;
  return (
    <div className={cx(s.root, layout === 'split' ? s.split : s.stack)}>
      <div className={s.side}>
        <div className={s.head}>
          <span className={s.headTitle}>{running ? `${running} running` : 'None running'}</span>
          {items.length > running ? <span className={s.dim}>{running ? `of ${items.length}` : `${items.length} ended lately`}</span> : null}
        </div>
        <div className={s.list} role="listbox" aria-label="Background commands" tabIndex={0} onKeyDown={onKey}>
          {items.map((it) => {
            const on = item === it;
            const { label } = taskLabel(it.task, now);
            return (
              <div key={key(it)} role="option" aria-selected={on} className={cx(s.row, on && s.rowOn)} title={it.task.command} onClick={() => setPicked(key(it))}>
                <span className={s.markBox}>
                  <Mark item={it} />
                </span>
                <span className={s.rowText}>
                  <span className={s.rowName}>{it.task.description}</span>
                  <span className={s.rowWho}>
                    {it.who} · {label}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {item ? <Output key={key(item)} item={item} now={now} /> : null}
    </div>
  );
}
