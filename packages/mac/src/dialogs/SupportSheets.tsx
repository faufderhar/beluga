import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState } from 'react';
import type { SupportAnswer } from '@beluga/core/support-store.js';
import avatar from '../assets/maintainer.png';
import { Icon } from '../components/Icon.js';
import { GitHubMark } from '../components/GitHubMark.js';
import { useApi, useApp } from '../lib/beluga.js';
import { FEEDBACK_URL, GITHUB_URL, MAINTAINER, closeSupport, useOpenedSupport } from '../lib/support.js';
import { openExternal } from '../lib/system.js';
import { useClock, windowActive } from '../lib/window-active.js';
import { StarGlyph, StarScene } from './StarScene.js';
import s from './support.module.css';

/**
 * The one ask merged work brings (core/support-store.ts): a star on GitHub after the third merge,
 * with a paper-cut ocean the whale rises out of (StarScene.tsx), how many starred it already, and a
 * way to tell us what you think. It waits for a calm moment (no other sheet up, the window in
 * front), so it never lands on top of what you're doing. Opened by hand (Settings › About, the
 * palette) it's the same sheet, and answering it tells the daemon nothing. Beluga never asks for
 * money.
 */
export function SupportSheets() {
  const api = useApi();
  const support = useApp((st) => st.support);
  const byHand = useOpenedSupport();
  const calm = useCalmMoment(Boolean(support.due) && !byHand);
  if (!byHand && !(calm && support.due)) return null;
  const answer = (a: SupportAnswer): void => {
    if (byHand) closeSupport();
    else void api.support.answer('star', a);
  };
  return <StarSheet merges={support.merges} stars={support.stars} byHand={byHand} onAnswer={answer} />;
}

/** True once nothing else has been up for a couple of seconds (latched: the ask's own sheet doesn't undo it). */
function useCalmMoment(waiting: boolean): boolean {
  const [calm, setCalm] = useState(false);
  const quiet = useRef(0);
  // Ticks only while you're looking at the window (lib/window-active.ts).
  const now = useClock(waiting && !calm, 900);
  useEffect(() => {
    if (!waiting) {
      quiet.current = 0;
      return setCalm(false);
    }
    if (calm) return;
    const busy = !windowActive() || document.querySelector('[role="dialog"], [role="alertdialog"]');
    quiet.current = busy ? 0 : quiet.current + 1;
    if (quiet.current > 2) setCalm(true);
  }, [now, waiting, calm]);
  return waiting && calm;
}

/** The maker, as a GitHub chip: their avatar and handle; it opens their profile. */
export function MaintainerChip() {
  return (
    <button type="button" className={s.chip} onClick={() => void openExternal(MAINTAINER.url)} title={`${MAINTAINER.login} on GitHub`}>
      <img src={avatar} alt="" className={s.chipAvatar} draggable={false} />
      <span>{MAINTAINER.login}</span>
      <GitHubMark className={s.mark} />
    </button>
  );
}

/** The main button gets the focus, so Return does the kind thing (not the close button). */
function focusMain(e: Event): void {
  const main = (e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>('[data-main]');
  if (!main) return;
  e.preventDefault();
  main.focus();
}

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 21st. */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

/** The headline: the work that brought it, or a plain question when you opened it yourself. */
function titleFor(merges: number, byHand: boolean): string {
  return byHand ? 'Enjoying Beluga?' : `You shipped your ${ordinal(merges)} PR with Beluga`;
}

interface StarSheetProps {
  readonly merges: number;
  readonly stars?: number;
  readonly byHand: boolean;
  readonly onAnswer: (a: SupportAnswer) => void;
}

function StarSheet({ merges, stars, byHand, onAnswer }: StarSheetProps) {
  const later = byHand ? 'Close' : 'Maybe later';
  return (
    <Dialog.Root open onOpenChange={(v) => (v ? undefined : onAnswer('later'))}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content className={s.sheet} data-support="star" aria-describedby={undefined} onOpenAutoFocus={(e) => focusMain(e)}>
          <div className={s.band}>
            <StarScene />
            <Dialog.Close className={s.close} aria-label={later}>
              <Icon name="x" size={12} />
            </Dialog.Close>
          </div>
          <div className={s.body}>
            <Dialog.Title className={s.title}>{titleFor(merges, byHand)}</Dialog.Title>
            <p className={s.lead}>
              Beluga is free and open source, made by <MaintainerChip />
              <br />
              How is it working for you? We’d love to hear what you like, and what you don’t.
            </p>
            <button
              type="button"
              data-main
              className={s.main}
              onClick={() => {
                void openExternal(GITHUB_URL);
                onAnswer('yes');
              }}
            >
              <span className={s.mainLabel}>
                <span className={s.mainStar}>
                  <StarGlyph size={16} />
                </span>
                Star Beluga on GitHub
              </span>
              {stars === undefined ? null : <span className={s.mainCount}>{stars.toLocaleString()}</span>}
            </button>
            <button type="button" className={s.second} onClick={() => void openExternal(FEEDBACK_URL)}>
              <Icon name="chat" size={14} />
              Share feedback
            </button>
            <div className={s.foot}>
              {stars === undefined ? null : (
                <>
                  <span>Yours would be star #{(stars + 1).toLocaleString()}</span>
                  <span className={s.dot} aria-hidden="true" />
                </>
              )}
              <button type="button" className={s.quietButton} onClick={() => onAnswer('later')}>
                {later}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
