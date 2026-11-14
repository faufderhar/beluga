import { Fragment, type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import type { Suggestion, SuggestionKind } from '@beluga/ui/suggest.js';
import { type IssueStatus, STATUS_INFO } from '@beluga/core/board/model.js';
import { Icon, type IconName } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import { StatusIcon } from '../tasks/marks.js';
import s from './composer.module.css';

/** Suggestions listed under / and @ at most (Beluga's commands and every one of Claude's skills). */
export const MAX_LISTED = 300;

/** Each kind's icon in the list. */
const KIND_ICON: Record<SuggestionKind, IconName> = {
  command: 'command',
  skill: 'wand',
  claude: 'claude',
  person: 'person',
  project: 'grid',
  workspace: 'branch',
  folder: 'folder',
  file: 'file',
  task: 'task',
  chat: 'chat',
  option: 'check',
};

/** A section's heading above its first row: Claude's skills, tasks, chats, other projects' tasks. */
export function sectionOf(sug: Suggestion, prev: Suggestion | undefined): string | undefined {
  if (sug.task?.elsewhere && !prev?.task?.elsewhere) return 'In other projects, not this one';
  if (sug.task && !sug.task.elsewhere && !prev?.task) return 'Tasks';
  if (sug.kind === 'chat' && prev?.kind !== 'chat') return 'Chats';
  if (sug.kind === 'skill' && prev?.kind !== 'skill') return 'Your agent’s skills and commands';
  return undefined;
}

/** A row's insides: its kind's icon, what it is, and a word about it. `asking`: picked once, it says it's another project's. */
export function SuggestionBody({ sug, asking = false }: { sug: Suggestion; asking?: boolean }) {
  if (sug.task) return <TaskOption task={sug.task} asking={asking} />;
  return (
    <>
      {sug.kind || sug.mark ? (
        <span className={s.sugIcon} aria-hidden="true">
          {/* An agent's tag shows its own mark (BLG-520): Claude Code's, Codex's, a local model's. */}
          <Icon name={sug.mark ?? KIND_ICON[sug.kind!]} size={12} />
        </span>
      ) : null}
      <span className={s.sugLabel}>{sug.label}</span>
      <span className={s.sugHint}>{sug.hint}</span>
    </>
  );
}

/**
 * The list above a message box as you type / or @ (the worktree chat's and a channel's): the
 * arrows move the highlight, Tab or Return picks, Escape hides it until the words change.
 * `reset` after the words change; `onKeyDown` says whether it took the key.
 */
export function useSuggestions<T extends Suggestion>(items: readonly T[], text: string, accept: (sug: T) => void): { shown: readonly T[]; reset: () => void; onKeyDown: (e: KeyboardEvent) => boolean; list: ReactNode } {
  const [selected, setSelected] = useState(0);
  const [hidden, setHidden] = useState(false);
  const shown = hidden ? [] : items;
  /** Only the first MAX_LISTED are listed, so the arrows move within those. */
  const listed = Math.min(shown.length, MAX_LISTED);
  const pick = Math.min(selected, Math.max(0, listed - 1));
  const ref = useRef<HTMLDivElement>(null);
  /** The arrow keys moved the highlight (the pointer hovering an item doesn't scroll the list). */
  const byKeys = useRef(false);
  // The highlighted item stays in view as the arrows move it through a long list.
  useLayoutEffect(() => {
    if (!byKeys.current) return;
    ref.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [pick, listed]);
  /** Another project's task picked once: it says so, and goes in only when picked again. */
  const [asking, setAsking] = useState<string | undefined>(undefined);
  const reset = (): void => {
    setHidden(false);
    setSelected(0);
    setAsking(undefined);
  };
  const take = (sug: T, i: number): void => {
    if (sug.task?.elsewhere && asking !== sug.value) {
      setAsking(sug.value);
      setSelected(i);
      return;
    }
    setAsking(undefined);
    accept(sug);
  };
  const onKeyDown = (e: KeyboardEvent): boolean => {
    if (!listed) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      byKeys.current = true;
      setSelected((n) => (Math.min(n, listed - 1) + (e.key === 'ArrowDown' ? 1 : -1) + listed) % listed);
    } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && shown[pick]?.value !== text)) take(shown[pick]!, pick);
    else if (e.key === 'Escape' && asking) setAsking(undefined);
    else if (e.key === 'Escape') setHidden(true);
    else return false;
    e.preventDefault();
    return true;
  };
  const list = listed ? (
    <div ref={ref} className={s.suggestions} role="listbox" aria-label="Suggestions">
      {shown.slice(0, MAX_LISTED).map((sug, i, all) => (
        <Fragment key={`${sug.value}:${sug.label}:${i}`}>
          {/* Tasks ("@BLG-24") and Claude's skills come as their own sections, under a heading. */}
          {sectionOf(sug, all[i - 1]) ? (
            <div className={cx(s.sugSection, sug.task?.elsewhere && s.sugSectionElsewhere)} role="presentation">
              {sug.task?.elsewhere ? <Icon name="alert" size={11} /> : null}
              {sectionOf(sug, all[i - 1])}
            </div>
          ) : null}
          <div
            role="option"
            aria-selected={i === pick}
            className={cx(s.suggestion, (sug.task || sug.kind) && s.sugTask, sug.task?.elsewhere && s.sugElsewhere, i === pick && s.suggestionOn)}
            onMouseEnter={() => {
              byKeys.current = false;
              setSelected(i);
            }}
            onMouseDown={(e) => (e.preventDefault(), take(sug, i))}
          >
            <SuggestionBody sug={sug} asking={asking === sug.value} />
          </div>
        </Fragment>
      ))}
    </div>
  ) : null;
  return { shown, reset, onKeyDown, list };
}

/**
 * A task in the list: its status ring, key and title, and its status in words at the end. Another
 * project's names that project instead, and once picked (`asking`) says it isn't this one's.
 */
function TaskOption({ task, asking }: { task: NonNullable<Suggestion['task']>; asking: boolean }) {
  const status = STATUS_INFO[task.status as IssueStatus];
  return (
    <>
      {status ? <StatusIcon status={task.status as IssueStatus} size={12} /> : null}
      <span className={s.sugKey}>{task.key}</span>
      {asking ? (
        <span className={s.sugTitle}>
          From {task.elsewhere}, not this project. Pick it again to mention it anyway.
        </span>
      ) : (
        <span className={s.sugTitle}>{task.title}</span>
      )}
      {task.elsewhere ? <span className={s.sugProject}>{task.elsewhere}</span> : status ? <span className={s.sugStatus}>{status.label}</span> : null}
    </>
  );
}
