import { useCallback, useEffect, useState } from 'react';
import type { BelugaClient } from '@beluga/ipc/client.js';
import { Icon } from '../components/Icon.js';
import { Button } from '../components/ui.js';
import { webServed } from '../lib/boot.js';
import { copyText } from '../lib/copy.js';
import { useClock } from '../lib/window-active.js';
import { useBeluga } from '../lib/beluga.js';
import { QrCode } from '../network/QrCode.js';
import { ago } from '../phone/phone-model.js';
import p from '../phone/phone.module.css';
import { Group, Row, Select, Switch } from './settings-controls.js';
import s from './settings.module.css';

type WebApi = BelugaClient['api']['web'];
type Status = Awaited<ReturnType<WebApi['sessions.list']>>;
type Link = Awaited<ReturnType<WebApi['link']>>;
type Ways = Awaited<ReturnType<WebApi['ways']>>;
/** How browsers reach Beluga: this computer (and an SSH tunnel to it), the tailnet, or a public link. */
type Way = 'local' | 'tailscale' | 'public';

/** How often the list refreshes while it shows (last seen moves; a browser may join; a public address may move). */
const REFRESH_MS = 10_000;
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const wayOf = (st: Status | undefined): Way => (st?.public ? 'public' : st?.tailscale ? 'tailscale' : 'local');

/** What each way means, under the choice. */
function wayDetail(way: Way, st: Status | undefined): string {
  if (way === 'tailscale') return st?.tailscale?.login ? `Your own Tailscale login (${st.tailscale.login}) gets in without a link, on any of your devices. Others on your tailnet need one.` : 'Only your tailnet reaches it (Tailscale Serve, never Funnel). Each browser needs a link.';
  if (way === 'public') return 'Anyone with a join link gets in, from anywhere, through a Cloudflare tunnel. The address alone shows only a page that asks for a link.';
  return 'This computer’s browsers, or another computer through SSH: beluga connect you@this-computer. Nothing is opened to the network.';
}

/**
 * Settings › Advanced › Web access (BLG-650, BLG-659): your whole Beluga in any browser, off until
 * you turn it on. One switch, then how browsers reach it: this computer only, your tailnet
 * (offered when Tailscale is installed and logged in) or a public link; a join link as a QR with
 * Copy; the browsers let in, each with Remove. A browser itself only sees the list: who gets in is
 * decided from the Mac app or `beluga web` (BLG-653).
 */
export function WebAccessSettings() {
  const { client } = useBeluga();
  const [status, setStatus] = useState<Status>();
  const [ways, setWays] = useState<Ways>({});
  const [link, setLink] = useState<Link>();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const manage = !webServed();

  const refresh = useCallback(() => {
    client.api.web['sessions.list']().then(
      (st) => {
        setStatus(st);
        setNow(Date.now());
      },
      (err: unknown) => setError(errorText(err)),
    );
  }, [client]);

  // Every REFRESH_MS while you're looking (the clock rests while the window is hidden), and at once when you look back.
  const tick = useClock(true, REFRESH_MS);
  useEffect(() => refresh(), [refresh, tick]);
  useEffect(() => {
    if (manage) void client.api.web.ways().then(setWays, () => undefined);
  }, [client, manage]);

  const run = async (doing: string, work: () => Promise<unknown>): Promise<void> => {
    setBusy(doing);
    setError(undefined);
    try {
      await work();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(undefined);
      refresh();
    }
  };

  const show = (next: Link | undefined): void => {
    setCopied(false);
    setLink(next);
  };

  const on = status?.on ?? false;
  const way = wayOf(status);

  const turn = (want: boolean): Promise<void> =>
    want
      ? run('Opening…', async () => show(await client.api.web.link()))
      : run('Closing…', async () => {
          show(undefined);
          await client.api.web.stop();
        });

  const choose = (next: Way): Promise<void> =>
    run(next === 'public' ? 'Opening a public link (this can take a minute)…' : next === 'tailscale' ? 'Serving on your tailnet…' : 'Closing the other ways in…', async () => {
      show(undefined);
      if (way === 'tailscale' && next !== 'tailscale') await client.api.web.tailscale(false);
      if (way === 'public' && next !== 'public') await client.api.web.public(false);
      if (next === 'tailscale') show((await client.api.web.tailscale(true))?.link);
      else if (next === 'public') show((await client.api.web.public(true))?.link);
      else show(await client.api.web.link());
    });

  const newLink = (): Promise<void> => run('Making a link…', async () => show(await client.api.web.link(way === 'local' ? undefined : { via: way })));

  const live = link && link.expiresAt > now ? link : undefined;
  const sessions = status?.sessions ?? [];
  const address = way === 'tailscale' ? status?.tailscale?.url : way === 'public' ? status?.public?.url : status?.url;
  const reopening = way === 'public' && status?.public && status.public.state !== 'on';
  const options = [
    { value: 'local' as const, label: 'This computer only' },
    ...(ways.tailscale || way === 'tailscale' ? [{ value: 'tailscale' as const, label: 'Tailscale' }] : []),
    { value: 'public' as const, label: 'Public link' },
  ];
  const intro = 'The whole app in any browser: on this computer, over SSH, on your tailnet or through a public link.';
  return (
    <Group title="Web access">
      <Row label="Open Beluga in a browser" detail={manage ? `${intro} Each browser is let in once by its own link, and you can remove it any time.` : `${intro} Browsers are let in and removed from the Beluga app, or with beluga web on the computer Beluga runs on.`}>
        {manage ? <Switch on={on} onChange={(v) => void turn(v)} label="Open Beluga in a browser" /> : <span />}
      </Row>
      {manage && on ? (
        <>
          <Row label="Reached from" detail={wayDetail(way, status)}>
            <Select label="How browsers reach Beluga" value={way} options={options} disabled={!!busy} onChange={(v) => void choose(v)} />
          </Row>
          {address ? (
            <Row label="Address" detail={way === 'local' ? 'Only this computer reaches it.' : 'Without a link it shows only a page that asks for one.'}>
              <code className={s.webLink} title={address}>
                {address}
              </code>
            </Row>
          ) : reopening ? (
            <Row label="Address" detail="Cloudflare dropped the last one: a new address is on its way.">
              <span />
            </Row>
          ) : null}
          <Row label="Let a browser in" detail="A link works once, for 10 minutes. Anyone with it can get in: send it only to yourself.">
            <Button variant={sessions.length ? 'plain' : 'primary'} icon="link" disabled={!!busy} onClick={() => void newLink()}>
              New Link
            </Button>
          </Row>
        </>
      ) : null}
      {busy ? <div className={s.webBusy}>{busy}</div> : null}
      {manage && on && live ? (
        <div className={s.webQr}>
          <QrCode text={live.url} size={132} label="Scan to open Beluga in your phone's browser" />
          <div className={s.webQrText}>
            <span>Open this link in the browser, or scan it with your phone. It works once, until {new Date(live.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.</span>
            <span className={s.pictureRow}>
              <code className={s.webLink} title={live.url}>
                {live.url}
              </code>
              <Button
                size="small"
                icon={copied ? 'check' : 'copy'}
                onClick={() =>
                  void copyText(live.url).then(
                    () => setCopied(true),
                    (err: unknown) => setError(errorText(err)),
                  )
                }
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </span>
          </div>
        </div>
      ) : null}
      {error ? <div className={p.error}>{error}</div> : null}
      <div className={p.inSettings}>
        <div className={p.devices} aria-label="Browsers let in" role="list">
          {sessions.length === 0 ? (
            <div className={p.empty}>No browsers yet.</div>
          ) : (
            sessions.map((b) => (
              <div key={b.id} className={p.device} role="listitem">
                <div className={p.deviceHead}>
                  <span className={p.deviceMark} aria-hidden="true">
                    <Icon name="globe" size={16} />
                  </span>
                  <span className={p.deviceText}>
                    <span className={p.deviceName}>{b.name}</span>
                    <span className={p.dim}>
                      Let in {ago(b.createdAt, now)} · seen {ago(b.lastSeenAt, now)}
                    </span>
                  </span>
                  {manage ? (
                    <Button size="small" variant="quiet" disabled={!!busy} aria-label={`Remove ${b.name}`} onClick={() => void run('Removing…', () => client.api.web['sessions.revoke'](b.id))}>
                      Remove
                    </Button>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </Group>
  );
}
