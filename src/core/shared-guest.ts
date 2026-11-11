import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { AgentPlace } from '../agent/types.js';
import type { SharedWorkspace } from './collab-store.js';

/**
 * A guest in a friend's worktree (it runs on the friend's Mac, where its files are). What they type
 * goes to the owner's agent, as ever; "@claude …" is their own agent, on their own Mac, reading the
 * worktree from afar and answering in the same conversation; "@claude:<owner> …" names the owner's.
 */
export interface SharedAsk {
  readonly to: 'self' | 'owner';
  /** What the agent is asked (a leading mention taken off). */
  readonly prompt: string;
}

/** How a name is written after "@" (as the message box completes it: src/ui/suggest.ts friendMention). */
const handle = (name: string): string => name.replace(/[^\p{L}\p{N}_.-]+/gu, '');

export function sharedAskTarget(text: string, ownerName: string): SharedAsk {
  const trimmed = text.trim();
  const match = /^@claude(?::([^\s]+))?\s+([\s\S]+)$/i.exec(trimmed);
  if (!match) return { to: 'owner', prompt: trimmed };
  const named = match[1];
  const prompt = match[2]!.trim();
  if (!named) return { to: 'self', prompt };
  // Anyone else's agent stays in the words, for the owner's agent to reach (as it always did).
  return handle(named).toLowerCase() === handle(ownerName).toLowerCase() ? { to: 'owner', prompt } : { to: 'owner', prompt: trimmed };
}

/** Where your agent works for your asks in friends' worktrees: a folder of its own, with nothing of theirs in it. */
export function guestPlace(home: string): AgentPlace {
  const cwd = path.join(home, 'guest-work');
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  return { cwd, additionalDirectories: [], autoEdit: false, onSession: () => undefined };
}

/** What your agent is told when you ask it in a friend's worktree. */
export function sharedWorktreeBrief(ws: Pick<SharedWorkspace, 'name' | 'project' | 'branch' | 'share'>, ownerName: string): string {
  return [
    '',
    '',
    `You are answering your owner in ${ownerName}’s worktree "${ws.name}" (project ${ws.project}${ws.branch ? `, branch ${ws.branch}` : ''}),`,
    `which ${ownerName} shared with them in Beluga. It is on ${ownerName}’s Mac, not this one. Everyone in that`,
    'worktree reads your answer there, as your owner’s agent, beside the conversation with its own agent.',
    '',
    `Read its files with the Beluga tools: list_peer_files and read_peer_file, peer "${ownerName}", share "${ws.share}"`,
    '("" for its top folder). You can’t change them or run anything there: for a change, say what to do, and',
    `that your owner can ask ${ownerName}’s agent (@claude:${handle(ownerName) || ownerName} in that conversation) to make it.`,
    'Your working folder here is a scratch folder of your own, not that project.',
  ].join('\n');
}
