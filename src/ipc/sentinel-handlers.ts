import { fromPhone } from '../core/client-context.js';
import { busyChannels } from '../core/board/work.js';
import { sentinelChatChannel } from '../core/sentinel/model.js';
import { needSentinel } from '../core/sentinel/registry.js';
import { revealInFinder, systemOpen } from '../core/os-open.js';
import { DOCUMENT_TO_PHONE } from '../companion/protocol.js';
import type { Session } from '../core/session.js';
import type { Args, Method } from './api.js';

/** What each `sentinel.*` method does (see sentinel-api.ts): you act as yourself. */

type SentinelMethod = Extract<Method, `sentinel.${string}`>;
type SentinelHandlers = { readonly [M in SentinelMethod]: (s: Session, ...args: Args<M>) => unknown };

export const SENTINEL_HANDLERS = {
  'sentinel.create': (s, draft) => needSentinel(s).create(draft),
  'sentinel.update': (s, id, patch) => needSentinel(s).update(id, patch),
  'sentinel.remove': (s, id) => needSentinel(s).remove(id),
  'sentinel.runDelete': (s, id, what) => needSentinel(s).runDelete(id, what),
  'sentinel.duplicate': (s, id) => needSentinel(s).duplicate(id),
  // Run Now from the phone says so in the run's history ("You ran it from your phone").
  'sentinel.run': (s, id) => needSentinel(s).start(id, fromPhone() ? 'phone' : 'you'),
  'sentinel.test': (s, id) => needSentinel(s).test(id, 'you'),
  'sentinel.stop': (s, runId) => needSentinel(s).stop(runId),
  'sentinel.pause': (s, id, paused) => needSentinel(s).pause(id, paused),
  'sentinel.moveCheck': (s, id) => needSentinel(s).mover.check(id),
  'sentinel.movePack': (s, id) => needSentinel(s).mover.packOut(id),
  'sentinel.moveChunk': (s, token, n) => needSentinel(s).mover.chunk(token, n),
  'sentinel.moveReceive': (s, token, n, total, data) => needSentinel(s).mover.receive(token, n, total, data),
  'sentinel.moveLand': (s, token, projectId, from) => needSentinel(s).mover.landIn(token, projectId ?? null, from),
  'sentinel.moveDrop': (s, id) => needSentinel(s).mover.drop(id),
  'sentinel.forChat': (s, chat) => needSentinel(s).forChat(chat),
  'sentinel.runs': (s, id) => needSentinel(s).runsOf(id),
  'sentinel.runGet': (s, runId) => needSentinel(s).runGet(runId),
  'sentinel.ask': (s, id, text) => needSentinel(s).ask(id, text),
  'sentinel.recipes': (s) => needSentinel(s).recipes(),
  'sentinel.decide': (s, runId, choice) => needSentinel(s).decide(runId, choice),
  'sentinel.setRunAtOnce': (s, n) => needSentinel(s).setRunAtOnce(n),
  // A webhook sentinel's new secret (the old URL stops at once) → its address, or why there's none now.
  'sentinel.rotateSecret': (s, id) => needSentinel(s).rotateSecret(id),
  // Its address with the secret ({ url }), or why there's none now ({ why }): never in the state.
  'sentinel.webhookUrl': (s, id) => needSentinel(s).webhookUrl(id),
  'sentinel.metricRead': (s, id, name, since) => needSentinel(s).metricRead(id, name, since),
  // The phone gets what fits a frame of its link (text cut, bigger bytes refused).
  'sentinel.document': (s, id, metric, column, name) => needSentinel(s).document(id, metric, column, name, fromPhone() ? DOCUMENT_TO_PHONE : undefined),
  // In its own app, or shown in Finder, on this Mac (its path never leaves the daemon).
  'sentinel.documentOpen': (s, id, metric, column, name, how) => {
    (how === 'reveal' ? revealInFinder : systemOpen)(needSentinel(s).documentPath(id, metric, column, name));
  },
  'sentinel.signStorage': (s, id, metric, column, value) => needSentinel(s).signStorage(id, metric, column, value),
  'sentinel.storageDocument': (s, id, metric, column, value) => needSentinel(s).storageDocument(id, metric, column, value),
  'sentinel.storageOpen': async (s, id, metric, column, value, how) => {
    (how === 'reveal' ? revealInFinder : systemOpen)(await needSentinel(s).storagePath(id, metric, column, value));
  },
  'sentinel.dataList': (s, id) => needSentinel(s).dataList(id),
  'sentinel.runFile': (s, runId, name) => needSentinel(s).runFile(runId, name, fromPhone() ? DOCUMENT_TO_PHONE : undefined),
  'sentinel.runFileOpen': (s, runId, name, how) => {
    (how === 'reveal' ? revealInFinder : systemOpen)(needSentinel(s).runFilePath(runId, name));
  },
  'sentinel.dataExport': (s, id, what) => {
    revealInFinder(needSentinel(s).dataExport(id, what));
  },
  'sentinel.dataReveal': (s, id, runId) => {
    systemOpen(needSentinel(s).dataFolder(id, runId));
  },
  'sentinel.runRow': (s, id, metric, column, row) => needSentinel(s).runRow(id, metric, column, row, fromPhone() ? 'phone' : 'you'),
  'sentinel.chatNew': (s) => needSentinel(s).chatNew(),
  'sentinel.chatOpen': (s, id) => needSentinel(s).chatOpen(id),
  'sentinel.chatClear': (s, id) => {
    const channel = sentinelChatChannel(id);
    // Its Claude stops first: nothing it says after lands in the cleared chat.
    if (busyChannels(s.store.getState().log).has(channel)) s.host.stopRun(channel);
    s.host.forgetContext(channel);
    needSentinel(s).chatClear(id);
  },
  'sentinel.chatDelete': async (s, id) => {
    const channel = sentinelChatChannel(id);
    if (busyChannels(s.store.getState().log).has(channel)) s.host.stopRun(channel);
    s.host.forgetContext(channel);
    await needSentinel(s).chatDelete(id);
  },
} satisfies SentinelHandlers;
