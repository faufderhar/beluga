import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AppState } from '../src/core/store.js';
import { initialAppState as initialState, reduceApp as reduce } from '../src/client/screen.js';
import type { PullRequest, SearchHit, Template } from '../src/core/work-store.js';
import type { PeerInfo } from '../src/protocol.js';
import { buttons, draftModel, formatTokens, searchCursorRow, searchModel, terminalBarModel, topBarModel, trustCardModel, usageModel } from '../src/ui/work-models.js';
import { HIDEABLE_BUTTONS, TUNNEL_LABELS, TUNNEL_ORDER, inboxMenu, modelLabel, modelMenu, settingsMenu } from '../src/ui/settings-menus.js';
import { type WorkMenuKind, workMenuSpec } from '../src/ui/work-menus.js';
import { workspaceHeaderModel, type Model, type Zone } from '../src/ui/workspace-models.js';
import type { Project, Workspace } from '../src/workspaces/types.js';

type Lines = Model['lines'];
const text = (lines: Lines): string[] => lines.map((l) => l.map((s) => s.text).join(''));
const ids = (spec: { options: readonly { id: string }[] } | null | undefined): string[] => (spec ? spec.options.map((o) => o.id) : []);
const zoneText = (line: Lines[number], z: Zone): string => line.map((s) => s.text).join('').slice(z.x0, z.x1 + 1);

const ws = (over: Partial<Workspace>): Workspace => ({
  id: 'w1', projectRoot: '/p', name: 'fix-auth', path: '/wt/fix-auth', kind: 'worktree', branch: 'beluga/fix-auth', base: 'origin/main',
  createdAt: 1, projectId: 'p1', external: false, status: { changed: 2, ahead: 3, behind: 0 }, ...over,
});
const usage = (tokens: number, cost = 0) => ({ input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, cost, runs: 1 });
const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1', name: 'app', root: '/p', base: 'origin/main',
  workspaces: [ws({ id: 'main', name: 'main', kind: 'main', branch: 'main', status: { changed: 0, ahead: 0, behind: 0 } }), ws({})],
  ...over,
});
const peer = (peerId: string, name: string, over: Partial<PeerInfo> = {}): PeerInfo => ({ peerId, name, shares: [], agent: true, ...over });
const ME = peer('me000001', 'kayra');
const withProjects = (projects: readonly Project[], s: AppState = initialState('room')): AppState => reduce(s, { type: 'projects', projects });
const pr = (over: Partial<PullRequest> = {}): PullRequest => ({ number: 12, url: 'https://github.com/x/y/pull/12', state: 'OPEN', title: 'Fix auth', draft: false, checks: 'passing', ...over });
const tpl = (id: string, over: Partial<Template> = {}): Template => ({ id, name: `T ${id}`, prompt: `do ${id}`, ...over });
const spec = (s: AppState, m: WorkMenuKind) => workMenuSpec(s, m);

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------- work-models

describe('formatTokens and buttons', () => {
  it('formats token counts', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1500)).toBe('2k');
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });

  it('lays out buttons left to right with zones on the given row', () => {
    const zones: Zone[] = [];
    const segs = buttons([{ label: 'A', action: { type: 'inbox' }, hint: 'a' }, { label: 'Bee', action: { type: 'templates_menu' }, hint: 'b', active: false }], 3, zones, 2);
    expect(segs.map((s) => s.text).join('')).toBe('   A   Bee  ');
    expect(zones).toEqual([
      { x0: 2, x1: 4, y: 3, action: { type: 'inbox' }, hint: 'a' },
      { x0: 6, x1: 10, y: 3, action: { type: 'templates_menu' }, hint: 'b' },
    ]);
    expect(segs.find((s) => s.text === ' Bee ')?.inverse).toBe(false);
  });
});

describe('topBarModel', () => {
  const connected = (peers: readonly PeerInfo[]): AppState => {
    let s = reduce(initialState('my-room'), { type: 'welcome', self: ME });
    s = reduce(s, { type: 'peers', peers });
    return reduce(s, { type: 'status', status: 'connected' });
  };

  it('puts the Inbox button at the far right with a zone covering exactly it', () => {
    const m = topBarModel(connected([ME]), 80);
    const line = text(m.lines)[0]!;
    expect(line.startsWith('❯_ Beluga  my-room')).toBe(true);
    expect(line).toContain('○ solo');
    expect(line).toContain('1 person');
    expect(line.endsWith(' Inbox ')).toBe(true);
    expect(m.zones).toHaveLength(1);
    const z = m.zones[0]!;
    expect(z.action).toEqual({ type: 'inbox' });
    expect(z.y).toBe(0);
    expect(zoneText(m.lines[0]!, z)).toBe(' Inbox ');
    expect(z.x1).toBe(line.length - 1);
    expect(z.hint).toBe('What happened in other workspaces');
  });

  it('shows "● N new" (inverse) when there are unread notices', () => {
    let s = connected([ME]);
    s = reduce(s, { type: 'notice_add', notice: { kind: 'done', title: 'a', body: '' } });
    s = reduce(s, { type: 'notice_add', notice: { kind: 'done', title: 'b', body: '' } });
    const m = topBarModel(s, 80);
    const z = m.zones[0]!;
    expect(zoneText(m.lines[0]!, z)).toBe(' ● 2 new ');
    expect(z.hint).toBe('2 things happened while you were elsewhere');
    expect(m.lines[0]!.at(-1)).toMatchObject({ inverse: true, bold: true });
    const one = reduce(s, { type: 'notice_read', id: 2 });
    expect(topBarModel(one, 80).zones[0]!.hint).toBe('1 thing happened while you were elsewhere');
    const none = reduce(s, { type: 'notice_read' });
    expect(zoneText(topBarModel(none, 80).lines[0]!, topBarModel(none, 80).zones[0]!)).toBe(' Inbox ');
  });

  it('shows live / connecting / offline, people, your usage and who you follow', () => {
    const friend = peer('fr000001', 'ana');
    const me = { ...ME, usage: { fiveHour: { pct: 40 }, week: { pct: 10 }, updatedAt: 1 } };
    let s = connected([me, friend]);
    s = reduce(s, { type: 'follow', peerId: 'fr000001' });
    const line = text(topBarModel(s, 120).lines)[0]!;
    expect(line).toContain('● live');
    expect(line).toContain('2 people');
    expect(line).toContain('your Claude plan 5h 40% · week 10%');
    expect(line).toContain('◉ following ana');
    const weekOnly = connected([{ ...ME, usage: { week: { pct: 7 }, updatedAt: 1 } }, friend]);
    expect(text(topBarModel(weekOnly, 120).lines)[0]).toContain('your Claude plan week 7%');
    expect(text(topBarModel(initialState('r'), 80).lines)[0]).toContain('connecting…');
    expect(text(topBarModel(reduce(initialState('r'), { type: 'status', status: 'disconnected' }), 80).lines)[0]).toContain('offline · reconnecting');
    // hosting alone is not "solo"
    const invited = reduce(connected([ME]), { type: 'invite', invite: 'klaud://x' });
    expect(text(topBarModel(invited, 80).lines)[0]).toContain('● live');
  });
});

describe('searchModel', () => {
  const hit = (over: Partial<SearchHit> = {}): SearchHit => ({ channel: 'ws:w1', place: 'app › fix-auth', who: 'kayra', text: 'the login token expires early', at: 10, ts: 1_700_000_000_000, ...over });

  it('explains how to search when the query is empty (or blank)', () => {
    const s = reduce(initialState('r'), { type: 'search', search: { query: '   ' } });
    const m = searchModel(s, 80);
    expect(text(m.lines)[0]).toMatch(/^Type in the box below/);
    expect(m.lines).toHaveLength(2);
    expect(m.zones).toEqual([]);
  });

  it('says nothing was found', () => {
    const s = reduce(initialState('r'), { type: 'search', search: { query: 'zzz', hits: [], searched: 1 } });
    const lines = text(searchModel(s, 80).lines);
    expect(lines[0]).toBe('0 results for "zzz" in 1 conversation');
    expect(lines).toContain('Nothing found. Try fewer or different words.');
    expect(searchModel(s, 80).zones).toEqual([]);
  });

  it('draws two rows per hit with zones for both, marks the cursor and archived places', () => {
    const hits = [hit(), hit({ place: 'old-chat', archived: true, who: '' })];
    const s = reduce(reduce(initialState('r'), { type: 'search', search: { query: 'token', hits, searched: 5 } }), { type: 'search_cursor', cursor: 1 });
    const m = searchModel(s, 80);
    const lines = text(m.lines);
    expect(lines[0]).toBe('2 results for "token" in 5 conversations');
    expect(lines[2]).toMatch(/^ {2}app › fix-auth {2}kayra/);
    expect(lines[3]).toContain('token');
    expect(lines[4]).toMatch(/^▸ old-chat \(archived\)/);
    expect(m.zones.map((z) => [z.y, z.action])).toEqual([
      [2, { type: 'search_hit', index: 0 }],
      [3, { type: 'search_hit', index: 0 }],
      [4, { type: 'search_hit', index: 1 }],
      [5, { type: 'search_hit', index: 1 }],
    ]);
    expect(m.zones.every((z) => z.x0 === 0 && z.x1 === 79)).toBe(true);
    expect(m.zones[0]!.hint).toBe('Open app › fix-auth');
    // the matched word is underlined
    expect(m.lines[3]!.find((seg) => seg.underline)?.text).toBe('token');
    expect(searchCursorRow(s)).toBe(4);
    expect(lines[4]!.length).toBe(80);
  });

  it('shows "+" when the hit list is capped and singular wording for one', () => {
    const many = Array.from({ length: 200 }, (_, i) => hit({ place: `p${i}` }));
    const s = reduce(initialState('r'), { type: 'search', search: { query: 'x', hits: many, searched: 300 } });
    expect(text(searchModel(s, 60).lines)[0]).toBe('200+ results for "x" in 300 conversations');
    const one = reduce(initialState('r'), { type: 'search', search: { query: 'x', hits: [hit()], searched: 1 } });
    expect(text(searchModel(one, 60).lines)[0]).toBe('1 result for "x" in 1 conversation');
  });
});

describe('usageModel', () => {
  const agentWt = ws({ id: 'ag', name: 'agent-wt', external: true, path: '/p/.claude/worktrees/agent-1', usage: usage(50_000) });
  const otherTool = ws({ id: 'ext', name: 'other-tool', external: true, path: '/elsewhere/wt' });
  const make = (): AppState => {
    const p = project({
      workspaces: [
        ws({ id: 'main', name: 'main', kind: 'main', branch: 'main', usage: usage(1000, 0.5) }),
        ws({ id: 'small', name: 'small', usage: usage(2000, 0.25) }),
        ws({ id: 'big', name: 'big' }),
        ws({ id: 'chat', name: 'question', kind: 'chat', usage: usage(3000, 1) }),
        ws({ id: 'gone', name: 'gone', archived: true }),
        ws({ id: 'empty', name: 'empty' }),
        agentWt,
        otherTool,
      ],
    });
    const s = withProjects([p]);
    return reduce(s, { type: 'disk', sizes: { main: 50 * 1024 ** 2, small: 1024 ** 2, big: 200 * 1024 ** 2, gone: 999 * 1024 ** 2, ag: 500 * 1024 ** 2, ext: 2 * 1024 ** 2 } });
  };

  it('says it is measuring when nothing is known yet', () => {
    const m = usageModel(withProjects([project()]), 100);
    const lines = text(m.lines);
    expect(lines[0]).toBe('Worktrees take 0 KB   ·   agents used nothing yet');
    expect(lines).toContain('Measuring… sizes show up in a few seconds.');
    expect(m.zones).toEqual([]);
  });

  it('sorts rows biggest first, skips archived, empty and agent worktrees, and totals', () => {
    const m = usageModel(make(), 120);
    const lines = text(m.lines);
    // totals: disk excludes main (big 200MB + ext 2MB + small 1MB); tokens & cost include everything shown
    expect(lines[0]).toBe('Worktrees take 203 MB   ·   agents used 6k tokens (≈ $1.75)');
    const rows = lines.slice(4);
    const names = rows.map((l) => l.replace(/^. app › (\S+).*$/, '$1'));
    expect(names).toEqual(['big', 'main', 'other-tool', 'small', 'question']);
    expect(lines.join('\n')).not.toMatch(/agent-wt|gone|empty/);
    expect(rows[0]).toMatch(/^⌥ app › big/);
    expect(rows[1]).toMatch(/^⌂ app › main/);
    expect(rows[4]).toMatch(/^◇ app › question/);
    expect(rows[4]).toContain('$1.00');
  });

  it('offers Archive only for worktrees Beluga made', () => {
    const m = usageModel(make(), 120);
    const archives = m.zones.filter((z) => z.action.type === 'ws');
    expect(archives.map((z) => z.action)).toEqual([
      { type: 'ws', id: 'big', action: 'archive' },
      { type: 'ws', id: 'small', action: 'archive' },
    ]);
    expect(archives[0]!.hint).toBe('Archive big to free 200 MB');
    for (const z of archives) expect(zoneText(m.lines[z.y]!, z)).toBe(' Archive ');
    const opens = m.zones.filter((z) => z.action.type === 'open_ws');
    expect(opens.map((z) => (z.action.type === 'open_ws' ? z.action.id : ''))).toEqual(['big', 'main', 'ext', 'small', 'chat']);
    expect(opens.every((z) => z.x0 === 0)).toBe(true);
  });

  it('hints "its space" for a worktree with tokens but no disk size', () => {
    const s = withProjects([project({ workspaces: [ws({ id: 'tok', name: 'tok', usage: usage(500) })] })]);
    const m = usageModel(s, 100);
    expect(m.zones.find((z) => z.action.type === 'ws')?.hint).toBe('Archive tok to free its space');
    expect(text(m.lines)[0]).toBe('Worktrees take 0 KB   ·   agents used 500 tokens');
  });

  it('labels workspaces without a project root by name only', () => {
    const chats: Project = { id: 'chats', name: 'Chats', root: '', base: '', workspaces: [ws({ id: 'c', name: 'ideas', kind: 'chat', projectId: 'chats', usage: usage(10) })] };
    expect(text(usageModel(withProjects([chats]), 100).lines)[4]).toMatch(/^◇ ideas/);
  });
});

describe('draftModel', () => {
  it('explains a new worktree, with setup on or off', () => {
    const on = text(draftModel(initialState('r'), 100, 'worktree').lines);
    expect(on[0]).toMatch(/^A new worktree from the latest origin/);
    expect(on[2]).toMatch(/setup .* runs in its Terminal tab/);
    const off = text(draftModel(initialState('r', 'ask', { autoSetup: false }), 100, 'worktree').lines);
    expect(off[2]).toBe('Setup scripts are off (Settings → Workspaces).');
  });

  it('explains a new chat', () => {
    const lines = text(draftModel(initialState('r'), 100, 'chat').lines);
    expect(lines[0]).toBe('A fresh conversation with your agent, with all its tools.');
    expect(lines).toContain('Esc goes back without creating anything.');
  });

  it('lists up to 12 templates as zones plus a Manage button', () => {
    const templates = Array.from({ length: 14 }, (_, i) => tpl(`t${i}`, { plan: i === 0, prompt: i === 1 ? 'multi\n  line   prompt' : `do t${i}` }));
    const s = reduce(initialState('r'), { type: 'templates', templates });
    const m = draftModel(s, 100, 'chat');
    const lines = text(m.lines);
    const tz = m.zones.filter((z) => z.action.type === 'template');
    expect(tz).toHaveLength(12);
    expect(tz.map((z) => (z.action.type === 'template' ? z.action.id : ''))).toEqual(templates.slice(0, 12).map((t) => t.id));
    expect(tz[0]!.hint).toBe('Fill the box with "T t0"');
    expect(tz.every((z) => z.x0 === 0 && z.x1 === 99)).toBe(true);
    expect(lines[tz[0]!.y]).toBe('  ↳ T t0  plans first  do t0');
    expect(lines[tz[1]!.y]).toBe('  ↳ T t1  multi line prompt');
    const manage = m.zones.at(-1)!;
    expect(manage.action).toEqual({ type: 'templates_menu' });
    expect(manage.x0).toBe(2);
    expect(zoneText(m.lines[manage.y]!, manage)).toBe(' Manage templates… ');
  });
});

describe('trustCardModel', () => {
  it('offers the four trust levels plus Later', () => {
    let s = reduce(initialState('r'), { type: 'peers', peers: [peer('fr000001', 'ana')] });
    s = reduce(s, { type: 'trust_prompt', peerId: 'fr000001', show: true });
    const m = trustCardModel(s, 'fr000001', 200);
    const lines = text(m.lines);
    expect(lines[0]).toBe('● ana joined. How much do you trust ana?');
    expect(lines[1]).toContain('Change it any time by clicking ana in People.');
    expect(m.zones.map((z) => z.action)).toEqual([
      { type: 'trust', peerId: 'fr000001', level: 'blocked' },
      { type: 'trust', peerId: 'fr000001', level: 'ask' },
      { type: 'trust', peerId: 'fr000001', level: 'trusted' },
      { type: 'trust', peerId: 'fr000001', level: 'full' },
      { type: 'trust_later', peerId: 'fr000001' },
    ]);
    expect(m.zones.map((z) => zoneText(m.lines[2]!, z))).toEqual([" Can't use my agent ", ' Ask me each time ', ' Trusted ', ' Full trust ', ' Later ']);
    expect(m.zones.every((z) => z.y === 2)).toBe(true);
    expect(m.zones[0]!.x0).toBe(2);
    expect(m.zones.at(-1)!.hint).toContain('ask me each time');
  });

  it('counts other people waiting and falls back to a short id for unknown people', () => {
    let s = reduce(initialState('r'), { type: 'trust_prompt', peerId: 'abcdef123', show: true });
    s = reduce(s, { type: 'trust_prompt', peerId: 'zzz999', show: true });
    expect(text(trustCardModel(s, 'abcdef123', 200).lines)[0]).toBe('● abcdef joined. How much do you trust abcdef?   +1 more');
  });
});

describe('terminalBarModel', () => {
  const opts = { hasRun: true, hasSetup: true, focused: false };

  it('draws tabs with their state and Run / setup actions', () => {
    const tabs = [
      { key: 'w1:shell', label: 'Shell', running: true },
      { key: 'w1:setup', label: 'Setup', running: false, exitCode: 0 },
      { key: 'w1:fail', label: 'Fail', running: false, exitCode: 1 },
      { key: 'w1:gone', label: 'Gone', running: false, exitCode: null },
    ];
    const m = terminalBarModel('w1', tabs, 'w1:shell', 120, opts);
    const line = text(m.lines)[0]!;
    expect(line.startsWith(' ● Shell   ✓ Setup   ✗ Fail   ✗ Gone  │  Run  Run setup again ')).toBe(true);
    expect(line.endsWith('click the terminal to type in it')).toBe(true);
    expect(m.zones.map((z) => zoneText(m.lines[0]!, z))).toEqual([' ● Shell ', ' ✓ Setup ', ' ✗ Fail ', ' ✗ Gone ', ' Run ', ' Run setup again ']);
    expect(m.zones.slice(0, 4).map((z) => z.action)).toEqual(tabs.map((t) => ({ type: 'term_tab', key: t.key })));
    expect(m.zones[4]!.action).toEqual({ type: 'ws', id: 'w1', action: 'run' });
    expect(m.zones[5]!.action).toEqual({ type: 'ws', id: 'w1', action: 'setup' });
    expect(m.lines[0]![0]).toMatchObject({ inverse: true });
  });

  it('shows Stop while running and Restart once it stopped', () => {
    const running = terminalBarModel('w1', [{ key: 'w1:run', label: 'Run', running: true }], 'w1:run', 100, { ...opts, hasSetup: false });
    expect(running.zones.at(-1)!.action).toEqual({ type: 'ws', id: 'w1', action: 'stop_run' });
    expect(zoneText(running.lines[0]!, running.zones.at(-1)!)).toBe(' Stop ');
    const stopped = terminalBarModel('w1', [{ key: 'w1:run', label: 'Run', running: false, exitCode: 0 }], 'w1:run', 100, opts);
    expect(zoneText(stopped.lines[0]!, stopped.zones[1]!)).toBe(' Restart ');
    expect(stopped.zones[1]!.action).toEqual({ type: 'ws', id: 'w1', action: 'run' });
  });

  it('has no actions without scripts, and a focused hint', () => {
    const m = terminalBarModel('w1', [{ key: 'w1:shell', label: 'Shell', running: true }], 'w1:shell', 100, { hasRun: false, hasSetup: false, focused: true });
    expect(m.zones).toHaveLength(1);
    expect(text(m.lines)[0]).toMatch(/Ctrl\+] or click outside to leave$/);
  });
});

// ---------------------------------------------------------------- settings-menus

describe('settingsMenu', () => {
  const s = (): AppState => reduce(initialState('r'), { type: 'welcome', self: ME });

  it('top level links to every section', () => {
    const m = settingsMenu(s());
    expect(m.title).toBe('Settings');
    expect(ids(m)).toEqual(['set-name', 'set-theme', 'sec:people', 'sec:notify', 'sec:claude', 'sec:workspaces', 'sec:display', 'close']);
    expect(m.options[0]!.hint).toContain('kayra');
    expect(m.options[3]!.hint).toBe('desktop on · sound');
    expect(settingsMenu(reduce(s(), { type: 'prefs', prefs: { notify: { ...s().prefs.notify, sound: { kind: 'none' } } } })).options[3]!.hint).toBe('desktop on');
    const quiet = reduce(s(), { type: 'prefs', prefs: { notify: { ...s().prefs.notify, desktop: false } } });
    expect(settingsMenu(quiet).options[3]!.hint).toBe('desktop off · inbox only');
    const others = reduce(s(), { type: 'peers', peers: [ME, peer('fr000001', 'ana')] });
    expect(settingsMenu(others).options[2]!.hint).toBe('new people: asks you · 1 here');
    expect(settingsMenu(initialState('r')).options[0]!.hint).toContain('–');
  });

  it('claude section, with and without custom PR instructions', () => {
    expect(ids(settingsMenu(s(), 'claude'))).toEqual(['set-model', 'set-effort', 'set-self-approval', 'set-pr-prompt', 'set-templates', 'set-back']);
    const custom = settingsMenu(reduce(s(), { type: 'prefs', prefs: { model: 'opus', effort: 'high', selfApproval: 'ask' } }), 'claude', { prCustom: true });
    expect(ids(custom)).toEqual(['set-model', 'set-effort', 'set-self-approval', 'set-pr-prompt', 'set-pr-reset', 'set-templates', 'set-back']);
    expect(custom.options[0]!.hint).toMatch(/^Opus/);
    expect(custom.options[1]!.hint).toMatch(/^high/);
    expect(custom.options[2]!.hint).toMatch(/^Yes \(safer\)/);
    expect(custom.options[3]!.hint).toMatch(/^Customized/);
  });

  it('notify, workspaces, buttons and display sections', () => {
    expect(ids(settingsMenu(s(), 'notify'))).toEqual(['n-desktop', 'n-sound', 'n-onlyAway', 'n-dnd', 'n-needsYou', 'n-done', 'n-mentions', 'n-people', 'n-background', 'n-problems', 'n-pr', 'n-test', 'set-back']);
    const wsMenu = settingsMenu(s(), 'workspaces');
    expect(ids(wsMenu)).toEqual(['w-setup', 'w-friend', 'sec:terminal', 'sec:env', 'w-buttons', 'set-back']);
    expect(wsMenu.options[4]!.hint).toBe('all shown');
    const hidden = reduce(s(), { type: 'prefs', prefs: { hiddenButtons: ['run', 'pr'], friendWorktrees: 'never' as never, shell: '/bin/fish' } });
    const wsHidden = settingsMenu(hidden, 'workspaces');
    expect(wsHidden.options[4]!.hint).toBe('2 hidden');
    expect(wsHidden.options[1]!.hint).toMatch(/^No/);
    expect(wsHidden.options[2]!.hint).toMatch(/^fish/);
    const btns = settingsMenu(hidden, 'buttons');
    expect(ids(btns)).toEqual([...HIDEABLE_BUTTONS.map(([id]) => `btn:${id}`), 'set-back-workspaces']);
    expect(btns.options[0]!.hint).toMatch(/^○ hidden/);
    expect(btns.options[1]!.hint).toMatch(/^◉ shown/);
    expect(ids(settingsMenu(s(), 'display'))).toEqual(['set-mouse', 'd-context', 'd-subagents', 'size-in', 'size-out', 'size-reset', 'set-back']);
    expect(settingsMenu(reduce(s(), { type: 'prefs', prefs: { mouse: false, subagents: 'hidden' } }), 'display').options.map((o) => o.hint).slice(0, 3).join('|')).toMatch(/^Off \(keeps native text selection\).*\|On .*\|Hidden/);
  });

  it('people section lists others here and remembered people who are away', () => {
    const st = reduce(s(), { type: 'peers', peers: [ME, peer('fr000001', 'ana')] });
    const m = settingsMenu(st, 'people', { remembered: { fr000001: { name: 'ana', trust: 'trusted' }, aw000001: { name: 'bob', trust: 'full' } } });
    expect(ids(m)).toEqual(['p-default', 'p-person:fr000001', 'p-forget:aw000001', 'set-tunnel', 'set-back']);
    expect(m.options[2]!.label).toBe('bob (not here)');
    expect(m.options[2]!.hint).toMatch(/^Full trust/);
    expect(m.options[3]!.hint).toMatch(new RegExp(`^${TUNNEL_LABELS.auto.replace(/[()]/g, '\\$&')}`));
    expect(ids(settingsMenu(s(), 'people'))).toEqual(['p-default', 'set-tunnel', 'set-back']);
  });

  it('tunnel order covers every label', () => {
    expect([...TUNNEL_ORDER].sort()).toEqual(Object.keys(TUNNEL_LABELS).sort());
  });
});

describe('modelLabel and modelMenu', () => {
  it('labels models by value', () => {
    const s = initialState('r');
    expect(modelLabel(s, undefined)).toBe('Default');
    expect(modelLabel(s, 'opus')).toBe('Opus');
    expect(modelLabel(s, 'claude-x-1')).toBe('claude-x-1');
  });

  it('marks the current model', () => {
    // The picker milestone (BLG-446): one menu for the agent and its model, your default agent's models under it.
    const s = initialState('r');
    const m = modelMenu(s, undefined, 'this chat');
    expect(m.title).toBe('Agent and model for this chat');
    expect(ids(m)).toEqual(['runtime:claude', 'model:', 'model:opus', 'model:sonnet', 'model:haiku', 'runtime:codex', 'runtime:opencode', 'runtime:copilot', 'runtime:grok', 'runtime:local', 'close']);
    const on = (menu: ReturnType<typeof modelMenu>) => menu.options.filter((o) => o.label.trim().startsWith('◉')).map((o) => o.label.trim());
    expect(on(m)).toEqual(['◉ Default']);
    expect(on(modelMenu(reduce(s, { type: 'prefs', prefs: { model: 'opus' } }), undefined, 'x'))).toEqual(['◉ Opus']);
    // Another runtime isn't set up: its row says why, with no models under it.
    expect(m.options.find((o) => o.id === 'runtime:codex')?.hint).toBe("Codex isn't set up on this Mac yet");
    const custom = reduce(s, { type: 'models', models: [{ value: 'm1', label: 'M1', description: 'd' }] });
    expect(ids(modelMenu(custom, undefined, 'x'))).toEqual(['runtime:claude', 'model:m1', 'runtime:codex', 'runtime:opencode', 'runtime:copilot', 'runtime:grok', 'runtime:local', 'close']);
    expect(modelMenu(custom, undefined, 'x').options[1]!.label.trim()).toBe('○ M1');
  });
});

describe('inboxMenu', () => {
  it('is empty with just settings and close', () => {
    const m = inboxMenu(initialState('r'));
    expect(ids(m)).toEqual(['sec:notify', 'close']);
    expect(m.intro[0]).toMatch(/^Nothing yet/);
  });

  it('lists notices newest first with unread marks and ages, Today then Earlier', () => {
    vi.useFakeTimers();
    // Local times, so Today and Earlier split the same way in every time zone.
    const at = (day: number, h: number, m = 0, sec = 0): number => new Date(2026, 0, day, h, m, sec).getTime();
    vi.setSystemTime(at(1, 9));
    let s = reduce(initialState('r'), { type: 'notice_add', notice: { kind: 'done', title: 'old one', body: 'body' } });
    vi.setSystemTime(at(3, 9));
    s = reduce(s, { type: 'notice_add', notice: { kind: 'done', title: 'hours', body: '' } });
    vi.setSystemTime(at(3, 12));
    s = reduce(s, { type: 'notice_add', notice: { kind: 'done', title: 'minutes', body: '' } });
    vi.setSystemTime(at(3, 12, 5));
    s = reduce(s, { type: 'notice_add', notice: { kind: 'done', title: 'fresh', body: '' } });
    s = reduce(s, { type: 'notice_read', id: 2 });
    const m = inboxMenu(s, {}, at(3, 12, 5, 10));
    expect(m.intro[0]).toBe('3 new · click one to open it');
    expect(ids(m)).toEqual(['notice:4', 'notice:3', 'notice:2', 'notice:1', 'inbox-filter', 'inbox-read', 'inbox-manage', 'inbox-clear', 'sec:notify', 'close']);
    expect(m.options.slice(0, 4).map((o) => o.label)).toEqual(['● fresh', '● minutes', '  hours', '● old one']);
    expect(m.options.slice(0, 4).map((o) => o.hint)).toEqual(['now', '5m', '3h', 'Earlier · Thu  ·  body']);
  });

  it('filters, and clears one by one', () => {
    let s = reduce(initialState('r'), { type: 'notice_add', notice: { kind: 'needsYou', tag: 'approval', title: 'Run tests?', body: '' } });
    s = reduce(s, { type: 'notice_add', notice: { kind: 'mentions', tag: 'mention', title: 'bob mentioned you', body: '@kay look' } });
    s = reduce(s, { type: 'notice_read', id: 2 });
    const titles = (spec: { options: readonly { id: string; label: string }[] }): string[] => spec.options.filter((o) => o.id.startsWith('notice')).map((o) => o.label.trim());
    expect(titles(inboxMenu(s, { filter: 'unread' }))).toEqual(['● Run tests?']);
    expect(titles(inboxMenu(s, { filter: 'mentions' }))).toEqual(['bob mentioned you']);
    expect(inboxMenu(s, { filter: 'needsYou' }).options.find((o) => o.id === 'inbox-filter')).toMatchObject({ label: 'Showing: Needs you', hint: 'Enter for Mentions' });
    const read = reduce(s, { type: 'notice_read' });
    expect(inboxMenu(read, { filter: 'unread' }).intro[0]).toBe('Nothing unread.');
    expect(ids(inboxMenu(read))).not.toContain('inbox-read');
    const manage = inboxMenu(s, { manage: true });
    expect(manage.title).toBe('Inbox › Clear');
    expect(ids(manage)).toEqual(['notice-x:2', 'notice-x:1', 'inbox-clear', 'inbox-back']);
    expect(manage.options[0]!.label).toBe('× bob mentioned you');
    expect(ids(inboxMenu(initialState('r'), { manage: true }))).toEqual(['inbox-back']);
  });

  it('shows at most 30 notices', () => {
    let s = initialState('r');
    for (let i = 0; i < 35; i++) s = reduce(s, { type: 'notice_add', notice: { kind: 'done', title: `n${i}`, body: '' } });
    expect(ids(inboxMenu(s)).filter((id) => id.startsWith('notice:'))).toHaveLength(30);
  });
});

// ---------------------------------------------------------------- work-menus

describe('workMenuSpec', () => {
  const base = (): AppState => withProjects([project()]);

  it('returns null for other kinds', () => {
    expect(workMenuSpec(base(), { kind: 'agents' })).toBeNull();
    expect(workMenuSpec(base(), { kind: 'settings' })).toBeNull();
  });

  it('pr: without a PR offers to create one', () => {
    const m = spec(base(), { kind: 'pr', id: 'w1' })!;
    expect(m.title).toBe('Pull request · fix-auth');
    expect(m.intro[0]).toBe('No pull request for beluga/fix-auth yet.');
    expect(m.intro[1]).toMatch(/^Your agent commits/);
    expect(ids(m)).toEqual(['pr-create', 'pr-create-note', 'pr-edit-prompt', 'close']);
    expect(m.options[2]!.hint).toBe('built-in');
  });

  it('pr: tells you to install gh when it is missing', () => {
    const s = reduce(base(), { type: 'gh', ok: false });
    expect(spec(s, { kind: 'pr', id: 'w1' })!.intro[1]).toMatch(/Install the GitHub CLI/);
    const ok = reduce(base(), { type: 'gh', ok: true });
    expect(spec(ok, { kind: 'pr', id: 'w1' })!.intro[1]).toMatch(/^Your agent commits/);
  });

  it('pr: with an open PR and failing checks offers to fix and update', () => {
    let s = reduce(base(), { type: 'pr', id: 'w1', pr: pr({ checks: 'failing' }) });
    s = reduce(s, { type: 'pr_custom', custom: true });
    const m = spec(s, { kind: 'pr', id: 'w1' })!;
    expect(m.intro[0]).toBe('PR #12 · checks failing · Fix auth');
    expect(ids(m)).toEqual(['pr-open', 'pr-fix', 'pr-update', 'pr-refresh', 'pr-edit-prompt', 'close']);
    expect(m.options[0]).toMatchObject({ label: 'Open PR #12 in the browser', hint: 'https://github.com/x/y/pull/12' });
    expect(m.options[4]!.hint).toBe('customized');
  });

  it('pr: passing or merged PRs have no fix / update', () => {
    const passing = reduce(base(), { type: 'pr', id: 'w1', pr: pr() });
    expect(ids(spec(passing, { kind: 'pr', id: 'w1' }))).toEqual(['pr-open', 'pr-update', 'pr-refresh', 'pr-edit-prompt', 'close']);
    const merged = reduce(base(), { type: 'pr', id: 'w1', pr: pr({ state: 'MERGED', checks: 'failing' }) });
    expect(ids(spec(merged, { kind: 'pr', id: 'w1' }))).toEqual(['pr-open', 'pr-fix', 'pr-refresh', 'pr-edit-prompt', 'close']);
  });

  it('pr: unknown workspace is undefined; branchless falls back', () => {
    expect(spec(base(), { kind: 'pr', id: 'nope' })).toBeUndefined();
    const s = withProjects([project({ workspaces: [ws({ branch: undefined })] })]);
    expect(spec(s, { kind: 'pr', id: 'w1' })!.intro[0]).toBe('No pull request for this branch yet.');
  });

  it('scripts: shows commands with where they came from', () => {
    const p = project({ scripts: { setup: { command: 'npm i', source: 'yours' }, run: { command: 'npm start', source: 'klaud.json' } } });
    const m = spec(withProjects([p]), { kind: 'scripts', projectId: 'p1' })!;
    expect(m.title).toBe('app · setup and run');
    expect(ids(m)).toEqual(['s-setup', 's-run', 's-team', 'close']);
    expect(m.options[0]).toMatchObject({ label: 'Setup: npm i', hint: 'set by you  ·  Enter to change' });
    expect(m.options[1]).toMatchObject({ label: 'Run: npm start', hint: 'from klaud.json  ·  Enter to change' });
    expect(m.intro[2]).toBe('Setup in new worktrees is on.');
  });

  it('scripts: detected / conductor sources, none, and setup off', () => {
    const p = project({ scripts: { setup: { command: 'pnpm i', source: 'detected' }, run: { command: 'make', source: 'conductor.json' } } });
    const m = spec(withProjects([p]), { kind: 'scripts', projectId: 'p1' })!;
    expect(ids(m)).toEqual(['s-setup', 's-run', 'close']);
    expect(m.options[0]!.hint).toMatch(/^guessed from the project/);
    expect(m.options[1]!.hint).toMatch(/^from conductor\.json/);
    const off = withProjects([project()], initialState('r', 'ask', { autoSetup: false }));
    const none = spec(off, { kind: 'scripts', projectId: 'p1' })!;
    expect(none.options[0]).toMatchObject({ label: 'Setup: none', hint: 'nothing found  ·  Enter to change' });
    expect(none.options[1]!.label).toBe('Run: none');
    expect(none.intro[2]).toMatch(/is off/);
    const runOnlyYours = project({ scripts: { run: { command: 'go run .', source: 'yours' } } });
    expect(ids(spec(withProjects([runOnlyYours]), { kind: 'scripts', projectId: 'p1' }))).toContain('s-team');
    expect(spec(base(), { kind: 'scripts', projectId: 'nope' })).toBeUndefined();
  });

  it('templates: pick fills the box; manage removes your own', () => {
    const long = 'x'.repeat(80);
    const s = reduce(base(), { type: 'templates', templates: [tpl('b', { builtIn: true, plan: true }), tpl('mine', { prompt: long })] });
    const pick = spec(s, { kind: 'templates' })!;
    expect(pick.title).toBe('Start from a template');
    expect(ids(pick)).toEqual(['tpl:b', 'tpl:mine', 'tpl-save', 'tpl-manage', 'close']);
    expect(pick.options[0]!.hint).toBe('plans first · do b');
    expect(pick.options[1]!.hint).toBe(`${'x'.repeat(70)}…`);
    const manage = spec(s, { kind: 'templates', manage: true })!;
    expect(manage.title).toBe('Templates');
    expect(ids(manage)).toEqual(['tpl:b', 'tpl-del:mine', 'tpl-save', 'close']);
    expect(manage.options[1]).toMatchObject({ label: 'Remove "T mine"', hint: 'x'.repeat(60) });
  });

  it('handoff: lists people with a Claude (not you)', () => {
    let s = reduce(base(), { type: 'welcome', self: ME });
    s = reduce(s, { type: 'peers', peers: [ME, peer('fr000001', 'ana'), peer('nc000001', 'noclaude', { agent: false })] });
    const m = spec(s, { kind: 'handoff', id: 'w1' })!;
    expect(m.title).toBe('Hand off fix-auth');
    expect(ids(m)).toEqual(['ho:fr000001', 'close']);
    expect(m.options[0]!.label).toBe('Hand off to ana');
    expect(m.intro.join('\n')).not.toContain('No friends to hand');
  });

  it('handoff: without people says to add a friend; unknown workspace is undefined', () => {
    const m = spec(base(), { kind: 'handoff', id: 'w1' })!;
    expect(ids(m)).toEqual(['close']);
    expect(m.intro).toContain('No friends to hand it to yet. Type /invite to add one.');
    expect(spec(base(), { kind: 'handoff', id: 'nope' })).toBeUndefined();
  });

  it("remote_ws: lists the friend's projects", () => {
    const s = reduce(base(), { type: 'peers', peers: [peer('fr000001', 'ana', { projects: ['web', 'api'] }), peer('fr000002', 'bob')] });
    const m = spec(s, { kind: 'remote_ws', peerId: 'fr000001' })!;
    expect(m.title).toBe("Start a worktree on ana's computer");
    expect(ids(m)).toEqual(['rws:web', 'rws:api', 'close']);
    expect(ids(spec(s, { kind: 'remote_ws', peerId: 'fr000002' }))).toEqual(['close']);
    expect(spec(s, { kind: 'remote_ws', peerId: 'nobody' })).toBeUndefined();
  });

  it('ws_more: one option per hidden action', () => {
    const m = spec(base(), { kind: 'ws_more', id: 'w1', actions: [{ action: 'fork', label: 'Fork', hint: 'copy' }, { action: 'archive', label: 'Archive', hint: 'away' }] })!;
    expect(m.title).toBe('More');
    expect(ids(m)).toEqual(['wsact:fork', 'wsact:archive', 'close']);
    expect(m.options[0]).toMatchObject({ label: 'Fork', hint: 'copy' });
  });
});

// ---------------------------------------------------------------- workspace header overflow

describe('workspaceHeaderModel overflow and hidden buttons', () => {
  const header = (s: AppState, width: number): Model => workspaceHeaderModel(s, s.projects[0]!.workspaces[1]!, width);
  const wsActions = (m: Model): string[] => m.zones.flatMap((z) => (z.action.type === 'ws' ? [z.action.action] : []));

  it('shows every button when there is room, with no More', () => {
    const m = header(withProjects([project()]), 200);
    expect(wsActions(m)).toEqual(['review_claude', 'commit', 'pr', 'merge', 'handoff', 'fork', 'finder', 'archive', 'share']);
    expect(m.zones.some((z) => z.action.type === 'ws_more')).toBe(false);
  });

  it('puts the buttons that do not fit under a last "⋯ More" zone (enabled ones only)', () => {
    const m = header(withProjects([project()]), 60);
    expect(wsActions(m)).toEqual(['review_claude', 'commit']);
    const more = m.zones.at(-1)!;
    expect(more.action.type).toBe('ws_more');
    expect(more.y).toBe(1);
    expect(zoneText(m.lines[1]!, more)).toBe(' ⋯ More ');
    expect(more.x1).toBeLessThan(60);
    if (more.action.type !== 'ws_more') throw new Error('expected ws_more');
    expect(more.action.id).toBe('w1');
    // Merge (uncommitted changes) and Hand off (nobody here) are disabled, so they're left out
    expect(more.action.actions.map((a) => a.action)).toEqual(['pr', 'fork', 'finder', 'archive', 'share']);
    expect(more.hint).toBe('PR, Fork, Finder, Archive, Share');
  });

  it('hides buttons listed in hiddenButtons, but never "Solve conflict"', () => {
    let s = withProjects([project()], initialState('r', 'ask', { hiddenButtons: ['review_claude', 'merge', 'share'] }));
    expect(wsActions(header(s, 200))).toEqual(['commit', 'pr', 'handoff', 'fork', 'finder', 'archive']);
    s = reduce(s, { type: 'conflicts', id: 'w1', files: ['a.ts'] });
    expect(wsActions(header(s, 200))).toContain('merge_claude');
    const shown = reduce(withProjects([project()]), { type: 'conflicts', id: 'w1', files: ['a.ts'] });
    expect(wsActions(header(shown, 200))).toContain('merge_claude');
  });

  it('hidden buttons make room so fewer go under More', () => {
    const s = withProjects([project()], initialState('r', 'ask', { hiddenButtons: ['review_claude', 'commit', 'merge', 'handoff', 'share'] }));
    const m = header(s, 60);
    expect(wsActions(m)).toEqual(['pr', 'fork']);
    const more = m.zones.at(-1)!;
    expect(more.action.type === 'ws_more' && more.action.actions.map((a) => a.action)).toEqual(['finder', 'archive']);
  });
});
