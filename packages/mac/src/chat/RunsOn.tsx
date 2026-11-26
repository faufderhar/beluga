import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { type NativeRow, nativeDropdown } from '../lib/native-menu.js';
import { FitContent } from '../components/SpecMenu.js';
import { useSyncExternalStore } from 'react';
import type { MachineView } from '@beluga/machines/machines.js';
import { Icon } from '../components/Icon.js';
import { Tip, cx } from '../components/ui.js';
import m from '../components/SpecMenu.module.css';
import { useApp, useBeluga, useMachine } from '../lib/beluga.js';
import { thisComputer, upFirst } from '../lib/os-words.js';
import { MachineMark } from '../machines/MachineMark.js';
import { BEST, HERE, type RunsOn, rememberPick, runsOnName, runsOnRows, startingPick } from '../machines/runs-on-model.js';
import { useMachines } from '../machines/use-machines.js';
import { myRuntime } from './ModelPicker.js';
import s from './composer.module.css';
import r from './runs-on.module.css';

/**
 * Runs on [icon] [name] (BLG-786): where new work goes, beside the mode and model wherever work is
 * made. It starts from Settings' Run New Work On and remembers the last pick per project. Only
 * when you have a computer paired: without one, nothing here shows and nothing changes.
 */

const KEY = 'beluga.runsOn.v1';
let picks: Readonly<Record<string, RunsOn>> = read();
const listeners = new Set<() => void>();

function read(): Record<string, RunsOn> {
  try {
    const raw: unknown = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '{}');
    if (!raw || typeof raw !== 'object') return {};
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch {
    return {};
  }
}

function pick(project: string, value: RunsOn): void {
  picks = rememberPick(picks, project, value);
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(picks));
  } catch {
    // Not kept past this window (private storage): the pick still holds while it's open.
  }
  for (const l of [...listeners]) l();
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** The project a pick is kept under: work outside a project (Your Mac's, New Sentinel's) is `mac`. */
const projectKey = (project: string | undefined): string => project || 'mac';

/** Where new work in `project` runs now: its last pick, else Run New Work On (src/ui/submit.ts reads it through BLG-788). */
export function runsOnFor(project: string | undefined, runOn: RunsOn, machines: readonly MachineView[]): RunsOn {
  return startingPick(picks[projectKey(project)], runOn, machines);
}

/** The pick for `project`, and how to change it. */
export function useRunsOn(project: string | undefined): { readonly value: RunsOn; readonly set: (v: RunsOn) => void; readonly machines: readonly MachineView[] } {
  const { home } = useBeluga();
  const machines = useMachines(home);
  const runOn = useSyncExternalStore(home.store.subscribe, () => home.store.getState().prefs.runOn);
  const remembered = useSyncExternalStore(subscribe, () => picks[projectKey(project)]);
  return { value: startingPick(remembered, runOn, machines), set: (v) => pick(projectKey(project), v), machines };
}

/** A computer's mark, This Mac's laptop, or Best Available's gauge. */
function Mark({ value, machines }: { value: RunsOn; machines: readonly MachineView[] }) {
  const machine = machines.find((x) => x.id === value);
  if (machine) return <MachineMark machine={machine} size={12} />;
  return <Icon name={value === BEST ? 'gauge' : 'laptop'} size={12} />;
}

/**
 * The picker: "Runs on [icon] build-box", its menu headed Runs on. On a computer's own page
 * (BLG-784) new work there runs there: the label instead.
 */
export function RunsOnPicker({ project, runtime, folder, bare = false }: { project?: string; runtime?: string; /** A folder chat's folder, on this Mac (BLG-841). */ folder?: string; bare?: boolean }) {
  const machine = useMachine();
  const { value, set, machines } = useRunsOn(project);
  const agentRuntime = useApp((st) => runtime ?? myRuntime(st.prefs));
  if (!machines.length) return null;
  if (machine) return <RunsOnLabel />;
  const here = upFirst(thisComputer());
  const rows = runsOnRows(machines, agentRuntime, here);
  const name = runsOnName(value, machines, here);
  // The computer it names can't take it now, or the folder is this Mac's: said on the chip, and sending waits (BLG-841).
  const picked = machines.find((x) => x.id === value);
  const why = picked ? (rows.find((row) => row.value === value)?.disabled ? rows.find((row) => row.value === value)!.line : folder ? `this folder is on ${here}` : undefined) : undefined;
  // The Mac's own menu in the app (lib/native-menu.ts): "Runs on" as its section, each computer's
  // mark, and what it can do now as the line under it.
  const nativeRows = (): NativeRow[] =>
    rows.map((row, i) => ({
      label: row.label,
      hint: row.line,
      mark: row.machine ? <MachineMark machine={row.machine} size={13} /> : undefined,
      ...(row.machine ? {} : { icon: row.value === HERE ? ('laptop' as const) : ('gauge' as const) }),
      ...(row.disabled ? { disabled: true } : {}),
      ...(row.value === value ? { checked: true } : {}),
      ...(i === 0 ? { header: 'Runs on' } : {}),
      onSelect: () => set(row.value),
    }));
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild {...nativeDropdown(nativeRows)}>
        <button type="button" className={cx(s.chip, r.chip, bare && r.bare, why && r.held)} aria-label={`Runs on ${name}${why ? `: ${why}` : ''}`} title={why ? `Nothing starts until it can: ${why}` : undefined} data-runs-on={value}>
          {bare ? null : <span className={r.words} data-runs-on-words>Runs on</span>}
          <Mark value={value} machines={machines} />
          <span className={s.chipLabel}>{name}</span>
          {why ? <span className={r.why}>· {why}</span> : null}
          <Icon name="chevronDown" size={9} />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <FitContent className={cx(m.menu, r.menu)} align="start" aria-label="Runs on">
          <Dropdown.Label className={r.head}>Runs on</Dropdown.Label>
          {rows.map((row) => (
            <Dropdown.Item key={row.value} className={m.item} disabled={row.disabled} onSelect={() => set(row.value)} data-checked={row.value === value || undefined} aria-label={`${row.label}: ${row.line}`}>
              <span className={m.line}>
                <span className={r.mark}>{row.machine ? <MachineMark machine={row.machine} size={13} /> : <Icon name={row.value === HERE ? 'laptop' : 'gauge'} size={13} />}</span>
                <span className={m.label}>{row.label}</span>
                {row.value === value ? <Icon name="check" size={12} /> : null}
              </span>
              <span className={cx(m.hint, r.line)}>{row.line}</span>
            </Dropdown.Item>
          ))}
        </FitContent>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/**
 * Where this chat, plan or sentinel runs, as a label: the computer whose page it is, or This Mac.
 * Only when you have a computer paired.
 */
export function RunsOnLabel({ tip = 'New work can run elsewhere.' }: { tip?: string }) {
  const machine = useMachine();
  const { home } = useBeluga();
  const machines = useMachines(home);
  if (!machines.length) return null;
  const here = upFirst(thisComputer());
  const name = machine ? runsOnName(machine, machines, here) : here;
  return (
    <Tip label={tip}>
      <span className={cx(s.chip, r.chip, r.label)} aria-label={`Runs on ${name}`} data-runs-on={machine ?? HERE}>
        <span className={r.words} data-runs-on-words>Runs on</span>
        <Mark value={machine ?? HERE} machines={machines} />
        <span className={s.chipLabel}>{name}</span>
      </span>
    </Tip>
  );
}

/** The picker as a sheet's row ("Runs on" beside it), for New Plan and New Sentinel; nothing without a computer paired. */
export function RunsOnRow({ project, className, labelClassName }: { project?: string; className?: string; labelClassName?: string }) {
  const { home } = useBeluga();
  if (!useMachines(home).length) return null;
  return (
    <div className={className}>
      <span className={labelClassName}>Runs on</span>
      <RunsOnPicker {...(project ? { project } : {})} bare />
    </div>
  );
}
