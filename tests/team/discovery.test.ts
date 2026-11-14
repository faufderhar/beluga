import { afterEach, describe, expect, it } from 'vitest';
import { needsYou } from '../../src/companion/views.js';
import { fingerprint, pairKey, repoKey } from '../../src/core/team/fingerprint.js';
import { cannotTake } from '../../src/net/mesh/features.js';
import { type Crowd, befriend, crowd, settle } from '../mesh/helpers.js';
import { type TeamMac, teamMac } from './helpers.js';

/** BLG-221: friends on the same GitHub repository find each other and team up, both saying yes. */

let net: Crowd | undefined;
const macs: TeamMac[] = [];

afterEach(async () => {
  for (const m of macs.splice(0)) await m.close();
  await net?.close();
  net = undefined;
});

describe('fingerprints', () => {
  it('are the same for both people of a pair, different for another pair, and never the name', () => {
    const [a, b, c] = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)];
    const repo = repoKey({ host: 'github.com', owner: 'Acme', repo: 'API' });
    expect(repo).toBe('github.com/acme/api');
    expect(fingerprint(pairKey(a, b), repo)).toBe(fingerprint(pairKey(b, a), repo));
    expect(fingerprint(pairKey(a, b), repo)).not.toBe(fingerprint(pairKey(a, c), repo));
    expect(fingerprint(pairKey(a, b), repo)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('teaming up on the same repository', () => {
  it('offers on both sides, forms only when both say yes, keeps it after a restart, and either can leave', async () => {
    net = await crowd();
    const ata = await teamMac(net, 'ata', [
      { id: 'p-ata-api', name: 'api', repo: 'acme/api' },
      { id: 'p-ata-secret', name: 'secret', repo: 'acme/secret' },
    ]);
    const kay = await teamMac(net, 'kay', [
      { id: 'p-kay-api', name: 'acme-api', repo: 'Acme/API' },
      { id: 'p-kay-web', name: 'web', repo: 'acme/web' },
      { id: 'p-kay-local', name: 'scratch' },
    ]);
    macs.push(ata, kay);
    await befriend(ata.person, kay.person);

    // Only the repository both have is offered, on both Macs; nothing else is known about the rest.
    const offerA = await settle(() => ata.store.getState().team.offers.find((o) => o.peerId === kay.id));
    const offerK = await settle(() => kay.store.getState().team.offers.find((o) => o.peerId === ata.id));
    expect(offerA).toMatchObject({ projectId: 'p-ata-api', repo: 'acme/api', state: 'found', name: 'kay' });
    expect(offerK).toMatchObject({ projectId: 'p-kay-api', repo: 'Acme/API', state: 'found', name: 'ata' });
    expect(ata.store.getState().team.offers).toHaveLength(1);
    expect(kay.store.getState().team.offers).toHaveLength(1);
    expect(ata.notices.some((n) => n.title === 'kay also works on acme/api')).toBe(true);
    // The phone has it as a card with Team Up / Not Now.
    const card = needsYou(kay.store.getState()).find((n) => n.id === `team:${ata.id}:p-kay-api`);
    expect(card?.actions.map((a) => a.label)).toEqual(['Team Up', 'Not Now']);

    // One yes isn't a team.
    ata.team.answer(kay.id, 'p-ata-api', true);
    await settle(() => kay.store.getState().team.offers.find((o) => o.state === 'invited'));
    expect(ata.store.getState().team.offers[0]?.state).toBe('asked');
    expect(ata.store.getState().team.teams).toEqual({});
    expect(kay.store.getState().team.teams).toEqual({});
    expect(kay.notices.some((n) => n.title === 'ata wants to team up on Acme/API')).toBe(true);

    // Both: a team on both Macs, with the same link.
    kay.team.answer(ata.id, 'p-kay-api', true);
    await settle(() => ata.store.getState().team.teams['p-ata-api']);
    expect(kay.store.getState().team.teams['p-kay-api']?.mates.map((m) => m.name)).toEqual(['ata']);
    expect(ata.store.getState().team.teams['p-ata-api']?.mates.map((m) => m.name)).toEqual(['kay']);
    expect(ata.team.allLinks()[0]?.id).toBe(kay.team.allLinks()[0]?.id);
    expect(ata.team.allLinks()[0]?.theirProject).toBe('acme-api');
    expect(ata.store.getState().team.offers).toEqual([]);
    expect(needsYou(kay.store.getState()).some((n) => n.id.startsWith('team:'))).toBe(false);

    // A restart keeps it (teams.json).
    await kay.stop();
    kay.store.dispatch({ type: 'team_off' });
    await kay.start();
    expect(kay.store.getState().team.teams['p-kay-api']?.mates.map((m) => m.peerId)).toEqual([ata.id]);

    // Leaving ends it on both Macs, and it isn't offered again by itself.
    kay.team.leave('p-kay-api');
    await settle(() => !ata.store.getState().team.teams['p-ata-api']);
    expect(kay.store.getState().team.teams).toEqual({});
    expect(ata.store.getState().team.offers).toEqual([]);
  }, 60_000);

  it('Not Now hides the offer; two yeses at once settle on one team', async () => {
    net = await crowd();
    const ata = await teamMac(net, 'ata', [{ id: 'a1', name: 'api', repo: 'acme/api' }]);
    const kay = await teamMac(net, 'kay', [{ id: 'k1', name: 'api', repo: 'acme/api' }]);
    macs.push(ata, kay);
    await befriend(ata.person, kay.person);
    await settle(() => ata.store.getState().team.offers[0] && kay.store.getState().team.offers[0]);
    ata.team.answer(kay.id, 'a1', true);
    kay.team.answer(ata.id, 'k1', true);
    await settle(() => ata.store.getState().team.teams.a1 && kay.store.getState().team.teams.k1);
    await settle(() => ata.team.allLinks().length === 1 && kay.team.allLinks().length === 1 && ata.team.allLinks()[0]!.id === kay.team.allLinks()[0]!.id);

    ata.team.leave('a1');
    await settle(() => !kay.store.getState().team.teams.k1);
    // They ask again; kay says not now: ata hears it and nothing forms.
    ata.team.answer(kay.id, 'a1', true);
    await settle(() => kay.store.getState().team.offers.find((o) => o.state === 'invited'));
    kay.team.answer(ata.id, 'k1', false);
    expect(kay.store.getState().team.offers).toEqual([]);
    await settle(() => ata.store.getState().team.offers.length === 0);
    expect(ata.store.getState().team.teams).toEqual({});
  }, 60_000);

  it('an accept for a team you already left, arriving late, puts nobody back on it (BLG-721)', async () => {
    net = await crowd();
    const ata = await teamMac(net, 'ata', [{ id: 'a1', name: 'api', repo: 'acme/api' }]);
    const kay = await teamMac(net, 'kay', [{ id: 'k1', name: 'api', repo: 'acme/api' }]);
    macs.push(ata, kay);
    await befriend(ata.person, kay.person);
    await settle(() => ata.store.getState().team.offers[0] && kay.store.getState().team.offers[0]);
    // Two yeses at once: kay's accept is slow on its way (a busy runner, a retry).
    const courier = kay.team.courier;
    const send = courier.send.bind(courier);
    const held: Array<Parameters<typeof send>> = [];
    courier.send = (...args) => (args[1].k === 'accept' ? (held.push(args), true) : send(...args));
    ata.team.answer(kay.id, 'a1', true);
    kay.team.answer(ata.id, 'k1', true);
    await settle(() => ata.store.getState().team.teams.a1 && kay.store.getState().team.teams.k1);
    courier.send = send;
    expect(held).toHaveLength(1);

    ata.team.leave('a1');
    await settle(() => !kay.store.getState().team.teams.k1);
    ata.team.answer(kay.id, 'a1', true);
    await settle(() => kay.store.getState().team.offers.find((o) => o.state === 'invited'));
    // The old accept arrives while ata is asking again; then kay says not now.
    for (const args of held) send(...args);
    kay.team.answer(ata.id, 'k1', false);
    await settle(() => ata.store.getState().team.offers.length === 0);
    expect(ata.store.getState().team.teams).toEqual({});
    expect(ata.team.allLinks()).toEqual([]);
  }, 60_000);

  it('a friend whose Beluga is too old is told the cannotTake way', () => {
    expect(cannotTake('Ata', { version: '0.6.0+mac.1.2.0', can: ['share.project'] }, 'team.board')).toBe("Ata's Beluga 1.2.0 can't open team boards yet. Ask Ata to update Beluga.");
    expect(cannotTake('Ata', { version: '0.6.0+mac.1.2.0', can: ['team.board'] }, 'team.plans')).toBe("Ata's Beluga 1.2.0 can't open shared plans yet. Ask Ata to update Beluga.");
  });
});
