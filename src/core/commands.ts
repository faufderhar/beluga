import type { Session } from './session.js';
import type { Policy } from './store.js';
import { THEMES, type ThemeName } from '../shared/settings-schema.js';
import { runEnvCommand, runShellCommand } from './terminal-commands.js';
import { type InvitePlace, friendNamed, inviteRoute, namesLine, parseInvite } from '../shared/invite-route.js';
import { defaultAgentOf } from '../protocol.js';
import { agentLabel, agentName } from '../shared/agent-label.js';
import { builtInInstead } from '../shared/skills.js';
import { ASSISTANT_TITLE, FILE_MANAGER } from '../shared/assistant.js';

/**
 * "~/x" (or "~\\x" on Windows) from your home folder. No node:os here (the screens load this file):
 * Windows has no $HOME, so its USERPROFILE.
 */
const fromHome = (p: string): string => p.replace(/^~(?=$|[\\/])/, () => process.env.HOME || process.env.USERPROFILE || '~');

export interface CommandSpec {
  readonly name: string;
  readonly args?: string;
  readonly desc: string;
}

/** Single source of truth for autocomplete and the help screen. */
export const COMMANDS: readonly CommandSpec[] = [
  { name: 'invite', args: '[@friend]', desc: 'add a friend; with @name, add them to the chat, project or worktree you’re in' },
  { name: 'overview', desc: 'see every worktree at a glance' },
  { name: 'room', desc: 'back to the room chat' },
  { name: 'new', args: '<name>', desc: 'new worktree from the latest origin (in the current project)' },
  { name: 'chat', args: '<title>', desc: 'new chat with your agent in the current project, no worktree' },
  { name: 'review', desc: "see this workspace's changes" },
  { name: 'pr', args: '[extra instructions]', desc: 'your agent opens a pull request with a short description (your PR instructions)' },
  { name: 'run', args: '[@name <command>]', desc: "start the project's run command in the Terminal tab, or run a command on a friend's computer (/run @bob npm test)" },
  { name: 'terminal', desc: "open this workspace's terminal (elsewhere: your own shell, the Terminal tab)" },
  { name: 'setup', desc: "run the project's setup command again in this workspace" },
  { name: 'handoff', args: '<name>', desc: 'share this workspace so someone takes it over; their agent continues it' },
  { name: 'model', args: '[name | agent[:model]]', desc: 'pick the agent and model for this conversation (another agent hands the conversation off)' },
  { name: 'search', args: '<words>', desc: 'search every conversation' },
  { name: 'usage', desc: 'disk space and agent usage per workspace' },
  { name: 'inbox', desc: 'what happened while you were elsewhere' },
  { name: 'template', args: 'save <name>: <prompt>', desc: 'start from a template, or save your own' },
  { name: 'shell', args: '<path>|default|login on|off|args …', desc: 'the shell for the built-in terminal, and how it starts' },
  { name: 'env', args: '[project] KEY=value', desc: 'set an environment variable for your shells, scripts and your agent (KEY= removes it)' },
  { name: 'visualize', args: '[what]', desc: 'your agent draws it as an interactive graph: architecture, a flow, what changed' },
  { name: 'schedule', args: '[prompt]', desc: 'send a prompt into this chat on a schedule, as from Sentinel (Beluga’s app)' },
  { name: 'btw', args: '<question>', desc: 'a side question: Claude answers beside the chat, without stopping or remembering it' },
  { name: 'compact', args: '[focus]', desc: "shrink this conversation's context (your agent keeps what matters)" },
  { name: 'merge', desc: 'merge this worktree into the main folder' },
  { name: 'commit', args: '[message]', desc: 'commit all changes in this workspace' },
  { name: 'fork', args: '<name>', desc: 'copy this workspace and its conversation' },
  { name: 'finder', desc: `open this workspace in ${FILE_MANAGER}` },
  { name: 'archive', desc: 'archive this workspace (keeps branch and conversation)' },
  { name: 'restore', desc: 'bring an archived workspace back' },
  { name: 'delete', desc: 'delete this workspace, its branch and conversation' },
  { name: 'project', args: 'add <path>', desc: 'add a project, "folder <path>" to watch a folder, or "setup|run <command>"' },
  { name: 'copy', desc: "copy your agent's last answer" },
  { name: 'follow', args: '<name>', desc: "follow someone's screen and their agent" },
  { name: 'unfollow', desc: 'stop following' },
  { name: 'open', args: '<file>', desc: 'open a shared file live, e.g. /open bob:api/README.md' },
  { name: 'get', args: '<file>', desc: 'download a shared file to ~/Downloads/Beluga' },
  { name: 'close', desc: 'close the file viewer' },
  { name: 'stop', desc: 'stop your agent' },
  { name: 'policy', args: 'ask|auto|deny', desc: "how friends' requests for your agent are handled" },
  { name: 'trust', args: '<name>', desc: "auto-approve someone's requests this session" },
  { name: 'untrust', args: '<name>', desc: 'require approval again' },
  { name: 'people', desc: "list everyone and what they share" },
  { name: 'share', args: '<folder> [rw]', desc: 'share a folder with the room (read-only unless rw)' },
  { name: 'unshare', args: '<name>', desc: 'stop sharing a folder' },
  { name: 'settings', desc: 'name, theme, sharing, mouse, remote access' },
  { name: 'name', args: '<new name>', desc: 'change the name friends see' },
  { name: 'theme', args: 'calm|light|contrast|mono', desc: 'switch the color theme' },
  { name: 'zoom', args: 'in|out|reset', desc: 'make the text bigger or smaller (also Option+↑ / Option+↓)' },
  { name: 'clear', desc: 'clear this conversation (choose: just you, everyone, or a fresh agent)' },
  { name: 'plan', args: 'on|off', desc: 'your agent plans first and asks you to approve before changing anything' },
  { name: 'remove', args: '<name>', desc: 'host: remove someone from the room (the invite link changes)' },
  { name: 'newlink', desc: 'host: make a new invite link; the old one stops working' },
  { name: 'lock', args: 'on|off', desc: 'host: stop (or allow) new people joining' },
  { name: 'help', desc: 'show keys and commands' },
  { name: 'quit', desc: 'leave the room' },
];

const POLICIES: readonly Policy[] = ['ask', 'auto', 'deny'];
const COMMAND_ALIASES = new Set(['q', 'exit', 'h', '?', 'projects', 'workspaces', 'lobby', 'worktree', 'find', 'space', 'notifications', 'templates', 'e', 'download', 'peers', 'who', 'y', 'yes', 'n', 'no', 'a', 'always', 'graph', 'prefs', 'text']);

/** What /visualize asks Claude (the graph format is in its instructions: agent/graph-prompt.ts). */
export function visualizePrompt(what: string): string {
  const subject = what.trim() || 'what we are working on in this conversation (or, if nothing yet, this project\'s architecture)';
  return [
    `Visualize ${subject} as an interactive graph.`,
    'Look at the real code first if you need to. Answer with one beluga-graph block (more only if one would be',
    'crowded), with a walkthrough when there is a flow to follow, and at most two sentences of prose.',
  ].join(' ');
}

/**
 * `/invite` (BLG-203). On its own: the Add a Friend sheet. With friends named, typed in a worktree:
 * share it with them. The Mac's message boxes route it themselves (they also know DMs, channels and
 * projects, src/shared/invite-route.ts); this is the core's own reading, for any other screen. The
 * worktree goes to them over the Beluga network (BLG-204), room or not; with the network off, a friend
 * in your room still gets it through the room (BLG-340).
 */
function inviteCommand(session: Session, args: readonly string[], channel: string): void {
  const parsed = parseInvite(['/invite', ...args].join(' '));
  if (!parsed?.names.length) return session.intend({ type: 'overlay', overlay: 'add_friend' });
  const state = session.store.getState();
  const wsId = channel.startsWith('ws:') ? channel.slice(3) : undefined;
  const ws = wsId ? state.projects.flatMap((p) => p.workspaces).find((w) => w.id === wsId) : undefined;
  const place: InvitePlace = ws && wsId ? { kind: 'workspace', workspaceId: wsId, projectId: ws.projectId, name: ws.name } : { kind: 'none' };
  const route = inviteRoute(place, parsed.names, state.network.friends);
  if (route.kind === 'error') return session.toast(route.text, 'warn');
  if (route.kind !== 'share' || !route.workspaceId) return session.toast('Type it in Beluga’s message box there', 'info');
  const workspaceId = route.workspaceId;
  if (session.sharing.friends) {
    for (const f of route.friends) session.sharing.shareWithFriend({ peerId: f.peerId, workspaceId, ...(route.projectId ? { projectId: route.projectId } : {}), role: 'contribute' });
    return;
  }
  const inRoom = route.friends.filter((f) => state.peers.some((p) => p.peerId === f.peerId && !p.guest));
  for (const f of inRoom) session.sharing.invite(workspaceId, f.peerId, 'contribute');
  const away = route.friends.filter((f) => !inRoom.includes(f));
  if (away.length) session.toast(`Turn on the Beluga network in Settings › Network to share ${route.where} with ${namesLine(away.map((f) => f.name))}`, 'warn');
}

/**
 * Execute a `/command` (or legacy `:command`) typed in `channel` (the conversation on screen).
 * `raw`: the words as typed; in a workspace's conversation, a command Beluga doesn't know (one of
 * Claude's skills or custom commands, "/frontend-design make it pastel") goes to Claude as typed.
 */
export function runCommand(session: Session, name: string, args: readonly string[], channel = 'room', raw?: string): void {
  const state = session.store.getState();
  const arg = args[0];
  switch (name) {
    case 'q':
    case 'quit':
    case 'exit':
      session.quit();
      return;
    case 'h':
    case 'help':
    case '?':
      session.intend({ type: 'overlay', overlay: 'help' });
      return;
    case 'invite':
      return inviteCommand(session, args, channel);
    // The app's message box turns into a schedule itself (BLG-400); typed anywhere else it says where.
    case 'schedule':
      return session.toast(`/schedule works in Beluga’s app, in a worktree, project or ${ASSISTANT_TITLE} chat`, 'info');
    case 'btw': {
      const question = args.join(' ').trim();
      if (!question) return session.toast('Usage: /btw <question>', 'warn');
      session.btw(channel, question).catch((err: unknown) => session.toast(err instanceof Error ? err.message : String(err), 'warn'));
      return;
    }
    case 'overview':
    case 'projects':
    case 'workspaces':
      session.intend({ type: 'navigate', view: { kind: 'overview' } });
      return;
    case 'room':
    case 'lobby':
      session.intend({ type: 'navigate', view: { kind: 'room' } });
      return;
    case 'run':
      if (arg?.startsWith('@')) {
        const command = args.slice(1).join(' ').trim();
        if (!command) return session.toast('Usage: /run @name <command>', 'warn');
        session.runOnPeerByHand(arg.slice(1), command, channel);
        return;
      }
      runWorkspaceCommand(session, name, args, channel);
      return;
    case 'new':
    case 'worktree':
    case 'chat':
    case 'review':
    case 'compact':
    case 'merge':
    case 'commit':
    case 'fork':
    case 'finder':
    case 'archive':
    case 'restore':
    case 'delete':
    case 'project':
    case 'pr':
    case 'terminal':
    case 'setup':
    case 'handoff':
      runWorkspaceCommand(session, name, args, channel);
      return;
    case 'model': {
      // "/model codex" or "/model codex:gpt-5": another runtime for this conversation (a handoff when it's live).
      const [rt = '', ...rest] = (arg ?? '').split(':');
      const runtime = state.runtimes.find((r) => r.available && (r.id === rt.toLowerCase() || r.label.toLowerCase() === rt.toLowerCase()));
      const conversation = channel === 'room' || channel === 'draft' ? undefined : channel;
      if (runtime && conversation && session.workbench) {
        const model = rest.join(':');
        session.workbench.setAgent(conversation, { runtime: runtime.id, label: runtime.label, ...(model ? { model } : {}) });
        return;
      }
      const pick = state.models.find((m) => m.value === arg || m.label.toLowerCase() === (arg ?? '').toLowerCase());
      if (!arg || !pick) return session.intend({ type: 'overlay', overlay: 'model' });
      if (session.workbench) session.workbench.setModel(channel === 'room' || channel === 'draft' ? undefined : channel, pick.value);
      else session.setPrefs({ model: pick.value || undefined });
      return;
    }
    case 'search':
    case 'find':
      session.intend({ type: 'navigate', view: { kind: 'search' } });
      if (args.length) session.workbench?.search(args.join(' '));
      return;
    case 'usage':
    case 'space':
      session.intend({ type: 'navigate', view: { kind: 'usage' } });
      void session.workbench?.measureDisk();
      return;
    case 'inbox':
    case 'notifications':
      session.intend({ type: 'overlay', overlay: 'inbox' });
      return;
    case 'template':
    case 'templates':
      if (arg === 'save') return session.workbench?.saveTemplate(args.slice(1).join(' '));
      session.intend({ type: 'overlay', overlay: 'templates' });
      return;
    case 'shell':
      runShellCommand(session, args);
      return;
    case 'env':
      runEnvCommand(session, args, channel);
      return;
    case 'copy':
      void session.copyLastAnswer();
      return;
    case 'open':
    case 'e':
      if (!arg) return session.toast('Usage: /open <name>:<folder>/<file>', 'warn');
      session.openSpec(arg);
      return;
    case 'get':
    case 'download':
      if (!arg) return session.toast('Usage: /get <name>:<folder>/<file>', 'warn');
      session.downloadSpec(arg);
      return;
    case 'close':
      session.store.dispatch({ type: 'viewer_close' });
      return;
    case 'follow':
      session.follow(arg);
      return;
    case 'unfollow':
      session.follow(undefined);
      return;
    case 'people':
    case 'peers':
    case 'who':
      for (const p of state.peers) {
        const shares = p.shares.map((s) => `${s.name}${s.writable ? '' : ' (read-only)'}`).join(', ') || 'nothing';
        session.system(`${p.name}${p.peerId === session.selfId ? ' (you)' : ''} · ${agentName(defaultAgentOf(p)).toLowerCase()} ${p.agent ? 'on' : 'off'} · shares ${shares}`);
      }
      return;
    case 'stop':
      session.stopAgent();
      return;
    case 'share': {
      if (!arg) return session.toast('Usage: /share <folder> [rw]', 'warn');
      session.shareFolder(fromHome(arg), args[1] === 'rw');
      return;
    }
    case 'unshare':
      if (!arg) return session.toast('Usage: /unshare <name>', 'warn');
      session.unshareFolder(arg);
      return;
    case 'policy':
      if (!arg || !POLICIES.includes(arg as Policy)) return session.toast(`Policy is "${state.policy}". Use /policy ask, auto or deny`);
      session.setClaudeSharing(arg as Policy);
      session.toast(`Friends' requests for ${agentLabel(session.agentRef, undefined, true)}: ${arg}`, 'success');
      return;
    case 'trust':
    case 'untrust': {
      const peer = arg ? session.findPeer(arg) : undefined;
      if (!peer) return session.toast(`Usage: /${name} <name>`, 'warn');
      session.store.dispatch({ type: 'trust', peerId: peer.peerId, trusted: name === 'trust' });
      session.toast(name === 'trust' ? `${peer.name}'s requests are auto-approved` : `${peer.name}'s requests need approval again`, 'success');
      return;
    }
    case 'y':
    case 'yes':
    case 'n':
    case 'no':
    case 'a':
    case 'always': {
      const answer = name.startsWith('y') ? 'yes' : name.startsWith('n') ? 'no' : 'always';
      if (!session.answerApproval(answer)) session.toast('Nothing to approve');
      return;
    }
    case 'clear':
      session.intend({ type: 'overlay', overlay: 'clear' });
      return;
    case 'visualize':
    case 'graph':
    {
      const what = args.join(' ').trim();
      // What you asked shows as you'd say it; Claude gets the full ask (unless it can't be asked here).
      const shared = session.sharing.sharedFor(channel);
      // Load the saved conversation first, so the line is kept with it (as askOwnClaude does).
      if (!shared && channel.startsWith('ws:')) session.workspaces?.ensureLoaded(channel.slice(3));
      if (!shared || shared.role === 'contribute') session.sendChat(what ? `Visualize ${what}` : 'Visualize this', false, channel);
      session.askOwnClaude(visualizePrompt(what), channel, false, false);
      return;
    }
    case 'plan': {
      session.setPlanMode(channel, arg ? arg !== 'off' : !state.planMode[channel]);
      return;
    }
    case 'remove': {
      const target = state.peers.find((p) => p.name.toLowerCase() === (arg ?? '').toLowerCase());
      if (!session.isHost) return session.toast('Only the host can remove people', 'warn');
      if (!target) return session.toast(`Nobody called "${arg}" is here`, 'warn');
      session.removePerson(target.peerId);
      return;
    }
    case 'newlink':
      session.newInviteLink();
      return;
    case 'lock':
      session.setRoomOpen(arg === 'off');
      return;
    case 'settings':
    case 'prefs':
      session.intend({ type: 'overlay', overlay: 'settings' });
      return;
    case 'name':
      session.rename(args.join(''));
      return;
    case 'zoom':
    case 'text': {
      const dir = arg === 'out' || arg === 'smaller' || arg === '-' ? 'out' : arg === 'reset' || arg === '0' ? 'reset' : 'in';
      void session.zoom(dir);
      return;
    }
    case 'theme':
      if (!arg || !THEMES.includes(arg as ThemeName)) return session.toast(`Themes: ${THEMES.join(', ')}`);
      session.setPrefs({ theme: arg as ThemeName });
      session.toast(`Theme: ${arg}`, 'success');
      return;
    default: {
      // Claude Code's own commands (/context, /rewind…) do nothing as a message: say what Beluga has instead.
      // …unless a skill or command of your own has that name: then it's yours.
      const instead = builtInInstead(name);
      if (instead) {
        void session.ownSkill(name, channel).then((own) => {
          if (own && raw) session.askOwnClaude(raw.trim().replace(/^:/, '/'), channel);
          else session.toast(instead, 'info');
        });
        return;
      }
      if (raw && channel !== 'room' && session.workspaces?.inChannel(channel)) {
        session.askOwnClaude(raw.trim().replace(/^:/, '/'), channel);
        return;
      }
      session.toast(`Unknown command /${name}. Type /help (or // to send a message starting with /)`, 'warn');
    }
  }
}

/** Whether Beluga handles this command, including its aliases and `/dialogue`, which Session.submit takes before the command list. */
export function isBelugaCommand(name: string): boolean {
  return name === 'dialogue' || COMMANDS.some((command) => command.name === name) || COMMAND_ALIASES.has(name);
}

/** Workspace commands act on the workspace you're looking at (or its project). */
function runWorkspaceCommand(session: Session, name: string, args: readonly string[], channel: string): void {
  const ctl = session.workspaces;
  if (!ctl) return session.toast('Projects are not available in this mode', 'warn');
  const text = args.join(' ').trim();
  const ws = ctl.inChannel(channel);
  if (name === 'project') {
    const [sub, ...rest] = args;
    if (sub === 'setup' || sub === 'run') {
      const project = ws ? ctl.manager.list.find((p) => p.id === ws.projectId && p.root) : undefined;
      if (!project) return session.toast('Open a workspace in the project first, or use the project ⋯ menu', 'warn');
      session.workbench?.setScript(project.id, sub, rest.join(' '));
      return;
    }
    const dir = fromHome(rest.join(' '));
    if (!dir || (sub !== 'add' && sub !== 'folder')) return session.toast('Usage: /project add <path>, /project folder <path>, /project setup <command> or /project run <command>', 'warn');
    void (sub === 'add' ? ctl.addProject(dir) : ctl.addFolder(dir));
    return;
  }
  const repos = ctl.manager.list.filter((p) => p.root);
  const project = ws ? ctl.manager.list.find((p) => p.id === ws.projectId) : repos.length === 1 ? repos[0] : undefined;
  if (name === 'new' || name === 'worktree' || name === 'chat') {
    if (!project) return session.toast('Open a workspace in the project first (or use + New worktree under it)', 'warn');
    if (!text) return session.toast(`Usage: /${name} <${name === 'chat' ? 'title' : 'name'}>`, 'warn');
    void (name === 'chat' ? ctl.newChat(project.id, text) : ctl.newWorktree(project.id, text));
    return;
  }
  // Outside a workspace, /terminal opens your own shell (the Terminal tab).
  if (!ws && name === 'terminal') return session.intend({ type: 'navigate', view: { kind: 'terminal' } });
  if (!ws) return session.toast(ctl.isMaking(channel) ? 'This worktree is still being made: a moment' : 'Open a workspace first (Projects on the left)', 'warn');
  switch (name) {
    case 'pr':
      session.workbench?.createPr(ws.id, text);
      return;
    case 'run':
      session.workbench?.run(ws.id);
      ctl.open(ws.id, 'terminal');
      return;
    case 'terminal':
      ctl.open(ws.id, 'terminal');
      return;
    case 'setup':
      session.workbench?.runSetup(ws.id);
      ctl.open(ws.id, 'terminal');
      return;
    case 'handoff': {
      // Someone in your room, or a friend by @handle or name over the network (BLG-341).
      const peer = text ? (session.findPeer(text) ?? friendNamed(text.replace(/^@+/, ''), session.store.getState().network.friends)) : undefined;
      if (!peer) return session.intend({ type: 'overlay', overlay: 'handoff' });
      void session.remote.handoff(ws.id, peer.peerId);
      return;
    }
    case 'review':
      ctl.open(ws.id, 'review');
      return;
    case 'compact':
      ctl.compact(ws.id, text);
      return;
    case 'merge':
      void ctl.merge(ws.id);
      return;
    case 'commit':
      void ctl.commit(ws.id, text || undefined);
      return;
    case 'fork':
      if (!text) return session.toast('Usage: /fork <name>', 'warn');
      void ctl.fork(ws.id, text);
      return;
    case 'finder':
      ctl.openInFinder(ws.id);
      return;
    case 'archive':
      void ctl.archive(ws.id, args[0] === 'force');
      return;
    case 'restore':
      void ctl.restore(ws.id);
      return;
    case 'delete':
      void ctl.remove(ws.id);
      return;
  }
}
