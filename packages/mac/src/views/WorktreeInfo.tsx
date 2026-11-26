import { baseName } from '@beluga/shared/os-path.js';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { AgentOrigin } from '@beluga/core/claude-code/model.js';
import type { WorktreeInfo } from '@beluga/core/other-worktrees.js';
import { formatBytes } from '@beluga/shared/format.js';
import { type WorktreeSource, sourceFromPath } from '@beluga/workspaces/origin.js';
import type { Workspace } from '@beluga/workspaces/types.js';
import { Alert } from '../components/Alert.js';
import { Icon, type IconName } from '../components/Icon.js';
import { Button, Tip } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { toast, useApi, useApp, useBeluga, useMachine } from '../lib/beluga.js';
import { showWorktreeFolder } from '../lib/remote-open.js';
import { revealThereLabel } from '@beluga/machines/open.js';
import { setWorktreeFlag, useWorktreeInfo } from './worktree-info-state.js';
import s from './worktree-info.module.css';
import { LivePanel } from '../claude-code/Live.js';
import { openFolderLabel } from '../lib/os-words.js';

/**
 * What a worktree made outside Beluga is (another app's, Claude Code's, a script's): where it
 * is, its branch and state, the Claude Code conversations that ran in it, and what you can do
 * with it. Shown instead of an empty chat, and from "About This Worktree" over one with a
 * conversation. Another app is never named: the worktree's name and location say enough.
 */

/** Claude's mark for one Claude made; a branch for the rest. */
const iconOf = (source: WorktreeSource): IconName => (source === 'claude' ? 'claude' : 'branch');
const MADE_OUTSIDE = 'Made outside Beluga';
const MADE_OUTSIDE_DETAIL = 'Made by hand, by a script or by another app.';

const day = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const when = (ms: number): string => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function ago(ms: number): string {
  const d = Math.floor((Date.now() - ms) / 86_400_000);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 45) return `${d} days ago`;
  const m = Math.round(d / 30);
  return m < 18 ? `${m} months ago` : `${Math.round(d / 365)} years ago`;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={s.field}>
      <dt>{label}</dt>
      <dd className="selectable">{children}</dd>
    </div>
  );
}

/**
 * Asks before removing a worktree made outside Beluga; with uncommitted changes the button says what's lost.
 * Confirming closes it at once: the removal carries on in the background and says how it went in a toast.
 */
export function RemoveWorktreeAlert({ ws, info, onDone, onCancel }: { ws: Workspace; info?: WorktreeInfo; onDone: (removed: boolean) => void; onCancel: () => void }) {
  const api = useApi();
  const { client } = useBeluga();
  const changed = info?.changed ?? ws.status?.changed ?? 0;
  const branch = info?.branch ?? ws.branch;
  // Another app made it and may still use it.
  const anotherApp = (info?.origin.source ?? sourceFromPath(ws.path)) === 'conductor';
  const go = (): void => {
    void api.workspaces.removeOther(ws.id, changed > 0).catch((err: unknown) => toast(client, `Couldn't remove ${ws.name}: ${err instanceof Error ? err.message : String(err)}`, 'error'));
    onDone(true);
  };
  return (
    <Alert
      icon="archive"
      tone={changed > 0 ? 'danger' : 'caution'}
      title={`Remove “${ws.name}”?`}
      message={
        <>
          <p>
            Beluga deletes its folder and git’s record of it.{' '}
            {branch ? (
              <>
                The branch <strong>{branch}</strong> stays, so nothing committed is lost.
              </>
            ) : (
              'It isn’t on a branch, so commits only it has may be hard to find later.'
            )}
          </p>
          {changed > 0 ? (
            <p>
              <strong>It has {plural(changed, 'uncommitted change')}.</strong> They’ll be lost.
            </p>
          ) : null}
          {anotherApp ? <p>If you still use it in the app that made it, remove it there instead: that app would show it as missing.</p> : null}
        </>
      }
      confirm={{ label: changed > 0 ? 'Remove Anyway' : 'Remove', destructive: true, onClick: go }}
      onCancel={onCancel}
    />
  );
}

function Conversations({ ws, info }: { ws: Workspace; info: WorktreeInfo }) {
  const api = useApi();
  const talked = useApp((st) => st.log.some((l) => l.channel === `ws:${ws.id}` && !/^(t-\d+|import-)/.test(l.id)));
  if (!info.conversations.length) {
    return (
      <p className={s.quiet}>
        No Claude Code conversation ran in this folder, so there’s nothing to continue.
        {info.creator?.cwd ? ` The one that made it ran in ${info.creator.cwd}.` : ''}
      </p>
    );
  }
  return (
    <ul className={s.convos} aria-label="Claude Code conversations">
      {info.conversations.map((c) => (
        <li key={c.sessionId} className={s.convo}>
          <Icon name="chat" size={14} className={s.convoIcon} />
          <span className={s.convoText}>
            <span className={s.convoTitle}>{c.title}</span>
            <span className={s.convoWhen}>Last active {when(c.lastModified)}</span>
          </span>
          <Button
            size="small"
            disabled={talked || Boolean(ws.sessionId)}
            onClick={() => {
              setWorktreeFlag('about', ws.id, false);
              void api.workspaces.showConversation(ws.id, c.sessionId);
            }}
          >
            Show
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** Size on disk: measured on request (it walks every worktree's folder). */
function useSize(id: string): number | undefined {
  const api = useApi();
  const size = useApp((st) => st.disk[id]);
  const asked = useRef(false);
  useEffect(() => {
    if (size !== undefined || asked.current) return;
    asked.current = true;
    void api.workbench.measureDisk().catch(() => undefined);
  }, [api, size]);
  return size;
}

/**
 * `agent`: a sub-agent's own worktree whose agent Claude Code no longer has (no conversation to
 * start in it); `origin`, who started it, when Claude Code's files still say.
 */
export function WorktreeInfoPage({ ws, agent, origin }: { ws: Workspace; agent?: boolean; origin?: AgentOrigin }) {
  const actions = useActions();
  const api = useApi();
  const { client } = useBeluga();
  // On a computer's page, its folder's path is copied instead (BLG-794).
  const machine = useMachine();
  const statusKey = `${ws.status?.changed ?? '-'}:${ws.status?.ahead ?? '-'}:${ws.status?.behind ?? '-'}:${ws.branch ?? ''}`;
  const { info, loading, error } = useWorktreeInfo(ws.id, statusKey);
  const hasChat = useApp((st) => st.log.some((l) => l.channel === `ws:${ws.id}`));
  const size = useSize(ws.id);
  const [removing, setRemoving] = useState(false);
  const source = info?.origin.source ?? sourceFromPath(ws.path);
  const start = (): void => {
    setWorktreeFlag('started', ws.id, true);
    setWorktreeFlag('about', ws.id, false);
    setTimeout(() => document.dispatchEvent(new CustomEvent('beluga:focus-composer')), 30);
  };
  return (
    <div className={s.page} data-testid="worktree-info">
      <div className={s.inner}>
        <header className={s.head}>
          <span className={s.badge} aria-hidden="true">
            <Icon name={agent ? 'bot' : iconOf(source)} size={22} />
          </span>
          <div className={s.headText}>
            <h1 className={s.title}>{origin?.description ?? ws.name}</h1>
            <p className={s.origin}>{origin ? `Sub-agent · started by “${origin.sessionTitle ?? 'a Claude Code session'}”${origin.sessionCwd ? ` in ${baseName(origin.sessionCwd)}` : ''}` : (info?.origin.label ?? MADE_OUTSIDE)}</p>
          </div>
          {hasChat ? (
            <Button size="small" variant="quiet" icon="back" onClick={() => setWorktreeFlag('about', ws.id, false)}>
              Back to Conversation
            </Button>
          ) : null}
        </header>
        <p className={s.lead}>{agent ? 'A sub-agent made this worktree to work in. It finished a while ago and Claude Code no longer has what it did step by step; its changes are in the right panel.' : (info?.origin.detail ?? MADE_OUTSIDE_DETAIL)}</p>
        <LivePanel workspaceId={ws.id} />
        {info?.stale ? (
          <p className={s.stale}>
            <Icon name="check" size={13} /> Safe to remove: {info.staleText?.toLowerCase()}.
          </p>
        ) : null}
        {info?.missing ? (
          <p className={s.warn}>
            <Icon name="alert" size={13} /> Its folder is gone. Git still lists it; removing it tidies that up.
          </p>
        ) : null}

        <div className={s.actions}>
          {!info?.missing && !agent ? (
            <Button size="small" variant="primary" icon="chat" onClick={start}>
              Start a Conversation Here
            </Button>
          ) : null}
          {!info?.missing ? (
            <Button size="small" icon="folder" onClick={() => void showWorktreeFolder(client, ws.id)}>
              {machine ? revealThereLabel('folder') : openFolderLabel()}
            </Button>
          ) : null}
          {!info?.missing ? (
            <Button size="small" icon="terminal" onClick={() => actions.run({ type: 'open_ws', id: ws.id, tab: 'terminal' })}>
              Open in Terminal
            </Button>
          ) : null}
          <span className={s.flex} />
          <Button size="small" variant="danger" icon="archive" onClick={() => setRemoving(true)}>
            Remove Worktree…
          </Button>
        </div>

        <section className={s.card} aria-label="About this worktree">
          <dl className={s.fields}>
            <Field label="Branch">{info ? (info.branch ?? 'None (detached)') : (ws.branch ?? '…')}</Field>
            <Field label="Based on">{info?.base ?? ws.base ?? '…'}</Field>
            <Field label="Made">{info?.createdAt ? `${day(info.createdAt)} (${ago(info.createdAt)})` : loading ? '…' : 'Unknown'}</Field>
            <Field label="Last commit">
              {info?.lastCommit ? (
                <>
                  {ago(info.lastCommit.at)} · <span className={s.subject}>{info.lastCommit.subject}</span>
                </>
              ) : loading ? (
                '…'
              ) : (
                'None'
              )}
            </Field>
            <Field label="Compared with base">{info ? `${plural(info.ahead, 'commit')} ahead · ${info.behind} behind${info.merged ? ' · all merged' : ''}` : '…'}</Field>
            <Field label="Uncommitted">{info ? (info.changed ? plural(info.changed, 'file') : 'Nothing') : '…'}</Field>
            <Field label="Size on disk">{size !== undefined ? formatBytes(size) : 'Measuring…'}</Field>
            {info?.conductor?.prTitle ? <Field label="Pull request">{info.conductor.prTitle}</Field> : null}
            {info?.creator ? (
              <Field label="Made by">
                Claude Code in “{info.creator.title ?? info.creator.sessionId.slice(0, 8)}”{info.creator.at ? `, ${day(info.creator.at)}` : ''}
                {info.creator.cwd ? ` (ran in ${info.creator.cwd})` : ''}
              </Field>
            ) : null}
            <Field label="Folder">
              <Tip label="Copy path">
                <button type="button" className={s.path} onClick={() => void navigator.clipboard?.writeText(ws.path).then(() => toast(client, 'Copied the path', 'success'))}>
                  {ws.path}
                </button>
              </Tip>
            </Field>
          </dl>
        </section>

        <section className={s.section}>
          <h2 className={s.h2}>{info?.conversations.length ? `Claude Code conversations (${info.conversations.length})` : 'Claude Code conversations'}</h2>
          {info ? <Conversations ws={ws} info={info} /> : error ? <p className={s.quiet}>Couldn’t look: {error}</p> : <p className={s.quiet}>Looking…</p>}
        </section>
      </div>
      {removing ? (
        <RemoveWorktreeAlert
          ws={ws}
          {...(info ? { info } : {})}
          onCancel={() => setRemoving(false)}
          onDone={(removed) => {
            setRemoving(false);
            if (removed) actions.run({ type: 'close_tab', id: ws.id });
          }}
        />
      ) : null}
    </div>
  );
}

/** Above a conversation shown from a worktree made outside Beluga: what it is, and its info page. */
export function OtherWorktreeBanner({ ws }: { ws: Workspace }) {
  return (
    <div className={s.banner}>
      <Icon name={iconOf(sourceFromPath(ws.path))} size={13} />
      <span className={s.bannerText}>A worktree made outside Beluga. It becomes one of yours once you send a message here.</span>
      <Button size="small" variant="quiet" onClick={() => setWorktreeFlag('about', ws.id, true)}>
        About This Worktree
      </Button>
    </div>
  );
}
