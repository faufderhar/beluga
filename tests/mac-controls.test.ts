import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS } from '../packages/mac/src/lib/prefs.js';

/**
 * The Mac app's controls are drawn from one set of tokens (styles/tokens.css, "Controls"), named
 * after AppKit's semantic colours. These hold the set together: every control token a stylesheet
 * uses exists, each is made from the theme's tokens (so every theme and accent carries through),
 * and the shared controls take their colours from it rather than their own.
 */

const src = path.join('packages', 'mac', 'src');
const read = (...parts: string[]): string => readFileSync(path.join(src, ...parts), 'utf8');
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
const CONTROL = /--(?:control[\w-]*|text-bg|on-accent|focus-ring|segment-[\w-]+)\b/g;

const tokens = strip(read('styles', 'tokens.css'));
/** The rule for `selector` that declares `first` (tokens.css has several `:root` rules). */
const block = (selector: string, first = ''): string => {
  const rules = tokens.split(`${selector} {`).slice(1).map((rest) => rest.slice(0, rest.indexOf('}')));
  const rule = rules.find((body) => !first || new RegExp(`^\\s*${first}:`, 'm').test(body));
  expect(rule, `${selector} with ${first}`).toBeDefined();
  return rule!;
};
const defined = new Set([...tokens.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!));

const SHEETS = [
  ['components', 'ui.module.css'],
  ['components', 'alert.module.css'],
  ['components', 'form.module.css'],
  ['components', 'select.module.css'],
  ['dialogs', 'settings.module.css'],
] as const;

describe('the control tokens', () => {
  it('are defined for light, and dark changes only the surfaces', () => {
    const base = block(':root', '--control-h');
    for (const name of ['--control', '--control-hover', '--control-press', '--control-accent-hover', '--control-edge', '--control-bezel', '--control-accent', '--on-accent', '--text-bg', '--segment-track', '--segment-on', '--focus-ring']) expect(base).toContain(`${name}:`);
    const dark = block(":root[data-theme='dark']", '--control');
    expect(dark).not.toMatch(/--control-h(?:-small|-large)?:/);
    expect(dark).not.toContain('--focus-ring');
  });

  it('are made from the theme’s tokens, never a colour of their own', () => {
    const lines = tokens.split('\n').filter((l) => /^\s*--(?:control|text-bg|on-accent|focus-ring|segment-)/.test(l));
    expect(lines.length).toBeGreaterThan(20);
    for (const line of lines) expect(line).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|\b(?:white|black)\b/i);
  });

  it('come in the three sizes of docs/mac-controls.md, each one height, text and corner', () => {
    const base = block(':root', '--control-h-large');
    const px = (name: string): number => Number(new RegExp(`${name}:\\s*(\\d+)px`).exec(base)?.[1]);
    expect([px('--control-h-small'), px('--control-h'), px('--control-h-large')]).toEqual([20, 22, 28]);
    expect([px('--control-text-small'), px('--control-text'), px('--control-text-large')]).toEqual([12, 13, 13]);
    expect([px('--control-radius-small'), px('--control-radius'), px('--control-radius-large')]).toEqual([4, 5, 6]);
    // No text under 12px (Chinese doesn't read there), so no mini size.
    expect(tokens).not.toContain('--control-h-mini');
    const doc = readFileSync(path.join('docs', 'mac-controls.md'), 'utf8');
    for (const row of ['| **Large** | 28px | 13px | 6px', '| **Regular** (default) | 22px | 13px | 5px', '| **Small** | 20px | 12px | 4px']) expect(doc).toContain(row);
  });

  it('give each size a class to the shared controls that take one', () => {
    const ui = read('components', 'ui.module.css');
    for (const sel of ['.small', '.large', '.segmentedSmall .segment', '.segmentedLarge .segment']) expect(ui).toContain(`\n${sel} {`);
    const select = read('components', 'select.module.css');
    for (const sel of ['.small', '.large']) expect(select).toContain(`\n${sel} {`);
    expect(read('components', 'ui.tsx')).toContain("export type ControlSize = 'small' | 'regular' | 'large';");
  });

  it('draw Simplified Chinese in its own face', () => {
    const zh = block(':root:lang(zh-CN)');
    expect(zh.indexOf("'PingFang SC'")).toBeGreaterThan(0);
    expect(zh.indexOf("'PingFang SC'")).toBeLessThan(zh.indexOf('system-ui'));
  });

  it('size the title row Large and the panels Small, every control of a row one height', () => {
    const iconButtons = (file: string): string[] => [...read(...file.split('/')).matchAll(/<IconButton\b[^>]*/g)].map((m) => m[0]);
    for (const file of ['layout/Toolbar.tsx']) for (const tag of iconButtons(file)) expect(tag, file).toContain('size="large"');
    for (const file of ['layout/panel/ChangesTab.tsx', 'layout/panel/FilesTab.tsx', 'layout/panel/ScratchTab.tsx', 'layout/panel/TerminalPane.tsx']) for (const tag of iconButtons(file)) expect(tag, file).toContain('size="small"');
    expect(read('layout', 'BranchControl.tsx').match(/<Button size="large"/g)).toHaveLength(2);
    const branch = strip(read('layout', 'BranchControl.module.css'));
    for (const sel of ['main', 'more']) expect(branch).toMatch(new RegExp(`\\n\\.${sel} \\{[^}]*height: var\\(--control-h-large\\)`));
    expect(branch).not.toMatch(/\.more\s*\{[^}]*box-shadow/);
    expect(strip(read('layout', 'SidebarSearch.module.css'))).toContain('height: var(--control-h-large)');
    // The panel's and the center's tabs are Dockview's strips (styles/dock.css): editor tabs, not a
    // segmented control, one height for every strip's (the tabs and the strip they stand in).
    const dock = strip(read('styles', 'dock.css'));
    expect(dock).toMatch(/--tab-h: \d+px/);
    expect(dock).toContain('--dv-tabs-and-actions-container-height: var(--tab-h)');
    expect(dock).toMatch(/\.dv-tab \{[^}]*height: var\(--tab-h\)/);
    expect(dock).toMatch(/\.dv-tab \{[^}]*font-size: var\(--control-text\)/);
    expect(dock).not.toMatch(/\.dv-tab[^{]*\{[^}]*height:\s*\d+px/);
  });

  it('give sheets Regular fields and buttons (step 3)', () => {
    const sheets = ['dialogs/native/sharing.module.css', 'dialogs/env-settings.module.css', 'dialogs/add-project.module.css'];
    for (const file of sheets) {
      const css = strip(read(...file.split('/')));
      expect(css, file).toContain('height: var(--control-h)');
      expect(css, file).not.toMatch(/\n\.(?:input|key|filter|path|nameInput|search)\b[^{]*\{[^}]*height:\s*\d+px/);
    }
    // A sheet's or a popover's bottom buttons, and a button beside a field, are Regular.
    for (const [file, tag] of [
      ['dialogs/native/MergeReview.tsx', '<Button variant="merge" icon="merge"'],
      ['dialogs/native/WorkConfirm.tsx', '<Button ref={start} variant="primary"'],
      ['dialogs/AddProjectSheet.tsx', '<Button type="submit"'],
      ['dialogs/EnvironmentSettings.tsx', '<Button icon={result'],
    ] as const) expect(read(...file.split('/')), file).toContain(tag);
  });

  it('give lists, cards and the conversation Small controls (step 4)', () => {
    const bar = strip(read('views', 'overview', 'filter-bar.module.css'));
    for (const sel of ['popup', 'field']) expect(bar).toMatch(new RegExp(`\\n\\.${sel} \\{[^}]*height: var\\(--control-h-small\\)`));
    expect(bar).toMatch(/\n\.segment \{[^}]*height: calc\(var\(--control-h-small\) - 2px\)/);
    // A small icon button keeps its square in a tight row.
    expect(strip(read('components', 'ui.module.css'))).toMatch(/\.iconSmall \{\s*flex: none;/);
    for (const file of ['chat/Attention.tsx', 'tasks/TaskPage.tsx', 'sentinel/SentinelCards.tsx', 'views/Overview.tsx']) {
      const tags = [...read(...file.split('/')).matchAll(/<(?:Button|IconButton)\b[^>]*/g)].map((m) => m[0]);
      expect(tags.length, file).toBeGreaterThan(0);
      for (const tag of tags) expect(tag, file).toMatch(/\bsize="(?:small|large)"/);
    }
  });

  it('lose the accent while the window isn’t key', () => {
    expect(block(":root[data-window='idle']")).toContain('--control-accent:');
  });

  it('cover every control token the stylesheets use', () => {
    for (const parts of SHEETS) {
      const used = [...strip(read(...parts)).matchAll(CONTROL)].map((m) => m[0]);
      expect(used.length, parts.join('/')).toBeGreaterThan(0);
      expect(used.filter((name) => !defined.has(name)), parts.join('/')).toEqual([]);
    }
  });

  it('draw the bezels, faces and focus rings of the shared controls', () => {
    const rule = (css: string, selector: string): string => {
      const body = strip(css);
      const at = body.indexOf(`\n${selector} {`);
      expect(at, selector).toBeGreaterThanOrEqual(0);
      return body.slice(at, body.indexOf('}', at));
    };
    const ui = read('components', 'ui.module.css');
    expect(rule(ui, '.plain')).toContain('var(--control-bezel)');
    expect(rule(ui, '.primary')).toContain('var(--control-accent)');
    expect(rule(ui, '.segmentOn')).toContain('var(--segment-on)');
    expect(rule(ui, '.button:focus-visible')).toContain('var(--focus-ring)');
    const alert = read('components', 'alert.module.css');
    expect(rule(alert, '.button')).toContain('var(--control-h)');
    expect(rule(alert, '.default')).toContain('var(--control-accent)');
    expect(rule(alert, '.box:checked')).toContain('var(--control-accent)');
    expect(rule(read('components', 'form.module.css'), '.input')).toContain('var(--text-bg)');
    const select = read('components', 'select.module.css');
    expect(rule(select, '.trigger')).toContain('var(--control-bezel)');
    expect(rule(select, '.chevrons')).toContain('var(--control-accent)');
  });

  it('draw a default, primary or Merge button that can’t be pressed as a plain one, never a faded colour', () => {
    // AppKit's disabled default button: its colour goes and its words dim. Faded, the accent left
    // white words on pale blue that couldn't be read (a sheet's Save, a page's Send).
    const block = (css: string, head: string): string => {
      const body = strip(css);
      const at = body.indexOf(head);
      expect(at, head).toBeGreaterThanOrEqual(0);
      return body.slice(at, body.indexOf('}', at));
    };
    const ui = block(read('components', 'ui.module.css'), '.primary:disabled,\n.merge:disabled {');
    expect(ui).toContain('color: var(--text)');
    expect(ui).toContain('var(--control-bezel)');
    expect(ui).not.toMatch(/accent|merge\)/);
    const alert = block(read('components', 'alert.module.css'), '.default:disabled,\n.destructive:disabled {');
    expect(alert).toContain('color: var(--text)');
    expect(alert).toContain('var(--sheet-button)');
    // A sheet's buttons are filled, as macOS 26 draws them on a sheet: a white one on a white sheet hardly shows.
    expect(block(read('components', 'alert.module.css'), '\n.button {')).toContain('background: var(--sheet-button)');
  });
});

describe('Liquid Glass', () => {
  // Liquid Glass: only with the macOS style (Settings › Appearance › Style) on a Mac whose window blurs.
  const GATE = ":root[data-os='mac'][data-transparency='full'][data-look='macos']";
  const SHEETS_WITH_GLASS = [
    ['layout', 'Shell.module.css'],
    ['layout', 'Sidebar.module.css'],
    ['layout', 'SidebarSearch.module.css'],
    ['layout', 'panel', 'panel.module.css'],
    ['views', 'overview', 'filter-bar.module.css'],
    ['components', 'ui.module.css'],
    ['components', 'form.module.css'],
    ['components', 'select.module.css'],
    ['components', 'alert.module.css'],
    ['tasks', 'NewTaskSheet.module.css'],
  ] as const;

  it('makes controls capsules and the panes glass only with the macOS style (Settings › Appearance), never by default', () => {
    expect(DEFAULT_PREFS.look).toBe('beluga');
    // The style is put on the page (lib/prefs.ts apply) for the styles to follow.
    expect(read('lib', 'prefs.ts')).toContain('root.dataset.look = p.look;');
    expect(block(':root', '--control-h')).not.toContain('999px');
    const round = block(":root[data-look='macos']", '--control-radius-large');
    for (const name of ['--control-radius-large', '--control-radius', '--control-radius-small']) expect(round).toMatch(new RegExp(`${name}: 999px;`));
    // The glass window keeps the shape you chose: it sets no corner of its own.
    const glass = block(GATE, '--glass-inset');
    expect(glass).not.toContain('--control-radius');
    for (const name of ['--glass-inset', '--glass-radius', '--glass-fill', '--glass-edge', '--glass-rim', '--glass-drop', '--glass-chip', '--glass-ring']) expect(glass).toContain(`${name}:`);
    expect(block(`${GATE}[data-theme='dark']`, '--glass-edge')).toContain('--glass-drop:');
    // A capsule's ring is a border: the bezel keeps no 0.5px spread shadow where the controls are capsules.
    expect(glass).toMatch(/--control-bezel: var\(--control-drop\), var\(--control-sheen\);/);
  });

  it('makes a track a capsule when the controls in it are (New Task’s priority scale)', () => {
    const css = strip(read('tasks', 'NewTaskSheet.module.css'));
    expect(css).toMatch(/\.step \{[^}]*border-radius: var\(--control-radius\)/);
    const scale = css.split('}').find((r) => r.includes(`:global(${GATE}) .scale {`));
    expect(scale).toContain('border-radius: calc(var(--control-radius) + 2px);');
    // The chosen step sits in the middle: its shadow has no drop below that would fill the gap under it.
    const on = [strip(read('tasks', 'NewTaskSheet.module.css')), strip(read('components', 'ui.module.css'))]
      .flatMap((c) => c.split('}'))
      .filter((r) => r.includes(`:global(${GATE}) .stepOn {`) || r.includes(`:global(${GATE}) .segmentOn {`));
    expect(on).toHaveLength(2);
    for (const rule of on) expect(rule).toMatch(/box-shadow: 0 0 /);
  });

  it('draws a capsule’s ring as a real border, never a 0.5px shadow WebKit breaks up', () => {
    for (const parts of [['components', 'ui.module.css'], ['components', 'alert.module.css'], ['components', 'form.module.css'], ['layout', 'SidebarSearch.module.css'], ['views', 'overview', 'filter-bar.module.css'], ['tasks', 'NewTaskSheet.module.css']] as const) {
      const gated = strip(read(...parts)).split('}').filter((r) => r.slice(0, r.indexOf('{')).includes(`:global(${GATE}`));
      expect(gated.some((r) => /border(?:-color)?: /.test(r)), parts.join('/')).toBe(true);
      for (const rule of gated) expect(rule, parts.join('/')).not.toMatch(/0 0 0 0\.5px/);
    }
    const ui = strip(read('components', 'ui.module.css'));
    for (const cls of ['.plain', '.primary', '.merge', '.segmented', '.segment', '.segmentOn']) expect(ui).toMatch(new RegExp(`:global\\(${GATE.replace(/[[\]().'=]/g, '\\$&')}\\) \\${cls}\\b`));
  });

  it('keeps every glass rule behind that switch, in its component’s own stylesheet', () => {
    for (const parts of SHEETS_WITH_GLASS) {
      const rules = strip(read(...parts)).split('}').map((r) => r.trim()).filter((r) => r.includes('{'));
      const gated = rules.filter((r) => r.slice(0, r.indexOf('{')).includes(`:global(${GATE}`));
      expect(gated.length, parts.join('/')).toBeGreaterThan(0);
      // The glass tokens are used only where the glass is on.
      for (const rule of rules.filter((r) => r.slice(r.indexOf('{')).includes('--glass-'))) expect(gated, parts.join('/')).toContain(rule);
    }
  });

  it('floats the sidebar and the panel, and puts the toolbar’s icon buttons on glass', () => {
    expect(strip(read('layout', 'Sidebar.module.css'))).toMatch(/\.sidebar \{[^}]*backdrop-filter: blur/);
    expect(strip(read('layout', 'panel', 'panel.module.css'))).toMatch(/\.panel \{[^}]*border-radius: var\(--glass-radius\)/);
    // The window toolbar is the one header that is a drag region (layout/Toolbar.tsx).
    expect(read('layout', 'Toolbar.tsx')).toMatch(/<header[^>]*data-tauri-drag-region/);
    expect(strip(read('components', 'ui.module.css'))).toContain(`:global(${GATE} header[data-tauri-drag-region]) .iconButton {`);
  });
});
