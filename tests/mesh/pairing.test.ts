import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import DHT from 'hyperdht';
import { fromStream } from '../../src/net/transport.js';
import { pairingSecrets, parseTicket } from '../../src/net/mesh/invitations.js';
import { pairFailure } from '../../src/net/mesh/pairing.js';
import { type Crowd, befriend, crowd, settle } from './helpers.js';

let net: Crowd;
beforeAll(async () => {
  net = await crowd();
}, 30_000);
afterAll(async () => {
  await net?.close();
});

describe('adding friends without a server', () => {
  it('pairs with a one-time link: names both ways, then linked', async () => {
    const ann = await net.add('ann');
    const bob = await net.add('bob');
    const invite = await ann.mesh.createInvite();
    expect(invite.link).toMatch(/^beluga:\/\/add#[\w-]{22}$/);
    expect(invite.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(invite.codeLink).toBe(`beluga://add?code=${invite.code}`);
    // The code works for an hour, the link for a day.
    expect(invite.codeExpiresAt - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(invite.expiresAt - invite.codeExpiresAt).toBeGreaterThan(22 * 60 * 60 * 1000);
    expect(ann.mesh.summary().invitations).toHaveLength(1);
    const got = await bob.mesh.accept(`here you go: ${invite.link}`);
    expect(got).toEqual({ kind: 'friend', peerId: ann.identity.peerId, name: 'ann' });
    await settle(() => ann.friend(bob.identity.peerId)?.online && bob.friend(ann.identity.peerId)?.online);
    expect(ann.friend(bob.identity.peerId)?.name).toBe('bob');
    expect(ann.friend(bob.identity.peerId)?.via).toBe('direct');
    // Used up: gone from the list, and it doesn't work again.
    await settle(() => ann.mesh.summary().invitations.length === 0);
    const eve = await net.add('eve');
    await expect(eve.mesh.accept(invite.link)).rejects.toThrow(/Nobody is waiting/);
    expect(ann.friend(eve.identity.peerId)).toBeUndefined();
  }, 40_000);

  it('pairs with the short code, typed loosely', async () => {
    const cat = await net.add('cat');
    const dan = await net.add('dan');
    const invite = await cat.mesh.createInvite();
    const typed = invite.code.toLowerCase().replace('-', ' ');
    expect(await dan.mesh.accept(typed)).toMatchObject({ kind: 'friend', name: 'cat' });
    await settle(() => cat.friend(dan.identity.peerId)?.online);
    // The code is single-use too.
    const eve = await net.add('eve2');
    await expect(eve.mesh.accept(invite.code)).rejects.toThrow(/Nobody is waiting/);
  }, 40_000);

  it('refuses a wrong code and an expired invitation', async () => {
    const fay = await net.add('fay');
    const gus = await net.add('gus');
    await fay.mesh.createInvite();
    await expect(gus.mesh.accept('ZZZZ-ZZZZ-ZZZZ')).rejects.toThrow(/Nobody is waiting/);
    await expect(gus.mesh.accept('not an invitation')).rejects.toThrow(/isn’t a Beluga invitation/);
    const short = await fay.mesh.createInvite({ ttlMs: 200 });
    await settle(() => !fay.mesh.summary().invitations.some((i) => i.id === short.id));
    await expect(gus.mesh.accept(short.link)).rejects.toThrow(/Nobody is waiting|expired/);
    expect(gus.mesh.summary().friends).toEqual([]);
  }, 40_000);

  it('stops taking the code after its hour while the link still works', async () => {
    const kim = await net.add('kim');
    const lou = await net.add('lou');
    const invite = await kim.mesh.createInvite({ codeTtlMs: 200 });
    await new Promise((r) => setTimeout(r, 400));
    await expect(lou.mesh.accept(invite.code)).rejects.toThrow(/Nobody is waiting|expired/);
    await expect(lou.mesh.accept(invite.codeLink)).rejects.toThrow(/Nobody is waiting|expired/);
    expect(await lou.mesh.accept(invite.link)).toMatchObject({ kind: 'friend', name: 'kim' });
  }, 40_000);

  it('pairs by the code as a link (klaud://add?code=…)', async () => {
    const mo = await net.add('mo');
    const ned = await net.add('ned');
    const invite = await mo.mesh.createInvite();
    expect(await ned.mesh.accept(invite.codeLink)).toMatchObject({ kind: 'friend', name: 'mo' });
  }, 40_000);

  it('pauses an invitation after a burst of wrong proofs (without throwing it away)', async () => {
    const hal = await net.add('hal');
    const invite = await hal.mesh.createInvite();
    // Someone who found the listening key but doesn't hold the secret behind the proofs.
    const secrets = await pairingSecrets(parseTicket(invite.link)!);
    const node = new DHT({ bootstrap: net.testnet.bootstrap, host: '127.0.0.1' });
    try {
      for (let i = 0; i < 5; i++) {
        const stream = node.connect(DHT.keyPair(secrets.seed).publicKey);
        const socket = fromStream(stream, { maxBytes: 65_536 });
        socket.on('error', () => undefined);
        const answer = await new Promise<string>((resolve) => {
          socket.once('open', () => socket.send(JSON.stringify({ t: 'pair_hello', proto: 1, mac: 'AAAA', profile: hal.mesh.profile })));
          socket.once('message', resolve);
          socket.once('close', () => resolve('closed'));
        });
        expect(answer).toMatch(/pair_refused|closed/);
      }
      // Even the real invitee is turned away for now; the invitation itself stays.
      const ivo = await net.add('ivo');
      await expect(ivo.mesh.accept(invite.link)).rejects.toThrow(/Too many tries/);
      expect(hal.mesh.summary().invitations).toHaveLength(1);
    } finally {
      await node.destroy({ force: true });
    }
  }, 40_000);

  it('removes a friend: the link closes and they can no longer reach you', async () => {
    const ivy = await net.add('ivy');
    const jon = await net.add('jon');
    await befriend(ivy, jon);
    ivy.mesh.removeFriend(jon.identity.peerId);
    expect(ivy.friend(jon.identity.peerId)).toBeUndefined();
    await settle(() => jon.friend(ivy.identity.peerId)?.online === false);
    expect(() => jon.mesh.sendDm(ivy.identity.peerId, 'still there?')).not.toThrow();
    expect(jon.mesh.dmHistory(ivy.identity.peerId).at(-1)?.status).toBe('waiting');
  }, 40_000);
});

describe('why an invitation could not be used', () => {
  it('says the invitation is gone when nobody was found', () => {
    expect(pairFailure(undefined)).toMatch(/Nobody is waiting/);
    expect(pairFailure('PEER_NOT_FOUND')).toMatch(/Nobody is waiting/);
  });

  it('says the networks could not meet when the hole-punch failed, and that the invitation still works', () => {
    for (const code of ['HOLEPUNCH_ABORTED', 'HOLEPUNCH_DOUBLE_RANDOMIZED_NATS', 'CANNOT_HOLEPUNCH', 'REMOTE_NOT_HOLEPUNCHABLE']) {
      const said = pairFailure(code);
      expect(said).toMatch(/couldn't connect directly/);
      expect(said).toContain(code);
      expect(said).toMatch(/still works/);
      expect(said).not.toMatch(/Nobody is waiting/);
    }
  });

  it('says nobody is waiting when the dial found only a closed invitation the DHT still remembers', () => {
    expect(pairFailure('PEER_CONNECTION_FAILED')).toMatch(/Nobody is waiting/);
  });
});
