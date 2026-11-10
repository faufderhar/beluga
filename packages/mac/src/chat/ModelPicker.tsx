import * as Popover from '@radix-ui/react-popover';
import { EFFORTS, type Effort } from '@beluga/shared/settings-schema.js';
import { useState } from 'react';
import type { AppState } from '@beluga/core/store.js';
import { type AgentRef, CLAUDE_AGENT } from '@beluga/protocol.js';
import { type HandoffMode, limitHit, needsHandoff } from '@beluga/shared/agent-handoff.js';
import { type AgentMark, modelMark, runtimeMark } from '@beluga/shared/agent-marks.js';
import { type AgentPicker, type PickerGroup, type PickerState, agentPicker, pickAction } from '@beluga/shared/agent-picker.js';
import type { RuntimeModel } from '@beluga/shared/agent-runtimes.js';
import type { AgentOption } from '@beluga/ui/agent-choice.js';
import { Icon } from '../components/Icon.js';
import type { SelectEntry } from '../components/Select.js';
import { cx } from '../components/ui.js';
import { useApi, useApp } from '../lib/beluga.js';
import s from './picker.module.css';

type Api = ReturnType<typeof useApi>;
type Prefs = AppState['prefs'];

/** Your agent's runtime: it runs every conversation that picked none of its own, and answers @you (Claude until you pick another). */
export const myRuntime = (prefs: Prefs): string => prefs.defaultAgent?.runtime ?? CLAUDE_AGENT.runtime;

/** Your agent's model ('' its runtime's default): Claude's is the model setting, another runtime's comes with the agent. */
export function myModel(prefs: Prefs): string {
  const agent = prefs.defaultAgent;
  if (agent && agent.runtime !== CLAUDE_AGENT.runtime) return agent.model ?? '';
  return agent?.model ?? prefs.model ?? '';
}

/**
 * Makes `runtime` (with `model`) your agent. Claude's model stays in the model setting, where the
 * composer and the model sheet change it, so there's one place for it; another runtime's model
 * goes with the agent (the model setting is Claude's only).
 */
export function setMyAgent(api: Api, runtime: string, label: string, model: string): void {
  if (runtime === CLAUDE_AGENT.runtime) {
    void api.session.setPrefs({ defaultAgent: null });
    void api.workbench.setModel(undefined, model);
  } else void api.session.setPrefs({ defaultAgent: { runtime, label, ...(model ? { model } : {}) } });
}

/** The picker's view of the state: "your default model" is your agent's, whichever runtime it is. */
export const pickerState = (st: AppState): PickerState => ({ ...st, prefs: { model: myModel(st.prefs) || undefined, openModels: st.prefs.openModels } });

/** The effort a conversation shows: its own pick, else Settings’. Not a conversation: Settings’. */
export function shownEffort(st: Pick<AppState, 'projects' | 'prefs'>, channel: string): Effort | undefined {
  const id = channel.startsWith('ws:') ? channel.slice(3) : undefined;
  const own = id ? st.projects.flatMap((p) => p.workspaces).find((w) => w.id === id)?.effort : undefined;
  return own ?? st.prefs.effort;
}

/** A model's details (its effort levels) by runtime and value; Claude's come from Claude Code itself. */
export function modelInfo(st: Pick<AppState, 'runtimes' | 'models'>, runtime: string, model: string): RuntimeModel | undefined {
  const models = runtime === CLAUDE_AGENT.runtime ? st.models : (st.runtimes.find((r) => r.id === runtime)?.models ?? []);
  return models.find((m) => m.value === model);
}

/** The maker a runtime's models usually come from: its own models carry no second mark. */
const HOUSE: Readonly<Record<string, AgentMark>> = { claude: 'anthropic', codex: 'openai', opencode: 'opencode' };

/** A model's maker mark when it isn't its runtime's own (a local runtime serving a GPT model); else none. */
export function foreignMark(model: string, runtime: string): AgentMark | undefined {
  if (!model) return undefined;
  const mark = modelMark(model, runtime);
  return mark === (HOUSE[runtime] ?? 'localModel') ? undefined : mark;
}

/**
 * The agents (agentChoices) as a pop-up's entries: a section per runtime, each row with the
 * runtime's mark before its name. In a section a row says the model alone ("Opus"); the button
 * says both ("Claude · Opus"). A runtime that isn't set up is one greyed row saying what's missing.
 */
export function agentEntries(options: readonly AgentOption[]): SelectEntry<string>[] {
  const groups = [...new Set(options.map((o) => o.group))];
  return groups.map((group) => ({
    section: group,
    options: options
      .filter((o) => o.group === group)
      .map((o) => {
        const name = o.model ? o.label.slice(`${o.group} · `.length) || o.label : o.group;
        const why = o.why ?? (o.model ? undefined : o.disabled ? undefined : 'Its own default model');
        return { value: o.value, label: name, short: o.label, icon: o.mark, keywords: [o.group], ...(why ? { description: why } : {}), ...(o.disabled ? { disabled: true } : {}) };
      }),
  }));
}

/** Effort, in plain words, with what each level means (the same five steps for every agent). */
export const EFFORT_INFO: Record<Effort, { label: string; detail: string }> = {
  low: { label: 'Low', detail: 'Answers fast; best for small, clear asks' },
  medium: { label: 'Medium', detail: 'Thinks enough for most everyday work' },
  high: { label: 'High', detail: 'Takes its time on tricky changes' },
  xhigh: { label: 'Extra High', detail: 'Works hard problems through carefully' },
  max: { label: 'Max', detail: 'As much thinking as it can; slowest' },
};

/** A friendlier word for a model, from its name (Opus is the most capable, Haiku the fastest). */
function flavor(value: string, label: string, runtime: string): string {
  const v = `${value} ${label}`.toLowerCase();
  if (v.includes('opus')) return 'Most capable';
  if (v.includes('sonnet')) return 'Fast and capable';
  if (v.includes('haiku')) return 'Fastest';
  return value ? '' : `${runtime} chooses`;
}

export const samePicker = (a: AgentPicker, b: AgentPicker): boolean => JSON.stringify(a) === JSON.stringify(b);

/** What a move to another runtime needs to know of a conversation: whose session it holds, and whether its agent is at its plan limit. */
interface Carried {
  readonly live: boolean;
  readonly sessionRuntime?: string;
  readonly limited: boolean;
}

function carriedOf(st: AppState, channel: string): Carried {
  const id = channel.startsWith('ws:') ? channel.slice(3) : undefined;
  const ws = id ? st.projects.flatMap((p) => p.workspaces).find((w) => w.id === id) : undefined;
  if (!ws || (!ws.sessionId && !ws.forkFromSession)) return { live: false, limited: false };
  return { live: true, ...(ws.sessionRuntime ? { sessionRuntime: ws.sessionRuntime } : {}), limited: limitHit(st.log, channel) !== undefined };
}

const sameCarried = (a: Carried, b: Carried): boolean => a.live === b.live && a.sessionRuntime === b.sessionRuntime && a.limited === b.limited;

/** A move waiting on how (BLG-592): to an agent that can't read this conversation's session. */
interface Move {
  readonly agent: AgentRef | null;
  readonly to: string;
  readonly from: string;
}

/**
 * The agent for this conversation, and how hard it thinks, in one popover (BLG-446): your default
 * agent's models first, as rows with what they're good at; the other runtimes one tap away under
 * Other agents, each with its models, or greyed with what's missing. Effort is five steps with plain
 * names. `draft`: a new worktree's pick (it has no conversation yet), kept by the New Worktree box.
 */
export function ModelPicker({ channel, draft, onDraft }: { channel: string; draft?: AgentRef; onDraft?: (agent: AgentRef | undefined) => void }) {
  const api = useApi();
  // Only what the picker shows (not the whole state): not drawn again on every streamed event (KLD-48).
  const picker = useApp((st) => agentPicker(pickerState(st), channel, myRuntime(st.prefs), draft), samePicker);
  const globalEffort = useApp((st) => st.prefs.effort);
  // In an open chat the meter pins that conversation; elsewhere it is Settings, for every conversation.
  const place = useApp(
    (st) => {
      const id = channel.startsWith('ws:') ? channel.slice(3) : undefined;
      const ws = id ? st.projects.flatMap((p) => p.workspaces).find((w) => w.id === id) : undefined;
      return ws ? { inChat: true as const, effort: ws.effort } : { inChat: false as const, effort: undefined };
    },
    (a, b) => a.inChat === b.inChat && a.effort === b.effort,
  );
  const carried = useApp((st) => carriedOf(st, channel), sameCarried);
  const [others, setOthers] = useState(() => picker.groups.some((g) => !g.isDefault && g.current));
  const [move, setMove] = useState<Move>();
  const conversation = picker.conversation;
  const groups = picker.groups;
  const home = groups.find((g) => g.isDefault);
  const rest = groups.filter((g) => !g.isDefault);
  const model = groups.find((g) => g.current)?.models.find((m) => m.on);
  // Some models take only some effort levels.
  const allowed = new Set((model?.efforts ?? EFFORTS) as readonly string[]);
  const label = picker.label;
  const inChat = place.inChat;
  const pinned = inChat && place.effort !== undefined;
  // The chip says what the next message uses. The meter highlights a pin, or Settings when this isn’t a chat.
  const shown = pinned ? place.effort : globalEffort;
  const meter = pinned ? place.effort : inChat ? undefined : globalEffort;
  const chip = `${label}${shown ? ` · ${EFFORT_INFO[shown].label}` : ''}`;
  const pick = (g: PickerGroup, value: string): void => {
    if (onDraft && !conversation) {
      // A new worktree: your default's model is the default for new ones; another runtime is this worktree's own.
      if (g.isDefault) {
        onDraft(undefined);
        setMyAgent(api, g.runtime, g.label, value);
      } else onDraft({ runtime: g.runtime, label: g.label, ...(value ? { model: value } : {}) });
      return;
    }
    const action = pickAction(picker, g, value);
    // New conversations: your agent's model (Claude's is the model setting; another runtime's goes with the agent).
    if (action?.kind === 'model' && !conversation) setMyAgent(api, g.runtime, g.label, action.value);
    else if (action?.kind === 'model') void api.workbench.setModel(conversation, action.value);
    else if (action?.kind === 'agent' && conversation) {
      // The new agent can't read this conversation: you choose how it goes on (BLG-592).
      const live = { sessionId: 'live', ...(carried.sessionRuntime ? { sessionRuntime: carried.sessionRuntime } : {}) };
      if (carried.live && needsHandoff(live, g.runtime)) setMove({ agent: action.agent, to: g.label, from: groups.find((x) => x.current)?.label ?? 'Your agent' });
      else void api.workbench.setAgent(conversation, action.agent);
    }
  };
  const moveWith = (mode: HandoffMode): void => {
    if (move && conversation) void api.workbench.setAgent(conversation, move.agent, mode);
    setMove(undefined);
  };
  const rows = (g: PickerGroup) => (
    <div className={s.models} role="radiogroup" aria-label={`${g.label} models`}>
      {g.models.map((m) => {
        const maker = foreignMark(m.value, g.runtime);
        return (
          <button key={m.value || 'default'} type="button" role="radio" aria-checked={m.on} disabled={Boolean(m.why) && !m.on} title={m.why} className={cx(s.model, m.on && s.modelOn, m.why && s.modelOff)} onClick={() => pick(g, m.value)}>
            <span className={s.radio}>{m.on ? <Icon name="check" size={11} /> : null}</span>
            <span className={s.modelText}>
              <span className={s.modelName}>
                {maker ? <Icon name={maker} size={12} className={s.maker} /> : null}
                {m.label}
              </span>
              <span className={s.modelDesc}>{m.why ?? (m.description || flavor(m.value, m.label, g.label))}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
  // Narrow (a side panel): the effort alone, the whole of it in the tooltip; never two lines.
  const words = shown ? (
    <>
      <span className={s.chipModel}>{label} · </span>
      {EFFORT_INFO[shown].label}
    </>
  ) : (
    label
  );
  return (
    <Popover.Root onOpenChange={(open) => !open && setMove(undefined)}>
      <Popover.Trigger asChild>
        <button type="button" className={s.chip} aria-label="Agent, model and effort" title={chip} data-shrink="">
          <Icon name={runtimeMark(picker.runtime)} size={12} />
          <span className={s.chipText}>{words}</span>
          <Icon name="chevronDown" size={9} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={s.popover} side="top" align="start" sideOffset={8} collisionPadding={12}>
          {move ? (
            <MoveChoice move={move} limited={carried.limited} onPick={moveWith} onBack={() => setMove(undefined)} />
          ) : (
            <>
              <div className={s.heading}>
                {home ? <Icon name={runtimeMark(home.runtime)} size={12} className={s.mark} /> : null}
                {home?.label ?? 'Model'}
                <span className={s.scope}>{conversation ? 'for this conversation' : onDraft ? 'for this worktree' : 'for new conversations'}</span>
              </div>
              {home ? (home.available ? rows(home) : <div className={s.why}>{home.why}</div>) : null}
              {rest.length ? (
                <>
                  <button type="button" className={s.others} aria-expanded={others} onClick={() => setOthers(!others)}>
                    <Icon name={others ? 'chevronDown' : 'chevronRight'} size={10} />
                    Other agents
                  </button>
                  {others
                    ? rest.map((g) => (
                        <div key={g.runtime} className={cx(s.group, !g.available && s.groupOff)} aria-disabled={!g.available || undefined}>
                          <div className={s.groupName}>
                            <Icon name={runtimeMark(g.runtime)} size={11} className={s.mark} />
                            {g.label}
                          </div>
                          {g.available ? rows(g) : <div className={s.why}>{g.why}</div>}
                        </div>
                      ))
                    : null}
                </>
              ) : null}
              <div className={s.heading}>
                Thinking
                <span className={s.scope}>{pinned ? 'for this conversation' : inChat ? 'follows Settings' : 'for every conversation'}</span>
              </div>
              <div className={s.meterRow}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={inChat ? !pinned : !globalEffort}
                  className={cx(s.auto, (inChat ? !pinned : !globalEffort) && s.autoOn)}
                  onClick={() => (inChat ? void api.workbench.setEffort(channel, '') : void api.session.setPrefs({ effort: null }))}
                >
                  {inChat ? 'Settings' : 'Auto'}
                </button>
                <div className={s.meter} role="radiogroup" aria-label="Thinking effort">
                  {EFFORTS.map((e, i) => {
                    const level = meter ? EFFORTS.indexOf(meter) : -1;
                    return (
                      <button
                        key={e}
                        type="button"
                        role="radio"
                        aria-checked={meter === e}
                        disabled={!allowed.has(e)}
                        className={s.step}
                        onClick={() => (inChat ? void api.workbench.setEffort(channel, e) : void api.session.setPrefs({ effort: e }))}
                      >
                        <span className={cx(s.bar, i <= level && s.barOn)} style={{ height: 6 + i * 5 }} />
                        <span className={cx(s.stepLabel, meter === e && s.stepLabelOn)}>{EFFORT_INFO[e].label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className={s.effortDetail}>
                {pinned && place.effort ? (
                  <>
                    <strong>{EFFORT_INFO[place.effort].label}</strong> · {EFFORT_INFO[place.effort].detail}
                  </>
                ) : inChat ? (
                  <>
                    <strong>Settings</strong> · {globalEffort ? `Follows Settings (${EFFORT_INFO[globalEffort].label})` : 'Follows Settings, where your agent decides how much to think'}
                  </>
                ) : (
                  <>
                    <strong>{globalEffort ? EFFORT_INFO[globalEffort].label : 'Auto'}</strong> · {globalEffort ? EFFORT_INFO[globalEffort].detail : 'Your agent decides how much to think, case by case'}
                  </>
                )}
              </div>
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * Moving a conversation to an agent that can't read its session (BLG-592): switch now, the new
 * agent getting the recent conversation with your next message; or have the old agent write a
 * handoff note first, on its own plan. An agent at its plan limit can't write one.
 */
function MoveChoice({ move, limited, onPick, onBack }: { move: Move; limited: boolean; onPick: (mode: HandoffMode) => void; onBack: () => void }) {
  return (
    <>
      <div className={s.heading}>
        <button type="button" className={s.back} aria-label="Back to the models" onClick={onBack}>
          <Icon name="back" size={11} />
        </button>
        Move to {move.to}
      </div>
      <div className={s.why}>
        {move.to} can’t read {move.from}’s conversation, so it needs to be told where things stand.
      </div>
      <div className={s.models} role="group" aria-label={`How to move to ${move.to}`}>
        <button type="button" className={s.model} onClick={() => onPick('quiet')} autoFocus>
          <span className={s.choiceIcon}>
            <Icon name="arrowRight" size={12} />
          </span>
          <span className={s.modelText}>
            <span className={s.modelName}>Just switch</span>
            <span className={s.modelDesc}>Nothing runs now. {move.to} gets the recent conversation with your next message.</span>
          </span>
        </button>
        <button type="button" className={cx(s.model, limited && s.modelOff)} disabled={limited} onClick={() => onPick('note')}>
          <span className={s.choiceIcon}>
            <Icon name="pencil" size={12} />
          </span>
          <span className={s.modelText}>
            <span className={s.modelName}>Write a handoff note first</span>
            <span className={s.modelDesc}>{limited ? `${move.from} is at its plan limit, so it can’t write one.` : `${move.from} sums up what’s done and what’s left, using your ${move.from} plan.`}</span>
          </span>
        </button>
      </div>
    </>
  );
}
