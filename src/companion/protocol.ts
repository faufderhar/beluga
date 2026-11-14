import { z } from 'zod';

/**
 * What your phone and your Mac say over the companion link (docs/companion.md). The Mac's side
 * (src/companion/host.ts) and the phone app (packages/companion) both import this file, so the two
 * can't disagree within one commit. Runs anywhere: zod only, no Node, no React Native.
 *
 * Versions: within a major only additive changes (new topics, fields, needs-you kinds); the phone
 * ignores what it doesn't know. A breaking change bumps the major, and the Mac keeps answering the
 * previous major for a release.
 */
export const COMPANION_PROTO = { major: 1, minor: 57 } as const;

/**
 * What came in which minor, for a phone talking to an older Mac: it subscribes to a topic (and
 * makes a call) only when the Mac's minor has it, since an older Mac drops a `sub` frame naming a
 * topic it doesn't know. 1.3: the relay (any network). 1.4: the tasks topics, `companion.openOnMac`, `companion.icon`, merging
 * from the phone (`companion.mergeCheck` / `merge` / `resolve`), describing a task
 * (`companion.draftTask` / `addTask`) and starting one (`board.start`). 1.5: "Your Mac" (the
 * `conv:mac:assistant` topic, Home's `assistant`), and asking in a project as a new worktree
 * (`workspaces.startWorktree`, with plan mode) or a plan (`plans.create`), besides a question;
 * a plan's dependencies, criteria and autonomy (`PlanView`, `plans.setAutonomy`). 1.6: a
 * worktree's branch state in its conversation (`ConvView.branch`). 1.7 (BLG-42): a worktree's
 * files, read-only (`companion.files.list` / `find` / `read`), and its terminals, shared with the
 * Mac (`companion.terminals` / `termOpen` / `termClose`, the `term_*` frames). 1.8: a branch's every
 * step from the phone, as the Mac's toolbar has them (`BranchView.steps`, `companion.branchStep`).
 * 1.9 (BLG-87): more of Claude's blocks drawn (`tree`, `json`, `terminal`, `math` blocks, mermaid as
 * a graph or view) and its math typeset (`ProseView.math`). 1.10 (BLG-110): a sub-agent opened on
 * the phone, its whole activity and the report it gave back (`companion.subAgent`). 1.11 (BLG-124):
 * which conversations the phone saved files from are archived or deleted (`companion.gone`). 1.12:
 * photos with a new worktree (`companion.ask`'s `worktree` target). 1.13 (BLG-127): whether the Mac
 * stays awake for the phone (`HomeView.mac.keepAwake`, `companion.keepAwake`), and (BLG-128) a phone
 * away pinging every KEEPALIVE_AWAY_MS on a relay or LAN link. 1.14: Your Mac's chats on the phone
 * (`HomeView.macChats`), started and deleted there (`assistant.newChat` / `deleteChat`). 1.15: the
 * plan a conversation is the home of (`ConvView.plan`), so its chat links back to the plan. 1.16
 * (BLG-140): the Mac writes down what you said on the phone (`companion.voice` / `voicePrepare` /
 * `transcribe`). 1.17 (BLG-150): your Mac uses your phone. The phone says what it lets the Mac do
 * (`control`), the Mac asks it to act (`req` / `reply`), and the Mac's adb reaches the phone's
 * Wireless debugging through the link (`tun_*`). 1.18 (BLG-184): the Mac's mirror of the phone as
 * live H.264 video (the `mirror` op, `vid` / `vid_end`, and the Mac's `vid_ack`). 1.19 (BLG-189,
 * BLG-190): the phone proves it's the one at a Wireless-debugging address (`proof`), and opens its
 * Developer options or About phone for the person (`open {settings}`). 1.20 (BLG-210): who's in a
 * chat and what their Claude is doing (`ChatMemberView.presence` / `claude`), what waits on whom
 * (`ChatView.waiting`), who gets a message later (`ChatView.note`), and whose a task's card is
 * (`ChatMessageView.task.who` / `secret`). Read-only fields: an older Mac just leaves them out.
 * 1.21 (BLG-237): Sentinel, your watchers (docs/sentinel.md): the `sentinels` and `sentinel:<id>`
 * topics (`SentinelsView`, `SentinelPageView`), Run Now, Pause / Turn On and a run's report
 * (`sentinel.run` / `pause` / `runs` / `runGet`), and a run waiting for your Merge as a `decision`
 * (`sentinel.decide`). 1.22 (BLG-244): numbers and dashboards (docs/sentinel.md §10): the
 * `dashboard:<id>` topic (`DashboardView`, its tiles worked out on the Mac with every compare),
 * pull to refresh (`dashboard.refresh`), a number over time (`sentinel.metricRead`), and in
 * `SentinelsView` the dashboards and the first one's first three numbers for Home. 1.23 (BLG-246):
 * Sentinel's own dashboard and its chat (docs/sentinel.md §10, §12): tiles of kind `series` (an
 * older phone's `chart` still comes as `chart`) and `output` (a step's latest export, `output`),
 * a tile's real size (`span`, `tall`; `width` stays 1 to 3 for older phones), the `draft` state,
 * and `SentinelsView.chat`, the Sentinel chat's open conversation (a `conv:sentinel-chat:<id>`
 * topic the phone writes in as any conversation). 1.24 (BLG-322): New Task from one message makes
 * several tasks: `companion.draftTask`'s `several`, a draft's `for`, `more` and `epic`, and
 * `companion.addTask` adding them all (`more` in its answer). 1.25 (BLG-345): a table tile's typed
 * columns (`table.typed`: a document, a storage object, a link, a path, with each row's whole value)
 * and its metric (`table.metric`), so a chip opens the document through the Mac (`sentinel.document`)
 * or a storage object's link signed there (`sentinel.signStorage`); a sentinel page's workflow
 * as a graph (`SentinelPageView.graph`, BLG-352). 1.26 (BLG-361): every board tile in words for
 * the phone's Home-screen widgets (the `widgets` topic, `WidgetsView`: what the Mac's desktop
 * widgets read from `~/.beluga/widgets/tiles.json`, each project's icon as its checksum).
 * 1.27 (BLG-354): a request you asked of a friend can be removed (`gateway.forget`), and a
 * needs-you item dismissed (`needs.dismiss`) without answering it, here and on the Mac.
 * 1.28 (BLG-387): a message you sent can be edited (`TurnView.edit`, `workspaces.editPrompt`):
 * the conversation rewinds to it, or goes on in a new fork from there.
 * 1.29 (BLG-386): a table's documents and storage objects as refs the phone streams (`table.typed[].docs`,
 * fetched by the Mac when asked, nothing kept), each column's `max`, `better` and `button`, and Open
 * on your Mac for one the phone doesn't show (`sentinel.documentOpen`, `sentinel.storageOpen`); what a
 * sentinel keeps (`sentinel.dataList`, BLG-392: its metrics' histories and runs' files, as refs) and
 * Open on your Mac for a run's file (`sentinel.runFileOpen`).
 * 1.30 (BLG-429): a direct message deleted (`network.messages.delete`, yours from your friend's Mac
 * too), your own edited (`network.messages.edit`, only one whose words reach the phone whole:
 * `ChatMessageView.editable`), and a direct chat cleared on the Mac (`network.clear`).
 * 1.31 (BLG-500): boards and repos are many to many. `TasksView.projects` are boards (a repo's own,
 * by its project id, or one covering several, `board_…`), and a task on a board of several says
 * which repo it runs in (`TaskSummary.repo`). `companion.draftTask` / `addTask` take a board's id
 * too (the task runs in its first repo).
 * 1.32 (BLG-446): the agent picker in a conversation (`ConvView.agent`: runtimes as groups with their
 * models, an unavailable one with why), picked with `workbench.setModel` / `workbench.setAgent`.
 * 1.33 (BLG-459): usage per provider: each `UsageView` says its agent (`runtime`, `isDefault`),
 * a local model's `tokens` and `tokensPerSec`, and `signedIn`; the phone makes one the default
 * agent (`companion.defaultAgent`). An older Mac sends Claude Code alone, as before.
 * 1.34 (BLG-466): a dialogue between agents in a conversation (`TurnView.dialogue`): its header card,
 * and Stop / Continue? from the phone (`dialogues.stop`, `dialogues.continue`).
 * 1.35 (BLG-498): who works a task and a plan's work: `TaskPageView.agent` / `PlanView.agent` (none:
 * your default) and `agents`, the list to change it from (`board.setAgent`, `plans.setWorkAgent`).
 * An older Mac sends neither, and the phone offers no change. SINCE.workAgents: `companion.addTask` and
 * `plans.create` take the `agent` a new task or plan is worked by; each turn and task activity line
 * may carry the `agent` that spoke, for its mark (an older Mac sends none: the phone guesses by name).
 * Start with… (BLG-506), also SINCE.workAgents: `board.start` takes the `agent` that works this start,
 * and `companion.ask`'s worktree target the `agent` a new worktree runs (an older Mac: your default).
 * 1.36 (BLG-534): the agent's own terminal on the Mac drives a conversation (`ConvView.terminal`):
 * the phone says so in place of its message box, and Take Over gives it back to the chat
 * (`agentTerm.takeOver`). An older Mac sends none, and never refuses a message for it.
 * 1.37 (BLG-559): a repo's own board also lists the tasks running in its repo from other boards,
 * each saying the board it's on (`TaskSummary.onBoard`). An older phone shows them without it.
 * 1.38 (BLG-574): how many of their messages in a chat you haven't read (`ChatView.unread`), so the
 * phone marks them as the Mac does when you open it. An older Mac leaves it out: no marks.
 * 1.39 (BLG-634): the conversation checking a milestone (`PlanView.milestones[].checker`), its own
 * Claude off the sidebar, so you can watch the check. An older Mac leaves it out: no way in.
 * 1.40 (BLG-688): what a milestone's agent is doing right now (`PlanView.milestones[].agentNow`),
 * even between tasks, and its conversation. An older Mac leaves it out: the tasks still say theirs.
 * 1.41 (BLG-702): emoji reactions on chat messages (`ChatMessageView.reactions`: each emoji, how
 * many, whether one is yours and who), your quick row (`ChatView.quick`), and a tap putting one on
 * or taking yours off (`network.messages.react`); the same on the room's and workspaces' chat turns
 * (`TurnView.reactions` / `reactable`, `ConvView.quick`, `session.react`). An older Mac leaves them
 * out: no reactions.
 * 1.42 (BLG-757): a run stopped by your usage limit says when Beluga tells it to continue on its
 * own (`TurnView.resumesAt`). An older Mac leaves it out.
 * 1.43 (BLG-762): a steered message your agent hasn't read yet can be taken back
 * (`host.cancelSteer` → its words, for the box). An older Mac doesn't have it: no Cancel.
 * 1.44 (BLG-74): each chat's category in Work while `chatCategories` is on (`WorkView.categories`,
 * `ConvSummary.category`, `snoozedUntil`, `settledWhy`, `back`), and Settle, Remind Me Later, Show Again
 * Now and Un-settle from the phone (`triage.*`). Its Snoozed category is Later on the screens (BLG-770). An older Mac or phone never sees them: Work stays one list by project.
 * 1.45 (BLG-772): a plan's decisions (`PlanView.decisions`), and verifying its draft when you ask
 * (`plans.verify`, with `thenApprove`; `PlanView.review`: reviewing, or what it found), with Fix
 * (`plans.fixReview`). An older Mac leaves them out: Approve as before.
 * 1.47 (BLG-172): child threads: each chat's harness and parent in Work (`ConvSummary.harness` /
 * `parent`), a chat's family (`ConvView.threadFamily`, Stop with `threads.stop`), which thread a need
 * belongs to (`NeedsYou.thread`), and what archive and delete would take with them
 * (`BranchView.threads`, answered in `companion.branchStep`'s third argument). An older Mac leaves them
 * out: flat rows, no Threads sheet, no question. The phone sends the third argument only to a Mac with
 * SINCE.threads: an older Mac refuses an argument it doesn't know, so its children stay.
 * SINCE.threadAgents: a family also lists the chat's native sub-agents (`ThreadFamilyView.agents`),
 * read-only. An older Mac leaves them out: the sheet lists threads only.
 * 1.48 (BLG-798): your own direct message says Delivered or Seen (`ChatMessageView.delivery`). An older Mac leaves it out.
 * 1.49 (BLG-809): your computers, where to dial each (`computers`, sent after the welcome and when
 * they change), so the phone links to each by itself with the certificate it has. Each computer lets
 * in the phones of your device set, with this phone table's limits. An older Mac sends none, an
 * older phone drops the frame: nothing changes for either. Each says its Runs on line as the Mac's
 * menu does (`line`, `why`), and the phone shows every computer's work, Needs You and New Task's
 * Runs on from its own links (BLG-810).
 * 1.50: Usage says when a provider can't report its billing period (`UsageView.note`), and Home
 * carries cache hit rate by session and by model (`HomeView.cache`). An older phone drops both.
 * An older Mac leaves them out: the phone hides the cache section.
 * 1.50 (BLG-121, BLG-122): a message an external agent sent says so (`TurnView.via`). An older phone shows the message
 * without it. External agents from the phone: `external.agents`, `stopAgent`, `stopAll`, `revoke`, `activity` (SINCE.externalAgents).
 * 1.51 (BLG-140): a chat's address (`chats.resolve`): its chip's current title and whether it opens.
 * An older Mac has no such call: the phone shows the token as code. `ConvView.chatLinks`: the Mac has
 * chat links (always on a Mac newer than 3.3.0; before, a setting off by default); without it the
 * phone shows a chat mention as its title, with no chip.
 * 1.52 (BLG-149): `TurnView.origin`: an agent's turn that reads a message from another chat.
 * 1.53 (BLG-277): `ConvView.queue[].origin`: a queued message that an agent in another chat sent.
 * 1.54 (BLG-922): usage statistics' level on the phone's Settings (`HomeView.mac.telemetry`, `telemetry.choose`). An older phone
 * shows no such row; an older Mac sends no `telemetry`.
 * 1.55 (BLG-940): a worktree of yours shared with someone says how many (`ConvSummary.shared`), for the
 * Mac sidebar's green dot. An older Mac sends none; an older phone shows none.
 * 1.56 (BLG-952): a task held for its checks says so (`TaskSummary.needsChecks`): how many criteria are
 * neither ticked nor explained, and whether its work already merged. An older Mac sends none; an older phone shows none.
 * 1.57: a provider's token figure counts cache reads and cache writes too (`UsageView.tokens.cacheRead` /
 * `cacheWrite`), beside input and output. An older phone shows input and output only; an older Mac sends neither cache field.
 */
export const SINCE = { tasks: 4, openOnMac: 4, icon: 4, merge: 4, draftTask: 4, viewFetch: 4, assistant: 5, askModes: 5, files: 7, terminal: 7, branchSteps: 8, subAgent: 10, gone: 11, worktreePhotos: 12, keepAwake: 13, awayBeat: 13, macChats: 14, voice: 16, control: 17, video: 18, proof: 19, sentinel: 21, dashboard: 22, sentinelChat: 23, severalTasks: 24, documents: 25, widgets: 26, forget: 27, dismiss: 27, editPrompt: 28, docRefs: 29, keptData: 29, chatEdits: 30, agentPicker: 32, providers: 33, dialogues: 34, workAgents: 35, terminalView: 36, reactions: 41, cancelSteer: 43, triage: 44, draftReview: 45, threads: 47, threadAgents: 47, seen: 48, computers: 49, externalAgents: 50, chatLinks: 51, chatOrigin: 52, queuedOrigin: 53, telemetry: 54, sharedMark: 55 } as const;

/** One frame's biggest payload, and a file piece. */
export const MAX_COMPANION_FRAME = 1024 * 1024;
export const COMPANION_PIECE = 192 * 1024;
/** How often the phone's link pings while open, and how long it stays after the app goes to the background. */
export const KEEPALIVE_MS = 20_000;
/**
 * Away with the link kept open (Stay connected, BLG-128), over the relay (TCP: Cloudflare drops a
 * socket idle 100 s) or the same Wi-Fi (no NAT): a ping this often. A hole-punched link keeps
 * KEEPALIVE_MS (mobile NATs forget a UDP mapping in about 30 s). Only with a Mac that has
 * SINCE.awayBeat, which then waits three of these before it calls the phone gone.
 */
export const KEEPALIVE_AWAY_MS = 50_000;
export const BACKGROUND_GRACE_MS = 15_000;
/** Views of one topic are sent at most this often. */
export const VIEW_COALESCE_MS = 500;
/** Turns a conversation view carries (older ones: companion.older). */
export const VIEW_TURNS = 40;
/** Phones one identity may pair. */
export const MAX_DEVICES = 4;
/** What the phone may send the Mac (photos, files): this big a file, this many in one message. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_UPLOADS = 10;
/** A worktree's file is read in pages of this many bytes (companion.files.read). */
export const FILE_PAGE = 512 * 1024;
/** A terminal's output is sent to the phone at most this often (about 30 frames a second), and in pieces of at most this many characters. */
export const TERM_COALESCE_MS = 33;
export const TERM_PIECE = 128 * 1024;

const id = z.string().min(1).max(200);
const text = z.string().max(64_000);
const ts = z.number().int().min(0);

// ---- topics

/** What a screen shows; the phone subscribes to the ones on screen. */
export const Topic = z.union([
  z.literal('home'),
  z.literal('work'),
  z.literal('plans'),
  z.literal('chats'),
  z.literal('people'),
  /** The board's tasks, by project and status (1.3). */
  z.literal('tasks'),
  z.string().regex(/^conv:[\w:.-]{1,200}$/),
  z.string().regex(/^plan:[\w.-]{1,200}$/),
  z.string().regex(/^chat:[\w:.-]{1,200}$/),
  /** One task's page (1.3). */
  z.string().regex(/^task:[\w.-]{1,200}$/),
  /** 1.21: every sentinel, and one sentinel's page with its runs. */
  z.literal('sentinels'),
  z.string().regex(/^sentinel:[\w.-]{1,200}$/),
  /** 1.22: one dashboard with its tiles. */
  z.string().regex(/^dashboard:[\w.-]{1,200}$/),
  /** 1.26: every board tile, for the phone's Home-screen widgets. */
  z.literal('widgets'),
]);
export type Topic = z.infer<typeof Topic>;

/**
 * One of Your Mac's chats: `conv:mac:assistant`, and since BLG-102 (the Mac's chat tabs) also
 * `conv:mac:assistant:<id>`. Home's `assistant` names the one open on the Mac.
 */
export const isMacTopic = (topic: string | undefined): boolean => topic === 'conv:mac:assistant' || Boolean(topic?.startsWith('conv:mac:assistant:'));

// ---- what views are made of

/** A file the phone sent the Mac (`put`): named by this ref in `companion.ask` / `companion.post`. */
export const UploadRef = z.string().regex(/^up:[\w-]{8,64}$/);

/** A file the Mac handed out: fetched by `ref` (resolved and checked on the Mac). */
export const OutputView = z.object({
  ref: z.string().regex(/^out:[\w-]{8,64}$/),
  name: z.string().max(256),
  kind: z.enum(['image', 'pdf', 'video', 'json', 'markdown', 'text', 'file']),
  size: z.number().int().min(0).optional(),
  ts: ts.optional(),
  /** Who made it: a sub-agent's id, else the conversation's Claude. */
  by: z.string().max(200).optional(),
});
export type OutputView = z.infer<typeof OutputView>;

/** 1.29 (BLG-386): a kept table's document or storage object, as a ref (`get` streams it; text comes redacted). */
export const DocRefView = z.object({ ref: OutputView.shape.ref, name: z.string().max(256), mime: z.string().max(100) });
export type DocRefView = z.infer<typeof DocRefView>;

/**
 * 1.29 (BLG-392): what a sentinel keeps (`sentinel.dataList` from the phone): each metric with how
 * much it keeps, its whole history as a ref (CSV, made when it's fetched); each run's files as refs.
 */
export const DataListView = z.object({
  metrics: z.array(z.object({ name: z.string().max(80), label: z.string().max(100), kind: z.string().max(10), unit: z.string().max(40), lines: z.number().int().min(0), first: ts.optional(), last: ts.optional(), rows: z.number().int().min(0).optional(), ref: OutputView.shape.ref }).passthrough()).max(200),
  runs: z.array(z.object({ runId: z.string().max(200), at: ts, headline: z.string().max(2000), state: z.string().max(20), files: z.array(z.object({ name: z.string().max(220), label: z.string().max(200), kind: z.string().max(10), size: z.number().int().min(0), ref: OutputView.shape.ref, mime: z.string().max(100) }).passthrough()).max(60) }).passthrough()).max(200),
  keepsDays: z.number().int().min(0),
});
export type DataListView = z.infer<typeof DataListView>;

export const UsageWindowView = z.object({ label: z.string().max(40), pct: z.number().min(0).max(100), resetsAt: ts.optional() });
/** One agent provider's allowance: plan windows where it has them, tokens and speed where not (1.33). */
export const UsageView = z.object({
  provider: z.string().max(40),
  plan: z.string().max(40).optional(),
  windows: z.array(UsageWindowView).max(8),
  updatedAt: ts,
  /** 1.33: its runtime ("claude", "codex", "local"), what `companion.defaultAgent` takes. */
  runtime: z.string().max(32).optional(),
  /** 1.33: the agent that answers when nobody names one. */
  isDefault: z.boolean().optional(),
  /** 1.33: a local model's tokens since the Mac started, and its speed over the last run. 1.57: cache reads and cache writes, when conversations counted them. */
  tokens: z.object({ input: z.number().min(0), output: z.number().min(0), cacheRead: z.number().min(0).optional(), cacheWrite: z.number().min(0).optional() }).optional(),
  tokensPerSec: z.number().min(0).optional(),
  /** 1.33: false when it's installed on the Mac but not signed in. */
  signedIn: z.boolean().optional(),
  /** 1.50: why this provider has no plan window (Grok Build, when its period can't be read from here). */
  note: z.string().max(200).optional(),
});
export type UsageView = z.infer<typeof UsageView>;

export const Choice = z.object({ label: z.string().max(200), description: z.string().max(1000).optional() });

/**
 * Something waiting for you. `kind` tells the phone which buttons to draw; one it doesn't know is
 * drawn as a plain card with "Open on your Mac". `actions` are API calls the phone makes as they are.
 */
export const NeedsYou = z.object({
  id,
  kind: z.union([z.enum(['approval', 'question', 'request', 'decision', 'confirm']), z.string().max(40)]),
  title: z.string().max(500),
  detail: text.optional(),
  /** Who is asking ("your Claude", "mia's Claude"). */
  from: z.string().max(100).optional(),
  /** The conversation it holds up, to open. */
  topic: Topic.optional(),
  /** 1.47: that conversation's title when it is a child thread, so a need says which one asks. */
  thread: z.string().max(300).optional(),
  askedAt: ts.optional(),
  timeoutMs: z.number().int().min(0).optional(),
  /** A question's options (pick one, or several). */
  choices: z.array(Choice).max(12).optional(),
  multi: z.boolean().optional(),
  /** Free words are taken too. */
  freeText: z.boolean().optional(),
  /** Buttons: what they say and the call they make. `tone` main is the swipe-right one, danger the swipe-left. */
  actions: z
    .array(z.object({ label: z.string().max(40), tone: z.enum(['main', 'danger', 'plain']), method: z.string().max(80), args: z.array(z.unknown()).max(8) }))
    .max(4),
  /**
   * How to send an answer of your own (picked options, or words): call `method` with `args`, after
   * putting the answer at `slot` (a path into args: [1, 'answers', 'Which store?'] is
   * args[1].answers['Which store?']). Several picks go in as one string joined by `join`
   * (Claude's questions), or as a list when `list` is set. `text` says whether words are taken,
   * `picks` whether options are (one, or several with `multi`). No `answer`: only the buttons.
   */
  answer: z
    .object({
      method: z.string().max(80),
      args: z.array(z.unknown()).max(8),
      slot: z.array(z.union([z.number().int().min(0), z.string().max(1000)])).min(1).max(6),
      join: z.string().max(10).optional(),
      list: z.boolean().optional(),
      text: z.boolean(),
      picks: z.boolean(),
      /** What the send button says ("Send", "Send back"). */
      label: z.string().max(40).optional(),
    })
    .optional(),
});
export type NeedsYou = z.infer<typeof NeedsYou>;

/**
 * What kind of tool a step used, for its icon (1.3): reading, editing, writing a file, searching,
 * running a command, the tests, the web, a sub-agent, its plan, another tool. A phone draws a kind
 * it doesn't know as `tool`.
 */
export const ToolKind = z.union([z.enum(['read', 'edit', 'write', 'search', 'run', 'test', 'web', 'agent', 'plan', 'tool']), z.string().max(20)]);
export type ToolKind = z.infer<typeof ToolKind>;

/** One step in words, with its tool's kind ("Edited store.ts", edit). Never the code or the command line. */
export const StepView = z.object({ tool: ToolKind, text: z.string().max(300) });
export type StepView = z.infer<typeof StepView>;

/**
 * What a run is doing right now (1.3): thinking, writing its answer, on a step (its words, tool and
 * how far it has got), starting, waiting for your approval, or waiting its turn. `since`: when that
 * began (the phone counts the seconds itself; nothing streams per second).
 */
export const LiveView = z.object({
  phase: z.union([z.enum(['thinking', 'writing', 'step', 'starting', 'approval', 'queued']), z.string().max(20)]),
  since: ts.optional(),
  /** The step it's on, present tense ("Running the tests"), with its tool and its count ("137/215"). */
  words: z.string().max(300).optional(),
  tool: ToolKind.optional(),
  progress: z.string().max(40).optional(),
  /** Sub-agents of this run at work now. */
  agents: z.number().int().min(0).optional(),
});
export type LiveView = z.infer<typeof LiveView>;

export const SubAgentView = z.object({
  id,
  title: z.string().max(300),
  status: z.enum(['running', 'done', 'failed']),
  /** Its steps in words, newest last (at most 30). */
  steps: z.array(z.string().max(300)).max(30),
  outputs: z.array(OutputView).max(50),
  /** 1.3: the same steps with their tools' kinds (for icons), what it's doing now, its kind ("general-purpose"), when it started and ended. */
  trail: z.array(StepView).max(30).optional(),
  step: z.string().max(300).optional(),
  tool: ToolKind.optional(),
  type: z.string().max(60).optional(),
  startedAt: ts.optional(),
  endTs: ts.optional(),
  /** Steps it has taken in all (the trail keeps the last 30). */
  count: z.number().int().min(0).optional(),
});
export type SubAgentView = z.infer<typeof SubAgentView>;

/** Claude's text, with code blocks taken out: each is a `[[code:n]]` marker and one entry in `code`. */
export const ProseView = z.object({
  text,
  code: z
    .array(
      z.object({
        lang: z.string().max(40).optional(),
        lines: z.number().int().min(0),
        /**
         * 1.3: what Claude drew for the screen rather than code (BLG-68): a `beluga-view` (table,
         * chart, stats, code, colors), a `beluga-graph` or `beluga-tasks`, its JSON as written. The
         * phone reads it with the Mac's own parsers (src/shared) and draws it; its source's rows
         * come through the Mac (companion.viewFetch). A phone before 1.3 shows the chip. A table
         * Claude wrote as text is a `view` (a table) too; 1.5: one that only looks like a table
         * is `text`, shown monospaced and never wrapped. 1.9 (BLG-87): a file tree (`tree`), JSON
         * (`json`) or terminal output (`terminal`) as written, display math as its TeX (`math`), and
         * a mermaid diagram as the `graph` or `view` it reads as (src/shared/render/rich-fence.ts).
         */
        block: z.object({ kind: z.union([z.enum(['view', 'graph', 'tasks', 'text', 'tree', 'json', 'terminal', 'math']), z.string().max(20)]), text: z.string().max(200_000) }).optional(),
      }),
    )
    .max(200),
  /**
   * 1.9: the math in it typeset on the Mac (MathJax, src/companion/math-svg.ts), by `I<tex>` (inline,
   * `$…$` in the text) or `D<tex>` (a `math` block): an SVG drawn in the text's color
   * (`currentColor`), its size and baseline in ex. Math the Mac couldn't typeset isn't here: the
   * phone shows its TeX.
   */
  math: z.record(z.string().max(4001), z.object({ svg: z.string().max(200_000), w: z.number(), h: z.number(), v: z.number() })).optional(),
});
export type ProseView = z.infer<typeof ProseView>;

/**
 * 1.10 (BLG-110): one sub-agent opened on the phone (`companion.subAgent`): its activity, every
 * step in words with when it began (newest last), and once it ended the report it gave back, code
 * stripped as Claude's answers are (`stripCode`). `missing`: the Mac keeps no details of it
 * (someone else's Claude, or gone); the phone shows what the view had.
 */
export const SubAgentStepView = StepView.extend({ at: ts.optional() });
export type SubAgentStepView = z.infer<typeof SubAgentStepView>;
export const SubAgentDetailView = z.object({
  id,
  timeline: z.array(SubAgentStepView).max(200),
  /** Steps it took in all (the timeline keeps the last 200). */
  count: z.number().int().min(0).optional(),
  result: ProseView.optional(),
  missing: z.boolean().optional(),
});
export type SubAgentDetailView = z.infer<typeof SubAgentDetailView>;

/** Which agent it is (src/protocol.ts AgentRef, repeated here: this file is the phone's whole contract). */
export const AgentRefView = z.object({ runtime: z.string().max(32), model: z.string().max(64).optional(), label: z.string().max(64) });
export type AgentRefView = z.infer<typeof AgentRefView>;

/** 1.41 (BLG-702): one emoji under a message: how many put it there, whether you did, and who (their names, you as "You"). */
export const ChatReactionView = z.object({
  emoji: z.string().min(1).max(32),
  count: z.number().int().min(1),
  mine: z.boolean(),
  who: z.array(z.string().max(100)).max(20),
});
export type ChatReactionView = z.infer<typeof ChatReactionView>;

export const TurnView = z.object({
  id,
  who: z.enum(['you', 'claude', 'friend', 'system']),
  name: z.string().max(100),
  /** BLG-498: with `claude`, which agent it is (its mark); an older Mac leaves it out (the phone goes by the name). */
  agent: AgentRefView.optional(),
  /** 1.38: an external agent sent this message through its owner's Beluga: its name. */
  via: z.string().max(80).optional(),
  prose: ProseView,
  ts,
  status: z.enum(['queued', 'working', 'done', 'failed', 'stopped']).optional(),
  /** What it's doing now, in words ("Running the tests · 137/215"). */
  step: z.string().max(300).optional(),
  steps: z.number().int().min(0).optional(),
  subagents: z.array(SubAgentView).max(40).optional(),
  outputs: z.array(OutputView).max(50).optional(),
  endTs: ts.optional(),
  /**
   * 1.45 (BLG-149): the agent in another chat, not you, asked for this turn: its chat's ref and
   * title, the agent, and its words. Drawn above the turn as a card, never as your message.
   */
  origin: z.object({ ref: z.string().max(400), title: z.string().max(200), agent: z.string().max(64), prose: ProseView }).optional(),
  /** 1.3: what it's doing now (a running turn), and its steps in words with their tools, newest last. */
  live: LiveView.optional(),
  trail: z.array(StepView).max(40).optional(),
  /**
   * Your message, steered into Claude's running turn, that Claude hasn't read yet (1.3): it waits
   * for Claude's next step (Send now: host.steerNow with `request`), or for its step to stop.
   */
  steer: z.object({ request: id, waiting: z.enum(['next_step', 'stopping']) }).optional(),
  /**
   * 1.28 (BLG-387): your message can be edited (workspaces.editPrompt with the conversation's
   * workspace, this turn's id, the new words and 'here' or 'fork'): where it is, a worktree (its
   * files go back too) or a chat. Only a message whose words show here whole (no code in it).
   */
  edit: z.object({ ws: id, kind: z.enum(['worktree', 'chat']) }).optional(),
  /**
   * 1.42 (BLG-757): a run that stopped on your usage limit: when Beluga tells it to continue on its
   * own (shared/auto-continue.ts), said under its card. Changed only on the Mac (a setting). An older
   * Mac leaves it out.
   */
  resumesAt: ts.optional(),
  /** 1.41 (BLG-702): a person's message in the room's or a workspace's chat: its emoji reactions (`session.react` changes yours). */
  reactions: z.array(ChatReactionView).max(20).optional(),
  /** 1.41: it takes reactions (a message of the room's or a workspace's chat, not an earlier line). */
  reactable: z.boolean().optional(),
  /**
   * 1.34 (BLG-466): where a dialogue between agents begins (core/dialogues view.ts, in words): its
   * topic, who talks, turn n of the cap, the budget left, and whether Stop / Continue apply now.
   * Its turns follow as `claude` turns named for their agent.
   */
  dialogue: z
    .object({
      id,
      topic: z.string().max(500),
      mode: z.string().max(40),
      who: z.string().max(200),
      progress: z.string().max(100),
      budget: z.string().max(60).optional(),
      status: z.string().max(300),
      tone: z.enum(['live', 'waiting', 'done', 'failed']),
      canStop: z.boolean(),
      canContinue: z.boolean(),
    })
    .optional(),
});
export type TurnView = z.infer<typeof TurnView>;

export const ConvSummary = z.object({
  topic: Topic,
  title: z.string().max(300),
  project: z.string().max(200).optional(),
  status: z.enum(['working', 'waiting', 'idle', 'failed']),
  last: z.string().max(300).optional(),
  lastAt: ts.optional(),
  unread: z.number().int().min(0).optional(),
  needsYou: z.boolean().optional(),
  /** Running sub-agents, for the dots. */
  agents: z.number().int().min(0).optional(),
  /** 1.3: its project's id and icon (a checksum: companion.icon), and outputs made since you last wrote in it. */
  projectId: z.string().max(200).optional(),
  icon: z.string().regex(/^[0-9a-f]{16,64}$/).optional(),
  fresh: z.number().int().min(0).optional(),
  /** 1.44: in Work while `chatCategories` is on: its category, none for what has none (the room). */
  category: z.enum(['active', 'working', 'snoozed', 'settled']).optional(),
  /** 1.44: when a snoozed chat wakes. */
  snoozedUntil: ts.optional(),
  /** 1.44: why a settled chat settled. */
  settledWhy: z.enum(['you', 'pr_merged', 'merged_here', 'idle']).optional(),
  /** 1.44: a snooze ended, and it shows Back until you open it. */
  back: z.literal(true).optional(),
  /** 1.46 (BLG-840): commits in its worktree that its open PR doesn't have, the Mac row's ↑N chip: merging now would leave them out. */
  notOnPr: z.object({ count: z.number().int().min(1).max(100_000), pr: z.number().int().positive() }).optional(),
  /** 1.47, with threads on: the agent this chat runs, for its mark. */
  harness: AgentRefView.optional(),
  /** 1.47: the chat it sits under in Work. Only a live parent in the same project; a kept child has none. */
  parent: Topic.optional(),
  /** 1.55 (BLG-940): a worktree of yours shared with this many people (friends, or your room), the Mac row's green dot. */
  shared: z.number().int().min(1).max(1000).optional(),
});
export type ConvSummary = z.infer<typeof ConvSummary>;

// ---- views, one per topic

export const HomeView = z.object({
  // 1.13: keepAwake, whether the Mac stays awake for the phone (companion.keepAwake).
  // 1.54: usage statistics (BLG-922): only when this Mac's build can send them; level unset until chosen.
  mac: z.object({ name: z.string().max(100), version: z.string().max(40), keepAwake: z.enum(['off', 'power', 'always']).optional(), telemetry: z.object({ level: z.enum(['off', 'limited', 'on']).optional() }).optional() }),
  me: z.object({ name: z.string().max(64), peerId: id }),
  usage: z.array(UsageView).max(8),
  /**
   * 1.50: prompt-cache hit rate by conversation and by model. Empty means nothing was counted yet
   * (not a measured 0%). Absent: an older Mac, and the phone hides the section.
   */
  cache: z.array(z.object({ scope: z.enum(['session', 'model']), label: z.string().max(80), pct: z.number().min(0).max(100) })).max(24).optional(),
  needsYou: z.array(NeedsYou).max(50),
  running: z.array(ConvSummary).max(20),
  /**
   * Every conversation's newest outputs in one list, until 1.2. Since 1.3 it's empty: outputs live
   * with their conversation (ConvView `outputs`), Home only hints at new ones (ConvSummary `fresh`).
   * Kept, empty, so older phones still read Home.
   */
  outputs: z.array(OutputView.extend({ topic: Topic.optional() })).max(30),
  unread: z.object({ work: z.number().int().min(0), chats: z.number().int().min(0) }),
  /** 1.5: "Your Mac" (`conv:mac:assistant`): its last line and whether it works, for Home's "Ask your Mac". Since BLG-102 the chat open on the Mac (its topic may be `conv:mac:assistant:<id>`, see isMacTopic). */
  assistant: ConvSummary.optional(),
  /** 1.14: every one of Your Mac's chats in the Mac's tab order, each titled by its tab ("New chat" until you write), for the phone's chat list. */
  macChats: z.array(ConvSummary).max(40).optional(),
  /** 1.3: tasks waiting for your review (Home links to them). */
  review: z.object({ count: z.number().int().min(0), first: z.object({ topic: Topic, key: z.string().max(40), title: z.string().max(300) }).optional() }).optional(),
});
export type HomeView = z.infer<typeof HomeView>;

export const WorkView = z.object({
  projects: z.array(z.object({ id, name: z.string().max(200), conversations: z.array(ConvSummary).max(200), /** 1.3: its icon's checksum (companion.icon). */ icon: z.string().regex(/^[0-9a-f]{16,64}$/).optional() })).max(200),
  /** 1.44: `chatCategories` is on: the phone sorts by `ConvSummary.category`. */
  categories: z.literal(true).optional(),
});
export type WorkView = z.infer<typeof WorkView>;

/** A worktree's merge as the phone follows it (1.3). Files by name only, never their contents. */
export const MergeView = z.object({
  phase: z.union([z.enum(['merging', 'conflicts', 'resolving', 'resolved', 'merged', 'blocked']), z.string().max(20)]),
  at: ts,
  conflicts: z.array(z.string().max(300)).max(100).optional(),
  why: z.string().max(500).optional(),
});
export type MergeView = z.infer<typeof MergeView>;

/**
 * 1.8: the branch steps the phone can ask the Mac for (companion.branchStep): all of the Mac's
 * (core/branch-state.ts) but Merge into the main folder (its own sheet, companion.merge) and Open
 * PR (the phone's browser). Since BLG-753 also Push (an open PR's commits not pushed yet) and Re-run
 * Failed Checks, added at the end (an older Mac never offers them); since BLG-948 Open Your Own PR
 * (a fork's pull request that can't be pushed to).
 */
export const PHONE_BRANCH_STEPS = ['merge_pr', 'merge_auto', 'merge_admin', 'cancel_auto', 'update_branch', 'mark_ready', 'resolve_pr', 'fix_checks', 'merge_claude', 'review_claude', 'commit', 'pr', 'pr_claude', 'pr_draft', 'pr_original', 'continue_after_merge', 'archive', 'delete', 'push', 'rerun_checks', 'pr_own'] as const;
export type PhoneBranchStep = (typeof PHONE_BRANCH_STEPS)[number];

/** 1.8: one of a branch's steps (core/branch-state.ts BranchStep). */
export const BranchStepView = z.object({
  id: z.string().max(40),
  label: z.string().max(80),
  hint: z.string().max(300),
  /** Claude does it, in the worktree's conversation. */
  claude: z.boolean().optional(),
  /** Can't be undone (Delete Worktree, merging past the checks): the phone asks first. */
  danger: z.boolean().optional(),
});
export type BranchStepView = z.infer<typeof BranchStepView>;

/** 1.6: where a worktree's branch stands, as the Mac's toolbar shows it (core/branch-state.ts), and its next step in words. */
/** How many threads a step would touch, and how many of them work now (for the question's words). */
export const ThreadCountView = z.object({ count: z.number().int().min(0), running: z.number().int().min(0) });
export type ThreadCountView = z.infer<typeof ThreadCountView>;

export const BranchView = z.object({
  kind: z.string().max(40),
  /** "Merged", "Ready to merge", "Conflicts". */
  label: z.string().max(80),
  tone: z.union([z.enum(['merged', 'ok', 'error', 'warn', 'wait', 'info', 'muted']), z.string().max(10)]),
  detail: z.string().max(300),
  branch: z.string().max(250),
  into: z.string().max(250),
  /** 1.8: `url`, its page on GitHub (Open PR opens it on the phone). */
  pr: z.object({ number: z.number().int().min(0), state: z.string().max(10), url: z.string().max(500).optional() }).optional(),
  /** The Mac's next step: "Squash and Merge", and whether Claude does it. */
  next: z.object({ id: z.string().max(40), label: z.string().max(80), claude: z.boolean().optional() }).optional(),
  /** 1.8: every step, the main one first (the Mac's toolbar button, then its menu); the phone does them with companion.branchStep. */
  steps: z.array(BranchStepView).max(20).optional(),
  /** 1.47: the threads archiving or deleting it would ask about. Unset: it has none. */
  threads: z.object({ archive: ThreadCountView, delete: ThreadCountView }).optional(),
});
export type BranchView = z.infer<typeof BranchView>;

/** What a merge would do and what stands in the way (companion.mergeCheck): the Mac's own checks, in words. */
export const MergeCheckView = z.object({
  from: z.string().max(200),
  into: z.string().max(200),
  commits: z.number().int().min(0),
  files: z.number().int().min(0),
  /** The newest commits' subjects (words, at most 5). */
  subjects: z.array(z.string().max(300)).max(5),
  checks: z.array(z.object({ id: z.string().max(40), tone: z.union([z.enum(['ok', 'info', 'block']), z.string().max(10)]), text: z.string().max(500), fix: z.union([z.enum(['commit', 'claude']), z.string().max(20)]).optional() })).max(12),
  canMerge: z.boolean(),
  /** The button: "Merge 3 Commits". */
  confirm: z.string().max(60),
  conflicts: z.array(z.string().max(300)).max(100).optional(),
});
export type MergeCheckView = z.infer<typeof MergeCheckView>;

/** 1.32: the agent picker (BLG-446): your default agent's runtime first; one this Mac doesn't run has `why` and no models. */
export const AgentPickerView = z.object({
  runtime: z.string().max(32),
  label: z.string().max(120),
  groups: z
    .array(
      z.object({
        runtime: z.string().max(32),
        label: z.string().max(64),
        available: z.boolean(),
        why: z.string().max(200).optional(),
        isDefault: z.boolean(),
        current: z.boolean(),
        models: z.array(z.object({ value: z.string().max(80), label: z.string().max(80), description: z.string().max(200), on: z.boolean() })).max(30),
        /** BLG-945: how many more models this runtime has on the Mac than `models` holds (the picked one is always in it). */
        more: z.number().int().min(0).optional(),
      }),
    )
    .max(8),
});
export type AgentPickerView = z.infer<typeof AgentPickerView>;

/** A thread's state, or a newer Mac's word this phone doesn't know yet. */
const ThreadStateView = z.union([z.enum(['queued', 'running', 'needs_you', 'waiting_limit', 'done', 'failed', 'stopped', 'interrupted']), z.string().max(20)]);

/**
 * 1.47: a chat's family, the Mac's Threads panel without its native sub-agents (the phone's strip has
 * those): the chat that started it and the threads it started, most urgent first. Titles only, never
 * a thread's task or result.
 */
export const ThreadFamilyView = z.object({
  /** No `topic`: nothing to open (removed, or a Your Mac chat). `gone`: removed, and only its title stays. */
  parent: z.object({ title: z.string().max(300), topic: Topic.optional(), state: ThreadStateView.optional(), gone: z.boolean() }).optional(),
  children: z.array(z.object({ id, topic: Topic, title: z.string().max(300), state: ThreadStateView, working: z.boolean(), harness: AgentRefView })).max(100),
  /** SINCE.threadAgents: its native sub-agents, read-only (no Stop, no page of their own), with the chat's harness. */
  agents: z.array(z.object({ id, title: z.string().max(300), state: ThreadStateView, startedAt: ts.optional(), harness: AgentRefView })).max(40).optional(),
  /** This chat's workspace id: `threads.stopAll` takes it. */
  chat: id,
  /** BLG-345: whether harness marks show (the chats listed run two or more harnesses). Left out by an older Mac: they show. */
  marks: z.boolean().optional(),
  /** Every working thread under this chat, each after its own children. */
  stoppable: z.array(id).max(200),
});
export type ThreadFamilyView = z.infer<typeof ThreadFamilyView>;

export const ConvView = z.object({
  topic: Topic,
  title: z.string().max(300),
  project: z.string().max(200).optional(),
  turns: z.array(TurnView).max(200),
  /** Older turns exist (companion.older). */
  more: z.boolean(),
  /** 1.51: the Mac has chat links (always on a Mac newer than 3.3.0): each "@Title (chat: …)" of yours is a chip. Without it, the phone shows "@Title". */
  chatLinks: z.literal(true).optional(),
  needsYou: z.array(NeedsYou).max(20),
  /** You may write here (it's yours, or shared with you to work in). */
  canSend: z.boolean(),
  working: z.boolean(),
  /** 1.47: its parent and child threads. Unset: it has neither, or threads are off. */
  threadFamily: ThreadFamilyView.optional(),
  /** 1.3: its project's id and icon, everything its worktree made (scratch files, reports, its Claude's and sub-agents' outputs, newest first), and what of yours waits its turn. */
  projectId: z.string().max(200).optional(),
  icon: z.string().regex(/^[0-9a-f]{16,64}$/).optional(),
  outputs: z.array(OutputView).max(100).optional(),
  /** What waits for your agent here, in run order: your messages, and messages from your other chats (`origin`). Steer one (host.promote) or remove it (host.cancelQueued) by `id`. */
  /** `waiting`: why it hasn't started though nothing runs here (your Claude works in as many conversations as it may at once). */
  queue: z
    .array(
      z.object({
        id,
        text: z.string().max(300),
        waiting: z.string().max(300).optional(),
        /** 1.46: an agent in another chat sent it, not you: its chat's ref and title, and the agent. */
        origin: z.object({ ref: z.string().max(400), title: z.string().max(200), agent: z.string().max(64) }).optional(),
      }),
    )
    .max(20)
    .optional(),
  /** 1.3: a worktree of yours: it can be merged from the phone (companion.mergeCheck, companion.merge). */
  mergeable: z.boolean().optional(),
  /** 1.3: where its merge stands: merging, conflicts (files by name), Claude resolving them, Claude done (check again), merged, or blocked (why). */
  merge: MergeView.optional(),
  /** 1.6: a worktree's branch: merged, ready to merge, conflicts, checks… (BranchView). */
  branch: BranchView.optional(),
  /** 1.15: the plan this conversation writes and runs (its home): its page, name, state and progress. */
  plan: z.object({ topic: Topic, title: z.string().max(300), state: z.string().max(20), done: z.number().int(), total: z.number().int(), milestones: z.number().int() }).optional(),
  /** A friend's worktree shared over the network whose owner's Mac is offline: what the message box says (what you send waits for it). */
  waiting: z.string().max(200).optional(),
  /** 1.32: your conversation's agent picker (src/ui/agent-picker.ts): the chip's words, and runtimes as groups with their models. */
  agent: AgentPickerView.optional(),
  /**
   * BLG-520, the room only: its agent tags for "@" in the message box (shared/agent-tags.ts), each
   * agent by name with its mark ("@codex" yours, "@bob:codex" bob's). An older Mac leaves it out.
   */
  tags: z.array(z.object({ tag: z.string().max(80), hint: z.string().max(200), agent: AgentRefView })).max(40).optional(),
  /** 1.36: the agent's own terminal on the Mac drives this conversation (its agent's name): messages wait for Take Over. */
  terminal: z.object({ label: z.string().max(80) }).optional(),
  /** 1.41 (BLG-702): your quick reactions, for a reactable turn's long-press (the room's or a workspace's chat). */
  quick: z.array(z.string().min(1).max(32)).max(8).optional(),
});
export type ConvView = z.infer<typeof ConvView>;

export const PlanTaskView = z.object({
  id,
  title: z.string().max(300),
  state: z.string().max(40),
  mine: z.boolean().optional(),
  topic: Topic.optional(),
  /** 1.5: what it's for, done means (its acceptance), the plan's tasks it waits on (ids), and why it can't start yet. */
  goal: z.string().max(1000).optional(),
  acceptance: z.array(z.string().max(400)).max(20).optional(),
  blockedBy: z.array(id).max(20).optional(),
  why: z.string().max(300).optional(),
});
/** How a plan runs (1.5): Step by Step (you start each task), Check-ins (waits at each milestone), Autopilot. */
export const PlanAutonomy = z.union([z.enum(['step', 'gated', 'autopilot']), z.string().max(20)]);
export const PlanView = z.object({
  id,
  title: z.string().max(300),
  goal: z.string().max(4000).optional(),
  state: z.string().max(40),
  topic: Topic.optional(),
  milestones: z
    .array(
      z.object({
        id,
        title: z.string().max(300),
        state: z.string().max(40),
        criteria: z.array(z.string().max(1000)).max(40),
        tasks: z.array(PlanTaskView).max(100),
        /** 1.5: the milestones it waits on (ids; none: it runs alongside from the start), and its own autonomy when it differs from the plan's. */
        dependsOn: z.array(id).max(20).optional(),
        autonomy: PlanAutonomy.optional(),
        /** 1.39: the conversation of its checker (a Claude of its own checking its criteria), once there is one. */
        checker: Topic.optional(),
        /** 1.40: its agent at work right now (“Working on BLG-12 · Edit README.md”), and its conversation. */
        agentNow: z.object({ text: z.string().max(300), asking: z.boolean().optional(), topic: Topic.optional() }).optional(),
      }),
    )
    .max(50),
  needsYou: z.array(NeedsYou).max(20),
  /** 1.5: how it runs (plans.setAutonomy), paused, how many tasks may run at once, and how many run now. */
  autonomy: PlanAutonomy.optional(),
  paused: z.boolean().optional(),
  parallel: z.number().int().min(0).optional(),
  running: z.number().int().min(0).optional(),
  /** 1.35 (BLG-498): who works its milestones and tasks from here on (none: your default), and the list to change it from (`plans.setWorkAgent`). */
  agent: AgentRefView.optional(),
  agents: AgentPickerView.optional(),
  /** 1.45 (BLG-772): what the plan has decided, in order (a replaced one marked), and its draft's review before approval. */
  decisions: z.array(z.object({ text: z.string().max(1000), replaced: z.boolean().optional() })).max(60).optional(),
  review: z
    .object({
      state: z.enum(['reviewing', 'findings', 'clean', 'failed']),
      fixAsked: z.boolean().optional(),
      findings: z.array(z.object({ kind: z.string().max(20), text: z.string().max(1000) })).max(20),
      /** While it verifies: what it's doing now, in a line, how many of its four checks are behind it, and since when. */
      now: z.string().max(240).optional(),
      checksDone: z.number().int().min(0).max(4).optional(),
      since: z.number().optional(),
    })
    .optional(),
});
export type PlanView = z.infer<typeof PlanView>;
export const PlansView = z.object({ plans: z.array(PlanView.pick({ id: true, title: true, state: true, topic: true }).extend({ done: z.number().int(), total: z.number().int() })).max(100) });
export type PlansView = z.infer<typeof PlansView>;

/** The board's statuses and priorities (src/core/board/model.ts), as the phone shows them. */
export const TaskStatus = z.union([z.enum(['backlog', 'todo', 'in_progress', 'in_review', 'in_plan', 'done', 'canceled']), z.string().max(20)]);
export const TaskPriority = z.union([z.enum(['urgent', 'high', 'medium', 'low', 'none']), z.string().max(20)]);

/** At most this many of the board's other tasks in the Tasks view (`TasksView.others`). */
export const TASK_OTHERS = 1500;

/** A task in a list (1.3): its key, title, status, priority, who has it ("you", "your Claude", "Mia"). */
export const TaskSummary = z.object({
  id,
  topic: Topic,
  key: z.string().max(40),
  title: z.string().max(300),
  status: TaskStatus,
  priority: TaskPriority,
  assignee: z.string().max(80).optional(),
  /** Acceptance criteria ticked, of all. */
  checks: z.object({ done: z.number().int().min(0), total: z.number().int().min(0) }).optional(),
  /** The conversation of the worktree doing it. */
  conv: Topic.optional(),
  pr: z.object({ number: z.number().int().min(0), state: z.string().max(20) }).optional(),
  /** Teammates on the same repository working on it now (core/team): "Ata is working on this". */
  working: z.string().max(200).optional(),
  /** Teammates who don't have its latest change yet (BLG-273): "Ata doesn't have the latest yet". */
  waiting: z.string().max(240).optional(),
  /** It's an epic (a task with sub-tasks): how many of them are done, of all but canceled ones. */
  epic: z.object({ done: z.number().int().min(0), total: z.number().int().min(0) }).optional(),
  /** The epic it's part of: its key. */
  epicKey: z.string().max(40).optional(),
  /** The repo it runs in (its name), when its board covers several (1.31). */
  repo: z.string().max(200).optional(),
  /** The board it's on (its name), when listed on its repo's own board from another (1.37). */
  onBoard: z.string().max(200).optional(),
  /** Only you see it (BLG-501): it never reaches teammates or Linear. */
  private: z.literal(true).optional(),
  /**
   * 1.56 (BLG-952): held for its checks, as the Mac's "Needs its checks": `open` criteria are neither
   * ticked nor explained, so it stays out of review; `merged`: its work merged, so it stays out of Done.
   */
  needsChecks: z.object({ open: z.number().int().min(1), merged: z.literal(true).optional() }).optional(),
  updatedAt: ts,
});
export type TaskSummary = z.infer<typeof TaskSummary>;

export const TasksView = z.object({
  projects: z
    .array(
      z.object({
        id,
        name: z.string().max(200),
        icon: z.string().regex(/^[0-9a-f]{16,64}$/).optional(),
        /** By status, in the board's order (in progress, in review, ready, backlog, then the latest done). */
        groups: z.array(z.object({ status: TaskStatus, label: z.string().max(40), tasks: z.array(TaskSummary).max(100), more: z.number().int().min(0).optional() })).max(10),
      }),
    )
    .max(100),
  /**
   * The board's other tasks, the ones `groups` leave out (older done, canceled, past a group's
   * 100), newest first: only what a task key in Claude's words needs to be a live chip (BLG-109).
   * Optional: an older Mac leaves it out, and the phone then knows only the listed ones.
   */
  others: z.array(z.object({ id, key: z.string().max(40), title: z.string().max(300), status: TaskStatus })).max(TASK_OTHERS).optional(),
});
export type TasksView = z.infer<typeof TasksView>;

/** One task's page (1.3): its brief's goal (code folded), acceptance with ticks, activity, worktree and pull request. */
export const TaskPageView = TaskSummary.extend({
  project: z.string().max(200),
  projectId: z.string().max(200),
  icon: z.string().regex(/^[0-9a-f]{16,64}$/).optional(),
  goal: ProseView.optional(),
  acceptance: z.array(z.object({ text: z.string().max(1000), state: z.union([z.enum(['done', 'deferred', 'not_done', 'open']), z.string().max(20)]), reason: z.string().max(1000).optional() })).max(60),
  /** Newest last. */
  /** `agent` (BLG-498): an agent's line, which agent it was (its mark); an older Mac leaves it out (the phone goes by `who`). */
  activity: z.array(z.object({ id, at: ts, who: z.string().max(80), agent: AgentRefView.optional(), text: z.string().max(500), body: z.string().max(8000).optional(), comment: z.boolean().optional() })).max(60),
  worktree: z.string().max(200).optional(),
  pr: z.object({ number: z.number().int().min(0), state: z.string().max(20), title: z.string().max(300), checks: z.string().max(20).optional() }).optional(),
  /** Where it may be moved from the phone (board.move), with their labels. */
  moves: z.array(z.object({ status: TaskStatus, label: z.string().max(40) })).max(10),
  /**
   * 1.35 (BLG-498): who works it (none: your default), and while it can start, every agent (for Start
   * with…). BLG-569: with a worktree on it (`conv`), `agent` is the one running there, shown only (it's
   * changed in that conversation); a newer phone no longer changes it from here (`board.setAgent`).
   */
  agent: AgentRefView.optional(),
  agents: AgentPickerView.optional(),
});
export type TaskPageView = z.infer<typeof TaskPageView>;

/** 1.21 (BLG-237): a sentinel run's state (src/core/sentinel/model.ts RUN_STATES); one a phone doesn't know is drawn plain. */
export const SentinelRunState = z.union([z.enum(['queued', 'running', 'needs-you', 'done', 'skipped', 'failed', 'stopped']), z.string().max(20)]);

/**
 * 1.21: a sentinel in the list (docs/sentinel.md §2): its name, icon (a name the screens know:
 * "calendar", "wrench"…), project (none: Your Mac), when it runs in words (`sentence`, the Mac's
 * own), whether it's paused and why Beluga paused it, its last run, its next one, and whether a
 * run is going now.
 */
export const SentinelSummary = z.object({
  id,
  topic: Topic,
  name: z.string().max(100),
  icon: z.string().max(40),
  projectId: z.string().max(200).optional(),
  project: z.string().max(200).optional(),
  sentence: z.string().max(300),
  paused: z.boolean(),
  pausedWhy: z.string().max(300).optional(),
  /** BLG-239: why its event trigger can't watch now, with what to do (no gh, no Stripe key, no token). */
  trouble: z.string().max(300).optional(),
  last: z.object({ state: SentinelRunState, headline: z.string().max(300), at: ts }).optional(),
  nextAt: ts.optional(),
  live: z.boolean(),
});
export type SentinelSummary = z.infer<typeof SentinelSummary>;

/** 1.22: how a number moved, in words, with its tone by which way is good (src/core/sentinel/metrics.ts). */
export const NumberTone = z.union([z.enum(['good', 'bad', 'flat', 'none']), z.string().max(10)]);
export const NumberDelta = z.object({ change: z.string().max(60).optional(), tone: NumberTone });
/** 1.22: what a number is compared with (one a phone doesn't know is shown as the dashboard's). */
export const CompareKind = z.union([z.enum(['previous', 'day', 'week', 'month']), z.string().max(10)]);

/** 1.22: a dashboard in a list (its tab). */
export const DashboardRef = z.object({ id, name: z.string().max(100), topic: Topic });

/** 1.21: every sentinel, and the latest runs that ended across them (newest first), for Home's "2 ran since you looked". */
export const SentinelsView = z.object({
  /** Sentinel runs on this Mac (the Mac app's daemon). */
  enabled: z.boolean(),
  sentinels: z.array(SentinelSummary).max(200),
  recent: z.array(z.object({ id, sentinelId: id, state: SentinelRunState, at: ts })).max(50),
  /** 1.22: your dashboards, in their tabs' order. */
  dashboards: z.array(DashboardRef).max(30).optional(),
  /** 1.22: Home's row: the first dashboard's first three numbers, compared as that dashboard says. */
  numbers: z.object({ dashboard: DashboardRef, items: z.array(z.object({ label: z.string().max(100), value: z.string().max(60), change: z.string().max(60).optional(), tone: NumberTone })).max(3) }).optional(),
  /** 1.23: the Sentinel chat's open conversation (docs/sentinel.md §12): its topic, name, last line, and whether Claude works in it. */
  chat: z.object({ topic: Topic, title: z.string().max(100), last: z.string().max(300).optional(), lastAt: ts.optional(), working: z.boolean() }).optional(),
});
export type SentinelsView = z.infer<typeof SentinelsView>;

/**
 * 1.21: one run, as the sentinel's page lists it: who ran it in words ("schedule", "you", "after
 * Nightly tests"), its state, headline, times, why it failed, its pull request, the step it's on
 * (a running one), and its report as an output (opened in the reader). No report ref (a run kept
 * in memory only): the phone asks `sentinel.runGet` for its text.
 */
export const SentinelRunView = z.object({
  id,
  by: z.string().max(120),
  state: SentinelRunState,
  headline: z.string().max(300),
  startedAt: ts,
  endedAt: ts.optional(),
  why: z.string().max(500).optional(),
  pr: z.object({ number: z.number().int().min(0), url: z.string().max(500) }).optional(),
  step: z.string().max(100).optional(),
  report: OutputView.optional(),
  /** BLG-330: its Claude step's conversation (a channel the phone's conversation screen opens), to watch it work. */
  chat: z.string().max(200).optional(),
});
export type SentinelRunView = z.infer<typeof SentinelRunView>;

/** 1.21: a sentinel's page: its summary, its steps (kind and name, never their commands), its last 30 runs (newest first) and what of it waits for you. */
export const SentinelPageView = SentinelSummary.extend({
  steps: z.array(z.object({ kind: z.string().max(20), name: z.string().max(100) })).max(40),
  runs: z.array(SentinelRunView).max(30),
  needsYou: z.array(NeedsYou).max(10),
  /** 1.25 (BLG-352): its workflow as a `beluga-graph` (JSON): what starts it, its steps, where results land, its last run's states. */
  graph: z.string().max(200_000).optional(),
});
export type SentinelPageView = z.infer<typeof SentinelPageView>;

/**
 * 1.22 (BLG-244): a dashboard's tile as the phone draws it, worked out on the Mac: its title, the
 * sentinel it's from (paused or gone said quietly), and for its kind: a number with its change for
 * every compare (the phone's chips pick one; `pinned` is the tile's own), a chart's series, a
 * table's rows, a text's headline (or its report through `sentinel.runGet` with `runId`). A tile
 * never carries a source, a query or a key.
 */
export const DashboardTileView = z.object({
  id,
  kind: z.union([z.enum(['number', 'chart', 'series', 'table', 'output', 'text', 'divider']), z.string().max(20)]),
  /** Columns of six, 1 to 3 (what an older phone reads; `span` is the real one). */
  width: z.number().int().min(1).max(3),
  /** 1.23: its real width, 1 to 6 columns, and whether it's tall. */
  span: z.number().int().min(1).max(6).optional(),
  tall: z.boolean().optional(),
  title: z.string().max(100),
  state: z.union([z.enum(['ok', 'paused', 'draft', 'gone', 'waiting']), z.string().max(20)]),
  sentinel: z.string().max(100).optional(),
  topic: Topic.optional(),
  value: z.string().max(60).optional(),
  deltas: z.record(z.string().max(10), NumberDelta).optional(),
  pinned: CompareKind.optional(),
  /** The last points (a sparkline), oldest first. */
  trend: z.array(z.number()).max(90).optional(),
  chart: z.object({
    kind: z.string().max(10),
    unit: z.string().max(20),
    series: z.array(z.object({ label: z.string().max(100), points: z.array(z.tuple([ts, z.number()])).max(90) })).max(8),
    /** 1.23: a kept array (a series tile of a `series` metric): each point's label; the points' first number is its place. */
    labels: z.array(z.string().max(80)).max(90).optional(),
  }).optional(),
  /** 1.23: an output tile: how it reads (`markdown`, `tree`, `table`, `text`), the text (Markdown without its code, or JSON), and whether it was cut. */
  output: z.object({ look: z.union([z.enum(['markdown', 'tree', 'table', 'text']), z.string().max(10)]), text: z.string().max(16_000), cut: z.boolean().optional() }).optional(),
  table: z
    .object({
      columns: z.array(z.string().max(80)).max(20),
      rows: z.array(z.array(z.union([z.string().max(300), z.number(), z.boolean(), z.null()])).max(20)).max(50),
      total: z.number().int().min(0),
      /** 1.29 (BLG-386): each column's key (what an action's row is sent back with). */
      keys: z.array(z.string().max(80)).max(20).optional(),
      /** 1.25: the metric the rows are (a chip's `sentinel.document` names it). */
      metric: z.object({ sentinelId: z.string().max(200), name: z.string().max(80) }).optional(),
      /** 1.25: typed columns by place: `html`/`file` (a document), `storage`, `url`, `path`, with each row's whole value (a document's file name, a storage object's bucket/path). */
      typed: z
        .array(
          z.object({
            col: z.number().int().min(0).max(19),
            key: z.string().max(80),
            kind: z.union([z.enum(['html', 'file', 'storage', 'url', 'path']), z.string().max(20)]),
            values: z.array(z.string().max(1200).nullable()).max(50),
            /** 1.29 (BLG-386): a document's or storage object's cell as a ref the phone streams (`get`), with its name and kind; the Mac reads or fetches it then. */
            docs: z.array(DocRefView.nullable()).max(50).optional(),
            /** 1.29: what the column's sentinel said of it: progress's and rating's most, which way a change is good, an action's or a document's button words. */
            max: z.number().optional(),
            better: z.union([z.enum(['up', 'down', 'none']), z.string().max(10)]).optional(),
            button: z.string().max(60).optional(),
          }),
        )
        .max(20)
        .optional(),
    })
    .optional(),
  text: z.string().max(2000).optional(),
  runId: z.string().max(200).optional(),
  at: ts.optional(),
});
export type DashboardTileView = z.infer<typeof DashboardTileView>;

/**
 * 1.25 (BLG-345): a table's document, read through the Mac (`sentinel.document`): its name, kind,
 * size, and its text or bytes (base64). A phone gets at most DOCUMENT_TO_PHONE of it (`cut`: text was).
 */
export const DocumentView = z.object({
  name: z.string().max(200),
  mime: z.string().max(100),
  size: z.number().int().min(0),
  text: z.string().optional(),
  base64: z.string().optional(),
  cut: z.boolean().optional(),
  runId: z.string().max(200),
  at: ts.optional(),
});
export type DocumentView = z.infer<typeof DocumentView>;
/** What of a document goes to the phone, at most (a call's answer fits one frame). */
export const DOCUMENT_TO_PHONE = 640 * 1024;
/** 1.25: a storage object's link, signed on the Mac for `expiresIn` seconds. */
export const SignedLinkView = z.object({ url: z.string().max(4000), expiresIn: z.number().int().min(1) });

/** 1.22: one dashboard: its tiles in order, what it compares with, a Refresh going ("Fetching… 2 of 3"), and every dashboard (its tabs). */
export const DashboardView = z.object({
  id,
  name: z.string().max(100),
  compare: CompareKind,
  tiles: z.array(DashboardTileView).max(60),
  refreshing: z.object({ done: z.number().int().min(0), total: z.number().int().min(0), sentinel: z.string().max(100).optional() }).optional(),
  dashboards: z.array(DashboardRef).max(30),
});
export type DashboardView = z.infer<typeof DashboardView>;

/**
 * 1.26 (BLG-361): a board tile as a Home-screen widget draws it, in words (src/core/sentinel/
 * widgets.ts `widgetSnapshot`, the same the Mac's desktop widgets read): a number (its value, its
 * change, its points), a chart (its points with the first and last labels) or text. `dashboard`
 * and `tile` name it on its board (the widget opens there). Never a source, a query or a key.
 */
export const WidgetTileView = z.object({
  /** "<dashboardId>/<tileId>". */
  id: z.string().min(1).max(401),
  dashboard: id,
  tile: id,
  board: z.string().max(100),
  title: z.string().max(100),
  kind: z.union([z.enum(['number', 'chart', 'text']), z.string().max(20)]),
  value: z.string().max(60).optional(),
  change: z.string().max(60).optional(),
  tone: NumberTone,
  vs: z.string().max(60).optional(),
  points: z.array(z.number()).max(40).optional(),
  from: z.string().max(80).optional(),
  to: z.string().max(80).optional(),
  text: z.string().max(1000).optional(),
  /** "paused", "draft: turn it on", "gone", "waiting for its first run". */
  note: z.string().max(60).optional(),
  project: z.string().max(100).optional(),
  /** The project's icon, as its checksum (`companion.icon`). */
  icon: z.string().regex(/^[0-9a-f]{16,64}$/).optional(),
  /** Its project's tint, #rrggbb. */
  tint: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  at: ts.optional(),
});
export type WidgetTileView = z.infer<typeof WidgetTileView>;
export const WidgetsView = z.object({ tiles: z.array(WidgetTileView).max(120) });
export type WidgetsView = z.infer<typeof WidgetsView>;



export const ChatMessageView = z.object({
  id,
  from: z.string().max(100),
  mine: z.boolean(),
  claude: z.boolean().optional(),
  /** BLG-434: with `claude`, which agent answered (an older Mac leaves it out: Claude). */
  agent: AgentRefView.optional(),
  text,
  ts,
  /** BLG-425: when its author last changed its text (a Mac before it never says). */
  /** The external agent that wrote it for its author (a Mac before it never says). */
  sentBy: z.string().max(80).optional(),
  edited: ts.optional(),
  /** 1.30 (BLG-429): your own direct message whose words reach the phone whole: it can be edited here. */
  editable: z.boolean().optional(),
  files: z.array(OutputView).max(20).optional(),
  /** 1.41 (BLG-702): the emoji reactions under it, in the order they were first put there. */
  reactions: z.array(ChatReactionView).max(20).optional(),
  /** 1.48 (BLG-798): your own direct message: it reached them (your Always On has theirs the same way), or it was on their screen. */
  delivery: z.enum(['delivered', 'seen']).optional(),
  /** A friend's Claude answering you can't touch their Mac from the chat: what it offers to do there as a request (gateway.ask `to`). */
  offer: z.object({ to: id, ask: z.string().max(500), needs: z.array(z.enum(['project', 'shell', 'files', 'screen', 'device'])).max(5).optional() }).optional(),
  /**
   * A task between two people's Claudes (BLG-208), drawn as a small card: who asks whom, where it is
   * ("Waiting for bob to approve"), its tone, the result's summary and the files it brought.
   */
  task: z
    .object({
      id,
      title: z.string().max(200),
      ask: z.string().max(300),
      state: z.string().max(80),
      tone: z.union([z.enum(['claude', 'ok', 'warn', 'error', 'muted']), z.string().max(20)]),
      summary: z.string().max(600).optional(),
      files: z.array(z.string().max(200)).max(8).optional(),
      /** 1.20: whose it is, as the chat heads it ("mia’s Claude · asked your Mac"). */
      who: z.string().max(200).optional(),
      /** 1.20: a secret, approved on its own each time (the card is tinted). */
      secret: z.boolean().optional(),
    })
    .optional(),
});
export type ChatMessageView = z.infer<typeof ChatMessageView>;
export const ChatsView = z.object({
  chats: z.array(z.object({ topic: Topic, name: z.string().max(100), kind: z.enum(['dm', 'group']), last: z.string().max(300).optional(), lastAt: ts.optional(), unread: z.number().int().min(0) })).max(600),
});
export type ChatsView = z.infer<typeof ChatsView>;
/** Someone in a chat (you too, `me`): whose Claude a message can ask (companion.post `ask`). Since 1.2. */
export const ChatMemberView = z.object({
  peerId: id,
  name: z.string().max(64),
  me: z.boolean().optional(),
  /** 1.20 (BLG-210): online, away, dnd or offline. */
  presence: z.union([z.enum(['online', 'away', 'dnd', 'offline']), z.string().max(20)]).optional(),
  /** 1.20: what their Claude is doing, in the header's words ("working", "idle", "offline · 1.1", "needs an update"). */
  claude: z.string().max(80).optional(),
});
export type ChatMemberView = z.infer<typeof ChatMemberView>;
export const ChatView = z.object({
  topic: Topic,
  name: z.string().max(100),
  kind: z.enum(['dm', 'group']),
  messages: z.array(ChatMessageView).max(200),
  more: z.boolean(),
  live: z.array(z.string().max(100)).max(20),
  /** Who's in it, you first (1.2; older Macs leave it out). */
  members: z.array(ChatMemberView).max(200).optional(),
  /** 1.20 (BLG-210): what waits here: on you ("Waiting on you: …"), or on someone else; `task`: its card. */
  waiting: z.array(z.object({ text: z.string().max(300), you: z.boolean(), task: id.optional() })).max(10).optional(),
  /** 1.20: who won't get a message now ("Mia is offline: this waits for them"). */
  note: z.string().max(200).optional(),
  /** 1.38 (BLG-574): their messages you haven't read yet, the last ones (until you open it: then 0). */
  unread: z.number().int().min(0).optional(),
  /** 1.41 (BLG-702): your quick reactions, the ones you use most first (then 👍 ❤️ 😂 🎉 👀 ✅). */
  quick: z.array(z.string().min(1).max(32)).max(8).optional(),
});
export type ChatView = z.infer<typeof ChatView>;

export const PeopleView = z.object({
  people: z
    .array(
      z.object({
        peerId: id,
        name: z.string().max(64),
        presence: z.enum(['online', 'away', 'dnd', 'offline']),
        note: z.string().max(200).optional(),
        /** The emoji of their status ("🌮"), shown by their name; an older Mac leaves it out. */
        emoji: z.string().max(32).optional(),
        usage: UsageView.optional(),
        /** What their Beluga lets your Claude do (their card): "screen", "commands"… */
        offers: z.array(z.string().max(40)).max(20),
        chat: Topic.optional(),
        /** Their Beluga's version ("1.2.0"), when their Mac says it. */
        beluga: z.string().max(40).optional(),
        /** Your Macs can't link until one of you updates Beluga: who. */
        update: z.enum(['them', 'you']).optional(),
      }),
    )
    .max(600),
});
export type PeopleView = z.infer<typeof PeopleView>;

// ---- a worktree's files and terminals (1.7, BLG-42)

/**
 * One entry of a worktree's folder (companion.files.list). `ref`: a picture, openable in the
 * image viewer as an output. Secrets (`isSecretPath`), `.git` and links that lead out of the
 * worktree are never listed.
 */
export const FileEntryView = z.object({
  name: z.string().max(256),
  dir: z.boolean(),
  size: z.number().int().min(0).optional(),
  ref: OutputView.shape.ref.optional(),
});
export type FileEntryView = z.infer<typeof FileEntryView>;
/** A folder of a worktree: its path inside it ('' is the top), folders first. */
export const FolderView = z.object({ path: z.string().max(4096), entries: z.array(FileEntryView).max(5000), more: z.boolean().optional() });
export type FolderView = z.infer<typeof FolderView>;
/** Files and folders whose names match (companion.files.find), by their paths inside the worktree. */
export const FoundView = z.object({ hits: z.array(z.object({ path: z.string().max(4096), dir: z.boolean() })).max(200), more: z.boolean().optional() });
export type FoundView = z.infer<typeof FoundView>;
/**
 * A page of a worktree's file, read-only (companion.files.read): `text` from byte `off` (secrets a
 * file holds are redacted), the file's `size`, `eof`, and its language for colours (`lang`, from
 * its name). `binary`: not text; nothing is sent.
 */
export const FilePageView = z.object({
  path: z.string().max(4096),
  text: z.string().max(FILE_PAGE * 2),
  off: z.number().int().min(0),
  next: z.number().int().min(0),
  size: z.number().int().min(0),
  eof: z.boolean(),
  lang: z.string().max(20).optional(),
  binary: z.boolean().optional(),
});
export type FilePageView = z.infer<typeof FilePageView>;
/** A terminal session of a worktree (companion.terminals): the same session the Mac's terminal dock shows. */
export const TerminalView = z.object({
  key: z.string().min(1).max(200),
  label: z.string().max(80),
  running: z.boolean(),
  exit: z.number().int().nullable().optional(),
  /** The session's size: the Mac's. The phone draws that grid rather than resizing it. */
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(500),
});
export type TerminalView = z.infer<typeof TerminalView>;
/** The models that write down speech (src/shared/voice-models.ts VOICE_MODEL_IDS, kept equal by a test). */
export const VoiceModelId = z.enum(['whisper-base', 'whisper-turbo', 'parakeet']);
export type VoiceModelId = z.infer<typeof VoiceModelId>;
/** 1.16: the Mac's voice models, here or coming (companion.voice). */
export const VoiceMacView = z.object({
  models: z
    .array(z.object({ model: VoiceModelId, bytes: z.number().int().min(0), ready: z.boolean(), progress: z.number().min(0).max(1).optional(), error: z.string().max(300).optional() }))
    .max(10),
});
export type VoiceMacView = z.infer<typeof VoiceMacView>;
/** 1.16: what the Mac wrote down (companion.transcribe). */
export const TranscriptView = z.object({ text: z.string().max(64_000), language: z.string().max(16).optional(), ms: z.number().int().min(0) });
export type TranscriptView = z.infer<typeof TranscriptView>;

export const TerminalsView = z.object({ terminals: z.array(TerminalView).max(40) });
export type TerminalsView = z.infer<typeof TerminalsView>;

const termKey = z.string().min(1).max(200);

// ---- your phone, used by your Mac (1.16, BLG-150; docs/companion.md, "Your phone, from your Mac")

/**
 * What the Mac may ask the phone to do (the `req` frame's `op`), through the app's Accessibility
 * service. Positions are the screen's pixels, as the phone's `screen` gives them.
 */
export const PHONE_OPS = ['screen', 'screenshot', 'tap', 'long_press', 'swipe', 'type', 'key', 'scroll', 'open', 'apps', 'info', 'install', 'mirror', 'proof'] as const;
export const PhoneOp = z.enum(PHONE_OPS);
export type PhoneOp = z.infer<typeof PhoneOp>;

/** The buttons a phone has without a finger on the screen (`key`). */
export const PHONE_KEYS = ['back', 'home', 'recents', 'notifications', 'quick_settings', 'lock', 'power_dialog', 'enter'] as const;
export const PhoneKey = z.enum(PHONE_KEYS);
export type PhoneKey = z.infer<typeof PhoneKey>;

const px = z.number().int().min(0).max(20_000);
/** A node of the last `screen` (its `gen` and the node's `i`): tapped as itself, not by where it was. */
const nodeRef = { node: z.number().int().min(0).max(5000).optional(), gen: z.number().int().min(0).optional() };

/** Each op's arguments, checked on the phone before anything happens. */
export const PHONE_ARGS = {
  screen: z.object({}),
  /** `max`: the picture's longest side (it's made smaller, never bigger); JPEG at `quality`. */
  screenshot: z.object({ max: z.number().int().min(256).max(4096).optional(), quality: z.number().int().min(30).max(95).optional() }),
  /** A node of the last screen when given (its click action), else a tap at x, y. */
  tap: z.object({ x: px, y: px, ...nodeRef }),
  long_press: z.object({ x: px, y: px, ms: z.number().int().min(300).max(5000).optional(), ...nodeRef }),
  swipe: z.object({ x1: px, y1: px, x2: px, y2: px, ms: z.number().int().min(50).max(5000).optional() }),
  /** Into a node of the last screen, or the field that has the focus; `replace` clears it first; `enter` presses the keyboard's action after. */
  type: z.object({ text: z.string().max(8000), replace: z.boolean().optional(), enter: z.boolean().optional(), ...nodeRef }),
  key: z.object({ key: PhoneKey }),
  /** Scroll a node of the last screen (or the biggest scrollable one) a page that way. */
  scroll: z.object({ dir: z.enum(['up', 'down', 'left', 'right']), ...nodeRef }),
  /** An app by its package name, or a link (https:, tel:, a deep link) in whatever app opens it. */
  open: z.object({
    package: z.string().min(1).max(200).regex(/^[A-Za-z][\w.]*$/).optional(),
    url: z.string().min(1).max(4000).optional(),
    /** 1.19: one of the phone's own settings screens, for the person to switch something on (USB debugging). */
    settings: z.enum(['developer', 'about']).optional(),
  }),
  apps: z.object({}),
  info: z.object({}),
  /** An APK the Mac offers (`out:` ref, fetched in pieces like any output), installed with the phone's own Install button. */
  install: z.object({ ref: z.string().regex(/^out:[\w-]{1,200}$/), name: z.string().min(1).max(200), size: z.number().int().min(0).max(1024 * 1024 * 1024) }),
  /**
   * 1.18: stream the screen as H.264 video (`vid` frames) or stop. `max`: the video's longest side;
   * `fps` and `kbps`: its rate. The first time, the phone asks its user (Android's "Start now").
   */
  mirror: z.object({ on: z.boolean(), max: z.number().int().min(320).max(1920).optional(), fps: z.number().int().min(5).max(60).optional(), kbps: z.number().int().min(200).max(12_000).optional() }),
  /**
   * 1.19: keep this one-time code where only adb on this phone can read it (the app's own files
   * folder); the Mac reads it back over a direct Wireless-debugging connection, so it knows the
   * device at that address is this phone. Answered with `{ path }`.
   */
  proof: z.object({ nonce: z.string().regex(/^[0-9a-f]{32,64}$/) }),
} as const satisfies Record<PhoneOp, z.ZodType>;

/** `proof`'s answer: where the code is, as adb's shell sees it. */
export const ProofView = z.object({ path: z.string().min(1).max(400) });

/** `mirror`'s answer: streaming now, asking the phone's user first, or stopped. */
export const MirrorView = z.object({ state: z.enum(['streaming', 'asking', 'off']) });
export type MirrorView = z.infer<typeof MirrorView>;

/** The biggest piece of video one `vid` frame carries (a key frame with its SPS/PPS). */
export const VID_MAX = 600 * 1024;

/**
 * One thing on the phone's screen (`screen`): its class, short ("Button", "EditText"), what it
 * says (`t`; a password field never says it), its hint (`h`), description (`s`), resource id
 * (`r`), where it is in screen pixels (`b`: left, top, right, bottom) and what it can do (`f`):
 * c clickable, l long-clickable, e editable, s scrollable, k checkable, K checked, F focused,
 * x selected, d disabled, p password.
 */
export const ScreenNode = z.object({
  i: z.number().int().min(0),
  d: z.number().int().min(0).max(100),
  c: z.string().max(60),
  t: z.string().max(2000).optional(),
  h: z.string().max(400).optional(),
  s: z.string().max(2000).optional(),
  r: z.string().max(200).optional(),
  b: z.tuple([z.number().int(), z.number().int(), z.number().int(), z.number().int()]),
  f: z.string().max(16).optional(),
});
export type ScreenNode = z.infer<typeof ScreenNode>;

/** What's on the phone's screen now, from the Accessibility service: the app in front and its nodes, in order. */
export const ScreenView = z.object({
  gen: z.number().int().min(0),
  app: z.string().max(200),
  w: z.number().int().min(1),
  h: z.number().int().min(1),
  nodes: z.array(ScreenNode).max(1500),
  /** The keyboard is up. */
  keyboard: z.boolean().optional(),
  /** Other windows on top (a dialog, the notification shade), by their app. */
  windows: z.array(z.object({ app: z.string().max(200), title: z.string().max(200).optional(), type: z.string().max(40) })).max(20).optional(),
});
export type ScreenView = z.infer<typeof ScreenView>;

/** A screenshot (`screenshot`): the picture (`iw` × `ih`) of a screen of `w` × `h` pixels. */
export const ShotView = z.object({ mime: z.enum(['image/jpeg', 'image/png']), b64: z.string().max(MAX_COMPANION_FRAME), w: z.number().int().min(1), h: z.number().int().min(1), iw: z.number().int().min(1), ih: z.number().int().min(1) });
export type ShotView = z.infer<typeof ShotView>;

/** The phone in a few facts (`info`). */
export const PhoneInfoView = z.object({
  model: z.string().max(100),
  manufacturer: z.string().max(100),
  android: z.string().max(40),
  sdk: z.number().int(),
  w: z.number().int(),
  h: z.number().int(),
  battery: z.object({ pct: z.number().min(0).max(100), charging: z.boolean() }).optional(),
  network: z.enum(['wifi', 'cellular', 'ethernet', 'other', 'none']).optional(),
  locked: z.boolean().optional(),
  screenOn: z.boolean().optional(),
  app: z.string().max(200).optional(),
});
export type PhoneInfoView = z.infer<typeof PhoneInfoView>;

export const AppsView = z.object({ apps: z.array(z.object({ pkg: z.string().max(200), label: z.string().max(200) })).max(1000) });

/**
 * What the phone lets its Mac do, and how the Mac can reach it (the `control` frame: after hello
 * and whenever it changes). `allowed`: its own switch, Settings › Let your Mac use this phone.
 * `adb`: Android's Wireless debugging, the port it listens on (mDNS) and, while Pair with code is
 * open, the pairing port. `wifi`: its address on Wi-Fi, for the Mac's adb on the same network.
 */
export const PhoneControl = z.object({
  allowed: z.boolean(),
  accessibility: z.boolean(),
  /** Screenshots without adb (the Accessibility service on Android 11 and later). */
  screenshots: z.boolean(),
  /** It may ask to install apps (Install unknown apps is on for Beluga). */
  installs: z.boolean().optional(),
  /** 1.18: it can stream its screen as video (`mirror`). */
  video: z.boolean().optional(),
  adb: z.object({ on: z.boolean(), port: z.number().int().min(1).max(65_535).optional(), pairing: z.number().int().min(1).max(65_535).optional() }),
  wifi: z.object({ ip: z.string().max(45) }).optional(),
  device: z.object({ model: z.string().max(100), manufacturer: z.string().max(100), android: z.string().max(40), sdk: z.number().int(), w: z.number().int().min(1), h: z.number().int().min(1) }),
});
export type PhoneControl = z.infer<typeof PhoneControl>;

/** A tunnel's piece of bytes (`tun_data`), and how much may be in flight before the sender waits for `tun_ack`. */
export const TUN_PIECE = 48 * 1024;
export const TUN_WINDOW = 512 * 1024;
const tunId = z.number().int().min(1).max(2 ** 31);
const tunB64 = z.string().max(Math.ceil(TUN_PIECE / 3) * 4 + 4);

// ---- paths (docs/companion.md, "Any network")

/**
 * How a link reached the Mac: `lan` (directly, on the same network), `direct` (directly over the
 * internet: hyperdht's hole-punch), or `relay` (through the Mac's Cloudflare tunnel, with the same
 * Noise handshake inside, so the relay sees only ciphertext).
 */
export const LinkPath = z.enum(['lan', 'direct', 'relay']);
export type LinkPath = z.infer<typeof LinkPath>;

/** One way the phone tried (`p2p`: hyperdht, LAN first then hole-punching; `relay`: the tunnel). */
export const DialAttempt = z.object({
  way: z.enum(['p2p', 'relay']),
  outcome: z.enum(['ok', 'timeout', 'refused', 'unreachable', 'not-found', 'failed', 'skipped', 'lost']),
  /** `lost`: still trying when another way connected (it was dropped). `code`: hyperdht's error code (HOLEPUNCH_ABORTED, PEER_NOT_FOUND…), or the relay's close code. */
  code: z.string().max(60).optional(),
  ms: z.number().int().min(0).optional(),
});
export type DialAttempt = z.infer<typeof DialAttempt>;

/** A relay URL: wss:// (the tunnel), or ws:// (a local relay in tests). */
export const RelayUrl = z.string().max(300).regex(/^wss?:\/\/[\w.:-]+(\/[\w./-]*)?$/);
/** Where a key's relay is: the URL path ends with the key it reaches (hex). */
export const relayUrlFor = (base: string, keyHex: string): string => `${base.replace(/\/+$/, '')}/${keyHex}`;

/**
 * What the Mac publishes on the DHT under its companion key (and each open pairing's key), signed
 * with that key (hyperdht mutablePut): its current relay. The DHT lookup works on networks where
 * peer connections don't, so a phone finds the relay there.
 */
// `phones` (BLG-126, under the companion key only): the first 16 hex of each paired phone's link key, so
// a phone the Mac no longer knows hears it (and is told to pair again) instead of "Mac offline" forever.
export const RelayRecord = z.object({ v: z.literal(1), relay: RelayUrl.optional(), at: ts, phones: z.array(z.string().regex(/^[0-9a-f]{16}$/)).max(8).optional() });
export type RelayRecord = z.infer<typeof RelayRecord>;

/**
 * 1.49 (BLG-809): one of your computers as your Mac tells its phones: who it is, how it looks, and
 * where to dial it (its companion address and relays). Nothing secret: keys are public, and a
 * computer lets the phone in only because your identity signed the phone's certificate.
 */
export const PhoneComputer = z.object({
  id: z.string().regex(/^[0-9a-f]{16}$/),
  name: z.string().min(1).max(64),
  /** Its icon as kept on it (`auto` or none: its kind's own). */
  icon: z.string().max(200).optional(),
  /** What it is and, on Linux, which one (src/machines/kind.ts): its mark, as the Mac draws it. Plain strings, so a newer kind reaches an older phone as unknown. */
  kind: z.string().max(32).optional(),
  distro: z.string().max(32).optional(),
  platform: z.enum(['android', 'ios', 'macos', 'linux', 'windows']),
  address: z.string().regex(/^[0-9a-f]{64}$/),
  relays: z.array(RelayUrl).max(4),
  /** When your Mac last heard from it. */
  lastSeen: ts.optional(),
  /** It's your Always On (BLG-796). */
  alwaysOn: z.boolean().optional(),
  /** As the Mac's Runs on menu says it (src/machines/words.ts): what it has free, and why it can't take new work now. */
  line: z.string().max(200).optional(),
  why: z.string().max(200).optional(),
});
export type PhoneComputer = z.infer<typeof PhoneComputer>;
/** Computers one Mac tells a phone about (a device set holds at most MAX_SET_DEVICES). */
export const MAX_PHONE_COMPUTERS = 32;

// ---- frames

export const PhoneFrame = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    v: z.object({ major: z.number().int(), minor: z.number().int() }),
    app: z.string().max(40),
    platform: z.enum(['android', 'ios']),
    topics: z.array(Topic).max(16),
    /** How this link got here, and what was tried first (the Mac's Settings › Phone says it in words). */
    via: z.object({ path: LinkPath, tried: z.array(DialAttempt).max(8) }).optional(),
  }),
  z.object({ t: z.literal('sub'), topics: z.array(Topic).max(16) }),
  z.object({ t: z.literal('call'), id: z.number().int().min(0), method: z.string().max(80), args: z.array(z.unknown()).max(16) }),
  z.object({ t: z.literal('get'), id: z.number().int().min(0), ref: OutputView.shape.ref, variant: z.enum(['thumb', 'full', 'text']), off: z.number().int().min(0) }),
  /**
   * A piece of a file for the Mac (a photo to attach): pieces of at most COMPANION_PIECE bytes, in
   * order from 0, the last with `eof`. Each is answered with `result {id}`; the last one's value is
   * `{ ref }` (an `up:` ref for companion.ask / companion.post). At most MAX_UPLOAD_BYTES a file.
   */
  z.object({ t: z.literal('put'), id: z.number().int().min(0), name: z.string().min(1).max(200), mime: z.string().max(100), size: z.number().int().min(0).max(MAX_UPLOAD_BYTES), off: z.number().int().min(0), b64: z.string().max(Math.ceil(COMPANION_PIECE / 3) * 4 + 4), eof: z.boolean() }),
  z.object({ t: z.literal('push'), platform: z.enum(['fcm', 'apns']), token: z.string().max(4096), relayKey: z.string().max(200) }),
  /** The app went to the background (the link closes after the grace) or came back. */
  z.object({ t: z.literal('focus'), on: z.boolean() }),
  /**
   * 1.7: a terminal on the phone's screen (a key companion.terminals or termOpen gave). The Mac
   * sends what it wrote lately, then its output as it comes (coalesced, TERM_COALESCE_MS), until
   * `term_detach` or the link closes. `term_input`: keys typed on the phone, written to the very
   * session the Mac shows.
   */
  z.object({ t: z.literal('term_attach'), term: termKey }),
  z.object({ t: z.literal('term_detach'), term: termKey }),
  z.object({ t: z.literal('term_input'), term: termKey, data: z.string().min(1).max(64_000) }),
  /** 1.16: what this phone lets its Mac do now (only to a Mac with SINCE.control). */
  z.object({ t: z.literal('control'), state: PhoneControl }),
  /** 1.16: the answer to the Mac's `req` (its value is the op's view: ScreenView, ShotView…). */
  z.object({ t: z.literal('reply'), id: z.number().int().min(0), ok: z.boolean(), value: z.unknown().optional(), error: z.string().max(2000).optional() }),
  /** 1.16: the six digits Wireless debugging's Pair with code shows, typed into Beluga's notification: the Mac's adb pairs with them. */
  z.object({ t: z.literal('adb_code'), code: z.string().regex(/^\d{6}$/) }),
  /** 1.16: a tunnel the Mac opened is connected to the phone's own port (`tun_ok`), its bytes, how much was taken, and its end. */
  z.object({ t: z.literal('tun_ok'), id: tunId }),
  z.object({ t: z.literal('tun_data'), id: tunId, b64: tunB64 }),
  z.object({ t: z.literal('tun_ack'), id: tunId, n: z.number().int().min(1).max(TUN_WINDOW) }),
  z.object({ t: z.literal('tun_close'), id: tunId, error: z.string().max(300).optional() }),
  /**
   * 1.18: a piece of the screen's video (after `mirror {on: true}`): H.264 Annex B, a key frame
   * carrying its SPS/PPS first; `ts` its time (µs); `w`×`h` the video, `sw`×`sh` the screen it
   * shows (taps map to those). The Mac answers each with `vid_ack`; a phone with too many
   * unanswered skips to the next key frame instead of falling behind.
   */
  z.object({ t: z.literal('vid'), seq: z.number().int().min(0), b64: z.string().max(Math.ceil(VID_MAX / 3) * 4 + 4), key: z.boolean().optional(), ts: z.number().int().min(0), w: z.number().int().min(1).max(8192), h: z.number().int().min(1).max(8192), sw: z.number().int().min(1).max(20_000), sh: z.number().int().min(1).max(20_000) }),
  /** 1.18: the video stopped (the user said no, pressed Stop, or Android ended it). */
  z.object({ t: z.literal('vid_end'), reason: z.string().max(300).optional() }),
  z.object({ t: z.literal('bye') }),
]);
export type PhoneFrame = z.infer<typeof PhoneFrame>;

export const MacFrame = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('welcome'),
    v: z.object({ major: z.number().int(), minor: z.number().int() }),
    /** The oldest phone protocol this Mac still answers. */
    min: z.object({ major: z.number().int(), minor: z.number().int() }),
    mac: z.object({ name: z.string().max(100), version: z.string().max(40) }),
    me: z.object({ name: z.string().max(64), peerId: id }),
    /** The Mac's relay now (the phone keeps it for next time). */
    relay: RelayUrl.optional(),
  }),
  z.object({ t: z.literal('view'), topic: Topic, rev: z.number().int().min(0), data: z.unknown() }),
  z.object({ t: z.literal('result'), id: z.number().int().min(0), ok: z.boolean(), value: z.unknown().optional(), error: z.string().max(2000).optional() }),
  z.object({ t: z.literal('chunk'), id: z.number().int().min(0), off: z.number().int().min(0), b64: z.string().max(Math.ceil(COMPANION_PIECE / 3) * 4 + 4), eof: z.boolean(), size: z.number().int().min(0), mime: z.string().max(100) }),
  z.object({ t: z.literal('nudge'), kind: z.enum(['needsYou', 'done', 'mentions']), title: z.string().max(200), body: z.string().max(1000), topic: Topic.optional() }),
  /** 1.7: a terminal's output (raw, as the program wrote it). `reset`: what follows is the whole screen again (clear first). */
  z.object({ t: z.literal('term_data'), term: termKey, data: z.string().max(TERM_PIECE), reset: z.boolean().optional() }),
  /** 1.7: whether it runs, how it ended, and its size (the Mac's: when the Mac resizes it, this comes again). */
  z.object({ t: z.literal('term_status'), term: termKey, running: z.boolean(), exit: z.number().int().nullable().optional(), cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(500), gone: z.boolean().optional() }),
  /** 1.16: do something on the phone (only to a phone that sent `control` with `allowed`); answered by `reply`. `args`: PHONE_ARGS[op]. */
  z.object({ t: z.literal('req'), id: z.number().int().min(0), op: PhoneOp, args: z.record(z.string(), z.unknown()) }),
  /** 1.16: a tunnel to the phone's Wireless debugging port (`adb`) or its pairing port (`adb-pair`), then its bytes both ways. */
  z.object({ t: z.literal('tun_open'), id: tunId, to: z.enum(['adb', 'adb-pair']) }),
  z.object({ t: z.literal('tun_data'), id: tunId, b64: tunB64 }),
  z.object({ t: z.literal('tun_ack'), id: tunId, n: z.number().int().min(1).max(TUN_WINDOW) }),
  z.object({ t: z.literal('tun_close'), id: tunId, error: z.string().max(300).optional() }),
  /** 1.18: the Mac took the screen video's piece `seq` (the phone paces itself by these). */
  z.object({ t: z.literal('vid_ack'), seq: z.number().int().min(0) }),
  /** 1.46: your computers and where to dial each (only to a phone with SINCE.computers): the whole list, each time it changes. */
  z.object({ t: z.literal('computers'), list: z.array(PhoneComputer).max(MAX_PHONE_COMPUTERS) }),
  z.object({ t: z.literal('bye'), reason: z.string().max(200) }),
]);
export type MacFrame = z.infer<typeof MacFrame>;

/** Which view type a topic carries. */
export function viewSchema(topic: Topic): z.ZodType {
  if (topic === 'home') return HomeView;
  if (topic === 'work') return WorkView;
  if (topic === 'plans') return PlansView;
  if (topic === 'chats') return ChatsView;
  if (topic === 'people') return PeopleView;
  if (topic.startsWith('conv:')) return ConvView;
  if (topic.startsWith('plan:')) return PlanView;
  if (topic === 'tasks') return TasksView;
  if (topic.startsWith('task:')) return TaskPageView;
  if (topic === 'sentinels') return SentinelsView;
  if (topic.startsWith('sentinel:')) return SentinelPageView;
  if (topic.startsWith('dashboard:')) return DashboardView;
  if (topic === 'widgets') return WidgetsView;
  return ChatView;
}

/** Can this side talk to that one: same major, or the other side still answers ours. */
export const compatible = (mine: { major: number }, theirs: { major: number }, theirMin: { major: number }): boolean => mine.major === theirs.major || (mine.major < theirs.major && mine.major >= theirMin.major);

const parse = <T>(schema: z.ZodType<T>, raw: string): T | undefined => {
  try {
    const r = schema.safeParse(JSON.parse(raw));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
};
export const parsePhoneFrame = (raw: string): PhoneFrame | undefined => parse(PhoneFrame, raw);
export const parseMacFrame = (raw: string): MacFrame | undefined => parse(MacFrame, raw);

// ---- pairing (docs/companion.md, "Signing in")

/** What the pairing QR holds: `beluga://device#<22 chars>`; a code is typed as for friends. */
/** `?r=` (additive): the Mac's relay, URL-encoded, so pairing works where the DHT doesn't. */
export const DEVICE_LINK = /^(?:beluga|klaud):\/\/device#([\w-]{22})(?:\?r=([\w%.-]+))?$/;

/**
 * What a device of yours is (BLG-774): a phone, a Beluga app you drive from, or a computer that
 * does the work. A certificate without one is a phone's (every one signed before roles).
 */
export const DEVICE_ROLES = ['phone', 'app', 'computer'] as const;
export type DeviceRole = (typeof DEVICE_ROLES)[number];
/** Phones are android or ios; apps and computers are macos, linux or windows. */
export const DEVICE_PLATFORMS = ['android', 'ios', 'macos', 'linux', 'windows'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

export const DeviceCert = z.object({
  v: z.literal(1),
  /** Your peer id and identity key (base64 SPKI). */
  owner: id,
  ownerKey: z.string().max(200),
  /** The device's own Ed25519 key (hex), its Noise link key (hex) and box key (hex X25519). */
  device: hex64,
  link: hex64,
  box: hex64,
  name: z.string().min(1).max(64),
  platform: z.enum(DEVICE_PLATFORMS),
  /** Additive (BLG-774): left out on a phone's, so the certificates phones hold still verify. */
  role: z.enum(DEVICE_ROLES).optional(),
  issuedAt: ts,
  /** Your identity's signature over the canonical JSON of the rest ('beluga-device-v1'). */
  sig: z.string().max(200),
});
export type DeviceCert = z.infer<typeof DeviceCert>;

/**
 * A device let go (BLG-774): its key, when, and who said so: your identity (`by` 'identity') or a
 * device of yours (`by` its device key), signed. A certificate issued at or before `at` is refused
 * everywhere; pairing it again later issues a newer one.
 */
export const Forget = z.object({ device: hex64, at: ts, by: z.union([z.literal('identity'), hex64]), sig: z.string().max(200) });
export type Forget = z.infer<typeof Forget>;
/** Devices one identity may have in its set (phones are still MAX_DEVICES of them). */
export const MAX_SET_DEVICES = 64;
export const MAX_FORGOTTEN = 1024;

/**
 * Your device set (BLG-774): every certificate your identity signed that still holds, and who was
 * forgotten, signed as a whole by your identity. `seq` only grows: a computer keeps the newest.
 */
export const DeviceRoster = z.object({
  v: z.literal(1),
  owner: id,
  ownerKey: z.string().max(200),
  seq: z.number().int().min(1),
  issuedAt: ts,
  devices: z.array(DeviceCert).max(MAX_SET_DEVICES),
  forgotten: z.array(Forget).max(MAX_FORGOTTEN),
  sig: z.string().max(200),
});
export type DeviceRoster = z.infer<typeof DeviceRoster>;

/**
 * Joining a computer (BLG-774, `beluga pair --computer` on it; the app dials with the link or code).
 * `mac` is the sender's proof that it holds the pairing's secret, as for phones (roles 'app' and
 * 'computer'). The computer proves it holds the keys it names by signing the handshake with each.
 *   app      → mp_hello {proto, app cert, name}
 *   computer → mp_keys {device, link, box, name, platform, address, relay?, sigs}   both show the fingerprint
 *   (you click Join on the app)
 *   app      → mp_ok {cert (role computer), roster}
 *   computer → mp_done                                                              or mp_refused either way
 */
export const MachinePair = z.discriminatedUnion('t', [
  /** `address` and `relay`: where the computer reaches the app back (to tell it what it forgot). */
  z.object({ t: z.literal('mp_hello'), proto: z.number().int(), mac: z.string().max(100), app: DeviceCert, name: z.string().min(1).max(64), address: hex64.optional(), relay: RelayUrl.optional() }),
  z.object({
    t: z.literal('mp_keys'),
    proto: z.number().int(),
    mac: z.string().max(100),
    device: hex64,
    link: hex64,
    box: hex64,
    name: z.string().min(1).max(64),
    platform: z.enum(['macos', 'linux', 'windows']),
    version: z.string().max(40),
    /** Where the app dials it from now on (its companion address), and its relay. */
    address: hex64,
    relay: RelayUrl.optional(),
    /** The handshake hash signed with its device key and with its link key. */
    deviceSig: z.string().max(200),
    linkSig: z.string().max(200),
  }),
  z.object({ t: z.literal('mp_ok'), mac: z.string().max(100), cert: DeviceCert, roster: DeviceRoster }),
  z.object({ t: z.literal('mp_done') }),
  z.object({ t: z.literal('mp_refused'), reason: z.string().max(200), why: z.enum(['expired', 'cancelled', 'unverified', 'tries', 'busy', 'owned', 'version', 'declined']).optional() }),
]);
export type MachinePair = z.infer<typeof MachinePair>;
export const parseMachinePair = (raw: string): MachinePair | undefined => parse(MachinePair, raw);

/** What devices of yours tell each other to stay one set (BLG-774; carried by the links of BLG-775). */
export const DeviceSetSync = z.object({ t: z.literal('devset'), roster: DeviceRoster.optional(), forgotten: z.array(Forget).max(MAX_FORGOTTEN) });
export type DeviceSetSync = z.infer<typeof DeviceSetSync>;

/**
 * The pairing's messages. `mac` on dev_hello and dev_ok is the sender's proof that it holds the
 * pairing's secret: keyed BLAKE2b over its role, the Noise handshake hash and the canonical JSON
 * of the message without `mac` (src/companion/device-crypto.ts `devProof`).
 */
export const DevicePair = z.discriminatedUnion('t', [
  z.object({ t: z.literal('dev_hello'), proto: z.number().int(), mac: z.string().max(100), device: z.string().regex(/^[0-9a-f]{64}$/), box: z.string().regex(/^[0-9a-f]{64}$/), name: z.string().min(1).max(64), platform: z.enum(['android', 'ios']), app: z.string().max(40) }),
  /** The Mac is showing "Pair this phone?" with the fingerprint; waits for your click. */
  z.object({ t: z.literal('dev_wait'), fingerprint: z.string().max(40) }),
  z.object({ t: z.literal('dev_ok'), mac: z.string().max(100), cert: DeviceCert, address: z.string().regex(/^[0-9a-f]{64}$/), macName: z.string().max(100), relay: RelayUrl.optional() }),
  /** `why` (additive) says it for the phone's explanation (diagnose.ts); `reason` is the Mac's words. */
  z.object({ t: z.literal('dev_refused'), reason: z.string().max(200), why: z.enum(['expired', 'used', 'cancelled', 'unverified', 'tries', 'busy', 'full', 'version-mac', 'version-app']).optional() }),
]);
export type DevicePair = z.infer<typeof DevicePair>;
export const parseDevicePair = (raw: string): DevicePair | undefined => parse(DevicePair, raw);

/** The paired phones, as the Mac's screens see them (never keys). */
export interface DeviceView {
  readonly id: string;
  readonly name: string;
  readonly platform: 'android' | 'ios';
  readonly app?: string;
  readonly pairedAt: number;
  readonly lastSeen?: number;
  /** Linked right now. */
  readonly linked: boolean;
  /** It can be told things while closed (Beluga Push is set up for it). */
  readonly push: boolean;
  /** How its last link came: on the same network, directly over the internet, or through the relay. */
  readonly path?: LinkPath;
  /** That in words, when it's worth saying ("couldn't connect directly on its network; it used the relay"). */
  readonly note?: string;
  /** Claude using it (BLG-150): what you allow on the Mac, what the phone allows, and how it's reached now (the host fills this in; an older slice won't have it). */
  readonly control?: PhoneControlView;
}

/**
 * How freely your Claude uses a phone (Settings › Phone, per phone): `off`; `ask` before each
 * action (looking at it never asks); `use`: taps, typing, opening apps and installs without asking,
 * its shell asks; `full`: its shell too.
 */
export const PHONE_USE = ['off', 'ask', 'use', 'full'] as const;
export type PhoneUse = (typeof PHONE_USE)[number];

/** How the Mac reaches a phone for Claude now, best first (src/companion/phone-control.ts). */
export type PhoneRoute = 'usb' | 'wifi' | 'link' | 'accessibility';

/** A phone's control, for the Mac's screens. */
export interface PhoneControlView {
  readonly use: PhoneUse;
  /** The phone said (its own switch is on), and when it last told; undefined: an older app, or not heard yet. */
  readonly allowed?: boolean;
  readonly accessibility?: boolean;
  readonly screenshots?: boolean;
  /**
   * Wireless debugging: `off` on the phone, `unpaired` (on, but this Mac's adb isn't paired with
   * it: type the pairing code), `ready` (it can connect), `connected` (adb is on it now).
   */
  readonly adb?: 'off' | 'unpaired' | 'ready' | 'connected';
  /** adb sees it on USB. */
  readonly usb?: boolean;
  /** The ways Claude reaches it now, best first (empty: none). */
  readonly routes: readonly PhoneRoute[];
  /** adb's name for it while connected ("R5CX…", "192.168.1.20:41235", "127.0.0.1:50123"). */
  readonly serial?: string;
  /** The phone's model, as it said. */
  readonly model?: string;
  /** Claude is acting on it now (its last tap, swipe or key was moments ago): the Mac's Phone tab shows a dot. */
  readonly busy?: boolean;
  /** Wireless debugging on this Wi‑Fi: reached straight (the phone proved itself), or the network keeps devices apart (through Beluga instead). */
  readonly wifiPath?: 'direct' | 'blocked';
  /** What's wrong or what's next, in words, when there's something to say. */
  readonly note?: string;
}

/** adb on this Mac (Settings › Phone): where it is, or that it isn't, and a download under way. */
export interface AdbView {
  readonly path?: string;
  readonly version?: string;
  readonly fetching?: boolean;
  readonly error?: string;
  /** A phone on this Mac's USB cable, and how far adb gets with it (BLG-190). */
  readonly cable?: CableView;
}

/**
 * A phone on the cable: `no-debugging` (macOS sees it, adb doesn't: USB debugging is off),
 * `unauthorized` (the phone hasn't allowed this Mac yet: "Allow USB debugging?"), or `ready`.
 * `canPair`: ready, with Beluga on it, but not paired with this Mac (it can pair over the cable).
 */
export interface CableView {
  readonly state: 'no-debugging' | 'unauthorized' | 'ready';
  readonly name: string;
  readonly canPair?: boolean;
}

export interface CompanionSlice {
  /** `relay`: how phones on other networks reach this Mac now (reach.ts), for Settings › Phone (BLG-126). */
  readonly companion: { readonly devices: readonly DeviceView[]; readonly relay?: 'ready' | 'starting' | 'off'; readonly pairing?: { readonly link: string; readonly code: string; readonly expiresAt: number; readonly waiting?: { readonly name: string; readonly fingerprint: string } }; readonly adb?: AdbView };
}
