import { describe, expect, it } from 'vitest';
import type { ProjectTeam } from '../src/core/team/model.js';
import { type BoardPeopleState, boardPeople, boardPeopleLabel, boardPersonLine } from '../packages/mac/src/tasks/board-people.js';

/** Who's on a board, for its header (packages/mac/src/tasks/board-people.ts, BLG-906). */

const id = (c: string): string => c.repeat(32);
const team = (projectId: string, repo: string, mates: Array<[string, string]>): ProjectTeam => ({ projectId, repo, mates: mates.map(([peerId, name]) => ({ peerId, name, since: 1 })) });
const NOW = 1_000_000;

const state = (over: Partial<BoardPeopleState> = {}): BoardPeopleState => ({
  teams: {
    api: team('api', 'acme/api', [[id('a'), 'Ata'], [id('m'), 'Mia']]),
    web: team('web', 'acme/web', [[id('m'), 'Mia'], [id('z'), 'Zoe']]),
  },
  friends: [{ peerId: id('a') }],
  offers: [],
  self: { peerId: id('k'), name: 'Kay' },
  ...over,
});

describe('who is on a board', () => {
  it('is you first, then everyone on its repos’ teams once each, by name', () => {
    const people = boardPeople(state(), ['api', 'web'], NOW);
    expect(people.map((p) => p.name)).toEqual(['Kay', 'Ata', 'Mia', 'Zoe']);
    expect(people[0]).toMatchObject({ you: true });
    // Mia is on both teams: asked through the first one the board covers.
    expect(people.find((p) => p.name === 'Mia')).toMatchObject({ projectId: 'api', team: 'acme/api', friend: false });
  });

  it('only covers the repos this board shows', () => {
    expect(boardPeople(state(), ['web'], NOW).map((p) => p.name)).toEqual(['Kay', 'Mia', 'Zoe']);
  });

  it('is just you when nobody else works on it (the header shows nothing then)', () => {
    expect(boardPeople(state({ teams: {} }), ['api'], NOW)).toHaveLength(1);
  });

  it('never lists you twice when a team names you', () => {
    const teams = { api: team('api', 'acme/api', [[id('k'), 'Kay'], [id('a'), 'Ata']]) };
    expect(boardPeople(state({ teams }), ['api'], NOW).map((p) => p.name)).toEqual(['Kay', 'Ata']);
  });

  it('knows a friend request still waiting, either way, and forgets one that expired', () => {
    const offers = [
      { peerId: id('m'), dir: 'out' as const, expiresAt: NOW + 1 },
      { peerId: id('z'), dir: 'in' as const, expiresAt: NOW + 1 },
    ];
    const people = boardPeople(state({ offers }), ['api', 'web'], NOW);
    expect(people.find((p) => p.name === 'Mia')).toMatchObject({ asked: true, theyAsked: false });
    expect(people.find((p) => p.name === 'Zoe')).toMatchObject({ asked: false, theyAsked: true });
    const later = boardPeople(state({ offers }), ['api', 'web'], NOW + 2);
    expect(later.every((p) => !p.asked && !p.theyAsked)).toBe(true);
  });
});

describe('what the header and the list say', () => {
  const people = boardPeople(state({ offers: [{ peerId: id('z'), dir: 'in', expiresAt: NOW + 1 }] }), ['api', 'web'], NOW);
  const line = (name: string): string => boardPersonLine(people.find((p) => p.name === name)!);

  it('says who each one is to you', () => {
    expect(line('Kay')).toBe('You');
    expect(line('Ata')).toBe('Friend');
    expect(line('Mia')).toBe('On the acme/api team, not a friend yet');
    expect(line('Zoe')).toBe('Asked to be your friend');
  });

  it('names everyone on the avatars', () => {
    expect(boardPeopleLabel(people)).toBe('On this board: you, Ata, Mia and Zoe');
    expect(boardPeopleLabel(people.slice(0, 2))).toBe('On this board: you and Ata');
  });
});
