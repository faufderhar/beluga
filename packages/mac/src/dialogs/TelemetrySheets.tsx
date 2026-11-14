import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';
import { DEFAULT_LEVEL, type TelemetryLevel } from '@beluga/core/telemetry-store.js';
import { isRunning } from '@beluga/ui/format.js';
import { Icon } from '../components/Icon.js';
import { TelemetryLevels } from '../components/TelemetryLevels.js';
import { useApi, useApp } from '../lib/beluga.js';
import { TELEMETRY_FOOT, TELEMETRY_LEAD, TELEMETRY_TITLE, levelLabel } from '../lib/telemetry.js';
import { useCalmMoment } from './SupportSheets.js';
import s from './support.module.css';
import t from './telemetry.module.css';

/**
 * The ask after an update (core/telemetry-store.ts): once, at a calm moment, never while one of
 * your agents is running. Share keeps the level picked (Limited unless you pick another), Later asks
 * again in a few days or a few merges, No thanks is final. Closing it is Later.
 */
export function TelemetrySheets() {
  const api = useApi();
  const telemetry = useApp((st) => st.telemetry);
  const running = useApp((st) => st.log.some((l) => l.type === 'agent' && l.owner === st.selfId && isRunning(l.status)));
  const waiting = telemetry.available && telemetry.due && !running;
  const calm = useCalmMoment(waiting);
  const show = waiting && calm;
  useEffect(() => {
    if (show) void api.telemetry.mark('ask_shown', undefined).catch(() => undefined);
  }, [show]);
  if (!show) return null;
  return <AskSheet onAnswer={(answer, level) => void api.telemetry.answer(answer, level)} />;
}

function AskSheet({ onAnswer }: { readonly onAnswer: (answer: 'share' | 'later' | 'never', level: TelemetryLevel) => void }) {
  const [level, setLevel] = useState<TelemetryLevel>(DEFAULT_LEVEL);
  return (
    <>
      <Dialog.Root open onOpenChange={(v) => (v ? undefined : onAnswer('later', level))}>
        <Dialog.Portal>
          <Dialog.Overlay className={s.overlay} />
          <Dialog.Content
            className={s.sheet}
            data-support="telemetry"
            aria-describedby={undefined}
            onOpenAutoFocus={(e) => {
              // Share gets the focus, so Return does it (not the close button).
              const main = (e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>('[data-main]');
              if (!main) return;
              e.preventDefault();
              main.focus();
            }}
          >
            <div className={t.head}>
              <Dialog.Close className={t.close} aria-label="Later">
                <Icon name="x" size={12} />
              </Dialog.Close>
            </div>
            <div className={s.body}>
              <Dialog.Title className={s.title}>{TELEMETRY_TITLE}</Dialog.Title>
              <p className={s.lead}>{TELEMETRY_LEAD}</p>
              <TelemetryLevels value={level} onChange={setLevel} name="telemetry-ask" />
              <button type="button" className={s.main} data-main onClick={() => onAnswer(level === 'off' ? 'never' : 'share', level)}>
                <span className={s.mainLabel}>{level === 'off' ? 'Keep It Off' : `Share (${levelLabel(level)})`}</span>
              </button>
              <div className={s.foot}>
                <button type="button" className={s.quietButton} onClick={() => onAnswer('later', level)}>
                  Later
                </button>
                <span className={s.dot} aria-hidden="true" />
                <button type="button" className={s.quietButton} onClick={() => onAnswer('never', level)}>
                  No thanks
                </button>
              </div>
              <p className={t.small}>{TELEMETRY_FOOT}</p>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
