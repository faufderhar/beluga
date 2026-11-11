import { readFileSync } from 'node:fs';
import { THREAD_LIMIT_ROWS } from '../src/shared/threads.js';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PANES, SETTINGS } from '../packages/mac/src/dialogs/settings-index.js';
import { HIDEABLE_BUTTONS } from '../src/ui/settings-menus.js';
import { EXPERIMENTS, EXPERIMENT_INFO } from '../src/shared/experiments.js';
import { flatHits, foldText, hitAnchors, searchSettings, settingAnchor } from '../packages/mac/src/lib/settings-search.js';

/** Settings search (BLG-740): find a setting by typing, and jump to its row. */

const search = (q: string) => searchSettings(q, SETTINGS, PANES);
const top = (q: string) => flatHits(search(q))[0];
const paneLabel = (id: string) => PANES.find((p) => p.id === id)!.label;

describe('matching', () => {
  it('folds case, accents, curly quotes and odd dashes', () => {
    expect(foldText('  Only when Beluga ISN’T  in front ')).toBe('only when beluga isnt in front');
    expect(foldText('Over Wi‑Fi')).toBe('over wi-fi');
    expect(foldText('Café')).toBe('cafe');
  });

  it('makes anchors from labels', () => {
    expect(settingAnchor('Text size')).toBe('text-size');
    expect(settingAnchor('The terminal’s keys come first')).toBe('the-terminals-keys-come-first');
    expect(settingAnchor('Read .env files without asking')).toBe('read-env-files-without-asking');
  });

  it('finds nothing for an empty query or nonsense', () => {
    expect(search('')).toEqual([]);
    expect(search('   ')).toEqual([]);
    expect(search('zzqx')).toEqual([]);
  });

  it('finds the settings the issue names, best first', () => {
    expect(top('Text size')).toMatchObject({ pane: 'appearance', label: 'Text size' });
    expect(top('text s')).toMatchObject({ pane: 'appearance', label: 'Text size' });
    expect(top('scratch tab')).toMatchObject({ pane: 'claude', label: 'Show the Scratch tab' });
    expect(top('tunnel')).toMatchObject({ pane: 'people', label: 'How friends reach you' });
  });

  it('is case-insensitive and matches words in any order', () => {
    expect(top('TEXT SIZE')).toMatchObject({ label: 'Text size' });
    expect(top('size text')).toMatchObject({ pane: 'appearance', label: 'Text size' });
  });

  it('matches details and other words people use', () => {
    expect(top('dark mode')).toMatchObject({ pane: 'appearance', label: 'Appearance' });
    expect(top('font size')).toMatchObject({ pane: 'appearance', label: 'Text size' });
    expect(top('dnd')).toMatchObject({ pane: 'notifications', label: 'Do Not Disturb' });
    expect(top('isnt in front')).toMatchObject({ label: 'Only when Beluga isn’t in front' });
    expect(top("isn't in front")).toMatchObject({ label: 'Only when Beluga isn’t in front' });
    expect(top('wifi')).toMatchObject({ pane: 'phone', label: 'Over Wi‑Fi' });
    // A word only in the detail still finds it.
    expect(flatHits(search('beside the send button')).map((h) => h.label)).toContain('Context meter');
  });

  it('finds a pane by its name, opening at its top', () => {
    const hit = top('terminal');
    expect(hit).toMatchObject({ pane: 'terminal', label: 'Terminal', entry: null });
    expect(hitAnchors(hit!)).toEqual([]);
    expect(top('shortcuts')).toMatchObject({ pane: 'keyboard', entry: null });
  });

  it('needs a word outside the pane name for a row: the pane name narrows', () => {
    const hits = flatHits(search('terminal font'));
    expect(hits[0]).toMatchObject({ pane: 'terminal', label: 'Font' });
    // "voice" alone is the Voice pane, not each of its rows.
    expect(search('voice').find((g) => g.pane.id === 'voice')!.hits.map((h) => h.entry)).toEqual([null]);
  });

  it('groups results by pane, the pane with the best match first', () => {
    const groups = search('size');
    // The terminal's "Size" is the closer match than Appearance's "Text size".
    expect(groups.map((g) => g.pane.id).slice(0, 2)).toEqual(['terminal', 'appearance']);
    expect(groups[1]!.hits[0]).toMatchObject({ label: 'Text size' });
    for (const g of groups) expect(new Set(g.hits.map((h) => h.pane))).toEqual(new Set([g.pane.id]));
  });

  it('jumps to the row, then its group', () => {
    expect(hitAnchors(top('text size')!)).toEqual([
      { kind: 'row', anchor: 'text-size' },
      { kind: 'group', anchor: 'layout' },
    ]);
    expect(hitAnchors(top('launch flags')!)).toEqual([{ kind: 'group', anchor: 'launch-flags' }]);
  });
});

describe('the sidebar categories', () => {
  it('finds each setting by its label, and by other words people use', () => {
    for (const label of ['Sidebar categories', 'Settle when a pull request merges', 'Settle idle chats']) {
      expect(top(label)).toMatchObject({ pane: 'appearance', label, entry: { group: 'Layout' } });
    }
    expect(top('inbox snooze')).toMatchObject({ label: 'Sidebar categories' });
    expect(top('auto settle merge')).toMatchObject({ label: 'Settle when a pull request merges' });
    expect(top('auto settle inactive')).toMatchObject({ label: 'Settle idle chats' });
  });

  it('says that a settle row needs Sidebar categories, and falls back to its group while hidden', () => {
    for (const label of ['Settle when a pull request merges', 'Settle idle chats']) {
      const hit = top(label)!;
      expect(hit.entry?.detail).toContain('Sidebar categories');
      expect(hitAnchors(hit).at(-1)).toEqual({ kind: 'group', anchor: 'layout' });
    }
  });
});

describe('every static setting', () => {
  it('is found by its label, and by its first half', () => {
    for (const e of SETTINGS) {
      const whole = flatHits(search(e.label));
      expect(whole.some((h) => h.entry === e), `"${e.label}" (${e.pane})`).toBe(true);
      const part = e.label.slice(0, Math.max(3, Math.ceil(e.label.length / 2)));
      expect(flatHits(search(part)).some((h) => h.entry === e), `"${part}" for "${e.label}"`).toBe(true);
    }
  });

  it('has a pane Settings shows', () => {
    const ids = new Set(PANES.map((p) => p.id));
    for (const e of SETTINGS) expect(ids.has(e.pane), e.label).toBe(true);
    expect(paneLabel('appearance')).toBe('Appearance');
  });
});

// The index is kept by hand: it must follow the panes. Each pane's source (a whole file, or one
// function of Settings.tsx) is read; every literal Row label and Group title in it must be
// indexed, and every indexed label must still be in it.
const MAC = path.join(__dirname, '../packages/mac/src');
const read = (file: string): string => readFileSync(path.join(MAC, file), 'utf8');
const SETTINGS_TSX = read('dialogs/Settings.tsx');

/** One top-level function of a file: from its declaration to the next top-level declaration. */
function fn(src: string, name: string): string {
  const start = src.search(new RegExp(`^(export )?function ${name}\\(`, 'm'));
  if (start < 0) throw new Error(`no function ${name}`);
  const rest = src.slice(start + 1);
  const end = rest.search(/^(export )?(async )?(function|const|type|interface) /m);
  return end < 0 ? src.slice(start) : src.slice(start, start + 1 + end);
}

const s = (...names: string[]) => names.map((n) => fn(SETTINGS_TSX, n)).join('\n');
const PANE_SOURCES: Record<string, string> = {
  general: [s('General', 'PictureRow'), fn(read('dialogs/UpdateSettings.tsx'), 'UpdateSettingsGroup'), read('dialogs/EarningsSettings.tsx')].join('\n'),
  appearance: [s('Appearance'), read('dialogs/ThemePicker.tsx')].join('\n'),
  claude: [s('AgentPane', 'OpenModelsGroup', 'AgentsGroup'), ...['LaunchFlagsSettings', 'McpSettings', 'LocalModelsSettings', 'ContextSettings', 'UsageLimitSettings', 'ParallelSettings', 'ChatLimitSettings'].map((f) => read(`dialogs/${f}.tsx`)), fn(read('dialogs/AgentThreadsSettings.tsx'), 'ThreadLimitsSettings'), ...THREAD_LIMIT_ROWS.map(({ label }) => `'${label}'`)].join('\n'),
  notifications: ['dialogs/NotificationSettings.tsx', 'dialogs/sound/SoundSettings.tsx', 'dialogs/sound/TestNotification.tsx'].map(read).join('\n'),
  // Its toolbar buttons' rows are made from HIDEABLE_BUTTONS, and so are their entries.
  workspaces: [s('Workspaces', 'HiddenProjectsGroup', 'BranchPrefixRow'), ...HIDEABLE_BUTTONS.map(([, label]) => `'${label}'`)].join('\n'),
  terminal: ['dialogs/TerminalSettings.tsx', 'dialogs/TerminalThemes.tsx', 'dialogs/TerminalImport.tsx'].map(read).join('\n'),
  fire: read('dialogs/FireSettings.tsx'),
  menubar: read('dialogs/MenuBarSettings.tsx'),
  environment: read('dialogs/EnvironmentSettings.tsx'),
  people: [s('People'), read('network/NetworkSettings.tsx'), read('gateway/AccessSettings.tsx')].join('\n'),
  phone: read('phone/Phone.tsx'),
  external: read('dialogs/ExternalAgentsSettings.tsx'),
  computers: read('dialogs/MachinesSettings.tsx'),
  voice: read('dialogs/VoiceSettings.tsx'),
  keyboard: read('dialogs/KeyboardSettings.tsx'),
  advanced: [read('dialogs/WebAccessSettings.tsx'), fn(read('dialogs/AgentThreadsSettings.tsx'), 'AgentThreadsSettings')].join('\n'),
  // Its rows are made from shared/experiments.ts, and so are their entries.
  experimental: [read('dialogs/ExperimentalSettings.tsx'), ...EXPERIMENTS.map((id) => `'${EXPERIMENT_INFO[id].title}'`)].join('\n'),
  about: [s('About'), fn(read('dialogs/UpdateSettings.tsx'), 'UpdateAboutRow'), read('dialogs/ReportProblemRow.tsx')].join('\n'),
};

/** Literal labels the search leaves out: placeholders, not settings. */
const NOT_SETTINGS = new Set(['None', 'Nothing yet']);

/** The literal `<Row label="…">` labels and `<Group title="…">` titles of a source. */
function literals(src: string): { rows: string[]; groups: string[] } {
  const rows: string[] = [];
  const groups: string[] = [];
  const attr = String.raw`(?:\s+[a-zA-Z]+=(?:"[^"]*"|\{(?:[^{}]|\{[^{}]*\})*\}))*?`;
  for (const m of src.matchAll(new RegExp(String.raw`<(Row|Group)\b${attr}\s+(?:label|title)="([^"]*)"`, 'g'))) (m[1] === 'Row' ? rows : groups).push(m[2]!);
  return { rows, groups };
}

describe('the index follows the panes', () => {
  it('lists every pane', () => {
    expect(Object.keys(PANE_SOURCES).sort()).toEqual(PANES.map((p) => p.id).sort());
  });

  for (const pane of PANES) {
    const src = PANE_SOURCES[pane.id]!;
    const mine = SETTINGS.filter((e) => e.pane === pane.id);
    const labels = new Set(mine.map((e) => e.label));
    const groups = new Set(mine.flatMap((e) => (e.isGroup ? [e.label] : e.group ? [e.group] : [])));

    it(`${pane.label}: every row and group in the pane is indexed`, () => {
      const found = literals(src);
      const missing = [
        ...found.rows.filter((l) => !labels.has(l) && !groups.has(l) && !NOT_SETTINGS.has(l)).map((l) => `row "${l}"`),
        ...found.groups.filter((g) => !groups.has(g)).map((g) => `group "${g}"`),
      ];
      expect(missing, `add these to SETTINGS in dialogs/settings-index.ts (pane ${pane.id})`).toEqual([]);
    });

    it(`${pane.label}: every indexed label is still in the pane`, () => {
      const quoted = (t: string) => src.includes(`"${t}"`) || src.includes(`'${t}'`);
      const gone = [...[...labels].filter((l) => !quoted(l)), ...[...groups].filter((g) => !quoted(g))];
      expect(gone, `renamed or removed: update dialogs/settings-index.ts (pane ${pane.id})`).toEqual([]);
    });
  }
});
