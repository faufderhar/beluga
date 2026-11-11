import { channelOf } from '@beluga/core/store.js';
import { planForHome } from '@beluga/core/plans/model.js';
import { Attention } from '../chat/Attention.js';
import { ChatLog } from '../chat/ChatLog.js';
import { Composer } from '../chat/Composer.js';
import { Button, Empty, EmptyActions } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp } from '../lib/beluga.js';
import s from './views.module.css';
import { OtherWorktreeBanner, WorktreeInfoPage } from './WorktreeInfo.js';
import { AgentWorktreePage } from '../claude-code/AgentMonitor.js';
import { isAgentWorktree } from '../claude-code/subagents-model.js';
import { LiveStrip } from '../claude-code/Live.js';
import { SharedStrip } from '../layout/PeopleHere.js';
import { EnvStrip } from './project/EnvAsks.js';
import { TaskStrip } from '../tasks/TaskStrip.js';
import { DrivenStrip } from '../chat/DrivenStrip.js';
import { PrStrip } from '../chat/PrStrip.js';
import { PlanStrip } from '../plans/PlanStrip.js';
import { useWorktreeFlag } from './worktree-info-state.js';
import { AskBanner } from '../chat/AskBanner.js';
import { TriageLine } from '../chat/TriageLine.js';
import { ConnectionStatus } from './room/ConnectionStatus.js';
import { AssistantTabs } from '../chat/AssistantTabs.js';
import { DrivingBanner } from '../agent-term/DrivingBanner.js';
import { computerWord, yourComputer } from '../lib/os-words.js';

/** A conversation and the box to add to it: the room's group chat, a workspace, a shared workspace, a draft. */
/** One-click ways to begin, under an empty conversation. */
function Starters() {
  const actions = useActions();
  const view = useApp((st) => st.view);
  const project = useApp((st) => st.projects.find((p) => p.root && (view.kind !== 'workspace' || p.workspaces.some((w) => w.id === view.id))));
  if (view.kind === 'room') {
    return (
      <EmptyActions>
        {project ? (
          <Button variant="primary" icon="branch" onClick={() => actions.run({ type: 'new_worktree', projectId: project.id })}>
            New Worktree
          </Button>
        ) : (
          <Button variant="primary" icon="plus" onClick={() => actions.run({ type: 'add_project' })}>
            Add Projects…
          </Button>
        )}
        <Button icon="chat" onClick={() => actions.run({ type: 'new_chat', projectId: 'chats' })}>
          New Chat
        </Button>
        {project ? (
          <Button variant="quiet" icon="plus" onClick={() => actions.run({ type: 'add_project' })}>
            Add Projects…
          </Button>
        ) : null}
      </EmptyActions>
    );
  }
  if (view.kind !== 'workspace') return null;
  // A first task, sent with one click (in a main folder: a first question).
  const ask = project?.workspaces.find((w) => w.id === view.id)?.askOnly;
  return (
    <EmptyActions>
      {(ask ? ASK_STARTERS : STARTERS).map((t) => (
        <Button key={t.label} icon={t.icon} onClick={() => actions.submit(t.prompt)}>
          {t.label}
        </Button>
      ))}
    </EmptyActions>
  );
}

/** First things to ask Your Mac. */
function AssistantStarters() {
  const actions = useActions();
  return (
    <EmptyActions>
      {ASSISTANT_STARTERS.map((t) => (
        <Button key={t.label} icon={t.icon} onClick={() => actions.submit(t.prompt)}>
          {t.label}
        </Button>
      ))}
    </EmptyActions>
  );
}

const ASSISTANT_STARTERS = [
  { label: 'Take a Screenshot', icon: 'image', prompt: 'Take a screenshot of my screen and send it to me.' },
  { label: 'What’s Using My CPU', icon: 'gauge', prompt: 'What’s using my CPU and memory right now?' },
  { label: 'What’s Running', icon: 'pulse', prompt: 'What’s running in Beluga right now, across my projects?' },
] as const;

const STARTERS = [
  { label: 'Explain This Project', icon: 'eye', prompt: 'Explain how this project is organized: the main parts, how they fit together, and where to start reading.' },
  { label: 'Find a Bug', icon: 'search', prompt: 'Look through the code for a likely bug, explain it, and fix it with a test.' },
  { label: 'Add Tests', icon: 'check', prompt: 'Find the most important code without tests and write good tests for it.' },
] as const;

/** First questions for a chat in a main folder, where Claude only reads. */
const ASK_STARTERS = [
  { label: 'Explain This Project', icon: 'eye', prompt: 'Explain how this project is organized: the main parts, how they fit together, and where to start reading.' },
  { label: 'What Changed Lately', icon: 'clock', prompt: 'Summarize what changed in this project over the last couple of weeks, from the git history.' },
  { label: 'Where Are the Risks', icon: 'search', prompt: 'Where is this code most likely to break? Point me at the riskiest parts and explain why. Don’t change anything.' },
] as const;

export function ChatView() {
  const view = useApp((st) => st.view);
  const channel = channelOf(view);
  const ws = useApp((st) => (view.kind === 'workspace' ? st.projects.flatMap((p) => p.workspaces).find((w) => w.id === view.id) : undefined));
  const projectName = useApp((st) => st.projects.find((p) => p.root && (view.kind === 'draft' ? p.id === view.projectId : p.workspaces.some((w) => w.id === ws?.id)))?.name);
  const empty =
    view.kind === 'draft' ? (
      projectName ? (
        <Empty icon="eye" title={`Ask about ${projectName}`} detail="Questions only: your agent reads the main folder and changes nothing there. Ask for a change and this chat becomes a worktree." />
      ) : (
        <Empty icon="chat" title="A new chat with your agent" detail="Nothing is created until you send your first message." />
      )
    ) : ws?.askOnly ? (
      <Empty icon="eye" title={`Ask about ${projectName ?? 'this project'}`} detail="Your agent reads the main folder and answers; it won’t change anything here. Ask for a change and this chat becomes a worktree." action={<Starters />} />
    ) : view.kind === 'draft_worktree' ? (
      <Empty icon="branch" title="A new worktree" detail="Describe the task below. Beluga makes a branch and a folder for it from the branch you pick, and your agent starts right away." />
    ) : view.kind === 'assistant' ? (
      <Empty icon="laptop" title={`Ask ${yourComputer()}`} detail={`Your agent for this whole ${computerWord()}, not one project: screenshots, what’s using the CPU, starting a worktree or a task. Keep several chats as tabs above; the open one is the one on your phone.`} action={<AssistantStarters />} />
    ) : view.kind === 'room' ? (
      <Empty icon="claude" title="Say hi to the room" detail="Everyone here sees this chat. Mention @claude to ask your agent." action={<Starters />} />
    ) : (
      <Empty icon="chat" title="Tell your agent what to do here" detail="It works in this folder and remembers the conversation. Start with one of these, or write your own below." action={<Starters />} />
    );
  // A worktree made outside Beluga: its info page until there's a conversation (or you start one).
  const other = ws?.kind === 'worktree' && ws.external && !ws.archived ? ws : undefined;
  const hasItems = useApp((st) => st.log.some((l) => l.channel === channel));
  // A plan's own conversation plans: it never moves to a worktree.
  const planHome = useApp((st) => Boolean(planForHome(st.plans, channel)));
  // The agent's own terminal drives this conversation (BLG-534): the chat follows along until you take over.
  const driving = useApp((st) => (view.kind === 'workspace' ? Boolean(st.agentTerms[view.id]) : false));
  const started = useWorktreeFlag('started', other?.id ?? '');
  const about = useWorktreeFlag('about', other?.id ?? '');
  // A sub-agent's own worktree is the agent, followed live (never a place to start a conversation).
  if (other && isAgentWorktree(other) && !hasItems) return <AgentWorktreePage ws={other} />;
  if (other && (about || (!hasItems && !started))) return <WorktreeInfoPage ws={other} />;
  // Files from Finder dropped anywhere on it go in the message box (use-attachments.tsx).
  const chat = (
    <div className={s.chat} data-drop-zone>
      {other ? <OtherWorktreeBanner ws={other} /> : null}
      {view.kind === 'room' ? <ConnectionStatus /> : null}
      {view.kind === 'assistant' ? <AssistantTabs /> : null}
      {view.kind === 'workspace' ? <PlanStrip workspaceId={view.id} /> : null}
      {view.kind === 'workspace' ? <TaskStrip workspaceId={view.id} /> : null}
      {view.kind === 'workspace' ? <DrivenStrip workspaceId={view.id} /> : null}
      {view.kind === 'workspace' ? <PrStrip workspaceId={view.id} /> : null}
      {view.kind === 'workspace' ? <SharedStrip wsId={view.id} /> : null}
      {view.kind === 'workspace' ? <EnvStrip workspaceId={view.id} /> : null}
      {/* Its own terminal driving it: the banner below says so (not a Claude Code session beside it). */}
      {view.kind === 'workspace' && !driving ? <LiveStrip workspaceId={view.id} /> : null}
      <ChatLog key={channel} channel={channel === 'draft' ? '__draft__' : channel} empty={empty} />
      {ws?.askOnly && !ws.archived && !planHome ? <AskBanner wsId={ws.id} /> : null}
      <Attention />
      {channel === 'draft' ? null : <TriageLine channel={channel} />}
      {driving && view.kind === 'workspace' ? <DrivingBanner wsId={view.id} /> : <Composer />}
    </div>
  );
  // The terminal is in the right panel or the drawer under the center (layout/panel), not beside the chat.
  return chat;
}
