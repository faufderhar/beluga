import type { ProjectTeam } from '../../../../src/core/team/model.js';

/**
 * Who's on a board (BLG-906): you, and everyone on the teams of the repos it covers, once each.
 * The board's header shows their avatars; clicking them lists everyone, and someone who isn't
 * your friend yet can be asked from there (team.befriend, through the team you share). Pure, so
 * it's tested on its own (tests/mac-board-people.test.ts).
 */

export interface BoardPerson {
  readonly peerId: string;
  readonly name: string;
  /** This is you (first in the list). */
  readonly you: boolean;
  readonly friend: boolean;
  /** A repo whose team you share with them: the friend request goes through it. */
  readonly projectId?: string;
  /** "acme/api": the team you're on with them, in words. */
  readonly team?: string;
  /** You asked them to be friends and they haven't answered. */
  readonly asked: boolean;
  /** They asked you: Accept is what's left to do. */
  readonly theyAsked: boolean;
}

/** What the list reads from the state: the teams, your friends and friend requests, and who you are. */
export interface BoardPeopleState {
  readonly teams: Readonly<Record<string, ProjectTeam | undefined>>;
  readonly friends: ReadonlyArray<{ readonly peerId: string }>;
  readonly offers?: ReadonlyArray<{ readonly peerId: string; readonly dir: 'in' | 'out'; readonly expiresAt: number }>;
  readonly self: { readonly peerId: string; readonly name: string };
}

/** You, then the others by name. Nobody but you: just you (the header shows nothing then). */
export function boardPeople(state: BoardPeopleState, repos: readonly string[], now = Date.now()): readonly BoardPerson[] {
  const offers = state.offers ?? [];
  const pending = (peerId: string, dir: 'in' | 'out'): boolean => offers.some((o) => o.dir === dir && o.peerId === peerId && o.expiresAt > now);
  const others = new Map<string, BoardPerson>();
  for (const repo of repos) {
    const team = state.teams[repo];
    for (const m of team?.mates ?? []) {
      if (m.peerId === state.self.peerId || others.has(m.peerId)) continue;
      others.set(m.peerId, {
        peerId: m.peerId,
        name: m.name,
        you: false,
        friend: state.friends.some((f) => f.peerId === m.peerId),
        projectId: repo,
        team: team!.repo,
        asked: pending(m.peerId, 'out'),
        theyAsked: pending(m.peerId, 'in'),
      });
    }
  }
  const me: BoardPerson = { peerId: state.self.peerId, name: state.self.name, you: true, friend: false, asked: false, theyAsked: false };
  return [me, ...[...others.values()].sort((a, b) => a.name.localeCompare(b.name))];
}

/** What a person's line says under their name. */
export function boardPersonLine(p: BoardPerson): string {
  if (p.you) return 'You';
  if (p.friend) return 'Friend';
  if (p.theyAsked) return 'Asked to be your friend';
  if (p.asked) return 'Asked to be friends';
  return p.team ? `On the ${p.team} team, not a friend yet` : 'On the team, not a friend yet';
}

/** The avatars' label: "On this board: you, Ata and Mia". */
export function boardPeopleLabel(people: readonly BoardPerson[]): string {
  const names = people.map((p) => (p.you ? 'you' : p.name));
  const words = names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `On this board: ${words}`;
}
