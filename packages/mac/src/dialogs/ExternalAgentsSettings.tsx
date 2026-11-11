import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useClock } from '../lib/window-active.js';
import { REMOTE_FULL_WARNING } from '@beluga/shared/remote-full.js';
import { Button } from '../components/ui.js';
import { useApi, useApp } from '../lib/beluga.js';
import { copyText } from '../lib/copy.js';
import { Group, Row, Select, Switch } from './settings-controls.js';
import s from './settings.module.css';

/** In a grant's projects: all your chats with no project. */
const STANDALONE_CHATS = 'chats';

type Level = 'ask' | 'trusted' | 'full';
type ActivityShown = 'all' | 'allowed' | 'asked' | 'refused';

interface Activity {
  readonly ts: number;
  readonly agent: string;
  readonly tool: string;
  readonly target: string;
  readonly decidedBy: 'rule' | 'person';
  readonly argsHash: string;
  readonly kind: Exclude<ActivityShown, 'all'>;
}

const ACTIVITY_SHOWN: ReadonlyArray<{ value: ActivityShown; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'allowed', label: 'Allowed' },
  { value: 'asked', label: 'Asked' },
  { value: 'refused', label: 'Refused' },
];
const KIND_WORDS: Readonly<Record<Activity['kind'], string>> = { allowed: 'Allowed', asked: 'Asked', refused: 'Refused' };

type RouteKind = 'tailscale' | 'public';

interface Route {
  readonly kind: RouteKind;
  readonly state: 'opening' | 'on' | 'reopening';
  readonly url?: string;
  readonly error?: string;
}

interface Status {
  readonly on: boolean;
  readonly paused?: boolean;
  readonly url?: string;
  readonly routes?: readonly Route[];
  readonly error?: string;
}

interface Agent {
  readonly id: string;
  readonly name: string;
  readonly level: string;
  readonly route: 'local' | 'remote';
  readonly lastSeen: number;
  readonly expiresAt: number;
  readonly suspendedAt?: number;
}

const LEVELS: ReadonlyArray<{ value: Level; label: string }> = [
  { value: 'ask', label: 'Ask each time' },
  { value: 'trusted', label: 'Trusted' },
  { value: 'full', label: 'Full trust' },
];
const LEVEL_WORDS: Readonly<Record<string, string>> = { blocked: 'Blocked', ask: 'Ask each time', trusted: 'Trusted', full: 'Full trust' };
const REFRESH_MS = 5000;
const ROUTE_ROWS: ReadonlyArray<{ kind: RouteKind; label: string; off: string; on: string }> = [
  { kind: 'tailscale', label: 'On your tailnet', off: 'Agents on your Tailscale network connect over https. Nobody else reaches it.', on: 'Only your tailnet reaches this address (Tailscale Serve, never Funnel).' },
  { kind: 'public', label: 'Public address', off: 'Hosted agents connect through a Cloudflare tunnel. Each one still needs a pairing code.', on: 'This address changes when the tunnel restarts. Agents must then sign in again with a new code.' },
];

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const seenWords = (at: number): string => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Settings › External agents: other agents (a Claude Code in your terminal, GrokBot, a local model)
 * reaching Beluga through its MCP server. Turn it on, hand over its URL, make a pairing code (what it
 * gives is chosen here, and the sign-in page only spends it), see who connected, and revoke them.
 */
export function ExternalAgentsSettings() {
  const api = useApi();
  const projects = useApp((st) => st.projects.filter((p) => p.root && !p.error).map((p) => p.id + '\n' + p.name).join('\0'));
  const [status, setStatus] = useState<Status | undefined>();
  const [agents, setAgents] = useState<readonly Agent[]>([]);
  const [level, setLevel] = useState<Level>('full');
  const [allProjects, setAllProjects] = useState(true);
  const [remote, setRemote] = useState(false);
  // For one code only: it goes back to off when a code is made or the choice above changes.
  const [confirmFull, setConfirmFull] = useState(false);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [dms, setDms] = useState(true);
  const [groups, setGroups] = useState(true);
  const [code, setCode] = useState<{ code: string; expiresAt: number } | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [shown, setShownState] = useState<ActivityShown>('all');
  const [activity, setActivity] = useState<readonly Activity[]>([]);
  const filter = useRef<ActivityShown>('all');
  const setShown = (next: ActivityShown): void => {
    filter.current = next;
    setShownState(next);
    look();
  };

  const look = (): void => {
    void api.external.status().then((v) => setStatus(v as Status), (e: unknown) => setError(errorText(e)));
    void api.external.agents().then((v) => setAgents(v as readonly Agent[]), () => undefined);
    void api.external.activity(filter.current === 'all' ? {} : { kind: filter.current }).then((v) => setActivity(v as readonly Activity[]), () => undefined);
  };
  // An agent signs in from its own terminal while this pane is open.
  const tick = useClock(true, REFRESH_MS);
  useEffect(look, [tick]);

  const run = (work: Promise<unknown>): void => {
    setError(undefined);
    void work.then(look, (e: unknown) => setError(errorText(e)));
  };
  const makeCode = (): void => {
    if (remote && level === 'full' && !confirmFull) return setError('Confirm the warning for this code first.');
    setError(undefined);
    setConfirmFull(false);
    void api.external.pairingCode({ level, projects: allProjects ? 'all' : [...chosen], chats: { dms, groups }, ...(remote ? { remote: true } : {}), ...(remote && level === 'full' ? { allowRemoteFull: true } : {}) }).then((v) => setCode(v as { code: string; expiresAt: number }), (e: unknown) => setError(errorText(e)));
  };
  const toggle = (id: string): void => {
    const next = new Set(chosen);
    if (!next.delete(id)) next.add(id);
    setChosen(next);
  };
  const [turning, setTurning] = useState<RouteKind | undefined>();
  const setRoute = (kind: RouteKind, on: boolean): void => {
    setError(undefined);
    setTurning(kind);
    void api.external.setRoute(kind, on).then(look, (e: unknown) => setError(errorText(e))).finally(() => setTurning(undefined));
  };
  const routeDetail = (row: (typeof ROUTE_ROWS)[number], route: Route | undefined): ReactNode => {
    if (turning === row.kind && !route?.url) return 'Opening. A fresh address can take a minute.';
    if (route?.state === 'reopening') return route.error ? `Opening a new address: ${route.error}` : 'It dropped. Opening a new address. Agents must then sign in again.';
    return route?.url ? <>{route.url}<br />{row.on}</> : row.off;
  };
  const projectRows = projects ? projects.split('\0').map((line) => line.split('\n') as [string, string]) : [];

  return (
    <>
      <Group>
        <Row label="Let other agents connect" detail={status?.error ?? (status?.on ? status.routes?.length ? 'Each agent needs a pairing code from you.' : 'Only programs on this Mac can reach it, and each one needs a pairing code from you.' : 'Off: nothing listens.')}>
          <Switch label="Let other agents connect" on={status?.on ?? false} onChange={(on) => run(api.external.setEnabled(on))} />
        </Row>
        {status?.on ? (
          <Row label="Pause all agents" detail={status.paused ? 'Paused: every agent is refused. Their grants stay.' : 'Refuses every agent and keeps their grants.'}>
            <Switch label="Pause all agents" on={status.paused ?? false} onChange={(on) => run(api.external.setPaused(on))} />
          </Row>
        ) : null}
        {status?.url ? (
          <Row label="MCP URL" detail={status.url}>
            <Button onClick={() => void copyText(status.url!)}>Copy MCP URL</Button>
          </Row>
        ) : null}
        {ROUTE_ROWS.map((row) => {
          const route = status?.routes?.find((r) => r.kind === row.kind);
          return (
            <Row key={row.kind} label={row.label} detail={routeDetail(row, route)}>
              {route?.url ? <Button onClick={() => void copyText(route.url!)}>Copy MCP URL</Button> : null}
              <Switch label={row.label} on={route !== undefined} onChange={(on) => { if (!turning) setRoute(row.kind, on); }} />
            </Row>
          );
        })}
      </Group>
      {status?.on ? (
        <Group title="Connect an agent">
          <Row label="For an agent outside this Mac" detail="It starts at Trusted. Full trust takes your explicit choice for this code.">
            <Switch
              label="For an agent outside this Mac"
              on={remote}
              onChange={(on) => {
                setRemote(on);
                setConfirmFull(false);
                if (on && level === 'full') setLevel('trusted');
              }}
            />
          </Row>
          <Row label="What it may do" detail="Chosen now. The sign-in page can't raise it. Full: what you can do on this Mac.">
            <Select<Level> label="What it may do" value={level} options={LEVELS} onChange={(next) => { setLevel(next); setConfirmFull(false); }} />
          </Row>
          {remote && level === 'full' ? (
            <Row label="Full trust for this code" detail={<span className={s.fullWarning} role="alert">{REMOTE_FULL_WARNING}</span>}>
              <Switch label="I understand. Full trust for this code." on={confirmFull} onChange={setConfirmFull} />
            </Row>
          ) : null}
          <Row label="All projects and chats" detail="Also projects you add later. Off: choose below what it reaches.">
            <Switch label="Reach all projects and chats" on={allProjects} onChange={setAllProjects} />
          </Row>
          {allProjects ? null : projectRows.map(([id, name]) => (
            <Row key={id} label={name} detail="A project it reaches">
              <Switch label={`Reach ${name}`} on={chosen.has(id)} onChange={() => toggle(id)} />
            </Row>
          ))}
          {allProjects ? null : (
            <Row label="Your chats with no project" detail="They can hold private conversations. Off: it reaches only the chats it starts.">
              <Switch label="Reach your chats with no project" on={chosen.has(STANDALONE_CHATS)} onChange={() => toggle(STANDALONE_CHATS)} />
            </Row>
          )}
          <Row label="Direct messages" detail="It reads and sends yours, with its name on each one.">
            <Switch label="Reach direct messages" on={dms} onChange={setDms} />
          </Row>
          <Row label="Groups" detail="It reads and sends in your groups, with its name on each message.">
            <Switch label="Reach groups" on={groups} onChange={setGroups} />
          </Row>
          <Row label="Pairing code" detail={code ? 'It works once, for 10 minutes. Enter it on the page your agent opens.' : 'Give your agent the MCP URL, then enter this on the page it opens.'}>
            {code ? <code data-pairing-code>{code.code}</code> : null}
            {code ? <Button onClick={() => void copyText(code.code)}>Copy</Button> : null}
            <Button onClick={makeCode}>{code ? 'Make Another' : 'Make a Code'}</Button>
          </Row>
        </Group>
      ) : null}
      {error ? <p className={s.endpointError} role="alert">{error}</p> : null}
      {agents.length ? (
        <Group title="Connected agents">
          <Row label="Stop all agents" detail="Ends their runs, queued messages and friend tasks now. Their grants stay.">
            <Button onClick={() => run(api.external.stopAll())}>Stop All</Button>
          </Row>
          {agents.map((a) => (
            <Row key={a.id} label={a.name} detail={`${a.suspendedAt === undefined ? '' : 'Suspended after repeated refusals · '}${a.route === 'remote' && a.level === 'full' ? '⚠ Full trust from outside this Mac' : `${LEVEL_WORDS[a.level] ?? a.level} · ${a.route === 'local' ? 'On this Mac' : 'Outside this Mac'}`} · Last seen ${seenWords(a.lastSeen)}`}>
              {a.suspendedAt === undefined ? null : <Button onClick={() => run(api.external.resume(a.id))}>Resume</Button>}
              <Button onClick={() => run(api.external.stopAgent(a.id))}>Stop</Button>
              <Button tone="error" onClick={() => run(api.external.revoke(a.id))}>Revoke</Button>
            </Row>
          ))}
        </Group>
      ) : null}
      {agents.length ? (
        <Group title="Activity">
          <Row label="Show" detail="What agents did, and who decided.">
            <Select<ActivityShown> label="Show" value={shown} options={ACTIVITY_SHOWN} onChange={setShown} />
          </Row>
          {activity.length ? activity.map((a) => (
            <Row key={`${a.ts} ${a.tool} ${a.argsHash}`} label={`${a.agent}: ${a.tool}`} detail={`${KIND_WORDS[a.kind]} · decided by ${a.decidedBy === 'person' ? 'you' : 'its level'}${a.target ? ` · ${a.target}` : ''} · ${seenWords(a.ts)}`}>
              {null}
            </Row>
          )) : (
            <Row label="Nothing yet" detail="Each call an agent makes shows here.">
              {null}
            </Row>
          )}
        </Group>
      ) : null}
    </>
  );
}
