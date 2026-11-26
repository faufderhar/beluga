import * as Popover from '@radix-ui/react-popover';
import { useEffect, useRef, useState } from 'react';
import { parseCriterion } from '@beluga/core/board/criteria.js';
import { BRIEF_SECTIONS, type BriefSection, type Issue, SECTION_INFO, actorName } from '@beluga/core/board/model.js';
import { Markdown } from '../chat/Markdown.js';
import { Icon } from '../components/Icon.js';
import { Button, Dot, IconButton, Tip, cx } from '../components/ui.js';
import { useMyAgentName } from '../lib/agent-words.js';
import { ago, checklist, toggleCheck } from './tasks-model.js';
import { useSelfId, useTaskActions } from './use-tasks.js';
import t from './tasks.module.css';

/**
 * A task's brief: what later agents and people rely on, in sections. Click a section to edit it
 * (⌘↩ saves, Esc cancels); acceptance criteria tick on click; every section keeps its versions
 * (who changed it, when, why) and an old one can be put back. Empty sections wait as one-click
 * "Add" chips, so the page stays short.
 */
export function Brief({ issue }: { issue: Issue }) {
  const [adding, setAdding] = useState<BriefSection>();
  // Fresh from its agent: the brief fades in where the skeleton was (once, not on every visit).
  const [arrived, setArrived] = useState(false);
  const wasDrafting = useRef(issue.drafting);
  useEffect(() => {
    if (wasDrafting.current && !issue.drafting) setArrived(true);
    wasDrafting.current = issue.drafting;
  }, [issue.drafting]);
  const filled = BRIEF_SECTIONS.filter((s) => issue.brief[s] || s === 'goal' || s === adding);
  const missing = BRIEF_SECTIONS.filter((s) => !filled.includes(s));
  if (issue.drafting) return <BriefWriting />;
  return (
    <div className={cx(t.brief, arrived && t.briefArrived)}>
      {filled.map((s) => (
        <Section key={s} issue={issue} section={s} startEditing={s === adding} onDone={() => setAdding(undefined)} />
      ))}
      {missing.length ? (
        <div className={t.addSections}>
          {missing.map((s) => (
            <Tip key={s} label={SECTION_INFO[s].hint}>
              <button type="button" className={t.addSection} onClick={() => setAdding(s)}>
                <Icon name="plus" size={11} />
                {SECTION_INFO[s].label}
              </button>
            </Tip>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** How long each ghost line is, as a share of the section: uneven, like written lines. */
const GHOST_GOAL = [94, 81, 58] as const;
const GHOST_CRITERIA = [72, 86, 64] as const;

/**
 * While its agent writes the task (BLG-598): the goal and criteria drawn in outline, a light
 * passing over them, and a line saying who is writing. Nothing to edit until it's done.
 */
function BriefWriting() {
  const who = useMyAgentName();
  return (
    <div className={cx(t.brief, t.briefWriting)} aria-busy="true">
      <div className={t.writingStatus} role="status">
        <Dot tone="claude" live />
        {who} is writing this task…
      </div>
      <section className={t.section} aria-hidden="true">
        <header className={t.sectionHead}>
          <h3 className={t.sectionTitle}>{SECTION_INFO.goal.label}</h3>
        </header>
        <div className={t.ghostLines}>
          {GHOST_GOAL.map((w, i) => (
            <span key={i} className={t.ghostLine} style={{ width: `${w}%`, ['--i' as string]: i }} />
          ))}
        </div>
      </section>
      <section className={t.section} aria-hidden="true">
        <header className={t.sectionHead}>
          <h3 className={t.sectionTitle}>{SECTION_INFO.acceptance.label}</h3>
        </header>
        <div className={t.ghostLines}>
          {GHOST_CRITERIA.map((w, i) => (
            <span key={i} className={t.ghostCheck} style={{ ['--i' as string]: i + GHOST_GOAL.length }}>
              <span className={t.ghostBox} />
              <span className={t.ghostLine} style={{ width: `${w}%` }} />
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}

function Section({ issue, section, startEditing, onDone }: { issue: Issue; section: BriefSection; startEditing: boolean; onDone: () => void }) {
  const text = issue.brief[section] ?? '';
  const [draft, setDraft] = useState<string | undefined>(startEditing ? '' : undefined);
  const { api, act } = useTaskActions();
  const area = useRef<HTMLTextAreaElement>(null);
  const editing = draft !== undefined;
  const revisions = issue.revisions.filter((r) => r.section === section);
  const info = SECTION_INFO[section];
  const ticks = section === 'acceptance' ? checklist(text) : undefined;

  useEffect(() => {
    if (!editing || !area.current) return;
    area.current.focus();
    area.current.setSelectionRange(area.current.value.length, area.current.value.length);
  }, [editing]);
  // Grows with what's written.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(520, el.scrollHeight + 2)}px`;
  }, [draft]);

  const save = async (): Promise<void> => {
    if (draft === undefined) return;
    // If it didn't save (the reason is in a toast), what you wrote stays open.
    if (draft.trim() !== text.trim() && !(await act(() => api.editBrief(issue.id, section, draft)))) return;
    setDraft(undefined);
    onDone();
  };
  const cancel = (): void => {
    setDraft(undefined);
    onDone();
  };

  return (
    <section className={cx(t.section, editing && t.sectionEditing)} aria-label={info.label}>
      <header className={t.sectionHead}>
        <h3 className={t.sectionTitle}>{info.label}</h3>
        {ticks?.total ? (
          <span className={cx(t.sectionCount, ticks.done === ticks.total && t.sectionCountDone)}>
            {ticks.done} of {ticks.total}
            {ticks.deferred ? ` · ${ticks.deferred} deferred` : ''}
            {ticks.notDone ? ` · ${ticks.notDone} not done` : ''}
          </span>
        ) : null}
        <span className={t.grow} />
        {revisions.length ? <History issue={issue} section={section} /> : null}
        {editing ? null : <IconButton size="small" icon="pencil" label={`Edit ${info.label}`} onClick={() => setDraft(text)} />}
      </header>
      {editing ? (
        <div className={t.editor}>
          <textarea
            ref={area}
            className={t.editorArea}
            value={draft}
            maxLength={20_000}
            placeholder={info.hint}
            aria-label={info.label}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void save();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                cancel();
              }
            }}
          />
          <div className={t.editorBar}>
            <span className={t.editorHint}>Markdown{section === 'acceptance' ? ' · “- [ ]” makes a checkbox · “— deferred: why” after one explains it' : ''}</span>
            <span className={t.grow} />
            <Button size="small" variant="quiet" onClick={cancel}>
              Cancel
            </Button>
            <Button size="small" variant="primary" onClick={() => void save()}>
              Save
            </Button>
          </div>
        </div>
      ) : text ? (
        section === 'acceptance' ? (
          <Checklist text={text} onToggle={(i) => void act(() => api.editBrief(issue.id, section, toggleCheck(text, i), 'ticked a criterion'))} onEdit={() => setDraft(text)} />
        ) : (
          <div className={t.sectionBody} onDoubleClick={() => setDraft(text)}>
            <Markdown text={text} paths tasks />
          </div>
        )
      ) : (
        <button type="button" className={t.sectionEmpty} onClick={() => setDraft('')}>
          {info.hint}…
        </button>
      )}
    </section>
  );
}

/**
 * Acceptance criteria: each "- [ ]" line a checkbox you click; one not ticked yet but explained
 * ("— deferred: why", "— not done: why") shows its own state and the reason; other lines as they are.
 */
function Checklist({ text, onToggle, onEdit }: { text: string; onToggle: (index: number) => void; onEdit: () => void }) {
  let n = -1;
  return (
    <ul className={t.checklist} onDoubleClick={onEdit}>
      {text.split('\n').map((line, i) => {
        const c = parseCriterion(line);
        if (!c) return line.trim() ? <li key={i} className={t.checkNote}>{line.replace(/^\s*[-*]\s+/, '')}</li> : null;
        n++;
        const index = n;
        const done = c.state === 'done';
        const deferred = c.state === 'deferred';
        const notDone = c.state === 'not_done';
        return (
          <li key={i} className={cx(t.check, done && t.checkDone, deferred && t.checkDeferred, notDone && t.checkNotDone)} data-state={c.state}>
            <button type="button" role="checkbox" aria-checked={done} aria-label={deferred ? 'Deferred: tick it when it’s true' : notDone ? 'Not done: tick it when it’s true' : undefined} className={t.checkBox} onClick={() => onToggle(index)}>
              {done ? <Icon name="check" size={10} /> : deferred ? <Icon name="clock" size={10} /> : notDone ? <Icon name="minus" size={10} /> : null}
            </button>
            <span className={t.checkText}>
              <Markdown text={c.text} tasks />
              {c.reason ? (
                <span className={t.checkReason}>
                  <span className={t.checkReasonLabel}>{deferred ? 'Deferred' : 'Not done'}</span> · {c.reason}
                </span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** A section's versions, newest first: who, when, why, what it said; Restore puts one back. */
function History({ issue, section }: { issue: Issue; section: BriefSection }) {
  const selfId = useSelfId();
  const { api, act } = useTaskActions();
  const [open, setOpen] = useState(false);
  const revisions = issue.revisions.filter((r) => r.section === section).slice().reverse();
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <IconButton size="small" icon="clock" label={`${SECTION_INFO[section].label}: ${revisions.length} ${revisions.length === 1 ? 'version' : 'versions'}`} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={t.history} align="end" sideOffset={6} collisionPadding={10} aria-label="Versions">
          <div className={t.historyHead}>{SECTION_INFO[section].label} · history</div>
          <ol className={t.historyList}>
            {revisions.map((r, i) => (
              <li key={r.id} className={t.historyItem}>
                <div className={t.historyMeta}>
                  <span className={t.historyWho}>{actorName(r.by, selfId)}</span>
                  <span className={t.historyWhen}>{ago(r.at)}</span>
                  {r.reason ? <span className={t.historyWhy}>{r.reason}</span> : null}
                </div>
                <div className={t.historyBefore}>{r.before.trim() ? r.before : <em>Empty before</em>}</div>
                {r.before.trim() || i > 0 ? (
                  <Button
                    size="small"
                    variant="quiet"
                    onClick={() => {
                      setOpen(false);
                      void act(() => api.restoreRevision(issue.id, r.id), 'Restored that version');
                    }}
                  >
                    Restore This
                  </Button>
                ) : null}
              </li>
            ))}
          </ol>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
