import { useEffect, useState } from 'react';
import type { TelemetryLevel } from '@beluga/core/telemetry-store.js';
import { DEFAULT_LEVEL } from '@beluga/core/telemetry-store.js';
import { Icon } from '../components/Icon.js';
import { TelemetryLevels } from '../components/TelemetryLevels.js';
import { useApi, useApp } from '../lib/beluga.js';
import { TELEMETRY_FOOT, TELEMETRY_LEAD, TELEMETRY_TITLE } from '../lib/telemetry.js';
import { Rise, Words } from './fx.js';
import s from './onboarding.module.css';

/**
 * Usage statistics (BLG-922), the last setting: Off, Limited or On, with Limited already picked.
 * Continue, Finish or Skip keep it; only builds that can send show this step (onboarding-model.ts).
 */
export function ShareStep() {
  const api = useApi();
  const level = useApp((st) => st.telemetry.level);
  // Yours at once (the daemon's copy follows a moment later).
  const [picked, setPicked] = useState<TelemetryLevel>(level ?? DEFAULT_LEVEL);
  const pick = (l: TelemetryLevel): void => {
    setPicked(l);
    void api.telemetry.choose(l, 'onboarding').catch(() => undefined);
  };
  // Arriving here picks Limited for you (what Continue keeps), unless you chose before.
  useEffect(() => {
    if (!level) void api.telemetry.choose(DEFAULT_LEVEL, 'onboarding').catch(() => undefined);
  }, []);
  return (
    <div className={s.tour}>
      <div className={s.tourText}>
        <Rise className={s.eyebrow}>
          <Icon name="chartBar" size={12} /> Usage statistics
        </Rise>
        <h2 className={s.title}>
          <Words text={`${TELEMETRY_TITLE}.`} delay={0.05} />
        </h2>
        <Rise delay={0.3} className={s.body}>
          {TELEMETRY_LEAD}
        </Rise>
        <Rise delay={0.45}>
          <TelemetryLevels value={picked} onChange={pick} name="telemetry-onboarding" />
        </Rise>
        <Rise delay={0.55} className={s.body}>
          {TELEMETRY_FOOT}
        </Rise>
      </div>
    </div>
  );
}
