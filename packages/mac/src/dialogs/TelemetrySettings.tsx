import type { TelemetryLevel } from '@beluga/core/telemetry-store.js';
import { useApi, useApp } from '../lib/beluga.js';
import { LEVELS } from '../lib/telemetry.js';
import { Group, Row, Select } from './settings-controls.js';

/** Settings › General › Usage statistics: Off, Limited, On. Only in builds that can send them. */
export function TelemetrySettingsGroup() {
  const api = useApi();
  const telemetry = useApp((st) => st.telemetry);
  if (!telemetry.available) return null;
  const level = telemetry.level ?? 'off';
  return (
    <Group title="Usage statistics">
      <Row label="Share usage statistics" detail={LEVELS.find((l) => l.level === level)?.detail ?? ''}>
        <Select<TelemetryLevel> label="Share usage statistics" value={level} onChange={(v) => void api.telemetry.choose(v, 'settings')} options={LEVELS.map((l) => ({ value: l.level, label: l.label, description: l.detail }))} />
      </Row>
    </Group>
  );
}
