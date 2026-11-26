import type { ReactNode } from 'react';
import { cx } from '../components/ui.js';
import { settingAnchor } from '../lib/settings-search.js';
import s from './settings.module.css';

/** The pop-up button of a Settings row: Beluga's own (components/Select). */
export { Select } from '../components/Select.js';

/**
 * The building blocks of every Settings pane: grouped rows with a label, a detail and a control.
 * Rows and titled groups carry an anchor made from their words, which Settings' search jumps to.
 */

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={cx(s.switch, on && s.switchOn)} onClick={() => onChange(!on)} />;
}

/** A setting's row. `name`: its label is a name (an agent's), shown as it is in every language. */
export function Row({ label, detail, children, name }: { label: string; detail?: ReactNode; children?: ReactNode; name?: boolean }) {
  return (
    <div className={s.row} data-setting={settingAnchor(label)}>
      <div className={s.rowText}>
        <div className={s.rowLabel} {...(name ? { translate: 'no' as const } : {})}>
          {label}
        </div>
        {detail ? <div className={s.rowDetail}>{detail}</div> : null}
      </div>
      <div className={s.control}>{children}</div>
    </div>
  );
}

export function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className={s.group} {...(title ? { 'data-setting-group': settingAnchor(title) } : {})}>
      {title ? <h3 className={s.groupTitle}>{title}</h3> : null}
      <div className={s.groupBox}>{children}</div>
    </section>
  );
}
