import { EarningsTipBody } from '../../components/EarningsPill.js';
import { Icon } from '../../components/Icon.js';
import { ProjectIcon } from '../../components/ProjectIcon.js';
import { Button, IconButton, Tip, cx } from '../../components/ui.js';
import { type ConnectedProject, formatGlance, formatMoney, missingNote, openEarnings, ratesWhen, updatedAgo, useConvertedEarnings } from '../../lib/earnings.js';
import type { ConvertedRow } from '../../lib/money.js';
import { Card } from './parts.js';
import s from './usage.module.css';

/** One connected project: its name, what it earned in the shown currency, and a thin bar for its part of the total. */
function EarningsRow({ row, currency }: { row: ConvertedRow<ConnectedProject>; currency: string }) {
  const { project, earnings } = row.item;
  const counted = Boolean(earnings.totals);
  const nothingConverts = counted && row.money.missing.length > 0 && row.money.missing.length === earnings.totals!.length;
  const amount = !counted ? 'Counting…' : nothingConverts ? '—' : formatGlance(row.money.amount, currency);
  const pct = Math.round(row.share * 100);
  return (
    <li>
      <Tip label={<EarningsTipBody earnings={earnings} />}>
        <button type="button" className={cx(s.earnRow, earnings.refreshing && s.earnCounting)} onClick={() => openEarnings(project.id)} aria-label={`${project.name}: ${counted ? formatMoney(row.money.amount, currency) : 'counting'}${counted && pct ? `, ${pct}% of the total` : ''}`}>
          <span className={s.earnName}>
            <ProjectIcon id={project.id} name={project.name} size={14} />
            <span className={s.earnLabel}>{project.name}</span>
            {earnings.mode === 'test' && !earnings.revenuecat ? <span className={s.earnTest}>test</span> : null}
            {earnings.error ? <Icon name="alert" size={11} className={s.alertWarn} /> : null}
          </span>
          <span className={s.earnAmount}>{amount}</span>
          <span className={s.earnShare} aria-hidden="true">
            <span style={{ width: `${row.share > 0 ? Math.max(1.5, row.share * 100) : 0}%` }} />
          </span>
        </button>
      </Tip>
    </li>
  );
}

/**
 * The Usage view's third card: what every project with Stripe or RevenueCat connected earned, all-time, as one
 * amount in the currency you show earnings in (Settings › General, or a project's Earnings sheet),
 * then each project with its part of it. Other currencies are converted at the ECB's daily rates;
 * a project's own currencies show on hover. With none connected, a quiet way to connect one.
 */
export function EarningsSummaryCard() {
  const summary = useConvertedEarnings();
  if (!summary.projects.length) {
    return (
      <Card label="Earnings" title="Earnings" className={s.earnCard}>
        <p className={s.quiet}>Connect Stripe or RevenueCat to a project and what it has earned, all-time, shows here and beside it in the sidebar.</p>
        <div className={s.earnConnect}>
          <Button size="small" icon="coin" onClick={() => openEarnings()}>
            Connect Earnings…
          </Button>
        </div>
      </Card>
    );
  }
  const { converted, fx } = summary;
  const { currency, total } = converted;
  const counted = summary.projects.some((c) => c.earnings.totals);
  const status = summary.refreshing ? 'Counting…' : summary.updatedAt ? `Updated ${updatedAgo(summary.updatedAt)}` : undefined;
  const count = summary.projects.length;
  const caption = ['All time', `${count} ${count === 1 ? 'project' : 'projects'}`, ...(total.converted && fx ? [`ECB rates, updated ${ratesWhen(fx.at)}`] : [])].join(' · ');
  const note = missingNote(total.missing);
  return (
    <Card
      label="Earnings"
      title="Earnings"
      className={s.earnCard}
      aside={
        <>
          {status ? <span className={s.updated}>{status}</span> : null}
          <IconButton size="small" icon="plus" label="Connect Earnings to Another Project…" className={s.earnAdd} onClick={() => openEarnings()} />
        </>
      }
    >
      <div className={s.earnBody}>
        <div className={s.earnSummary}>
          <Tip label={total.converted ? `${formatMoney(total.amount, currency)} · approximate, other currencies converted at the ECB’s rates` : formatMoney(total.amount, currency)}>
            <span className={s.earnTotal} data-earnings-total={currency} aria-label={`All-time earnings ${total.converted ? 'about ' : ''}${formatMoney(total.amount, currency)}`}>
              {counted ? formatGlance(total.amount, currency) : '—'}
            </span>
          </Tip>
          <div className={s.earnCaption}>{caption}</div>
          {note ? <div className={s.earnNote}>{note}</div> : null}
        </div>
        <ul className={s.earnList} aria-label="Earnings by project">
          {converted.rows.map((row) => (
            <EarningsRow key={row.item.project.id} row={row} currency={currency} />
          ))}
        </ul>
      </div>
    </Card>
  );
}
