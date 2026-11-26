import { AUTOPILOT_WAIT_CHOICES, AUTOPILOT_WAIT_DEFAULT, AUTOPILOT_WAIT_NEVER, autopilotWaitWords } from '@beluga/shared/autopilot-wait.js';
import { useApi, useApp } from '../lib/beluga.js';
import { Group, Row, Select } from './settings-controls.js';

/**
 * Settings › Agent › Autopilot (BLG-998): how long work on Autopilot waits for your answer before
 * your agent carries on without it. Step by Step, Check-ins and plain chats always wait for you.
 */
export function AutopilotWaitSettings() {
  const api = useApi();
  const saved = useApp((st) => st.prefs.autopilotWait ?? AUTOPILOT_WAIT_DEFAULT);
  // A number set in settings.json by hand still shows as itself.
  const values = AUTOPILOT_WAIT_CHOICES.includes(saved) ? AUTOPILOT_WAIT_CHOICES : [...AUTOPILOT_WAIT_CHOICES, saved].sort((a, b) => (a || Infinity) - (b || Infinity));
  const detail =
    saved === AUTOPILOT_WAIT_NEVER
      ? 'Questions and plans your agent asks you wait until you answer, on Autopilot too.'
      : `On Autopilot, a question or plan you leave for ${autopilotWaitWords(saved)} is skipped and your agent carries on. Step by Step, Check-ins and chats always wait for you.`;
  return (
    <Group title="Autopilot">
      <Row label="Wait for your answer" detail={detail}>
        <Select
          label="Wait for your answer"
          value={String(saved)}
          onChange={(v) => void api.session.setPrefs({ autopilotWait: Number(v) })}
          options={values.map((m) => ({ value: String(m), label: m === AUTOPILOT_WAIT_DEFAULT ? `${autopilotWaitWords(m)} (default)` : autopilotWaitWords(m) }))}
        />
      </Row>
    </Group>
  );
}
