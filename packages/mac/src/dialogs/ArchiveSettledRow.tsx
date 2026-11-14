import { useEffect, useState } from 'react';
import { ARCHIVE_SETTLED_DAYS_MAX } from '@beluga/shared/settings-schema.js';
import { useApi, useApp } from '../lib/beluga.js';
import { Row } from './settings-controls.js';
import s from './settings.module.css';

/**
 * Settings › Appearance › Archive settled chats: how many days a chat stays in Settled before it
 * is archived by itself (0: never). Any whole number of days; saved when you leave the field.
 */
export function ArchiveSettledRow() {
  const api = useApi();
  const saved = useApp((st) => st.prefs.archiveSettledDays);
  const [value, setValue] = useState(String(saved));
  useEffect(() => setValue(String(saved)), [saved]);
  const days = daysFrom(value);
  const save = (): void => {
    if (days !== undefined && days !== saved) void api.session.setPrefs({ archiveSettledDays: days });
  };
  return (
    <Row label="Archive settled chats" detail={detailFor(days)}>
      <form
        className={s.daysField}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <input aria-label="Archive settled chats after days" className={s.days} type="number" inputMode="numeric" min={0} max={ARCHIVE_SETTLED_DAYS_MAX} step={1} value={value} onChange={(e) => setValue(e.target.value)} onBlur={save} />
        <span>days</span>
      </form>
    </Row>
  );
}

/** A whole number of days in range, or undefined. */
function daysFrom(text: string): number | undefined {
  if (!/^\d+$/.test(text.trim())) return undefined;
  const days = Number(text);
  return days <= ARCHIVE_SETTLED_DAYS_MAX ? days : undefined;
}

function detailFor(days: number | undefined): string {
  if (days === undefined) return `Type a whole number of days, from 0 to ${ARCHIVE_SETTLED_DAYS_MAX}.`;
  if (days === 0) return 'Settled chats stay until you archive them. 0 means never.';
  return `A chat in Settled for ${days} day${days === 1 ? '' : 's'} is archived. Its branch and conversation are kept. 0 means never.`;
}
