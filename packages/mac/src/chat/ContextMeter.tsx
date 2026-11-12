import * as Popover from '@radix-ui/react-popover';
import { useEffect, useMemo, useRef, useState } from 'react';
import { contextFacts } from '@beluga/ui/context-facts.js';
import { cacheHitOf, formatTokenCount } from '@beluga/shared/context-usage.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { tokensOf } from '@beluga/workspaces/usage-days.js';
import { LOCAL_RUNTIME, speedWords } from '@beluga/shared/local-endpoints.js';
import { cx } from '../components/ui.js';
import { toast, useApi, useApp, useBeluga } from '../lib/beluga.js';
import { type MeterModel, breakdownRows, meterModel, usageLine, whenText } from './context-model.js';
import s from './context.module.css';

const OPEN_DELAY_MS = 220;
const CLOSE_DELAY_MS = 180;
const R = 6;
const CIRCUMFERENCE = 2 * Math.PI * R;

/** The ring: how much of the window is used, or a short arc going round while Claude compacts. */
function Ring({ pct, spinning }: { pct: number; spinning: boolean }) {
  const filled = spinning ? 0.28 : Math.max(pct > 0 ? 0.04 : 0, Math.min(1, pct / 100));
  return (
    <svg className={s.ring} width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <circle className={s.track} cx="8" cy="8" r={R} fill="none" strokeWidth="2" />
      <circle className={s.arc} cx="8" cy="8" r={R} fill="none" strokeWidth="2" strokeLinecap="round" strokeDasharray={CIRCUMFERENCE} strokeDashoffset={CIRCUMFERENCE * (1 - filled)} />
    </svg>
  );
}

/** The meter for a conversation (undefined: nothing to show, or the meter is turned off). */
function useMeter(channel: string): MeterModel | undefined {
  const on = useApp((st) => st.prefs.contextMeter);
  const context = useApp((st) => st.context);
  const log = useApp((st) => st.log);
  return useMemo(() => (on ? meterModel({ context, log }, channel) : undefined), [on, context, log, channel]);
}

/**
 * A local or bring-your-own model's conversation (BLG-450): its tokens so far and how fast its
 * last turn wrote. There's no plan behind it, so this is what it shows instead of limits.
 */
function useLocalRun(channel: string): { tokens: number; tps?: number } | undefined {
  return useApp(
    (st) => {
      const ws = channel.startsWith('ws:') ? st.projects.flatMap((p) => p.workspaces).find((w) => w.id === channel.slice(3)) : undefined;
      if (ws?.agent?.runtime !== LOCAL_RUNTIME) return undefined;
      const u = ws.usage;
      return { tokens: tokensOf(u), ...(u?.local?.tps ? { tps: u.local.tps } : {}) };
    },
    (a, b) => a?.tokens === b?.tokens && a?.tps === b?.tps,
  );
}

/** This conversation's prompt-cache hit rate (fresh, cache read, cache write added up for the session). */
function useCacheHit(channel: string): ReturnType<typeof cacheHitOf> {
  return useApp(
    (st) => {
      const id = channel.startsWith('ws:') ? channel.slice(3) : '';
      return id ? cacheHitOf(findWorkspace(st.projects, id)?.usage) : undefined;
    },
    (a, b) => a?.pct === b?.pct && a?.detail === b?.detail,
  );
}

/** Open on hover (after a beat), stay open while the pointer is over it; a click pins it. */
function useHoverOpen(): { open: boolean; setOpen: (v: boolean) => void; hover: { onPointerEnter: () => void; onPointerLeave: () => void } } {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const later = (v: boolean, ms: number): void => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(v), ms);
  };
  return {
    open,
    setOpen: (v) => {
      clearTimeout(timer.current);
      setOpen(v);
    },
    hover: { onPointerEnter: () => later(true, open ? 0 : OPEN_DELAY_MS), onPointerLeave: () => later(false, CLOSE_DELAY_MS) },
  };
}

/**
 * How full this conversation's context is: a small ring and the percentage beside the send
 * button, neutral until 70%, amber, then red at 90%. Hover for the details and Compact now.
 */
export function ContextMeter({ channel }: { channel: string }) {
  const model = useMeter(channel);
  const local = useLocalRun(channel);
  const cache = useCacheHit(channel);
  const { open, setOpen, hover } = useHoverOpen();
  if (!model) return null;
  const label = model.compacting ? 'Compacting…' : `${model.pct}%`;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={cx(s.meter, model.compacting ? s.spinning : model.tone === 'full' ? s.full : model.tone === 'warn' && s.warn)}
          aria-label={model.compacting ? 'Context: compacting' : cache ? `Context ${model.pct}% used, ${cache.label}` : `Context ${model.pct}% used`}
          data-context-meter={model.compacting ? 'compacting' : model.tone}
          {...hover}
        >
          <Ring pct={model.pct} spinning={model.compacting} />
          {label}
          {cache && !model.compacting ? (
            <span className={s.cache} data-cache-hit="" title={cache.detail}>{`· ${cache.label}`}</span>
          ) : null}
          {local?.tps && !model.compacting ? <span className={s.speed} data-local-speed="">{`· ${local.tps} tok/s`}</span> : null}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={s.popover} data-tone={model.tone} side="top" align="end" sideOffset={8} collisionPadding={12} aria-label="Context window" {...hover} onOpenAutoFocus={(e) => e.preventDefault()}>
          <MeterDetails channel={channel} model={model} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The popover: the numbers, where they come from, the model's window, compactions, Compact now. */
function MeterDetails({ channel, model }: { channel: string; model: MeterModel }) {
  const api = useApi();
  const { client } = useBeluga();
  const facts = useApp(
    (st) => contextFacts(st, channel),
    (a, b) => a.runtime === b.runtime && a.modelLabel === b.modelLabel && a.window === b.window && a.autoCompact === b.autoCompact && a.autoCompactMark === b.autoCompactMark && a.threshold === b.threshold,
  );
  // A workspace someone shared with you: their agent, so only they can compact it.
  const theirs = useApp((st) => st.view.kind === 'shared');
  const local = useLocalRun(channel);
  const cache = useCacheHit(channel);
  const info = model.info;
  const rows = info ? breakdownRows(info) : [];
  const compact = (): void => {
    api.session.compact(channel).then(
      () => (model.busy ? toast(client, 'Your agent compacts this conversation when it finishes what it’s doing', 'info') : undefined),
      (err: unknown) => toast(client, `Couldn’t compact: ${err instanceof Error ? err.message : String(err)}`, 'error'),
    );
  };
  return (
    <>
      <div className={s.head}>
        <span className={s.title}>Context window</span>
        <span className={cx(s.pct, model.tone === 'full' ? s.full : model.tone === 'warn' && s.warn)}>{model.compacting ? '…' : `${model.pct}%`}</span>
      </div>
      {info ? (
        <>
          <div className={s.bar} role="img" aria-label={usageLine(info)}>
            {rows.length ? rows.map((r) => <span key={r.key} className={s[`seg_${r.key}`]} style={{ width: `${r.share * 100}%` }} />) : <span className={s.seg_used} style={{ width: `${model.pct}%` }} />}
            {facts.autoCompactMark ? <i className={s.mark} style={{ left: `${facts.threshold}%` }} title={facts.autoCompactTitle ?? facts.autoCompact} /> : null}
          </div>
          <div className={s.sub} data-context-usage="">
            {usageLine(info)}
            {info.window > info.used ? ` · ${formatTokenCount(info.window - info.used)} left` : ''}
          </div>
          {rows.length ? (
            <dl className={s.rows}>
              {rows.map((r) => (
                <div key={r.key} style={{ display: 'contents' }}>
                  <dt>
                    <span className={cx(s.swatch, s[`seg_${r.key}`])} />
                    {r.label}
                  </dt>
                  <dd>{formatTokenCount(r.tokens)}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </>
      ) : null}
      <dl className={cx(s.rows, s.facts)}>
        <dt>Model window</dt>
        <dd>
          {facts.window ? formatTokenCount(facts.window) : 'Not reported yet'}
          {` · ${facts.modelLabel}`}
        </dd>
        {cache ? (
          <>
            <dt>Cache</dt>
            <dd title={cache.detail} data-cache-hit="">{`${cache.pct}%`}</dd>
          </>
        ) : null}
        {local ? (
          <>
            <dt>This conversation</dt>
            <dd data-local-usage="">{`${formatTokenCount(local.tokens)} tokens · ${speedWords(local.tps)}`}</dd>
          </>
        ) : null}
        <dt>Last compacted</dt>
        <dd>{model.last ? `${whenText(model.last.ts)} · ${formatTokenCount(model.last.compact.pre ?? 0)} → ${formatTokenCount(model.last.compact.post ?? 0)}` : 'Not yet'}</dd>
        <dt>Auto-compact</dt>
        <dd title={facts.autoCompactTitle}>{facts.autoCompact}</dd>
      </dl>
      {theirs ? (
        <div className={s.actions}>
          <span className={s.hint}>This is the owner’s agent: only they can compact it.</span>
        </div>
      ) : (
        <div className={s.actions}>
          <span className={s.hint}>Your agent keeps decisions, open tasks and file paths. The chat stays here.</span>
          <button type="button" className={s.compact} disabled={model.compacting} onClick={compact}>
            {model.compacting ? 'Compacting…' : model.busy ? 'Compact After Turn' : 'Compact Now'}
          </button>
        </div>
      )}
    </>
  );
}

/** The toolbar's quiet note once a conversation is getting full ("78% context"). */
export function ContextNote({ channel, className }: { channel: string; className?: string }) {
  const model = useMeter(channel);
  if (!model || (!model.compacting && model.tone === 'normal')) return null;
  return (
    <span className={cx(className, s.note, model.compacting ? undefined : model.tone === 'full' ? s.full : s.warn)} title={model.info ? usageLine(model.info) : undefined}>
      {model.compacting ? 'Compacting context…' : `${model.pct}% context`}
    </span>
  );
}
