import { systemOpen } from '../core/os-open.js';
import { needPlans } from '../core/plans/registry.js';
import type { Session } from '../core/session.js';
import type { Args, Method } from './api.js';

/** What each `plans.*` method does (see plans-api.ts): you act as yourself. */

type PlansMethod = Extract<Method, `plans.${string}`>;
type PlansHandlers = { readonly [M in PlansMethod]: (s: Session, ...args: Args<M>) => unknown };

export const PLANS_HANDLERS = {
  'plans.create': (s, input) => needPlans(s).create(input),
  'plans.here': (s, channel, autonomy) => needPlans(s).here(channel, autonomy),
  'plans.approve': (s, id) => needPlans(s).approve(id),
  'plans.discard': (s, id) => needPlans(s).discard(id) ?? null,
  'plans.fixReview': (s, id) => needPlans(s).fixReview(id),
  'plans.verify': (s, id, opts) => needPlans(s).verify(id, Boolean(opts?.thenApprove)),
  'plans.edit': (s, id, ops) => needPlans(s).edit(id, ops),
  'plans.setAutonomy': (s, id, autonomy, milestone) => needPlans(s).setAutonomy(id, autonomy, milestone),
  'plans.setPaused': (s, id, paused) => needPlans(s).setPaused(id, paused),
  'plans.setParallel': (s, id, n) => needPlans(s).setParallel(id, n),
  'plans.setTestsAt': (s, id, when) => needPlans(s).setTestsAt(id, when),
  'plans.setWorkAgent': (s, id, agent) => needPlans(s).setWorkAgent(id, agent ?? null),
  'plans.setRoleAgent': (s, id, role, agent) => needPlans(s).setRoleAgent(id, role, agent ?? null),
  'plans.setFullAuto': (s, id, on) => needPlans(s).setFullAuto(id, on),
  'plans.tidyUp': (s, id, yes) => needPlans(s).tidyUp(id, yes),
  'plans.pass': (s, id, milestone) => needPlans(s).pass(id, milestone),
  'plans.recheck': (s, id, milestone) => needPlans(s).recheck(id, milestone),
  'plans.sendBack': (s, id, milestone, note) => needPlans(s).sendBack(id, milestone, note),
  'plans.openPr': (s, id) => needPlans(s).openPr(id),
  'plans.mergePr': (s, id, opts) => needPlans(s).mergePr(id, opts ?? {}),
  'plans.mergeLocal': (s, id) => needPlans(s).mergeLocal(id),
  'plans.bringInMain': (s, id) => needPlans(s).bringInMain(id),
  'plans.retryConflicts': (s, id) => needPlans(s).retryConflicts(id),
  'plans.showConflict': (s, id) => {
    const dir = needPlans(s).conflictDir(id);
    if (!dir) throw new Error('This plan has no conflict waiting');
    systemOpen(dir);
    return null;
  },
  'plans.startTask': (s, id, task, agent) => needPlans(s).startTask(id, task, agent),
  'plans.resumeTask': (s, id, task) => needPlans(s).resumeTask(id, task),
  'plans.remove': (s, id) => needPlans(s).remove(id),
  'plans.setStyle': (s, text) => needPlans(s).setStyle(text),
  'plans.moveCheck': (s, id) => needPlans(s).mover.check(id),
  'plans.movePack': (s, id, opts) => needPlans(s).mover.packOut(id, opts),
  'plans.moveChunk': (s, token, n) => needPlans(s).mover.chunk(token, n),
  'plans.moveReceive': (s, token, n, total, data) => needPlans(s).mover.receive(token, n, total, data),
  'plans.moveLand': (s, token, projectId, from) => needPlans(s).mover.landIn(token, projectId, from),
  'plans.moveDone': (s, id, to) => needPlans(s).mover.done(id, to),
  'plans.moveUndo': (s, id) => needPlans(s).mover.undo(id),
} satisfies PlansHandlers;
