import { git, tryGit } from '../workspaces/git.js';
import { type WorktreeMover, worktreeMover } from '../core/worktree-move.js';
import type { Session } from '../core/session.js';
import { needFriendShares } from '../core/friend-share/launch.js';
import { remoteScratch } from '../core/friend-share/scratch.js';
import type { AddResult, WorkspaceController } from '../core/workspace-controller.js';
import type { Workbench } from '../core/workbench.js';
import { browseDir, listLocalDirs, localDirKey, openWithSystem } from '../core/local.js';
import { ATTACHMENT_SHARE, type FetchShared, attachmentOnDisk, chipText, expandChips, importImageFitting, mediaTypeOf, pathInfo, publishForRoom, reattach, readAttachment, registerAttachment, roomAttachmentsDir, saveImageBytes } from '../core/attachments.js';
import { fetchBytes } from '../core/downloads.js';
import { testDatabase } from '../core/views/sources.js';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findProjects, isMainCheckout } from '../workspaces/discovery.js';
import { cloneProject, createProject, defaultProjectsHome, initProject } from '../workspaces/new-project.js';
import { sameRepo } from '../shared/repo-key.js';
import { listMyReposHere } from '../workspaces/github-repos.js';
import { projectId } from '../workspaces/manager.js';
import { SUGGEST_ALL, chooseProjectIcon, readProjectIcon, suggestProjects } from '../core/project-icons.js';
import type { Args, Method } from './api.js';
import { NETWORK_HANDLERS } from './network-handlers.js';
import { STRIPE_HANDLERS } from './stripe-handlers.js';
import { REVENUECAT_HANDLERS } from './revenuecat-handlers.js';
import { SUPPORT_HANDLERS } from './support-handlers.js';
import { STATS_HANDLERS } from './stats-handlers.js';
import { maybeStatsOf } from '../core/stats/counter.js';
import { WEB_HANDLERS } from './web-handlers.js';
import { DIAGNOSTICS_HANDLERS } from './diagnostics-handlers.js';
import { CLAUDE_CODE_HANDLERS } from './claude-code-handlers.js';
import { STEPS_HANDLERS } from './steps-handlers.js';
import { EXTERNAL_HANDLERS } from './external-handlers.js';
import { GATEWAY_HANDLERS } from './gateway-handlers.js';
import { BOARD_HANDLERS } from './board-handlers.js';
import { DASHBOARD_HANDLERS } from './dashboard-handlers.js';
import { SENTINEL_HANDLERS } from './sentinel-handlers.js';
import { PLANS_HANDLERS } from './plans-handlers.js';
import { plansOf } from '../core/plans/registry.js';
import { stopChat, stopThreadsUnder } from '../core/threads/launch.js';
import { DIALOGUES_HANDLERS } from './dialogues-handlers.js';
import { ISSUES_HANDLERS } from './issues-handlers.js';
import { CI_HANDLERS } from './ci-handlers.js';
import { TEAM_HANDLERS } from './team-handlers.js';
import { TRIAGE_HANDLERS } from './triage-handlers.js';
import { GIT_HANDLERS } from './git-handlers.js';
import { VIEWS_HANDLERS } from './views-handlers.js';
import { PREVIEW_HANDLERS } from './preview-handlers.js';
import { FILES_EDIT_HANDLERS } from './files-handlers.js';
import { COMPANION_HANDLERS } from './companion-handlers.js';
import { MACHINE_HANDLERS } from './machine-handlers.js';
import { ASSISTANT_HANDLERS } from './assistant-handlers.js';
import { VOICE_HANDLERS } from './voice-handlers.js';
import { CALLS_HANDLERS } from './calls-handlers.js';
import { TERMINAL_IMPORT_HANDLERS } from './terminal-import-handlers.js';
import { AGENT_TERM_HANDLERS } from './agent-term-handlers.js';
import { worktreePorts } from '../workspaces/ports.js';
import { waitingNeeds } from '../companion/needs-you.js';
import { saveDismissedNeeds, withDismissed } from '../core/dismissed-needs.js';

/**
 * What each API method does (see api.ts for the list and its arguments). Runs in the core:
 * in the daemon for every connected client, or in-process (tests).
 * Results are plain data (they cross a socket).
 */
type Handler<M extends Method> = (s: Session, ...args: Args<M>) => unknown;
export type Handlers = { readonly [M in Method]: Handler<M> };

// Without projects (some tests, the guest-only mode) these do nothing, as before.
const ctl = (s: Session): WorkspaceController | undefined => s.workspaces;
/** Continue On's part here (BLG-808): it needs the workspaces. */
const moverIn = (s: Session): WorktreeMover => {
  const c = ctl(s);
  if (!c) throw new Error('Worktrees need the Beluga app (its daemon)');
  return worktreeMover(s.store, c);
};
const rootOf = (s: Session, projectId: string): string | undefined => s.store.getState().projects.find((p) => p.id === projectId)?.root || undefined;
const expandHome = (p: string): string => p.replace(/^~(?=$|\/)/, os.homedir());
const bench = (s: Session): Workbench | undefined => s.workbench;

/** Pull a file from a friend's share through this session's connection. */
const fetchShared = (s: Session): FetchShared => (at, max) => fetchBytes(at, s.files.request.bind(s.files), max);

/** A terminal program started (or already running), by key; undefined when it couldn't start. */
const started = (pty: { id: string } | undefined): string | undefined => pty?.id;

export const HANDLERS = {
  // Your prompts count for your stats here, where you typed them (core/stats/counter.ts).
  'session.submit': (s, raw, opts) => {
    maybeStatsOf(s)?.prompt(opts?.channel, raw);
    return s.submit(raw, opts);
  },
  'session.copyInvite': (s) => s.copyInvite(),
  'session.copyLastAnswer': (s) => s.copyLastAnswer(),
  'session.copyText': (s, text, success) => s.copyText(text, success),
  'session.setPrefs': (s, prefs) => s.setPrefs(prefs),
  'session.setPlanMode': (s, channel, on) => s.setPlanMode(channel, on),
  'session.setClaudeSharing': (s, policy) => s.setClaudeSharing(policy),
  'session.rename': (s, name) => s.rename(name),
  'session.zoom': (s, dir) => s.zoom(dir),
  'session.shareFolder': (s, dir, writable, only) => s.shareFolder(dir, writable, only),
  'session.unshareFolder': (s, name) => s.unshareFolder(name),
  'session.follow': (s, name) => s.follow(name),
  'session.clearChat': (s, channel, opts) => s.clearChat(channel, opts),
  'session.react': (s, channel, id, emoji, on) => s.reactChat(channel, id, emoji, on),
  'session.removePerson': (s, peerId) => s.removePerson(peerId),
  'session.newInviteLink': (s) => s.newInviteLink(),
  'session.setRoomOpen': (s, open) => s.setRoomOpen(open),
  'session.retryConnection': (s) => s.retryConnection(),
  'session.setFriendWorktrees': (s, value) => s.setFriendWorktrees(value),
  'session.setAccess': (s, peerId, scope) => s.setAccess(peerId, scope),
  'session.runOnPeerByHand': (s, name, command, channel) => s.runOnPeerByHand(name, command, channel),
  'session.stopAgent': (s) => s.stopAgent(),
  'session.compact': (s, channel, instructions) => s.compact(channel, instructions),
  'session.btw': (s, channel, question) => s.btw(channel, question),
  'session.btwDismiss': (s, channel) => s.btwDismiss(channel),
  'session.quit': (s) => s.quit(),
  'session.serveFolder': (s, name, root, allowed) => s.serveFolder(name, root, allowed),
  'session.localLocation': (s, abs, dir) => s.localLocation(abs, dir),
  'session.testNotification': (s) => {
    s.notifier.test();
    s.toast('Sent a test notification', 'success');
  },

  'host.answerApproval': (s, answer, id) => s.answerApproval(answer, id),
  'host.promote': (s, requestId, opts) => s.host.promote(requestId, opts),
  'host.sendNext': (s, requestId) => s.host.sendNext(requestId),
  'host.steerNow': (s, requestId) => s.host.steerNow(requestId),
  'host.cancelSteer': (s, requestId) => s.host.cancelSteer(requestId),
  'host.stopRun': (s, channel) => stopChat(s, channel),
  'threads.stop': (s, id): ReturnType<Session['host']['stopRun']> => {
    if (!ctl(s)?.manager.find(id)?.thread) throw new Error('That chat is not a child thread.');
    return HANDLERS['host.stopRun'](s, `ws:${id}`);
  },
  'threads.stopAll': (s, id) => stopThreadsUnder(s, id),
  'host.cancelQueued': (s, requestId) => s.host.cancelQueued(requestId),
  'host.reorderQueued': (s, requestId, index) => s.host.reorderQueued(requestId, index),

  'inbox.read': (s, which) => s.store.dispatch({ type: 'notice_read', ...(which?.channel !== undefined ? { channel: which.channel } : {}), ...(which?.id !== undefined ? { id: which.id } : {}) }),
  'inbox.unread': (s, id) => s.store.dispatch({ type: 'notice_unread', id }),
  'inbox.clear': (s, which) => s.store.dispatch({ type: 'notice_clear', ...(which?.id !== undefined ? { id: which.id } : {}) }),

  'questions.answer': (s, qid, answer) => s.questions.answer(qid, answer),
  'questions.pick': (s, qid, question, answer) => s.store.dispatch({ type: 'question_pick', qid, question, answer }),

  'people.setTrust': (s, peerId, level) => s.people.setTrust(peerId, level),
  'people.dismissPrompt': (s, peerId) => s.people.dismissPrompt(peerId),
  'needs.dismiss': (s, needId) => {
    const live = new Set(waitingNeeds(s.store.getState()).map((n) => n.id));
    const ids = withDismissed(s.store.getState().dismissedNeeds, needId, live);
    s.store.dispatch({ type: 'needs_dismissed', ids });
    saveDismissedNeeds(ids);
  },
  'people.forget': (s, peerId) => s.people.forget(peerId),

  'sharing.invite': (s, wsId, peerId, role) => {
    const ok = s.sharing.invite(wsId, peerId, role);
    void s.workspaces?.refresh();
    return ok;
  },
  'sharing.remove': (s, wsId, peerId) => s.sharing.remove(wsId, peerId),
  'sharing.leave': (s, owner, id) => s.sharing.leave(owner, id),
  'sharing.shareWithFriend': (s, share) => s.sharing.shareWithFriend(share),
  'sharing.unshareFriend': (s, share) => s.sharing.unshareFriend(share),
  'sharing.leaveProject': (s, owner, projectId) => needFriendShares(s).leave(owner, projectId),
  'sharing.copyProject': (s, owner, projectId) => needFriendShares(s).makeCopy(owner, projectId),
  'sharing.earlier': (s, owner, wsId) => needFriendShares(s).earlier(owner, wsId),
  'sharing.runHere': (s, owner, wsId, prompt) => needFriendShares(s).runHere(owner, wsId, prompt),
  'sharing.fork': (s, owner, wsId, name) => needFriendShares(s).fork(owner, wsId, name),
  'sharing.scratch': (s, owner, wsId) => {
    if (!s.store.getState().shared.some((w) => w.owner === owner && w.id === wsId)) throw new Error('That worktree isn’t shared with you');
    return remoteScratch(owner, wsId, (at, o) => s.listFiles(at, o));
  },

  'invites.create': async (s, opts) => {
    const link = await s.invites.create(opts);
    return link?.id;
  },
  'invites.revoke': (s, id) => s.invites.revoke(id),
  'invites.copyLink': (s, id) => s.invites.copyLink(id),
  'invites.letIn': (s, peerId, can) => s.invites.letIn(peerId, can),
  'invites.decline': (s, peerId) => s.invites.decline(peerId),
  'invites.change': (s, peerId, patch) => s.invites.change(peerId, patch),
  'invites.remove': (s, peerId) => s.invites.remove(peerId),

  'remote.requestWorktree': (s, peerId, project, task, plan) => s.remote.requestWorktree(peerId, project, task, plan),
  'remote.handoff': (s, wsId, peerId) => s.remote.handoff(wsId, peerId),
  'remote.canHandOff': (s, wsId, peerId) => s.remote.canHandOff(wsId, peerId),

  'diff.load': (s, id) => s.diff.load(id),
  'diff.select': (s, index) => s.diff.select(index),
  'shell.run': (s, id, line) => s.shell.run(id, line),
  'shell.openEntry': (s, id, rel, dir) => s.shell.openEntry(id, rel, dir),

  'files.browseTo': (s, at) => s.browseTo(at),
  'files.enter': (s, index) => s.browserEnter(index),
  'files.up': (s) => s.browserUp(),
  'files.loadDir': (s, at) => s.loadDir(at),
  'files.open': (s, at, opts) => s.openLocation(at, opts),
  'files.openSpec': (s, spec) => s.openSpec(spec),
  'files.download': (s, at, opts) => s.download(at, opts?.to !== undefined ? { to: opts.to } : {}),
  'files.downloadSpec': (s, spec) => s.downloadSpec(spec),
  'files.closeViewer': (s) => s.store.dispatch({ type: 'viewer_close' }),
  'files.readImage': (s) => {
    const image = s.store.getState().viewer?.image;
    return image ? { width: image.width, height: image.height, data: Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength).toString('base64') } : undefined;
  },
  'files.readImageFile': async (s, at) => {
    const { mediaType, bytes } = await s.files.readImageFile(at);
    return { mediaType, data: bytes.toString('base64') };
  },
  'files.version': (s, at) => s.files.fileVersion(at),
  'files.read': (s, at) => s.files.readFile(at),
  'files.readRange': (s, at, range) => s.files.readRange(at, range),

  'workspaces.open': (s, id, tab, o) => ctl(s)?.open(id, tab, o?.req),
  'workspaces.load': (s, id) => void ctl(s)?.ensureLoaded(id),
  'workspaces.refresh': (s) => ctl(s)?.refresh(),
  'workspaces.newWorktree': async (s, projectId, name, opts) => (await ctl(s)?.newWorktree(projectId, name, { ...(opts?.base ? { base: opts.base } : {}), ...(opts?.agent ? { agent: opts.agent } : {}) }))?.id,
  'workspaces.newChat': async (s, projectId, title, dir) => (await ctl(s)?.newChat(projectId, title, dir))?.id,
  'workspaces.startChat': (s, projectId, text, dir, opts) => (maybeStatsOf(s)?.prompt(`new-chat:${projectId}`, text), ctl(s)?.startChat(projectId, text, dir ?? undefined, { ...(opts?.terminal ? { terminal: true } : {}), ...(opts?.plan ? { plan: true } : {}) })),
  'workspaces.startWorktree': async (s, projectId, text, opts) => (maybeStatsOf(s)?.prompt(`new-worktree:${projectId}`, text, opts?.agent?.runtime), await ctl(s)?.startWorktree(projectId, text, (prompt) => s.nameTask(prompt), { ...(opts?.base ? { base: opts.base } : {}), ...(opts?.name ? { name: opts.name } : {}), ...(opts?.plan ? { plan: true } : {}), ...(opts?.tasks ? { tasks: true } : {}), ...(opts?.quiet ? { quiet: true } : {}), ...(opts?.agent ? { agent: opts.agent } : {}), ...(opts?.terminal ? { terminal: true } : {}), nameLater: true }))?.id,
  'workspaces.branches': (s, projectId) => ctl(s)?.branches(projectId),
  'workspaces.fork': async (s, id, name) => (await ctl(s)?.fork(id, name))?.id,
  'workspaces.editPrompt': (s, id, line, text, mode) => ctl(s)?.editPrompt(id, line, text, mode),
  'workspaces.continueInWorktree': async (s, id, opts) =>
    // Claude starts there once whatever runs in the conversation now has finished (its session is complete then).
    (await ctl(s)?.continueInWorktree(id, (prompt) => s.nameTask(prompt), { ...(opts?.task ? { task: opts.task } : {}), ...(opts?.base ? { base: opts.base } : {}), ...(opts?.name ? { name: opts.name } : {}), ...(opts?.agent ? { agent: opts.agent } : {}), after: s.host.idle(`ws:${id}`) }))?.id,
  'workspaces.moveCheck': (s, id) => moverIn(s).check(id),
  'workspaces.movePack': (s, id, opts) => moverIn(s).packOut(id, opts),
  'workspaces.moveChunk': (s, token, n) => moverIn(s).chunk(token, n),
  'workspaces.moveReceive': (s, token, n, total, data) => moverIn(s).receive(token, n, total, data),
  'workspaces.moveLand': (s, token, projectId, from) => moverIn(s).landIn(token, projectId, from),
  'workspaces.moveDone': (s, id, to) => moverIn(s).done(id, to),
  'workspaces.moveUndo': (s, id) => moverIn(s).undo(id),
  'workspaces.archive': (s, id, force, opts) => ctl(s)?.archive(id, force, opts),
  'workspaces.restore': (s, id) => ctl(s)?.restore(id),
  'workspaces.archivePlan': (s, id) => ctl(s)?.archivePlan(id),
  'workspaces.deletePlan': (s, id) => ctl(s)?.deletePlan(id),
  'workspaces.freeSpace': (s, id) => ctl(s)?.freeSpace(id),
  'workspaces.remove': (s, id, opts) => ctl(s)?.remove(id, opts),
  'workspaces.commit': (s, id, message) => ctl(s)?.commit(id, message),
  'workspaces.merge': (s, id) => ctl(s)?.merge(id),
  'workspaces.prepareRemoval': (s, id) => ctl(s)?.prepareRemoval(id),
  'workspaces.applyEnvBack': (s, id) => ctl(s)?.applyEnvBack(id),
  'workspaces.keepEnvHere': (s, id) => ctl(s)?.keepEnvHere(id),
  'workspaces.saveEnvInBeluga': (s, id) => ctl(s)?.saveEnvInBeluga(id),
  'workspaces.checkEnv': (s, projectId) => ctl(s)?.checkEnv(projectId, false),
  'workspaces.ports': (s, id) => {
    const ws = s.store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.id === id);
    return ws ? worktreePorts(ws.path) : [];
  },
  'workspaces.askClaudeToReview': (s, id) => ctl(s)?.askClaudeToReview(id),
  'workspaces.askClaudeToMerge': (s, id) => ctl(s)?.askClaudeToMerge(id),
  'workspaces.compact': (s, id, instructions) => ctl(s)?.compact(id, instructions),
  'workspaces.openInFinder': (s, id) => ctl(s)?.openInFinder(id),
  'workspaces.setGroup': (s, projectId, group) => ctl(s)?.setGroup(projectId, group),
  'workspaces.renameGroup': (s, from, to) => ctl(s)?.renameGroup(from, to),
  'workspaces.rename': (s, id, name) => ctl(s)?.rename(id, name),
  'workspaces.regenerateTitle': (s, id) => ctl(s)?.regenerateTitle(id),
  'workspaces.ungroup': (s, name) => ctl(s)?.ungroup(name),
  'workspaces.arrange': (s, item, place) => ctl(s)?.arrange(item, place ?? {}) ?? false,
  'workspaces.newGroup': (s, name, opts) => ctl(s)?.newGroup(name, opts ?? {}),
  'workspaces.showProject': (s, root) => ctl(s)?.showProject(root) ?? false,
  'workspaces.hideProject': (s, projectId) => ctl(s)?.hideProject(projectId),
  'workspaces.removeProject': (s, projectId, opts) => ctl(s)?.removeProject(projectId, opts?.trash ?? false) ?? false,
  'workspaces.cleanAgentWorktrees': (s, projectId) => ctl(s)?.cleanAgentWorktrees(projectId),
  'workspaces.otherOrigins': (s, projectId) => ctl(s)?.others.origins(projectId) ?? {},
  'workspaces.otherActivity': (s, projectId) => ctl(s)?.others.activity(projectId) ?? {},
  'workspaces.worktreeInfo': (s, id) => ctl(s)?.others.info(id),
  'workspaces.showConversation': (s, id, sessionId) => ctl(s)?.showConversation(id, sessionId) ?? false,
  'workspaces.outsideConversations': (s, projectId, dir) => ctl(s)?.outsideConversations(projectId, dir) ?? { dir: dir ?? '', conversations: [] },
  'workspaces.importOutside': (s, projectId, dir, sessionId, name) => ctl(s)?.importOutside(projectId, dir, sessionId, name),
  'workspaces.removeOther': (s, id, force) => ctl(s)?.removeOther(id, force ?? false) ?? false,
  'workspaces.staleOthers': (s, projectId, source) => ctl(s)?.others.stale(projectId, source) ?? [],
  'workspaces.cleanUpOthers': (s, projectId, ids) => ctl(s)?.others.cleanUp(projectId, ids),
  'workspaces.addProject': (s, dir) => ctl(s)?.addProject(dir),
  'workspaces.addFolder': (s, dir) => ctl(s)?.addFolder(dir),
  'workspaces.selectFile': (s, index) => ctl(s)?.selectFile(index),
  'workspaces.diffAhead': (s, index) => ctl(s)?.diffAhead(index),
  'workspaces.review': (s, id) => ctl(s)?.loadReview(id),
  'workspaces.scratch': (s, id) => ctl(s)?.scratch(id),

  'workbench.run': (s, wsId) => started(bench(s)?.run(wsId)),
  'workbench.stopRun': (s, wsId) => bench(s)?.stopRun(wsId),
  'workbench.runSetup': (s, wsId) => bench(s)?.runSetup(wsId),
  'workbench.setScript': (s, projectId, kind, command, team) => bench(s)?.setScript(projectId, kind, command, team),
  'workbench.shareScripts': (s, projectId) => bench(s)?.shareScripts(projectId),
  'workbench.setAgent': (s, channel, agent, mode) => s.workbench?.setAgent(channel, agent ?? undefined, mode) ?? false,
  'workbench.setModel': (s, channel, value) => (s.workbench ? s.workbench.setModel(channel, value) : s.setPrefs({ model: value || undefined })),
  'workbench.setEffort': (s, channel, effort) => (s.workbench ? s.workbench.setEffort(channel, effort || undefined) : s.setPrefs({ effort: effort || null })),
  'workbench.createPr': (s, id, extra) => bench(s)?.createPr(id, extra),
  'workbench.quickPr': (s, id, opts) => bench(s)?.quickPr(id, opts),
  'workbench.mergeToBase': (s, id, opts) => bench(s)?.mergeToBase(id, opts),
  'workbench.gitFix': (s, id, fix, retry) => bench(s)?.gitFix(id, fix, retry),
  'workbench.signInClaude': (s, key, channel, how) => bench(s)?.signInClaude(key, channel, how),
  'workbench.fixChecks': (s, id) => bench(s)?.fixChecks(id),
  'workbench.resolvePrConflicts': (s, id) => bench(s)?.resolvePrConflicts(id),
  'workbench.continueAfterMerge': (s, id) => bench(s)?.continueAfterMerge(id),
  'workbench.openPr': (s, id) => bench(s)?.openPr(id),
  'workbench.mergePr': (s, id, opts) => bench(s)?.mergePr(id, opts),
  'workbench.prStep': (s, id, step) => bench(s)?.prStep(id, step),
  'workbench.pushPr': (s, id) => bench(s)?.pushPr(id),
  'workbench.rerunChecks': (s, id) => bench(s)?.rerunChecks(id),
  'workbench.prConversation': (s, id) => bench(s)?.prConversation(id),
  'workbench.prPost': (s, id, post) => bench(s)?.prPost(id, post),
  'workbench.addressPrComments': (s, id, thread) => bench(s)?.addressPrComments(id, thread),
  'workbench.openCode': (s, id, file, line) => bench(s)?.openCode(id, file, line),
  'workbench.excerpt': (s, id, file, from, to) => bench(s)?.excerpt(id, file, from, to),
  'workbench.cancelMergeWhenReady': (s, id) => bench(s)?.cancelMergeWhenReady(id),
  'workbench.refreshPrs': (s, only, recheckGh) => {
    // Back to the window: the plans' pull requests are looked at too, as the worktrees' are.
    if (typeof only === 'object' && only.reason === 'focus') void plansOf(s)?.pilot.pollPrs('focus').catch(() => undefined);
    return typeof only === 'object' ? bench(s)?.pollPrs(only.reason, only.id) : bench(s)?.refreshPrs(only, recheckGh);
  },
  'workbench.editPrPrompt': (s) => bench(s)?.editPrPrompt(),
  'workbench.resetPrPrompt': (s) => bench(s)?.resetPrPrompt(),
  'workbench.measureDisk': (s) => bench(s)?.measureDisk(),
  'workbench.checkAgents': async (s) => (await bench(s)?.checkAgents()) ?? s.store.getState().runtimes,
  'workbench.agentSignIn': (s, runtime) => bench(s)?.agentSignIn(runtime) ?? false,
  'workbench.search': (s, query) => bench(s)?.search(query),
  'workbench.openHit': (s, index) => bench(s)?.openHit(index),
  'workbench.saveTemplate': (s, text, plan) => bench(s)?.saveTemplate(text, plan),
  'workbench.removeTemplate': (s, id) => bench(s)?.removeTemplate(id),

  'terminals.shell': (s, wsId, size) => started(bench(s)?.shell(wsId, size)),
  'terminals.global': (s, key, dir, size) => started(bench(s)?.globalShell(key, dir, size)),
  'terminals.close': (s, key) => bench(s)?.closeTerminal(key),
  'terminals.restart': (s, key) => started(bench(s)?.restartTerminal(key)),
  'terminals.rename': (s, key, name) => bench(s)?.renameTerminal(key, name),

  // The values go back only to the screen that asked (Settings), never into the shared state.
  'env.get': (s, projectId) => s.env.get(projectId),
  'env.set': (s, projectId, rows, dotenv) => s.env.set(projectId, rows, dotenv),
  'env.claudeDotenv': (s, projectId, on) => s.env.setClaudeDotenv(projectId, on),
  'env.testDatabase': (s, projectId) => testDatabase(s.env.viewEnvOf(projectId)),
  'env.importDotenv': (s, projectId) => s.env.importDotenv(projectId),
  'env.newKeysBack': (s, projectId, on) => s.env.setNewKeysBack(projectId, on),
  'env.endpoints': (s) => s.local.views(),
  'env.saveEndpoint': async (s, change) => {
    const saved = s.env.saveEndpoint(change);
    await s.local.look();
    return saved;
  },
  'env.removeEndpoint': async (s, id) => {
    s.env.removeEndpoint(id);
    await s.local.look();
  },
  'env.checkEndpoints': async (s) => {
    await s.local.look();
    return s.local.views();
  },

  'attachments.add': async (_s, ext, base64) => {
    const bytes = Buffer.from(base64, 'base64');
    const file = await saveImageBytes(bytes, ext);
    const a = registerAttachment(file, bytes.byteLength);
    return { n: a.n, chip: chipText(a.n), file: path.basename(file) };
  },
  'attachments.addFile': async (_s, file) => {
    const info = pathInfo(file);
    if (info.kind !== 'file' || !info.image) throw new Error(`${info.name} isn't an image file here`);
    const saved = await importImageFitting(info.path);
    const a = registerAttachment(saved, statSync(saved).size);
    return { n: a.n, chip: chipText(a.n), file: path.basename(saved) };
  },
  'attachments.reattach': (_s, file) => {
    const a = reattach(file);
    if (!a) throw new Error('That image is gone from this computer');
    return { n: a.n, chip: chipText(a.n), file: path.basename(a.path) };
  },
  'attachments.expand': (s, text, channel, only, shown) => {
    if (!text.includes('[image ') || text.startsWith('/')) return text;
    const state = s.store.getState();
    const friends = state.peers.filter((p) => p.peerId !== s.selfId).map((p) => p.peerId);
    const toRoom = channel === 'room' && friends.length > 0;
    // Sent to the room with friends there, a copy goes where they (and only they) can fetch it.
    const out = expandChips(text, s.selfId, toRoom ? (a) => publishForRoom(a) : (a) => path.basename(a.path), only, shown);
    if (toRoom && out.attachments.length) s.serveFolder(ATTACHMENT_SHARE, roomAttachmentsDir(), friends);
    return out.text;
  },

  'attachments.read': async (s, owner, file) => {
    const bytes = await readAttachment(owner, file, s.selfId, fetchShared(s));
    return { mime: mediaTypeOf(file), size: bytes.byteLength, data: bytes.toString('base64') };
  },
  'attachments.open': async (s, owner, file) => openWithSystem(await attachmentOnDisk(owner, file, s.selfId, fetchShared(s))),

  'daemon.stop': (s) => s.shutdown(),

  'projects.icon': (s, projectId) => {
    const root = rootOf(s, projectId);
    return root ? readProjectIcon(root) : undefined;
  },
  'projects.setIcon': (s, projectId, image) => {
    const root = rootOf(s, projectId);
    if (!root) throw new Error('No such project');
    chooseProjectIcon(root, image ? expandHome(image) : undefined);
  },
  // A git project is added; a folder of them is watched (new ones in it show up too).
  // → what it did, or why it couldn't (the Add projects sheet shows it on the folder's row).
  'projects.add': async (s, dir): Promise<AddResult> => {
    const abs = expandHome(dir);
    if (isMainCheckout(abs)) return (await ctl(s)?.addProject(abs)) ?? {};
    if (findProjects([abs]).length) return (await ctl(s)?.addFolder(abs)) ?? {};
    const plain = existsSync(abs);
    const error = plain ? `${path.basename(abs)} isn't a git project yet` : `${abs} isn't there`;
    s.toast(error, 'warn');
    // A plain folder: the Add projects sheet offers to set up git there (projects.initGit).
    return plain ? { error, canInit: true } : { error };
  },
  // Make a plain folder a git project (git, a .gitignore, a first commit), then add it.
  'projects.initGit': async (s, dir): Promise<AddResult> => (await ctl(s)?.addProject(await initProject(expandHome(dir)))) ?? {},
  'projects.addFolder': (s, dir) => ctl(s)?.addFolder(expandHome(dir)),
  'projects.origin': async (s, projectId) => {
    const root = rootOf(s, projectId);
    if (!root) return null;
    return (await git(root, ['remote', 'get-url', 'origin'], 5_000).catch(() => '')).trim() || null;
  },
  'projects.iconAt': (_s, dir) => readProjectIcon(expandHome(dir)),
  // Every repo found (the sheet shows the newest, and its Filter searches them all).
  'projects.suggest': (s) => suggestProjects(s.store.getState().projects.map((p) => p.root).filter(Boolean), undefined, SUGGEST_ALL),
  'projects.create': async (s, name, parent) => {
    const dir = await createProject(name, parent ? expandHome(parent) : undefined);
    const added = await ctl(s)?.addProject(dir);
    return { id: added?.project?.id ?? projectId(dir), path: dir };
  },
  // A repository you have here already is the project it is, not a second clone.
  'projects.clone': async (s, url, parent) => {
    const projects = s.store.getState().projects.filter((p) => p.root);
    const origins = await Promise.all(projects.map((p) => tryGit(p.root, ['remote', 'get-url', 'origin'])));
    const here = projects.find((_, i) => origins[i] && sameRepo(origins[i]!.trim(), url.trim()));
    if (here) return { id: here.id, path: here.root, existed: true };
    const dir = await cloneProject(url, parent ? expandHome(parent) : undefined);
    const added = await ctl(s)?.addProject(dir);
    if (added?.error) throw new Error(added.error);
    return { id: added?.project?.id ?? projectId(dir), path: dir };
  },
  'projects.newHome': () => defaultProjectsHome(),
  'projects.myRepos': (s) => {
    const roots = s.store.getState().projects.map((p) => p.root).filter(Boolean);
    return listMyReposHere(async () => (await Promise.all(roots.map((r) => tryGit(r, ['remote', 'get-url', 'origin'])))).flatMap((o) => (o?.trim() ? [o.trim()] : [])));
  },
  'local.listDirs': (s, dir) => {
    const entries = listLocalDirs(dir);
    s.store.dispatch({ type: 'dir_cache', key: localDirKey(dir), entries });
    return entries;
  },
  'local.browse': (_s, dir) => browseDir(dir),
  'local.openFolder': (_s, dir) => openWithSystem(dir),
  'local.statFiles': (_s, paths) => paths.map(pathInfo),
  ...NETWORK_HANDLERS,
  ...STRIPE_HANDLERS,
  ...REVENUECAT_HANDLERS,
  ...SUPPORT_HANDLERS,
  ...STATS_HANDLERS,
  ...WEB_HANDLERS,
  ...DIAGNOSTICS_HANDLERS,
  ...CLAUDE_CODE_HANDLERS,
  ...STEPS_HANDLERS,
  ...EXTERNAL_HANDLERS,
  ...GATEWAY_HANDLERS,
  ...BOARD_HANDLERS,
  ...SENTINEL_HANDLERS,
  ...DASHBOARD_HANDLERS,
  ...PLANS_HANDLERS,
  ...DIALOGUES_HANDLERS,
  ...ISSUES_HANDLERS,
  ...CI_HANDLERS,
  ...TEAM_HANDLERS,
  ...TRIAGE_HANDLERS,
  ...GIT_HANDLERS,
  ...VIEWS_HANDLERS,
  ...PREVIEW_HANDLERS,
  ...FILES_EDIT_HANDLERS,
  ...COMPANION_HANDLERS,
  ...MACHINE_HANDLERS,
  ...ASSISTANT_HANDLERS,
  ...VOICE_HANDLERS,
  ...CALLS_HANDLERS,
  ...TERMINAL_IMPORT_HANDLERS,
  ...AGENT_TERM_HANDLERS,
} satisfies Handlers;

export type Result<M extends Method> = Awaited<ReturnType<(typeof HANDLERS)[M]>>;
