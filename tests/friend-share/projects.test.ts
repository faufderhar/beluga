import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { cannotTake } from '../../src/net/mesh/features.js';
import { createDemoWorkspaces } from '../../src/demo.js';
import { type Crowd, SLOW, befriend, crowd, settle } from '../mesh/helpers.js';
import { type Mac, mac } from './helpers.js';

/** BLG-204: a project shared with a friend over the network (nobody hosts): two simulated Macs on a local testnet. */

let net: Crowd | undefined;
const macs: Mac[] = [];

afterEach(async () => {
  for (const m of macs.splice(0)) await m.close();
  await net?.close();
  net = undefined;
});

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const chatSeen = (m: Mac, channel: string, text: string) => m.store.getState().log.some((l) => l.type === 'chat' && l.channel === channel && l.text === text);

describe('sharing a project with a friend over the network', () => {
  it('shows as one project with its worktrees, follows new ones, stays while the owner is offline, and goes when unshared', async () => {
    net = await crowd();
    const ata = await mac(net, 'ata', { workspaces: await createDemoWorkspaces() });
    const kay = await mac(net, 'kay');
    macs.push(ata, kay);
    await befriend(ata.person, kay.person);

    const project = ata.store.getState().projects.find((p) => p.name === 'bob-api')!;
    // Worktrees made outside Beluga stay on the owner's Mac.
    const live = project.workspaces.filter((w) => !w.archived && !w.external && w.kind !== 'main');
    expect(live.length).toBeGreaterThan(0);
    ata.session.sharing.shareWithFriend({ peerId: kay.id, projectId: project.id, role: 'contribute' });

    // One project row on kay's Mac, its worktrees under it (each a workspace shared with her, over the network).
    const shared = await settle(() => kay.store.getState().sharedProjects.find((p) => p.id === project.id && p.worktrees.length === live.length));
    expect(shared).toMatchObject({ owner: ata.id, ownerName: 'ata', name: 'bob-api', role: 'contribute' });
    expect(kay.store.getState().shared.filter((w) => w.via === 'mesh').map((w) => w.id).sort()).toEqual(live.map((w) => w.id).sort());
    expect(ata.store.getState().projectShares[project.id]?.[kay.id]).toEqual({ role: 'contribute' });

    // Ata's Mac goes offline: the project stays in kay's Projects (and after kay restarts too).
    await ata.stop();
    await settle(() => kay.person.friend(ata.id)?.online === false);
    expect(kay.store.getState().sharedProjects).toHaveLength(1);
    await kay.stop();
    // A fresh start: only what's on disk (~/.beluga/shared-projects.json).
    kay.store.dispatch({ type: 'fshare_projects', projects: [] });
    await kay.start();
    expect(kay.store.getState().sharedProjects.map((p) => p.name)).toEqual(['bob-api']);
    await ata.start();

    // A new worktree in the project reaches kay by itself.
    const added = await ata.session.workspaces!.manager.createWorktree(project.id, 'live-update');
    await ata.session.workspaces!.refresh();
    await settle(() => kay.store.getState().sharedProjects[0]?.worktrees.some((w) => w.id === added.id));

    // Unsharing takes it away.
    ata.session.sharing.unshareFriend({ peerId: kay.id, projectId: project.id });
    await settle(() => kay.store.getState().sharedProjects.length === 0 && !kay.store.getState().shared.some((w) => w.via === 'mesh'));
    expect(ata.store.getState().members[live[0]!.id]?.[kay.id]).toBeUndefined();
  }, 60_000 * SLOW);

  it('a friend who can only follow along can read but not ask', async () => {
    net = await crowd();
    const ata = await mac(net, 'ata', { workspaces: await createDemoWorkspaces() });
    const kay = await mac(net, 'kay');
    macs.push(ata, kay);
    await befriend(ata.person, kay.person);
    const project = ata.store.getState().projects.find((p) => p.name === 'bob-api')!;
    const ws = project.workspaces.find((w) => !w.archived && !w.external && w.kind !== 'main')!;
    ata.session.sharing.shareWithFriend({ peerId: kay.id, workspaceId: ws.id, role: 'view' });
    const shared = await settle(() => kay.store.getState().sharedProjects[0]);
    expect(shared.worktrees.map((w) => w.id)).toEqual([ws.id]);
    expect(shared.role).toBe('view');
    // The composer refuses (a toast says why); nothing reaches ata's Claude.
    expect(kay.session.submit('do something', { channel: `ws:${ws.id}` })).toBe(false);
    ata.session.sendChat('watch this', false, `ws:${ws.id}`);
    await settle(() => chatSeen(kay, `ws:${ws.id}`, 'watch this'));
    expect(ata.runs).toHaveLength(0);
  }, 40_000 * SLOW);

  it('only friends, and a friend whose Beluga is too old is told at once', async () => {
    net = await crowd();
    const ata = await mac(net, 'ata');
    macs.push(ata);
    // Reject a non-friend before resolving the project; no repositories need to be created.
    expect(() => ata.session.sharing.shareWithFriend({ peerId: 'x'.repeat(32), projectId: 'not-shared', role: 'view' })).toThrow(/friend first/);
    expect(cannotTake('Ata', { version: '0.6.0+mac.1.1.0', can: ['chat.files', 'task.ask'] }, 'share.project')).toBe("Ata's Beluga 1.1.0 can't open shared projects yet. Ask Ata to update Beluga.");
    expect(cannotTake('Ata', { version: '0.6.3+mac.1.3.0', can: ['share.project'] }, 'share.project')).toBeUndefined();
  }, 20_000 * SLOW);

  it('shared whole, the friend gets their own copy of it: a bundle from the owner when it can’t be cloned (BLG-258)', async () => {
    net = await crowd();
    const ata = await mac(net, 'ata', { workspaces: await createDemoWorkspaces() });
    const kay = await mac(net, 'kay', { workspaces: await createDemoWorkspaces() });
    macs.push(ata, kay);
    await befriend(ata.person, kay.person);
    const project = ata.store.getState().projects.find((p) => p.name === 'bob-api')!;
    const branches = git(project.root, 'branch', '--format=%(refname:short)').split('\n').sort();

    ata.session.sharing.shareWithFriend({ peerId: kay.id, projectId: project.id, role: 'contribute' });
    const shared = await settle(() => kay.store.getState().sharedProjects.find((p) => p.id === project.id && p.copy?.state === 'ready'));
    const copy = shared!.copy!;
    expect(copy.path).toMatch(/copies[\\/]ata[\\/]bob-api$/);
    expect(git(copy.path!, 'branch', '--format=%(refname:short)').split('\n').sort()).toEqual(branches);
    // It's one of kay's projects now.
    expect(kay.store.getState().projects.some((p) => p.id === copy.projectId && p.root === copy.path)).toBe(true);

    // In one of ata's worktrees, kay can run it on this Mac instead: a worktree of hers on the same branch, in her copy.
    const theirs = project.workspaces.find((w) => w.kind === 'worktree' && !w.archived && !w.external && w.branch)!;
    const localId = await kay.shares.runHere(ata.id, theirs.id, 'try it here');
    const local = kay.store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.id === localId)!;
    expect(local.branch).toBe(theirs.branch);
    await settle(() => kay.runs.some((r) => r.prompt.includes('try it here')));
    expect(ata.runs.some((r) => r.prompt.includes('try it here'))).toBe(false);
    // Again: the same worktree, not a new one.
    expect(await kay.shares.runHere(ata.id, theirs.id, 'and again')).toBe(localId);

    // A worktree shared on its own is followed, not copied.
    const one = await ata.session.workspaces!.manager.createWorktree(project.id, 'only-this');
    await ata.session.workspaces!.refresh();
    const other = ata.store.getState().projects.find((p) => p.name === 'landing')!;
    const ws = other.workspaces.find((w) => w.kind !== 'main' && !w.archived) ?? one;
    ata.session.sharing.shareWithFriend({ peerId: kay.id, workspaceId: ws.id, role: 'view' });
    const single = await settle(() => kay.store.getState().sharedProjects.find((p) => p.worktrees.some((w) => w.id === ws.id)));
    expect(single!.copy).toBeUndefined();
  }, 60_000 * SLOW);
});
