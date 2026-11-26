import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Plan, PlansState } from '@beluga/core/plans/model.js';
import { type MilestoneView, type PlanView, liveFrom, planView } from '@beluga/core/plans/progress.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { toast, useApi, useApp, useBeluga } from '../lib/beluga.js';
import { useActions } from '../lib/actions.js';
import { onWindowActive, windowActive } from '../lib/window-active.js';
import { sameDeep, sameItems } from '../lib/stable.js';
import { beat, onPowerSaving, powerSaving } from '../lib/power.js';

/** What the Plans screens share: the plans, a plan where it stands (live), and acting on plans. */

export const usePlans = (): PlansState => useApp((s) => s.plans);

/** A plan where it stands now: from the board and what Claude is doing in each worktree. */
export function usePlanView(plan: Plan | undefined): PlanView | undefined {
  // Worked out again only when what it's made of changes, and given out again only when it reads
  // differently: a Claude streaming in another conversation doesn't draw a plan's row again (KLD-48).
  const made = useRef<{ readonly from: readonly unknown[]; readonly view: PlanView | undefined }>(undefined);
  return useApp((s) => {
    const from = [plan, s.board, s.log, s.questions, s.approvals];
    if (made.current && sameItems(made.current.from, from)) return made.current.view;
    const view = plan ? planView(plan, s.board, liveFrom(s)) : undefined;
    made.current = { from, view };
    return view;
  }, sameDeep);
}

/**
 * The conversation checking a milestone (its own Claude, folded into the plan so the sidebar never
 * shows it): its workspace id while it's there, archived ones too (a passed milestone's check is kept).
 */
export function useCheckerChat(m: MilestoneView | undefined): string | undefined {
  const id = m?.run.checker;
  return useApp((s) => (id && findWorkspace(s.projects, id) ? id : undefined));
}

// One clock for every card that shows how long a step has run: it ticks each second only while one
// does and you're looking at the window (on time again the moment you look back).
const CLOCK_MS = 1000;
const clockSubs = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | undefined;
let stopLooking: (() => void) | undefined;
let clockNow = Date.now();
const tickClock = (): void => {
  clockNow = Date.now();
  clockSubs.forEach((f) => f());
};
function runClock(): void {
  clearInterval(clockTimer);
  clockTimer = undefined;
  if (!clockSubs.size || !windowActive()) return;
  tickClock();
  clockTimer = setInterval(tickClock, beat(CLOCK_MS, powerSaving()));
}
let stopSaving: (() => void) | undefined;
function subscribeClock(onChange: () => void): () => void {
  clockSubs.add(onChange);
  clockNow = Date.now();
  if (!stopLooking) {
    stopLooking = onWindowActive(runClock);
    stopSaving = onPowerSaving(runClock);
    runClock();
  }
  return () => {
    clockSubs.delete(onChange);
    if (clockSubs.size) return;
    stopLooking?.();
    stopLooking = undefined;
    stopSaving?.();
    stopSaving = undefined;
    runClock();
  };
}
const noClock = (): (() => void) => () => undefined;

/** Now, for a card showing elapsed time (`on`: it shows some); it moves every second while on and the window is in front. */
export function useClock(on: boolean): number {
  return useSyncExternalStore(on ? subscribeClock : noClock, () => (on ? clockNow : 0));
}

/**
 * Now, for a task card: every second while it shows elapsed time (`on`), else to the minute, for
 * its "Updated 2 h ago" (a card never says "just now" for lack of a clock).
 */
export function useCardClock(on: boolean): number {
  const fast = useClock(on);
  const [slow, setSlow] = useState(Date.now);
  useEffect(() => {
    if (on) return;
    setSlow(Date.now());
    const t = setInterval(() => setSlow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [on]);
  return on ? fast : slow;
}

/**
 * The plan's own conversation, loaded: after a restart it's only on disk until something asks for
 * it (workspaces.load). False until that answered for this channel; true for one that isn't a workspace's.
 */
export function useConversationLoaded(channel: string): boolean {
  const api = useApi();
  const wsId = channel.startsWith('ws:') ? channel.slice(3) : undefined;
  const [loadedFor, setLoadedFor] = useState<string>();
  useEffect(() => {
    if (!wsId) return;
    let alive = true;
    void api.workspaces
      .load(wsId)
      .catch(() => undefined)
      .then(() => alive && setLoadedFor(wsId));
    return () => {
      alive = false;
    };
  }, [api, wsId]);
  return !wsId || loadedFor === wsId;
}

const message = (err: unknown): string => (err instanceof Error ? err.message.replace(/^Error: /, '') : String(err));

/** The plans API with errors shown (a toast), and going places. */
export function usePlanActions() {
  const api = useApi();
  const { client } = useBeluga();
  const actions = useActions();
  return useMemo(() => {
    const act = async <T,>(run: () => Promise<T>, done?: string): Promise<T | undefined> => {
      try {
        const result = await run();
        if (done) toast(client, done, 'success');
        return result;
      } catch (err) {
        toast(client, message(err), 'error');
        return undefined;
      }
    };
    return {
      api: api.plans,
      act,
      open: (id: string): void => actions.run({ type: 'view', view: { kind: 'plan', id } }),
      openList: (projectId?: string): void => actions.run({ type: 'view', view: { kind: 'plans', ...(projectId ? { projectId } : {}) } }),
      openTask: (issueId: string): void => actions.run({ type: 'view', view: { kind: 'task', id: issueId } }),
      openWorktree: (workspaceId: string): void => actions.run({ type: 'open_ws', id: workspaceId, tab: 'chat' }),
    };
  }, [api, client, actions]);
}

/**
 * A plan's big steps (Open PR, Merge, Resolve Conflicts, Pass): what's under way (its button says so
 * and waits), and what went wrong (kept on the page, with Try Again, until you dismiss it or it works).
 * Kept per plan outside the page, so leaving and coming back mid-merge still shows it.
 */
export interface PlanTrouble {
  /** What was being done ("Merge #7 on GitHub"). */
  readonly what: string;
  /** Why it didn't happen, in GitHub's or git's words made plain. */
  readonly why: string;
  readonly retry?: () => void;
}
interface StepState {
  readonly busy?: string;
  readonly trouble?: PlanTrouble;
}
const steps = new Map<string, StepState>();
const stepSubs = new Set<() => void>();
const setStep = (planId: string, next: StepState): void => {
  steps.set(planId, next);
  stepSubs.forEach((f) => f());
};
const subscribeSteps = (f: () => void): (() => void) => (stepSubs.add(f), () => void stepSubs.delete(f));

/** What a long step under way is doing now ("Sending it to build-box…"): the busy button says it. */
export const stepSays = (planId: string, words: string): void => {
  if (steps.get(planId)?.busy) setStep(planId, { busy: words });
};
const NO_STEP: StepState = {};

export function usePlanStep(planId: string) {
  const { client } = useBeluga();
  const state = useSyncExternalStore(subscribeSteps, () => steps.get(planId) ?? NO_STEP);
  const run = useCallback(
    async (what: string, doing: string, task: () => Promise<unknown>, done?: string): Promise<boolean> => {
      if (steps.get(planId)?.busy) return false;
      setStep(planId, { busy: doing });
      try {
        await task();
        setStep(planId, {});
        if (done) toast(client, done, 'success');
        return true;
      } catch (err) {
        setStep(planId, { trouble: { what, why: message(err), retry: () => void run(what, doing, task, done) } });
        return false;
      }
    },
    [planId, client],
  );
  const dismiss = useCallback(() => setStep(planId, {}), [planId]);
  return { busy: state.busy, trouble: state.trouble, run, dismiss };
}
