import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readJson, writeJson } from '../net/mesh/files.js';
import { ENV_KEY, MAX_ENV_VALUE, MAX_ENV_VARS } from '../shared/env-vars.js';
import { Settings } from '../shared/settings-schema.js';

/**
 * Your settings on every computer of yours (BLG-805). Each setting that is yours (not the
 * computer's) carries when it last changed and on which device; your devices swap them with every
 * device-set sync (machines.ts), and the newest wins. A change here is sent at once; a computer
 * that's offline hears it when it's back (the app asks its computers every 30 s, and a computer
 * tries the app again every minute), and what changed there while it was away comes back the
 * same way. The same setting changed on two devices while they were apart keeps the latest, and
 * says so in Settings › Your Computers.
 *
 * Secrets (your own variables in env.json) are a second tier: they travel only with a computer you
 * said Keep My Secrets in Sync for, on the end-to-end link, and never into a log (names and counts
 * only). The ledger keeps a hash of each, never the value.
 *
 * Kept in ~/.beluga/settings-sync.json (0600).
 */

/** Settings that are yours: the same on every computer. */
export const SYNCED_SETTINGS = [
  'theme',
  // How you work, and which experimental features you turned on (a computer then runs them too).
  'pushToPr',
  'experiments',
  'agentThreads',
  'runOn',
  'selfApproval',
  'notify',
  'model',
  'effort',
  'openModels',
  'defaultAgent',
  'projectAgents',
  'autoSetup',
  'branchPrefix',
  'contextMeter',
  'autoCompact',
  'autoCompactAt',
  'autoContinue',
  'chatLimit',
  'chatCategories',
  'settleOnMerge',
  'settleIdleDays',
  'scratchFolder',
  'subagents',
  'hiddenButtons',
  'friendWorktrees',
  'chatClaude',
  'shareUsage',
  'readReceipts',
  'claudeArgs',
  'codexArgs',
  'earningsCurrency',
] as const satisfies ReadonlyArray<keyof Settings>;
export type SyncedSetting = (typeof SYNCED_SETTINGS)[number];

/**
 * Settings that belong to one computer and never sync: its name and icon, its paths and shell,
 * its service and web access (tunnel, mailbox, network), its power and phones, how much it runs
 * at once, and what's kept per conversation or per network identity there.
 */
export const LOCAL_SETTINGS = [
  'name',
  'computerName',
  'computerIcon',
  'mouse',
  'tunnel',
  'keepAwake',
  'lowPower',
  'shell',
  'shellLogin',
  'shellArgs',
  'parallelRuns',
  // How many threads run at once here is this computer's capacity, like parallelRuns.
  'threadLimits',
  'autoContinueOff',
  'autoContinueSkip',
  'autoCompactChosen',
  'policy',
  'people',
  'mainChannel',
  'network',
  'mailbox',
  'mailboxAfterMin',
  'askMeFor',
  'askFreely',
  'capabilities',
] as const satisfies ReadonlyArray<keyof Settings>;

/** What Settings calls each synced setting, for a conflict said in words. */
export const SETTING_LABELS: Readonly<Record<SyncedSetting, string>> = {
  theme: 'Theme',
  pushToPr: 'Keep open pull requests current',
  experiments: 'Experimental features',
  agentThreads: 'Agent threads',
  runOn: 'Run New Work On',
  selfApproval: 'Ask before risky actions',
  notify: 'Notifications',
  model: 'Model',
  effort: 'Effort',
  openModels: 'Models in chat',
  defaultAgent: 'Default agent',
  projectAgents: 'Project agents',
  autoSetup: 'Run setup in new worktrees',
  branchPrefix: 'Branch prefix',
  contextMeter: 'Context meter',
  autoCompact: 'Auto-compact',
  autoCompactAt: 'Auto-compact at',
  autoContinue: 'Continue after the limit',
  chatLimit: 'Open chats',
  chatCategories: 'Chat categories',
  settleOnMerge: 'Settle on merge',
  settleIdleDays: 'Settle after',
  scratchFolder: 'Scratch folder',
  subagents: 'Sub-agents',
  hiddenButtons: 'Hidden buttons',
  friendWorktrees: 'Friends’ worktrees',
  chatClaude: 'Who may call your Claude',
  shareUsage: 'Share your usage',
  readReceipts: 'Say when you’ve seen a message',
  claudeArgs: 'Claude flags',
  codexArgs: 'Codex flags',
  earningsCurrency: 'Earnings currency',
};

const MAX_CONFLICTS = 20;
/** A change is sent this long after it's made, with whatever else changed meanwhile. */
const PUSH_DELAY_MS = 100;
/** Seeded from the app before anything changed: any real change, anywhere, wins over these. */
const SEED_AT = 1;

const at = z.number().int().min(0);
const by = z.string().max(64);
const name = z.string().max(64);

const WireEntry = z.object({ at, by, name, value: z.unknown().optional() });
const WireSecret = z.object({ at, by, name, value: z.string().max(MAX_ENV_VALUE).optional() });

const Side = z.object({ name, at, value: z.string().max(200).optional() });
const Conflict = z.object({ key: z.string().max(200), secret: z.boolean().optional(), at, kept: Side, lost: Side });
type Conflict = z.infer<typeof Conflict>;

/** What a device of yours says of your settings in a sync (machines.ts MachineSync.settings). */
export const SettingsFrame = z.object({
  entries: z.record(z.string().max(40), WireEntry).refine((o) => Object.keys(o).length <= 64, 'Too many settings'),
  /** From your app: keep your secrets in sync with this computer (said on every sync while it's on). */
  secretsOk: z.boolean().optional(),
  secrets: z
    .record(z.string().max(200).regex(ENV_KEY), WireSecret)
    .refine((o) => Object.keys(o).length <= MAX_ENV_VARS * 2, 'Too many secrets')
    .optional(),
  /** From a computer: conflicts it recorded that your app hasn't taken yet (BLG-835; a secret's never with a value). */
  conflicts: z.array(Conflict).max(MAX_CONFLICTS).optional(),
  /** From your app: the newest of this computer's conflicts it has taken (that computer's clock), so it stops sending them. */
  heard: at.optional(),
});
export type SettingsFrame = z.infer<typeof SettingsFrame>;

const Ledger = z.object({
  v: z.literal(1),
  /** The app put its settings in before anything changed. */
  seeded: z.boolean().default(false),
  /** Each synced setting as last seen here (stable JSON), to tell a change made here. */
  base: z.record(z.string(), z.string()).optional(),
  entries: z.record(z.string(), WireEntry).default({}),
  /** Each secret's hash as last seen here. */
  secretBase: z.record(z.string(), z.string()).optional(),
  secrets: z.record(z.string(), z.object({ at, by, name, hash: z.string().max(64).optional() })).default({}),
  /** The devices your secrets sync with: on the app, the computers you said yes for; on a computer, the app that said so. */
  secretsWith: z.array(z.string().max(16)).max(64).default([]),
  /** When each device was last heard from (this computer's clock). */
  seen: z.record(z.string(), z.number()).default({}),
  conflicts: z.array(Conflict).max(MAX_CONFLICTS).default([]),
  /** On a computer: conflicts recorded here that your app hasn't said it took. */
  untold: z.array(Conflict).max(MAX_CONFLICTS).default([]),
  /** On the app: the newest conflict taken from each computer (its clock). */
  heard: z.record(z.string(), z.number()).default({}),
});
type Ledger = z.infer<typeof Ledger>;
type Entry = z.infer<typeof WireEntry>;

/** A conflict as Settings says it: what was kept, from which device, and what was replaced. */
export interface SyncConflictView {
  readonly key: string;
  readonly label: string;
  readonly secret: boolean;
  readonly at: number;
  readonly kept: { readonly name: string; readonly at: number; readonly value?: string };
  readonly lost: { readonly name: string; readonly at: number; readonly value?: string };
}

export interface SettingsSyncView {
  readonly synced: number;
  readonly conflicts: readonly SyncConflictView[];
}

export interface SettingsSecrets {
  /** Your own variables now (env.json `global`). */
  read(): Readonly<Record<string, string>>;
  /** Set one, or with undefined remove it. */
  write(key: string, value: string | undefined): void;
  watch(listener: () => void): () => void;
}

export interface SettingsSyncDeps {
  readonly file: string;
  /** This computer's settings now (the store's prefs). */
  readonly prefs: () => object;
  /** Called whenever they may have changed (the store's subscribe). */
  readonly watch: (listener: () => void) => () => void;
  /** Take settings from another device of yours (session.setPrefs: null is back to the default). */
  readonly apply: (patch: Readonly<Record<string, unknown>>) => void;
  readonly secrets?: SettingsSecrets;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

/** A device of yours on the other end of a sync. */
export interface SyncPeer {
  readonly id: string;
  readonly name: string;
  readonly role: 'app' | 'computer' | 'phone';
}

/** JSON with keys in order, so the same setting always reads the same. */
export function stable(v: unknown): string {
  if (v === undefined) return '';
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

const hashOf = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 32);

/** `a` is newer than `b`: later, or at the same time from the larger device id (every device picks the same). */
const newer = (a: { at: number; by: string }, b: { at: number; by: string } | undefined): boolean => !b || a.at > b.at || (a.at === b.at && a.by > b.by);

/** A setting's value in a few words, for a conflict. */
function shortValue(v: unknown): string | undefined {
  if (v === undefined) return 'the default';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'string' || typeof v === 'number') return String(v).slice(0, 60);
  return undefined;
}

export class SettingsSync {
  private ledger: Ledger;
  private readonly now: () => number;
  private readonly offs: Array<() => void> = [];
  private lastPrefs?: object;
  private timer?: NodeJS.Timeout;
  private self: () => { id: string; name: string } = () => ({ id: 'here', name: 'this computer' });
  private push?: () => void;

  constructor(private readonly deps: SettingsSyncDeps) {
    this.now = deps.now ?? Date.now;
    const parsed = Ledger.safeParse(readJson(deps.file));
    this.ledger = parsed.success ? parsed.data : Ledger.parse({ v: 1 });
    // What's here when sync starts is where changes are told from.
    let fresh = false;
    if (!this.ledger.base) {
      this.ledger = { ...this.ledger, base: this.snapshot() };
      fresh = true;
    }
    if (deps.secrets && !this.ledger.secretBase) {
      this.ledger = { ...this.ledger, secretBase: this.secretSnapshot() };
      fresh = true;
    }
    if (fresh) this.save();
    this.lastPrefs = deps.prefs();
  }

  /** Follow changes made here; `push` sends them to your other devices. */
  start(opts: { self: () => { id: string; name: string }; push: () => void }): void {
    this.self = opts.self;
    this.push = opts.push;
    this.offs.push(this.deps.watch(() => this.noteLocal()));
    if (this.deps.secrets) this.offs.push(this.deps.secrets.watch(() => this.noteSecrets()));
    // What changed while Beluga was off here.
    this.noteLocal(true);
    this.noteSecrets();
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    clearTimeout(this.timer);
    this.push = undefined;
  }

  /** Your secrets sync with this device. */
  secretsOn(id: string): boolean {
    return this.ledger.secretsWith.includes(id);
  }

  /** Keep My Secrets in Sync With a computer (the one ask for it), or stop. */
  setSecretsWith(id: string, on: boolean): void {
    const rest = this.ledger.secretsWith.filter((d) => d !== id);
    this.ledger = { ...this.ledger, secretsWith: on ? [...rest, id] : rest };
    this.save();
    this.schedule();
  }

  /** A device was forgotten: nothing more goes to it. */
  forget(id: string): void {
    if (!this.secretsOn(id) && !(id in this.ledger.seen)) return;
    const { [id]: _gone, ...seen } = this.ledger.seen;
    this.ledger = { ...this.ledger, secretsWith: this.ledger.secretsWith.filter((d) => d !== id), seen };
    this.save();
  }

  view(): SettingsSyncView {
    return {
      synced: Object.keys(this.ledger.entries).length,
      conflicts: [...this.ledger.conflicts].reverse().map((c) => ({ key: c.key, label: c.secret ? c.key : (SETTING_LABELS[c.key as SyncedSetting] ?? c.key), secret: Boolean(c.secret), at: c.at, kept: c.kept, lost: c.lost })),
    };
  }

  clearConflicts(): void {
    if (!this.ledger.conflicts.length) return;
    this.ledger = { ...this.ledger, conflicts: [] };
    this.save();
  }

  /**
   * What this device says to `peer`: every synced setting with when and where it changed, and
   * your secrets when they sync with it. `holder`: this is your app (it seeds its settings the
   * first time, and says whether secrets sync).
   */
  frame(peer: Pick<SyncPeer, 'id'>, holder: boolean): SettingsFrame {
    this.noteLocal();
    this.noteSecrets();
    if (holder && !this.ledger.seeded) this.seed();
    const secrets = this.secretsOn(peer.id) ? this.secretsOut() : undefined;
    // The app says which of a computer's conflicts it has; a computer tells the app the ones it hasn't.
    const told = holder ? { heard: this.ledger.heard[peer.id] ?? 0 } : this.ledger.untold.length ? { conflicts: this.ledger.untold.map(withoutSecret) } : {};
    return { entries: { ...this.ledger.entries }, ...(secrets ? { secrets, ...(holder ? { secretsOk: true } : {}) } : {}), ...told };
  }

  /** Take what `peer` said: newer settings are applied here; returns whether anything changed. */
  merge(peer: SyncPeer, raw: unknown, holder: boolean): boolean {
    const parsed = SettingsFrame.safeParse(raw);
    if (!parsed.success) return false;
    const frame = parsed.data;
    this.noteLocal();
    this.noteSecrets();
    // Your app says whether your secrets sync with this computer, every time.
    if (!holder && peer.role === 'app' && Boolean(frame.secretsOk) !== this.secretsOn(peer.id)) {
      const rest = this.ledger.secretsWith.filter((d) => d !== peer.id);
      this.ledger = { ...this.ledger, secretsWith: frame.secretsOk ? [...rest, peer.id] : rest };
      this.deps.log?.(`settings: ${peer.name} ${frame.secretsOk ? 'keeps your secrets in sync with this computer' : 'stopped syncing your secrets here'}`);
    }
    const since = this.ledger.seen[peer.id] ?? 0;
    const before = this.ledger.conflicts;
    const took = this.mergeSettings(peer, frame.entries, since);
    const secrets = frame.secrets && this.secretsOn(peer.id) ? this.mergeSecrets(peer, frame.secrets, since) : 0;
    this.ledger = { ...this.ledger, seen: { ...this.ledger.seen, [peer.id]: this.now() } };
    this.tellConflicts(peer, frame, before, holder);
    this.save();
    if (took.length) this.deps.log?.(`settings: took ${took.join(', ')} from ${peer.name}`);
    if (secrets) this.deps.log?.(`settings: took ${secrets} secret${secrets === 1 ? '' : 's'} from ${peer.name}`);
    const changed = took.length > 0 || secrets > 0;
    // Your other computers hear it too: the app passes it on.
    if (changed && holder) this.schedule();
    return changed;
  }

  // ---- inside

  private mergeSettings(peer: SyncPeer, entries: Readonly<Record<string, Entry>>, since: number): string[] {
    const patch: Record<string, unknown> = {};
    let next = this.ledger;
    for (const key of SYNCED_SETTINGS) {
      const theirs = entries[key];
      if (!theirs) continue;
      const value = theirs.value === undefined ? undefined : valid(key, theirs.value);
      if (theirs.value !== undefined && value === undefined) continue;
      const ours = next.entries[key];
      const differ = stable(value) !== stable(ours?.value);
      // Both changed it since they last heard of each other: the latest is kept, and that's said.
      if (ours && differ && ours.by !== theirs.by && ours.at > since && theirs.at > since && ours.at > SEED_AT && theirs.at > SEED_AT) {
        const win = newer(theirs, ours) ? theirs : ours;
        const lose = win === theirs ? ours : theirs;
        next = { ...next, conflicts: this.withConflict(next.conflicts, { key, at: this.now(), kept: sideOf(win), lost: sideOf(lose) }) };
      }
      if (!newer(theirs, ours)) continue;
      const entry: Entry = { at: theirs.at, by: theirs.by, name: theirs.name, ...(value !== undefined ? { value } : {}) };
      next = { ...next, entries: { ...next.entries, [key]: entry } };
      const here = (this.deps.prefs() as Record<string, unknown>)[key];
      if (stable(here) === stable(value)) continue;
      // Remembered as seen before it's applied, so it isn't taken for a change made here.
      next = { ...next, base: { ...next.base, [key]: stable(value) } };
      patch[key] = value === undefined ? null : value;
    }
    this.ledger = next;
    const keys = Object.keys(patch);
    if (keys.length) {
      this.deps.apply(patch);
      this.lastPrefs = this.deps.prefs();
    }
    return keys;
  }

  private mergeSecrets(peer: SyncPeer, incoming: NonNullable<SettingsFrame['secrets']>, since: number): number {
    const secrets = this.deps.secrets;
    if (!secrets) return 0;
    let next = this.ledger;
    const writes: Array<[string, string | undefined]> = [];
    for (const [key, theirs] of Object.entries(incoming)) {
      const ours = next.secrets[key];
      const hash = theirs.value === undefined ? undefined : hashOf(theirs.value);
      if (ours && hash !== ours.hash && ours.by !== theirs.by && ours.at > since && theirs.at > since && ours.at > SEED_AT && theirs.at > SEED_AT) {
        const win = newer(theirs, ours) ? theirs : ours;
        const lose = win === theirs ? ours : theirs;
        // Never a value: which device's was kept, and when.
        next = { ...next, conflicts: this.withConflict(next.conflicts, { key, secret: true, at: this.now(), kept: { name: win.name, at: win.at }, lost: { name: lose.name, at: lose.at } }) };
      }
      if (!newer(theirs, ours)) continue;
      next = { ...next, secrets: { ...next.secrets, [key]: { at: theirs.at, by: theirs.by, name: theirs.name, ...(hash ? { hash } : {}) } } };
      if (next.secretBase?.[key] === hash) continue;
      const base = { ...next.secretBase };
      if (hash) base[key] = hash;
      else delete base[key];
      next = { ...next, secretBase: base };
      writes.push([key, theirs.value]);
    }
    this.ledger = next;
    for (const [key, value] of writes) {
      try {
        secrets.write(key, value);
      } catch (err) {
        this.deps.log?.(`settings: couldn't keep the secret ${key} from ${peer.name}: ${err instanceof Error ? err.message : 'refused'}`);
      }
    }
    return writes.length;
  }

  /**
   * Conflicts reach your app whichever side saw them (BLG-835): a computer keeps the ones it
   * recorded until the app says it has them; the app takes a computer's into its own list.
   */
  private tellConflicts(peer: SyncPeer, frame: SettingsFrame, before: Ledger['conflicts'], holder: boolean): void {
    if (holder) {
      const theirs = peer.role === 'computer' ? (frame.conflicts ?? []) : [];
      if (!theirs.length) return;
      let conflicts = this.ledger.conflicts;
      for (const c of theirs) conflicts = this.withConflict(conflicts, withoutSecret(c));
      const heard = Math.max(this.ledger.heard[peer.id] ?? 0, ...theirs.map((c) => c.at));
      this.ledger = { ...this.ledger, conflicts, heard: { ...this.ledger.heard, [peer.id]: heard } };
      return;
    }
    const fresh = this.ledger.conflicts.filter((c) => !before.includes(c));
    let untold = frame.heard === undefined ? this.ledger.untold : this.ledger.untold.filter((c) => c.at > frame.heard!);
    for (const c of fresh) untold = this.withConflict(untold, c);
    if (untold !== this.ledger.untold) this.ledger = { ...this.ledger, untold };
  }

  private withConflict(list: Ledger['conflicts'], c: Ledger['conflicts'][number]): Ledger['conflicts'] {
    const same = (o: Ledger['conflicts'][number]): boolean => o.key === c.key && o.kept.at === c.kept.at && o.lost.at === c.lost.at;
    if (list.some(same)) return list;
    return [...list, c].slice(-MAX_CONFLICTS);
  }

  /** Settings changed here since they were last seen: each is stamped now, by this device, and sent. */
  private noteLocal(force = false): void {
    const prefs = this.deps.prefs();
    if (!force && prefs === this.lastPrefs) return;
    this.lastPrefs = prefs;
    const values = prefs as Record<string, unknown>;
    const base = this.ledger.base ?? {};
    const self = this.self();
    let next = this.ledger;
    for (const key of SYNCED_SETTINGS) {
      const now = stable(values[key]);
      if (now === base[key]) continue;
      const value = values[key];
      next = { ...next, base: { ...next.base, [key]: now }, entries: { ...next.entries, [key]: { at: Math.max(this.now(), (next.entries[key]?.at ?? 0) + 1), by: self.id, name: self.name, ...(value !== undefined ? { value } : {}) } } };
    }
    if (next === this.ledger) return;
    this.ledger = next;
    this.save();
    this.schedule();
  }

  private noteSecrets(): void {
    const secrets = this.deps.secrets;
    if (!secrets) return;
    const now = this.secretSnapshot();
    const base = this.ledger.secretBase ?? {};
    const self = this.self();
    let next = this.ledger;
    const stamp = (key: string, hash: string | undefined): void => {
      const s = { ...next.secretBase };
      if (hash) s[key] = hash;
      else delete s[key];
      next = { ...next, secretBase: s, secrets: { ...next.secrets, [key]: { at: Math.max(this.now(), (next.secrets[key]?.at ?? 0) + 1), by: self.id, name: self.name, ...(hash ? { hash } : {}) } } };
    };
    for (const [key, hash] of Object.entries(now)) if (base[key] !== hash) stamp(key, hash);
    for (const key of Object.keys(base)) if (!(key in now)) stamp(key, undefined);
    if (next === this.ledger) return;
    this.ledger = next;
    this.save();
    if (this.ledger.secretsWith.length) this.schedule();
  }

  /** The app's settings as they are, before anything changed: what a computer joining takes. */
  private seed(): void {
    const values = this.deps.prefs() as Record<string, unknown>;
    const self = this.self();
    const entries = { ...this.ledger.entries };
    for (const key of SYNCED_SETTINGS) if (!entries[key] && values[key] !== undefined) entries[key] = { at: SEED_AT, by: self.id, name: self.name, value: values[key] };
    const secrets = { ...this.ledger.secrets };
    for (const [key, hash] of Object.entries(this.ledger.secretBase ?? {})) secrets[key] ??= { at: SEED_AT, by: self.id, name: self.name, hash };
    this.ledger = { ...this.ledger, seeded: true, entries, secrets };
    this.save();
  }

  /** The secrets to send: each with its stamp, and its value as it is here now (none: removed). */
  private secretsOut(): NonNullable<SettingsFrame['secrets']> {
    const values = this.deps.secrets?.read() ?? {};
    return Object.fromEntries(
      Object.entries(this.ledger.secrets)
        .filter(([key]) => ENV_KEY.test(key))
        .map(([key, s]) => {
          const value = s.hash ? values[key] : undefined;
          return [key, { at: s.at, by: s.by, name: s.name, ...(value !== undefined && value.length <= MAX_ENV_VALUE ? { value } : {}) }];
        }),
    );
  }

  private snapshot(): Record<string, string> {
    const values = this.deps.prefs() as Record<string, unknown>;
    return Object.fromEntries(SYNCED_SETTINGS.map((k) => [k, stable(values[k])]));
  }

  private secretSnapshot(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.deps.secrets?.read() ?? {}).map(([k, v]) => [k, hashOf(v)]));
  }

  private schedule(): void {
    if (!this.push || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.push?.();
    }, PUSH_DELAY_MS);
    this.timer.unref?.();
  }

  private save(): void {
    writeJson(this.deps.file, this.ledger);
  }
}

/** A setting's value from another device, as this Beluga reads it (undefined: not one it takes). */
function valid(key: SyncedSetting, value: unknown): unknown {
  const parsed = Settings.shape[key].safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** A conflict as it may travel: a secret's never carries a value. */
const withoutSecret = (c: Conflict): Conflict => (c.secret ? { ...c, kept: { name: c.kept.name, at: c.kept.at }, lost: { name: c.lost.name, at: c.lost.at } } : c);

const sideOf = (e: Entry): z.infer<typeof Side> => {
  const value = shortValue(e.value);
  return { name: e.name, at: e.at, ...(value !== undefined ? { value } : {}) };
};
