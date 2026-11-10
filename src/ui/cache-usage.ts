import { RUNTIME_NAMES, modelName } from '../shared/agent-label.js';
import { type CacheCounts, cacheHitPct, sessionCache } from '../shared/context-usage.js';

/**
 * Cache hit rate by conversation and by model, from the counts each turn already records.
 * A row exists only when something was counted. 0% is a real measurement (cache written, nothing read).
 * Browser-safe.
 */

export interface CacheWorkspace {
  readonly id: string;
  readonly name: string;
  readonly model?: string;
  readonly agent?: { readonly runtime: string; readonly model?: string };
  readonly archived?: boolean;
  readonly usage?: { readonly session?: CacheCounts; readonly last?: CacheCounts; readonly lastAt?: number };
}

export interface CacheProject {
  readonly name: string;
  readonly workspaces: readonly CacheWorkspace[];
}

export interface CacheDefaults {
  readonly runtime?: string;
  /** The default agent's own model. Claude's Settings model belongs here only when that agent is Claude. */
  readonly model?: string;
  readonly projectAgents?: Readonly<Record<string, { readonly runtime: string; readonly model?: string }>>;
}

export interface CacheHitRow {
  readonly key: string;
  readonly scope: 'session' | 'model';
  readonly label: string;
  readonly pct: number;
  readonly lastAt?: number;
}

export interface CacheHitTables {
  readonly sessions: readonly CacheHitRow[];
  readonly models: readonly CacheHitRow[];
}

interface Bucket {
  key: string;
  label: string;
  runtime: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
}

const runtimeOf = (project: CacheProject, ws: CacheWorkspace, defaults: CacheDefaults): string =>
  ws.agent?.runtime ?? defaults.projectAgents?.[project.name]?.runtime ?? defaults.runtime ?? 'claude';

function modelIdOf(project: CacheProject, ws: CacheWorkspace, context: Readonly<Record<string, { readonly model?: string } | undefined>>, defaults: CacheDefaults): string | undefined {
  const reported = context[`ws:${ws.id}`]?.model || ws.model || ws.agent?.model;
  if (reported || ws.agent) return reported;
  const projectAgent = defaults.projectAgents?.[project.name];
  if (projectAgent) return projectAgent.model;
  return defaults.model;
}

/** One row per conversation that counted cache, and those counts grouped by the model the conversation uses now. */
export function cacheHitRows(projects: readonly CacheProject[], context: Readonly<Record<string, { readonly model?: string } | undefined>> = {}, defaults: CacheDefaults = {}): CacheHitTables {
  const sessions: CacheHitRow[] = [];
  const models = new Map<string, Bucket>();
  for (const project of projects) {
    for (const ws of project.workspaces) {
      const counts = sessionCache(ws.usage);
      const pct = cacheHitPct(counts);
      if (!counts || pct === undefined) continue;
      sessions.push({ key: ws.id, scope: 'session', label: ws.name || 'Conversation', pct, ...(ws.usage?.lastAt ? { lastAt: ws.usage.lastAt } : {}) });
      const runtime = runtimeOf(project, ws, defaults);
      const modelId = modelIdOf(project, ws, context, defaults);
      const key = `${runtime}:${modelId ?? ''}`;
      const bucket = models.get(key) ?? { key, label: modelId ? modelName(modelId) : 'Model not recorded', runtime, input: 0, cacheRead: 0, cacheWrite: 0 };
      bucket.input += counts.input;
      bucket.cacheRead += counts.cacheRead;
      bucket.cacheWrite += counts.cacheWrite;
      models.set(key, bucket);
    }
  }
  const seen = new Map<string, number>();
  for (const bucket of models.values()) seen.set(bucket.label, (seen.get(bucket.label) ?? 0) + 1);
  const modelRows: CacheHitRow[] = [];
  for (const bucket of models.values()) {
    const pct = cacheHitPct(bucket);
    if (pct === undefined) continue;
    const runtime = RUNTIME_NAMES[bucket.runtime] ?? bucket.runtime;
    const label = (seen.get(bucket.label) ?? 0) > 1 ? `${runtime} · ${bucket.label}` : bucket.label;
    modelRows.push({ key: bucket.key, scope: 'model', label, pct });
  }
  sessions.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0) || a.label.localeCompare(b.label));
  modelRows.sort((a, b) => b.pct - a.pct || a.label.localeCompare(b.label));
  return { sessions, models: modelRows };
}

/** The phone's list: recent sessions, then models, capped so the frame stays small. */
export function phoneCacheRows(tables: CacheHitTables, clip: (s: string, max: number) => string, max = 24): { readonly scope: 'session' | 'model'; readonly label: string; readonly pct: number }[] {
  const sessions = tables.sessions.slice(0, 12);
  const models = tables.models.slice(0, 12);
  return [...sessions, ...models].slice(0, max).map((r) => ({ scope: r.scope, label: clip(r.label, 80), pct: r.pct }));
}
