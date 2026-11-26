import { useState } from 'react';
import type { PrThread } from '@beluga/core/work-store.js';
import { Icon } from '../components/Icon.js';
import { Button, IconButton, Tip, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { toast, useApi, useApp, useBeluga } from '../lib/beluga.js';
import { showGitTrouble } from '../lib/git-trouble.js';
import { ItemCard, ThreadCard, WriteBox } from './PrConversation.js';
import { conversationCounts, timeline, usePrConversation } from './use-pr-conversation.js';
import s from './pr-conversation.module.css';

type Post = Parameters<ReturnType<typeof useApi>['workbench']['prPost']>[1];

/** Post on the PR; GitHub's "no" opens its trouble card. → whether it went. */
function usePost(wsId: string, posted: () => void): (p: Post) => Promise<boolean> {
  const api = useApi();
  return async (p) => {
    const out = await api.workbench.prPost(wsId, p);
    if (!out) return false;
    if (!out.ok) {
      showGitTrouble(wsId, out, 'none');
      return false;
    }
    posted();
    return true;
  };
}

/** A thread on the page: the card, then Reply, Ask Your Agent, and Resolve. */
function PageThread({ wsId, thread, posted }: { wsId: string; thread: PrThread; posted: () => void }) {
  const api = useApi();
  const post = usePost(wsId, posted);
  const [replying, setReplying] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <ThreadCard wsId={wsId} thread={thread}>
      {replying ? (
        <WriteBox autoFocus placeholder="Reply…" label="Reply" busyLabel="Replying…" onCancel={() => setReplying(false)} onSend={async (body) => (await post({ kind: 'reply', thread: thread.id, body })) && (setReplying(false), true)} />
      ) : (
        <div className={s.threadActions}>
          <Button size="small" icon="chat" onClick={() => setReplying(true)}>
            Reply
          </Button>
          <Tip label="Back in the chat, your agent reads the code there and addresses this comment">
            <Button size="small" icon="claude" onClick={() => void api.workbench.addressPrComments(wsId, thread.id)}>
              Ask Your Agent
            </Button>
          </Tip>
          <span className={s.grow} />
          <Button
            size="small"
            variant="quiet"
            icon={thread.resolved ? 'refresh' : 'check'}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void post({ kind: thread.resolved ? 'unresolve' : 'resolve', thread: thread.id }).finally(() => setBusy(false));
            }}
          >
            {thread.resolved ? 'Reopen' : 'Resolve'}
          </Button>
        </div>
      )}
    </ThreadCard>
  );
}

/**
 * A worktree's pull request, its conversation as a page across the center (Esc goes back to the
 * chat): what everyone said on GitHub in time order (comments, reviews, and threads on lines with
 * the code they're on), and your answers: a reply, a thread resolved, a comment on the PR.
 */
export function PrPage({ wsId }: { wsId: string }) {
  const api = useApi();
  const { client } = useBeluga();
  const actions = useActions();
  const pr = useApp((st) => st.prs[wsId]);
  const { data, error, loading, refresh } = usePrConversation(wsId, { live: true });
  const [all, setAll] = useState(false);
  if (!pr) return <div className={s.empty}>This worktree has no pull request.</div>;
  const counts = conversationCounts(data);
  const items = data ? timeline(data) : [];
  const resolved = items.filter((i) => i.kind === 'thread' && i.thread.resolved).length;
  const shown = all ? items : items.filter((i) => i.kind !== 'thread' || !i.thread.resolved);
  return (
    <div className={s.page} data-pr-page={pr.number}>
      <div className={s.pageColumn}>
        <header className={s.pageHead}>
          <div className={s.pageTitleRow}>
            <Icon name="pr" size={16} />
            <h1 className={cx(s.pageTitle, 'selectable')}>{pr.title}</h1>
            <span className={s.pageNumber}>#{pr.number}</span>
          </div>
          <div className={s.pageMeta}>
            <span>{data ? `${counts.said} ${counts.said === 1 ? 'comment' : 'comments'}${counts.open ? ` · ${counts.open} open ${counts.open === 1 ? 'thread' : 'threads'}` : ''}` : loading ? 'Reading GitHub…' : ''}</span>
            <span className={s.grow} />
            <IconButton size="small" icon="refresh" label="Read GitHub again" disabled={loading} onClick={refresh} />
            <IconButton size="small" icon="external" label="Open on GitHub" onClick={() => actions.openLink({ kind: 'url', url: pr.url })} />
            {counts.open ? (
              <Tip label="Back in the chat, your agent works through every open comment: changes the code or says why not, then commits">
                <Button size="small" variant="primary" icon="claude" onClick={() => void api.workbench.addressPrComments(wsId)}>
                  Address All With Your Agent
                </Button>
              </Tip>
            ) : null}
          </div>
        </header>
        <div className={s.pageBody}>
          {error && !data ? (
            <div className={s.problem}>
              <Icon name="alert" size={12} />
              {error}
            </div>
          ) : null}
          {data && !items.length ? <div className={s.empty}>Nobody has said anything on #{pr.number} yet.</div> : null}
          {shown.map((item) => (
            <ItemCard key={item.id} wsId={wsId} item={item} thread={(t) => <PageThread wsId={wsId} thread={t} posted={refresh} />} />
          ))}
          {resolved ? (
            <button type="button" className={s.more} onClick={() => setAll(!all)}>
              {all ? 'Hide resolved threads' : `Show ${resolved} resolved ${resolved === 1 ? 'thread' : 'threads'}`}
            </button>
          ) : null}
          {data?.more ? (
            <button type="button" className={s.more} onClick={() => actions.openLink({ kind: 'url', url: pr.url })}>
              Older comments are on GitHub <Icon name="external" size={11} />
            </button>
          ) : null}
          {data && pr.state === 'OPEN' ? (
            <div className={s.pageComment}>
              <WriteBox
                placeholder={`Comment on #${pr.number}…`}
                label="Comment"
                busyLabel="Posting…"
                onSend={async (body) => {
                  const out = await api.workbench.prPost(wsId, { kind: 'comment', body });
                  if (!out?.ok) {
                    if (out) showGitTrouble(wsId, out, 'none');
                    return false;
                  }
                  toast(client, out.message, 'success');
                  refresh();
                  return true;
                }}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
