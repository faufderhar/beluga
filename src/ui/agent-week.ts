import { type StatsSnapshot, statDay } from '../shared/stats.js';

/** One agent's week on the Usage tab (an ACP agent's card): what Beluga counted, over every project. */
export interface AgentWeek {
  readonly runs: number;
  /** How long it worked on your runs (ms). */
  readonly agentMs: number;
  readonly tokens: number;
  /** What it said its turns cost (USD); 0 when it never said. */
  readonly cost: number;
  /** Its agent time on each of the last 7 days, today last. */
  readonly days: readonly number[];
}

/** The last 7 days (today included) of `runtime` in your stats. */
export function agentWeek(days: StatsSnapshot['days'], runtime: string, now: number): AgentWeek {
  const t = new Date(now);
  let runs = 0;
  let agentMs = 0;
  let tokens = 0;
  let cost = 0;
  const each: number[] = [];
  for (let back = 6; back >= 0; back--) {
    const day = days[statDay(new Date(t.getFullYear(), t.getMonth(), t.getDate() - back).getTime())] ?? {};
    let ms = 0;
    for (const agents of Object.values(day)) {
      const c = agents[runtime];
      if (!c) continue;
      runs += c.runs ?? 0;
      ms += c.agentMs ?? 0;
      tokens += c.tokens ?? 0;
      cost += c.cost ?? 0;
    }
    agentMs += ms;
    each.push(ms);
  }
  return { runs, agentMs, tokens, cost, days: each };
}
