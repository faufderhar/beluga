import { AuditFile } from './adapters/audit-file.js';
import { type ClientMetadata, fetchClientMetadata } from './adapters/client-metadata.js';
import { externalHost, externalPort, externalSigningKey, externalUrl, readExternalConfig, writeExternalConfig } from './adapters/config-file.js';
import { GrantFile } from './adapters/grant-file.js';
import { ExternalListener, type Turned } from './adapters/http.js';
import { type AskOwner, dropHeldCards, type ExternalToolDef, type HeldCard, mcpServerForGrant } from './adapters/mcp-tools.js';
import { OTHER_ADDRESS, oauthRoutes } from './adapters/oauth-routes.js';
import { ExternalReach, type ExternalReachOptions, type ReachRouteState } from './adapters/reach.js';
import { type ActivityKind, activityKind, type AuditRecord } from './domain/audit.js';
import { canHold, type Denial } from './domain/decide.js';
import { cleanAgentName, type Grant, isExpired } from './domain/grant.js';
import { REMOTE_ROUTES, type RemoteRoute } from './domain/reach.js';
import { countsTowardSuspension, LIMITS, RATE_WINDOW_MS, SUSPEND_AFTER, VISITOR_REFUSALS, type VisitorRefusal, WindowCounter } from './domain/limits.js';
import type { PairingSpec } from './domain/oauth.js';
import { SIGN_IN_MS } from './domain/oauth.js';
import { PairingCodes } from './adapters/oauth-codes.js';
import { REMOTE_FULL_WARNING } from '../shared/remote-full.js';
import type { AuditLog } from './ports/audit-log.js';
import type { GrantStore } from './ports/grant-store.js';

export interface ExternalServiceOptions {
  readonly configFile?: string;
  readonly grantFile?: string;
  readonly auditFile?: string;
  /** Default externalPort(); 0: any free port. */
  readonly port?: number;
  /** Default externalHost(). Anything but loopback is refused. */
  readonly listenHost?: string;
  /** The Tailscale and tunnel seams (tests use fakes). */
  readonly reach?: ExternalReachOptions;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /** How a client's metadata document is fetched (tests use a fake). */
  readonly fetchClient?: (clientId: string) => Promise<ClientMetadata>;
  /** An agent just connected: tell the owner. */
  readonly notify?: (grant: Grant) => void;
  /** Wrong pairing codes stopped new remote sign-ins for a while: tell the owner. */
  readonly notifyLockout?: () => void;
  /** A remote agent just got Full trust: tell the owner, louder than notify. */
  readonly notifyRemoteFull?: (grant: Grant) => void;
  /** A remote agent was suspended: tell the owner. */
  readonly notifySuspended?: (grant: Grant) => void;
  /** The owner's card for a tool call that needs one. Without one, it's a no. */
  readonly ask?: AskOwner;
  /** How long a call waits for a card, and how long an answer waits for a call (tests use short ones). */
  readonly cardWaitMs?: number;
  readonly cardKeepMs?: number;
  /** The tools an agent can call. */
  readonly tools?: readonly ExternalToolDef[];
  /** Ends what this agent has going (adapters/stop.ts). True when there was any. */
  readonly stopWork?: (grantId: string) => boolean;
}

export interface ExternalStatus {
  readonly on: boolean;
  /** The local MCP URL, while it's listening. */
  readonly url?: string;
  /** The HTTPS routes open or opening, while it's listening. */
  readonly routes?: readonly ReachRouteState[];
  readonly port?: number;
  /** Why it isn't listening although it's enabled. */
  readonly error?: string;
  /** It refuses every agent and keeps their grants. */
  readonly paused?: boolean;
}

/** Which of the audit log to show. */
export interface ActivityFilter {
  readonly agent?: string;
  readonly kind?: ActivityKind;
  readonly limit?: number;
}

const ACTIVITY_DEFAULT = 100;
const ACTIVITY_SCAN = 2000;

/**
 * The external agents' server inside the daemon: its listener, and the one grant book and audit log
 * of this process. Off until you turn it on; that choice survives restarts.
 */
export class ExternalService {
  readonly grants: GrantStore;
  readonly audit: AuditLog;
  private readonly codes: PairingCodes;
  private readonly routes: ReturnType<typeof oauthRoutes>;
  private readonly always = new Set<string>();
  private readonly cards = new Map<string, HeldCard>();
  private readonly reach: ExternalReach;
  private readonly requests: WindowCounter;
  private readonly visitors: WindowCounter;
  private readonly visitorsInAll: WindowCounter;
  private readonly floodsAudited: WindowCounter;
  private readonly visitorRefusalAudited = new Map<VisitorRefusal, number>();
  private readonly denials: WindowCounter;
  private listener?: ExternalListener;
  private port?: number;
  private error?: string;

  constructor(private readonly opts: ExternalServiceOptions = {}) {
    this.grants = new GrantFile({ ...(opts.grantFile ? { file: opts.grantFile } : {}), ...(opts.now ? { now: opts.now } : {}), onRevoked: (id) => this.endGrantWork(id) });
    this.audit = new AuditFile({ ...(opts.auditFile ? { file: opts.auditFile } : {}), ...(opts.now ? { now: opts.now } : {}) });
    const now = opts.now ?? Date.now;
    this.requests = new WindowCounter(now, RATE_WINDOW_MS);
    this.visitors = new WindowCounter(now, RATE_WINDOW_MS, LIMITS.remoteVisitor.maxVisitors);
    this.visitorsInAll = new WindowCounter(now, RATE_WINDOW_MS);
    this.floodsAudited = new WindowCounter(now, RATE_WINDOW_MS);
    this.denials = new WindowCounter(now, SUSPEND_AFTER.windowMs);
    this.reach = new ExternalReach({ ...(opts.log ? { log: opts.log } : {}), ...opts.reach });
    this.codes = new PairingCodes(now);
    this.routes = oauthRoutes({
      grants: this.grants,
      codes: this.codes,
      signingKey: () => externalSigningKey(opts.configFile),
      fetchClient: opts.fetchClient ?? ((clientId) => fetchClientMetadata(clientId)),
      notify: (grant) => {
        opts.notify?.(grant);
        if (grant.route === 'remote' && grant.level === 'full') opts.notifyRemoteFull?.(grant);
      },
      notifyLockout: () => opts.notifyLockout?.(),
      refused: (kind) => this.auditVisitorRefusal(kind),
      now,
      ...(opts.log ? { log: opts.log } : {}),
    });
  }

  /** A one-time code the owner hands to the sign-in page. It holds what the agent will get. */
  pairingCode(spec: PairingSpec): { readonly code: string; readonly expiresAt: number } {
    if (spec.allowRemoteFull && !spec.remote) throw new Error('The choice of remote Full trust goes with --remote. A code for this computer needs no such choice.');
    if (spec.allowRemoteFull && spec.level !== 'full') throw new Error('The choice of remote Full trust goes with --level full.');
    if (spec.remote && !canHold('remote', spec.level, spec.allowRemoteFull)) throw new Error(`A remote agent gets Full trust only by an explicit choice for this code: add --allow-remote-full, or confirm it in Settings. ${REMOTE_FULL_WARNING}`);
    return this.codes.create(spec);
  }

  /** A local grant for a client with no OAuth, once the owner says yes on the Mac. The token shows here only. */
  async localToken(name: string, spec: PairingSpec): Promise<{ readonly grant: Grant; readonly token: string }> {
    if (spec.remote) throw new Error('A local token is for this computer, and a remote agent signs in with a pairing code.');
    const agent = cleanAgentName(name);
    const answer = await (this.opts.ask ?? (async () => 'no' as const))(`A program on this Mac wants a Beluga token for ${agent}`, `As an external agent, level ${spec.level}. Say no if you didn't just ask for this.`, true);
    if (answer === 'no') throw new Error('Declined on the Mac');
    const now = (this.opts.now ?? Date.now)();
    return this.grants.create({ name: agent, clientId: 'local-token', redirectHost: 'localhost', route: 'local', level: spec.level, projects: spec.projects, ...(spec.chats ? { chats: spec.chats } : {}), expiresAt: now + SIGN_IN_MS });
  }

  /** Ends a grant at once: its next call gets 401 and its work stops. False when there is no such grant. */
  revoke(id: string): boolean {
    return this.grants.revoke(id);
  }

  /** Lifts a suspension. The count of denials starts over. False when there is no such grant. */
  resume(id: string): boolean {
    this.denials.forget(id);
    return this.grants.setSuspended(id, undefined);
  }

  /** Ends what this agent has going and keeps its grant. False when nothing was going. */
  stopAgent(id: string): boolean {
    const stopped = this.opts.stopWork?.(id) ?? false;
    // After the stop, so that a card it ended counts as something going.
    this.forgetAnswers(id);
    return stopped;
  }

  /** Ends what every agent has going. How many had anything. */
  stopAll(): number {
    return this.grants.list().filter((g) => this.stopAgent(g.id)).length;
  }

  /** While paused the listener refuses every agent. Their grants stay. It survives a restart. */
  setPaused(paused: boolean): ExternalStatus {
    writeExternalConfig({ paused }, this.opts.configFile);
    return this.status();
  }

  /** What agents did and who decided, newest first. */
  activity(filter: ActivityFilter = {}): readonly (AuditRecord & { readonly kind: ActivityKind })[] {
    return this.audit
      .recent(ACTIVITY_SCAN)
      .map((r) => ({ ...r, kind: activityKind(r) }))
      .filter((r) => (!filter.agent || r.agentId === filter.agent) && (!filter.kind || r.kind === filter.kind))
      .slice(0, filter.limit ?? ACTIVITY_DEFAULT);
  }

  /** At daemon start: opens only if it was left on. A taken port is reported in status, never fatal. */
  async start(): Promise<void> {
    if (!readExternalConfig(this.opts.configFile).enabled) return;
    try {
      await this.open();
    } catch (err) {
      this.error = reason(err);
      this.opts.log?.(`external agents: not listening: ${this.error}`);
      return;
    }
    // In the background: a slow tunnel doesn't hold up Beluga, and a public one keeps trying.
    const config = readExternalConfig(this.opts.configFile);
    for (const kind of REMOTE_ROUTES) {
      if (config[kind]) void this.reach.open(kind, this.port!).catch((err: unknown) => this.opts.log?.(`external agents: no ${kind} route: ${reason(err)}`));
    }
  }

  /** Turning it on throws when the port can't open, and stays off. Off closes every route too, for good. */
  async setEnabled(on: boolean): Promise<ExternalStatus> {
    if (on) await this.open().catch((err: unknown) => {
      throw new Error(reason(err));
    });
    else await this.close();
    writeExternalConfig(on ? { enabled: true } : { enabled: false, tailscale: false, public: false }, this.opts.configFile);
    return this.status();
  }

  /** Opens or closes one HTTPS route; opening also turns the listener on. A route that can't open stays off. */
  async setRoute(kind: RemoteRoute, on: boolean): Promise<ExternalStatus> {
    if (!on) {
      await this.reach.close(kind);
      writeExternalConfig({ [kind]: false }, this.opts.configFile);
      return this.status();
    }
    await this.setEnabled(true);
    try {
      await this.reach.open(kind, this.port!);
    } catch (err) {
      await this.reach.close(kind);
      throw new Error(reason(err));
    }
    writeExternalConfig({ [kind]: true }, this.opts.configFile);
    return this.status();
  }

  status(): ExternalStatus {
    const paused = this.paused() ? { paused: true } : {};
    if (this.port === undefined) return { on: false, ...paused, ...(this.error ? { error: this.error } : {}) };
    return { on: true, port: this.port, url: externalUrl(this.port), routes: this.reach.routes(), ...paused };
  }

  private paused(): boolean {
    return readExternalConfig(this.opts.configFile).paused === true;
  }

  /** The daemon is stopping: closes the port and leaves the choice as it was. */
  async stop(): Promise<void> {
    await this.close();
  }

  private async open(): Promise<void> {
    if (this.listener) return;
    const listener = new ExternalListener({
      port: this.opts.port ?? externalPort(),
      host: this.opts.listenHost ?? externalHost(),
      remoteOrigins: () => this.reach.origins(),
      authenticate: (token, audience) => {
        // The lookup is a hash and a map read. The paused flag is a file read, only for a token that holds.
        const grant = this.grants.lookup(token, audience);
        return grant && !this.paused() ? grant : undefined;
      },
      admit: (grant, inFlight) => this.admit(grant, inFlight),
      admitVisitor: (visitor) => this.admitVisitor(visitor),
      refusal: (token, audience) => (!this.paused() && this.grants.heldElsewhere(token, audience) ? OTHER_ADDRESS : undefined),
      routes: this.routes,
      serve: (grant) =>
        mcpServerForGrant(grant, this.opts.tools ?? [], {
          audit: this.audit,
          ask: this.opts.ask ?? (async () => 'no'),
          now: this.opts.now ?? Date.now,
          always: this.always,
          cards: this.cards,
          ...(this.opts.cardWaitMs !== undefined ? { cardWaitMs: this.opts.cardWaitMs } : {}),
          ...(this.opts.cardKeepMs !== undefined ? { cardKeepMs: this.opts.cardKeepMs } : {}),
          live: (id) => {
            const now = this.opts.now ?? Date.now;
            const held = this.grants.list().find((g) => g.id === id);
            return !this.paused() && held !== undefined && !isExpired(held, now()) && held.level !== 'blocked' && held.suspendedAt === undefined && canHold(held.route, held.level, held.allowRemoteFull);
          },
          denied: (denied, denial) => this.noteDenial(denied, denial),
        }),
      ...(this.opts.log ? { log: this.opts.log } : {}),
    });
    this.port = await listener.listen();
    this.listener = listener;
    this.error = undefined;
  }

  /** The grant is gone already, so nothing the stop lets go of can count on it. Also when /token ended it: a code or token that came back. */
  private endGrantWork(id: string): void {
    this.forgetAnswers(id);
    this.opts.stopWork?.(id);
  }

  private forgetAnswers(id: string): void {
    for (const key of this.always) if (key.startsWith(`${id} `)) this.always.delete(key);
    dropHeldCards(this.cards, id);
  }

  private admit(grant: Grant, inFlight: number): Turned | undefined {
    if (grant.suspendedAt !== undefined) return { status: 403, error: 'grant_suspended', message: 'This agent is suspended after repeated refusals. Its owner can resume it in Beluga.' };
    const limits = LIMITS[grant.route];
    if (this.requests.take(grant.id, limits.perMinute) && inFlight < limits.inFlight) return undefined;
    // One line per window: a flood must not fill the log it is shown in.
    if (this.floodsAudited.take(grant.id, 1)) this.auditRefusal(grant, 'rate_limited', 'Too many requests');
    return { status: 429, error: 'rate_limited', message: 'Too many requests from this agent. Wait a minute, then try again.' };
  }

  private admitVisitor(visitor: string): Turned | undefined {
    const { perMinute, totalPerMinute } = LIMITS.remoteVisitor;
    // A visitor past its own limit counts for nothing more: one of them must not use up the total for others.
    if (this.visitors.take(visitor, perMinute) && this.visitorsInAll.take('', totalPerMinute)) return undefined;
    this.auditVisitorRefusal('visitor_flood');
    return { status: 429, error: 'rate_limited', message: 'Too many requests. Wait a minute, then try again.' };
  }

  /** Repeated refusals of a remote agent: it may be stolen. It stops, and a person decides. */
  private noteDenial(grant: Grant, denial: Denial): void {
    if (grant.route !== 'remote' || !countsTowardSuspension(denial)) return;
    if (this.denials.take(grant.id, SUSPEND_AFTER.denials - 1)) return;
    this.denials.forget(grant.id);
    const now = this.opts.now ?? Date.now;
    if (!this.grants.setSuspended(grant.id, now())) return;
    this.auditRefusal(grant, 'grant_suspended', 'Suspended after repeated refusals');
    this.stopAgent(grant.id);
    this.opts.log?.(`external agents: ${grant.id} suspended after repeated refusals`);
    this.opts.notifySuspended?.(grant);
  }

  /** One line per window per kind, whoever claims to be asking. */
  private auditVisitorRefusal(kind: VisitorRefusal): void {
    const now = (this.opts.now ?? Date.now)();
    const { windowMs, summary } = VISITOR_REFUSALS[kind];
    const last = this.visitorRefusalAudited.get(kind);
    if (last !== undefined && now - last < windowMs) return;
    this.visitorRefusalAudited.set(kind, now);
    this.audit.append({ agent: 'visitor', tool: kind, class: 'read', target: '', decision: 'deny', decidedBy: 'rule', result: 'rate_limited', durationMs: 0, args: {}, summary });
  }

  private auditRefusal(grant: Grant, result: 'rate_limited' | 'grant_suspended', summary: string): void {
    this.audit.append({ agent: grant.name, agentId: grant.id, tool: result, class: 'read', target: '', decision: 'deny', decidedBy: 'rule', result, durationMs: 0, args: {}, summary });
  }

  private async close(): Promise<void> {
    const listener = this.listener;
    this.listener = undefined;
    this.port = undefined;
    this.error = undefined;
    await this.reach.closeAll();
    await listener?.close();
  }
}

function reason(err: unknown): string {
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') return 'Its port is in use by another program';
  return err instanceof Error ? err.message : String(err);
}
