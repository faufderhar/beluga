import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LogItem } from '../src/core/store.js';
import { INITIAL_UPDATE_STATE, type UpdateState, activityOf, idleLine, lastCheckedLabel, pillOf, placeAction, shortVersion, statusLine } from '../packages/mac/src/lib/update-model.js';

/**
 * The Mac app's own updates, as the window shows them (packages/mac/src/lib/update-model.ts).
 * When to look and when to install quietly is decided in the app shell and tested there
 * (packages/mac/src-tauri/src/update_rules.rs).
 */

const state = (patch: Partial<UpdateState> = {}): UpdateState => ({ ...INITIAL_UPDATE_STATE, current: '0.4.0', ...patch });
const ready = state({ phase: 'ready', available: { version: '0.5.0', notes: '- Faster' }, choice: 'quit' });

describe('the Mac app version', () => {
  it('is the same in tauri.conf.json and package.json, so a release is detected as newer', () => {
    const conf = JSON.parse(readFileSync('packages/mac/src-tauri/tauri.conf.json', 'utf8')) as { version: string; plugins: { updater: { endpoints: string[]; pubkey: string } }; bundle: { createUpdaterArtifacts: boolean } };
    const pkg = JSON.parse(readFileSync('packages/mac/package.json', 'utf8')) as { version: string };
    expect(conf.version).toBe(pkg.version);
    expect(conf.bundle.createUpdaterArtifacts).toBe(true);
    expect(conf.plugins.updater.endpoints).toEqual(['https://github.com/beluga-labs/beluga/releases/latest/download/latest.json']);
    expect(Buffer.from(conf.plugins.updater.pubkey, 'base64').toString()).toContain('minisign public key');
  });

  it('is read from tauri.conf.json by the window, never written twice', () => {
    expect(readFileSync('packages/mac/src/lib/boot.ts', 'utf8')).toMatch(/import \{ version \} from '..\/..\/src-tauri\/tauri.conf.json'/);
  });
});

describe('what the window says', () => {
  it('names versions the way people say them', () => {
    expect(shortVersion('0.5.0')).toBe('0.5');
    expect(shortVersion('v1.0.0')).toBe('1.0');
    expect(shortVersion('0.4.1')).toBe('0.4.1');
    expect(shortVersion('0.5.0-beta.1')).toBe('0.5.0-beta.1');
  });

  it('shows the pill only for a downloaded update or what just changed', () => {
    expect(pillOf(state())).toBeUndefined();
    expect(pillOf(state({ phase: 'downloading', progress: 0.4 }))).toBeUndefined();
    expect(pillOf(ready)).toEqual({ label: 'Beluga 0.5 is ready', kind: 'ready' });
    // Looking again while one is downloaded doesn't make it blink away.
    expect(pillOf({ ...ready, phase: 'checking' })?.kind).toBe('ready');
    expect(pillOf({ ...ready, phase: 'installing' })?.label).toBe('Updating Beluga…');
    expect(pillOf(state({ news: { version: '0.5.0' } }))).toEqual({ label: 'Updated to 0.5 · What’s new', kind: 'news' });
  });

  it('says when Beluga last looked', () => {
    const now = new Date(2026, 9, 18, 15, 0).getTime();
    expect(lastCheckedLabel(undefined, now)).toBe('Never');
    expect(lastCheckedLabel(null, now)).toBe('Never');
    expect(lastCheckedLabel(now - 20_000, now)).toBe('Just now');
    expect(lastCheckedLabel(now - 60_000, now)).toBe('1 minute ago');
    expect(lastCheckedLabel(now - 12 * 60_000, now)).toBe('12 minutes ago');
    expect(lastCheckedLabel(new Date(2026, 9, 18, 9, 41).getTime(), now, 'en-GB')).toBe('Today at 9:41');
    expect(lastCheckedLabel(new Date(2026, 9, 17, 18, 2).getTime(), now, 'en-GB')).toBe('Yesterday at 18:02');
    expect(lastCheckedLabel(new Date(2026, 9, 3, 12, 0).getTime(), now, 'en-GB')).toBe('3 Oct');
  });

  it('says what Update When Idle still waits for', () => {
    expect(idleLine([])).toMatch(/as soon as you step away/);
    expect(idleLine(['you'])).toBe('Waiting for you to step away for 10 minutes.');
    expect(idleLine(['claude', 'terminal', 'you'])).toBe('Waiting for your agent to finish, programs in your terminals to finish and you to step away for 10 minutes.');
  });

  it('sums up the state for Settings', () => {
    expect(statusLine(state())).toBe('');
    expect(statusLine(state({ phase: 'checking' }))).toBe('Checking…');
    expect(statusLine(state({ phase: 'downloading', progress: 0.42 }))).toBe('Downloading · 42%');
    expect(statusLine(state({ phase: 'current' }))).toBe('Beluga is up to date.');
    expect(statusLine(state({ phase: 'error', error: 'Offline' }))).toBe('Offline');
    expect(statusLine(ready)).toBe('Beluga 0.5 is ready · installs when you quit');
    expect(statusLine({ ...ready, choice: 'idle' })).toBe('Beluga 0.5 is ready · installs when you’re idle');
  });
});

const agent = (status: string, owner = 'me'): LogItem => ({ id: `a-${status}-${owner}`, type: 'agent', channel: 'ws:1', subagents: [], requestId: 'r', owner, ownerName: owner, requesterName: owner, status, text: '', steps: [], ts: 0 }) as LogItem;

describe('what the app shell is told before installing quietly', () => {
  it('counts your Claude runs, the people in your room and whether you joined someone else’s', () => {
    const st = { selfId: 'me', isHost: true, peers: [{ peerId: 'me' }], log: [agent('done'), agent('tool'), agent('queued'), agent('text', 'bob')] };
    expect(activityOf(st)).toEqual({ claude: 2, guests: 0, joined: false });
    expect(activityOf({ ...st, peers: [{ peerId: 'me' }, { peerId: 'bob' }] }).guests).toBe(1);
    expect(activityOf({ ...st, isHost: false }).joined).toBe(true);
    // Before klaud says who you are, nothing counts as joined.
    expect(activityOf({ ...st, selfId: '', isHost: false }).joined).toBe(false);
  });
});

describe('going back to where you were after Restart Now', () => {
  const projects = [{ id: 'p1', workspaces: [{ id: 'w1' }] }];
  const now = 1_000_000_000;

  it('reopens the workspace, project or place you had open', () => {
    expect(placeAction({ view: { kind: 'workspace', id: 'w1', tab: 'review' }, at: now - 5000 }, { projects }, now)).toEqual({ type: 'open_ws', id: 'w1', tab: 'review' });
    expect(placeAction({ view: { kind: 'project', id: 'p1' }, at: now }, { projects }, now)).toEqual({ type: 'view', view: { kind: 'project', id: 'p1' } });
    expect(placeAction({ view: { kind: 'usage' }, at: now }, { projects }, now)).toEqual({ type: 'view', view: { kind: 'usage' } });
  });

  it('forgets places that are gone, stale or can’t be reopened', () => {
    expect(placeAction(undefined, { projects }, now)).toBeUndefined();
    expect(placeAction({ view: { kind: 'workspace', id: 'gone', tab: 'chat' }, at: now }, { projects }, now)).toBeUndefined();
    expect(placeAction({ view: { kind: 'project', id: 'gone' }, at: now }, { projects }, now)).toBeUndefined();
    expect(placeAction({ view: { kind: 'usage' }, at: now - 11 * 60_000 }, { projects }, now)).toBeUndefined();
    expect(placeAction({ view: { kind: 'draft', projectId: 'p1', back: { kind: 'room' } }, at: now }, { projects }, now)).toBeUndefined();
  });
});
