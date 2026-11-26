import { useEffect, useRef, useState } from 'react';
import type { CarryCandidate, CarryFile, CarryPicks, CarryPreview } from '@beluga/shared/fork-carry.js';
import { formatBytes } from '@beluga/shared/format.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { Checkbox, Field, FormSheet } from '../../components/FormSheet.js';
import { Icon } from '../../components/Icon.js';
import { toast, useApi, useApp, useBeluga } from '../../lib/beluga.js';
import s from './fork-carry.module.css';
import m from './menus.module.css';

const bare = (p: string): string => p.replace(/\/+$/, '');
const files = (n: number): string => `${n} ${n === 1 ? 'file' : 'files'}`;
const LEFT: Record<NonNullable<CarryFile['why']>, string> = {
  secret: 'Secret: tick it to send',
  big: 'Over 50 MB: stays here',
  limit: 'Past the 150 MB limit: stays here',
  ignored: 'Not picked',
  there: 'They have it',
  unplaced: 'Couldn’t be placed',
};

/** One git-ignored path you can pick: what it is, how big, and whether secrets are in it. */
function candidateDetail(c: CarryCandidate, secretFile: boolean): string {
  if (secretFile) return `A secret · ${formatBytes(c.bytes)} · goes only when ticked`;
  return [files(c.files), formatBytes(c.bytes), c.secrets ? `${c.secrets} secret-looking, left out unless ticked` : ''].filter(Boolean).join(' · ');
}

/**
 * What forks of your worktree bring (BLG-1017): its commits, changes, conversation and Scratch
 * always; of what git ignores only what you pick here, and a secret-looking file in a pick only
 * once you tick that very file. The list of what would go, its size and any warning update as you
 * pick, before anything goes; Save keeps it for every fork from now on.
 */
export function ForkCarrySheet({ wsId, close }: { wsId: string; close: () => void }) {
  const api = useApi();
  const { client } = useBeluga();
  const ws = useApp((st) => findWorkspace(st.projects, wsId));
  const [picks, setPicks] = useState<CarryPicks | undefined>();
  const [preview, setPreview] = useState<CarryPreview | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [showAll, setShowAll] = useState(false);
  const asked = useRef(0);

  const look = (next?: CarryPicks): void => {
    const n = ++asked.current;
    api.sharing
      .forkCarry(wsId, next)
      .then((p) => {
        if (n !== asked.current) return;
        setPreview(p);
        if (!next) setPicks(p.picks);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };
  useEffect(() => look(), [wsId]);

  if (!ws) return null;
  const change = (next: CarryPicks): void => {
    setPicks(next);
    look(next);
  };
  const picked = (c: CarryCandidate): boolean => Boolean(picks?.paths.some((p) => bare(p) === bare(c.path)));
  const ticked = (path: string): boolean => Boolean(picks?.secrets.includes(path));
  const toggle = (c: CarryCandidate, secretFile: boolean, on: boolean): void => {
    if (!picks) return;
    const paths = on ? [...picks.paths, c.path] : picks.paths.filter((p) => bare(p) !== bare(c.path));
    // A secret on its own (a .env file) is picked and ticked at once; a folder's secrets each wait for their tick.
    const secrets = picks.secrets.filter((x) => paths.some((p) => x === bare(p) || x.startsWith(`${bare(p)}/`)));
    change({
      paths,
      secrets: secretFile && on ? [...secrets, bare(c.path)] : secrets,
    });
  };
  const tick = (path: string, on: boolean): void => {
    if (picks)
      change({
        ...picks,
        secrets: on ? [...picks.secrets, path] : picks.secrets.filter((x) => x !== path),
      });
  };

  const candidates = preview?.candidates ?? [];
  const isSecretFile = (c: CarryCandidate): boolean => !c.path.endsWith('/') && c.secrets === 1 && c.files === 1;
  // Secrets inside picked folders (a secret file picked on its own is ticked on its row).
  const secrets = (preview?.files ?? []).filter((f) => f.secret && !candidates.some((c) => isSecretFile(c) && bare(c.path) === f.path));
  const shown = (preview?.files ?? []).filter((f) => !f.secret || f.goes);
  const total = (preview?.bytes ?? 0) + (preview?.scratch.bytes ?? 0);

  return (
    <FormSheet
      title={`What Forks of “${ws.name}” Bring`}
      icon="branch"
      intro="Someone who works here can fork it to their computer. Its commits, uncommitted changes, conversation and Scratch always go. Of what git ignores, only what you pick goes."
      submitLabel="Save"
      canSubmit={Boolean(picks)}
      onSubmit={async () => {
        if (!picks) return;
        await api.sharing.setForkCarry(wsId, picks);
        toast(client, picks.paths.length ? `Forks of ${ws.name} bring ${picks.paths.map(bare).join(', ')} too` : `Forks of ${ws.name} bring Scratch, nothing git ignores`, 'success');
        close();
      }}
      onCancel={close}
      width={580}
      scrolls
    >
      <Field label="Always">
        <div className={s.stack}>
          <div className={m.note}>
            <Icon name="folder" size={14} />
            <span>{preview ? `Scratch: ${files(preview.scratch.files)}, ${formatBytes(preview.scratch.bytes)}` : 'Scratch'}</span>
          </div>
        </div>
      </Field>
      <Field label="Also bring" hint="What git ignores here. node_modules, build output and caches aren’t listed: the setup makes them again.">
        <div className={s.stack}>
          {error ? (
            <div className={m.note} role="alert">
              <Icon name="alert" size={14} />
              <span>{error}</span>
            </div>
          ) : !preview ? (
            <div className={s.empty}>Looking at what git ignores…</div>
          ) : candidates.length ? (
            <div className={s.list} role="group" aria-label="Git-ignored paths">
              {candidates.map((c) => {
                const secretFile = isSecretFile(c);
                return (
                  <div key={c.path} className={s.row}>
                    <Checkbox
                      checked={picked(c)}
                      onChange={(on) => toggle(c, secretFile, on)}
                      label={
                        <span className={s.name}>
                          {secretFile ? <Icon name="lock" size={12} /> : null}
                          <code>{c.path}</code>
                          {c.large ? <span className={s.large}>{formatBytes(c.bytes)}</span> : null}
                        </span>
                      }
                      detail={candidateDetail(c, secretFile)}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <div className={s.empty}>Git ignores nothing else here.</div>
          )}
        </div>
      </Field>
      {secrets.length ? (
        <Field label="Secrets" hint="Secret-looking files in what you picked. Each stays here until you tick it: tick only what the fork can’t do without.">
          <div className={s.stack}>
            <div className={s.list} role="group" aria-label="Secret-looking files">
              {secrets.map((f) => (
                <div key={f.path} className={s.row}>
                  <Checkbox
                    checked={ticked(f.path)}
                    onChange={(on) => tick(f.path, on)}
                    label={
                      <span className={s.name}>
                        <Icon name="lock" size={12} />
                        <code>{f.path}</code>
                      </span>
                    }
                    detail={`${formatBytes(f.bytes)} · ${ticked(f.path) ? 'Goes with the fork' : 'Stays here'}`}
                  />
                </div>
              ))}
            </div>
          </div>
        </Field>
      ) : null}
      {preview ? (
        <Field label="What goes">
          <div className={s.stack}>
            <div className={s.summary}>
              <span>{`${files(preview.count)} of what git ignores, plus Scratch: ${formatBytes(total)} in all`}</span>
              {shown.length ? (
                <button type="button" className={s.toggle} onClick={() => setShowAll((v) => !v)}>
                  {showAll ? 'Hide Files' : 'Show Files'}
                </button>
              ) : null}
            </div>
            {preview.warnings.map((w) => (
              <div key={w} className={m.note} role="status">
                <Icon name="alert" size={14} />
                <span>{w}</span>
              </div>
            ))}
            {showAll ? (
              <ul className={s.files} aria-label="Files that would go">
                {shown.map((f) => (
                  <li key={f.path} className={f.goes ? undefined : s.stays}>
                    <code>{f.path}</code>
                    <span>{f.goes ? formatBytes(f.bytes) : LEFT[f.why ?? 'limit']}</span>
                  </li>
                ))}
                {preview.more ? <li className={s.stays}>{`and ${files(preview.more)} more`}</li> : null}
              </ul>
            ) : null}
          </div>
        </Field>
      ) : null}
    </FormSheet>
  );
}
