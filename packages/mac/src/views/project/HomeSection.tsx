import type { ReactNode } from "react";
import { cx } from "../../components/ui.js";
import s from "../project-home.module.css";
import a from "../../lib/arrive.module.css";

/** One of Project Home's lists: its title and count, a hint, one action, then its rows. */
export function Section({
  title,
  count,
  hint,
  action,
  arrive,
  children,
}: {
  /** It came after the page opened: it settles in. */
  arrive?: boolean;
  title: string;
  count: number;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={cx(s.section, arrive && a.arrive)} aria-label={title}>
      <div className={s.sectionHead}>
        <h3 className={s.sectionTitle}>
          {title} <span className={s.count}>{count}</span>
        </h3>
        {hint ? <span className={s.sectionHint}>{hint}</span> : null}
        <span className={s.flex} />
        {action}
      </div>
      <div className={s.rows} role="list">
        {children}
      </div>
    </section>
  );
}

