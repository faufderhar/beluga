import { Icon } from '../components/Icon.js';
import { ProjectIcon } from '../components/ProjectIcon.js';
import { Button, IconButton, Tip, cx } from '../components/ui.js';
import { EarningsTipBody } from '../components/EarningsPill.js';
import { dismissEarningsHint, formatMoney, missingNote, openEarnings, refreshEarnings, sourcesOf, updatedAgo, useConvertedEarnings, useEarningsHintDismissed } from '../lib/earnings.js';
import { useApi, useApp } from '../lib/beluga.js';
import s from './earnings-card.module.css';

/**
 * The Overview's Earnings: every project with Stripe or RevenueCat connected and what it earned, all-time.
 * Before any is connected, a one-time hint says it exists (dismissed for good with ✕).
 */
export function EarningsCard() {
  const api = useApi();
  const summary = useConvertedEarnings();
  const dismissed = useEarningsHintDismissed();
  const repos = useApp((st) => st.projects.filter((p) => p.root).length);
  if (!summary.projects.length) {
    if (dismissed || !repos) return null;
    return (
      <section className={s.hint} aria-label="Track earnings">
        <span className={s.hintIcon} aria-hidden="true">
          <Icon name="coin" size={16} />
        </span>
        <span className={s.hintText}>
          <span className={s.hintTitle}>Track what your projects earn</span>
          <span className={s.hintDetail}>Connect Stripe or RevenueCat to a project and its earnings show beside it in the sidebar, with how it’s doing lately on its home.</span>
        </span>
        <Button size="small" variant="primary" onClick={() => openEarnings()}>
          Connect…
        </Button>
        <IconButton size="small" icon="x" label="Don’t show this again" className={s.dismiss} onClick={dismissEarningsHint} />
      </section>
    );
  }
  const { currency, total, rows } = summary.converted;
  const several = summary.projects.length > 1;
  const counted = summary.projects.some((c) => c.earnings.totals);
  return (
    <section className={s.card} aria-label="Earnings">
      <div className={s.head}>
        <h2 className={s.title}>Earnings</h2>
        <span className={s.sub}>all-time, from {sourcesOf(summary.projects.map((c) => c.earnings))}{summary.updatedAt && !summary.refreshing ? ` · updated ${updatedAgo(summary.updatedAt)}` : summary.refreshing ? ' · counting…' : ''}</span>
        <span className={s.actions}>
          <Button size="small" variant="quiet" icon="plus" onClick={() => openEarnings()}>
            Connect Another…
          </Button>
          <Tip label="Count again now">
            <Button size="small" variant="quiet" icon="refresh" aria-label="Refresh all earnings" disabled={summary.refreshing} onClick={() => refreshEarnings(api)} />
          </Tip>
        </span>
      </div>
      <div className={s.tiles}>
        {several && counted ? (
          <div className={cx(s.tile, s.all)}>
            <span className={s.tileName}>All projects</span>
            <span className={s.amount}>{formatMoney(total.amount, currency)}</span>
            <span className={s.others}>{missingNote(total.missing) ?? (total.converted ? 'Converted at the ECB’s daily rates' : ' ')}</span>
          </div>
        ) : null}
        {rows.map(({ item: { project, earnings }, money, share }) => (
          <Tip key={project.id} label={<EarningsTipBody earnings={earnings} />}>
            <button type="button" className={cx(s.tile, earnings.refreshing && s.counting)} onClick={() => openEarnings(project.id)}>
              <span className={s.tileName}>
                <ProjectIcon id={project.id} name={project.name} size={14} />
                {project.name}
                {earnings.mode === 'test' && !earnings.revenuecat ? <span className={s.test}>test</span> : null}
                {earnings.error ? <Icon name="alert" size={11} className={s.warn} /> : null}
              </span>
              <span className={s.amount}>{earnings.totals ? formatMoney(money.amount, currency) : 'Counting…'}</span>
              <span className={s.others}>{missingNote(money.missing) ?? (several && earnings.totals ? `${Math.round(share * 100)}% of the total` : ' ')}</span>
            </button>
          </Tip>
        ))}
      </div>
    </section>
  );
}
