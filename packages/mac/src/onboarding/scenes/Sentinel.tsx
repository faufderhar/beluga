import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { Icon } from '../../components/Icon.js';
import { STEP_ICON, TRIGGER_ICON } from '../../sentinel/sentinel-model.js';
import { SPRING } from '../fx.js';
import { TOUR_SENTINELS } from '../sentinel-tour.js';
import { useBeatControl } from './use-beats.js';
import t from './tour-scenes.module.css';
import n from './sentinel-scene.module.css';

/**
 * Sentinel at a glance (BLG-362, simplified in BLG-989): a sentence in three colours (when, what,
 * and what you get), and under it the same three as cards that light up in turn: the moment
 * comes, the agent works through its steps, the report lands. Pick a use case along the top;
 * left alone they take turns. A picture of the idea, simpler than the Sentinel page itself.
 */

// Beats: the sentence · the moment comes · the work · the report, held.
const BEATS = [900, 1100, 1500, 3200] as const;
const FIRED = 1;
const WORKING = 2;
const REPORTED = 3;

/** A part of the run: its colour and label, lit once its beat has come. */
function Card({ part, label, lit, live, children }: { readonly part: 'when' | 'what' | 'then'; readonly label: string; readonly lit: boolean; readonly live?: boolean; readonly children: React.ReactNode }) {
  return (
    <motion.div className={n.card} data-part={part} data-lit={lit ? '' : undefined} animate={{ scale: live ? 1.03 : 1 }} transition={SPRING}>
      <span className={n.cardLabel}>{label}</span>
      {children}
    </motion.div>
  );
}

/** Steps that tell you rather than do the work: they belong under "You get". */
const TELLS_YOU: ReadonlySet<string> = new Set(['notify', 'message']);

const Arrow = ({ on }: { readonly on: boolean }) => (
  <span className={n.arrow} data-on={on ? '' : undefined} aria-hidden="true">
    <Icon name="arrowRight" size={12} />
  </span>
);

export function Sentinel() {
  const [at, setAt] = useState(0);
  const { beat, go } = useBeatControl(BEATS, { rest: REPORTED, onLoop: () => setAt((a) => (a + 1) % TOUR_SENTINELS.length) });
  const x = TOUR_SENTINELS[at]!;
  const pick = (i: number): void => {
    setAt(i);
    go(0);
  };
  return (
    <div className={t.stage} style={{ alignContent: 'center', gap: 18 }}>
      <div className={t.picks} role="radiogroup" aria-label="Sentinels" style={{ justifyContent: 'center' }}>
        {TOUR_SENTINELS.map((s, i) => (
          <button key={s.id} type="button" role="radio" aria-checked={i === at} className={t.pick} onClick={() => pick(i)}>
            {i === at ? <motion.span layoutId="sentinel-pick" className={t.pickOn} transition={SPRING} /> : null}
            <span className={t.pickLabel}>
              <Icon name={TRIGGER_ICON[s.trigger]} size={11} /> {s.name}
            </span>
          </button>
        ))}
      </div>
      <AnimatePresence mode="wait">
        <motion.p key={x.id} className={n.said} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.35 }}>
          <span data-part="when">{x.said[0]}</span> <span data-part="what">{x.said[1]}</span> <span data-part="then">{x.said[2]}</span>
        </motion.p>
      </AnimatePresence>
      <div className={n.flow}>
        <Card part="when" label="When" lit={beat >= FIRED} live={beat === FIRED}>
          <span className={n.cardMain}>
            <Icon name={TRIGGER_ICON[x.trigger]} size={14} /> {x.when}
          </span>
          {beat >= FIRED ? <span className={n.fired}>Now</span> : <span className={t.dim}>Waiting</span>}
        </Card>
        <Arrow on={beat >= WORKING} />
        <Card part="what" label="Your agent" lit={beat >= WORKING} live={beat === WORKING}>
          {x.steps.filter((st) => !TELLS_YOU.has(st.kind)).slice(0, 2).map((st) => (
            <span key={st.detail} className={n.stepLine}>
              <Icon name={beat === WORKING ? 'refresh' : beat > WORKING ? 'check' : STEP_ICON[st.kind]} size={11} className={beat === WORKING ? t.spin : beat > WORKING ? t.ok : undefined} />
              {st.detail}
            </span>
          ))}
        </Card>
        <Arrow on={beat >= REPORTED} />
        <Card part="then" label="You get" lit={beat >= REPORTED} live={beat === REPORTED}>
          <AnimatePresence mode="wait">
            {beat >= REPORTED ? (
              <motion.span key={`r-${x.id}`} className={n.report} initial={{ opacity: 0, y: 10, scale: 0.94 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0 }} transition={SPRING}>
                <strong>{x.report.title}</strong>
                <span>{x.report.line}</span>
              </motion.span>
            ) : (
              <motion.span key="wait" className={t.dim} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                A report
              </motion.span>
            )}
          </AnimatePresence>
        </Card>
      </div>
    </div>
  );
}
