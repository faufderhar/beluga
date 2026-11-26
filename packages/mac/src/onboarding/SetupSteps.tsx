import { motion } from 'motion/react';
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import { STARTERS, type FireLook, presetOf, starterOf } from '../chat/fire-look.js';
import { Preview } from '../dialogs/FireSettings.js';
import { Switch } from '../dialogs/settings-controls.js';
import { previewRequestPopup } from '../gateway/request-native.js';
import { useApi, useApp, useBeluga } from '../lib/beluga.js';
import type { SettingsPane } from '../lib/settings-search.js';
import { askNotificationPermission, openNotificationSettings, useNotificationAccess } from '../lib/sounds/access.js';
import { ACCENTS, type Accent, type UiPrefs, baseNow, getPrefs, pickTheme, setPrefs, usePrefs } from '../lib/prefs.js';
import { type AppTheme, THEMES, themeFor } from '../lib/themes.js';
import { useDocTheme } from '../components/markdown/use-doc-theme.js';
import { EASE_OUT, Rise, SPRING, Words } from './fx.js';
import { Glass } from './Glass.js';
import s from './onboarding.module.css';
import { cmdReturn, notificationSettings, returnName, systemSettingsName } from '../lib/os-words.js';
import { keyPlatform } from '../lib/shortcuts-model.js';

type Appearance = UiPrefs['appearance'];

/** A tiny Beluga window in one theme's colours: sidebar, a conversation, the box you type in. */
function MiniApp({ theme }: { readonly theme: AppTheme }) {
  const k = theme.colors;
  const vars = { '--m-bg': k.bg, '--m-side': k.sidebar, '--m-line': `color-mix(in srgb, ${k.text3} 40%, ${k.bg})`, '--m-strong': `color-mix(in srgb, ${k.text2} 45%, ${k.bg})`, '--m-claude': k.claude } as CSSProperties;
  return (
    <span className={s.mini} data-look={theme.base} style={vars}>
      <span className={s.miniSide}>
        <i />
        <i />
        <i data-on />
        <i />
      </span>
      <span className={s.miniMain}>
        <i data-w="70" />
        <i data-w="45" data-claude />
        <i data-w="58" />
        <span className={s.miniBox} />
      </span>
    </span>
  );
}

/**
 * The themes for the look showing (BLG-696): a swatch each, its own background with its accent at
 * the centre, and the picked one's name beside them. Settings › Appearance has them all as windows.
 */
function ThemeRow({ prefs }: { readonly prefs: UiPrefs }) {
  const base = useDocTheme();
  const picked = themeFor(base, prefs);
  const [hover, setHover] = useState<AppTheme>();
  return (
    <Rise delay={0.45} className={s.accentRow}>
      <span className={cx(s.label, s.themeLabel)}>Theme</span>
      <div className={s.swatches} role="radiogroup" aria-label={base === 'dark' ? 'Dark theme' : 'Light theme'} onMouseLeave={() => setHover(undefined)}>
        {THEMES.filter((th) => th.base === base).map((th) => (
          <motion.button
            key={th.id}
            type="button"
            role="radio"
            aria-label={th.name}
            aria-checked={picked.id === th.id}
            className={cx(s.swatch, s.themeSwatch)}
            style={{ background: th.colors.bg, '--t-dot': th.accent ?? th.colors.text2, '--t-edge': th.colors.sidebar } as CSSProperties}
            onClick={() => pickTheme(th.id)}
            onMouseEnter={() => setHover(th)}
            onFocus={() => setHover(th)}
            whileHover={{ scale: 1.15 }}
            whileTap={{ scale: 0.92 }}
          >
            {picked.id === th.id ? <motion.span layoutId={`theme-ring-${base}`} className={s.swatchRing} transition={SPRING} /> : null}
          </motion.button>
        ))}
      </div>
      <span className={s.themeName} aria-live="polite">
        {(hover ?? picked).name}
      </span>
    </Rise>
  );
}

const LOOKS: ReadonlyArray<{ value: Appearance; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

/** Pick a look: three windows to choose from, and the accent. It all applies as you pick. */
export function Look() {
  const prefs = usePrefs();
  return (
    <div className={s.setup}>
      <h2 className={s.title}>
        <Words text="Pick how Beluga looks." />
      </h2>
      <Rise delay={0.2} className={s.body}>
        Light, dark or matching your system, then a theme and an accent color. The window changes as you click.
      </Rise>
      <div className={s.looks} role="radiogroup" aria-label="Appearance">
        {LOOKS.map((l, i) => {
          const on = prefs.appearance === l.value;
          return (
            <motion.button
              key={l.value}
              type="button"
              role="radio"
              aria-checked={on}
              className={cx(s.lookCard, on && s.lookOn)}
              onClick={() => setPrefs({ appearance: l.value })}
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              whileHover={{ y: -3 }}
              transition={{ ...SPRING, delay: 0.25 + i * 0.07 }}
            >
              {l.value === 'system' ? (
                <span className={s.split}>
                  <MiniApp theme={themeFor('light', prefs)} />
                  <MiniApp theme={themeFor('dark', prefs)} />
                </span>
              ) : (
                <MiniApp theme={themeFor(l.value, prefs)} />
              )}
              <span className={s.lookLabel}>
                <span className={s.radio}>{on ? <motion.span layoutId="look-dot" className={s.radioDot} transition={SPRING} /> : null}</span>
                {l.label}
              </span>
            </motion.button>
          );
        })}
      </div>
      <ThemeRow prefs={prefs} />
      <Rise delay={0.5} className={cx(s.accentRow, s.accentAfter)}>
        <span className={s.label}>Accent</span>
        <div className={s.swatches} role="radiogroup" aria-label="Accent">
          {(Object.keys(ACCENTS) as Accent[]).filter((a) => a !== 'theme' || themeFor(baseNow(prefs), prefs).accent).map((a) => (
            <motion.button
              key={a}
              type="button"
              role="radio"
              aria-label={a === 'system' ? 'System accent' : a === 'theme' ? `${themeFor(baseNow(prefs), prefs).name}’s own accent` : a}
              aria-checked={prefs.accent === a}
              className={s.swatch}
              style={{ background: a === 'system' ? 'conic-gradient(#3b82f6, #8b5cf6, #e11d48, #d97706, #059669, #3b82f6)' : ACCENTS[a] }}
              onClick={() => setPrefs({ accent: a })}
              whileHover={{ scale: 1.15 }}
              whileTap={{ scale: 0.92 }}
            >
              {prefs.accent === a ? <motion.span layoutId="accent-ring" className={s.swatchRing} transition={SPRING} /> : null}
            </motion.button>
          ))}
        </div>
      </Rise>
      <AllSettings pane="appearance" label="All Appearance Settings…" delay={0.6} />
    </div>
  );
}

/** A choice of two or three, the selection sliding between them. */
function Choice<T extends string>({ label, value, options, onChange }: { readonly label: string; readonly value: T; readonly options: ReadonlyArray<{ value: T; label: string }>; readonly onChange: (v: T) => void }) {
  return (
    <div className={s.choice} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={cx(s.choiceItem, value === o.value && s.choiceOn)} onClick={() => onChange(o.value)}>
          {value === o.value ? <motion.span layoutId={`choice-${label}`} className={s.choicePill} transition={SPRING} /> : null}
          <span className={s.choiceLabel}>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

function SetupRow({ label, detail, children, index }: { readonly label: string; readonly detail: ReactNode; readonly children: ReactNode; readonly index: number }) {
  return (
    <motion.div className={s.row} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: EASE_OUT, delay: 0.25 + index * 0.06 }}>
      <div className={s.rowText}>
        <span className={s.rowLabel}>{label}</span>
        <span className={s.rowDetail}>{detail}</span>
      </div>
      <div className={s.rowControl}>{children}</div>
    </motion.div>
  );
}

/** Under a settings step: that step's whole page in Settings, opened over the welcome (which waits behind it). */
export function AllSettings({ pane, label, delay = 0.55 }: { readonly pane: SettingsPane; readonly label: string; readonly delay?: number }) {
  const { ui } = useBeluga();
  return (
    <Rise delay={delay} className={s.allSettings}>
      <button type="button" className={s.textLink} onClick={() => ui.patch({ settings: pane })}>
        <Icon name="gear" size={11} /> {label}
      </button>
    </Rise>
  );
}

/**
 * When the fire burns, in one choice (Settings › Fire & Confetti keeps these as two, Where and
 * When it burns): all the time on Max, all the time on every effort, or only while you type.
 */
type When = 'max' | 'everywhere' | 'typing';
const WHEN: Readonly<Record<When, Pick<FireLook, 'where' | 'show'>>> = {
  max: { where: 'max', show: 'always' },
  everywhere: { where: 'everywhere', show: 'always' },
  typing: { where: 'everywhere', show: 'typing' },
};
const WHEN_OPTIONS: ReadonlyArray<{ value: When; label: string }> = [
  { value: 'max', label: 'On Max Only' },
  { value: 'everywhere', label: 'Always' },
  { value: 'typing', label: 'While Typing' },
];
const WHEN_DETAIL: Readonly<Record<When, string>> = {
  max: 'Only on Max effort, so it tells you you’re on Max.',
  everywhere: 'With every model and every effort.',
  typing: 'Only while you type, then it goes out.',
};

/** How much room each fire has above its box: enough for the two starters' flames, not the tallest a custom one can reach. */
const FIRE_ROOM = 130;

/**
 * The message box's fire: the pixel fire and the flame side by side, each burning in a box like the
 * real one. Click one (or type in it) to pick it; the switch turns the fire off. Settings › Fire &
 * Confetti, a click away, has the sliders, colours and timing. A look of someone's own (tuned in
 * Settings) picks neither until they choose.
 */
export function Fire() {
  const look = usePrefs().maxFire;
  const set = (patch: Partial<FireLook>): void => {
    const next = { ...getPrefs().maxFire, ...patch };
    setPrefs({ maxFire: { ...next, preset: presetOf(next) } });
  };
  // Burning only while typing is a "when", not another fire: the fire it burns is still Pixel or Flame.
  const typing = look.show === 'typing';
  const picked = starterOf(typing ? { ...look, show: 'always' } : look);
  const fires = STARTERS.filter((x) => x.id !== 'none');
  const on = picked !== 'none';
  /** A fire's look, burning when this step says (always, or while typing). */
  const lit = (x: (typeof STARTERS)[number]): Partial<FireLook> => (typing && x.id !== 'none' ? { ...x.set, show: 'typing' } : x.set);
  const choose = (id: string): void => {
    if (picked !== id) set(lit(STARTERS.find((x) => x.id === id)!));
  };
  const when: When = typing ? 'typing' : look.where === 'max' ? 'max' : 'everywhere';
  return (
    <div className={cx(s.setup, s.fireSetup)}>
      <h2 className={s.title}>
        <Words text="Pick a fire for your message box." />
      </h2>
      <Rise delay={0.2} className={s.body}>
        On Max effort, flames burn around the box you type in. Type in either one to try it.
      </Rise>
      <div className={s.fires} role="radiogroup" aria-label="Fire">
        {fires.map((x, i) => {
          const chosen = picked === x.id;
          return (
            <motion.div key={x.id} className={s.fireOption} data-on={chosen ? '' : undefined} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: EASE_OUT, delay: 0.3 + i * 0.08 }} onPointerDown={() => choose(x.id)}>
              <Preview look={{ ...look, ...lit(x), preset: presetOf({ ...look, ...lit(x) }) }} room={FIRE_ROOM} className={s.fireStage} label={`Try the ${x.name} fire`} onFocus={() => choose(x.id)} />
              <button type="button" role="radio" aria-checked={chosen} className={s.firePick} onClick={() => choose(x.id)}>
                <span className={s.radio}>{chosen ? <motion.span layoutId="fire-dot" className={s.radioDot} transition={SPRING} /> : null}</span>
                <span className={s.fireText}>
                  <span className={s.fireName}>{x.name}</span>
                  <span className={s.fireBlurb}>{x.blurb}</span>
                </span>
              </button>
            </motion.div>
          );
        })}
      </div>
      <Glass radius={16} width="100%" className={s.fireRows}>
        <SetupRow index={0} label="Fire around the message box" detail={on ? (picked ? 'Pick the other one above to switch.' : 'Your own look, from Settings. Pick one above to replace it.') : 'Off: a plain box, nothing flies.'}>
          <Switch label="Fire around the message box" on={on} onChange={(v) => set(STARTERS.find((x) => x.id === (v ? 'flame' : 'none'))!.set)} />
        </SetupRow>
        {on ? (
          <SetupRow index={1} label="When it burns" detail={WHEN_DETAIL[when]}>
            <Choice label="When it burns" value={when} onChange={(w) => set(WHEN[w])} options={WHEN_OPTIONS} />
          </SetupRow>
        ) : null}
      </Glass>
      <AllSettings pane="fire" label="All Fire Settings…" />
    </div>
  );
}

/**
 * When something needs you (Claude asks, a decision of yours in a plan, a friend's request): a
 * card in the corner of the screen, over any app, full-screen ones too. It needs no macOS
 * permission; notifications (asked for here) are the fallback and fill Notification Center.
 */
export function Popups() {
  const api = useApi();
  const notify = useApp((st) => st.prefs.notify);
  const [asked, setAsked] = useState<'no' | 'asking' | 'done'>('no');
  // What macOS says (checked again as you come back from System Settings).
  const { access, recheck } = useNotificationAccess();
  const state = access?.state;
  // Where they wait once shown: Notification Center on a Mac and Windows; Linux desktops differ.
  const kept = keyPlatform() === 'linux' ? '' : ', and stay in Notification Center';
  const ask = (): void => {
    setAsked('asking');
    void askNotificationPermission()
      .catch(() => undefined)
      .then((a) => {
        setAsked('done');
        recheck(a);
      });
  };
  return (
    <div className={s.setup}>
      <h2 className={s.title}>
        <Words text="Know when your agent needs you." />
      </h2>
      <Rise delay={0.2} className={s.body}>
        When your agent asks a question, a plan waits for your decision or a friend sends a request, a small card appears in the corner of your screen, even over full-screen apps. It never takes the keyboard away from what you’re typing.
      </Rise>
      <Glass radius={16} width="100%" className={s.rows}>
        <SetupRow index={0} label="Show on-screen popups when something needs me" detail="Needs no permission. Off: you still get notifications.">
          <Switch label="Show on-screen popups when something needs me" on={notify.popup !== false} onChange={(v) => void api.session.setPrefs({ notify: { ...notify, popup: v } })} />
        </SetupRow>
        <SetupRow index={1} label="See one now" detail="A pretend friend’s request and a pretend decision, for a minute. Their buttons do nothing.">
          <button type="button" className={cx(s.input, s.rowButton)} onClick={previewRequestPopup}>
            Show Me a Sample
          </button>
        </SetupRow>
        <SetupRow
          index={2}
          label="Notifications too"
          detail={
            state === 'allowed'
              ? `Allowed. They reach you when popups are off${kept}.`
              : state === 'off'
                ? `Turned off for Beluga in ${notificationSettings()}.`
                : asked === 'done'
                  ? `Asked. You can change it in ${notificationSettings()}.`
                  : `Optional.${keyPlatform() === 'mac' ? ' macOS asks once.' : ''} They reach you when popups are off${kept}.`
          }
        >
          {state === 'allowed' ? (
            <span className={s.grant} data-grant="granted">
              <Icon name="check" size={11} /> Allowed
            </span>
          ) : state === 'off' ? (
            <button type="button" className={cx(s.input, s.rowButton)} onClick={() => void openNotificationSettings()}>
              Open {systemSettingsName()}
            </button>
          ) : (
            <button type="button" className={cx(s.input, s.rowButton)} disabled={asked !== 'no'} onClick={ask}>
              {asked === 'done' ? 'Asked' : asked === 'asking' ? 'Asking…' : 'Allow Notifications'}
            </button>
          )}
        </SetupRow>
      </Glass>
      <AllSettings pane="notifications" label="All Notification Settings…" />
    </div>
  );
}

/**
 * The few settings that matter on day one, already set the way most people want them. Each
 * applies as you change it; Settings has every one of them later.
 */
export function Setup() {
  const api = useApi();
  const prefs = usePrefs();
  const self = useApp((st) => st.self?.name ?? '');
  const policy = useApp((st) => st.policy);
  const core = useApp((st) => st.prefs);
  const [name, setName] = useState(self);
  // What's typed is saved on Return, on leaving the field, and when the step goes (⌘] doesn't blur).
  const typed = useRef({ name, self });
  typed.current = { name, self };
  const saveName = (): void => {
    const next = typed.current.name.trim();
    if (next && next !== typed.current.self) void api.session.rename(next);
  };
  useEffect(() => saveName, []);
  return (
    <div className={s.setup}>
      <h2 className={s.title}>
        <Words text="Check a few settings." />
      </h2>
      <Rise delay={0.2} className={s.body}>
        These are set the way most people keep them. Change any of them now, or later in Settings.
      </Rise>
      <Glass radius={16} width="100%" className={s.rows}>
        <SetupRow index={0} label="Your name" detail="What friends see when you work together.">
          <input className={s.input} aria-label="Your name" value={name} placeholder="Your name" maxLength={64} onChange={(e) => setName(e.target.value)} onBlur={saveName} onKeyDown={(e) => e.key === 'Enter' && saveName()} />
        </SetupRow>
        <SetupRow index={1} label="When a friend asks your agent" detail={policy === 'ask' ? 'Recommended: you see and approve every request.' : policy === 'auto' ? 'Requests from friends run without asking.' : 'Only you can use your agent.'}>
          <Choice
            label="Friends' requests"
            value={policy}
            onChange={(v) => void api.session.setClaudeSharing(v)}
            options={[
              { value: 'ask', label: 'Ask Me' },
              { value: 'auto', label: 'Allow' },
              { value: 'deny', label: 'Private' },
            ]}
          />
        </SetupRow>
        <SetupRow index={2} label="Tell me when my agent needs me" detail={core.notify.onlyAway ? 'When a run finishes or waits for you, while you’re in another app.' : 'When a run finishes or waits for you.'}>
          <Switch label="Notifications" on={core.notify.desktop} onChange={(v) => void api.session.setPrefs({ notify: { ...core.notify, desktop: v, ...(v ? { onlyAway: true } : {}) } })} />
        </SetupRow>
        <SetupRow index={3} label="Ask before my agent runs commands" detail="Off lets your agent work on its own in your worktrees. Secrets stay blocked either way.">
          <Switch label="Ask before running commands" on={core.selfApproval === 'ask'} onChange={(v) => void api.session.setPrefs({ selfApproval: v ? 'ask' : 'never' })} />
        </SetupRow>
        {/* Your agent is picked on its own step, right after the welcome (AgentsStep.tsx). */}
        <SetupRow index={4} label="Send messages with" detail={prefs.sendWith === 'enter' ? 'Shift-Return makes a new line.' : 'Return makes a new line.'}>
          <Choice
            label="Send with"
            value={prefs.sendWith}
            onChange={(v) => setPrefs({ sendWith: v })}
            options={[
              { value: 'enter', label: returnName() },
              { value: 'cmd-enter', label: cmdReturn(' ') },
            ]}
          />
        </SetupRow>
      </Glass>
      <AllSettings pane="general" label="All Settings…" />
    </div>
  );
}
