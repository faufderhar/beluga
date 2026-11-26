import { describe, expect, it } from 'vitest';
import { agentWeek } from '../src/ui/agent-week.js';
import { type StatsSnapshot, statDay } from '../src/shared/stats.js';

const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m - 1, d, h).getTime();
const NOW = at(2026, 11, 24, 15);

describe('an agent’s week', () => {
  it('adds up the last 7 days, today last, over every project, for that agent only', () => {
    const days: StatsSnapshot['days'] = {
      [statDay(at(2026, 11, 24))]: { '/a': { cursor: { runs: 2, agentMs: 600_000, tokens: 1000, cost: 0.5 } }, '/b': { cursor: { runs: 1, agentMs: 60_000 }, claude: { runs: 9 } } },
      [statDay(at(2026, 11, 18))]: { '/a': { cursor: { runs: 3, agentMs: 120_000, tokens: 500 } } },
      [statDay(at(2026, 11, 17))]: { '/a': { cursor: { runs: 100 } } },
    };
    expect(agentWeek(days, 'cursor', NOW)).toEqual({ runs: 6, agentMs: 780_000, tokens: 1500, cost: 0.5, days: [120_000, 0, 0, 0, 0, 0, 660_000] });
  });

  it('is all zeros with no stats', () => {
    expect(agentWeek({}, 'cursor', NOW)).toEqual({ runs: 0, agentMs: 0, tokens: 0, cost: 0, days: [0, 0, 0, 0, 0, 0, 0] });
  });
});
