import { type Graph, type GraphEdge, type GraphNode, type GraphStatus, type GraphStep, MAX_NODES, MAX_STEPS, cleanId } from '../../shared/graph-spec.js';
import { type Dashboard, tileRefs } from './dashboard-model.js';
import { labelOf } from './metrics.js';
import { type RunSummary, type Sentinel, type Step, type StepKind, type StepState, ACCESS_INFO, SCRIPT_LANGUAGE_INFO, STEP_INFO, scheduleSentence, stepSentence } from './model.js';
import { ASSISTANT_TITLE } from '../../shared/assistant.js';

/**
 * A sentinel's workflow as a graph (BLG-352): what starts it, its steps in order with what moves
 * between them, where its results land (dashboards, the sentinels a step or a table's button runs),
 * and the sentinels that run after it. Given its last run, each step shows how it went. The same
 * graph on the sentinel's page and the phone. Browser-safe: pure.
 */

const NODE_TYPE: Readonly<Record<StepKind, GraphNode['type']>> = {
  claude: 'service',
  script: 'function',
  notify: 'client',
  http: 'external',
  pr: 'task',
  merge: 'milestone',
  message: 'person',
  chat: 'service',
  friend: 'person',
  trigger: 'service',
  measure: 'metric',
};

const STATE: Readonly<Record<StepState, GraphStatus>> = { waiting: 'todo', running: 'active', done: 'done', failed: 'failed', skipped: 'idle' };

/** What a step hands the next one, in a few words (the line between them). */
function handsOn(st: Step): string {
  switch (st.kind) {
    case 'claude':
      return 'its report';
    case 'script':
      return 'what it printed';
    case 'http':
      return 'the answer';
    case 'measure':
      return 'what it read (JSON)';
    case 'friend':
      return 'their answer';
    case 'chat':
      return 'its answer’s first line';
    case 'pr':
      return 'the pull request';
    case 'merge':
      return 'the merge';
    case 'trigger':
      return 'the run it started';
    default:
      return 'its line';
  }
}

/** A step's card, in Markdown: what it does and how (never a secret: headers are names only). */
function stepDetails(st: Step): string {
  const lines = [`**${STEP_INFO[st.kind].label}** · ${stepSentence(st)}`];
  if (st.kind === 'claude') lines.push(`Works ${st.where === 'worktree' ? 'in a new worktree (later steps share it)' : st.where === 'mac' ? `on ${ASSISTANT_TITLE}` : 'in the project, reading only'}.`, '', `> ${st.prompt.split('\n').slice(0, 6).join('\n> ').slice(0, 1200)}`);
  if (st.kind === 'script') lines.push(st.code?.trim() ? `${SCRIPT_LANGUAGE_INFO[st.language ?? 'sh'].label}, ${st.code.split('\n').length} lines${st.command.trim() ? `, with \`${st.command.trim().slice(0, 80)}\`` : ''}.` : `\`${st.command.slice(0, 200)}\``);
  if (st.kind === 'http') lines.push(`\`${st.method} ${st.url.slice(0, 200)}\`${Object.keys(st.headers).length ? `\n\nHeaders: ${Object.keys(st.headers).join(', ')}` : ''}`);
  if (st.kind === 'measure') {
    lines.push(st.from === 'source' ? `Reads ${st.source ? `a ${st.source.kind} source` : 'a source (none yet)'}.` : st.from === 'claude' ? 'Keeps what the agent measured.' : 'Reads the step before’s output.');
    for (const m of st.metrics) lines.push(`- ${m.label ?? m.name} (${m.kind ?? 'number'})${m.columns?.length ? `: ${m.columns.map((c) => `${c.key} as ${c.type}`).join(', ')}` : ''}`);
  }
  return lines.join('\n').slice(0, 4000);
}

/** A step's line under its name: its last run's state and time when there's one, else what it does. */
function sublabelOf(st: Step, ran: RunSummary['steps'][number] | undefined): string {
  if (ran?.state === 'failed' && ran.why) return `Failed: ${ran.why}`.slice(0, 120);
  if (ran?.startedAt && ran.endedAt && ran.state === 'done') {
    const ms = ran.endedAt - ran.startedAt;
    return `${STEP_INFO[st.kind].label} · ${ms < 1000 ? '<1 s' : ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`}`;
  }
  return stepSentence(st).slice(0, 120);
}

export interface WorkflowOptions {
  /** Its last run: each step coloured by how it went. */
  readonly run?: RunSummary;
  /** Every sentinel (names, and the ones that run after this one). */
  readonly items?: readonly Sentinel[];
  readonly dashboards?: readonly Dashboard[];
}

export function sentinelGraph(s: Sentinel, opts: WorkflowOptions = {}): Graph {
  const items = opts.items ?? [];
  const nameOf = (id: string): string | undefined => items.find((i) => i.id === id)?.name;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const has = new Set<string>();
  const node = (n: GraphNode): string => {
    if (!has.has(n.id) && nodes.length < MAX_NODES) {
      has.add(n.id);
      nodes.push(n);
    }
    return n.id;
  };
  const edge = (e: Omit<GraphEdge, 'id'>): void => {
    if (!has.has(e.from) || !has.has(e.to)) return;
    const id = `${e.from}->${e.to}`;
    if (!edges.some((x) => x.id === id)) edges.push({ id, ...e });
  };
  const other = (id: string): string =>
    node({ id: cleanId(`sentinel:${id}`), type: 'service', label: (nameOf(id) ?? 'Another sentinel').slice(0, 80), sublabel: 'Another sentinel', links: [{ label: 'Open it', href: `sentinel:${id}` }] });

  // What starts it (another sentinel, for `after`).
  const on = node({ id: 'on', type: 'milestone', label: scheduleSentence(s.trigger, nameOf).slice(0, 80), sublabel: s.paused ? 'Paused' : 'Watching', ...(s.paused ? { status: 'idle' as const } : {}), details: `**Starts** ${scheduleSentence(s.trigger, nameOf)}\n\n**Access** ${ACCESS_INFO[s.access].label}: ${ACCESS_INFO[s.access].sentence}.` });
  if (s.trigger.kind === 'after' && s.trigger.sentinelId) edge({ from: other(s.trigger.sentinelId), to: on, label: s.trigger.on === 'success' ? 'when it succeeds' : s.trigger.on === 'failure' ? 'when it fails' : 'after it runs', kind: 'async' });

  // A worktree the run's Claude makes: its steps (and the pull request, the merge) inside one box.
  const worktree = s.steps.some((st) => (st.kind === 'claude' && st.where === 'worktree') || st.kind === 'pr' || st.kind === 'merge');
  if (worktree) node({ id: 'worktree', type: 'group', label: 'In a worktree' });

  const ranBy = new Map((opts.run?.steps ?? []).map((r) => [r.id, r]));
  const stepIds = s.steps.map((st) => cleanId(`step:${st.id}`));
  let before = on;
  s.steps.forEach((st, i) => {
    const ran = ranBy.get(st.id);
    const status = ran ? STATE[ran.state] : undefined;
    const inWorktree = worktree && ((st.kind === 'claude' && st.where === 'worktree') || st.kind === 'pr' || st.kind === 'merge');
    const id = node({
      id: stepIds[i]!,
      type: NODE_TYPE[st.kind],
      label: st.name.slice(0, 80),
      sublabel: sublabelOf(st, ran),
      tag: `${i + 1}`,
      ...(status ? { status } : {}),
      ...(ran?.state === 'failed' ? { emphasis: true } : {}),
      ...(inWorktree ? { group: 'worktree' } : {}),
      details: stepDetails(st),
    });
    const prev = i > 0 ? s.steps[i - 1] : undefined;
    edge({ from: before, to: id, ...(prev ? { label: handsOn(prev), kind: 'data' as const } : { label: 'starts', kind: 'flow' as const }), ...(ran?.state === 'running' ? { animated: true } : {}) });
    before = id;
    // Where it reaches: another sentinel it runs, the sentinels its table's buttons run.
    if (st.kind === 'trigger' && st.sentinelId) edge({ from: id, to: other(st.sentinelId), label: 'runs it with its line', kind: 'async' });
    if (st.kind === 'measure')
      for (const m of st.metrics) for (const c of m.columns ?? []) if (c.type === 'action' && c.sentinel) edge({ from: id, to: other(c.sentinel), label: `${c.button ?? c.label ?? 'a button'} on each row`, kind: 'async' });
  });

  // Where its results show: the dashboards whose tiles read its numbers or a step's output.
  for (const d of opts.dashboards ?? []) {
    const from = new Map<string, string[]>();
    for (const t of d.tiles) {
      for (const r of tileRefs(t)) {
        if (r.sentinelId !== s.id) continue;
        const st = s.steps.find((x) => x.kind === 'measure' && x.metrics.some((m) => m.name === r.metric)) ?? s.steps.find((x) => x.kind === 'measure');
        // Said as the metric's label ("Failed payments"), not its file name.
        const spec = st?.kind === 'measure' ? st.metrics.find((m) => m.name === r.metric) : undefined;
        if (st) from.set(st.id, [...(from.get(st.id) ?? []), spec?.label ?? labelOf(r.metric)]);
      }
      if (t.step?.sentinelId === s.id) from.set(t.step.stepId, [...(from.get(t.step.stepId) ?? []), 'its output']);
    }
    if (!from.size) continue;
    const dash = node({ id: cleanId(`dashboard:${d.id}`), type: 'metric', label: d.name.slice(0, 80), sublabel: 'Dashboard', value: `${d.tiles.length} tiles`, links: [{ label: 'Open it', href: `dashboard:${d.id}` }] });
    // Several numbers say how many (their names are in the tiles): a long list of names overlaps on the line.
    for (const [stepId, what] of from) {
      const names = [...new Set(what)];
      edge({ from: cleanId(`step:${stepId}`), to: dash, label: names.length === 1 ? names[0]!.slice(0, 60) : `${names.length} numbers`, kind: 'data' });
    }
  }

  // The sentinels that run after it.
  for (const o of items) {
    if (o.id === s.id || o.trigger.kind !== 'after' || o.trigger.sentinelId !== s.id) continue;
    edge({ from: before, to: other(o.id), label: o.trigger.on === 'success' ? 'when it succeeds' : o.trigger.on === 'failure' ? 'when it fails' : 'after it runs', kind: 'async' });
  }

  const steps: GraphStep[] = [
    { title: 'What starts it', text: scheduleSentence(s.trigger, nameOf), focus: [on] },
    ...s.steps.map((st, i) => ({ title: `${i + 1}. ${st.name}`.slice(0, 80), text: stepSentence(st, nameOf).slice(0, 600), focus: [stepIds[i]!, ...(i ? [`${stepIds[i - 1]}->${stepIds[i]}`] : [`on->${stepIds[i]}`])] })),
  ].slice(0, MAX_STEPS);
  const last = opts.run ? ` · last run ${opts.run.state}` : '';
  return { title: s.name.slice(0, 120), summary: `${s.steps.length} ${s.steps.length === 1 ? 'step' : 'steps'}, in order${last}`.slice(0, 400), direction: 'right', nodes, edges, steps };
}
