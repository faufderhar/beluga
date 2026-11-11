import { parseArgs } from 'node:util';
import { externalPort, externalUrl, readExternalConfig, writeExternalConfig } from '../external/adapters/config-file.js';
import type { ReachRouteState } from '../external/adapters/reach.js';
import { FULL_REACH, defaultLevel, type Grant } from '../external/domain/grant.js';
import { REMOTE_ROUTES, type RemoteRoute } from '../external/domain/reach.js';
import type { ExternalStatus } from '../external/service.js';
import { belugaEnv } from '../core/beluga-env.js';
import { REMOTE_FULL_WARNING } from '../shared/remote-full.js';
import { callDaemon, callDaemonWithin, daemonRunning } from './daemon-call.js';

const GRANT_OPTIONS = { level: { type: 'string' }, project: { type: 'string', multiple: true }, 'no-dms': { type: 'boolean' }, 'no-groups': { type: 'boolean' } } as const;
const ROUTE_OPTIONS = { tailscale: { type: 'boolean' }, public: { type: 'boolean' } } as const;
/** A card on the Mac waits 5 minutes before it's declined. */
const CARD_WAIT_MS = 5 * 60_000 + 10_000;
/** A fresh tunnel name may take this long to answer. */
const ROUTE_WAIT_MS = 3 * 60_000;

export const MCP_USAGE = `Usage: beluga mcp <command>
  on       let external agents connect (stays on across restarts)
             --tailscale   also over https on your tailnet, on port 8443 (Tailscale Serve, never Funnel)
             --public      also over a public https address (a Cloudflare quick tunnel). It changes when
                           the tunnel restarts, and agents then sign in again
  off      close the port and every route
             --tailscale, --public   close only that route
  status   say whether it is on, and where
  url      print the URL to give an MCP client
             --tailscale, --public   the URL through that route
  pair     make a one-time code for an agent's sign-in page
             --level ask|trusted|full   what it may do (default full; with --remote, trusted)
             --project <name>           only this project (repeat; default all, also later ones);
                                        chats: all your chats with no project
             --no-dms, --no-groups      no direct messages, no groups (default both)
             --remote                   for an agent outside this computer
             --allow-remote-full        with --remote --level full: your explicit choice, for this code only
  token --name <agent>   a local grant for a client with no OAuth, after you say yes on the Mac
             takes --level and --project too
  stdio    bridge a client's stdio to Beluga (token in BELUGA_MCP_TOKEN, never on the command line)
  agents   list the agents that hold a grant
  revoke <id>   end an agent's grant now
  resume <id>   lift an agent's suspension
`;

/** `beluga mcp …`. Everything that changes state goes through the running daemon; it has the only grant book. */
export async function runMcp(args: readonly string[], out: (text: string) => void = (t) => void process.stdout.write(t)): Promise<number> {
  switch (args[0]) {
    case 'on':
    case 'off':
      out(await setEnabled(args[0] === 'on', args.slice(1)));
      return 0;
    case 'status':
      out(await statusText());
      return 0;
    case 'url':
      out(await urlText(args.slice(1)));
      return 0;
    case 'pair':
      out(await pair(args.slice(1)));
      return 0;
    case 'token':
      out(await localToken(args.slice(1)));
      return 0;
    case 'stdio':
      await stdio();
      return 0;
    case 'agents':
      out(agentsText((await callDaemon('external.agents')) as readonly Grant[]));
      return 0;
    case 'revoke': {
      if (!args[1]) throw new Error('Which agent? See `beluga mcp agents`.');
      const gone = (await callDaemon('external.revoke', args[1])) as boolean;
      out(gone ? `Revoked ${args[1]}. Its next call gets refused.\n` : `No agent ${args[1]}.\n`);
      return gone ? 0 : 1;
    }
    case 'resume': {
      if (!args[1]) throw new Error('Which agent? See `beluga mcp agents`.');
      const had = (await callDaemon('external.resume', args[1])) as boolean;
      out(had ? `Resumed ${args[1]}.\n` : `No agent ${args[1]}.\n`);
      return had ? 0 : 1;
    }
    default:
      out(MCP_USAGE);
      return args[0] === undefined || args[0] === '--help' ? 0 : 1;
  }
}

async function setEnabled(on: boolean, args: readonly string[]): Promise<string> {
  const routes = routesOf(args);
  if (!daemonRunning()) {
    writeExternalConfig(on ? { enabled: true, ...Object.fromEntries(routes.map((r) => [r, true])) } : routes.length ? Object.fromEntries(routes.map((r) => [r, false])) : { enabled: false, tailscale: false, public: false });
    return routes.length ? `${routes.join(' and ')}: ${on ? 'on' : 'off'} from the next time Beluga starts.\n` : `External agents are ${on ? 'on' : 'off'} from the next time Beluga starts.\n`;
  }
  if (!routes.length) return describe((await callDaemon('external.setEnabled', on)) as ExternalStatus);
  let status: ExternalStatus | undefined;
  for (const route of routes) status = (await callDaemonWithin(ROUTE_WAIT_MS, 'external.setRoute', route, on)) as ExternalStatus;
  return describe(status!);
}

async function urlText(args: readonly string[]): Promise<string> {
  const [route] = routesOf(args);
  if (!route) return `${externalUrl(externalPort())}\n`;
  const status = daemonRunning() ? ((await callDaemon('external.status')) as ExternalStatus) : undefined;
  const url = status?.routes?.find((r) => r.kind === route)?.url;
  if (!url) throw new Error(`The ${route} route is not open. Run beluga mcp on --${route}.`);
  return `${url}\n`;
}

function routesOf(args: readonly string[]): RemoteRoute[] {
  const { values } = parseArgs({ args: [...args], options: ROUTE_OPTIONS });
  return REMOTE_ROUTES.filter((r) => values[r]);
}

async function statusText(): Promise<string> {
  if (daemonRunning()) return describe((await callDaemon('external.status')) as ExternalStatus);
  return `Beluga is not running. External agents are ${readExternalConfig().enabled ? 'on' : 'off'} for when it starts.\n`;
}

function describe(status: ExternalStatus): string {
  if (status.on) return `External agents: on, at ${status.url}\n${(status.routes ?? []).map(routeLine).join('')}`;
  return status.error ? `External agents: not listening: ${status.error}\n` : 'External agents: off\n';
}

function routeLine(route: ReachRouteState): string {
  if (route.state !== 'on') return `  ${route.kind}: opening a new address${route.error ? ` (${route.error})` : ''}\n`;
  return route.kind === 'public' ? `  public: ${route.url}\n  This address changes when the tunnel restarts. Agents must then sign in again.\n` : `  tailscale: ${route.url}\n`;
}

async function pair(args: readonly string[]): Promise<string> {
  const { values } = parseArgs({ args: [...args], options: { ...GRANT_OPTIONS, remote: { type: 'boolean' as const }, 'allow-remote-full': { type: 'boolean' as const } } });
  const spec = { ...grantSpec(values), ...(values.remote ? { remote: true } : {}), ...(values['allow-remote-full'] ? { allowRemoteFull: true } : {}) };
  const made = (await callDaemon('external.pairingCode', spec)) as { code: string; expiresAt: number };
  const reach = spec.projects === 'all' ? 'all projects and chats' : spec.projects.length ? spec.projects.join(', ') : 'no projects';
  return `Pairing code: ${made.code}\nIt works once, for 10 minutes. It gives: ${spec.level}, ${reach}${spec.chats.dms ? ', direct messages' : ''}${spec.chats.groups ? ', groups' : ''}.\n${spec.allowRemoteFull ? `WARNING: ${REMOTE_FULL_WARNING}\n` : ''}`;
}

async function localToken(args: readonly string[]): Promise<string> {
  const { values } = parseArgs({ args: [...args], options: { ...GRANT_OPTIONS, name: { type: 'string' as const } } });
  if (!values.name) throw new Error('--name says who the token is for');
  const made = (await callDaemonWithin(CARD_WAIT_MS, 'external.localToken', values.name, grantSpec(values))) as { grant: Grant; token: string };
  return `Set this in your client's environment. It shows only now.\nBELUGA_MCP_TOKEN=${made.token}\nThe client runs: beluga mcp stdio\nAgent ${made.grant.id}: revoke it with beluga mcp revoke ${made.grant.id}\n`;
}

async function stdio(): Promise<void> {
  const token = belugaEnv('MCP_TOKEN');
  if (!token) throw new Error('beluga mcp stdio needs BELUGA_MCP_TOKEN in its environment. Make one with beluga mcp token --name <agent>.');
  delete process.env.BELUGA_MCP_TOKEN;
  delete process.env.KLAUD_MCP_TOKEN;
  const { bridgeStdio } = await import('../external/adapters/stdio.js');
  // The client closed its end: nothing more will come.
  const clientClosed = new Promise<void>((resolve) => process.stdin.once('end', resolve).once('close', resolve));
  await bridgeStdio(belugaEnv('MCP_URL') ?? externalUrl(externalPort()), token, clientClosed);
}

function grantSpec(values: { readonly level?: string | undefined; readonly project?: string[] | undefined; readonly 'no-dms'?: boolean | undefined; readonly 'no-groups'?: boolean | undefined; readonly remote?: boolean | undefined }): { level: 'ask' | 'trusted' | 'full'; projects: 'all' | string[]; chats: { dms: boolean; groups: boolean } } {
  const { level = defaultLevel(values.remote), project } = values;
  if (level !== 'ask' && level !== 'trusted' && level !== 'full') throw new Error('--level is ask, trusted or full');
  return { level, projects: project ?? FULL_REACH.projects, chats: { dms: !values['no-dms'], groups: !values['no-groups'] } };
}

function agentsText(agents: readonly Grant[]): string {
  if (!agents.length) return 'No external agents.\n';
  return agents.map((a) => `${a.id}  ${a.name}  ${a.level}  ${a.route}${a.route === 'remote' && a.level === 'full' ? '  WARNING: full from outside this computer' : ''}${a.suspendedAt === undefined ? '' : '  suspended'}  last seen ${new Date(a.lastSeen).toISOString()}\n`).join('');
}
