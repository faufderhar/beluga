import * as Dialog from '@radix-ui/react-dialog';
import { Icon } from '../components/Icon.js';
import { Button, Kbd, Tip, cx } from '../components/ui.js';
import { toast, useApi, useBeluga } from '../lib/beluga.js';
import { chordLabel } from '../lib/shortcuts-model.js';
import { pinchStep } from '../components/pinch-model.js';
import { useDecoded } from '../components/use-decoded.js';
import { type Size, type ZoomView, clampView, doubleClickScale, fitScale, fitView, isZoomed, panBy, transformOf, zoomAt } from '../components/zoom-model.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { openWithDefaultApp } from '../lib/files.js';
import { type ChatImage, closeLightbox, copyImage, imageGone, loadImage, openLightbox, stepLightbox, unavailableText, useImage, useLightbox } from './images.js';
import s from './images.module.css';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** One image in a message: a thumbnail that opens full size (with the message's other images a step away). */
export function Thumb({ image, all, index, tiled }: { image: ChatImage; all: readonly ChatImage[]; index: number; tiled: boolean }) {
  const api = useApi();
  const state = useImage(api, image);
  const name = `${image.label}${image.detail ? ` (${image.detail})` : ''}`;
  if (state.status === 'error') {
    const why = unavailableText(state.error);
    return (
      <div className={cx(s.thumb, s.failed, tiled && s.tile)} role="img" aria-label={`${name}: ${why.text}`} title={why.detail}>
        <Icon name={imageGone(state.error) ? 'image' : 'alert'} size={14} />
        <span>{why.text}</span>
      </div>
    );
  }
  return (
    <button type="button" className={cx(s.thumb, tiled && s.tile, state.status === 'loading' && s.loading)} aria-label={`Open ${name}`} onClick={() => openLightbox(all, index)} disabled={state.status !== 'ready'}>
      {state.status === 'ready' ? <img src={state.url} alt={name} draggable={false} /> : null}
    </button>
  );
}

/** The images a message links to: one keeps its shape, several sit in a neat grid. */
export function ImageGrid({ images }: { images: readonly ChatImage[] }) {
  if (!images.length) return null;
  const tiled = images.length > 1;
  return (
    <div className={cx(s.grid, tiled && s.gridMany, images.length === 2 && s.gridTwo)}>
      {images.map((img, i) => (
        <Thumb key={img.href} image={img} all={images} index={i} tiled={tiled} />
      ))}
    </div>
  );
}

/** Room left around a fitted picture (px, each side). */
const FIT_PAD = 24;

/**
 * The picture, fitted and centered (any size, any shape); pinch, Ctrl+scroll or double-click to
 * zoom around the cursor, then drag or scroll to look around. It's drawn at its own size and only
 * moved with a transform, a frame at a time, so zooming never lays the window out again.
 */
function Full({ image }: { image: ChatImage }) {
  const api = useApi();
  const state = useImage(api, image, 'full');
  // A new picture is decoded before it replaces the one on screen.
  const pic = useDecoded(state.status === 'ready' ? state.url : undefined);
  const frame = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  const live = useRef({ view: { scale: 1, x: 0, y: 0 } as ZoomView, fit: 1, size: { w: 0, h: 0 } as Size, frame: { w: 0, h: 0 } as Size, frameId: 0, idle: 0, dragged: false });
  const fittedFor = useRef<string | undefined>(undefined);
  const [zoomed, setZoomed] = useState(false);

  const draw = (): void => {
    const z = live.current;
    z.frameId = 0;
    const el = picture.current;
    if (!el) return;
    // Laid out at the fitted size (a box inside the frame), and only scaled past it while zoomed.
    // (A picture with no size of its own, like a broken one, keeps whatever size it draws at.)
    const w = z.size.w ? `${z.size.w * z.fit}px` : '';
    const h = z.size.h ? `${z.size.h * z.fit}px` : '';
    if (el.style.width !== w || el.style.height !== h) Object.assign(el.style, { width: w, height: h });
    el.style.transform = transformOf(z.view, z.size, z.fit);
  };
  /** Shown as `v` on the next frame (many events in one frame draw once); `moving` keeps it on its own layer meanwhile. */
  const show = (v: ZoomView, how: 'moving' | 'glide' | 'still' = 'moving'): void => {
    const z = live.current;
    z.view = v;
    const el = picture.current;
    if (el) {
      el.style.transition = how === 'glide' ? 'transform 160ms var(--ease-out, ease-out)' : '';
      if (how !== 'still') {
        // On its own layer while it moves; let go once it rests, so it's drawn sharp at the new size.
        el.style.willChange = 'transform';
        window.clearTimeout(z.idle);
        z.idle = window.setTimeout(() => {
          if (picture.current) picture.current.style.willChange = '';
        }, 220);
      }
    }
    if (how === 'still') draw();
    else if (!z.frameId) z.frameId = requestAnimationFrame(draw);
    setZoomed(isZoomed(v, z.fit));
  };
  const measure = (): Size => {
    const el = frame.current;
    return (live.current.frame = el ? { w: el.clientWidth, h: el.clientHeight } : { w: 0, h: 0 });
  };
  /** Where the cursor is, from the frame's center. */
  const from = (clientX: number, clientY: number): { x: number; y: number } => {
    const r = frame.current?.getBoundingClientRect();
    return r ? { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 } : { x: 0, y: 0 };
  };
  const zoomTo = (scale: number, clientX: number, clientY: number, how: 'moving' | 'glide' = 'moving'): void => {
    const z = live.current;
    show(zoomAt(z.view, scale, from(clientX, clientY), z.size, z.frame, z.fit), how);
  };

  // A picture is on screen (or a newer version of it): fitted and centered the first time, kept where it is after.
  useLayoutEffect(() => {
    if (!pic) return;
    const z = live.current;
    const frameSize = measure();
    const same = fittedFor.current === image.href && z.size.w === pic.w && z.size.h === pic.h;
    z.size = { w: pic.w, h: pic.h };
    z.fit = fitScale(z.size, frameSize, FIT_PAD);
    show(same ? clampView(z.view, z.size, frameSize) : fitView(z.size, frameSize, FIT_PAD), 'still');
    fittedFor.current = image.href;
  }, [pic?.url, image.href]);

  // The window is resized: still fitted (and centered) if it was, else kept in the frame.
  useEffect(() => {
    const el = frame.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const z = live.current;
      if (!z.size.w) return;
      const wasZoomed = isZoomed(z.view, z.fit);
      const frameSize = measure();
      z.fit = fitScale(z.size, frameSize, FIT_PAD);
      show(wasZoomed ? clampView(z.view, z.size, frameSize) : fitView(z.size, frameSize, FIT_PAD), 'still');
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Pinches (WebKit's gesture events, Chromium's Ctrl+wheel), two-finger scrolls and drags, all off React's renders.
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const z = live.current;
    let start = 1;
    let drag: { id: number; x: number; y: number } | undefined;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : 1;
      if (e.ctrlKey) zoomTo(pinchStep(z.view.scale, e.deltaY * unit), e.clientX, e.clientY);
      else if (isZoomed(z.view, z.fit)) show(panBy(z.view, -e.deltaX * unit, -e.deltaY * unit, z.size, z.frame));
    };
    const onGestureStart = (e: Event): void => {
      e.preventDefault();
      start = z.view.scale;
    };
    const onGesture = (e: Event): void => {
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      zoomTo(start * g.scale, g.clientX, g.clientY);
    };
    const stop = (e: Event): void => e.preventDefault();
    const onDown = (e: PointerEvent): void => {
      z.dragged = false;
      if (e.button !== 0 || !isZoomed(z.view, z.fit)) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
      el.classList.add(s.dragging!);
    };
    const onMove = (e: PointerEvent): void => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 0) {
        if (Math.abs(dx) + Math.abs(dy) > 2) z.dragged = true;
        drag = { ...drag, x: e.clientX, y: e.clientY };
        show(panBy(z.view, dx, dy, z.size, z.frame));
      }
    };
    const onUp = (e: PointerEvent): void => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = undefined;
      el.classList.remove(s.dragging!);
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', onGestureStart, { passive: false } as AddEventListenerOptions);
    el.addEventListener('gesturechange', onGesture, { passive: false } as AddEventListenerOptions);
    el.addEventListener('gestureend', stop, { passive: false } as AddEventListenerOptions);
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onGestureStart);
      el.removeEventListener('gesturechange', onGesture);
      el.removeEventListener('gestureend', stop);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      cancelAnimationFrame(z.frameId);
      z.frameId = 0;
      window.clearTimeout(z.idle);
    };
  }, []);

  return (
    <div
      ref={frame}
      className={cx(s.stage, zoomed && s.stageZoom)}
      // A click on the picture (or the end of a drag) keeps the lightbox open; one beside it closes it.
      onClick={(e) => {
        if (live.current.dragged || e.target === picture.current) e.stopPropagation();
        live.current.dragged = false;
      }}
    >
      {pic ? (
        <img
          ref={picture}
          className={s.full}
          src={pic.url}
          alt={image.label}
          draggable={false}
          onDoubleClick={(e) => {
            e.stopPropagation();
            const z = live.current;
            zoomTo(doubleClickScale(z.view, z.fit), e.clientX, e.clientY, 'glide');
          }}
        />
      ) : (
        <div className={cx(s.fullPending, state.status === 'error' && s.failed)}>{state.status === 'error' ? unavailableText(state.error).text : null}</div>
      )}
    </div>
  );
}

/** An image full size: Esc or a click outside closes, ⌘C copies it, Open shows it in Preview. */
export function Lightbox() {
  const { client } = useBeluga();
  const api = useApi();
  const box = useLightbox();
  const image = box?.images[box.index];
  if (!box || !image) return null;
  const many = box.images.length > 1;
  const copy = async (): Promise<void> => {
    try {
      await copyImage(await loadImage(api, image));
      toast(client, 'Copied the image', 'success');
    } catch (err) {
      toast(client, `Couldn't copy the image: ${errorText(err)}`, 'error');
    }
  };
  const openInPreview = (): void => {
    (image.local ? openWithDefaultApp(client, image.local) : api.attachments.open(image.owner, image.file)).catch((err: unknown) => toast(client, `Couldn't open the image: ${errorText(err)}`, 'error'));
  };
  return (
    <Dialog.Root open onOpenChange={(v) => (v ? undefined : closeLightbox())}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content
          className={s.lightbox}
          aria-describedby={undefined}
          // Focus the lightbox itself (not its first button, which would pop a tooltip that eats Esc).
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.focus();
          }}
          onClick={closeLightbox}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'c' && !window.getSelection()?.toString()) {
              e.preventDefault();
              void copy();
            } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
              e.preventDefault();
              stepLightbox(e.key === 'ArrowRight' ? 1 : -1);
            }
          }}
        >
          <div className={s.bar} onClick={(e) => e.stopPropagation()}>
            <Dialog.Title className={s.title}>
              {image.label}
              {image.detail ? <span className={s.detail}>{image.detail}</span> : null}
              {many ? <span className={s.detail}>{`${box.index + 1} of ${box.images.length}`}</span> : null}
            </Dialog.Title>
            {many ? (
              <>
                <Tip label="Previous image" keys="←">
                  <Button size="small" variant="quiet" icon="back" aria-label="Previous image" onClick={() => stepLightbox(-1)} />
                </Tip>
                <Tip label="Next image" keys="→">
                  <Button size="small" variant="quiet" icon="forward" aria-label="Next image" onClick={() => stepLightbox(1)} />
                </Tip>
              </>
            ) : null}
            <Tip label="Copy the image" keys={chordLabel('Cmd+C')}>
              <Button size="small" variant="quiet" icon="copy" onClick={() => void copy()}>
                Copy
              </Button>
            </Tip>
            <Tip label="Open in Preview">
              <Button size="small" variant="quiet" icon="share" onClick={openInPreview}>
                Open
              </Button>
            </Tip>
            <Dialog.Close className={s.close} aria-label="Close">
              <Icon name="x" size={12} />
            </Dialog.Close>
          </div>
          <Full image={image} />
          <div className={s.hint}>
            <Kbd>esc</Kbd> close · <Kbd>{chordLabel('Cmd+C')}</Kbd> copy{many ? ' · ← → more' : ''}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
