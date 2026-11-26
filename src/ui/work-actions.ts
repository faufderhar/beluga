import { EFFORTS, TRUST_LEVELS, type TrustLevel } from '../shared/settings-schema.js';
import { channelOf } from '../core/store.js';
import { cursorFor } from '../shared/templates-text.js';
import { MOUSE_OFF, MOUSE_ON } from './tty/codes.js';
import type { MenuContext } from './menu-actions.js';
import type { MenuKind } from './menus.js';
import { agentPicker } from '../shared/agent-picker.js';
import { TUNNEL_ORDER, type SettingsSection, myAgentPicker } from './settings-menus.js';
import { joinArgs } from '../shared/shells.js';
import type { WorkspaceAction } from './workspace-models.js';
import { NOTICE_FILTERS } from './notice-models.js';
import { nextDnd } from '../shared/quiet.js';
import { toggledSound } from '../shared/notify-sound.js';

const SECTIONS: readonly SettingsSection[] = ['claude', 'notify', 'workspaces', 'people', 'display', 'buttons', 'terminal', 'env'];
type NotifyKey = 'desktop' | 'sound' | 'done' | 'needsYou' | 'problems' | 'people' | 'pr' | 'mentions' | 'background' | 'onlyAway';

/**
 * Options in the settings sections, the inbox, the model picker and the workspace menus
 * (PR, scripts, templates, remote worktrees). Returns false when it isn't one of these.
 */
export function runWorkOption(ctx: MenuContext, menu: MenuKind, id: string, index: number): boolean {
  const { client, patchUi, typeInto } = ctx;
  const { api } = client;
  const latest = client.store.getState();
  const prefs = latest.prefs;
  const bench = api.workbench;
  const setPrefs = (patch: Parameters<typeof api.session.setPrefs>[0]): void => void api.session.setPrefs(patch);
  const toast = (text: string): void => client.store.dispatch({ type: 'toast', text });
  const reopen = (): void => patchUi({ menu: { menu, selected: index } });
  const section = (s?: SettingsSection): void => patchUi({ menu: { menu: { kind: 'settings', ...(s ? { section: s } : {}) }, selected: 0 } });

  if (id.startsWith('sec:')) {
    const s = id.slice(4) as SettingsSection;
    if (SECTIONS.includes(s)) section(s);
    return true;
  }
  if (id === 'set-back') {
    section(undefined);
    return true;
  }
  if (id === 'set-back-workspaces') {
    section('workspaces');
    return true;
  }
  if (id === 'n-dnd') {
    setPrefs({ notify: { ...prefs.notify, dnd: nextDnd(prefs.notify) } });
    reopen();
    return true;
  }
  if (id.startsWith('notice-x:') && menu.kind === 'inbox') {
    void api.inbox.clear({ id: Number(id.slice('notice-x:'.length)) });
    // The row below moves up into this place (the last one: the one above).
    patchUi({ menu: { menu, selected: Math.max(0, Math.min(index, latest.inbox.length - 2)) } });
    return true;
  }
  if (menu.kind === 'inbox' && (id === 'inbox-filter' || id === 'inbox-manage' || id === 'inbox-back')) {
    const at = NOTICE_FILTERS.findIndex((f) => f.value === (menu.filter ?? 'all'));
    if (id === 'inbox-filter') patchUi({ menu: { menu: { ...menu, filter: NOTICE_FILTERS[(at + 1) % NOTICE_FILTERS.length]!.value }, selected: index } });
    else patchUi({ menu: { menu: { kind: 'inbox', ...(menu.filter ? { filter: menu.filter } : {}), ...(id === 'inbox-manage' ? { manage: true } : {}) }, selected: 0 } });
    return true;
  }
  if (id.startsWith('n-') && id !== 'n-test') {
    const key = id.slice(2) as NotifyKey;
    if (key === 'sound') setPrefs({ notify: { ...prefs.notify, ...toggledSound(prefs.notify) } });
    else if (key in prefs.notify) setPrefs({ notify: { ...prefs.notify, [key]: !prefs.notify[key] } });
    reopen();
    return true;
  }
  if (id.startsWith('sh:')) {
    setPrefs({ shell: id.slice(3) });
    toast(`New shells use ${id.slice(3)}`);
    reopen();
    return true;
  }
  if (id.startsWith('env:')) {
    typeInto(`/env ${id.slice(4)}=`);
    toast('Type the new value, or leave it empty to remove it, then Enter');
    return true;
  }
  if (id.startsWith('btn:')) {
    const name = id.slice(4);
    setPrefs({ hiddenButtons: prefs.hiddenButtons.includes(name) ? prefs.hiddenButtons.filter((b) => b !== name) : [...prefs.hiddenButtons, name] });
    reopen();
    return true;
  }
  if (id.startsWith('model:') && menu.kind === 'model') {
    const model = id.slice('model:'.length);
    const mine = latest.prefs.defaultAgent;
    // New conversations on an agent other than Claude: the model goes with that agent (Settings' model is Claude's).
    if (!menu.channel && mine && mine.runtime !== 'claude') setPrefs({ defaultAgent: { runtime: mine.runtime, label: mine.label, ...(model ? { model } : {}) } });
    else void bench.setModel(menu.channel, model);
    return true;
  }
  if (id.startsWith('agent:') && menu.kind === 'model' && menu.channel) {
    const [runtime = '', ...rest] = id.slice('agent:'.length).split(':');
    const model = rest.join(':');
    const group = myAgentPicker(latest, menu.channel).groups.find((g) => g.runtime === runtime && g.available);
    // A local endpoint that isn't answering stays where it is (its row says why).
    if (group?.models.find((m) => m.value === model)?.why) return true;
    if (group) void bench.setAgent(menu.channel, group.isDefault && !model ? null : { runtime, label: group.label, ...(model ? { model } : {}) });
    return true;
  }
  if (id.startsWith('runtime:') && menu.kind === 'model') return true;
  if (id.startsWith('trust:') && menu.kind === 'person') {
    const peer = latest.peers[menu.index];
    const level = id.slice('trust:'.length) as TrustLevel;
    if (peer && TRUST_LEVELS.includes(level)) void api.people.setTrust(peer.peerId, level);
    reopen();
    return true;
  }
  if (id.startsWith('p-person:')) {
    const at = latest.peers.findIndex((p) => p.peerId === id.slice('p-person:'.length));
    if (at >= 0) patchUi({ menu: { menu: { kind: 'person', index: at }, selected: 0 } });
    return true;
  }
  if (id.startsWith('p-forget:')) {
    void api.people.forget(id.slice('p-forget:'.length));
    reopen();
    return true;
  }
  if (id.startsWith('notice:')) {
    const notice = latest.inbox.find((n) => n.id === Number(id.slice('notice:'.length)));
    void api.inbox.read(notice ? { id: notice.id } : {});
    const channel = notice?.channel;
    if (channel?.startsWith('ws:')) {
      const wsId = channel.slice(3);
      const shared = latest.shared.find((w) => w.id === wsId);
      if (shared) client.store.dispatch({ type: 'view', view: { kind: 'shared', owner: shared.owner, id: wsId, tab: 'chat' } });
      else void api.workspaces.open(wsId);
      patchUi({ focus: 'chat' });
    } else if (channel === 'room') client.store.dispatch({ type: 'view', view: { kind: 'room' } });
    return true;
  }
  if (id.startsWith('tpl:')) {
    const t = latest.templates.find((x) => x.id === id.slice(4));
    if (!t) return true;
    const channel = channelOf(latest.view);
    if (t.plan && channel !== 'draft') void api.session.setPlanMode(channel, true);
    patchUi({ focus: 'chat', buffer: t.prompt, cursor: cursorFor(t.prompt), suggestHidden: true, selected: 0 });
    return true;
  }
  if (id.startsWith('tpl-del:')) {
    void bench.removeTemplate(id.slice('tpl-del:'.length));
    reopen();
    return true;
  }
  if (id.startsWith('wsact:') && menu.kind === 'ws_more') {
    ctx.runUiAction({ type: 'ws', id: menu.id, action: id.slice('wsact:'.length) as WorkspaceAction });
    return true;
  }
  if (id.startsWith('rws:') && menu.kind === 'remote_ws') {
    patchUi({ focus: 'chat', buffer: '', cursor: 0, pending: { kind: 'remote', projectId: id.slice(4), peerId: menu.peerId } });
    const peer = latest.peers.find((p) => p.peerId === menu.peerId);
    toast(`Describe the task for ${peer ? `${peer.name}'s` : 'their'} agent in ${id.slice(4)}, then Enter`);
    return true;
  }
  const wsId = menu.kind === 'pr' ? menu.id : undefined;
  const projectId = menu.kind === 'scripts' ? menu.projectId : undefined;
  switch (id) {
    case 'set-model':
      patchUi({ menu: { menu: { kind: 'model' }, selected: 0 } });
      return true;
    case 'set-effort': {
      const order = [undefined, ...EFFORTS];
      setPrefs({ effort: order[(order.indexOf(prefs.effort) + 1) % order.length] });
      reopen();
      return true;
    }
    case 'set-pr-prompt':
    case 'pr-edit-prompt':
      void bench.editPrPrompt();
      if (id === 'set-pr-prompt') reopen();
      return true;
    case 'set-pr-reset':
      void bench.resetPrPrompt();
      reopen();
      return true;
    case 'set-templates':
      patchUi({ menu: { menu: { kind: 'templates', manage: true }, selected: 0 } });
      return true;
    case 'set-tunnel':
      setPrefs({ tunnel: TUNNEL_ORDER[(TUNNEL_ORDER.indexOf(prefs.tunnel) + 1) % TUNNEL_ORDER.length] ?? 'auto' });
      reopen();
      return true;
    case 'set-mouse':
      ctx.write(prefs.mouse ? MOUSE_OFF : MOUSE_ON);
      setPrefs({ mouse: !prefs.mouse });
      reopen();
      return true;
    case 'p-default': {
      const order = ['ask', 'auto', 'deny'] as const;
      void api.session.setClaudeSharing(order[(order.indexOf(latest.policy) + 1) % order.length] ?? 'ask');
      reopen();
      return true;
    }
    case 'n-test':
      void api.session.testNotification();
      reopen();
      return true;
    case 'w-setup':
      setPrefs({ autoSetup: !prefs.autoSetup });
      reopen();
      return true;
    case 'w-friend':
      void api.session.setFriendWorktrees(prefs.friendWorktrees === 'ask' ? 'off' : 'ask');
      reopen();
      return true;
    case 'sh-other':
      typeInto('/shell ');
      return true;
    case 'sh-login':
      setPrefs({ shellLogin: !prefs.shellLogin });
      reopen();
      return true;
    case 'sh-args':
      typeInto(`/shell args ${joinArgs(prefs.shellArgs)}`);
      return true;
    case 'env-add':
      typeInto('/env ');
      return true;
    case 'w-buttons':
      section('buttons');
      return true;
    case 'd-context':
      setPrefs({ contextMeter: !prefs.contextMeter });
      reopen();
      return true;
    case 'd-subagents': {
      const order = ['full', 'compact', 'hidden'] as const;
      setPrefs({ subagents: order[(order.indexOf(prefs.subagents) + 1) % order.length] ?? 'full' });
      reopen();
      return true;
    }
    case 'inbox-read':
      void api.inbox.read();
      reopen();
      return true;
    case 'inbox-clear':
      void api.inbox.clear();
      return true;
    case 'tpl-save':
      typeInto('/template save ');
      return true;
    case 'tpl-manage':
      patchUi({ menu: { menu: { kind: 'templates', manage: true }, selected: 0 } });
      return true;
    case 'pr-create':
      if (wsId) void bench.createPr(wsId);
      return true;
    case 'pr-create-note':
      typeInto('/pr ');
      return true;
    case 'pr-update':
      if (wsId) void bench.createPr(wsId, 'This pull request already exists: push the new commits and refresh its description.');
      return true;
    case 'pr-fix':
      if (wsId) void bench.fixChecks(wsId);
      return true;
    case 'pr-open':
      if (wsId) void bench.openPr(wsId);
      return true;
    case 'pr-refresh':
      if (wsId) void bench.refreshPrs(wsId).then(() => toast('Pull request status refreshed'));
      return true;
    case 's-setup':
    case 's-run': {
      if (!projectId) return true;
      const kind = id === 's-setup' ? 'setup' : 'run';
      const current = latest.projects.find((p) => p.id === projectId)?.scripts?.[kind]?.command ?? '';
      patchUi({ focus: 'chat', buffer: current, cursor: current.length, suggestHidden: true, pending: { kind, projectId } });
      toast(`Type the ${kind} command (empty to clear), then Enter`);
      return true;
    }
    case 's-team':
      if (projectId) void bench.shareScripts(projectId);
      return true;
    case 'person-remote-ws':
      if (menu.kind === 'person' && latest.peers[menu.index]) patchUi({ menu: { menu: { kind: 'remote_ws', peerId: latest.peers[menu.index]!.peerId }, selected: 0 } });
      return true;
    case 'p-scripts':
      if (menu.kind === 'project') patchUi({ menu: { menu: { kind: 'scripts', projectId: menu.id }, selected: 0 } });
      return true;
    default:
      return false;
  }
}
