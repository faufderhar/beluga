import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { APP_VERSION } from '../lib/boot.js';
import { useApi, useApp, useBeluga } from '../lib/beluga.js';
import { DEFAULT_LEVEL } from '@beluga/core/telemetry-store.js';
import { usePrefs } from '../lib/prefs.js';
import { usePrivacyAccess } from '../lib/privacy.js';
import { AccessStepView } from './AccessSteps.js';
import { AgentsStep } from './AgentsStep.js';
import { accessNext } from './access-copy.js';
import { Backdrop } from './Backdrop.js';
import { Glass, GlassBackdrop } from './Glass.js';
import { type Prepared, prepareWormhole } from './finale-sound.js';
import { WORMHOLE, WORMHOLE_TOTAL, Wormhole } from './Wormhole.js';
import { EASE_OUT, SPRING } from './fx.js';
import { SHOW_WELCOME, type Step, afterAccess, afterTour, clearPlace, groupOf, inAccess, inTour, lastSettingOf, resumeAt, saveMark, savePlace, shouldShow, stepBy, stepIndex, stepsFor, tourPlace, wasDone } from './onboarding-model.js';
import { PhoneStep } from './PhoneStep.js';
import { ShareStep } from './ShareStep.js';
import { TerminalStep } from './TerminalStep.js';
import { Fire, Look, Popups, Setup } from './SetupSteps.js';
import { Hello, Ready, Tour } from './Steps.js';
import s from './onboarding.module.css';

/** How lit the backdrop is on each step: bright for the welcome and the end, calm behind settings. */
const ENERGY: Record<Step, number> = { hello: 1, yourAgents: 0.8, parallel: 0.9, agents: 0.9, tables: 0.9, machines: 0.9, friends: 0.9, sentinel: 0.9, uses: 0.9, earnings: 0.9, archive: 0.9, look: 0.75, terminal: 0.7, fire: 0.7, setup: 0.65, screen: 0.6, accessibility: 0.6, disk: 0.6, automation: 0.6, popups: 0.6, phone: 0.7, share: 0.7, ready: 1 };

/** How long the app takes to settle into place as the wormhole clears (Shell.module.css, `arrive`). */
const ARRIVE_S = 1.6;

const systemDark = (): boolean => window.matchMedia('(prefers-color-scheme: dark)').matches;

/** Whether it's showing, and the way to show it again on purpose. */
/**
 * The app settling into place as the wormhole clears to it (Shell.module.css, [data-arriving]).
 * Set on the element itself: re-rendering the whole app for it would cost a frame mid-flight.
 */
function arrive(): void {
  const app = document.querySelector<HTMLElement>('[data-app-root]');
  if (!app) return;
  app.dataset.arriving = '';
  setTimeout(() => delete app.dataset.arriving, 2000);
}

export function useOnboarding(): { open: boolean; start: Step; close: (how: 'finished' | 'skipped') => void; arrive: () => void } {
  const api = useApi();
  const telemetry = useApp((st) => st.telemetry);
  const [open, setOpen] = useState(() => shouldShow(localStorage, window.location.search));
  // Where it opens: the step it was left on (macOS's "Quit & Reopen" after a permission), or the welcome.
  const [start, setStart] = useState<Step>(() => resumeAt(localStorage) ?? 'hello');
  useEffect(() => {
    // The first time only: quit halfway and it's back next launch. Seeing it again from Help
    // leaves the mark as it was, so a replay you leave never brings it back on its own (only a
    // permission step's reopen does, for a few minutes).
    if (open && !wasDone(localStorage)) saveMark(localStorage, APP_VERSION, 'started');
  }, []);
  useEffect(() => {
    const show = (): void => {
      setStart('hello');
      setOpen(true);
    };
    document.addEventListener(SHOW_WELCOME, show);
    return () => document.removeEventListener(SHOW_WELCOME, show);
  }, []);
  return {
    open,
    start,
    arrive,
    close: (how) => {
      saveMark(localStorage, APP_VERSION, how);
      // Finished or skipped before its step: usage statistics stay at Limited, as the step has it (BLG-922).
      if (telemetry.available && !telemetry.level) void api.telemetry.choose(DEFAULT_LEVEL, 'onboarding').catch(() => undefined);
      void api.telemetry.mark('onboarding_done', how).catch(() => undefined);
      clearPlace(localStorage);
      setOpen(false);
    },
  };
}

/** The dots under every step: where you are, the tour's and the permissions' parts grouped, each one a way back. */
function Progress({ step, steps, go }: { readonly step: Step; readonly steps: readonly Step[]; readonly go: (to: Step) => void }) {
  const at = stepIndex(step, steps);
  return (
    <div className={s.progress} role="group" aria-label="Steps">
      {steps.map((st, i) => (
        <button
          key={st}
          type="button"
          aria-current={st === step ? 'step' : undefined}
          aria-label={`Step ${i + 1} of ${steps.length}`}
          className={s.progressDot}
          data-past={i < at}
          // A little room where a group (the tour, the permissions) starts or ends.
          data-gap={i > 0 && groupOf(st) !== groupOf(steps[i - 1]!) ? '' : undefined}
          disabled={i > at}
          onClick={() => go(st)}
        >
          {st === step ? <motion.span layoutId="progress-on" className={s.progressOn} transition={SPRING} /> : null}
        </button>
      ))}
    </div>
  );
}

/**
 * The first time Beluga opens: a welcome, an eight-part tour of what it does, a look and a few
 * settings, the macOS permissions (one a step, each optional), notifications, the phone app,
 * then the app. A full window of its own over the app (which is already there
 * underneath, so finishing simply lifts this away).
 */
export function Onboarding({ start = 'hello', onClose, onArrive }: { readonly start?: Step; readonly onClose: (how: 'finished' | 'skipped') => void; readonly onArrive?: () => void }) {
  const { ui } = useBeluga();
  const api = useApi();
  const prefs = usePrefs();
  const projects = useApp((st) => st.projects.filter((p) => p.root).length);
  const phones = useApp((st) => st.companion.devices.length);
  // Usage statistics' step only in a build that can send them (BLG-922).
  const steps = stepsFor(useApp((st) => st.telemetry.available));
  const still = (useReducedMotion() ?? false) || prefs.reduceMotion;
  const [step, setStep] = useState<Step>(start);
  // Kept as it goes: macOS's "Quit & Reopen" after a permission brings you back to this step.
  useEffect(() => savePlace(localStorage, step), [step]);
  const [dir, setDir] = useState(1);
  const [leaving, setLeaving] = useState<'finished' | 'skipped'>();
  // Finishing (not skipping) ends in the wormhole: through it, out into the light, onto the app.
  // When the warp began (performance.now()); the tunnel waits behind the last step until then.
  const [warpAt, setWarpAt] = useState<number>();
  const finale = warpAt !== undefined;
  // In the tunnel: the welcome behind it is gone (and its backdrop stops drawing).
  const [inside, setInside] = useState(false);
  // Out in the light: the tunnel clears to the app.
  const [out, setOut] = useState(false);
  const theme = prefs.appearance === 'system' ? (systemDark() ? 'dark' : 'light') : prefs.appearance;
  const smoke = useRef<HTMLCanvasElement>(null);
  // The permissions as macOS has them, checked while one of their steps shows.
  const privacy = usePrivacyAccess(inAccess(step));

  const go = (to: Step): void => {
    setDir(stepIndex(to) >= stepIndex(step) ? 1 : -1);
    setStep(to);
    void api.telemetry.mark('onboarding_step', to).catch(() => undefined);
  };
  const next = (): void => (step === 'ready' ? finish('finished') : go(stepBy(step, 1, steps)));
  const back = (): void => go(stepBy(step, -1, steps));
  const exit = useRef<ReturnType<typeof setTimeout>>(undefined);
  const beats = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  // The wormhole's sound, readied once the last step has settled (so the click doesn't wait on it).
  const sound = useRef<Prepared>(undefined);
  useEffect(() => {
    if (step !== 'ready' || still) return;
    const t = setTimeout(() => (sound.current ??= prepareWormhole()), 1600);
    return () => clearTimeout(t);
  }, [step, still]);
  useEffect(() => () => sound.current?.discard(), []);
  useEffect(
    () => () => {
      clearTimeout(exit.current);
      beats.current.forEach(clearTimeout);
    },
    [],
  );
  const finish = (how: 'finished' | 'skipped', then?: () => void): void => {
    if (leaving) return;
    setLeaving(how);
    const travel = how === 'finished' && !still;
    if (travel) {
      setWarpAt(performance.now());
      (sound.current ?? prepareWormhole())?.play(WORMHOLE.whiteout, WORMHOLE_TOTAL);
      sound.current = undefined;
      beats.current = [
        setTimeout(() => setInside(true), WORMHOLE.enter * 1000),
        setTimeout(() => {
          setOut(true);
          onArrive?.();
        }, WORMHOLE.whiteout * 1000),
      ];
    }
    // Skipping: the window lifts away. Finishing: the wormhole, then the app underneath is
    // yours (and the next sheet opens on it).
    exit.current = setTimeout(
      () => {
        onClose(how);
        then?.();
      },
      // After a wormhole, only once the app has settled: taking the welcome down costs a frame or
      // two, which nobody sees once nothing is moving.
      still ? 0 : travel ? (WORMHOLE.whiteout + ARRIVE_S + 0.1) * 1000 : 650,
    );
  };

  // Return goes on, ⌘[ and ⌘] go back and forth; the arrow keys too, when you're not in a field
  // or a choice. Listened for first (capture), so the app's own keys underneath (⌘K, ⌘N…) wait.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey) e.stopPropagation();
      if (leaving) return;
      // Settings opened over it (Set Up… on Your agents) has the keys to itself.
      if (e.target instanceof Element && !e.target.closest('[data-welcome]') && e.target !== document.body) return;
      const field = e.target instanceof HTMLElement && e.target.closest('input, textarea, [role="combobox"], [role="listbox"], [role="radiogroup"], [role="switch"]');
      const onButton = e.target instanceof HTMLButtonElement && !e.target.closest('[role="radiogroup"]');
      if (e.key === 'Enter' && !e.metaKey && !onButton && !(field && e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        next();
      } else if ((e.metaKey && e.key === ']') || (!field && e.key === 'ArrowRight')) {
        e.preventDefault();
        if (step !== 'ready') next();
      } else if ((e.metaKey && e.key === '[') || (!field && e.key === 'ArrowLeft')) {
        e.preventDefault();
        back();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const place = tourPlace(step);
  const showNav = step !== 'hello' && step !== 'ready';
  return (
    <GlassBackdrop.Provider value={smoke}>
    <MotionConfig reducedMotion={still ? 'always' : 'never'}>
      <motion.div
        className={s.overlay}
        // On the last step the welcome goes see-through: the wormhole waits behind it.
        data-clear={step === 'ready' && !still ? '' : undefined}
        role="dialog"
        aria-modal="true"
        aria-label="Welcome to Beluga"
        data-welcome=""
        initial={{ opacity: 0 }}
        animate={finale ? { opacity: inside ? 0 : 1 } : leaving ? { opacity: 0, scale: 1.04, filter: 'blur(14px)' } : { opacity: 1, scale: 1, filter: 'blur(0px)' }}
        transition={finale ? { duration: 0.12 } : { duration: leaving ? 0.6 : 0.8, ease: EASE_OUT }}
      >
        <div className={s.backdrop}>
          <Backdrop theme={theme} energy={ENERGY[step]} still={still} paused={inside || (step === 'ready' && !still)} canvasRef={smoke} />
        </div>
        <div className={s.titlebar} data-tauri-drag-region />
        {step !== 'ready' ? (
          <button type="button" className={s.skip} onClick={() => finish('skipped')}>
            Skip Setup
          </button>
        ) : null}

        <motion.main className={s.content} animate={finale ? { scale: 1.7, opacity: 0 } : { scale: 1, opacity: 1 }} transition={{ duration: WORMHOLE.enter, ease: [0.55, 0, 0.8, 0.3] }}>
          {/* Not initial={false}: that would also skip the first step's own entrance (the beluga leaping in). */}
          <AnimatePresence mode="wait" custom={dir}>
            <motion.section
              key={step}
              // Focus comes into each step (unless a button in it took it), so Tab stays in here.
              ref={(el) => void (el && !el.contains(document.activeElement) && el.focus({ preventScroll: true }))}
              tabIndex={-1}
              className={s.page}
              custom={dir}
              variants={{
                enter: (d: number) => ({ opacity: 0, x: d * 48, filter: 'blur(10px)' }),
                center: { opacity: 1, x: 0, filter: 'blur(0px)' },
                exit: (d: number) => ({ opacity: 0, x: d * -48, filter: 'blur(10px)' }),
              }}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.45, ease: EASE_OUT }}
            >
              {step === 'hello' ? <Hello onStart={next} /> : null}
              {step === 'yourAgents' ? <AgentsStep /> : null}
              {inTour(step) ? <Tour step={step} /> : null}
              {step === 'look' ? <Look /> : null}
              {step === 'terminal' ? <TerminalStep /> : null}
              {step === 'fire' ? <Fire /> : null}
              {step === 'setup' ? <Setup /> : null}
              {inAccess(step) ? <AccessStepView step={step} access={privacy.access} recheck={privacy.recheck} go={go} /> : null}
              {step === 'popups' ? <Popups /> : null}
              {step === 'phone' ? <PhoneStep /> : null}
              {step === 'share' ? <ShareStep /> : null}
              {step === 'ready' ? <Ready projects={projects} onOpen={() => finish('finished')} onAddProject={() => finish('finished', () => ui.patch({ addProject: true }))} /> : null}
            </motion.section>
          </AnimatePresence>
        </motion.main>

        <AnimatePresence>
          {showNav ? (
            <motion.footer className={s.footer} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 16 }} transition={{ duration: 0.45, ease: EASE_OUT }}>
              <Glass radius={28} className={s.navGlass}>
              <button type="button" className={s.navBack} onClick={back} aria-label="Back">
                <Icon name="back" size={14} />
              </button>
              <Progress step={step} steps={steps} go={go} />
              <div className={s.navRight}>
                {place ? (
                  <button type="button" className={s.navSkipTour} onClick={() => go(afterTour())}>
                    Skip Tour
                  </button>
                ) : null}
                {inAccess(step) ? (
                  <button type="button" className={s.navSkipTour} onClick={() => go(afterAccess())}>
                    Skip Permissions
                  </button>
                ) : null}
                <motion.button type="button" className={s.navNext} data-quiet={(inAccess(step) && privacy.access?.[step] !== 'granted') || (step === 'phone' && !phones) ? '' : undefined} onClick={next} whileTap={{ scale: 0.96 }}>
                  {step === lastSettingOf(steps) ? 'Finish' : inAccess(step) ? accessNext(privacy.access?.[step]) : 'Continue'}
                  <Icon name="arrowRight" size={13} />
                </motion.button>
              </div>
              </Glass>
            </motion.footer>
          ) : null}
        </AnimatePresence>
      </motion.div>
      {/* Under the welcome while it waits; over the app once the welcome is gone. */}
      {step === 'ready' && !still ? <Wormhole theme={theme} since={warpAt} out={out} /> : null}
    </MotionConfig>
    </GlassBackdrop.Provider>
  );
}
