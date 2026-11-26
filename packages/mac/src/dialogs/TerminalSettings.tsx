import { useEffect, useState } from 'react';
import { joinArgs, shellName, splitArgs } from '@beluga/shared/shells.js';
import { Segmented, cx } from '../components/ui.js';
import { useApi, useApp } from '../lib/beluga.js';
import { setPrefs, usePrefs } from '../lib/prefs.js';
import { SCROLLBACK_CHOICES, fontChoices } from '../lib/terminal-look.js';
import { ImportGroup, TermPreview } from './TerminalImport.js';
import { KeysGroup, ThemeGroup, ViewGroup } from './TerminalThemes.js';
import { Group, Row, Select, Switch } from './settings-controls.js';
import s from './settings.module.css';
import t from './terminal-settings.module.css';
import { shortcutKeys } from '../lib/shortcuts.js';
import { thisComputer } from '../lib/os-words.js';
import { keyPlatform, type KeyPlatform } from '../lib/shortcuts-model.js';

const OTHER = '__other';

/** A shell's full path as this computer writes one, and an example (Homebrew's fish on a Mac). */
const SHELL_PATH: Readonly<Record<KeyPlatform, { readonly full: RegExp; readonly start: string; readonly example: string }>> = {
  mac: { full: /^\//, start: 'Start with /', example: '/opt/homebrew/bin/fish' },
  linux: { full: /^\//, start: 'Start with /', example: '/usr/bin/fish' },
  windows: { full: /^([a-z]:[\\/]|\\\\)/i, start: 'Start with the drive', example: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' },
};

/** Which shell new terminals run, and how it starts (Beluga's setting, not just this window's). */
function ShellGroup() {
  const api = useApi();
  const p = useApp((st) => st.prefs);
  const choices = useApp((st) => st.shellChoices);
  const login = choices.find((c) => c.isDefault);
  const listed = !p.shell || choices.some((c) => c.path === p.shell);
  const [other, setOther] = useState(!listed);
  const [path, setPath] = useState(listed ? '' : (p.shell ?? ''));
  const [args, setArgs] = useState(joinArgs(p.shellArgs));
  useEffect(() => {
    setArgs(joinArgs(p.shellArgs));
  }, [p.shellArgs]);
  const picked = other ? OTHER : (p.shell ?? '');
  const shellPath = SHELL_PATH[keyPlatform()];
  const savePath = (): void => {
    const next = path.trim();
    if (next && next !== p.shell) void api.session.setPrefs({ shell: next });
  };
  return (
    <Group title="Shell">
      <Row label="Shell" detail={other ? 'The full path of the program.' : picked ? picked : `Your login shell${login ? `, ${login.path}` : ''}.`}>
        <Select
          label="Shell"
          value={picked}
          onChange={(v) => {
            setOther(v === OTHER);
            // The login shell is "no shell set": null, since JSON drops undefined on the way to the daemon.
            if (v !== OTHER) void api.session.setPrefs({ shell: v || null });
          }}
          options={[
            { value: '', label: login ? `Login shell (${login.name})` : 'Login shell' },
            ...choices.filter((c) => !c.isDefault || p.shell === c.path).map((c) => ({ value: c.path, label: choices.filter((x) => x.name === c.name).length > 1 ? `${c.name} · ${c.path}` : c.name })),
            { value: OTHER, label: 'Other…' },
          ]}
        />
      </Row>
      {other ? (
        <Row label="Path" detail={path && !shellPath.full.test(path) ? `${shellPath.start} (e.g. ${shellPath.example}).` : path ? `Runs ${shellName(path)}.` : undefined}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              savePath();
            }}
          >
            <input className={cx(s.text, t.mono)} aria-label="Shell path" value={path} placeholder={shellPath.example} spellCheck={false} onChange={(e) => setPath(e.target.value)} onBlur={savePath} />
          </form>
        </Row>
      ) : null}
      <Row label="Login shell" detail="Reads your profile (~/.zprofile, ~/.bash_profile…), like Terminal does.">
        <Switch label="Login shell" on={p.shellLogin} onChange={(v) => void api.session.setPrefs({ shellLogin: v })} />
      </Row>
      <Row label="Extra arguments" detail={`Started as: ${[p.shell ? shellName(p.shell) : (login?.name ?? 'shell'), ...(p.shellLogin ? ['-l'] : []), ...splitArgs(args)].join(' ')}`}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            (e.currentTarget.elements[0] as HTMLInputElement).blur();
          }}
        >
          <input className={cx(s.text, t.mono)} aria-label="Extra arguments" value={args} placeholder="none" spellCheck={false} onChange={(e) => setArgs(e.target.value)} onBlur={() => joinArgs(splitArgs(args)) !== joinArgs(p.shellArgs) && void api.session.setPrefs({ shellArgs: splitArgs(args).slice(0, 20) })} />
        </form>
      </Row>
    </Group>
  );
}

/** How the terminal looks in this window (kept on this computer). */
function LookGroup() {
  const prefs = usePrefs();
  const installed = useApp((st) => st.fontChoices);
  return (
    <Group title={`Appearance on ${thisComputer()}`}>
      <div className={t.previewRow}>
        <TermPreview prefs={prefs} />
      </div>
      <Row label="Font">
        <Select label="Terminal font" value={prefs.termFont} onChange={(v) => setPrefs({ termFont: v })} options={fontChoices(prefs.termFont, installed)} />
      </Row>
      <Row label="Size" detail={`${prefs.termFontSize} pt`}>
        <input className={s.slider} aria-label="Terminal font size" type="range" min={9} max={22} step={0.5} value={prefs.termFontSize} onChange={(e) => setPrefs({ termFontSize: Number(e.target.value) })} />
      </Row>
      <Row label="Line height" detail={`${prefs.termLineHeight.toFixed(2)}×`}>
        <input className={s.slider} aria-label="Terminal line height" type="range" min={1} max={1.6} step={0.02} value={prefs.termLineHeight} onChange={(e) => setPrefs({ termLineHeight: Number(e.target.value) })} />
      </Row>
      <Row label="Cursor">
        <Segmented
          label="Cursor style"
          value={prefs.termCursor}
          onChange={(v) => setPrefs({ termCursor: v })}
          options={[
            { value: 'block', label: 'Block' },
            { value: 'bar', label: 'Bar' },
            { value: 'underline', label: 'Underline' },
          ]}
        />
      </Row>
      <Row label="Blinking cursor">
        <Switch label="Blinking cursor" on={prefs.termCursorBlink} onChange={(v) => setPrefs({ termCursorBlink: v })} />
      </Row>
      <Row label="Scrollback" detail="Lines you can scroll back through, per terminal.">
        <Select label="Scrollback" value={String(prefs.termScrollback)} onChange={(v) => setPrefs({ termScrollback: Number(v) })} options={SCROLLBACK_CHOICES.map((n) => ({ value: String(n), label: `${n.toLocaleString()} lines` }))} />
      </Row>
      {/* Only a Mac's Option key types special characters; Alt is already Meta elsewhere. */}
      {keyPlatform() === 'mac' ? (
        <Row label="Option key as Meta" detail={prefs.termOptionMeta ? 'Option+B and Option+F move by word in the shell.' : 'Option types special characters (é, ©, …).'}>
          <Switch label="Option key as Meta" on={prefs.termOptionMeta} onChange={(v) => setPrefs({ termOptionMeta: v })} />
        </Row>
      ) : null}
    </Group>
  );
}

/** Where ⌘J (and Run) show the terminal in this window: the drawer under the chat or the right panel. */
function PlaceGroup() {
  const prefs = usePrefs();
  return (
    <Group title="In this window">
      <Row label={`${shortcutKeys('toggle-dock') ?? 'Toggle Terminal'} opens the terminal`} detail={prefs.termIn === 'drawer' ? 'It slides up under the conversation, across the window.' : 'It shows as the right panel’s Terminal tab, beside the conversation.'}>
        <Segmented
          label="Where the terminal opens"
          value={prefs.termIn}
          onChange={(v) => setPrefs({ termIn: v })}
          options={[
            { value: 'drawer', label: 'Bottom Drawer', icon: 'panelBottom' },
            { value: 'panel', label: 'Right Panel', icon: 'panelRight' },
          ]}
        />
      </Row>
    </Group>
  );
}

/** Settings › Terminal: the shell (for every screen), where it opens and how terminals look here. */
export function TerminalSettings() {
  const prefs = usePrefs();
  return (
    <>
      <PlaceGroup />
      <ShellGroup />
      <ImportGroup />
      <ThemeGroup />
      <LookGroup />
      <ViewGroup />
      {prefs.termView ? <KeysGroup /> : null}
      <p className={t.note}>The shell applies to new terminals; ones already open keep theirs. The look changes right away.</p>
    </>
  );
}
