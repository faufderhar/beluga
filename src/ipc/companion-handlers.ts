import { branchStep } from '../companion/branch-steps.js';
import { goneTopics } from '../companion/gone.js';
import { merge, mergeCheck, resolve } from '../companion/merge.js';
import { macViewFor } from '../companion/open-on-mac.js';
import { stripCode } from '../companion/strip.js';
import { subAgentDetail } from '../companion/sub-agent.js';
import { claudeCodeOf } from '../core/claude-code/launch.js';
import { type ViewFetchArgs, viewFetch } from '../companion/view-fetch.js';
import { needBoard } from '../core/board/registry.js';
import { needCompanion } from '../companion/registry.js';
import { CLAUDE_AGENT } from '../protocol.js';
import { providersOf } from '../agent/usage.js';
import { currentClient } from '../core/client-context.js';
import type { Session } from '../core/session.js';
import type { TaskDraft } from '../agent/task-drafter.js';
import type { TaskDraftResult } from '../companion/calls.js';
import type { Args, Method } from './api.js';
import { THIS_COMPUTER, YOUR_COMPUTER } from '../shared/assistant.js';

/** What each `companion.*` method does (see companion-api.ts). Results carry no keys or secrets beyond the pairing's own link and code. */

/** Who is calling (a phone's calls run as `phone:<device id>`). */
const callerOf = (): string => currentClient() ?? '';

type CompanionMethod = Extract<Method, `companion.${string}`>;
type CompanionHandlers = { readonly [M in CompanionMethod]: (s: Session, ...args: Args<M>) => unknown };

export const COMPANION_HANDLERS = {
  'companion.pair.start': (s) => needCompanion(s).pairStart(),
  'companion.pair.approve': (s) => needCompanion(s).pairApprove(),
  'companion.pair.cancel': (s) => needCompanion(s).pairCancel(),
  'companion.devices.remove': (s, id) => needCompanion(s).removeDevice(id),
  'companion.phone.use': (s, id, use) => needCompanion(s).setPhoneUse(id, use),
  'companion.phone.pairAdb': (s, id) => needCompanion(s).pairPhoneAdb(id),
  'companion.phone.wifi': (s, id, on) => needCompanion(s).phoneWifiDebugging(id, on),
  'companion.phone.pairCable': (s) => needCompanion(s).pairOverCable(),
  'companion.phone.setUpLink': (s, id) => needCompanion(s).setUpPhoneLink(id),
  'companion.phone.settings': (s, id, which) => needCompanion(s).showPhoneSettings(id, which),
  'companion.phone.act': (s, id, op, args) => needCompanion(s).phoneAction(id, op, args),
  'companion.phone.macros': (s) => needCompanion(s).listPhoneMacros(),
  'companion.phone.macroRun': (s, name) => needCompanion(s).runPhoneMacro(name),
  'companion.phone.macroDelete': (s, name) => needCompanion(s).deletePhoneMacro(name),
  'companion.older': (s, topic, page) => needCompanion(s).older(topic, page.before, page.limit),
  'companion.ask': (s, a) => needCompanion(s).ask(callerOf(), a),
  'companion.post': (s, a) => needCompanion(s).post(callerOf(), a),
  'companion.askPerson': (s, a) => needCompanion(s).askPerson(callerOf(), a),
  'companion.signOut': (s) => needCompanion(s).signOut(callerOf()),
  'companion.keepAwake': (s, mode) => s.setPrefs({ keepAwake: mode }),
  'companion.defaultAgent': (s, runtime) => {
    // One of your providers by its runtime (its card's agent); Claude is "no default set", as on the Mac.
    const me = s.store.getState().peers.find((p) => p.peerId === s.selfId) ?? s.store.getState().self;
    const agent = providersOf(me).find((a) => a.runtime === runtime);
    if (!agent) throw new Error(`No ${runtime} agent on ${THIS_COMPUTER}`);
    s.setPrefs({ defaultAgent: runtime === CLAUDE_AGENT.runtime ? null : agent });
  },
  'companion.openOnMac': async (s, target) => {
    const view = macViewFor(s.store.getState(), target);
    if (!view) return { opened: false, why: `That isn’t on ${YOUR_COMPUTER} any more` };
    // A worktree's conversation is loaded before it's shown (as opening it on the Mac does).
    if (view.kind === 'workspace') s.workspaces?.ensureLoaded(view.id);
    const raised = await s.showOnScreens({ type: 'navigate', view });
    return raised ? { opened: true } : { opened: false, why: `Beluga isn’t open on ${YOUR_COMPUTER}` };
  },
  'companion.icon': (s, sum) => needCompanion(s).icon(sum),
  'companion.voice': (s) => needCompanion(s).voice.status(),
  'companion.voicePrepare': (s, model) => needCompanion(s).voice.prepare(model),
  'companion.transcribe': (s, a) => needCompanion(s).transcribe(callerOf(), a),
  'companion.mergeCheck': (s, topic) => mergeCheck(s, topic),
  'companion.merge': (s, topic) => merge(s, needCompanion(s).merges, topic),
  'companion.resolve': (s, topic) => resolve(s, needCompanion(s).merges, topic),
  'companion.branchStep': (s, topic, step, children) => branchStep(s, topic, step, children),
  'companion.viewFetch': (s, a) => viewFetch(s.store.getState(), a as ViewFetchArgs),
  'companion.draftTask': async (s, a) => {
    const d = await needBoard(s).draft(a.projectId, a.text, { several: Boolean(a.several) });
    return phoneDraft(d, a.several);
  },
  'companion.addTask': (s, a) => {
    const { projectId, more, epic, agent, ...first } = a;
    const [issue, ...rest] = needBoard(s).addDraft(projectId, { ...first, ...(more?.length ? { more } : {}), ...(epic ? { epic: true as const } : {}) }, agent);
    return { id: issue!.id, key: issue!.key, ...(rest.length ? { more: rest.map((i) => ({ id: i.id, key: i.key })) } : {}) };
  },
  'companion.files.list': (s, topic, rel) => needCompanion(s).filesList(topic, rel),
  'companion.files.find': (s, topic, query) => needCompanion(s).filesFind(topic, query),
  'companion.files.read': (s, topic, rel, opts) => needCompanion(s).filesRead(topic, rel, opts?.off ?? 0),
  'companion.terminals': (s, topic) => needCompanion(s).terminalsOf(topic),
  'companion.termOpen': (s, topic, opts) => needCompanion(s).termOpen(callerOf(), topic, opts ?? {}),
  'companion.termClose': (s, key) => needCompanion(s).termClose(callerOf(), key),
  'companion.subAgent': (s, topic, turn, id) =>
    subAgentDetail(s.store.getState(), {
      steps: (channel, itemId) => s.host.stepsFor(channel, itemId),
      step: (channel, itemId, stepId) => s.host.stepFor(channel, itemId, stepId),
      ccSteps: (sessionId, agentId) => claudeCodeOf(s).steps(sessionId, agentId, { limit: 200 }),
    }, topic, turn, id),
  'companion.gone': (s, topics) => ({ gone: goneTopics(s.store.getState(), topics) }),
} satisfies CompanionHandlers;

/**
 * A draft as the phone shows it: words only (a code block in a goal, rare in a draft, reads
 * "(code)"); with `several` (1.24), who each is for and the tasks after the first.
 */
function phoneDraft(d: TaskDraft, several?: boolean): TaskDraftResult {
  const one = (t: TaskDraft) => ({ title: t.title, goal: stripCode(t.goal).text.replace(/\[\[code(?::\d+)?\]\]/g, '(code)'), acceptance: [...t.acceptance], labels: [...t.labels], ...(t.priority ? { priority: t.priority } : {}), ...(several && t.for ? { for: t.for } : {}) });
  return { ...one(d), ...(several && d.more?.length ? { more: d.more.map(one), ...(d.epic ? { epic: true } : {}) } : {}) };
}
