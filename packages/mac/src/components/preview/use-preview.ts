import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type PreviewProblem, type PreviewResult, renderProblem } from '@beluga/shared/preview/opened.js';
import { type PreviewRef, previewTitle } from '@beluga/shared/preview/ref.js';
import { useApi, useApp, useBeluga } from '../../lib/beluga.js';
import { forwardedUrl } from '../../machines/forwarded-url.js';
import { useClock } from '../../lib/window-active.js';
import { keptKey, readKept, withKept, writeKept } from './kept-props.js';
import { type FiredEvent, RETRYING, RETRY_MS, addEvent, mergeProps, previewOrigin, variantField } from './preview-model.js';

/**
 * A live preview's state and its talk with the daemon (preview.open, preview.snapshot) and its
 * frame (props in; size, events, failures, the tools' answers out). PreviewBlock.tsx draws it.
 */

type Ok = Extract<PreviewResult, { ok: true }>;
export type Canvas = 'light' | 'dark';
export const PIN_STATES = ['hover', 'focus', 'active'] as const;
export type PinState = (typeof PIN_STATES)[number];
export interface AuditIssue {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
}
type Shot = { readonly png?: string; readonly failed?: string };

/** How long a drawing rests before its newest picture is kept for the phone. */
const STILL_AFTER_MS = 1500;
/** How long a picture may take before it's given up on. */
const SHOT_MS = 8000;

export interface UsePreview {
  readonly frame: RefObject<HTMLIFrameElement | null>;
  readonly title: string;
  readonly result: PreviewResult | undefined;
  readonly ok: Ok | undefined;
  readonly src: { readonly id: string; readonly url: string } | undefined;
  readonly drawn: boolean;
  readonly height: number | undefined;
  readonly problem: PreviewProblem | undefined;
  readonly stale: PreviewProblem | undefined;
  readonly values: Readonly<Record<string, unknown>>;
  readonly touched: ReadonlySet<string>;
  readonly events: readonly FiredEvent[];
  readonly fired: Readonly<Record<string, number>>;
  readonly variants: boolean;
  readonly gallery: boolean;
  readonly canvas: Canvas;
  readonly pinned: readonly PinState[];
  readonly audit: readonly AuditIssue[] | undefined;
  open(): Promise<void>;
  /** A page (not a component) finished loading: it's drawn. */
  loaded(): void;
  change(name: string, value: unknown): void;
  clear(name: string): void;
  reset(): void;
  redraw(): void;
  setVariants(on: boolean): void;
  setGallery(on: boolean): void;
  setCanvas(c: Canvas): void;
  setPinned(states: readonly PinState[]): void;
  check(): void;
  closeAudit(): void;
  highlight(id: string): void;
  /** A picture of the drawing, saved in the worktree's scratch folder: its path there, or why not. */
  picture(): Promise<{ readonly path?: string; readonly failed?: string }>;
}

export function usePreview({ wsId, ref, pick, seen, framed }: { wsId: string; ref: PreviewRef; pick: string | undefined; seen: boolean; framed: boolean }): UsePreview {
  const api = useApi();
  // A worktree on one of your computers: its preview is served there, reached here through the app's forward.
  const { home, machine } = useBeluga();
  const frame = useRef<HTMLIFrameElement>(null);
  const page = ref.target.kind !== 'component';
  const title = previewTitle(ref);
  const phone = useApp((st) => st.companion.devices.length > 0);

  const [result, setResult] = useState<PreviewResult>();
  const [src, setSrc] = useState<{ id: string; url: string }>();
  const [drawn, setDrawn] = useState(false);
  const [height, setHeight] = useState<number>();
  const [failure, setFailure] = useState<PreviewProblem>();
  const [stale, setStale] = useState<PreviewProblem>();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [events, setEvents] = useState<FiredEvent[]>([]);
  const [fired, setFired] = useState<Record<string, number>>({});
  const [variants, setVariants] = useState(false);
  const [gallery, setGallery] = useState(false);
  const [canvas, setCanvas] = useState<Canvas>('light');
  const [pinned, setPinned] = useState<readonly PinState[]>([]);
  const [audit, setAudit] = useState<readonly AuditIssue[]>();
  const ready = useRef(false);
  const asking = useRef(false);
  /** Asked again while a request was out (another component picked, the frame lost): asked once more after it. */
  const again = useRef(false);
  const openNow = useRef<() => Promise<void>>(async () => undefined);
  /** The preview whose props are known (only then is what you change kept, never an empty start). */
  const keptReady = useRef<string | undefined>(undefined);
  const eventId = useRef(0);
  const shots = useRef<Array<(s: Shot) => void>>([]);
  // What you changed, read when a reopen's props arrive (never the value from when it was asked for).
  const touchedNow = useRef(touched);
  touchedNow.current = touched;

  const ok: Ok | undefined = result?.ok ? result : undefined;
  const fields = ok?.component?.props ?? [];
  const variantOf = useMemo(() => variantField(fields), [fields]);
  const problem = result && !result.ok ? result : failure;

  // What to ask the daemon for (the same request is the same preview: it's built once).
  const spec = useMemo(() => {
    const target = ref.target.kind === 'component' && pick ? { ...ref.target, export: pick } : ref.target;
    return { target, ...(ref.props ? { props: ref.props as Record<string, unknown> } : {}), ...(ref.css ? { css: ref.css } : {}), ...(ref.wrap ? { wrap: ref.wrap } : {}) };
  }, [JSON.stringify(ref), pick]);
  const kept = useMemo(() => keptKey(wsId, spec), [wsId, spec]);

  const open = useCallback(async () => {
    if (asking.current) {
      again.current = true;
      return;
    }
    asking.current = true;
    try {
      const opened = (await api.preview.open(wsId, spec)) as PreviewResult | undefined;
      if (!opened) return;
      const out = machine && opened.ok ? { ...opened, url: await forwardedUrl(home, machine, opened.url) } : opened;
      setResult(out);
      if (!out.ok) return;
      const fresh = out.props ?? {};
      const fieldsNow = out.component?.props ?? [];
      setSrc((was) => {
        if (was?.id === out.id) return was;
        // Another preview (a new build of a new wrapper, another component): drawn afresh.
        ready.current = false;
        setDrawn(false);
        setFailure(undefined);
        return { id: out.id, url: out.url };
      });
      const first = keptReady.current !== kept;
      setValues((was) => {
        const mine = touchedNow.current;
        if (!first && (Object.keys(was).length || mine.size)) return mergeProps(fieldsNow, fresh, was, mine);
        // The first time for this preview: what you changed before (kept in the window) comes back.
        const back = withKept(fieldsNow, fresh, readKept(kept));
        setTouched(back.touched);
        return back.values;
      });
      keptReady.current = kept;
    } catch {
      setResult({ ok: false, kind: 'build', title: 'The preview couldn’t start', detail: 'Try again in a moment.' });
    } finally {
      asking.current = false;
      if (again.current) {
        again.current = false;
        void openNow.current();
      }
    }
  }, [api, wsId, spec, kept]);
  openNow.current = open;

  // Another component picked: its own props, from the start.
  useEffect(() => {
    setValues({});
    setTouched(new Set());
    setGallery(false);
  }, [pick]);

  // Far off screen the frame is unloaded: on the way back it's opened again (the daemon may have let
  // it go meanwhile: a new one is built) and drawn afresh, with the same props.
  useEffect(() => {
    if (framed) {
      if (seen && src) void open();
      return;
    }
    ready.current = false;
    setDrawn(false);
  }, [framed]);

  // Built once it's about to be seen.
  useEffect(() => {
    if (seen) void open();
  }, [seen, spec]);

  // A problem that may clear up by itself (a save, the dev server starting, a wrapper written):
  // looked at again now and then, on the window's own clock (it rests while you look away).
  const retrying = Boolean(problem && (RETRYING.has(problem.kind) || problem.kind === 'provider'));
  const tick = useClock(retrying, RETRY_MS);
  useEffect(() => {
    if (retrying && tick) void open();
  }, [tick]);

  // What you changed is kept, a moment after you stop.
  useEffect(() => {
    if (!ok || keptReady.current !== kept) return;
    const t = setTimeout(() => writeKept(kept, values, touched), 300);
    return () => clearTimeout(t);
  }, [values, touched, kept, Boolean(ok)]);

  const origin = useMemo(() => previewOrigin(src?.url, typeof window === 'undefined' ? undefined : window.location.href), [src?.url]);

  const post = useCallback(
    (msg: Record<string, unknown>): boolean => {
      const win = frame.current?.contentWindow;
      if (!win || !ready.current || !origin) return false;
      win.postMessage(msg, origin);
      return true;
    },
    [origin],
  );

  const send = useCallback(() => {
    if (page) return;
    const all = gallery && ok?.gallery ? ok.gallery : undefined;
    const every = !all && variants && variantOf ? { name: variantOf.name, values: (variantOf.shape.kind === 'union' ? variantOf.shape.of : []).flatMap((o) => (o.kind === 'literal' && o.value !== null ? [o.value] : [])) } : undefined;
    post({ beluga: 'props', props: values, ...(every ? { variants: every } : {}), ...(all ? { gallery: all } : {}) });
  }, [page, gallery, ok, variants, variantOf, values, post]);

  // The frame's messages (only from this frame and its expected origin).
  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      if (!origin || e.origin !== origin || !frame.current || e.source !== frame.current.contentWindow || !e.data || typeof e.data !== 'object') return;
      const msg = e.data as { beluga?: string; height?: number; name?: string; detail?: string; message?: string; stack?: string; problem?: PreviewProblem; issues?: AuditIssue[]; png?: string; failed?: string };
      switch (msg.beluga) {
        case 'ready':
          ready.current = true;
          send();
          post({ beluga: 'canvas', dark: canvas === 'dark' });
          if (pinned.length) post({ beluga: 'pin', states: pinned });
          break;
        case 'size':
          if (typeof msg.height === 'number') setHeight(msg.height);
          break;
        case 'drawn':
          setDrawn(true);
          setFailure(undefined);
          break;
        case 'event': {
          const name = String(msg.name ?? 'callback');
          setEvents((list) => addEvent(list, name, String(msg.detail ?? ''), ++eventId.current));
          setFired((f) => ({ ...f, [name]: (f[name] ?? 0) + 1 }));
          break;
        }
        case 'error':
          setFailure(renderProblem(ok?.component?.name ?? title, String(msg.message ?? ''), String(msg.stack ?? '')));
          setDrawn(true);
          break;
        case 'rebuilt':
          setStale(undefined);
          // Its props may have changed with it.
          void open();
          break;
        case 'stale':
          if (msg.problem) setStale(msg.problem);
          break;
        case 'lost':
          // Its preview was let go (the Mac slept, say): opened again, as a new one.
          ready.current = false;
          setDrawn(false);
          setSrc(undefined);
          void open();
          break;
        case 'audit':
          setAudit(Array.isArray(msg.issues) ? msg.issues : []);
          break;
        case 'snapshot': {
          const waiting = shots.current;
          shots.current = [];
          for (const done of waiting) done({ ...(msg.png ? { png: msg.png } : {}), ...(msg.failed ? { failed: msg.failed } : {}) });
          break;
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [origin, send, post, open, ok, title, canvas, pinned]);

  // Every change of props goes straight to the frame.
  useEffect(() => send(), [send]);
  useEffect(() => void post({ beluga: 'canvas', dark: canvas === 'dark' }), [canvas, post]);
  useEffect(() => void post({ beluga: 'pin', states: pinned }), [pinned, post]);

  /** A picture from the frame, as a PNG data URL. */
  const shoot = useCallback(
    () =>
      new Promise<Shot>((resolve) => {
        if (!post({ beluga: 'snapshot' })) return resolve({ failed: 'It isn’t drawn yet' });
        const timer = setTimeout(() => resolve({ failed: 'It took too long' }), SHOT_MS);
        shots.current.push((s) => {
          clearTimeout(timer);
          resolve(s);
        });
      }),
    [post],
  );

  const picture = useCallback(async () => {
    const shot = await shoot();
    if (!shot.png) return { failed: shot.failed ?? 'It couldn’t be drawn as a picture' };
    try {
      const out = (await api.preview.snapshot(wsId, { target: spec.target, name: ok?.component?.name ?? title, png: shot.png })) as { ok: boolean; path?: string; title?: string };
      return out.ok && out.path ? { path: out.path } : { failed: out.title ?? 'it couldn’t be saved' };
    } catch {
      return { failed: 'it’s too big to save' };
    }
  }, [shoot, api, wsId, spec, ok, title]);

  // With a phone paired, each drawing's newest picture is kept for it (once it rests, never while hidden).
  const stillFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!phone || !drawn || problem || !src || !ok || !framed) return;
    const which = `${src.id}:${ok.version}:${JSON.stringify(values)}:${canvas}`;
    if (stillFor.current === which) return;
    const t = setTimeout(() => {
      if (document.visibilityState !== 'visible') return;
      stillFor.current = which;
      void shoot().then((shot) => {
        if (shot.png) api.preview.snapshot(wsId, { target: spec.target, name: title, png: shot.png, still: true }).catch(() => undefined);
      });
    }, STILL_AFTER_MS);
    return () => clearTimeout(t);
  }, [phone, drawn, problem, src, ok, framed, values, canvas, shoot, api, wsId, spec, title]);

  return {
    frame,
    title,
    result,
    ok,
    src,
    drawn,
    height,
    problem,
    stale,
    values,
    touched,
    events,
    fired,
    variants,
    gallery,
    canvas,
    pinned,
    audit,
    open,
    loaded: () => setDrawn(true),
    change: (name, value) => {
      setValues((v) => ({ ...v, [name]: value }));
      setTouched((t) => new Set(t).add(name));
    },
    clear: (name) => {
      setValues((v) => {
        const { [name]: _gone, ...rest } = v;
        return rest;
      });
      setTouched((t) => new Set(t).add(name));
    },
    reset: () => {
      setValues({ ...(ok?.props ?? {}) });
      setTouched(new Set());
      setFailure(undefined);
    },
    redraw: () => {
      ready.current = false;
      setDrawn(false);
      setFailure(undefined);
      setAudit(undefined);
      setSrc((was) => (was ? { ...was, url: `${was.url.split('#')[0]}#${Date.now()}` } : was));
      void open();
    },
    setVariants,
    setGallery: (on) => {
      setGallery(on);
      if (on) setVariants(false);
    },
    setCanvas,
    setPinned,
    check: () => void post({ beluga: 'audit' }),
    closeAudit: () => setAudit(undefined),
    highlight: (id) => void post({ beluga: 'highlight', id }),
    picture,
  };
}
