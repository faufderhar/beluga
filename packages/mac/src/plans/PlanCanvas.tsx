import '@xyflow/react/dist/base.css';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Background, BackgroundVariant, BaseEdge, type Edge, EdgeLabelRenderer, type EdgeProps, Handle, type Node, type NodeProps, Panel, Position, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { AUTONOMY_INFO } from '@beluga/core/plans/model.js';
import type { MilestoneView, PlanView, TaskView } from '@beluga/core/plans/progress.js';
import { IconButton, Working, cx } from '../components/ui.js';
import { Icon } from '../components/Icon.js';
import { useDocTheme } from '../components/markdown/use-doc-theme.js';
import { type ElkInput, type ElkOutput, type Placed, type Point, type Route, placesOf, roundedPath, routesOf } from '../components/graph/graph-model.js';
import { layout } from '../components/graph/layout.js';
import { useSharpZoom } from '../components/graph/sharp-zoom.js';
import { breath, turn, useLive } from '../lib/live-motion.js';
import { MILESTONE_STATE, type MilestoneJoin, type PlanGraphShape, TASK_STATE, changeMarks, gateId, graphShape, groupId, lockWords, milestoneJoin, milestoneLink, milestoneNowWords, startingMilestones, taskNodeId, taskWords } from './plans-model.js';
import { COMPACT_STATES, FOLDS_KEY, type Folds, MILESTONE, type MilestoneFrame, PLAN_GAPS, arrowHead, isFolded, joinAt, labelAt, milestoneAnchors, milestoneFrame, milestoneRoute, placeMilestones, readFolds, taskSize, withFold } from './plan-layout.js';
import { useCheckerChat, useClock, usePlanActions } from './use-plans.js';
import { useGlide } from './use-glide.js';
import { LiveDot, LockMark, TaskChatMark, TaskStateIcon } from './marks.js';
import p from './plans.module.css';
import c from './PlanCanvas.module.css';

/**
 * A plan as a living graph: each milestone a box, its tasks inside laid out by what waits on what,
 * and its gate across its foot: the criteria that must hold before what waits on it unlocks.
 * Milestones run top to bottom in rows (side by side when they run at once); a bolder line leaves
 * each gate from its middle and comes down into the top of each milestone it unlocks, onto a lock
 * that opens once the gate passes. Finished tasks shrink to slim rows; a passed milestone folds into
 * one summary row (click it to open it again; your choice is kept for the session). The geometry is
 * plain math (plan-layout.ts); ELK only lays out the tasks inside each box. Work moving on re-lays
 * the plan only when a card's size changes (a task finishing, a milestone folding), and it glides.
 */

/** Empty room left around the plan when it's framed: above it the view switch sits over the canvas. */
const MARGIN = { top: 48, side: 24 };
/** Opened, the plan is framed whole when it reads at this zoom; smaller, its current milestones are. */
const READABLE = 0.55;

interface TaskData extends Record<string, unknown> {
  readonly view: TaskView;
  readonly key?: string;
  readonly mark?: 'added' | 'changed';
  readonly canStart: boolean;
  readonly onStart: (taskId: string) => void;
  readonly selected: boolean;
  /** In another milestone, waiting on or waited on by the task you picked. */
  readonly linked: boolean;
}
interface MilestoneData extends Record<string, unknown> {
  readonly view: MilestoneView;
  readonly current: boolean;
  readonly folded: boolean;
  /** What it waits on that hasn't passed yet (titles): locked until they do. */
  readonly waitsOn: readonly string[];
  /** It waits on other milestones (and they've all passed, unless it's locked). */
  readonly gated: boolean;
  /** The plan's branch: what it starts from once what it waits on is merged in. */
  readonly branch?: string;
  /** Beluga is starting its Claude right now (see startingMilestones). */
  readonly starting?: boolean;
  /** Picked: its details are open (the same pick as its gate's). */
  readonly selected: boolean;
  readonly onFold: (milestoneId: string, folded: boolean) => void;
}
interface GateData extends Record<string, unknown> {
  readonly view: MilestoneView;
  readonly current: boolean;
  readonly selected: boolean;
  readonly folded: boolean;
}
type PlanNode = Node<TaskData, 'task'> | Node<MilestoneData, 'milestone'> | Node<GateData, 'gate'>;

interface LineData extends Record<string, unknown> {
  readonly kind: 'blocks' | 'next';
  readonly state: 'done' | 'live' | 'ready' | 'waiting';
  /** On the current path: in or into a milestone being worked on. */
  readonly current: boolean;
  readonly route?: Route;
  /** A milestone's line: what it says just below the gate it leaves. */
  readonly label?: string;
  /** Lit (it touches the card you point at or picked), dimmed (another one is lit), or gone (folded away). */
  readonly look?: 'hot' | 'dim' | 'gone';
  /** It ends at a join (its milestone waits on several): no arrowhead of its own. */
  readonly joined?: boolean;
  /** The join it meets the others at, and the stem from there into the lock (drawn by the first line in). */
  readonly join?: MilestoneJoin & { readonly stem: readonly Point[] };
}

type PlanEdge = Edge<LineData, 'line'>;

export interface PlanCanvasProps {
  readonly view: PlanView;
  readonly keys: ReadonlyMap<string, string>;
  readonly selected?: string;
  readonly onSelect: (id: string | undefined) => void;
  readonly onStart: (taskId: string) => void;
  readonly startable: ReadonlySet<string>;
}

export default function PlanCanvas(props: PlanCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

/** ELK's layout of each milestone's tasks, and the shape it was made for. */
interface Inner {
  readonly shape: PlanGraphShape;
  readonly outs: ReadonlyMap<string, ElkOutput>;
}
interface Laid {
  readonly places: ReadonlyMap<string, Placed>;
  readonly frames: ReadonlyMap<string, MilestoneFrame>;
  readonly routes: ReadonlyMap<string, Route>;
  /** Each line between milestones: the height it runs across above the one it leads into (where lines into it meet). */
  readonly meets: ReadonlyMap<string, number>;
}

/** ELK's options for a milestone's inside: its tasks left to right by what waits on what. */
const INSIDE = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.layered.spacing.nodeNodeBetweenLayers': '64',
  'elk.spacing.nodeNode': '14',
  'elk.layered.spacing.edgeNodeBetweenLayers': '22',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.spacing.edgeEdge': '10',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  // What can start at once lines up on the left.
  'elk.layered.layering.strategy': 'LONGEST_PATH_SOURCE',
  'elk.padding': `[top=${MILESTONE.head + 8},left=${MILESTONE.side},bottom=0,right=${MILESTONE.side}]`,
} as const;

/** Folds you chose, kept for the session (a reload too), not for good. */
function loadFolds(): Folds {
  try {
    return readFolds(JSON.parse(sessionStorage.getItem(FOLDS_KEY) ?? 'null'));
  } catch {
    return {};
  }
}

const passedOf = (m: MilestoneView): boolean => m.state === 'passed' || (!!m.run.passedAt && m.state !== 'merging');

function Canvas({ view, keys, selected, onSelect, onStart, startable }: PlanCanvasProps) {
  const theme = useDocTheme();
  const flow = useReactFlow<PlanNode, PlanEdge>();
  useSharpZoom();
  const shape = useMemo(() => graphShape(view.plan), [view.plan]);
  const [failed, setFailed] = useState(false);
  const [folds, setFolds] = useState<Folds>(loadFolds);
  const [hot, setHot] = useState<string>();
  const framed = useRef(false);
  const marks = useMemo(() => changeMarks(view.plan), [view.plan]);
  const planId = view.plan.id;

  const byTask = useMemo(() => new Map(view.milestones.flatMap((m) => m.tasks.map((t) => [t.task.id, t] as const))), [view]);
  const byMs = useMemo(() => new Map(view.milestones.map((m) => [m.milestone.id, m] as const)), [view]);
  const folded = useMemo(() => new Set(view.milestones.filter((m) => passedOf(m) && isFolded(folds, planId, m.milestone.id, true)).map((m) => m.milestone.id)), [view, folds, planId]);
  const onFold = useCallback(
    (milestoneId: string, fold: boolean) =>
      setFolds((now) => {
        const next = withFold(now, planId, milestoneId, fold);
        try {
          sessionStorage.setItem(FOLDS_KEY, JSON.stringify(next));
        } catch {
          // No storage: kept until the window closes.
        }
        return next;
      }),
    [planId],
  );

  // What sizes the task cards (a finished task is a slim row): all ELK needs.
  const slimKey = useMemo(() => JSON.stringify(shape.milestones.flatMap((m) => m.tasks.filter((t) => COMPACT_STATES.has(byTask.get(t)?.state ?? '')))), [shape, byTask]);
  // What folds (a folded milestone is as wide as its title needs): plain math, no ELK.
  const foldKey = useMemo(() => JSON.stringify(Object.fromEntries([...folded].sort().map((id) => [id, byMs.get(id)?.milestone.title ?? '']))), [byMs, folded]);
  const [inner, setInner] = useState<Inner>();

  // Lay out each milestone's tasks with ELK when the shape or a task card's size changes (only then).
  // Folding doesn't: it re-places the boxes in the same render (below), so the box, its header, its
  // cards and its lines all change together, never an open header in a folded box while ELK runs.
  useEffect(() => {
    let live = true;
    const slim = new Set(JSON.parse(slimKey) as string[]);
    void Promise.all(
      shape.milestones.map((m) => {
        const inside = new Set(m.tasks.map(taskNodeId));
        const input: ElkInput = {
          id: groupId(m.id),
          layoutOptions: INSIDE,
          children: m.tasks.map((t) => ({ id: taskNodeId(t), ...taskSize(slim.has(t) ? 'done' : 'ready') })),
          edges: shape.edges.filter((e) => e.kind === 'blocks' && inside.has(e.from) && inside.has(e.to)).map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
        };
        return layout(input);
      }),
    )
      .then((outs) => {
        if (!live) return;
        setInner({ shape, outs: new Map(shape.milestones.map((m, i) => [m.id, outs[i]!] as const)) });
        setFailed(false);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [shape.key, slimKey]);

  // Each box around its tasks with its gate at its foot, the boxes in their rows, and their lines between.
  const laid = useMemo<Laid | undefined>(() => {
    if (!inner) return undefined;
    const { shape } = inner;
    const folded = new Map(Object.entries(JSON.parse(foldKey) as Record<string, string>));
    const criteria = new Map(shape.milestones.map((m) => [m.id, m.criteria] as const));
    // Each box only as tall as its own tasks and gate: stretched to a taller neighbour's height, a short
    // milestone would be mostly empty room between its tasks and its gate.
    const frameOf = (id: string, fold: boolean): MilestoneFrame => {
      const o = inner.outs.get(id);
      return milestoneFrame({ width: o?.width ?? 0, height: o?.height ?? 0 }, criteria.get(id) ?? [], fold, undefined, folded.get(id));
    };
    const opened = new Map(shape.milestones.map((m) => [m.id, frameOf(m.id, false)] as const));
    const frames = new Map(shape.milestones.map((m) => [m.id, folded.has(m.id) ? frameOf(m.id, true) : opened.get(m.id)!] as const));
    const next = shape.edges.filter((e) => e.kind === 'next').map((e) => ({ id: e.id, from: e.from.replace(/^gate:/, ''), to: e.to.replace(/^m:/, '') }));
    const parents = new Map<string, string[]>();
    for (const e of next) parents.set(e.to, [...(parents.get(e.to) ?? []), e.from]);
    const boxes = placeMilestones(shape.rows, frames, parents);

    const places = new Map<string, Placed>();
    const routes = new Map<string, Route>();
    const meets = new Map<string, number>();
    for (const m of shape.milestones) {
      const box = boxes.get(m.id);
      // Folded, its cards and gate stay where they sit open (hidden), so opening it fades them in in place.
      const frame = opened.get(m.id);
      const o = inner.outs.get(m.id);
      if (!box || !frame || !o) continue;
      places.set(groupId(m.id), box);
      places.set(gateId(m.id), frame.gate);
      for (const [nid, at] of placesOf(o)) places.set(nid, { ...at, x: at.x + frame.shiftX });
      for (const [eid, r] of routesOf(o)) routes.set(eid, { ...r, points: r.points.map((pt) => ({ x: pt.x + box.x + frame.shiftX, y: pt.y + box.y })) });
    }
    // A milestone's lines: from the middle of its gate's foot, down the gap below it, into the top of the next.
    // Lines into milestones at the same height run across at slightly different heights (so they never overlap).
    const targets = [...new Set(next.map((e) => e.to))];
    const nudge = new Map(
      targets.map((id) => {
        const same = targets.filter((t) => boxes.get(t)?.y === boxes.get(id)?.y).sort((a, b) => (boxes.get(a)?.x ?? 0) - (boxes.get(b)?.x ?? 0));
        return [id, (same.indexOf(id) - (same.length - 1) / 2) * 10] as const;
      }),
    );
    for (const e of next) {
      const a = boxes.get(e.from);
      const b = boxes.get(e.to);
      const fa = frames.get(e.from);
      if (!a || !b || !fa) continue;
      const enterY = b.y - PLAN_GAPS.row / 2 + (nudge.get(e.to) ?? 0);
      // Right under it: one run across; further down, across below it, then down a clear lane.
      const exitY = b.y - (a.y + a.height) <= PLAN_GAPS.row ? enterY : a.y + a.height + PLAN_GAPS.row / 2;
      const obstacles = [...boxes].filter(([id]) => id !== e.from && id !== e.to).map(([, box]) => box);
      routes.set(e.id, { points: milestoneRoute(milestoneAnchors(a, fa.gate).out, milestoneAnchors(b).in, exitY, enterY, obstacles) });
      meets.set(e.id, enterY);
    }
    return { places, frames, routes, meets };
  }, [inner, foldKey]);

  const lane = useMemo(() => new Map(shape.milestones.flatMap((m) => m.tasks.map((t) => [taskNodeId(t), m.id] as const))), [shape]);
  // What the picked task waits on, or is waited on by, in other milestones: ringed, not wired across the lanes.
  const linked = useMemo(() => {
    if (!selected) return new Set<string>();
    const me = taskNodeId(selected);
    return new Set(shape.edges.filter((e) => e.kind === 'blocks' && (e.from === me || e.to === me) && lane.get(e.from) !== lane.get(e.to)).map((e) => (e.from === me ? e.to : e.from)));
  }, [shape, lane, selected]);
  const starting = useMemo(() => new Set(startingMilestones(view).map((m) => m.milestone.id)), [view]);
  // Each node says its size as measured (the layout knows it exactly): without one, React Flow drops a
  // re-made node's handles and every line vanishes for a frame, then comes back drawn afresh, ahead of
  // its gliding cards (folding a milestone, picking a task).
  const nodes = useMemo<PlanNode[]>(() => {
    if (!laid) return [];
    const out: PlanNode[] = [];
    for (const m of view.milestones) {
      const id = m.milestone.id;
      const box = laid.places.get(groupId(id));
      if (!box) continue;
      const current = view.current?.milestone.id === id;
      const away = folded.has(id);
      const waitsOn = m.dependsOn.filter((d) => byMs.get(d) && !passedOf(byMs.get(d)!)).map((d) => byMs.get(d)!.milestone.title);
      out.push({
        id: groupId(id),
        type: 'milestone',
        position: { x: box.x, y: box.y },
        style: { width: box.width, height: box.height },
        width: box.width,
        height: box.height,
        measured: { width: box.width, height: box.height },
        data: { view: m, current, folded: away, waitsOn, gated: m.dependsOn.some((d) => byMs.has(d)), ...(view.plan.branch ? { branch: view.plan.branch } : {}), ...(starting.has(id) ? { starting: true } : {}), selected: selected === gateId(id), onFold },
        selectable: false,
        draggable: false,
        zIndex: -1,
      });
      // A folded milestone's cards stay where they were, faded away (so opening it again fades them back in).
      const hidden = away ? { className: c.foldedAway, selectable: false, focusable: false, domAttributes: { 'aria-hidden': true } } : {};
      for (const t of m.tasks) {
        const at = laid.places.get(taskNodeId(t.task.id));
        if (!at) continue;
        const key = keys.get(t.task.id);
        const mark = marks.get(t.task.id);
        out.push({
          id: taskNodeId(t.task.id),
          type: 'task',
          parentId: groupId(id),
          position: { x: at.x, y: at.y },
          width: at.width,
          height: at.height,
          measured: { width: at.width, height: at.height },
          draggable: false,
          ...hidden,
          data: { view: t, ...(key ? { key } : {}), ...(mark ? { mark } : {}), canStart: startable.has(t.task.id), onStart, selected: selected === t.task.id, linked: linked.has(taskNodeId(t.task.id)) },
        });
      }
      const gate = laid.places.get(gateId(id));
      if (gate) {
        out.push({ id: gateId(id), type: 'gate', parentId: groupId(id), position: { x: gate.x, y: gate.y }, width: gate.width, height: gate.height, measured: { width: gate.width, height: gate.height }, draggable: false, ...hidden, data: { view: m, current, folded: away, selected: selected === gateId(id) } });
      }
    }
    return out;
  }, [laid, view, byMs, folded, keys, marks, selected, linked, startable, onStart, onFold, starting]);

  const edges = useMemo<PlanEdge[]>(() => {
    if (!laid) return [];
    const finished = (id: string): boolean => {
      const s = byTask.get(id.replace(/^t:/, ''))?.state;
      return s === 'done' || s === 'review' || s === 'canceled' || s === 'planned';
    };
    const titleOf = (id: string): string => `“${byMs.get(id.replace(/^(gate|m):/, ''))?.milestone.title ?? id}”`;
    const working = (id: string): boolean => {
      const s = byTask.get(id.replace(/^t:/, ''))?.state;
      return s === 'running' || s === 'asking' || s === 'idle';
    };
    // The milestones being worked on now: their lines, and the lines into them, are the current path.
    const open = new Set(view.open.map((m) => m.milestone.id));
    const now = (e: (typeof shape.edges)[number]): boolean => open.has(e.kind === 'next' ? e.to.replace(/^m:/, '') : (lane.get(e.from) ?? ''));
    // The card you point at (else the one you picked) lights its lines; the others step back.
    const focus = hot ?? (selected && !selected.startsWith('gate:') ? taskNodeId(selected) : undefined);
    // Only real lines: blockers inside a milestone (across milestones its gate says what comes first), and each gate into the milestones it unlocks.
    const shown = shape.edges.filter((e) => (e.kind === 'blocks' ? lane.get(e.from) === lane.get(e.to) && laid.routes.has(e.id) : e.kind === 'next'));
    const labelled = new Set<string>();
    // A milestone waiting on several: their lines meet in one join above its lock, and one stem goes on into it.
    const into = new Map<string, string[]>();
    for (const e of shown) if (e.kind === 'next') into.set(e.to, [...(into.get(e.to) ?? []), e.id]);
    return shown.map((e) => {
      const from = byMs.get(e.from.replace(/^gate:/, ''));
      if (e.kind === 'next') {
        const link = milestoneLink(from);
        // One label per gate (its lines leave it as one).
        const label = labelled.has(e.from) ? undefined : link.label;
        labelled.add(e.from);
        let route = laid.routes.get(e.id);
        const siblings = into.get(e.to) ?? [];
        let join: LineData['join'];
        const meet = laid.meets.get(e.id);
        const cut = siblings.length > 1 && route && meet !== undefined ? joinAt(route.points, meet) : undefined;
        if (route && cut) {
          // Every line in stops where they meet, on the run across above its lock (however its lane ran down).
          route = { ...route, points: cut.line };
          // The first line in carries the join and its stem (so they're drawn once).
          if (siblings[0] === e.id) {
            const parents = shown.filter((x) => x.kind === 'next' && x.to === e.to).map((x) => byMs.get(x.from.replace(/^gate:/, '')));
            const j = milestoneJoin(parents, view.plan.branch);
            if (j) join = { ...j, stem: cut.stem };
          }
        }
        return { id: e.id, source: e.from, target: e.to, ariaLabel: `${titleOf(e.from)} leads to ${titleOf(e.to)}`, type: 'line', data: { kind: 'next', state: link.state, current: now(e), ...(route ? { route } : {}), ...(label ? { label } : {}), ...(siblings.length > 1 ? { joined: true } : {}), ...(join ? { join } : {}) } };
      }
      const state: LineData['state'] = finished(e.from) ? 'done' : working(e.from) ? 'live' : 'waiting';
      const look: LineData['look'] = folded.has(lane.get(e.from) ?? '') ? 'gone' : focus ? (e.from === focus || e.to === focus ? 'hot' : 'dim') : undefined;
      const route = laid.routes.get(e.id);
      return { id: e.id, source: e.from, target: e.to, type: 'line', data: { kind: 'blocks', state, current: now(e), ...(route ? { route } : {}), ...(look ? { look } : {}) } };
    });
  }, [laid, shape, lane, byTask, byMs, view, folded, hot, selected]);

  // Framed once laid out: the whole plan if it reads, else the milestones being worked on (else the current one).
  const wrap = useRef<HTMLDivElement>(null);
  /** The viewport that shows these milestones as large as fits (never past 1:1), from the top, centred across. */
  const framing = (ids: readonly string[], least = 0): { x: number; y: number; zoom: number } | undefined => {
    const box = wrap.current;
    const groups = ids.map((id) => laid?.places.get(groupId(id))).filter((g): g is Placed => !!g);
    if (!box || !groups.length) return undefined;
    const x0 = Math.min(...groups.map((g) => g.x));
    const y0 = Math.min(...groups.map((g) => g.y));
    const width = Math.max(...groups.map((g) => g.x + g.width)) - x0;
    const height = Math.max(...groups.map((g) => g.y + g.height)) - y0;
    const zoom = Math.min(1, (box.clientWidth - 2 * MARGIN.side) / width, (box.clientHeight - MARGIN.top - MARGIN.side) / height);
    if (zoom < least) return undefined;
    return { x: (box.clientWidth - width * zoom) / 2 - x0 * zoom, y: MARGIN.top - y0 * zoom, zoom };
  };
  const fit = (ms: number): void => {
    const at = framing(shape.milestones.map((m) => m.id));
    if (at) void flow.setViewport(at, { duration: ms });
  };
  useEffect(() => {
    if (!laid || framed.current) return;
    framed.current = true;
    requestAnimationFrame(() => {
      const open = view.open.map((m) => m.milestone.id);
      const at =
        framing(shape.milestones.map((m) => m.id), READABLE) ??
        framing(open, READABLE) ??
        framing(view.current ? [view.current.milestone.id] : open.slice(0, 1)) ??
        framing(shape.milestones.map((m) => m.id));
      if (at) void flow.setViewport(at, { duration: 0 });
    });
  }, [laid]);

  return (
    <div ref={wrap} className={cx(p.canvas, c.canvas)} data-ready={laid ? 'true' : 'false'}>
      <ReactFlow<PlanNode, PlanEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        colorMode={theme}
        minZoom={0.2}
        maxZoom={3}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        zoomOnDoubleClick={false}
        zoomOnScroll={false}
        panOnScroll
        zoomOnPinch
        panOnDrag
        // A milestone (open, anywhere but its cards) or its gate: the milestone's details; a card: its task's.
        onNodeClick={(_e, n) => (n.className === c.foldedAway || (n.type === 'milestone' && n.data.folded) ? undefined : onSelect(n.type === 'gate' ? n.id : n.type === 'milestone' ? gateId(n.id.replace(/^m:/, '')) : n.id.replace(/^t:/, '')))}
        onNodeMouseEnter={(_e, n) => (n.type === 'task' ? setHot(n.id) : undefined)}
        onNodeMouseLeave={(_e, n) => (n.type === 'task' ? setHot((h) => (h === n.id ? undefined : h)) : undefined)}
        onPaneClick={() => onSelect(undefined)}
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} className={p.dots} />
        <Panel position="bottom-left" className={p.zoom}>
          <IconButton icon="minus" label="Zoom Out" onClick={() => void flow.zoomOut({ duration: 200 })} />
          <IconButton icon="plus" label="Zoom In" onClick={() => void flow.zoomIn({ duration: 200 })} />
          <IconButton icon="outline" label="Fit to View" onClick={() => fit(350)} />
        </Panel>
      </ReactFlow>
      {failed ? <div className={p.canvasNote}>Couldn’t lay this plan out.</div> : !laid ? <div className={p.canvasNote}>Laying out…</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------- nodes

/** Where lines meet a card: never drawn (a line shows itself). */
const Ends = () => (
  <>
    <Handle type="target" position={Position.Left} className={p.handle} isConnectable={false} />
    <Handle type="source" position={Position.Right} className={p.handle} isConnectable={false} />
  </>
);

/** Claude at work on a card: a copper light going round its edge (with the live clock, lib/live-motion.ts). */
function Glow() {
  const glow = useRef<HTMLSpanElement>(null);
  useLive(glow, (t) => glow.current?.style.setProperty('--angle', `${turn(t, 2600)}deg`));
  return <span ref={glow} className={p.glow} aria-hidden="true" />;
}

const TaskNode = memo(function TaskNode({ data }: NodeProps<Node<TaskData, 'task'>>) {
  const { view: t } = data;
  // A started task says how it's doing now (its step and for how long, or that it stopped).
  const now = useClock(t.pulse?.kind === 'working' || t.pulse?.kind === 'command');
  const info = taskWords(t, now);
  if (COMPACT_STATES.has(t.state)) {
    // Finished: a slim row (its tick, key and title); its details are a click away.
    return (
      <div className={cx(p.task, p[`task_${t.state}`], c.taskCompact, data.selected && p.taskSelected, data.linked && p.taskLinked, data.mark && p.taskMarked)} data-state={t.state} data-linked={data.linked ? 'true' : undefined} aria-label={`${t.task.title}, ${info.label}`}>
        <Ends />
        <TaskStateIcon state={t.state === 'canceled' ? 'canceled' : 'done'} />
        <span className={p.taskKey}>{data.key ?? t.task.id}</span>
        <span className={c.compactName} title={t.task.title}>
          {t.task.title}
        </span>
        <TaskChatMark {...(t.worktree ? { worktree: t.worktree } : {})} />
      </div>
    );
  }
  const sub = info.sub ?? (t.state === 'asking' ? 'Your agent asked you something' : t.forYou && t.state === 'ready' ? 'For you' : undefined);
  return (
    <div
      className={cx(p.task, p[`task_${t.state}`], c.taskCard, data.selected && p.taskSelected, data.linked && p.taskLinked, data.mark && p.taskMarked)}
      data-state={t.state}
      data-linked={data.linked ? 'true' : undefined}
      aria-label={`${t.task.title}, ${info.label}`}
    >
      <Ends />
      {t.state === 'running' ? <Glow /> : null}
      <div className={p.taskTop}>
        <TaskStateIcon state={t.state} />
        <span className={p.taskKey}>{data.key ?? t.task.id}</span>
        {data.mark ? <span className={p.markChip}>{data.mark === 'added' ? 'New' : 'Changed'}</span> : null}
        <span className={p.grow} />
        <TaskChatMark {...(t.worktree ? { worktree: t.worktree } : {})} />
        {t.task.estimate ? <span className={p.points}>{t.task.estimate}</span> : null}
        {t.forYou ? <Icon name="person" size={12} className={p.forYou} /> : null}
      </div>
      <div className={p.taskTitle} title={t.task.title}>
        {t.task.title}
      </div>
      <div className={p.taskFoot}>
        {data.canStart ? (
          <button
            type="button"
            className={cx(p.startButton, 'nodrag', 'nopan')}
            onClick={(e) => {
              e.stopPropagation();
              data.onStart(t.task.id);
            }}
          >
            <Icon name={t.forYou ? 'hand' : 'play'} size={9} />
            {t.forYou ? 'Decide…' : 'Start'}
          </button>
        ) : (
          <span className={cx(p.taskState, p[`tone_${info.tone}`])}>{info.label}</span>
        )}
        {sub ? <span className={p.taskSub}>{sub}</span> : null}
      </div>
    </div>
  );
});

/** What a milestone's gate says of itself. */
function gateLabel(m: MilestoneView): string {
  const checked = m.run.check?.verdict === 'pass';
  if (m.state === 'merging') return milestoneLink(m).label === 'Merging' ? 'Merging…' : milestoneLink(m).label;
  return m.state === 'passed' ? 'Passed' : m.state === 'checking' ? 'Checking…' : m.state === 'failed' ? 'Failed check' : m.state === 'gate' ? (checked ? 'Checked · pass it' : 'Pass it') : 'Not yet';
}

const MilestoneNode = memo(function MilestoneNode({ data }: NodeProps<Node<MilestoneData, 'milestone'>>) {
  const m = data.view;
  const info = MILESTONE_STATE[m.state];
  const share = m.state === 'passed' ? 1 : m.total ? m.finished / m.total : 0;
  const locked = data.waitsOn.length > 0;
  const passed = m.state === 'passed';
  // Its agent at work right now: said in its header, even between tasks (when no card shows it).
  const clock = useClock(!data.folded && (m.agentNow?.kind === 'working' || m.agentNow?.kind === 'command'));
  const live = data.folded ? undefined : milestoneNowWords(m, clock);
  const { openWorktree } = usePlanActions();
  // Where the line from what it waits on comes in: a lock, open once those gates pass.
  const badge = data.gated ? (
    <span className={cx(c.inBadge, locked ? c.inBadgeLocked : c.inBadgeOpen)} title={lockWords(data.waitsOn, m.dependsOn.length, data.branch)} aria-hidden="true">
      <LockMark open={!locked} size={11} />
    </span>
  ) : null;
  if (data.folded) {
    const n = m.milestone.tasks.length;
    return (
      <div className={cx(p.milestone, p.ms_passed, c.ms)}>
        <Handle id="in" type="target" position={Position.Top} className={p.handle} isConnectable={false} />
        <Handle id="out" type="source" position={Position.Bottom} className={p.handle} isConnectable={false} />
        {badge}
        <button type="button" className={cx(c.foldRow, 'nodrag', 'nopan')} aria-expanded="false" aria-label={`${m.milestone.title}: passed. Show its ${n} ${n === 1 ? 'task' : 'tasks'}`} onClick={(e) => (e.stopPropagation(), data.onFold(m.milestone.id, false))}>
          <span className={p.msIndex}>
            <Icon name="check" size={11} />
          </span>
          <span className={c.foldTitle}>{m.milestone.title}</span>
          <span className={c.foldMeta}>
            {m.finished}/{m.total} {m.total === 1 ? 'task' : 'tasks'} done
          </span>
          <span className={c.foldGate} data-criteria={m.milestone.id} data-state={m.state} aria-label={`Criteria of ${m.milestone.title}: Passed`}>
            <Icon name="check" size={10} />
            {m.milestone.criteria.length ? `${m.milestone.criteria.length} ${m.milestone.criteria.length === 1 ? 'criterion' : 'criteria'} · ` : ''}Passed
          </span>
          <Icon name="chevronDown" size={12} className={c.foldChevron} />
        </button>
      </div>
    );
  }
  return (
    <div
      className={cx(p.milestone, p[`ms_${m.state}`], data.current && p.msCurrent, c.ms, locked && c.msLocked, live && c.msLive, data.selected && c.msSelected)}
      data-locked={locked ? 'true' : undefined}
      data-milestone={m.milestone.id}
      data-agent-now={live ? live.tone : undefined}
    >
      <Handle id="in" type="target" position={Position.Top} className={p.handle} isConnectable={false} />
      <Handle id="out" type="source" position={Position.Bottom} className={p.handle} isConnectable={false} />
      {badge}
      <div className={p.msHead}>
        <span className={p.msIndex}>{passed ? <Icon name="check" size={11} /> : m.index + 1}</span>
        <span className={p.msTitles}>
          <span className={p.msTitle}>{m.milestone.title}</span>
          <span className={p.msSub}>
            <span className={cx(p.msState, p[`tone_${info.tone}`])}>{info.label}</span>
            {m.state !== 'draft' ? (
              <span className={p.msCount}>
                {m.finished}/{m.total}
              </span>
            ) : (
              <span className={p.msCount}>{m.milestone.tasks.length} tasks</span>
            )}
            {m.state !== 'draft' ? (
              <span className={p.msProgress} aria-hidden="true">
                <span className={p.msProgressFill} style={{ width: `${Math.round(share * 100)}%` }} />
              </span>
            ) : null}
            {m.milestone.autonomy ? <span className={p.msAuto}>{AUTONOMY_INFO[m.autonomy].label}</span> : null}
            {data.starting ? (
              <span className={c.starting} role="status">
                <Working />
                Starting its agent…
              </span>
            ) : null}
            {/* Where its work starts: the plan's branch, with what it waited on merged in. */}
            {data.gated && data.branch && !locked && !passed ? (
              <span className={c.fromBranch} title={lockWords([], m.dependsOn.length, data.branch)}>
                from {data.branch}
              </span>
            ) : null}
          </span>
        </span>
        <span className={p.grow} />
        {live && m.agent ? (
          <button
            type="button"
            className={cx(c.agentNow, p[`tone_${live.tone}`], 'nodrag', 'nopan')}
            title={`${live.label}${live.sub ? ` · ${live.sub}` : ''}: open its chat`}
            aria-label={`${live.label}${live.sub ? `, ${live.sub}` : ''}. Open the Agent’s Chat`}
            onClick={(e) => (e.stopPropagation(), openWorktree(m.agent!.worktree))}
          >
            {live.tone === 'claude' ? <LiveDot /> : <Icon name="chat" size={11} />}
            <span className={c.agentNowLabel}>{live.label}</span>
            {live.sub && !live.onCard ? <span className={c.agentNowSub}>{live.sub}</span> : null}
            <TaskChatMark worktree={m.agent.worktree} />
          </button>
        ) : null}
        {locked ? (
          <span className={c.lockChip} title={lockWords(data.waitsOn, m.dependsOn.length, data.branch)}>
            <LockMark size={10} />
            Locked
          </span>
        ) : null}
        {passed ? (
          <button type="button" className={cx(c.foldButton, 'nodrag', 'nopan')} aria-expanded="true" aria-label={`Fold ${m.milestone.title}`} title="Fold" onClick={(e) => (e.stopPropagation(), data.onFold(m.milestone.id, true))}>
            <Icon name="chevronUp" size={12} />
          </button>
        ) : null}
      </div>
    </div>
  );
});

/** How each criterion reads: Claude's check judges them together, so they move as one. */
function criterionState(m: MilestoneView): 'met' | 'checking' | 'unmet' | 'pending' {
  if (m.state === 'passed' || m.state === 'merging' || (m.state === 'gate' && m.run.check?.verdict === 'pass')) return 'met';
  if (m.state === 'checking') return 'checking';
  if (m.state === 'failed') return 'unmet';
  return 'pending';
}

/**
 * A milestone's gate: a bar across its foot listing what must be true to pass it, and how it stands
 * (not yet, checking, waiting for you, failed, passed). Its line to what it unlocks leaves from the
 * middle of its foot. Picked, the details say more.
 */
const GateNode = memo(function GateNode({ data }: NodeProps<Node<GateData, 'gate'>>) {
  const m = data.view;
  const criteria = m.milestone.criteria;
  const label = gateLabel(m);
  const each = criterionState(m);
  // Waiting for you: a soft ring that breathes out; being checked: each criterion's mark turns
  // (both with the live clock, lib/live-motion.ts).
  const gate = useRef<HTMLDivElement>(null);
  const checking = each === 'checking';
  useLive(
    gate,
    (t) => {
      if (checking) gate.current?.style.setProperty('--check-turn', `${turn(t, 1100)}deg`);
      else gate.current?.style.setProperty('--beckon', (1 - breath(t, 2400)).toFixed(3));
    },
    (m.state === 'gate' || checking) && !data.folded,
  );
  const state = m.state === 'merging' ? 'passed' : m.state;
  // Its checker's conversation, one click from its state (“Checking…”); the rest of the gate still opens its details.
  const checker = useCheckerChat(m);
  const { openWorktree } = usePlanActions();
  return (
    <div
      ref={gate}
      className={cx(c.gate, c[`gate_${state}`], data.current && c.gateCurrent, data.selected && c.gateSelected)}
      // Folded away, the summary row stands for it.
      {...(data.folded ? {} : { 'data-criteria': m.milestone.id })}
      data-state={m.state}
      aria-label={`Criteria of ${m.milestone.title}: ${label}`}
    >
      <Ends />
      <div className={c.gateHead}>
        <span className={c.gateMark}>
          <Icon name={state === 'passed' ? 'check' : state === 'failed' ? 'x' : 'flag'} size={10} />
        </span>
        <span className={c.gateTitle}>Pass criteria</span>
        {criteria.length ? <span className={c.gateCount}>{criteria.length}</span> : null}
        {checker ? (
          <button
            type="button"
            className={cx(c.gateState, c.gateWatch, 'nodrag', 'nopan')}
            title={checking ? 'Watch the check' : 'Open the check'}
            aria-label={`${label}: ${checking ? 'Watch the Check' : 'Open the Check'}`}
            onClick={(e) => (e.stopPropagation(), openWorktree(checker))}
          >
            <Icon name="eye" size={11} />
            {label}
            <TaskChatMark worktree={checker} />
          </button>
        ) : (
          <span className={c.gateState}>{label}</span>
        )}
      </div>
      {criteria.length ? (
        <ul className={c.gateList}>
          {criteria.map((text, i) => (
            <li key={i} className={c.criterion} data-state={each} title={text}>
              <span className={c.criterionMark} aria-hidden="true" />
              <span className={c.criterionText}>{text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className={c.gateNone}>Passes when its tasks are done</div>
      )}
      <span className={c.gatePort} aria-hidden="true" />
    </div>
  );
});

const NODE_TYPES = { task: TaskNode, milestone: MilestoneNode, gate: GateNode } as const;

// ---------------------------------------------------------------- lines

/**
 * Two kinds of line. Inside a milestone, a thin one from a task to what waits on it (right side to
 * left side, corners rounded, a small arrowhead), lit when you point at either card. Between
 * milestones, a bolder one from a gate down into what it unlocks: dashed while it's locked, solid
 * green once the gate passed, labelled just below the gate.
 */
const PlanLine = memo(function PlanLine({ id, source, target, sourceX, sourceY, targetX, targetY, data }: EdgeProps<PlanEdge>) {
  const kind = data?.kind ?? 'blocks';
  // Re-laid, it glides with the cards it joins (or, reshaped, waits for them hidden and fades back in).
  const { points, reshaped } = useGlide(
    data?.route?.points ?? [
      { x: sourceX, y: sourceY },
      { x: (sourceX + targetX) / 2, y: sourceY },
      { x: (sourceX + targetX) / 2, y: targetY },
      { x: targetX, y: targetY },
    ],
  );
  const arrive = reshaped ? c.lineIn : undefined;
  const state = data?.state ?? 'waiting';
  const look = data?.look;
  // Back from a folded milestone: it waits for the cards to slide in and show, then appears (never ahead of them).
  const was = useRef(look);
  const back = was.current === 'gone' && look !== 'gone';
  useEffect(() => {
    was.current = look;
  });
  const cls = cx(kind === 'next' ? c.flow : c.line, c[`${kind === 'next' ? 'flow' : 'line'}_${state}`], data?.current && c.lineCurrent, look && c[`look_${look}`], back && c.lineBack);
  const at = data?.label ? labelAt(points) : undefined;
  return (
    // Reshaped, it's drawn afresh (keyed), so its fade-in starts over.
    <g key={reshaped} className={arrive} data-from={source} data-to={target} data-kind={kind} data-state={state} data-look={look}>
      <BaseEdge id={id} path={roundedPath(points, kind === 'next' ? 14 : 10)} className={cls} interactionWidth={0} />
      {data?.joined ? null : <path d={arrowHead(points, kind === 'next' ? 5 : 3.5)} className={cx(cls, c.arrow)} />}
      {data?.join ? <JoinMark join={data.join} current={data.current} arrive={arrive} /> : null}
      {data?.label && at ? (
        <EdgeLabelRenderer>
          <div className={cx(c.flowLabel, c[`flowLabel_${state}`], arrive)} style={{ transform: `translate(-50%, -50%) translate(${at.x}px, ${at.y}px)` }}>
            {state === 'done' ? <LockMark open size={9} /> : <LockMark size={9} />}
            {data.label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </g>
  );
});

/**
 * Where the lines from several milestones meet: a small pill saying how many are in ("2/3"), and one
 * stem from it into the lock, solid green once all are in. Its tooltip names what it still waits on,
 * and the branch the milestone starts from.
 */
function JoinMark({ join, current, arrive }: { join: NonNullable<LineData['join']>; current: boolean; arrive: string | undefined }) {
  const cls = cx(c.flow, c[`flow_${join.state}`], current && c.lineCurrent);
  // The knot glides with the lines into it (it's keyed with its line, so a reshaped one starts afresh).
  const { points: stem } = useGlide(join.stem);
  const at = stem[0]!;
  return (
    <>
      <path d={roundedPath(stem, 14)} className={cls} />
      <path d={arrowHead(stem, 5)} className={cx(cls, c.arrow)} />
      <EdgeLabelRenderer>
        <div
          className={cx(c.flowLabel, c[`flowLabel_${join.state}`], c.joinKnot, arrive)}
          style={{ transform: `translate(-50%, -50%) translate(${at.x}px, ${at.y}px)` }}
          title={join.tip}
          aria-label={join.tip}
          data-join={`${join.passed}/${join.total}`}
        >
          <LockMark open={join.passed === join.total} size={9} />
          {join.passed}/{join.total}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const EDGE_TYPES = { line: PlanLine } as const;
