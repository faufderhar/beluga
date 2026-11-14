/**
 * Usage statistics, in the shared state: whether this build can send them at all (only Beluga's own
 * releases carry where to send them: src/telemetry/config.ts), the level you chose, and whether the
 * one ask is due now. The record itself (your level, how you answered, this install's random id) is
 * kept in ~/.beluga/telemetry.json (src/telemetry/record.ts). Browser-safe: the Mac app runs it.
 *
 * - off: nothing is sent.
 * - limited: what Beluga does, without any text: runs, tools, features, errors, this computer's kind.
 * - on: limited, plus the text of your own conversations (your prompts and the agent's answers),
 *   masked on this computer before anything leaves it. Never files, paths or commands.
 *
 * Nothing is sent before a level is chosen. A new install chooses at the end of the onboarding
 * (Limited preselected; Skip keeps it). One that updated asks once (Share, Later, No thanks).
 */

export const TELEMETRY_LEVELS = ['off', 'limited', 'on'] as const;
export type TelemetryLevel = (typeof TELEMETRY_LEVELS)[number];

/** What the onboarding and the ask preselect. */
export const DEFAULT_LEVEL: TelemetryLevel = 'limited';

/** Where a level was chosen. */
export type TelemetryVia = 'onboarding' | 'ask' | 'settings';

/** How the ask was answered: Share (with a level), Later, or No thanks (never asked again). */
export type TelemetryAnswer = 'share' | 'later' | 'never';

/**
 * The ask's round. A release that bumps it asks again whoever said Later or never answered;
 * No thanks stays no. (A release that sends something new should bump it.)
 */
export const ASK_ROUND = 1;

/** Later asks again after this long, or after this many more merges, whichever comes first. */
export const LATER_MS = 3 * 24 * 60 * 60_000;
export const LATER_MERGES = 5;

/** The ask, answered. */
export interface TelemetryAsked {
  readonly round: number;
  readonly answer: TelemetryAnswer;
  readonly at: number;
  /** How many worktrees had been merged then (Later counts more from here). */
  readonly merges: number;
  /** How many times it was shown. */
  readonly times: number;
}

/** What telemetry.json holds. */
export interface TelemetryRecord {
  /** A random id for this install, made once: it counts installs and links nothing else. */
  readonly installId: string;
  /** Unset: never chosen, nothing is sent. */
  readonly level?: TelemetryLevel;
  readonly chosenAt?: number;
  readonly via?: TelemetryVia;
  readonly ask?: TelemetryAsked;
  /** Projects (their folders) whose runs send nothing, whatever the level (each project's Settings). */
  readonly excluded?: readonly string[];
}

/** The record with a project left out of usage statistics, or back in. */
export function excludeProject(record: TelemetryRecord, root: string, excluded: boolean): TelemetryRecord {
  const others = (record.excluded ?? []).filter((r) => r !== root);
  const next = excluded ? [...others, root] : others;
  const { excluded: _old, ...rest } = record;
  return next.length ? { ...rest, excluded: next } : rest;
}

/** The project a folder belongs to: its main folder or one of its worktrees (longest match wins). */
export function projectOfFolder(projects: ReadonlyArray<{ readonly root: string; readonly workspaces: ReadonlyArray<{ readonly path: string }> }>, dir: string): string | undefined {
  const inside = (base: string): boolean => Boolean(base) && (dir === base || dir.startsWith(base.endsWith('/') ? base : `${base}/`));
  let best: { root: string; len: number } | undefined;
  for (const p of projects) for (const base of [p.root, ...p.workspaces.map((w) => w.path)]) if (inside(base) && (!best || base.length > best.len)) best = { root: p.root, len: base.length };
  return best?.root;
}

/** What the ask's timing depends on. */
export interface AskContext {
  /** This build can send (a release, with where to send). */
  readonly available: boolean;
  /** Worktrees Beluga made that ended up merged (the shared state's support.merges). */
  readonly merges: number;
  readonly now: number;
}

/** Whether the ask is due now. Never in a build that can't send, never after No thanks or a choice made elsewhere. */
export function askDue(record: TelemetryRecord, ctx: AskContext): boolean {
  if (!ctx.available) return false;
  const ask = record.ask;
  if (ask?.answer === 'never') return false;
  // Shared once: that choice stands (Settings changes it), whatever later rounds ask others.
  if (ask?.answer === 'share') return false;
  // Chosen in the onboarding or in Settings, and not left at Later: nothing to ask.
  if (record.level !== undefined && ask?.answer !== 'later') return false;
  if (!ask) return true;
  if (ask.round < ASK_ROUND) return true;
  return ctx.now - ask.at >= LATER_MS || ctx.merges - ask.merges >= LATER_MERGES;
}

/** The record after a level was chosen in the onboarding or in Settings (`now`: epoch ms). */
export function chooseLevel(record: TelemetryRecord, level: TelemetryLevel, via: TelemetryVia, now: number): TelemetryRecord {
  // A choice made in Settings (or on the phone) after Later settles the ask: Off as No thanks, the rest as Share.
  const settled = via !== 'ask' && record.ask?.answer === 'later' ? { ask: { ...record.ask, answer: level === 'off' ? ('never' as const) : ('share' as const) } } : {};
  return { ...record, level, chosenAt: now, via, ...settled };
}

/** The record after the ask was answered: Share keeps `level`, No thanks turns it off, Later changes nothing yet. */
export function answerAsk(record: TelemetryRecord, answer: TelemetryAnswer, level: TelemetryLevel, ctx: Omit<AskContext, 'available'>): TelemetryRecord {
  const asked: TelemetryAsked = { round: ASK_ROUND, answer, at: ctx.now, merges: ctx.merges, times: (record.ask?.times ?? 0) + 1 };
  if (answer === 'share') return { ...chooseLevel(record, level, 'ask', ctx.now), ask: asked };
  if (answer === 'never') return { ...chooseLevel(record, 'off', 'ask', ctx.now), ask: asked };
  return { ...record, ask: asked };
}

/** What screens see. */
export interface TelemetryView {
  /** This build can send usage statistics (Beluga's own releases). Off everywhere else: no ask, no setting. */
  readonly available: boolean;
  /** Unset: not chosen yet (nothing is sent). */
  readonly level?: TelemetryLevel;
  /** The ask to show now (the Mac shows it when nothing else is in the way). */
  readonly due: boolean;
  /** Projects (their folders) left out (each project's Settings). */
  readonly excluded?: readonly string[];
}

export function telemetryView(record: TelemetryRecord, ctx: AskContext): TelemetryView {
  return { available: ctx.available, ...(record.level ? { level: record.level } : {}), due: askDue(record, ctx), ...(record.excluded?.length ? { excluded: record.excluded } : {}) };
}

/** The level that counts now: nothing is sent before a choice, nor from a build that can't send. */
export function effectiveLevel(view: Pick<TelemetryView, 'available' | 'level'>): TelemetryLevel {
  return view.available ? (view.level ?? 'off') : 'off';
}

export interface TelemetrySlice {
  readonly telemetry: TelemetryView;
}

export const initialTelemetry: TelemetrySlice = { telemetry: { available: false, due: false } };

export type TelemetryAction = { type: 'telemetry'; telemetry: TelemetryView };
