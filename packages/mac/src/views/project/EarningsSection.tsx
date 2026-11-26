import { useState } from 'react';
import { EARNINGS_RANGES, type EarningsActivity, type EarningsRange, type FxRates, type MoneyTotal, type PaymentStatus, type RangeDay, type RecentPayment, convertParts, lastDays, rangeFigures } from '@beluga/core/earnings-store.js';
import type { ProjectRevenueCat } from '@beluga/core/revenuecat-store.js';
import type { Project } from '@beluga/workspaces/types.js';
import { Icon } from '../../components/Icon.js';
import { Button, Segmented, Tip, cx } from '../../components/ui.js';
import { brandText } from '../../lib/brand.js';
import { type CombinedEarnings, formatGlance, formatMoney, missingNote, newestPaid, openEarnings, revenueCatUrl, sourcesOf, stripePaymentsUrl, updatedAgo, useArrived, useMoney, useProjectEarnings } from '../../lib/earnings.js';
import { openExternal } from '../../lib/system.js';
import { agoText } from './home-model.js';
import h from '../project-home.module.css';
import s from './earnings-section.module.css';

/**
 * A project's home, with Stripe or RevenueCat connected: how it's doing lately, as one quiet row at the bottom
 * of the page, like its other sections. Folded, the row says what it earned in the last 7, 30 or
 * 90 days (your pick, kept for every project) against the span before, how many payments and
 * paying customers, and when the last payment came. Unfolded (kept too): the range, what came in
 * each day, what each source brought in (when both are connected), RevenueCat's own figures, and
 * Stripe's latest payments, filtered to refunds or failed ones when there are any. Money shows in
 * the currency you show earnings in; the Earnings sheet has the rest. Paying customers and
 * payments are Stripe's alone (RevenueCat has neither). Nothing when neither is connected.
 */
export function EarningsSection({ project }: { project: Project }) {
  const earnings = useProjectEarnings(project.root);
  const [range, setRange] = useKept<EarningsRange>(RANGE_KEY, (v) => EARNINGS_RANGES.find((r) => String(r) === v) ?? 30);
  const [open, setOpen] = useKept<boolean>(OPEN_KEY, (v) => v === 'true');
  if (!earnings) return null;
  const status = earnings.refreshing ? `reading ${sourcesOf([earnings])}…` : earnings.updatedAt ? `updated ${updatedAgo(earnings.updatedAt)}` : undefined;
  const activity = earnings.activity;
  return (
    <section className={h.section} aria-label="Earnings">
      <div className={h.sectionHead}>
        <h3 className={h.sectionTitle}>Earnings</h3>
        <span className={h.sectionHint}>
          {earnings.account ?? sourcesOf([earnings])}
          {earnings.mode === 'test' && !earnings.revenuecat ? ' · test mode' : ''}
          {status ? ` · ${status}` : ''}
        </span>
        <span className={h.flex} />
        <Button size="small" variant="quiet" onClick={() => openEarnings(project.id)}>
          Earnings…
        </Button>
      </div>
      <div className={h.rows}>
        {activity ? (
          <>
            <Summary activity={activity} earnings={earnings} range={range} open={open} onToggle={() => setOpen(!open)} />
            {open ? <Details activity={activity} earnings={earnings} range={range} onRange={setRange} /> : null}
          </>
        ) : (
          <NotYet project={project} earnings={earnings} />
        )}
      </div>
    </section>
  );
}

const RANGE_KEY = 'beluga.earnings.range.v1';
const OPEN_KEY = 'beluga.earnings.open.v1';

/** A choice kept in this Mac's storage, for every project (no storage: this page keeps it). */
function useKept<T>(key: string, read: (stored: string | null) => T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      return read(localStorage.getItem(key));
    } catch {
      return read(null);
    }
  });
  return [
    value,
    (v) => {
      setValue(v);
      try {
        localStorage.setItem(key, String(v));
      } catch {
        // No storage: this page keeps it.
      }
    },
  ];
}

function NotYet({ project, earnings }: { project: Project; earnings: CombinedEarnings }) {
  if (earnings.error && !earnings.refreshing) {
    return (
      <div className={cx(h.row, s.problem)} role="status">
        <span className={h.rowIcon}>
          <Icon name="alert" size={13} />
        </span>
        <span className={h.rowMain}>{brandText(earnings.error.message)}</span>
        <button type="button" className={s.link} onClick={() => openEarnings(project.id)}>
          Earnings…
        </button>
      </div>
    );
  }
  return <p className={h.none}>Reading the last months from {sourcesOf([earnings])}…</p>;
}

/** The money of some totals in the currency earnings show in (≈ when some was converted). */
interface Shown {
  readonly amount: number;
  readonly approx: boolean;
  readonly missing: readonly MoneyTotal[];
}

const shownOf = (totals: readonly MoneyTotal[], currency: string, fx: FxRates | undefined): Shown => {
  const c = convertParts(totals, currency, fx);
  return { amount: c.amount, approx: c.converted, missing: c.missing };
};

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** The folded row: the range's money and its change, payments, paying customers, the last payment. */
function Summary({ activity, earnings, range, open, onToggle }: { activity: EarningsActivity; earnings: CombinedEarnings; range: EarningsRange; open: boolean; onToggle: () => void }) {
  const { currency, fx } = useMoney();
  const fig = rangeFigures(activity, range);
  const earned = shownOf(fig.totals, currency, fx);
  const before = fig.before ? shownOf(fig.before.totals, currency, fx) : undefined;
  const span = `the ${range} days before`;
  const last = newestPaid(earnings);
  const both = Boolean(earnings.stripe && earnings.revenuecat);
  const counted = both
    ? 'Stripe: captured minus refunds, before its fees. RevenueCat: net of refunds, before store fees and taxes.'
    : earnings.stripe
      ? 'Captured minus refunds, before Stripe’s fees.'
      : 'Net of refunds, before store fees and taxes.';
  const money = `${earned.approx ? '≈ ' : ''}${formatGlance(earned.amount, currency)}`;
  return (
    <button type="button" className={h.row} aria-expanded={open} aria-label={`${money} in the last ${range} days`} onClick={onToggle} data-earnings-summary>
      <span className={h.rowIcon}>
        <Icon name="coin" size={13} />
      </span>
      <span className={h.rowMain}>
        <span className={h.rowTitle}>
          <Tip label={`${formatMoney(earned.amount, currency)} in the last ${range} days${before ? `, ${formatMoney(before.amount, currency)} in ${span}` : ''}. ${counted}`}>
            <span className={h.rowName}>{money}</span>
          </Tip>
          <span className={s.range}>in the last {range} days</span>
          <Change now={earned.amount} before={before?.amount} />
        </span>
        <span className={h.rowLast}>
          {plural(fig.payments, 'payment', 'payments')}
          <Change now={fig.payments} before={fig.before?.payments} />
          {fig.payers !== undefined ? (
            <>
              {' · '}
              {plural(fig.payers, 'paying customer', 'paying customers')}
              {both ? ' (Stripe)' : ''}
              <Change now={fig.payers} before={fig.before?.payers} />
            </>
          ) : null}
        </span>
      </span>
      {last ? <span className={s.last}>last payment {agoText(last.at)}</span> : null}
      <Icon name="chevronDown" size={11} className={cx(s.fold, open && s.folded)} />
    </button>
  );
}

/** Up or down against the span before, in percent ("new" when there was nothing then): a small mark. */
function Change({ now, before }: { now: number; before: number | undefined }) {
  if (before === undefined) return null;
  if (before === 0) return now > 0 ? <span className={cx(s.change, s.up)}>new</span> : null;
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return <span className={cx(s.change, s.flat)}>±0%</span>;
  return (
    <span className={cx(s.change, pct > 0 ? s.up : s.down)} data-change={pct}>
      {pct > 0 ? '↑' : '↓'}
      {Math.abs(pct)}%
    </span>
  );
}

/** Unfolded: the range, each day, the latest payments. */
function Details({ activity, earnings, range, onRange }: { activity: EarningsActivity; earnings: CombinedEarnings; range: EarningsRange; onRange: (r: EarningsRange) => void }) {
  const { currency, fx } = useMoney();
  const fig = rangeFigures(activity, range);
  const note = missingNote(shownOf(fig.totals, currency, fx).missing);
  const allTime = earnings.totals ? shownOf(earnings.totals, currency, fx) : undefined;
  return (
    <div className={s.details}>
      <div className={s.bar}>
        <Segmented<`${EarningsRange}`> size="small"
          label="Range"
          value={`${range}`}
          onChange={(v) => onRange(Number(v) as EarningsRange)}
          options={EARNINGS_RANGES.map((r) => ({ value: `${r}` as const, label: `${r} days`, hint: `The last ${r} days, today included` }))}
        />
        <span className={h.flex} />
        {allTime ? (
          <span className={s.dim}>
            All time {allTime.approx ? '≈ ' : ''}
            {formatGlance(allTime.amount, currency)}
          </span>
        ) : null}
      </div>
      <DayBars days={fig.days} currency={currency} fx={fx} />
      {earnings.stripe && earnings.revenuecat ? <BySource earnings={earnings} range={range} /> : null}
      {note || activity.partial ? (
        <p className={s.dim}>
          {note}
          {note && activity.partial ? ' ' : ''}
          {activity.partial ? 'A busy account: Beluga read the newest 5,000 payments, so the oldest days may show only part.' : ''}
        </p>
      ) : null}
      {earnings.revenuecat ? <RevenueCatBlock rc={earnings.revenuecat} range={range} /> : null}
      {earnings.stripe ? <Latest latest={earnings.stripe.activity?.latest ?? []} mode={earnings.stripe.mode} /> : null}
    </div>
  );
}

/** What each source brought in over the range (the row above adds them). */
function BySource({ earnings, range }: { earnings: CombinedEarnings; range: EarningsRange }) {
  const { currency, fx } = useMoney();
  const rows = [
    { name: 'Stripe', activity: earnings.stripe?.activity },
    { name: 'RevenueCat', activity: earnings.revenuecat?.activity ? { ...earnings.revenuecat.activity, payers: [], latest: [] } : undefined },
  ];
  return (
    <ul className={s.split} aria-label="By source">
      {rows.map(({ name, activity }) => {
        const fig = activity ? rangeFigures(activity, range) : undefined;
        const shown = fig ? shownOf(fig.totals, currency, fx) : undefined;
        return (
          <li key={name} className={s.splitItem}>
            <span className={s.splitName}>{name}</span>
            <span className={s.splitAmount}>{shown ? `${shown.approx ? '≈ ' : ''}${formatMoney(shown.amount, currency)}` : 'counting…'}</span>
            {fig ? <span className={s.dim}>{plural(fig.payments, 'payment', 'payments')}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

/** RevenueCat's own figures: subscriptions right now, and what's kept of the range after store fees and taxes. */
function RevenueCatBlock({ rc, range }: { rc: ProjectRevenueCat; range: EarningsRange }) {
  const { currency, fx } = useMoney();
  const subs = rc.subscriptions;
  const inRange = new Set(lastDays(range, Date.now()));
  const kept = (rc.activity?.days ?? []).filter((d) => inRange.has(d.day) && d.proceeds).flatMap((d) => d.proceeds!);
  const keep = rc.activity?.days.some((d) => d.proceeds) ? shownOf(kept, currency, fx) : undefined;
  const mrr = subs?.mrr !== undefined ? shownOf([{ currency: rc.currency, amount: subs.mrr }], currency, fx) : undefined;
  const stats: Array<[string, string | undefined]> = [
    ['MRR', mrr ? `${mrr.approx ? '≈ ' : ''}${formatMoney(mrr.amount, currency)}` : undefined],
    ['Active subscriptions', subs?.activeSubscriptions?.toLocaleString()],
    ['Active trials', subs?.activeTrials?.toLocaleString()],
    ['New customers (28 days)', subs?.newCustomers?.toLocaleString()],
  ];
  return (
    <div className={s.latest} role="group" aria-label="RevenueCat">
      <div className={s.latestHead}>
        <h4 className={s.latestTitle}>RevenueCat</h4>
        <span className={h.flex} />
        <button type="button" className={s.link} onClick={() => void openExternal(revenueCatUrl(rc.project.id))}>
          Open RevenueCat
          <Icon name="external" size={10} />
        </button>
      </div>
      {subs ? (
        <dl className={s.stats}>
          {stats.map(([label, value]) =>
            value === undefined ? null : (
              <div key={label} className={s.stat}>
                <dt className={s.dim}>{label}</dt>
                <dd className={s.statValue}>{value}</dd>
              </div>
            ),
          )}
        </dl>
      ) : null}
      {keep ? (
        <p className={s.dim}>
          You keep ≈ {formatMoney(keep.amount, currency)} (after store fees and taxes)
        </p>
      ) : null}
    </div>
  );
}

const dateOf = (day: string): Date => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d!, 12);
};
const shortDay = (day: string): string => dateOf(day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const longDay = (day: string): string => dateOf(day).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

/** What came in each day: a bar per day, the quiet ones a stub, today's a shade stronger. */
function DayBars({ days, currency, fx }: { days: readonly RangeDay[]; currency: string; fx: FxRates | undefined }) {
  // A day can be negative (refunds are booked on the refund day): its bar is a stub, never below the line.
  const values = days.map((d) => Math.max(0, convertParts(d.totals, currency, fx).amount));
  const max = Math.max(1, ...values);
  return (
    <div className={s.chartWrap}>
      <div className={cx(s.chart, days.length > 40 && s.dense)} role="img" aria-label={`Earned each day, the last ${days.length} days`}>
        {days.map((d, i) => {
          const v = values[i]!;
          return (
            <Tip key={d.day} label={`${longDay(d.day)} · ${v ? `${formatMoney(v, currency)} · ${plural(d.payments, 'payment', 'payments')}` : 'no payments'}`}>
              <span className={cx(s.col, i === days.length - 1 && s.today)}>
                <span className={cx(s.fill, !v && s.zero)} style={v ? { height: `${Math.max(6, (v / max) * 100)}%` } : undefined} />
              </span>
            </Tip>
          );
        })}
      </div>
      <div className={s.axis} aria-hidden="true">
        <span>{shortDay(days[0]!.day)}</span>
        <span>Today</span>
      </div>
    </div>
  );
}

type Filter = 'all' | 'refunds' | 'failed';

const FILTERS: ReadonlyArray<{ value: Filter; label: string; test: (p: RecentPayment) => boolean }> = [
  { value: 'all', label: 'All', test: () => true },
  { value: 'refunds', label: 'Refunds', test: (p) => p.status === 'refunded' || p.status === 'partly_refunded' },
  { value: 'failed', label: 'Failed', test: (p) => p.status === 'failed' },
];

type Tone = 'ok' | 'info' | 'merged' | 'warn' | 'muted';

const STATUS: Partial<Record<PaymentStatus, { label: string; tone: Tone }>> = {
  refunded: { label: 'Refunded', tone: 'muted' },
  partly_refunded: { label: 'Part refunded', tone: 'muted' },
  pending: { label: 'Pending', tone: 'info' },
  failed: { label: 'Failed', tone: 'warn' },
};

/** How many of the latest payments show before Show All. */
const FEW = 5;

/** The latest payments, newest first; filters only for kinds there are. */
function Latest({ latest, mode }: { latest: readonly RecentPayment[]; mode: 'test' | 'live' }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [all, setAll] = useState(false);
  const arrived = useArrived(latest);
  const offered = FILTERS.filter((f) => f.value === 'all' || latest.some(f.test));
  const chosen = offered.find((f) => f.value === filter) ?? FILTERS[0]!;
  const list = latest.filter(chosen.test);
  const shown = all ? list : list.slice(0, FEW);
  return (
    <div className={s.latest}>
      <div className={s.latestHead}>
        <h4 className={s.latestTitle}>Latest payments from Stripe</h4>
        {offered.length > 1 ? (
          <div className={s.filters} role="radiogroup" aria-label="Show">
            {offered.map((f) => (
              <button key={f.value} type="button" role="radio" aria-checked={f.value === chosen.value} className={cx(s.filter, f.value === chosen.value && s.filterOn)} onClick={() => setFilter(f.value)}>
                {f.label}
                {f.value === 'all' ? null : <span className={s.filterCount}>{latest.filter(f.test).length}</span>}
              </button>
            ))}
          </div>
        ) : null}
        <span className={h.flex} />
        <button type="button" className={s.link} onClick={() => void openExternal(stripePaymentsUrl(mode))}>
          Open Stripe
          <Icon name="external" size={10} />
        </button>
      </div>
      {shown.length ? (
        <div className={s.payments} role="list" aria-label="Latest payments">
          {shown.map((p) => (
            <PaymentRow key={p.id} payment={p} fresh={arrived.has(p.id)} />
          ))}
        </div>
      ) : (
        <p className={s.dim}>{latest.length ? 'None of these lately.' : 'No payments in the last six months.'}</p>
      )}
      {list.length > FEW ? (
        <button type="button" className={cx(s.link, s.more)} onClick={() => setAll(!all)}>
          {all ? 'Show Fewer' : `Show All ${list.length}`}
        </button>
      ) : null}
    </div>
  );
}

function PaymentRow({ payment: p, fresh }: { payment: RecentPayment; fresh: boolean }) {
  const status = STATUS[p.status];
  const gone = p.status === 'refunded' || p.status === 'failed';
  return (
    <div role="listitem" className={cx(s.pay, fresh && s.fresh)} data-payment={p.status}>
      <span className={s.payWho}>{p.who ?? 'A customer'}</span>
      {p.description ? <span className={s.payWhat}>{p.description}</span> : <span className={h.flex} />}
      {fresh ? <span className={cx(s.badge, s.badgeNew)}>New</span> : null}
      {status ? <span className={cx(s.badge, s[`badge_${status.tone}`])}>{status.label}</span> : null}
      <Tip label={p.refunded && p.status === 'partly_refunded' ? `${formatMoney(p.refunded, p.currency)} refunded` : new Date(p.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}>
        <span className={cx(s.payAmount, gone && s.struck)}>{formatMoney(p.amount, p.currency)}</span>
      </Tip>
      <span className={s.payWhen}>{agoText(p.at)}</span>
    </div>
  );
}
