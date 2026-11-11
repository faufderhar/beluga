/**
 * Settings search (BLG-740): find a setting by typing, without knowing its pane. Pure: the index
 * lives in dialogs/settings-index.ts, the field and the jump in dialogs/SettingsSearch.tsx.
 */

export type SettingsPane = 'general' | 'appearance' | 'claude' | 'notifications' | 'workspaces' | 'terminal' | 'fire' | 'menubar' | 'environment' | 'people' | 'phone' | 'external' | 'computers' | 'voice' | 'keyboard' | 'advanced' | 'experimental' | 'about';

/** Find… (⌘F) while Settings is open: runCommand sends it to Settings' search, not the conversation behind. */
export const SETTINGS_FIND_EVENT = 'beluga:settings-find';

/** One setting the search knows: a row (or a whole group) of a pane, with words people may type for it. */
export interface SettingEntry<P extends string = string> {
  readonly pane: P;
  /** The row's label as the pane shows it (or the group's title, when `isGroup`). */
  readonly label: string;
  /** The group it sits in: where the jump lands when the row isn't showing right now. */
  readonly group?: string;
  readonly detail?: string;
  /** Other words for it ("dark mode", "font size"), matched like the label. */
  readonly keywords?: string;
  /** The label is a group's title: there is no row of that name. */
  readonly isGroup?: boolean;
}

export interface PaneInfo<P extends string = string> {
  readonly id: P;
  readonly label: string;
  /** Other words for the pane ("shortcuts" for Keyboard). */
  readonly keywords?: string;
}

/** One result: a setting, or a whole pane (its name matched). */
export interface SettingHit<P extends string = string> {
  readonly key: string;
  readonly pane: P;
  readonly label: string;
  readonly detail?: string;
  /** Null when the hit is the pane itself: it opens at the top. */
  readonly entry: SettingEntry<P> | null;
  readonly score: number;
}

export interface PaneResults<P extends string = string> {
  readonly pane: PaneInfo<P>;
  readonly hits: readonly SettingHit<P>[];
}

/** Lower case, no accents or apostrophes, plain quotes and dashes: "Wi‑Fi" and "isn’t" match what people type. */
export function foldText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['\u2018\u2019\u02bc]/g, '')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

/** The anchor a row or group carries (data-setting) and the search looks for: its label, folded to a slug. */
export function settingAnchor(label: string): string {
  return foldText(label)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const words = (query: string): string[] => foldText(query).split(' ').filter(Boolean);

/** Where a word sits in a text: at the start of it (3), of one of its words (2), inside one (1), or not at all (0). */
function place(text: string, word: string): number {
  const at = text.indexOf(word);
  if (at < 0) return 0;
  if (at === 0) return 3;
  return new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text) ? 2 : 1;
}

/**
 * How well an entry matches, or 0 when it doesn't: every word must be found in its label, keywords,
 * group, detail or pane name, and at least one outside the pane name (typing a pane's name finds
 * the pane, not each of its rows).
 */
export function scoreEntry(entry: SettingEntry, pane: PaneInfo, query: string): number {
  const ws = words(query);
  if (!ws.length) return 0;
  const label = foldText(entry.label);
  const fields = [
    [label, 10],
    [foldText(entry.keywords ?? ''), 7],
    [foldText(entry.group ?? ''), 4],
    [foldText(entry.detail ?? ''), 2],
  ] as const;
  const paneWords = foldText(`${pane.label} ${pane.keywords ?? ''}`);
  let score = 0;
  let outsidePane = false;
  for (const w of ws) {
    let best = 0;
    for (const [text, weight] of fields) best = Math.max(best, place(text, w) * weight);
    if (best) outsidePane = true;
    else if (place(paneWords, w)) best = 1;
    else return 0;
    score += best;
  }
  if (!outsidePane) return 0;
  // The whole phrase in the label, best at its start: "text s" puts Text size first.
  const phrase = foldText(query);
  if (label.startsWith(phrase)) score += 40;
  else if (place(label, phrase) >= 2) score += 25;
  return score;
}

/** How well a pane matches: every word in its name or its other words, best at the start of its name. */
function scorePane(pane: PaneInfo, query: string): number {
  const label = foldText(pane.label);
  const all = `${label} ${foldText(pane.keywords ?? '')}`;
  const ws = words(query);
  if (!ws.length || !ws.every((w) => place(all, w))) return 0;
  const phrase = foldText(query);
  // Its exact name beats a row of the same name elsewhere ("Terminal" the pane, not the toolbar button).
  return label === phrase ? 80 : label.startsWith(phrase) ? 70 : ws.every((w) => place(label, w)) ? 45 : 20;
}

/**
 * The settings that match, grouped by pane: the pane with the best match first (then in sidebar
 * order), the best match first within it. Empty for an empty query.
 */
export function searchSettings<P extends string>(query: string, entries: readonly SettingEntry<P>[], panes: readonly PaneInfo<P>[]): PaneResults<P>[] {
  if (!words(query).length) return [];
  const groups = panes.map((pane, order) => {
    const hits: SettingHit<P>[] = [];
    const paneScore = scorePane(pane, query);
    if (paneScore) hits.push({ key: `pane:${pane.id}`, pane: pane.id, label: pane.label, detail: 'Open the pane', entry: null, score: paneScore });
    entries.forEach((entry, i) => {
      if (entry.pane !== pane.id) return;
      const score = scoreEntry(entry, pane, query);
      if (score) hits.push({ key: `${pane.id}:${i}`, pane: pane.id, label: entry.label, ...(entry.detail ? { detail: entry.detail } : {}), entry, score });
    });
    // Stable: equal scores keep the pane's own order.
    const sorted = hits.map((h, i) => [h, i] as const).sort((a, b) => b[0].score - a[0].score || a[1] - b[1]).map(([h]) => h);
    return { pane, hits: sorted, best: sorted[0]?.score ?? 0, order };
  });
  return groups
    .filter((g) => g.hits.length)
    .sort((a, b) => b.best - a.best || a.order - b.order)
    .map(({ pane, hits }) => ({ pane, hits }));
}

/** The results in the order the list shows them, for ↑/↓. */
export const flatHits = <P extends string>(results: readonly PaneResults<P>[]): SettingHit<P>[] => results.flatMap((r) => r.hits);

/** The anchors to look for once a hit's pane is open, in order: its row, then its group. Empty: the top of the pane. */
export function hitAnchors(hit: SettingHit): { readonly kind: 'row' | 'group'; readonly anchor: string }[] {
  const e = hit.entry;
  if (!e) return [];
  const out: { kind: 'row' | 'group'; anchor: string }[] = [];
  if (!e.isGroup) out.push({ kind: 'row', anchor: settingAnchor(e.label) });
  const group = e.isGroup ? e.label : e.group;
  if (group) out.push({ kind: 'group', anchor: settingAnchor(group) });
  return out;
}
