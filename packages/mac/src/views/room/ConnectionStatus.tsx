import { useEffect, useState } from 'react';
import { Button, Dot } from '../../components/ui.js';
import { useApi, useApp } from '../../lib/beluga.js';
import { connectionHint, connectionLine } from './connection-model.js';
import s from './connection.module.css';

/** Ticks once a second, only while something counts down. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/**
 * At the top of the room while it can't be reached: one status that updates in place (the
 * chat gets one line per outage, never one per try). Gone once you're back.
 */
export function ConnectionStatus() {
  const api = useApi();
  const trouble = useApp((st) => st.connection);
  const now = useNow(trouble?.state === 'reconnecting');
  if (!trouble) return null;
  const line = connectionLine(trouble, now);
  return (
    <div className={s.wrap}>
      <div className={s.status} role="status" aria-label="Room connection" title={connectionHint(trouble)}>
        <Dot tone={trouble.state === 'offline' ? 'error' : 'warn'} />
        <span className={s.text}>
          <span className={s.lead}>{line.lead}</span> · {line.detail}
        </span>
        {line.canRetry ? (
          <Button size="small" variant="plain" className={s.button} onClick={() => void api.session.retryConnection()}>
            Retry Now
          </Button>
        ) : null}
      </div>
    </div>
  );
}
