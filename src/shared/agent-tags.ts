import type { AgentRef } from '../protocol.js';
import { agentName } from './agent-label.js';
import { type AgentMark, agentMark } from './agent-marks.js';
import { THIS_COMPUTER } from './assistant.js';

/** protocol.ts's defaultAgentOf, repeated so the phone bundles this file without the daemon's protocol. */
// agent-wording: claude (the Claude runtime's own name)
const defaultAgentOf = (p: { readonly agents?: readonly AgentRef[]; readonly defaultAgent?: AgentRef } | undefined): AgentRef => p?.defaultAgent ?? p?.agents?.[0] ?? { runtime: 'claude', label: 'Claude' };

/**
 * The room's agent tags (BLG-520), as the Mac's composer and the phone list them after "@": your
 * own agents by runtime ("@codex"), and each person's by name and runtime ("@bob:codex",
 * "@bob:claude"), each with its mark. Only agents that person runs: what their card lists (an older
 * Mac's: its one agent); yours: what runs on this Mac. Browser-safe, types only.
 */

export interface AgentTag {
  /** What goes in the box: "@codex", "@bob:codex". */
  readonly tag: string;
  /** Whose: the peer id. */
  readonly peerId: string;
  readonly agent: AgentRef;
  readonly mark: AgentMark;
  /** A word about it: "your Codex, on this Mac", "bob's Codex, on his Mac · answers @bob". */
  readonly hint: string;
  /** For the person: "@bo" offers bob's agents too. */
  readonly person?: string;
}

/** The parts of a room peer the tags read. */
export interface TagPeer {
  readonly peerId: string;
  readonly name: string;
  /** Lets the room use their agent. */
  readonly agent?: boolean;
  readonly agents?: readonly AgentRef[];
  readonly defaultAgent?: AgentRef;
}

/** One of your own runtimes, as the picker knows it (shared/agent-runtimes.ts RuntimeChoice). */
export interface TagRuntime {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
}

/** A name as it goes after @ ("Mia Chen" → "MiaChen"): what parseInput's MENTION takes. */
const handle = (name: string): string => name.replace(/[^\w.-]+/g, '');

/** Each runtime once, the default's first. */
function byRuntime(list: readonly AgentRef[], first: AgentRef): AgentRef[] {
  const seen = new Set<string>();
  return [first, ...list].filter((a) => !seen.has(a.runtime) && Boolean(seen.add(a.runtime)));
}

export function roomAgentTags(peers: readonly TagPeer[], selfId: string, mine: readonly TagRuntime[] = []): AgentTag[] {
  const self = peers.find((p) => p.peerId === selfId);
  const yourDefault = defaultAgentOf(self);
  // Yours: every runtime that runs here but Claude ("@claude" stays the old alias for your agent).
  const yours: AgentTag[] = mine
    .filter((r) => r.available && r.id !== 'claude' && /^[\w.-]+$/.test(r.id))
    .map((r) => {
      const agent = self?.agents?.find((a) => a.runtime === r.id) ?? { runtime: r.id, label: r.label };
      const isDefault = yourDefault.runtime === r.id;
      return { tag: `@${r.id}`, peerId: selfId, agent, mark: agentMark(agent), hint: `your ${agentName(agent)}, on ${THIS_COMPUTER}${isDefault ? ' (your default)' : ''}` };
    });
  const theirs: AgentTag[] = peers
    .filter((p) => p.peerId !== selfId && p.agent && handle(p.name))
    .flatMap((p) => {
      const def = defaultAgentOf(p);
      return byRuntime(p.agents ?? [], def)
        .filter((a) => /^[\w.-]+$/.test(a.runtime))
        .map((a) => ({
          tag: `@${handle(p.name)}:${a.runtime}`,
          peerId: p.peerId,
          agent: a,
          mark: agentMark(a),
          hint: `${p.name}'s ${agentName(a)}, on their Mac${a.runtime === def.runtime ? ` · @${handle(p.name)} asks it too` : ''}`,
          person: `@${handle(p.name)}`,
        }));
    });
  return [...yours, ...theirs];
}

/** The "@…" being typed at the end of the words, without the @ (undefined: not typing a tag). */
const typedTag = (text: string): string | undefined => /(?:^|\s)@([\w.:-]*)$/.exec(text)?.[1];

/**
 * The tags for what's being typed (the phone's chips): "@" lists them all, "@bo" bob's, "@co" your
 * Codex; a tag typed out whole lists nothing more.
 */
export function matchTags<T extends { readonly tag: string }>(text: string, tags: readonly T[], max = 8): T[] {
  const typed = typedTag(text);
  if (typed === undefined) return [];
  const want = `@${typed}`.toLowerCase();
  return tags.filter((t) => t.tag.toLowerCase().startsWith(want) && t.tag.toLowerCase() !== want).slice(0, max);
}

/** The words with the tag being typed replaced by `tag` (and a space after it). */
export function withTag(text: string, tag: string): string {
  const typed = typedTag(text);
  return typed === undefined ? `${text}${text && !/\s$/.test(text) ? ' ' : ''}${tag} ` : `${text.slice(0, text.length - typed.length - 1)}${tag} `;
}
