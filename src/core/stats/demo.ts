/**
 * A year of made-up stats for the demo (screenshots, e2e): a steady rhythm, busier mid-week and
 * quiet on weekends, mostly Claude with some Codex and a local model, and pull requests merging.
 * Repeatable: the same numbers every run for the same day.
 */
import { type StatCounts, addToDay, statDay } from '../../shared/stats.js';
import type { Project } from '../../workspaces/types.js';
import type { StatsFile } from './file.js';

const DAY = 86_400_000;
const AGENTS = [
  { agent: 'claude', share: 1 },
  { agent: 'codex', share: 0.35 },
  { agent: 'local', share: 0.12 },
] as const;

/** A number from 0 to 1 that's always the same for the same seed. */
const noise = (seed: number): number => {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

export function demoStats(projects: readonly Project[], now: number): Pick<StatsFile, 'days' | 'hours' | 'prs' | 'plan'> {
  const roots = projects.filter((p) => p.root).map((p) => p.root);
  let days: StatsFile['days'] = {};
  const hours = Array.from({ length: 168 }, () => 0);
  const prs: Record<string, StatsFile['prs'][string]> = {};
  const today = new Date(now);
  for (let ago = 364; ago >= 0; ago--) {
    const at = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ago, 12).getTime();
    const dow = new Date(at).getDay();
    const weekend = dow === 0 || dow === 6;
    // Slowly getting into it over the year, with quiet days here and there.
    const pace = (0.25 + 0.75 * ((364 - ago) / 364)) * (weekend ? 0.25 : 1) * (noise(ago) < 0.12 ? 0 : 0.5 + noise(ago + 7));
    if (pace <= 0) continue;
    roots.forEach((root, ri) => {
      for (const { agent, share } of AGENTS) {
        const f = pace * share * (1 / (ri + 1)) * (0.6 + noise(ago * 31 + ri * 7 + share * 100) * 0.8);
        if (f < 0.08) continue;
        const prompts = Math.max(1, Math.round(9 * f));
        const add: Partial<StatCounts> = {
          prompts,
          chars: prompts * Math.round(180 + noise(ago + ri) * 260),
          pasted: Math.round(prompts * 420 * noise(ago * 3 + ri)),
          agentMs: Math.round(prompts * (4 + noise(ago * 5) * 6) * 60_000),
          runs: prompts,
          tokens: Math.round(prompts * 21_000 * (agent === 'local' ? 0.6 : 1)),
          cost: agent === 'local' ? 0 : Math.round(prompts * 21_000 * 0.0000165 * 100) / 100,
          ...(noise(ago * 11 + ri) < 0.3 * f + 0.05 ? { worktrees: 1 } : {}),
          ...(noise(ago * 13 + ri) < 0.2 * f ? { archived: 1 } : {}),
          ...(noise(ago * 17 + ri) < 0.15 * f ? { chats: 1 } : {}),
          ...(agent === 'claude' && noise(ago * 19) < 0.35 ? { dictationMs: Math.round(60_000 + noise(ago * 23) * 240_000) } : {}),
        };
        days = { ...days, [statDay(at)]: addToDay(days[statDay(at)], root, agent, add) };
        for (let i = 0; i < prompts; i++) {
          const hour = Math.min(23, Math.max(7, Math.round(10 + noise(ago * 29 + i) * 10 - (noise(i) < 0.3 ? 3 : 0))));
          hours[dow * 24 + hour]! += 1;
        }
        if (noise(ago * 37 + ri + share) < 0.18 * f) {
          const number = 100 + Object.keys(prs).length;
          const merged = noise(ago * 41) < 0.85 ? at + Math.round((0.2 + noise(ago) * 2) * DAY) : undefined;
          prs[`${root}#${number}`] = { project: root, agent, number, opened: at, ...(merged !== undefined && merged < now ? { merged } : {}), added: Math.round(40 + noise(ago * 43) * 600), removed: Math.round(10 + noise(ago * 47) * 240) };
        }
      }
    });
  }
  // The noise above can leave a whole month with only Claude's merges. Usage's month view, and
  // the e2e that reads it, expect Codex and the local model in that window too.
  const monthAgo = now - 30 * DAY;
  const root = roots[0];
  if (root) {
    for (const { agent } of AGENTS) {
      const recent = Object.values(prs).some((p) => p.agent === agent && p.merged !== undefined && p.merged >= monthAgo);
      if (recent) continue;
      const number = 100 + Object.keys(prs).length;
      const merged = now - 6 * DAY;
      prs[`${root}#${number}`] = { project: root, agent, number, opened: merged - 2 * DAY, merged, added: 80, removed: 20 };
    }
  }
  return { days, hours, prs, plan: demoPlan(now) };
}

/**
 * Six weeks of Claude's 5-hour sessions (two or three on a weekday, fewer at weekends; some run
 * out, many leave room) and Codex's, and their weeks. The current ones are open.
 */
function demoPlan(now: number): StatsFile['plan'] {
  const out: StatsFile['plan'][number][] = [];
  const today = new Date(now);
  for (let ago = 41; ago >= 0; ago--) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ago);
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    for (const [i, start] of [9, 14, 19].entries()) {
      if (noise(ago * 53 + i) < (weekend ? 0.7 : 0.12)) continue;
      const resetsAt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), start + 5, Math.round(noise(ago + i) * 50)).getTime();
      const r = noise(ago * 59 + i * 3);
      const peak = r > 0.82 ? 100 : Math.round(18 + r * 85);
      out.push({ runtime: 'claude', kind: 'session', resetsAt, peak: Math.min(100, peak), ...(resetsAt > now ? { open: true as const } : {}) });
      if (noise(ago * 61 + i) < 0.35) out.push({ runtime: 'codex', kind: 'session', resetsAt: resetsAt + 1_800_000, peak: Math.round(10 + noise(ago * 67 + i) * 70), ...(resetsAt + 1_800_000 > now ? { open: true as const } : {}) });
    }
  }
  for (let w = 5; w >= 0; w--) {
    const resetsAt = now + 2 * DAY - w * 7 * DAY;
    out.push({ runtime: 'claude', kind: 'week', resetsAt, peak: w === 0 ? 38 : Math.round(45 + noise(w * 71) * 55), ...(w === 0 ? { open: true as const } : {}) });
  }
  // Only the newest of each kind and provider is still going.
  const seen = new Set<string>();
  return out
    .sort((a, b) => a.resetsAt - b.resetsAt)
    .reverse()
    .map((x) => {
      const key = `${x.runtime}|${x.kind}`;
      if (!x.open) return x;
      if (seen.has(key)) return { runtime: x.runtime, kind: x.kind, resetsAt: x.resetsAt, peak: x.peak };
      seen.add(key);
      return x;
    })
    .reverse();
}

/**
 * Someone who has all but the extras (BELUGA_DEMO_STATS=sparse): only Claude, on a plan that has a
 * week but no 5-hour session, no GitHub CLI (no pull requests), and never dictating.
 */
export function sparseDemoStats(projects: readonly Project[], now: number): Pick<StatsFile, 'days' | 'hours' | 'prs' | 'plan'> {
  const full = demoStats(projects, now);
  const days: StatsFile['days'] = {};
  for (const [key, day] of Object.entries(full.days)) {
    const kept: StatsFile['days'][string] = {};
    for (const [root, agents] of Object.entries(day)) {
      const { dictationMs: _, ...claude } = agents.claude ?? {};
      if (agents.claude) kept[root] = { claude };
    }
    days[key] = kept;
  }
  return { days, hours: full.hours, prs: {}, plan: full.plan.filter((w) => w.runtime === 'claude' && w.kind === 'week') };
}
