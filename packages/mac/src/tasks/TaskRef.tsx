import { type ReactNode, useMemo } from 'react';
import { type Issue, PRIORITY_INFO, STATUS_INFO, findIssue } from '@beluga/core/board/model.js';
import { readTaskKeys } from '@beluga/shared/task-refs.js';
import { Icon } from '../components/Icon.js';
import { Tip } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { TonePill } from '../plans/marks.js';
import { PriorityIcon, StatusIcon } from './marks.js';
import { useTaskActions } from './use-tasks.js';
import { useActions } from '../lib/actions.js';
import { planTitle } from '@beluga/core/plans/model.js';
import { type ResolvedChat, resolveChat } from '@beluga/core/chat-links/resolve.js';
import { type ChatRef, chatChipOf } from '@beluga/shared/chat-ref.js';
import { openChatView } from '../lib/chat-links.js';
import r from './task-ref.module.css';

/**
 * Tasks Claude shows in an answer (src/shared/task-refs.ts): `task:BLG-12` as a chip in the
 * sentence, a `beluga-tasks` block as a list of cards. Each reads its task from the live board,
 * so a status that changes changes here too; a click opens the task. A key the board doesn't
 * have (deleted, or someone else's board) is a quiet "not found", never a broken card.
 */

const useIssue = (key: string): Issue | undefined => useApp((s) => findIssue(s.board, key));

const tipOf = (issue: Issue): string => `${issue.key} · ${STATUS_INFO[issue.status].label} · ${PRIORITY_INFO[issue.priority].label}. Click to open`;

function Missing({ taskKey, block, label }: { taskKey: string; block?: boolean; label?: 'worktree' | 'plan' }) {
  return (
    <Tip label={label ? `No ${label} ${taskKey} here: deleted, or on someone else’s computer` : `No task ${taskKey} on this board: deleted, or on someone else's`}>
      <span className={block ? r.missingRow : r.missing}>
        <span className={r.key}>{taskKey}</span>
        <span>not found</span>
      </span>
    </Tip>
  );
}

/** One task inside a sentence: a pill with its status ring, key and title (cut short), and an arrow to open it. */
export function TaskChip({ taskKey }: { taskKey: string }) {
  const issue = useIssue(taskKey);
  const { open } = useTaskActions();
  if (!issue) return <Missing taskKey={taskKey} />;
  return (
    <Tip label={tipOf(issue)}>
      <button type="button" className={r.chip} onClick={() => open(issue)} aria-label={`${issue.key}: ${issue.title}, ${STATUS_INFO[issue.status].label}`}>
        <StatusIcon status={issue.status} size={12} />
        <span className={r.key}>{issue.key}</span>
        <span className={r.chipTitle}>{issue.title}</span>
        <Icon name="arrowRight" size={10} className={r.chipGo} />
      </button>
    </Tip>
  );
}

/**
 * A bare key in the words ("BLG-72", not `task:BLG-72`): Claude wrote what it's about next to it,
 * so only the status ring and the key, with the title on hover. A key that's gone stays text.
 */
export function TaskKeyChip({ taskKey }: { taskKey: string }) {
  const issue = useIssue(taskKey);
  const { open } = useTaskActions();
  if (!issue) return <>{taskKey}</>;
  return (
    <Tip label={`${issue.title} · ${STATUS_INFO[issue.status].label}. Click to open`}>
      <button type="button" className={`${r.chip} ${r.keyChip}`} onClick={() => open(issue)} aria-label={`${issue.key}: ${issue.title}, ${STATUS_INFO[issue.status].label}`}>
        <StatusIcon status={issue.status} size={11} />
        <span className={r.key}>{issue.key}</span>
      </button>
    </Tip>
  );
}

/** A `beluga-tasks` block: one card per key, stacked. */
export function TaskCards({ code }: { code: string }) {
  const keys = useMemo(() => readTaskKeys(code), [code]);
  if (!keys.length) return null;
  return (
    <div className={r.cards} role="list" aria-label={keys.length === 1 ? 'Task' : `${keys.length} tasks`}>
      {keys.map((k) => (
        <TaskCardRow key={k} taskKey={k} />
      ))}
    </div>
  );
}

function TaskCardRow({ taskKey }: { taskKey: string }) {
  const issue = useIssue(taskKey);
  const { open } = useTaskActions();
  if (!issue) {
    return (
      <div role="listitem">
        <Missing taskKey={taskKey} block />
      </div>
    );
  }
  const status = STATUS_INFO[issue.status];
  return (
    <div role="listitem">
      <button type="button" className={r.card} onClick={() => open(issue)}>
        <StatusIcon status={issue.status} size={14} />
        <span className={r.key}>{issue.key}</span>
        <span className={r.cardTitle}>{issue.title}</span>
        <span className={r.cardEnd}>
          <TonePill tone={status.tone} live={issue.status === 'in_progress'}>
            {status.label}
          </TonePill>
          <PriorityIcon priority={issue.priority} size={14} labelled />
        </span>
      </button>
    </div>
  );
}

/** A worktree Claude started (Your Mac: `worktree:<id>`): a pill with its name; a click opens its conversation. */
export function WorktreeChip({ id }: { id: string }) {
  // Picks the store's own objects: a pick built fresh each time ({ w, project }) never settles, and React gives up (#185).
  const project = useApp((s) => s.projects.find((p) => p.workspaces.some((w) => w.id === id)));
  const w = project?.workspaces.find((x) => x.id === id);
  const actions = useActions();
  if (!project || !w) return <Missing taskKey={id} label="worktree" />;
  return (
    <Tip label={`${project.name} · ${w.name}${w.archived ? ' (archived)' : ''}. Click to open`}>
      <button type="button" className={r.chip} onClick={() => actions.run({ type: 'open_ws', id })} aria-label={`Worktree ${w.name} in ${project.name}`}>
        <Icon name="branch" size={12} />
        <span className={r.key}>{project.name}</span>
        <span className={r.chipTitle}>{w.name}</span>
        <Icon name="arrowRight" size={10} className={r.chipGo} />
      </button>
    </Tip>
  );
}

/** A plan Claude started (Your Mac: `plan:<id>`): a pill with its name; a click opens its page. */
export function PlanChip({ id }: { id: string }) {
  const plan = useApp((s) => s.plans.plans.find((p) => p.id === id));
  const actions = useActions();
  if (!plan) return <Missing taskKey={id} label="plan" />;
  return (
    <Tip label={`Plan · ${planTitle(plan)}. Click to open`}>
      <button type="button" className={r.chip} onClick={() => actions.run({ type: 'view', view: { kind: 'plan', id } })} aria-label={`Plan ${planTitle(plan)}`}>
        <Icon name="graph" size={12} />
        <span className={r.key}>Plan</span>
        <span className={r.chipTitle}>{planTitle(plan)}</span>
        <Icon name="arrowRight" size={10} className={r.chipGo} />
      </button>
    </Tip>
  );
}

export const CHAT_KIND: Readonly<Record<ResolvedChat['kind'], string>> = { worktree: 'Worktree', chat: 'Chat', assistant: 'Your Mac', sentinel: 'Sentinel' };

/**
 * A chat by its address (`chat:<owner>/<channel>`): a pill with its current title, read from the
 * records as chats.resolve reads them; a click opens it. Until it
 * reads, `fallback`: the caller's own (an inline code span, a step's words), else the code.
 */
export function ChatChip({ target, raw, fallback }: { target: ChatRef; raw: string; fallback?: ReactNode }) {
  // Text, not the object: a pick built fresh each time never settles (#185, as WorktreeChip above).
  const picked = useApp((s) => JSON.stringify(resolveChat(s, target)));
  const chat = useMemo(() => (picked ? (JSON.parse(picked) as ResolvedChat) : undefined), [picked]);
  const actions = useActions();
  if (!chat) return <>{fallback ?? <code>{raw}</code>}</>;
  const chip = chatChipOf(chat);
  const { view } = chat;
  if (!chip.opens || !view) {
    return (
      <Tip label={chat.ownership === 'unknown' ? 'A chat on someone else’s computer that isn’t shared with you' : chat.state === 'loading' ? 'Beluga is still finding your projects' : 'This chat is gone: deleted, or its worktree was removed'}>
        <span className={r.missing}>
          <Icon name={chat.ownership === 'unknown' ? 'lock' : 'chat'} size={12} />
          <span>{chip.label}</span>
        </span>
      </Tip>
    );
  }
  return (
    <Tip label={`${CHAT_KIND[chat.kind]} · ${chip.label}${chat.state === 'idle' ? '' : ` (${chat.state})`}. Click to open`}>
      <button type="button" className={r.chip} onClick={() => openChatView(actions, view)} aria-label={`${CHAT_KIND[chat.kind]} ${chip.label}`}>
        <Icon name={chat.kind === 'worktree' ? 'branch' : 'chat'} size={12} />
        <span className={r.key}>{CHAT_KIND[chat.kind]}</span>
        <span className={r.chipTitle}>{chip.label}</span>
        <Icon name="arrowRight" size={10} className={r.chipGo} />
      </button>
    </Tip>
  );
}
