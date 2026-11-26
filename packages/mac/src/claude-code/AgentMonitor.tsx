import { useEffect, useMemo, useState } from 'react';
import type { Workspace } from '@beluga/workspaces/types.js';
import { useNow } from '../chat/Items.js';
import { StepWords } from '../chat/steps/StepRow.js';
import { Icon } from '../components/Icon.js';
import { Button, Dot, Empty, Segmented, Tip, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { usePrefs } from '../lib/prefs.js';
import { chordLabel } from '../lib/shortcuts-model.js';
import { RemoveWorktreeAlert, WorktreeInfoPage } from '../views/WorktreeInfo.js';
import { LiveTranscript } from './LiveTranscript.js';
import { AgentOutputs, useAgentOutputs } from './AgentOutputs.js';
import { BackgroundTasks } from './BackgroundTasks.js';
import { tasksForAgent } from './background-model.js';
import { agentElapsed, agentLabel, agentTone, plural, tokens, typeLabel } from './cc-model.js';
import { type SubAgent, agentIdOfPath, agentOfWorktree, agentTitle, effortLabel, modelLabel, parentWorkspace, steerPrompt, steerable } from './subagents-model.js';
import s from './claude-code.module.css';
import m from './agent-monitor.module.css';
import o from './agent-outputs.module.css';
import { revealLabel } from '../lib/os-words.js';
import { showWorktreeFolder, useRevealLabel } from '../lib/remote-open.js';

/**
 * One sub-agent, followed live: what it was asked, who started it (and a way back there), its
 * model and effort, everything it does as it does it (thinking, tools, words), what it makes along
 * the way (Outputs: screenshots, test output, logs, wherever it puts them), and its own worktree's
 * Changes, Files and Scratch in the right panel when it has one. You don't talk to
 * a sub-agent: you tell the Claude that started it, which passes it on (SendMessage), so its
 * conversation stays the one story of the work.
 */

/** Tell the lead Claude something for this sub-agent (only when the lead is one of Beluga's conversations). */
function Steer({ sub, parent, leadName }: { sub: SubAgent; parent: Workspace | undefined; leadName?: string }) {
  const { client } = useBeluga();
  const prefs = usePrefs();
  const [text, setText] = useState('');
  const [sent, setSent] = useState<string>();
  const can = steerable(sub) && parent !== undefined;
  const lead = leadName ?? parent?.name ?? 'the conversation that started it';
  const send = (): void => {
    const body = text.trim();
    if (!body || !can || !parent) return;
    void client.api.session.submit(steerPrompt(sub.agent, body), { channel: `ws:${parent.id}` }).then(
      () => {
        setText('');
        setSent(`Sent to ${lead}’s agent: it passes it on.`);
      },
      () => setSent('Couldn’t reach that conversation. Try again.'),
    );
  };
  if (!can) {
    return (
      <div className={m.steerOff}>
        <Icon name="info" size={12} />
        {sub.session.own ? 'The conversation that started it is gone, so nobody can pass anything on.' : 'It was started outside Beluga: steer it from where its session runs.'}
      </div>
    );
  }
  return (
    <div className={m.steer}>
      <div className={m.steerBox}>
        <textarea
          className={`${m.steerInput} selectable`}
          rows={1}
          value={text}
          placeholder={`Tell ${lead}’s main agent something for this one…`}
          aria-label={`Tell ${lead}’s main agent something for this one`}
          onChange={(e) => {
            setText(e.target.value);
            setSent(undefined);
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
            const modKey = e.metaKey || e.ctrlKey;
            if (prefs.sendWith === 'enter' ? e.shiftKey || modKey : !modKey) return;
            e.preventDefault();
            send();
          }}
        />
        <Tip label={`The main agent in ${lead} gets it and passes it on with SendMessage`} keys={prefs.sendWith === 'enter' ? '↩' : chordLabel('Cmd+Enter')}>
          <Button size="small" variant={text.trim() ? 'primary' : 'plain'} icon="send" disabled={!text.trim()} onClick={send}>
            Send to Main Agent
          </Button>
        </Tip>
      </div>
      <div className={m.steerHint}>{sent ?? `You steer it through ${lead}’s agent, which started it. Its answer shows in that chat.`}</div>
    </div>
  );
}

/** The live page of one sub-agent (with its worktree when it has one). */
export function AgentMonitor({ sub, worktree }: { sub: SubAgent; worktree?: Workspace }) {
  const { client } = useBeluga();
  const revealWords = useRevealLabel();
  const actions = useActions();
  const a = sub.agent;
  // Only Beluga's own conversations are a chat to go back to (a session outside Beluga isn't).
  const parent = useApp((st) => (sub.session.own ? parentWorkspace(st, sub) : undefined));
  const projectName = useApp((st) => st.projects.find((p) => p.id === sub.session.projectId)?.name);
  const parentAgent = a.parentAgentId ? sub.session.agents.find((x) => x.id === a.parentAgentId) : undefined;
  const now = useNow(a.status === 'running');
  const [removing, setRemoving] = useState(false);
  const [picked, setView] = useState<'activity' | 'outputs' | 'background'>('activity');
  const live = a.status === 'running';
  const outputs = useAgentOutputs(sub.session.id, a.id, live);
  const made = outputs?.outputs.length ?? 0;
  // Commands it runs in the background (a dev server, its tests): a third view, when it has any.
  const tasks = useMemo(() => tasksForAgent(sub.session, a.id), [sub.session, a.id]);
  const runningTasks = tasks.filter((t) => t.task.status === 'running').length;
  const view = picked === 'background' && !tasks.length ? 'activity' : picked;
  const version = `${a.lastAt}:${a.steps}:${a.status}`;
  const facts = [
    { label: typeLabel(a.type) },
    ...(modelLabel(a.model) ? [{ label: modelLabel(a.model)!, tip: a.model }] : []),
    ...(effortLabel(a.effort) ? [{ label: effortLabel(a.effort)! }] : []),
    { label: agentElapsed(a, now) },
    { label: plural(a.steps, 'step') },
    ...(a.tokens ? [{ label: `${tokens(a.tokens)} context` }] : []),
    ...(a.background ? [{ label: 'Background' }] : []),
  ];
  return (
    <div className={s.sessionPage} data-agent-monitor={a.id}>
      <header className={m.head}>
        <span className={cx(m.avatar, live && m.avatarLive)} aria-hidden="true">
          <Icon name="bot" size={20} />
        </span>
        <div className={m.titles}>
          <div className={m.kicker}>
            Sub-agent
            {parent ? (
              <>
                {' of '}
                <button type="button" className={m.parentLink} onClick={() => actions.run({ type: 'open_ws', id: parent.id })}>
                  {parent.kind === 'main' ? (projectName ?? parent.name) : parent.name}
                </button>
              </>
            ) : sub.session.own ? null : (
              <>
                {' of “'}
                {sub.session.title}
                {'”, a Claude Code session outside Beluga'}
                {projectName ? ` in ${projectName}` : ''}
              </>
            )}
            {parentAgent ? <> · started by its agent “{agentTitle(parentAgent)}”</> : null}
          </div>
          <h1 className={s.focusTitle}>{agentTitle(a)}</h1>
          <div className={m.facts}>
            <span className={cx(m.status, s[`tone_${agentTone(a)}`])}>
              {live ? <Dot tone="subagent" live /> : <Icon name={a.status === 'failed' ? 'x' : a.status === 'finished' ? 'check' : 'clock'} size={10} />}
              {agentLabel(a)}
            </span>
            {facts.map((f) => (
              <span key={f.label} className={m.fact} title={f.tip}>
                {f.label}
              </span>
            ))}
            {a.worktree ? (
              <span className={m.fact} title={a.worktree.path}>
                <Icon name="branch" size={10} /> Its own worktree{a.worktree.branch ? ` · ${a.worktree.branch}` : ''}
              </span>
            ) : null}
          </div>
          {live && a.step ? (
            <div className={m.now} title={a.step}>
              <StepWords words={a.step} />
            </div>
          ) : null}
        </div>
        <div className={m.headActions}>
          {parent ? (
            <Button size="small" icon="chat" onClick={() => actions.run({ type: 'open_ws', id: parent.id })}>
              Open Main Chat
            </Button>
          ) : null}
          {worktree ? (
            <Button size="small" icon="folder" onClick={() => void showWorktreeFolder(client, worktree.id)}>
              {revealWords}
            </Button>
          ) : null}
          {worktree && !live ? (
            <Button size="small" variant="danger" icon="archive" onClick={() => setRemoving(true)}>
              Remove Worktree…
            </Button>
          ) : null}
        </div>
      </header>
      <div className={o.tabs}>
        <Segmented size="small"
          label="Show"
          value={view}
          onChange={setView}
          options={[
            { value: 'activity', label: 'Activity', hint: 'What it does, as it does it' },
            { value: 'outputs', label: made ? `Outputs · ${made}` : 'Outputs', hint: 'Screenshots, test output and logs it made or looked at' },
            ...(tasks.length ? [{ value: 'background' as const, label: `Background · ${runningTasks ? `${runningTasks} running` : tasks.length}`, hint: 'Commands it runs in the background, with their output as it comes' }] : []),
          ]}
        />
      </div>
      {view === 'activity' ? (
        <LiveTranscript key={`${sub.session.id}/${a.id}`} sessionId={sub.session.id} agentId={a.id} version={version} live={live} label={`Sub-agent ${agentTitle(a)}`} />
      ) : view === 'background' ? (
        <BackgroundTasks items={tasks} layout="split" empty="Nothing it runs in the background." />
      ) : (
        <AgentOutputs key={`${sub.session.id}/${a.id}`} sessionId={sub.session.id} agentId={a.id} list={outputs} {...(sub.session.cwd ? { cwd: sub.session.cwd } : {})} />
      )}
      <Steer sub={sub} parent={parent} {...(parent ? { leadName: parent.kind === 'main' ? (projectName ?? parent.name) : parent.name } : {})} />
      {removing && worktree ? <RemoveWorktreeAlert ws={worktree} onDone={() => setRemoving(false)} onCancel={() => setRemoving(false)} /> : null}
    </div>
  );
}

/**
 * A sub-agent's own worktree, opened from the sidebar: the agent, live. If Claude Code no longer
 * has that agent (long gone), what the worktree is, without offering to start a conversation in it.
 */
export function AgentWorktreePage({ ws }: { ws: Workspace }) {
  const { client } = useBeluga();
  const sessions = useApp((st) => st.claudeCode.sessions);
  const origin = useApp((st) => st.claudeCode.origins.find((o) => o.path === ws.path));
  const sub = useMemo(() => agentOfWorktree(sessions, ws), [sessions, ws]);
  const [looked, setLooked] = useState(false);
  const id = agentIdOfPath(ws.path);
  // Not watched now (finished a while ago): ask Beluga to find it, so it can be followed again.
  useEffect(() => {
    if (sub || !id) return void setLooked(true);
    let alive = true;
    client.api.claudeCode.findAgent(id).then(
      () => alive && setTimeout(() => alive && setLooked(true), 600),
      () => alive && setLooked(true),
    );
    return () => {
      alive = false;
    };
  }, [id, Boolean(sub)]);
  if (sub) return <AgentMonitor sub={sub} worktree={ws} />;
  if (!looked) return <Empty icon="bot" title="Finding this sub-agent…" detail="Reading what Claude Code kept of it." />;
  return <WorktreeInfoPage ws={ws} agent {...(origin ? { origin } : {})} />;
}
