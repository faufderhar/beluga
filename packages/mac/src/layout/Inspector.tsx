import type { ReactNode } from 'react';
import { findWorkspace, stateOf } from '@beluga/ui/workspace-models.js';
import { formatTokens } from '@beluga/ui/work-models.js';
import { formatBytes } from '@beluga/shared/format.js';
import { cacheHitOf, contextPct, contextTone, formatTokenCount } from '@beluga/shared/context-usage.js';
import { contextFacts } from '@beluga/ui/context-facts.js';
import { speedWords } from '@beluga/shared/local-endpoints.js';
import { unreadCount } from '@beluga/core/work-store.js';
import { issuesOfWorkspace } from '@beluga/core/board/model.js';
import { noticeAgo, noticeLook } from '@beluga/ui/notice-models.js';
import { Icon } from '../components/Icon.js';
import { Avatar, Button, Dot, Tip } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApi, useApp, useBeluga, useMachine } from '../lib/beluga.js';
import { showWorktreeFolder } from '../lib/remote-open.js';
import { revealThereLabel } from '@beluga/machines/open.js';
import { openExternal } from '../lib/system.js';
import { Switch } from '../dialogs/settings-controls.js';
import { openPerson } from '../dialogs/native/PersonPopover.js';
import r from '../dialogs/native/room.module.css';
import { ConversationDetails } from '../network/ConversationInspector.js';
import { StatusIcon } from '../tasks/marks.js';
import { ClaudeCodeInspector } from '../claude-code/Live.js';
import { teammatesOf } from '@beluga/core/team/model.js';
import { shownState } from '../network/net-model.js';
import { openDm } from '../network/use-net.js';
import { sameDeep, sameFields } from '../lib/stable.js';
import s from './Inspector.module.css';
import { fileManager } from '../lib/os-words.js';
import { ThreadsSection } from '../threads/ThreadsSection.js';
import { Panel } from './inspector-parts.js';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={s.field}>
      <span className={s.fieldLabel}>{label}</span>
      <span className={s.fieldValue}>{children}</span>
    </div>
  );
}

/** Everything waiting on you, in one place, wherever you are. */
function NeedsYou() {
  const api = useApi();
  const actions = useActions();
  const state = useApp((st) => ({ approvals: st.approvals, questions: st.questions, projects: st.projects, shared: st.shared }), sameFields);
  const { approvals, questions } = state;
  if (!approvals.length && !questions.length) return null;
  const place = (channel: string): string => {
    if (channel === 'room') return 'the chat';
    const id = channel.slice(3);
    return findWorkspace(state.projects, id)?.name ?? state.shared.find((w) => w.id === id)?.name ?? 'a workspace';
  };
  return (
    <Panel title="Needs you">
      {approvals.map((a) => (
        <div key={a.id} className={s.need}>
          <div className={s.needTitle}>
            <Dot tone="warn" />
            {a.title}
          </div>
          <div className={s.needActions}>
            <Button size="small" variant="primary" onClick={() => void api.host.answerApproval('yes', a.id)}>
              Allow
            </Button>
            <Button size="small" variant="quiet" onClick={() => void api.host.answerApproval('no', a.id)}>
              Deny
            </Button>
          </div>
        </div>
      ))}
      {questions.map((q) => (
        <button
          key={q.qid}
          type="button"
          className={s.needLink}
          onClick={() => {
            const id = q.channel.slice(3);
            const shared = state.shared.find((w) => w.id === id);
            if (q.channel === 'room') actions.run({ type: 'view', view: { kind: 'room' } });
            else if (shared) actions.run({ type: 'open_shared', owner: shared.owner, id, tab: 'chat' });
            else actions.run({ type: 'open_ws', id });
          }}
        >
          <Icon name={q.question.kind === 'plan' ? 'wand' : 'spark'} size={12} />
          {q.question.kind === 'plan' ? 'A plan to approve' : 'A question'} in {place(q.channel)}
          <Icon name="chevronRight" size={10} />
        </button>
      ))}
    </Panel>
  );
}

/** The board's tasks this worktree is doing or carrying: each opens its page, and the board opens filtered to them. */
function WorkspaceTasks({ id, projectId }: { id: string; projectId: string }) {
  const actions = useActions();
  const board = useApp((st) => st.board);
  if (!board.enabled) return null;
  const tasks = issuesOfWorkspace(board, id);
  const toBoard = (
    <Tip label="The board, with only this worktree’s tasks">
      <Button size="small" variant="quiet" icon="task" onClick={() => actions.run({ type: 'view', view: { kind: 'tasks', projectId, worktree: id } })}>
        Board
      </Button>
    </Tip>
  );
  return (
    <Panel title={tasks.length > 1 ? `Tasks · ${tasks.length}` : 'Tasks'} action={toBoard}>
      {tasks.length ? (
        tasks.map((t) => (
          <button key={t.id} type="button" className={s.taskLink} title={`${t.key} ${t.title}`} onClick={() => actions.run({ type: 'view', view: { kind: 'task', id: t.id } })}>
            <StatusIcon status={t.status} size={13} />
            <span className={s.taskKey}>{t.key}</span>
            <span className={s.taskTitle}>{t.title}</span>
          </button>
        ))
      ) : (
        <div className={s.dim}>No task yet. Your agent links the ones it opens or moves from here.</div>
      )}
    </Panel>
  );
}

/** The people you work on this project with (BLG-299): each opens your chat with them. */
function ProjectTeam({ projectId }: { projectId: string }) {
  const { client } = useBeluga();
  const enabled = useApp((st) => st.team.enabled);
  const mates = useApp((st) => teammatesOf(st.team, projectId), sameDeep);
  const online = useApp((st) => mates.filter((m) => st.network.friends.some((f) => f.peerId === m.peerId && shownState(f) === 'online')).map((m) => m.peerId), sameDeep);
  if (!enabled && !mates.length) return null;
  return (
    <Panel title={mates.length > 1 ? `Team · ${mates.length}` : 'Team'}>
      {mates.length ? (
        mates.map((m) => (
          <Tip key={m.peerId} label={`Your chat with ${m.name}`}>
            <button type="button" className={`${s.person} ${r.personRow}`} onClick={() => openDm(client, m.peerId)}>
              <Avatar name={m.name} id={m.peerId} size={18} />
              <span className={s.personName}>{m.name}</span>
              {online.includes(m.peerId) ? (
                <span className={s.dim}>
                  <Dot tone="ok" /> online
                </span>
              ) : null}
              <Icon name="chat" size={12} />
            </button>
          </Tip>
        ))
      ) : (
        <div className={s.dim}>Only you. Team up with a friend who has this repository to share its tasks.</div>
      )}
    </Panel>
  );
}

function WorkspaceDetails({ id }: { id: string }) {
  const api = useApi();
  const actions = useActions();
  const { ui, client } = useBeluga();
  // On a computer's page, its folder's path is copied instead (BLG-794).
  const machine = useMachine();
  // What this panel shows, worked out from the shared state: drawn again only when part of it changes.
  const state = useApp(
    (full) => {
      const ws = findWorkspace(full.projects, id);
      return {
        ws,
        st: ws ? stateOf(full, ws, 0) : undefined,
        pr: full.prs[id],
        ctx: full.context[`ws:${id}`],
        setup: full.setup[id],
        members: full.members[id],
        disk: full.disk[id],
        projects: full.projects,
        peers: full.peers,
        friends: full.network.friends,
        contextMeter: full.prefs.contextMeter,
      };
    },
    (a, b) => sameDeep(a, b, 2),
  );
  const facts = useApp(
    (full) => contextFacts(full, `ws:${id}`),
    (a, b) => a.modelLabel === b.modelLabel && a.window === b.window && a.runtime === b.runtime,
  );
  const { ws, st, pr, ctx, setup } = state;
  if (!ws || !st) return null;
  const members = Object.entries(state.members ?? {});
  const tokens = ws.usage ? ws.usage.input + ws.usage.output + ws.usage.cacheWrite : 0;
  const cache = cacheHitOf(ws.usage);
  const project = state.projects.find((p) => p.id === ws.projectId);
  return (
    <>
      <ThreadsSection id={id} />
      <Panel title="This workspace">
        <Field label="State">
          <span className={s[`tone_${st.tone}`]}>{st.label}</span>
        </Field>
        {ws.branch ? <Field label="Branch">{ws.branch}</Field> : null}
        {ws.base ? <Field label="From">{ws.base}</Field> : null}
        {ws.status ? (
          <Field label="Changes">
            {ws.status.changed} uncommitted · {ws.status.ahead} ahead{ws.status.behind ? ` · ${ws.status.behind} behind` : ''}
          </Field>
        ) : null}
        {ctx && state.contextMeter ? (
          <Field label="Context">
            {/* The same numbers and colours as the meter in the box you type in, named for this agent. */}
            <span className={s.meter} data-tone={contextTone(contextPct(ctx))} title={`${formatTokenCount(ctx.used)} of ${facts.window ? formatTokenCount(facts.window) : 'an unreported window'} · ${facts.modelLabel}`}>
              <span style={{ width: `${contextPct(ctx)}%` }} />
            </span>
            {ctx.compacting ? 'Compacting…' : `${contextPct(ctx)}% · ${formatTokenCount(ctx.used)} of ${facts.window ? formatTokenCount(facts.window) : 'an unreported window'} · ${facts.modelLabel}`}
          </Field>
        ) : null}
        {cache ? (
          <Field label="Cache">
            <span title={cache.detail} data-cache-hit="">{`${cache.pct}%`}</span>
          </Field>
        ) : null}
        {tokens ? <Field label="Agent">{`${formatTokens(tokens)} tokens${ws.usage?.local ? ` · ${speedWords(ws.usage.local.tps)}` : ws.usage?.cost ? ` · $${ws.usage.cost.toFixed(2)}` : ''}`}</Field> : null}
        {state.disk !== undefined ? <Field label="Disk">{formatBytes(state.disk)}</Field> : null}
        {setup ? <Field label="Setup">{setup.status === 'running' ? 'Running…' : setup.status === 'done' ? 'Done' : `Failed${setup.detail ? ` (${setup.detail})` : ''}`}</Field> : null}
        {ws.handedTo ? <Field label="Handed to">{ws.handedTo}</Field> : null}
        {ws.continuedOn ? <Field label="Continued on">{ws.continuedOn}</Field> : null}
        {ws.continuedFrom ? <Field label="Continued from">{ws.continuedFrom}</Field> : null}
        {ws.handedFrom ? <Field label="From">{ws.handedFrom}</Field> : null}
        <div className={s.buttons}>
          <Button size="small" icon="folder" onClick={() => void showWorktreeFolder(client, ws.id)}>
            {machine ? revealThereLabel('folder') : fileManager()}
          </Button>
          {project?.root ? (
            <Button size="small" icon="terminal" onClick={() => ui.openMenu({ kind: 'scripts', projectId: ws.projectId })}>
              Commands
            </Button>
          ) : null}
        </div>
      </Panel>
      {project?.root ? <WorkspaceTasks id={ws.id} projectId={ws.projectId} /> : null}
      {pr ? (
        <Panel title={`Pull request #${pr.number}`} action={<Button size="small" variant="quiet" icon="refresh" onClick={() => void api.workbench.refreshPrs(ws.id)} />}>
          <div className={s.prTitle}>{pr.title}</div>
          <Field label="Checks">
            <Dot tone={pr.checks === 'passing' ? 'ok' : pr.checks === 'failing' ? 'error' : pr.checks === 'pending' ? 'warn' : 'muted'} />
            {pr.checks}
          </Field>
          <Field label="State">{pr.state === 'OPEN' ? (pr.draft ? 'Draft' : 'Open') : pr.state === 'MERGED' ? 'Merged' : 'Closed'}</Field>
          {pr.review ? <Field label="Review">{pr.review === 'APPROVED' ? 'Approved' : pr.review === 'CHANGES_REQUESTED' ? 'Changes requested' : 'Waiting for review'}</Field> : null}
          <div className={s.buttons}>
            <Button size="small" onClick={() => void openExternal(pr.url)}>
              Open on GitHub
            </Button>
            {pr.checks === 'failing' ? (
              <Button size="small" variant="primary" onClick={() => void api.workbench.fixChecks(ws.id)}>
                Fix checks
              </Button>
            ) : null}
          </div>
        </Panel>
      ) : null}
      <ProjectTeam projectId={ws.projectId} />
      <Panel title="Working here" action={<Button size="small" variant="quiet" icon="plus" aria-label="Share this worktree" onClick={() => actions.run({ type: 'ws', id: ws.id, action: 'share' })} />}>
        {members.length ? (
          members.map(([peerId, role]) => {
            const name = state.peers.find((p) => p.peerId === peerId)?.name ?? state.friends.find((f) => f.peerId === peerId)?.name ?? 'someone';
            return (
              <button key={peerId} type="button" className={`${s.person} ${r.personRow}`} onClick={(e) => openPerson(ui, state.peers.findIndex((p) => p.peerId === peerId), e.currentTarget)}>
                <Avatar name={name} id={peerId} size={18} />
                <span className={s.personName}>{name}</span>
                <span className={s.dim}>{role === 'contribute' ? 'works here' : 'follows'}</span>
              </button>
            );
          })
        ) : (
          <div className={s.dim}>Only you. Share it to work on it together.</div>
        )}
      </Panel>
    </>
  );
}

function Room() {
  const api = useApi();
  const { ui } = useBeluga();
  const state = useApp((st) => ({ hosting: st.hosting, invite: st.invite, room: st.room, status: st.status, peers: st.peers, selfId: st.selfId, isHost: st.isHost, roomOpen: st.roomOpen }), sameFields);
  const hosting = state.hosting;
  const invite = (): void => void document.dispatchEvent(new CustomEvent('beluga:invite-room'));
  const inviteState = hosting?.phase === 'ready' || state.invite ? 'Ready to share' : hosting?.phase === 'local' ? 'Local network only' : hosting?.phase === 'failed' ? (hosting.detail ?? 'Couldn’t open remote access') : hosting ? 'Opening…' : 'Not open yet';
  return (
    <Panel
      title="Room"
      action={
        <Button size="small" variant="quiet" icon="link" onClick={invite}>
          Invite
        </Button>
      }
    >
      <Field label="Name">{state.room}</Field>
      <Field label="Status">
        <Dot tone={state.status === 'connected' ? 'ok' : state.status === 'connecting' ? 'warn' : 'error'} />
        {state.status === 'connected' ? 'Connected' : state.status === 'connecting' ? 'Connecting…' : 'Offline'}
      </Field>
      <Field label="People">
        <span className={r.avatars}>
          {state.peers.map((p, index) => (
            <Tip key={p.peerId} label={p.peerId === state.selfId ? `${p.name} (you)` : p.name}>
              <button type="button" className={r.avatarButton} aria-label={p.name} onClick={(e) => openPerson(ui, index, e.currentTarget)}>
                <Avatar name={p.name} id={p.peerId} size={20} />
              </button>
            </Tip>
          ))}
        </span>
      </Field>
      {state.isHost ? (
        <Field label="Invite">
          <Tip label="Invite someone: copy a link">
            <button type="button" className={r.link} onClick={invite}>
              {inviteState}
              <Icon name="chevronRight" size={9} />
            </button>
          </Tip>
        </Field>
      ) : null}
      {state.isHost ? (
        <Field label="New people">
          <Switch label="New people can join" on={state.roomOpen} onChange={(v) => void api.session.setRoomOpen(v)} />
          {state.roomOpen ? 'Can join' : 'Closed'}
        </Field>
      ) : null}
    </Panel>
  );
}

/** The newest unread notification; the rest are under the bell in the toolbar. */
function Inbox() {
  const { ui } = useBeluga();
  const unread = useApp((st) => unreadCount(st));
  const latest = useApp((st) => st.inbox.find((n) => !n.read));
  if (!unread || !latest) return null;
  const { tone } = noticeLook(latest);
  const show = (): void => ui.patch({ notices: true });
  return (
    <Panel
      title="Notifications"
      action={
        <Button size="small" variant="quiet" onClick={show}>
          Show all
        </Button>
      }
    >
      <button type="button" className={s.notice} onClick={show}>
        <Dot tone={tone === 'claude' ? 'claude' : tone === 'muted' ? 'info' : tone} />
        <span className={s.noticeText}>
          <span className={s.noticeTitle}>{latest.title}</span>
          <span className={s.dim}>{unread > 1 ? `and ${unread - 1} more` : (latest.body || 'New')}</span>
        </span>
        <span className={s.dim}>{noticeAgo(latest.ts)}</span>
      </button>
    </Panel>
  );
}

export function Inspector() {
  const view = useApp((st) => st.view);
  return (
    <aside className={s.inspector} aria-label="Inspector">
      <div className={s.titlebar} data-tauri-drag-region />
      <div className={s.scroll}>
        <NeedsYou />
        <ClaudeCodeInspector />
        {view.kind === 'workspace' ? (
          <WorkspaceDetails id={view.id} />
        ) : view.kind === 'conversation' ? (
          <ConversationDetails id={view.id} />
        ) : (
          <>
            {view.kind === 'project' ? <ProjectTeam projectId={view.id} /> : null}
            <Room />
          </>
        )}
        <Inbox />
      </div>
    </aside>
  );
}
