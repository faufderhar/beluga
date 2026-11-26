import type { TelemetryLevel } from '@beluga/core/telemetry-store.js';
import { LEVELS, PRIVACY_LABEL, openPrivacyNotice } from '../lib/telemetry.js';
import s from './telemetry-levels.module.css';

/** Off, Essential, On: one radio group, each with a line saying what it sends. No value: none picked yet. */
export function TelemetryLevels({ value, onChange, name = 'telemetry-level' }: { readonly value: TelemetryLevel | undefined; readonly onChange: (level: TelemetryLevel) => void; readonly name?: string }) {
  return (
    <div className={s.levels} role="radiogroup" aria-label="Usage statistics">
      {LEVELS.map((l) => (
        <label key={l.level} className={s.level} data-on={l.level === value ? '' : undefined}>
          <input type="radio" name={name} className={s.radio} checked={l.level === value} onChange={() => onChange(l.level)} />
          <span className={s.dotOuter} aria-hidden="true">
            <span className={s.dotInner} />
          </span>
          <span className={s.words}>
            <span className={s.label}>{l.label}</span>
            <span className={s.detail}>{l.detail}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

/** "Privacy notice": who gets usage statistics, why, for how long, your rights (docs/privacy.md, in the browser). */
export function PrivacyNoticeLink() {
  return (
    <button type="button" className={s.privacy} onClick={openPrivacyNotice}>
      {PRIVACY_LABEL}
    </button>
  );
}
