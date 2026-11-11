import { motion } from 'motion/react';
import { useState } from 'react';
import { Icon } from '../components/Icon.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { errorText, quietly } from '../network/use-net.js';
import { sameDeep } from '../lib/stable.js';
import { openExternal } from '../lib/system.js';
import { useClock } from '../lib/window-active.js';
import { Pairing } from '../phone/Phone.js';
import homeDark from '../assets/phone-home-dark.webp';
import homeLight from '../assets/phone-home-light.webp';
import { EASE_OUT, Rise, SPRING, Words } from './fx.js';
import s from './onboarding.module.css';

/**
 * The phone app (docs/companion.md): what it's for, that it's Android only for now, where to get
 * it, and the real Pair a Phone… (the same QR and code as Settings › Phone). Optional: Finish
 * goes on without one.
 */

/** Where the Android app is published: each Mac release carries its APK. */
export const ANDROID_APP_URL = 'https://github.com/beluga-labs/beluga/releases/latest';

/**
 * The phone app's real Home, from its own demo (a pretend Mac: an approval waiting, a plan and a
 * conversation running), in the Mac's look. scripts/phone-shots.mjs makes them again.
 */
function PhoneShot() {
  return (
    <div className={s.phone} aria-hidden="true">
      <div className={s.phoneScreen}>
        <img className={s.phoneShot} data-look="light" src={homeLight} alt="" draggable={false} />
        <img className={s.phoneShot} data-look="dark" src={homeDark} alt="" draggable={false} />
      </div>
    </div>
  );
}

/**
 * The step's one action: Pair a Phone… in the welcome's own look. Once a pairing is open (or a
 * phone waits to be approved) it's the real panel from Settings › Phone: the QR, the code, Pair.
 */
function PairHere() {
  const { client } = useBeluga();
  const pairing = useApp((st) => st.companion.pairing, sameDeep);
  const devices = useApp((st) => st.companion.devices.length);
  const now = useClock(true, 30_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (pairing) {
    return (
      <motion.div className={s.pairCard} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={SPRING}>
        <Pairing now={now} />
      </motion.div>
    );
  }
  const start = (): void => {
    setBusy(true);
    setError(undefined);
    quietly(client, client.api.companion['pair.start']())
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(false));
  };
  return (
    <div className={s.accessActions}>
      <motion.button type="button" className={s.solidButton} disabled={busy || devices >= 4} aria-busy={busy || undefined} onClick={start} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }} transition={{ type: 'spring', stiffness: 500, damping: 30 }}>
        <Icon name={busy ? 'refresh' : 'phone'} size={13} className={busy ? s.spinning : undefined} />
        {busy ? 'Opening…' : devices ? 'Pair Another Phone…' : 'Pair a Phone…'}
      </motion.button>
      {error ? <span className={s.accessError}>{error}</span> : null}
    </div>
  );
}

export function PhoneStep() {
  const devices = useApp((st) => st.companion.devices, sameDeep);
  return (
    <div className={s.tour}>
      <div className={s.tourText}>
        <Rise className={s.eyebrow}>
          <Icon name="phone" size={12} /> Phone
          <span className={s.eyebrowSoft}>· Android only for now</span>
        </Rise>
        <h2 className={s.title}>
          <Words text="Your agent in your pocket." delay={0.05} />
        </h2>
        <Rise delay={0.3} className={s.body}>
          The Beluga app on your phone shows what your agent is doing and lets you answer, ask and chat from anywhere. It reads, it never edits. It’s on Android for now; iPhone comes later.
        </Rise>
        {devices.length ? (
          <Rise delay={0.4} className={s.accessStatus}>
            <span className={s.grant} data-grant="granted">
              <Icon name="check" size={11} /> {devices.length === 1 ? `${devices[0]!.name} is paired` : `${devices.length} phones paired`}
            </span>
          </Rise>
        ) : null}
        <Rise delay={0.45} className={s.phonePair}>
          <PairHere />
        </Rise>
        <Rise delay={0.55}>
          <button type="button" className={s.textLink} onClick={() => void openExternal(ANDROID_APP_URL)}>
            <Icon name="download" size={11} /> Get the Android app
          </button>
        </Rise>
      </div>
      <motion.div className={s.scene} initial={{ opacity: 0, scale: 0.94, filter: 'blur(12px)' }} animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }} transition={{ duration: 0.9, ease: EASE_OUT, delay: 0.1 }}>
        <div className={s.phoneStage}>
          <PhoneShot />
        </div>
      </motion.div>
    </div>
  );
}
