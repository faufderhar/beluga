import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { isoLocal } from '../chat/schedule-model.js';
import type { BelugaTrigger, GitHubTrigger, OnceTrigger, Sentinel, SentryTrigger, StripeTrigger, Trigger, UptimeTrigger, WebhookAddress, WebhookTrigger } from '@beluga/core/sentinel/model.js';
import { TextInput } from '../components/FormSheet.js';
import { Icon } from '../components/Icon.js';
import { Select } from '../components/Select.js';
import { Button, Tip, cx } from '../components/ui.js';
import { toast, useApi, useApp, useBeluga } from '../lib/beluga.js';
import { copyText } from '../lib/copy.js';
import { openSheet } from '../lib/sheets.js';
import { type EventCard, GITHUB_MINUTES, SIGNATURES, UPTIME_MINUTES, WEBHOOK_MOVES, eventCards, eventSentence, looksLikeUrl, troubleOf } from './sentinel-model.js';
import { useDraft } from './use-draft.js';
import s from './sentinel.module.css';

/**
 * The When card for events (docs/sentinel.md §3): the kind's events as cards (a radio group, the
 * arrows move), that kind's few fields, one sentence of what will happen, and what's in the way
 * (no gh, no Stripe key, no token, the tunnel) as a soft line with what to do.
 */

type Save = (patch: { trigger: Trigger }) => void;

export function EventControls({ item, save }: { item: Sentinel; save: Save }) {
  const t = item.trigger;
  const trouble = useApp((st) => troubleOf(st.sentinel, item));
  const project = useApp((st) => st.projects.find((p) => p.id === item.projectId));
  const repo = useRepo(t.kind === 'github' ? item.projectId : undefined);
  const set = (next: Trigger): void => save({ trigger: next });
  const cards = eventCards(t.kind);
  const sentence = eventSentence(t, { ...(project ? { project: project.name } : {}), ...(repo ? { repo } : {}) });
  return (
    <>
      {cards && 'what' in t ? <EventCards cards={cards} value={t.what} label="What starts it" onChange={(what) => set({ ...t, what } as Trigger)} /> : null}
      {t.kind === 'beluga' ? <BelugaFields t={t} set={set} /> : null}
      {t.kind === 'github' ? <GitHubFields t={t} set={set} repo={repo} hasProject={Boolean(item.projectId)} /> : null}
      {t.kind === 'stripe' ? <StripeFields t={t} project={project?.name} /> : null}
      {t.kind === 'uptime' ? <UptimeFields t={t} set={set} /> : null}
      {t.kind === 'sentry' ? <SentryFields t={t} set={set} /> : null}
      {t.kind === 'webhook' ? <WebhookFields t={t} item={item} set={set} /> : null}
      {sentence ? <p className={s.eventSentence}>{sentence}</p> : null}
      {trouble ? (
        <p className={s.trouble} role="status" data-testid="sentinel-trouble">
          <Icon name="alert" size={12} />
          <span>{trouble}</span>
        </p>
      ) : null}
    </>
  );
}

/** A once trigger's moment (BLG-400): a date and time on the Mac's clock, kept with its offset. */
export function OnceControls({ t, set }: { t: OnceTrigger; set: (next: OnceTrigger) => void }) {
  return (
    <div className={s.controlRow}>
      <span className={s.controlLabel}>At</span>
      <input
        type="datetime-local"
        className={s.time}
        aria-label="On what day and at what time"
        value={localInput(t.at)}
        onChange={(e) => {
          const at = new Date(e.target.value).getTime();
          if (!Number.isNaN(at)) set({ ...t, at: isoLocal(at) });
        }}
      />
    </div>
  );
}

/** An ISO moment as a datetime-local input's value ("2026-11-12T19:30"), on the Mac's clock. */
const localInput = (iso: string): string => {
  const ts = new Date(iso).getTime();
  return Number.isNaN(ts) ? '' : isoLocal(ts).slice(0, 16);
};

/** A project's GitHub repository ("acme/bob-api"), read from its remote (no network). */
function useRepo(projectId: string | undefined): string | undefined {
  const api = useApi();
  const [repo, setRepo] = useState<string>();
  useEffect(() => {
    setRepo(undefined);
    if (!projectId) return;
    let alive = true;
    api.git.githubRepo(projectId).then(
      (r) => alive && setRepo(r ? `${r.owner}/${r.repo}` : undefined),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [projectId]);
  return repo;
}

/** The plans' AutonomyCards pattern: cards you can read without hovering. */
function EventCards<W extends string>({ cards, value, label, onChange }: { cards: ReadonlyArray<EventCard<W>>; value: W; label: string; onChange: (v: W) => void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const at = Math.max(0, cards.findIndex((c) => c.value === value));
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (at + step + cards.length) % cards.length;
    onChange(cards[next]!.value);
    refs.current[next]?.focus();
  };
  return (
    <div className={s.eventCards} role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {cards.map((c, i) => {
        const on = c.value === value;
        return (
          <button
            key={c.value}
            ref={(el) => void (refs.current[i] = el)}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className={cx(s.eventCard, on && s.eventCardOn)}
            onClick={() => onChange(c.value)}
          >
            <span className={s.eventIcon} aria-hidden="true">
              <Icon name={c.icon} size={14} />
            </span>
            <span className={s.eventName}>{c.label}</span>
            <span className={s.eventLine}>{c.line}</span>
          </button>
        );
      })}
    </div>
  );
}

function BelugaFields({ t, set }: { t: BelugaTrigger; set: (t: Trigger) => void }) {
  const projects = useApp((st) => st.projects).filter((p) => p.root && !p.error);
  const ANY = '*';
  return (
    <div className={s.controlRow}>
      <span className={s.controlLabel}>In</span>
      <Select
        label="In which project"
        size="small"
        value={t.projectId ?? ANY}
        options={[{ value: ANY, label: 'Any project' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
        onChange={(v) => {
          const { projectId: _p, ...rest } = t;
          set(v === ANY ? rest : { ...rest, projectId: v });
        }}
      />
    </div>
  );
}

function GitHubFields({ t, set, repo, hasProject }: { t: GitHubTrigger; set: (t: Trigger) => void; repo: string | undefined; hasProject: boolean }) {
  const label = useDraft(t.label ?? '', (v) => {
    const next = v.trim();
    if (next === (t.label ?? '')) return;
    const { label: _l, ...rest } = t;
    set(next ? { ...rest, label: next } : rest);
  });
  const minutes = t.minutes ?? 2;
  const choices = GITHUB_MINUTES.includes(minutes) ? GITHUB_MINUTES : [...GITHUB_MINUTES, minutes].sort((a, b) => a - b);
  return (
    <>
      <div className={s.controlRow}>
        <span className={s.controlLabel}>Repository</span>
        <span className={cx(s.staticValue, repo && s.mono)}>{repo ?? (hasProject ? 'The project’s GitHub repository' : 'Pick a project on the right')}</span>
      </div>
      {t.what === 'issue-labelled' ? (
        <div className={s.controlRow}>
          <span className={s.controlLabel}>Label</span>
          <TextInput className={s.shortField} value={label.text} onChange={label.change} onBlur={label.flush} placeholder="Any label" aria-label="Label" />
        </div>
      ) : null}
      <div className={s.controlRow}>
        <span className={s.controlLabel}>Look</span>
        <Select label="How often GitHub is asked" size="small" value={String(minutes)} options={choices.map((m) => ({ value: String(m), label: m === 1 ? 'Every minute' : `Every ${m} minutes` }))} onChange={(v) => set({ ...t, minutes: Number(v) })} />
      </div>
    </>
  );
}

function StripeFields({ project }: { t: StripeTrigger; project: string | undefined }) {
  return (
    <div className={s.controlRow}>
      <span className={s.controlLabel}>Account</span>
      <span className={s.staticValue}>{project ? `${project}’s Stripe, connected in Earnings` : 'Pick a project on the right'}</span>
    </div>
  );
}

function UptimeFields({ t, set }: { t: UptimeTrigger; set: (t: Trigger) => void }) {
  const [bad, setBad] = useState(false);
  const url = useDraft(t.url, (v) => {
    const next = v.trim();
    setBad(!looksLikeUrl(next));
    if (next !== t.url && looksLikeUrl(next)) set({ ...t, url: next });
  });
  const expect = t.expect ?? 200;
  const statuses = [200, 204, 301, 302, 401, 403].includes(expect) ? [200, 204, 301, 302, 401, 403] : [200, 204, 301, 302, 401, 403, expect];
  return (
    <>
      <div className={s.field}>
        <span className={s.fieldLabel}>Address</span>
        <div className={s.urlRow}>
          <TextInput className={s.grow} value={url.text} onChange={url.change} onBlur={url.flush} mono invalid={bad} placeholder="https://example.com" aria-label="Address to check" />
        </div>
        {bad ? <span className={s.help}>A whole address, like https://example.com/health</span> : null}
      </div>
      <div className={s.controlRow}>
        <span className={s.controlLabel}>Check</span>
        <Select label="How often it's checked" size="small" value={String(t.minutes)} options={UPTIME_MINUTES.map((m) => ({ value: String(m), label: m === 1 ? 'Every minute' : `Every ${m} minutes` }))} onChange={(v) => set({ ...t, minutes: Number(v) as UptimeTrigger['minutes'] })} />
      </div>
      <div className={s.controlRow}>
        <span className={s.controlLabel}>Expect</span>
        <Select
          label="The status it should answer"
          size="small"
          value={String(expect)}
          options={statuses.map((n) => ({ value: String(n), label: String(n), description: n === 200 ? 'OK (the usual)' : n === 204 ? 'No content (health checks)' : n === 301 || n === 302 ? 'It answers with a redirect' : 'Behind a sign-in' }))}
          onChange={(v) => {
            const n = Number(v);
            const { expect: _e, ...rest } = t;
            set(n === 200 ? rest : { ...rest, expect: n });
          }}
        />
      </div>
    </>
  );
}

function SentryFields({ t, set }: { t: SentryTrigger; set: (t: Trigger) => void }) {
  const org = useDraft(t.org, (v) => v.trim() !== t.org && set({ ...t, org: v.trim() }));
  const project = useDraft(t.project, (v) => v.trim() !== t.project && set({ ...t, project: v.trim() }));
  return (
    <div className={s.controlRow}>
      <span className={s.controlLabel}>Project</span>
      <span className={s.pair}>
        <TextInput className={s.shortField} value={org.text} onChange={org.change} onBlur={org.flush} mono placeholder="organization" aria-label="Sentry organization" />
        <span className={s.slash}>/</span>
        <TextInput className={s.shortField} value={project.text} onChange={project.change} onBlur={project.flush} mono placeholder="project" aria-label="Sentry project" />
      </span>
    </div>
  );
}

function WebhookFields({ t, item, set }: { t: WebhookTrigger; item: Sentinel; set: (t: Trigger) => void }) {
  const api = useApi();
  const { client } = useBeluga();
  const tunnel = useApp((st) => st.sentinel.webhook);
  const [address, setAddress] = useState<WebhookAddress>();
  const [turn, setTurn] = useState(0);
  useEffect(() => {
    let alive = true;
    api.sentinel.webhookUrl(item.id).then(
      (a) => alive && setAddress(a),
      (err: unknown) => alive && setAddress({ why: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      alive = false;
    };
  }, [item.id, item.paused, tunnel?.url, tunnel?.ready, turn]);
  const copy = (text: string, what: string): void => void copyText(text).then(() => toast(client, `Copied ${what}`, 'success'));
  const rotate = (): void =>
    openSheet({
      kind: 'confirm',
      title: `A new secret for “${item.name}”?`,
      message: 'Its URL and its signing secret change, and the old ones stop working at once: whatever posts to it (GitHub, Stripe) needs the new URL, and GitHub the new secret.',
      confirm: 'Rotate Secret',
      destructive: true,
      run: () =>
        void api.sentinel.rotateSecret(item.id).then(
          (a) => {
            setAddress(a);
            setTurn((n) => n + 1);
            toast(client, 'A new secret: copy the new URL', 'success');
          },
          (err: unknown) => toast(client, err instanceof Error ? err.message : String(err), 'error'),
        ),
    });
  // GitHub's form asks for the signing secret, never the one in the URL.
  const secret = address?.signingSecret;
  return (
    <>
      <div className={s.field}>
        <span className={s.fieldLabel}>URL</span>
        <div className={s.urlRow}>
          <input className={cx(s.copyField, 'selectable')} readOnly value={address?.url ?? ''} placeholder={address?.why ?? 'Looking…'} aria-label="Webhook URL" data-testid="webhook-url" onFocus={(e) => e.currentTarget.select()} />
          <Button size="small" icon="copy" disabled={!address?.url} onClick={() => address?.url && copy(address.url, 'the webhook URL')}>
            Copy
          </Button>
        </div>
        <span className={s.hintLine}>{address?.url && address.why ? `${address.why}. ` : ''}{WEBHOOK_MOVES}</span>
      </div>
      <div className={s.controlRow}>
        <span className={s.controlLabel}>Signature</span>
        <Select
          label="Signature"
          size="small"
          value={t.signature ?? 'none'}
          options={SIGNATURES}
          onChange={(v) => {
            const { signature: _s, ...rest } = t;
            set(v === 'none' ? rest : { ...rest, signature: v });
          }}
        />
        {t.signature === 'github' && secret ? (
          <Tip label="GitHub’s webhook form asks for it as its Secret">
            <Button size="small" variant="quiet" icon="copy" onClick={() => copy(secret, 'the secret')}>
              Copy Secret
            </Button>
          </Tip>
        ) : null}
        <span className={s.grow} />
        <Button size="small" variant="quiet" icon="refresh" onClick={rotate}>
          Rotate Secret…
        </Button>
      </div>
    </>
  );
}
