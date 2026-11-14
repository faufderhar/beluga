import { z } from 'zod';
import { API, type Method } from '../ipc/api.js';
import { ChatMessageView, DataListView, DocumentView, FilePageView, FolderView, FoundView, MergeCheckView, MergeView, SignedLinkView, SubAgentDetailView, TerminalView, TerminalsView, TranscriptView, TurnView, VoiceMacView } from './protocol.js';

/**
 * Every call the phone may make, typed: each `phone` method of coverage.ts with its arguments
 * (the very zod tuple the daemon checks, from src/ipc/api.ts) and what comes back. The app
 * imports this instead of keeping its own list; tests/companion-coverage.test.ts checks the keys
 * are exactly the `phone` methods. Results the phone only shows as done-or-failed are `unknown`.
 * Browser-safe: zod and the API list only (as the Mac app's web view loads them).
 */

const entry = <M extends Method, R extends z.ZodType>(method: M, result: R) => ({ args: API[method].args as (typeof API)[M]['args'], result });
const done = z.unknown();

export const AskResult = z.object({ topic: z.string() });
export const AskPersonResult = z.object({ topic: z.string(), task: z.string() });
export const OlderResult = z.union([z.object({ turns: z.array(TurnView), more: z.boolean() }), z.object({ messages: z.array(ChatMessageView), more: z.boolean() })]);
/** What a chat's address is now (src/core/chat-links/resolve.ts); null for a malformed ref, or from a Mac of 3.3.0 or older with chat links off. Where it opens stays the Mac's: the phone opens /conv/<channel>. */
export const ChatResolveResult = z.object({ title: z.string().optional(), kind: z.string(), state: z.enum(['idle', 'working', 'archived', 'removed', 'loading']), ownership: z.enum(['own', 'shared', 'unknown']) }).passthrough().nullable();
export type ChatResolveResult = z.infer<typeof ChatResolveResult>;
/** Open on your Mac: it came to the front, or why not. */
export const OpenOnMacResult = z.object({ opened: z.boolean(), why: z.string().optional() });
/** A project's small icon (PNG, or a small SVG), by checksum. */
export const IconResult = z.object({ sum: z.string(), mime: z.string(), b64: z.string() });
/** Your Claude's draft of a task described in words (companion.draftTask), before it's added. */
const OneDraft = z.object({ title: z.string(), goal: z.string(), acceptance: z.array(z.string()), labels: z.array(z.string()), priority: z.enum(['urgent', 'high', 'medium', 'low']).optional(), for: z.string().optional() });
/** 1.24 (BLG-322): who each is for (`for`), the tasks after the first (`more`), and whether the first is their epic. */
export const TaskDraftResult = OneDraft.extend({ more: z.array(OneDraft).optional(), epic: z.boolean().optional() });
export type TaskDraftResult = z.infer<typeof TaskDraftResult>;
/** What `put` answers: a piece taken, then the file's ref. */
/** A sentinel's run as the phone reads it (src/core/sentinel/model.ts RunSummary; more fields pass through). */
export const SentinelRunResult = z.object({ id: z.string(), sentinelId: z.string(), state: z.string(), startedAt: z.number(), headline: z.string() }).passthrough();
export const PutResult =z.union([z.object({ received: z.number().int().min(0) }), z.object({ ref: z.string() })]);

export const PhoneCalls = {
  'session.submit': entry('session.submit', done),
  // 1.41 (BLG-702): an emoji reaction in a worktree's or the room's chat.
  'session.react': entry('session.react', done),
  'host.answerApproval': entry('host.answerApproval', done),
  'host.promote': entry('host.promote', done),
  'host.sendNext': entry('host.sendNext', done),
  'host.steerNow': entry('host.steerNow', done),
  'host.cancelSteer': entry('host.cancelSteer', z.object({ cancelled: z.boolean(), prompt: z.string() }).partial().passthrough().optional()),
  // 1.28 (BLG-387): edit a message you sent → the conversation it went on in (a fork's channel).
  'workspaces.editPrompt': entry('workspaces.editPrompt', z.string().optional()),
  // 1.32 (BLG-446): the agent picker: a model of this conversation's runtime, or another runtime's agent.
  'workbench.setModel': entry('workbench.setModel', done),
  'workbench.setAgent': entry('workbench.setAgent', z.boolean().optional()),
  // Give a conversation its terminal drives back to the chat (BLG-534).
  'agentTerm.takeOver': entry('agentTerm.takeOver', done),
  'host.stopRun': entry('host.stopRun', z.object({ stopped: z.boolean(), returned: z.array(z.string()) }).partial().passthrough().optional()),
  'threads.stop': entry('threads.stop', z.object({ stopped: z.boolean(), returned: z.array(z.string()) }).partial().passthrough().optional()),
  'threads.stopAll': entry('threads.stopAll', z.object({ stopped: z.number() }).passthrough().optional()),
  'host.cancelQueued': entry('host.cancelQueued', done),
  // 1.38: external agents: who holds a grant, what they did, and stopping them.
  'external.agents': entry('external.agents', z.array(z.object({ id: z.string(), name: z.string(), level: z.string(), route: z.string(), lastSeen: z.number() }).passthrough())),
  'external.revoke': entry('external.revoke', z.boolean()),
  'external.stopAgent': entry('external.stopAgent', z.boolean()),
  'external.stopAll': entry('external.stopAll', z.number()),
  'external.activity': entry('external.activity', z.array(z.object({ ts: z.number(), agent: z.string(), tool: z.string(), target: z.string(), decidedBy: z.string(), kind: z.enum(['allowed', 'asked', 'refused']) }).passthrough())),
  'inbox.read': entry('inbox.read', done),
  'inbox.unread': entry('inbox.unread', done),
  'questions.answer': entry('questions.answer', done),
  'questions.pick': entry('questions.pick', done),
  'invites.letIn': entry('invites.letIn', done),
  'invites.decline': entry('invites.decline', done),
  'workspaces.load': entry('workspaces.load', done),
  'workspaces.startChat': entry('workspaces.startChat', done),
  // 1.5: asking in a project as a new worktree (its id comes back) or a plan (it comes back).
  'workspaces.startWorktree': entry('workspaces.startWorktree', z.string().optional()),
  'plans.create': entry('plans.create', z.object({ id: z.string() }).passthrough()),
  'attachments.add': entry('attachments.add', z.object({ n: z.number(), chip: z.string() })),
  'attachments.expand': entry('attachments.expand', z.string()),
  'attachments.read': entry('attachments.read', z.object({ mime: z.string(), size: z.number(), data: z.string() })),
  'calls.join': entry('calls.join', done),
  'calls.leave': entry('calls.leave', done),
  'calls.decline': entry('calls.decline', done),
  'network.status': entry('network.status', done),
  'network.friends.list': entry('network.friends.list', done),
  'network.friends.answerOffer': entry('network.friends.answerOffer', done),
  'triage.settle': entry('triage.settle', done),
  'triage.unsettle': entry('triage.unsettle', done),
  'triage.snooze': entry('triage.snooze', done),
  'triage.wake': entry('triage.wake', done),
  'triage.setAutoSettle': entry('triage.setAutoSettle', done),
  // Team boards: an offer to team up with a friend on the same repository (its card).
  'team.answer': entry('team.answer', done),
  'team.ackAssignment': entry('team.ackAssignment', done),
  'team.reviewPlan': entry('team.reviewPlan', done),
  'team.applySuggestion': entry('team.applySuggestion', done),
  'team.dismissSuggestion': entry('team.dismissSuggestion', done),
  // A teammate knocking on your worktree (its card): let in as a viewer or an editor, or not now.
  'team.answerKnock': entry('team.answerKnock', done),
  'network.dm.send': entry('network.dm.send', done),
  'network.dm.history': entry('network.dm.history', done),
  'network.groups.list': entry('network.groups.list', done),
  'network.groups.send': entry('network.groups.send', done),
  'network.groups.history': entry('network.groups.history', done),
  'network.groups.approve': entry('network.groups.approve', done),
  'network.groups.decline': entry('network.groups.decline', done),
  'network.presence.set': entry('network.presence.set', done),
  'network.presence.get': entry('network.presence.get', done),
  'network.avatar.get': entry('network.avatar.get', z.object({ mime: z.string(), b64: z.string() }).passthrough().optional()),
  'network.post': entry('network.post', done),
  'network.files.addData': entry('network.files.addData', done),
  'network.files.download': entry('network.files.download', done),
  'network.files.cancel': entry('network.files.cancel', done),
  'network.files.preview': entry('network.files.preview', z.object({ mime: z.string(), b64: z.string() }).passthrough().optional()),
  'network.channels.main': entry('network.channels.main', z.string().optional()),
  'network.read': entry('network.read', done),
  // 1.30 (BLG-429): a direct message deleted or your own edited, and a direct chat cleared on the Mac.
  'network.messages.delete': entry('network.messages.delete', done),
  'network.messages.edit': entry('network.messages.edit', done),
  'network.clear': entry('network.clear', done),
  // 1.41 (BLG-702): an emoji reaction put on a message or taken off (the quick row).
  'network.messages.react': entry('network.messages.react', done),
  // 1.34 (BLG-466): a dialogue between agents, stopped or continued from the phone.
  'dialogues.stop': entry('dialogues.stop', done),
  'dialogues.continue': entry('dialogues.continue', done),
  'dialogues.confirm': entry('dialogues.confirm', done),
  'claudeCode.outputs': entry('claudeCode.outputs', done),
  'claudeCode.output': entry('claudeCode.output', done),
  'claudeCode.taskOutput': entry('claudeCode.taskOutput', done),
  'gateway.list': entry('gateway.list', done),
  'gateway.confirm': entry('gateway.confirm', done),
  'gateway.cancel': entry('gateway.cancel', done),
  'gateway.forget': entry('gateway.forget', done),
  'needs.dismiss': entry('needs.dismiss', done),
  'gateway.ask': entry('gateway.ask', done),
  'gateway.decide': entry('gateway.decide', done),
  'gateway.answer': entry('gateway.answer', done),
  'gateway.image': entry('gateway.image', z.string()),
  'board.comment': entry('board.comment', done),
  'board.move': entry('board.move', done),
  'plans.approve': entry('plans.approve', done),
  // 1.5: how a plan runs (Step by Step, Check-ins, Autopilot), from its page.
  'plans.setAutonomy': entry('plans.setAutonomy', done),
  'plans.discard': entry('plans.discard', done),
  'plans.fixReview': entry('plans.fixReview', done),
  'plans.verify': entry('plans.verify', done),
  'plans.pass': entry('plans.pass', done),
  'plans.recheck': entry('plans.recheck', done),
  'plans.sendBack': entry('plans.sendBack', done),
  // 1.8: Resume a plan's task that stopped twice, from its Needs You card.
  'plans.resumeTask': entry('plans.resumeTask', z.string()),
  // Ask Claude again about a plan's merge conflict, from its Needs You card.
  'plans.retryConflicts': entry('plans.retryConflicts', done),
  'companion.older': entry('companion.older', OlderResult),
  'companion.ask': entry('companion.ask', AskResult),
  'companion.post': entry('companion.post', done),
  'companion.askPerson': entry('companion.askPerson', AskPersonResult),
  'companion.signOut': entry('companion.signOut', z.object({ signedOut: z.literal(true) })),
  // 1.13: whether the Mac stays awake for the phone (BLG-127).
  'companion.keepAwake': entry('companion.keepAwake', done),
  // 1.54: usage statistics' level, from the phone's Settings (BLG-922).
  'telemetry.choose': entry('telemetry.choose', done),
  // 1.32: one of your providers becomes the default agent (BLG-459).
  'companion.defaultAgent': entry('companion.defaultAgent', done),
  // 1.14: Your Mac's chats: a new one (its id comes back), or one deleted for good.
  'assistant.newChat': entry('assistant.newChat', z.string()),
  'assistant.deleteChat': entry('assistant.deleteChat', done),
  'chats.resolve': entry('chats.resolve', ChatResolveResult),
  'companion.openOnMac': entry('companion.openOnMac', OpenOnMacResult),
  'companion.icon': entry('companion.icon', IconResult),
  'companion.mergeCheck': entry('companion.mergeCheck', MergeCheckView),
  'companion.merge': entry('companion.merge', MergeView),
  'companion.resolve': entry('companion.resolve', MergeView),
  // 1.8: a branch's step, the Mac's own way: how it went, in a line.
  'companion.branchStep': entry('companion.branchStep', z.object({ ok: z.boolean(), message: z.string() })),
  'companion.viewFetch': entry('companion.viewFetch', done),
  'companion.draftTask': entry('companion.draftTask', TaskDraftResult),
  'companion.addTask': entry('companion.addTask', z.object({ id: z.string(), key: z.string(), more: z.array(z.object({ id: z.string(), key: z.string() })).optional() })),
  'board.start': entry('board.start', z.string()),
  // 1.35 (BLG-498): who works a task, and a plan's work, from their next start → what happened, in words.
  'board.setAgent': entry('board.setAgent', z.string()),
  'plans.setWorkAgent': entry('plans.setWorkAgent', z.string()),
  // 1.7: a worktree's files (read-only) and terminals (shared with the Mac).
  'companion.files.list': entry('companion.files.list', FolderView),
  'companion.files.find': entry('companion.files.find', FoundView),
  'companion.files.read': entry('companion.files.read', FilePageView),
  'companion.terminals': entry('companion.terminals', TerminalsView),
  'companion.termOpen': entry('companion.termOpen', TerminalView),
  'companion.termClose': entry('companion.termClose', z.object({ closed: z.boolean() })),
  // 1.10 (BLG-110): a sub-agent's activity and report.
  'companion.subAgent': entry('companion.subAgent', SubAgentDetailView),
  // 1.11 (BLG-124): the conversations no longer on the Mac, of those asked about.
  'companion.gone': entry('companion.gone', z.object({ gone: z.array(z.string()) })),
  'companion.voice': entry('companion.voice', VoiceMacView),
  'companion.voicePrepare': entry('companion.voicePrepare', VoiceMacView),
  'companion.transcribe': entry('companion.transcribe', TranscriptView),
  // Sentinel (docs/sentinel.md): Run Now, Pause / Resume, a sentinel's runs, one run with its
  // report, and Merge / Not Now on a run waiting for you.
  'sentinel.run': entry('sentinel.run', SentinelRunResult),
  'sentinel.pause': entry('sentinel.pause', done),
  'sentinel.runs': entry('sentinel.runs', z.array(SentinelRunResult)),
  'sentinel.runGet': entry('sentinel.runGet', z.object({ run: SentinelRunResult, sentinel: z.object({ id: z.string(), name: z.string() }).optional(), report: z.string().optional() }).passthrough()),
  'sentinel.decide': entry('sentinel.decide', SentinelRunResult),
  // 1.22 (BLG-244): a number over time (its points, oldest first), and pull to refresh a dashboard.
  'sentinel.metricRead': entry('sentinel.metricRead', z.object({ metric: z.object({ name: z.string(), label: z.string(), unit: z.string() }).passthrough(), lines: z.array(z.object({ at: z.number(), runId: z.string(), value: z.number().optional() }).passthrough()) })),
  'dashboard.refresh': entry('dashboard.refresh', z.object({ total: z.number() })),
  // 1.25 (BLG-345): a table's document chip, read through the Mac, and a storage chip's link signed there.
  'sentinel.document': entry('sentinel.document', DocumentView),
  'sentinel.signStorage': entry('sentinel.signStorage', SignedLinkView),
  'sentinel.runRow': entry('sentinel.runRow', SentinelRunResult),
  // 1.29 (BLG-386): a document the phone doesn't show, opened in its app on the Mac.
  'sentinel.documentOpen': entry('sentinel.documentOpen', done),
  'sentinel.storageOpen': entry('sentinel.storageOpen', done),
  // 1.29 (BLG-392): what a sentinel keeps, its files and histories as refs; a run's file opened on the Mac.
  'sentinel.dataList': entry('sentinel.dataList', DataListView),
  'sentinel.runFileOpen': entry('sentinel.runFileOpen', done),
} as const;

export type PhoneMethod = keyof typeof PhoneCalls;
export type PhoneArgs<M extends PhoneMethod> = z.input<(typeof PhoneCalls)[M]['args']>;
export type PhoneResult<M extends PhoneMethod> = z.infer<(typeof PhoneCalls)[M]['result']>;
