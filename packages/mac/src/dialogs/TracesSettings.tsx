import { type CSSProperties, useCallback, useEffect, useState } from 'react';
import { ago } from '@beluga/shared/render/format.js';
import { TRACE_PROVIDERS, type TraceDestinationView, type TraceField, type TraceProvider, type TraceProviderId, type TraceState, type TraceTestResult } from '@beluga/shared/trace-destinations.js';
import { Icon } from '../components/Icon.js';
import { Button, Dot, Segmented, cx } from '../components/ui.js';
import { useApi } from '../lib/beluga.js';
import { useClock } from '../lib/window-active.js';
import { settingAnchor } from '../lib/settings-search.js';
import { openExternal } from '../lib/system.js';
import { Group, Select, Switch } from './settings-controls.js';
import { TRACE_LOGOS } from './trace-logos.js';
import s from './settings.module.css';
import t from './traces.module.css';

/**
 * Settings › Traces (BLG-1014): your own observability tools, which get your agents' turns as
 * OpenTelemetry spans (src/telemetry/destinations.ts). Ratel first. Each tool asks only for what it
 * needs; its keys are kept on this Mac with your other secrets and never shown again, only "saved".
 * Apart from usage statistics (Settings › General), which this never changes.
 */

/** The group of tools you connected (only there once you have one, so search finds the tools themselves). */
const CONNECTED = 'Connected';

const errorText = (err: unknown): string => (err instanceof Error ? err.message.replace(/^Bad arguments for [\w.]+: /, '') : String(err));

/** A tool's own mark, in its colours (dark mode: a lighter one where the brand's wouldn't show). */
export function TraceLogo({ id, size = 22 }: { readonly id: TraceProviderId; readonly size?: number }) {
  const logo = TRACE_LOGOS[id];
  // A wide mark (Ratel's badger) gets the box's whole width: in a square it would look small beside the others.
  const [, , w = 1, h = 1] = logo.viewBox.split(' ').map(Number);
  const wide = w / h > 1.4;
  return (
    <span className={t.logo} style={{ width: Math.round(size * 1.3), height: size }} aria-hidden="true">
      <svg viewBox={logo.viewBox} width={wide ? Math.round(size * 1.3) : size} height={size} fillRule={logo.evenOdd ? 'evenodd' : undefined}>
        {logo.paths.map((p, i) => (
          <path key={i} d={p.d} style={{ '--fill': p.fill, ...(p.dark ? { '--fill-dark': p.dark } : {}) } as CSSProperties} />
        ))}
      </svg>
    </span>
  );
}

const STATE: Readonly<Record<TraceState, { readonly tone: 'ok' | 'warn' | 'error' | 'muted'; readonly words: string }>> = {
  off: { tone: 'muted', words: 'Off' },
  waiting: { tone: 'ok', words: 'Connected. Traces go after your next turn.' },
  sending: { tone: 'ok', words: 'Sending' },
  refused: { tone: 'error', words: 'Key refused' },
  failing: { tone: 'warn', words: 'Not going through' },
  invalid: { tone: 'error', words: 'Missing something' },
};

function stateWords(v: TraceDestinationView): string {
  if (v.state === 'sending' && v.lastSentAt) return `Sending. Last batch ${ago(v.lastSentAt)}.`;
  return v.problem ?? STATE[v.state].words;
}

interface Draft {
  readonly id: TraceProviderId;
  readonly fields: Readonly<Record<string, string>>;
  readonly text: boolean;
}

const draftFor = (p: TraceProvider, v: TraceDestinationView | undefined): Draft => ({
  id: p.id,
  fields: Object.fromEntries(p.fields.map((f) => [f.key, v?.fields[f.key] ?? (f.kind === 'choice' ? (f.initial ?? '') : '')])),
  text: v?.text ?? true,
});

/** A field is shown unless it's an address another choice doesn't use (Phoenix's, your own Langfuse's). */
function shown(p: TraceProvider, f: TraceField, d: Draft): boolean {
  if (f.key !== 'url' || p.id === 'otlp') return true;
  return d.fields.region === 'phoenix' || d.fields.region === 'self';
}

export function TracesSettings() {
  const api = useApi();
  const [list, setList] = useState<readonly TraceDestinationView[] | undefined>(undefined);
  const [open, setOpen] = useState<Draft | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [test, setTest] = useState<TraceTestResult | undefined>(undefined);

  const load = useCallback(() => void api.traces.list().then(setList, () => setList([])), [api]);
  // How each is doing changes as batches go: looked at again every 10 s while you look at Settings.
  const tick = useClock(true, 10_000);
  useEffect(load, [load, tick]);

  const run = async (work: () => Promise<readonly TraceDestinationView[]>, close = true): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      setList(await work());
      if (close) setOpen(undefined);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (p: TraceProvider): void => {
    setError('');
    setTest(undefined);
    setOpen(open?.id === p.id ? undefined : draftFor(p, list?.find((v) => v.id === p.id)));
  };

  const sendTest = async (d: Draft): Promise<void> => {
    setBusy(true);
    setTest(undefined);
    try {
      setTest(await api.traces.test(d.id, d.fields));
    } catch (err) {
      setTest({ ok: false, words: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const connected = TRACE_PROVIDERS.filter((p) => list?.some((v) => v.id === p.id));
  const others = TRACE_PROVIDERS.filter((p) => !list?.some((v) => v.id === p.id));

  const form = (p: TraceProvider) => {
    const d = open;
    if (!d || d.id !== p.id) return null;
    const view = list?.find((v) => v.id === p.id);
    const set = (key: string, value: string): void => setOpen({ ...d, fields: { ...d.fields, [key]: value } });
    return (
      <form
        className={s.endpointForm}
        onSubmit={(ev) => {
          ev.preventDefault();
          void run(() => api.traces.save({ id: p.id, fields: d.fields, text: d.text }));
        }}
      >
        {p.fields.filter((f) => shown(p, f, d)).map((f) => (
          <div key={f.key} className={cx(s.endpointField, t.field)}>
            <span>{f.label}</span>
            {f.kind === 'choice' && f.choices ? (
              f.choices.length <= 4 ? (
                <Segmented size="small" label={f.label} value={d.fields[f.key] ?? f.initial ?? ''} options={f.choices} onChange={(v) => set(f.key, v)} />
              ) : (
                <Select size="small" label={f.label} value={d.fields[f.key] ?? f.initial ?? ''} options={f.choices} onChange={(v) => set(f.key, v)} />
              )
            ) : (
              <input
                className={s.text}
                aria-label={f.label}
                type={f.kind === 'secret' ? 'password' : 'text'}
                autoComplete="off"
                spellCheck={false}
                value={d.fields[f.key] ?? ''}
                placeholder={f.kind === 'secret' && view?.saved.includes(f.key) ? 'Saved (type to replace)' : (f.placeholder ?? (f.optional ? 'Optional' : ''))}
                onChange={(ev) => set(f.key, ev.target.value)}
              />
            )}
          </div>
        ))}
        <div className={t.where}>
          {p.where}.{' '}
          <button type="button" className={t.link} onClick={() => void openExternal(p.docs)}>
            Their guide
          </button>
        </div>
        <label className={t.textRow}>
          <Switch label="Send what you and your agent wrote" on={d.text} onChange={(v) => setOpen({ ...d, text: v })} />
          <span>
            <span className={t.textLabel}>Send what you and your agent wrote</span>
            <span className={t.textDetail}>Your prompts, its answers, and what each tool was given and gave back, on runs that are yours. Keys and secrets are always taken out first.</span>
          </span>
        </label>
        {test ? <div className={cx(t.test, test.ok ? t.testOk : t.testBad)}>{test.words}</div> : null}
        {error ? <div className={s.endpointError}>{error}</div> : null}
        <div className={s.endpointBar}>
          {view ? (
            <Button size="small" variant="quiet" tone="error" disabled={busy} onClick={() => void run(() => api.traces.remove(p.id))}>
              Disconnect
            </Button>
          ) : null}
          <span className={t.spacer} />
          <Button size="small" variant="quiet" disabled={busy} onClick={() => void sendTest(d)}>
            Send Test
          </Button>
          <Button size="small" variant="quiet" onClick={() => setOpen(undefined)}>
            Cancel
          </Button>
          <Button size="small" variant="primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : view ? 'Save' : 'Connect'}
          </Button>
        </div>
      </form>
    );
  };

  const row = (p: TraceProvider) => {
    const view = list?.find((v) => v.id === p.id);
    const isOpen = open?.id === p.id;
    return (
      <div key={p.id} className={t.item}>
        <div className={cx(s.row, t.row)} data-setting={settingAnchor(p.name)}>
          <TraceLogo id={p.id} />
          <div className={s.rowText}>
            <div className={s.rowLabel}>
              {p.name}
              {p.by ? <span className={t.by}> by {p.by}</span> : null}
              {p.site ? <SiteLink name={p.name} url={p.site} /> : null}
            </div>
            {view ? (
              <div className={s.rowDetail}>
                <span className={t.state}>
                  <Dot tone={STATE[view.state].tone} />
                  {stateWords(view)}
                </span>
              </div>
            ) : null}
          </div>
          <div className={s.control}>
            {view ? <Switch label={`Send to ${p.name}`} on={view.on} onChange={(on) => void run(() => api.traces.save({ id: p.id, on }), false)} /> : null}
            <Button size="small" variant="plain" className={t.action} disabled={busy && !isOpen} onClick={() => toggle(p)}>
              {isOpen ? 'Close' : view ? 'Edit…' : 'Connect…'}
            </Button>
          </div>
        </div>
        {isOpen ? form(p) : null}
      </div>
    );
  };

  return (
    <>
      <p className={t.lead}>
        Send your agents’ traces to your own tools as OpenTelemetry: every turn, model call, tool call, token and cost, from Claude, Codex, OpenCode and local models alike. It’s yours, apart from
        Beluga’s usage statistics.
      </p>
      {list === undefined ? (
        <Group>
          <div className={s.note}>Looking…</div>
        </Group>
      ) : (
        <>
          {connected.length ? <Group title={CONNECTED}>{connected.map(row)}</Group> : null}
          {others.length ? <Group title={connected.length ? 'Add another' : 'Connect a tool'}>{others.map(row)}</Group> : null}
        </>
      )}
    </>
  );
}

/** A tool's website, by its domain: what it is, before you connect it. */
function SiteLink({ name, url }: { readonly name: string; readonly url: string }) {
  return (
    <button type="button" className={t.site} aria-label={`${name} website`} title={url} translate="no" onClick={() => void openExternal(url)}>
      {new URL(url).hostname.replace(/^www\./, '')}
      <Icon name="external" size={11} />
    </button>
  );
}
