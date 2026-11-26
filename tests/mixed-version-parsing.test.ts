import { describe, expect, it } from 'vitest';
import { encodeFrame, parseClientFrame } from '../src/ipc/protocol.js';
import { MachineInfo, MachineSync } from '../src/machines/info.js';

/**
 * Several Beluga versions in one cluster: what a newer one sends has values an older one doesn't
 * know. A value it can't read is left out, never the whole frame: a screen's hello offering a newer
 * cap was dropped ("the daemon did not answer"), and one unknown value in a computer's sync made it
 * show as offline, with its roster and settings not synced.
 */

const hello = (caps: string[]) => encodeFrame({ t: 'hello', token: 'x'.repeat(16), ipc: 1, kind: 'mac', version: '9.9.9', caps } as never);

const INFO = {
  at: 1,
  version: '9.9.9',
  ipc: 1,
  name: 'Mac mini',
  icon: 'desktop',
  cpus: 8,
  loadPerCore: 0.2,
  memory: { freeGB: 4, totalGB: 16 },
  agentsRunning: 0,
  runtimes: [{ id: 'claude', state: 'ready' }],
  gh: 'signed_in',
  mcp: [{ name: 'fs', from: 'user' }],
  projects: [{ name: 'beluga' }],
};

describe('a newer screen’s hello', () => {
  it('keeps the caps this daemon knows and leaves out the rest', () => {
    expect(parseClientFrame(hello(['notify', 'aNewerCap', 'raise']))).toMatchObject({ t: 'hello', caps: ['notify', 'raise'] });
  });

  it('still refuses what isn’t a hello at all', () => {
    expect(parseClientFrame(encodeFrame({ t: 'hello', token: 'short' } as never))).toBeUndefined();
  });
});

describe('a newer computer’s info and sync', () => {
  it('reads as it always did when every value is known', () => {
    expect(MachineInfo.parse(INFO)).toMatchObject(INFO);
  });

  it('an icon, a runtime state, an MCP source or a GitHub state it doesn’t know: that value is left out', () => {
    const newer = {
      ...INFO,
      icon: 'aNewerIcon',
      runtimes: [{ id: 'claude', state: 'ready' }, { id: 'local', state: 'no_endpoint' }],
      gh: 'aNewerState',
      mcp: [{ name: 'fs', from: 'user' }, { name: 'x', from: 'aNewerSource' }],
    };
    const info = MachineInfo.parse(newer);
    expect(info.icon).toBeUndefined();
    expect(info.runtimes).toEqual([{ id: 'claude', state: 'ready' }]);
    expect(info.gh).toBe('missing');
    expect(info.mcp).toEqual([{ name: 'fs', from: 'user' }]);
    expect(info).toMatchObject({ name: 'Mac mini', cpus: 8, projects: [{ name: 'beluga' }] });
  });

  it('more entries than this side keeps: the first ones, not none', () => {
    const runtimes = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, state: 'ready' }));
    expect(MachineInfo.parse({ ...INFO, runtimes }).runtimes).toHaveLength(8);
    expect(() => MachineInfo.parse({ ...INFO, runtimes: Array.from({ length: 100 }, () => runtimes[0]) })).toThrow();
  });

  it('a sync with a part this side can’t read keeps the rest (the roster with it)', () => {
    const sync = MachineSync.parse({
      t: 'devset',
      forgotten: [],
      want: ['info', 'aNewerAsk'],
      info: { ...INFO, cpus: 'not a number any more' },
      update: { mode: 'aNewerMode' },
      look: { name: 'Office Mac', icon: 'aNewerIcon' },
    });
    expect(sync).toMatchObject({ t: 'devset', forgotten: [], want: ['info'], look: { name: 'Office Mac' } });
    expect(sync.info).toBeUndefined();
    expect(sync.update).toBeUndefined();
    expect(sync.look?.icon).toBeUndefined();
  });
});
