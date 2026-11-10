import { baseName } from '@beluga/shared/os-path.js';
import * as Dialog from '@radix-ui/react-dialog';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { TRUST_INFO, trustOf } from '@beluga/core/trust.js';
import { BRANCH_PREFIX_RE, EFFORTS, type LowPower } from '@beluga/shared/settings-schema.js';
import { agentChoices, agentForChoice, choiceForAgent } from '@beluga/ui/agent-choice.js';
import { EFFORT_INFO, agentEntries, modelInfo, myModel, myRuntime, setMyAgent } from '../chat/ModelPicker.js';
import { openModelCatalog, toggleOpenModel } from '@beluga/shared/open-models.js';
import { HIDEABLE_BUTTONS, TUNNEL_LABELS, TUNNEL_ORDER } from '@beluga/ui/settings-menus.js';
import { Icon } from '../components/Icon.js';
import { Avatar, Button, Dot, cx } from '../components/ui.js';
import { runtimeMark } from '@beluga/shared/agent-marks.js';
import type { RuntimeState } from '@beluga/shared/agent-runtimes.js';
import { CopyCommand, LOCAL_MODELS_ID, useAgents } from '../onboarding/AgentsStep.js';
import { fixLabel } from '../onboarding/agent-setup.js';
import { APP_VERSION, webServed } from '../lib/boot.js';
import { revealInFinder } from '../lib/files.js';
import { type SettingsPane, useApi, useApp, useBeluga, useUi } from '../lib/beluga.js';
import { ACCENTS, type Accent, setPrefs, useChosenPrefs, usePrefs } from '../lib/prefs.js';
import { themeFor } from '../lib/themes.js';
import { useDocTheme } from '../components/markdown/use-doc-theme.js';
import { ThemeGroups } from './ThemePicker.js';
import { foldsForCategories } from '../layout/attention-model.js';
import { EnvironmentSettings } from './EnvironmentSettings.js';
import { ReportProblemRow } from './ReportProblemRow.js';
import { ContextSettings } from './ContextSettings.js';
import { UsageLimitSettings } from './UsageLimitSettings.js';
import { ParallelSettings } from './ParallelSettings.js';
import { AgentThreadsSettings, ThreadLimitsSettings } from './AgentThreadsSettings.js';
import { ChatLimitSettings } from './ChatLimitSettings.js';
import { McpSettings } from './McpSettings.js';
import { LaunchFlagsSettings } from './LaunchFlagsSettings.js';
import { LocalModelsSettings } from './LocalModelsSettings.js';
import { EarningsSettings } from './EarningsSettings.js';
import { NotificationSettings } from './NotificationSettings.js';
import { VoiceSettings } from './VoiceSettings.js';
import { KeyboardSettings } from './KeyboardSettings.js';
import { ExperimentalSettings } from './ExperimentalSettings.js';
import { WebAccessSettings } from './WebAccessSettings.js';
import { Group, Row, Select, Switch } from './settings-controls.js';
import { PANES } from './settings-index.js';
import { SettingsSearchField, SettingsSearchResults, useSettingsSearch } from './SettingsSearch.js';
import { MaintainerChip } from './SupportSheets.js';
import s from './settings.module.css';
import { TerminalSettings } from './TerminalSettings.js';
import { FireSettings } from './FireSettings.js';
import { MenuBarSettings } from './MenuBarSettings.js';
import { NetworkSettings } from '../network/NetworkSettings.js';
import { befriend, openFriendCard } from '../network/use-net.js';
import { PhoneSettings } from '../phone/Phone.js';
import { MachinesSettings } from './MachinesSettings.js';
import { AccessSettings } from '../gateway/AccessSettings.js';
import { UpdateAboutRow, UpdateSettingsGroup } from './UpdateSettings.js';
import { GITHUB_URL, openSupport } from '../lib/support.js';
import { openExternal } from '../lib/system.js';
import { shortcutKeys } from '../lib/shortcuts.js';
import { keyPlatform } from '../lib/shortcuts-model.js';
import { cmdReturn, returnName, revealLabel, yourComputer } from '../lib/os-words.js';

/** Your profile picture: friends and people in your groups get it once and keep it (net/mesh/avatars.ts). */
function PictureRow() {
  const api = useApi();
  const me = useApp((st) => st.network.self);
  const on = useApp((st) => st.network.enabled);
  const fallbackName = useApp((st) => st.self?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const run = (b64: string | null): void => {
    setBusy(true);
    setError(undefined);
    api.network['avatar.set'](b64).then(
      () => setBusy(false),
      (err: unknown) => {
        setBusy(false);
        setError(err instanceof Error ? err.message : String(err));
      },
    );
  };
  const pick = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try {
      run(await squarePicture(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const detail = !on ? 'Turn on the Beluga network to share a picture.' : (error ?? 'Friends and people in your groups see it, and keep a copy.');
  return (
    <Row label="Your picture" detail={detail}>
      <span className={s.pictureRow}>
        {me ? <Avatar name={me.name || fallbackName} id={me.peerId} size={32} /> : null}
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/heic" hidden onChange={(e) => void pick(e.target.files?.[0]).finally(() => (e.target.value = ''))} />
        <Button size="small" icon="image" disabled={!on || busy} onClick={() => input.current?.click()}>
          {me?.avatar ? 'Change…' : 'Choose…'}
        </Button>
        {me?.avatar ? (
          <Button size="small" variant="quiet" disabled={busy} onClick={() => run(null)}>
            Remove
          </Button>
        ) : null}
      </span>
    </Row>
  );
}

/** A picture cropped to its middle square and shrunk to 256 px, small enough to send (base64). */
async function squarePicture(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("That picture couldn't be opened. Try a PNG or JPEG.");
  });
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = Math.min(256, side);
  const g = canvas.getContext('2d');
  if (!g) throw new Error("That picture couldn't be drawn");
  g.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const encode = (type: string, quality: number): Promise<Blob | null> => new Promise((done) => canvas.toBlob(done, type, quality));
  // WebP where the browser writes it (WebKit doesn't: JPEG there), a little rougher until it fits.
  for (const quality of [0.88, 0.78, 0.65, 0.5]) {
    let blob = await encode('image/webp', quality);
    if (blob?.type !== 'image/webp') blob = await encode('image/jpeg', quality);
    if (blob && blob.size <= 90 * 1024) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      return btoa(bin);
    }
  }
  throw new Error('That picture is too big to send, even shrunk');
}

function General() {
  const api = useApi();
  const state = useApp((st) => st);
  const prefs = usePrefs();
  const [name, setName] = useState(state.self?.name ?? '');
  return (
    <>
      <Group>
        <Row label="Your name" detail="What friends see in the room.">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void api.session.rename(name);
            }}
          >
            <input id="settings-name" aria-label="Your name" className={s.text} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== state.self?.name && void api.session.rename(name)} />
          </form>
        </Row>
        <PictureRow />
        <Row label="Friends' requests for your agent" detail="For people you haven't picked a trust level for.">
          <Select
            label="Default policy"
            value={state.policy}
            onChange={(v) => void api.session.setClaudeSharing(v)}
            options={[
              { value: 'ask', label: 'Ask me each time' },
              { value: 'auto', label: 'Allow everyone' },
              { value: 'deny', label: 'Keep it private' },
            ]}
          />
        </Row>
      </Group>
      {/* A browser runs the build its server serves: the server's Beluga updates, not the page. */}
      {webServed() ? null : <UpdateSettingsGroup />}
      <Group title="Writing">
        <Row label="Send with" detail={prefs.sendWith === 'enter' ? 'Shift+Return makes a new line.' : 'Return makes a new line.'}>
          <Select
            label="Send with"
            value={prefs.sendWith}
            onChange={(v) => setPrefs({ sendWith: v })}
            options={[
              { value: 'enter', label: returnName() },
              { value: 'cmd-enter', label: cmdReturn(' ') },
            ]}
          />
        </Row>
        <Row label="Send during a turn" detail="Queue waits for the turn to finish. Steer sends to the current turn. The secondary action uses the other choice. Agents that cannot steer always queue.">
          <Select
            label="Send during a turn"
            value={prefs.sendDuringTurn}
            onChange={(v) => setPrefs({ sendDuringTurn: v })}
            options={[
              { value: 'queue', label: 'Queue' },
              { value: 'steer', label: 'Steer' },
            ]}
          />
        </Row>
        <Row label="Show times next to messages">
          <Switch label="Times" on={prefs.timestamps} onChange={(v) => setPrefs({ timestamps: v })} />
        </Row>
        <Row label="The agent's steps once it answers" detail="Folded, the answer stands on its own; Show Steps on the answer opens them again.">
          <Select
            label="Steps"
            value={prefs.doneSteps}
            onChange={(v) => setPrefs({ doneSteps: v })}
            options={[
              { value: 'fold', label: 'Fold them away' },
              { value: 'show', label: 'Keep them showing' },
            ]}
          />
        </Row>
      </Group>
      <EarningsSettings />
    </>
  );
}

const LOW_POWER_OPTIONS: ReadonlyArray<{ value: LowPower; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'battery', label: 'On battery' },
  { value: 'always', label: 'Always' },
];

const IDLE_DAYS: readonly number[] = [0, 1, 3, 7, 14, 30];
const idleWords = (days: number): string => (days === 0 ? 'Never' : `After ${days} day${days === 1 ? '' : 's'}`);

function Appearance() {
  const prefs = useChosenPrefs();
  const api = useApi();
  const lowPower = useApp((st) => st.prefs.lowPower ?? 'off');
  const saving = useApp((st) => st.powerSaving);
  const savingNote = saving ? 'Off while Low Power mode saves power.' : undefined;
  const theme = themeFor(useDocTheme(), prefs);
  const themeAccent = theme.accent !== undefined;
  const daemonPrefs = useApp((st) => st.prefs);
  const idleChoices = [...new Set([...IDLE_DAYS, daemonPrefs.settleIdleDays])].sort((x, y) => x - y);
  // Your folds come back when it's off.
  const turnCategories = (on: boolean): void => {
    setPrefs(foldsForCategories(on, prefs));
    void api.session.setPrefs({ chatCategories: on });
  };
  return (
    <>
      <Group>
        <Row label="Appearance" {...(prefs.appearance === 'system' ? { detail: `Your light theme by day and your dark theme at night, as ${yourComputer()} switches.` } : {})}>
          <Select
            label="Appearance"
            value={prefs.appearance}
            onChange={(v) => setPrefs({ appearance: v })}
            options={[
              { value: 'system', label: 'Match the system' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </Row>
        <Row label="Accent" detail={`Selection, focus and buttons. “System” follows ${yourComputer()}${themeAccent ? `; the one beside it is ${theme.name}’s own` : ''}.`}>
          <div className={s.swatches}>
            {(Object.keys(ACCENTS) as Accent[]).filter((a) => a !== 'theme' || themeAccent || prefs.accent === 'theme').map((a) => (
              <button key={a} type="button" aria-label={a === 'theme' ? `${theme.name}’s own` : a} {...(a === 'theme' ? { title: `${theme.name}’s own` } : {})} aria-pressed={prefs.accent === a} className={cx(s.swatch, prefs.accent === a && s.swatchOn)} style={{ background: a === 'system' ? 'conic-gradient(#3b82f6, #8b5cf6, #e11d48, #d97706, #059669, #3b82f6)' : ACCENTS[a] }} onClick={() => setPrefs({ accent: a })} />
            ))}
          </div>
        </Row>
      </Group>
      <ThemeGroups />
      <Group title="Low Power">
        <Row
          label="Low Power mode"
          detail={`Beluga does less and shows less to save the battery: no motion or blur, the window redraws a few times a second, terminals skip the GPU, background checks come less often, and idle terminals rest sooner. On battery counts macOS Low Power Mode too.${saving ? ' Saving power now.' : ''}`}
        >
          <Select label="Low Power mode" value={lowPower} onChange={(v) => void api.session.setPrefs({ lowPower: v })} options={LOW_POWER_OPTIONS.map((o) => ({ ...o }))} />
        </Row>
      </Group>
      <Group title="Layout">
        <Row label="Text size" detail={`${prefs.textSize} pt · ${[shortcutKeys('zoom-in'), shortcutKeys('zoom-out')].filter(Boolean).join(' and ') || 'Bigger and Smaller Text in the View menu'} work anywhere`}>
          <input className={s.slider} type="range" min={11} max={17} step={1} value={prefs.textSize} onChange={(e) => setPrefs({ textSize: Number(e.target.value) })} />
        </Row>
        <Row label="Density">
          <Select
            label="Density"
            value={prefs.density}
            onChange={(v) => setPrefs({ density: v })}
            options={[
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'compact', label: 'Compact' },
            ]}
          />
        </Row>
        <Row label="Conversation width">
          <Select
            label="Width"
            value={prefs.chatWidth}
            onChange={(v) => setPrefs({ chatWidth: v, chatWidthPicked: true })}
            options={[
              { value: 'narrow', label: 'Narrow' },
              { value: 'wide', label: 'Wide' },
              { value: 'full', label: 'Full window' },
            ]}
          />
        </Row>
        <Row label="Sidebar categories" detail="Sort chats into Inbox, Working, Later and Settled, in place of Unread and Chats.">
          <Switch label="Sidebar categories" on={daemonPrefs.chatCategories} onChange={turnCategories} />
        </Row>
        {daemonPrefs.chatCategories ? (
          <>
            <Row label="Settle when a pull request merges" detail="The chat moves to Settled when its pull request merges.">
              <Switch label="Settle when a pull request merges" on={daemonPrefs.settleOnMerge} onChange={(v) => void api.session.setPrefs({ settleOnMerge: v })} />
            </Row>
            <Row label="Settle idle chats" detail="A chat with no activity for this long moves to Settled. An open pull request stops it.">
              <Select label="Settle idle chats" value={String(daemonPrefs.settleIdleDays)} onChange={(v) => void api.session.setPrefs({ settleIdleDays: Number(v) })} options={idleChoices.map((d) => ({ value: String(d), label: idleWords(d) }))} />
            </Row>
          </>
        ) : (
          <Row label="Unread in the sidebar" detail="Conversations that finished or need you, listed at the top while there are any.">
            <Switch label="Unread in the sidebar" on={prefs.unreadSection} onChange={(v) => setPrefs({ unreadSection: v })} />
          </Row>
        )}
        <Row label="Sidebar width">
          <input className={s.slider} type="range" min={200} max={360} step={4} value={prefs.sidebarWidth} onChange={(e) => setPrefs({ sidebarWidth: Number(e.target.value) })} />
        </Row>
        <Row label="Reduce motion" {...(savingNote ? { detail: savingNote } : {})}>
          <Switch label="Reduce motion" on={prefs.reduceMotion} onChange={(v) => setPrefs({ reduceMotion: v })} />
        </Row>
        {keyPlatform() === 'mac' && !webServed() && (
          <Row label="Reduce transparency" detail={savingNote ?? 'A solid sidebar, with no blur behind the window. Lighter on slower Macs.'}>
            <Switch label="Reduce transparency" on={prefs.reduceTransparency} onChange={(v) => setPrefs({ reduceTransparency: v })} />
          </Row>
        )}
      </Group>
    </>
  );
}

const TONE: Record<RuntimeState, 'ok' | 'warn' | 'muted'> = { ready: 'ok', signed_out: 'warn', missing: 'muted', no_endpoint: 'muted' };

/**
 * Your agents (BLG-507): each one Beluga can run with where it stands on this Mac, and its one fix
 * (Sign In, Get Codex, Set Up…); Check Again asks them all now. The same rows as onboarding's.
 */
function AgentsGroup({ mine }: { mine: string }) {
  const { rows, checking, check, act } = useAgents();
  return (
    <Group title="Your agents">
      {rows.map((row) => (
        <div key={row.id} className={s.row} data-testid={`settings-agent-${row.id}`}>
          <Icon name={runtimeMark(row.id)} size={18} />
          <div className={s.rowText}>
            <div className={s.rowLabel}>
              {row.label}
              {row.id === mine && row.state === 'ready' ? <span className={s.agentYours}> · yours</span> : null}
            </div>
            <div className={s.rowDetail}>
              {row.detail}
              {row.fix === 'install' ? (
                <>
                  {' '}
                  <CopyCommand className={s.agentCommand} runtime={row.id} />
                </>
              ) : null}
            </div>
          </div>
          <div className={s.control}>
            <Dot tone={row.state ? TONE[row.state] : 'muted'} />
            {row.words}
            {row.fix ? (
              <Button size="small" onClick={() => act(row)}>
                {fixLabel(row)}
              </Button>
            ) : null}
          </div>
        </div>
      ))}
      <Row label="Signed in or installed one just now?" detail="Beluga looks again by itself when you come back to the window.">
        <Button variant="quiet" icon="refresh" disabled={checking} onClick={() => void check()}>
          {checking ? 'Checking…' : 'Check Again'}
        </Button>
      </Row>
    </Group>
  );
}

/**
 * Models the chat’s model menu offers. With every switch on, the list is empty and a model found
 * later is on too. The last one stays on, so the menu always has a choice.
 */
function OpenModelsGroup() {
  const api = useApi();
  const runtimes = useApp((st) => st.runtimes);
  const models = useApp((st) => st.models);
  const open = useApp((st) => st.prefs.openModels) ?? [];
  const catalog = openModelCatalog(runtimes, models);
  const known = catalog.map((m) => m.key);
  const chosen = (key: string): boolean => open.length === 0 || open.includes(key);
  const toggle = (key: string): void => {
    const next = toggleOpenModel(open, key, known);
    if (next === undefined) return;
    void api.session.setPrefs({ openModels: [...next] });
  };
  return (
    <Group title="Models in chat">
      <div className={s.note}>Only these appear in the chat’s model menu. With every one on, a model found later is on too.</div>
      {catalog.length ? (
        catalog.map((m) => (
          <Row key={m.key} label={m.label} detail={[m.runtimeLabel, m.description].filter(Boolean).join(' · ')}>
            <Switch label={`${m.runtimeLabel} ${m.label}`} on={chosen(m.key)} onChange={() => toggle(m.key)} />
          </Row>
        ))
      ) : (
        <Row label="None" detail="No agent on this Mac is ready with a model yet.">
          {null}
        </Row>
      )}
    </Group>
  );
}

/**
 * Your agent (BLG-497): one pick of runtime and model, for every conversation that picked none of
 * its own and for @you; then how hard it thinks (only the levels its model takes) and the rest.
 */
function AgentPane() {
  const api = useApi();
  const macPrefs = usePrefs();
  const { ui } = useBeluga();
  const state = useApp((st) => st);
  const p = state.prefs;
  const runtime = myRuntime(p);
  const model = myModel(p);
  const choices = agentChoices(state.runtimes, state.models);
  // A model its runtime doesn't list (yet) takes every level.
  const efforts = new Set<string>(modelInfo(state, runtime, model)?.efforts ?? EFFORTS);
  const effortOptions = EFFORTS.filter((e) => efforts.has(e) || e === p.effort);
  return (
    <>
      <Group>
        <Row label="Your agent" detail="Runs every new conversation and answers when friends write @you. A conversation can pick another in the box you type in; a project, in its settings.">
          <Select
            label="Your agent"
            value={choiceForAgent({ runtime, label: '', ...(model ? { model } : {}) })}
            onChange={(v) => {
              const ref = agentForChoice(v, state.runtimes);
              setMyAgent(api, ref.runtime, ref.label, ref.model ?? '');
            }}
            options={agentEntries(choices)}
            placeholder={choices.find((c) => c.runtime === runtime)?.group ?? runtime}
          />
        </Row>
        <Row label="Thinking effort" detail={efforts.size < EFFORTS.length ? 'Only the levels this model takes.' : undefined}>
          <Select label="Effort" value={p.effort ?? ''} onChange={(v) => void api.session.setPrefs({ effort: (v || null) as (typeof EFFORTS)[number] | null })} options={[{ value: '', label: 'Auto', description: 'Your agent decides, case by case' }, ...effortOptions.map((e) => ({ value: e, label: EFFORT_INFO[e].label, description: EFFORT_INFO[e].detail, ...(efforts.has(e) ? {} : { disabled: true }) }))]} />
        </Row>
        <Row label="Ask before running commands" detail="Your own agent. Secrets stay blocked either way.">
          <Switch label="Self approval" on={p.selfApproval === 'ask'} onChange={(v) => void api.session.setPrefs({ selfApproval: v ? 'ask' : 'never' })} />
        </Row>
      </Group>
      <OpenModelsGroup />
      <AgentsGroup mine={runtime} />
      <LaunchFlagsSettings />
      <McpSettings />
      <div id={LOCAL_MODELS_ID}>
        <LocalModelsSettings />
      </div>
      <Group title="In the chat">
        <Row label="Sub-agents">
          <Select
            label="Sub-agents"
            value={p.subagents}
            onChange={(v) => void api.session.setPrefs({ subagents: v })}
            options={[
              { value: 'full', label: 'Every step' },
              { value: 'compact', label: 'One line each' },
              { value: 'hidden', label: 'Just a count' },
            ]}
          />
        </Row>
      </Group>
      <ContextSettings />
      <UsageLimitSettings />
      <ParallelSettings />
      <ChatLimitSettings />
      {p.agentThreads ? <ThreadLimitsSettings /> : null}
      <Group title="Scratch folder">
        <Row label="Give your agent a scratch folder" detail="Screenshots, JSON, logs and notes your agent makes while it works go to the workspace’s .beluga/scratch/ folder (kept out of git; never touches other tools’ .context/).">
          <Switch label="Scratch folder" on={p.scratchFolder} onChange={(v) => void api.session.setPrefs({ scratchFolder: v })} />
        </Row>
        <Row label="Show the Scratch tab" detail={`Watch that folder live in the right panel, newest first${shortcutKeys('panel-scratch') ? ` (${shortcutKeys('panel-scratch')})` : ''}.`}>
          <Switch label="Scratch tab" on={macPrefs.scratchTab} onChange={(v) => setPrefs({ scratchTab: v })} />
        </Row>
      </Group>
      <Group title="Pull requests and templates">
        <Row label="Pull request instructions" detail={state.prCustom ? 'Customized' : 'Built-in'}>
          <Button onClick={() => void api.workbench.editPrPrompt()}>Edit…</Button>
          {state.prCustom ? (
            <Button variant="quiet" onClick={() => void api.workbench.resetPrPrompt()}>
              Reset
            </Button>
          ) : null}
        </Row>
        <Row label="Templates" detail={`${state.templates.length} ways to start a task`}>
          <Button onClick={() => ui.patch({ settings: undefined, menu: { menu: { kind: 'templates', manage: true }, selected: 0 } })}>Manage…</Button>
        </Row>
      </Group>
    </>
  );
}

/** Projects you hid from the sidebar, each with Show (it comes back where it was). */
function HiddenProjectsGroup() {
  const api = useApi();
  const hidden = useApp((st) => st.hiddenProjects);
  return (
    <Group title="Hidden projects">
      {hidden.length ? (
        hidden.map((root) => (
          <Row key={root} label={baseName(root) || root} detail={root}>
            <Button onClick={() => void api.workspaces.showProject(root)} aria-label={`Show ${baseName(root) || root}`}>
              Show
            </Button>
          </Row>
        ))
      ) : (
        <Row label="None" detail="Hide a project from its menu in the sidebar; it waits here (and under Hidden Projects) until you show it again.">
          {null}
        </Row>
      )}
    </Group>
  );
}

/** What new worktrees' branches start with: saved when you leave the field, if git would take it. */
function BranchPrefixRow() {
  const api = useApi();
  const saved = useApp((st) => st.prefs.branchPrefix);
  const [value, setValue] = useState(saved);
  useEffect(() => setValue(saved), [saved]);
  const ok = BRANCH_PREFIX_RE.test(value);
  const save = (): void => {
    if (ok && value !== saved) void api.session.setPrefs({ branchPrefix: value });
  };
  return (
    <Row label="Branch prefix" detail={ok ? `New worktrees get branches like ${value}fix-login. Leave it empty for no prefix.` : 'Use letters, digits and . _ - / only.'}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <input aria-label="Branch prefix" className={s.text} value={value} placeholder="none" spellCheck={false} onChange={(e) => setValue(e.target.value.trim())} onBlur={save} />
      </form>
    </Row>
  );
}

function Workspaces() {
  const api = useApi();
  const p = useApp((st) => st.prefs);
  return (
    <>
      <Group>
        <Row label="Run setup in new worktrees" detail="The project's setup command (npm install, …) runs in each new worktree.">
          <Switch label="Auto setup" on={p.autoSetup} onChange={(v) => void api.session.setPrefs({ autoSetup: v })} />
        </Row>
        <BranchPrefixRow />
        <Row label="Keep open pull requests current" detail="When your agent commits in a worktree whose pull request is open, it pushes there as its turn ends. Off: it commits here, and you push from the toolbar.">
          <Switch label="Keep open pull requests current" on={p.pushToPr} onChange={(v) => void api.session.setPrefs({ pushToPr: v })} />
        </Row>
        <Row label="Friends may start work here" detail="They ask to start a worktree or hand work to you; you approve each one.">
          <Switch label="Friend worktrees" on={p.friendWorktrees === 'ask'} onChange={(v) => void api.session.setFriendWorktrees(v ? 'ask' : 'off')} />
        </Row>
      </Group>
      <HiddenProjectsGroup />
      <Group title="Toolbar buttons">
        {HIDEABLE_BUTTONS.map(([id, label]) => (
          <Row key={id} label={label}>
            <Switch label={label} on={!p.hiddenButtons.includes(id)} onChange={(v) => void api.session.setPrefs({ hiddenButtons: v ? p.hiddenButtons.filter((b) => b !== id) : [...p.hiddenButtons, id] })} />
          </Row>
        ))}
      </Group>
    </>
  );
}

function People() {
  const api = useApi();
  const { client, ui } = useBeluga();
  const state = useApp((st) => st);
  const others = state.peers.filter((p) => p.peerId !== state.selfId);
  const remembered = Object.entries(state.remembered).filter(([id]) => !others.some((p) => p.peerId === id));
  return (
    <>
      <NetworkSettings />
      <AccessSettings />
      {/* Trust is shown here and set on each friend's card (BLG-202). */}
      <Group title="In the room">
        {others.length ? (
          others.map((p) => {
            const friend = state.network.friends.some((f) => f.peerId === p.peerId);
            return (
              <Row key={p.peerId} label={p.name} detail={`${TRUST_INFO[trustOf(state, p.peerId)].label}. ${friend ? 'Change it on their card.' : 'Add them as a friend to set it.'}`}>
                <Avatar name={p.name} id={p.peerId} size={20} />
                {friend ? (
                  <Button
                    variant="quiet"
                    onClick={() => {
                      ui.patch({ settings: undefined });
                      openFriendCard(client, p.peerId);
                    }}
                  >
                    Their Card…
                  </Button>
                ) : p.guest || state.guests[p.peerId] ? null : (
                  <Button variant="quiet" onClick={() => void befriend(client, p.peerId, p.name)}>
                    Add as Friend
                  </Button>
                )}
              </Row>
            );
          })
        ) : (
          <div className={s.note}>Nobody else is here yet.</div>
        )}
      </Group>
      {remembered.length ? (
        <Group title="Remembered from before">
          {remembered.map(([id, r]) => (
            <Row key={id} label={r.name} detail={TRUST_INFO[r.trust].label}>
              <Button variant="quiet" onClick={() => void api.people.forget(id)}>
                Forget
              </Button>
            </Row>
          ))}
        </Group>
      ) : null}
      <Group title="Remote access">
        <Row label="How friends reach you" detail="Takes effect for the next invite.">
          <Select label="Tunnel" value={state.prefs.tunnel} onChange={(v) => void api.session.setPrefs({ tunnel: v })} options={TUNNEL_ORDER.map((t) => ({ value: t, label: TUNNEL_LABELS[t] }))} />
        </Row>
        {state.isHost ? (
          <Row label="Take new people" detail={state.roomOpen ? 'Anyone with the link can come in (or knock).' : 'Closed: nobody new can join, even with the link.'}>
            <Switch label="Room open" on={state.roomOpen} onChange={(v) => void api.session.setRoomOpen(v)} />
          </Row>
        ) : null}
        <Row label="Invite link">
          <Button onClick={() => void api.session.copyInvite()}>Copy</Button>
          {state.isHost ? (
            <Button variant="quiet" onClick={() => void api.session.newInviteLink()}>
              New link
            </Button>
          ) : null}
        </Row>
      </Group>
    </>
  );
}

function About() {
  const { client, ui } = useBeluga();
  const home = useApp((st) => st.home);
  const logPath = `${home}/.beluga/logs/daemon.log`;
  return (
    <>
      <Group>
        <Row label="The Beluga app">{APP_VERSION}</Row>
        {webServed() ? null : <UpdateAboutRow />}
        <Row label="Beluga (the part that runs your room)">{client.daemonVersion}</Row>
        <Row label="Windows attached" detail="Beluga windows connected to the room right now.">
          {client.clients}
        </Row>
        <Row label="Log" detail="~/.beluga/logs/daemon.log">
          <Button size="small" onClick={() => void client.api.local.openFolder(logPath)}>
            Open in Console
          </Button>
          <Button size="small" variant="quiet" onClick={() => void revealInFinder(client, logPath)}>
            {revealLabel()}
          </Button>
        </Row>
        <ReportProblemRow />
      </Group>
      <Group title="Support Beluga">
        <Row label="Beluga is free, and a passion project" detail={
            <>
              Built and maintained by <MaintainerChip />. A star helps others find it; a coffee keeps it going.
            </>
          }>
          <Button size="small" icon="star" onClick={() => void openExternal(GITHUB_URL)}>
            Star on GitHub
          </Button>
          <Button
            size="small"
            icon="cup"
            onClick={() => {
              // The sheet opens where Settings was (Settings sits above sheets).
              ui.patch({ settings: undefined });
              openSupport('coffee');
            }}
          >
            Buy a Coffee…
          </Button>
        </Row>
      </Group>
    </>
  );
}

const BODY: Record<SettingsPane, () => ReactNode> = {
  general: General,
  appearance: Appearance,
  claude: AgentPane,
  notifications: NotificationSettings,
  workspaces: Workspaces,
  terminal: TerminalSettings,
  fire: FireSettings,
  menubar: MenuBarSettings,
  environment: EnvironmentSettings,
  people: People,
  phone: PhoneSettings,
  computers: MachinesSettings,
  voice: VoiceSettings,
  keyboard: KeyboardSettings,
  advanced: Advanced,
  experimental: ExperimentalSettings,
  about: About,
};

function Advanced() {
  return (
    <>
      <WebAccessSettings />
      <AgentThreadsSettings />
    </>
  );
}

/** The app's own panes a browser has no use for (it has no menu bar icon). */
const APP_ONLY: ReadonlySet<SettingsPane> = new Set(['menubar']);

/** Beluga's settings: this window's look on the left panes, Beluga's shared settings on the rest. */
export function Settings() {
  const pane = useUi((u) => u.settings);
  return pane ? <SettingsWindow pane={pane} /> : null;
}

/**
 * The window, with the search above the panes (BLG-740): opened, the field has focus; ⌘F comes
 * back to it, Esc clears it, and a second Esc closes the window.
 */
function SettingsWindow({ pane }: { pane: SettingsPane }) {
  const { ui } = useBeluga();
  const panes = useMemo(() => (webServed() ? PANES.filter((p) => !APP_ONLY.has(p.id)) : PANES), []);
  const scroll = useRef<HTMLDivElement>(null);
  const search = useSettingsSearch(panes, pane, (id) => ui.patch({ settings: id }), scroll);
  const Body = BODY[pane];
  // Opened from the welcome (Set Up… on Your agents): over it, not hidden behind it.
  const overWelcome = document.querySelector('[data-welcome]') ? '' : undefined;
  return (
    <Dialog.Root open onOpenChange={(v) => (v ? undefined : ui.patch({ settings: undefined }))}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} data-over-welcome={overWelcome} />
        <Dialog.Content
          className={s.window}
          data-over-welcome={overWelcome}
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            search.field.current?.focus();
          }}
          onEscapeKeyDown={(e) => {
            if (!search.query) return;
            e.preventDefault();
            search.clear();
          }}
        >
          <nav className={s.nav}>
            <Dialog.Title className={s.title}>Settings</Dialog.Title>
            <SettingsSearchField search={search} />
            {panes.map((p) => (
              <button
                key={p.id}
                type="button"
                className={cx(s.navItem, p.id === pane && !search.showing && s.navOn, search.showing && !search.matched.has(p.id) && s.navDim)}
                onClick={() => {
                  ui.patch({ settings: p.id });
                  search.browse();
                }}
              >
                <Icon name={p.icon} size={14} />
                {p.label}
              </button>
            ))}
          </nav>
          <div className={s.body}>
            <div className={s.bodyHead}>
              <h2 className={s.paneTitle}>{search.showing ? 'Search' : PANES.find((p) => p.id === pane)?.label}</h2>
              <Dialog.Close className={s.close} aria-label="Close">
                <Icon name="x" size={12} />
              </Dialog.Close>
            </div>
            <div ref={scroll} className={s.scroll}>
              {search.showing ? <SettingsSearchResults search={search} panes={panes} /> : <Body />}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
