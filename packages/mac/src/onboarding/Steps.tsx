import { motion, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';
import { Icon } from '../components/Icon.js';
import { EASE_OUT, Rise, Words } from './fx.js';
import { Mark } from './Mark.js';
import type { Step } from './onboarding-model.js';
import { Agents } from './scenes/Agents.js';
import { Archive } from './scenes/Archive.js';
import { Earnings } from './scenes/Earnings.js';
import { Friends } from './scenes/Friends.js';
import { Machines } from './scenes/Machines.js';
import { Parallel } from './scenes/Parallel.js';
import { Sentinel } from './scenes/Sentinel.js';
import { SentinelUses } from './scenes/SentinelUses.js';
import { Tables } from './scenes/Tables.js';
import { TOUR_COPY } from './tour-copy.js';
import s from './onboarding.module.css';

/** The welcome: the mark draws itself, the name and the one-line promise come into focus. */
export function Hello({ onStart }: { readonly onStart: () => void }) {
  const still = useReducedMotion() ?? false;
  return (
    <div className={s.hello}>
      <Mark size={124} />
      <Rise delay={1.5} className={s.wordmark}>
        Beluga
      </Rise>
      <h1 className={s.heroTitle}>
        <Words text="Every project. Every agent." delay={1.75} />
        <br />
        {/* One span, not word by word: the line's sheen has to run across all of it. */}
        <motion.span className={s.heroSoft} initial={still ? false : { opacity: 0, y: '0.25em', filter: 'blur(10px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} transition={{ duration: 0.9, ease: EASE_OUT, delay: 2.05 }}>
          All at once.
        </motion.span>
      </h1>
      <Rise delay={2.45} className={s.heroBody}>
        Claude Code, Codex, OpenCode, GitHub Copilot, Grok Build or a model of your own, working across all your repositories in parallel. Everything they do, in view. Your friends’ agents, one message away.
      </Rise>
      <Rise delay={2.75}>
        <GlowButton onClick={onStart} autoFocus>
          Get Started <Icon name="arrowRight" size={13} />
        </GlowButton>
      </Rise>
    </div>
  );
}

/** The main button: a ring of light travels round its edge (Magic UI's border beam, in CSS). */
export function GlowButton({ children, onClick, autoFocus, quiet }: { readonly children: ReactNode; readonly onClick: () => void; readonly autoFocus?: boolean; readonly quiet?: boolean }) {
  return (
    <motion.button type="button" className={quiet ? s.quietButton : s.glowButton} onClick={onClick} autoFocus={autoFocus} whileHover={{ scale: 1.025 }} whileTap={{ scale: 0.97 }} transition={{ type: 'spring', stiffness: 500, damping: 30 }}>
      {quiet ? null : <span className={s.beam} aria-hidden="true" />}
      <span className={s.buttonLabel}>{children}</span>
    </motion.button>
  );
}

const SCENES: Partial<Record<Step, () => ReactNode>> = {
  parallel: () => <Parallel />,
  agents: () => <Agents />,
  tables: () => <Tables />,
  machines: () => <Machines />,
  friends: () => <Friends />,
  sentinel: () => <Sentinel />,
  uses: () => <SentinelUses />,
  earnings: () => <Earnings />,
  archive: () => <Archive />,
};

/** One idea of the tour: what it is on the left, the app doing it on the right. */
export function Tour({ step }: { readonly step: Step }) {
  const copy = TOUR_COPY[step];
  const still = useReducedMotion() ?? false;
  if (!copy) return null;
  return (
    <div className={s.tour}>
      <div className={s.tourText}>
        <Rise className={s.eyebrow}>
          <Icon name={copy.icon} size={12} /> {copy.eyebrow}
        </Rise>
        <h2 className={s.title}>
          <Words text={copy.title} delay={0.05} />
        </h2>
        <Rise delay={0.3} className={s.body}>
          {copy.body}
        </Rise>
        <ul className={s.points}>
          {copy.points.map((p, i) => (
            <motion.li key={p} initial={still ? false : { opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.5, ease: EASE_OUT, delay: 0.45 + i * 0.08 }}>
              <Icon name="check" size={12} />
              {p}
            </motion.li>
          ))}
        </ul>
      </div>
      <motion.div className={s.scene} initial={still ? false : { opacity: 0, scale: 0.94, filter: 'blur(12px)' }} animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }} transition={{ duration: 0.9, ease: EASE_OUT, delay: 0.1 }}>
        {SCENES[step]?.()}
      </motion.div>
    </div>
  );
}

/** Light bursting out from the mark when you're done: a ring of sparks, once. */
function Burst() {
  const still = useReducedMotion() ?? false;
  if (still) return null;
  const sparks = Array.from({ length: 28 }, (_, i) => i);
  return (
    <div className={s.burst} aria-hidden="true">
      {sparks.map((i) => {
        const angle = (i / sparks.length) * Math.PI * 2;
        const far = 120 + (i % 4) * 34;
        return (
          <motion.span
            key={i}
            className={s.spark}
            data-copper={i % 3 === 0}
            initial={{ x: 0, y: 0, opacity: 0, scale: 0.4 }}
            animate={{ x: Math.cos(angle) * far, y: Math.sin(angle) * far, opacity: [0, 1, 0], scale: [0.4, 1, 0.2] }}
            transition={{ duration: 1.5, ease: EASE_OUT, delay: 0.35 + (i % 5) * 0.03 }}
          />
        );
      })}
    </div>
  );
}

/** The last step: what to do first (add a project, or look around), then into the app. */
export function Ready({ projects, onAddProject, onOpen }: { readonly projects: number; readonly onAddProject: () => void; readonly onOpen: () => void }) {
  const has = projects > 0;
  return (
    <div className={s.hello}>
      <div className={s.readyMark}>
        <Burst />
        <Mark size={92} />
      </div>
      <h1 className={s.heroTitle}>
        <Words text="You’re all set." delay={0.5} />
      </h1>
      <Rise delay={0.8} className={s.heroBody}>
        {has
          ? `Your ${projects === 1 ? 'project is' : `${projects} projects are`} here. Start a worktree from any of them, and your agent gets to work on its own branch.`
          : 'Add a project to begin. Beluga finds its branches and worktrees, and every new task gets its own.'}
      </Rise>
      <Rise delay={1.05} className={s.readyButtons}>
        {has ? (
          <GlowButton onClick={onOpen} autoFocus>
            Open Beluga <Icon name="arrowRight" size={13} />
          </GlowButton>
        ) : (
          <>
            <GlowButton onClick={onAddProject} autoFocus>
              <Icon name="folder" size={13} /> Add a Project…
            </GlowButton>
            <GlowButton onClick={onOpen} quiet>
              Look Around First
            </GlowButton>
          </>
        )}
      </Rise>
      <Rise delay={1.3} className={s.readyHint}>
        File › Onboard Again shows this again.
      </Rise>
    </div>
  );
}
