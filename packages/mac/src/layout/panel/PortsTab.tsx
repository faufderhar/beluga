import { useEffect, useState } from 'react';
import type { PortForward, PortShare } from '@beluga/shared/forwards.js';
import type { WorktreePort } from '@beluga/workspaces/ports.js';
import { Icon } from '../../components/Icon.js';
import { Button, Tip } from '../../components/ui.js';
import { useApp, useBeluga } from '../../lib/beluga.js';
import { sameDeep } from '../../lib/stable.js';
import { openExternal } from '../../lib/system.js';
import s from './ports.module.css';
import { everyWhileShown } from '../../lib/window-active.js';
import { oneAtATime } from '../../lib/one-at-a-time.js';

/**
 * A worktree's servers (BLG-802), above its Background: each port its dev servers listen on, with
 * Open at localhost. On one of your computers they're forwarded here, at the same port when it was
 * free on this Mac; when it wasn't, the row says which it took. They come and go with the servers.
 * A worktree on a computer can also be given a port of this Mac's (a local database or API, BLG-804):
 * Share a Port from This Mac, reachable there at localhost:<port> until Unshare or the worktree goes.
 */

const NONE: readonly PortForward[] = [];
const NO_SHARES: readonly PortShare[] = [];
const POLL_MS = 3_000;

interface Row {
  readonly key: string;
  readonly name: string;
  readonly port: number;
  readonly local: number;
  readonly where?: string;
}

export function PortsTab({ wsId }: { wsId: string }) {
  const { client } = useBeluga();
  const forwarded = useApp((st) => (st.forwards ?? NONE).filter((f) => f.workspaceId === wsId), sameDeep);
  const [here, setHere] = useState<readonly WorktreePort[]>([]);
  const onComputer = useApp((st) => st.onComputers?.[wsId]);
  const shares = useApp((st) => (st.portShares ?? NO_SHARES).filter((p) => p.workspaceId === wsId), sameDeep);
  // A worktree on this Mac: its own ports, looked at while the tab shows.
  useEffect(() => {
    let live = true;
    const look = oneAtATime(() => client.call('workspaces.ports', wsId).then((p) => live && setHere(p as readonly WorktreePort[]), () => undefined));
    look();
    // Looked at while the window can be seen; at once again when it can.
    const stop = everyWhileShown(look, POLL_MS);
    return () => {
      live = false;
      stop();
    };
  }, [client, wsId]);
  const rows: Row[] = [
    ...forwarded.map((f) => ({ key: `${f.machineId}:${f.port}`, name: f.name, port: f.port, local: f.local, where: f.machineName })),
    ...here.filter((p) => !forwarded.some((f) => f.local === p.port)).map((p) => ({ key: `here:${p.port}`, name: p.name, port: p.port, local: p.port })),
  ];
  if (!rows.length && !onComputer) return null;
  return (
    <section className={s.ports} aria-label="Servers">
      {rows.map((r) => (
        <div key={r.key} className={s.row}>
          <Icon name="globe" size={13} className={s.icon} />
          <span className={s.text}>
            <strong>{r.name}</strong>
            <code>localhost:{r.local}</code>
            {r.where ? <span className={s.detail}>{r.local === r.port ? `from ${r.where}` : `from ${r.where}’s ${r.port} · ${r.port} is in use on this Mac`}</span> : null}
          </span>
          <Tip label={`Open http://localhost:${r.local} in your browser`}>
            <Button size="small" variant="quiet" onClick={() => void openExternal(`http://localhost:${r.local}`)}>
              Open
            </Button>
          </Tip>
        </div>
      ))}
      {shares.map((p) => (
        <div key={`share:${p.port}`} className={s.row}>
          <Icon name="share" size={13} className={s.icon} />
          <span className={s.text}>
            <strong>This Mac</strong>
            <code>localhost:{p.port}</code>
            <span className={s.detail}>shared with this worktree</span>
          </span>
          <Button size="small" variant="quiet" onClick={() => void client.call('machines.unshare', wsId, p.port)}>
            Unshare
          </Button>
        </div>
      ))}
      {onComputer ? <ShareRow wsId={wsId} /> : null}
    </section>
  );
}

/** Share a Port from This Mac: a port, then Share; said plainly when it can't. */
function ShareRow({ wsId }: { wsId: string }) {
  const { client } = useBeluga();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [said, setSaid] = useState<string | undefined>();
  const port = Number(typed);
  const valid = Number.isInteger(port) && port > 0 && port < 65536;
  if (!open)
    return (
      <Tip label="A database or API running on this Mac, reachable from this worktree at the same localhost port">
        <Button size="small" variant="quiet" icon="share" onClick={() => setOpen(true)}>
          Share a Port from This Mac…
        </Button>
      </Tip>
    );
  const share = (): void => {
    if (!valid) return;
    setSaid(undefined);
    void client.call('machines.share', wsId, port).then(
      () => {
        setOpen(false);
        setTyped('');
      },
      (err: unknown) => setSaid(err instanceof Error ? err.message : String(err)),
    );
  };
  return (
    <div className={s.row}>
      <Icon name="share" size={13} className={s.icon} />
      <input className={s.input} inputMode="numeric" placeholder="5432" aria-label="Port on this Mac" autoFocus value={typed} onChange={(e) => setTyped(e.target.value.replace(/\D/g, '').slice(0, 5))} onKeyDown={(e) => (e.key === 'Enter' ? share() : e.key === 'Escape' ? setOpen(false) : undefined)} />
      <span className={s.hint}>{said ?? 'reachable there at the same localhost port'}</span>
      <Button size="small" disabled={!valid} onClick={share}>
        Share
      </Button>
      <Button size="small" variant="quiet" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </div>
  );
}
