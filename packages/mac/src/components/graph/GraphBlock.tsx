import { Suspense, lazy, memo, useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { type Graph, parseGraph } from '@beluga/shared/graph-spec.js';
import { ActionsContext, type ActionItem } from '../SpecMenu.js';
import { CodeLines } from '../markdown/CodeLines.js';
import { IconButton } from '../ui.js';
import { copyText } from '../../lib/copy.js';
import { toast, useBeluga } from '../../lib/beluga.js';
import { type Size, fittedHeight, inlineHeight } from './graph-model.js';
import { cachedLayout } from './layout-cache.js';
import { GraphGlyph } from './marks.js';
import g from './graph.module.css';

/**
 * A ```beluga-graph block wherever Markdown is drawn (answers, reports, documents): a card with
 * the graph's title and the graph itself, which opens in the whole window. React Flow and ELK
 * load the first time a graph shows. While Claude is still writing the block it says so; a
 * block that's wrong says what's wrong and shows its JSON.
 */

const FlowGraph = lazy(() => import('./FlowGraph.js'));

export const GraphBlock = memo(function GraphBlock({ code, live = false, localImages = false, shapeKey }: { code: string; live?: boolean; localImages?: boolean; /** See FlowGraph: the graph changes in place while this stays the same. */ shapeKey?: string }) {
  const parsed = useMemo(() => parseGraph(code), [code]);
  if (!parsed.ok) {
    if (parsed.incomplete && live) {
      return (
        <figure className={g.block} data-state="drawing" aria-label="Graph">
          <div className={g.drawing}>
            <GraphGlyph size={14} />
            Drawing a graph…
          </div>
        </figure>
      );
    }
    return (
      <figure className={g.blockError} data-state="error">
        <figcaption>Can’t draw this graph: {parsed.error}</figcaption>
        <CodeLines text={code} lang="json" />
      </figure>
    );
  }
  return <GraphCard graph={parsed.graph} code={code} warnings={parsed.warnings} localImages={localImages} {...(shapeKey ? { shapeKey } : {})} />;
});

function useWidth(): [React.RefObject<HTMLElement | null>, number] {
  const ref = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(760);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const w = Math.round(entry?.contentRect.width ?? 0);
      // Only a real change moves the height (the conversation measures rows again).
      if (w) setWidth((now) => (Math.abs(now - w) > 24 ? w : now));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function GraphCard({ graph, code, warnings, localImages, shapeKey }: { graph: Graph; code: string; warnings: readonly string[]; localImages: boolean; shapeKey?: string }) {
  const { client } = useBeluga();
  const [full, setFull] = useState(false);
  const [ref, width] = useWidth();
  const [laid, setLaid] = useState<Size | undefined>(() => cachedLayout(shapeKey ?? code, 'inline')?.bounds);
  const height = laid ? fittedHeight(laid, width) : inlineHeight(graph, width);
  const parts = graph.nodes.filter((n) => n.type !== 'group').length;
  const copy = (): void => void copyText(JSON.stringify(JSON.parse(code), null, 2)).then(() => toast(client, 'Copied the graph as JSON', 'success'));
  const items: ActionItem[] = [
    { label: 'Open in Full Window', icon: 'expand', onSelect: () => setFull(true) },
    { label: 'Copy as JSON', icon: 'copy', onSelect: copy },
  ];
  const meta = [`${parts} ${parts === 1 ? 'part' : 'parts'}`, graph.steps.length ? `${graph.steps.length} ${graph.steps.length === 1 ? 'step' : 'steps'}` : ''].filter(Boolean).join(' · ');
  return (
    <>
      <ActionsContext items={items}>
      <figure ref={ref} className={g.block} data-state="ready" aria-label={graph.title ? `Graph: ${graph.title}` : 'Graph'}>
        <figcaption className={g.blockHead}>
          <span className={g.blockGlyph} aria-hidden="true">
            <GraphGlyph size={13} />
          </span>
          <span className={g.blockTitles} title={graph.summary ? `${graph.title ?? 'Graph'}\n${graph.summary}` : undefined}>
            <span className={g.blockTitle}>{graph.title ?? 'Graph'}</span>
            {graph.summary ? <span className={g.blockSummary}>{graph.summary}</span> : null}
          </span>
          <span className={g.blockMeta} title={warnings.length ? warnings.join('\n') : undefined}>
            {meta}
            {warnings.length ? ` · ${warnings.length} left out` : ''}
          </span>
        </figcaption>
        <div className={g.inlineFrame} style={{ height }}>
          <Suspense fallback={<div className={g.overlayNote}>Laying out…</div>}>
            <FlowGraph graph={graph} mode="inline" localImages={localImages} onExpand={() => setFull(true)} onCopy={copy} onLaidOut={setLaid} cacheKey={shapeKey ?? code} {...(shapeKey ? { shapeKey } : {})} />
          </Suspense>
        </div>
      </figure>
      </ActionsContext>
      {full ? <FullWindow graph={graph} code={shapeKey ?? code} localImages={localImages} onClose={() => setFull(false)} onCopy={copy} {...(shapeKey ? { shapeKey } : {})} /> : null}
    </>
  );
}

/** The graph in the whole window: a minimap, zoom buttons and room for its details. Esc closes. */
function FullWindow({ graph, code, localImages, onClose, onCopy, shapeKey }: { graph: Graph; code: string; localImages: boolean; onClose: () => void; onCopy: () => void; shapeKey?: string }) {
  return (
    <Dialog.Root open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className={g.fullOverlay} />
        <Dialog.Content className={g.full} aria-describedby={undefined} onOpenAutoFocus={(e) => e.preventDefault()}>
          <header className={g.fullHead}>
            <span className={g.blockIcon} aria-hidden="true">
              <GraphGlyph size={14} />
            </span>
            <Dialog.Title className={g.fullTitle}>{graph.title ?? 'Graph'}</Dialog.Title>
            {graph.summary ? <span className={g.blockSummary}>{graph.summary}</span> : null}
            <span className={g.grow} />
            <Dialog.Close asChild>
              <IconButton size="small" icon="x" label="Close" keys="esc" />
            </Dialog.Close>
          </header>
          <div className={g.fullFrame}>
            <Suspense fallback={<div className={g.overlayNote}>Laying out…</div>}>
              <FlowGraph graph={graph} mode="full" localImages={localImages} onCopy={onCopy} cacheKey={code} {...(shapeKey ? { shapeKey } : {})} />
            </Suspense>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
