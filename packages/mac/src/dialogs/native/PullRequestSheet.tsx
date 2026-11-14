import { useState } from 'react';
import type { PrCheck, PullRequest } from '@beluga/core/work-store.js';
import { notOnPr } from '@beluga/core/branch-state.js';
import type { AppState } from '@beluga/core/store.js';
import type { MergeMethod } from '@beluga/workspaces/pr.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { CommandLine, Field, FormSheet, TextArea, formStyles as f } from '../../components/FormSheet.js';
import { Icon } from '../../components/Icon.js';
import { ActionsDropdown } from '../../components/SpecMenu.js';
import { Button, Tip, cx } from '../../components/ui.js';
import { useActions } from '../../lib/actions.js';
import { toast, useApi, useApp, useBeluga } from '../../lib/beluga.js';
import { MERGE_METHODS, canAutoMerge, canSkipChecks, checkDuration, checkTone, checksSummary, sortChecks } from '../../lib/pr-checks.js';
import { openExternal } from '../../lib/system.js';
import { showGitTrouble } from '../../lib/git-trouble.js';
import { askBeforeWork } from '../../lib/work-confirm.js';
import { useClock } from '../../lib/window-active.js';
import type { NativeMenuProps } from './index.js';
import { usePick } from './pick.js';
import { openPrPage } from '../../pr/use-pr-conversation.js';
import s from './menus.module.css';
import { cmdReturn } from '../../lib/os-words.js';

const STATE: Record<PullRequest['state'], string> = { OPEN: 'Open', CLOSED: 'Closed', MERGED: 'Merged' };
const CHECKS: Record<PullRequest['checks'], { label: string; tone?: string; icon?: 'check' | 'x' | 'clock' }> = {
  passing: { label: 'Checks passed', tone: s.pillOk, icon: 'check' },
  failing: { label: 'Checks failed', tone: s.pillBad, icon: 'x' },
  pending: { label: 'Checks running', tone: s.pillWait, icon: 'clock' },
  none: { label: 'No checks' },
};
const REVIEW = { APPROVED: { label: 'Approved', tone: s.pillOk }, CHANGES_REQUESTED: { label: 'Changes requested', tone: s.pillBad }, REVIEW_REQUIRED: { label: 'Waiting for review', tone: undefined } } as const;

/** The way you last merged (squash until you pick another). */
const METHOD_KEY = 'beluga.mergeMethod';
export function lastMethod(): MergeMethod {
  try {
    const m = localStorage.getItem(METHOD_KEY);
    return m === 'merge' || m === 'rebase' ? m : 'squash';
  } catch {
    return 'squash';
  }
}

export function rememberMethod(how: MergeMethod): void {
  try {
    localStorage.setItem(METHOD_KEY, how);
  } catch {
    // No storage: squash next time.
  }
}

/** Each CI check, live: spinner while it runs, ✓ or ✗ when done, how long, and its page. */
export function CheckList({ checks, summary = true }: { checks: readonly PrCheck[]; summary?: boolean }) {
  const running = checks.some((c) => c.state === 'in_progress');
  // Running checks count up, only while you're looking (KLD-40).
  const now = useClock(running);
  return (
    <div className={s.checks}>
      {summary ? <div className={s.checksHead}>{checksSummary(checks)}</div> : null}
      <ul className={s.checkList} aria-label="Checks">
        {sortChecks(checks).map((c, i) => {
          const tone = checkTone(c);
          const time = checkDuration(c, now);
          return (
            <li key={`${c.workflow ?? ''}/${c.name}/${i}`} className={s.checkRow} data-check={tone}>
              <span className={cx(s.checkIcon, s[`check_${tone}`])} aria-label={tone}>
                {tone === 'running' ? <span className={s.spinner} /> : <Icon name={tone === 'passed' ? 'check' : tone === 'failed' ? 'x' : tone === 'queued' ? 'clock' : 'minus'} size={12} />}
              </span>
              <span className={s.checkName} title={c.workflow ? `${c.workflow} / ${c.name}` : c.name}>
                {c.workflow ? <span className={s.checkWorkflow}>{c.workflow} / </span> : null}
                {c.name}
              </span>
              <span className={s.checkTime}>{tone === 'queued' ? 'Queued' : time}</span>
              {c.url ? (
                <button type="button" className={s.checkLink} aria-label={`Open ${c.name} on GitHub`} title="Details on GitHub" onClick={() => void openExternal(c.url!)}>
                  <Icon name="external" size={11} />
                </button>
              ) : (
                <span className={s.checkLink} />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Merge on GitHub: the button merges the way you last did (squash at first); its menu picks
 * another way, "Merge When Checks Pass" while something is still to come, or "Merge Now,
 * Skipping Checks" (an admin's override) when checks or a review are in the way.
 */
export function MergeButton({ wsId, pr, onError, size }: { wsId: string; pr: PullRequest; onError: (message: string | undefined) => void; size?: 'small' }) {
  const api = useApi();
  const [method, setMethod] = useState<MergeMethod>(lastMethod);
  const [busy, setBusy] = useState(false);
  // Commits here the PR doesn't have (BLG-840): never merged without them. Push and Merge pushes
  // them, then merges once their checks pass (the daemon pushes first whichever way you merge).
  const gap = useApp((st) => unpushedOnPr(st, wsId, pr));
  const merge = async (how: MergeMethod, picked?: 'auto' | 'admin'): Promise<void> => {
    const mode = picked ?? (gap ? 'auto' : undefined);
    if (busy) return;
    setMethod(how);
    rememberMethod(how);
    setBusy(true);
    onError(undefined);
    try {
      const out = await api.workbench.mergePr(wsId, { method: how, ...(mode ? { [mode]: true } : {}) });
      // Couldn't reach GitHub: its card (why, and the fix) instead of the line.
      if (out && !out.ok && !showGitTrouble(wsId, out, 'none')) onError(out.message);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const chosen = MERGE_METHODS.find((m) => m.method === method)!;
  const auto = canAutoMerge(pr);
  const skip = canSkipChecks(pr);
  const commits = gap === 1 ? '1 commit' : `${gap} commits`;
  const items = [
    ...MERGE_METHODS.map((m) => ({ label: m.label, hint: gap ? `Pushes the ${commits}, then merges this way once ${gap === 1 ? 'its' : 'their'} checks pass` : m.hint, checked: m.method === method, onSelect: () => void merge(m.method) })),
    ...(auto && !gap ? [{ label: 'Merge When Checks Pass', hint: `${chosen.label} as soon as GitHub allows it`, separate: true, onSelect: () => void merge(method, 'auto') }] : []),
    ...(skip ? [{ label: gap ? 'Push and Merge Now, Skipping Checks' : 'Merge Now, Skipping Checks', hint: `${gap ? `Pushes the ${commits}, then ${chosen.label.toLowerCase()}` : chosen.label} into the base on GitHub right away, past its checks and reviews, and stops the checks still running (needs admin rights)`, danger: true, separate: Boolean(gap), onSelect: () => void merge(method, 'admin') }] : []),
  ];
  const tip = pr.draft ? 'It’s a draft: mark it ready for review on GitHub first' : gap ? `${commits} here ${gap === 1 ? 'isn’t' : 'aren’t'} on PR #${pr.number} yet: pushes ${gap === 1 ? 'it' : 'them'}, then ${chosen.label.toLowerCase()} once ${gap === 1 ? 'its' : 'their'} checks pass` : `${chosen.label} on GitHub`;
  return (
    <span className={s.split} role="group" aria-label="Merge on GitHub">
      <Tip label={tip}>
        <Button variant="merge" icon={gap ? 'up' : 'merge'} size={size ?? 'regular'} className={s.splitMain} disabled={busy || pr.draft} data-merge-github={method} data-push-first={gap || undefined} onClick={() => void merge(method)}>
          {busy ? (gap ? 'Pushing…' : 'Merging…') : gap ? 'Push and Merge' : 'Merge on GitHub'}
        </Button>
      </Tip>
      <ActionsDropdown items={items} align="start">
        <Button variant="merge" size={size ?? 'regular'} className={s.splitMore} disabled={busy || pr.draft} aria-label="More ways to merge">
          <Icon name="chevronDown" size={11} />
        </Button>
      </ActionsDropdown>
    </span>
  );
}

/** Commits in this worktree its open PR doesn't have (0: none), as the branch pill counts them. */
function unpushedOnPr(st: AppState, wsId: string, pr: PullRequest): number {
  const ws = findWorkspace(st.projects, wsId);
  return ws ? (notOnPr(pr, ws)?.count ?? 0) : 0;
}

/** GitHub can't merge a PR that conflicts with its base: Claude resolves it in the chat (asks first). */
export function ResolveConflictsButton({ wsId, size }: { wsId: string; size?: 'small' }) {
  return (
    <Tip label="Your agent merges the latest base into this branch, resolves the conflicts in the chat, and pushes">
      <Button variant="danger" icon="merge" size={size ?? 'regular'} data-pr-next="resolve" onClick={() => askBeforeWork(wsId, 'resolve_pr')}>
        Resolve Merge Conflicts…
      </Button>
    </Tip>
  );
}

/**
 * Once the PR merged, the worktree is done: Archive Worktree puts it away; its menu carries on
 * here instead (Continue After Merge: a new PR next), or deletes it.
 */
export function AfterMergeButton({ wsId, size }: { wsId: string; size?: 'small' }) {
  const actions = useActions();
  const items = [
    { label: 'Continue After Merge…', hint: 'Start this branch again from the latest base and keep the conversation; the next change gets a new PR', onSelect: () => askBeforeWork(wsId, 'continue_after_merge') },
    { label: 'Delete Worktree…', hint: 'Remove the folder and its branch for good', danger: true, onSelect: () => actions.run({ type: 'ws', id: wsId, action: 'delete' }) },
  ];
  return (
    <span className={s.split} role="group" aria-label="After the merge">
      <Button variant="primary" icon="archive" size={size ?? 'regular'} className={s.splitMain} data-pr-next="archive" onClick={() => actions.run({ type: 'ws', id: wsId, action: 'archive' })}>
        Archive Worktree
      </Button>
      <ActionsDropdown items={items} align="start">
        <Button variant="primary" size={size ?? 'regular'} className={s.splitMore} aria-label="Other ways to finish">
          <Icon name="chevronDown" size={11} />
        </Button>
      </ActionsDropdown>
    </span>
  );
}

/** The PR you have: its state and checks at a glance, and what to do next. */
function PrCard({ wsId, pr, pick, refresh, close }: { wsId: string; pr: PullRequest; pick: (id: string) => boolean; refresh: () => void; close: () => void }) {
  const actions = useActions();
  const [error, setError] = useState<string>();
  const checks = CHECKS[pr.checks];
  const review = pr.review ? REVIEW[pr.review] : undefined;
  const open = pr.state === 'OPEN';
  // Beluga waits for the checks and merges then (Merge When Checks Pass), or GitHub's own auto-merge is on.
  const waiting = useApp((st) => Boolean(st.projects.flatMap((p) => p.workspaces).find((w) => w.id === wsId)?.mergeWhenReady));
  const gap = useApp((st) => unpushedOnPr(st, wsId, pr));
  const changed = useApp((st) => findWorkspace(st.projects, wsId)?.status?.changed ?? 0);
  return (
    <div className={s.pr} data-pr-state={pr.state}>
      <div className={s.prTop}>
        <Icon name={pr.state === 'MERGED' ? 'merge' : 'pr'} size={15} />
        <span className={s.prNumber}>#{pr.number}</span>
        <span className={cx(s.prTitle, 'selectable')} title={pr.title}>
          {pr.title}
        </span>
        <Button size="small" variant="quiet" icon="refresh" aria-label="Refresh status" onClick={refresh} />
      </div>
      <div className={s.prMeta}>
        <span className={cx(s.pill, pr.state === 'MERGED' && s.pillOk)}>
          {pr.state === 'MERGED' ? <Icon name="merge" size={11} /> : null}
          {pr.draft && open ? 'Draft' : STATE[pr.state]}
        </span>
        {open ? (
          <span className={cx(s.pill, checks.tone)}>
            {checks.icon ? <Icon name={checks.icon} size={11} /> : null}
            {checks.label}
          </span>
        ) : null}
        {review && open ? <span className={cx(s.pill, review.tone)}>{review.label}</span> : null}
        {open && pr.conflicts ? <span className={cx(s.pill, s.pillBad)}>Conflicts with the base</span> : null}
        {open && gap ? (
          <span className={cx(s.pill, s.pillWait)} data-not-on-pr={gap}>
            <Icon name="up" size={11} />
            {gap === 1 ? '1 commit' : `${gap} commits`} not on it yet
          </span>
        ) : null}
        {open && (pr.autoMerge || waiting) ? (
          <span className={cx(s.pill, s.pillWait)}>
            <Icon name="clock" size={11} />
            Merges when checks pass
          </span>
        ) : null}
      </div>
      {pr.checkRuns?.length && pr.state !== 'CLOSED' ? <CheckList checks={pr.checkRuns} /> : null}
      <div className={s.prActions}>
        {open ? pr.conflicts ? <ResolveConflictsButton wsId={wsId} /> : <MergeButton wsId={wsId} pr={pr} onError={setError} /> : null}
        {pr.state === 'MERGED' ? <AfterMergeButton wsId={wsId} /> : null}
        <Tip label="The PR’s page: what reviewers said, with the code they mean; reply, resolve, or ask your agent">
          <Button icon="chat" onClick={() => (openPrPage(wsId), close())}>
            Comments
          </Button>
        </Tip>
        <Button onClick={() => pick('pr-open')}>Open on GitHub</Button>
        {pr.checks === 'failing' && open ? (
          <Button icon="claude" onClick={() => pick('pr-fix')}>
            Fix Failing Checks
          </Button>
        ) : null}
        {open ? (
          <Button icon="up" onClick={() => pick('pr-update')}>
            Push & Update
          </Button>
        ) : null}
      </div>
      {error ? (
        <div className={s.prError} role="alert">
          <Icon name="alert" size={12} />
          {error}
        </div>
      ) : null}
      {pr.state === 'MERGED' ? <div className={s.prNote}>Merged on GitHub, so this worktree is done. Archive it to put it away (its branch and conversation are kept), or Continue After Merge to keep working here with a new PR.</div> : null}
      {open && pr.conflicts ? <div className={s.prNote}>It conflicts with its base, so GitHub can’t merge it until the conflicts are resolved and pushed.</div> : null}
      {open && gap ? <div className={s.prNote}>{gap === 1 ? '1 commit' : `${gap} commits`} in this worktree {gap === 1 ? 'isn’t' : 'aren’t'} on PR #{pr.number} yet, so merging it as it is would leave {gap === 1 ? 'it' : 'them'} out. Push and Merge pushes {gap === 1 ? 'it' : 'them'} first, then merges once {gap === 1 ? 'its' : 'their'} checks pass.</div> : null}
      {open && changed ? <div className={s.prNote}>{changed === 1 ? '1 uncommitted change stays' : `${changed} uncommitted changes stay`} here: commit {changed === 1 ? 'it' : 'them'} first to have {changed === 1 ? 'it' : 'them'} in the merge.</div> : null}
    </div>
  );
}

/**
 * The PR button: create one with Claude (with anything extra to tell it), see the one you have,
 * or, without the GitHub CLI, the two commands that set it up.
 */
export function PullRequestSheet({ menu, close }: NativeMenuProps<'pr'>) {
  const api = useApi();
  const { client } = useBeluga();
  const pick = usePick(menu);
  const ws = useApp((st) => findWorkspace(st.projects, menu.id));
  const pr = useApp((st) => st.prs[menu.id]);
  const gh = useApp((st) => st.gh);
  const custom = useApp((st) => st.prCustom);
  const [note, setNote] = useState('');
  const [checking, setChecking] = useState(false);
  if (!ws) return null;
  const instructions = (
    <button type="button" className={f.linkButton} onClick={() => pick('pr-edit-prompt')}>
      {custom ? 'Your PR instructions…' : 'PR instructions…'}
    </button>
  );

  if (gh === false) {
    const check = async (): Promise<string | void> => {
      setChecking(true);
      await api.workbench.refreshPrs(menu.id, true);
      setChecking(false);
      if (client.store.getState().gh === false) return 'The GitHub CLI isn’t set up yet. Run both commands in Terminal, then check again.';
      toast(client, 'GitHub is connected', 'success');
    };
    return (
      <FormSheet title="Connect GitHub" icon="pr" intro="Beluga opens pull requests with GitHub’s command-line tool. Set it up once, in Terminal:" submitLabel={checking ? 'Checking…' : 'Check Again'} canSubmit={!checking} onSubmit={check} onCancel={close}>
        <div className={s.ghSteps}>
          <div className={s.ghStep}>
            <div className={s.ghStepTitle}>
              1. Install it <span>· needs Homebrew</span>
            </div>
            <CommandLine command="brew install gh" />
          </div>
          <div className={s.ghStep}>
            <div className={s.ghStepTitle}>
              2. Sign in to GitHub <span>· it opens your browser</span>
            </div>
            <CommandLine command="gh auth login" />
          </div>
        </div>
      </FormSheet>
    );
  }

  if (pr) {
    return (
      <FormSheet width={560} title={`Pull Request · ${ws.name}`} intro={<>From <code>{ws.branch ?? 'this branch'}</code></>} submitLabel="" hideSubmit onSubmit={() => undefined} onCancel={close} footer={instructions}>
        <PrCard wsId={menu.id} pr={pr} pick={pick} refresh={() => void api.workbench.refreshPrs(menu.id).then(() => toast(client, 'Pull request status refreshed'))} close={close} />
      </FormSheet>
    );
  }

  return (
    <FormSheet
      title="Create Pull Request"
      icon="pr"
      intro={
        <>
          Your agent commits what belongs to the work on <code>{ws.branch ?? 'this branch'}</code>, pushes it and opens a pull request with a short description: what, why, and how to test.
        </>
      }
      submitLabel="Create Pull Request"
      onSubmit={() => {
        // The same as /pr with extra words (or the plain option without them).
        if (note.trim()) void api.workbench.createPr(menu.id, note.trim());
        else pick('pr-create');
        close();
      }}
      onCancel={close}
      footer={instructions}
    >
      <Field label="Instructions" htmlFor="pr-note" hint={`Optional: anything extra for this pull request. ${cmdReturn()} creates it.`}>
        <TextArea id="pr-note" value={note} onChange={setNote} rows={3} placeholder="e.g. Open it as a draft and mention issue #42" />
      </Field>
    </FormSheet>
  );
}
