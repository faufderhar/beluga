import type { AgentRef } from '@beluga/protocol.js';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { waitingNote } from '@beluga/core/friend-share-people.js';
import { type AppState, type View, channelOf, peerName } from '@beluga/core/store.js';
import { localDirKey } from '@beluga/core/local-key.js';
import { workspaceMentions } from '@beluga/core/mentions.js';
import { composeState, queueIn } from '@beluga/ui/compose.js';
import { isRunning } from '@beluga/ui/format.js';
import { localDirOf, mentionDir, openTarget, suggest, type Suggestion, typedMention } from '@beluga/ui/suggest.js';
import { worktreeMode } from '@beluga/ui/submit.js';
import { resolveChat } from '@beluga/core/chat-links/resolve.js';
import { chatChipOf, chatLinksToMentions, chatMentionsIn, isAddressableChannel, parseChatRef, withChatWords } from '@beluga/shared/chat-ref.js';
import { roomAgentTags } from '@beluga/shared/agent-tags.js';
import { shareNameOf } from '@beluga/shared/share-names.js';
import { secretIn } from '@beluga/shared/secret-text.js';
import { steeredMessages } from '@beluga/shared/claude-notices.js';
import { fallbackFor, runtimeHas, runtimeHere } from '@beluga/shared/runtime-fallbacks.js';
import { defaultAgentOf } from '@beluga/protocol.js';
import { Icon } from '../components/Icon.js';
import { Kbd, Tip, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { recipientLabel, recipientPrefix, toast, useApi, useApp, useBeluga, useUi, useMachine, useScopedKey } from '../lib/beluga.js';
import { makeAhead } from '../lib/make-ahead.js';
import { agentName, useAgentNameIn, useMyAgentName } from '../lib/agent-words.js';
import { sameDeep, sameFields } from '../lib/stable.js';
import { getPrefs, usePrefs } from '../lib/prefs.js';
import { sendsToTerminal } from '../lib/convo-mode.js';
import { chordLabel } from '../lib/shortcuts-model.js';
import { cmdReturn, returnName, thisComputer, upFirst, yourComputer } from '../lib/os-words.js';
import { ModelPicker, myRuntime, shownEffort } from './ModelPicker.js';
import { ContextMeter } from './ContextMeter.js';
import { McpChip } from './McpChip.js';
import { boxChats, plainWords } from './chat-box.js';
import { RunsOnLabel, RunsOnPicker } from './RunsOn.js';
import { sendToComputer, useStartDeps } from '../machines/start-there.js';
import { QueueTray } from './QueueTray.js';
import { BtwCard, askBtw } from './BtwCard.js';
import { expectClaude, launchFlight } from './flight.js';
import { lastMineIn } from './starting-model.js';
import { type WorktreeChoice, WorktreeDraft } from './WorktreeDraft.js';
import { sendSteerNow, stopClaude } from '../lib/commands.js';
import { useAttachments } from './use-attachments.js';
import { CommentCards } from './CommentCards.js';
import { useWaitingComments } from '../views/DiffComment.js';
import { takeComments, withComments } from '../views/diff-comments.js';
import { MentionHighlighter } from './MentionHighlighter.js';
import { useSuggestions } from './Suggestions.js';
import { useChatMentions, useMentionWorld, worktreeOf } from './Mention.js';
import { useSkills } from './use-skills.js';
import { caretAfterDraw, useDraftChips } from './draft-chips.js';
import { MentionedChats, MentionedTasks } from './MentionedTasks.js';
import { DictationStrip, MicButton } from './Dictation.js';
import { dictatingInto, useDictation, useDictationTarget } from '../lib/dictation.js';
import { ActionsDropdown } from '../components/SpecMenu.js';
import { openSheet } from '../lib/sheets.js';
import { type ComposeMode, MODE_INFO, nextMode } from './compose-mode.js';
import { isPlanHome, planForHome } from '@beluga/core/plans/model.js';
import { MaxFire } from './MaxFire.js';
import { effectsOn, fireVars } from './fire-look.js';
import { handleInvite } from '../lib/invite-command.js';
import s from './composer.module.css';
import m from './max.module.css';
import d from './draft.module.css';
import { isShortcut } from '../lib/shortcuts.js';
import { shortcutKeys } from '../lib/shortcuts.js';
import { projectOfView } from '../tasks/use-tasks.js';
import { answerSend, answeringIn, sendAction, sendsUrgent, steerBlockNote } from './send-action.js';
import { useSteerBlock } from './use-steer.js';

import { scopedKey } from '../machines/pane-model.js';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Whose unsent words the box holds: a chat's own channel; a new chat or a new worktree its
 * project's page (they all share the channel "draft", so each needs its own).
 */
const draftKeyOf = (view: View): string => (view.kind === 'draft' ? `new-chat:${view.projectId}` : view.kind === 'draft_worktree' ? `new-worktree:${view.projectId}` : channelOf(view));

/** What you left unsent in each chat and on each new chat or new worktree page (kept while the app runs, like the network's chats). */
const drafts = new Map<string, string>();
/** The branch and name picked on each project's new worktree page, kept with its words. */
const worktreeChoices = new Map<string, WorktreeChoice>();
/** Conversations where Plan with Tasks is picked but nothing was sent yet (no plan is made until it is). */
const tasksPicked = new Set<string>();
/** Whose words are in the box now (the window keeps one box's words, `buffer`, for the chat on screen). */
let boxOf: string | undefined;

/** The words in the box, before you start typing: what it does here. */
function placeholderOf(state: AppState, ui: { pending?: { kind: string; projectId: string; peerId?: string } }): string {
  const agent = agentName(defaultAgentOf(state.self));
  const q = state.questions[0];
  if (q && q.channel === channelOf(state.view)) return q.question.kind === 'plan' ? 'Say what to change in the plan, or approve it above' : 'Type your own answer, or pick an option above';
  const p = ui.pending;
  if (p?.kind === 'peer_run') return `A command to run on ${peerName(state, p.peerId ?? '')}'s computer`;
  if (p?.kind === 'remote') return 'Describe the task for their agent';
  if (p?.kind === 'setup' || p?.kind === 'run') return `The project's ${p.kind} command (empty to clear it)`;
  if (p) return `Name for the new ${p.kind}${state.projects.find((x) => x.id === p.projectId)?.root ? ` in ${state.projects.find((x) => x.id === p.projectId)?.name}` : ''}`;
  const v = state.view;
  if (v.kind === 'draft') {
    // A chat in a project runs in its main folder: questions only.
    const project = state.projects.find((x) => x.id === v.projectId && x.root);
    return project ? `Ask about ${project.name}…` : `Ask ${agent} anything. Your first message starts the chat`;
  }
  if (v.kind === 'draft_worktree') return `What should ${agent} work on in the new worktree?`;
  if (v.kind === 'search') return 'Search every conversation';
  if (v.kind === 'assistant') return `Ask ${yourComputer()} anything`;
  if (v.kind === 'sentinel_chat') return 'Ask for a dashboard, a watcher or a pipeline: “chart my signups”, “tell me when my site is down”…';
  if (v.kind === 'workspace') {
    const ws = state.projects.flatMap((x) => x.workspaces).find((w) => w.id === v.id);
    if (ws?.askOnly) return `Ask about ${state.projects.find((x) => x.root && x.workspaces.includes(ws))?.name ?? 'this project'}…`;
    // The worktree's own agent (a Codex worktree says Codex), else yours.
    return `Tell ${ws?.agent ? agentName(ws.agent) : agent} what to do in ${ws?.name ?? 'this workspace'}`;
  }
  if (v.kind === 'shared') {
    const w = state.shared.find((x) => x.id === v.id);
    const waiting = waitingNote(state, v.id);
    if (waiting) return waiting;
    return w?.role === 'view' ? `You're following ${w.name}` : `Message ${w?.name ?? 'the workspace'}`;
  }
  return state.peers.length <= 1 ? `Message your ${agent}` : 'Message the room';
}

/** Where what you say in a friend's worktree runs (BLG-260): on their Mac (as ever) or in your own copy. */
type RunOn = 'owner' | 'here';
const runOnChoice = new Map<string, RunOn>();

/** In a friend's worktree you have a copy of: "Runs on Ata's Mac" or "on This Mac", one click to switch. */
function RunOnChip({ wsId, ownerName, value, onChange }: { wsId: string; ownerName: string; value: RunOn; onChange: (v: RunOn) => void }) {
  const key = useScopedKey(wsId);
  const pick = (v: RunOn): void => {
    runOnChoice.set(key, v);
    onChange(v);
  };
  return (
    <ActionsDropdown
      align="start"
      items={[
        { label: `${ownerName}’s computer`, hint: 'Their agent, in their worktree', icon: 'people', checked: value === 'owner', onSelect: () => pick('owner') },
        { label: upFirst(thisComputer()), hint: 'Your agent, in your copy, on the same branch', icon: 'laptop', checked: value === 'here', onSelect: () => pick('here') },
      ]}
    >
      <button type="button" className={cx(s.chip, value === 'here' && s.chipOn)} aria-label={`Runs on ${value === 'here' ? thisComputer() : `${ownerName}’s computer`}`}>
        <Icon name={value === 'here' ? 'laptop' : 'people'} size={12} />
        {value === 'here' ? upFirst(thisComputer()) : `${ownerName}’s computer`}
        <Icon name="chevronDown" size={9} />
      </button>
    </ActionsDropdown>
  );
}

/** The slices the same objects, and the box's state (worked out from them) the same. */
function sameComposer<T extends { readonly compose: object }>(a: T, b: T): boolean {
  const { compose: ca, ...ra } = a;
  const { compose: cb, ...rb } = b;
  return sameFields(ra, rb) && sameDeep(ca, cb);
}

export function Composer({ autoFocus = true }: { autoFocus?: boolean }) {
  const { ui, client } = useBeluga();
  const api = useApi();
  const actions = useActions();
  const prefs = usePrefs();
  const buffer = useUi((u) => u.buffer);
  const pending = useUi((u) => u.pending);
  const agent = useMyAgentName();
  // Only what the box reads (and what it works out from the rest), so it isn't drawn again for
  // events that change none of it. Worked out on each render too, so the words you type count.
  const state = useApp(
    (full) => ({
      view: full.view,
      log: full.log,
      selfId: full.selfId,
      self: full.self,
      peers: full.peers,
      planMode: full.planMode,
      plans: full.plans,
      projects: full.projects,
      prefs: full.prefs,
      shared: full.shared,
      sharedProjects: full.sharedProjects,
      friends: full.network.friends,
      dirCache: full.dirCache,
      compose: composeState(full, ui.get(), full.selfId, channelOf(full.view), full.view.kind === 'shared'),
      waiting: full.view.kind === 'shared' ? waitingNote(full, full.view.id) : undefined,
      project: projectOfView(full),
      placeholder: placeholderOf(full, pending ? { pending } : {}),
      answering: answeringIn(full.questions, channelOf(full.view)),
    }),
    sameComposer,
  );
  // Addressed to someone (a person's card › Message / Ask Claude): the chip says who; sending says it to them.
  const to = useUi((u) => u.to);
  const ref = useRef<HTMLTextAreaElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const channel = channelOf(state.view);
  const agentHere = useAgentNameIn(channel);
  const draftKey = draftKeyOf(state.view);
  // The window's memories of this box (its words, Plan with Tasks, a new worktree's branch) are per computer (BLG-784).
  const machine = useMachine();
  const boxKey = scopedKey(machine, draftKey);
  const shared = state.view.kind === 'shared';
  const compose = state.compose;
  const queue = useMemo(() => queueIn(state, channel, state.selfId), [state.log, channel, state.selfId]);
  // Your newest steered message Claude hasn't read yet: ⇧⌥↩ sends it now (BLG-54).
  const unread = useMemo(() => [...steeredMessages(state.log.filter((l) => l.channel === channel)).waiting.values()].filter((x) => x.waiting === 'next_step').at(-1), [state.log, channel]);
  // Images pasted, dropped or named by their path wait as thumbnails above the text, with an
  // "[image N]" where they go; other pasted files as chips (see use-attachments). They wait with
  // the words, so a new chat or worktree page keeps its own too.
  // Comments on the changes waiting above the box (CommentCards): enough to send on their own.
  const commentsWaiting = useWaitingComments(draftKey).length > 0;
  const ready = !!buffer.trim() || commentsWaiting;
  // A chat's link pasted here becomes a chip. In a friend's worktree, one of yours can take a copy along (see send).
  const chipLinks = (text: string): string | undefined => {
    const words = chatLinksToMentions(text, (r) => chatChipOf(resolveChat(client.store.getState(), r)).label);
    return words && boxChats(words);
  };
  const att = useAttachments({ channel: draftKey, box: ref, text: () => ui.get().buffer, setText: (buffer, cursor) => ui.patch({ buffer, cursor }), chipLinks });
  // A plan or a question waiting above the box: what you type answers it (the turn is waiting on you, not working).
  const answering = state.answering;
  // During a turn, the preference selects the main action. The secondary action uses the other choice.
  const queueing = compose.busy && !answering && (compose.typing || !buffer.trim());
  // Plan First and agents that can't steer queue with either key (a plan message would stop the turn).
  const steerBlock = useSteerBlock(channel);
  const canSteer = !steerBlock;
  const mainAction = sendAction(prefs.sendDuringTurn, { busy: true, canSteer });
  const otherAction = sendAction(prefs.sendDuringTurn, { busy: true, canSteer, secondary: true });
  const actionTip = (action: string): string => action === 'steer'
    ? `Steer: ${agentHere} reads this at its next step, without stopping`
    : steerBlock === 'plan' ? `Queue: in Plan First, this waits for ${agentHere}'s current turn to finish`
    : steerBlock ? `Queue: ${agentHere} cannot steer. This waits for the current turn to finish` : `Queue: this waits for ${agentHere}'s current turn to finish`;
  const plan = state.planMode[channel] === true;
  // Plan with Tasks: this conversation is a plan's home (milestones and tasks, approved onto the board).
  const homePlan = planForHome(state.plans, channel);
  // Picked but nothing sent yet: only the box knows. The plan is made with the first message, so
  // until then the conversation stays an ordinary one everywhere else (sidebar, Overview, its page).
  // A new worktree's page is picked for by its project (new chats and worktrees all share "draft"):
  // its worktree starts as the plan's home.
  const newWorktree = state.view.kind === 'draft_worktree';
  const tasksKey = newWorktree ? boxKey : scopedKey(machine, channel);
  const [, redraw] = useState(0);
  const armed = !homePlan && tasksPicked.has(tasksKey);
  const arm = (on: boolean): void => {
    if (on === tasksPicked.has(tasksKey)) return;
    if (on) tasksPicked.add(tasksKey);
    else tasksPicked.delete(tasksKey);
    redraw((n) => n + 1);
  };
  // While it's being planned (once approved, the conversation is the plan's head and the box is as usual).
  const drafting = Boolean(homePlan && !homePlan.body);
  const tasksMode = drafting || armed;
  // A draft nobody has asked Claude for yet (nothing in it, nothing said): still just a mode you can leave.
  const untouched = drafting && !homePlan?.draft?.milestones.length && !state.log.some((l) => l.type === 'agent' && l.channel === channel);
  // A plan's own conversation (its head Claude plans and runs it here): no modes to pick, the plan is what it's for.
  const planHome = isPlanHome(state.plans, channel) && !untouched;
  const canPlanTasks = state.plans.enabled && (newWorktree || (channel.startsWith('ws:') && state.projects.some((p) => p.root && p.workspaces.some((w) => `ws:${w.id}` === channel))));
  const mode: ComposeMode = tasksMode ? 'tasks' : plan ? 'plan' : 'act';
  const setMode = (next: ComposeMode): void => {
    const leave = (): void => {
      if ((next === 'plan') !== plan) void api.session.setPlanMode(channel, next === 'plan');
    };
    arm(next === 'tasks' && !homePlan);
    // Leaving a draft plan: an empty one just goes; one with something in it is thrown away only if you say so.
    // (Plan mode waits for it to go: a plan's own conversation has none.)
    if (next !== 'tasks' && drafting && homePlan) {
      const discard = (): void => void api.plans.discard(homePlan.id).then(leave, (err: unknown) => toast(client, errorText(err), 'error'));
      if (!homePlan.draft?.milestones.length) return discard();
      openSheet({ kind: 'confirm', title: 'Throw away the draft plan?', message: 'Nothing of it is on the board. To keep it, approve it on its page instead.', confirm: 'Throw Away', destructive: true, run: discard });
      return;
    }
    leave();
  };
  // The box's effects (Settings › Fire & Confetti): on Max effort by default, or everywhere.
  // `burning` is the fire itself; without it, only the confetti and pixels fly.
  const effortHere = shownEffort(state, channel);
  const effects = !shared && effectsOn(prefs.maxFire, effortHere);
  const burning = effects && prefs.maxFire.show !== 'off';
  // A friend's worktree you have a copy of (its project shared whole): you pick where it runs.
  const sharedWs = state.view.kind === 'shared' ? state.shared.find((w) => w.id === (state.view as { id: string }).id && w.via === 'mesh') : undefined;
  const copyOf = sharedWs ? state.sharedProjects.find((p) => p.owner === sharedWs.owner && p.id === sharedWs.projectId)?.copy : undefined;
  const canRunHere = Boolean(sharedWs && copyOf?.state === 'ready');
  const [runOnState, setRunOn] = useState<RunOn>('owner');
  const runOn: RunOn = canRunHere && sharedWs ? (runOnChoice.get(scopedKey(machine, sharedWs.id)) ?? runOnState) : 'owner';
  // Following along, or the owner's Mac can't hear you right now (offline, or an old Beluga): the box is locked,
  // unless what you say goes to your own Claude in your copy.
  const readOnly = state.view.kind === 'shared' && state.view.tab === 'chat' && runOn !== 'here' && (sharedWs?.role === 'view' || Boolean(state.waiting));
  // A new worktree: the branch it starts from and its name (empty: named from the task).
  const draftProject = state.view.kind === 'draft_worktree' ? state.view.projectId : undefined;
  // New work (a new chat or worktree): Runs on picks where it goes.
  const newWork = state.view.kind === 'draft_worktree' || state.view.kind === 'draft' ? { project: state.view.projectId === 'chats' ? undefined : state.view.projectId, folder: state.view.kind === 'draft' ? state.view.dir || undefined : undefined } : undefined;
  const startDeps = useStartDeps();
  const choiceKey = draftProject ? scopedKey(machine, draftProject) : undefined;
  const [worktree, setWorktreeState] = useState<WorktreeChoice>(() => (choiceKey && worktreeChoices.get(choiceKey)) || { name: '' });
  useEffect(() => setWorktreeState((choiceKey && worktreeChoices.get(choiceKey)) || { name: '' }), [choiceKey]);
  const setWorktree = (choice: WorktreeChoice): void => {
    if (choiceKey) worktreeChoices.set(choiceKey, choice);
    setWorktreeState(choice);
  };
  // A side question (/btw): "/btw " turns the box into one; it's answered in the card above, never in the chat.
  // Only where its agent has one (it forks the conversation's session: Claude's, OpenCode's; not Codex's).
  const btwHere = useApp((st) => runtimeHas(runtimeHere(st.projects.flatMap((p) => p.workspaces).find((w) => `ws:${w.id}` === channel)?.agent, st.self), 'btw'));
  const canBtw = channel.startsWith('ws:') && !shared && btwHere;
  const [asideIn, setAsideIn] = useState<string | undefined>(undefined);
  const aside = canBtw && asideIn === channel;
  const btwOpen = useApp((st) => Boolean(st.btw?.[channel]));
  const canCreate = Boolean(buffer.trim() && !buffer.trim().startsWith('/')) || Boolean(worktree.name.trim());

  // "@src/au" in a worktree: its folders and files (loaded as you type into a folder).
  const wsId = worktreeOf(channel);
  const atDir = wsId ? mentionDir(buffer) : undefined;
  useEffect(() => {
    if (wsId && atDir !== undefined) void api.files.loadDir({ owner: state.selfId, share: shareNameOf(wsId), path: atDir });
  }, [wsId, atDir, state.selfId]);
  // "@BLG-24": a task on your board (not in a workspace someone shared with you: their Claude has its own).
  const mentionWorld = useMentionWorld(channel, { tasks: !shared, project: state.project });
  // "@login": a chat of yours, or one shared with you (in a friend's worktree too: a copy of yours can go along, see send).
  const chats = useChatMentions(channel, typedMention(buffer) !== undefined);
  // "/fron…": Claude's skills and custom commands here, beside Beluga's commands.
  const skills = useSkills(channel, !shared && buffer.startsWith('/') && !buffer.includes(' '));
  // On Codex they're translated: each says what doesn't carry over (BLG-461).
  const skillsOn = useApp((st) => (fallbackFor(runtimeHere(st.projects.flatMap((p) => p.workspaces).find((w) => w.id === wsId)?.agent, st.self), 'skills') ? 'mapped' : 'native'));

  // Your agents (which run on this Mac), for the room's "@codex" (BLG-520).
  const runtimes = useApp((st) => st.runtimes);
  // In a friend's worktree, "@claude" is yours (reading theirs from here, or in your copy) and "@claude:<them>" theirs.
  const sharedOwner = shared ? state.shared.find((w) => w.id === (state.view as { id: string }).id)?.owner : undefined;
  const ownerName = sharedOwner ? peerName({ ...state, network: { friends: state.friends } }, sharedOwner) : undefined;
  const claudeHere = !ownerName
    ? undefined
    : runOn === 'here'
      ? { hint: 'ask your agent, in your copy' }
      : { hint: `ask your agent: it reads ${ownerName}’s worktree from here`, owner: { name: ownerName, hint: `ask ${ownerName}’s agent, in their worktree` } };
  // Suggestions as you type: commands, people and Claudes, workspaces, folders, tasks.
  const suggestions: Suggestion[] = useMemo(
    () =>
      !buffer
        ? []
        : suggest(buffer, {
            peers: state.peers,
            selfId: state.selfId,
            dirCache: state.dirCache,
            listLocalDirs: (dir) => state.dirCache[localDirKey(dir)] ?? [],
            workspaces: state.view.kind === 'room' ? workspaceMentions(state.projects) : [],
            // In the room: each agent by name, with its mark ("@codex", "@bob:codex", BLG-520).
            ...(state.view.kind === 'room' ? { agentTags: roomAgentTags(state.peers, state.selfId, runtimes) } : {}),
            friends: state.friends,
            projects: state.projects.filter((p) => p.root),
            ...(wsId ? { entries: (dir: string) => state.dirCache[`${state.selfId}:${shareNameOf(wsId)}/${dir}`] } : {}),
            ...(mentionWorld.tasks ? { tasks: mentionWorld.tasks } : {}),
            chats,
            skills,
            skillsOn,
            ...(canBtw ? {} : { without: ['btw'] }),
            ...(claudeHere ? { claudeHere } : {}),
          }),
    [buffer, state.peers, state.selfId, state.dirCache, state.view.kind, state.projects, state.friends, wsId, mentionWorld.tasks, chats, skills, skillsOn, canBtw, runtimes, claudeHere?.hint],
  );
  const sug = useSuggestions(suggestions, buffer, (picked) => accept(picked));

  // Folders to suggest for "/project add …", and shared files for "/open …".
  const localDir = localDirOf(buffer);
  useEffect(() => {
    if (localDir !== undefined) void api.local.listDirs(localDir);
  }, [localDir]);
  const target = openTarget(buffer, state.peers);
  const targetKey = target ? `${target.owner}:${target.share}/${target.path}` : '';
  useEffect(() => {
    if (target) void api.files.loadDir(target);
  }, [targetKey]);

  // Grow with what you write, up to a dozen lines.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 12 * 20 + 16)}px`;
  }, [buffer]);
  // Each chat keeps its own unsent words: going to another puts its words in the box, never these.
  useLayoutEffect(() => {
    if (boxOf !== undefined && boxOf !== boxKey) {
      const text = drafts.get(boxKey) ?? '';
      ui.patch({ buffer: text, cursor: text.length, historyIndex: -1 });
      sug.reset();
    }
    boxOf = boxKey;
  }, [boxKey]);
  // A chat's row dropped here: its chip at the cursor. It waits in the words: it never sends.
  useDraftChips(draftKey, (words) => {
    const text = ui.get().buffer;
    const at = ref.current?.value === text ? ref.current.selectionStart : text.length;
    const next = withChatWords(text, at, boxChats(words));
    ui.patch({ buffer: next.text, cursor: next.caret });
    caretAfterDraw(ref, next.caret);
  });
  useEffect(() => {
    const text = ui.get().buffer;
    if (text) drafts.set(boxKey, text);
    else drafts.delete(boxKey);
  }, [boxKey, buffer]);
  useEffect(() => {
    const focus = (): void => ref.current?.focus();
    document.addEventListener('beluga:focus-composer', focus);
    return () => document.removeEventListener('beluga:focus-composer', focus);
  }, []);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [state.view, autoFocus]);

  /** The message you were just warned holds a secret. */
  const secretWarned = useRef<string | undefined>(undefined);
  const set = (raw: string): void => {
    const btw = canBtw && !aside ? /^\/btw\s+/.exec(raw) : null;
    if (btw) setAsideIn(channel);
    const text = btw ? raw.slice(btw[0].length) : raw;
    ui.patch({ buffer: text, cursor: text.length });
    sug.reset();
  };
  /** The first message of a new worktree starts it (on the chosen branch, with the chosen name). */
  const createWorktree = (projectId: string, text: string): void => {
    const name = worktree.name.trim();
    // Seen as its terminal (Settings › Terminal): the terminal opens on this message (BLG-553).
    const terminal = Boolean(text.trim()) && sendsToTerminal(client.store.getState(), getPrefs(), 'draft', worktree.agent?.runtime);
    // Started in the mode the picker shows (Act, Plan First or Plan with Tasks).
    const mode = worktreeMode({ terminal, plan: client.store.getState().planMode.draft === true, tasks: armed });
    const opts = { ...(worktree.base ? { base: worktree.base } : {}), ...(name ? { name } : {}), ...(worktree.agent ? { agent: worktree.agent } : {}), ...mode };
    // Runs on one of your computers (BLG-788): made there, in the same project, and opened at once.
    // Held (the computer Runs on names can't take it now): nothing starts, the words stay in the box.
    const sent = sendToComputer(startDeps, projectId, worktree.agent?.runtime ?? myRuntime(client.store.getState().prefs), { kind: 'worktree', text, opts });
    if (sent === 'held') return keepWords(text);
    // Its words left the box when it was sent; its branch and name go with them.
    worktreeChoices.delete(scopedKey(machine, projectId));
    setWorktreeState({ name: '' });
    arm(false);
    if (sent === 'sent') return;
    // Its row and "Making…" page show at once (BLG-942), whatever the daemon is busy with; a failure takes them away again.
    // The draft's words went with it: forgotten now, as the page changes in this same moment (no render in between to do it).
    drafts.delete(boxKey);
    const ahead = makeAhead(client, projectId, name || text || 'worktree', { ...(worktree.base ? { base: worktree.base } : {}), asked: text });
    void api.workspaces.startWorktree(projectId, text, { ...(worktree.base ? { base: worktree.base } : {}), ...(name ? { name } : {}), ...(worktree.agent ? { agent: worktree.agent } : {}), ...mode, ...(ahead ? { id: ahead.id } : {}) }).catch((err: unknown) => {
      ahead?.drop();
      keepWords(text);
      toast(client, `Couldn't create the worktree: ${errorText(err)}`, 'error');
    });
  };
  /** Held for a computer that can't take it now: the words go back in the box, nothing was sent. */
  const keepWords = (text: string): void => {
    if (!ui.get().buffer) ui.patch({ buffer: text, cursor: text.length });
  };
  const deliver = (text: string, urgent: boolean): void => {
    if (readOnly) return;
    if (runOn === 'here' && sharedWs && !text.startsWith('/')) {
      set('');
      void api.sharing.runHere(sharedWs.owner, sharedWs.id, text).catch((err: unknown) => toast(client, `Couldn’t start it here: ${errorText(err)}`, 'error'));
      return;
    }
    // /invite adds a friend, or adds friends to what's on screen (BLG-203): done here, where the view is known.
    if (handleInvite(client, ui, text)) return;
    if (draftProject && !text.startsWith('/')) return createWorktree(draftProject, text);
    // A new chat (in a project, outside one, or in a folder), Runs on one of your computers (BLG-788,
    // BLG-841): started there; held, never here instead, when the computer named can't take it.
    const v = client.store.getState().view;
    if (v.kind === 'draft' && !text.startsWith('/')) {
      const sent = sendToComputer(startDeps, v.projectId, myRuntime(client.store.getState().prefs), { kind: 'chat', text }, v.dir || undefined);
      if (sent === 'held') return keepWords(text);
      if (sent === 'sent') return;
    }
    if (to && !text.startsWith('/')) {
      ui.patch({ to: undefined });
      return actions.submit(`${recipientPrefix(to)}${text}`, urgent);
    }
    // Plan with Tasks, first message: the plan is made now, and this is what Claude plans from.
    if (armed && !text.startsWith('/')) {
      api.plans.here(channel).then(
        () => (arm(false), actions.submit(text, urgent)),
        (err: unknown) => {
          if (!ui.get().buffer) ui.patch({ buffer: text, cursor: text.length });
          toast(client, errorText(err), 'error');
        },
      );
      return;
    }
    actions.submit(text, urgent);
  };
  /** Chats of yours that the words name, when this chat is another person's and goes to their agent. */
  const ownChatsNamed = (typed: string): Array<{ readonly ref: string; readonly title: string }> => {
    if (state.view.kind !== 'shared' || runOn === 'here' || typed.startsWith('/')) return [];
    const now = client.store.getState();
    const mine = chatMentionsIn(typed).flatMap((m) => {
      const ref = parseChatRef(m.ref);
      const chat = ref && ref.owner === now.selfId ? resolveChat(now, ref) : undefined;
      return chat && chat.state !== 'removed' ? [{ ref: m.ref, title: chat.title ?? m.title }] : [];
    });
    return mine.filter((c, i) => mine.findIndex((x) => x.ref === c.ref) === i);
  };
  const shareCopyPerson = state.view.kind === 'shared' ? peerName(state, state.view.owner) : '';
  /** Share Copy: each copy is made now and waits as a file, then goes with the message. False when one couldn't be made. */
  const shareCopies = async (ours: ReadonlyArray<{ readonly ref: string; readonly title: string }>): Promise<boolean> => {
    try {
      for (const c of ours) {
        const copy = await api.chats.snapshot(c.ref);
        if (!copy) throw new Error(`“${c.title}” is not a chat of yours`);
        att.addCopy(copy);
      }
      return true;
    } catch (err) {
      toast(client, `Couldn’t make the copy: ${errorText(err)}`, 'error');
      return false;
    }
  };
  /** `copied`: you answered the copy question for these words already. */
  const send = (secondary = false, copied = false): void => {
    const urgent = sendsUrgent(prefs.sendDuringTurn, { busy: queueing, canSteer, secondary });
    const typed = buffer.trim();
    if (aside) {
      if (!typed) return;
      askBtw(client, api, channel, plainWords(typed, client.store.getState()));
      setAsideIn(undefined);
      ui.patch({ buffer: '', cursor: 0, history: [...ui.get().history, `/btw ${typed}`].slice(-200), historyIndex: -1 });
      return;
    }
    // A password on its way to the whole room: stop once and say where it belongs (sending again sends it).
    const secret = state.view.kind === 'room' && !typed.startsWith('/') ? secretIn(typed) : undefined;
    if (secret && secretWarned.current !== typed) {
      secretWarned.current = typed;
      toast(client, `That looks like ${secret}, and everyone in the room would see it. Put it in Settings › Environment instead: your ${agent} uses it from there. Send again to share it anyway.`, 'warn');
      return;
    }
    secretWarned.current = undefined;
    // Chats of yours named in a chat another person owns: their agent can't read them, so you say if a copy goes (BLG-152).
    const ours = copied ? [] : ownChatsNamed(plainWords(typed, client.store.getState()));
    if (ours.length) {
      openSheet({ kind: 'share_copy', titles: ours.map((c) => c.title), person: shareCopyPerson, share: () => void shareCopies(ours).then((ok) => ok && send(secondary, true)), without: () => send(secondary, true) });
      return;
    }
    // Images stay where you referenced them in the words; any you took the reference out of go after them.
    const { text: words, images, shown, putBack: putFilesBack } = att.take(typed);
    // Comments on the changes waiting above the box go after the words (views/diff-comments.ts).
    const notes = typed.startsWith('/') ? undefined : takeComments(draftKey);
    const text = withComments(words, notes?.comments ?? []);
    const putBack = (): void => {
      putFilesBack();
      notes?.putBack();
    };
    if (!text && !(draftProject && worktree.name.trim())) {
      if (draftProject) toast(client, 'Describe the task, or give the worktree a name', 'info');
      return;
    }
    if (!text && draftProject) return createWorktree(draftProject, '');
    // The words fly from the box into the chat (or into the queue while Claude works): see flight.ts.
    if (typed && !typed.startsWith('/') && !draftProject && !pending) {
      const live = state.log.some((l) => l.type === 'agent' && l.channel === channel && isRunning(l.status));
      launchFlight({ channel, target: queueing && compose.typing && !urgent ? 'queue' : 'chat', text: typed, from: ref.current, live });
      // Steering joins the turn Claude is on (no new card to wait for).
      if (compose.typing && !compose.busy) {
        const here = state.log.filter((l) => l.channel === channel);
        expectClaude(channel, here.filter((l) => l.type === 'agent').length, lastMineIn(here, state.selfId));
      }
    }
    ui.patch({ buffer: '', cursor: 0, history: [...ui.get().history, typed].slice(-200), historyIndex: -1 });
    // Image chips become links to the images (Beluga keeps them) before the message goes.
    if (text.includes('[image ') && !text.startsWith('/')) {
      // An image still being saved is waited for (it showed in the box at once).
      att
        .saved(images)
        .then((real) => api.attachments.expand(text, channel, [...real], [...shown]))
        .then(
        (expanded) => deliver(expanded, urgent),
        (err: unknown) => {
          // Put the message and its images back so nothing is lost.
          if (!ui.get().buffer) ui.patch({ buffer: typed, cursor: typed.length });
          putBack();
          toast(client, `Couldn't send the images: ${errorText(err)}`, 'error');
        },
      );
      return;
    }
    deliver(text, urgent);
  };
  // Speaking instead of typing (Settings › Voice): the words come here when this is the box you're in; Send right away sends them as ↩ would.
  useDictationTarget(ref, () => send(false), draftKey);
  const dictation = useDictation();
  const talking = dictation.kind !== 'off' && dictatingInto(ref.current);
  /** A queued message pulled back to edit: into the box, ahead of anything already there. */
  const editQueued = async (sent: string): Promise<void> => {
    // Its images wait above the box again, each an "[image N]" in the words (not the link it went as).
    const prompt = await att.restore(sent);
    const toClaude = channel === 'room' && state.peers.length > 1 && !prompt.startsWith('@') ? `@claude ${prompt}` : prompt;
    const current = ui.get().buffer.trim();
    set(current ? `${toClaude}\n${current}` : toClaude);
    ref.current?.focus();
  };
  const sendKeys = prefs.sendWith === 'enter' ? '↩' : chordLabel('Cmd+Enter');
  function accept(picked: Suggestion): void {
    if (picked.enter === 'submit') {
      ui.patch({ buffer: '', cursor: 0 });
      // A friend picked for "/invite": handled here like a typed one (BLG-340), not by the daemon.
      if (!handleInvite(client, ui, picked.value)) actions.submit(picked.value);
      return;
    }
    // A chat picked: its mention written short, a chip with its title.
    set(picked.kind === 'chat' ? boxChats(picked.value) : picked.value);
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter while an input method is composing (Japanese, Chinese…) picks the characters.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // Shift-Tab switches between acting and planning first, as in Claude Code (not focus).
    if (isShortcut('composer-mode', e) && !shared && !planHome) {
      e.preventDefault();
      setMode(nextMode(mode));
      return;
    }
    const modKey = e.metaKey || e.ctrlKey;
    if (sug.onKeyDown(e)) return;
    if (att.onRefKey(e)) return;
    // Backspace in an empty side question: back to an ordinary message.
    if (aside && e.key === 'Backspace' && !buffer) {
      e.preventDefault();
      setAsideIn(undefined);
      return;
    }
    if (e.key === 'Escape') {
      if (aside) setAsideIn(undefined);
      else if (pending) ui.patch({ pending: undefined, buffer: '' });
      else if (to) ui.patch({ to: undefined });
      else if (btwOpen && !buffer) void api.session.btwDismiss(channel);
      else if (state.view.kind === 'draft' || state.view.kind === 'draft_worktree') client.store.dispatch({ type: 'view', view: state.view.back });
      return;
    }
    // ⇧⌥↩: the steered message Claude hasn't read yet goes now (its step stops); what's in the box stays.
    if (unread && isShortcut('composer-send-now', e)) {
      e.preventDefault();
      sendSteerNow(client, unread.request);
      return;
    }
    // ⌥↩ uses the other send action during a turn (outside one, with Queue as the default, it goes first in line).
    if (isShortcut('composer-steer', e)) {
      e.preventDefault();
      send(true);
      return;
    }
    if (e.key === 'Enter') {
      const sends = prefs.sendWith === 'enter' ? !e.shiftKey && !modKey : modKey;
      // A ⌥ chord that isn't steering is no Send.
      if (e.altKey) return;
      if (sends) {
        e.preventDefault();
        send(false);
      }
      return;
    }
    // ↑ on an empty box brings back what you sent last.
    if (e.key === 'ArrowUp' && !buffer) {
      const h = ui.get().history;
      if (h.length) {
        e.preventDefault();
        set(h[h.length - 1]!);
      }
    }
  };
  const askingFor = pending
    ? pending.kind === 'peer_run'
      ? 'Command'
      : pending.kind === 'remote'
        ? 'Task'
        : pending.kind === 'setup' || pending.kind === 'run'
          ? `${pending.kind[0]!.toUpperCase()}${pending.kind.slice(1)} command`
          : `New ${pending.kind}`
    : undefined;

  return (
    <div className={s.wrap}>
      {att.dropTarget}
      {sug.list}
      {canBtw ? <BtwCard channel={channel} /> : null}
      <QueueTray queue={queue} selfName={state.self?.name ?? ''} onEdit={(prompt) => void editQueued(prompt)} />
      <div
        ref={boxRef}
        style={effects ? (fireVars(prefs.maxFire) as React.CSSProperties) : undefined}
        data-fire={burning ? prefs.maxFire.show : undefined}
        className={cx(s.box, burning ? (prefs.maxFire.border ? m.max : m.maxPlain) : effects && m.fxOnly, pending && s.asking, readOnly && s.readOnly, att.dropping && s.dropping, (plan || tasksMode || aside || answering === 'plan') && s.planning)}
        data-plan={plan || tasksMode || aside || answering === 'plan' || undefined}
        data-mode={aside ? 'btw' : answering === 'plan' ? 'plan' : mode}
        data-chat-box={shared ? (readOnly ? undefined : draftKey) : (isAddressableChannel(channel) || state.view.kind === 'draft' || state.view.kind === 'draft_worktree') ? draftKey : undefined}
        {...att.dropProps}
      >
        {effects ? <MaxFire box={boxRef} input={ref} /> : null}
        {aside ? (
          <div className={s.planBanner} role="status">
            <span className={s.planTag}>
              <Icon name="sparkles" size={11} />
              By the way
            </span>
            <span className={s.planHint}>A side question: answered above, {agentHere} keeps working and won’t remember it</span>
            <span className={s.flex} />
            <span className={s.planKeys}>
              <Kbd>esc</Kbd> to leave
            </span>
          </div>
        ) : answering === 'plan' ? (
          <div className={s.planBanner} role="status">
            <span className={s.planTag}>
              <Icon name="wand" size={11} />
              Plan Review
            </span>
            <span className={s.planHint}>What you write goes back to {agentHere} as changes to the plan</span>
          </div>
        ) : mode !== 'act' ? (
          <div className={s.planBanner} role="status">
            <span className={s.planTag}>
              <Icon name={mode === 'tasks' ? 'graph' : 'wand'} size={11} />
              {mode === 'plan' ? 'Planning' : MODE_INFO[mode].label}
            </span>
            <span className={s.planHint}>{MODE_INFO[mode].banner}</span>
            <span className={s.flex} />
            {mode === 'tasks' && homePlan ? (
              <button type="button" className={s.planLink} onClick={() => actions.run({ type: 'view', view: { kind: 'plan', id: homePlan.id } })}>
                Open Plan
              </button>
            ) : planHome ? null : (
              <span className={s.planKeys}>
                <Kbd>{shortcutKeys('composer-mode')}</Kbd> to act
              </span>
            )}
          </div>
        ) : null}
        {draftProject ? <WorktreeDraft projectId={draftProject} choice={worktree} onChange={setWorktree} /> : null}
        {to ? (
          <div className={s.askChip} aria-label={`To ${recipientLabel(to)}`}>
            To {recipientLabel(to)}
            <button type="button" aria-label="Don’t address it" onClick={() => ui.patch({ to: undefined })}>
              <Icon name="x" size={10} />
            </button>
          </div>
        ) : null}
        {askingFor ? (
          <div className={s.askChip}>
            {askingFor}
            <button type="button" aria-label="Cancel" onClick={() => ui.patch({ pending: undefined, buffer: '' })}>
              <Icon name="x" size={10} />
            </button>
          </div>
        ) : null}
        {att.waiting}
        <CommentCards box={draftKey} />
        <MentionedTasks text={buffer} world={mentionWorld} />
        <MentionedChats text={buffer} world={mentionWorld} />
        <DictationStrip box={ref} />
        <div className={s.inputWrap}>
          <MentionHighlighter text={buffer} world={mentionWorld} input={ref} className={s.input ?? ""} />
          <textarea
            ref={ref}
            className={`${s.input} ${s.overHighlight} selectable`}
            data-composer
            rows={1}
            value={buffer}
            disabled={readOnly}
            placeholder={aside ? `Ask ${agentHere} something on the side…` : to ? `Message ${recipientLabel(to)}` : mode === 'tasks' && !homePlan?.body && !homePlan?.draft?.milestones.length ? `Describe what to build: ${agent} plans it into milestones and tasks` : state.placeholder}
            onChange={(e) => set(e.target.value)}
            onKeyDown={onKey}
            onPaste={att.onPaste}
            spellCheck
          />
        </div>
        <div className={s.bar}>
          {planHome && homePlan ? (
            <ActionsDropdown
              align="start"
              items={[
                { label: 'Open the Plan', onSelect: () => actions.run({ type: 'view', view: { kind: 'plan', id: homePlan.id } }) },
                // While it's a draft nothing is on the board: it can go (asked first when it has something in it).
                ...(tasksMode ? [{ label: 'Discard the Draft', danger: true, separate: true, onSelect: () => setMode('act') }] : []),
              ]}
            >
              <button type="button" className={cx(s.chip, s.chipOn)} title="This conversation is the plan’s own: its agent plans and runs it here" aria-label={`Mode: ${MODE_INFO.tasks.label}`}>
                <Icon name="graph" size={12} />
                {tasksMode ? MODE_INFO.tasks.label : 'Plan'}
                <Icon name="chevronDown" size={9} />
              </button>
            </ActionsDropdown>
          ) : !shared ? (
            <ActionsDropdown
              align="start"
              items={(['act', 'plan', 'tasks'] as const)
                .filter((m) => m !== 'tasks' || canPlanTasks || tasksMode)
                .map((m) => ({ label: MODE_INFO[m].label, hint: MODE_INFO[m].hint, checked: mode === m, onSelect: () => setMode(m) }))}
            >
              <button type="button" className={cx(s.chip, mode !== 'act' && s.chipOn)} title={mode === 'tasks' ? MODE_INFO[mode].hint : `${MODE_INFO[mode].hint} (${shortcutKeys('composer-mode') ?? 'Settings › Keyboard'} switches acting and planning first)`} aria-label={`Mode: ${MODE_INFO[mode].label}`}>
                <Icon name={mode === 'tasks' ? 'graph' : 'wand'} size={12} />
                <span className={s.chipLabel}>{MODE_INFO[mode].label}</span>
                <Icon name="chevronDown" size={9} />
              </button>
            </ActionsDropdown>
          ) : null}
          {canRunHere && sharedWs ? <RunOnChip wsId={sharedWs.id} ownerName={state.sharedProjects.find((p) => p.owner === sharedWs.owner)?.ownerName ?? 'Their'} value={runOn} onChange={setRunOn} /> : null}
          {!shared ? <ModelPicker channel={channel} {...(draftProject ? { draft: worktree.agent, onDraft: (agent: AgentRef | undefined) => setWorktree({ ...worktree, agent }) } : {})} /> : null}
          {/* Where new work runs (BLG-786); a chat that runs somewhere already says where. Only with a computer paired. */}
          {shared ? null : newWork ? <RunsOnPicker {...(newWork.project ? { project: newWork.project } : {})} {...(worktree.agent?.runtime && draftProject ? { runtime: worktree.agent.runtime } : {})} {...(newWork.folder ? { folder: newWork.folder } : {})} /> : <RunsOnLabel />}
          {burning && effortHere === 'max' ? (
            <Tip label={`Max effort: ${agentHere} thinks as hard as it can`}>
              <span className={m.tag}>
                <Icon name="flame" size={11} className={m.flicker} />
                Max
              </span>
            </Tip>
          ) : null}
          <span className={s.flex} />
          {/* Your MCP servers, on the box's right beside how full the context is (BLG-252). */}
          {!shared ? <McpChip /> : null}
          {channel !== 'draft' ? <ContextMeter channel={channel} /> : null}
          {/* While you talk, only your voice's control shows: two square buttons side by side stopped Claude by mistake. */}
          {compose.busy && !talking ? (
            <Tip label={`Stop ${agentHere} here · your queued messages come back to the box`} keys={shortcutKeys('conv-stop')}>
              <button type="button" className={s.stop} aria-label={`Stop ${agentHere}`} onClick={() => stopClaude({ client, ui, actions }, channel)}>
                <span className={s.stopMark} />
              </button>
            </Tip>
          ) : null}
          {!readOnly ? <MicButton box={ref} /> : null}
          {draftProject ? (
            <Tip label={worktree.name.trim() && !buffer.trim() ? `Create ${worktree.name.trim()} without a task` : `Make the branch and folder, then ${worktree.agent ? agentName(worktree.agent) : agent} starts on the task`} keys={sendKeys}>
              <button type="button" className={cx(d.create, canCreate && d.createReady)} onClick={() => send(false)} aria-disabled={!canCreate}>
                <Icon name="branch" size={12} />
                Create Worktree
                <span className={d.createKey}>{sendKeys}</span>
              </button>
            </Tip>
          ) : aside ? (
            <Tip label="Ask on the side: the answer shows above the box, the conversation never sees it" keys={sendKeys}>
              <button type="button" className={cx(s.send, buffer.trim() && s.sendReady)} onClick={() => send(false)} aria-label="Ask on the side" disabled={!buffer.trim()}>
                <Icon name="send" size={14} />
              </button>
            </Tip>
          ) : answering ? (
            <Tip label={answerSend(answering, agentHere).tip} keys={sendKeys}>
              <button type="button" className={cx(s.split, s.answer, ready && s.splitReady)} onClick={() => send(false)} disabled={!ready}>
                <Icon name="send" size={12} />
                <span className={s.chipLabel}>{answerSend(answering, agentHere).label}</span>
              </button>
            </Tip>
          ) : queueing ? (
            <div className={cx(s.split, buffer.trim() && s.splitReady)} role="group" aria-label={`${agentHere} is working`}>
              <Tip label={actionTip(mainAction)} keys={sendKeys}>
                <button type="button" className={s.splitMain} aria-label={upFirst(mainAction)} onClick={() => send(false)} disabled={!ready}>
                  <Icon name={mainAction === 'steer' ? 'send' : 'clock'} size={12} />
                  <span className={s.chipLabel}>{upFirst(mainAction)}</span>
                </button>
              </Tip>
              {canSteer ? <Tip label={actionTip(otherAction)} keys={shortcutKeys('composer-steer')}>
                <button type="button" className={s.splitAlt} onClick={() => send(true)} disabled={!ready}>
                  {upFirst(otherAction)}
                </button>
              </Tip> : null}
            </div>
          ) : (
            <Tip label={prefs.sendWith === 'enter' ? `Send · Shift+${returnName()} for a new line` : `Send · ${cmdReturn()}`} keys={prefs.sendWith === 'enter' ? '↩' : chordLabel('Cmd+Enter')}>
              <button type="button" className={cx(s.send, ready && s.sendReady)} onClick={() => send(false)} aria-label="Send" disabled={!ready}>
                <Icon name="send" size={14} />
              </button>
            </Tip>
          )}
        </div>
      </div>
      {/* Keys are shown only when they change what Return does (Mac apps don't keep a legend up). */}
      {(queueing && !aside) || draftProject ? (
      <div className={s.legend}>
        {queueing ? (
          <>
            <Kbd>{sendKeys}</Kbd> {mainAction} ·{canSteer && shortcutKeys('composer-steer') ? (
              <>
                {' '}
                <Kbd>{shortcutKeys('composer-steer')}</Kbd> {otherAction} ·
              </>
            ) : null}
            {steerBlock ? ` ${steerBlockNote(steerBlock)} · ` : null}
            {unread && shortcutKeys('composer-send-now') ? (
              <>
                {' '}
                <Kbd>{shortcutKeys('composer-send-now')}</Kbd> send now ·
              </>
            ) : null}
            {shortcutKeys('conv-stop') ? (
              <>
                {' '}
                <Kbd>{shortcutKeys('conv-stop')}</Kbd> stop
              </>
            ) : null}
            {canBtw ? (
              <>
                {' '}
                · <Kbd>/btw</Kbd> ask on the side
              </>
            ) : null}
          </>
        ) : (
          <>
            <Kbd>{sendKeys}</Kbd> create the worktree · <Kbd>esc</Kbd> cancel
          </>
        )}
      </div>
      ) : null}
    </div>
  );
}
