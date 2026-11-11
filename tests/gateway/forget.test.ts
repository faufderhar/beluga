import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { conversations, homeView } from '../../src/companion/views.js';
import { type Crowd, LOSES_A_MESSAGE_ON_WINDOWS, befriend, crowd, settle } from '../mesh/helpers.js';
import { type Node, node, task } from './helpers.js';

/**
 * A request you asked of a friend's Claude that never ends (BLG-356): Remove takes it off your
 * lists (cancelling it first), and one handed over that then goes quiet for a day stops showing
 * as running.
 */

let net: Crowd;
beforeAll(async () => {
  net = await crowd();
}, 30_000);
afterAll(async () => {
  await net?.close();
});

async function pair(a: string, b: string, extra: Parameters<typeof node>[2] = {}): Promise<[Node, Node]> {
  const x = await node(net, a, extra);
  const y = await node(net, b);
  await befriend(x.person, y.person);
  return [x, y];
}

const running = (n: Node): string[] => homeView(n.store.getState(), { mac: { name: 'Mac', version: '1' } } as never).running.map((c) => c.topic);

describe('a request that never ends', () => {
  it.skipIf(LOSES_A_MESSAGE_ON_WINDOWS)('Remove cancels it on their side and takes it off yours', async () => {
    const [ria, sol] = await pair('ria', 'sol');
    ria.trust(sol.id, 'trusted');
    sol.trust(ria.id, 'trusted');
    sol.claude.hold();
    const t = ria.gw.ask({ person: 'sol', ask: 'show me your desktop wallpaper', by: 'person' });
    await settle(() => task(ria, t.id)?.state === 'working');
    expect(conversations(ria.store.getState()).some((c) => c.channel === `task:${t.id}`)).toBe(true);
    ria.gw.forget(t.id);
    expect(task(ria, t.id)).toBeUndefined();
    expect(ria.store.getState().gateway.tasks.some((x) => x.id === t.id)).toBe(false);
    expect(conversations(ria.store.getState()).some((c) => c.channel === `task:${t.id}`)).toBe(false);
    await settle(() => task(sol, t.id)?.state === 'cancelled');
    sol.claude.open();
    // Only what you sent can be removed.
    const back = sol.gw.ask({ person: 'ria', ask: 'and yours?', by: 'person' });
    await settle(() => task(ria, back.id) !== undefined);
    expect(() => ria.gw.forget(back.id)).toThrow(/you sent/);
  }, 90_000);

  it.skipIf(LOSES_A_MESSAGE_ON_WINDOWS)('a day without word from their Mac: it failed, and stops showing as running', async () => {
    let clock = Date.now();
    const [tao, uma] = await pair('tao', 'uma', { now: () => clock });
    tao.trust(uma.id, 'trusted');
    uma.trust(tao.id, 'trusted');
    uma.claude.hold();
    const t = tao.gw.ask({ person: 'uma', ask: 'a long one', by: 'person' });
    await settle(() => task(tao, t.id)?.state === 'working');
    // Uma's Mac goes away for good (an older Beluga that lost the task): nothing more comes back.
    await uma.stop();
    (tao.gw as unknown as { tick(): void }).tick();
    expect(task(tao, t.id)?.state).toBe('working');
    expect(running(tao)).toContain(`conv:task:${t.id}`);
    clock += 25 * 3600_000;
    (tao.gw as unknown as { tick(): void }).tick();
    expect(task(tao, t.id)?.state).toBe('failed');
    expect(task(tao, t.id)?.result?.summary).toBe('No word from uma in a day');
    expect(running(tao)).not.toContain(`conv:task:${t.id}`);
    uma.claude.open();
  }, 90_000);
});
