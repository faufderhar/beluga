import { useRef, useState } from 'react';
import type { Issue } from '@beluga/core/board/model.js';
import { type GhIssueFull, type IssueStage, repoSlug } from '@beluga/core/issues/model.js';
import type { GitHubRepo } from '@beluga/workspaces/github.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { Markdown } from '../chat/Markdown.js';
import { Icon } from '../components/Icon.js';
import { type ActionItem, ActionsDropdown } from '../components/SpecMenu.js';
import { Avatar, Button, Empty, EmptyActions, IconButton, Tip, cx } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { openSheet } from '../lib/sheets.js';
import { LiveDot } from '../plans/marks.js';
import { PrChip, StatusIcon } from '../tasks/marks.js';
import { issueWayBack } from '../tasks/use-tasks.js';
import { useSwipeBack } from '../tasks/use-swipe-back.js';
import { SwipeBackEdge } from '../tasks/SwipeBackEdge.js';
import { agoWords, comments, lastReport, stateOf } from './issues-model.js';
import { GhLabelChip, IssueStateIcon, useIssueMenu } from './parts.js';
import { IssueComposer } from './IssueComposer.js';
import { IssueReply } from './IssueReply.js';
import { useIssue, useIssueActions, useIssueStage } from './use-issues.js';
import { useActions } from '../lib/actions.js';
import t from '../tasks/tasks.module.css';
import s from './issues.module.css';
import arr from '../lib/arrive.module.css';
import { useLateArrival } from '../lib/last-seen.js';
import { shortcutKeys } from '../lib/shortcuts.js';

/**
 * One GitHub issue: what it says and what people said since, and what Claude should do about it.
 * Nothing done yet: a composer like a project's home (Investigate, Fix It or Make a Task, and
 * anything Claude should know). Once Claude is on it, the same place shows how it's going:
 * investigating, what it found (with Fix It, in the same worktree), fixing, its pull request,
 * done. Everything goes through the issue's task.
 */
export function IssuePage({ projectId, number }: { projectId: string; number: number }) {
  const { data, error, loading, refresh } = useIssue(projectId, number);
  const actions = useActions();
  const late = useLateArrival(`${projectId}#${number}`, data !== undefined);
  if (!data) {
    if (error) {
      return (
        <Empty
          icon="alert"
          title={`Couldn’t read #${number}`}
          detail={error}
          action={
            <EmptyActions>
              <Button size="small" onClick={refresh}>Try Again</Button>
              <Button size="small" variant="quiet" onClick={() => actions.run({ type: 'view', view: issueWayBack(projectId) })}>
                Back
              </Button>
            </EmptyActions>
          }
        />
      );
    }
    return <Empty icon="issue" title="Asking GitHub…" detail={`For issue #${number}`} />;
  }
  return <Page projectId={projectId} repo={data.repo} issue={data.issue} loading={loading} refresh={refresh} late={late} />;
}

function Page({ projectId, repo, issue, loading, refresh, late }: { projectId: string; repo: GitHubRepo; issue: GhIssueFull; loading: boolean; refresh: () => void; late: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const actions = useActions();
  const back = (): void => actions.run({ type: 'view', view: issueWayBack(projectId) });
  const swipe = useSwipeBack(wrap, back);
  const stage = useIssueStage(projectId, repo, issue.number);
  const project = useApp((st) => st.projects.find((p) => p.id === projectId));
  const menu = useIssueMenu(projectId);
  const a = useIssueActions();
  const state = stateOf(issue);
  // What Claude found can go on GitHub as your comment (⋯), after you've seen what it says.
  const found = useFindings(stage);
  const post: ActionItem[] = found
    ? [
        {
          label: 'Post the Findings on GitHub…',
          icon: 'send',
          hint: `As a comment from you on #${issue.number}`,
          onSelect: () =>
            openSheet({
              kind: 'confirm',
              title: `Post the findings on #${issue.number}?`,
              message: `What the agent found goes on GitHub as a comment from you, for everyone who can see the issue.\n\n${found.length > 600 ? `${found.slice(0, 600)}…` : found}`,
              confirm: 'Post Comment',
              run: () => void a.comment(projectId, issue.number, `**Findings**\n\n${found}`).then((url) => url && refresh()),
            }),
        },
      ]
    : [];
  return (
    <div ref={wrap} className={cx(t.pageWrap, late && arr.arrive)}>
      <SwipeBackEdge progress={swipe} />
      <div className={t.page}>
        <div className={t.pageMain}>
          <nav className={t.crumbs} aria-label="Where this issue is">
            <IconButton size="small" icon="back" label="Back" keys={shortcutKeys('page-back')} className={t.crumbBack} onClick={back} />
            <button type="button" className={t.crumb} onClick={() => a.openList(projectId)}>
              Issues
            </button>
            <Icon name="chevronRight" size={10} />
            <span className={t.crumbPlain}>{project?.name ?? repoSlug(repo)}</span>
            <span className={t.grow} />
            <span className={t.pageKey}>#{issue.number}</span>
            <IconButton size="small" icon="refresh" label={loading ? 'Asking GitHub…' : 'Ask GitHub Again'} className={cx(loading && s.spinning)} onClick={refresh} />
            <ActionsDropdown items={[...post, ...menu(issue, stage, { open: false })]}>
              <IconButton size="small" icon="more" label="More" />
            </ActionsDropdown>
          </nav>
          <header className={t.pageHead}>
            <h1 className={s.pageTitle}>{issue.title}</h1>
            <div className={s.byline}>
              <span className={cx(s.statePill, s[`statePill_${state.tone}`])}>
                <IssueStateIcon issue={issue} size={13} />
                {state.label}
              </span>
              <span>
                {issue.author ? <strong>{issue.author}</strong> : 'Someone'} opened this {agoWords(issue.createdAt)}
                {issue.comments ? ` · ${comments(issue.comments)}` : ''}
              </span>
            </div>
            <NextStep projectId={projectId} issue={issue} stage={stage} />
          </header>
          <section className={s.thread} aria-label="The issue and its comments">
            <Post author={issue.author} at={issue.createdAt} what="opened this" body={issue.body} url={issue.url} />
            {issue.thread.map((c, i) => (
              <Post key={`${c.url}-${i}`} author={c.author} at={c.createdAt} what="commented" body={c.body} url={c.url} />
            ))}
            {issue.moreComments || issue.thread.length < issue.comments ? (
              <button type="button" className={s.moreComments} onClick={() => actions.openLink({ kind: 'url', url: issue.url })}>
                {issue.comments - issue.thread.length} more on GitHub
                <Icon name="external" size={11} />
              </button>
            ) : null}
          </section>
          <IssueReply projectId={projectId} number={issue.number} posted={refresh} />
        </div>
        <Properties repo={repo} issue={issue} stage={stage} />
      </div>
    </div>
  );
}

/**
 * What Claude found: the task's context, once Claude was asked to investigate and wrote it (not the
 * report the task started from, nor what a quick look noted while writing the task).
 */
function findingsOf(task: Issue): string | undefined {
  const context = task.brief.context?.trim();
  if (!context || !task.github?.investigated) return undefined;
  return task.revisions.some((r) => r.section === 'context' && r.by.kind === 'claude') ? context : undefined;
}

/**
 * What Claude found, to show and to post: its report in the conversation (what happens, why, how
 * to fix it, a verdict), else what it wrote in the task's brief. Only once it has investigated.
 */
function useFindings(stage: IssueStage): string | undefined {
  const ws = stage.kind === 'investigated' || stage.kind === 'investigating' || stage.kind === 'fixing' ? stage.ws : undefined;
  const report = useApp((st) => (ws && stage.kind === 'investigated' ? lastReport(st.log, `ws:${ws}`) : undefined));
  if (stage.kind === 'new' || stage.kind === 'investigating') return undefined;
  return report ?? findingsOf(stage.task);
}

/** What to do next, or how it's going: the one place on the page that changes as Claude works. */
function NextStep({ projectId, issue, stage }: { projectId: string; issue: GhIssueFull; stage: IssueStage }) {
  const a = useIssueActions();
  const [fixing, setFixing] = useState(false);
  const fix = async (): Promise<void> => {
    setFixing(true);
    await a.fix(projectId, n);
    setFixing(false);
  };
  const n = issue.number;
  const ws = useApp((st) => (stage.kind === 'investigating' || stage.kind === 'investigated' || stage.kind === 'fixing' ? findWorkspace(st.projects, stage.ws) : undefined));
  const found = useFindings(stage);
  // Stopped while fixing: what it said (why there's no pull request).
  const said = useApp((st) => (stage.kind === 'fixing' && !stage.working ? lastReport(st.log, `ws:${stage.ws}`) : undefined));

  // Nothing under way yet: hand it to Claude (the composer), the way a project's home starts work.
  if (stage.kind === 'new' || stage.kind === 'task') return <IssueComposer projectId={projectId} number={n} {...(stage.kind === 'task' ? { task: stage.task } : {})} />;

  const task = stage.task;
  const taskButton = (
    <Button size="small" icon="task" onClick={() => a.openTask(task.id)}>
      Open {task.key}
    </Button>
  );
  const chatButton = (primary: boolean) =>
    ws ? (
      <Button size="small" variant={primary ? 'primary' : 'plain'} icon="chat" onClick={() => a.openWorktree(ws.id)}>
        Open the Conversation
      </Button>
    ) : null;
  const where = ws ? (
    <span className={t.nextInfo}>
      in <span className={t.mono}>{ws.name}</span>
    </span>
  ) : null;

  if (stage.kind === 'investigating') {
    return (
      <Status icon={<LiveDot />} title="The agent is investigating" where={where} tone="claude" text={`Finding out why it happens and reproducing it. What it finds goes into ${task.key}’s brief; nothing is fixed yet.`}>
        <div className={s.statusActions}>
          {chatButton(true)}
          {taskButton}
        </div>
      </Status>
    );
  }

  if (stage.kind === 'investigated') {
    return (
      <Status icon={<Icon name="search" size={13} />} title="The agent investigated" where={where} tone="info" text={found ? undefined : 'Its report is in the conversation.'}>
        {found ? <Report text={found} /> : null}
        <div className={s.statusActions}>
          <Button variant="primary" size="small" icon="wrench" disabled={fixing} onClick={() => void fix()}>
            {fixing ? 'Asking the agent…' : 'Fix It'}
          </Button>
          <Tip label={`In the same worktree, with a pull request that closes #${n}`}>
            <span className={s.statusHint}>In the same worktree, with a pull request that closes #{n}</span>
          </Tip>
          {chatButton(false)}
          {taskButton}
        </div>
      </Status>
    );
  }

  if (stage.kind === 'fixing') {
    return (
      <Status
        icon={stage.working ? <LiveDot /> : <Icon name="wrench" size={13} />}
        title={stage.working ? 'The agent is fixing it' : 'The agent stopped before a pull request'}
        where={where}
        tone="claude"
        text={stage.working ? `Its pull request closes #${n} when it merges.` : said ? undefined : 'See what it said in the conversation: it may need you, or it may not be a bug.'}
      >
        {said ? <Report text={said} /> : null}
        <div className={s.statusActions}>
          {chatButton(true)}
          {taskButton}
        </div>
      </Status>
    );
  }

  if (stage.kind === 'review') {
    const pr = task.pr;
    return (
      <Status icon={<StatusIcon status="in_review" size={13} />} title={pr ? 'Its pull request is open' : 'In review'} tone="info" text={`Merging it closes #${n} and finishes ${task.key}.`}>
        <div className={s.statusActions}>
          {pr ? (
            <Button variant="primary" size="small" icon="pr" onClick={() => a.openOnGitHub(pr.url)}>
              Open Pull Request #{pr.number}
            </Button>
          ) : null}
          {pr ? <PrChip pr={pr} /> : null}
          <span className={t.grow} />
          {taskButton}
        </div>
      </Status>
    );
  }

  return (
    <Status icon={<StatusIcon status={task.status} size={13} />} title={task.status === 'done' ? `Done in ${task.key}` : `${task.key} was canceled`} tone={task.status === 'done' ? 'ok' : 'muted'} text={task.status === 'done' ? (issue.state === 'open' ? 'Its pull request closes the issue on GitHub when it merges, or close it there.' : undefined) : 'Reopen it on its page to work on the issue again.'}>
      <div className={s.statusActions}>
        {task.pr ? <PrChip pr={task.pr} /> : null}
        <span className={t.grow} />
        {taskButton}
      </div>
    </Status>
  );
}

/** How it's going, in a soft card: what Claude is at, where, and what you can do. */
function Status({ icon, title, where, tone, text, children }: { icon: React.ReactNode; title: string; where?: React.ReactNode; tone: 'claude' | 'info' | 'ok' | 'muted'; text?: string; children: React.ReactNode }) {
  return (
    <section className={cx(s.status, s[`tone_${tone}`])} aria-label={title} data-testid="issue-status">
      <div className={s.statusHead}>
        <span className={s.statusIcon}>{icon}</span>
        <strong>{title}</strong>
        {where}
      </div>
      {text ? <p className={s.statusText}>{text}</p> : null}
      {children}
    </section>
  );
}

/** What Claude said (its report, or the task's context), folded when it's long. */
function Report({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 900 || text.split('\n').length > 16;
  return (
    <>
      <div className={cx(s.findings, long && !open && s.findingsFolded)}>
        <Markdown text={text} paths tasks />
      </div>
      {long ? (
        <button type="button" className={s.findingsMore} onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Show Less' : 'Show All'}
        </button>
      ) : null}
    </>
  );
}

/** The issue's description or a comment: who, when, and what they wrote. */
function Post({ author, at, what, body, url }: { author: string | undefined; at: number; what: string; body: string; url: string }) {
  const actions = useActions();
  return (
    <article className={s.post}>
      <header className={s.postHead}>
        <Avatar name={author ?? '?'} id={`gh:${author ?? ''}`} size={20} />
        <strong>{author ?? 'Someone'}</strong>
        <span>
          {what} {agoWords(at)}
        </span>
        <span className={t.grow} />
        <Tip label="Open on GitHub">
          <button type="button" className={s.postLink} aria-label="Open on GitHub" onClick={() => actions.openLink({ kind: 'url', url })}>
            <Icon name="external" size={11} />
          </button>
        </Tip>
      </header>
      <div className={s.postBody}>{body.trim() ? <Markdown text={body} html /> : <p className={s.none}>No description.</p>}</div>
    </article>
  );
}

/** The right column: the issue's facts, and its task. */
function Properties({ repo, issue, stage }: { repo: GitHubRepo; issue: GhIssueFull; stage: IssueStage }) {
  const a = useIssueActions();
  const task = stage.kind === 'new' ? undefined : stage.task;
  const state = stateOf(issue);
  return (
    <aside className={t.props} aria-label="Properties">
      <Prop label="State">
        <span className={cx(t.propStatic, s.propState, s[`propState_${state.tone}`])}>
          <IssueStateIcon issue={issue} size={13} />
          {state.label}
        </span>
      </Prop>
      <Prop label="Task">
        {task ? (
          <button type="button" className={t.propValue} onClick={() => a.openTask(task.id)}>
            <StatusIcon status={task.status} />
            <span className={t.ellipsis}>{task.key}</span>
          </button>
        ) : (
          <span className={t.propStatic}>None yet</span>
        )}
      </Prop>
      <Prop label="Labels">
        <div className={t.propLabels}>{issue.labels.length ? issue.labels.map((l) => <GhLabelChip key={l.name} label={l} />) : <span className={t.propStatic}>None</span>}</div>
      </Prop>
      <Prop label="Assignees">
        <span className={t.propStatic}>{issue.assignees.length ? issue.assignees.join(', ') : 'No one'}</span>
      </Prop>
      <div className={t.propsRule} />
      <Prop label="Opened" quiet>
        <span className={t.propStatic}>{agoWords(issue.createdAt)}</span>
      </Prop>
      <Prop label="Updated" quiet>
        <span className={t.propStatic}>{agoWords(issue.updatedAt)}</span>
      </Prop>
      {issue.closedAt ? (
        <Prop label="Closed" quiet>
          <span className={t.propStatic}>{agoWords(issue.closedAt)}</span>
        </Prop>
      ) : null}
      <Prop label="GitHub" quiet>
        <Tip label={`Open #${issue.number} on GitHub`}>
          <button type="button" className={t.propValue} onClick={() => a.openOnGitHub(issue.url)}>
            <span className={cx(t.mono, t.ellipsis)}>
              {repoSlug(repo)}#{issue.number}
            </span>
            <Icon name="external" size={11} />
          </button>
        </Tip>
      </Prop>
    </aside>
  );
}

function Prop({ label, children, quiet }: { label: string; children: React.ReactNode; quiet?: boolean }) {
  return (
    <div className={cx(t.prop, quiet && t.propStaticRow)}>
      <span className={t.propLabel}>{label}</span>
      <div className={t.propControl}>{children}</div>
    </div>
  );
}
