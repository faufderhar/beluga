import { EXPERIMENTS, EXPERIMENT_INFO, type Experiment, experimentOn, withExperiment } from '@beluga/shared/experiments.js';
import { Icon } from '../components/Icon.js';
import { useApi, useApp } from '../lib/beluga.js';
import { Group, Row, Switch } from './settings-controls.js';
import s from './settings.module.css';
import x from './experimental.module.css';

/**
 * Settings › Experimental: early features, each off until you turn it on (or on until you turn it
 * off: shared/experiments.ts DEFAULT_ON), each saying what it
 * changes in Beluga and what it costs this computer (shared/experiments.ts). Turning one on is
 * saved with your settings, and the daemon follows it at once (what your agent is told, what it
 * may build).
 */
export function ExperimentalSettings() {
  const api = useApi();
  const enabled = useApp((st) => st.prefs.experiments);
  const set = (id: Experiment, on: boolean): void => void api.session.setPrefs({ experiments: withExperiment(enabled, id, on) });
  return (
    <>
      <div className={x.intro}>
        <Icon name="flask" size={16} className={x.introIcon} />
        <p>
          Early features we’re still shaping. They haven’t been tested as fully as the rest of Beluga, so most are off until you turn them on, and each may change before it’s finished. Here’s what each does, and what it changes.
        </p>
      </div>
      {EXPERIMENTS.map((id) => {
        const info = EXPERIMENT_INFO[id];
        const on = experimentOn(enabled, id);
        return (
          <Group key={id} title={info.title}>
            <Row label={info.title} detail={info.summary}>
              <Switch label={info.title} on={on} onChange={(v) => set(id, v)} />
            </Row>
            <div className={x.about}>
              <div className={x.heading}>What changes</div>
              <ul className={x.changes}>
                {info.changes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <div className={x.heading}>On this computer</div>
              <p className={x.cost}>{info.cost}</p>
            </div>
          </Group>
        );
      })}
      <p className={s.note}>Something not right in an experiment? Report a Problem, in About, tells us.</p>
    </>
  );
}
