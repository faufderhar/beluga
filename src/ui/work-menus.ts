import type { AppState } from '../core/store.js';
import { describePr } from '../shared/format.js';
import type { MenuSpec } from './menus.js';
import { handoffPeople } from './worktree-share.js';

export type WorkMenuKind =
  /** The PR button: create one with Claude, or work with the one that exists. */
  | { readonly kind: 'pr'; readonly id: string }
  /** A project's setup and run commands. */
  | { readonly kind: 'scripts'; readonly projectId: string; readonly tab?: 'general' | 'environment' | 'worktrees' }
  /** Start from a template (fills the box), or manage them. */
  | { readonly kind: 'templates'; readonly manage?: boolean }
  /** Pick who takes over a workspace. */
  | { readonly kind: 'handoff'; readonly id: string }
  /** Pick a project on a friend's computer to start a worktree in. */
  | { readonly kind: 'remote_ws'; readonly peerId: string }
  /** The workspace buttons that didn't fit in the top bar. */
  | { readonly kind: 'ws_more'; readonly id: string; readonly actions: ReadonlyArray<{ readonly action: string; readonly label: string; readonly hint: string }> };

const findWs = (state: AppState, id: string) => state.projects.flatMap((p) => p.workspaces).find((w) => w.id === id);
const SOURCE = { yours: 'set by you', claude: 'worked out by your agent', 'beluga.json': 'from beluga.json', 'klaud.json': 'from klaud.json', 'conductor.json': 'from conductor.json', detected: 'guessed from the project' } as const;

function prMenu(state: AppState, id: string): MenuSpec | undefined {
  const ws = findWs(state, id);
  if (!ws) return undefined;
  const pr = state.prs[id];
  const noGh = state.gh === false;
  const intro = [
    pr ? `${describePr(pr)} · ${pr.title}` : `No pull request for ${ws.branch ?? 'this branch'} yet.`,
    noGh ? 'Install the GitHub CLI and sign in first: brew install gh, then gh auth login.' : 'Your agent commits what belongs to the work, pushes, and writes a short description (what, why, how to test).',
    '',
  ];
  const options = pr
    ? [
        { id: 'pr-open', label: `Open PR #${pr.number} in the browser`, hint: pr.url },
        ...(pr.checks === 'failing' ? [{ id: 'pr-fix', label: 'Fix the failing checks', hint: 'your agent reads the CI logs, fixes and pushes' }] : []),
        ...(pr.state === 'OPEN' ? [{ id: 'pr-update', label: 'Push new work and update the description', hint: 'with your PR instructions' }] : []),
        { id: 'pr-refresh', label: 'Refresh status', hint: '' },
      ]
    : [
        { id: 'pr-create', label: 'Create a pull request', hint: 'your agent does it with your PR instructions' },
        { id: 'pr-create-note', label: 'Create one with extra instructions…', hint: 'type them, then Enter' },
      ];
  return { title: `Pull request · ${ws.name}`, intro, options: [...options, { id: 'pr-edit-prompt', label: 'Edit the PR instructions…', hint: state.prCustom ? 'customized' : 'built-in' }, { id: 'close', label: 'Close', hint: 'Esc' }] };
}

function scriptsMenu(state: AppState, projectId: string): MenuSpec | undefined {
  const p = state.projects.find((x) => x.id === projectId);
  if (!p) return undefined;
  const s = p.scripts ?? {};
  return {
    title: `${p.name} · setup and run`,
    intro: [
      'Setup runs in every new worktree (in its Terminal tab), e.g. to install dependencies.',
      'Run starts the project when you click Run in a workspace.',
      `${state.prefs.autoSetup ? 'Setup in new worktrees is on.' : 'Setup in new worktrees is off (Settings → Workspaces).'}`,
      '',
    ],
    options: [
      { id: 's-setup', label: `Setup: ${s.setup?.command ?? 'none'}`, hint: `${s.setup ? SOURCE[s.setup.source] : 'nothing found'}  ·  Enter to change` },
      { id: 's-run', label: `Run: ${s.run?.command ?? 'none'}`, hint: `${s.run ? SOURCE[s.run.source] : 'nothing found'}  ·  Enter to change` },
      ...(s.setup?.source === 'yours' || s.run?.source === 'yours' ? [{ id: 's-team', label: 'Save them to beluga.json', hint: 'so everyone on the project gets them' }] : []),
      { id: 'close', label: 'Done', hint: 'Esc' },
    ],
  };
}

function templatesMenu(state: AppState, manage: boolean): MenuSpec {
  return {
    title: manage ? 'Templates' : 'Start from a template',
    intro: [manage ? 'Your own templates can be removed here. Save new ones with /template save <name>: <what to do>.' : 'Pick one: it fills the box below, ready to finish and send.', ''],
    options: [
      ...state.templates.map((t) =>
        manage && !t.builtIn
          ? { id: `tpl-del:${t.id}`, label: `Remove "${t.name}"`, hint: t.prompt.slice(0, 60) }
          : { id: `tpl:${t.id}`, label: t.name, hint: `${t.plan ? 'plans first · ' : ''}${t.prompt.slice(0, 70)}${t.prompt.length > 70 ? '…' : ''}` },
      ),
      { id: 'tpl-save', label: '+ Save a new template…', hint: 'name: what your agent should do' },
      ...(manage ? [] : [{ id: 'tpl-manage', label: 'Manage templates…', hint: '' }]),
      { id: 'close', label: 'Close', hint: 'Esc' },
    ],
  };
}

function handoffMenu(state: AppState, id: string): MenuSpec | undefined {
  const ws = findWs(state, id);
  if (!ws) return undefined;
  // In your room, or friends over the network (BLG-341); one whose Beluga can't take it yet isn't offered.
  const people = handoffPeople(state).filter((p) => !p.why);
  return {
    title: `Hand off ${ws.name}`,
    intro: [
      'Someone else takes over this work on their computer, with their own agent:',
      '  1. Your agent writes a short handoff note (what is done, what is left).',
      '  2. Uncommitted work is committed, and the branch is sent to them (encrypted).',
      '  3. They accept, get a worktree with the branch and the chat, and their agent continues.',
      'They need the same repository (same origin). You can follow along afterwards.',
      ...(people.length ? [] : ['', 'No friends to hand it to yet. Type /invite to add one.']),
      '',
    ],
    options: [...people.map((p) => ({ id: `ho:${p.peerId}`, label: `Hand off to ${p.name}`, hint: `${p.name}'s agent continues on ${p.name}'s computer${p.online ? '' : ' (offline: it waits for them)'}` })), { id: 'close', label: 'Cancel', hint: 'Esc' }],
  };
}

function remoteWsMenu(state: AppState, peerId: string): MenuSpec | undefined {
  const peer = state.peers.find((p) => p.peerId === peerId);
  if (!peer) return undefined;
  return {
    title: `Start a worktree on ${peer.name}'s computer`,
    intro: [
      `Pick one of ${peer.name}'s projects, then describe the task. ${peer.name} approves it, and ${peer.name}'s agent`,
      `does the work there. You both see it in Projects (yours, and ${peer.name}'s).`,
      '',
    ],
    options: [...(peer.projects ?? []).map((name) => ({ id: `rws:${name}`, label: name, hint: `a new worktree on ${peer.name}'s computer` })), { id: 'close', label: 'Cancel', hint: 'Esc' }],
  };
}

/** Menus for workspace features (PR, scripts, templates, handoff, remote worktrees); null when it's not one of these. */
export function workMenuSpec(state: AppState, menu: { readonly kind: string }): MenuSpec | undefined | null {
  const m = menu as WorkMenuKind;
  switch (m.kind) {
    case 'pr':
      return prMenu(state, m.id);
    case 'scripts':
      return scriptsMenu(state, m.projectId);
    case 'templates':
      return templatesMenu(state, Boolean(m.manage));
    case 'handoff':
      return handoffMenu(state, m.id);
    case 'remote_ws':
      return remoteWsMenu(state, m.peerId);
    case 'ws_more':
      return { title: 'More', intro: [''], options: [...m.actions.map((a) => ({ id: `wsact:${a.action}`, label: a.label, hint: a.hint })), { id: 'close', label: 'Close', hint: 'Esc' }] };
    default:
      return null;
  }
}
