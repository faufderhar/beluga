/// <reference path="./modules.d.ts" />
import type DHT from 'hyperdht';
import type { KeyPair, NoiseSocket, Server } from 'hyperdht';
import { type MessageSocket, fromStream } from '../transport.js';
import { canonical } from './files.js';
import { FAILURE_WINDOW_MS, type InvitationBook, type InvitationRecord, MAX_FAILURES, type Ticket, checkProof, pairProof, pairingSecrets } from './invitations.js';
import { verifyCard } from './keys.js';
import type { Profile } from './schemas.js';
import { PROTO, type PairMessage, parsePair } from './wire.js';

/**
 * The pairing handshake behind an invitation. The inviter listens on a key pair made from the
 * invitation's secret (one for the link, one for the code); the invitee makes the same key pair
 * from what they typed and dials it with their own network key. Then:
 *   invitee → pair_hello {profile, proof}   proof = HMAC(secret, "invitee" + handshake hash + profile)
 *   inviter → pair_ok {profile, proof, …}    (or pair_refused)
 * The proofs bind both cards to this very connection, so the two of you end up with each
 * other's real keys, and nobody without the secret can sit in the middle.
 */

const MAX_PAIR_BYTES = 64 * 1024;

const NOT_FOUND = 'Nobody is waiting for that invitation. Check the code, or ask for a new one (codes work for an hour, links for a day).';

/**
 * Why using an invitation failed, from hyperdht's error code on the dial. A hole-punch only starts
 * once whoever made the invitation has answered, so a failed one (HOLEPUNCH_*) means they're there
 * and the invitation is still good, but the two networks can't meet: it mustn't read as expired (a
 * Mac behind Cloudflare WARP and a Linux computer were told it had). Anything else, no answer at
 * all included, is nobody waiting: PEER_NOT_FOUND, and PEER_CONNECTION_FAILED from an invitation
 * that has closed while the DHT still remembers it.
 */
export function pairFailure(code: string | undefined): string {
  if (code && /HOLEPUNCH/.test(code)) {
    return `Found whoever made that invitation, but your two networks couldn't connect directly (${code}). The invitation still works: try again from another network (a phone's hotspot), or turn off a VPN (such as Cloudflare WARP) or a firewall that blocks UDP on either side.`;
  }
  return NOT_FOUND;
}

export type PairingDecision =
  | { readonly ok: true; readonly kind: 'friend' }
  | { readonly ok: true; readonly kind: 'group'; readonly group: { readonly id: string; readonly name: string; readonly status: 'joined' | 'waiting' } }
  | { readonly ok: false; readonly reason: string };

export interface PairingHostOptions {
  readonly node: DHT;
  readonly book: InvitationBook;
  readonly me: () => Profile;
  readonly timeoutMs: number;
  /** Someone proved they hold the invitation: let them in (or not). */
  readonly decide: (record: InvitationRecord, profile: Profile) => PairingDecision;
  /** The invitation list changed (used up, expired, burned). */
  readonly onChange: () => void;
}

interface Listening {
  /** The link's server, then the code's while it lasts (it's closed after an hour). */
  readonly servers: Server[];
  readonly timers: readonly NodeJS.Timeout[];
}

const send = (socket: MessageSocket, msg: PairMessage): void => socket.send(JSON.stringify(msg));

/** Listens for your open invitations. */
export class PairingHost {
  private readonly open = new Map<string, Listening>();
  /** Recent wrong proofs per invitation (a burst pauses it rather than throwing it away, so nobody can kill your invite). */
  private readonly failures = new Map<string, number[]>();

  constructor(private readonly opts: PairingHostOptions) {}

  async listen(record: InvitationRecord): Promise<void> {
    const DHTClass = (await import('hyperdht')).default;
    const codeLive = record.codeExpiresAt > Date.now();
    const tickets: Ticket[] = [{ via: 'link', secret: record.secret }, ...(codeLive ? [{ via: 'code' as const, code: record.code }] : [])];
    const servers: Server[] = [];
    try {
      for (const ticket of tickets) {
        const secrets = await pairingSecrets(ticket);
        const server = this.opts.node.createServer({}, (stream: NoiseSocket) => this.serve(record.id, ticket.via, secrets.auth, stream));
        servers.push(server);
        await server.listen(DHTClass.keyPair(secrets.seed));
      }
    } catch (err) {
      await Promise.all(servers.map((s) => s.close().catch(() => undefined)));
      throw err;
    }
    const expiry = setTimeout(() => void this.stop(record.id), Math.max(0, record.expiresAt - Date.now()));
    expiry.unref();
    const timers = [expiry];
    const codeServer = codeLive ? servers[1] : undefined;
    if (codeServer) {
      // The code stops working after its hour; the link carries on.
      const codeExpiry = setTimeout(() => {
        const l = this.open.get(record.id);
        if (l) l.servers.splice(l.servers.indexOf(codeServer), 1);
        void codeServer.close().catch(() => undefined);
        this.opts.onChange();
      }, Math.max(0, record.codeExpiresAt - Date.now()));
      codeExpiry.unref();
      timers.push(codeExpiry);
    }
    this.open.set(record.id, { servers, timers });
  }

  async stop(id: string): Promise<void> {
    const l = this.open.get(id);
    if (!l) {
      if (this.opts.book.remove(id)) this.opts.onChange();
      return;
    }
    this.open.delete(id);
    this.failures.delete(id);
    for (const t of l.timers) clearTimeout(t);
    this.opts.book.remove(id);
    this.opts.onChange();
    await Promise.all(l.servers.map((s) => s.close().catch(() => undefined)));
  }

  async close(): Promise<void> {
    const all = [...this.open.values()];
    this.open.clear();
    for (const l of all) for (const t of l.timers) clearTimeout(t);
    await Promise.all(all.flatMap((l) => l.servers.map((s) => s.close().catch(() => undefined))));
  }

  private serve(id: string, via: Ticket['via'], auth: Buffer, stream: NoiseSocket): void {
    const socket = fromStream(stream, { maxBytes: MAX_PAIR_BYTES, open: true });
    socket.on('error', () => undefined);
    const timer = setTimeout(() => socket.terminate(), this.opts.timeoutMs);
    timer.unref();
    socket.once('close', () => clearTimeout(timer));
    socket.once('message', (text) => {
      const refuse = (reason: string): void => {
        send(socket, { t: 'pair_refused', reason });
        socket.close(1000);
      };
      const msg = parsePair(text);
      const hh = stream.handshakeHash;
      const proven =
        msg?.t === 'pair_hello' &&
        hh !== null &&
        checkProof(auth, 'invitee', hh, canonical(msg.profile), msg.mac) &&
        verifyCard(msg.profile.card) &&
        msg.profile.card.address === stream.remotePublicKey.toString('hex');
      const record = this.opts.book.get(id);
      if (!record || (via === 'code' && record.codeExpiresAt <= Date.now())) return refuse('That invitation has expired');
      const recent = (this.failures.get(id) ?? []).filter((t) => Date.now() - t < FAILURE_WINDOW_MS);
      if (recent.length >= MAX_FAILURES) return refuse('Too many tries with that invitation; wait a minute and try again');
      if (!proven || msg?.t !== 'pair_hello' || !hh) {
        this.failures.set(id, [...recent, Date.now()]);
        this.opts.book.update(id, { failures: record.failures + 1 });
        return refuse("That invitation couldn't be verified");
      }
      if (msg.proto !== PROTO) return refuse('Update Beluga to pair with this person');
      if (record.kind === 'friend' && record.uses > 0) return refuse('That invitation was already used');
      let decision: PairingDecision;
      try {
        decision = this.opts.decide(record, msg.profile);
      } catch (err) {
        return refuse(err instanceof Error ? err.message.slice(0, 200) : 'Something went wrong');
      }
      if (!decision.ok) return refuse(decision.reason);
      this.opts.book.update(id, { uses: record.uses + 1 });
      const me = this.opts.me();
      send(socket, { t: 'pair_ok', mac: pairProof(auth, 'inviter', hh, canonical(me)), profile: me, kind: decision.kind, ...(decision.kind === 'group' ? { group: decision.group } : {}) });
      socket.close(1000);
      if (record.kind === 'friend') void this.stop(id);
      else this.opts.onChange();
    });
  }
}

export interface PairResult {
  readonly profile: Profile;
  readonly kind: 'friend' | 'group';
  readonly group?: { readonly id: string; readonly name: string; readonly status: 'joined' | 'waiting' };
}

/** Use an invitation: find whoever made it, prove you hold it, and learn who they are. */
export async function pairWith(node: DHT, keyPair: KeyPair, me: Profile, ticket: Ticket, timeoutMs: number): Promise<PairResult> {
  const DHTClass = (await import('hyperdht')).default;
  const secrets = await pairingSecrets(ticket);
  const target = DHTClass.keyPair(secrets.seed).publicKey;
  const stream = node.connect(target, { keyPair });
  const socket = fromStream(stream, { maxBytes: MAX_PAIR_BYTES });
  // The dial's own error (PEER_NOT_FOUND, HOLEPUNCH_ABORTED…) says why it closed (pairFailure).
  let code: string | undefined;
  socket.on('error', (err: Error & { code?: unknown }) => {
    if (typeof err.code === 'string') code ??= err.code;
  });
  return new Promise<PairResult>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      socket.close(1000);
    };
    const timer = setTimeout(() => settle(() => reject(new Error(pairFailure(code)))), timeoutMs);
    timer.unref();
    socket.once('open', () => {
      const hh = stream.handshakeHash;
      if (!hh || !stream.remotePublicKey?.equals(target)) return settle(() => reject(new Error(NOT_FOUND)));
      send(socket, { t: 'pair_hello', proto: PROTO, mac: pairProof(secrets.auth, 'invitee', hh, canonical(me)), profile: me });
    });
    socket.on('message', (text) => {
      const msg = parsePair(text);
      const hh = stream.handshakeHash;
      if (msg?.t === 'pair_refused') return settle(() => reject(new Error(msg.reason)));
      if (msg?.t !== 'pair_ok' || !hh) return settle(() => reject(new Error('The other side answered something Beluga does not understand')));
      if (!checkProof(secrets.auth, 'inviter', hh, canonical(msg.profile), msg.mac) || !verifyCard(msg.profile.card)) return settle(() => reject(new Error("The other side couldn't prove it made that invitation")));
      settle(() => resolve({ profile: msg.profile, kind: msg.kind, ...(msg.group ? { group: msg.group } : {}) }));
    });
    socket.once('close', () => settle(() => reject(new Error(pairFailure(code)))));
  });
}
