import { useMemo } from 'react';
import { type CcSession, outsideSessions, sessionApp } from '@beluga/core/claude-code/model.js';
import { useNow } from '../chat/Items.js';
import { Icon } from '../components/Icon.js';
import { ProjectIcon } from '../components/ProjectIcon.js';
import { Button, Dot, Empty } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { AgentCard, SessionChip } from './Cards.js';
import { chatOf } from './chat-of.js';
import { LiveTranscript } from './LiveTranscript.js';
import { AgentMonitor } from './AgentMonitor.js';
import { openSubAgent } from '../layout/SubAgents.js';
import { TeamBlock, teamMembers } from './Team.js';
import { activitySummary, groupByProject, openActivity, placeLabel, plural, sessionLabel } from './cc-model.js';
import s from './claude-code.module.css';

/**
 * Activity: every Claude Code session running outside Beluga (a terminal, another app), by project,
 * with its sub-agents as cards. Everything opens where it lives: a session the chat of its folder
 * (with the session live in a strip at the top), an agent its worktree's chat or its own page. Only
 * a session in a folder Beluga doesn't know opens as a live transcript.
 */

export const OUTSIDE = 'Running in Claude Code, outside Beluga';

/** Open where a session lives (its folder's chat, else its transcript here), or one of its agents (openSubAgent). */
function useOpenSession(session: CcSession): (agentId?: string) => void {
  const { client } = useBeluga();
  const actions = useActions();
  const chat = useApp((st) => chatOf(st, session));
  return (agentId) => {
    const agent = agentId ? session.agents.find((a) => a.id === agentId) : undefined;
    if (agent) openSubAgent(client, actions, { session, agent });
    else if (chat) actions.run({ type: 'open_ws', id: chat });
    else openActivity(client, session.id);
  };
}

function SessionRow({ session }: { session: CcSession }) {
  const open = useOpenSession(session);
  const chat = useApp((st) => chatOf(st, session));
  const place = useApp((st) => placeLabel(st, session));
  const now = useNow(session.status === 'working', 5000);
  const st = sessionLabel(session, now);
  const running = session.agents.filter((a) => a.status === 'running').length;
  const team = new Set(teamMembers(session).map((a) => a.id));
  const others = session.agents.filter((a) => !team.has(a.id));
  return (
    <section className={s.session} aria-label={`${sessionApp(session)} session ${session.title}`}>
      <button type="button" className={s.sessionHead} onClick={() => open()}>
        <span className={s.sessionDot}>{st.tone === 'claude' ? <Dot tone="claude" live /> : <Dot tone={st.tone === 'ok' ? 'ok' : 'muted'} />}</span>
        <span className={s.sessionText}>
          <span className={s.sessionTitle}>{session.title}</span>
          <span className={s.sessionMeta}>
            <span className={s[`tone_${st.tone}`]}>{st.label}</span>
            <span>{place}</span>
            {session.agent ? <span>{sessionApp(session)}</span> : null}
            {session.agents.length ? <span>{running ? `${running} of ${plural(session.agents.length, 'agent')} running` : plural(session.agents.length, 'agent')}</span> : null}
          </span>
        </span>
        <span className={s.sessionOpen}>
          {chat ? 'Open Chat' : 'Open'}
          <Icon name="chevronRight" size={10} />
        </span>
      </button>
      {/* Agents working as a team (named, messaging each other) under one header, with their messages. */}
      <TeamBlock session={session} onOpen={(id) => open(id)} />
      {others.length ? (
        <div className={s.grid}>
          {others.map((a) => (
            <AgentCard key={a.id} agent={a} onOpen={() => open(a.id)} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ActivityList() {
  const raw = useApp((st) => st.claudeCode.sessions);
  const sessions = useMemo(() => outsideSessions(raw), [raw]);
  const projects = useApp((st) => st.projects);
  // Selectors must return what's in the state (a fresh array each time would render forever).
  const groups = useMemo(() => groupByProject({ projects }, sessions), [projects, sessions]);
  if (!sessions.length) {
    return (
      <div className={s.page}>
        <Empty icon="claude" title="No Claude Code sessions right now" detail="When you run Claude Code in a terminal or another app, its sessions and their agents show here live." />
      </div>
    );
  }
  return (
    <div className={s.page}>
      <div className={s.inner}>
        <header className={s.summary}>
          <h1 className={s.summaryTitle}>{activitySummary(sessions)}</h1>
          <p className={s.summaryText}>Claude Code sessions running outside Beluga, and the agents they started. Open one to follow it where it lives; they keep running where they are.</p>
        </header>
        {groups.map((g) => (
          <section key={g.key} className={s.group} aria-label={g.name}>
            <h2 className={s.groupTitle}>
              {g.projectId ? <ProjectIcon id={g.projectId} name={g.name} size={18} /> : <Icon name="folder" size={16} />}
              <span>{g.name}</span>
              <span className={s.groupCount}>{g.running ? `${g.running} running` : plural(g.sessions.length, 'session')}</span>
            </h2>
            {g.sessions.map((x) => (
              <SessionRow key={x.id} session={x} />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

/**
 * One session's transcript (the chat's live strip opens it; Activity does for a session in a folder
 * Beluga doesn't know), titled by its folder, with its agents in a row. An agent that went quiet
 * lands here too.
 */
export function SessionPage({ session, agentId }: { session: CcSession; agentId?: string }) {
  const { client } = useBeluga();
  const open = useOpenSession(session);
  const actions = useActions();
  const chat = useApp((st) => chatOf(st, session));
  const place = useApp((st) => placeLabel(st, session));
  const now = useNow(session.status === 'working', 5000);
  const st = sessionLabel(session, now);
  return (
    <div className={s.sessionPage}>
      <header className={s.focusHead}>
        <Button size="small" variant="quiet" icon="back" onClick={() => openActivity(client)}>
          Activity
        </Button>
        <div className={s.focusTitles}>
          <h1 className={s.focusTitle}>{place}</h1>
          <div className={s.focusMeta}>
            <span className={s[`tone_${st.tone}`]}>{st.label}</span>
            <span>{session.title}</span>
            {session.model ? <span>{session.model}</span> : null}
          </div>
        </div>
        {chat ? (
          <Button size="small" icon="chat" onClick={() => actions.run({ type: 'open_ws', id: chat })}>
            Open Chat
          </Button>
        ) : (
          <span className={s.readOnly} title="It runs in a terminal or another app; Beluga shows it live">
            <Icon name="eye" size={12} />
            {session.agent ? `Running in ${sessionApp(session)}, outside Beluga` : OUTSIDE}
          </span>
        )}
      </header>
      {session.agents.length ? (
        <div className={s.strip} role="group" aria-label="Agents in this session">
          <SessionChip session={session} selected={!agentId} onOpen={() => openActivity(client, session.id)} />
          {session.agents.map((a) => (
            <AgentCard key={a.id} agent={a} compact onOpen={() => open(a.id)} />
          ))}
        </div>
      ) : null}
      {agentId ? (
        <Empty icon="clock" title="This agent went quiet" detail="Beluga stops watching agents a while after they finish." action={<Button size="small" onClick={() => openActivity(client, session.id)}>Show the Conversation</Button>} />
      ) : session.agent === 'codex' ? (
        <Empty icon="eye" title={session.step ?? 'Working in Codex'} detail="Beluga shows what this Codex session is doing now; its whole conversation is in Codex." />
      ) : (
        <LiveTranscript key={session.id} sessionId={session.id} version={`${session.lastAt}:${session.steps}:${session.status}`} live={session.status === 'working'} label={`Claude Code session ${session.title}`} />
      )}
    </div>
  );
}

export function ActivityView() {
  const { client } = useBeluga();
  const view = useApp((st) => st.view);
  const sessionId = view.kind === 'claude_code' ? view.session : undefined;
  const agentId = view.kind === 'claude_code' ? view.agent : undefined;
  const session = useApp((st) => (sessionId ? st.claudeCode.sessions.find((x) => x.id === sessionId) : undefined));
  if (!sessionId) return <ActivityList />;
  if (!session) {
    return (
      <div className={s.page}>
        <Empty icon="clock" title="This session went quiet" detail="Beluga shows Claude Code sessions while they work, and for a while after." action={<Button size="small" onClick={() => openActivity(client)}>Show All Activity</Button>} />
      </div>
    );
  }
  // A sub-agent: followed on its own page (gone quiet: the session's page says so).
  const agent = agentId ? session.agents.find((a) => a.id === agentId) : undefined;
  if (agent) return <AgentMonitor sub={{ session, agent }} />;
  return <SessionPage session={session} {...(agentId ? { agentId } : {})} />;
}
