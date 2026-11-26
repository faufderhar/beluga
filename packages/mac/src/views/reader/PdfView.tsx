import { useCallback, useEffect, useRef, useState } from 'react';
import type { Location } from '@beluga/core/store.js';
import { Empty, IconButton, cx } from '../../components/ui.js';
import { useApi } from '../../lib/beluga.js';
import type { PDFDocumentProxy } from './pdf-lib.js';
import { usePinchZoom } from '../../components/usePinchZoom.js';
import r from './reader.module.css';

/**
 * A PDF, page under page, as wide as the space it has (zoom in and out like an image). Pages are
 * drawn as they scroll into view, so a long document opens at once.
 */

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
/** Fitted, a page never grows past this (a wide window would blow a page up to poster size). */
const FIT_MAX = 1.5;
const GAP = 12;

interface Size {
  readonly w: number;
  readonly h: number;
}

/** Base64 to bytes in a plain loop (a big PDF is tens of millions of bytes: no callback per byte). */
function base64Bytes(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Redraw at a new size once it has stopped changing (dragging the panel's edge, say); the pages stretch meanwhile. */
const SETTLE_MS = 150;
function useSettled<T>(value: T): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), SETTLE_MS);
    return () => clearTimeout(t);
  }, [value]);
  return settled;
}

const quiet = (): undefined => undefined;

/** Where a PDF comes from: a file at a place, or bytes already here (base64, a kept or fetched document). */
export type PdfSource = { readonly at: Location } | { readonly data: string };

/** The PDF read and opened (and let go when you leave it); read again when `version` changes. */
function usePdf(source: PdfSource, version: unknown): { doc?: PDFDocumentProxy; error?: string } {
  const api = useApi();
  const [state, setState] = useState<{ key: string; doc?: PDFDocumentProxy; error?: string }>();
  // Bytes key themselves (the same string again is the same document).
  const key = 'data' in source ? source.data : `${source.at.owner}\0${source.at.share}\0${source.at.path}`;
  useEffect(() => {
    let alive = true;
    let close: (() => void) | undefined;
    void (async () => {
      try {
        const read = 'data' in source ? Promise.resolve({ data: source.data }) : api.files.readImageFile(source.at);
        const [{ data }, lib] = await Promise.all([read, import('./pdf-lib.js')]);
        const opened = await lib.openPdf(base64Bytes(data));
        close = opened.close;
        if (alive) setState({ key, doc: opened.doc });
        else opened.close();
      } catch (err) {
        if (alive) setState({ key, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      alive = false;
      close?.();
    };
  }, [key, version]);
  return state?.key === key ? { ...(state.doc ? { doc: state.doc } : {}), ...(state.error ? { error: state.error } : {}) } : {};
}

/** One page: its place kept at the right size, drawn once it's near the screen. */
function Page({ doc, n, scale, guess }: { doc: PDFDocumentProxy; n: number; scale: number; guess: Size }) {
  const drawScale = useSettled(scale);
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<Size>();
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const seen = new IntersectionObserver(([e]) => setNear(!!e?.isIntersecting), { rootMargin: '600px 0px' });
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  useEffect(() => {
    if (!near) return;
    let task: { cancel: () => void } | undefined;
    let alive = true;
    void doc.getPage(n).then((page) => {
      const el = canvas.current;
      if (!alive || !el) return;
      const one = page.getViewport({ scale: 1 });
      setSize({ w: one.width, h: one.height });
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: drawScale * dpr });
      el.width = Math.floor(viewport.width);
      el.height = Math.floor(viewport.height);
      const render = page.render({ canvas: el, viewport });
      task = render;
      render.promise.catch(quiet);
    }, quiet); // (the document was closed meanwhile)
    return () => {
      alive = false;
      task?.cancel();
    };
  }, [near, drawScale, doc, n]);
  const s = size ?? guess;
  return (
    <div ref={box} className={r.pdfPage} style={{ width: Math.round(s.w * scale), height: Math.round(s.h * scale) }} aria-label={`Page ${n}`} role="img">
      <canvas ref={canvas} />
    </div>
  );
}

/**
 * Drawn with PDF.js rather than the web view's own viewer: the Mac's web view (WKWebView) draws a
 * PDF only as a whole page, so one in an iframe (a blob or a data URL) stays blank.
 */
export function PdfView({ controls, version, ...source }: PdfSource & { controls: boolean; version?: unknown }) {
  const { doc, error } = usePdf(source, version);
  const [width, setWidth] = useState(0);
  const [first, setFirst] = useState<Size>();
  const [zoom, setZoom] = useState<'fit' | number>('fit');
  // The stage appears once the PDF is open: watch its width from then on.
  const watch = useRef<ResizeObserver | undefined>(undefined);
  const stageEl = useRef<HTMLDivElement | null>(null);
  const stage = useCallback((el: HTMLDivElement | null) => {
    watch.current?.disconnect();
    watch.current = undefined;
    stageEl.current = el;
    if (!el) return;
    // The room inside its padding.
    const measure = (): void => {
      const css = getComputedStyle(el);
      setWidth(el.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight));
    };
    measure();
    watch.current = new ResizeObserver(measure);
    watch.current.observe(el);
  }, []);
  useEffect(() => {
    setFirst(undefined);
    let alive = true;
    doc?.getPage(1).then((p) => {
      const v = p.getViewport({ scale: 1 });
      if (alive) setFirst({ w: v.width, h: v.height });
    }, quiet);
    return () => {
      alive = false;
    };
  }, [doc]);
  // Two fingers on the trackpad zoom the pages (they stretch at once and are redrawn sharp when you stop).
  const fittedNow = first && width > 0 ? Math.min(FIT_MAX, width / first.w) : 1;
  usePinchZoom(stageEl, zoom === 'fit' ? fittedNow : zoom, setZoom, { min: 0.25, max: 6 });
  if (error) return <Empty icon="alert" title="Can’t show this PDF" detail={error} />;
  if (!doc || !first) return <div className={r.opening}>Opening…</div>;
  const fitted = width > 0 ? Math.min(FIT_MAX, width / first.w) : 1;
  const scale = zoom === 'fit' ? fitted : zoom;
  const step = (dir: 1 | -1): void => {
    const next = dir > 0 ? ZOOMS.find((z) => z > scale + 0.001) : [...ZOOMS].reverse().find((z) => z < scale - 0.001);
    if (next) setZoom(next);
  };
  const pages = Array.from({ length: doc.numPages }, (_, i) => i + 1);
  return (
    <div className={r.imageView}>
      <div ref={stage} className={cx(r.stage, r.pdfStage, zoom !== 'fit' && r.stageZoom)} style={{ gap: GAP }} aria-label={`PDF, ${doc.numPages} page${doc.numPages === 1 ? '' : 's'}`}>
        {pages.map((n) => (
          <Page key={n} doc={doc} n={n} scale={scale} guess={first} />
        ))}
      </div>
      {controls ? (
        <div className={r.zoomBar} role="toolbar" aria-label="Zoom">
          <IconButton size="small" icon="minus" label="Zoom out" onClick={() => step(-1)} />
          <button type="button" className={r.zoomValue} onClick={() => setZoom(zoom === 'fit' ? 1 : 'fit')} aria-label={zoom === 'fit' ? 'Actual size' : 'Fit to window'}>
            {zoom === 'fit' ? 'Fit' : `${Math.round(zoom * 100)}%`}
          </button>
          <IconButton size="small" icon="plus" label="Zoom in" onClick={() => step(1)} />
          <span className={r.zoomSize}>
            {doc.numPages} page{doc.numPages === 1 ? '' : 's'}
          </span>
        </div>
      ) : null}
    </div>
  );
}
