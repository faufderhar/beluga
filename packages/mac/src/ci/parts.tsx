import { memo } from 'react';
import type { GhRun, RunTone } from '@beluga/core/ci/model.js';
import { durationWords, eventWords, isLive, runDuration, runTone, statusWords } from '@beluga/core/ci/model.js';
import { Icon, type IconName } from '../components/Icon.js';
import { type ActionItem, ActionsContext, ActionsDropdown } from '../components/SpecMenu.js';
import { IconButton, Tip, cx } from '../components/ui.js';
import { copyText } from '../lib/copy.js';
import { toast, useBeluga } from '../lib/beluga.js';
import { ago } from '../tasks/tasks-model.js';
import { useCiActions } from './use-ci.js';
import { NowText } from './now.js';
import s from './ci.module.css';

const ICONS: Readonly<Record<Exclude<RunTone, 'running'>, IconName>> = { passed: 'check', failed: 'x', queued: 'clock', waiting: 'hand', cancelled: 'stopSign', skipped: 'minus' };

/** How a run, job or step is going: a turning ring while it runs, else a small mark in its colour. */
export function RunMark({ tone, size = 16, label }: { tone: RunTone; size?: number; label?: string }) {
  return (
    <span className={cx(s.mark, s[`tone_${tone}`])} style={{ '--mark': `${size}px` } as React.CSSProperties} role="img" aria-label={label ?? tone}>
      {tone === 'running' ? <span className={s.ring} /> : <Icon name={ICONS[tone]} size={Math.round(size * 0.62)} />}
    </span>
  );
}

/** What to do with a run (right-click and ⋯). */
export function useRunMenu(projectId: string): (run: GhRun, opts?: { readonly open?: boolean; readonly then?: () => void }) => ActionItem[] {
  const a = useCiActions();
  const { client } = useBeluga();
  return (run, opts = {}) => {
    const tone = runTone(run);
    const done = !isLive(run);
    return [
      ...(opts.open === false ? [] : [{ label: 'Open', icon: 'pulse' as const, onSelect: () => a.openRun(projectId, run.id) }]),
      ...(done && (tone === 'failed' || tone === 'cancelled') ? [{ label: 'Re-run Failed Jobs', icon: 'refresh' as const, separate: opts.open !== false, onSelect: () => void a.rerun(projectId, run.id, true).then((ok) => ok && opts.then?.()) }] : []),
      ...(done ? [{ label: 'Re-run All Jobs', icon: 'refresh' as const, separate: opts.open !== false && tone !== 'failed' && tone !== 'cancelled', onSelect: () => void a.rerun(projectId, run.id, false).then((ok) => ok && opts.then?.()) }] : []),
      ...(!done ? [{ label: 'Cancel Run…', icon: 'stop' as const, separate: opts.open !== false, onSelect: () => a.cancel(projectId, run.id, run.title, opts.then) }] : []),
      { label: 'Open on GitHub', icon: 'external', separate: true, onSelect: () => a.openOnGitHub(run.url) },
      { label: 'Copy Link', icon: 'copy', onSelect: () => void copyText(run.url).then(() => toast(client, 'Copied the link to the run', 'success')) },
    ];
  };
}

/**
 * One run in a list: how it's going, its title, the workflow, what started it and where, how long
 * it took (counting while it runs), when. Click opens its page.
 */
export const RunRow = memo(function RunRow({ projectId, run, now, compact }: { projectId: string; run: GhRun; /** Its own clock; else the page's (Ticking). */ now?: number; compact?: boolean }) {
  const { openRun } = useCiActions();
  const menu = useRunMenu(projectId);
  const tone = runTone(run);
  const live = isLive(run);
  const where = [run.branch, run.prs.length ? `#${run.prs[0]}` : undefined].filter(Boolean).join(' · ');
  return (
    <ActionsContext items={() => menu(run)}>
      <div
        role="row"
        tabIndex={0}
        className={cx(s.row, compact && s.rowCompact)}
        onClick={() => openRun(projectId, run.id)}
        onKeyDown={(e) => e.key === 'Enter' && openRun(projectId, run.id)}
        aria-label={`${run.workflow}: ${run.title}, ${statusWords(run)}`}
        data-run={run.id}
      >
        <RunMark tone={tone} label={statusWords(run)} />
        <span className={s.rowMain}>
          <span className={s.rowTitle}>{run.title}</span>
          <span className={s.rowSub}>
            <span className={s.rowFlow}>{run.workflow}</span>
            <span>#{run.number}</span>
            <span>{eventWords(run.event)}</span>
            {where ? <span className={s.rowBranch}>{where}</span> : null}
            {!compact && run.actor ? <span>{run.actor}</span> : null}
          </span>
        </span>
        <NowText at={now}>
          {(now) => (
            <>
              <Tip label={live ? `${statusWords(run)} for ${durationWords(runDuration(run, now))}` : `Took ${durationWords(runDuration(run, now))}`}>
                <span className={cx(s.took, live && s.tookLive)}>
                  <Icon name="clock" size={11} />
                  {durationWords(runDuration(run, now))}
                </span>
              </Tip>
              <span className={s.when}>{ago(run.createdAt, now)}</span>
            </>
          )}
        </NowText>
        <span className={s.rowMore} onClick={(e) => e.stopPropagation()}>
          <ActionsDropdown items={menu(run)}>
            <IconButton size="small" icon="more" label={`What to do with run #${run.number}`} />
          </ActionsDropdown>
        </span>
      </div>
    </ActionsContext>
  );
});
