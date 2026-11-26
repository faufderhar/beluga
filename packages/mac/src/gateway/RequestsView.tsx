import { useMemo, useState } from 'react';
import { type TaskView, isFinal, oneLine, stateLabel, stateTone, targetLabel } from '@beluga/core/gateway/model.js';
import { Select } from '../components/Select.js';
import { Avatar, Button, Dot, Empty, Segmented, cx } from '../components/ui.js';
import { useApi, useApp, useBeluga } from '../lib/beluga.js';
import { TaskCard } from './TaskCard.js';
import s from './gateway.module.css';

/**
 * Requests: tasks between Claudes in one place. Sent (what you and your Claude asked of others)
 * and Received (what others' Claudes asked of yours), newest first; a row opens into its card.
 * Your own "Ask me for…" note (what friends' Claudes see) and asking someone's Claude yourself.
 */

type Tab = 'sent' | 'received';

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

const needsYou = (t: TaskView): boolean => (t.direction === 'sent' && t.state === 'confirm') || (t.direction === 'received' && t.state === 'awaiting_approval');

/** Still open: waiting for you or on its way. Answered ones (done, declined, failed) are tucked away. */
const pending = (t: TaskView): boolean => !isFinal(t.state);

/** How many tasks wait for you (the sidebar's badge). */
export const waitingForYou = (tasks: readonly TaskView[]): number => tasks.filter(needsYou).length;

function Row({ task, open, onToggle }: { task: TaskView; open: boolean; onToggle: () => void }) {
  const tone = stateTone(task);
  const who = task.direction === 'sent' ? targetLabel(task) : `${task.peerName}${task.by === 'agent' ? '’s agent' : ''}`;
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={`${task.direction === 'sent' ? 'To' : 'From'} ${who}: ${oneLine(task.ask, 80)}, ${stateLabel(task)}`}
        className={cx(s.row, open && s.rowOn)}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <Avatar name={task.peerName} id={task.peerId} claude={task.kind === 'ask'} agent={task.kind === 'ask' ? task.result?.agent : undefined} size={20} />
        <span className={s.rowWho}>{who}</span>
        <span className={s.rowAsk}>{task.kind === 'run' && task.command ? `$ ${task.command}` : oneLine(task.ask, 140)}</span>
        <span className={`${s.status} ${s[`tone_${tone}`]}`}>
          <Dot tone={tone === 'claude' ? 'claude' : tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : tone === 'error' ? 'error' : 'muted'} live={!isFinal(task.state) && task.state !== 'confirm'} />
          {stateLabel(task)}
        </span>
        <span className={s.rowWhen}>{ago(task.createdAt, Date.now())}</span>
      </div>
      {open ? (
        <div className={s.detail}>
          <TaskCard task={task} />
        </div>
      ) : null}
    </>
  );
}

/** Your "Ask me for…" note: what friends' Claudes see when they look for who can help. */
function Note() {
  const api = useApi();
  const { client } = useBeluga();
  const saved = useApp((st) => st.gateway.note);
  const [text, setText] = useState<string | undefined>();
  const value = text ?? saved;
  const save = (): void => {
    if (text === undefined || text === saved) return;
    void api.gateway
      .setNote(text)
      .then(() => {
        setText(undefined);
        client.store.dispatch({ type: 'toast', text: 'Saved. Friends’ agents see it on your card', level: 'success' });
      })
      .catch((err: unknown) => client.store.dispatch({ type: 'toast', text: `Couldn't save it: ${message(err)}`, level: 'error' }));
  };
  return (
    <label className={s.note}>
      <span>Ask me for</span>
      <input
        aria-label="Ask me for"
        placeholder="what your agent is good for here (friends’ agents see this)"
        value={value}
        maxLength={280}
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === 'Enter' && save()}
      />
    </label>
  );
}

/** Ask someone's Claude yourself (it goes straight to them: you're the one asking). */
function Compose({ onDone }: { onDone: () => void }) {
  const api = useApi();
  const { client } = useBeluga();
  const people = useApp((st) => {
    const self = st.selfId;
    const friends = st.network.enabled ? st.network.friends.map((f) => ({ id: f.peerId, name: f.name })) : [];
    const room = st.peers.filter((p) => p.peerId !== self && !p.guest && !friends.some((f) => f.id === p.peerId)).map((p) => ({ id: p.peerId, name: p.name }));
    return JSON.stringify([...friends, ...room]);
  });
  const list = useMemo(() => JSON.parse(people) as Array<{ id: string; name: string }>, [people]);
  const [to, setTo] = useState(list[0]?.id ?? '');
  const [ask, setAsk] = useState('');
  const send = (): void => {
    if (!to || !ask.trim()) return;
    void api.gateway
      .ask(to, ask.trim())
      .then(onDone)
      .catch((err: unknown) => client.store.dispatch({ type: 'toast', text: `Couldn't ask: ${message(err)}`, level: 'error' }));
  };
  if (!list.length) return <div className={s.compose}>Nobody to ask yet: add a friend, or invite someone to your room.</div>;
  return (
    <div className={s.compose} role="group" aria-label="Ask someone's agent">
      <div className={s.composeRow}>
        <span>To</span>
        <Select label="Whose agent" value={to} onChange={setTo} options={list.map((p) => ({ value: p.id, label: `${p.name}’s agent`, icon: <Avatar name={p.name} id={p.id} size={16} /> }))} />
      </div>
      <textarea className={s.edit} aria-label="What to ask" placeholder="What should their agent do? They see only this." value={ask} onChange={(e) => setAsk(e.target.value)} autoFocus />
      <div className={s.actions}>
        <Button size="small" variant="primary" disabled={!ask.trim()} onClick={send}>
          Ask
        </Button>
        <Button size="small" variant="quiet" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function RequestsView() {
  const gateway = useApp((st) => st.gateway);
  const [tab, setTab] = useState<Tab>(() => (gateway.tasks.some((t) => t.direction === 'received' && t.state === 'awaiting_approval') ? 'received' : 'sent'));
  const [open, setOpen] = useState<string | undefined>();
  const [composing, setComposing] = useState(false);
  const [answered, setAnswered] = useState(false);
  if (!gateway.enabled) {
    return <Empty icon="hand" title="Requests need the Beluga app" detail="Tasks between agents run in the Beluga app's daemon." />;
  }
  const mine = gateway.tasks.filter((t) => t.direction === tab);
  const done = mine.filter((t) => !pending(t)).length;
  const list = (answered ? mine : mine.filter(pending)).slice().reverse();
  const count = (d: Tab): number => gateway.tasks.filter((t) => t.direction === d && pending(t)).length;
  return (
    <div className={s.page}>
      <div className={s.inner}>
        <div className={s.bar}>
          <Segmented<Tab> size="small"
            label="Requests"
            value={tab}
            onChange={(v) => {
              setTab(v);
              setOpen(undefined);
            }}
            options={[
              { value: 'sent', label: `Sent${count('sent') ? ` · ${count('sent')}` : ''}` },
              { value: 'received', label: `Received${count('received') ? ` · ${count('received')}` : ''}` },
            ]}
          />
          <span className={s.grow} />
          {composing ? null : (
            <Button size="small" icon="claude" onClick={() => setComposing(true)}>
              Ask Someone’s Agent…
            </Button>
          )}
        </div>
        <Note />
        {composing ? (
          <Compose
            onDone={() => {
              setComposing(false);
              setTab('sent');
            }}
          />
        ) : null}
        <div className={s.list} role="list" aria-label={tab === 'sent' ? 'Sent requests' : 'Received requests'}>
          {list.length ? (
            list.map((t) => (
              <div role="listitem" key={t.id}>
                <Row task={t} open={open === t.id || (open === undefined && needsYou(t) && list.find(needsYou)?.id === t.id)} onToggle={() => setOpen(open === t.id ? '' : t.id)} />
              </div>
            ))
          ) : (
            <div className={s.empty}>
              {done ? 'Nothing waiting. Everything here has been answered.' : tab === 'sent' ? 'Nothing sent yet. Ask your agent to get something from a friend’s agent (“ask bob to run the tests”).' : 'Nothing received yet. When a friend’s agent asks yours for something, it shows here.'}
            </div>
          )}
        </div>
        {done ? (
          <Button size="small" variant="quiet" onClick={() => setAnswered(!answered)}>
            {answered ? 'Hide answered' : `Show answered · ${done}`}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
