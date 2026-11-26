import type { AgentRef } from '@beluga/protocol.js';
import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { Select, type SelectOption } from '../components/Select.js';
import { Tip } from '../components/ui.js';
import { useApi, useApp } from '../lib/beluga.js';
import s from './draft.module.css';
import { baseChoice, liveBaseChoice, pruneBaseChoice, rememberBase } from './base-choice.js';
import { landChoice, rememberLand } from './land-choice.js';

/** What a new worktree starts from and is called (empty name: Beluga names it from the task). */
export interface WorktreeChoice {
  /** Unset: your last pick in this project (BLG-1034), else its default branch. */
  readonly base?: string;
  readonly name: string;
  /** Its own agent (the composer's picker, BLG-446); unset: your default. */
  readonly agent?: AgentRef;
  /** Straight to main (BLG-973): its work lands on its base in the main folder as its agent finishes. Unset: your last pick in this project. */
  readonly land?: boolean;
}

/** Whether this new worktree goes straight to main: picked in its box, else your last pick in the project. */
export const landsOnBase = (choice: WorktreeChoice, projectId: string): boolean => choice.land ?? landChoice(projectId);

/** The branch this new worktree starts from: picked in its box, else your last pick in the project (unset: its default). */
export const baseOf = (choice: WorktreeChoice, projectId: string): string | undefined => choice.base ?? baseChoice(projectId);

/** The branch it would land on: the base, without its remote ("origin/main" → "main"). */
export const landTarget = (base: string): string => base.replace(/^origin\//, '') || 'main';

type Then = 'branch' | 'land';

/** What happens to its work: its own branch (a PR or a merge when you like), or straight to the base. */
export function thenOptions(into: string): Array<SelectOption<Then>> {
  return [
    { value: 'branch', label: 'Its own branch', icon: 'branch', description: 'Open a PR or merge it when you like' },
    { value: 'land', label: `Straight to ${into}`, icon: 'merge', description: `Commits to ${into} in your main folder each time the agent finishes. No PR; you push when you’re ready` },
  ];
}

/**
 * The top of the message box for a new worktree: which project, the branch it starts from
 * (a pop-up, searchable when there are many) and an optional name. The task below is Claude's first message.
 */
export function WorktreeDraft({ projectId, choice, onChange }: { projectId: string; choice: WorktreeChoice; onChange: (c: WorktreeChoice) => void }) {
  const api = useApi();
  const project = useApp((st) => st.projects.find((p) => p.id === projectId));
  const [branches, setBranches] = useState<{ base: string; branches: readonly string[] }>();
  useEffect(() => {
    let alive = true;
    setBranches(undefined);
    api.workspaces.branches(projectId).then(
      (b) => alive && b && setBranches(b),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [projectId]);
  useEffect(() => {
    if (branches) pruneBaseChoice(projectId, branches.branches);
  }, [projectId, branches]);
  const fallback = branches?.base ?? project?.base;
  const base = choice.base ?? liveBaseChoice(projectId, branches?.branches) ?? fallback ?? '';
  const options = branches?.branches.length ? branches.branches : base ? [base] : [];
  return (
    <div className={s.draft} role="group" aria-label="New worktree">
      <span className={s.project}>
        <Icon name="branch" size={12} />
        {project?.name ?? 'Project'}
      </span>
      <label className={s.field}>
        <span className={s.fieldLabel}>Based on</span>
        <Tip label="The branch the new one starts from (origin branches are fetched first, so it's the latest)">
          <Select className={s.select} size="small" mono label="Based on" value={base} onChange={(b) => {
              rememberBase(projectId, b, fallback);
              onChange({ ...choice, base: b });
            }} options={branchOptions(options, branches?.base)} searchPlaceholder="Find a branch" />
        </Tip>
      </label>
      <label className={s.field}>
        <span className={s.fieldLabel}>Name</span>
        <input
          className={`${s.name} selectable`}
          aria-label="Worktree name"
          placeholder="from the task"
          value={choice.name}
          maxLength={60}
          spellCheck={false}
          onChange={(e) => onChange({ ...choice, name: e.target.value })}
          onKeyDown={(e) => {
            // Return in the name goes to the task (or creates it when there's no task).
            if (e.key === 'Enter') {
              e.preventDefault();
              document.dispatchEvent(new CustomEvent('beluga:focus-composer'));
            }
          }}
        />
      </label>
      <ThenField projectId={projectId} base={base} land={choice.land} onChange={(land) => onChange({ ...choice, land })} />
    </div>
  );
}

/**
 * "Then": where a new worktree's work goes, its own branch or Straight to main (BLG-973). The pick
 * is remembered for the project. Both new-worktree boxes have it (this one and the project's home).
 */
export function ThenField({ projectId, base, land, onChange }: { projectId: string; base: string; land: boolean | undefined; onChange: (land: boolean) => void }) {
  const into = landTarget(base);
  const then: Then = (land ?? landChoice(projectId)) ? 'land' : 'branch';
  return (
    <label className={s.field}>
      <span className={s.fieldLabel}>Then</span>
      <Tip label={`Where its work goes. Straight to ${into}: the agent still works in a worktree of its own, and each time it finishes, its work is committed to ${into} in your main folder (your own changes there are never touched). Push ${into} when you’re ready`}>
        <Select
          className={s.select}
          size="small"
          label="Then"
          value={then}
          onChange={(v) => {
            rememberLand(projectId, v === 'land');
            onChange(v === 'land');
          }}
          options={thenOptions(into)}
          searchable={false}
        />
      </Tip>
    </label>
  );
}

/** The branches a worktree can start from, for the Based on pop-up: the default one says so. */
export function branchOptions(branches: readonly string[], base: string | undefined): Array<SelectOption<string>> {
  return branches.map((b) => ({ value: b, label: b, ...(b === base ? { badge: 'default' } : {}) }));
}
