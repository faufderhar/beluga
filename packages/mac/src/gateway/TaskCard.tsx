import { memo, useEffect, useState } from 'react';
import { type TaskView, approvalTitle, isFinal, stateLabel, stateTone, targetLabel } from '@beluga/core/gateway/model.js';
import { formatDuration } from '@beluga/shared/text.js';
import { agentLabel } from '@beluga/shared/agent-label.js';
import { agentMark } from '@beluga/shared/agent-marks.js';
import { Markdown } from '../chat/Markdown.js';
import { useNow } from '../chat/Items.js';
import { Icon } from '../components/Icon.js';
import { Avatar, Button, Dot } from '../components/ui.js';
import { revealInFinder } from '../lib/files.js';
import { useApi, useApp, useBeluga } from '../lib/beluga.js';
import { openRequest } from './request-native.js';
import { TaskStep } from './TaskStep.js';
import a from './access.module.css';
import s from './gateway.module.css';
import { fileManager, revealLabel, yourComputer } from '../lib/os-words.js';

/**
 * One task between Claudes, as a card: in the conversation your Claude asked from (sent →
 * waiting for Alice → working, with steps → the result with its summary, data and files), and
 * in Requests. While your Claude waits for your OK to ask someone you don't trust yet, the card
 * asks you: Ask / Edit / Not now.
 */

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function useCall(): (what: string, call: Promise<unknown>) => void {
  const { client } = useBeluga();
  return (what, call) => void call.catch((err: unknown) => client.store.dispatch({ type: 'toast', text: `Couldn't ${what}: ${message(err)}`, level: 'error' }));
}

/** Structured data as a table when it has the shape of one, else as JSON. */
export function DataTable({ data }: { data: unknown }) {
  const isRow = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const cell = (v: unknown): string => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  if (Array.isArray(data) && data.length && data.every(isRow)) {
    const cols = [...new Set(data.flatMap((r) => Object.keys(r)))].slice(0, 8);
    return (
      <table className={s.table} aria-label="Data">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.slice(0, 50).map((row, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c} className="selectable">
                  {cell(row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (isRow(data) && Object.keys(data).length <= 24) {
    return (
      <table className={s.table} aria-label="Data">
        <tbody>
          {Object.entries(data).map(([k, v]) => (
            <tr key={k}>
              <td className={s.key}>{k}</td>
              <td className={`${typeof v === 'object' && v !== null ? s.mono : ''} selectable`}>{cell(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return <pre className={`${s.json} selectable`}>{JSON.stringify(data, null, 2)}</pre>;
}

const kb = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** A screenshot a result brought: a thumbnail; clicking shows it in Finder. */
function Shot({ task, name, path }: { task: TaskView; name: string; path: string }) {
  const api = useApi();
  const { client } = useBeluga();
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let alive = true;
    void api.gateway
      .image(task.id, name)
      .then((u) => alive && setUrl(u))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [task.id, name]);
  return (
    <button type="button" className={a.shot} aria-label={`Screenshot ${name}: show in ${fileManager()}`} title={name} onClick={() => void revealInFinder(client, path)}>
      {url ? <img src={url} alt={name} draggable={false} /> : null}
    </button>
  );
}

/**
 * Your Claude asked, and it has the answer: it tells you in its own words just below, so the
 * card only says it was answered (their reply one click away). Screenshots and files stay.
 */
export const relayed = (t: Pick<TaskView, 'direction' | 'by' | 'conversation' | 'delivered' | 'state'>): boolean =>
  t.direction === 'sent' && t.by === 'agent' && Boolean(t.conversation) && t.delivered === true && t.state === 'done';

function Result({ task }: { task: TaskView }) {
  const { client } = useBeluga();
  const [open, setOpen] = useState(false);
  const r = task.result;
  if (!r) return null;
  const shots = r.files.filter((f) => f.image && f.path);
  const folded = relayed(task) && !open;
  return (
    <div className={s.result}>
      {relayed(task) ? (
        <button type="button" className={s.reveal} aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={10} />
          {open ? `Hide ${task.peerName}’s reply` : `Show ${task.peerName}’s reply`}
          <span className={s.via}>your agent passes it on below</span>
        </button>
      ) : null}
      {r.summary && !folded ? <Markdown text={r.summary} /> : null}
      {shots.length ? (
        <>
          <span className={s.label}>Screenshots</span>
          <div className={a.shots}>
            {shots.map((f) => (
              <Shot key={f.name} task={task} name={f.name} path={f.path!} />
            ))}
          </div>
        </>
      ) : null}
      {r.data !== undefined && !folded ? (
        <>
          <span className={s.label}>Data</span>
          <DataTable data={r.data} />
        </>
      ) : null}
      {r.files.length ? (
        <>
          <span className={s.label}>Files</span>
          <div className={s.files}>
            {r.files.map((f) => (
              <div key={f.name} className={s.file}>
                <Icon name="file" size={13} />
                {f.path ? (
                  <button type="button" onClick={() => void revealInFinder(client, f.path!)} title={revealLabel()}>
                    {f.name}
                  </button>
                ) : (
                  <span>{f.name}</span>
                )}
                <span className={s.via}>{f.path ? kb(f.size) : 'didn’t arrive'}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}
      {r.secret && r.status === 'done' ? (
        <div className={s.hint}>
          <Icon name="lock" size={11} /> A secret ({r.secret}): {task.direction === 'sent' ? `${task.peerName} approved sending it to you` : 'you approved sending it'}, this once.
        </div>
      ) : null}
      {r.agent && task.direction === 'sent' ? (
        <div className={s.hint}>
          <Icon name={agentMark(r.agent)} size={11} /> Answered by {agentLabel(r.agent, task.peerName, false, { model: true })}
        </div>
      ) : null}
      {r.problems?.length ? <div className={s.problems}>{r.valid === false ? 'The data doesn’t match what was asked for: ' : ''}{r.problems.join(' · ')}</div> : null}
    </div>
  );
}

/** A friend's request waiting for you: Approve, Always (a rule for requests like it), Decline, or the full sheet. */
function Approve({ task, inChat }: { task: TaskView; inChat?: boolean }) {
  const api = useApi();
  const call = useCall();
  const waiting = useApp((st) => st.approvals.some((x) => x.task === task.id || x.title === approvalTitle(task)));
  const answer = (decision: 'yes' | 'always' | 'no'): Promise<unknown> => api.gateway.decide(task.id, { answer: decision, scope: 'this', command: 'this', expiry: 'never' });
  // In a friends' chat the card is where you answer: there's no approval above the message box there.
  if (!waiting && inChat)
    return (
      <div className={s.actions}>
        <span className={s.hint}>Waiting for your answer.</span>
        <Button size="small" variant="quiet" icon="eye" onClick={() => openRequest(task.id)}>
          Review…
        </Button>
      </div>
    );
  if (!waiting) return <div className={s.hint}>Waiting for your answer above the message box.</div>;
  return (
    <div className={s.actions}>
      <Button size="small" variant="primary" onClick={() => call('approve it', answer('yes'))}>
        {task.secret ? 'Allow Once' : 'Approve'}
      </Button>
      {/* A secret is asked about each time: nothing to make "Always". */}
      {task.secret ? null : <Button size="small" onClick={() => call('approve it', answer('always'))}>Always Allow from {task.peerName}</Button>}
      <Button size="small" variant="quiet" onClick={() => call('decline it', answer('no'))}>
        Decline
      </Button>
      <Button size="small" variant="quiet" icon="eye" onClick={() => openRequest(task.id)}>
        Review…
      </Button>
    </div>
  );
}

/** Their Claude asks something about your task (your Claude was told first): answer it, or let them decide. */
function Question({ task }: { task: TaskView }) {
  const api = useApi();
  const call = useCall();
  const q = task.question;
  const draft = q && task.answerDraft?.qid === q.qid ? task.answerDraft.answers : undefined;
  const [texts, setTexts] = useState<string[]>(() => [...(draft ?? [])]);
  useEffect(() => {
    if (draft) setTexts([...draft]);
  }, [draft?.join('\u0000')]);
  if (!q) return null;
  const send = (answers: string[] | 'skip'): void => call('answer', api.gateway.answer(task.id, answers));
  // Your Claude's answer waits for you: shown to edit and send.
  const single = !draft && q.questions.length === 1 && q.questions[0]!.options.length > 0 && !q.questions[0]!.multiSelect;
  return (
    <div className={a.question} role="group" aria-label={`${task.peerName}’s agent asks`}>
      {q.questions.map((item, i) => (
        <div key={i}>
          <div className={a.questionText}>
            {task.peerName}’s agent asks: {item.question}
          </div>
          {single ? (
            <div className={a.answers}>
              {item.options.map((o) => (
                <Button key={o.label} size="small" onClick={() => send([o.label])} title={o.description || undefined}>
                  {o.label}
                </Button>
              ))}
            </div>
          ) : null}
          {!single ? (
            <input
              className={a.input}
              style={{ width: '100%', marginBottom: 6 }}
              aria-label={`Answer: ${item.question}`}
              placeholder={item.options.length ? item.options.map((o) => o.label).join(' / ') : 'Your answer'}
              value={texts[i] ?? ''}
              onChange={(e) => setTexts(Object.assign([...texts], { [i]: e.target.value }))}
            />
          ) : null}
        </div>
      ))}
      <div className={s.actions} style={{ marginTop: 4 }}>
        {!single ? (
          <Button size="small" variant="primary" disabled={!texts.some((t) => t?.trim())} onClick={() => send(q.questions.map((_, i) => texts[i] ?? ''))}>
            {draft ? 'Send It' : 'Send Answer'}
          </Button>
        ) : null}
        <Button size="small" variant="quiet" onClick={() => send('skip')}>
          Let Them Decide
        </Button>
        <span className={s.via}>{draft ? 'Your agent’s answer: you hadn’t seen this request, so it waits for you' : task.by === 'agent' ? 'Your agent was asked first' : ''}</span>
      </div>
    </div>
  );
}

/** "Ask bob's Claude?" — your Claude waits for you. */
function Confirm({ task }: { task: TaskView }) {
  const api = useApi();
  const call = useCall();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(task.ask);
  return (
    <>
      {editing ? <textarea className={s.edit} aria-label="What to ask" value={text} onChange={(e) => setText(e.target.value)} autoFocus /> : <div className={`${s.ask} selectable`}>{task.ask}</div>}
      <div className={s.hint}>Your agent wants to send this, so it asks you first. Always lets it ask {task.peerName} without checking from now on (it doesn’t change what they may do on {yourComputer()}).</div>
      <div className={s.actions}>
        <Button size="small" variant="primary" onClick={() => call('send it', api.gateway.confirm(task.id, true, editing && text.trim() !== task.ask ? text : undefined))}>
          Ask {task.peerName}
        </Button>
        <Button size="small" onClick={() => call('send it', api.gateway.confirm(task.id, true, editing && text.trim() !== task.ask ? text : undefined, true))}>Always</Button>
        {editing ? null : (
          <Button size="small" icon="pencil" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
        <Button size="small" variant="quiet" onClick={() => call('answer', api.gateway.confirm(task.id, false))}>
          Not now
        </Button>
      </div>
    </>
  );
}

/** A task card placed in a conversation, lined up with the messages. */
export function LogTaskCard({ task, inChat }: { task: TaskView; inChat?: boolean }) {
  return (
    <div className={s.inLog}>
      <TaskCard task={task} {...(inChat ? { inChat } : {})} />
    </div>
  );
}

/** `inChat`: in a friends' chat (BLG-207), where the card itself is where you answer. */
export const TaskCard = memo(function TaskCard({ task, inChat }: { task: TaskView; inChat?: boolean }) {
  const api = useApi();
  const call = useCall();
  const live = !isFinal(task.state) && task.state !== 'confirm';
  const now = useNow(task.state === 'working');
  const tone = stateTone(task);
  const sent = task.direction === 'sent';
  const working = task.incoming ? ` · ${kb(task.incoming.received)} of ${kb(task.incoming.total)}` : task.state === 'working' && task.startedAt ? ` · ${formatDuration(now - task.startedAt)}` : '';
  const done = isFinal(task.state) && task.endedAt ? ` · ${formatDuration(task.endedAt - task.createdAt)}` : '';
  const title = task.state === 'confirm' ? `Ask ${targetLabel(task)}?` : sent ? `To ${targetLabel(task)}` : `From ${task.peerName}${task.by === 'agent' ? '’s agent' : ''}`;
  return (
    <section className={`${s.card} ${task.state === 'confirm' ? s.confirm : ''} ${task.secret && !isFinal(task.state) ? s.secret : ''}`} aria-label={`Task: ${title}`} data-task={task.id} data-state={task.state}>
      {/* A secret is its own approval, each time (BLG-209): the card says so before anything else. */}
      {task.secret && !isFinal(task.state) ? (
        <div className={s.secretLine}>
          <Icon name="lock" size={12} />
          {sent ? `A secret · only ${task.peerName} can allow it, each time` : 'A secret · only you can allow it, each time'}
        </div>
      ) : null}
      <div className={s.head}>
        <Avatar name={task.peerName} id={task.peerId} claude={task.kind === 'ask'} agent={task.kind === 'ask' ? task.result?.agent : undefined} size={20} />
        <span className={s.who}>{title}</span>
        {sent && task.by === 'agent' && task.state !== 'confirm' ? <span className={s.via}>asked by your agent</span> : null}
        {!sent && task.where ? <span className={s.via}>{task.where}</span> : null}
        <span className={`${s.status} ${s[`tone_${tone}`]}`} role="status">
          {task.state === 'confirm' ? null : <Dot tone={tone === 'claude' ? 'claude' : tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : tone === 'error' ? 'error' : 'muted'} live={live} />}
          {stateLabel(task)}
          {working || done}
        </span>
      </div>
      {task.state === 'confirm' ? (
        <Confirm task={task} />
      ) : (
        <>
          {task.kind === 'run' && task.command ? <div className={`${s.command} selectable`}>$ {task.command}</div> : relayed(task) ? null : <div className={`${s.ask} selectable`}>{task.ask}</div>}
          {live && task.steps.length ? (
            <div className={s.steps} aria-label="Steps">
              {task.steps.slice(-4).map((step, i) => (
                <TaskStep key={i} line={step} owner={sent ? task.peerName : undefined} className={s.step} />
              ))}
            </div>
          ) : null}
          {sent && task.question ? <Question task={task} /> : null}
          <Result task={task} />
          {!sent && task.state === 'awaiting_approval' ? <Approve task={task} {...(inChat ? { inChat } : {})} /> : null}
          {live && !(!sent && task.state === 'awaiting_approval') ? (
            <div className={s.actions}>
              <Button size="small" variant="quiet" icon="stop" onClick={() => call(sent ? 'cancel it' : 'stop it', api.gateway.cancel(task.id))}>
                {sent ? 'Cancel' : 'Stop'}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
});
