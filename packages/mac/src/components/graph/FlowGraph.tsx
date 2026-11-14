import '@xyflow/react/dist/base.css';
import { type KeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  MiniMap,
  type NodeChange,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useNodesInitialized,
  useOnViewportChange,
  useReactFlow,
  useUpdateNodeInternals,
} from '@xyflow/react';
import type { Graph, GraphDirection, GraphNode } from '@beluga/shared/graph-spec.js';
import { IconButton } from '../ui.js';
import { reducedMotion, useDocTheme } from '../markdown/use-doc-theme.js';
import { type ElkOutput, type Focus, INLINE_MAX_HEIGHT, type Placed, type Route, SIMPLEX_MAX_EDGES, type Size, backEdges, bestLayout, elkGraph, fitZoom, handleSides, inlineAspect, neighborhood, nodeBoxes, parentsFirst, placeLabels, placesOf, routesOf, stepFocus, turned } from './graph-model.js';
import { PACK_FROM, packedLayout, startView } from './graph-pack.js';
import { cachedLayout, rememberLayout } from './layout-cache.js';
import { layout } from './layout.js';
import { useSharpZoom } from './sharp-zoom.js';
import { BUSY_FROM, detailAt } from './detail.js';
import { NODE_TYPES, type FlowNode, drawingOf } from './nodes.js';
import { EDGE_TYPES, EdgeMarkers, type FlowEdge } from './edges.js';
import { Inspector } from './Inspector.js';
import { Walkthrough } from './Walkthrough.js';
import g from './graph.module.css';

/**
 * A `beluga-graph`, drawn with React Flow and laid out by ELK. Nodes are drawn once out of
 * sight to learn their sizes, laid out, then shown. Point at a node to see what it touches,
 * click it for its details, step through the walkthrough Claude wrote, turn the layout, or open
 * the graph in the whole window (minimap, two-finger scroll pans, pinch zooms).
 *
 * A live graph (a board's What Waits on What, BLG-691) keeps its canvas while what it shows changes:
 * a status moving just redraws that card, and a task coming or going lays it out again in place,
 * keeping where you are.
 */

export interface FlowGraphProps {
  readonly graph: Graph;
  readonly mode: 'inline' | 'full';
  readonly localImages: boolean;
  /** Open this graph in the whole window (inline only). */
  readonly onExpand?: () => void;
  readonly onCopy?: () => void;
  /** Start in the walkthrough (the full window opened from a step). */
  readonly startStep?: number;
  /** The laid-out graph's size (the card fits its height to it). */
  readonly onLaidOut?: (size: Size) => void;
  /** The block's text: a graph laid out before is shown again at once (layout-cache.ts). */
  readonly cacheKey?: string;
  /** Nodes stand for something that opens (a task): the details panel's main button, and double-click. */
  readonly onOpen?: (nodeId: string) => void;
  readonly openLabel?: string;
  /**
   * What the layout depends on (its nodes and lines, not their statuses): while it stays the same,
   * a new graph (a CI run moving along) updates the drawing in place instead of laying it out again.
   */
  readonly shapeKey?: string;
  /** It shows something that changes as you look (a board): new shapes lay out in place, keeping the view. */
  readonly live?: boolean;
  /** A busy graph of loose pieces (a board): packed into the frame's shape (graph-pack.ts). */
  readonly pack?: boolean;
  /** What a graph too big to read whole opens on (the work going on), in the whole window. */
  readonly startAt?: readonly string[];
}

/** A fresh canvas for each graph (Claude rewrote the block, the file changed): nothing carries over. */
const graphKeys = new WeakMap<Graph, number>();
let nextKey = 0;
const keyOf = (graph: Graph): number => {
  let k = graphKeys.get(graph);
  if (k === undefined) graphKeys.set(graph, (k = ++nextKey));
  return k;
};

export default function FlowGraph(props: FlowGraphProps) {
  return (
    <ReactFlowProvider>
      <Canvas key={props.live ? 'live' : (props.shapeKey ?? keyOf(props.graph))} {...props} />
    </ReactFlowProvider>
  );
}

type Phase = 'measuring' | 'laying-out' | 'ready' | 'failed';

const NO_FOCUS: Focus = { nodes: new Set(), edges: new Set() };

const cx = (...c: Array<string | false | undefined>): string => c.filter(Boolean).join(' ');

function baseNodes(graph: Graph, direction: GraphDirection, localImages: boolean): FlowNode[] {
  const sides = handleSides(direction);
  return parentsFirst(graph.nodes).map((node) => ({
    id: node.id,
    type: drawingOf(node),
    position: { x: 0, y: 0 },
    data: { node, sides, localImages },
    ...(node.group ? { parentId: node.group } : {}),
    ...(node.type === 'group' ? { selectable: true, draggable: false, style: { width: 200, height: 120 }, zIndex: -1 } : {}),
  }));
}

/** Nodes moved to where the layout put them (groups get their size), their handles on the right sides. */
function placeNodes(nodes: readonly FlowNode[], places: ReadonlyMap<string, Placed>, direction: GraphDirection): FlowNode[] {
  const sides = handleSides(direction);
  return nodes.map((n) => {
    const at = places.get(n.id);
    const data = { ...n.data, sides };
    if (!at) return { ...n, data };
    const box = n.data.node.type === 'group' ? { style: { ...n.style, width: at.width, height: at.height }, width: at.width, height: at.height } : {};
    return { ...n, data, position: { x: at.x, y: at.y }, ...box };
  });
}

/** Room for the walkthrough's caption along the bottom. */
const STEP_PADDING = { top: '48px', left: '48px', right: '48px', bottom: '150px' } as const;

/** What a live graph's layout depends on: the nodes, the groups they're in, and the lines (in any order: a task moving up its list isn't a new shape). */
const shapeOf = (graph: Graph): string => JSON.stringify([graph.nodes.map((n) => `${n.id}:${n.type}:${n.group ?? ''}`).sort(), graph.edges.map((e) => `${e.id}:${e.from}:${e.to}`).sort()]);

const sameNode = (a: GraphNode, b: GraphNode): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/** How small you can zoom out: always far enough to see the whole graph. */
const MIN_ZOOM = 0.15;

function Canvas({ graph, mode, localImages, onExpand, onCopy, startStep, onLaidOut, cacheKey, onOpen, openLabel, live, pack, startAt }: FlowGraphProps) {
  const uid = useId().replace(/[^\w-]/g, '');
  const theme = useDocTheme();
  const motion = !reducedMotion();
  const flow = useReactFlow<FlowNode, FlowEdge>();
  useSharpZoom();
  const updateInternals = useUpdateNodeInternals();
  const initialized = useNodesInitialized();
  // Laid out before (this graph scrolled out of the conversation and back): show it at once.
  const [cached] = useState(() => cachedLayout(cacheKey, mode));
  const [direction, setDirection] = useState<GraphDirection>(cached?.direction ?? graph.direction);
  const [nodes, setNodes] = useState<FlowNode[]>(() => {
    const base = baseNodes(graph, cached?.direction ?? graph.direction, localImages);
    return cached ? placeNodes(base, cached.places, cached.direction) : base;
  });
  const [phase, setPhase] = useState<Phase>(cached ? 'ready' : 'measuring');
  const [hover, setHover] = useState<string>();
  // While the view moves, cards sliding under a still pointer don't light up one after another (each
  // relights the whole drawing): what's under it once the view stops does (BLG-931).
  const moving = useRef(false);
  const pointer = useRef<{ x: number; y: number }>(undefined);
  const point = (id: string | undefined): void => {
    if (!moving.current) setHover(id && graph.nodes.find((n) => n.id === id)?.type !== 'group' ? id : undefined);
  };
  const pointAgain = (): void => {
    const at = pointer.current;
    const under = at ? document.elementFromPoint(at.x, at.y)?.closest<HTMLElement>('.react-flow__node') : undefined;
    point(under && wrap.current?.contains(under) ? (under.dataset.id ?? undefined) : undefined);
  };
  const [selected, setSelected] = useState<string>();
  const [step, setStep] = useState<number>(startStep ?? -1);
  const stepRef = useRef(step);
  stepRef.current = step;
  const sizes = useRef(new Map<string, Size>());
  // ELK's lines, and the nodes dragged since (their lines curve to wherever they are now).
  const [routes, setRoutes] = useState<ReadonlyMap<string, Route>>(cached?.routes ?? new Map());
  const [moved, setMoved] = useState<ReadonlySet<string>>(new Set());
  // Nodes new to a live graph, drawn out of sight until the layout has a place for them.
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  // Bumped when a live graph changes shape: lay it out again once its new nodes are measured.
  const [reshaped, setReshaped] = useState(0);
  const [floor, setFloor] = useState(MIN_ZOOM);
  // You moved the view yourself: a resize leaves it where you put it.
  const touched = useRef(false);
  const run = useRef(0);
  const wrap = useRef<HTMLDivElement>(null);
  const duration = motion ? 450 : 0;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const busy = graph.nodes.length >= BUSY_FROM;

  // A busy graph's level of detail follows the zoom, set on the canvas itself: zooming never redraws React.
  const detail = (zoom: number): void => {
    const box = wrap.current;
    const want = detailAt(graph.nodes.length, zoom);
    if (!box || box.dataset.detail === want) return;
    if (want) box.dataset.detail = want;
    else delete box.dataset.detail;
  };
  useOnViewportChange({ onChange: (v) => detail(v.zoom) });
  useEffect(() => detail(flow.getZoom()), [busy]);

  // The whole drawing, lines included (ELK's lines can reach past the nodes), framed in the canvas.
  const bounds = useRef<Size | undefined>(cached?.bounds);
  const frameAll = (ms: number): void => {
    const box = wrap.current;
    const b = bounds.current;
    if (!box || !b) return void flow.fitView({ padding: 0.1, maxZoom: 1, duration: ms });
    const pad = mode === 'inline' ? 10 : 28;
    // Hidden or tiny (being shown, a collapsed row): wait for a real size.
    if (box.clientWidth <= pad * 2 + 20 || box.clientHeight <= pad * 2 + 20) return;
    const zoom = Math.max(0.05, Math.min(1, (box.clientWidth - pad * 2) / b.width, (box.clientHeight - pad * 2) / b.height));
    void flow.setViewport({ x: (box.clientWidth - b.width * zoom) / 2, y: (box.clientHeight - b.height * zoom) / 2, zoom }, { duration: ms });
  };

  // Walkthrough: each step frames what it's about.
  const steps = graph.steps;
  const current = step >= 0 ? steps[step] : undefined;
  const frameStep = (i: number, ms: number): void => {
    const s = steps[i];
    const ids = s ? [...stepFocus(graph, s).nodes].map((id) => ({ id })) : [];
    if (ids.length) void flow.fitView({ nodes: ids, padding: STEP_PADDING, maxZoom: 1.1, duration: ms });
    else frameAll(ms);
  };
  // In the whole window, a graph too big to read whole opens readable, on the work going on (startAt).
  const frameStart = (ms: number): void => {
    const box = wrap.current;
    const b = bounds.current;
    if (mode === 'inline' || !startAt || !box || !b) return frameAll(ms);
    const boxOf = (id: string) => {
      const n = flow.getInternalNode(id);
      return n ? { ...n.internals.positionAbsolute, width: n.measured.width ?? n.width ?? 0, height: n.measured.height ?? n.height ?? 0 } : undefined;
    };
    // The outermost group a node is in (or itself): where the view's corner may sit.
    const outermost = (id: string): string => {
      const up = flow.getInternalNode(id)?.parentId;
      return up ? outermost(up) : id;
    };
    const ids = startAt.filter((id) => flow.getInternalNode(id)?.data.node.type !== 'group');
    const wanted = ids.flatMap((id) => boxOf(id) ?? []);
    const anchors = [...new Set(ids.map(outermost))].flatMap((id) => boxOf(id) ?? []);
    void flow.setViewport(startView(b, { width: box.clientWidth, height: box.clientHeight }, wanted, anchors), { duration: ms });
  };
  const frame = (ms: number): void => (stepRef.current >= 0 ? frameStep(stepRef.current, ms) : frameStart(ms));

  // The same shape with new words or statuses (shapeKey, or a live graph): only the nodes that changed take them, where they are.
  const first = useRef(graph);
  useEffect(() => {
    if (first.current === graph) return;
    const before = first.current;
    first.current = graph;
    if (live && shapeOf(before) !== shapeOf(graph)) return reshape();
    const by = new Map(graph.nodes.map((n) => [n.id, n]));
    setNodes((now) => now.map((n) => (by.has(n.id) && !sameNode(n.data.node, by.get(n.id)!) ? { ...n, data: { ...n.data, node: by.get(n.id)! } } : n)));
  }, [graph]);

  // A live graph changed shape: the nodes still there keep their places, new ones wait out of sight for the layout.
  const reshape = (): void => {
    const had = new Map(flow.getNodes().map((n) => [n.id, n]));
    setNodes(
      baseNodes(graph, direction, localImages).map((b) => {
        const was = had.get(b.id);
        return was && was.parentId === b.parentId && was.type === b.type ? { ...was, data: { ...was.data, node: b.data.node } } : b;
      }),
    );
    setPending(new Set(graph.nodes.filter((n) => !had.has(n.id)).map((n) => n.id)));
    setReshaped((r) => r + 1);
  };

  // Shown from the cache: frame it once React Flow knows the canvas, and size the card.
  useEffect(() => {
    if (!cached) return;
    onLaidOut?.(cached.bounds);
    requestAnimationFrame(() => frame(0));
  }, []);

  /**
   * Lay the graph out. With `choose`, it's tried both ways round, plainly and wrapped onto more
   * rows, and the one that reads biggest in the frame wins (bestLayout); else only `start`'s way.
   * A busy graph asked to (`pack`) is packed into the frame's shape instead of wrapped. `keep`: a
   * live graph laid out again, the view stays where you are.
   */
  const lay = useCallback(
    async (start: GraphDirection, choose: boolean, keep = false): Promise<void> => {
      const mine = ++run.current;
      setPhase((p) => (p === 'ready' ? p : 'laying-out'));
      const box = wrap.current;
      const real = !!box && box.clientWidth > 0 && box.clientHeight > 0;
      const aspect = box && real ? (mode === 'inline' ? inlineAspect(box.clientWidth) : box.clientWidth / box.clientHeight) : undefined;
      // In a conversation the card grows to fit the graph (up to a point).
      const room = box && real ? { width: box.clientWidth, height: mode === 'inline' ? INLINE_MAX_HEIGHT : box.clientHeight } : undefined;
      const packed = !!pack && graph.nodes.length >= PACK_FROM;
      // A busy graph takes a while to lay out: only the way it was asked for (packed, each piece is quick).
      const ways = choose && room && (packed || graph.edges.length <= SIMPLEX_MAX_EDGES) ? [start, turned(start)] : [start];
      const tries = ways.flatMap((dir) => (packed ? [undefined] : [undefined, ...(aspect ? [aspect] : [])]).map((shape) => ({ dir, shape })));
      // A layout that fails (or takes too long) just isn't a choice.
      const done = await Promise.allSettled(tries.map((t) => (packed ? packedLayout(graph, sizes.current, t.dir, aspect ?? 1.6, layout) : layout(elkGraph(graph, sizes.current, t.dir, t.shape)))));
      if (mine !== run.current) return;
      const laid = tries.flatMap((t, i) => {
        const r = done[i]!;
        return r.status === 'fulfilled' ? [{ direction: t.dir, wrapped: t.shape !== undefined, size: { width: r.value.width ?? 0, height: r.value.height ?? 0 }, out: r.value }] : [];
      });
      const pick = room ? bestLayout(laid, room, start) : laid[0];
      // A live graph that can't be laid out again keeps the drawing it has (its new nodes show where they are).
      if (!pick) return keep ? setPending(new Set()) : setPhase('failed');
      const out: ElkOutput = pick.out;
      const dir = pick.direction;
      if (dir !== start) setDirection(dir);
      const places = placesOf(out);
      // Labels ELK left alone find a free spot on their line.
      const lines = placeLabels(routesOf(out, backEdges(graph)), new Map(graph.edges.flatMap((e) => (e.label ? [[e.id, e.label] as const] : []))), nodeBoxes(out));
      setRoutes(lines);
      setMoved(new Set());
      if (out.width && out.height) {
        bounds.current = { width: out.width, height: out.height };
        onLaidOut?.(bounds.current);
        rememberLayout(cacheKey, mode, { direction: dir, places, routes: lines, bounds: bounds.current });
        // Zooming out always goes far enough to see all of it.
        if (room) setFloor(Math.max(0.02, Math.min(MIN_ZOOM, fitZoom(bounds.current, room, 28) * 0.8)));
      }
      setNodes((now) => placeNodes(now, places, dir));
      // The handles moved sides: React Flow measures them again before drawing lines.
      requestAnimationFrame(() => {
        if (mine !== run.current) return;
        updateInternals(graph.nodes.map((n) => n.id));
        requestAnimationFrame(() => {
          if (mine !== run.current) return;
          if (!keep) frame(phaseRef.current === 'ready' ? duration : 0);
          setPending(new Set());
          setPhase('ready');
        });
      });
    },
    [graph, mode, duration, cacheKey, pack, startAt],
  );

  // (React Flow's "initialized" can still be the last shape's for a moment.)
  const allMeasured = (): boolean => graph.nodes.every((n) => n.type === 'group' || !!flow.getInternalNode(n.id)?.measured.width);

  /** What each node measures now (the layout's sizes). */
  const measure = (): void => {
    for (const n of flow.getNodes()) {
      if (n.data.node.type === 'group') continue;
      const w = n.measured?.width;
      const h = n.measured?.height;
      if (w && h) sizes.current.set(n.id, { width: Math.ceil(w), height: Math.ceil(h) });
    }
  };

  // Every node has been measured once: lay out with the real sizes.
  useEffect(() => {
    if (!initialized || phase !== 'measuring' || !allMeasured()) return;
    measure();
    void lay(direction, true);
  }, [initialized, phase]);

  // A live graph changed shape: once its new nodes are measured, lay it out again where you are.
  useEffect(() => {
    if (!reshaped || !initialized || phaseRef.current === 'measuring' || !allMeasured()) return;
    measure();
    void lay(direction, false, true);
  }, [reshaped, initialized]);

  // The frame changed size (the card fit its height, the window was resized): frame the graph again.
  useEffect(() => {
    const box = wrap.current;
    if (!box) return;
    let last = '';
    const observer = new ResizeObserver(() => {
      const size = `${box.clientWidth}x${box.clientHeight}`;
      if (size === last) return;
      const first = !last;
      last = size;
      if (!first && phaseRef.current !== 'measuring' && stepRef.current < 0 && !touched.current) frame(0);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [mode]);

  const turn = (): void => {
    const next = turned(direction);
    setDirection(next);
    // Sizes from the cache aren't known: measure first (the canvas stays as it is meanwhile).
    if (!sizes.current.size) {
      for (const n of flow.getNodes()) {
        const w = n.measured?.width;
        const h = n.measured?.height;
        if (n.data.node.type !== 'group' && w && h) sizes.current.set(n.id, { width: Math.ceil(w), height: Math.ceil(h) });
      }
    }
    touched.current = false;
    void lay(next, false);
  };

  useEffect(() => {
    if (phase === 'ready' && step >= 0) frameStep(step, duration);
  }, [step, phase]);
  const goStep = (i: number): void => {
    setSelected(undefined);
    if (i < 0 || i >= steps.length) {
      setStep(-1);
      frameAll(duration);
      return;
    }
    setStep(i);
  };

  // What's lit: the step, else what you point at, else what you picked. (Kept while nothing changes,
  // so dragging doesn't redraw every line.)
  const focus = useMemo<Focus>(() => (current ? stepFocus(graph, current) : hover ? neighborhood(graph, hover) : selected ? neighborhood(graph, selected) : NO_FOCUS), [graph, current, hover, selected]);
  const lit = focus.nodes.size > 0;

  // Only what's lit is marked (the canvas dims the rest, data-lit): pointing at a node redraws its
  // neighbours, not every node and line. Nodes and lines that didn't change stay the same objects.
  const nodeCache = useRef(new Map<string, { readonly base: FlowNode; readonly className: string; readonly selected: boolean; readonly out: FlowNode }>());
  const shown = useMemo(() => {
    const cache = nodeCache.current;
    return nodes.map((n) => {
      const className = cx(lit && focus.nodes.has(n.id) && g.nodeHot, pending.has(n.id) && g.nodePending);
      const isSelected = n.id === selected;
      const was = cache.get(n.id);
      if (was && was.base === n && was.className === className && was.selected === isSelected) return was.out;
      const out = { ...n, className, selected: isSelected };
      cache.set(n.id, { base: n, className, selected: isSelected, out });
      return out;
    });
  }, [nodes, focus, lit, selected, pending]);
  const edgeCache = useRef(new Map<string, { readonly key: string; readonly route: Route | undefined; readonly out: FlowEdge }>());
  const edges = useMemo<FlowEdge[]>(() => {
    const cache = edgeCache.current;
    return graph.edges.map((e) => {
      const hot = lit && focus.edges.has(e.id);
      const route = routes.has(e.id) && !moved.has(e.from) && !moved.has(e.to) ? routes.get(e.id) : undefined;
      const key = JSON.stringify([e.from, e.to, e.kind, e.label, e.emphasis, e.animated, hot, uid, motion]);
      const was = cache.get(e.id);
      if (was && was.key === key && was.route === route) return was.out;
      const out: FlowEdge = {
        id: e.id,
        source: e.from,
        target: e.to,
        type: 'graph',
        ...(hot ? { className: g.edgeLit } : {}),
        data: { kind: e.kind, state: hot ? 'hot' : 'none', markers: uid, motion, ...(route ? { route } : {}), ...(e.label ? { label: e.label } : {}), ...(e.emphasis ? { emphasis: true } : {}), ...(e.animated !== undefined ? { animated: e.animated } : {}) },
      };
      cache.set(e.id, { key, route, out });
      return out;
    });
  }, [graph, focus, lit, uid, motion, routes, moved]);

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    // Selection is this graph's own (one node at a time); the rest (sizes, drags) is React Flow's.
    setNodes((now) => applyNodeChanges(changes.filter((c) => c.type !== 'select'), now));
  }, []);

  const focusNode = (id: string): void => {
    setSelected(id);
    const n = flow.getInternalNode(id);
    if (!n) return;
    const w = n.measured.width ?? 0;
    const h = n.measured.height ?? 0;
    void flow.setCenter(n.internals.positionAbsolute.x + w / 2, n.internals.positionAbsolute.y + h / 2, { zoom: Math.max(flow.getZoom(), 0.9), duration });
  };

  const inline = mode === 'inline';
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && (step >= 0 || selected)) {
      e.stopPropagation();
      if (selected) setSelected(undefined);
      else goStep(-1);
      return;
    }
    // In the whole window: + and − zoom, 0 fits it all in.
    if (!inline && step < 0 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const zoom = e.key === '+' || e.key === '=' ? 'in' : e.key === '-' ? 'out' : e.key === '0' ? 'fit' : undefined;
      if (zoom) {
        e.preventDefault();
        if (zoom === 'fit') frameAll(duration);
        else void (zoom === 'in' ? flow.zoomIn({ duration }) : flow.zoomOut({ duration }));
        return;
      }
    }
    if (step < 0) return;
    if (e.key === 'ArrowRight') (e.preventDefault(), goStep(Math.min(steps.length - 1, step + 1)));
    if (e.key === 'ArrowLeft') (e.preventDefault(), goStep(Math.max(0, step - 1)));
  };

  const picked = selected ? graph.nodes.find((n) => n.id === selected) : undefined;
  const across = direction === 'right' || direction === 'left';

  return (
    <div ref={wrap} className={g.canvas} data-mode={mode} data-phase={phase} data-ready={phase === 'ready' ? 'true' : 'false'} data-lit={lit ? 'true' : undefined} onKeyDown={onKeyDown} onPointerMove={(e) => (pointer.current = { x: e.clientX, y: e.clientY })} onPointerLeave={() => (pointer.current = undefined)} tabIndex={-1}>
      <EdgeMarkers id={uid} />
      <ReactFlow<FlowNode, FlowEdge>
        nodes={shown}
        edges={edges}
        // A busy graph laid out draws only what's in view (all of it while new nodes wait to be measured).
        onlyRenderVisibleElements={busy && phase === 'ready' && !pending.size}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onNodeDragStart={(_e, n) => setMoved((m) => new Set([...m, n.id, ...graph.nodes.filter((x) => x.group === n.id).map((x) => x.id)]))}
        onNodeClick={(_e, n) => setSelected((s) => (s === n.id ? undefined : n.id))}
        {...(onOpen ? { onNodeDoubleClick: (_e: unknown, n: FlowNode) => onOpen(n.id) } : {})}
        onNodeMouseEnter={(_e, n) => point(n.id)}
        onNodeMouseLeave={() => point(undefined)}
        onPaneClick={() => setSelected(undefined)}
        colorMode={theme}
        minZoom={floor}
        maxZoom={2.5}
        nodesConnectable={false}
        nodesDraggable
        elementsSelectable
        selectNodesOnDrag={false}
        zoomOnDoubleClick={false}
        // In a conversation, scrolling scrolls the conversation; pinch zooms and dragging pans.
        zoomOnScroll={false}
        panOnScroll={!inline}
        // Two fingers move the drawing as far as they move, like any scrolling view (React Flow's own is half that).
        panOnScrollSpeed={1}
        onMoveStart={(e) => {
          if (e) touched.current = true;
          moving.current = true;
        }}
        onMoveEnd={() => {
          moving.current = false;
          pointAgain();
        }}
        preventScrolling={!inline}
        // React Flow's Space-to-pan listens on the whole window and swallows Space there: inline (in a
        // chat or a document) Space scrolls the page; dragging still pans.
        panActivationKeyCode={inline ? null : 'Space'}
        zoomOnPinch
        panOnDrag
        // Nothing in a graph is deleted by a key (React Flow listens for Backspace on the whole window).
        deleteKeyCode={null}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1.2} className={g.dots} />
        {!inline ? <MiniMap pannable zoomable className={g.minimap} nodeClassName={(n) => (n.type === 'group' ? g.miniGroup! : g.miniNode!)} /> : null}
        <Panel position="top-right" className={g.tools}>
          {steps.length ? <IconButton icon="play" label={step >= 0 ? 'Leave the Walkthrough' : 'Walk Me Through It'} active={step >= 0} onClick={() => goStep(step >= 0 ? -1 : 0)} /> : null}
          <IconButton icon={across ? 'chevronDown' : 'chevronRight'} label={across ? 'Lay Out Top to Bottom' : 'Lay Out Left to Right'} onClick={turn} />
          <IconButton icon="outline" label="Fit to View" onClick={() => frameAll(duration)} />
          {onCopy ? <IconButton icon="copy" label="Copy as JSON" onClick={onCopy} /> : null}
          {onExpand ? <IconButton icon="expand" label="Open in Full Window" onClick={onExpand} /> : null}
        </Panel>
        {!inline ? (
          <Panel position="bottom-left" className={g.zoom}>
            <IconButton icon="minus" label="Zoom Out" onClick={() => void flow.zoomOut({ duration })} />
            <IconButton icon="plus" label="Zoom In" onClick={() => void flow.zoomIn({ duration })} />
          </Panel>
        ) : null}
      </ReactFlow>
      {phase === 'failed' ? <div className={g.overlayNote}>Couldn’t lay this graph out.</div> : phase !== 'ready' ? <div className={g.overlayNote}>Laying out…</div> : null}
      {current ? <Walkthrough steps={steps} index={step} onGo={goStep} /> : null}
      {picked ? <Inspector graph={graph} node={picked} onPick={focusNode} onClose={() => setSelected(undefined)} wide={!inline} {...(onOpen ? { onOpen: () => onOpen(picked.id), openLabel: openLabel ?? 'Open' } : {})} /> : null}
    </div>
  );
}
