// Environment variables you give Beluga for your shells, scripts and Claude, as data (no file
// access), so the core and the Mac app check them the same way. Browser-safe.

/** A variable name a shell accepts: letters, digits and _, not starting with a digit. */
export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_ENV_VARS = 200;
export const MAX_ENV_VALUE = 32_000;

export interface EnvVar {
  readonly key: string;
  readonly value: string;
}

/** What's wrong with a name, in plain words (undefined when it's fine). */
export function envKeyProblem(key: string): string | undefined {
  if (!key) return 'Give it a name';
  if (/^[0-9]/.test(key)) return "Names can't start with a digit";
  if (!ENV_KEY.test(key)) return 'Use letters, digits and _ only';
  return undefined;
}

/** Problems per row (by index): bad names and names used twice. Empty rows are skipped. */
export function envProblems(vars: readonly EnvVar[]): ReadonlyMap<number, string> {
  const problems = new Map<number, string>();
  const seen = new Set<string>();
  vars.forEach((v, i) => {
    if (!v.key && !v.value) return;
    const problem = envKeyProblem(v.key) ?? (seen.has(v.key) ? `${v.key} is already set above` : v.value.length > MAX_ENV_VALUE ? 'That value is too long' : undefined);
    if (problem) problems.set(i, problem);
    seen.add(v.key);
  });
  return problems;
}

const unquote = (raw: string): string => {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  // Unquoted: a trailing " # comment" isn't part of the value.
  return v.replace(/\s+#.*$/, '');
};

/**
 * KEY=value lines (a pasted block, or a .env file): `export` is allowed, quotes are removed,
 * blank lines and # comments are skipped. Lines that aren't KEY=value come back in `skipped`.
 */
export function parseEnvText(text: string): { vars: EnvVar[]; skipped: string[] } {
  const vars = new Map<string, string>();
  const skipped: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = /^(?:export\s+)?([^=\s]+)\s*=(.*)$/.exec(trimmed);
    if (!m?.[1] || envKeyProblem(m[1])) {
      skipped.push(trimmed);
      continue;
    }
    vars.set(m[1], unquote(m[2] ?? ''));
  }
  return { vars: [...vars].map(([key, value]) => ({ key, value })), skipped };
}

/** Rows into a name → value record (later rows win; empty names are dropped). */
export const envRecord = (vars: readonly EnvVar[]): Record<string, string> => Object.fromEntries(vars.filter((v) => v.key).map((v) => [v.key, v.value]));

/** Layers merged in order: each one overrides the ones before it. */
export const mergeEnv = (...layers: ReadonlyArray<Readonly<Record<string, string>> | undefined>): Record<string, string> => Object.assign({}, ...layers.filter(Boolean)) as Record<string, string>;

/** Rows replaced or added by an import (same name: the imported value wins), keeping their order. */
export function importEnv(current: readonly EnvVar[], incoming: readonly EnvVar[]): EnvVar[] {
  const byKey = new Map(incoming.map((v) => [v.key, v.value]));
  const kept = current.filter((v) => v.key || v.value).map((v) => (byKey.has(v.key) ? { key: v.key, value: byKey.get(v.key)! } : v));
  const known = new Set(kept.map((v) => v.key));
  return [...kept, ...incoming.filter((v) => !known.has(v.key))];
}

/** Variable names per place, for screens (values stay in the core; ask it with env.get). */
export interface EnvKeys {
  readonly global: readonly string[];
  /** By project folder. */
  readonly projects: Readonly<Record<string, { readonly keys: readonly string[]; readonly dotenv: boolean }>>;
  /** By worktree id: the names it sets over its project's (BLG-924). */
  readonly worktrees?: Readonly<Record<string, readonly string[]>>;
}

export const NO_ENV_KEYS: EnvKeys = { global: [], projects: {}, worktrees: {} };
