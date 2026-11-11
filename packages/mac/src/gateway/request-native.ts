import { untag } from '@beluga/machines/attention.js';
import { machineClientOf } from '../machines/pane-clients.js';
import { useEffect, useSyncExternalStore } from 'react';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { inApp } from '../lib/boot.js';
import { dndActive } from '@beluga/shared/quiet.js';
import { planOfChannel } from '@beluga/core/notify.js';
import { NOTIFICATION_TAP, macNoticeTarget } from '../lib/notices.js';
import { popupPublisher } from './popup-bridge.js';
import { type PopupItem, type PopupNeed, isNeedId, isPreviewId, popupNeeds, popupRequests, previewItems } from './popup-model.js';
import { REQUEST_NOTIFICATION, type RequestAction, outsideStep, parseRequestMenuId, trayRequests } from './request-actions.js';
import { t as translate } from '../i18n/index.js';

/**
 * Friends' requests outside the window: the floating pop-up (Allow / Allow Always / Decline,
 * with See more), the same in the menu-bar menu, and the request sheet they open (one at a
 * time). The app shell (src-tauri) shows the pop-up and menu items; this side answers them.
 */

export { REQUEST_NOTIFICATION, type RequestAction, notificationActions } from './request-actions.js';

// ------------------------------------------------------------------ the request sheet

let open: string | undefined;
const listeners = new Set<() => void>();
const emit = (): void => {
  for (const l of [...listeners]) l();
};

/** Open the request sheet on this received task. */
export function openRequest(taskId: string): void {
  open = taskId;
  emit();
}

export function closeRequest(): void {
  if (open === undefined) return;
  open = undefined;
  emit();
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export const useRequestSheet = (): string | undefined => useSyncExternalStore(subscribe, () => open);

// ------------------------------------------------------------------ answering

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Answer an approval from outside the window (a notification, the menu bar), or open its sheet. */
export async function runRequestAction(client: SocketClient, action: RequestAction, approval: string | undefined, task: string | undefined): Promise<void> {
  if (isPreviewId(approval)) {
    // The preview's buttons: nothing was asked, so nothing is answered.
    stopPreview();
    return void client.store.dispatch({ type: 'toast', text: 'That was a preview: nothing was asked, and nothing was sent', level: 'info' });
  }
  if (isNeedId(approval)) return openNeed(client, approval!);
  const approvals = client.store.getState().approvals;
  const known = approvals.find((a) => a.id === approval) ?? (task ? approvals.find((a) => a.task === task) : undefined);
  const say = (text: string, level: 'info' | 'success' | 'error' = 'info'): void => void client.store.dispatch({ type: 'toast', text, level });
  const step = outsideStep(action, known, task);
  if (step.kind === 'gone') return say('That request was already answered');
  if (step.kind === 'review') {
    if (step.task) openRequest(step.task);
    // Your own Claude's approval: the conversation it holds up, where its card is.
    else if (known && !known.peer) openWhere(client, known.channel);
    else client.store.dispatch({ type: 'view', view: { kind: 'requests' } });
    return;
  }
  try {
    if (step.kind === 'decide') await client.api.gateway.decide(step.task, step.decision);
    else await client.api.host.answerApproval(step.answer, step.id);
    const answer = step.kind === 'decide' ? step.decision.answer : step.answer;
    const always = step.kind === 'decide' && step.decision.expiry === 'never' ? 'Allowed; requests like it run without asking (Settings › People & access)' : 'Approved; requests like it run without asking for a week';
    say(answer === 'no' ? 'Declined' : answer === 'always' ? always : 'Approved', answer === 'no' ? 'info' : 'success');
  } catch (err) {
    say(`Couldn't answer it: ${message(err)}`, 'error');
  }
}

/** A menu-bar item for a request ("req-yes:<approval id>"…); false if it's someone else's. */
export function runRequestMenuItem(id: string, client: SocketClient): boolean {
  const item = parseRequestMenuId(id);
  if (!item) return false;
  void runRequestAction(client, item.action, item.approval, undefined);
  return true;
}

/** Do Not Disturb (Beluga's or your status), or appearing offline: friends' requests wait quietly. */
const quietNow = (st: ReturnType<SocketClient['store']['getState']>): boolean =>
  dndActive(st.prefs.notify) || Boolean(st.network.self && (st.network.self.appearOffline || st.network.self.presence.state === 'dnd'));

// ------------------------------------------------------------------ the pop-up

/** What your own Claude needs, as the card shows it now (by id), so Open knows where to go. */
const shownNeeds = new Map<string, PopupNeed>();

/**
 * Open on a "Claude needs you" card: where it's asked (a plan's conversation opens the plan), like
 * clicking its notification. The card may have left the pop-up's list by now (bringing the window
 * forward changes what counts as showing), so what it's about is looked up again by its id.
 */
function openNeed(client: SocketClient, id: string): void {
  openWhere(client, shownNeeds.get(id)?.channel ?? needChannel(client.store.getState(), id));
}

/** The conversation a need's id ("need:a:<approval>", "need:q:<qid>", "need:pass:<plan>:…") is about, from the state. */
function needChannel(st: ReturnType<SocketClient['store']['getState']>, id: string): string | undefined {
  const [, kind, rest = ''] = /^need:(a|q|pass):(.*)$/.exec(id) ?? [];
  if (kind === 'a') return st.approvals.find((a) => a.id === rest)?.channel;
  if (kind === 'q') return st.questions.find((q) => q.qid === rest)?.channel;
  if (kind === 'pass') return st.plans.plans.find((p) => rest.startsWith(`${p.id}:`))?.home;
  return undefined;
}

/** Go to a conversation (the notification's way: a plan's opens the plan); with none the window can open, Your Mac, which shows every approval. */
function openWhere(client: SocketClient, channel: string | undefined): void {
  if (channel && macNoticeTarget(client.store.getState(), channel)) document.dispatchEvent(new CustomEvent(NOTIFICATION_TAP, { detail: { channel } }));
  else client.store.dispatch({ type: 'view', view: { kind: 'assistant' } });
}

/** The preview (⌘K › Preview Request Pop-up) while it shows, and who to tell when it changes. */
let preview: { readonly items: readonly PopupItem[]; readonly timer: ReturnType<typeof setTimeout> } | undefined;
const previewListeners = new Set<() => void>();
const PREVIEW_MS = 60_000;

function stopPreview(): void {
  if (!preview) return;
  clearTimeout(preview.timer);
  preview = undefined;
  for (const l of [...previewListeners]) l();
}

/**
 * Show the pop-up with a pretend friend's request and a pretend decision, so you can see it (and
 * that it reaches you) even when nobody else uses Beluga with you. Gone after a minute, or when
 * you press one of its buttons (which do nothing).
 */
export function previewRequestPopup(): void {
  if (preview) clearTimeout(preview.timer);
  preview = { items: previewItems(Date.now()), timer: setTimeout(stopPreview, PREVIEW_MS) };
  for (const l of [...previewListeners]) l();
}

/** A Beluga window in front shows this already (the conversation, or the plan's page): no card about it. */
function showingNow(st: ReturnType<SocketClient['store']['getState']>): (channel: string | undefined, plan?: string) => boolean {
  if (!st.attention.front) return () => false;
  const onPlan = st.view.kind === 'plan' ? st.view.id : undefined;
  return (channel, plan) => Boolean((channel && st.attention.visible.includes(channel)) || (onPlan && (plan === onPlan || (channel && planOfChannel(st, channel)?.plan.id === onPlan))));
}

/** Keep the pop-up showing the friends' requests and what your Claude needs from you (and hide it once they're answered). */
export function useRequestPopup(client: SocketClient): void {
  useEffect(() => {
    const popup = popupPublisher();
    let last = '';
    let seen: readonly unknown[] = [];
    let wasPreview: typeof preview;
    const update = (): void => {
      const st = client.store.getState();
      // Claude streams all the time: only what the card is made of counts.
      const parts = [st.approvals, st.questions, st.plans, st.board, st.prefs, st.attention, st.view, st.network.self, st.gateway.tasks, st.projects];
      if (wasPreview === preview && parts.length === seen.length && parts.every((p, i) => p === seen[i])) return;
      seen = parts;
      wasPreview = preview;
      const quiet = quietNow(st);
      const requests = popupRequests(st.approvals, st.gateway.tasks, quiet);
      const needs = popupNeeds(st, { quiet, showing: showingNow(st) });
      shownNeeds.clear();
      for (const n of needs) shownNeeds.set(n.approval, n);
      const items: readonly PopupItem[] = [...(preview?.items ?? []), ...requests, ...needs];
      const key = JSON.stringify(items);
      if (key === last) return;
      last = key;
      popup.publish(items);
    };
    update();
    const unsubscribe = client.store.subscribe(update);
    previewListeners.add(update);
    return () => {
      unsubscribe();
      previewListeners.delete(update);
      popup.publish([]);
      popup.close();
    };
  }, [client]);
}

/** Keep the menu bar's requests in step, and answer the notifications' (and the pop-up's) buttons. */
export function useRequestNative(client: SocketClient): void {
  useRequestPopup(client);
  useEffect(() => {
    // One of your computers' (BLG-790): answered on that computer, with its own ids.
    const answer = (action: RequestAction, approval?: string, task?: string): void => {
      const a = untag(approval);
      const t = untag(task);
      const machine = a.machine ?? t.machine;
      const on = machine ? machineClientOf(machine) : client;
      if (on) void runRequestAction(on, action, a.id, t.id);
    };
    const onEvent = (e: Event): void => {
      const d = (e as CustomEvent<{ action?: RequestAction; approval?: string; task?: string }>).detail;
      if (d?.action) answer(d.action, d.approval, d.task);
    };
    document.addEventListener(REQUEST_NOTIFICATION, onEvent);
    if (!inApp()) return () => document.removeEventListener(REQUEST_NOTIFICATION, onEvent);
    let alive = true;
    let off: (() => void) | undefined;
    void import('@tauri-apps/api/event')
      .then(async ({ listen }) => {
        const un = await listen<{ action: RequestAction; approval?: string; task?: string }>('notification-request', (e) => answer(e.payload.action, e.payload.approval, e.payload.task));
        if (alive) off = un;
        else un();
      })
      .catch(() => undefined);
    let last = '';
    const update = (): void => {
      const requests = trayRequests(client.store.getState().approvals).map((r) => ({ ...r, title: translate(r.title) }));
      const key = JSON.stringify(requests);
      if (key === last) return;
      last = key;
      void import('@tauri-apps/api/core').then(({ invoke }) => invoke('set_tray_requests', { requests })).catch(() => undefined);
    };
    update();
    const unsubscribe = client.store.subscribe(update);
    return () => {
      alive = false;
      off?.();
      unsubscribe();
      document.removeEventListener(REQUEST_NOTIFICATION, onEvent);
    };
  }, [client]);
}
