import { useEffect, useState } from 'react';
import type { TelemetryLevel } from '@beluga/core/telemetry-store.js';
import { PrivacyNoticeLink } from '../components/TelemetryLevels.js';
import { Button } from '../components/ui.js';
import { useApi, useApp } from '../lib/beluga.js';
import { copyText } from '../lib/copy.js';
import { LEVELS } from '../lib/telemetry.js';
import { Group, Row, Select } from './settings-controls.js';
import s from './telemetry.module.css';

/** Settings › General › Usage statistics: Off, Essential, On, the privacy notice, and the install id. Only in builds that can send them. */
export function TelemetrySettingsGroup() {
  const api = useApi();
  const telemetry = useApp((st) => st.telemetry);
  if (!telemetry.available) return null;
  const level = telemetry.level ?? 'off';
  return (
    <Group title="Usage statistics">
      <Row
        label="Share usage statistics"
        detail={
          <>
            {LEVELS.find((l) => l.level === level)?.detail ?? ''} <PrivacyNoticeLink />
          </>
        }
      >
        <Select<TelemetryLevel> label="Share usage statistics" value={level} onChange={(v) => void api.telemetry.choose(v, 'settings')} options={LEVELS.map((l) => ({ value: l.level, label: l.label, description: l.detail }))} />
      </Row>
      <InstallIdRow level={level} />
    </Group>
  );
}

/**
 * The random id your statistics go under: include it in a privacy request. Shown once any level is chosen,
 * Off too (a request after you withdraw). Reset ID starts a new one; what was sent stays under the old.
 */
function InstallIdRow({ level }: { readonly level: TelemetryLevel }) {
  const api = useApi();
  const [id, setId] = useState<string>();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    void api.telemetry
      .installId()
      .then((v) => live && setId(typeof v === 'string' ? v : undefined))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [level]);
  if (!id) return null;
  const copy = (): void => {
    void copyText(id).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const reset = (): void => {
    void api.telemetry
      .resetId()
      .then((v) => typeof v === 'string' && setId(v))
      .catch(() => undefined);
  };
  return (
    <Row
      label="Install ID"
      detail={
        <>
          <span className={s.installId}>{id}</span> Include it in a privacy request. Reset ID starts a new one: what was sent before stays linked to the old ID.
        </>
      }
    >
      <Button size="small" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </Button>
      <Button size="small" onClick={reset}>
        Reset ID
      </Button>
    </Row>
  );
}
