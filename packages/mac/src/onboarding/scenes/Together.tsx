import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { Icon } from '../../components/Icon.js';
import { SPRING } from '../fx.js';
import { useBeatControl } from './use-beats.js';
import t from './tour-scenes.module.css';
import g from './together.module.css';

/**
 * A worktree shared live (BLG-989): your agent is at work, you press Share, invite Ada to Work
 * here or to Follow, and she joins the session. Working, she asks the same agent something and it
 * answers you both; following, she watches it work. You can press Share, pick and Invite
 * yourself; left alone it plays both ways in turn. The words are the share sheet's own
 * (dialogs/native/WorkspaceShare.tsx).
 */

type Role = 'contribute' | 'view';

const ROLES: ReadonlyArray<{ readonly value: Role; readonly label: string; readonly detail: string }> = [
  { value: 'contribute', label: 'Work here', detail: 'Ada can talk to your agent' },
  { value: 'view', label: 'Follow', detail: 'Ada watches it work' },
];

// Beats: your agent at work · the share sheet · Ada joins · she speaks (or watches) · the agent answers, held.
const BEATS = [1900, 2300, 1100, 1400, 3000] as const;
const SHEET = 1;
const JOINED = 2;
const SPOKE = 3;
const ANSWERED = 4;

function Avatar({ who, hue, live }: { readonly who: string; readonly hue: number; readonly live?: boolean }) {
  return (
    <span className={g.avatar} style={{ background: `oklch(0.72 0.1 ${hue})` }} aria-label={who}>
      {who[0]}
      {live ? <span className={g.presence} /> : null}
    </span>
  );
}

export function Together() {
  const [round, setRound] = useState(0);
  const [chosen, setChosen] = useState<Role>();
  // Opened by you: it waits for your Invite instead of moving on by itself.
  const [yours, setYours] = useState(false);
  const { beat, go } = useBeatControl(BEATS, {
    rest: ANSWERED,
    paused: yours,
    onLoop: () => {
      setRound((r) => r + 1);
      setChosen(undefined);
      setYours(false);
    },
  });
  const role: Role = chosen ?? (round % 2 === 0 ? 'contribute' : 'view');
  const joined = beat >= JOINED;
  const working = role === 'contribute';
  const share = (): void => {
    setYours(true);
    go(SHEET);
  };
  const invite = (): void => {
    setYours(false);
    go(JOINED);
  };
  return (
    <div className={t.stage}>
      <div className={t.window} style={{ width: 520 }}>
        <div className={t.bar}>
          <span className={t.lights}>
            <i />
            <i />
            <i />
          </span>
          <span className={t.mono}>web · feat/coupons</span>
          <span className={g.people}>
            <Avatar who="You" hue={40} live />
            <AnimatePresence>{joined ? <motion.span key="ada" initial={{ opacity: 0, scale: 0.4, x: -8 }} animate={{ opacity: 1, scale: 1, x: 0 }} exit={{ opacity: 0 }} transition={SPRING}><Avatar who="Ada" hue={300} live /></motion.span> : null}</AnimatePresence>
          </span>
          <button type="button" className={g.share} data-hint={beat === 0 ? '' : undefined} onClick={share} disabled={beat === SHEET}>
            <Icon name="people" size={11} /> Share
          </button>
        </div>
        <div className={g.chat}>
          <div className={t.ask}>Add a coupon field to checkout</div>
          <div className={g.line}>
            <Icon name="check" size={11} className={t.ok} /> Edited <code>CheckoutForm.tsx</code>
          </div>
          <div className={g.line}>
            <Icon name={beat >= ANSWERED && working ? 'check' : 'refresh'} size={11} className={beat >= ANSWERED && working ? t.ok : t.spin} /> Running the tests
          </div>
          <AnimatePresence>
            {joined ? (
              <motion.div key={`j-${round}`} className={g.joined} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={SPRING}>
                <Icon name={working ? 'people' : 'eye'} size={11} /> Ada joined{working ? ' and can work here' : ' to follow along'}
              </motion.div>
            ) : null}
            {beat >= SPOKE && working ? (
              <motion.div key={`s-${round}`} className={g.theirs} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={SPRING}>
                <Avatar who="Ada" hue={300} />
                <span>Make the coupon optional, most people won’t have one</span>
              </motion.div>
            ) : null}
            {beat >= SPOKE && !working ? (
              <motion.div key={`w-${round}`} className={g.watching} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={SPRING}>
                <Avatar who="Ada" hue={300} /> Ada is watching each step live
              </motion.div>
            ) : null}
            {beat >= ANSWERED && working ? (
              <motion.div key={`a-${round}`} className={t.answer} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={SPRING}>
                <Icon name="claude" size={12} className={t.claude} /> Got it, Ada. The coupon is optional now, and the tests pass.
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
        <AnimatePresence>
          {beat === SHEET ? (
            <motion.div key="sheet" className={g.sheet} initial={{ opacity: 0, y: -8, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.97 }} transition={SPRING}>
              <span className={g.sheetTitle}>Share feat/coupons</span>
              <span className={g.friend}>
                <Avatar who="Ada" hue={300} /> Ada
              </span>
              <div className={g.roles} role="radiogroup" aria-label="Ada can">
                {ROLES.map((r) => (
                  <button key={r.value} type="button" role="radio" aria-checked={role === r.value} className={g.role} onClick={() => setChosen(r.value)}>
                    {role === r.value ? <motion.span layoutId="together-role" className={g.roleOn} transition={SPRING} /> : null}
                    <span className={g.roleText}>
                      <strong>{r.label}</strong>
                      <span>{r.detail}</span>
                    </span>
                  </button>
                ))}
              </div>
              <button type="button" className={g.invite} onClick={invite}>
                Invite
              </button>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}
