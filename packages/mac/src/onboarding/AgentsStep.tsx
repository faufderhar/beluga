import { motion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { runtimeMark } from '@beluga/shared/agent-marks.js';
import type { RuntimeChoice } from '@beluga/shared/agent-runtimes.js';
import { myModel, myRuntime, setMyAgent } from '../chat/ModelPicker.js';
import { Icon } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import { useApi, useApp, useBeluga } from '../lib/beluga.js';
import { copyText } from '../lib/copy.js';
import { openExternal } from '../lib/system.js';
import { everyWhileShown } from '../lib/window-active.js';
import { AGENT_RECHECK_MS, type AgentRow, INSTALLS, agentRows, awaitingAgent, fixLabel, pickDefault } from './agent-setup.js';
import { EASE_OUT, Rise, SPRING, Words } from './fx.js';
import { Glass } from './Glass.js';
import s from './onboarding.module.css';

/** Where Settings › Agent keeps its local models (Settings.tsx), to scroll to. */
export const LOCAL_MODELS_ID = 'settings-local-models';

/**
 * Your agents as this Mac has them (BLG-507): asked when shown, again when you come back to the
 * window (from Terminal's sign-in, say), and every few seconds on their own while one is still
 * missing or signed out (Codex installed from Beluga's own terminal never leaves the window), with
 * Check Again for the rest; and what each row's button does: sign in (in Terminal), get Codex or
 * OpenCode, or set up a local model (Settings › Agent).
 */
export function useAgents(): { rows: AgentRow[]; checking: boolean; checked: boolean; check: () => Promise<readonly RuntimeChoice[] | undefined>; act: (row: AgentRow) => void } {
  const api = useApi();
  const { ui } = useBeluga();
  const runtimes = useApp((st) => st.runtimes);
  const [checked, setChecked] = useState(false);
  const [checking, setChecking] = useState(false);
  // Quiet: the looks on its own don't turn Check Again into "Checking…" every few seconds.
  const look = useCallback(
    async (quiet: boolean): Promise<readonly RuntimeChoice[] | undefined> => {
      if (!quiet) setChecking(true);
      try {
        return await api.workbench.checkAgents();
      } catch {
        return undefined;
      } finally {
        if (!quiet) setChecking(false);
        setChecked(true);
      }
    },
    [api],
  );
  const check = useCallback(() => look(false), [look]);
  useEffect(() => {
    void check();
    const again = (): void => void check();
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [check]);
  const rows = agentRows(runtimes, checked);
  const awaiting = awaitingAgent(rows);
  // While it can be seen, behind Terminal too (where you're installing or signing in).
  useEffect(() => (awaiting ? everyWhileShown(() => void look(true), AGENT_RECHECK_MS) : undefined), [awaiting, look]);
  const act = (row: AgentRow): void => {
    if (row.fix === 'sign_in') void api.workbench.agentSignIn(row.id);
    else if (row.fix === 'install' && INSTALLS[row.id]) void openExternal(INSTALLS[row.id]!.page);
    else if (row.fix === 'set_up') {
      ui.patch({ settings: 'claude' });
      setTimeout(() => document.getElementById(LOCAL_MODELS_ID)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 120);
    }
  };
  return { rows, checking, checked, check, act };
}

/** An agent's install command (Codex's, OpenCode's npm one, or `command`: an ACP agent's), a tap to copy. */
export function CopyCommand({ className, runtime = 'codex', command: given }: { readonly className?: string; readonly runtime?: string; readonly command?: string }) {
  const [copied, setCopied] = useState(false);
  const command = given ?? INSTALLS[runtime]?.command;
  if (!command) return null;
  return (
    <button
      type="button"
      className={className}
      aria-label={`Copy ${command}`}
      onClick={() => {
        void copyText(command);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
    >
      <code>{command}</code>
      <Icon name={copied ? 'check' : 'copy'} size={11} />
    </button>
  );
}

/**
 * Onboarding's "Your agents" step, right after the welcome: every agent Beluga can run with where it
 * stands here, the first ready one already picked as yours (Claude Code before Codex before a local
 * model, or the one you had), and Sign In / Get Codex / Set Up beside the rest. With none ready it
 * says so and lets you go on.
 */
export function AgentsStep() {
  const api = useApi();
  const prefs = useApp((st) => st.prefs);
  const mine = myRuntime(prefs);
  const { rows, checking, checked, check, act } = useAgents();
  // The first ready agent picks yours, once; after that only you do. With none ready yet, it waits:
  // Codex turning ready while you're here becomes yours.
  const picked = useRef(false);
  useEffect(() => {
    // Only once every agent has been asked (before that, one listed as running may not be signed in).
    if (picked.current || checking || !checked) return;
    const to = pickDefault(rows, mine);
    if (!to) return;
    picked.current = true;
    if (to !== mine) choose(rows.find((r) => r.id === to)!);
  });
  const choose = (row: AgentRow): void => {
    picked.current = true;
    setMyAgent(api, row.id, row.label, row.id === mine ? myModel(prefs) : '');
  };
  const anyReady = rows.some((r) => r.state === 'ready');
  const asked = checked;
  return (
    <div className={s.setup}>
      <h2 className={s.title}>
        <Words text="Which agent is yours?" />
      </h2>
      <Rise delay={0.2} className={s.body}>
        Beluga works with the coding agents you already have. The one you pick here starts new conversations and answers your friends’ requests. Any conversation can switch to another.
      </Rise>
      <Glass radius={16} width="100%" className={s.rows}>
        <div role="radiogroup" aria-label="Your agent">
          {rows.map((row, i) => {
            const ready = row.state === 'ready';
            const on = ready && row.id === mine;
            return (
              <motion.div key={row.id} className={cx(s.row, s.agentRow)} data-on={on ? '' : undefined} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: EASE_OUT, delay: 0.25 + i * 0.06 }}>
                <button type="button" role="radio" aria-checked={on} aria-label={row.label} disabled={!ready} className={s.agentPick} onClick={() => choose(row)}>
                  <span className={s.agentRadio} aria-hidden="true">
                    {on ? <motion.span layoutId="agent-on" className={s.agentRadioOn} transition={SPRING} /> : null}
                  </span>
                  <Icon name={runtimeMark(row.id)} size={20} className={s.agentMark} />
                  <span className={s.rowText}>
                    <span className={s.rowLabel}>
                      {row.label}
                      <span className={s.grant} data-grant={ready ? 'granted' : undefined} data-testid={`agent-state-${row.id}`}>
                        {ready ? <Icon name="check" size={10} /> : null}
                        {row.words}
                      </span>
                    </span>
                    <span className={s.rowDetail}>{row.detail}</span>
                  </span>
                </button>
                {row.fix === 'install' ? <CopyCommand className={s.agentCommand} runtime={row.id} /> : null}
                {row.fix ? (
                  <button type="button" className={cx(s.input, s.rowButton)} onClick={() => act(row)}>
                    {fixLabel(row)}
                  </button>
                ) : null}
              </motion.div>
            );
          })}
        </div>
      </Glass>
      <Rise delay={0.5} className={s.agentsBar}>
        <span>{!asked ? 'Looking for your agents…' : `${anyReady ? 'Change it any time in Settings › Agent.' : 'None of your agents is ready yet. Sign in to one now, or go on and set one up later in Settings › Agent.'} More agents, Antigravity, Cursor, Gemini CLI and others, are added there under ACP agents.`}</span>
        <button type="button" className={s.agentsCheck} disabled={checking} onClick={() => void check()}>
          <Icon name="refresh" size={12} />
          {checking ? 'Checking…' : 'Check Again'}
        </button>
      </Rise>
    </div>
  );
}
