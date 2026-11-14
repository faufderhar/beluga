import type { PhoneArgs, PhoneMethod } from '../../../../src/companion/calls';
import type { ThreadChildren } from '../../../../src/shared/threads';
import type { NeedsYou, PhoneBranchStep, Topic, VoiceModelId } from './protocol';

/**
 * Every call the phone makes, typed through the Mac's own list (src/companion/calls.ts:
 * `PhoneCalls`, the `phone` methods of coverage.ts with the very argument tuples the daemon
 * checks). A method renamed or an argument changed on the Mac fails `npm run typecheck` here.
 * Type-only import: nothing of the daemon's API is bundled into the app.
 *
 * Needs-you items carry their own calls (`actions`, and `answer` for picks and words), made as the
 * Mac wrote them.
 */
export interface Call<M extends PhoneMethod = PhoneMethod> {
  readonly method: M;
  readonly args: PhoneArgs<M>;
  /** How the outbox names it while your Mac is asleep ("Send 'Run the tests'"). */
  readonly label: string;
}

const make = <M extends PhoneMethod>(method: M, args: PhoneArgs<M>, label: string): Call => ({ method, args, label }) as unknown as Call;

/** One of Your Mac's chats' topics → its id (`main` is the first, `conv:mac:assistant`). */
const macChatOf = (topic: Topic): string => (topic === 'conv:mac:assistant' ? 'main' : topic.slice('conv:mac:assistant:'.length));
/** `conv:<channel>` → the channel the daemon's session methods take. */
export const channelOf = (topic: Topic): string => topic.replace(/^conv:/, '');
/** `chat:dm:<peerId>` → `dm:<peerId>` (what the network methods call a conversation). */
export const conversationOf = (topic: Topic): string => topic.replace(/^chat:/, '');

const short = (text: string): string => (text.length > 32 ? `${text.slice(0, 31)}…` : text);
/** `up:` refs of files the phone `put` (store.put), to send along. */
type Files = readonly string[] | undefined;
/** An agent as the calls send it (src/protocol.ts AgentRef). */
type PickedRef = { runtime: string; label: string; model?: string };
const withFiles = (files: Files) => (files?.length ? { files: [...files] } : {});

/** One task's draft as the phone sends it back to be added. */
type PhoneDraft = { title: string; goal: string; acceptance: string[]; labels: string[]; priority?: 'urgent' | 'high' | 'medium' | 'low'; for?: string };

export const calls = {
  /** Since 1.13 (BLG-127): keep the Mac awake for the phone, never, on power or always. */
  keepAwake: (mode: 'off' | 'power' | 'always'): Call => make('companion.keepAwake', [mode], 'Keep your Mac awake'),
  telemetry: (level: 'off' | 'limited' | 'on'): Call => make('telemetry.choose', [level, 'settings'], 'Usage statistics'),
  /** Since 1.32 (BLG-459): one of your providers (by its runtime) becomes your default agent. */
  defaultAgent: (runtime: string): Call => make('companion.defaultAgent', [runtime], 'Make it your default agent'),
  /** 1.14: a new empty chat on Your Mac (open on the Mac now) → its id; one deleted for good. */
  newMacChat: (): Call => make('assistant.newChat', [], 'New chat'),
  deleteMacChat: (topic: Topic): Call => make('assistant.deleteChat', [macChatOf(topic)], 'Delete the chat'),
  /** A chat's id → its topic: the first (`main`) keeps `conv:mac:assistant`. */
  macChatTopic: (id: string): Topic => (id === 'main' ? 'conv:mac:assistant' : `conv:mac:assistant:${id}`) as Topic,
  /** 1.44 (BLG-74): a chat's category, as its sheet in Work changes it. The setting itself stays the Mac's. */
  settle: (topic: Topic): Call => make('triage.settle', [channelOf(topic)], 'Settle'),
  unsettle: (topic: Topic): Call => make('triage.unsettle', [channelOf(topic)], 'Un-settle'),
  snooze: (topic: Topic, until: number): Call => make('triage.snooze', [channelOf(topic), until], 'Remind Me Later'),
  wake: (topic: Topic): Call => make('triage.wake', [channelOf(topic)], 'Show Again Now'),
  /** A message in a conversation (yours, or shared with you to work in), with photos. */
  send: (topic: Topic, text: string, files?: Files): Call => make('companion.ask', [{ target: { topic }, text, ...withFiles(files) }], `Send "${short(text)}"`),
  /** Ask your Mac in a project: a new conversation there (its topic comes back). */
  ask: (project: string, text: string, files?: Files): Call => make('companion.ask', [{ target: { project }, text, ...withFiles(files) }], `Ask "${short(text)}"`),
  /**
   * Since 1.5, in a project, what the Mac's project home offers besides a question: a new worktree
   * with Claude on your words (`plan`: it plans first, as the Mac's Plan mode), → its id; or a plan
   * Claude drafts for you to approve, → the plan.
   */
  // `agent` (1.35, BLG-506): who works it; only to a Mac with SINCE.workAgents (the caller checks).
  startWorktree: (project: string, text: string, plan = false, agent?: PickedRef): Call => make('workspaces.startWorktree', [project, text, { quiet: true, ...(plan ? { plan: true } : {}), ...(agent ? { agent } : {}) }], `Start "${short(text)}"`),
  /** 1.12: a new worktree with photos: its words and photos go the way a question's do → its topic. */
  startWorktreeWith: (project: string, text: string, plan: boolean, files: Files, agent?: PickedRef): Call => make('companion.ask', [{ target: { project, worktree: true, ...(plan ? { plan: true } : {}), ...(agent ? { agent } : {}) }, text, ...withFiles(files) }], `Start "${short(text)}"`),
  createPlan: (project: string, goal: string): Call => make('plans.create', [{ projectId: project, goal }], `Plan "${short(goal)}"`),
  /** How a plan runs (1.5): Step by Step, Check-ins or Autopilot. */
  setAutonomy: (plan: string, autonomy: 'step' | 'gated' | 'autopilot', label: string): Call => make('plans.setAutonomy', [plan, autonomy], `Run as ${label}`),
  /** 1.32 (BLG-446): a model of this conversation's runtime, or another runtime's agent (null: your default again). */
  setModel: (topic: Topic, value: string, label: string): Call => make('workbench.setModel', [channelOf(topic), value], `Use ${label}`),
  setAgent: (topic: Topic, agent: { runtime: string; label: string; model?: string } | null, label: string): Call => make('workbench.setAgent', [channelOf(topic), agent], `Use ${label}`),
  stop: (topic: Topic): Call => make('host.stopRun', [channelOf(topic)], 'Stop'),
  /** 1.38 (BLG-122): external agents: who holds a grant, what they did, and stopping them. */
  externalAgents: (): Call => make('external.agents', [], 'External agents'),
  externalActivity: (kind?: 'allowed' | 'asked' | 'refused'): Call => make('external.activity', [kind ? { kind } : {}], 'Activity'),
  externalStop: (agent: string, name: string): Call => make('external.stopAgent', [agent], `Stop ${short(name)}`),
  externalStopAll: (): Call => make('external.stopAll', [], 'Stop all agents'),
  externalRevoke: (agent: string, name: string): Call => make('external.revoke', [agent], `Revoke ${short(name)}`),
  /** Give a conversation the Mac's terminal drives back to the chat (1.36, BLG-534). */
  takeOver: (topic: Topic): Call => make('agentTerm.takeOver', [channelOf(topic).replace(/^ws:/, '')], 'Take over'),
  /** A request you asked of a friend's Claude (a `conv:task:<id>`): stop it, or (1.27) remove it from your lists. */
  /** 1.27: take a needs-you item off every list (here and the Mac's) without answering it. */
  dismissNeed: (id: string): Call => make('needs.dismiss', [id], 'Dismiss'),
  cancelTask: (id: string): Call => make('gateway.cancel', [id], 'Stop asking'),
  forgetTask: (id: string): Call => make('gateway.forget', [id], 'Remove'),
  /**
   * While Claude works, as the Mac's composer: Steer gives it your words at its next step (never
   * stopping it), Queue lets it finish first. The same `session.submit` the
   * Mac sends (`urgent` for Steer).
   */
  steer: (topic: Topic, text: string): Call => make('session.submit', [text, { channel: channelOf(topic), urgent: true }], `Steer "${short(text)}"`),
  queue: (topic: Topic, text: string): Call => make('session.submit', [text, { channel: channelOf(topic) }], `Queue "${short(text)}"`),
  /** A queued message of yours: steer with it now, or take it out of the queue. */
  steerQueued: (id: string): Call => make('host.promote', [id], 'Steer now'),
  unqueue: (id: string): Call => make('host.cancelQueued', [id], 'Remove from the queue'),
  /** Bring Beluga on your Mac to the front on this (a topic, or a needs-you item without one). */
  openOnMac: (target: { topic?: Topic; need?: string }): Call => make('companion.openOnMac', [{ ...(target.topic ? { topic: target.topic } : {}), ...(target.need ? { need: target.need } : {}) }], 'Open on your Mac'),
  /** A project's icon, by the checksum its views carry. */
  icon: (sum: string): Call => make('companion.icon', [sum], 'Icon'),
  /** A task: a comment, or a new status (as dragging it on the Mac's board). */
  comment: (key: string, text: string): Call => make('board.comment', [key, text], `Comment on ${key}`),
  move: (key: string, status: string, label: string): Call => make('board.move', [key, status as never], `Move ${key} to ${label}`),
  /** Start a task in a new worktree with Claude on it (the Mac's Start with Claude) → the worktree's id. */
  // `agent` (1.35, BLG-506, Start with…): who works this start; only to a Mac with SINCE.workAgents (the caller checks).
  start: (key: string, agent?: PickedRef): Call => make('board.start', [key, { claude: true, ...(agent ? { agent } : {}) }], agent ? `Start ${key} with ${agent.label}` : `Start ${key}`),
  /** 1.35 (BLG-498): who works a task from its next start (null: your default) → what happened, in words. */
  setTaskAgent: (key: string, agent: { runtime: string; label: string; model?: string } | null, label: string): Call => make('board.setAgent', [key, agent], `${key}: ${label}`),
  /** 1.35 (BLG-498): who works a plan's milestones and tasks from here on (null: your default) → in words. */
  setPlanAgent: (planId: string, agent: { runtime: string; label: string; model?: string } | null, label: string): Call => make('plans.setWorkAgent', [planId, agent], `Plan's agent: ${label}`),
  /** A task described in words: Claude's draft first, then it's added. */
  // 1.24 (BLG-322) `several`: only to a Mac that has it (SINCE.severalTasks); an older one drafts one task.
  draftTask: (projectId: string, text: string, several = false): Call => make('companion.draftTask', [{ projectId, text, ...(several ? { several } : {}) }], 'Draft a task'),
  // A draft with `more` (1.24) adds them all: what the Mac drafted with `several`, as it came.
  addTask: (projectId: string, d: PhoneDraft & { more?: PhoneDraft[]; epic?: boolean }): Call =>
    make('companion.addTask', [{ projectId, ...d }], d.more?.length ? `Add ${d.more.length + 1} tasks` : `Add "${short(d.title)}"`),
  /** A live view's rows: the Mac runs its source (one your own Claude's view names) and sends the page. */
  // 1.44: what a chat's address is now (its chip).
  resolveChat: (ref: string): Call => make('chats.resolve', [ref], 'Chat link'),
  viewFetch: (a: { topic: Topic; turn: string; block: number; query: object; source?: object; confirm?: boolean; fresh?: boolean; text?: boolean }): Call => make('companion.viewFetch', [a as never], 'View rows'),
  /** Merging a worktree (its conversation): look first, merge, Claude resolves the conflicts. */
  mergeCheck: (topic: Topic): Call => make('companion.mergeCheck', [topic], 'Check the merge'),
  merge: (topic: Topic): Call => make('companion.merge', [topic], 'Merge'),
  resolve: (topic: Topic): Call => make('companion.resolve', [topic], 'Ask your agent to resolve'),
  /** 1.8: one of a worktree's branch steps (Archive, Squash and Merge, Fix with Claude…), as the Mac's toolbar does it. */
  branchStep: (topic: Topic, step: PhoneBranchStep, label: string, children?: ThreadChildren): Call => make('companion.branchStep', children ? [topic, step, children] : [topic, step], label),
  /** 1.47: one child thread and those under it stop, as the Mac's Threads panel does it. */
  stopThread: (id: string): Call => make('threads.stop', [id], 'Stop the thread'),
  stopThreads: (id: string): Call => make('threads.stopAll', [id], 'Stop the threads'),
  /** Your steered message Claude hasn't read yet, now: its step stops and it reads it next. */
  steerNow: (request: string): Call => make('host.steerNow', [request], 'Send now'),
  /** 1.43: your steered message Claude hasn't read yet, taken back → { cancelled, prompt: its words, for the box }. */
  cancelSteer: (request: string): Call => make('host.cancelSteer', [request], 'Cancel'),
  /** 1.28 (BLG-387): a message you sent, edited: the conversation rewinds to it ('here') or goes on in a new fork → where it went on. */
  editPrompt: (ws: string, turn: string, text: string, mode: 'here' | 'fork'): Call => make('workspaces.editPrompt', [ws, turn, text, mode], mode === 'here' ? 'Rewind and send' : 'Fork and send'),
  /** 1.7: a worktree's files, read-only: a folder ('' is the top), names that match, a page of a file. */
  filesList: (topic: Topic, path: string): Call => make('companion.files.list', [topic, path], 'Files'),
  filesFind: (topic: Topic, query: string): Call => make('companion.files.find', [topic, query], 'Find files'),
  filesRead: (topic: Topic, path: string, off = 0): Call => make('companion.files.read', [topic, path, ...(off ? [{ off }] : [])] as never, 'Read a file'),
  /** 1.7: a worktree's terminals, shared with the Mac: list, open (its shell, one of them, or a new one), close for everyone. */
  terminals: (topic: Topic): Call => make('companion.terminals', [topic], 'Terminals'),
  termOpen: (topic: Topic, opts: { key?: string; fresh?: boolean } = {}): Call => make('companion.termOpen', [topic, opts], 'Open a terminal'),
  termClose: (key: string): Call => make('companion.termClose', [key], 'Close the terminal'),
  older: (topic: Topic, before: string): Call => make('companion.older', [topic, { before }], 'Load older'),
  /** 1.10: one sub-agent of a turn, opened: its activity in words and the report it gave back. */
  subAgent: (topic: Topic, turn: string, id: string): Call => make('companion.subAgent', [topic, turn, id], 'Sub-agent'),
  /** 1.11: which conversations files were saved from are archived or deleted on the Mac. */
  gone: (topics: readonly string[]): Call => make('companion.gone', [[...topics]], 'Check saved files'),
  /** 1.16 (BLG-140): the Mac's voice models, getting one there now, and a recording it writes down. */
  voice: (): Call => make('companion.voice', [], 'Voice on your Mac'),
  voicePrepare: (model: VoiceModelId): Call => make('companion.voicePrepare', [model], 'Get a voice model on your Mac'),
  transcribe: (audio: string, model: VoiceModelId, language: string, prompt?: string): Call => make('companion.transcribe', [{ audio, model, language, ...(prompt ? { prompt } : {}) }], 'Write down what you said'),
  /** Write in a friends' chat (with photos, or asking Claude). */
  /** Ask a friend's Claude to do it on their Mac (their chat answer offered it): a request, as from their card. */
  request: (to: string, ask: string, needs?: readonly ('project' | 'shell' | 'files' | 'screen' | 'device')[]): Call => make('gateway.ask', [to, ask, needs?.length ? { needs: [...needs] } : undefined], `Ask "${short(ask)}"`),
  /** `ask`: whose Claude answers too: everyone's ('all') or the chosen people's (peer ids, you included). */
  chat: (topic: Topic, text: string, opts: { files?: Files; ask?: 'all' | readonly string[] } = {}): Call =>
    make('companion.post', [{ conversation: conversationOf(topic), text, ...withFiles(opts.files), ...(opts.ask ? { ask: opts.ask === 'all' ? ('all' as const) : [...opts.ask] } : {}) }], opts.files?.length ? 'Send a photo' : `Message "${short(text)}"`),
  read: (topic: Topic): Call => make('network.read', [conversationOf(topic)], 'Mark read'),
  /** 1.30 (BLG-429): delete a direct message (`everyone`: yours, from their Mac too), edit your own, clear the chat on the Mac. */
  deleteMessage: (topic: Topic, id: string, everyone: boolean): Call => make('network.messages.delete', [conversationOf(topic), id, everyone ? { everyone: true } : {}], 'Delete the message'),
  editMessage: (topic: Topic, id: string, text: string): Call => make('network.messages.edit', [conversationOf(topic), id, text], `Edit to "${short(text)}"`),
  clearChat: (topic: Topic): Call => make('network.clear', [conversationOf(topic)], 'Clear the chat'),
  /** 1.41 (BLG-702): an emoji on a person's message in the room's or a workspace's chat (`on`), or yours taken off. */
  reactTurn: (topic: Topic, id: string, emoji: string, on: boolean): Call => make('session.react', [channelOf(topic), id, emoji, on], on ? `React ${emoji}` : `Take back ${emoji}`),
  /** 1.41 (BLG-702): put an emoji on a message (`on`) or take yours off. */
  react: (topic: Topic, id: string, emoji: string, on: boolean): Call => make('network.messages.react', [conversationOf(topic), id, emoji, on], on ? `React ${emoji}` : `Take back ${emoji}`),
  /** 1.34 (BLG-466): a dialogue between agents: Stop it, or Continue? → yes. */
  dialogueStop: (id: string): Call => make('dialogues.stop', [id], 'Stop the dialogue'),
  dialogueContinue: (id: string): Call => make('dialogues.continue', [id], 'Continue the dialogue'),
  dialogueConfirm: (id: string): Call => make('dialogues.confirm', [id], 'Start the dialogue'),
  /** Ask a friend's Claude yourself; the answer (and files) come back in the topic it returns. */
  askPerson: (peerId: string, name: string, text: string): Call => make('companion.askPerson', [{ peerId, text }], `Ask ${name}'s agent`),
  screenshot: (peerId: string, name: string): Call => make('companion.askPerson', [{ peerId, text: 'Take a screenshot of your desktop and send it to me.', needs: ['screen'] }], `Screenshot of ${name}'s desktop`),
  // Sentinel (1.21, docs/sentinel.md): Run Now, Pause / Turn On, one run with its report's text.
  sentinelRun: (id: string, name: string): Call => make('sentinel.run', [id], `Run ${short(name)}`),
  sentinelPause: (id: string, paused: boolean, name: string): Call => make('sentinel.pause', [id, paused], `${paused ? 'Pause' : 'Turn on'} ${short(name)}`),
  sentinelRunGet: (runId: string): Call => make('sentinel.runGet', [runId], 'Read the report'),
  /** 1.22 (BLG-244): Refresh a dashboard (Run Now on each sentinel it draws from, one at a time) → { total }; a number over time. */
  dashboardRefresh: (id: string, name: string): Call => make('dashboard.refresh', [id], `Refresh ${short(name)}`),
  metricRead: (sentinelId: string, name: string, since?: number): Call => make('sentinel.metricRead', since === undefined ? [sentinelId, name] : [sentinelId, name, since], 'Read a number'),
  /** 1.29 (BLG-386): a table's action button runs its sentinel with the row; a document the phone doesn't show opens on the Mac. */
  sentinelRunRow: (sentinelId: string, metric: string, column: string, row: Record<string, string | number | boolean | null>, words: string): Call => make('sentinel.runRow', [sentinelId, metric, column, row], short(words)),
  /** 1.29 (BLG-392): what a sentinel keeps (its metrics' histories and runs' files, as refs), and a run's file opened on the Mac. */
  dataList: (sentinelId: string): Call => make('sentinel.dataList', [sentinelId], 'Read what it keeps'),
  runFileOpen: (runId: string, name: string, label: string): Call => make('sentinel.runFileOpen', [runId, name], `Open ${short(label)} on your Mac`),
  documentOpen: (sentinelId: string, metric: string, column: string, value: string, storage: boolean, name: string): Call => make(storage ? 'sentinel.storageOpen' : 'sentinel.documentOpen', [sentinelId, metric, column, value], `Open ${short(name)} on your Mac`),
  /** This phone signs out on the Mac (its certificate goes). */
  signOut: (): Call => make('companion.signOut', [], 'Sign out'),

  /** One of a needs-you item's buttons, as the Mac wrote it. */
  action: (item: NeedsYou, action: NeedsYou['actions'][number]): Call => ({ method: action.method as PhoneMethod, args: action.args as never, label: `${action.label}: ${short(item.title)}` }),
  /**
   * Your own answer (picked options, or words) through the item's `answer` template: the value goes
   * at `slot` inside a copy of `args` (several picks joined with `join`, or as a list with `list`).
   */
  answer(item: NeedsYou, value: string | readonly string[]): Call | undefined {
    const t = item.answer;
    if (!t) return undefined;
    const filled = Array.isArray(value) ? (t.list ? [...value] : value.join(t.join ?? ', ')) : value;
    const args = structuredCloneish(t.args);
    let at: unknown = args;
    t.slot.forEach((key, i) => {
      const box = at as Record<string | number, unknown>;
      if (i === t.slot.length - 1) box[key] = filled;
      else {
        if (box[key] === undefined || box[key] === null) box[key] = typeof t.slot[i + 1] === 'number' ? [] : {};
        at = box[key];
      }
    });
    const shown = Array.isArray(filled) ? filled.join(', ') : String(filled);
    return { method: t.method as PhoneMethod, args: args as never, label: `${t.label ?? 'Answer'}: ${short(shown)}` };
  },
};

/** A deep copy of JSON-shaped args (the template is the view's; it must stay untouched). */
const structuredCloneish = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
