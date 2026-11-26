import { AnimatePresence, type Variants, motion, useReducedMotion } from 'motion/react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppState } from '@beluga/core/store.js';
import type { StatsSnapshot } from '@beluga/shared/stats.js';
import { Icon } from '../../components/Icon.js';
import { Button, IconButton, cx } from '../../components/ui.js';
import { Mark } from '../../onboarding/Mark.js';
import { type Slide, recapSlides } from './recap-model.js';
import type { Title } from './titles.js';
import s from './recap.module.css';

/** How long a slide stays before the next (paused while you hold the pointer down). */
const SLIDE_MS = 6000;
const EASE = [0.22, 1, 0.36, 1] as const;

/** A number that counts up to `to` when it first shows (at once with reduced motion). */
function useCountUp(to: number, key: string, still: boolean): number {
  const [n, setN] = useState(() => (still ? to : 0));
  useEffect(() => {
    if (still) return setN(to);
    const start = performance.now() + 250;
    let raf = 0;
    const step = (t: number): void => {
      const f = Math.min(1, Math.max(0, (t - start) / 1300));
      setN(to * (1 - Math.pow(1 - f, 4)));
      if (f < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to, key, still]);
  return n;
}

/** The words of a slide come in one after another, rising out of a soft blur, and leave together. */
const words = (still: boolean): Variants => ({
  hidden: { opacity: 0 },
  shown: { opacity: 1, transition: { staggerChildren: still ? 0 : 0.11, delayChildren: still ? 0 : 0.08 } },
  gone: { opacity: 0, y: still ? 0 : -18, filter: still ? 'none' : 'blur(6px)', transition: { duration: still ? 0.15 : 0.42, ease: EASE } },
});
const word = (still: boolean): Variants => ({
  hidden: still ? { opacity: 0 } : { opacity: 0, y: 30, filter: 'blur(10px)' },
  shown: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: still ? 0.2 : 0.85, ease: EASE } },
});

function SlideView({ slide, still }: { slide: Slide; still: boolean }) {
  const counted = useCountUp(slide.value ?? 0, slide.id, still);
  const w = word(still);
  return (
    <motion.div className={s.slide} variants={words(still)} initial="hidden" animate="shown" exit="gone">
      <motion.span variants={w} className={cx(s.icon, slide.id === 'hello' && s.iconLogo)}>
        {slide.id === 'hello' ? <Mark size={84} delay={0.2} /> : <Icon name={slide.icon} size={30} />}
      </motion.span>
      <motion.p variants={w} className={s.lead}>
        {slide.lead}
      </motion.p>
      <motion.h2 variants={w} className={s.big}>
        {slide.title ? (
          slide.title.name
        ) : slide.value !== undefined ? (
          <>
            {slide.format ? slide.format(counted) : Math.round(counted)}
            {slide.after ? <span className={s.after}>{slide.after}</span> : null}
          </>
        ) : (
          slide.big
        )}
      </motion.h2>
      {slide.bars ? (
        <motion.ul variants={w} className={s.bars}>
          {slide.bars.map((b, i) => (
            <li key={b.name} style={{ '--b': b.color } as React.CSSProperties}>
              <span className={s.barName}>{b.name}</span>
              <span className={s.barTrack}>
                <motion.span className={s.barFill} initial={{ width: still ? `${Math.max(3, b.share * 100)}%` : '0%' }} animate={{ width: `${Math.max(3, b.share * 100)}%` }} transition={{ duration: still ? 0 : 1.1, delay: still ? 0 : 0.55 + i * 0.12, ease: EASE }} />
              </span>
              <span className={s.barValue}>{b.value}</span>
            </li>
          ))}
        </motion.ul>
      ) : null}
      {slide.note ? (
        <motion.p variants={w} className={s.note}>
          {slide.note}
        </motion.p>
      ) : null}
    </motion.div>
  );
}

/** Where the three soft shapes sit on each slide: they drift and change shape between slides. */
const SHAPES = [
  [
    { x: '62vw', y: '-14vh', scale: 1, rotate: 0, borderRadius: '58% 42% 63% 37% / 46% 52% 48% 54%' },
    { x: '-10vw', y: '58vh', scale: 0.8, rotate: 10, borderRadius: '41% 59% 45% 55% / 60% 38% 62% 40%' },
    { x: '70vw', y: '62vh', scale: 0.35, rotate: 0, borderRadius: '50%' },
  ],
  [
    { x: '48vw', y: '-24vh', scale: 1.15, rotate: 40, borderRadius: '45% 55% 38% 62% / 55% 42% 58% 45%' },
    { x: '2vw', y: '48vh', scale: 0.95, rotate: -20, borderRadius: '62% 38% 54% 46% / 42% 61% 39% 58%' },
    { x: '60vw', y: '50vh', scale: 0.5, rotate: 30, borderRadius: '38% 62% 47% 53% / 52% 44% 56% 48%' },
  ],
  [
    { x: '66vw', y: '4vh', scale: 0.9, rotate: -30, borderRadius: '52% 48% 60% 40% / 38% 58% 42% 62%' },
    { x: '-16vw', y: '30vh', scale: 1.1, rotate: 25, borderRadius: '44% 56% 39% 61% / 57% 40% 60% 43%' },
    { x: '76vw', y: '70vh', scale: 0.42, rotate: -10, borderRadius: '57% 43% 50% 50% / 48% 55% 45% 52%' },
  ],
] as const;

function Shapes({ at, still }: { at: number; still: boolean }) {
  const set = SHAPES[at % SHAPES.length]!;
  return (
    <div className={s.shapes} aria-hidden>
      {set.map((shape, i) => (
        <motion.span key={i} className={s.shape} initial={false} animate={still ? undefined : shape} style={still ? SHAPES[0]![i] : undefined} transition={{ duration: 2.4, ease: EASE }} />
      ))}
    </div>
  );
}

/**
 * Your recap, like Spotify Wrapped: over the whole window, a slide per big number (recap-model.ts),
 * each a few seconds, a bar at the top for each. One calm background whose colour drifts slowly
 * from slide to slide while soft shapes move and change shape; the words leave and the next ones
 * rise in. Click (or →, space) for the next, the left side (or ←) for the one before, a bar to
 * jump, hold to pause, Esc to leave. It opens with Beluga's beluga and ends on your title, with
 * your pass swinging beside it (and your stats to share).
 */
export function Recap({ state, stats, now, title, pass, onShare, onClose }: { state: AppState; stats: StatsSnapshot; now: number; title: Title; pass?: ReactNode; onShare?: () => void; onClose: () => void }) {
  const still = useReducedMotion() ?? false;
  const name = state.network.self?.name || state.self?.name || 'You';
  const slides = useMemo(() => recapSlides(stats, state, name, now, title), [stats, state.projects, name, now, title]); // eslint-disable-line react-hooks/exhaustive-deps
  const [at, setAt] = useState(0);
  const [held, setHeld] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const last = at === slides.length - 1;
  const go = useCallback((i: number) => setAt(Math.max(0, Math.min(slides.length - 1, i))), [slides.length]);
  // On a timer, unless held or at the end; holding keeps what's left of the slide's time.
  const left = useRef(SLIDE_MS);
  useEffect(() => {
    left.current = SLIDE_MS;
  }, [at]);
  useEffect(() => {
    if (held || last) return;
    const started = performance.now();
    const t = setTimeout(() => go(at + 1), left.current);
    return () => {
      clearTimeout(t);
      left.current = Math.max(0, left.current - (performance.now() - started));
    };
  }, [at, held, last, go]);
  useEffect(() => {
    box.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' || e.key === ' ') go(at + 1);
      else if (e.key === 'ArrowLeft') go(at - 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [at, go, onClose]);
  const slide = slides[at]!;
  const onClick = (e: React.MouseEvent): void => {
    const r = box.current?.getBoundingClientRect();
    if (r && e.clientX < r.left + r.width / 3) go(at - 1);
    else if (!last) go(at + 1);
  };
  return (
    <motion.div
      ref={box}
      className={s.recap}
      role="dialog"
      aria-modal="true"
      aria-label="Your recap"
      tabIndex={-1}
      style={{ '--c': slide.color } as React.CSSProperties}
      initial={still ? { opacity: 0 } : { opacity: 0, scale: 0.985 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.5, ease: EASE }}
    >
      <Shapes at={at} still={still} />
      <div className={s.top}>
        <div className={s.progress} role="tablist" aria-label="Slides">
          {slides.map((x, i) => (
            <button key={x.id} type="button" role="tab" aria-selected={i === at} aria-label={`Slide ${i + 1}`} className={s.segment} onClick={() => go(i)}>
              <span className={cx(s.segmentFill, i < at && s.segmentDone, i === at && s.segmentNow, held && s.segmentHeld)} style={i === at ? { animationDuration: `${SLIDE_MS}ms` } : undefined} key={i === at ? `${at}` : undefined} />
            </button>
          ))}
        </div>
        <IconButton size="small" icon="x" label="Close the recap" onClick={onClose} />
      </div>
      <div className={cx(s.stage, last && Boolean(pass) && s.stageWithPass)} onClick={onClick} onPointerDown={() => setHeld(true)} onPointerUp={() => setHeld(false)} onPointerLeave={() => setHeld(false)}>
        <AnimatePresence mode="wait" initial={false}>
          <SlideView key={slide.id} slide={slide} still={still} />
        </AnimatePresence>
        <AnimatePresence>
          {last && pass ? (
            <motion.div key="pass" className={s.pass} onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.6, delay: still ? 0 : 0.5 }}>
              {pass}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
      <AnimatePresence>
        {last ? (
          <motion.div key="end" className={s.end} initial={{ opacity: 0, y: still ? 0 : 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.5, delay: still ? 0 : 0.9, ease: EASE }}>
            <Button size="small" variant="plain" icon="refresh" onClick={() => go(0)}>
              Play Again
            </Button>
            {onShare ? (
              <Button size="small" variant="plain" icon="share" onClick={onShare}>
                Share…
              </Button>
            ) : null}
            <Button size="small" variant="primary" onClick={onClose}>
              Back to Your Stats
            </Button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}
