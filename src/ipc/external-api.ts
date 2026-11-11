import { z } from 'zod';

/**
 * External agents (docs/parity.md): their server on this computer, for the Mac app and `beluga mcp`.
 * Browser-safe: zod only.
 */
// Each is a restriction: left out, the agent reaches what you reach (domain/grant.ts FULL_REACH). An empty list reaches nothing.
const grantSpec = z.object({ level: z.enum(['ask', 'trusted', 'full']).optional(), projects: z.union([z.literal('all'), z.array(z.string().min(1).max(200)).max(200)]).optional(), chats: z.object({ dms: z.boolean(), groups: z.boolean() }).optional(), remote: z.boolean().optional(), allowRemoteFull: z.boolean().optional() });

export const EXTERNAL_API = {
  // → { on, url?, port?, routes?, error? }
  'external.status': { args: z.tuple([]) },
  // Turn the listener on or off; the choice survives restarts. → the status.
  'external.setEnabled': { args: z.tuple([z.boolean()]) },
  // Open or close one HTTPS route to the listener: Tailscale Serve, or a public quick tunnel. Opening turns the listener on. The choice survives restarts. → the status.
  'external.setRoute': { args: z.tuple([z.enum(['tailscale', 'public']), z.boolean()]) },
  // A one-time code for the sign-in page; it holds what the agent gets (`projects`: ids or names). → { code, expiresAt }
  'external.pairingCode': { args: z.tuple([grantSpec]) },
  // A named local grant for a client with no OAuth, after you say yes on the Mac. → { grant, token }, shown this once.
  'external.localToken': { args: z.tuple([z.string().min(1).max(200), grantSpec]) },
  // The agents that hold a grant → Grant[] (never a token).
  'external.agents': { args: z.tuple([]) },
  // End a grant now: its next call gets 401. → whether there was one.
  'external.revoke': { args: z.tuple([z.string().min(1).max(40)]) },
  // Lift a suspension. → whether there was such a grant.
  'external.resume': { args: z.tuple([z.string().min(1).max(40)]) },
  // End what this agent has going (runs, queue, friend tasks) and keep its grant. → whether anything was going.
  'external.stopAgent': { args: z.tuple([z.string().min(1).max(40)]) },
  // The same for every agent. → how many had anything going.
  'external.stopAll': { args: z.tuple([]) },
  // Refuse every agent and keep the grants; the choice survives restarts. → the status.
  'external.setPaused': { args: z.tuple([z.boolean()]) },
  // What agents did and who decided, newest first. → records with kind allowed, asked or refused.
  'external.activity': { args: z.tuple([z.object({ agent: z.string().min(1).max(40).optional(), kind: z.enum(['allowed', 'asked', 'refused']).optional(), limit: z.number().int().min(1).max(500).optional() }).optional()]) },
} as const;
