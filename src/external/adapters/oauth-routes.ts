import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { canHold } from '../domain/decide.js';
import { cleanAgentName, type Grant } from '../domain/grant.js';
import { FORM_DRAIN, FORM_MAX, RATE_WINDOW_MS, REMOTE_SIGN_IN, TOKEN_FAILURES, type VisitorRefusal, WindowCounter } from '../domain/limits.js';
import { ACCESS_MS, allowedRedirect, redirectMatches, routeOf, SIGN_IN_MS, SignInLimiter } from '../domain/oauth.js';
import { AuthCodes, type AuthCodeRecord, type PairingCodes, pkceMatches, validChallenge } from './oauth-codes.js';
import type { GrantStore } from '../ports/grant-store.js';
import { type ClientMetadata, clientIdUrl } from './client-metadata.js';
import { MCP_PATH, readBody, RESOURCE_METADATA_PATH, type RequestContext, TOKEN_PATH } from './http.js';
import { sendSignInError, sendSignInPage } from './signin-page.js';

/** What a client reads when its token is for an address this Beluga no longer has. */
export const OTHER_ADDRESS = "This token is for another address of this Beluga. A public address changes when its tunnel restarts. Sign in again at this address.";

/**
 * OAuth 2.1 for external agents, on the listener: discovery, stateless registration, sign-in with a
 * pairing code, tokens. Public clients only, PKCE S256 and a resource (RFC 8707) always. The grant
 * takes its level and projects from the pairing code, never from a request.
 */

export interface OAuthDeps {
  readonly grants: GrantStore;
  readonly codes: PairingCodes;
  /** Signs stateless registrations, so a client_id can't be made up in a link. */
  readonly signingKey: () => string;
  readonly fetchClient: (clientId: string) => Promise<ClientMetadata>;
  /** An agent just connected: tell the owner. */
  readonly notify: (grant: Grant) => void;
  /** A limiter here refused someone. It goes in the audit log. */
  readonly refused?: (kind: VisitorRefusal) => void;
  /** Wrong pairing codes through a route used up the total: no new remote sign-in for a while. Tell the owner. */
  readonly notifyLockout?: () => void;
  readonly now: () => number;
  readonly log?: (line: string) => void;
}

interface Pending {
  readonly client: ClientMetadata;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state?: string;
  readonly challenge: string;
  readonly resource: string;
  readonly issuer: string;
  /** It started through a route: it is remote, whatever its redirect says. */
  readonly remote: boolean;
  readonly expiresAt: number;
}

const PENDING_MS = 10 * 60_000;
const PENDING_MAX = 100;
const STATE_MAX = 1024;
const REGISTERED_PREFIX = 'dcr.';

const Registration = z.object({ client_name: z.string().max(500).optional(), redirect_uris: z.array(z.string().max(500)).min(1).max(5) });

export function oauthRoutes(deps: OAuthDeps): (req: IncomingMessage, res: ServerResponse, ctx: RequestContext) => Promise<boolean> {
  const localLimiter = new SignInLimiter(deps.now);
  // Apart, and harder: a flood through a route can't lock out sign-ins on this computer.
  const remoteLimiter = new SignInLimiter(deps.now, REMOTE_SIGN_IN.perAddress, REMOTE_SIGN_IN.total, REMOTE_SIGN_IN.windowMs);
  const limiterOf = (ctx: RequestContext): SignInLimiter => (ctx.remote ? remoteLimiter : localLimiter);
  const lockoutNotices = new WindowCounter(deps.now, REMOTE_SIGN_IN.windowMs);
  const tokenFailures = new WindowCounter(deps.now, TOKEN_FAILURES.windowMs, TOKEN_FAILURES.maxVisitors);
  const tokenFailuresInAll = new WindowCounter(deps.now, RATE_WINDOW_MS);
  const authCodes = new AuthCodes(deps.now);
  const pending = new Map<string, Pending>();

  const authorizeGet = async (req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> => {
    const q = new URL(req.url ?? '/', ctx.origin).searchParams;
    const clientId = q.get('client_id') ?? '';
    const client = await resolveClient(clientId, deps).catch((err: unknown) => {
      deps.log?.(`external sign-in: client refused: ${err instanceof Error ? err.message : 'error'}`);
      return undefined;
    });
    if (!client) return sendSignInError(res, 400, { title: "Beluga can't check this agent", message: 'Beluga could not check the client that sent you here. Start the sign-in again from your agent.' });
    const redirectUri = q.get('redirect_uri') ?? '';
    // Until the redirect is known good, nothing may go back to it.
    if (!redirectMatches(redirectUri, client.redirectUris)) return sendSignInError(res, 400, { title: 'This agent asked for the wrong address', message: 'The client asked to come back to an address it did not register. Start the sign-in again from your agent.' });
    const state = q.get('state') ?? undefined;
    const back = (error: string): void => redirect(res, redirectUri, { error, ...(state !== undefined ? { state } : {}), iss: ctx.origin });
    if (state !== undefined && state.length > STATE_MAX) return back('invalid_request');
    if (q.get('response_type') !== 'code') return back('unsupported_response_type');
    const challenge = q.get('code_challenge') ?? '';
    if (q.get('code_challenge_method') !== 'S256' || !validChallenge(challenge)) return back('invalid_request');
    if (q.get('resource') !== ctx.resource) return back('invalid_target');
    const id = randomBytes(16).toString('hex');
    const now = deps.now();
    for (const [key, p] of pending) if (p.expiresAt <= now) pending.delete(key);
    // The oldest goes: a page that opens sign-ins in a loop can't lock you out of yours.
    if (pending.size >= PENDING_MAX) pending.delete(pending.keys().next().value!);
    const held: Pending = { client, clientId, redirectUri, ...(state !== undefined ? { state } : {}), challenge, resource: ctx.resource, issuer: ctx.origin, remote: ctx.remote, expiresAt: now + PENDING_MS };
    pending.set(id, held);
    showPage(res, id, held);
  };

  const authorizePost = async (req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> => {
    const read = await readForm(req);
    const form = read === 'too_large' ? undefined : read;
    const id = form?.get('pending') ?? '';
    const held = pending.get(id);
    if (!form || !held || held.issuer !== ctx.origin || held.expiresAt <= deps.now()) return sendSignInError(res, 400, { title: 'This sign-in expired', message: 'Start it again from your agent. A sign-in waits 10 minutes for its code.' });
    const backParams = { ...(held.state !== undefined ? { state: held.state } : {}), iss: held.issuer };
    if (form.get('action') === 'deny') {
      pending.delete(id);
      // From the page that asks about Full trust, which holds the code: a person refused what it gives.
      const refused = form.get('code');
      if (refused) deps.codes.spend(refused);
      return redirect(res, held.redirectUri, { error: 'access_denied', ...backParams });
    }
    const limiter = limiterOf(ctx);
    if (!limiter.allowed(ctx.visitor)) {
      deps.refused?.('wrong_pairing_codes');
      return sendSignInError(res, 429, { title: 'Too many wrong codes', message: 'Wait a few minutes, then start the sign-in again from your agent.' });
    }
    const code = form.get('code') ?? '';
    const spec = deps.codes.peek(code);
    if (!spec) {
      limiter.failed(ctx.visitor);
      if (ctx.remote && limiter.locked() && lockoutNotices.take('lockout', 1)) deps.notifyLockout?.();
      return showPage(res, id, held, 'That code is wrong, used or expired. Make a new one in Beluga.');
    }
    const { route: arrived, host } = routeOfPending(held);
    const route = spec.remote ? 'remote' : arrived;
    const remoteFull = route === 'remote' && spec.level === 'full';
    // The owner reads the warning here, where the code becomes a grant. Nothing is spent until they say yes.
    if (remoteFull && spec.allowRemoteFull && form.get('confirm_full') !== 'yes') return showPage(res, id, held, undefined, code);
    deps.codes.spend(code);
    pending.delete(id);
    if (!canHold(route, spec.level, spec.allowRemoteFull)) return sendSignInError(res, 403, { title: "This code can't go to a hosted service", message: 'That code gives Full trust and was made for this computer, so a hosted service cannot use it. Make a code for a remote agent.' });
    const created = deps.grants.create({ name: held.client.name, clientId: held.clientId, redirectHost: host, route, level: spec.level, projects: spec.projects, ...(spec.chats ? { chats: spec.chats } : {}), ...(remoteFull ? { allowRemoteFull: true } : {}), expiresAt: deps.now() + SIGN_IN_MS });
    deps.notify(created.grant);
    const record: AuthCodeRecord = { grantId: created.grant.id, clientId: held.clientId, redirectUri: held.redirectUri, challenge: held.challenge, resource: held.resource };
    redirect(res, held.redirectUri, { code: authCodes.issue(record), ...backParams });
  };

  const token = async (req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> => {
    const form = await readForm(req);
    if (form === 'too_large') return tokenError(res, 'invalid_request', 413);
    if (!form) return tokenError(res, 'invalid_request');
    // Checked after the lookup: a valid code or token always goes through, whoever failed before it.
    const failed = (error: string): void => {
      // Through a route only: a stranger's flood must not hide invalid_grant from a client on this computer.
      const fits = tokenFailures.take(ctx.visitor, TOKEN_FAILURES.perVisitor) && (!ctx.remote || tokenFailuresInAll.take('', TOKEN_FAILURES.totalPerMinute));
      if (fits) return tokenError(res, error);
      deps.refused?.('token_failures');
      tokenError(res, 'slow_down', 429);
    };
    const type = form.get('grant_type');
    const clientId = form.get('client_id') ?? '';
    if (type === 'authorization_code') return codeExchange(res, form, clientId, ctx, failed);
    if (type !== 'refresh_token') return tokenError(res, 'unsupported_grant_type');
    const used = deps.grants.useRefresh(form.get('refresh_token') ?? '');
    if (used === 'reused') {
      deps.log?.('external sign-in: a spent refresh token came back; its grant is revoked');
      return failed('invalid_grant');
    }
    if (!used || used.grant.clientId !== clientId) return failed('invalid_grant');
    // The token is bound to its audience already; a client that repeats one must repeat it right.
    if (form.has('resource') && form.get('resource') !== used.audience) return failed('invalid_target');
    // A new address: the client signs in again. Its refresh token isn't spent, so nothing else ends.
    if (used.audience !== ctx.resource) return tokenError(res, 'invalid_grant', 400, OTHER_ADDRESS);
    sendTokens(res, deps.grants, used.grant.id, used.audience);
  };

  const codeExchange = (res: ServerResponse, form: URLSearchParams, clientId: string, ctx: RequestContext, failed: (error: string) => void): void => {
    const used = authCodes.use(form.get('code') ?? '');
    if (used.outcome === 'unknown') return failed('invalid_grant');
    if (used.outcome === 'reused') {
      // OAuth 2.1: whoever replays a code may have stolen it, so what it gave ends.
      deps.grants.revoke(used.record.grantId);
      return failed('invalid_grant');
    }
    const { record } = used;
    if (record.clientId !== clientId || record.redirectUri !== form.get('redirect_uri')) return failed('invalid_grant');
    if (!pkceMatches(form.get('code_verifier') ?? '', record.challenge)) return failed('invalid_grant');
    if (form.get('resource') !== record.resource || record.resource !== ctx.resource) return failed('invalid_target');
    sendTokens(res, deps.grants, record.grantId, record.resource);
  };

  const showPage = (res: ServerResponse, id: string, held: Pending, error?: string, confirmFullCode?: string): void => {
    const { route, host } = routeOfPending(held);
    sendSignInPage(res, { agent: held.client.name, route: confirmFullCode ? 'remote' : route, host, loopback: routeOf(held.redirectUri).route === 'local', pending: id, redirectOrigin: new URL(held.redirectUri).origin, ...(error ? { error } : {}), ...(confirmFullCode ? { confirmFullCode } : {}) });
  };

  return async (req, res, ctx) => {
    const route = `${req.method ?? ''} ${(req.url ?? '').split('?')[0] ?? ''}`;
    switch (route) {
      case `GET ${RESOURCE_METADATA_PATH}`:
      case 'GET /.well-known/oauth-protected-resource':
        sendJson(res, 200, { resource: `${ctx.origin}${MCP_PATH}`, authorization_servers: [ctx.origin], bearer_methods_supported: ['header'] });
        return true;
      case 'GET /.well-known/oauth-authorization-server':
        sendJson(res, 200, {
          issuer: ctx.origin,
          authorization_endpoint: `${ctx.origin}/authorize`,
          token_endpoint: `${ctx.origin}/token`,
          registration_endpoint: `${ctx.origin}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          // Every sign-in gets a refresh token. A client such as ChatGPT looks for this word to expect one.
          scopes_supported: ['offline_access'],
          token_endpoint_auth_methods_supported: ['none'],
          client_id_metadata_document_supported: true,
          authorization_response_iss_parameter_supported: true,
        });
        return true;
      case 'POST /register':
        await register(req, res, deps);
        return true;
      case 'GET /authorize':
        await authorizeGet(req, res, ctx);
        return true;
      case 'POST /authorize':
        await authorizePost(req, res, ctx);
        return true;
      case `POST ${TOKEN_PATH}`:
        await token(req, res, ctx);
        return true;
      default:
        return false;
    }
  };
}

/** Through a route it is remote, even when its redirect is a loopback address (a client on another computer). */
function routeOfPending(held: Pending): ReturnType<typeof routeOf> {
  const { route, host } = routeOf(held.redirectUri);
  return { route: held.remote ? 'remote' : route, host };
}

/** Stateless registration: the client_id itself carries what was registered, signed. */
async function register(req: IncomingMessage, res: ServerResponse, deps: OAuthDeps): Promise<void> {
  let parsed: z.infer<typeof Registration>;
  try {
    parsed = Registration.parse(JSON.parse((await readBody(req, FORM_MAX)) ?? ''));
  } catch {
    return sendJson(res, 400, { error: 'invalid_client_metadata' });
  }
  if (!parsed.redirect_uris.every(allowedRedirect)) return sendJson(res, 400, { error: 'invalid_redirect_uri' });
  const name = cleanAgentName(parsed.client_name ?? 'An MCP client');
  const body = Buffer.from(JSON.stringify({ n: name, r: parsed.redirect_uris })).toString('base64url');
  const clientId = `${REGISTERED_PREFIX}${body}.${sign(body, deps.signingKey())}`;
  sendJson(res, 201, { client_id: clientId, client_id_issued_at: Math.floor(deps.now() / 1000), client_name: name, redirect_uris: parsed.redirect_uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
}

async function resolveClient(clientId: string, deps: OAuthDeps): Promise<ClientMetadata | undefined> {
  if (clientId.startsWith(REGISTERED_PREFIX)) return registeredClient(clientId, deps.signingKey());
  if (!clientIdUrl(clientId)) return undefined;
  const client = await deps.fetchClient(clientId);
  return { name: cleanAgentName(client.name), redirectUris: client.redirectUris.filter(allowedRedirect) };
}

function registeredClient(clientId: string, key: string): ClientMetadata | undefined {
  const [body, signature] = clientId.slice(REGISTERED_PREFIX.length).split('.');
  if (!body || !signature) return undefined;
  const want = Buffer.from(sign(body, key));
  const got = Buffer.from(signature);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return undefined;
  const { n, r } = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { n: string; r: string[] };
  return { name: n, redirectUris: r };
}

const sign = (body: string, key: string): string => createHmac('sha256', key).update(body).digest('base64url');

function sendTokens(res: ServerResponse, grants: GrantStore, grantId: string, audience: string): void {
  const access = grants.issueAccess(grantId, audience, ACCESS_MS);
  const refresh = grants.issueRefresh(grantId, audience);
  if (!access || !refresh) return tokenError(res, 'invalid_grant');
  sendJson(res, 200, { access_token: access, token_type: 'Bearer', expires_in: Math.floor(ACCESS_MS / 1000), refresh_token: refresh });
}

const tokenError = (res: ServerResponse, error: string, status = 400, description?: string): void => sendJson(res, status, { error, ...(description ? { error_description: description } : {}) });

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
}

function redirect(res: ServerResponse, uri: string, params: Readonly<Record<string, string>>): void {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  res.writeHead(303, { location: url.href }).end();
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams | 'too_large' | undefined> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) return undefined;
  const text = await readBody(req, FORM_MAX, FORM_DRAIN);
  return text === undefined ? 'too_large' : new URLSearchParams(text);
}
