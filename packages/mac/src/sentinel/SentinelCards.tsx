import { useMemo, useRef, useState } from 'react';
import {
  type AfterTrigger,
  type ClaudeStep,
  type FriendStep,
  type HttpStep,
  type MergeStep,
  type MessageStep,
  type NotifyStep,
  type PrStep,
  type ScheduleTrigger,
  type ScriptStep,
  type Sentinel,
  type SentinelPatch,
  type Step,
  type TriggerStep,
  DAY_NAMES,
  SERVICE_PRESETS,
  STEP_INFO,
  accessAllows,
  ordinal,
  presetFields,
  frequentAgentNote,
  scheduleSentence,
  stepAvailable,
  stepRefusal,
  stepSentence,
  SCRIPT_LANGUAGES,
  SCRIPT_LANGUAGE_INFO,
  type ScriptLanguage,
} from '@beluga/core/sentinel/model.js';
import { Checkbox, TextArea, TextInput } from '../components/FormSheet.js';
import { CodeEditor } from '../components/markdown/CodeEditor.js';
import { Icon } from '../components/Icon.js';
import { Select } from '../components/Select.js';
import { useAgentEntries } from '../components/agent-options.js';
import { type ActionItem, ActionsDropdown } from '../components/SpecMenu.js';
import { Button, IconButton, Segmented } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { openSheet } from '../lib/sheets.js';
import {
  AFTER_ON,
  CLAUDE_PRESETS,
  EVERY_CHOICES,
  INTERVAL_CHOICES,
  LATER,
  STEP_ICON,
  TEMPLATE_HELP,
  HTTP_METHODS,
  SECRETS_NOTE,
  SERVICE_CHOICES,
  WEEK,
  chatChoices,
  duplicateStep,
  headerRows,
  mergeWords,
  moveStep,
  newStep,
  otherSentinels,
  patchStep,
  rowsToHeaders,
  stepChoices,
  toggleDay,
  triggerChoices,
  triggerOfKind,
  withEvery,
  everySegment,
  intervalOf,
  withInterval,
  agentFields,
  stepAgentChoice,
} from './sentinel-model.js';
import { EventControls } from './EventControls.js';
import { MeasureFields } from './MeasureFields.js';
import { useDraft } from './use-draft.js';
import { sentinelGraph } from '@beluga/core/sentinel/workflow.js';
import { GraphBlock } from '../components/graph/GraphBlock.js';
import s from './sentinel.module.css';
import { ASSISTANT_TITLE, THIS_COMPUTER } from '@beluga/shared/assistant.js';
import { computerWord } from '../lib/os-words.js';

/** The sentinel page's editor: When it runs, and its Steps. Everything saves as you change it. */

export type Save = (patch: SentinelPatch) => void;

const nameOf =
  (items: readonly Sentinel[]) =>
  (id: string): string | undefined =>
    items.find((i) => i.id === id)?.name;

export function WhenCard({ item, save }: { item: Sentinel; save: Save }) {
  const items = useApp((st) => st.sentinel.items);
  const t = item.trigger;
  const choices = triggerChoices();
  return (
    <section className={s.card} aria-label="When">
      <header className={s.cardHead}>
        <h3 className={s.cardTitle}>When</h3>
      </header>
      <p className={s.sentence} data-testid="sentinel-sentence">
        {scheduleSentence(t, nameOf(items))}
      </p>
      <div className={s.controls}>
        <div className={s.controlRow}>
          <span className={s.controlLabel}>What starts it</span>
          <Select
            label="What starts it"
            size="small"
            value={t.kind}
            options={choices}
            onChange={(k) => {
              const next = triggerOfKind(k, t);
              if (next) save({ trigger: next });
            }}
          />
        </div>
        {t.kind === 'schedule' ? <ScheduleControls t={t} item={item} save={save} /> : null}
        {t.kind === 'manual' ? <p className={s.hint}>It runs only when you press Run Now: here, on its row, or from your phone.</p> : null}
        {t.kind === 'after' ? <AfterControls t={t} item={item} items={items} save={save} /> : null}
        {t.kind !== 'schedule' && t.kind !== 'manual' && t.kind !== 'after' ? <EventControls item={item} save={save} /> : null}
      </div>
    </section>
  );
}

function AfterControls({ t, item, items, save }: { t: AfterTrigger; item: Sentinel; items: readonly Sentinel[]; save: Save }) {
  const others = otherSentinels(items, item.id);
  return (
    <>
      <div className={s.controlRow}>
        <span className={s.controlLabel}>After</span>
        {others.length ? (
          <Select label="After which sentinel" size="small" value={t.sentinelId} placeholder="Pick a sentinel" options={others} onChange={(sentinelId) => save({ trigger: { ...t, sentinelId } })} />
        ) : (
          <span className={s.hint}>There’s no other sentinel yet to follow.</span>
        )}
      </div>
      <div className={s.controlRow}>
        <span className={s.controlLabel}>Runs</span>
        <Select label="When it runs after it" size="small" value={t.on} options={AFTER_ON} onChange={(on) => save({ trigger: { ...t, on } })} />
      </div>
      <p className={s.hint}>It starts when that one’s run ends, with its last output as what fired it ({'{{trigger}}'}, {'{{trigger.json}}'}). It doesn’t run while paused.</p>
    </>
  );
}

function ScheduleControls({ t, item, save }: { t: ScheduleTrigger; item: Sentinel; save: Save }) {
  const set = (next: ScheduleTrigger): void => save({ trigger: next });
  const often = t.every === 'hours' || t.every === 'minutes';
  const heavy = frequentAgentNote({ trigger: t, steps: item.steps, limits: item.limits });
  return (
    <>
      <div className={s.every}>
        <Segmented label="How often" value={everySegment(t)} onChange={(every) => (every === everySegment(t) ? undefined : set(withEvery(t, every)))} options={EVERY_CHOICES} />
      </div>
      {often ? (
        <div className={s.controlRow}>
          <span className={s.controlLabel}>Every</span>
          <Select label="Every how long" size="small" value={intervalOf(t)} options={INTERVAL_CHOICES} onChange={(v) => set(withInterval(t, v))} />
        </div>
      ) : (
        <div className={s.controlRow}>
          <span className={s.controlLabel}>At</span>
          <input
            type="time"
            className={s.time}
            aria-label="At what time"
            value={t.at}
            onChange={(e) => {
              if (/^\d{2}:\d{2}$/.test(e.target.value)) set({ ...t, at: e.target.value });
            }}
          />
        </div>
      )}
      {t.every === 'week' ? (
        <div className={s.controlRow}>
          <span className={s.controlLabel}>On</span>
          <span className={s.days} role="group" aria-label="Days of the week">
            {WEEK.map((d) => {
              const on = (t.days?.length ? t.days : [1]).includes(d);
              return (
                <button key={d} type="button" className={s.day} aria-pressed={on} onClick={() => set({ ...t, days: toggleDay(t.days, d) })}>
                  {DAY_NAMES[d]}
                </button>
              );
            })}
          </span>
        </div>
      ) : null}
      {t.every === 'month' ? (
        <div className={s.controlRow}>
          <span className={s.controlLabel}>On the</span>
          <Select label="Day of the month" size="small" value={String(t.day ?? 1)} options={Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: ordinal(i + 1) }))} onChange={(d) => set({ ...t, day: Number(d) })} />
        </div>
      ) : null}
      <div className={s.controlRow}>
        <span className={s.controlLabel}>If my {computerWord()} was asleep</span>
        <Select
          label={`If my ${computerWord()} was asleep`}
          size="small"
          value={t.missed}
          options={[
            { value: 'catch-up', label: 'Run as soon as it wakes', description: 'Once, however many runs it missed' },
            { value: 'skip', label: 'Skip that run', description: 'It waits for the next one' },
          ]}
          onChange={(missed) => set({ ...t, missed })}
        />
      </div>
      {heavy ? <p className={s.hint}>{heavy}</p> : null}
    </>
  );
}

export function StepsCard({ item, save }: { item: Sentinel; save: Save }) {
  const items = useApp((st) => st.sentinel.items);
  const [open, setOpen] = useState<string>();
  const latest = useRef(item);
  latest.current = item;
  const setSteps = (steps: Parameters<Save>[0]['steps']): void => save({ steps });
  const change = (id: string, patch: Partial<Step>): void => setSteps(patchStep(latest.current.steps, id, patch));
  const add: ActionItem[] = stepChoices(item.access).map((c) => ({
    label: c.label,
    icon: STEP_ICON[c.kind],
    hint: c.hint,
    disabled: c.disabled,
    onSelect: () => {
      if (c.disabled) return;
      setSteps([...latest.current.steps, newStep(c.kind)]);
      // The new one opens (its id comes back from the daemon: open the last one then).
      setOpen('last');
    },
  }));
  const steps = item.steps;
  const [look, setLook] = useState<'list' | 'graph'>('list');
  return (
    <section className={s.card} aria-label="Steps">
      <header className={s.cardHead}>
        <h3 className={s.cardTitle}>Steps</h3>
        <span className={s.grow} />
        {steps.length ? (
          <Segmented<'list' | 'graph'>
            label="Show the steps as"
            value={look}
            onChange={setLook}
            options={[
              { value: 'list', label: 'List', icon: 'rows' },
              { value: 'graph', label: 'Graph', icon: 'graph' },
            ]}
          />
        ) : null}
      </header>
      {look === 'graph' && steps.length ? (
        <WorkflowGraph item={item} />
      ) : steps.length ? (
        <div className={s.steps} role="list">
          {steps.map((st, i) => (
            <StepItem
              key={st.id}
              step={st}
              index={i}
              count={steps.length}
              open={open === st.id || (open === 'last' && i === steps.length - 1)}
              toggle={() => setOpen(open === st.id || (open === 'last' && i === steps.length - 1) ? undefined : st.id)}
              item={item}
              nameOf={nameOf(items)}
              change={(patch) => change(st.id, patch)}
              move={(by) => setSteps(moveStep(latest.current.steps, i, by))}
              duplicate={() => setSteps(duplicateStep(latest.current.steps, i))}
              remove={() => setSteps(latest.current.steps.filter((x) => x.id !== st.id))}
            />
          ))}
        </div>
      ) : (
        <p className={s.empty}>No steps yet. Add what it does, in order: ask your agent, run a script, call a service, tell you.</p>
      )}
      <div className={s.addStep}>
        <ActionsDropdown items={add} align="start">
          <Button size="small" icon="plus">
            Add a Step
          </Button>
        </ActionsDropdown>
      </div>
    </section>
  );
}

/**
 * The steps as a workflow (BLG-352): what starts it, each step with what it hands the next, where its
 * results land (dashboards, other sentinels), and its last run's states. A node's card says what it does.
 */
function WorkflowGraph({ item }: { item: Sentinel }) {
  const items = useApp((st) => st.sentinel.items);
  const runs = useApp((st) => st.sentinel.runs);
  const dashboards = useApp((st) => st.sentinel.dashboards);
  const run = useMemo(() => [...runs].reverse().find((r) => r.sentinelId === item.id), [runs, item.id]);
  const graph = useMemo(() => sentinelGraph(item, { items, ...(run ? { run } : {}), ...(dashboards ? { dashboards } : {}) }), [item, items, run, dashboards]);
  // Its layout follows its nodes and lines; a run moving along only recolours them.
  const shape = JSON.stringify([graph.nodes.map((n) => [n.id, n.label]), graph.edges.map((e) => e.id)]);
  return (
    <div className={s.workflow}>
      <GraphBlock code={JSON.stringify(graph)} shapeKey={shape} />
    </div>
  );
}

function StepItem({
  step,
  index,
  count,
  open,
  toggle,
  item,
  nameOf,
  change,
  move,
  duplicate,
  remove,
}: {
  step: Step;
  index: number;
  count: number;
  open: boolean;
  toggle: () => void;
  item: Sentinel;
  nameOf: (id: string) => string | undefined;
  change: (patch: Partial<Step>) => void;
  move: (by: number) => void;
  duplicate: () => void;
  remove: () => void;
}) {
  const name = useDraft(step.name, (v) => {
    const next = v.replace(/\s+/g, ' ').trim();
    if (next && next !== step.name) change({ name: next });
  });
  const later = !stepAvailable(step.kind);
  const menu: ActionItem[] = [
    { label: 'Move Up', icon: 'up', disabled: index === 0, onSelect: () => move(-1) },
    { label: 'Move Down', icon: 'chevronDown', disabled: index === count - 1, onSelect: () => move(1) },
    { label: 'Duplicate', icon: 'copy', separate: true, disabled: later, onSelect: duplicate },
    { label: 'Remove', danger: true, separate: true, onSelect: remove },
  ];
  return (
    <div className={s.step} role="listitem" data-step={step.kind}>
      <div
        className={s.stepRow}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('input, button')) return;
          if (!later) toggle();
        }}
      >
        <span className={s.stepIndex}>{index + 1}</span>
        <span className={s.chip} data-kind={step.kind} aria-hidden="true">
          <Icon name={STEP_ICON[step.kind]} size={11} />
        </span>
        <span className={s.stepText}>
          <input
            className={s.stepName}
            value={name.text}
            aria-label={`Step ${index + 1}’s name`}
            spellCheck={false}
            onChange={(e) => name.change(e.target.value)}
            onBlur={name.flush}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
          />
          <span className={s.stepLine}>
            {STEP_INFO[step.kind].label} · {stepSentence(step, nameOf)}
          </span>
          {later ? <span className={s.stepLater}>{LATER}: a run stops here until then.</span> : null}
        </span>
        {later ? null : <IconButton icon={open ? 'chevronUp' : 'chevronDown'} label={open ? 'Fold' : 'Show its fields'} onClick={toggle} aria-expanded={open} />}
        <ActionsDropdown items={menu}>
          <IconButton icon="more" label={`More for “${step.name}”`} />
        </ActionsDropdown>
      </div>
      {open && !later ? (
        <div className={s.stepFields}>
          {step.kind === 'claude' ? <ClaudeFields step={step} item={item} change={change} /> : null}
          {step.kind === 'script' ? <ScriptFields step={step} change={change} /> : null}
          {step.kind === 'notify' ? <NotifyFields step={step} change={change} /> : null}
          {step.kind === 'http' ? <HttpFields step={step} change={change} /> : null}
          {step.kind === 'pr' ? <PrFields step={step} change={change} /> : null}
          {step.kind === 'merge' ? <MergeFields step={step} change={change} /> : null}
          {step.kind === 'message' ? <MessageFields step={step} change={change} /> : null}
          {step.kind === 'friend' ? <FriendFields step={step} change={change} /> : null}
          {step.kind === 'trigger' ? <TriggerFields step={step} item={item} change={change} /> : null}
          {step.kind === 'measure' ? <MeasureFields step={step} change={change} /> : null}
        </div>
      ) : null}
    </div>
  );
}

const WHERE_INFO: ReadonlyArray<{ readonly value: ClaudeStep['where']; readonly label: string; readonly description: string }> = [
  { value: 'project', label: 'In the project', description: 'A new chat in the project’s main folder; the agent reads and reports, never changes files' },
  { value: 'worktree', label: 'In a new worktree', description: 'Its own branch: the agent edits, commits and runs the tests; later steps share it' },
  { value: 'mac', label: `On ${ASSISTANT_TITLE}`, description: `A chat in ${ASSISTANT_TITLE}, for things about ${THIS_COMPUTER} itself` },
];

function ClaudeFields({ step, item, change }: { step: ClaudeStep; item: Sentinel; change: (patch: Partial<ClaudeStep>) => void }) {
  const agents = useAgentEntries();
  const prompt = useDraft(step.prompt, (v) => v !== step.prompt && change({ prompt: v }));
  const where = WHERE_INFO.find((w) => w.value === step.where);
  return (
    <>
      <div className={s.field}>
        <span className={s.fieldLabel}>What the agent does</span>
        <div className={s.presets} role="group" aria-label="Start from">
          {CLAUDE_PRESETS.map((p) => (
            <button key={p.id} type="button" className={s.preset} onClick={() => prompt.change(p.prompt)}>
              {p.label}
            </button>
          ))}
        </div>
        <TextArea className={s.prompt} value={prompt.text} onChange={prompt.change} onBlur={prompt.flush} rows={6} aria-label="The agent’s prompt" placeholder="What should your agent do each run? Say when to stop: “If nothing changed, say so and stop.”" />
        <span className={s.help}>{TEMPLATE_HELP}</span>
      </div>
      <div className={s.controlRow}>
        <span className={s.controlLabel}>Where</span>
        <Select
          label="Where the agent runs"
          size="small"
          value={step.where}
          options={WHERE_INFO.map((w) => {
            const why = stepRefusal(item.access, 'claude', w.value);
            return { value: w.value, label: w.label, description: why ?? w.description, disabled: !accessAllows(item.access, 'claude', w.value) };
          })}
          onChange={(w) => change({ where: w })}
        />
      </div>
      {where ? <p className={s.hint}>{where.description}.</p> : null}
      <div className={s.controlRow}>
        <span className={s.controlLabel}>Agent</span>
        {/* Which agent and model does it (BLG-497): the run's chat or worktree runs it for this step. */}
        <Select label="Agent and model" size="small" value={stepAgentChoice(step)} options={agents} onChange={(v) => change(agentFields(v))} />
      </div>
      {step.where === 'mac' && stepAgentChoice(step) ? <p className={s.hint}>On {ASSISTANT_TITLE}, your default agent does it: pick In the project or In a new worktree for this one.</p> : null}
    </>
  );
}

const TIMEOUTS = [30, 60, 120, 300, 600, 900, 1800, 3600] as const;
const timeoutLabel = (sec: number): string => (sec < 60 ? `${sec} seconds` : sec < 3600 ? `${sec / 60} minute${sec === 60 ? '' : 's'}` : '1 hour');

/** What a new script starts as, by language: it prints what the next step reads. */
const STARTER: Readonly<Record<ScriptLanguage, string>> = {
  python: 'import json, os\n\n# What you print is what the next step reads (a number, JSON or CSV).\nprint(json.dumps({"value": 42}))\n',
  node: '// What you print is what the next step reads (a number, JSON or CSV).\nconsole.log(JSON.stringify({ value: 42 }));\n',
  bash: '# What you print is what the next step reads (a number, JSON or CSV).\necho 42\n',
  sh: '# What you print is what the next step reads (a number, JSON or CSV).\necho 42\n',
  zsh: '# What you print is what the next step reads (a number, JSON or CSV).\necho 42\n',
  ruby: '# What you print is what the next step reads (a number, JSON or CSV).\nrequire "json"\nputs({ value: 42 }.to_json)\n',
  perl: '# What you print is what the next step reads (a number, JSON or CSV).\nprint "42\\n";\n',
};

function ScriptFields({ step, change }: { step: ScriptStep; change: (patch: Partial<ScriptStep>) => void }) {
  const command = useDraft(step.command, (v) => v !== step.command && change({ command: v }));
  const code = useDraft(step.code ?? '', (v) => v !== (step.code ?? '') && change({ code: v }));
  const own = step.code !== undefined;
  const language = step.language ?? 'sh';
  const timeouts: number[] = TIMEOUTS.includes(step.timeoutSec as (typeof TIMEOUTS)[number]) ? [...TIMEOUTS] : [...TIMEOUTS, step.timeoutSec].sort((a, b) => a - b);
  // Its own code (BLG-350), or one shell line. Going back to a line keeps nothing of the script.
  const setMode = (mode: 'command' | 'script'): void => {
    if (mode === 'script') change({ code: step.code ?? STARTER.python, language: step.language ?? 'python', command: '' });
    else {
      const { code: _c, language: _l, ...rest } = step;
      change({ ...rest, code: undefined, language: undefined } as Partial<ScriptStep>);
    }
  };
  return (
    <>
      <div className={s.controlRow}>
        <span className={s.controlLabel}>It runs</span>
        <Segmented<'command' | 'script'>
          label="It runs"
          value={own ? 'script' : 'command'}
          onChange={setMode}
          options={[
            { value: 'command', label: 'A command' },
            { value: 'script', label: 'Its own script' },
          ]}
        />
      </div>
      {own ? (
        <>
          <div className={s.controlRow}>
            <span className={s.controlLabel}>Language</span>
            <Select label="Language" size="small" value={language} options={SCRIPT_LANGUAGES.map((l) => ({ value: l, label: SCRIPT_LANGUAGE_INFO[l].label }))} onChange={(l) => change({ language: l })} />
          </div>
          <div className={s.field}>
            <span className={s.fieldLabel}>Script</span>
            <CodeEditor value={code.text} onChange={code.change} onBlur={code.flush} lang={language} minRows={8} aria-label="Script" />
            <span className={s.help}>
              Runs with {SCRIPT_LANGUAGE_INFO[language].run} in the folder below. What it prints is what the next step reads (a number, JSON or CSV); a non-zero exit stops the run. It gets $VAR from Settings › Environment, $SENTINEL_PREVIOUS (the step before’s output), $SENTINEL_PREVIOUS_FILE and $SENTINEL_RUN_DIR.
            </span>
          </div>
          <div className={s.field}>
            <span className={s.fieldLabel}>Arguments</span>
            <TextInput value={command.text} onChange={command.change} onBlur={command.flush} mono placeholder="--since yesterday" aria-label="Arguments" />
          </div>
        </>
      ) : (
        <div className={s.field}>
          <span className={s.fieldLabel}>Command</span>
          <CodeEditor value={command.text} onChange={command.change} onBlur={command.flush} lang="bash" single placeholder="npm test" aria-label="Command" />
          <span className={s.help}>One shell line or a script’s path; a non-zero exit stops the run. $VAR from Settings › Environment; $SENTINEL_PREVIOUS has the step before’s output, and $SENTINEL_PREVIOUS_FILE the file it’s in.</span>
        </div>
      )}
      <div className={s.controlRow}>
        <span className={s.controlLabel}>Runs in</span>
        <Select
          label="Runs in"
          size="small"
          value={step.cwd}
          options={[
            { value: 'project', label: 'The project’s main folder' },
            { value: 'home', label: 'Your home folder' },
          ]}
          onChange={(cwd) => change({ cwd })}
        />
      </div>
      <div className={s.controlRow}>
        <span className={s.controlLabel}>Stop it after</span>
        <Select label="Stop it after" size="small" value={String(step.timeoutSec)} options={timeouts.map((n) => ({ value: String(n), label: timeoutLabel(n) }))} onChange={(v) => change({ timeoutSec: Number(v) })} />
      </div>
    </>
  );
}

function NotifyFields({ step, change }: { step: NotifyStep; change: (patch: Partial<NotifyStep>) => void }) {
  const title = useDraft(step.title ?? '', (v) => v !== (step.title ?? '') && change({ title: v }));
  const body = useDraft(step.body ?? '', (v) => v !== (step.body ?? '') && change({ body: v }));
  return (
    <>
      <div className={s.field}>
        <span className={s.fieldLabel}>Title</span>
        <TextInput value={title.text} onChange={title.change} onBlur={title.flush} placeholder="{{sentinel}} (the sentinel’s name)" aria-label="Title" />
      </div>
      <div className={s.field}>
        <span className={s.fieldLabel}>Says</span>
        <TextArea value={body.text} onChange={body.change} onBlur={body.flush} rows={2} placeholder="The report’s first line" aria-label="What it says" />
        <span className={s.help}>{TEMPLATE_HELP}</span>
      </div>
      <Checkbox checked={step.phone} onChange={(phone) => change({ phone })} label="On my phone too" detail="With the report, if your phone is paired" />
    </>
  );
}

// ---------------------------------------------------------------- Call a service

function HttpFields({ step, change }: { step: HttpStep; change: (patch: Partial<HttpStep>) => void }) {
  const url = useDraft(step.url, (v) => v !== step.url && change({ url: v }));
  const body = useDraft(step.body ?? '', (v) => v !== (step.body ?? '') && change({ body: v }));
  const preset = step.preset ?? 'url';
  const note = SERVICE_PRESETS[preset].note;
  const timeouts: number[] = [10, 30, 60, 120, 300, 600].includes(step.timeoutSec) ? [10, 30, 60, 120, 300, 600] : [10, 30, 60, 120, 300, 600, step.timeoutSec].sort((a, b) => a - b);
  return (
    <>
      <div className={s.controlRow}>
        <span className={s.controlLabel}>Service</span>
        <Select label="Service" size="small" value={preset} options={SERVICE_CHOICES} onChange={(p) => change(p === 'url' ? { preset: 'url' } : presetFields(p))} />
      </div>
      {note ? <p className={s.hint}>{note}</p> : null}
      <div className={s.field}>
        <span className={s.fieldLabel}>Address</span>
        <div className={s.urlRow}>
          <Select label="Method" size="small" value={step.method} options={HTTP_METHODS.map((m) => ({ value: m, label: m }))} onChange={(method) => change({ method })} />
          <TextInput className={s.grow} value={url.text} onChange={url.change} onBlur={url.flush} mono placeholder="https://api.example.com/search" aria-label="URL" />
        </div>
      </div>
      <Headers headers={step.headers} change={(headers) => change({ headers })} />
      {step.method !== 'GET' ? (
        <div className={s.field}>
          <span className={s.fieldLabel}>Body</span>
          <CodeEditor value={body.text} onChange={body.change} onBlur={body.flush} lang="json" placeholder={'{"query": "{{previous}}"}'} aria-label="Body" />
          <span className={s.help}>{TEMPLATE_HELP} (filled in as JSON text in a JSON body)</span>
        </div>
      ) : null}
      <div className={s.controlRow}>
        <span className={s.controlLabel}>Give up after</span>
        <Select label="Give up after" size="small" value={String(step.timeoutSec)} options={timeouts.map((n) => ({ value: String(n), label: timeoutLabel(n) }))} onChange={(v) => change({ timeoutSec: Number(v) })} />
      </div>
      <p className={s.hint}>{SECRETS_NOTE}.</p>
    </>
  );
}

/** Headers as name and value rows; a new row appears as the last one is filled. */
function Headers({ headers, change }: { headers: Readonly<Record<string, string>>; change: (headers: Record<string, string>) => void }) {
  const [rows, setRows] = useState(() => headerRows(headers));
  const latest = useRef(headers);
  // The daemon's copy changed under us (a preset): start again from it.
  if (latest.current !== headers && JSON.stringify(latest.current) !== JSON.stringify(headers)) {
    latest.current = headers;
    setRows(headerRows(headers));
  }
  const set = (i: number, patch: Partial<{ key: string; value: string }>): void => {
    const next = rows.map((r, n) => (n === i ? { ...r, ...patch } : r));
    setRows(next.at(-1)!.key || next.at(-1)!.value ? [...next, { key: '', value: '' }] : next);
  };
  const flush = (): void => {
    const next = rowsToHeaders(rows);
    if (JSON.stringify(next) !== JSON.stringify(headers)) {
      latest.current = next;
      change(next);
    }
  };
  return (
    <div className={s.field}>
      <span className={s.fieldLabel}>Headers</span>
      <div className={s.headers} role="list" aria-label="Headers">
        {rows.map((r, i) => (
          <div key={i} className={s.headerRow} role="listitem">
            <TextInput value={r.key} onChange={(key) => set(i, { key })} onBlur={flush} mono placeholder="Authorization" aria-label={`Header ${i + 1}’s name`} />
            <TextInput value={r.value} onChange={(value) => set(i, { value })} onBlur={flush} mono placeholder="Bearer $API_KEY" aria-label={`Header ${i + 1}’s value`} />
            {r.key || r.value ? (
              <IconButton
                icon="x"
                label={`Remove ${r.key || 'this header'}`}
                onClick={() => {
                  const next = rows.filter((_, n) => n !== i);
                  setRows(next);
                  const h = rowsToHeaders(next);
                  latest.current = h;
                  change(h);
                }}
              />
            ) : (
              <span className={s.headerSpacer} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- pull requests

function PrFields({ step, change }: { step: PrStep; change: (patch: Partial<PrStep>) => void }) {
  return (
    <>
      <Checkbox checked={Boolean(step.draft)} onChange={(draft) => change({ draft })} label="Open it as a draft" detail="For you to look at first; a draft can’t be merged by a later step" />
      <p className={s.hint}>From the worktree an earlier Ask Your Agent step made (in a new worktree), with your pull request instructions. Without one, the run stops here.</p>
    </>
  );
}

function MergeFields({ step, change }: { step: MergeStep; change: (patch: Partial<MergeStep>) => void }) {
  const setApproval = (approval: boolean): void => {
    if (approval) return change({ require: { checks: true, approval: true } });
    openSheet({
      kind: 'confirm',
      title: 'Merge without asking?',
      message: 'This sentinel will merge its pull request by itself once every check passes and the agent’s review says ship. A hold still asks you. You can turn asking back on here any time.',
      confirm: 'Merge Without Asking',
      destructive: true,
      run: () => change({ require: { checks: true, approval: false } }),
    });
  };
  return (
    <>
      <Checkbox checked={step.require.approval} onChange={setApproval} label="Ask me before merging" detail={`A card on the ${computerWord()} and your phone, with Merge and Not Now; unanswered for a day, the run stops`} />
      <div className={s.controlRow}>
        <span className={s.controlLabel}>Merge as</span>
        <Select
          label="Merge as"
          size="small"
          value={step.method}
          options={[
            { value: 'squash', label: 'One squashed commit', description: 'gh pr merge --squash' },
            { value: 'merge', label: 'A merge commit', description: 'gh pr merge --merge' },
          ]}
          onChange={(method) => change({ method })}
        />
      </div>
      <p className={s.hint}>{mergeWords(step)} The pull request must not be a draft or conflict; after merging, its worktree is archived.</p>
    </>
  );
}

// ---------------------------------------------------------------- chats, friends, other sentinels

function MessageFields({ step, change }: { step: MessageStep; change: (patch: Partial<MessageStep>) => void }) {
  const network = useApp((st) => st.network);
  const text = useDraft(step.text, (v) => v !== step.text && change({ text: v }));
  const chats = chatChoices(network);
  return (
    <>
      <div className={s.controlRow}>
        <span className={s.controlLabel}>Writes in</span>
        {chats.length ? (
          <Select label="Which chat" size="small" value={step.to} placeholder="Pick a chat" options={chats} onChange={(to) => change({ to })} />
        ) : (
          <span className={s.hint}>{network.enabled ? 'No friends or groups yet: add a friend in People.' : 'Turn on the Beluga network in Settings to message friends and groups.'}</span>
        )}
      </div>
      <div className={s.field}>
        <span className={s.fieldLabel}>Message</span>
        <TextArea value={text.text} onChange={text.change} onBlur={text.flush} rows={3} placeholder="{{sentinel}}: {{previous}}" aria-label="Message" />
        <span className={s.help}>{TEMPLATE_HELP}; @name tags someone and tells them</span>
      </div>
    </>
  );
}

function FriendFields({ step, change }: { step: FriendStep; change: (patch: Partial<FriendStep>) => void }) {
  const friends = useApp((st) => st.network.friends);
  const prompt = useDraft(step.prompt, (v) => v !== step.prompt && change({ prompt: v }));
  const project = useDraft(step.project ?? '', (v) => v !== (step.project ?? '') && change({ project: v || undefined }));
  return (
    <>
      <div className={s.controlRow}>
        <span className={s.controlLabel}>Whose agent</span>
        {friends.length ? (
          <Select label="Whose agent" size="small" value={step.peerId} placeholder="Pick a friend" options={[...friends].sort((a, b) => a.name.localeCompare(b.name)).map((f) => ({ value: f.peerId, label: f.name }))} onChange={(peerId) => change({ peerId })} />
        ) : (
          <span className={s.hint}>No friends yet: add one in People.</span>
        )}
      </div>
      <div className={s.field}>
        <span className={s.fieldLabel}>What to ask</span>
        <TextArea value={prompt.text} onChange={prompt.change} onBlur={prompt.flush} rows={4} placeholder="Is staging up? Look at its logs since {{date}} and say what’s wrong." aria-label="What to ask" />
        <span className={s.help}>{TEMPLATE_HELP}</span>
      </div>
      <div className={s.controlRow}>
        <span className={s.controlLabel}>In their project</span>
        <TextInput value={project.text} onChange={project.change} onBlur={project.flush} placeholder="Any (their choice)" aria-label="Their project" />
      </div>
      <p className={s.hint}>Asked as you; their trust in you decides what their agent may do. Their answer is this step’s output.</p>
    </>
  );
}

function TriggerFields({ step, item, change }: { step: TriggerStep; item: Sentinel; change: (patch: Partial<TriggerStep>) => void }) {
  const items = useApp((st) => st.sentinel.items);
  const others = otherSentinels(items, item.id);
  return (
    <>
      <div className={s.controlRow}>
        <span className={s.controlLabel}>Runs</span>
        {others.length ? <Select label="Which sentinel" size="small" value={step.sentinelId} placeholder="Pick a sentinel" options={others} onChange={(sentinelId) => change({ sentinelId })} /> : <span className={s.hint}>There’s no other sentinel yet.</span>}
      </div>
      <p className={s.hint}>It starts that one with this run’s last output and goes on without waiting for it. A paused one doesn’t start.</p>
    </>
  );
}
